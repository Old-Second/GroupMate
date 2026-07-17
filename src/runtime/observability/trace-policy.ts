import type { TerminalRunStatus } from '../../agent/run/run-state.js'
import {
  parseFrozenObservationPolicy,
  type FrozenObservationPolicyV1
} from '../../agent/run/run-observation.js'

export type ObservabilityLevel = FrozenObservationPolicyV1['levelAtStart']

export type TracePolicyDecisionV1 =
  | { readonly kind: 'drop'; readonly reason: 'off' | 'normal_success' }
  | { readonly kind: 'await_presentation'; readonly reason: 'unsampled_success' }
  | {
      readonly kind: 'retain'
      readonly reason:
        | 'diagnostic'
        | 'failed'
        | 'cancelled'
        | 'sampled_success'
        | 'presentation_anomaly'
    }

const LEVEL_ORDER: Readonly<Record<ObservabilityLevel, number>> = Object.freeze({
  off: 0,
  basic: 1,
  diagnostic: 2
})
const TERMINAL_STATUSES = new Set<TerminalRunStatus>([
  'completed', 'failed', 'cancelled'
])
const PRESENTATION_STATES = new Set(['not_observed', 'normal', 'anomaly'])

function exactOwnData (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  let actual: readonly PropertyKey[]
  try {
    actual = Reflect.ownKeys(value)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  if (actual.length !== keys.length || actual.some(key => (
    typeof key !== 'string' || !keys.includes(key)
  ))) {
    throw new TypeError(`${label} keys are invalid`)
  }
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      throw new TypeError(`${label} field is invalid`)
    }
    output[key] = descriptor.value
  }
  return output
}

export function decideTraceRetention (input: {
  readonly policy: FrozenObservationPolicyV1
  readonly currentLevel: ObservabilityLevel
  readonly terminalStatus: TerminalRunStatus
  readonly presentation: 'not_observed' | 'normal' | 'anomaly'
}): TracePolicyDecisionV1 {
  const fields = exactOwnData(input, [
    'policy', 'currentLevel', 'terminalStatus', 'presentation'
  ], 'trace policy input')
  const policy = parseFrozenObservationPolicy(fields.policy)
  if (!Object.hasOwn(LEVEL_ORDER, fields.currentLevel as PropertyKey) ||
    !TERMINAL_STATUSES.has(fields.terminalStatus as TerminalRunStatus) ||
    !PRESENTATION_STATES.has(fields.presentation as string)) {
    throw new TypeError('trace policy fields are invalid')
  }
  const currentLevel = fields.currentLevel as ObservabilityLevel
  const terminalStatus = fields.terminalStatus as TerminalRunStatus
  const presentation = fields.presentation as 'not_observed' | 'normal' | 'anomaly'
  const effective = LEVEL_ORDER[policy.levelAtStart] <= LEVEL_ORDER[currentLevel]
    ? policy.levelAtStart
    : currentLevel
  if (effective === 'off') return Object.freeze({ kind: 'drop', reason: 'off' })
  if (terminalStatus === 'failed') {
    return Object.freeze({ kind: 'retain', reason: 'failed' })
  }
  if (terminalStatus === 'cancelled') {
    return Object.freeze({ kind: 'retain', reason: 'cancelled' })
  }
  if (effective === 'diagnostic') {
    return Object.freeze({ kind: 'retain', reason: 'diagnostic' })
  }
  if (policy.sampledSuccess) {
    return Object.freeze({ kind: 'retain', reason: 'sampled_success' })
  }
  if (presentation === 'anomaly') {
    return Object.freeze({ kind: 'retain', reason: 'presentation_anomaly' })
  }
  if (presentation === 'normal') {
    return Object.freeze({ kind: 'drop', reason: 'normal_success' })
  }
  return Object.freeze({ kind: 'await_presentation', reason: 'unsampled_success' })
}
