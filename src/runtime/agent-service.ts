import { randomUUID } from 'node:crypto'
import {
  AgentError,
  serializeAgentError
} from '../agent/contracts/error.js'
import type { AgentEvent } from '../agent/contracts/event.js'
import type { AgentContentPart, AgentMessage } from '../agent/contracts/content.js'
import type { SessionPersistenceOutcome } from '../agent/contracts/completion.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import type { RunAdvanceResult } from '../agent/contracts/result.js'
import type { AbortOptions, ListOptions, SaveOptions } from '../agent/contracts/storage.js'
import type { ContextBudget } from '../agent/context/context-budget.js'
import { ContextEngine } from '../agent/context/context-engine.js'
import type { ContextItem } from '../agent/context/context-item.js'
import type {
  ModelMessage,
  ModelProviderError
} from '../agent/model/model-adapter.js'
import type {
  RunApprovalDecisionCommand,
  RunApprovalDisplayCommand,
  RunControlOptions,
  RunEngine,
  RunRuntimeBinding
} from '../agent/run/run-engine.js'
import type { RunCheckpoint } from '../agent/run/run-checkpoint.js'
import {
  RunAdmissionRejectionError,
  type RunAdmission,
  type RunLease
} from '../agent/run/run-admission.js'
import {
  RunReferenceConflictError,
  type RunStore
} from '../agent/run/run-store.js'
import {
  createFrozenObservationPolicy,
  type FrozenObservationPolicyV1
} from '../agent/run/run-observation.js'
import { createRunRef } from '../agent/run/run-reference.js'
import { isTerminalRunStatus } from '../agent/run/run-state.js'
import type { ApprovalInterruption } from '../agent/run/interruption.js'
import {
  parseAgentSessionState,
  type AgentSessionState,
  type CanonicalConversationItem,
  type ProviderProtocolSpan
} from '../agent/session/agent-session-state.js'
import type { SessionRecord, SessionSummary } from '../agent/session/session-record.js'
import type { SessionStore } from '../agent/session/session-store.js'
import type { TerminalCommitReceiptV1 } from '../agent/run/run-store.js'
import type { RunTerminalSnapshotV2 } from '../agent/run/run-observation.js'
import {
  RunProgressPresenter,
  type ProgressDelivery
} from './run-progress-presenter.js'
import {
  activateRequestObservation,
  beginRequestObservation,
  createRequestObservationDraft,
  type ActiveRequestObservationContextV1,
  type AdmissionRejectionReason,
  type ApprovalRecoveryDeferred,
  type RequestObservationContextV1,
  type RequestObservationDraftV1,
  type RequestObservationOutcome
} from './request-observation.js'
import type {
  YunzaiAgentRequest,
  YunzaiAgentRequestDraft
} from './yunzai-request-adapter.js'

export type PausedChatReplyEnvelope =
  Extract<RunAdvanceResult, { readonly kind: 'paused' }> & {
    readonly requestObservationContext: ActiveRequestObservationContextV1
  }

type WithFinalObservationMetadata<T> = T & {
  readonly requestObservationDraft: RequestObservationDraftV1
  readonly sessionPersistence: SessionPersistenceOutcome
}

export type FinalChatReplyEnvelope =
  | WithFinalObservationMetadata<
      Extract<RunAdvanceResult, { readonly kind: 'completed' }>
    > & {
      /** @deprecated Phase 6B Task 6 removes this compatibility projection. */
      readonly text: string | null
      /** @deprecated Phase 6B Task 6 removes this compatibility projection. */
      readonly visibleOutput: boolean
    }
  | WithFinalObservationMetadata<
      Extract<RunAdvanceResult, { readonly kind: 'failed' | 'cancelled' }>
    >

export type ChatReplyEnvelope = PausedChatReplyEnvelope | FinalChatReplyEnvelope

export interface AgentServiceRequestOptions extends RunControlOptions {
  readonly requestObservationContext?: RequestObservationContextV1
}

export interface AgentServiceRunRuntime {
  readonly binding: Readonly<Pick<
    RunRuntimeBinding,
    'snapshot' | 'prepareToolContext' | 'contextFor' | 'approvalControlContext'
  >>
  readonly progress?: ProgressDelivery
  readonly runtimeFacts?: readonly ContextItem[]
  readonly groupContext?: readonly ContextItem[]
}

export interface ConversationSessionPort {
  get(address: SessionAddress, options?: AbortOptions): Promise<SessionRecord<AgentSessionState> | null>
  list(query: { readonly botId: string }, options?: ListOptions): AsyncIterable<SessionSummary>
  delete(address: SessionAddress, options?: AbortOptions): Promise<boolean>
  deleteAll(query: { readonly botId: string }, options?: AbortOptions): Promise<number>
  fork(
    source: SessionAddress,
    target: SessionAddress,
    startedBy: SessionRecord<AgentSessionState>['startedBy'],
    options?: SaveOptions
  ): Promise<SessionRecord<AgentSessionState>>
}

