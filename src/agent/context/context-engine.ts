import { AgentError } from '../contracts/error.js'
import type { AgentContentPart, AgentMessage } from '../contracts/content.js'
import type { ModelMessage } from '../model/model-adapter.js'
import type { ContextBudget, ContextSnapshot } from './context-budget.js'
import type {
  ContextInput,
  ContextItem,
  ContextSource,
  TokenEstimator
} from './context-item.js'
import {
  createContextSpanV1,
  domainSeparatedContextHash,
  MAX_CONTEXT_SPANS,
  type ContextSpanPriority,
  type ContextSpanV1
} from './context-span.js'
import { MAX_CONTEXT_PLANNER_INPUT_BYTES, planModelTurn } from './context-planner.js'
import {
  asciiContextCompare,
  canonicalizeModelMessages,
  CONTEXT_TOKEN_ESTIMATOR_VERSION
} from './context-token-estimator.js'

export interface ContextEngineOptions {
  readonly estimator: TokenEstimator
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

interface StrictProjection {
  readonly span: ContextSpanV1
  readonly items: readonly ContextItem[]
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

function itemIsMandatory (item: ContextItem): boolean {
  return sourceIsMandatory(item.source) ||
    (item.source === 'tool_chain' && item.protocolSpanId !== undefined)
}

function invalidContextInput (reason: string): never {
  throw new AgentError({
    code: 'invalid_request',
    stage: 'context.input',
    retryable: false,
    userMessage: '上下文输入格式无效。',
    details: { reason }
  })
}

function validateInputContainers (input: ContextInput): void {
  const ordinary = (item: ContextItem, source: ContextSource): boolean => (
    item.source === source && item.memoryRecord === undefined
  )
  const valid = input.systemInstructions.every(item => ordinary(item, 'system_instruction')) &&
    input.runtimeFacts.every(item => ordinary(item, 'runtime_fact')) &&
    input.sessionHistory.every(item => ordinary(item, 'session_history')) &&
    input.groupContext.every(item => ordinary(item, 'group_context')) &&
    input.memoryContext.every(item => item.source === 'memory' && item.memoryRecord !== undefined) &&
    ordinary(input.currentRequest, 'current_request') &&
    input.toolMessages.every(item => ordinary(item, 'tool_chain'))
  if (!valid) return invalidContextInput('source_container_mismatch')
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
      modelMessage: item.modelMessage === undefined
        ? undefined
        : canonicalizeModelMessages(Object.freeze([item.modelMessage]))[0]
    }))
    return Buffer.byteLength(JSON.stringify(modelInput), 'utf8')
  } catch {
    throw new AgentError({
      code: 'invalid_request',
      stage: 'context.input',
      retryable: false,
      userMessage: '上下文输入格式无效。'
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
    mandatory: groupItems.some(value => itemIsMandatory(value.item)),
    priority: Math.max(...groupItems.map(value => optionalPriority[value.item.source])),
    newestAt: groupItems.reduce((latest, value) => {
      return value.item.message.createdAt > latest ? value.item.message.createdAt : latest
    }, ''),
    tieBreakId: [...groupItems].map(value => value.item.id).sort()[0] ?? id
  }))
}

function optionalGroupOrder (left: AtomicGroup, right: AtomicGroup): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  const newest = asciiContextCompare(right.newestAt, left.newestAt)
  if (newest !== 0) return newest
  return asciiContextCompare(left.tieBreakId, right.tieBreakId)
}

function legacyHash (domain: string, value: string): string {
  return domainSeparatedContextHash(`groupmate.context.legacy.${domain}.v1`, value)
}

function legacyRef (kind: string, value: string): string {
  return `${kind}:${legacyHash(kind, value)}`
}

function partText (part: AgentContentPart): string {
  switch (part.type) {
    case 'text': return part.text
    case 'mention': return `@${part.displayName ?? part.userId}`
    case 'resource_ref': return `[${part.resourceType}: ${part.resourceId}]`
    case 'tool_call': return `[工具调用: ${part.name}]`
    case 'tool_result': return `[工具结果: ${part.status}] ${part.content}`
  }
}

