// Shapes of the legacy voice tables (`utils/tts.js`, `utils/tts/microsoft-azure.js`,
// `utils/tts/voicevox.js`). Those modules live outside the typed layer, so the host bootstrap
// injects their exported arrays and the typed side only narrows the fields it actually reads.
export interface HostAzureVoice {
  readonly code: string
  readonly name: string
  readonly gender?: unknown
  readonly languageDetail?: unknown
  readonly emotion?: unknown
}

export interface HostVoiceVoxStyle {
  readonly name: string
}

export interface HostVoiceVoxVoice {
  readonly name: string
  readonly styles: readonly HostVoiceVoxStyle[]
}
