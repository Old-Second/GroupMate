import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import {
  availableModelOutputTokens,
  MODEL_TURN_CAPACITY_LIMITS
} from '../../src/agent/run/model-turn-capacity.js'

test('model turn capacity reserves tools and safety space for a normal turn', () => {
  assert.deepEqual(MODEL_TURN_CAPACITY_LIMITS, {
    contextWindowTokens: 32_768,
    toolSchemaTokens: 4_096,
    safetyMarginTokens: 1_024
  })
  assert.equal(availableModelOutputTokens({
    estimatedInputTokens: 23_552,
    requestedOutputTokens: 4_096,
    toolsEnabled: true
  }), 4_096)
  assert.equal(availableModelOutputTokens({
    estimatedInputTokens: 27_647,
    requestedOutputTokens: 4_096,
    toolsEnabled: true
  }), 1)
})

test('model turn capacity rejects a normal turn with no output space', () => {
  assert.throws(() => availableModelOutputTokens({
    estimatedInputTokens: 27_648,
    requestedOutputTokens: 4_096,
    toolsEnabled: true
  }), error => error instanceof AgentError &&
    error.code === 'context_budget_exceeded' &&
    error.stage === 'run.model_context')
})

test('model turn capacity does not reserve tool schemas for a correction turn', () => {
  assert.equal(availableModelOutputTokens({
    estimatedInputTokens: 27_648,
    requestedOutputTokens: 4_096,
    toolsEnabled: false
  }), 4_096)
  assert.equal(availableModelOutputTokens({
    estimatedInputTokens: 31_743,
    requestedOutputTokens: 4_096,
    toolsEnabled: false
  }), 1)
  assert.throws(() => availableModelOutputTokens({
    estimatedInputTokens: 31_744,
    requestedOutputTokens: 4_096,
    toolsEnabled: false
  }), error => error instanceof AgentError && error.code === 'context_budget_exceeded')
})

test('model turn capacity keeps the requested output cap and validates counters', () => {
  assert.equal(availableModelOutputTokens({
    estimatedInputTokens: 0,
    requestedOutputTokens: 256,
    toolsEnabled: false
  }), 256)
  assert.throws(() => availableModelOutputTokens({
    estimatedInputTokens: -1,
    requestedOutputTokens: 256,
    toolsEnabled: false
  }), TypeError)
  assert.throws(() => availableModelOutputTokens({
    estimatedInputTokens: 0,
    requestedOutputTokens: 0,
    toolsEnabled: false
  }), TypeError)
})