function messageText (message: AgentMessage): string {
  const text = message.parts.map(partText).filter(value => value.length > 0).join('\n')
  return text.length === 0 ? '[空消息]' : text
}

function canonicalLegacyMessages (items: readonly ContextItem[]): readonly ModelMessage[] {
  try {
    return canonicalizeModelMessages(Object.freeze(items.map(item => {
      if (item.modelMessage === undefined) throw new TypeError('missing protocol message')
      return item.modelMessage
    })))
  } catch {
    throw new AgentError({
      code: 'invalid_request',
      stage: 'context.protocol',
      retryable: false,
      userMessage: '上下文中的工具调用状态无效。',
      details: { reason: 'tool_protocol_incomplete' }
    })
  }
}

function sourcePriority (source: ContextSource): ContextSpanPriority {
  if (source === 'system_instruction' || source === 'current_request') return 'critical'
  if (source === 'runtime_fact' || source === 'tool_chain') return 'high'
  if (source === 'session_history') return 'normal'
  return 'low'
}

function ordinaryModelMessage (item: ContextItem): ModelMessage {
  const content = messageText(item.message)
  if (item.source === 'system_instruction') {
    return Object.freeze({ role: 'system' as const, content })
  }
  if (item.source === 'session_history' && item.message.role === 'assistant') {
    return Object.freeze({ role: 'assistant' as const, content })
  }
  return Object.freeze({ role: 'user' as const, content })
}

function safeOrdinaryItem (
  item: ContextItem,
  source: ContextSource,
  trust: 'trusted' | 'untrusted',
  modelMessage: ModelMessage
): ContextItem {
  if (modelMessage.role === 'tool') {
    throw new AgentError({
      code: 'invalid_request', stage: 'context.item', retryable: false,
      userMessage: '上下文条目无效。', details: { reason: 'ordinary_item_invalid' }
    })
  }
  const content = modelMessage.content ?? ''
  const role = modelMessage.role === 'developer' ? 'system' as const : modelMessage.role
  const message: AgentMessage = Object.freeze({
    id: item.message.id,
    role,
    parts: Object.freeze([Object.freeze({ type: 'text' as const, text: content })]),
    createdAt: item.message.createdAt,
    provenance: Object.freeze({
      ...item.message.provenance,
      source,
      trust
    })
  })
  return Object.freeze({
    id: item.id,
    source,
    message,
    ...(item.memoryRecord === undefined ? {} : { memoryRecord: item.memoryRecord }),
    ...(item.atomicGroupId === undefined ? {} : { atomicGroupId: item.atomicGroupId }),
    modelMessage
  })
}

function sourceAnchors (
  item: ContextItem
): readonly Readonly<{ ref: string; contentHash: string }>[] {
  const itemRef = item.source === 'memory'
    ? item.message.provenance.sourceId
    : legacyRef('item', item.id)
  const refs = [Object.freeze({
    ref: itemRef,
    contentHash: legacyHash('item-content', messageText(item.message))
  })]
  if (item.source === 'memory' && item.memoryRecord !== undefined) {
    refs.push(Object.freeze({
      ref: legacyRef('memory-id', item.memoryRecord.memoryId),
      contentHash: item.memoryRecord.revisionHash
    }))
    refs.push(Object.freeze({
      ref: legacyRef('memory-namespace', item.memoryRecord.namespaceRef),
      contentHash: legacyHash('memory-namespace-anchor', item.memoryRecord.namespaceRef)
    }))
  }
  return Object.freeze(refs)
}

function provenanceKind (source: ContextSource): ContextSpanV1['provenance']['kind'] {
  if (source === 'session_history') return 'session_item'
  if (source === 'group_context') return 'group_snapshot'
  if (source === 'memory') return 'memory_record'
  if (source === 'tool_chain') return 'tool_ledger'
  return 'run'
}

function ordinaryProjection (
  item: ContextItem,
  namespaceRef: string,
  semanticOrder: number
): StrictProjection {
  return ordinaryGroupProjection(Object.freeze([item]), namespaceRef, semanticOrder)
}

