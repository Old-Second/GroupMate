import type { PresentationSettingsPort, TtsMode } from '../presentation/presentation-settings.js'

type ToolVoiceInput = {
  readonly requested: string
  readonly mode: TtsMode
  readonly activeVoice: string
  readonly vits: readonly string[]
  readonly azure: readonly { readonly name: string; readonly code: string }[]
  readonly voicevox: readonly { readonly name: string; readonly styles: readonly { readonly name: string }[] }[]
}

export async function resolveToolVoice (
  input: Omit<ToolVoiceInput, 'activeVoice'> & {
    readonly actorId: string
    readonly settings: PresentationSettingsPort
  }
): Promise<string | null> {
  const settings = await input.settings.load(input.actorId)
  return selectToolVoice({ ...input, activeVoice: settings.tts.activeVoice })
}

export function selectToolVoice (input: ToolVoiceInput): string | null {
  const requested = input.requested.trim()
  const voice = ['', '默认', 'default'].includes(requested.toLowerCase()) ? input.activeVoice : requested
  if (voice === '随机') return voice
  if (input.mode === 'vits-uma-genshin-honkai') return input.vits.includes(voice) ? voice : null
  if (input.mode === 'azure') return input.azure.find(item => item.code === voice || item.name === voice)?.code ?? null
  if (input.voicevox.some(item => item.name === voice || item.styles.some(style => `${item.name}-${style.name}` === voice))) return voice
  return null
}
