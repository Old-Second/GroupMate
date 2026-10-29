// Batch 4 of the `index.js` host-bootstrap migration: Redis-backed chat preferences and the chat
// entry policy (entry mode, snapshot, mute, OCR, Azure emotion feedback, actor cast store).
//
// The legacy declarations are sliced out of a pinned `index.js` and executed for real. Redis, the
// cast file store and the Azure voice table are host-side dependencies the legacy code received as
// module scope, so they arrive here as recording stubs: a row therefore pins both the returned value
// and the exact host calls the helper made, including the key it read and the JSON it wrote back.
import path from 'node:path'
import {
  configuredReasoningEffort,
  configuredThinkingMode,
  finiteInteger,
  normalizedStringList,
  normalizedText
} from '../runtime/host/host-config-values.js'
import {
  parsePreferenceRecord,
  projectChatPreferences,
  resolveTtsMode
} from '../runtime/host/host-config-projection.js'
import { resolvePluginPath } from '../runtime/plugin-context.js'
import type { HostAzureVoice } from '../runtime/host/host-voice-tables.js'
import type {
  ChatEntryPolicyPort,
  ChatPreferencePort,
  ChatPreferences
} from '../runtime/yunzai-chat-controller.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import {
  encodeValue,
  legacyIndexSource,
  sliceBlock,
  sourceSha256,
  writeFixture,
  type Encoded
} from './host-bootstrap-fixture.js'

export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-4-preferences-policy.json'

export type Recorder = (entry: Readonly<Record<string, unknown>>) => void

// `actorCast` stays private to the policy: the snapshot is its only caller, in the legacy entry
// point and in the migrated module alike. The image collector and the voice lookup are public
// because the host bootstrap also hands them to the tool runtime and the TTS backend.
export interface ChatPolicyApi {
  chatPreferences: ChatPreferencePort
  chatPolicy: ChatEntryPolicyPort
  eventImageUrls: (event: unknown) => unknown
  azureVoice: (voice: string) => unknown
}

export const AZURE_VOICES: readonly HostAzureVoice[] = Object.freeze([
  Object.freeze({
    code: 'zh-CN-XiaochenNeural', name: '晓辰', gender: '女', languageDetail: '中文（普通话）'
  }),
  Object.freeze({
    code: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', languageDetail: '中文（普通话）',
    emotion: Object.freeze(['general', 'cheerful'])
  }),
  Object.freeze({
    code: 'en-US-JennyNeural', name: 'Jenny', gender: '女', languageDetail: 'English (US)',
    emotion: Object.freeze(['general'])
  })
])

export const CONFIGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  empty: Object.freeze({}),
  atMode: Object.freeze({
    toggleMode: 'at', enablePrivateChat: true, whitelist: ['1', '1', '2'], blacklist: '3',
    imgOcr: true, groupMerge: true, enableGroupContext: true, apiThinkingMode: 'enabled',
    apiReasoningEffort: 'high', conversationPreserveTime: 600, assistantLabel: '小助手',
    promptPrefixOverride: '前缀', defaultUsePicture: true, defaultUseTTS: true,
    defaultTTSRole: '胡桃', azureTTSSpeaker: 'zh-CN-XiaoxiaoNeural',
    voicevoxTTSSpeaker: '四国めたん'
  }),
  prefixMode: Object.freeze({
    toggleMode: 'prefix', conversationPreserveTime: 0, apiThinkingMode: 'ENABLED',
    apiReasoningEffort: 'highest', whitelist: 42, blacklist: []
  }),
  azureEmotion: Object.freeze({
    ttsMode: 'azure', enhanceAzureTTSEmotion: true, azureTTSEmotion: true,
    azureTTSSpeaker: 'zh-CN-XiaoxiaoNeural'
  }),
  azureEmotionDisabled: Object.freeze({
    ttsMode: 'azure', enhanceAzureTTSEmotion: true, azureTTSEmotion: false
  }),
  vitsMode: Object.freeze({
    ttsMode: 'vits-uma-genshin-honkai', enhanceAzureTTSEmotion: true, azureTTSEmotion: true
  }),
  negativeTtl: Object.freeze({ conversationPreserveTime: -5, toggleMode: 'at' })
})

