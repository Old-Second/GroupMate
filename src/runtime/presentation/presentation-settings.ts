export type TtsMode = 'vits-uma-genshin-honkai' | 'azure' | 'voicevox'

export interface TtsPresentationSettings {
  readonly enabled: boolean
  readonly mode: TtsMode
  readonly activeVoice: string
  readonly alsoSendText: boolean
  readonly autoFallbackThreshold: number
  readonly filter: null | {
    readonly source: string
    readonly flags: string
  }
  readonly azureEmotionEnabled: boolean
}

export interface PicturePresentationSettings {
  readonly userEnabled: boolean
  readonly autoEnabled: boolean
  readonly autoThreshold: number
  readonly deviceScaleFactor: number
  readonly closeBrowserAfterRender: boolean
  readonly showQRCode: boolean
  readonly live2d: null | {
    readonly modelPath: string
    readonly scale: number
    readonly positionX: number
    readonly positionY: number
    readonly rotation: number
    readonly alpha: number
  }
}

export interface PresentationSettings {
  readonly schemaVersion: 1
  readonly quoteReply: boolean
  readonly enableRobotAt: boolean
  readonly enableMarkdown: boolean
  readonly enableSuggestedResponses: boolean
  readonly forwardReasoning: boolean
  readonly blockWords: readonly string[]
  readonly promptBlockWords: readonly string[]
  readonly tts: TtsPresentationSettings
  readonly picture: PicturePresentationSettings
}

export interface PresentationSettingsPort {
  load(actorId: string): Promise<PresentationSettings>
}

export interface PresentationSettingsSource {
  loadUserJson(actorId: string): Promise<string | null>
  currentSafeConfig(): Readonly<{
    quoteReply: boolean
    enableRobotAt: boolean
    enableMd: boolean
    enableSuggestedResponses: boolean
    forwardReasoning: boolean
    blockWords: readonly string[]
    promptBlockWords: readonly string[]
    defaultUsePicture: boolean
    defaultUseTTS: boolean
    defaultTTSRole: string
    azureTTSSpeaker: string
    voicevoxTTSSpeaker: string
    ttsMode: TtsMode
    alsoSendText: boolean
    ttsAutoFallbackThreshold: number
    ttsRegex: string
    enhanceAzureTTSEmotion: boolean
    autoUsePicture: boolean
    autoUsePictureThreshold: number
    cloudDPR: number
    closeBrowserAfterRender: boolean
    showQRCode: boolean
    live2d: boolean
    live2dModel: string
    live2dOption_scale: number
    live2dOption_positionX: number
    live2dOption_positionY: number
    live2dOption_rotation: number
    live2dOption_alpha: number
  }>
}

const DEFAULTS = Object.freeze({
  quoteReply: true,
  enableRobotAt: true,
  enableMarkdown: false,
  enableSuggestedResponses: false,
  forwardReasoning: true,
  defaultUsePicture: false,
  defaultUseTTS: false,
  defaultTTSRole: '纳西妲',
  azureTTSSpeaker: 'zh-CN-XiaochenNeural',
  voicevoxTTSSpeaker: '护士机器子T',
  ttsMode: 'vits-uma-genshin-honkai' as TtsMode,
  alsoSendText: false,
  ttsAutoFallbackThreshold: 299,
  autoUsePicture: true,
  autoUsePictureThreshold: 1_200,
  cloudDPR: 1,
  closeBrowserAfterRender: true,
  showQRCode: true,
  live2d: false,
  live2dModel: '/live2d/Murasame/Murasame.model3.json',
  live2dOptionScale: 0.1,
  live2dOptionPositionX: 0,
  live2dOptionPositionY: 0,
  live2dOptionRotation: 0,
  live2dOptionAlpha: 1
})

type UserOverrides = Readonly<{
  usePicture?: boolean
  useTTS?: boolean
  ttsRole?: string
  ttsRoleAzure?: string
  ttsRoleVoiceVox?: string
}>

function nfcText (value: string): string {
  return value.trim().normalize('NFC')
}

function boundedText (value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = nfcText(value)
  return normalized !== '' && [...normalized].length <= maximum ? normalized : fallback
}

function booleanValue (value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function finiteClamped (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  truncate = false
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const number = truncate ? Math.trunc(value) : value
  return Math.min(Math.max(number, minimum), maximum)
}

function normalizedWords (value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const words: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (words.length >= 256) break
    if (typeof item !== 'string') continue
    const normalized = nfcText(item)
    if (normalized === '') continue
    const bounded = [...normalized].slice(0, 128).join('')
    if (seen.has(bounded)) continue
    seen.add(bounded)
    words.push(bounded)
  }
  return Object.freeze(words)
}

function filterFrom (value: unknown): TtsPresentationSettings['filter'] {
  if (typeof value !== 'string') return null
  const matched = /^\/([\s\S]*)\/([a-z]*)$/.exec(value)
  if (matched === null) return null
  const source = matched[1] ?? ''
  const flags = matched[2] ?? ''
  if ([...source].length > 512 || [...flags].length > 8 ||
    /[^dgimsuy]/.test(flags) || new Set(flags).size !== flags.length) return null
  try {
    new RegExp(source, flags)
  } catch {
    return null
  }
  return Object.freeze({ source, flags })
}

function ttsMode (value: unknown): TtsMode {
  return value === 'azure' || value === 'voicevox' || value === 'vits-uma-genshin-honkai'
    ? value
    : DEFAULTS.ttsMode
}

