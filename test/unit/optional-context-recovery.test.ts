import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OptionalContextRecoveryPolicy,
  type RecoverableContextSpan
} from '../../src/runtime/optional-context-recovery.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'

const policy = new OptionalContextRecoveryPolicy()

function fixtureSpans (): readonly RecoverableContextSpan<string>[] {
  return Object.freeze([
    Object.freeze({ spanId: 'required-1', kind: 'required', optional: false, value: 'required' }),
    Object.freeze({ spanId: 'legacy-1', kind: 'legacy', optional: true, value: 'legacy-a' }),
    Object.freeze({ spanId: 'legacy-1', kind: 'legacy', optional: true, value: 'legacy-b' }),
    Object.freeze({ spanId: 'group-1', kind: 'group', optional: true, value: 'group' }),
    Object.freeze({
      spanId: 'protocol-1',
      kind: 'provider_protocol',
      optional: true,
      value: 'protocol'
    })
  ])
}

function eligibleInput () {
  const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 4_096 })
  return {
    context: fixtureSpans(),
    optionalSpanIds: Object.freeze(['legacy-1', 'group-1']),
    modelCallIndex: 0,
    successfulTurns: 0,
    capabilityDispatches: 0,
    recoveryUsed: false,
    hint: 'drop_optional_context_once' as const,
    budget,
    counters: budget.initialCounters
  }
}

test('optional context recovery removes selected spans atomically and increments only recovery', () => {
  const input = eligibleInput()
  const before = structuredClone(input.context)
  const result = policy.tryRecover(input)

  assert.ok(result)
  assert.deepEqual(result.context.map(span => span.spanId), ['required-1', 'protocol-1'])
  assert.deepEqual(result.removedSpanIds, ['group-1', 'legacy-1'])
  assert.equal(result.recoveryUsed, true)
  assert.equal(result.counters.recoveryAttempts, 1)
  assert.deepEqual({ ...result.counters, recoveryAttempts: 0 }, input.counters)
  assert.deepEqual(input.context, before)
  assert.equal(Object.isFrozen(result.context), true)
  assert.equal(Object.isFrozen(result.removedSpanIds), true)
})

test('optional context recovery requires the first untouched pre-capability model call', () => {
  const base = eligibleInput()
  const cases = [
    { modelCallIndex: 1 },
    { successfulTurns: 1 },
    { capabilityDispatches: 1 },
    { recoveryUsed: true },
    { hint: 'none' as const },
    { optionalSpanIds: Object.freeze([]) }
  ]
  for (const override of cases) {
    assert.equal(policy.tryRecover({ ...base, ...override }), undefined)
  }
})

test('required and provider protocol spans can never enter optional recovery', () => {
  const base = eligibleInput()
  assert.equal(policy.tryRecover({
    ...base,
    optionalSpanIds: Object.freeze(['required-1'])
  }), undefined)
  assert.equal(policy.tryRecover({
    ...base,
    optionalSpanIds: Object.freeze(['protocol-1'])
  }), undefined)
  assert.equal(policy.tryRecover({
    ...base,
    optionalSpanIds: Object.freeze(['missing-span'])
  }), undefined)
})
