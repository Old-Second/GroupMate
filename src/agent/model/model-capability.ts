import type { OpenAICompatibleProfile } from './openai-compatible-profile.js'

export interface ModelCapabilitySnapshotV1 {
  readonly schemaVersion: 1
  readonly source: 'profile' | 'user_override' | 'safe_default'
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly promptCaching: 'deepseek_disk' | 'unknown'
  readonly usageExtensions: readonly (
    'prompt_cache_hit_tokens' | 'prompt_cache_miss_tokens'
  )[]
  readonly priceCatalogVersion: string | null
}

export interface ModelCapabilityOverride {
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly promptCaching?: 'deepseek_disk' | 'unknown'
  readonly usageExtensions?: readonly (
    'prompt_cache_hit_tokens' | 'prompt_cache_miss_tokens'
  )[]
}

export interface ResolveModelCapabilityInput {
  readonly profile: OpenAICompatibleProfile
  readonly model: string
  readonly override?: ModelCapabilityOverride
  readonly now?: Date
}

const MAX_CAPABILITY_TOKENS = 1_000_000
const CAPABILITY_KEYS = Object.freeze([
  'schemaVersion',
  'source',
  'contextWindowTokens',
  'maxOutputTokens',
  'promptCaching',
  'usageExtensions',
  'priceCatalogVersion'
])
const OVERRIDE_KEYS = Object.freeze([
  'contextWindowTokens',
  'maxOutputTokens',
  'promptCaching',
  'usageExtensions'
])
const SAFE_DEFAULT: ModelCapabilitySnapshotV1 = Object.freeze({
  schemaVersion: 1,
  source: 'safe_default',
  contextWindowTokens: 32_768,
  maxOutputTokens: 8_192,
  promptCaching: 'unknown',
  usageExtensions: Object.freeze([]),
  priceCatalogVersion: null
})

function isPlainRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys (value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function isTokenCount (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value > 0 && value <= MAX_CAPABILITY_TOKENS
}

function parseUsageExtensions (value: unknown): ModelCapabilitySnapshotV1['usageExtensions'] {
  if (!Array.isArray(value) || value.length > 2) throw new TypeError('model capability is invalid')
  const known = new Set(['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'])
  if (value.some(item => typeof item !== 'string' || !known.has(item)) ||
      new Set(value).size !== value.length) {
    throw new TypeError('model capability is invalid')
  }
  return Object.freeze([...value]) as ModelCapabilitySnapshotV1['usageExtensions']
}

function parseOverride (value: ModelCapabilityOverride): ModelCapabilityOverride {
  if (!isPlainRecord(value) || Object.keys(value).some(key => !OVERRIDE_KEYS.includes(key)) ||
      Object.keys(value).length === 0) {
    throw new TypeError('model capability override is invalid')
  }
  if (value.contextWindowTokens !== undefined && !isTokenCount(value.contextWindowTokens)) {
    throw new TypeError('model capability override is invalid')
  }
  if (value.maxOutputTokens !== undefined && !isTokenCount(value.maxOutputTokens)) {
    throw new TypeError('model capability override is invalid')
  }
  if (value.promptCaching !== undefined && value.promptCaching !== 'deepseek_disk' &&
      value.promptCaching !== 'unknown') {
    throw new TypeError('model capability override is invalid')
  }
  return Object.freeze({
    ...(value.contextWindowTokens === undefined ? {} : { contextWindowTokens: value.contextWindowTokens }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.promptCaching === undefined ? {} : { promptCaching: value.promptCaching }),
    ...(value.usageExtensions === undefined
      ? {}
      : { usageExtensions: parseUsageExtensions(value.usageExtensions) })
  })
}

export function parseModelCapabilitySnapshot (value: unknown): ModelCapabilitySnapshotV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS) ||
      value.schemaVersion !== 1 ||
      (value.source !== 'profile' && value.source !== 'user_override' && value.source !== 'safe_default') ||
      !isTokenCount(value.contextWindowTokens) || !isTokenCount(value.maxOutputTokens) ||
      value.maxOutputTokens > value.contextWindowTokens ||
      (value.promptCaching !== 'deepseek_disk' && value.promptCaching !== 'unknown') ||
      (typeof value.priceCatalogVersion !== 'string' && value.priceCatalogVersion !== null)) {
    throw new TypeError('model capability is invalid')
  }
  const priceCatalogVersion = value.priceCatalogVersion
  if (typeof priceCatalogVersion === 'string' && priceCatalogVersion.length === 0) {
    throw new TypeError('model capability is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    source: value.source,
    contextWindowTokens: value.contextWindowTokens,
    maxOutputTokens: value.maxOutputTokens,
    promptCaching: value.promptCaching,
    usageExtensions: parseUsageExtensions(value.usageExtensions),
    priceCatalogVersion
  })
}

export function resolveModelCapabilitySnapshot (
  input: ResolveModelCapabilityInput
): ModelCapabilitySnapshotV1 {
  if (typeof input.model !== 'string' || input.model.length === 0 ||
      (input.now !== undefined && !Number.isFinite(input.now.getTime()))) {
    throw new TypeError('model capability lookup is invalid')
  }
  const profileSnapshot = input.profile.resolveModelCapability(input.model, input.now ?? new Date())
  const base = profileSnapshot === undefined
    ? SAFE_DEFAULT
    : parseModelCapabilitySnapshot(profileSnapshot)
  const override = input.override === undefined ? undefined : parseOverride(input.override)
  return parseModelCapabilitySnapshot({
    ...base,
    ...override,
    source: override === undefined ? base.source : 'user_override'
  })
}