function parseUserJson (value: string | null): UserOverrides {
  if (value === null) return Object.freeze({})
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.freeze({})
    }
    const record = parsed as Record<string, unknown>
    const result: {
      usePicture?: boolean
      useTTS?: boolean
      ttsRole?: string
      ttsRoleAzure?: string
      ttsRoleVoiceVox?: string
    } = {}
    if (Object.hasOwn(record, 'usePicture') && typeof record.usePicture === 'boolean') {
      result.usePicture = record.usePicture
    }
    if (Object.hasOwn(record, 'useTTS') && typeof record.useTTS === 'boolean') {
      result.useTTS = record.useTTS
    }
    for (const key of ['ttsRole', 'ttsRoleAzure', 'ttsRoleVoiceVox'] as const) {
      if (!Object.hasOwn(record, key) || typeof record[key] !== 'string') continue
      const normalized = nfcText(record[key])
      if (normalized !== '' && [...normalized].length <= 256) result[key] = normalized
    }
    return Object.freeze(result)
  } catch {
    return Object.freeze({})
  }
}

export function createPresentationSettingsPort (
  source: PresentationSettingsSource
): PresentationSettingsPort {
  return Object.freeze({
    async load (actorId: string): Promise<PresentationSettings> {
      const config = source.currentSafeConfig()
      let userJson: string | null = null
      try {
        userJson = await source.loadUserJson(actorId)
      } catch {}
      const user = parseUserJson(userJson)
      const mode = ttsMode(config.ttsMode)
      const defaultRole = boundedText(config.defaultTTSRole, 256, DEFAULTS.defaultTTSRole)
      const azureRole = boundedText(config.azureTTSSpeaker, 256, DEFAULTS.azureTTSSpeaker)
      const voicevoxRole = boundedText(config.voicevoxTTSSpeaker, 256, DEFAULTS.voicevoxTTSSpeaker)
      const selectedRoles = Object.freeze({
        'vits-uma-genshin-honkai': boundedText(user.ttsRole, 256, defaultRole),
        azure: boundedText(user.ttsRoleAzure, 256, azureRole),
        voicevox: boundedText(user.ttsRoleVoiceVox, 256, voicevoxRole)
      })
      const live2dEnabled = booleanValue(config.live2d, DEFAULTS.live2d)
      const tts = Object.freeze({
        enabled: user.useTTS ?? booleanValue(config.defaultUseTTS, DEFAULTS.defaultUseTTS),
        mode,
        activeVoice: selectedRoles[mode],
        alsoSendText: booleanValue(config.alsoSendText, DEFAULTS.alsoSendText),
        autoFallbackThreshold: finiteClamped(
          config.ttsAutoFallbackThreshold,
          DEFAULTS.ttsAutoFallbackThreshold,
          1,
          24_000,
          true
        ),
        filter: filterFrom(config.ttsRegex),
        azureEmotionEnabled: booleanValue(config.enhanceAzureTTSEmotion, false)
      })
      const picture = Object.freeze({
        userEnabled: user.usePicture ?? booleanValue(
          config.defaultUsePicture,
          DEFAULTS.defaultUsePicture
        ),
        autoEnabled: booleanValue(config.autoUsePicture, DEFAULTS.autoUsePicture),
        autoThreshold: finiteClamped(
          config.autoUsePictureThreshold,
          DEFAULTS.autoUsePictureThreshold,
          1,
          24_000,
          true
        ),
        deviceScaleFactor: finiteClamped(config.cloudDPR, DEFAULTS.cloudDPR, 0.5, 4),
        closeBrowserAfterRender: booleanValue(
          config.closeBrowserAfterRender,
          DEFAULTS.closeBrowserAfterRender
        ),
        showQRCode: booleanValue(config.showQRCode, DEFAULTS.showQRCode),
        live2d: live2dEnabled
          ? Object.freeze({
              modelPath: boundedText(config.live2dModel, 512, DEFAULTS.live2dModel),
              scale: finiteClamped(config.live2dOption_scale, DEFAULTS.live2dOptionScale, 0, 10),
              positionX: finiteClamped(
                config.live2dOption_positionX,
                DEFAULTS.live2dOptionPositionX,
                -4096,
                4096
              ),
              positionY: finiteClamped(
                config.live2dOption_positionY,
                DEFAULTS.live2dOptionPositionY,
                -4096,
                4096
              ),
              rotation: finiteClamped(
                config.live2dOption_rotation,
                DEFAULTS.live2dOptionRotation,
                -360,
                360
              ),
              alpha: finiteClamped(
                config.live2dOption_alpha,
                DEFAULTS.live2dOptionAlpha,
                0,
                1
              )
            })
          : null
      })
      return Object.freeze({
        schemaVersion: 1,
        quoteReply: booleanValue(config.quoteReply, DEFAULTS.quoteReply),
        enableRobotAt: booleanValue(config.enableRobotAt, DEFAULTS.enableRobotAt),
        enableMarkdown: booleanValue(config.enableMd, DEFAULTS.enableMarkdown),
        enableSuggestedResponses: booleanValue(
          config.enableSuggestedResponses,
          DEFAULTS.enableSuggestedResponses
        ),
        forwardReasoning: booleanValue(config.forwardReasoning, DEFAULTS.forwardReasoning),
        blockWords: normalizedWords(config.blockWords),
        promptBlockWords: normalizedWords(config.promptBlockWords),
        tts,
        picture
      })
    }
  })
}
