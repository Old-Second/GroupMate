import fs from 'node:fs'
import path from 'node:path'
import { Config } from './utils/config.js'
import { newFetch } from './utils/proxy.js'
import { collectProcessors } from './utils/postprocessors/BasicProcessor.js'
import { convertFaces } from './utils/face.js'
import {
  convertSpeaker,
  generateVitsAudio,
  speakers as vitsSpeakers
} from './utils/tts.js'
import AzureTTS, {
  supportConfigurations as azureVoices
} from './utils/tts/microsoft-azure.js'
import VoiceVoxTTS, {
  supportConfigurations as voiceVoxVoices
} from './utils/tts/voicevox.js'
import {
  configureTranslationService,
  translate
} from './dist/runtime/translation-service.js'
import {
  configureAuxiliaryCompletionService
} from './dist/runtime/auxiliary-completion-service.js'
import { ModelProviderError } from './dist/agent/model/model-adapter.js'
import { OpenAICompatibleAdapter } from './dist/agent/model/openai-compatible-adapter.js'
import { resolveOpenAICompatibleModelRuntimeConfig } from './dist/runtime/model-runtime-config.js'
import {
  createPendingIndicatorConfigPort
} from './dist/runtime/presentation/pending-indicator-config.js'
import {
  createPresentationSettingsPort
} from './dist/runtime/presentation/presentation-settings.js'
import {
  createGroupMatePictureRenderer,
  createLive2dAssetResolver
} from './dist/runtime/presentation/groupmate-picture-renderer.js'
import {
  createCloudScreenshotPort,
  createRemoteGroupMatePictureRenderer,
  createRemotePicturePagePort
} from './dist/runtime/presentation/remote-picture-renderer.js'
import {
  createYunzaiTtsReplyPort
} from './dist/runtime/presentation/yunzai-tts-reply-port.js'
import {
  createRuntimePresentationHooks
} from './dist/runtime/runtime-presentation-hooks.js'
import {
  buildChatButtonContent
} from './dist/runtime/yunzai-button-content.js'
import {
  materializeYunzaiForwardMessage
} from './dist/runtime/presentation/yunzai-forward-message.js'
import {
  materializeYunzaiMagicSegment
} from './dist/runtime/presentation/yunzai-magic-segment.js'
import {
  initializeProductionYunzaiAgent
} from './dist/runtime/production-yunzai-agent.js'
import {
  resolveYunzaiGroupHistoryCursor
} from './dist/runtime/agent-service-bridge.js'
import {
  createBrowserReleaseLog,
  releaseBrowserAfterRender
} from './dist/runtime/browser-release.js'
import {
  pluginDisplayName,
  repositoryUrl,
  resolvePluginPath
} from './dist/runtime/plugin-context.js'

const runtimeLogger = globalThis.logger ?? Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
})
const redisClient = globalThis.redis
const BROWSER_RELEASE_TIMEOUT_MS = 5_000
const SUGGESTION_TIMEOUT_MS = 5_000
const TTS_OPERATION_TIMEOUT_MS = 120_000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_PICTURE_RASTER_BYTES = 32 * 1024 * 1024

if (redisClient === undefined || redisClient === null) {
  throw new Error('GroupMate requires the Yunzai Redis runtime')
}

runtimeLogger.info('**************************************')
runtimeLogger.info(`${pluginDisplayName}加载中`)

if (!globalThis.segment) {
  try {
    globalThis.segment = (await import('icqq')).segment
  } catch {
    globalThis.segment = (await import('oicq')).segment
  }
}

function normalizedText (value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFC').trim()
  if (normalized === '') return fallback
  return [...normalized].slice(0, maximum).join('')
}

