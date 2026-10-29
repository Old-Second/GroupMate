import type {
  ConfiguredReasoningEffort,
  ConfiguredThinkingMode
} from '../yunzai-chat-controller.js'

// The Yunzai host hands the plugin a mutable configuration object whose fields are whatever the
// operator last saved through Guoba or edited by hand. Every projection below therefore starts from
// `unknown` and narrows, instead of trusting a declared type that nothing enforces at the boundary.
export type HostConfigSource = Readonly<Record<string, unknown>>

export function normalizedText (value: unknown, maximum: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFC').trim()
  if (normalized === '') return fallback
  return [...normalized].slice(0, maximum).join('')
}

export function normalizedStringList (
  value: unknown,
  maximumItems = 256,
  maximumCharacters = 128
): readonly string[] {
  if (!Array.isArray(value) && typeof value !== 'string') return Object.freeze([])
  const source: readonly unknown[] = Array.isArray(value) ? value : [value]
  const result: string[] = []
  const seen = new Set<string>()
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

export function finiteInteger (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
    : fallback
}

export function finiteNumber (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback
}

const THINKING_MODES: readonly ConfiguredThinkingMode[] =
  Object.freeze(['enabled', 'disabled'])

export function configuredThinkingMode (value: unknown): ConfiguredThinkingMode {
  return THINKING_MODES.find(item => item === value) ?? 'default'
}

const REASONING_EFFORTS: readonly ConfiguredReasoningEffort[] =
  Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function configuredReasoningEffort (value: unknown): ConfiguredReasoningEffort {
  return REASONING_EFFORTS.find(item => item === value) ?? 'default'
}
