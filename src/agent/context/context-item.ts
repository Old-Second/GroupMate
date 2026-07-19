import type { AgentMessage } from '../contracts/content.js'
import type { MemoryQuery } from '../contracts/memory.js'
import type { ModelMessage } from '../model/model-adapter.js'

export type ContextSource =
  | 'system_instruction'
  | 'runtime_fact'
  | 'session_history'
  | 'group_context'
  | 'memory'
  | 'current_request'
  | 'tool_chain'

export interface ContextItem {
  readonly id: string
  readonly source: ContextSource
  readonly message: AgentMessage
  readonly atomicGroupId?: string
  readonly protocolSpanId?: string
  readonly modelMessage?: ModelMessage
}

export interface ContextInput {
  readonly systemInstructions: readonly ContextItem[]
  readonly runtimeFacts: readonly ContextItem[]
  readonly sessionHistory: readonly ContextItem[]
  readonly groupContext: readonly ContextItem[]
  readonly currentRequest: ContextItem
  readonly toolMessages: readonly ContextItem[]
  readonly memoryQuery?: MemoryQuery
}

export interface TokenEstimator {
  /** Legacy ContextEngine selector identity only; the strict V1 Planner uses its fixed estimator. */
  readonly version?: string
  estimate(message: AgentMessage): number
  estimateModelMessage?(message: ModelMessage): number
}
