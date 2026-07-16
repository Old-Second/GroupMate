export type Phase6CompletionErrorCode = 'legacy_entry_kind_unavailable'

export type AgentErrorCode =
  | 'invalid_request'
  | 'invalid_session'
  | 'storage_unavailable'
  | 'storage_invalid_data'
  | 'context_budget_exceeded'
  | 'provider_authentication'
  | 'provider_invalid_request'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_protocol_error'
  | 'run_budget_exceeded'
  | 'checkpoint_conflict'
  | 'checkpoint_invalid'
  | 'approval_expired'
  | 'authorization_changed'
  | 'tool_outcome_unknown'
  | 'cancelled'
  | Phase6CompletionErrorCode
  | 'internal_error'
  | 'internal'

export const AGENT_ERROR_CODES: readonly AgentErrorCode[] = Object.freeze([
  'invalid_request',
  'invalid_session',
  'storage_unavailable',
  'storage_invalid_data',
  'context_budget_exceeded',
  'provider_authentication',
  'provider_invalid_request',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_timeout',
  'provider_protocol_error',
  'run_budget_exceeded',
  'checkpoint_conflict',
  'checkpoint_invalid',
  'approval_expired',
  'authorization_changed',
  'tool_outcome_unknown',
  'cancelled',
  'legacy_entry_kind_unavailable',
  'internal_error',
  'internal'
])

export function isAgentErrorCode (value: unknown): value is AgentErrorCode {
  return typeof value === 'string' && AGENT_ERROR_CODES.includes(value as AgentErrorCode)
}

export type AgentErrorDetails = Readonly<Record<string, string | number | boolean | null>>

export interface AgentErrorOptions {
  readonly code: AgentErrorCode
  readonly stage: string
  readonly retryable: boolean
  readonly userMessage: string
  readonly details?: AgentErrorDetails
  readonly cause?: unknown
}
export interface SerializedAgentError {
  readonly code: AgentErrorCode
  readonly stage: string
  readonly retryable: boolean
  readonly userMessage: string
  readonly details: AgentErrorDetails
}

export class AgentError extends Error {
  readonly code: AgentErrorCode
  readonly stage: string
  readonly retryable: boolean
  readonly userMessage: string
  readonly details: AgentErrorDetails
  override readonly cause?: unknown

  constructor (options: AgentErrorOptions) {
    super(options.userMessage, { cause: options.cause })
    this.name = 'AgentError'
    this.code = options.code
    this.stage = options.stage
    this.retryable = options.retryable
    this.userMessage = options.userMessage
    this.details = Object.freeze({ ...(options.details ?? {}) })
    this.cause = options.cause
  }
}

export function serializeAgentError (error: AgentError): SerializedAgentError {
  return Object.freeze({
    code: error.code,
    stage: error.stage,
    retryable: error.retryable,
    userMessage: error.userMessage,
    details: error.details
  })
}
