import type {
  RunBudget,
  RunBudgetCounters
} from '../agent/run/run-budget.js'

export type RecoverableContextSpanKind =
  | 'required'
  | 'legacy'
  | 'group'
  | 'provider_protocol'

export interface RecoverableContextSpan<T = unknown> {
  readonly spanId: string
  readonly kind: RecoverableContextSpanKind
  readonly optional: boolean
  readonly value: T
}

export interface OptionalContextRecoveryInput<T> {
  readonly context: readonly RecoverableContextSpan<T>[]
  readonly optionalSpanIds: readonly string[]
  readonly modelCallIndex: number
  readonly successfulTurns: number
  readonly capabilityDispatches: number
  readonly recoveryUsed: boolean
  readonly hint: 'none' | 'drop_optional_context_once'
  readonly budget: RunBudget
  readonly counters: RunBudgetCounters
}

export interface OptionalContextRecoveryResult<T> {
  readonly context: readonly RecoverableContextSpan<T>[]
  readonly removedSpanIds: readonly string[]
  readonly recoveryUsed: true
  readonly counters: RunBudgetCounters
}

const SPAN_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const RECOVERABLE_KINDS = new Set<RecoverableContextSpanKind>(['legacy', 'group'])

function isZero (value: number): boolean {
  return Number.isSafeInteger(value) && value === 0
}

function selectedSpansAreRecoverable<T> (
  context: readonly RecoverableContextSpan<T>[],
  selected: ReadonlySet<string>
): boolean {
  const found = new Set<string>()
  for (const span of context) {
    if (!selected.has(span.spanId)) continue
    found.add(span.spanId)
    if (!span.optional || !RECOVERABLE_KINDS.has(span.kind)) return false
  }
  return found.size === selected.size
}

export class OptionalContextRecoveryPolicy {
  tryRecover<T> (
    input: OptionalContextRecoveryInput<T>
  ): OptionalContextRecoveryResult<T> | undefined {
    if (input.hint !== 'drop_optional_context_once' || input.recoveryUsed ||
        input.counters.recoveryAttempts !== 0 || !isZero(input.modelCallIndex) ||
        !isZero(input.successfulTurns) || !isZero(input.capabilityDispatches) ||
        !Array.isArray(input.context) || !Array.isArray(input.optionalSpanIds) ||
        input.optionalSpanIds.length === 0) {
      return undefined
    }
    const selected = new Set(input.optionalSpanIds)
    if (selected.size !== input.optionalSpanIds.length ||
        [...selected].some(id => typeof id !== 'string' || !SPAN_ID.test(id)) ||
        !selectedSpansAreRecoverable(input.context, selected)) {
      return undefined
    }
    const context = Object.freeze(input.context
      .filter(span => !selected.has(span.spanId))
      .map(span => Object.freeze({ ...span })))
    const removedSpanIds = Object.freeze([...selected].sort())
    const counters = input.budget.recordRecovery(input.counters)
    return Object.freeze({
      context,
      removedSpanIds,
      recoveryUsed: true,
      counters
    })
  }
}