function normalizedStringList (value, maximumItems = 256, maximumCharacters = 128) {
  if (!Array.isArray(value) && typeof value !== 'string') return Object.freeze([])
  const source = Array.isArray(value) ? value : [value]
  const result = []
  const seen = new Set()
  for (const item of source) {
    if (result.length >= maximumItems) break
    if (typeof item !== 'string') continue
    const normalized = normalizedText(item, maximumCharacters)
    if (normalized === '' || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return Object.freeze(result)
}

function finiteInteger (value, fallback, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
    : fallback
}

function finiteNumber (value, fallback, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback
}

function configuredThinkingMode (value) {
  return value === 'enabled' || value === 'disabled' ? value : 'default'
}

function configuredReasoningEffort (value) {
  return value === 'low' || value === 'medium' || value === 'high' ||
    value === 'max' ? value : 'default'
}

function ttsMode () {
  return Config.ttsMode === 'azure' || Config.ttsMode === 'voicevox'
    ? Config.ttsMode
    : 'vits-uma-genshin-honkai'
}

const rememberedBots = new Map()

function rememberBot (botId, bot) {
  if (bot === null || typeof bot !== 'object' || botId === '') return
  rememberedBots.delete(botId)
  rememberedBots.set(botId, bot)
  while (rememberedBots.size > 8) {
    const oldest = rememberedBots.keys().next().value
    if (oldest === undefined) break
    rememberedBots.delete(oldest)
  }
}

function configuredBotId (event) {
  const source = event !== null && typeof event === 'object' ? event : {}
  let value = source.self_id ?? source.bot?.uin
  if (value === undefined || value === null || String(value) === '') {
    const globalBot = globalThis.Bot
    const candidates = Array.isArray(globalBot?.uin) ? globalBot.uin : [globalBot?.uin]
    value = Config.trssBotUin && candidates.some(item => String(item) === String(Config.trssBotUin))
      ? Config.trssBotUin
      : candidates.filter(item => item !== undefined && item !== null).at(-1)
  }
  const botId = normalizedText(String(value ?? ''), 128)
  if (botId === '') throw new TypeError('Yunzai bot identity is unavailable')
  rememberBot(botId, source.bot)
  return botId
}

const botPicker = Object.freeze({
  async pick (botId) {
    const known = rememberedBots.get(String(botId))
    if (known !== undefined) return known
    const globalBot = globalThis.Bot
    if (globalBot === null || typeof globalBot !== 'object') return null
    const indexed = globalBot[String(botId)]
    if (indexed !== undefined && indexed !== null) return indexed
    if (!Array.isArray(globalBot.uin) && String(globalBot.uin ?? '') === String(botId)) {
      return globalBot
    }
    return null
  }
})

async function masterIds () {
  const hostConfig = (await import('../../lib/config/config.js')).default
  const value = hostConfig?.masterQQ
  return Object.freeze((Array.isArray(value) ? value : [value])
    .filter(item => typeof item === 'string' || typeof item === 'number'))
}

function eventActorId (event) {
  return normalizedText(String(event?.sender?.user_id ?? event?.user_id ?? ''), 128)
}

function eventTarget (event) {
  const botId = configuredBotId(event)
  const actorId = eventActorId(event)
  if (event?.isGroup === true) {
    return Object.freeze({
      botId,
      scope: Object.freeze({
        kind: 'group',
        groupId: normalizedText(String(event.group_id ?? ''), 128)
      })
    })
  }
  return Object.freeze({
    botId,
    scope: Object.freeze({ kind: 'private', userId: actorId })
  })
}

function resourceValue (resource) {
  if (resource.kind === 'buffer') return Buffer.from(resource.data)
  if (resource.kind === 'remote_url') return resource.url
  return resource.path
}

function textAtomValue (atom) {
  const segment = globalThis.segment
  if (atom.kind === 'text') return atom.text
  if (atom.kind === 'at') {
    const target = atom.target === 'all' ? 'all' : atom.target.userId
    return typeof segment.at === 'function'
      ? segment.at(target)
      : { type: 'at', qq: target }
  }
  if (atom.kind === 'face') {
    return typeof segment.face === 'function'
      ? segment.face(atom.faceId)
      : { type: 'face', id: atom.faceId }
  }
  return typeof segment.markdown === 'function'
    ? segment.markdown(atom.markdown)
    : { type: 'markdown', data: { content: atom.markdown } }
}

const buttonPolicy = Object.freeze({
  snapshot () {
    return Object.freeze({
      markdownEnabled: Config.enableMd === true,
      openAiConfigured: normalizedText(Config.apiKey, 16_384) !== '' &&
        normalizedText(Config.openAiBaseUrl, 2_048) !== '' &&
        normalizedText(Config.model, 256) !== ''
    })
  }
})

async function outboundMessage (receiver, part) {
  const segment = globalThis.segment
  if (part.media === 'text') {
    const values = part.atoms.map(textAtomValue)
    const buttons = buildChatButtonContent(part.buttons, buttonPolicy.snapshot())
    if (buttons !== null) values.push({ type: 'button', content: buttons })
    return values.length === 1 ? values[0] : values
  }
  if (part.media === 'picture') {
    return typeof segment.image === 'function'
      ? segment.image(resourceValue(part.resource))
      : { type: 'image', file: resourceValue(part.resource) }
  }
  if (part.media === 'voice') {
    return typeof segment.record === 'function'
      ? segment.record(resourceValue(part.resource))
      : { type: 'record', file: resourceValue(part.resource) }
  }
  if (part.media === 'video') {
    return typeof segment.video === 'function'
      ? segment.video(resourceValue(part.resource))
      : { type: 'video', file: resourceValue(part.resource) }
  }
  if (part.media === 'music') {
    return typeof segment.music === 'function'
      ? segment.music(part.provider, part.id)
      : { type: 'music', platform: part.provider, id: part.id }
  }
  if (part.media === 'dice') return materializeYunzaiMagicSegment(segment, 'dice')
  if (part.media === 'rps') return materializeYunzaiMagicSegment(segment, 'rps', part.value)
  return await materializeYunzaiForwardMessage(receiver, part)
}

const outboundHost = Object.freeze({
  async forTarget (target) {
    const bot = await botPicker.pick(target.botId)
    if (bot === null) return null
    const receiver = target.scope.kind === 'group'
      ? await bot.pickGroup?.(target.scope.groupId)
      : await bot.pickFriend?.(target.scope.userId)
    if (receiver === null || typeof receiver !== 'object' ||
      typeof receiver.sendMsg !== 'function') return null
    return Object.freeze({
      async dispatch (part, quoteMessageId, signal) {
        if (signal?.aborted === true) throw signal.reason
        const message = await outboundMessage(receiver, part)
        if (quoteMessageId === undefined) return await receiver.sendMsg(message)
        const reply = typeof globalThis.segment.reply === 'function'
          ? globalThis.segment.reply(quoteMessageId)
          : { type: 'reply', id: quoteMessageId }
        const quoted = Array.isArray(message) ? [reply, ...message] : [reply, message]
        return await receiver.sendMsg(quoted)
      },
      async recall (messageId, signal) {
        if (signal?.aborted === true) throw signal.reason
        return typeof receiver.recallMsg === 'function'
          ? await receiver.recallMsg(messageId)
          : false
      }
    })
  }
})

function currentPresentationConfig () {
  return Object.freeze({
    quoteReply: Config.quoteReply === true,
    enableRobotAt: Config.enableRobotAt === true,
    enableMd: Config.enableMd === true,
    enableSuggestedResponses: Config.enableSuggestedResponses === true,
    forwardReasoning: Config.forwardReasoning !== false,
    blockWords: normalizedStringList(Config.blockWords),
    promptBlockWords: normalizedStringList(Config.promptBlockWords),
    defaultUsePicture: Config.defaultUsePicture === true,
    defaultUseTTS: Config.defaultUseTTS === true,
    defaultTTSRole: normalizedText(Config.defaultTTSRole, 256, '纳西妲'),
    azureTTSSpeaker: normalizedText(Config.azureTTSSpeaker, 256, 'zh-CN-XiaochenNeural'),
    voicevoxTTSSpeaker: normalizedText(Config.voicevoxTTSSpeaker, 256, '护士机器子T'),
    ttsMode: ttsMode(),
    alsoSendText: Config.alsoSendText === true,
    ttsAutoFallbackThreshold: finiteInteger(Config.ttsAutoFallbackThreshold, 299, 1, 24_000),
    ttsRegex: typeof Config.ttsRegex === 'string' ? Config.ttsRegex : '',
    enhanceAzureTTSEmotion: Config.enhanceAzureTTSEmotion === true,
    autoUsePicture: Config.autoUsePicture !== false,
    autoUsePictureThreshold: finiteInteger(Config.autoUsePictureThreshold, 1_200, 1, 24_000),
    cloudDPR: finiteNumber(Config.cloudDPR, 1, 0.5, 4),
    closeBrowserAfterRender: Config.closeBrowserAfterRender !== false,
    showQRCode: Config.showQRCode !== false,
    live2d: Config.live2d === true,
    live2dModel: normalizedText(Config.live2dModel, 512, '/live2d/Murasame/Murasame.model3.json'),
    live2dOption_scale: finiteNumber(Config.live2dOption_scale, 0.1, 0, 10),
    live2dOption_positionX: finiteNumber(Config.live2dOption_positionX, 0, -4_096, 4_096),
    live2dOption_positionY: finiteNumber(Config.live2dOption_positionY, 0, -4_096, 4_096),
    live2dOption_rotation: finiteNumber(Config.live2dOption_rotation, 0, -360, 360),
    live2dOption_alpha: finiteNumber(Config.live2dOption_alpha, 1, 0, 1)
  })
}

const presentationSettings = createPresentationSettingsPort(Object.freeze({
  loadUserJson: async actorId => await redisClient.get(`CHATGPT:USER:${actorId}`),
  currentSafeConfig: currentPresentationConfig
}))
const pendingConfig = createPendingIndicatorConfigPort(redisClient)

function defaultPreferences () {
  return Object.freeze({
    usePicture: Config.defaultUsePicture === true,
    useTTS: Config.defaultUseTTS === true,
    ttsRole: normalizedText(Config.defaultTTSRole, 256, '纳西妲'),
    ttsRoleAzure: normalizedText(Config.azureTTSSpeaker, 256, 'zh-CN-XiaochenNeural'),
    ttsRoleVoiceVox: normalizedText(Config.voicevoxTTSSpeaker, 256, '护士机器子T')
  })
}

function parsePreferenceRecord (raw) {
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    return {}
  }
}

function projectPreferences (record) {
  const defaults = defaultPreferences()
  return Object.freeze({
    usePicture: typeof record.usePicture === 'boolean' ? record.usePicture : defaults.usePicture,
    useTTS: typeof record.useTTS === 'boolean' ? record.useTTS : defaults.useTTS,
    ttsRole: normalizedText(record.ttsRole, 256, defaults.ttsRole),
    ttsRoleAzure: normalizedText(record.ttsRoleAzure, 256, defaults.ttsRoleAzure),
    ttsRoleVoiceVox: normalizedText(
      record.ttsRoleVoiceVox,
      256,
      defaults.ttsRoleVoiceVox
    )
  })
}

const chatPreferences = Object.freeze({
  async load (actorId) {
    return projectPreferences(parsePreferenceRecord(
      await redisClient.get(`CHATGPT:USER:${actorId}`)
    ))
  },
  async patch (actorId, patch) {
    const key = `CHATGPT:USER:${actorId}`
    const record = parsePreferenceRecord(await redisClient.get(key))
    for (const field of ['usePicture', 'useTTS']) {
      if (typeof patch[field] === 'boolean') record[field] = patch[field]
    }
    for (const field of ['ttsRole', 'ttsRoleAzure', 'ttsRoleVoiceVox']) {
      if (typeof patch[field] !== 'string') continue
      const value = normalizedText(patch[field], 256)
      if (value !== '') record[field] = value
    }
    await redisClient.set(key, JSON.stringify(record))
    return projectPreferences(record)
  }
})

async function actorCast (actorId) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(actorId)) return ''
  try {
    const raw = await fs.promises.readFile(
      resolvePluginPath(path.join('resources/ChatGPTCache/user', `${actorId}.json`)),
      'utf8'
    )
    const parsed = JSON.parse(raw)
    return normalizedText(parsed?.cast?.api, 8_192)
  } catch {
    return ''
  }
}

