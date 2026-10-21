import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_CONTEXT_SPANS } from '../../src/agent/context/context-span.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import {
  availableInputTokens,
  CONTEXT_BYTES_PER_TOKEN,
  CONTEXT_REQUEST_ENVELOPE_BYTES,
  deriveContextBudget
} from '../../src/runtime/context-budget-policy.js'

test('a 1M-token window becomes a request budget of the same size', () => {
  const budget = deriveContextBudget({
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 4_096
  })
  assert.equal(budget.modelContextTokens, 1_048_576)
  assert.equal(budget.reservedOutputTokens, 4_096)
  assert.equal(budget.reservedToolTokens, 4_096)
  assert.equal(budget.safetyMarginTokens, 1_024)
  assert.equal(budget.maxItems, MAX_CONTEXT_SPANS)
  assert.equal(
    budget.maxBytes,
    RUN_RESOURCE_LIMITS.requestBytes - CONTEXT_REQUEST_ENVELOPE_BYTES
  )
  assert.equal(
    availableInputTokens(budget),
    1_048_576 - 4_096 - 4_096 - 1_024
  )
})

test('the request byte ceiling caps a window larger than one request may carry', () => {
  const budget = deriveContextBudget({
    contextWindowTokens: 16_777_216,
    maxOutputTokens: 4_096
  })
  const bytesLimited = Math.floor(
    (RUN_RESOURCE_LIMITS.requestBytes - CONTEXT_REQUEST_ENVELOPE_BYTES) / CONTEXT_BYTES_PER_TOKEN
  )
  assert.equal(budget.modelContextTokens, bytesLimited)
  assert.ok(budget.modelContextTokens > 1_048_576)
})

test('a small window shrinks the reservations instead of exhausting the input', () => {
  const budget = deriveContextBudget({
    contextWindowTokens: 6_000,
    maxOutputTokens: 4_096
  })
  assert.equal(budget.modelContextTokens, 6_000)
  assert.equal(budget.reservedToolTokens, 750)
  assert.equal(budget.safetyMarginTokens, 375)
  assert.ok(availableInputTokens(budget) >= 1_024)
})

test('an output reservation never claims the whole window', () => {
  const budget = deriveContextBudget({
    contextWindowTokens: 8_192,
    maxOutputTokens: 262_144
  })
  assert.equal(budget.reservedOutputTokens, 8_192 - 1_024 - 512 - 1_024)
  assert.ok(availableInputTokens(budget) >= 1_024)
})

test('invalid windows and byte ceilings are rejected', () => {
  assert.throws(() => deriveContextBudget({
    contextWindowTokens: 0,
    maxOutputTokens: 1_024
  }), /context window/i)
  assert.throws(() => deriveContextBudget({
    contextWindowTokens: 1_024,
    maxOutputTokens: 0,
    maxRequestBytes: 0
  }), /request bytes/i)
})
