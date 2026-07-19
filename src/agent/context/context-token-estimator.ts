import { types as utilTypes } from 'node:util'
import type { JsonObject, JsonValue } from '../model/json-value.js'
import type {
  ModelAssistantToolCall,
  ModelMessage
} from '../model/model-adapter.js'
import type { ProviderTurnState } from '../run/provider-state.js'

export const CONTEXT_TOKEN_ESTIMATOR_VERSION = 'context-byte-quarter-v1'
export const MAX_CONTEXT_CANONICAL_MESSAGE_BYTES = 512 * 1_024

const SAFE_ASCII = /^[\x21-\x7e]{1,128}$/
const PROFILE_ID = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 8_192
export const MAX_CONTEXT_MESSAGES = 128
const MAX_CONTEXT_TOOL_CALLS = 128
const MAX_CONTEXT_STRING_CODE_UNITS = 512 * 1_024

interface WalkState {
  nodes: number
  readonly ancestors: Set<object>
}

export function invalidContextValue (): never {
  throw new TypeError('invalid canonical context value')
}

function hasLoneSurrogate (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function normalizeContextString (value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CONTEXT_STRING_CODE_UNITS ||
    hasLoneSurrogate(value)) return invalidContextValue()
  return value.normalize('NFC')
}

export function requireContextAscii (value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ASCII.test(value)) return invalidContextValue()
  return value
}

export function requireContextHash (value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalidContextValue()
  return value
}

export function requireSafeInteger (
  value: unknown,
  options: { readonly positive?: boolean } = {}
): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) return invalidContextValue()
  const integer = value as number
  if (options.positive === true ? integer <= 0 : integer < 0) return invalidContextValue()
  return integer
}

export function inspectContextRecord (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
    return invalidContextValue()
  }
  let prototype: object | null
  let descriptors: Record<string, PropertyDescriptor>
  let keys: readonly PropertyKey[]
  let frozen: boolean
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
    frozen = Object.isFrozen(value)
  } catch {
    return invalidContextValue()
  }
  if (prototype !== Object.prototype || !frozen || keys.some(key => typeof key !== 'string')) {
    return invalidContextValue()
  }
  const allowed = new Set([...required, ...optional])
  if (keys.some(key => !allowed.has(key as string)) || required.some(key => !(key in descriptors))) {
    return invalidContextValue()
  }
  const result: Record<string, unknown> = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return invalidContextValue()
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

export function inspectContextArray (
  value: unknown,
  maxLength = MAX_JSON_NODES
): readonly unknown[] {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || !Array.isArray(value)) {
    return invalidContextValue()
  }
  let prototype: object | null
  let descriptors: Record<string, PropertyDescriptor>
  let keys: readonly PropertyKey[]
  let frozen: boolean
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
    frozen = Object.isFrozen(value)
  } catch {
    return invalidContextValue()
  }
  const lengthDescriptor = descriptors.length
  if (prototype !== Array.prototype || !frozen || lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 || keys.some(key => typeof key !== 'string')) {
    return invalidContextValue()
  }
  const length = lengthDescriptor.value as number
  if (length > maxLength) return invalidContextValue()
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))])
  if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key as string))) {
    return invalidContextValue()
  }
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return invalidContextValue()
    }
    result.push(descriptor.value)
  }
  return result
}

function inspectArbitraryRecord (value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
    return invalidContextValue()
  }
  let prototype: object | null
  let descriptors: Record<string, PropertyDescriptor>
  let keys: readonly PropertyKey[]
  let frozen: boolean
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
    frozen = Object.isFrozen(value)
  } catch {
    return invalidContextValue()
  }
  if (prototype !== Object.prototype || !frozen || keys.length > MAX_JSON_NODES ||
    keys.some(key => typeof key !== 'string')) return invalidContextValue()
  const result: Record<string, unknown> = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return invalidContextValue()
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