export interface AgentServiceOptions {
  readonly sessions: SessionStore<AgentSessionState>
  readonly runStore: RunStore
  readonly admission: Pick<RunAdmission, 'acquire' | 'recover'>
  readonly contextEngine: ContextEngine
  readonly progressPresenter: RunProgressPresenter
  readonly createEngine: (observer: (event: AgentEvent) => void) => RunEngine
  readonly createRuntime: (request: YunzaiAgentRequest) => Promise<AgentServiceRunRuntime>
  readonly recoverRuntime?: (checkpoint: RunCheckpoint) => Promise<AgentServiceRunRuntime>
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly createRunRef?: () => string
  readonly observationLevel?: () => unknown
  readonly monotonicNow?: () => number | 'unavailable'
  readonly onTerminalSnapshot?: (snapshot: RunTerminalSnapshotV2) => void
  readonly onTerminalCommitReceipt?: (receipt: TerminalCommitReceiptV1) => void
  readonly onObserverFailure?: (entry: Readonly<{
    event: 'agent.observer_failed'
  }>) => void
}

interface PendingRun {
  readonly runId: string
  readonly request: YunzaiAgentRequest | null
  readonly session: SessionRecord<AgentSessionState> | null
  readonly binding: RunRuntimeBinding
  readonly lease: RunLease
  readonly ephemeral: boolean
  readonly requestObservationContext: ActiveRequestObservationContextV1
}

function isApprovalRecoveryDeferred (
  value: PendingRun | ApprovalRecoveryDeferred
): value is ApprovalRecoveryDeferred {
  return 'kind' in value && value.kind === 'approval_deferred'
}

const EMPTY_ITEMS: readonly ContextItem[] = Object.freeze([])

function internalError (cause: unknown): AgentError {
  return new AgentError({
    code: 'internal_error',
    stage: 'agent.service',
    retryable: false,
    userMessage: '处理请求时出现异常，请稍后重试。',
    cause
  })
}

function asAgentError (error: unknown): AgentError {
  return error instanceof AgentError ? error : internalError(error)
}

function failedRunResult (
  runId: string,
  error: unknown,
  runRef: string | 'unavailable' = 'unavailable'
): Extract<RunAdvanceResult, { readonly kind: 'failed' }> {
  return Object.freeze({
    kind: 'failed',
    runId,
    runRef,
    error: serializeAgentError(asAgentError(error)),
    terminal: null
  })
}

function cancellationReason (value: unknown, fallback = 'user_cancelled'): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : fallback
}

function safeObservationLevel (
  read: (() => unknown) | undefined
): FrozenObservationPolicyV1['levelAtStart'] {
  if (read === undefined) return 'basic'
  try {
    const value = read()
    return value === 'off' || value === 'diagnostic' || value === 'basic'
      ? value
      : 'basic'
  } catch {
    return 'basic'
  }
}

function freezeRequest (
  draft: YunzaiAgentRequestDraft,
  runRef: string
): YunzaiAgentRequest {
  return Object.freeze({
    ...draft,
    schemaVersion: 2,
    runRef
  })
}

function cancelledRunResult (
  runId: string,
  reason: unknown = 'user_cancelled',
  runRef: string | 'unavailable' = 'unavailable'
): Extract<RunAdvanceResult, { readonly kind: 'cancelled' }> {
  return Object.freeze({
    kind: 'cancelled',
    runId,
    runRef,
    reason: cancellationReason(reason),
    terminal: null
  })
}

