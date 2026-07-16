import { createRequire } from 'node:module'
import type {
  TtsMode,
  TtsPresentationSettings
} from './presentation/presentation-settings.js'

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
const emojiStrip = createRequire(import.meta.url)('emoji-strip') as (value: string) => string
const EMOTION_MARKER_SOURCE = String.raw`\[\s*['\x60’‘]?([\p{L}\p{N}_]+)[\x60’‘']?\s*[,，、]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\]`
const MIN_AZURE_EMOTION_DEGREE = 0.01
const MAX_AZURE_EMOTION_DEGREE = 2

export interface PreprocessedTtsText {
  readonly bodyText: string
  readonly spokenText: string
  readonly emotion?: string
  readonly emotionDegree?: number
}

interface EmotionMarkerResult {
  readonly text: string
  readonly emotion?: string
  readonly emotionDegree?: number
}

function normalized (value: string): string {
  return value.trim().normalize('NFC')
}

function removeEmotionMarkers (value: string): {
  readonly text: string
  readonly emotion?: string
  readonly emotionDegree?: number
} {
  const expression = new RegExp(EMOTION_MARKER_SOURCE, 'gu')
  let emotion: string | undefined
  let emotionDegree: number | undefined
  const text = value.replace(expression, (_marker, candidate: string, degree: string) => {
    if (emotion === undefined) {
      emotion = normalized(candidate)
      const parsed = Number(degree)
      if (Number.isFinite(parsed)) {
        emotionDegree = Math.min(
          Math.max(parsed, MIN_AZURE_EMOTION_DEGREE),
          MAX_AZURE_EMOTION_DEGREE
        )
      }
    }
    return ''
  })
  return Object.freeze({
    text: normalized(text),
    ...(emotion === undefined ? {} : { emotion }),
    ...(emotionDegree === undefined ? {} : { emotionDegree })
  })
}

function filteredText (
  text: string,
  filter: TtsPresentationSettings['filter']
): string {
  if (filter === null) return text
  try {
    return text.replace(new RegExp(filter.source, filter.flags), '')
  } catch {
    return text
  }
}

export function preprocessTtsText (input: {
  readonly text: string
  readonly mode: TtsMode
  readonly filter: TtsPresentationSettings['filter']
  readonly azureEmotionEnabled: boolean
}): PreprocessedTtsText {
  const original = normalized(typeof input.text === 'string' ? input.text : '')
  const useEmotion = input.mode === 'azure' && input.azureEmotionEnabled
  const body: EmotionMarkerResult = useEmotion
    ? removeEmotionMarkers(original)
    : Object.freeze({ text: original })
  const prepared = normalized(
    emojiStrip(filteredText(body.text, input.filter)).replace(/[-:_；*;\n]/g, '，')
  )
  return Object.freeze({
    bodyText: body.text,
    spokenText: prepared,
    ...(body.emotion === undefined ? {} : { emotion: body.emotion }),
    ...(body.emotionDegree === undefined ? {} : { emotionDegree: body.emotionDegree })
  })
}

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
