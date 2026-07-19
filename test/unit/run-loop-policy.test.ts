import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import {
  createDefaultRunBudget
} from '../../src/agent/run/run-budget.js'
import {
  parseRunModelLoopPolicyV1
} from '../../src/agent/run/run-loop-policy.js'

test('adaptive context loop keeps counters without fixed turn or aggregate token termination', () => {
  const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 8_192 })
    .withLimits(createDefaultRunBudget({
      providerTimeoutMs: 120_000,
      outputTokens: 8_192
    }).limits, parseRunModelLoopPolicyV1({ schemaVersion: 1, kind: 'adaptive_context' }))
  let counters = budget.initialCounters
  for (let turn = 0; turn < 7; turn += 1) {
    counters = budget.reserveModelTurn(counters, {
      kind: 'normal',
      estimatedInputTokens: 32_768,
      maxOutputTokens: 1
    })
  }
  assert.equal(counters.modelTurns, 7)
  assert.ok(counters.estimatedTokens > 196_608)
})

test('adaptive overflow and legacy fixed cutoff retain stable budget errors', () => {
  const base = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 8_192 })
  assert.throws(() => base.reserveModelTurn(Object.freeze({
    ...base.initialCounters,
    modelTurns: Number.MAX_SAFE_INTEGER
  }), { kind: 'normal', estimatedInputTokens: 0, maxOutputTokens: 1 }), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded' &&
    error.stage === 'run.budget' && error.details.limit === 'model_turns'
  ))
  assert.throws(() => base.reserveModelTurn(Object.freeze({
    ...base.initialCounters,
    estimatedTokens: Number.MAX_SAFE_INTEGER
  }), { kind: 'normal', estimatedInputTokens: 0, maxOutputTokens: 1 }), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded' &&
    error.stage === 'run.budget' && error.details.limit === 'estimated_tokens' &&
    error.details.current === Number.MAX_SAFE_INTEGER && error.details.requested === 1
  ))
  assert.throws(() => base.recordUsage(Object.freeze({
    ...base.initialCounters,
    providerReportedTokens: Number.MAX_SAFE_INTEGER
  }), { providerReportedTokens: 1 }), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded' &&
    error.stage === 'run.budget' && error.details.limit === 'provider_reported_tokens' &&
    error.details.current === Number.MAX_SAFE_INTEGER && error.details.requested === 1
  ))
  const legacy = base.withLimits(base.limits, parseRunModelLoopPolicyV1({
    schemaVersion: 1,
    kind: 'legacy_fixed',
    maxModelTurns: 6,
    maxEstimatedTokens: 196_608
  }))
  assert.throws(() => legacy.reserveModelTurn(Object.freeze({
    ...legacy.initialCounters,
    modelTurns: 5
  }), { kind: 'normal', estimatedInputTokens: 0, maxOutputTokens: 1 }), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded' &&
    error.stage === 'run.budget' && error.details.limit === 'model_turns' &&
    error.details.current === 5 && error.details.requested === 1
  ))
})
