import { parseJsonValue, type JsonObject } from './json-value.js'
import type { ModelCapabilitySnapshotV1 } from './model-capability.js'
import {
  DEEPSEEK_CNY_CATALOG_VERSION,
  DEEPSEEK_PRICE_VERIFIED_AT,
  resolveModelPriceSnapshot
} from './model-price-catalog.js'
import type {
  ModelInputCacheUsage,
  ModelProviderError,
  ProviderRequestMetadata,
  ModelReasoningTrace,
  ModelRequest,
  ModelReasoningOptions
} from './model-adapter.js'
import { modelRequestError, normalizeModelReasoningTrace } from './model-adapter.js'
import {
  expiredImageInputRecoveryHint,
  type ModelErrorOverride,
  type OpenAICompatibleProfile,
  type ToolControlInput
} from './openai-compatible-profile.js'
import type { BoundedOpenAIWireError } from './openai-wire.js'
import {
  parseProviderTurnState,
  type ProviderTurnState
} from '../run/provider-state.js'

const PROFILE_ID = 'deepseek'
const PROFILE_VERSION = 1
const LEGACY_CONTEXT_PROFILE_CODE = 'deepseek_invalid_legacy_context'
const LEGACY_CONTEXT_MESSAGE = /^deepseek-[a-z0-9.-]+ does not support successive user or assistant messages \(messages\[\d+\] and messages\[\d+\] in your input\)\. You should interleave the user\/assistant messages in the message sequence\.$/i
const EMPTY_OBJECT: Readonly<JsonObject> = Object.freeze({})
const DEEPSEEK_V4_CAPABILITY: ModelCapabilitySnapshotV1 = Object.freeze({
  schemaVersion: 1,
  source: 'profile',
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 384_000,
  promptCaching: 'deepseek_disk',
  usageExtensions: Object.freeze([
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens'
  ] as const),
  priceCatalogVersion: DEEPSEEK_CNY_CATALOG_VERSION
})

function resolveDeepSeekModelCapability (
  model: string,
  now: Date
): ModelCapabilitySnapshotV1 | undefined {
  const current = now.getTime() >= DEEPSEEK_PRICE_VERIFIED_AT
  const known = current
    ? ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].includes(model)
    : ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(model) ||
      (['deepseek-chat', 'deepseek-reasoner'].includes(model) &&
        now.getTime() < Date.parse('2026-07-24T16:00:00.000Z'))
  if (!known) return undefined
  return Object.freeze({
    ...DEEPSEEK_V4_CAPABILITY,
    contextWindowTokens: current ? 1_048_576 : 1_000_000,
    maxOutputTokens: current ? 393_216 : 384_000,
    priceCatalogVersion: resolveModelPriceSnapshot(model, now)?.catalogVersion ?? null
  })
}

function hasToolCalls (message: Readonly<JsonObject>): boolean {
  if (message.tool_calls === undefined || message.tool_calls === null) return false
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw new TypeError('DeepSeek tool calls must be a non-empty array')
  }
  return true
}

function captureDeepSeekAssistantState (
  message: Readonly<JsonObject>,
  reasoning?: ModelReasoningOptions
): ProviderTurnState | undefined {
  const toolCalls = hasToolCalls(message)
  if (!toolCalls && (message.reasoning_content === undefined || message.reasoning_content === null)) {
    return undefined
  }
  // Non-thinking tool calls have no reasoning. Preserve an explicit empty state
  // so they can be replayed without requiring or inventing a thought trace.
  if (toolCalls && reasoning?.enabled === false &&
    (message.reasoning_content === undefined || message.reasoning_content === null)) {
    return parseProviderTurnState({
      profileId: PROFILE_ID, profileVersion: PROFILE_VERSION,
      payload: { reasoningContent: '' }
    })
  }
  if (typeof message.reasoning_content !== 'string') {
    throw new TypeError('DeepSeek reasoning_content is required for assistant tool calls')
  }
  return parseProviderTurnState({
    profileId: PROFILE_ID,
    profileVersion: PROFILE_VERSION,
    payload: {
      reasoningContent: message.reasoning_content
    }
  })
}

