import { createHash } from 'node:crypto'
import { RUN_REF_PATTERN } from './run-reference.js'

export type ObservationCount = number | 'unavailable' | 'not_attempted'

export interface FrozenObservationPolicyV1 {
  readonly schemaVersion: 1
  readonly levelAtStart: 'off' | 'basic' | 'diagnostic'
  readonly sampledSuccess: boolean
}

export interface RunObservationCountersV1 {
  readonly schemaVersion: 1
  readonly providerAttempts: ObservationCount
  readonly modelTurns: ObservationCount
  readonly toolAttempts: ObservationCount
  readonly providerRetries: ObservationCount
  readonly recoveryAttempts: ObservationCount
  readonly correctionTurns: ObservationCount
  readonly toolCalls: ObservationCount
  readonly approvalRequests: ObservationCount
  readonly toolDenied: ObservationCount
  readonly toolExpired: ObservationCount
  readonly toolIndeterminate: ObservationCount
  readonly estimatedTokens: ObservationCount
  readonly providerInputTokens: ObservationCount
  readonly providerOutputTokens: ObservationCount
  readonly providerTotalTokens: ObservationCount
  readonly providerActiveDurationMs: ObservationCount
  readonly engineActiveDurationMs: ObservationCount
}

export type ProviderDispatchObservationV1 =
  | { readonly state: 'idle' }
  | { readonly state: 'reserved' }

export type EngineActivityObservationV1 =
  | { readonly state: 'idle' }
  | { readonly state: 'reserved' }

const COUNTER_KEYS = Object.freeze([
  'schemaVersion',
  'providerAttempts',
  'modelTurns',
  'toolAttempts',
  'providerRetries',
  'recoveryAttempts',
  'correctionTurns',
  'toolCalls',
  'approvalRequests',
  'toolDenied',
  'toolExpired',
  'toolIndeterminate',
  'estimatedTokens',
  'providerInputTokens',
  'providerOutputTokens',
  'providerTotalTokens',
  'providerActiveDurationMs',
  'engineActiveDurationMs'
])

const PROVIDER_USAGE_KEYS = new Set([
  'providerInputTokens',
  'providerOutputTokens',
  'providerTotalTokens'
])

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactKeys (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (unknown !== undefined) throw new TypeError(`${label} contains unknown key: ${unknown}`)
  if (missing !== undefined) throw new TypeError(`${label} key is missing: ${missing}`)
}

function parseCount (
  value: unknown,
  key: string,
  allowNotAttempted: boolean
): ObservationCount {
  if (value === 'unavailable') return value
  if (allowNotAttempted && value === 'not_attempted') return value
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${key} observation count is invalid`)
  }
  return Number(value)
}

export function createFrozenObservationPolicy (input: {
  readonly levelAtStart: 'off' | 'basic' | 'diagnostic'
  readonly runRef: string
}): FrozenObservationPolicyV1 {
  if (!['off', 'basic', 'diagnostic'].includes(input.levelAtStart)) {
    throw new TypeError('observation level is invalid')
  }
  if (typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef)) {
    throw new TypeError('run reference is invalid')
  }
  let sampledSuccess = false
  if (input.levelAtStart !== 'off') {
    const hash = createHash('sha256')
      .update(`groupmate:success:v1:${input.runRef}`, 'ascii')
      .digest()
    sampledSuccess = hash.readUInt32BE(0) % 100 < 5
  }
  return Object.freeze({
    schemaVersion: 1,
    levelAtStart: input.levelAtStart,
    sampledSuccess
  })
}

export function parseFrozenObservationPolicy (
  value: unknown
): FrozenObservationPolicyV1 {
  const policy = record(value, 'observation policy')
  exactKeys(
    policy,
    ['schemaVersion', 'levelAtStart', 'sampledSuccess'],
    'observation policy'
  )
  if (policy.schemaVersion !== 1 ||
    (policy.levelAtStart !== 'off' && policy.levelAtStart !== 'basic' &&
      policy.levelAtStart !== 'diagnostic') ||
    typeof policy.sampledSuccess !== 'boolean' ||
    (policy.levelAtStart === 'off' && policy.sampledSuccess)) {
    throw new TypeError('observation policy is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    levelAtStart: policy.levelAtStart as FrozenObservationPolicyV1['levelAtStart'],
    sampledSuccess: policy.sampledSuccess
  })
}

export function createInitialRunObservationCounters (): RunObservationCountersV1 {
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: 0,
    modelTurns: 0,
    toolAttempts: 0,
    providerRetries: 0,
    recoveryAttempts: 0,
    correctionTurns: 0,
    toolCalls: 0,
    approvalRequests: 0,
    toolDenied: 0,
    toolExpired: 0,
    toolIndeterminate: 0,
    estimatedTokens: 0,
    providerInputTokens: 'not_attempted',
    providerOutputTokens: 'not_attempted',
    providerTotalTokens: 'not_attempted',
    providerActiveDurationMs: 0,
    engineActiveDurationMs: 0
  })
}

export function parseRunObservationCounters (
  value: unknown
): RunObservationCountersV1 {
  const counters = record(value, 'run observation counters')
  exactKeys(counters, COUNTER_KEYS, 'run observation counters')
  if (counters.schemaVersion !== 1) {
    throw new TypeError('run observation counters schema version is invalid')
  }
  const parsed: Record<string, ObservationCount> = {}
  for (const key of COUNTER_KEYS.slice(1)) {
    parsed[key] = parseCount(counters[key], key, PROVIDER_USAGE_KEYS.has(key))
  }
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: parsed.providerAttempts,
    modelTurns: parsed.modelTurns,
    toolAttempts: parsed.toolAttempts,
    providerRetries: parsed.providerRetries,
    recoveryAttempts: parsed.recoveryAttempts,
    correctionTurns: parsed.correctionTurns,
    toolCalls: parsed.toolCalls,
    approvalRequests: parsed.approvalRequests,
    toolDenied: parsed.toolDenied,
    toolExpired: parsed.toolExpired,
    toolIndeterminate: parsed.toolIndeterminate,
    estimatedTokens: parsed.estimatedTokens,
    providerInputTokens: parsed.providerInputTokens,
    providerOutputTokens: parsed.providerOutputTokens,
    providerTotalTokens: parsed.providerTotalTokens,
    providerActiveDurationMs: parsed.providerActiveDurationMs,
    engineActiveDurationMs: parsed.engineActiveDurationMs
  }) as RunObservationCountersV1
}