function readMonotonic (
  clock: () => number | 'unavailable'
): number | 'unavailable' {
  try {
    const value = clock()
    return value === 'unavailable' ||
      (Number.isSafeInteger(value) && Number(value) >= 0)
      ? value
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function elapsed (
  started: number | 'unavailable',
  finished: number | 'unavailable'
): number | 'unavailable' {
  return started === 'unavailable' || finished === 'unavailable' || finished < started
    ? 'unavailable'
    : finished - started
}

function linkedAbortSignal (
  callerSignal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController()
  const sources = callerSignal === undefined
    ? [lifecycleSignal]
    : [callerSignal, lifecycleSignal]
  const listeners = new Map<AbortSignal, () => void>()
  for (const source of sources) {
    const forward = (): void => {
      controller.abort(cancellationReason(source.reason))
    }
    if (source.aborted) {
      forward()
      break
    }
    listeners.set(source, forward)
    source.addEventListener('abort', forward, { once: true })
  }
  return Object.freeze({
    signal: controller.signal,
    dispose: (): void => {
      for (const [source, listener] of listeners) {
        source.removeEventListener('abort', listener)
      }
      listeners.clear()
    }
  })
}

function contentPartText (part: AgentContentPart): string {
  switch (part.type) {
    case 'text': return part.text
    case 'resource_ref': return `[${part.resourceType}: ${part.resourceId}]`
    case 'mention': return `@${part.displayName ?? part.userId}`
    case 'tool_call': return `[工具调用: ${part.name}]`
    case 'tool_result': return `[工具结果: ${part.status}] ${part.content}`
  }
}

function messageText (message: AgentMessage): string {
  const text = message.parts.map(contentPartText).filter(value => value.length > 0).join('\n')
  return text.length === 0 ? '[空消息]' : text
}

function modelMessageFor (item: ContextItem): ModelMessage {
  if (item.modelMessage !== undefined) return item.modelMessage
  const content = messageText(item.message)
  if (item.message.role === 'system') return Object.freeze({ role: 'system', content })
  if (item.message.role === 'user') return Object.freeze({ role: 'user', content })
  if (item.message.role === 'assistant') return Object.freeze({ role: 'assistant', content })
  throw new AgentError({
    code: 'invalid_session',
    stage: 'context.session',
    retryable: false,
    userMessage: '会话历史格式不兼容，请重新开始对话。'
  })
}

function currentRunItemOrder (items: readonly ContextItem[]): readonly ContextItem[] {
  const runtimeFacts = items.filter(item => item.source === 'runtime_fact')
  if (runtimeFacts.length === 0) return items
  const ordered = items.filter(item => item.source !== 'runtime_fact')
  const currentIndex = ordered.findIndex(item => item.source === 'current_request')
  if (currentIndex < 0) return Object.freeze([...ordered, ...runtimeFacts])
  return Object.freeze([
    ...ordered.slice(0, currentIndex),
    ...runtimeFacts,
    ...ordered.slice(currentIndex)
  ])
}

function mergeableTextRole (
  message: ModelMessage
): 'system' | 'developer' | 'user' | 'assistant' | null {
  if (message.role === 'tool') return null
  if (message.role !== 'assistant') return message.role
  return typeof message.content === 'string' && message.toolCalls === undefined &&
    message.providerState === undefined
    ? 'assistant'
    : null
}

function coalesceModelMessages (
  messages: readonly ModelMessage[]
): readonly ModelMessage[] {
  const result: ModelMessage[] = []
  for (const message of messages) {
    const role = mergeableTextRole(message)
    const previous = result.at(-1)
    if (role !== null && previous !== undefined &&
      mergeableTextRole(previous) === role) {
      result[result.length - 1] = Object.freeze({
        role,
        content: `${previous.content ?? ''}\n\n${message.content ?? ''}`
      }) as ModelMessage
    } else {
      result.push(message)
    }
  }
  return Object.freeze(result)
}

function systemItem (
  runId: string,
  instruction: string,
  index: number,
  createdAt: string
): ContextItem {
  const id = `system:${runId}:${index}`
  return Object.freeze({
    id,
    source: 'system_instruction',
    message: Object.freeze({
      id,
      role: 'system',
      parts: Object.freeze([{ type: 'text' as const, text: instruction }]),
      createdAt,
      provenance: Object.freeze({
        source: 'system_instruction',
        trust: 'trusted',
        sensitivity: 'sensitive',
        sourceId: id,
        createdAt
      })
    })
  })
}

function protocolMessageItem (
  span: ProviderProtocolSpan,
  modelMessage: ModelMessage,
  index: number
): ContextItem {
  const id = `protocol:${span.id}:${index}`
  return Object.freeze({
    id,
    source: 'session_history',
    protocolSpanId: span.id,
    modelMessage,
    message: Object.freeze({
      id,
      role: modelMessage.role === 'tool'
        ? 'tool'
        : modelMessage.role === 'assistant'
          ? 'assistant'
          : modelMessage.role === 'system'
            ? 'system'
            : 'user',
      parts: Object.freeze([{ type: 'text' as const, text: '[provider protocol]' }]),
      createdAt: span.createdAt,
      provenance: Object.freeze({
        source: 'provider_protocol',
        trust: 'trusted',
        sensitivity: 'sensitive',
        sourceId: span.id,
        createdAt: span.createdAt
      })
    })
  })
}

function sessionItems (
  items: readonly CanonicalConversationItem[]
): readonly ContextItem[] {
  return Object.freeze(items.flatMap(item => {
    if (item.kind === 'message') {
      return [Object.freeze({
        id: `session:${item.message.id}`,
        source: 'session_history' as const,
        message: item.message
      })]
    }
    return item.messages.map((message, index) => protocolMessageItem(item, message, index))
  }))
}

function atomicGroups (items: readonly ContextItem[]): readonly (readonly ContextItem[])[] {
  const groups: Array<readonly ContextItem[]> = []
  const positions = new Map<string, number>()
  for (const item of items) {
    const key = item.protocolSpanId ?? item.atomicGroupId ?? `item:${item.id}`
    const position = positions.get(key)
    if (position === undefined) {
      positions.set(key, groups.length)
      groups.push([item])
    } else {
      groups[position] = Object.freeze([...(groups[position] ?? []), item])
    }
  }
  return Object.freeze(groups)
}

function encodedContextBytes (items: readonly ContextItem[]): number {
  return Buffer.byteLength(JSON.stringify(items.map(item => ({
    id: item.id,
    source: item.source,
    atomicGroupId: item.atomicGroupId,
    protocolSpanId: item.protocolSpanId,
    role: item.message.role,
    parts: item.message.parts,
    modelMessage: item.modelMessage
  }))), 'utf8')
}

function boundedOptionalContext (
  mandatory: readonly ContextItem[],
  runtimeFacts: readonly ContextItem[],
  history: readonly ContextItem[],
  groupContext: readonly ContextItem[],
  budget: ContextBudget
): Readonly<{
  runtimeFacts: readonly ContextItem[]
  sessionHistory: readonly ContextItem[]
  groupContext: readonly ContextItem[]
}> {
  const historyGroups = [...atomicGroups(history)]
  const groupGroups = [...atomicGroups(groupContext)]
  const current = (): readonly ContextItem[] => Object.freeze([
    ...mandatory,
    ...runtimeFacts,
    ...historyGroups.flat(),
    ...groupGroups.flat()
  ])
  while ((current().length > budget.maxItems || encodedContextBytes(current()) > budget.maxBytes) &&
    (groupGroups.length > 0 || historyGroups.length > 0)) {
    if (groupGroups.length > 0) groupGroups.shift()
    else historyGroups.shift()
  }
  return Object.freeze({
    runtimeFacts: Object.freeze([...runtimeFacts]),
    sessionHistory: Object.freeze(historyGroups.flat()),
    groupContext: Object.freeze(groupGroups.flat())
  })
}

function freshSession (
  request: YunzaiAgentRequestDraft,
  sessionId: string,
  timestamp: string
): SessionRecord<AgentSessionState> {
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    botId: request.sessionAddress.botId,
    scope: Object.freeze({ ...request.sessionAddress.scope }),
    startedBy: Object.freeze({
      userId: request.actor.userId,
      ...(request.actor.displayName === undefined
        ? {}
        : { displayName: request.actor.displayName })
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 0,
    state: Object.freeze({ schemaVersion: 1, messages: Object.freeze([]) })
  })
}

function finalEnvelope (
  result: Exclude<RunAdvanceResult, { readonly kind: 'paused' }>,
  requestObservationDraft: RequestObservationDraftV1,
  sessionPersistence: SessionPersistenceOutcome
): FinalChatReplyEnvelope {
  if (result.kind !== 'completed') {
    return Object.freeze({
      ...result,
      requestObservationDraft,
      sessionPersistence
    })
  }
  const text = result.completion.kind === 'reply_text'
    ? result.completion.text
    : null
  return Object.freeze({
    ...result,
    visibleOutput: result.completion.kind === 'already_visible',
    text,
    requestObservationDraft,
    sessionPersistence
  })
}

function preCreateEnvelope (
  result: Extract<RunAdvanceResult, { readonly kind: 'failed' | 'cancelled' }>,
  context: RequestObservationContextV1,
  outcome: Exclude<RequestObservationOutcome, 'completed' | 'failed_session_save'>,
  admissionRejectionReason: AdmissionRejectionReason,
  queueDurationMs: number | 'unavailable' | 'not_attempted',
  sessionLoadDurationMs: number | 'unavailable' | 'not_attempted'
): FinalChatReplyEnvelope {
  const normalized = result.kind === 'failed'
    ? Object.freeze({ ...result, runRef: 'unavailable' as const, terminal: null })
    : Object.freeze({ ...result, runRef: 'unavailable' as const, terminal: null })
  return finalEnvelope(normalized, createRequestObservationDraft({
    context,
    runRef: 'unavailable',
    outcome,
    admissionRejectionReason,
    queueDurationMs,
    sessionLoadDurationMs,
    sessionSaveDurationMs: 'not_attempted',
    terminalObservationId: 'not_attempted'
  }), 'not_attempted')
}

function activeFinalEnvelope (
  result: Exclude<RunAdvanceResult, { readonly kind: 'paused' }>,
  context: ActiveRequestObservationContextV1,
  sessionPersistence: SessionPersistenceOutcome,
  sessionSaveDurationMs: number | 'unavailable' | 'not_attempted'
): FinalChatReplyEnvelope {
  const terminalObservationId = result.terminal?.snapshot.observationId ?? 'unavailable'
  const failedSessionSave = sessionPersistence === 'failed'
  const requestObservationDraft = failedSessionSave
    ? createRequestObservationDraft({
        context,
        outcome: 'failed_session_save',
        admissionRejectionReason: 'not_applicable',
        sessionSaveDurationMs: sessionSaveDurationMs === 'not_attempted'
          ? 'unavailable'
          : sessionSaveDurationMs,
        terminalObservationId: terminalObservationId === 'unavailable'
          ? (() => { throw new TypeError('failed session save terminal fact is unavailable') })()
          : terminalObservationId
      })
    : createRequestObservationDraft({
        context,
        outcome: 'completed',
        admissionRejectionReason: 'not_applicable',
        sessionSaveDurationMs,
        terminalObservationId
      })
  return finalEnvelope(result, requestObservationDraft, sessionPersistence)
}

function appendTerminalTurn (
  record: SessionRecord<AgentSessionState>,
  request: YunzaiAgentRequest,
  result: Extract<RunAdvanceResult, { readonly kind: 'completed' }>,
  updatedAt: string
): SessionRecord<AgentSessionState> {
  const existing = [...record.state.messages]
  const appended: CanonicalConversationItem[] = []
  const ids = new Set(existing.map(item => (
    item.kind === 'message' ? item.message.id : item.id
  )))
  if (!ids.has(request.message.id)) {
    appended.push(Object.freeze({ kind: 'message', message: request.message }))
    ids.add(request.message.id)
  }
  if (result.output !== null && !ids.has(result.output.id)) {
    appended.push(Object.freeze({ kind: 'message', message: result.output }))
  }
  const messages = [...existing, ...appended].slice(-128)
  let state: AgentSessionState | undefined
  while (state === undefined) {
    try {
      state = parseAgentSessionState({
        schemaVersion: 1,
        messages,
        ...(record.state.migratedFrom === undefined
          ? {}
          : { migratedFrom: record.state.migratedFrom })
      })
    } catch (error) {
      if (messages.length <= appended.length) throw error
      messages.shift()
    }
  }
  return Object.freeze({
    ...record,
    updatedAt,
    turnCount: record.turnCount + 1,
    state
  })
}

export class AgentService {
  readonly conversations: ConversationSessionPort
  readonly #sessions: SessionStore<AgentSessionState>
  readonly #admission: Pick<RunAdmission, 'acquire' | 'recover'>
  readonly #contextEngine: ContextEngine
  readonly #progressPresenter: RunProgressPresenter
  readonly #createRuntime: AgentServiceOptions['createRuntime']
  readonly #recoverRuntime?: AgentServiceOptions['recoverRuntime']
  readonly #now: () => Date
  readonly #generateId: () => string
  readonly #createRunRef: () => string
  readonly #observationLevel?: () => unknown
  readonly #monotonicNow: () => number | 'unavailable'
  readonly #onTerminalSnapshot?: AgentServiceOptions['onTerminalSnapshot']
  readonly #onTerminalCommitReceipt?: AgentServiceOptions['onTerminalCommitReceipt']
  readonly #onObserverFailure?: AgentServiceOptions['onObserverFailure']
  readonly #engine: RunEngine
  readonly #pending = new Map<string, PendingRun>()
  readonly #lifecycleController = new AbortController()
  #shutdownReason = 'process_shutdown'
  #shutdownPromise: Promise<number> | undefined
  #observerFailureReported = false

  constructor (options: AgentServiceOptions) {
    this.#sessions = options.sessions
    this.#admission = options.admission
    this.#contextEngine = options.contextEngine
    this.#progressPresenter = options.progressPresenter
    this.#createRuntime = options.createRuntime
    this.#recoverRuntime = options.recoverRuntime
    this.#now = options.now ?? (() => new Date())
    this.#generateId = options.generateId ?? randomUUID
    this.#createRunRef = options.createRunRef ?? createRunRef
    this.#observationLevel = options.observationLevel
    this.#monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()))
    this.#onTerminalSnapshot = options.onTerminalSnapshot
    this.#onTerminalCommitReceipt = options.onTerminalCommitReceipt
    this.#onObserverFailure = options.onObserverFailure
    this.#engine = options.createEngine(event => {
      try {
        this.#progressPresenter.handle(event)
      } catch {
        this.#reportObserverFailure()
      }
    })
    this.conversations = Object.freeze({
      get: (address: SessionAddress, storageOptions?: AbortOptions) => (
        this.#sessions.get(address, storageOptions)
      ),
      list: (query: { readonly botId: string }, storageOptions?: ListOptions) => (
        this.#sessions.list(query, storageOptions)
      ),
      delete: (address: SessionAddress, storageOptions?: AbortOptions) => (
        this.#sessions.delete(address, storageOptions)
      ),
      deleteAll: (query: { readonly botId: string }, storageOptions?: AbortOptions) => (
        this.#sessions.deleteAll(query, storageOptions)
      ),
      fork: (
        source: SessionAddress,
        target: SessionAddress,
        startedBy: SessionRecord<AgentSessionState>['startedBy'],
        storageOptions?: SaveOptions
      ) => this.#sessions.fork(source, target, startedBy, storageOptions)
    })
  }

  async handle (
    request: YunzaiAgentRequestDraft,
    options: AgentServiceRequestOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#start(request, false, options)
  }

  async handleEphemeral (
    request: YunzaiAgentRequestDraft,
    options: AgentServiceRequestOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#start(request, true, options)
  }

  async resume (
    runId: string,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope | ApprovalRecoveryDeferred | null> {
    const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal)
    let pending: PendingRun | ApprovalRecoveryDeferred | null | undefined = this.#pending.get(runId)
    try {
      if (pending === undefined) {
        pending = await this.#recoverPending(runId, linked.signal)
      }
      if (pending === null || isApprovalRecoveryDeferred(pending)) return pending
      if (linked.signal.aborted) {
        return await this.cancel(runId, linked.signal.reason)
      }
      const result = await this.#engine.resume(runId, pending.binding, {
        ...options,
        signal: linked.signal
      })
      return await this.#finish(pending, result)
    } catch (error) {
      if (linked.signal.aborted) {
        return await this.cancel(runId, linked.signal.reason)
      }
      if (pending === undefined) throw error
      if (pending === null || isApprovalRecoveryDeferred(pending)) return pending
      return await this.#abortPending(pending, error)
    } finally {
      linked.dispose()
    }
  }

  async cancel (
    runId: string,
    reason = 'user_cancelled'
  ): Promise<ChatReplyEnvelope | null> {
    const pending = this.#pending.get(runId)
    if (pending === undefined) return null
    try {
      const result = await this.#engine.cancel(runId, reason)
      return await this.#finish(pending, result)
    } catch (error) {
      this.#pending.delete(runId)
      await this.#progressPresenter.drain(runId).catch(() => undefined)
      this.#progressPresenter.detach(runId)
      await pending.lease.release().catch(() => undefined)
      return activeFinalEnvelope(
        failedRunResult(runId, error, pending.request?.runRef ?? pending.requestObservationContext.runRef),
        pending.requestObservationContext,
        'not_attempted',
        'not_attempted'
      )
    }
  }

  shutdown (reason = 'process_shutdown'): Promise<number> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise
    this.#shutdownReason = cancellationReason(reason, 'process_shutdown')
    this.#lifecycleController.abort(this.#shutdownReason)
    const runIds = Object.freeze([...this.#pending.keys()])
    this.#shutdownPromise = Promise.all(
      runIds.map(async runId => await this.cancel(runId, this.#shutdownReason))
    ).then(() => runIds.length)
    return this.#shutdownPromise
  }

  async pendingApproval (
    runId: string,
    approvalId: string
  ): Promise<ApprovalInterruption | null> {
    return await this.#engine.pendingApproval(runId, approvalId)
  }

  async displayApproval (
    input: RunApprovalDisplayCommand
  ): Promise<ApprovalInterruption | null> {
    return await this.#engine.displayApproval(input)
  }

  async decideApproval (
    input: RunApprovalDecisionCommand,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope | ApprovalRecoveryDeferred | null> {
    const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal)
    let pending: PendingRun | ApprovalRecoveryDeferred | null | undefined = this.#pending.get(input.runId)
    try {
      if (pending === undefined) {
        pending = await this.#recoverPending(input.runId, linked.signal)
      }
      if (pending === null || isApprovalRecoveryDeferred(pending)) return pending
      if (linked.signal.aborted) {
        return await this.cancel(input.runId, linked.signal.reason)
      }
      const result = await this.#engine.decideApproval(
        input,
        pending.binding,
        { ...options, signal: linked.signal }
      )
      if (result === null) return null
      return await this.#finish(pending, result)
    } finally {
      linked.dispose()
    }
  }

  async #start (
    draft: YunzaiAgentRequestDraft,
    ephemeral: boolean,
    options: AgentServiceRequestOptions
  ): Promise<ChatReplyEnvelope> {
    const runId = this.#generateId()
    const startedAtMonotonicMs = options.requestObservationContext?.startedAtMonotonicMs ??
      readMonotonic(this.#monotonicNow)
    const requestObservationContext = beginRequestObservation({
      requestRef: draft.requestRef,
      requestKind: draft.requestKind,
      startedAtMonotonicMs
    })
    if (draft.requestKind !== (ephemeral ? 'proactive_chat' : 'ordinary_chat') ||
      (options.requestObservationContext !== undefined &&
        (options.requestObservationContext.requestRef !== draft.requestRef ||
          options.requestObservationContext.requestKind !== draft.requestKind))) {
      return preCreateEnvelope(
        failedRunResult(runId, new AgentError({
          code: 'invalid_request',
          stage: 'agent.service.observation',
          retryable: false,
          userMessage: '请求格式不正确，请联系机器人主人。'
        })),
        requestObservationContext,
        'failed_request_validation',
        'not_applicable',
        'not_attempted',
        'not_attempted'
      )
    }
    const levelAtStart = safeObservationLevel(this.#observationLevel)
    let runRef = this.#createRunRef()
    let request = freezeRequest(draft, runRef)
    const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal)
    let lease: RunLease | undefined
    const queueStarted = readMonotonic(this.#monotonicNow)
    let queueDurationMs: number | 'unavailable' = 'unavailable'
    let sessionLoadDurationMs: number | 'unavailable' | 'not_attempted' = 'not_attempted'
    try {
      try {
        lease = await this.#admission.acquire(request.sessionAddress, linked.signal)
        queueDurationMs = elapsed(
          queueStarted,
          readMonotonic(this.#monotonicNow)
        )
      } catch (error) {
        queueDurationMs = elapsed(
          queueStarted,
          readMonotonic(this.#monotonicNow)
        )
        const reason: AdmissionRejectionReason = error instanceof RunAdmissionRejectionError
          ? error.rejectionReason
          : 'unavailable'
        const result = error instanceof RunAdmissionRejectionError &&
          error.rejectionReason === 'queue_aborted'
          ? cancelledRunResult(
              runId,
              linked.signal.reason ?? this.#shutdownReason,
              'unavailable'
            )
          : failedRunResult(runId, error)
        return preCreateEnvelope(
          result,
          requestObservationContext,
          'rejected_admission',
          reason,
          queueDurationMs,
          'not_attempted'
        )
      }
      const timestamp = this.#now().toISOString()
      let session: SessionRecord<AgentSessionState> | null
      if (ephemeral) {
        session = null
      } else {
        const sessionLoadStarted = readMonotonic(this.#monotonicNow)
        try {
          session = await this.#sessions.get(
            request.sessionAddress,
            { signal: linked.signal }
          ) ?? freshSession(request, this.#generateId(), timestamp)
          sessionLoadDurationMs = elapsed(
            sessionLoadStarted,
            readMonotonic(this.#monotonicNow)
          )
        } catch (error) {
          sessionLoadDurationMs = elapsed(
            sessionLoadStarted,
            readMonotonic(this.#monotonicNow)
          )
          await lease.release().catch(() => undefined)
          lease = undefined
          const result = linked.signal.aborted
            ? cancelledRunResult(runId, linked.signal.reason ?? this.#shutdownReason)
            : failedRunResult(runId, error)
          return preCreateEnvelope(
            result,
            requestObservationContext,
            'failed_session_load',
            'not_applicable',
            queueDurationMs,
            sessionLoadDurationMs
          )
        }
      }
      if (linked.signal.aborted) throw new Error('run start was cancelled')
      const runtime = await this.#createRuntime(request)
      if (linked.signal.aborted) throw new Error('run start was cancelled')
      const sessionId = session?.sessionId ?? this.#generateId()
      let binding = this.#bindingFor(runId, request, session, runtime)
      this.#progressPresenter.attach(runId, runtime.progress ?? (async () => undefined))
      let result: RunAdvanceResult | undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const observationPolicy = createFrozenObservationPolicy({
          levelAtStart,
          runRef
        })
        try {
          result = await this.#engine.start({
            runId,
            runRef,
            requestRef: request.requestRef,
            requestKind: request.requestKind,
            presentationRoute: request.presentationRoute,
            observationPolicy,
            sessionId,
            sessionAddress: request.sessionAddress,
            deadlineAt: request.deadlineAt,
            model: request.model,
            runtime: binding
          }, { signal: linked.signal })
          break
        } catch (error) {
          if (!(error instanceof RunReferenceConflictError) || attempt !== 0) throw error
          runRef = this.#createRunRef()
          request = freezeRequest(draft, runRef)
          binding = this.#bindingFor(runId, request, session, runtime)
        }
      }
      if (result === undefined) throw new RunReferenceConflictError()
      if (result.runRef === 'unavailable') {
        await lease.release().catch(() => undefined)
        lease = undefined
        this.#progressPresenter.detach(runId)
        if (result.kind === 'paused' || result.kind === 'completed') {
          throw new TypeError('run result lacks a claimed reference')
        }
        return preCreateEnvelope(
          result,
          requestObservationContext,
          'failed_run_create',
          'not_applicable',
          queueDurationMs,
          sessionLoadDurationMs
        )
      }
      const activeContext = activateRequestObservation({
        context: requestObservationContext,
        runRef: result.runRef,
        queueDurationMs,
        sessionLoadDurationMs
      })
      const pending: PendingRun = Object.freeze({
        runId,
        request,
        session,
        binding,
        lease,
        ephemeral,
        requestObservationContext: activeContext
      })
      this.#pending.set(runId, pending)
      return await this.#finish(pending, result)
    } catch (error) {
      if (this.#pending.has(runId)) {
        await this.#engine.cancel(runId, 'service_failure').catch(() => undefined)
      }
      if (lease !== undefined) {
        await lease.release().catch(() => undefined)
      }
      this.#pending.delete(runId)
      this.#progressPresenter.detach(runId)
      const result = linked.signal.aborted
        ? cancelledRunResult(runId, linked.signal.reason ?? this.#shutdownReason)
        : failedRunResult(runId, error)
      return preCreateEnvelope(
        result,
        requestObservationContext,
        'failed_run_create',
        'not_applicable',
        queueDurationMs,
        sessionLoadDurationMs
      )
    } finally {
      linked.dispose()
    }
  }

  #bindingFor (
    runId: string,
    request: YunzaiAgentRequest,
    session: SessionRecord<AgentSessionState> | null,
    runtime: AgentServiceRunRuntime
  ): RunRuntimeBinding {
    const prepare = async (dropOptional: boolean, signal: AbortSignal) => {
      const systemInstructions = Object.freeze(request.systemInstructions.map((value, index) => (
        systemItem(runId, value, index, request.createdAt)
      )))
      const currentRequest: ContextItem = Object.freeze({
        id: `current:${request.message.id}`,
        source: 'current_request',
        message: request.message
      })
      const runtimeFacts = Object.freeze([...(runtime.runtimeFacts ?? EMPTY_ITEMS)])
      const history = dropOptional || session === null
        ? EMPTY_ITEMS
        : sessionItems(session.state.messages)
      const groupContext = dropOptional
        ? EMPTY_ITEMS
        : Object.freeze([...(runtime.groupContext ?? EMPTY_ITEMS)])
      const bounded = boundedOptionalContext(
        Object.freeze([...systemInstructions, currentRequest]),
        runtimeFacts,
        history,
        groupContext,
        request.contextBudget
      )
      const snapshot = await this.#contextEngine.prepare({
        systemInstructions,
        runtimeFacts: bounded.runtimeFacts,
        sessionHistory: bounded.sessionHistory,
        groupContext: bounded.groupContext,
        currentRequest,
        toolMessages: EMPTY_ITEMS
      }, request.contextBudget, signal)
      return Object.freeze({
        messages: coalesceModelMessages(
          currentRunItemOrder(snapshot.items).map(modelMessageFor)
        ),
        estimatedInputTokens: snapshot.estimatedInputTokens
      })
    }
    return Object.freeze({
      snapshot: runtime.binding.snapshot,
      prepareContext: async (signal: AbortSignal) => await prepare(false, signal),
      recoverContext: async (
        _checkpoint: RunCheckpoint,
        _error: ModelProviderError,
        signal: AbortSignal
      ) => await prepare(true, signal),
      prepareToolContext: runtime.binding.prepareToolContext,
      contextFor: runtime.binding.contextFor,
      ...(runtime.binding.approvalControlContext === undefined
        ? {}
        : { approvalControlContext: runtime.binding.approvalControlContext })
    })
  }

  async #recoverPending (
    runId: string,
    signal?: AbortSignal
  ): Promise<PendingRun | ApprovalRecoveryDeferred | null> {
    const checkpoint = await this.#engine.loadCheckpoint(runId)
    if (checkpoint === null) return null
    if (isTerminalRunStatus(checkpoint.status)) return null
    if (this.#recoverRuntime === undefined) {
      throw new AgentError({
        code: 'checkpoint_invalid',
        stage: 'agent.service.recovery',
        retryable: false,
        userMessage: '任务运行环境已失效，请重新发起。'
      })
    }
    let lease: RunLease
    try {
      lease = await this.#admission.recover(checkpoint, signal)
    } catch (error) {
      const reason = error instanceof RunAdmissionRejectionError
        ? error.rejectionReason
        : 'unavailable'
      return Object.freeze({
        kind: 'approval_deferred',
        reason,
        retryable: true,
        runRef: checkpoint.runRef,
        requestRef: checkpoint.requestRef
      })
    }
    try {
      const runtime = await this.#recoverRuntime(checkpoint)
      const binding: RunRuntimeBinding = Object.freeze({
        snapshot: runtime.binding.snapshot,
        prepareContext: async () => Object.freeze({
          messages: checkpoint.messages,
          estimatedInputTokens: checkpoint.estimatedInputTokens
        }),
        recoverContext: async () => undefined,
        prepareToolContext: runtime.binding.prepareToolContext,
        contextFor: runtime.binding.contextFor,
        ...(runtime.binding.approvalControlContext === undefined
          ? {}
          : { approvalControlContext: runtime.binding.approvalControlContext })
      })
      const pending: PendingRun = Object.freeze({
        runId,
        request: null,
        session: null,
        binding,
        lease,
        // A restarted process cannot recreate the canonical QQ message without
        // inventing provenance, so recovery must not mutate chat history.
        ephemeral: true,
        requestObservationContext: activateRequestObservation({
          context: beginRequestObservation({
            requestRef: checkpoint.requestRef,
            requestKind: checkpoint.requestKind,
            startedAtMonotonicMs: 'unavailable'
          }),
          runRef: checkpoint.runRef,
          queueDurationMs: 'unavailable',
          sessionLoadDurationMs: checkpoint.requestKind === 'proactive_chat'
            ? 'not_attempted'
            : 'unavailable'
        })
      })
      this.#pending.set(runId, pending)
      this.#progressPresenter.attach(
        runId,
        runtime.progress ?? (async () => undefined),
        checkpoint.events
      )
      return pending
    } catch (error) {
      await lease.release().catch(() => undefined)
      throw error
    }
  }

  async #finish (
    pending: PendingRun,
    result: RunAdvanceResult
  ): Promise<ChatReplyEnvelope> {
    if (result.kind === 'paused') {
      await this.#progressPresenter.drain(pending.runId)
      return Object.freeze({
        ...result,
        requestObservationContext: pending.requestObservationContext
      })
    }
    if (result.terminal !== null) {
      try {
        this.#onTerminalSnapshot?.(result.terminal.snapshot)
      } catch {
        this.#reportObserverFailure()
      }
      try {
        this.#onTerminalCommitReceipt?.(result.terminal.receipt)
      } catch {
        this.#reportObserverFailure()
      }
    }
    await this.#progressPresenter.drain(pending.runId)
    let sessionPersistence: SessionPersistenceOutcome = 'not_attempted'
    let sessionSaveDurationMs: number | 'unavailable' | 'not_attempted' = 'not_attempted'
    try {
      if (!pending.ephemeral && pending.session !== null && pending.request !== null &&
        result.kind === 'completed') {
        const sessionSaveStarted = readMonotonic(this.#monotonicNow)
        try {
          const next = appendTerminalTurn(
            pending.session,
            pending.request,
            result,
            this.#now().toISOString()
          )
          await this.#sessions.save(next, {
            signal: undefined,
            ...(pending.request.sessionTtlSeconds === undefined
              ? {}
              : { ttlSeconds: pending.request.sessionTtlSeconds })
          })
          sessionPersistence = 'saved'
        } catch {
          sessionPersistence = 'failed'
          this.#reportObserverFailure()
        } finally {
          sessionSaveDurationMs = elapsed(
            sessionSaveStarted,
            readMonotonic(this.#monotonicNow)
          )
        }
      }
    } finally {
      this.#pending.delete(pending.runId)
      this.#progressPresenter.detach(pending.runId)
      await pending.lease.release().catch(() => undefined)
    }
    return activeFinalEnvelope(
      result,
      pending.requestObservationContext,
      sessionPersistence,
      sessionSaveDurationMs
    )
  }

  async #abortPending (
    pending: PendingRun,
    error: unknown
  ): Promise<ChatReplyEnvelope> {
    let cancelled: RunAdvanceResult | null = null
    try {
      cancelled = await this.#engine.cancel(pending.runId, 'service_failure')
    } catch {
      // A terminal-null safe failure below is the only valid fallback.
    }
    if (cancelled !== null && cancelled.kind !== 'paused' && cancelled.terminal !== null) {
      return await this.#finish(pending, cancelled)
    }
    this.#pending.delete(pending.runId)
    await this.#progressPresenter.drain(pending.runId)
    this.#progressPresenter.detach(pending.runId)
    await pending.lease.release().catch(() => undefined)
    return activeFinalEnvelope(
      failedRunResult(
        pending.runId,
        error,
        pending.request?.runRef ?? pending.requestObservationContext.runRef
      ),
      pending.requestObservationContext,
      'not_attempted',
      'not_attempted'
    )
  }

  #reportObserverFailure (): void {
    if (this.#observerFailureReported) return
    this.#observerFailureReported = true
    try {
      this.#onObserverFailure?.(Object.freeze({ event: 'agent.observer_failed' }))
    } catch {
      // Observability remains outside the run control plane.
    }
  }
}