function extractDeepSeekAssistantReasoning (
  message: Readonly<JsonObject>
): ModelReasoningTrace | undefined {
  const value = message.reasoning_content
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TypeError('DeepSeek reasoning_content is invalid')
  }
  return normalizeModelReasoningTrace(value)
}

function restoreDeepSeekAssistantState (state: ProviderTurnState): Readonly<JsonObject> {
  const parsed = parseProviderTurnState(state)
  if (parsed.profileId !== PROFILE_ID || parsed.profileVersion !== PROFILE_VERSION) {
    throw new TypeError('DeepSeek provider state profile does not match')
  }
  if (parsed.payload === null || typeof parsed.payload !== 'object' ||
      Array.isArray(parsed.payload)) {
    throw new TypeError('DeepSeek provider state payload is invalid')
  }
  const payload = parsed.payload as JsonObject
  const keys = Object.keys(payload)
  if (keys.length !== 1 || keys[0] !== 'reasoningContent' ||
      typeof payload.reasoningContent !== 'string') {
    throw new TypeError('DeepSeek provider state reasoning content is invalid')
  }
  return Object.freeze({
    reasoning_content: payload.reasoningContent
  })
}

function encodeDeepSeekReasoningOptions (
  input: ModelReasoningOptions
): Readonly<JsonObject> {
  return Object.freeze({
    thinking: Object.freeze({ type: input.enabled ? 'enabled' : 'disabled' }),
    ...(!input.enabled || input.effort === undefined ? {} : {
      reasoning_effort: input.effort === 'medium' ? 'high' : input.effort
    })
  })
}

function encodeDeepSeekRequestMetadata (
  input: ProviderRequestMetadata | undefined
): Readonly<JsonObject> {
  return input === undefined
    ? EMPTY_OBJECT
    : Object.freeze({ user_id: input.cacheIsolationId })
}

