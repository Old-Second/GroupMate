import { AgentError } from '../contracts/error.js'

export const MODEL_TURN_CAPACITY_LIMITS = Object.freeze({
  contextWindowTokens: 32_768,
  toolSchemaTokens: 4_096,
  safetyMarginTokens: 1_024
})

export interface ModelTurnCapacityInput {
  readonly estimatedInputTokens: number
  readonly requestedOutputTokens: number
  readonly toolsEnabled: boolean
}

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

export function availableModelOutputTokens (input: ModelTurnCapacityInput): number {
  nonNegativeInteger(input.estimatedInputTokens, 'estimated input tokens')
  positiveInteger(input.requestedOutputTokens, 'requested output tokens')
  if (typeof input.toolsEnabled !== 'boolean') {
    throw new TypeError('tools enabled must be a boolean')
  }
  const reservedTokens = MODEL_TURN_CAPACITY_LIMITS.safetyMarginTokens +
    (input.toolsEnabled ? MODEL_TURN_CAPACITY_LIMITS.toolSchemaTokens : 0)
  const availableTokens = MODEL_TURN_CAPACITY_LIMITS.contextWindowTokens -
    input.estimatedInputTokens - reservedTokens
  if (availableTokens < 1) {
    throw new AgentError({
      code: 'context_budget_exceeded',
      stage: 'run.model_context',
      retryable: false,
      userMessage: '当前请求超出可用上下文范围，请缩短内容后重试。',
      details: {
        estimatedInputTokens: input.estimatedInputTokens,
        reservedTokens,
        contextWindowTokens: MODEL_TURN_CAPACITY_LIMITS.contextWindowTokens
      }
    })
  }
  return Math.min(input.requestedOutputTokens, availableTokens)
}