function ordinaryGroupProjection (
  items: readonly ContextItem[],
  namespaceRef: string,
  semanticOrder: number
): StrictProjection {
  const first = items[0]
  if (first === undefined || items.some(item => item.source !== first.source) ||
    (first.source === 'current_request' && items.length !== 1) ||
    (first.source === 'memory' && (
      items.length !== 1 || first.memoryRecord === undefined ||
      first.message.provenance.sourceId !== `memory:${first.memoryRecord.revisionHash}`
    ))) {
    throw new AgentError({
      code: 'invalid_request', stage: 'context.atomic_group', retryable: false,
      userMessage: '上下文原子组无效。', details: { reason: 'atomic_group_invalid' }
    })
  }
  const strictSource = first.source === 'tool_chain' ? 'runtime_fact' as const : first.source
  const trust = strictSource === 'system_instruction'
    ? 'trusted' as const
    : first.source === 'memory'
      ? 'untrusted' as const
      : first.message.provenance.trust
  if (items.some(item => {
    const itemTrust = strictSource === 'system_instruction'
      ? 'trusted'
      : item.source === 'memory'
        ? 'untrusted'
        : item.message.provenance.trust
    return itemTrust !== trust
  })) {
    throw new AgentError({
      code: 'invalid_request', stage: 'context.atomic_group', retryable: false,
      userMessage: '上下文原子组无效。', details: { reason: 'atomic_group_invalid' }
    })
  }
  const groupKey = first.atomicGroupId ?? first.id
  const ref = first.source === 'memory'
    ? first.message.provenance.sourceId
    : legacyRef('item-group', groupKey)
  const refs = new Map<string, Readonly<{ ref: string; contentHash: string }>>()
  for (const item of items) {
    for (const sourceRef of sourceAnchors(item)) {
      if (!refs.has(sourceRef.ref)) refs.set(sourceRef.ref, sourceRef)
    }
  }
  const messages = Object.freeze(items.map(ordinaryModelMessage))
  const safeItems = Object.freeze(items.map((item, index) => safeOrdinaryItem(
    item,
    first.source,
    trust,
    messages[index] as ModelMessage
  )))
  const span = createContextSpanV1(Object.freeze({
    spanId: legacyRef('span-group', groupKey),
    namespaceRef,
    kind: 'message' as const,
    source: strictSource,
    trust,
    requirement: strictSource === 'system_instruction' || strictSource === 'current_request'
      ? 'mandatory' as const
      : 'optional' as const,
    priority: sourcePriority(first.source),
    semanticOrder,
    originGeneration: first.memoryRecord?.revision ?? 0,
    provenance: Object.freeze({
      kind: provenanceKind(strictSource),
      ref,
      revision: first.memoryRecord?.revision ?? null,
      contentHash: first.memoryRecord?.revisionHash ??
        legacyHash('provenance-group', items.map(item => messageText(item.message)).join('\0'))
    }),
    supersedes: null,
    messages,
    sourceRefs: Object.freeze([...refs.values()]),
    toolProtocol: null
  }))
  return Object.freeze({ span, items: safeItems })
}