export const REDIS_STORES: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    empty: Object.freeze({}),
    mutedEverywhere: Object.freeze({ 'CHATGPT:SHUT_UP:ALL': '1' }),
    mutedOneGroup: Object.freeze({ 'CHATGPT:SHUT_UP:700': 'yes' }),
    emotionFlagOne: Object.freeze({ 'CHATGPT:WRONG_EMOTION:555': '1' }),
    emotionFlagThree: Object.freeze({ 'CHATGPT:WRONG_EMOTION:555': 3 }),
    emotionFlagUnknown: Object.freeze({ 'CHATGPT:WRONG_EMOTION:555': '9' }),
    storedPreferences: Object.freeze({
      'CHATGPT:USER:555': '{"usePicture":true,"ttsRole":"钟离","unrelated":{"keep":1}}'
    }),
    malformedPreferences: Object.freeze({ 'CHATGPT:USER:555': 'not json' })
  })

export const CAST_FILES: Readonly<Record<string, string>> = Object.freeze({
  '555': '{"cast":{"api":"你是可靠的群友。"}}',
  '556': '{"cast":{}}',
  '557': 'not json',
  '558': `{"cast":{"api":${JSON.stringify('长'.repeat(9_000))}}}`,
  '559': '{"cast":{"api":"   "}}'
})

export const ACTOR_IDS: readonly string[] =
  Object.freeze(['555', '556', '557', '558', '559', '560', '', 'bad id', 'a'.repeat(129)])

const IMAGE = (url: unknown): Readonly<Record<string, unknown>> =>
  Object.freeze({ type: 'image', url })

export const EVENTS: Readonly<Record<string, unknown>> = Object.freeze({
  absent: undefined,
  noMessage: Object.freeze({ sender: Object.freeze({ user_id: '555' }) }),
  messageNotArray: Object.freeze({ message: 'text', sender: Object.freeze({ user_id: '555' }) }),
  oneImage: Object.freeze({
    sender: Object.freeze({ user_id: '555' }),
    message: Object.freeze([IMAGE('https://fixture.invalid/1.png')])
  }),
  duplicateImages: Object.freeze({
    sender: Object.freeze({ user_id: '555' }),
    message: Object.freeze([
      IMAGE('https://fixture.invalid/1.png'),
      IMAGE('https://fixture.invalid/1.png'),
      IMAGE('https://fixture.invalid/2.png')
    ])
  }),
  mixedSegments: Object.freeze({
    sender: Object.freeze({ user_id: '556' }),
    message: Object.freeze([
      Object.freeze({ type: 'text', text: '看图' }),
      null,
      'primitive',
      Object.freeze({ type: 'image', file: 'https://fixture.invalid/3.png' }),
      Object.freeze({ type: 'image', data: Object.freeze({ url: 'https://fixture.invalid/4.png' }) }),
      Object.freeze({ type: 'image', data: Object.freeze({ file: 'https://fixture.invalid/5.png' }) }),
      Object.freeze({ type: 'image', url: 7 }),
      Object.freeze({ type: 'image', url: `https://fixture.invalid/${'q'.repeat(4_096)}` })
    ])
  }),
  // Twelve distinct images probe the eight-image cap, which counts before de-duplication.
  manyImages: Object.freeze({
    sender: Object.freeze({ user_id: '555' }),
    message: Object.freeze(Array.from(
      { length: 12 }, (_, index) => IMAGE(`https://fixture.invalid/m${index}.png`)
    ))
  }),
  cappedDuplicates: Object.freeze({
    sender: Object.freeze({ user_id: '555' }),
    message: Object.freeze(Array.from({ length: 12 }, (_, index) =>
      IMAGE(`https://fixture.invalid/d${index % 3}.png`)))
  })
})

