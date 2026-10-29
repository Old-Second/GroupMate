import {
  configuredReasoningEffort,
  configuredThinkingMode,
  finiteInteger,
  finiteNumber,
  normalizedStringList,
  normalizedText,
  type HostConfigSource
} from './host-config-values.js'
import type { TtsMode, PresentationSettingsSource } from '../presentation/presentation-settings.js'
import type { BymPolicySnapshot } from '../yunzai-bym-controller.js'
import type { ChatPreferences } from '../yunzai-chat-controller.js'
import type { ButtonPolicySnapshot } from '../yunzai-button-content.js'

// Derived from the port rather than restated: if the presentation port changes its contract this
// projection stops compiling instead of silently feeding it a stale shape.
export type HostPresentationSafeConfig =
  ReturnType<PresentationSettingsSource['currentSafeConfig']>

const TTS_MODES: readonly TtsMode[] = Object.freeze(['azure', 'voicevox'])

export function resolveTtsMode (config: HostConfigSource): TtsMode {
  return TTS_MODES.find(item => item === config.ttsMode) ?? 'vits-uma-genshin-honkai'
}

export function projectPresentationSafeConfig (
  config: HostConfigSource
): HostPresentationSafeConfig {
  return Object.freeze({
    quoteReply: config.quoteReply === true,
    enableRobotAt: config.enableRobotAt === true,
    enableMd: config.enableMd === true,
    enableSuggestedResponses: config.enableSuggestedResponses === true,
    forwardReasoning: config.forwardReasoning !== false,
    blockWords: normalizedStringList(config.blockWords),
    promptBlockWords: normalizedStringList(config.promptBlockWords),
    defaultUsePicture: config.defaultUsePicture === true,
    defaultUseTTS: config.defaultUseTTS === true,
    defaultTTSRole: normalizedText(config.defaultTTSRole, 256, '纳西妲'),
    azureTTSSpeaker: normalizedText(config.azureTTSSpeaker, 256, 'zh-CN-XiaochenNeural'),
    voicevoxTTSSpeaker: normalizedText(config.voicevoxTTSSpeaker, 256, '护士机器子T'),
    ttsMode: resolveTtsMode(config),
    alsoSendText: config.alsoSendText === true,
    ttsAutoFallbackThreshold: finiteInteger(config.ttsAutoFallbackThreshold, 299, 1, 24_000),
    ttsRegex: typeof config.ttsRegex === 'string' ? config.ttsRegex : '',
    enhanceAzureTTSEmotion: config.enhanceAzureTTSEmotion === true,
    autoUsePicture: config.autoUsePicture !== false,
    autoUsePictureThreshold: finiteInteger(config.autoUsePictureThreshold, 1_200, 1, 24_000),
    cloudDPR: finiteNumber(config.cloudDPR, 1, 0.5, 4),
    closeBrowserAfterRender: config.closeBrowserAfterRender !== false,
    showQRCode: config.showQRCode !== false,
    live2d: config.live2d === true,
    live2dModel: normalizedText(
      config.live2dModel, 512, '/live2d/Murasame/Murasame.model3.json'
    ),
    live2dOption_scale: finiteNumber(config.live2dOption_scale, 0.1, 0, 10),
    live2dOption_positionX: finiteNumber(config.live2dOption_positionX, 0, -4_096, 4_096),
    live2dOption_positionY: finiteNumber(config.live2dOption_positionY, 0, -4_096, 4_096),
    live2dOption_rotation: finiteNumber(config.live2dOption_rotation, 0, -360, 360),
    live2dOption_alpha: finiteNumber(config.live2dOption_alpha, 1, 0, 1)
  })
}

export function projectDefaultPreferences (config: HostConfigSource): ChatPreferences {
  return Object.freeze({
    usePicture: config.defaultUsePicture === true,
    useTTS: config.defaultUseTTS === true,
    ttsRole: normalizedText(config.defaultTTSRole, 256, '纳西妲'),
    ttsRoleAzure: normalizedText(config.azureTTSSpeaker, 256, 'zh-CN-XiaochenNeural'),
    ttsRoleVoiceVox: normalizedText(config.voicevoxTTSSpeaker, 256, '护士机器子T')
  })
}

// Stays mutable on purpose: the preference patch path reads a record, assigns the accepted fields
// onto it and writes the same object back, so freezing here would break saving a preference.
export function parsePreferenceRecord (raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function projectChatPreferences (
  record: Readonly<Record<string, unknown>>,
  config: HostConfigSource
): ChatPreferences {
  const defaults = projectDefaultPreferences(config)
  return Object.freeze({
    usePicture: typeof record.usePicture === 'boolean' ? record.usePicture : defaults.usePicture,
    useTTS: typeof record.useTTS === 'boolean' ? record.useTTS : defaults.useTTS,
    ttsRole: normalizedText(record.ttsRole, 256, defaults.ttsRole),
    ttsRoleAzure: normalizedText(record.ttsRoleAzure, 256, defaults.ttsRoleAzure),
    ttsRoleVoiceVox: normalizedText(record.ttsRoleVoiceVox, 256, defaults.ttsRoleVoiceVox)
  })
}

export function projectButtonPolicySnapshot (config: HostConfigSource): ButtonPolicySnapshot {
  return Object.freeze({
    markdownEnabled: config.enableMd === true,
    openAiConfigured: normalizedText(config.apiKey, 16_384) !== '' &&
      normalizedText(config.openAiBaseUrl, 2_048) !== '' &&
      normalizedText(config.model, 256) !== ''
  })
}

export function projectBymPolicySnapshot (config: HostConfigSource): BymPolicySnapshot {
  return Object.freeze({
    enabled: config.enableBYM === true,
    assistantLabel: normalizedText(config.assistantLabel, 128, 'GroupMate'),
    recognizeLeadingAlias: config.bymRecognizeLeadingAlias !== false,
    ratePercent: finiteNumber(config.bymRate, 5, 0, 100),
    disabledGroupIds: normalizedStringList(config.bymDisableGroup, 256, 128),
    thinkingMode: configuredThinkingMode(config.bymThinkingMode),
    reasoningEffort: configuredReasoningEffort(config.bymReasoningEffort),
    preset: normalizedText(config.bymPreset, 8_192),
    retaliationWords: normalizedStringList(config.bymFuckList, 128, 128),
    retaliationBlacklistActorIds: normalizedStringList(config.bymFuckBlacklist, 256, 128),
    retaliationPrompt: normalizedText(config.bymFuckPrompt, 16_384),
    retaliationRecallEnabled: config.bymFuckRecall === true,
    retaliationRecallSeconds: finiteInteger(config.bymFuckRecallTime, 100, 1, 3_600)
  })
}
