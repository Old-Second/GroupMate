import { parseJsonValue, type JsonObject } from './json-value.js'
import {
  modelProtocolError,
  type NormalizedToolCall
} from './model-adapter.js'
import { asWireRecord } from './openai-wire.js'
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js'

interface ToolCallState {
  readonly index: number
  callId?: string
  type?: string
  name?: string
  argumentsText: string
}

const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/
const MAX_TOOL_CALL_INDEX = 255

function mergeStableValue (
  current: string | undefined,
  next: unknown,
  reason: string
): string | undefined {
  if (next === undefined) return current
  if (typeof next !== 'string' || next.length === 0) throw modelProtocolError(reason)
  if (current !== undefined && current !== next) throw modelProtocolError(reason)
  return next
}

function parseArguments (argumentsText: string): JsonObject {
  if (Buffer.byteLength(argumentsText, 'utf8') > RUN_RESOURCE_LIMITS.toolArgumentsBytes) {
    throw modelProtocolError('tool_arguments_too_large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    throw modelProtocolError('malformed_tool_arguments')
  }
  let value
  try {
    value = parseJsonValue(parsed, { maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes })
  } catch {
    throw modelProtocolError('invalid_tool_arguments')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw modelProtocolError('tool_arguments_not_object')
  }
  return value as JsonObject
}

export class SseToolCallAccumulator {
  readonly #states = new Map<number, ToolCallState>()

  add (value: unknown): void {
    const fragment = asWireRecord(value, 'invalid_tool_call_fragment')
    if (!Number.isSafeInteger(fragment.index) || Number(fragment.index) < 0 ||
        Number(fragment.index) > MAX_TOOL_CALL_INDEX) {
      throw modelProtocolError('invalid_tool_call_index')
    }
    const index = fragment.index as number
    const state = this.#states.get(index) ?? {
      index,
      argumentsText: ''
    }
    state.callId = mergeStableValue(state.callId, fragment.id, 'inconsistent_tool_call_id')
    state.type = mergeStableValue(state.type, fragment.type, 'inconsistent_tool_call_type')
    if (state.type !== undefined && state.type !== 'function') {
      throw modelProtocolError('unsupported_tool_call_type')
    }
    if (fragment.function !== undefined) {
      const fn = asWireRecord(fragment.function, 'invalid_tool_call_function')
      state.name = mergeStableValue(state.name, fn.name, 'inconsistent_tool_call_name')
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== 'string') {
          throw modelProtocolError('invalid_tool_arguments_fragment')
        }
        state.argumentsText += fn.arguments
        if (Buffer.byteLength(state.argumentsText, 'utf8') > RUN_RESOURCE_LIMITS.toolArgumentsBytes) {
          throw modelProtocolError('tool_arguments_too_large')
        }
      }
    }
    this.#states.set(index, state)
  }

  finalize (): readonly NormalizedToolCall[] {
    const callIds = new Set<string>()
    const calls = [...this.#states.values()]
      .sort((left, right) => left.index - right.index)
      .map(state => {
        if (!state.callId || !CALL_ID.test(state.callId)) {
          throw modelProtocolError('invalid_tool_call_id')
        }
        if (state.type !== 'function') throw modelProtocolError('missing_tool_call_type')
        if (!state.name || !TOOL_NAME.test(state.name)) {
          throw modelProtocolError('invalid_tool_call_name')
        }
        if (callIds.has(state.callId)) throw modelProtocolError('duplicate_tool_call_id')
        callIds.add(state.callId)
        return Object.freeze({
          index: state.index,
          callId: state.callId,
          name: state.name,
          argumentsText: state.argumentsText,
          arguments: parseArguments(state.argumentsText)
        })
      })
    return Object.freeze(calls)
  }
}

export function normalizeCompleteToolCalls (value: unknown): readonly NormalizedToolCall[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw modelProtocolError('invalid_tool_calls')
  const accumulator = new SseToolCallAccumulator()
  value.forEach((item, index) => {
    const call = asWireRecord(item, 'invalid_tool_call')
    accumulator.add({
      index,
      id: call.id,
      type: call.type,
      function: call.function
    })
  })
  return accumulator.finalize()
}