function decodeDeepSeekUsageExtensions (
  usage: Readonly<JsonObject>,
  common: Readonly<{
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
): Readonly<{ inputCache?: ModelInputCacheUsage }> {
  const hitTokens = usage.prompt_cache_hit_tokens
  const missTokens = usage.prompt_cache_miss_tokens
  if (hitTokens === undefined && missTokens === undefined) return EMPTY_OBJECT
  if (typeof hitTokens !== 'number' || typeof missTokens !== 'number' ||
      !Number.isSafeInteger(hitTokens) || !Number.isSafeInteger(missTokens) ||
      hitTokens < 0 || missTokens < 0 || hitTokens + missTokens !== common.inputTokens) {
    throw new TypeError('DeepSeek input cache usage is invalid')
  }
  return Object.freeze({
    inputCache: Object.freeze({ hitTokens, missTokens })
  })
}

function readDeepSeekError (
  error: BoundedOpenAIWireError
): Readonly<Record<string, unknown>> | undefined {
  if (error.truncated) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(error.body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const nested = (parsed as Record<string, unknown>).error
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return undefined
  try {
    const safe = parseJsonValue(nested, { maxBytes: 16_384 })
    return safe !== null && typeof safe === 'object' && !Array.isArray(safe)
      ? safe as Readonly<Record<string, unknown>>
      : undefined
  } catch {
    return undefined
  }
}

function isKnownLegacyContextError (error: BoundedOpenAIWireError): boolean {
  if (error.status !== 400 || error.providerCode !== 'invalid_request_error') return false
  const detail = readDeepSeekError(error)
  return typeof detail?.message === 'string' && LEGACY_CONTEXT_MESSAGE.test(detail.message) &&
    detail.type === 'invalid_request_error' &&
    detail.param === null &&
    detail.code === 'invalid_request_error'
}

function classifyDeepSeekError (
  error: BoundedOpenAIWireError
): ModelErrorOverride | undefined {
  if (isKnownLegacyContextError(error)) {
    return Object.freeze({
      code: 'provider_invalid_request',
      retryable: false,
      userMessage: '请求格式不正确，请联系机器人主人。',
      profileCode: LEGACY_CONTEXT_PROFILE_CODE
    })
  }
  if (error.status === 402) {
    return Object.freeze({
      code: 'provider_invalid_request',
      retryable: false,
      userMessage: 'AI 服务余额不足，请联系机器人主人。',
      profileCode: 'deepseek_balance_insufficient'
    })
  }
  if (error.status === 422) {
    return Object.freeze({
      code: 'provider_invalid_request',
      retryable: false,
      userMessage: '请求参数不受支持，请联系机器人主人。',
      profileCode: 'deepseek_invalid_parameters'
    })
  }
  if (error.status === 503) {
    return Object.freeze({
      code: 'provider_unavailable',
      retryable: true,
      userMessage: 'AI 服务繁忙，请稍后重试。',
      profileCode: 'deepseek_overloaded'
    })
  }
  return undefined
}

function deepSeekRecoveryHint (
  error: ModelProviderError
): 'none' | 'drop_optional_context_once' {
  if (error.code === 'provider_invalid_request' &&
    error.stage === 'model.response' &&
    error.statusCode === 400 &&
    error.profileCode === LEGACY_CONTEXT_PROFILE_CODE) {
    return 'drop_optional_context_once'
  }
  return expiredImageInputRecoveryHint(error)
}

export const deepSeekCompatibilityProfile: OpenAICompatibleProfile = Object.freeze({
  id: PROFILE_ID,
  version: PROFILE_VERSION,
  cacheIsolation: 'conversation_required',
  capabilities: Object.freeze({
    supportsDeveloperRole: false,
    supportsToolChoice: true,
    outputTokenField: 'max_tokens',
    requiresAssistantContentForToolCalls: true,
    requiresReasoningStateForToolCalls: true
  }),
  resolveModelCapability: resolveDeepSeekModelCapability,
  resolveModelPrice: resolveModelPriceSnapshot,
  validateRequest: (request: ModelRequest) => {
    const known = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].includes(request.model)
    if (known && request.maxOutputTokens > 393_216) throw modelRequestError('deepseek_output_limit_exceeded')
    if (request.model === 'deepseek-v4-pro' && request.messages.some(message =>
      message.role === 'user' && (message.imageUrls?.length ?? 0) > 0)) {
      throw modelRequestError('deepseek_model_does_not_support_images')
    }
  },
  encodeToolControls: (input: ToolControlInput) => {
    if (!input.enabled) return EMPTY_OBJECT
    if (input.mode === 'required' && input.reasoning?.enabled === true) {
      throw modelRequestError('deepseek_required_tools_with_thinking')
    }
    return Object.freeze({ tools: Object.freeze([...input.tools]), tool_choice: input.mode })
  },
  encodeSamplingOptions: (input: ModelReasoningOptions, temperature?: number, topP?: number) => Object.freeze({
    ...(input.enabled || temperature === undefined ? {} : { temperature }),
    ...(!input.enabled || topP === undefined ? {} : { top_p: Math.min(1, Math.max(0.95, topP)) })
  }),
  // Bound visual input size as well as text. The remote host never downloads
  // model images; a per-image token reserve remains necessary in the planner.
  encodeImageOptions: () => Object.freeze({ detail: 'low' }),
  encodeAssistantFallback: (toolsEnabled: boolean, input: ModelReasoningOptions) =>
    toolsEnabled && input.enabled ? Object.freeze({ reasoning_content: '' }) : EMPTY_OBJECT,
  encodeRequestExtensions: encodeDeepSeekReasoningOptions,
  encodeRequestMetadata: encodeDeepSeekRequestMetadata,
  decodeUsageExtensions: decodeDeepSeekUsageExtensions,
  extractAssistantReasoning: extractDeepSeekAssistantReasoning,
  captureAssistantState: captureDeepSeekAssistantState,
  restoreAssistantExtensions: restoreDeepSeekAssistantState,
  classifyError: classifyDeepSeekError,
  recoveryHint: deepSeekRecoveryHint
})
