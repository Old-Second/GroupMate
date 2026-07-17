import type { ModelReasoningTrace } from '../model/model-adapter.js'

export const MAX_RUN_REASONING_SEGMENTS = 6
export const MAX_RUN_REASONING_CODE_POINTS = 8_000
const MAX_REASONING_SEGMENT_CODE_POINTS = 2_000

export interface RunReasoningSegment {
  readonly step: number
  readonly turn: number
  readonly text: string
  readonly truncated: boolean
}

export interface AppendRunReasoningSegmentInput {
  readonly step: number
  readonly turn: number
  readonly reasoning: ModelReasoningTrace
}

const SEGMENT_KEYS = Object.freeze(['step', 'turn', 'text', 'truncated'])

function ownDataRecord (value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('reasoning segment is invalid')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const unknown = keys.find(key => typeof key !== 'string' || !SEGMENT_KEYS.includes(key))
  if (unknown !== undefined) throw new TypeError('reasoning segment contains unknown key')
  const missing = SEGMENT_KEYS.find(key => !Object.hasOwn(descriptors, key))
  if (missing !== undefined) throw new TypeError(`reasoning segment key is missing: ${missing}`)
  for (const key of SEGMENT_KEYS) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('reasoning segment must contain own data properties')
    }
  }
  return Object.freeze(Object.fromEntries(
    SEGMENT_KEYS.map(key => [key, descriptors[key]?.value])
  ))
}

function nonNegativeInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} is invalid`)
  }
  return Number(value)
}

function positiveInteger (value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed === 0) throw new TypeError(`${label} is invalid`)
  return parsed
}

function parseSegment (value: unknown): RunReasoningSegment {
  const segment = ownDataRecord(value)
  const step = nonNegativeInteger(segment.step, 'reasoning segment step')
  const turn = positiveInteger(segment.turn, 'reasoning segment turn')
  if (typeof segment.text !== 'string' || typeof segment.truncated !== 'boolean') {
    throw new TypeError('reasoning segment content is invalid')
  }
  const text = segment.text.trim().normalize('NFC')
  const length = [...text].length
  if (length === 0 || length > MAX_REASONING_SEGMENT_CODE_POINTS) {
    throw new TypeError('reasoning segment code point limit exceeded')
  }
  return Object.freeze({ step, turn, text, truncated: segment.truncated })
}

export function parseRunReasoningSegments (
  value: unknown
): readonly RunReasoningSegment[] {
  if (!Array.isArray(value) || value.length > MAX_RUN_REASONING_SEGMENTS) {
    throw new TypeError('reasoning segment count limit exceeded')
  }
  const segments: RunReasoningSegment[] = []
  let totalCodePoints = 0
  for (const valueSegment of value) {
    const segment = parseSegment(valueSegment)
    const previous = segments.at(-1)
    if (previous !== undefined &&
      (segment.turn <= previous.turn || segment.step < previous.step)) {
      throw new TypeError('reasoning segment order is invalid')
    }
    totalCodePoints += [...segment.text].length
    if (totalCodePoints > MAX_RUN_REASONING_CODE_POINTS) {
      throw new TypeError('reasoning segment total code point limit exceeded')
    }
    segments.push(segment)
  }
  return Object.freeze(segments)
}

export function appendRunReasoningSegment (
  segments: readonly RunReasoningSegment[],
  input: AppendRunReasoningSegmentInput
): readonly RunReasoningSegment[] {
  const parsed = parseRunReasoningSegments(segments)
  if (input.reasoning === null || typeof input.reasoning !== 'object' ||
    typeof input.reasoning.text !== 'string' ||
    typeof input.reasoning.truncated !== 'boolean') {
    throw new TypeError('model reasoning trace is invalid')
  }
  const text = input.reasoning.text.trim().normalize('NFC')
  if (text === '') return segments
  const step = nonNegativeInteger(input.step, 'reasoning segment step')
  const turn = positiveInteger(input.turn, 'reasoning segment turn')
  const previous = parsed.at(-1)
  if (previous !== undefined && (turn <= previous.turn || step < previous.step)) {
    throw new TypeError('reasoning segment order is invalid')
  }
  if (parsed.length >= MAX_RUN_REASONING_SEGMENTS) return segments
  const used = parsed.reduce((total, segment) => total + [...segment.text].length, 0)
  const remaining = MAX_RUN_REASONING_CODE_POINTS - used
  if (remaining <= 0) return segments
  const points = [...text]
  const retained = Math.min(
    points.length,
    MAX_REASONING_SEGMENT_CODE_POINTS,
    remaining
  )
  if (retained <= 0) return segments
  const segment = Object.freeze({
    step,
    turn,
    text: points.slice(0, retained).join(''),
    truncated: input.reasoning.truncated || retained < points.length
  })
  return Object.freeze([...parsed, segment])
}