function eventImageUrls (event) {
  if (!Array.isArray(event?.message)) return Object.freeze([])
  const urls = []
  for (const segment of event.message) {
    if (urls.length >= 8 || segment === null || typeof segment !== 'object' ||
      segment.type !== 'image') continue
    const value = segment.url ?? segment.file ?? segment.data?.url ?? segment.data?.file
    if (typeof value === 'string' && value.length <= 4_096) urls.push(value)
  }
  return Object.freeze([...new Set(urls)])
}

async function ocrText (event) {
  if (typeof event?.bot?.imageOcr !== 'function') return Object.freeze([])
  const result = []
  for (const image of eventImageUrls(event)) {
    try {
      const response = await event.bot.imageOcr(image)
      const words = Array.isArray(response?.wordslist) ? response.wordslist : []
      const text = normalizedText(words.map(item => item?.words ?? '').join('\n'), 2_000)
      if (text !== '') result.push(text)
    } catch {}
  }
  return Object.freeze(result)
}

function azureVoice (voice) {
  return azureVoices.find(item => item.code === voice || item.name === voice)
}

async function appendAzureEmotionFeedback ({ actorId, prompt, preferences }) {
  if (ttsMode() !== 'azure' || Config.enhanceAzureTTSEmotion !== true ||
    Config.azureTTSEmotion !== true || preferences.useTTS !== true ||
    azureVoice(preferences.ttsRoleAzure)?.emotion === undefined) return prompt
  const flag = await redisClient.get(`CHATGPT:WRONG_EMOTION:${actorId}`)
  const additions = Object.freeze({
    1: '(上一次回复没有添加情绪，请确保接下来的对话正确使用情绪和情绪格式，回复时忽略此内容。)',
    2: '(不要使用给出情绪范围的词和错误的情绪格式，请确保接下来的对话正确选择情绪，回复时忽略此内容。)',
    3: '(不要给出多个情绪[]项，请确保接下来的对话给且只给出一个正确情绪项，回复时忽略此内容。)'
  })
  return typeof additions[flag] === 'string' ? `${prompt}${additions[flag]}` : prompt
}

const bootstrapEntryMode = Config.toggleMode === 'prefix' ? 'prefix' : 'at'
const chatPolicy = Object.freeze({
  entryMode: () => bootstrapEntryMode,
  async snapshot (event) {
    const actorId = eventActorId(event)
    const ttl = finiteInteger(Config.conversationPreserveTime, 0, 0, 31_536_000)
    return Object.freeze({
      toggleMode: bootstrapEntryMode,
      enablePrivateChat: Config.enablePrivateChat === true,
      whitelist: normalizedStringList(Config.whitelist),
      blacklist: normalizedStringList(Config.blacklist),
      imgOcr: Config.imgOcr === true,
      groupMerge: Config.groupMerge === true,
      enableGroupContext: Config.enableGroupContext === true,
      thinkingMode: configuredThinkingMode(Config.apiThinkingMode),
      reasoningEffort: configuredReasoningEffort(Config.apiReasoningEffort),
      ...(ttl > 0 ? { sessionTtlSeconds: ttl } : {}),
      assistantLabel: normalizedText(Config.assistantLabel, 128, 'GroupMate'),
      promptPrefixOverride: normalizedText(Config.promptPrefixOverride, 8_192),
      actorCastApi: await actorCast(actorId)
    })
  },
  async isMuted (target) {
    if (await redisClient.get('CHATGPT:SHUT_UP:ALL')) return true
    const groupId = target.scope.kind === 'group' || target.scope.kind === 'group_user'
      ? target.scope.groupId
      : ''
    return groupId !== '' && Boolean(await redisClient.get(`CHATGPT:SHUT_UP:${groupId}`))
  },
  ocrText,
  appendAzureEmotionFeedback,
  clearAzureEmotionFeedback: async actorId => {
    await redisClient.del(`CHATGPT:WRONG_EMOTION:${actorId}`)
  }
})

function ttsConfigured (mode) {
  if (mode === 'azure') return normalizedText(Config.azureTTSKey, 16_384) !== ''
  if (mode === 'voicevox') return normalizedText(Config.voicevoxSpace, 2_048) !== ''
  return normalizedText(Config.ttsSpace, 2_048) !== ''
}