export const OCR_BEHAVIOURS: Readonly<Record<string, string>> = Object.freeze({
  absent: 'absent',
  words: 'words',
  empty: 'empty',
  malformed: 'malformed',
  throws: 'throws',
  long: 'long'
})

export const PREFERENCE_PATCHES: readonly Readonly<Record<string, unknown>>[] = Object.freeze([
  Object.freeze({}),
  Object.freeze({ usePicture: true }),
  Object.freeze({ usePicture: 'true' }),
  Object.freeze({ useTTS: false, usePicture: false }),
  Object.freeze({ ttsRole: '  钟离  ' }),
  Object.freeze({ ttsRole: '   ' }),
  Object.freeze({ ttsRole: 7 }),
  Object.freeze({ ttsRoleAzure: 'zh-CN-XiaoxiaoNeural', ttsRoleVoiceVox: '四国めたん' }),
  Object.freeze({ ttsRole: 'ロ'.repeat(600) })
])

export const PREFERENCES: Readonly<Record<string, ChatPreferences>> = Object.freeze({
  ttsOff: Object.freeze({
    usePicture: false, useTTS: false, ttsRole: '纳西妲',
    ttsRoleAzure: 'zh-CN-XiaoxiaoNeural', ttsRoleVoiceVox: '护士机器子T'
  }),
  ttsOnEmotionVoice: Object.freeze({
    usePicture: false, useTTS: true, ttsRole: '纳西妲',
    ttsRoleAzure: 'zh-CN-XiaoxiaoNeural', ttsRoleVoiceVox: '护士机器子T'
  }),
  ttsOnPlainVoice: Object.freeze({
    usePicture: false, useTTS: true, ttsRole: '纳西妲',
    ttsRoleAzure: 'zh-CN-XiaochenNeural', ttsRoleVoiceVox: '护士机器子T'
  }),
  ttsOnNamedVoice: Object.freeze({
    usePicture: false, useTTS: true, ttsRole: '纳西妲',
    ttsRoleAzure: '晓晓', ttsRoleVoiceVox: '护士机器子T'
  }),
  ttsOnUnknownVoice: Object.freeze({
    usePicture: false, useTTS: true, ttsRole: '纳西妲',
    ttsRoleAzure: '不存在', ttsRoleVoiceVox: '护士机器子T'
  })
})

export const TARGETS: Readonly<Record<string, SessionAddress>> = Object.freeze({
  group: Object.freeze({
    botId: '10001', scope: Object.freeze({ kind: 'group' as const, groupId: '700' })
  }),
  otherGroup: Object.freeze({
    botId: '10001', scope: Object.freeze({ kind: 'group' as const, groupId: '701' })
  }),
  groupUser: Object.freeze({
    botId: '10001',
    scope: Object.freeze({ kind: 'group_user' as const, groupId: '700', userId: '555' })
  }),
  private: Object.freeze({
    botId: '10001', scope: Object.freeze({ kind: 'private' as const, userId: '555' })
  }),
  // A private scope that still carries a group id: the mute check must decide on `kind`, not on
  // whether the property happens to be there.
  privateWithGroupId: Object.freeze({
    botId: '10001',
    scope: Object.freeze({ kind: 'private' as const, userId: '555', groupId: '700' })
  }) as SessionAddress,
  blankGroup: Object.freeze({
    botId: '10001', scope: Object.freeze({ kind: 'group' as const, groupId: '' })
  })
})

// Events driven through `ocrText`, which is the only production path into the image collector and
// its eight-image cap.
export const OCR_EVENTS: readonly string[] = Object.freeze([
  'absent', 'noMessage', 'messageNotArray', 'oneImage', 'duplicateImages', 'mixedSegments',
  'manyImages', 'cappedDuplicates'
])

