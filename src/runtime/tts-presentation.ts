interface VitsTextFallbackInput {
  ttsMode: string
  textCharacters: number
  threshold: unknown
}

interface TtsTextCopyInput {
  alsoSendText: boolean
  textCharacters: number
  threshold: unknown
}

const VITS_MODE = 'vits-uma-genshin-honkai'

function exceedsThreshold (textCharacters: number, threshold: unknown): boolean {
  const parsedThreshold = Number.parseInt(String(threshold), 10)

  return Number.isFinite(parsedThreshold) && textCharacters > parsedThreshold
}

export function shouldFallbackVitsToText ({
  ttsMode,
  textCharacters,
  threshold
}: VitsTextFallbackInput): boolean {
  return ttsMode === VITS_MODE && exceedsThreshold(textCharacters, threshold)
}

export function shouldSendTtsText ({
  alsoSendText,
  textCharacters,
  threshold
}: TtsTextCopyInput): boolean {
  return alsoSendText || exceedsThreshold(textCharacters, threshold)
}
