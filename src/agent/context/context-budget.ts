import type { ContextItem } from './context-item.js'

export interface ContextBudget {
  readonly modelContextTokens: number
  readonly reservedOutputTokens: number
  readonly reservedToolTokens: number
  readonly safetyMarginTokens: number
  readonly maxItems: number
  readonly maxBytes: number
}

export interface ContextSnapshot {
  readonly items: readonly ContextItem[]
  readonly estimatedInputTokens: number
  readonly availableInputTokens: number
  readonly includedIds: readonly string[]
  readonly omitted: readonly {
    readonly id: string
    readonly reason: 'duplicate' | 'budget'
  }[]
}