function protocolProjection (
  items: readonly ContextItem[],
  namespaceRef: string,
  semanticOrder: number
): StrictProjection {
  const allSessionHistory = items.every(item => item.source === 'session_history')
  const allToolChain = items.every(item => item.source === 'tool_chain')
  if (!allSessionHistory && !allToolChain) {
    throw new AgentError({
      code: 'invalid_request', stage: 'context.protocol', retryable: false,
      userMessage: '上下文中的工具调用状态无效。',
      details: { reason: 'tool_protocol_incomplete' }
    })
  }
  const messages = canonicalLegacyMessages(items)
  const assistant = messages[0]
  if (assistant?.role !== 'assistant' || assistant.toolCalls === undefined ||
    messages.length !== assistant.toolCalls.length + 1 ||
    messages.slice(1).some((message, index) => {
      return message.role !== 'tool' || message.toolCallId !== assistant.toolCalls?.[index]?.callId
    })) {
    throw new AgentError({
      code: 'invalid_request',
      stage: 'context.protocol',
      retryable: false,
      userMessage: '上下文中的工具调用状态无效。',
      details: { reason: 'tool_protocol_incomplete' }
    })
  }
  const spanKey = items[0]?.protocolSpanId
  if (spanKey === undefined) throw new AgentError({
    code: 'invalid_request',
    stage: 'context.protocol',
    retryable: false,
    userMessage: '上下文中的工具调用状态无效。',
    details: { reason: 'tool_protocol_incomplete' }
  })
  const consumed = allSessionHistory
  const canonicalItems = Object.freeze(items.map((item, index) => Object.freeze({
    ...item,
    modelMessage: messages[index] as ModelMessage
  })))
  const ref = legacyRef('protocol', spanKey)
  const span = createContextSpanV1(Object.freeze({
    spanId: legacyRef('span-protocol', spanKey),
    namespaceRef,
    kind: 'tool_protocol' as const,
    source: 'tool_chain' as const,
    trust: canonicalItems.every(item => item.message.provenance.trust === 'trusted')
      ? 'trusted' as const
      : 'untrusted' as const,
    requirement: consumed ? 'optional' as const : 'mandatory' as const,
    priority: consumed ? 'normal' as const : 'critical' as const,
    semanticOrder,
    originGeneration: 0,
    provenance: Object.freeze({
      kind: 'tool_ledger' as const,
      ref,
      revision: null,
      contentHash: legacyHash('protocol-content', spanKey)
    }),
    supersedes: null,
    messages,
    sourceRefs: Object.freeze([Object.freeze({
      ref,
      contentHash: legacyHash('protocol-source', spanKey)
    })]),
    toolProtocol: Object.freeze({
      phase: consumed ? 'consumed' as const : 'ready' as const,
      step: 1,
      callIds: Object.freeze(assistant.toolCalls.map(call => call.callId))
    })
  }))
  return Object.freeze({ span, items: canonicalItems })
}

function strictProjections (
  items: readonly ContextItem[],
  namespaceRef: string
): readonly StrictProjection[] {
  const protocolGroups = new Map<string, ContextItem[]>()
  const atomicGroups = new Map<string, ContextItem[]>()
  const protocolLastIndex = new Map<string, number>()
  const atomicLastIndex = new Map<string, number>()
  const projections: Array<{ order: number; value: StrictProjection }> = []
  for (const [index, item] of items.entries()) {
    if (item.protocolSpanId !== undefined) {
      const previousIndex = protocolLastIndex.get(item.protocolSpanId)
      if (previousIndex !== undefined && previousIndex !== index - 1) {
        throw new AgentError({
          code: 'invalid_request', stage: 'context.protocol', retryable: false,
          userMessage: '上下文中的工具调用状态无效。',
          details: { reason: 'tool_protocol_non_contiguous' }
        })
      }
      protocolLastIndex.set(item.protocolSpanId, index)
      const group = protocolGroups.get(item.protocolSpanId)
      if (group === undefined) protocolGroups.set(item.protocolSpanId, [item])
      else group.push(item)
      continue
    }
    if (item.modelMessage !== undefined) {
      throw new AgentError({
        code: 'invalid_request', stage: 'context.protocol', retryable: false,
        userMessage: '上下文中的工具调用状态无效。',
        details: { reason: 'tool_protocol_incomplete' }
      })
    }
    if (item.atomicGroupId !== undefined) {
      const previousIndex = atomicLastIndex.get(item.atomicGroupId)
      if (previousIndex !== undefined && previousIndex !== index - 1) {
        throw new AgentError({
          code: 'invalid_request', stage: 'context.atomic_group', retryable: false,
          userMessage: '上下文原子组无效。',
          details: { reason: 'atomic_group_non_contiguous' }
        })
      }
      atomicLastIndex.set(item.atomicGroupId, index)
      const group = atomicGroups.get(item.atomicGroupId)
      if (group === undefined) atomicGroups.set(item.atomicGroupId, [item])
      else group.push(item)
      continue
    }
    projections.push({ order: index, value: ordinaryProjection(item, namespaceRef, index + 1) })
  }
  for (const [spanId, group] of protocolGroups) {
    const order = items.findIndex(item => item.protocolSpanId === spanId)
    projections.push({
      order,
      value: protocolProjection(Object.freeze(group), namespaceRef, order + 1)
    })
  }
  for (const [groupId, group] of atomicGroups) {
    const order = items.findIndex(item => item.atomicGroupId === groupId)
    projections.push({
      order,
      value: ordinaryGroupProjection(Object.freeze(group), namespaceRef, order + 1)
    })
  }
  return Object.freeze(projections.sort((left, right) => left.order - right.order).map(entry => entry.value))
}

