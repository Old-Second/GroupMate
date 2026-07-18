import type { AgentErrorCode } from '../contracts/error.js'
import type { JsonObject } from './json-value.js'
import type {
  ModelInputCacheUsage,
  ModelProviderError,
  ModelReasoningTrace,
  ModelReasoningOptions,
  ModelToolMode
} from './model-adapter.js'
import type { BoundedOpenAIWireError } from './openai-wire.js'
import type { ProviderTurnState } from '../run/provider-state.js'

export interface ToolControlInput {
  readonly enabled: boolean
  readonly mode: ModelToolMode
  readonly tools: readonly JsonObject[]
}

export interface ModelErrorOverride {
  readonly code: AgentErrorCode
  readonly retryable: boolean
  readonly userMessage: string
  readonly profileCode?: string
}

export interface OpenAICompatibleProfile {
  readonly id: string
  readonly version: number
  readonly capabilities: Readonly<{
    supportsDeveloperRole: boolean
    supportsToolChoice: boolean
    outputTokenField: 'max_tokens' | 'max_completion_tokens'
    requiresAssistantContentForToolCalls: boolean
    requiresReasoningStateForToolCalls: boolean
  }>
  encodeToolControls(input: ToolControlInput): Readonly<JsonObject>
  encodeRequestExtensions(input: ModelReasoningOptions): Readonly<JsonObject>
  decodeUsageExtensions(
    usage: Readonly<JsonObject>,
    common: Readonly<{
      inputTokens: number
      outputTokens: number
      totalTokens: number
    }>
  ): Readonly<{ inputCache?: ModelInputCacheUsage }>
  extractAssistantReasoning(message: Readonly<JsonObject>): ModelReasoningTrace | undefined
  captureAssistantState(message: Readonly<JsonObject>): ProviderTurnState | undefined
  restoreAssistantExtensions(state: ProviderTurnState): Readonly<JsonObject>
  classifyError(error: BoundedOpenAIWireError): ModelErrorOverride | undefined
  recoveryHint(error: ModelProviderError): 'none' | 'drop_optional_context_once'
}