function missingTtsConfiguration (mode, operation) {
  if (operation === 'enable') {
    if (mode === 'azure') return '您没有配置Azure Key，请前往锅巴面板进行配置'
    if (mode === 'voicevox') return '您没有配置VoiceVox API，请前往锅巴面板进行配置'
    return '您没有配置VITS API，请前往锅巴面板进行配置'
  }
  if (mode === 'azure') return '您没有配置azure 密钥，请前往后台管理或锅巴面板进行配置'
  if (mode === 'voicevox') return '您没有配置voicevox API，请前往后台管理或锅巴面板进行配置'
  return '您没有配置vits-uma-genshin-honkai API，请前往后台管理或锅巴面板进行配置'
}

function selectVoice (mode, requested) {
  const voice = normalizedText(requested, 256, '随机')
  if (mode === 'vits-uma-genshin-honkai') {
    const selected = voice === '随机' ? '随机' : convertSpeaker(voice)
    return selected === '随机' || vitsSpeakers.includes(selected)
      ? Object.freeze({
          kind: 'selected',
          storedVoice: selected,
          message: `当前语音模式为${mode},您的默认语音角色已被设置为 "${selected}" `
        })
      : Object.freeze({ kind: 'unsupported', message: `抱歉，"${selected}"我还不认识呢` })
  }
  if (mode === 'azure') {
    if (voice === '随机') {
      return Object.freeze({
        kind: 'selected', storedVoice: '随机',
        message: `当前语音模式为${mode},您的默认语音角色已被设置为 "随机" `
      })
    }
    const selected = azureVoices.find(item => item.name === voice)
    if (selected === undefined) {
      return Object.freeze({
        kind: 'unsupported',
        message: `抱歉，没有"${voice}"这个角色，目前azure模式下支持的角色有${azureVoices.map(item => item.name).join('、')}`
      })
    }
    const emotion = selected.emotion !== undefined && Config.azureTTSEmotion === true
      ? '，此角色支持多情绪配置，建议重新使用设定并结束对话以获得最佳体验！'
      : ''
    return Object.freeze({
      kind: 'selected',
      storedVoice: selected.code,
      message: `当前语音模式为${mode},您的默认语音角色已被设置为 ${voice}-${selected.gender}-${selected.languageDetail} ${emotion}`
    })
  }
  if (voice === '随机') {
    return Object.freeze({
      kind: 'selected', storedVoice: '随机',
      message: `当前语音模式为${mode},您的默认语音角色已被设置为 "随机" `
    })
  }
  const matched = /^(.*?)-(.*)$/.exec(voice)
  const name = matched?.[1] ?? voice
  const style = matched?.[2]
  const selected = voiceVoxVoices.find(item => item.name === name)
  if (selected === undefined) {
    return Object.freeze({
      kind: 'unsupported',
      message: `抱歉，没有"${name}"这个角色，目前voicevox模式下支持的角色有${voiceVoxVoices.map(item => item.name).join('、')}`
    })
  }
  if (style !== undefined && !selected.styles.some(item => item.name === style)) {
    return Object.freeze({
      kind: 'unsupported',
      message: `抱歉，"${name}"这个角色没有"${style}"这个风格，目前支持的风格有${selected.styles.map(item => item.name).join('、')}`
    })
  }
  const storedVoice = `${selected.name}${style === undefined ? '' : `-${style}`}`
  return Object.freeze({
    kind: 'selected',
    storedVoice,
    message: `当前语音模式为${mode},您的默认语音角色已被设置为 "${storedVoice}" `
  })
}

const ttsAdministration = Object.freeze({
  getMode: ttsMode,
  setMode: mode => { Config.ttsMode = mode },
  isConfigured: ttsConfigured,
  selectVoice,
  missingConfigurationMessage: missingTtsConfiguration
})

function formatDateOnly (date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
    String(date.getDate()).padStart(2, '0')
}

const billing = Object.freeze({
  async queryLastHundredDays (now) {
    const endpoint = normalizedText(Config.openAiBaseUrl, 2_048).replace(/\/+$/, '')
    const headers = Object.freeze({ Authorization: `Bearer ${Config.apiKey}` })
    const subscriptionResponse = await newFetch(`${endpoint}/dashboard/billing/subscription`, {
      method: 'GET', headers
    })
    if (!subscriptionResponse.ok) throw new Error('billing subscription request failed')
    const subscription = await subscriptionResponse.json()
    const end = new Date(now)
    end.setDate(end.getDate() + 1)
    const start = new Date(end)
    start.setDate(start.getDate() - 100)
    const usageResponse = await newFetch(
      `${endpoint}/dashboard/billing/usage?start_date=${formatDateOnly(start)}&end_date=${formatDateOnly(end)}`,
      { method: 'GET', headers }
    )
    if (!usageResponse.ok) throw new Error('billing usage request failed')
    const usage = await usageResponse.json()
    const hardLimitUsd = Number(subscription?.hard_limit_usd)
    const totalUsageUsd = Number(usage?.total_usage) / 100
    const expiresAt = new Date(Number(subscription?.access_until) * 1_000)
    if (!Number.isFinite(hardLimitUsd) || !Number.isFinite(totalUsageUsd) ||
      Number.isNaN(expiresAt.getTime())) throw new Error('billing response is invalid')
    return Object.freeze({ hardLimitUsd, totalUsageUsd, expiresAt })
  }
})

const bymPolicy = Object.freeze({
  snapshot () {
    return Object.freeze({
      enabled: Config.enableBYM === true,
      assistantLabel: normalizedText(Config.assistantLabel, 128, 'GroupMate'),
      recognizeLeadingAlias: Config.bymRecognizeLeadingAlias !== false,
      ratePercent: finiteNumber(Config.bymRate, 5, 0, 100),
      disabledGroupIds: normalizedStringList(Config.bymDisableGroup, 256, 128),
      thinkingMode: configuredThinkingMode(Config.bymThinkingMode),
      reasoningEffort: configuredReasoningEffort(Config.bymReasoningEffort),
      preset: normalizedText(Config.bymPreset, 8_192),
      retaliationWords: normalizedStringList(Config.bymFuckList, 128, 128),
      retaliationBlacklistActorIds: normalizedStringList(Config.bymFuckBlacklist, 256, 128),
      retaliationPrompt: normalizedText(Config.bymFuckPrompt, 16_384),
      retaliationRecallEnabled: Config.bymFuckRecall === true,
      retaliationRecallSeconds: finiteInteger(Config.bymFuckRecallTime, 100, 1, 3_600)
    })
  }
})