function strictPlannerGate (
  items: readonly ContextItem[],
  currentRequestId: string,
  maxMessages: number
): Readonly<{ items: readonly ContextItem[]; omittedIds: readonly string[] }> {
  let projections: readonly StrictProjection[]
  let result: ReturnType<typeof planModelTurn>
  try {
    const namespaceRef = legacyRef('namespace', currentRequestId)
    projections = strictProjections(items, namespaceRef)
    const capabilityHash = legacyHash('capability', 'context-engine-v1')
    result = planModelTurn(Object.freeze({
      schemaVersion: 1 as const,
      namespaceRef,
      generation: 1,
      transition: 'normal' as const,
      previousPlan: null,
      estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
      capabilityHash,
      artifactPolicy: 'disabled' as const,
      budget: Object.freeze({
        schemaVersion: 1 as const,
        // Compatibility only: legacy selection above owns its injected estimator and token budget.
        // Task 10 switches the production seam to the fixed Planner estimator and exact budget.
        maxInputTokens: Number.MAX_SAFE_INTEGER,
        maxSerializedMessageBytes: 512 * 1_024,
        maxMessages: Math.min(maxMessages, 128),
        estimatedToolTokens: 0,
        reservedOutputTokens: 0
      }),
      spans: Object.freeze(projections.map(value => value.span)),
      artifacts: Object.freeze([])
    }))
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError({
      code: 'invalid_request',
      stage: 'context.plan',
      retryable: false,
      userMessage: '上下文输入格式无效。',
      details: { reason: 'strict_contract_invalid' }
    })
  }
  if (result.status === 'blocked') {
    throw new AgentError({
      code: result.code === 'context_budget_exceeded' ? 'context_budget_exceeded' : 'invalid_request',
      stage: 'context.plan',
      retryable: false,
      userMessage: result.code === 'context_budget_exceeded'
        ? '当前请求超出可用上下文范围，请缩短内容后重试。'
        : '上下文中的工具调用状态无效。',
      details: { reason: result.code }
    })
  }
  if (result.status !== 'ready') {
    throw new AgentError({
      code: 'internal_error', stage: 'context.plan', retryable: false,
      userMessage: '上下文规划失败。'
    })
  }
  const included = new Set(result.plan.included.map(entry => entry.spanId))
  const selected = projections
    .filter(value => included.has(value.span.spanId))
    .flatMap(value => value.items)
  const omittedIds = projections
    .filter(value => !included.has(value.span.spanId))
    .flatMap(value => value.items.map(item => item.id))
  return Object.freeze({
    items: Object.freeze(selected),
    omittedIds: Object.freeze(omittedIds)
  })
}

export class ContextEngine {
  private readonly estimator: TokenEstimator

  constructor (options: ContextEngineOptions) {
    this.estimator = options.estimator
  }

