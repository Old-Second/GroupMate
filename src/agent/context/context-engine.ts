import { AgentError } from '../contracts/error.js'
import type { MemoryStore } from '../contracts/memory.js'
import type { ContextBudget, ContextSnapshot } from './context-budget.js'
import type {
  ContextInput,
  ContextItem,
  ContextSource,
  TokenEstimator
} from './context-item.js'

export interface ContextEngineOptions {
  readonly estimator: TokenEstimator
  readonly memoryStore: MemoryStore
}

interface EstimatedItem {
  readonly item: ContextItem
  readonly tokens: number
  readonly semanticIndex: number
}

interface AtomicGroup {
  readonly id: string
  readonly items: EstimatedItem[]
  readonly tokens: number
  readonly mandatory: boolean
  readonly priority: number
  readonly newestAt: string
  readonly tieBreakId: string
}

const optionalPriority: Readonly<Record<ContextSource, number>> = {
  system_instruction: 0,
  runtime_fact: 5,
  session_history: 3,
  group_context: 2,
  memory: 1,
  current_request: 0,
  tool_chain: 4
}

function contextError (
  stage: string,
  details: Readonly<Record<string, string | number | boolean | null>>
): AgentError {
  return new AgentError({
    code: 'context_budget_exceeded',
    stage,
    retryable: false,
    userMessage: '当前请求超出可用上下文范围，请缩短内容后重试。',
    details
  })
}

function cancelledError (): AgentError {
  return new AgentError({
    code: 'cancelled',
    stage: 'context.prepare',
    retryable: false,
    userMessage: '操作已取消。'
  })
}

function assertNotAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelledError()
}

