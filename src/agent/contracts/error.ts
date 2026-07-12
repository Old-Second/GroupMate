export type AgentErrorCode =
  | 'invalid_request'
  | 'invalid_session'
  | 'storage_unavailable'
  | 'storage_invalid_data'
  | 'context_budget_exceeded'
  | 'cancelled'
  | 'internal'

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
