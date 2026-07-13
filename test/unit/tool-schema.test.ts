import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolInputError,
  validateToolDefinition,
  validateToolInput
} from '../../src/agent/tools/schema-validator.js'
import type { ToolDefinition } from '../../src/agent/tools/tool-definition.js'
import {
  parseToolResult,
  toolResultForModel
} from '../../src/agent/tools/tool-result.js'

const closedSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    seconds: { type: 'integer' },
    enabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['quiet', 'normal'] },
    weights: { type: 'array', items: { type: 'number' } },
    reason: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['userId', 'seconds', 'enabled', 'mode', 'weights', 'reason'],
  additionalProperties: false
} as const

test('closed tool input accepts the strict schema subset without coercion', () => {
  const input = {
    userId: '7',
    seconds: 60,
    enabled: true,
    mode: 'quiet',
    weights: [0.5, 1],
    reason: null
  }
  const validated = validateToolInput(closedSchema, input)

  assert.equal(JSON.stringify(validated), JSON.stringify(input))
  assert.notEqual(validated, input)
  assert.equal(Object.getPrototypeOf(validated), null)
  assert.equal(Object.isFrozen(validated), true)
  assert.equal(Object.isFrozen(validated.weights), true)
  assert.throws(
    () => validateToolInput(closedSchema, { ...input, seconds: '60' }),
    (error: unknown) => error instanceof ToolInputError && error.code === 'invalid_type'
  )
})

test('tool input rejects missing and additional properties', () => {
  const valid = {
    userId: '7', seconds: 60, enabled: true, mode: 'normal', weights: [], reason: 'ok'
  }
  const { reason: _reason, ...missing } = valid

  assert.throws(
    () => validateToolInput(closedSchema, missing),
    (error: unknown) => error instanceof ToolInputError && error.code === 'missing_required'
  )
  assert.throws(
    () => validateToolInput(closedSchema, { ...valid, sender: { isAdmin: true } }),
    (error: unknown) => error instanceof ToolInputError && error.code === 'additional_property'
  )
})

test('tool input rejects prototype pollution keys at every depth', () => {
  const schema = {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }
    },
    required: ['nested'],
    additionalProperties: false
  } as const

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const nested = Object.create(null) as Record<string, unknown>
    nested.value = 'ok'
    nested[key] = 'blocked'
    assert.throws(
      () => validateToolInput(schema, { nested }),
      (error: unknown) => error instanceof ToolInputError && error.code === 'forbidden_property'
    )
  }
})

test('tool input enforces depth, property, array, string and byte budgets', () => {
  const recursiveSchema = (depth: number): unknown => depth === 0
    ? { type: 'string' }
    : {
        type: 'object',
        properties: { value: recursiveSchema(depth - 1) },
        required: ['value'],
        additionalProperties: false
      }
  const recursiveValue = (depth: number): unknown => depth === 0
    ? 'done'
    : { value: recursiveValue(depth - 1) }

  assert.throws(
    () => validateToolInput(recursiveSchema(9) as never, recursiveValue(9)),
    (error: unknown) => error instanceof ToolInputError && error.code === 'max_depth_exceeded'
  )

  const properties = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, { type: 'string' }]))
  const required = Object.keys(properties)
  assert.throws(
    () => validateToolInput({ type: 'object', properties, required, additionalProperties: false } as never, Object.fromEntries(required.map(key => [key, 'x']))),
    (error: unknown) => error instanceof ToolInputError && error.code === 'max_properties_exceeded'
  )

  const arraySchema = {
    type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } },
    required: ['values'], additionalProperties: false
  } as const
  assert.throws(
    () => validateToolInput(arraySchema, { values: Array.from({ length: 33 }, (_, index) => index) }),
    (error: unknown) => error instanceof ToolInputError && error.code === 'max_items_exceeded'
  )

  const stringSchema = {
    type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false
  } as const
  assert.throws(
    () => validateToolInput(stringSchema, { value: 'x'.repeat(16 * 1024 + 1) }),
    (error: unknown) => error instanceof ToolInputError && error.code === 'max_string_bytes_exceeded'
  )
  assert.throws(
    () => validateToolInput(stringSchema, { value: '界'.repeat(11 * 1024) }),
    (error: unknown) => error instanceof ToolInputError && error.code === 'max_input_bytes_exceeded'
  )
})

test('tool input rejects non-finite numbers', () => {
  const schema = {
    type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false
  } as const
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => validateToolInput(schema, { value }),
      (error: unknown) => error instanceof ToolInputError && error.code === 'non_finite_number'
    )
  }
})

test('tool definition rejects open objects, unsupported keywords and contradictory metadata', () => {
  const execute = async () => ({
    status: 'success', effect: 'none', content: [], retryable: false
  } as const)
  const base = {
    name: 'weather',
    version: 1,
    aliases: [],
    description: '查询天气',
    inputSchema: closedSchema,
    effect: 'read_only',
    risk: 'low',
    readOnly: true,
    destructive: false,
    idempotency: 'none',
    openWorld: true,
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    network: 'fixed_hosts',
    permission: 'any_user',
    resolveTarget: () => ({ kind: 'none' }),
    execute
  } satisfies ToolDefinition

  assert.equal(validateToolDefinition(base).name, 'weather')
  assert.throws(() => validateToolDefinition({
    ...base,
    inputSchema: { ...closedSchema, additionalProperties: true }
  } as never), ToolInputError)
  assert.throws(() => validateToolDefinition({
    ...base,
    inputSchema: { ...closedSchema, minProperties: 1 }
  } as never), ToolInputError)
  assert.throws(() => validateToolDefinition({ ...base, effect: 'side_effect', readOnly: true } as never), ToolInputError)
})

test('tool result parser accepts exactly four bounded branches', () => {
  const results = [
    {
      status: 'success', effect: 'visible',
      content: [{ type: 'text', text: '图片已发送。' }], retryable: false
    },
    {
      status: 'denied', effect: 'none', reasonCode: 'permission_denied',
      userMessage: '当前身份不能执行该操作。', retryable: false
    },
    {
      status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
      userMessage: '工具暂时不可用。', retryable: true
    },
    {
      status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
      userMessage: '操作结果暂时无法确认。', retryable: false
    }
  ] as const

  for (const result of results) assert.deepEqual(parseToolResult(result), result)
  assert.throws(() => parseToolResult({ ...results[0], retryable: true }))
  assert.throws(() => parseToolResult({ ...results[1], cause: new Error('secret') }))
  assert.throws(() => parseToolResult({ ...results[1], reasonCode: 'model_selected_reason' }))
  assert.throws(() => parseToolResult({ ...results[2], stack: 'secret' }))
  assert.throws(() => parseToolResult({ ...results[2], errorCode: 'provider_body_secret' }))
  assert.throws(() => parseToolResult({
    ...results[2], userMessage: 'https://provider.invalid/path?token=secret'
  }))
  assert.throws(() => parseToolResult({ ...results[3], rawArguments: { text: 'secret' } }))
})

test('tool result model feedback is bounded and excludes unsafe error details', () => {
  const result = parseToolResult({
    status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
    userMessage: '工具暂时不可用。', retryable: true
  })
  const serialized = JSON.stringify(result)
  const feedback = toolResultForModel(result)

  assert.equal(feedback, '工具暂时不可用。')
  assert.doesNotMatch(serialized, /cause|stack|rawArguments|responseBody|\?token=|Authorization/i)
  assert.throws(() => parseToolResult({
    status: 'success', effect: 'none',
    content: [{ type: 'text', text: 'x'.repeat(65 * 1024) }], retryable: false
  }))
})
