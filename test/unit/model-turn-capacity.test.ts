import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import {
  availableModelOutputTokens,
  createToolWireSnapshotV1,
  estimateOpenAIToolSchemaTokens,
  parseToolWireSnapshotV1,
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

test('capacity uses the frozen capability and canonical actual OpenAI tool wire', () => {
  const tools = Object.freeze([Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: 'lookup',
      description: '查询天气',
      parameters: Object.freeze({
        type: 'object' as const,
        properties: Object.freeze({ city: Object.freeze({ type: 'string' as const }) }),
        required: Object.freeze(['city']),
        additionalProperties: false as const
      })
    })
  })])
  const expectedBytes = Buffer.byteLength(JSON.stringify([{
    function: {
      description: '查询天气',
      name: 'lookup',
      parameters: {
        additionalProperties: false,
        properties: { city: { type: 'string' } },
        required: ['city'],
        type: 'object'
      }
    },
    type: 'function'
  }]), 'utf8')
  assert.equal(estimateOpenAIToolSchemaTokens(tools), Math.ceil(expectedBytes / 4))
  assert.equal(estimateOpenAIToolSchemaTokens(Object.freeze([])), 0)
  const changedDescription = Object.freeze([Object.freeze({
    ...tools[0],
    function: Object.freeze({ ...tools[0]?.function, description: '查询实时天气' })
  })])
  assert.notEqual(
    createToolWireSnapshotV1(tools).hash,
    createToolWireSnapshotV1(changedDescription).hash
  )
  const reorderedParameters = Object.freeze([Object.freeze({
    function: Object.freeze({
      parameters: Object.freeze({
        additionalProperties: false as const,
        required: Object.freeze(['city']),
        properties: Object.freeze({ city: Object.freeze({ type: 'string' as const }) }),
        type: 'object' as const
      }),
      description: '查询天气',
      name: 'lookup'
    }),
    type: 'function' as const
  })])
  assert.equal(
    createToolWireSnapshotV1(tools).hash,
    createToolWireSnapshotV1(reorderedParameters).hash
  )
  const firstTool = tools[0]
  if (firstTool === undefined) throw new TypeError('fixture tool is missing')
  const secondTool = Object.freeze({
    ...firstTool,
    function: Object.freeze({ ...firstTool.function, name: 'lookup_second' })
  })
  assert.notEqual(
    createToolWireSnapshotV1(Object.freeze([firstTool, secondTool])).hash,
    createToolWireSnapshotV1(Object.freeze([secondTool, firstTool])).hash
  )
  assert.equal(availableModelOutputTokens({
    capability: {
      schemaVersion: 1,
      source: 'profile',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      promptCaching: 'deepseek_disk',
      usageExtensions: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'],
      priceCatalogVersion: 'deepseek-cny-2026-07-19'
    },
    estimatedInputTokens: 700_000,
    requestedOutputTokens: 400_000,
    toolSchemaTokens: 0
  }), 298_976)
})

test('tool wire snapshot codec enforces the 512 KiB quarter-token ceiling', () => {
  assert.equal(parseToolWireSnapshotV1({
    schemaVersion: 1,
    estimatorVersion: 'openai-tool-wire-byte-quarter-v1',
    hash: '0'.repeat(64),
    estimatedTokens: 131_072
  }).estimatedTokens, 131_072)
  assert.throws(() => parseToolWireSnapshotV1({
    schemaVersion: 1,
    estimatorVersion: 'openai-tool-wire-byte-quarter-v1',
    hash: '0'.repeat(64),
    estimatedTokens: 131_073
  }), /tool wire snapshot/i)
})