export function asciiContextCompare (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function cloneJsonValue (
  value: unknown,
  depth: number,
  state: WalkState
): JsonValue {
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return invalidContextValue()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return normalizeContextString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))) return invalidContextValue()
    return value
  }
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) return invalidContextValue()
  if (state.ancestors.has(value)) return invalidContextValue()
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const input = inspectContextArray(value)
      return Object.freeze(input.map(item => cloneJsonValue(item, depth + 1, state)))
    }
    const input = inspectArbitraryRecord(value)
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(input).sort(asciiContextCompare)) {
      const normalizedKey = normalizeContextString(key)
      if (normalizedKey !== key) return invalidContextValue()
      Object.defineProperty(output, key, {
        value: cloneJsonValue(input[key], depth + 1, state),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    return Object.freeze(output) as JsonObject
  } finally {
    state.ancestors.delete(value)
  }
}

function canonicalizeContextJsonValueWithState (value: unknown, state: WalkState): JsonValue {
  return cloneJsonValue(value, 0, state)
}

export function canonicalizeContextJsonValue (value: unknown): JsonValue {
  return canonicalizeContextJsonValueWithState(value, {
    nodes: 0,
    ancestors: new Set<object>()
  })
}

function parseToolCall (value: unknown, state: WalkState): ModelAssistantToolCall {
  const input = inspectContextRecord(value, ['callId', 'name', 'arguments'])
  const args = canonicalizeContextJsonValueWithState(input.arguments, state)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return invalidContextValue()
  return Object.freeze({
    callId: requireContextAscii(input.callId),
    name: requireContextAscii(input.name),
    arguments: args as JsonObject
  })
}

function parseProviderState (value: unknown, state: WalkState): ProviderTurnState {
  const input = inspectContextRecord(value, ['profileId', 'profileVersion', 'payload'])
  if (typeof input.profileId !== 'string' || !PROFILE_ID.test(input.profileId)) return invalidContextValue()
  const profileVersion = requireSafeInteger(input.profileVersion, { positive: true })
  return Object.freeze({
    profileId: input.profileId,
    profileVersion,
    payload: canonicalizeContextJsonValueWithState(input.payload, state)
  })
}

function parseModelMessage (value: unknown, state: WalkState): ModelMessage {
  const base = inspectContextRecord(value, ['role'], ['content', 'toolCalls', 'providerState', 'toolCallId'])
  switch (base.role) {
    case 'system':
    case 'developer':
    case 'user': {
      const input = inspectContextRecord(value, ['role', 'content'])
      return Object.freeze({ role: base.role, content: normalizeContextString(input.content) })
    }
    case 'assistant': {
      const input = inspectContextRecord(value, ['role', 'content'], ['toolCalls', 'providerState'])
      const content = input.content === null ? null : normalizeContextString(input.content)
      let toolCalls: readonly ModelAssistantToolCall[] | undefined
      if (input.toolCalls !== undefined) {
        const calls = inspectContextArray(input.toolCalls, MAX_CONTEXT_TOOL_CALLS)
          .map(call => parseToolCall(call, state))
        if (calls.length === 0) return invalidContextValue()
        const ids = new Set(calls.map(call => call.callId))
        if (ids.size !== calls.length) return invalidContextValue()
        toolCalls = Object.freeze(calls)
      }
      const providerState = input.providerState === undefined
        ? undefined
        : parseProviderState(input.providerState, state)
      return Object.freeze({
        role: 'assistant' as const,
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(providerState === undefined ? {} : { providerState })
      })
    }
    case 'tool': {
      const input = inspectContextRecord(value, ['role', 'content', 'toolCallId'])
      return Object.freeze({
        role: 'tool' as const,
        content: normalizeContextString(input.content),
        toolCallId: requireContextAscii(input.toolCallId)
      })
    }
    default:
      return invalidContextValue()
  }
}

export function canonicalizeModelMessages (value: unknown): readonly ModelMessage[] {
  const state: WalkState = { nodes: 0, ancestors: new Set<object>() }
  const parsed = Object.freeze(inspectContextArray(value, MAX_CONTEXT_MESSAGES)
    .map(message => parseModelMessage(message, state)))
  const bytes = Buffer.byteLength(`[${parsed.map(modelMessageJson).join(',')}]`, 'utf8')
  if (bytes > MAX_CONTEXT_CANONICAL_MESSAGE_BYTES) return invalidContextValue()
  return parsed
}

function stringifyJsonValue (value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringifyJsonValue).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object).sort(asciiContextCompare).map(key => {
    return `${JSON.stringify(key)}:${stringifyJsonValue(object[key] as JsonValue)}`
  }).join(',')}}`
}

function modelMessageJson (message: ModelMessage): string {
  switch (message.role) {
    case 'system':
    case 'developer':
    case 'user':
      return `{"role":${JSON.stringify(message.role)},"content":${JSON.stringify(message.content)}}`
    case 'assistant': {
      const fields = [
        `"role":"assistant"`,
        `"content":${message.content === null ? 'null' : JSON.stringify(message.content)}`
      ]
      if (message.toolCalls !== undefined) {
        fields.push(`"toolCalls":[${message.toolCalls.map(call => {
          return `{"callId":${JSON.stringify(call.callId)},"name":${JSON.stringify(call.name)},"arguments":${stringifyJsonValue(call.arguments)}}`
        }).join(',')}]`)
      }
      if (message.providerState !== undefined) {
        fields.push(`"providerState":{"profileId":${JSON.stringify(message.providerState.profileId)},"profileVersion":${message.providerState.profileVersion},"payload":${stringifyJsonValue(message.providerState.payload)}}`)
      }
      return `{${fields.join(',')}}`
    }
    case 'tool':
      return `{"role":"tool","content":${JSON.stringify(message.content)},"toolCallId":${JSON.stringify(message.toolCallId)}}`
  }
}

export function canonicalJsonStringify (value: JsonValue): string {
  return stringifyJsonValue(value)
}

export function serializeModelMessages (value: unknown): string {
  const messages = canonicalizeModelMessages(value)
  return `[${messages.map(modelMessageJson).join(',')}]`
}

export function serializedModelMessagesBytes (value: unknown): number {
  return Buffer.byteLength(serializeModelMessages(value), 'utf8')
}

export function estimateModelMessagesTokens (value: unknown): number {
  const messages = canonicalizeModelMessages(value)
  if (messages.length === 0) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(
    `[${messages.map(modelMessageJson).join(',')}]`,
    'utf8'
  ) / 4))
}