function safeTextAtoms (value, fallback) {
  const source = Array.isArray(value) ? value : [value]
  const atoms = []
  for (const item of source) {
    if (typeof item === 'string' && item !== '') {
      atoms.push(Object.freeze({ kind: 'text', text: item }))
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const data = item.data !== null && typeof item.data === 'object' ? item.data : {}
    if (item.type === 'at') {
      const target = item.qq ?? data.qq ?? item.text ?? data.text
      if (target === 'all') atoms.push(Object.freeze({ kind: 'at', target: 'all' }))
      else if (target !== undefined && target !== null) {
        atoms.push(Object.freeze({
          kind: 'at', target: Object.freeze({ userId: String(target) })
        }))
      }
    } else if (item.type === 'face') {
      const faceId = Number(item.id ?? data.id)
      if (Number.isSafeInteger(faceId) && faceId >= 0) {
        atoms.push(Object.freeze({ kind: 'face', faceId }))
      }
    } else if (item.type === 'markdown') {
      const markdown = item.markdown ?? item.content ?? data.content
      if (typeof markdown === 'string') {
        atoms.push(Object.freeze({ kind: 'markdown', markdown }))
      }
    }
  }
  return Object.freeze(atoms.length > 0
    ? atoms
    : [Object.freeze({ kind: 'text', text: fallback })])
}

async function updateEmotionFeedback (event, text) {
  const actorId = eventActorId(event)
  if (actorId === '' || ttsMode() !== 'azure' || Config.enhanceAzureTTSEmotion !== true ||
    Config.azureTTSEmotion !== true) return
  const preferences = await chatPreferences.load(actorId)
  if (!preferences.useTTS) return
  const supported = azureVoice(preferences.ttsRoleAzure)?.emotion
  if (supported === undefined) return
  const markers = [...String(text).matchAll(
    /\[\s*['`’‘]?([\p{L}\p{N}_]+)[`’‘']?\s*[,，、]\s*([\d.]+)\s*\]/gu
  )]
  let flag = '1'
  if (markers.length > 1) flag = '3'
  else if (markers.length === 1) {
    flag = Object.hasOwn(supported, markers[0][1]) ? '0' : '2'
  }
  await redisClient.set(`CHATGPT:WRONG_EMOTION:${actorId}`, flag)
}

const hooks = Object.freeze({
  forActiveEvent (event) {
    return createRuntimePresentationHooks(Object.freeze({
      loadPostprocessors: async () => await collectProcessors('post'),
      async convertText ({ text, enableRobotAt, enableMarkdown }) {
        let converted = await convertFaces(text, enableRobotAt, event)
        const handler = event?.runtime?.handler
        if (enableMarkdown && handler?.has?.('chatgpt.markdown.convert')) {
          try {
            converted = await handler.call('chatgpt.markdown.convert', event, {
              content: converted,
              use: 'api',
              prompt: ''
            })
          } catch {}
        }
        return safeTextAtoms(converted, text)
      },
      notifyResponsePost (input) {
        void updateEmotionFeedback(event, input.text).catch(() => undefined)
        const handler = event?.runtime?.handler
        if (!handler?.has?.('chatgpt.response.post')) return
        try {
          void Promise.resolve(handler.call('chatgpt.response.post', event, {
            content: input.text,
            thinking: input.hasReasoning ? 'available' : '',
            use: 'api',
            prompt: ''
          })).catch(() => undefined)
        } catch {}
      }
    }))
  }
})

function createProductionModelPort () {
  const selected = resolveOpenAICompatibleModelRuntimeConfig({
    openAiCompatibilityProfile: Config.openAiCompatibilityProfile
  })
  const endpoint = normalizedText(Config.openAiBaseUrl, 2_048)
  const apiKey = normalizedText(Config.apiKey, 16_384)
  const getAdapter = () => {
    const current = resolveOpenAICompatibleModelRuntimeConfig({
      openAiCompatibilityProfile: Config.openAiCompatibilityProfile
    })
    if (current.configuredProfile !== selected.configuredProfile ||
      normalizedText(Config.openAiBaseUrl, 2_048) !== endpoint ||
      normalizedText(Config.apiKey, 16_384) !== apiKey) {
      throw new ModelProviderError({
        code: 'provider_invalid_request',
        stage: 'model.configuration',
        retryable: false,
        userMessage: 'API 配置已变更，请重启机器人后再试。',
        details: Object.freeze({ reason: 'model_transport_configuration_changed' })
      })
    }
    return new OpenAICompatibleAdapter({
      endpoint,
      apiKey,
      profile: selected.profile,
      fetch: newFetch
    })
  }
  return Object.freeze({
    complete: async (request, signal) => await getAdapter().complete(request, signal),
    async generate ({ prompt, response }, signal) {
      const controller = new AbortController()
      const forwardAbort = () => controller.abort(signal?.reason)
      if (signal?.aborted === true) forwardAbort()
      else signal?.addEventListener('abort', forwardAbort, { once: true })
      const timeoutMs = Math.min(
        finiteInteger(Config.defaultTimeoutMs, 120_000, 1, 120_000),
        SUGGESTION_TIMEOUT_MS
      )
      const timer = setTimeout(() => {
        controller.abort(new DOMException('suggestion generation timed out', 'TimeoutError'))
      }, timeoutMs)
      timer.unref?.()
      try {
        const turn = await getAdapter().complete(Object.freeze({
          model: normalizedText(Config.model, 256),
          messages: Object.freeze([
            Object.freeze({
              role: 'system',
              content: 'Generate at most three short next-turn suggestions in the user language, one per line. Do not answer the conversation.'
            }),
            Object.freeze({
              role: 'user',
              content: `User:\n${normalizedText(prompt, 4_096)}\n\nAssistant:\n${normalizedText(response, 4_096)}`
            })
          ]),
          tools: Object.freeze([]),
          toolMode: 'disabled',
          streaming: false,
          maxOutputTokens: 512,
          reasoning: Object.freeze({ enabled: false }),
          temperature: 0.7
        }), controller.signal)
        return Object.freeze(turn.text.split(/\r?\n/).filter(Boolean))
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', forwardAbort)
      }
    }
  })
}

function createBrowserOperationBoundary (requestedTimeoutMs, signal) {
  const timeoutMs = Math.min(
    requestedTimeoutMs,
    finiteInteger(Config.chromeTimeoutMS, requestedTimeoutMs, 1_000, requestedTimeoutMs)
  )
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new DOMException('browser operation timed out', 'TimeoutError'))
  }, timeoutMs)
  timer.unref?.()
  return Object.freeze({
    signal: controller.signal,
    timeoutMs,
    dispose () {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  })
}

async function runBrowserStep (factory, signal, lateCleanup) {
  if (signal.aborted) throw signal.reason
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
      return true
    }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let operation
    try {
      operation = Promise.resolve(factory())
    } catch (error) {
      finish(reject, error)
      return
    }
    operation.then(value => {
      if (!finish(resolve, value) && signal.aborted) {
        try { void Promise.resolve(lateCleanup?.(value)).catch(() => undefined) } catch {}
      }
    }, error => finish(reject, error))
  })
}