export interface PolicyScenario {
  readonly config: string
  readonly redis: string
  readonly ocr: string
}

export interface PolicyRow {
  readonly fn: string
  readonly config: string
  readonly redis: string
  readonly args: readonly Encoded[]
  readonly result: Encoded
  readonly calls: readonly Encoded[]
  readonly frozen: boolean | null
}

export type PolicyFactory = (
  config: Record<string, unknown>, scenario: PolicyScenario, log: Recorder
) => ChatPolicyApi

export function recordingRedis (store: Readonly<Record<string, unknown>>, log: Recorder): Readonly<{
  get: (key: string) => Promise<unknown>
  set: (key: string, value: string) => Promise<unknown>
  del: (key: string) => Promise<unknown>
}> {
  const values: Record<string, unknown> = { ...store }
  return Object.freeze({
    get: async (key: string) => {
      log({ host: 'redis.get', key, hit: Object.hasOwn(values, key) })
      return values[key]
    },
    set: async (key: string, value: string) => {
      log({ host: 'redis.set', key, value: encodeValue(value) })
      values[key] = value
      return 'OK'
    },
    del: async (key: string) => {
      log({ host: 'redis.del', key })
      delete values[key]
      return 1
    }
  })
}

export function recordingCastStore (log: Recorder): (filePath: string) => Promise<string> {
  return async (filePath: string) => {
    const actorId = filePath.replace(/^.*\//, '').replace(/\.json$/, '')
    const relative = filePath.slice(filePath.indexOf('resources/'))
    log({ host: 'readFile', path: relative })
    const content = CAST_FILES[actorId]
    if (content === undefined) throw new Error('ENOENT: no such cast file')
    return content
  }
}

// The host OCR adapter: `imageOcr` must be called as a method on `event.bot`, so the stub records
// its receiver as well as the image it was handed.
export function ocrEvent (event: unknown, behaviour: string, log: Recorder): unknown {
  if (event === null || typeof event !== 'object' || behaviour === 'absent') return event
  const bot = {
    label: 'host-bot',
    imageOcr (this: unknown, image: unknown): unknown {
      log({
        host: 'imageOcr',
        image: encodeValue(image),
        receiver: (this as { readonly label?: unknown })?.label ?? null
      })
      if (behaviour === 'throws') throw new Error('OCR backend refused the image')
      if (behaviour === 'empty') return { wordslist: [] }
      if (behaviour === 'malformed') return { wordslist: 'nope' }
      if (behaviour === 'long') {
        return { wordslist: [{ words: '字'.repeat(3_000) }] }
      }
      return { wordslist: [{ words: `识别:${String(image).slice(-7)}` }, { notWords: 1 }] }
    }
  }
  return { ...(event as Record<string, unknown>), bot }
}

async function runPreferenceSequence (
  api: ChatPolicyApi, actorId: string, patch: Readonly<Record<string, unknown>>
): Promise<unknown> {
  const before = await api.chatPreferences.load(actorId)
  const patched = await api.chatPreferences.patch(actorId, patch)
  const after = await api.chatPreferences.load(actorId)
  return Object.freeze({ before, patched, after })
}

export async function runCase (
  api: ChatPolicyApi,
  config: Record<string, unknown>,
  fn: string,
  args: readonly unknown[],
  behaviour: string,
  log: Recorder
): Promise<{ readonly result: unknown; readonly frozen: boolean | null }> {
  let result: unknown
  try {
    if (fn === 'chatPreferences.load') result = await api.chatPreferences.load(String(args[0]))
    else if (fn === 'chatPreferences.patch') {
      result = await runPreferenceSequence(
        api, String(args[0]), PREFERENCE_PATCHES[Number(args[1])]
      )
    } else if (fn === 'eventImageUrls') result = api.eventImageUrls(EVENTS[String(args[0])])
    else if (fn === 'azureVoice') result = api.azureVoice(String(args[0]))
    else if (fn === 'chatPolicy.entryMode') result = api.chatPolicy.entryMode()
    else if (fn === 'chatPolicy.snapshot') {
      result = await api.chatPolicy.snapshot(EVENTS[String(args[0])] as never)
    } else if (fn === 'chatPolicy.snapshotForActor') {
      result = await api.chatPolicy.snapshot(
        Object.freeze({ sender: Object.freeze({ user_id: args[0] }) }) as never
      )
    } else if (fn === 'chatPolicy.isMuted') {
      result = await api.chatPolicy.isMuted(TARGETS[String(args[0])])
    } else if (fn === 'chatPolicy.ocrText') {
      result = await api.chatPolicy.ocrText(
        ocrEvent(EVENTS[String(args[0])], behaviour, log) as never
      )
    } else if (fn === 'chatPolicy.appendAzureEmotionFeedback') {
      result = await api.chatPolicy.appendAzureEmotionFeedback({
        actorId: String(args[0]),
        prompt: '原始提示',
        preferences: PREFERENCES[String(args[1])]
      })
    } else if (fn === 'chatPolicy.clearAzureEmotionFeedback') {
      await api.chatPolicy.clearAzureEmotionFeedback(String(args[0]))
      result = 'cleared'
    } else if (fn === 'entryModeAfterConfigChange') {
      // `toggleMode` is read once at construction on purpose: changing it needs a restart.
      const before = api.chatPolicy.entryMode()
      config.toggleMode = config.toggleMode === 'prefix' ? 'at' : 'prefix'
      const snapshot = await api.chatPolicy.snapshot(EVENTS.noMessage as never)
      result = Object.freeze({
        before, changedTo: config.toggleMode, after: api.chatPolicy.entryMode(),
        snapshotToggleMode: snapshot.toggleMode
      })
    } else throw new Error(`no caller for ${fn}`)
  } catch (error) {
    result = error
  }
  return Object.freeze({
    result,
    frozen: result !== null && typeof result === 'object' ? Object.isFrozen(result) : null
  })
}

async function row (
  create: PolicyFactory,
  fn: string,
  scenario: PolicyScenario,
  args: readonly unknown[]
): Promise<PolicyRow> {
  const calls: Encoded[] = []
  const log: Recorder = entry => { calls.push(encodeValue(entry)) }
  const config: Record<string, unknown> = { ...CONFIGS[scenario.config] }
  const api = create(config, scenario, log)
  const { result, frozen } = await runCase(api, config, fn, args, scenario.ocr, log)
  return Object.freeze({
    fn,
    config: scenario.config,
    redis: scenario.redis,
    args: Object.freeze(args.map(encodeValue)),
    result: encodeValue(result),
    calls: Object.freeze(calls),
    frozen
  })
}

const EMOTION_CONFIGS: readonly string[] =
  Object.freeze(['azureEmotion', 'azureEmotionDisabled', 'vitsMode'])

export async function buildRowsWith (create: PolicyFactory): Promise<readonly PolicyRow[]> {
  const rows: PolicyRow[] = []
  const at = (
    config: string, redis = 'empty', ocr = 'words'
  ): PolicyScenario => Object.freeze({ config, redis, ocr })

  for (const redis of ['empty', 'storedPreferences', 'malformedPreferences']) {
    for (const config of ['empty', 'atMode']) {
      rows.push(await row(create, 'chatPreferences.load', at(config, redis), ['555']))
    }
  }
  for (const [index] of PREFERENCE_PATCHES.entries()) {
    for (const redis of ['empty', 'storedPreferences']) {
      rows.push(await row(
        create, 'chatPreferences.patch', at('atMode', redis), ['555', index]
      ))
    }
  }
  // The cast store is only reachable through a snapshot, which is also the only way production
  // reaches it: the actor id comes from the event.
  for (const actorId of ACTOR_IDS) {
    rows.push(await row(create, 'chatPolicy.snapshotForActor', at('empty'), [actorId]))
  }
  for (const name of Object.keys(EVENTS)) {
    rows.push(await row(create, 'eventImageUrls', at('empty'), [name]))
  }
  for (const voice of ['zh-CN-XiaoxiaoNeural', '晓晓', 'zh-CN-XiaochenNeural', '不存在', '']) {
    rows.push(await row(create, 'azureVoice', at('empty'), [voice]))
  }
  for (const behaviour of Object.keys(OCR_BEHAVIOURS)) {
    for (const name of OCR_EVENTS) {
      rows.push(await row(create, 'chatPolicy.ocrText', at('empty', 'empty', behaviour), [name]))
    }
  }
  for (const config of Object.keys(CONFIGS)) {
    rows.push(await row(create, 'chatPolicy.entryMode', at(config), []))
    rows.push(await row(create, 'chatPolicy.snapshot', at(config), ['noMessage']))
  }
  rows.push(await row(create, 'chatPolicy.snapshot', at('atMode'), ['mixedSegments']))
  rows.push(await row(create, 'chatPolicy.snapshot', at('atMode'), ['absent']))
  for (const redis of ['empty', 'mutedEverywhere', 'mutedOneGroup']) {
    for (const target of Object.keys(TARGETS)) {
      rows.push(await row(create, 'chatPolicy.isMuted', at('empty', redis), [target]))
    }
  }
  // The emotion flag is only read once every gate passes, so the flag values are crossed for the
  // fully enabled config and held fixed for the configs that short-circuit before Redis.
  for (const config of EMOTION_CONFIGS) {
    for (const preferences of Object.keys(PREFERENCES)) {
      const stores = config === 'azureEmotion'
        ? ['emotionFlagOne', 'emotionFlagThree', 'emotionFlagUnknown', 'empty']
        : ['emotionFlagOne']
      for (const redis of stores) {
        rows.push(await row(
          create, 'chatPolicy.appendAzureEmotionFeedback', at(config, redis),
          ['555', preferences]
        ))
      }
    }
  }
  for (const redis of ['empty', 'emotionFlagOne']) {
    rows.push(await row(
      create, 'chatPolicy.clearAzureEmotionFeedback', at('empty', redis), ['555']
    ))
  }
  for (const config of ['atMode', 'prefixMode']) {
    rows.push(await row(create, 'entryModeAfterConfigChange', at(config), []))
  }
  return Object.freeze(rows)
}

const LEGACY_FUNCTIONS: readonly string[] = Object.freeze(['eventImageUrls', 'azureVoice'])
const LEGACY_ASYNC_FUNCTIONS: readonly string[] =
  Object.freeze(['actorCast', 'ocrText', 'appendAzureEmotionFeedback'])
const ENTRY_MODE_DECLARATION =
  "const bootstrapEntryMode = Config.toggleMode === 'prefix' ? 'prefix' : 'at'"

export function legacyChatPolicy (
  source: string, config: Record<string, unknown>, scenario: PolicyScenario, log: Recorder
): ChatPolicyApi {
  if (!source.includes(`\n${ENTRY_MODE_DECLARATION}\n`)) {
    throw new Error('baseline index.js has no bootstrapEntryMode declaration')
  }
  const blocks = [
    sliceBlock(source, '\nconst chatPreferences = Object.freeze({', '\n})\n', 'chatPreferences'),
    ...LEGACY_FUNCTIONS.map(name => sliceBlock(source, `\nfunction ${name} (`, '\n}\n', name)),
    ...LEGACY_ASYNC_FUNCTIONS.map(
      name => sliceBlock(source, `\nasync function ${name} (`, '\n}\n', name)
    ),
    ENTRY_MODE_DECLARATION,
    sliceBlock(source, '\nconst chatPolicy = Object.freeze({', '\n})\n', 'chatPolicy')
  ]
  const names = [
    'Config', 'redisClient', 'fs', 'path', 'resolvePluginPath', 'normalizedText',
    'normalizedStringList', 'finiteInteger', 'configuredThinkingMode',
    'configuredReasoningEffort', 'projectPreferences', 'parsePreferenceRecord', 'ttsMode',
    'azureVoices', 'eventActorId'
  ]
  const factory = new Function(
    ...names,
    `${blocks.join('\n')}\nreturn { chatPreferences, chatPolicy, eventImageUrls, azureVoice }`
  ) as (...values: readonly unknown[]) => ChatPolicyApi
  const readTextFile = recordingCastStore(log)
  return factory(
    config,
    recordingRedis(REDIS_STORES[scenario.redis], log),
    { promises: { readFile: async (filePath: string) => await readTextFile(filePath) } },
    path,
    resolvePluginPath,
    normalizedText,
    normalizedStringList,
    finiteInteger,
    configuredThinkingMode,
    configuredReasoningEffort,
    (stored: Readonly<Record<string, unknown>>) => projectChatPreferences(stored, config),
    parsePreferenceRecord,
    () => resolveTtsMode(config),
    AZURE_VOICES,
    legacyEventActorId
  )
}

// Batch 2 already holds `eventActorId` to its own captured rows, so this batch reuses the proven
// behaviour instead of re-slicing it.
function legacyEventActorId (event: unknown): string {
  const source = event !== null && typeof event === 'object'
    ? event as Record<string, unknown>
    : {}
  const sender = source.sender !== null && typeof source.sender === 'object'
    ? source.sender as Record<string, unknown>
    : {}
  return normalizedText(String(sender.user_id ?? source.user_id ?? ''), 128)
}

export async function buildRows (source: string): Promise<readonly PolicyRow[]> {
  return await buildRowsWith(
    (config, scenario, log) => legacyChatPolicy(source, config, scenario, log)
  )
}

export interface PolicyFixture {
  readonly schemaVersion: 1
  readonly baselineCommit: string
  readonly baselineSha256: string
  readonly generator: string
  readonly sectionName: 'scenarios'
  readonly section: Readonly<Record<string, Encoded>>
  readonly rows: readonly PolicyRow[]
}

export async function captureBaseline (source: string): Promise<PolicyFixture> {
  return Object.freeze({
    schemaVersion: 1 as const,
    baselineCommit: BASELINE_COMMIT,
    baselineSha256: sourceSha256(source),
    generator: 'src/verification/host-chat-policy-baseline.ts',
    sectionName: 'scenarios' as const,
    section: Object.freeze({
      configs: encodeValue(CONFIGS),
      redisStores: encodeValue(REDIS_STORES),
      // Only the shape travels: one cast file is a 9,000-character payload that probes the 8,192
      // truncation bound, and the committed fixture has a 64 KiB budget. Both sides read the file
      // bodies from this module, and the replay gate asserts the key set matches.
      castFiles: encodeValue(Object.fromEntries(
        Object.entries(CAST_FILES).map(([actorId, content]) => [actorId, [...content].length])
      )),
      actorIds: encodeValue(ACTOR_IDS),
      events: encodeValue(Object.keys(EVENTS)),
      ocrBehaviours: encodeValue(OCR_BEHAVIOURS),
      preferencePatches: encodeValue(PREFERENCE_PATCHES),
      preferences: encodeValue(PREFERENCES),
      targets: encodeValue(TARGETS),
      ocrEvents: encodeValue(OCR_EVENTS),
      azureVoices: encodeValue(AZURE_VOICES)
    }),
    rows: await buildRows(source)
  })
}

export async function main (): Promise<void> {
  writeFixture(FIXTURE_PATH, await captureBaseline(legacyIndexSource(BASELINE_COMMIT)))
}