  projectSourceSpans (
    input: ContextInput,
    namespaceRef: string,
    signal?: AbortSignal
  ): readonly ContextSpanV1[] {
    assertNotAborted(signal)
    validateInputContainers(input)
    const semanticItems = Object.freeze([
      ...input.systemInstructions,
      ...input.runtimeFacts,
      ...input.sessionHistory,
      ...input.groupContext,
      ...input.memoryContext,
      input.currentRequest,
      ...input.toolMessages
    ])
    if (semanticItems.length > MAX_CONTEXT_SPANS) {
      throw contextError('context.input', {
        itemCount: semanticItems.length,
        maxItems: MAX_CONTEXT_SPANS
      })
    }
    const inputBytes = byteLength(semanticItems)
    if (inputBytes > MAX_CONTEXT_PLANNER_INPUT_BYTES) {
      throw contextError('context.input', {
        inputBytes,
        maxBytes: MAX_CONTEXT_PLANNER_INPUT_BYTES
      })
    }
    const seen = new Map<string, ContextItem>()
    const unique: ContextItem[] = []
    for (const item of semanticItems) {
      const first = seen.get(item.id)
      if (first === undefined) {
        seen.set(item.id, item)
        unique.push(item)
      } else if (itemIsMandatory(first) || itemIsMandatory(item)) {
        return invalidContextInput('mandatory_duplicate_id')
      }
    }
    assertNotAborted(signal)
    return Object.freeze(strictProjections(
      Object.freeze(unique),
      namespaceRef
    ).map(projection => projection.span))
  }

  async prepare (
    input: ContextInput,
    budget: ContextBudget,
    signal?: AbortSignal
  ): Promise<ContextSnapshot> {
    assertNotAborted(signal)
    validateInputContainers(input)
    const availableInputTokens = availableTokens(budget)
    const hardMaxItems = Math.min(budget.maxItems, MAX_CONTEXT_SPANS)
    const hardMaxBytes = Math.min(budget.maxBytes, MAX_CONTEXT_PLANNER_INPUT_BYTES)
    const semanticItems: ContextItem[] = [
      ...input.systemInstructions,
      ...input.runtimeFacts,
      ...input.sessionHistory,
      ...input.groupContext,
      ...input.memoryContext,
      input.currentRequest,
      ...input.toolMessages
    ]

    if (semanticItems.length > hardMaxItems) {
      throw contextError('context.input', {
        itemCount: semanticItems.length,
        maxItems: hardMaxItems
      })
    }
    const inputBytes = byteLength(semanticItems)
    if (inputBytes > hardMaxBytes) {
      throw contextError('context.input', { inputBytes, maxBytes: hardMaxBytes })
    }

    const seen = new Map<string, ContextItem>()
    const unique: Array<{ item: ContextItem; semanticIndex: number }> = []
    const duplicates: ContextSnapshot['omitted'][number][] = []
    for (const [semanticIndex, item] of semanticItems.entries()) {
      const first = seen.get(item.id)
      if (first !== undefined) {
        if (itemIsMandatory(first) || itemIsMandatory(item)) {
          return invalidContextInput('mandatory_duplicate_id')
        }
        duplicates.push(Object.freeze({ id: item.id, reason: 'duplicate' }))
      } else {
        seen.set(item.id, item)
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
    const legacyItems = Object.freeze(
      estimated
        .filter(value => selectedIds.has(value.item.id))
        .sort((left, right) => left.semanticIndex - right.semanticIndex)
        .map(value => value.item)
    )
    const budgetOmissions = estimated
      .filter(value => !selectedIds.has(value.item.id))
      .sort((left, right) => left.semanticIndex - right.semanticIndex)
      .map(value => Object.freeze({ id: value.item.id, reason: 'budget' as const }))
    const strict = strictPlannerGate(
      legacyItems,
      input.currentRequest.id,
      budget.maxItems
    )
    const strictOmitted = strict.omittedIds.map(id => Object.freeze({
      id,
      reason: 'budget' as const
    }))
    const omitted = Object.freeze([...duplicates, ...budgetOmissions, ...strictOmitted])
    const includedIds = Object.freeze(strict.items.map(item => item.id))
    const includedIdSet = new Set(includedIds)
    const gatedEstimatedInputTokens = estimated
      .filter(value => includedIdSet.has(value.item.id))
      .reduce((total, value) => total + value.tokens, 0)

    return Object.freeze({
      items: strict.items,
      estimatedInputTokens: gatedEstimatedInputTokens,
      availableInputTokens,
      includedIds,
      omitted
    })
  }
}