async function closePageWithinBoundary (page) {
  if (typeof page?.close !== 'function') return
  let timer
  const close = Promise.resolve().then(async () => await page.close()).catch(() => undefined)
  await Promise.race([
    close,
    new Promise(resolve => {
      timer = setTimeout(resolve, BROWSER_RELEASE_TIMEOUT_MS)
      timer.unref?.()
    })
  ])
  if (timer !== undefined) clearTimeout(timer)
}

async function releaseManagedBrowser (manager, browserHandle) {
  if (!browserHandle) return 'not_connected'
  let releaseTimer
  const releasePromise = releaseBrowserAfterRender({
    browser: browserHandle,
    reportFailure: () => undefined
  }).then(result => {
    if ((result === 'closed' || result === 'disconnected') &&
      manager?.browser === browserHandle) manager.browser = null
    return result
  })
  const releaseResult = await Promise.race([
    releasePromise,
    new Promise(resolve => {
      releaseTimer = setTimeout(() => resolve('failed'), BROWSER_RELEASE_TIMEOUT_MS)
      releaseTimer.unref?.()
    })
  ])
  if (releaseTimer !== undefined) clearTimeout(releaseTimer)
  runtimeLogger.info(createBrowserReleaseLog(releaseResult))
  return releaseResult
}

function boundedScreenshotDpr (width, height, requested) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
    !Number.isFinite(requested)) return null
  const maximum = Math.sqrt(MAX_PICTURE_RASTER_BYTES / (width * height * 4))
  const bounded = Math.min(Math.max(requested, 0.5), 4, maximum)
  if (!Number.isFinite(bounded) || bounded < 0.5) return null
  return Math.floor(bounded * 100) / 100
}

function createLazyBrowserPicturePort () {
  return Object.freeze({
    async render (input, signal) {
      if (signal?.aborted === true) {
        return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
      }
      // The tracked local assets do not expose an independent renderer API.
      // Fail fast so the renderer performs its one bounded no-decoration retry.
      if (input.live2d !== null) {
        return Object.freeze({ kind: 'not_rendered', code: 'live2d_unavailable' })
      }
      const boundary = createBrowserOperationBoundary(input.timeoutMs, signal)
      let manager
      let page
      let browserHandle
      const onAbort = () => {
        void closePageWithinBoundary(page)
      }
      boundary.signal.addEventListener('abort', onAbort, { once: true })
      try {
        manager = (await import('./utils/browser.js')).default
        const browser = await runBrowserStep(
          async () => await manager.getBrowser(),
          boundary.signal,
          async lateBrowser => await releaseManagedBrowser(manager, lateBrowser)
        )
        if (!browser) return Object.freeze({ kind: 'not_rendered', code: 'local_renderer_unavailable' })
        browserHandle = browser
        page = await runBrowserStep(
          async () => await browser.newPage(),
          boundary.signal,
          closePageWithinBoundary
        )
        await runBrowserStep(async () => await page.setViewport({
          width: input.viewport.width,
          height: 720,
          deviceScaleFactor: Math.min(input.viewport.deviceScaleFactor, 1)
        }), boundary.signal)
        await runBrowserStep(async () => await page.setContent(input.html, {
          waitUntil: 'networkidle0', timeout: boundary.timeoutMs
        }), boundary.signal)
        const height = await runBrowserStep(async () => await page.evaluate(() => Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0
        )), boundary.signal)
        if (!Number.isFinite(height) || height <= 0 || height > input.maxContentHeightCssPx) {
          return Object.freeze({ kind: 'not_rendered', code: 'height_limit' })
        }
        const screenshotDpr = boundedScreenshotDpr(
          input.viewport.width, height, input.viewport.deviceScaleFactor
        )
        if (screenshotDpr === null) {
          return Object.freeze({ kind: 'not_rendered', code: 'height_limit' })
        }
        await runBrowserStep(async () => await page.setViewport({
          width: input.viewport.width,
          height: 720,
          deviceScaleFactor: screenshotDpr
        }), boundary.signal)
        const bytes = new Uint8Array(await runBrowserStep(
          async () => await page.screenshot({ type: 'png', fullPage: true }),
          boundary.signal
        ))
        if (boundary.signal.aborted || bytes.byteLength === 0 ||
          bytes.byteLength > 8 * 1024 * 1024) {
          return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
        }
        return Object.freeze({
          kind: 'rendered',
          source: 'local',
          resource: Object.freeze({
            kind: 'buffer', data: bytes, mimeType: 'image/png', byteLength: bytes.byteLength
          })
        })
      } catch {
        return Object.freeze({
          kind: 'not_rendered',
          code: boundary.signal.aborted ? 'render_timeout' : 'render_failed'
        })
      } finally {
        boundary.signal.removeEventListener('abort', onAbort)
        await closePageWithinBoundary(page)
        if (boundary.signal.aborted || input.closeBrowserAfterRender === true) {
          await releaseManagedBrowser(manager, browserHandle ?? manager?.browser)
        }
        boundary.dispose()
      }
    }
  })
}

function createLazyRemotePageBrowserPort () {
  return Object.freeze({
    async capture (input, signal) {
      if (signal?.aborted === true) {
        return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
      }
      const boundary = createBrowserOperationBoundary(input.timeoutMs, signal)
      let manager
      let page
      let browserHandle
      const onAbort = () => {
        void closePageWithinBoundary(page)
      }
      boundary.signal.addEventListener('abort', onAbort, { once: true })
      try {
        manager = (await import('./utils/browser.js')).default
        const browser = await runBrowserStep(
          async () => await manager.getBrowser(),
          boundary.signal,
          async lateBrowser => await releaseManagedBrowser(manager, lateBrowser)
        )
        if (!browser) return Object.freeze({ kind: 'not_rendered', code: 'local_renderer_unavailable' })
        browserHandle = browser
        page = await runBrowserStep(
          async () => await browser.newPage(),
          boundary.signal,
          closePageWithinBoundary
        )
        await runBrowserStep(async () => await page.setViewport({
          width: input.width,
          height: 720,
          deviceScaleFactor: Math.min(input.deviceScaleFactor, 1)
        }), boundary.signal)
        await runBrowserStep(async () => await page.goto(input.pageUrl, {
          waitUntil: 'networkidle0', timeout: boundary.timeoutMs
        }), boundary.signal)
        const height = await runBrowserStep(async () => await page.evaluate(() => Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0
        )), boundary.signal)
        if (!Number.isFinite(height) || height <= 0 || height > input.maxContentHeightCssPx) {
          return Object.freeze({ kind: 'not_rendered', code: 'height_limit' })
        }
        const screenshotDpr = boundedScreenshotDpr(input.width, height, input.deviceScaleFactor)
        if (screenshotDpr === null) {
          return Object.freeze({ kind: 'not_rendered', code: 'height_limit' })
        }
        await runBrowserStep(async () => await page.setViewport({
          width: input.width,
          height: 720,
          deviceScaleFactor: screenshotDpr
        }), boundary.signal)
        const bytes = new Uint8Array(await runBrowserStep(
          async () => await page.screenshot({ type: 'png', fullPage: true }),
          boundary.signal
        ))
        if (boundary.signal.aborted || bytes.byteLength === 0 ||
          bytes.byteLength > 8 * 1024 * 1024) {
          return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
        }
        return Object.freeze({
          kind: 'rendered',
          source: 'remote_page_local_browser',
          resource: Object.freeze({
            kind: 'buffer', data: bytes, mimeType: 'image/png', byteLength: bytes.byteLength
          })
        })
      } catch {
        return Object.freeze({
          kind: 'not_rendered',
          code: boundary.signal.aborted ? 'render_timeout' : 'render_failed'
        })
      } finally {
        boundary.signal.removeEventListener('abort', onAbort)
        await closePageWithinBoundary(page)
        if (boundary.signal.aborted || Config.closeBrowserAfterRender !== false) {
          await releaseManagedBrowser(manager, browserHandle ?? manager?.browser)
        }
        boundary.dispose()
      }
    }
  })
}

