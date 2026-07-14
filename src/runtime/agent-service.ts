import { randomUUID } from 'node:crypto'
import {
  AgentError,
  serializeAgentError
} from '../agent/contracts/error.js'
import type { AgentEvent } from '../agent/contracts/event.js'
import type { AgentContentPart, AgentMessage } from '../agent/contracts/content.js'
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
import type { RunAdmission, RunLease } from '../agent/run/run-admission.js'
import type { RunStore } from '../agent/run/run-store.js'
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
import {
  createAgentRunLog
} from './safe-chat-logging.js'
import {
  RunProgressPresenter,
  type ProgressDelivery
} from './run-progress-presenter.js'
import type { YunzaiAgentRequest } from './yunzai-request-adapter.js'

export type ChatReplyEnvelope =
  | Readonly<{
      kind: 'completed'
      runId: string
      output: Extract<RunAdvanceResult, { readonly kind: 'completed' }>['output']
      visibleOutput: boolean
      text: string | null
    }>
  | Extract<RunAdvanceResult, { readonly kind: 'paused' | 'failed' | 'cancelled' }>

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
  readonly onRunLog?: (entry: ReturnType<typeof createAgentRunLog>) => void
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

function failedEnvelope (runId: string, error: unknown): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'failed',
    runId,
    error: serializeAgentError(asAgentError(error))
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
  request: YunzaiAgentRequest,
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

function terminalEnvelope (result: RunAdvanceResult): ChatReplyEnvelope {
  if (result.kind !== 'completed') return result
  return Object.freeze({
    ...result,
    text: result.output === null ? null : messageText(result.output)
  })
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
  readonly #runStore: RunStore
  readonly #admission: Pick<RunAdmission, 'acquire' | 'recover'>
  readonly #contextEngine: ContextEngine
  readonly #progressPresenter: RunProgressPresenter
  readonly #createRuntime: AgentServiceOptions['createRuntime']
  readonly #recoverRuntime?: AgentServiceOptions['recoverRuntime']
  readonly #now: () => Date
  readonly #generateId: () => string
  readonly #onRunLog?: AgentServiceOptions['onRunLog']
  readonly #onObserverFailure?: AgentServiceOptions['onObserverFailure']
  readonly #engine: RunEngine
  readonly #pending = new Map<string, PendingRun>()
  #observerFailureReported = false

  constructor (options: AgentServiceOptions) {
    this.#sessions = options.sessions
    this.#runStore = options.runStore
    this.#admission = options.admission
    this.#contextEngine = options.contextEngine
    this.#progressPresenter = options.progressPresenter
    this.#createRuntime = options.createRuntime
    this.#recoverRuntime = options.recoverRuntime
    this.#now = options.now ?? (() => new Date())
    this.#generateId = options.generateId ?? randomUUID
    this.#onRunLog = options.onRunLog
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
    request: YunzaiAgentRequest,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#start(request, false, options)
  }

  async handleEphemeral (
    request: YunzaiAgentRequest,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#start(request, true, options)
  }

  async resume (
    runId: string,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    let pending: PendingRun | null | undefined = this.#pending.get(runId)
    if (pending === undefined) {
      try {
        pending = await this.#recoverPending(runId, options.signal)
      } catch (error) {
        return failedEnvelope(runId, error)
      }
    }
    if (pending === null) return terminalEnvelope(await this.#engine.resume(runId, undefined, options))
    try {
      const result = await this.#engine.resume(runId, pending.binding, options)
      return await this.#finish(pending, result)
    } catch (error) {
      return await this.#abortPending(pending, failedEnvelope(runId, error))
    }
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
  ): Promise<ChatReplyEnvelope | null> {
    let pending: PendingRun | null | undefined = this.#pending.get(input.runId)
    if (pending === undefined) {
      try {
        pending = await this.#recoverPending(input.runId, options.signal)
      } catch {
        return null
      }
    }
    const result = await this.#engine.decideApproval(
      input,
      pending?.binding,
      options
    )
    if (result === null) return null
    return pending === null ? terminalEnvelope(result) : await this.#finish(pending, result)
  }

  async #start (
    request: YunzaiAgentRequest,
    ephemeral: boolean,
    options: RunControlOptions
  ): Promise<ChatReplyEnvelope> {
    const runId = this.#generateId()
    let lease: RunLease | undefined
    try {
      lease = await this.#admission.acquire(request.sessionAddress, options.signal)
      const timestamp = this.#now().toISOString()
      const session = ephemeral
        ? null
        : await this.#sessions.get(request.sessionAddress, { signal: options.signal }) ??
          freshSession(request, this.#generateId(), timestamp)
      const runtime = await this.#createRuntime(request)
      const sessionId = session?.sessionId ?? this.#generateId()
      const binding = this.#bindingFor(runId, request, session, runtime)
      const pending: PendingRun = Object.freeze({
        runId,
        request,
        session,
        binding,
        lease,
        ephemeral
      })
      this.#pending.set(runId, pending)
      this.#progressPresenter.attach(runId, runtime.progress ?? (async () => undefined))
      const result = await this.#engine.start({
        runId,
        sessionId,
        sessionAddress: request.sessionAddress,
        deadlineAt: request.deadlineAt,
        model: request.model,
        runtime: binding
      }, options)
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
      return failedEnvelope(runId, error)
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
        messages: Object.freeze(snapshot.items.map(modelMessageFor)),
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
  ): Promise<PendingRun | null> {
    const checkpoint = await this.#runStore.load(runId)
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
    const lease = await this.#admission.recover(checkpoint, signal)
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
        ephemeral: true
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
    await this.#progressPresenter.drain(pending.runId)
    if (result.kind === 'paused') return result
    let envelope = terminalEnvelope(result)
    try {
      if (!pending.ephemeral && pending.session !== null && pending.request !== null &&
        result.kind === 'completed') {
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
      }
      this.#recordRun(result)
    } catch (error) {
      envelope = failedEnvelope(pending.runId, error)
    } finally {
      this.#pending.delete(pending.runId)
      this.#progressPresenter.detach(pending.runId)
      await pending.lease.release().catch(() => undefined)
    }
    return envelope
  }

  async #abortPending (
    pending: PendingRun,
    envelope: ChatReplyEnvelope
  ): Promise<ChatReplyEnvelope> {
    this.#pending.delete(pending.runId)
    await this.#engine.cancel(pending.runId, 'service_failure').catch(() => undefined)
    await this.#progressPresenter.drain(pending.runId)
    this.#progressPresenter.detach(pending.runId)
    await pending.lease.release().catch(() => undefined)
    return envelope
  }

  #recordRun (result: RunAdvanceResult): void {
    if (this.#onRunLog === undefined) return
    void this.#runStore.load(result.runId).then(checkpoint => {
      const counters = checkpoint?.budgetCounters
      try {
        this.#onRunLog?.(createAgentRunLog({
          runId: result.runId,
          fromStatus: 'active',
          toStatus: result.kind,
          modelTurns: counters?.modelTurns,
          toolCalls: counters?.toolCalls,
          usedActiveRuntimeMs: counters?.usedActiveRuntimeMs,
          providerAttempts: counters === undefined
            ? undefined
            : counters.modelTurns + counters.providerRetries,
          recoveryAttempts: counters?.recoveryAttempts,
          correctionAttempts: counters?.correctionTurns,
          errorCode: result.kind === 'failed' ? result.error.code : undefined
        }))
      } catch {
        this.#reportObserverFailure()
      }
    }).catch(() => this.#reportObserverFailure())
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
