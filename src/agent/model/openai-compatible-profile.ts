import type { AgentErrorCode } from '../contracts/error.js'
import type { JsonObject } from './json-value.js'
import type { ModelCapabilitySnapshotV1 } from './model-capability.js'
import type { ModelPriceSnapshotV1 } from './model-price-catalog.js'
import type {
  ModelInputCacheUsage,
  ModelProviderError,
  ProviderRequestMetadata,
  ModelReasoningTrace,
  ModelReasoningOptions,
  ModelToolMode,
  ModelRequest
} from './model-adapter.js'
import type { BoundedOpenAIWireError } from './openai-wire.js'
import type { ProviderTurnState } from '../run/provider-state.js'

export interface ToolControlInput {
  readonly enabled: boolean
  readonly mode: ModelToolMode
  readonly tools: readonly JsonObject[]
  readonly reasoning?: ModelReasoningOptions
}

export interface ModelErrorOverride {
  readonly code: AgentErrorCode
  readonly retryable: boolean
  readonly userMessage: string
  readonly profileCode?: string
}

/**
 * Whether a rejected image-carrying request is worth one context-free retry.
 *
 * Host image links carry a signature that expires within the hour, so a replayed
 * image makes the provider refuse the whole request as malformed and the member
 * only sees an unhelpable error. Dropping the optional context also drops the
 * replayed image, which turns that dead end into a plain answer.
 */
export function expiredImageInputRecoveryHint (
  error: ModelProviderError
): 'none' | 'drop_optional_context_once' {
  return error.requestImageInputs && error.code === 'provider_invalid_request' &&
    error.stage === 'model.response' && error.statusCode === 400
    ? 'drop_optional_context_once'
    : 'none'
}

export interface OpenAICompatibleProfile {
  readonly id: string
  readonly version: number
  readonly cacheIsolation: 'none' | 'conversation_required'
  readonly capabilities: Readonly<{
    supportsDeveloperRole: boolean
    supportsToolChoice: boolean
    outputTokenField: 'max_tokens' | 'max_completion_tokens'
    requiresAssistantContentForToolCalls: boolean
    requiresReasoningStateForToolCalls: boolean
  }>
  resolveModelCapability(model: string, now: Date): ModelCapabilitySnapshotV1 | undefined
  resolveModelPrice(model: string, now: Date): ModelPriceSnapshotV1 | undefined
  validateRequest?(request: ModelRequest): void
  encodeToolControls(input: ToolControlInput): Readonly<JsonObject>
  encodeRequestExtensions(input: ModelReasoningOptions): Readonly<JsonObject>
  encodeRequestMetadata(input: ProviderRequestMetadata | undefined): Readonly<JsonObject>
  encodeSamplingOptions?(input: ModelReasoningOptions, temperature?: number, topP?: number): Readonly<JsonObject>
  encodeImageOptions?(): Readonly<JsonObject>
  encodeAssistantFallback?(toolsEnabled: boolean, reasoning: ModelReasoningOptions): Readonly<JsonObject>
  decodeUsageExtensions(
    usage: Readonly<JsonObject>,
    common: Readonly<{
      inputTokens: number
      outputTokens: number
      totalTokens: number
    }>
  ): Readonly<{ inputCache?: ModelInputCacheUsage }>
  extractAssistantReasoning(message: Readonly<JsonObject>): ModelReasoningTrace | undefined
  captureAssistantState(message: Readonly<JsonObject>, reasoning?: ModelReasoningOptions): ProviderTurnState | undefined
  restoreAssistantExtensions(state: ProviderTurnState): Readonly<JsonObject>
  classifyError(error: BoundedOpenAIWireError): ModelErrorOverride | undefined
  recoveryHint(error: ModelProviderError): 'none' | 'drop_optional_context_once'
}
