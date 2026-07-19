import { AgentError } from '../contracts/error.js'
import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  parseModelCapabilitySnapshot,
  type ModelCapabilitySnapshotV1
} from '../model/model-capability.js'
import type { ModelToolDefinition } from '../tools/tool-registry.js'

export const MODEL_TURN_CAPACITY_LIMITS = Object.freeze({
  contextWindowTokens: 32_768,
  toolSchemaTokens: 4_096,
  safetyMarginTokens: 1_024
})

export interface ModelTurnCapacityInput {
  readonly capability?: ModelCapabilitySnapshotV1
  readonly estimatedInputTokens: number
  readonly requestedOutputTokens: number
  readonly toolSchemaTokens?: number
  readonly toolsEnabled?: boolean
}

export interface ToolWireSnapshotV1 {
  readonly schemaVersion: 1
  readonly estimatorVersion: 'openai-tool-wire-byte-quarter-v1'
  readonly hash: string
  readonly estimatedTokens: number
}

const MAX_TOOL_WIRE_BYTES = 512 * 1_024

function nonNegativeInteger (value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
}

function positiveInteger (value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
}

function canonicalJson (value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('tool schema is invalid')
    }
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
    ancestors.has(value) || !Object.isFrozen(value)) {
    throw new TypeError('tool schema is invalid')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Object.getPrototypeOf(value) !== Array.prototype ||
        keys.length !== value.length + 1 || keys.some((key, index) => (
          index < value.length ? key !== String(index) : key !== 'length'
        ))) throw new TypeError('tool schema is invalid')
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
          descriptor.enumerable !== true) throw new TypeError('tool schema is invalid')
        items.push(canonicalJson(descriptor.value, ancestors))
      }
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('tool schema is invalid')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('tool schema is invalid')
    return `{${(keys as string[]).sort().map(key => {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true) throw new TypeError('tool schema is invalid')
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`
    }).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function estimateOpenAIToolSchemaTokens (
  tools: readonly ModelToolDefinition[]
): number {
  try {
    if (!Array.isArray(tools)) throw new TypeError()
    const wire = canonicalJson(tools)
    if (Buffer.byteLength(wire, 'utf8') > MAX_TOOL_WIRE_BYTES) throw new TypeError()
    if (tools.length === 0) return 0
    const tokens = Math.ceil(Buffer.byteLength(wire, 'utf8') / 4)
    if (!Number.isSafeInteger(tokens)) throw new TypeError()
    return tokens
  } catch {
    throw new TypeError('tool schema estimate is invalid')
  }
}

export function createToolWireSnapshotV1 (
  tools: readonly ModelToolDefinition[]
): ToolWireSnapshotV1 {
  let wire: string
  try {
    wire = canonicalJson(tools)
    if (Buffer.byteLength(wire, 'utf8') > MAX_TOOL_WIRE_BYTES) throw new TypeError()
  } catch {
    throw new TypeError('tool schema estimate is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    estimatorVersion: 'openai-tool-wire-byte-quarter-v1',
    hash: createHash('sha256')
      .update('groupmate.run.tool-wire-schema.v1\0', 'ascii')
      .update(wire, 'utf8')
      .digest('hex'),
    estimatedTokens: tools.length === 0
      ? 0
      : Math.ceil(Buffer.byteLength(wire, 'utf8') / 4)
  })
}

export function parseToolWireSnapshotV1 (value: unknown): ToolWireSnapshotV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
    Array.isArray(value)) {
    throw new TypeError('tool wire snapshot is invalid')
  }
  let input: Record<string, unknown>
  let keys: string[]
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some(key => typeof key !== 'string')) throw new TypeError()
    keys = ownKeys as string[]
    input = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true) throw new TypeError()
      input[key] = descriptor.value
    }
  } catch {
    throw new TypeError('tool wire snapshot is invalid')
  }
  if (keys.length !== 4 || ![
    'schemaVersion', 'estimatorVersion', 'hash', 'estimatedTokens'
  ]
    .every(key => keys.includes(key)) || input.schemaVersion !== 1 ||
    input.estimatorVersion !== 'openai-tool-wire-byte-quarter-v1' ||
    typeof input.hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.hash) ||
    !Number.isSafeInteger(input.estimatedTokens) || Number(input.estimatedTokens) < 0 ||
    Number(input.estimatedTokens) > 131_072) {
    throw new TypeError('tool wire snapshot is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    estimatorVersion: 'openai-tool-wire-byte-quarter-v1',
    hash: input.hash,
    estimatedTokens: Number(input.estimatedTokens)
  })
}

export function availableModelOutputTokens (input: ModelTurnCapacityInput): number {
  nonNegativeInteger(input.estimatedInputTokens, 'estimated input tokens')
  positiveInteger(input.requestedOutputTokens, 'requested output tokens')
  if (input.toolsEnabled !== undefined && typeof input.toolsEnabled !== 'boolean') {
    throw new TypeError('tools enabled must be a boolean')
  }
  const capability = input.capability === undefined
    ? undefined
    : parseModelCapabilitySnapshot(input.capability)
  const contextWindowTokens = capability?.contextWindowTokens ??
    MODEL_TURN_CAPACITY_LIMITS.contextWindowTokens
  const capabilityOutputTokens = capability?.maxOutputTokens ?? input.requestedOutputTokens
  positiveInteger(contextWindowTokens, 'context window tokens')
  positiveInteger(capabilityOutputTokens, 'capability output tokens')
  const toolSchemaTokens = input.toolSchemaTokens ??
    (input.toolsEnabled === true ? MODEL_TURN_CAPACITY_LIMITS.toolSchemaTokens : 0)
  nonNegativeInteger(toolSchemaTokens, 'tool schema tokens')
  if (toolSchemaTokens > Number.MAX_SAFE_INTEGER -
    MODEL_TURN_CAPACITY_LIMITS.safetyMarginTokens) {
    throw new TypeError('tool schema tokens exceed safe capacity')
  }
  let availableTokens = contextWindowTokens
  for (const used of [
    input.estimatedInputTokens,
    toolSchemaTokens,
    MODEL_TURN_CAPACITY_LIMITS.safetyMarginTokens
  ]) {
    if (used >= availableTokens) {
      availableTokens = 0
      break
    }
    availableTokens -= used
  }
  if (availableTokens < 1) {
    throw new AgentError({
      code: 'context_budget_exceeded',
      stage: 'run.model_context',
      retryable: false,
      userMessage: '当前请求超出可用上下文范围，请缩短内容后重试。',
      details: {
        estimatedInputTokens: input.estimatedInputTokens,
        reservedTokens: toolSchemaTokens + MODEL_TURN_CAPACITY_LIMITS.safetyMarginTokens,
        contextWindowTokens
      }
    })
  }
  return Math.min(input.requestedOutputTokens, capabilityOutputTokens, availableTokens)
}