function safeInteger (value: number, label: string, positive: boolean): number {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw new TypeError(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`)
  }
  return value
}

function availableTokens (budget: ContextBudget): number {
  const model = safeInteger(budget.modelContextTokens, 'model context tokens', true)
  const output = safeInteger(budget.reservedOutputTokens, 'reserved output tokens', false)
  const tools = safeInteger(budget.reservedToolTokens, 'reserved tool tokens', false)
  const safety = safeInteger(budget.safetyMarginTokens, 'safety margin tokens', false)
  safeInteger(budget.maxItems, 'maximum context items', true)
  safeInteger(budget.maxBytes, 'maximum context bytes', true)
  const available = model - output - tools - safety
  if (available <= 0) {
    throw contextError('context.budget', {
      modelContextTokens: model,
      reservedTokens: output + tools + safety
    })
  }
  return available
}

function sourceIsMandatory (source: ContextSource): boolean {
  return source === 'system_instruction' || source === 'current_request'
}

function byteLength (items: readonly ContextItem[]): number {
  try {
    const modelInput = items.map(item => ({
      id: item.id,
      source: item.source,
      atomicGroupId: item.atomicGroupId,
      protocolSpanId: item.protocolSpanId,
      role: item.message.role,
      parts: item.message.parts,
      modelMessage: item.modelMessage
    }))
    return Buffer.byteLength(JSON.stringify(modelInput), 'utf8')
  } catch (error) {
    throw new AgentError({
      code: 'invalid_request',
      stage: 'context.input',
      retryable: false,
      userMessage: '上下文输入格式无效。',
      cause: error
    })
  }
}

function buildGroups (items: readonly EstimatedItem[]): AtomicGroup[] {
  const grouped = new Map<string, EstimatedItem[]>()
  for (const estimated of items) {
    const groupId = estimated.item.protocolSpanId === undefined
      ? estimated.item.atomicGroupId ?? `item:${estimated.item.id}`
      : `protocol:${estimated.item.protocolSpanId}`
    const group = grouped.get(groupId)
    if (group === undefined) grouped.set(groupId, [estimated])
    else group.push(estimated)
  }
  return [...grouped.entries()].map(([id, groupItems]) => ({
    id,
    items: groupItems,
    tokens: groupItems.reduce((total, value) => total + value.tokens, 0),
    mandatory: groupItems.some(value => sourceIsMandatory(value.item.source)),
    priority: Math.max(...groupItems.map(value => optionalPriority[value.item.source])),
    newestAt: groupItems.reduce((latest, value) => {
      return value.item.message.createdAt > latest ? value.item.message.createdAt : latest
    }, ''),
    tieBreakId: [...groupItems].map(value => value.item.id).sort()[0] ?? id
  }))
}

function optionalGroupOrder (left: AtomicGroup, right: AtomicGroup): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  const newest = right.newestAt.localeCompare(left.newestAt)
  if (newest !== 0) return newest
  return left.tieBreakId.localeCompare(right.tieBreakId)
}

export class ContextEngine {
  private readonly estimator: TokenEstimator
  private readonly memoryStore: MemoryStore

  constructor (options: ContextEngineOptions) {
    this.estimator = options.estimator
    this.memoryStore = options.memoryStore
  }

  async prepare (
    input: ContextInput,
    budget: ContextBudget,
    signal?: AbortSignal
  ): Promise<ContextSnapshot> {
    assertNotAborted(signal)
    const availableInputTokens = availableTokens(budget)
    const memories = input.memoryQuery === undefined
      ? []
      : await this.memoryStore.retrieve(input.memoryQuery, signal)
    assertNotAborted(signal)
    const memoryItems: ContextItem[] = memories.map(candidate => ({
      id: `memory:${candidate.memoryId}`,
      source: 'memory',
      message: candidate.message
    }))
    const semanticItems: ContextItem[] = [
      ...input.systemInstructions,
      ...input.runtimeFacts,
      ...input.sessionHistory,
      ...input.groupContext,
      ...memoryItems,
      input.currentRequest,
      ...input.toolMessages
    ]

    if (semanticItems.length > budget.maxItems) {
      throw contextError('context.input', {
        itemCount: semanticItems.length,
        maxItems: budget.maxItems
      })
    }
    const inputBytes = byteLength(semanticItems)
    if (inputBytes > budget.maxBytes) {
      throw contextError('context.input', { inputBytes, maxBytes: budget.maxBytes })
    }

    const seen = new Set<string>()
    const unique: Array<{ item: ContextItem; semanticIndex: number }> = []
    const duplicates: ContextSnapshot['omitted'][number][] = []
    for (const [semanticIndex, item] of semanticItems.entries()) {
      if (seen.has(item.id)) {
        duplicates.push(Object.freeze({ id: item.id, reason: 'duplicate' }))
      } else {
        seen.add(item.id)
        unique.push({ item, semanticIndex })
      }
    }

    const estimated: EstimatedItem[] = unique.map(value => {
      const tokens = value.item.modelMessage === undefined
        ? this.estimator.estimate(value.item.message)
        : this.estimator.estimateModelMessage?.(value.item.modelMessage) ?? Math.max(
          1,
          Math.ceil(Buffer.byteLength(JSON.stringify(value.item.modelMessage), 'utf8') / 4)
        )
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new TypeError('token estimator must return a non-negative safe integer')
      }
      return { ...value, tokens }
    })
    const groups = buildGroups(estimated)
    const mandatoryGroups = groups.filter(group => group.mandatory)
    const mandatoryTokens = mandatoryGroups.reduce((total, group) => total + group.tokens, 0)
    if (mandatoryTokens > availableInputTokens) {
      throw contextError('context.mandatory', {
        availableInputTokens,
        mandatoryTokens,
        mandatoryItems: mandatoryGroups.reduce((total, group) => total + group.items.length, 0)
      })
    }

    const selectedGroups = new Set(mandatoryGroups.map(group => group.id))
    let estimatedInputTokens = mandatoryTokens
    for (const group of groups.filter(group => !group.mandatory).sort(optionalGroupOrder)) {
      if (estimatedInputTokens + group.tokens <= availableInputTokens) {
        selectedGroups.add(group.id)
        estimatedInputTokens += group.tokens
      }
    }

    const selectedIds = new Set<string>()
    for (const group of groups) {
      if (!selectedGroups.has(group.id)) continue
      for (const value of group.items) selectedIds.add(value.item.id)
    }
    const items = Object.freeze(
      estimated
        .filter(value => selectedIds.has(value.item.id))
        .sort((left, right) => left.semanticIndex - right.semanticIndex)
        .map(value => value.item)
    )
    const budgetOmissions = estimated
      .filter(value => !selectedIds.has(value.item.id))
      .sort((left, right) => left.semanticIndex - right.semanticIndex)
      .map(value => Object.freeze({ id: value.item.id, reason: 'budget' as const }))
    const omitted = Object.freeze([...duplicates, ...budgetOmissions])
    const includedIds = Object.freeze(items.map(item => item.id))

    return Object.freeze({
      items,
      estimatedInputTokens,
      availableInputTokens,
      includedIds,
      omitted
    })
  }
}