const remotePageBrowser = createLazyRemotePageBrowserPort()
const remotePictureRenderer = Object.freeze({
  async render (input, signal) {
    const page = createRemotePicturePagePort({
      baseUrl: normalizedText(Config.viewHost, 2_048),
      fetch: newFetch
    })
    if (page === null) {
      return Object.freeze({ kind: 'not_rendered', code: 'remote_base_url_invalid' })
    }
    const cloud = Config.cloudRender === true
      ? createCloudScreenshotPort({
          baseUrl: normalizedText(Config.cloudTranscode, 2_048),
          fetch: newFetch
        })
      : null
    return await createRemoteGroupMatePictureRenderer({
      page,
      localBrowser: remotePageBrowser,
      cloud,
      chatViewWidth: () => Config.chatViewWidth
    }).render(input, signal)
  }
})

const pictureRenderer = createGroupMatePictureRenderer({
  template: fs.readFileSync(resolvePluginPath('resources/reply/groupmate.html'), 'utf8'),
  browser: createLazyBrowserPicturePort(),
  remote: remotePictureRenderer,
  live2dAssets: createLive2dAssetResolver(resolvePluginPath('server/static/live2d')),
  chatViewWidth: () => Config.chatViewWidth,
  appearance: () => ({
    botName: normalizedText(
      Config.chatViewBotName,
      80,
      normalizedText(Config.assistantLabel, 80, 'GroupMate')
    ),
    toneStyle: normalizedText(Config.toneStyle, 32, 'Creative')
  })
})

async function boundedResponseBytes (response, maximumBytes) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const normalized = String(contentLength).trim()
    if (!/^(?:0|[1-9][0-9]*)$/.test(normalized) ||
      Number(normalized) <= 0 || Number(normalized) > maximumBytes) {
      throw new Error('audio download size is invalid')
    }
  }
  if (response.body?.[Symbol.asyncIterator] === undefined) {
    throw new Error('audio download body is unavailable')
  }
  const chunks = []
  let byteLength = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > maximumBytes) {
      response.body.destroy?.()
      throw new Error('audio download size is invalid')
    }
    chunks.push(bytes)
  }
  if (byteLength === 0) throw new Error('audio download size is invalid')
  return Buffer.concat(chunks, byteLength)
}

function boundedAudioBytes (value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 ||
    value.byteLength > MAX_AUDIO_BYTES) throw new Error('audio resource size is invalid')
  return new Uint8Array(value)
}

function decodeBoundedAudioBase64 (value) {
  if (typeof value !== 'string' || value === '' ||
    value.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4) {
    throw new Error('audio resource size is invalid')
  }
  return boundedAudioBytes(Buffer.from(value, 'base64'))
}

async function audioResource (value, raw, signal) {
  const record = value !== null && typeof value === 'object' ? value : {}
  const file = record.file ?? record.data?.file ?? value
  if (file instanceof Uint8Array) {
    const data = boundedAudioBytes(file)
    return Object.freeze({
      kind: 'buffer', data,
      mimeType: 'audio/wav', byteLength: data.byteLength
    })
  }
  if (typeof file !== 'string' || file === '') throw new Error('audio resource is invalid')
  if (file.startsWith('base64://')) {
    const data = decodeBoundedAudioBase64(file.slice('base64://'.length))
    return Object.freeze({ kind: 'buffer', data, mimeType: 'audio/silk', byteLength: data.byteLength })
  }
  if (file.startsWith('protobuf://')) {
    const byteLength = decodeBoundedAudioBase64(file.slice('protobuf://'.length)).byteLength
    return Object.freeze({ kind: 'local_path', path: file, mimeType: 'audio/silk', byteLength })
  }
  if (/^https?:\/\//i.test(file)) {
    const response = await newFetch(file, { signal })
    if (!response.ok) throw new Error('audio download failed')
    const data = await boundedResponseBytes(response, MAX_AUDIO_BYTES)
    return Object.freeze({ kind: 'buffer', data, mimeType: 'audio/wav', byteLength: data.byteLength })
  }
  try {
    const localPath = file.replace(/^file:\/\//, '')
    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUDIO_BYTES) {
      throw new Error('audio file size is invalid')
    }
    const data = await fs.promises.readFile(localPath)
    return Object.freeze({
      kind: 'buffer', data,
      mimeType: 'audio/wav', byteLength: data.byteLength
    })
  } catch {
    if (raw instanceof Uint8Array) {
      const data = boundedAudioBytes(raw)
      return Object.freeze({
        kind: 'buffer', data,
        mimeType: 'audio/wav', byteLength: data.byteLength
      })
    }
    throw new Error('audio path is unavailable')
  }
}

const ttsTargets = Object.freeze({
  async forTarget (target) {
    const bot = await botPicker.pick(target.botId)
    if (bot === null) return 'unavailable'
    const adapter = String(bot.adapter?.name ?? bot.adapter ?? '').toLowerCase()
    return adapter.includes('shamrock') ? 'shamrock_passthrough' : 'default'
  }
})

let lowMemoryTtsTail = Promise.resolve()

async function waitForQueueSlot (previous, signal) {
  if (signal?.aborted === true) throw signal.reason
  if (signal === undefined) return await previous
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    previous.then(() => finish(resolve), error => finish(reject, error))
  })
}

