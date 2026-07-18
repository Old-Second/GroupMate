import { types as utilTypes } from 'node:util'
import {
  AgentError,
  type AgentErrorCode,
  type AgentErrorDetails
} from '../contracts/error.js'
import type { JsonObject } from './json-value.js'
import type { ProviderTurnState } from '../run/provider-state.js'

export type ModelToolMode = 'auto' | 'required' | 'disabled'

export interface ModelReasoningOptions {
  readonly enabled: boolean
  readonly effort?: 'low' | 'medium' | 'high' | 'max'
}

export interface ModelToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonObject
}

export interface ModelAssistantToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: JsonObject
}

export interface ProviderRequestMetadata {
  readonly cacheIsolationId: string
}

const CACHE_ISOLATION_ID = /^gm_[gu]_[A-Za-z0-9_-]{43}$/

export function parseProviderRequestMetadata (
  value: unknown
): ProviderRequestMetadata {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
    Array.isArray(value)) {
    throw modelRequestError('invalid_provider_request_metadata')
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  let descriptor: PropertyDescriptor | undefined
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
    descriptor = Object.getOwnPropertyDescriptor(value, 'cacheIsolationId')
  } catch {
    throw modelRequestError('invalid_provider_request_metadata')
  }
  if (prototype !== Object.prototype || keys.length !== 1 ||
    keys[0] !== 'cacheIsolationId' || descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
    typeof descriptor.value !== 'string' || !CACHE_ISOLATION_ID.test(descriptor.value)) {
    throw modelRequestError('invalid_provider_request_metadata')
  }
  return Object.freeze({ cacheIsolationId: descriptor.value })
}

export type ModelMessage =
  | Readonly<{ role: 'system' | 'developer' | 'user'; content: string }>
  | Readonly<{
      role: 'assistant'
      content: string | null
      toolCalls?: readonly ModelAssistantToolCall[]
      providerState?: ProviderTurnState
    }>
  | Readonly<{ role: 'tool'; content: string; toolCallId: string }>

export interface ModelRequest {
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly toolMode: ModelToolMode
  readonly streaming: boolean
  readonly maxOutputTokens: number
  readonly reasoning: ModelReasoningOptions
  readonly metadata?: ProviderRequestMetadata
  readonly temperature?: number
  readonly topP?: number
}

export interface NormalizedToolCall {
  readonly index: number
  readonly callId: string
  readonly name: string
  readonly argumentsText: string
  readonly arguments: JsonObject
}

export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'unknown'

export interface ModelInputCacheUsage {
  readonly hitTokens: number
  readonly missTokens: number
}

export interface ModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly inputCache?: ModelInputCacheUsage
}

export const MAX_MODEL_REASONING_CODE_POINTS = 2_000

export interface ModelReasoningTrace {
  readonly text: string
  readonly truncated: boolean
}

export function normalizeModelReasoningTrace (
  value: string
): ModelReasoningTrace | undefined {
  const normalized = value.trim().normalize('NFC')
  if (normalized === '') return undefined
  const points = [...normalized]
  const truncated = points.length > MAX_MODEL_REASONING_CODE_POINTS
  return Object.freeze({
    text: truncated
      ? points.slice(0, MAX_MODEL_REASONING_CODE_POINTS).join('')
      : normalized,
    truncated
  })
}

export interface ModelTurn {
  readonly text: string
  readonly refusal?: string
  readonly toolCalls: readonly NormalizedToolCall[]
  readonly finishReason: ModelFinishReason
  readonly usage?: ModelUsage
  readonly reasoning?: ModelReasoningTrace
  readonly providerState?: ProviderTurnState
  readonly responseId?: string
}

export interface ModelAdapter {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn>
}

export interface ModelProviderErrorOptions {
  readonly code: AgentErrorCode
  readonly stage: string
  readonly retryable: boolean
  readonly userMessage: string
  readonly details?: AgentErrorDetails
  readonly statusCode?: number | null
  readonly providerCode?: string
  readonly profileCode?: string
}

const SAFE_CODE = /^[a-z0-9_.:-]{1,128}$/i

export class ModelProviderError extends AgentError {
  readonly statusCode: number | null
  readonly providerCode?: string
  readonly profileCode?: string

  constructor (options: ModelProviderErrorOptions) {
    super({
      code: options.code,
      stage: options.stage,
      retryable: options.retryable,
      userMessage: options.userMessage,
      details: options.details
    })
    this.name = 'ModelProviderError'
    this.statusCode = options.statusCode ?? null
    this.providerCode = options.providerCode && SAFE_CODE.test(options.providerCode)
      ? options.providerCode
      : undefined
    this.profileCode = options.profileCode && SAFE_CODE.test(options.profileCode)
      ? options.profileCode
      : undefined
  }
}

export function modelProtocolError (reason: string): ModelProviderError {
  return new ModelProviderError({
    code: 'provider_protocol_error',
    stage: 'model.decode',
    retryable: false,
    userMessage: 'AI 服务响应格式异常，请稍后重试。',
    details: { reason }
  })
}

export function modelRequestError (reason: string): ModelProviderError {
  return new ModelProviderError({
    code: 'provider_invalid_request',
    stage: 'model.request',
    retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。',
    details: { reason }
  })
}