async function runLowMemoryTts (operation, signal) {
  const previous = lowMemoryTtsTail
  let release
  const own = new Promise(resolve => { release = resolve })
  lowMemoryTtsTail = previous.then(() => own, () => own)
  try {
    await waitForQueueSlot(previous, signal)
    return await operation()
  } finally {
    release()
  }
}

function createTtsOperationBoundary (signal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new DOMException('TTS operation timed out', 'TimeoutError'))
  }, TTS_OPERATION_TIMEOUT_MS)
  timer.unref?.()
  return Object.freeze({
    signal: controller.signal,
    dispose () {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  })
}

async function synthesizeTts (input, outerSignal) {
  const boundary = createTtsOperationBoundary(outerSignal)
  const signal = boundary.signal
  try {
    if (signal?.aborted === true) {
      return Object.freeze({ kind: 'failed_definite', code: 'aborted_before_dispatch' })
    }
    if (!ttsConfigured(input.mode)) {
      return Object.freeze({ kind: 'failed_definite', code: 'synthesis_rejected' })
    }
    let raw
    let temporaryFile
    try {
      if (input.mode === 'vits-uma-genshin-honkai') {
        raw = await generateVitsAudio(
          input.text, input.voice, undefined, undefined, undefined, undefined, signal
        )
      } else if (input.mode === 'azure') {
        const voice = azureVoice(input.voice)
        const languagePrefix = voice?.languageDetail?.startsWith('E')
          ? '英'
          : voice?.languageDetail?.charAt(0)
        const text = languagePrefix
          ? (await translate(input.text, languagePrefix, 'auto', signal)).replace('\n', '')
          : input.text
        const ssml = await AzureTTS.generateSsml(text, {
          speaker: input.voice,
          emotion: input.emotion,
          emotionDegree: input.emotionDegree
        })
        raw = await AzureTTS.generateAudio(text, { speaker: input.voice }, ssml, signal)
        temporaryFile = raw
      } else {
        const text = (await translate(input.text, '日', 'auto', signal)).replace('\n', '')
        raw = await VoiceVoxTTS.generateAudio(text, { speaker: input.voice, signal })
      }
      if (signal?.aborted === true) {
        return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_abort_after_dispatch' })
      }
      const uploadRecord = (await import('./utils/uploadRecord.js')).default
      let sendable = await uploadRecord(
        raw,
        input.mode,
        input.recordEncoding === 'shamrock_passthrough',
        signal
      )
      if (signal.aborted) {
        return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_abort_after_dispatch' })
      }
      if (!sendable && typeof globalThis.segment.record === 'function') {
        sendable = globalThis.segment.record(raw)
      }
      if (!sendable) return Object.freeze({ kind: 'failed_definite', code: 'synthesis_rejected' })
      return Object.freeze({ kind: 'ready', audio: await audioResource(sendable, raw, signal) })
    } catch {
      return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_exception' })
    } finally {
      if (typeof temporaryFile === 'string') {
        await fs.promises.unlink(temporaryFile).catch(() => undefined)
      }
    }
  } finally {
    boundary.dispose()
  }
}

const ttsBackend = Object.freeze({
  async synthesize (input, signal) {
    try {
      return await runLowMemoryTts(async () => await synthesizeTts(input, signal), signal)
    } catch {
      return Object.freeze({ kind: 'failed_definite', code: 'aborted_before_dispatch' })
    }
  }
})
const tts = createYunzaiTtsReplyPort({ targets: ttsTargets, backend: ttsBackend })

async function loadGroupHistory (event, limit) {
  if (event?.isGroup !== true || typeof event?.group?.getChatHistory !== 'function') {
    return Object.freeze([])
  }
  try {
    const history = await event.group.getChatHistory(
      resolveYunzaiGroupHistoryCursor(event),
      limit
    )
    return Object.freeze(Array.isArray(history) ? history.slice(-limit) : [])
  } catch {
    return Object.freeze([])
  }
}

const modelPort = createProductionModelPort()
configureAuxiliaryCompletionService({
  model: () => normalizedText(Config.model, 256),
  adapter: modelPort,
  timeoutMs: () => finiteInteger(Config.defaultTimeoutMs, 120_000, 1, 120_000),
  temperature: () => Config.temperature
})
configureTranslationService({
  model: Object.freeze({
    model: () => normalizedText(Config.model, 256),
    adapter: modelPort,
    timeoutMs: () => finiteInteger(Config.defaultTimeoutMs, 120_000, 1, 120_000),
    temperature: () => Config.temperature
  }),
  fetch: newFetch,
  logger: runtimeLogger
})
initializeProductionYunzaiAgent({
  bridge: Object.freeze({
    config: Config,
    redis: redisClient,
    getMasterIds: masterIds,
    getBotId: configuredBotId,
    getImages: async event => eventImageUrls(event),
    synthesizeAudio: async (event, text, voice, signal) => {
      const result = await tts.synthesize({
        target: eventTarget(event),
        text,
        mode: ttsMode(),
        voice
      }, signal)
      if (result.kind !== 'ready') throw new Error(`tool audio unavailable: ${result.code}`)
      return result.audio
    },
    loadGroupHistory,
    segment: () => globalThis.segment,
    logger: runtimeLogger
  }),
  botPicker,
  outboundHost,
  presentationSettings,
  pendingConfig,
  hooks,
  chatPolicy,
  chatPreferences,
  ttsAdministration,
  billing,
  bymPolicy,
  buttonPolicy,
  pictureRenderer,
  tts,
  modelFactory: () => modelPort
})

const files = fs.readdirSync(resolvePluginPath('apps')).filter(file => file.endsWith('.js'))
const loaded = await Promise.allSettled(files.map(async file => await import(`./apps/${file}`)))
const apps = {}
for (let index = 0; index < files.length; index += 1) {
  const name = files[index].replace('.js', '')
  const result = loaded[index]
  if (result.status !== 'fulfilled') {
    runtimeLogger.error(`载入插件错误：${name}`)
    runtimeLogger.error(result.reason)
    continue
  }
  apps[name] = result.value[Object.keys(result.value)[0]]
}

globalThis.chatgpt = {}

if (Config.enableToolbox) {
  runtimeLogger.info('开启工具箱配置项，工具箱启动中')
  const { createServer, runServer } = await import('./server/index.js')
  await createServer()
  await runServer()
  runtimeLogger.info('工具箱启动成功')
} else {
  runtimeLogger.info('提示：当前配置未开启chatgpt工具箱，可通过锅巴或`#chatgpt开启工具箱`指令开启')
}

runtimeLogger.info(`${pluginDisplayName}加载成功`)
runtimeLogger.info(`当前版本${Config.version}`)
runtimeLogger.info(`仓库地址 ${repositoryUrl}`)
runtimeLogger.info('文档地址 https://www.yunzai.chat')
runtimeLogger.info('**************************************')

export { apps }
