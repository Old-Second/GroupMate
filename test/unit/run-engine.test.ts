import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { AgentEvent } from '../../src/agent/contracts/event.js'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { ModelProviderError } from '../../src/agent/model/model-adapter.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import type {
  RunContentJournal,
  RunContentJournalEvent
} from '../../src/agent/run/run-content-journal.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  parseRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  RunEngine,
  type RunEngineOptions,
  type StartRunInput
} from '../../src/agent/run/run-engine.js'
import { createRunTerminalSnapshot } from '../../src/agent/run/run-observation.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import type { TraceCandidateV1 } from '../../src/agent/run/run-trace.js'
import {
  RunReferenceConflictError,
  RunStoreConflictError,
  type RunStore
} from '../../src/agent/run/run-store.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import type { ToolDefinition } from '../../src/agent/tools/tool-definition.js'
import {
  completedPreparedCall,
  type PreparedToolCall,
  type SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import { ToolRegistry, type ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'
import { FIXTURE_MODEL_CAPABILITY } from '../helpers/trace-fixture.js'

const timestamp = '2026-07-14T00:00:00.000Z'
const deadlineAt = '2026-07-14T00:04:00.000Z'
const schema = Object.freeze({
  type: 'object' as const,
  properties: Object.freeze({ value: Object.freeze({ type: 'string' as const }) }),
  required: Object.freeze(['value']),
  additionalProperties: false as const
})

const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-1',
  actor: Object.freeze({ userId: 'actor-1', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' }),
  botGroupRole: 'owner', actorGroupRole: 'owner', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
})
const intent = Object.freeze({
  trustedSources: Object.freeze(['current_request'] as const),
  actions: Object.freeze([]), explicitTargetIds: Object.freeze([]),
  mentionUserIds: Object.freeze([]), currentMessageId: 'message-current',
  replyMessageId: null
})

type ProviderJournalEvent = Exclude<
  RunContentJournalEvent,
  { readonly type: 'run.terminal_committed' }
>

function isProviderJournalEvent (
  event: RunContentJournalEvent
): event is ProviderJournalEvent {
  return event.type !== 'run.terminal_committed'
}

function success (text: string, effect: 'none' | 'background' | 'visible' = 'none'): ToolResult {
  return Object.freeze({
    status: 'success', effect,
    content: Object.freeze([{ type: 'text' as const, text }]),
    retryable: false
  })
}

function denied (text = '没有权限。'): ToolResult {
  return Object.freeze({
    status: 'denied', effect: 'none', reasonCode: 'permission_denied',
    userMessage: text, retryable: false
  })
}

function failed (text = '工具执行失败。'): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
    userMessage: text, retryable: false
  })
}

function retryableFailure (): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
    userMessage: '上游暂时不可用。', retryable: true
  })
}

function toolCall (
  index: number,
  callId: string,
  name: string,
  value = name
): ModelTurn['toolCalls'][number] {
  return Object.freeze({
    index, callId, name,
    argumentsText: JSON.stringify({ value }),
    arguments: Object.freeze({ value })
  })
}

function modelText (text: string, reasoning?: string): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([]),
    finishReason: 'stop',
    ...(reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ text: reasoning, truncated: false }) })
  })
}

function modelTools (
  calls: readonly ModelTurn['toolCalls'][number][],
  text = '内部过程正文',
  reasoning?: string
): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([...calls]),
    finishReason: 'tool_calls',
    ...(reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ text: reasoning, truncated: false }) })
  })
}

function deepSeekModelTools (
  calls: readonly ModelTurn['toolCalls'][number][],
  reasoning: string
): ModelTurn {
  return Object.freeze({
    ...modelTools(calls, '', reasoning),
    providerState: Object.freeze({
      profileId: deepSeekCompatibilityProfile.id,
      profileVersion: deepSeekCompatibilityProfile.version,
      payload: Object.freeze({ reasoningContent: reasoning })
    })
  })
}

type ScriptedItem = ModelTurn | Error | ((request: ModelRequest, signal: AbortSignal) => Promise<ModelTurn>)

class ScriptedAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  readonly #items: ScriptedItem[]

  constructor (items: readonly ScriptedItem[]) {
    this.#items = [...items]
  }

  async complete (request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    this.requests.push(request)
    const item = this.#items.shift()
    if (item === undefined) throw new Error('script exhausted')
    if (item instanceof Error) throw item
    return typeof item === 'function' ? await item(request, signal) : item
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T> (): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined
  const promise = new Promise<T>(resolve => { resolveValue = resolve })
  return Object.freeze({
    promise,
    resolve: (value: T) => {
      if (resolveValue === undefined) throw new Error('deferred is unavailable')
      resolveValue(value)
    }
  })
}

function sequenceClock (...values: number[]): () => number {
  const remaining = [...values]
  return () => {
    const value = remaining.shift()
    if (value === undefined) throw new Error('monotonic clock script exhausted')
    return value
  }
}

function incrementalWallClock (): Readonly<{
  now: () => Date
  reads: () => number
}> {
  let reads = 0
  return Object.freeze({
    now: () => new Date(new Date(timestamp).getTime() + reads++),
    reads: () => reads
  })
}

class ActivityOrderStore extends InMemoryRunStore {
  readonly order: string[] = []

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const stored = await super.compareAndSet(expected, next)
    if (expected.engineActivity.state === 'idle' &&
      next.engineActivity.state === 'reserved') {
      this.order.push('engine_reserved')
    }
    return stored
  }
}

class TerminalCaptureStore extends InMemoryRunStore {
  terminalCheckpoint: RunCheckpoint | null = null

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    this.terminalCheckpoint = next
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class TraceProjectionFailureStore extends InMemoryRunStore {
  override async create (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    const first = checkpoint.events[0]
    if (first === undefined) throw new TypeError('initial event is missing')
    const incompatible = parseRunCheckpoint({
      ...checkpoint,
      events: Object.freeze([
        Object.freeze({ ...first, type: 'run.started' as const }),
        ...checkpoint.events.slice(1)
      ])
    })
    return await super.create(incompatible)
  }
}

class TraceProjectionTerminalRaceStore extends TraceProjectionFailureStore {
  override async commitTerminal (
    expected: RunCheckpoint,
    _next: RunCheckpoint,
    _snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    const terminal = nextRunCheckpoint(expected, 'cancelled', {
      modelTurn: null,
      preparedBatch: null,
      interruption: null,
      providerDispatch: Object.freeze({ state: 'idle' }),
      engineActivity: Object.freeze({ state: 'idle' }),
      cancellationReason: 'concurrent_terminal'
    }, [], timestamp)
    await super.commitTerminal(
      expected,
      terminal,
      createRunTerminalSnapshot(terminal)
    )
    throw new RunStoreConflictError()
  }
}

class SimulatedProcessCrash extends Error {}

class RetryReservationCrashStore extends InMemoryRunStore {
  #offline = false

  restoreProcess (): void {
    this.#offline = false
  }

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (this.#offline) throw new SimulatedProcessCrash()
    const stored = await super.compareAndSet(expected, next)
    if (next.budgetCounters.providerRetries >
      expected.budgetCounters.providerRetries) {
      this.#offline = true
      throw new SimulatedProcessCrash()
    }
    return stored
  }

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    if (this.#offline) throw new SimulatedProcessCrash()
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class RecoveryCommitCrashStore extends InMemoryRunStore {
  #offline = false

  restoreProcess (): void {
    this.#offline = false
  }

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (this.#offline) throw new SimulatedProcessCrash()
    const stored = await super.compareAndSet(expected, next)
    if (!expected.recoveryUsed && next.recoveryUsed) {
      this.#offline = true
      throw new SimulatedProcessCrash()
    }
    return stored
  }

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    if (this.#offline) throw new SimulatedProcessCrash()
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class PreSuccessCasCrashStore extends TerminalCaptureStore {
  crashed = false
  readonly crash = new SimulatedProcessCrash()

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const commitsSuccessfulTurn = expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle' &&
      next.events.slice(expected.events.length).some(event => event.type === 'model.completed')
    if (!this.crashed && commitsSuccessfulTurn) {
      this.crashed = true
      throw this.crash
    }
    return await super.compareAndSet(expected, next)
  }

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    if (!this.crashed && expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle') {
      this.crashed = true
      throw this.crash
    }
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class PostSuccessCasCrashStore extends TerminalCaptureStore {
  crashed = false
  readonly crash = new SimulatedProcessCrash()

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const stored = await super.compareAndSet(expected, next)
    if (!this.crashed && expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle' && next.status === 'evaluating_tools') {
      this.crashed = true
      throw this.crash
    }
    return stored
  }
}

class SentinelStoreError extends Error {}

class SuccessCommitSentinelStore extends TerminalCaptureStore {
  readonly sentinel = new SentinelStoreError('success store sentinel')

  constructor (readonly phase: 'compareAndSet' | 'commitTerminal') {
    super()
  }

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (this.phase === 'compareAndSet' &&
      expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle' &&
      next.events.slice(expected.events.length).some(event => event.type === 'model.completed')) {
      throw this.sentinel
    }
    return await super.compareAndSet(expected, next)
  }

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    if (this.phase === 'commitTerminal' &&
      expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle') {
      throw this.sentinel
    }
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class AbortNamedStoreError extends Error {
  constructor () {
    super('success store abort-named sentinel')
    this.name = 'AbortError'
  }
}

class SuccessCommitAbortNamedStore extends TerminalCaptureStore {
  readonly sentinel = new AbortNamedStoreError()
  thrown = false

  constructor (readonly phase: 'compareAndSet' | 'commitTerminal') {
    super()
  }

  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (!this.thrown && this.phase === 'compareAndSet' &&
      expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle' &&
      next.events.slice(expected.events.length).some(event => event.type === 'model.completed')) {
      this.thrown = true
      throw this.sentinel
    }
    return await super.compareAndSet(expected, next)
  }

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<RunStore['commitTerminal']>[2]
  ): Promise<Awaited<ReturnType<RunStore['commitTerminal']>>> {
    if (!this.thrown && this.phase === 'commitTerminal' &&
      expected.providerDispatch.state === 'reserved' &&
      next.providerDispatch.state === 'idle') {
      this.thrown = true
      throw this.sentinel
    }
    return await super.commitTerminal(expected, next, snapshot)
  }
}

class OverflowUsageReservationStore extends TerminalCaptureStore {
  override async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (expected.providerDispatch.state === 'idle' &&
      next.providerDispatch.state === 'reserved') {
      return await super.compareAndSet(expected, parseRunCheckpoint({
        ...next,
        usage: {
          schemaVersion: 1,
          availability: 'complete',
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          totalTokens: Number.MAX_SAFE_INTEGER,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          turnsWithUsage: 1,
          turnsWithoutUsage: 0,
          cacheUsageComplete: false
        }
      }))
    }
    return await super.compareAndSet(expected, next)
  }
}

function definition (name: string, executionClass: ToolDefinition['executionClass'] = 'read_only'): ToolDefinition {
  return Object.freeze({
    name, version: 1, aliases: Object.freeze([]), description: `${name} fixture`,
    inputSchema: schema,
    effect: executionClass === 'read_only' ? 'read_only' : executionClass,
    risk: executionClass === 'read_only' ? 'low' : 'high',
    readOnly: executionClass === 'read_only', destructive: false,
    idempotency: executionClass === 'read_only' ? 'none' : 'call',
    openWorld: false, timeoutMs: 1_000, maxOutputBytes: 4_096,
    network: 'none', permission: 'any_user', executionClass,
    retrySafe: executionClass === 'read_only',
    resourceKeys: (input: Readonly<Record<string, unknown>>) => Object.freeze([
      `fixture:${String(input.value).padEnd(24, '0').slice(0, 24)}`
    ]),
    resolveTarget: () => Object.freeze({ kind: 'none' as const }),
    execute: async () => success(name)
  })
}

class ScriptedToolRuntime implements ToolRuntime {
  preparations = 0
  executions = 0
  readonly outcomes = new Map<string, ToolResult>()
  readonly delays = new Map<string, number>()
  readonly deferredOutcomes = new Map<string, Deferred<ToolResult>>()
  readonly scriptedOutcomes = new Map<string, Array<ToolResult | Error>>()
  readonly approvalCalls = new Set<string>()
  readonly startedCalls: string[] = []
  onStarted?: (callId: string) => void

  async prepare (
    call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    this.preparations += 1
    if (call.requestedName === 'unknown') {
      return completedPreparedCall(call.callId, 'unknown', denied('该工具不可用。'))
    }
    const executionClass = call.requestedName === 'sideEffect'
      ? 'side_effect'
      : call.requestedName === 'visible' ? 'visible_output' : 'read_only'
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1,
      callId: call.callId,
      toolName: call.requestedName,
      toolVersion: 1,
      snapshotId: call.snapshotId,
      canonicalArguments: call.arguments as SerializablePreparedCapability['canonicalArguments'],
      argumentHash: `hash-${call.callId}`,
      target: Object.freeze({ kind: 'none' }),
      resourceKeys: Object.freeze([`fixture:${call.callId.padEnd(24, '0').slice(0, 24)}`]),
      executionClass,
      retrySafe: executionClass === 'read_only'
    })
    return this.approvalCalls.has(call.callId)
      ? Object.freeze({ kind: 'approval_required', capability, summaryCode: 'fixture_approval' })
      : Object.freeze({ kind: 'ready', capability })
  }

  async executePrepared (
    prepared: SerializablePreparedCapability,
    _context: ToolExecutionContext,
    _snapshot: ToolSnapshot,
    _signal: AbortSignal
  ): Promise<ToolResult> {
    this.executions += 1
    this.startedCalls.push(prepared.callId)
    this.onStarted?.(prepared.callId)
    const scripted = this.scriptedOutcomes.get(prepared.callId)
    const scriptedItem = scripted?.shift()
    if (scriptedItem instanceof Error) throw scriptedItem
    if (scriptedItem !== undefined) return scriptedItem
    const pending = this.deferredOutcomes.get(prepared.callId)
    if (pending !== undefined) return await pending.promise
    const delay = this.delays.get(prepared.callId) ?? 0
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    return this.outcomes.get(prepared.callId) ?? success(prepared.callId)
  }
}

const allDefinitions = Object.freeze([
  definition('fastRead'), definition('slowRead'), definition('normalRead'),
  definition('deniedRead'), definition('failedRead'), definition('unknown'),
  definition('visible', 'visible_output'), definition('sideEffect', 'side_effect')
])

function snapshot (): ToolSnapshot {
  return new ToolRegistry(allDefinitions).createSnapshot({
    id: 'snapshot-1', facts,
    enabledTools: allDefinitions.map(item => item.name)
  })
}

function preparation (): ToolPreparationContext {
  return Object.freeze({
    runId: 'run-1', profile: 'compatible', facts, intent, now: timestamp
  })
}

function execution (): ToolExecutionContext {
  return Object.freeze({ ...preparation() })
}

interface HarnessOptions {
  readonly profile?: typeof standardOpenAIProfile
  readonly maxOutputTokens?: number
  readonly prepareContext?: StartRunInput['runtime']['prepareContext']
  readonly recoverContext?: StartRunInput['runtime']['recoverContext']
  readonly contextFor?: StartRunInput['runtime']['contextFor']
  readonly now?: () => Date
  readonly store?: RunStore
  readonly monotonicNow?: () => number
  readonly toolMonotonicNow?: () => number
  readonly onCommittedTraceCandidate?: RunEngineOptions['onCommittedTraceCandidate']
  readonly onTraceCandidateProjectionFailure?: RunEngineOptions['onTraceCandidateProjectionFailure']
  readonly contentJournal?: RunContentJournal
}

function harness (
  items: readonly ScriptedItem[],
  options: HarnessOptions = {}
) {
  const maxOutputTokens = options.maxOutputTokens ?? 256
  const adapter = new ScriptedAdapter(items)
  const tools = new ScriptedToolRuntime()
  const store = options.store ?? new InMemoryRunStore()
  const events: string[] = []
  const observedEvents: AgentEvent[] = []
  let id = 0
  const engine = new RunEngine({
    adapter,
    profile: options.profile ?? standardOpenAIProfile,
    scheduler: new ToolScheduler({
      runtime: tools,
      ...(options.toolMonotonicNow === undefined
        ? {}
        : { monotonicNow: options.toolMonotonicNow })
    }),
    store,
    budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: maxOutputTokens }),
    now: options.now ?? (() => new Date(timestamp)),
    ...(options.monotonicNow === undefined
      ? {}
      : { monotonicNow: options.monotonicNow }),
    generateId: () => `generated-${++id}`,
    observer: event => {
      events.push(event.type)
      observedEvents.push(event)
    },
    ...(options.onCommittedTraceCandidate === undefined
      ? {}
      : { onCommittedTraceCandidate: options.onCommittedTraceCandidate }),
    ...(options.onTraceCandidateProjectionFailure === undefined
      ? {}
      : { onTraceCandidateProjectionFailure: options.onTraceCandidateProjectionFailure }),
    ...(options.contentJournal === undefined
      ? {}
      : { contentJournal: options.contentJournal })
  })
  const input: StartRunInput = Object.freeze({
    runId: 'run-1',
    runRef: '1'.repeat(32),
    requestRef: '2'.repeat(32),
    requestKind: 'ordinary_chat',
    sessionId: 'session-1',
    sessionAddress: Object.freeze({ botId: facts.botId, scope: facts.scope }),
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      }),
      sessionAddress: Object.freeze({ botId: facts.botId, scope: facts.scope }),
      actorId: 'actor-1',
      requestMessageId: 'message-current'
    }),
    observationPolicy: Object.freeze({
      schemaVersion: 1, levelAtStart: 'basic', sampledSuccess: false
    }),
    deadlineAt,
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens,
      reasoning: Object.freeze({ enabled: false })
    }),
    runtime: Object.freeze({
      snapshot: snapshot(),
      prepareContext: options.prepareContext ?? (async () => Object.freeze({
        messages: Object.freeze([{ role: 'user' as const, content: '完成任务' }]),
        estimatedInputTokens: 16
      })),
      prepareToolContext: async () => preparation(),
      contextFor: options.contextFor ?? (async () => execution()),
      ...(options.recoverContext === undefined ? {} : { recoverContext: options.recoverContext })
    })
  })
  return { adapter, tools, store, events, observedEvents, engine, input }
}

class TerminalRaceRunStore implements RunStore {
  readonly base = new InMemoryRunStore()
  injected = false
  readonly #phase: 'provider_reservation' | 'success_transition' | 'terminal_commit'

  constructor (phase: 'provider_reservation' | 'success_transition' | 'terminal_commit') {
    this.#phase = phase
  }

  create: RunStore['create'] = async checkpoint => await this.base.create(checkpoint)
  load: RunStore['load'] = async runId => await this.base.load(runId)
  upgrade: RunStore['upgrade'] = async (expected, next) => (
    await this.base.upgrade(expected, next)
  )

  compareAndSet: RunStore['compareAndSet'] = async (expected, next) => {
    const reservation = expected.status === 'calling_model' &&
      expected.providerDispatch.state === 'idle' &&
      next.status === expected.status &&
      next.providerDispatch.state === 'reserved'
    const successTransition = expected.status === 'calling_model' &&
      expected.providerDispatch.state === 'reserved' &&
      next.status === 'evaluating_tools' && next.providerDispatch.state === 'idle'
    const shouldInject = this.#phase === 'provider_reservation'
      ? reservation
      : successTransition
    if (!this.injected && shouldInject) {
      this.injected = true
      const terminal = nextRunCheckpoint(expected, 'cancelled', {
        modelTurn: null,
        preparedBatch: null,
        interruption: null,
        providerDispatch: Object.freeze({ state: 'idle' }),
        engineActivity: Object.freeze({ state: 'idle' }),
        cancellationReason: 'concurrent_terminal'
      }, [], timestamp)
      await this.base.commitTerminal(
        expected,
        terminal,
        createRunTerminalSnapshot(terminal)
      )
      throw new RunStoreConflictError()
    }
    return await this.base.compareAndSet(expected, next)
  }

  appendEvents: RunStore['appendEvents'] = async (expected, events) => (
    await this.base.appendEvents(expected, events)
  )

  commitTerminal: RunStore['commitTerminal'] = async (expected, next, snapshot) => {
    if (!this.injected && this.#phase === 'terminal_commit') {
      this.injected = true
      const terminal = nextRunCheckpoint(expected, 'cancelled', {
        modelTurn: null,
        preparedBatch: null,
        interruption: null,
        providerDispatch: Object.freeze({ state: 'idle' }),
        engineActivity: Object.freeze({ state: 'idle' }),
        cancellationReason: 'concurrent_terminal'
      }, [], timestamp)
      await this.base.commitTerminal(
        expected,
        terminal,
        createRunTerminalSnapshot(terminal)
      )
      throw new RunStoreConflictError()
    }
    return await this.base.commitTerminal(expected, next, snapshot)
  }

  loadTombstone: RunStore['loadTombstone'] = async runId => (
    await this.base.loadTombstone(runId)
  )

  observationUsage: RunStore['observationUsage'] = async () => (
    await this.base.observationUsage()
  )
}

function outputText (result: Awaited<ReturnType<RunEngine['start']>>): string | null {
  if (result.kind !== 'completed' || result.output === null) return null
  const part = result.output.parts[0]
  return part?.type === 'text' ? part.text : null
}

test('run engine calls checkpoint-created hook once before observer and provider drive', async () => {
  const fixture = harness([modelText('hook complete')])
  const calls: Array<Readonly<Record<string, unknown>>> = []

  const result = await fixture.engine.start(fixture.input, {
    afterCheckpointCreated: input => {
      calls.push(Object.freeze({
        ...input,
        observerEvents: fixture.events.length,
        providerCalls: fixture.adapter.requests.length
      }))
    }
  })

  assert.equal(result.kind, 'completed')
  assert.deepEqual(calls, [{
    runId: 'run-1',
    runRef: '1'.repeat(32),
    observationPolicy: fixture.input.observationPolicy,
    observerEvents: 0,
    providerCalls: 0
  }])
})

test('checkpoint-created hook failure and losing runRef collision do not change run outcome', async () => {
  const failedHook = harness([modelText('hook failure ignored')])
  let hookCalls = 0
  const completed = await failedHook.engine.start(failedHook.input, {
    afterCheckpointCreated: async () => {
      hookCalls += 1
      throw new Error('private hook failure')
    }
  })
  assert.equal(outputText(completed), 'hook failure ignored')
  assert.equal(hookCalls, 1)

  const base = new InMemoryRunStore()
  const collisionStore: RunStore = {
    ...base,
    create: async () => { throw new RunReferenceConflictError() },
    load: async runId => await base.load(runId),
    upgrade: async (expected, next) => await base.upgrade(expected, next),
    compareAndSet: async (expected, next) => await base.compareAndSet(expected, next),
    appendEvents: async (expected, events) => await base.appendEvents(expected, events),
    commitTerminal: async (expected, next, snapshot) => (
      await base.commitTerminal(expected, next, snapshot)
    ),
    loadTombstone: async runId => await base.loadTombstone(runId),
    observationUsage: async () => await base.observationUsage()
  }
  const collision = harness([modelText('must not run')], { store: collisionStore })
  let collisionHookCalls = 0
  await assert.rejects(
    collision.engine.start(collision.input, {
      afterCheckpointCreated: () => { collisionHookCalls += 1 }
    }),
    error => error instanceof RunReferenceConflictError
  )
  assert.equal(collisionHookCalls, 0)
  assert.equal(collision.adapter.requests.length, 0)
})

function terminalSnapshot (result: RunAdvanceResult) {
  return result.kind === 'paused' || result.terminal === null
    ? null
    : result.terminal.snapshot
}

test('RunEngine completes one valid pure-text turn and emits ordered events', async () => {
  const candidates: TraceCandidateV1[] = []
  const fixture = harness([Object.freeze({
    ...modelText('完成'),
    usage: Object.freeze({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  })], {
    monotonicNow: sequenceClock(0, 5, 9, 20),
    onCommittedTraceCandidate: candidate => {
      candidates.push(candidate)
      throw new Error('private trace sink failure')
    }
  })
  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.equal(outputText(result), '完成')
  assert.equal(result.kind === 'completed' ? result.completion.kind : null, 'reply_text')
  assert.deepEqual(fixture.events, [
    'run.created', 'run.started', 'context.prepared', 'model.started',
    'model.attempted', 'model.completed', 'run.completed'
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.terminal.status, 'completed')
  assert.deepEqual(candidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count,
    durationCount: row.duration.count
  })), [{
    outcome: 'succeeded', attemptKind: 'primary', count: 1, durationCount: 1
  }])
  assert.equal(await fixture.store.load('run-1'), null)
  const snapshot = terminalSnapshot(result)
  assert.equal(snapshot?.status, 'completed')
  assert.deepEqual(snapshot === null ? null : {
    providerAttempts: snapshot.counters.providerAttempts,
    modelTurns: snapshot.counters.modelTurns,
    toolAttempts: snapshot.counters.toolAttempts,
    providerRetries: snapshot.counters.providerRetries,
    recoveryAttempts: snapshot.counters.recoveryAttempts,
    correctionTurns: snapshot.counters.correctionTurns,
    providerInputTokens: snapshot.counters.providerInputTokens,
    providerOutputTokens: snapshot.counters.providerOutputTokens,
    providerTotalTokens: snapshot.counters.providerTotalTokens,
    providerActiveDurationMs: snapshot.counters.providerActiveDurationMs,
    engineActiveDurationMs: snapshot.counters.engineActiveDurationMs
  }, {
    providerAttempts: 1,
    modelTurns: 1,
    toolAttempts: 0,
    providerRetries: 0,
    recoveryAttempts: 0,
    correctionTurns: 0,
    providerInputTokens: 7,
    providerOutputTokens: 3,
    providerTotalTokens: 10,
    providerActiveDurationMs: 4,
    engineActiveDurationMs: 20
  })
})

test('RunEngine journals the full Provider request before wire and response after return', async () => {
  const journalEvents: RunContentJournalEvent[] = []
  const order: string[] = []
  const turn = Object.freeze({
    ...modelText('完整响应'),
    responseId: 'response-full-1',
    usage: Object.freeze({ inputTokens: 9, outputTokens: 4, totalTokens: 13 })
  })
  const fixture = harness([
    async () => {
      order.push('provider.complete')
      return turn
    }
  ], {
    contentJournal: {
      record: event => {
        journalEvents.push(event)
        if (event.type === 'provider.request' || event.type === 'provider.response') {
          order.push(`journal.${event.type}`)
        }
      }
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '完整响应')
  const providerEvents = journalEvents.filter(event => event.type.startsWith('provider.'))
  assert.deepEqual(order, [
    'journal.provider.request',
    'provider.complete',
    'journal.provider.response'
  ])
  assert.equal(providerEvents.length, 2)
  assert.deepEqual(providerEvents[0], {
    type: 'provider.request',
    occurredAt: timestamp,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    ordinal: 1,
    attemptKind: 'primary',
    request: JSON.parse(JSON.stringify(fixture.adapter.requests[0])) as unknown
  })
  assert.deepEqual(providerEvents[1], {
    type: 'provider.response',
    occurredAt: timestamp,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    ordinal: 1,
    attemptKind: 'primary',
    turn
  })
})

test('RunEngine journals only the classified bounded Provider error and ignores journal failures', async () => {
  const journalEvents: RunContentJournalEvent[] = []
  const providerError = new ModelProviderError({
    code: 'provider_authentication',
    stage: 'model.response',
    retryable: false,
    userMessage: '认证失败。',
    details: Object.freeze({ reason: 'invalid_credential' }),
    statusCode: 401,
    providerCode: 'raw_provider_code',
    profileCode: 'profile_code'
  })
  const fixture = harness([providerError], {
    contentJournal: {
      record: event => {
        journalEvents.push(event)
        throw new Error(`journal failure: ${event.type}`)
      }
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' ? result.error.code : null, 'provider_authentication')
  assert.equal(fixture.adapter.requests.length, 1)
  const failure = journalEvents.find(event => event.type === 'provider.failure')
  assert.deepEqual(failure, {
    type: 'provider.failure',
    occurredAt: timestamp,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    ordinal: 1,
    attemptKind: 'primary',
    error: {
      code: 'provider_authentication',
      stage: 'model.response',
      retryable: false,
      userMessage: '认证失败。',
      details: { reason: 'invalid_credential' }
    }
  })
  assert.deepEqual(
    Object.keys(failure?.type === 'provider.failure' ? failure.error : {}).sort(),
    ['code', 'details', 'retryable', 'stage', 'userMessage']
  )
})

test('RunEngine rejects untrusted non-Provider AgentError fields at the Provider boundary', async () => {
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([new AgentError({
    code: 'invalid_request',
    stage: 'untrusted.provider.stage',
    retryable: true,
    userMessage: '不应泄漏的 Provider 文本',
    details: Object.freeze({ secret: '不应泄漏的 Provider 细节' })
  })], {
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)
  const failure = journalEvents.find(event => event.type === 'provider.failure')
  const expectedError = {
    code: 'internal_error',
    stage: 'run.engine',
    retryable: false,
    userMessage: '处理请求时出现异常，请稍后重试。',
    details: {}
  }

  assert.equal(result.kind, 'failed')
  assert.deepEqual(result.kind === 'failed' ? result.error : null, expectedError)
  assert.deepEqual(failure?.type === 'provider.failure' ? failure.error : null, expectedError)
  assert.equal(JSON.stringify(result).includes('不应泄漏'), false)
  assert.equal(JSON.stringify(failure).includes('不应泄漏'), false)
})

test('RunEngine keeps the canonical Provider failure within the total error byte limit', async () => {
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([new ModelProviderError({
    code: 'provider_unavailable',
    stage: 'model.response',
    retryable: false,
    userMessage: 'AI 服务暂时不可用。',
    details: Object.freeze({ body: 'x'.repeat(100_000) })
  })], {
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)
  const failure = journalEvents.find(event => event.type === 'provider.failure')
  const journalError = failure?.type === 'provider.failure' ? failure.error : null
  const finalError = result.kind === 'failed' ? result.error : null

  assert.notEqual(journalError, null)
  assert.deepEqual(finalError, journalError)
  assert.equal(journalError?.code, 'provider_unavailable')
  assert.ok(Buffer.byteLength(JSON.stringify(journalError), 'utf8') <=
    RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes)
})

test('RunEngine bounds the complete Provider failure envelope across UTF-8 boundaries', async () => {
  const boundaryCases = Object.freeze([
    Object.freeze({ label: 'ascii', character: 'x', valueLength: 512 }),
    Object.freeze({ label: 'cjk', character: '界', valueLength: 171 }),
    Object.freeze({ label: 'emoji', character: '😀', valueLength: 128 }),
    Object.freeze({ label: 'escaped-control', character: '\u0000', valueLength: 64 })
  ])

  for (const boundary of boundaryCases) {
    const journalEvents: RunContentJournalEvent[] = []
    const candidates: TraceCandidateV1[] = []
    const details = Object.freeze(Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `${boundary.character}${index}`,
        boundary.character.repeat(boundary.valueLength)
      ])
    ))
    const fixture = harness([new ModelProviderError({
      code: 'provider_unavailable',
      stage: boundary.character.repeat(10_000),
      retryable: false,
      userMessage: boundary.character.repeat(10_000),
      details
    })], {
      contentJournal: { record: event => { journalEvents.push(event) } },
      onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
    })

    const result = await fixture.engine.start(fixture.input)
    const failure = journalEvents.find(event => event.type === 'provider.failure')
    const projected = candidates[0]?.events.find(event => event.type === 'provider_request')
    const failureBytes = Buffer.byteLength(JSON.stringify(failure), 'utf8')

    assert.equal(failure?.type, 'provider.failure', boundary.label)
    assert.ok(failureBytes <= RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes,
      `${boundary.label}: ${failureBytes}`)
    assert.deepEqual(
      result.kind === 'failed' ? result.error : null,
      failure?.type === 'provider.failure' ? failure.error : null,
      boundary.label
    )
    assert.equal(result.kind === 'failed' ? result.error.code : null,
      'provider_unavailable', boundary.label)
    assert.equal(candidates[0]?.terminal.errorCode, 'provider_unavailable', boundary.label)
    assert.deepEqual(projected?.type === 'provider_request'
      ? { outcome: projected.outcome, errorCode: projected.errorCode }
      : null, {
      outcome: 'failed',
      errorCode: 'provider_unavailable'
    }, boundary.label)
  }
})

test('RunEngine journals Provider timeout classification before returning the same failure', async () => {
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([new ModelProviderError({
    code: 'provider_timeout',
    stage: 'model.response',
    retryable: false,
    userMessage: 'AI 服务响应超时，请稍后重试。',
    details: Object.freeze({ timeoutMs: 120_000 })
  })], {
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)
  const failure = journalEvents.find(event => event.type === 'provider.failure')

  assert.equal(result.kind, 'failed')
  assert.equal(failure?.type, 'provider.failure')
  assert.equal(failure?.type === 'provider.failure' ? failure.error.code : null, 'provider_timeout')
  assert.deepEqual(
    result.kind === 'failed' ? result.error : null,
    failure?.type === 'provider.failure' ? failure.error : null
  )
})

test('RunEngine journal hooks consume no extra wall-clock reads or authoritative timestamps', async () => {
  const withoutJournalClock = incrementalWallClock()
  const withJournalClock = incrementalWallClock()
  const withoutJournal = harness([modelText('时钟一致')], {
    now: withoutJournalClock.now,
    monotonicNow: (() => {
      let value = 0
      return () => ++value
    })()
  })
  const withJournal = harness([modelText('时钟一致')], {
    now: withJournalClock.now,
    monotonicNow: (() => {
      let value = 0
      return () => ++value
    })(),
    contentJournal: { record: () => undefined }
  })

  const [withoutResult, withResult] = await Promise.all([
    withoutJournal.engine.start(withoutJournal.input),
    withJournal.engine.start(withJournal.input)
  ])

  assert.equal(withJournalClock.reads(), withoutJournalClock.reads())
  assert.deepEqual(withResult, withoutResult)
})

test('RunEngine samples successful Provider duration before synchronous journal work', async () => {
  let monotonic = 0
  const fixture = harness([modelText('日志耗时不属于 Provider')], {
    monotonicNow: () => monotonic,
    contentJournal: {
      record: event => {
        if (event.type === 'provider.response') monotonic = 240_001
      }
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '日志耗时不属于 Provider')
  assert.equal(terminalSnapshot(result)?.counters.providerActiveDurationMs, 0)
})

test('RunEngine gives Provider journal callbacks detached deep-frozen request and turn snapshots', async () => {
  const mutableTurn = {
    text: '权威响应',
    toolCalls: [] as ModelTurn['toolCalls'][number][],
    finishReason: 'stop' as const,
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
  }
  let wireRequestText: string | null = null
  let journalRequest: ModelRequest | undefined
  let journalTurn: ModelTurn | undefined
  const fixture = harness([
    async request => {
      const first = request.messages[0]
      wireRequestText = first !== undefined && 'content' in first ? first.content : null
      return mutableTurn
    }
  ], {
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([
        { role: 'user' as const, content: '权威请求' }
      ]),
      estimatedInputTokens: 16
    }),
    contentJournal: {
      record: event => {
        if (event.type === 'provider.request') {
          journalRequest = event.request
          const first = event.request.messages[0] as { content?: string } | undefined
          if (first !== undefined) first.content = '污染请求'
        }
        if (event.type === 'provider.response') {
          journalTurn = event.turn
          const mutable = event.turn as {
            text: string
            usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
          }
          mutable.text = '污染响应'
          if (mutable.usage !== undefined) {
            mutable.usage.inputTokens = 700
            mutable.usage.totalTokens = 703
          }
        }
      }
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(wireRequestText, '权威请求')
  assert.equal(outputText(result), '权威响应')
  assert.equal(terminalSnapshot(result)?.counters.providerInputTokens, 7)
  assert.equal(terminalSnapshot(result)?.counters.providerTotalTokens, 10)
  assert.notStrictEqual(journalRequest, fixture.adapter.requests[0])
  assert.notStrictEqual(journalTurn, mutableTurn)
  assert.equal(Object.isFrozen(journalRequest), true)
  assert.equal(Object.isFrozen(journalRequest?.messages), true)
  assert.equal(Object.isFrozen(journalRequest?.messages[0]), true)
  assert.equal(Object.isFrozen(journalTurn), true)
  assert.equal(Object.isFrozen(journalTurn?.usage), true)
})

test('RunEngine drops a local trace candidate when terminal CAS loses', async () => {
  const candidates: TraceCandidateV1[] = []
  const fixture = harness([modelText('本地终态不应提交')], {
    store: new TerminalRaceRunStore('terminal_commit'),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'cancelled')
  assert.equal(candidates.length, 0)
})

test('RunEngine reports one fixed projection failure without changing the terminal result', async () => {
  const candidates: TraceCandidateV1[] = []
  const failures: string[] = []
  const fixture = harness([modelText('轨迹投影失败不影响回复')], {
    store: new TraceProjectionFailureStore(),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) },
    onTraceCandidateProjectionFailure: code => {
      failures.push(code)
      throw new Error('private projection failure sink body')
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '轨迹投影失败不影响回复')
  assert.deepEqual(failures, ['projection_rejected'])
  assert.equal(candidates.length, 0)
  assert.notEqual(terminalSnapshot(result), null)
})

test('RunEngine drops a projection rejection signal when terminal CAS loses', async () => {
  const failures: string[] = []
  const fixture = harness([modelText('本地投影和本地终态都不应可见')], {
    store: new TraceProjectionTerminalRaceStore(),
    onTraceCandidateProjectionFailure: code => { failures.push(code) }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'cancelled')
  assert.deepEqual(failures, [])
})

test('RunEngine records the monotonic activity start only after reservation CAS', async () => {
  const store = new ActivityOrderStore()
  let tick = 0
  const fixture = harness([modelText('完成')], {
    store,
    monotonicNow: () => {
      store.order.push('clock')
      tick += 1
      return tick
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.deepEqual(store.order.slice(0, 2), ['engine_reserved', 'clock'])
})

test('RunEngine keeps actual Provider wire time above one attempt timeout in the Phase 5 budget', async () => {
  const fixture = harness([modelText('完成')], {
    monotonicNow: sequenceClock(0, 10, 130_010, 130_020)
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.equal(terminalSnapshot(result)?.counters.providerActiveDurationMs, 130_000)
  assert.equal(await fixture.store.load('run-1'), null)
})

test('RunEngine caps delayed Provider completion without losing the attempt observation', async () => {
  const candidates: TraceCandidateV1[] = []
  const fixture = harness([modelText('延迟完成')], {
    monotonicNow: sequenceClock(0, 10, 240_011, 240_020),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'run_budget_exceeded')
  assert.equal(terminalSnapshot(result)?.counters.providerActiveDurationMs, 240_000)
  assert.deepEqual(candidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count,
    durationSumMs: row.duration.sumMs
  })), [{
    outcome: 'succeeded', attemptKind: 'primary', count: 1, durationSumMs: 240_001
  }])
})

test('RunEngine records a delayed failed Provider attempt before enforcing the active budget', async () => {
  const candidates: TraceCandidateV1[] = []
  const unavailable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: false,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const fixture = harness([unavailable], {
    monotonicNow: sequenceClock(0, 10, 240_011, 240_020),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'run_budget_exceeded')
  assert.equal(terminalSnapshot(result)?.counters.providerActiveDurationMs, 240_000)
  assert.deepEqual(candidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count,
    durationSumMs: row.duration.sumMs
  })), [{
    outcome: 'failed', attemptKind: 'primary', count: 1, durationSumMs: 240_001
  }])
})

test('RunEngine persists Provider dispatch reservation before wire and trusted usage after success', async () => {
  const store = new TerminalCaptureStore()
  let fixture: ReturnType<typeof harness>
  fixture = harness([async () => {
    const reserved = await fixture.store.load('run-1')
    assert.equal(reserved?.schemaVersion, 4)
    if (reserved?.schemaVersion !== 4) throw new TypeError('reserved checkpoint is missing')
    assert.deepEqual(reserved.modelCapability, FIXTURE_MODEL_CAPABILITY)
    assert.equal(reserved.modelPrice, null)
    assert.deepEqual(reserved.usage, {
      schemaVersion: 1,
      availability: 'complete',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      turnsWithUsage: 0,
      turnsWithoutUsage: 0,
      cacheUsageComplete: true
    })
    assert.deepEqual(reserved.providerDispatch, { state: 'reserved' })
    assert.equal(reserved.observationCounters.providerAttempts, 1)
    assert.deepEqual({
      input: reserved.observationCounters.providerInputTokens,
      output: reserved.observationCounters.providerOutputTokens,
      total: reserved.observationCounters.providerTotalTokens
    }, {
      input: 'unavailable', output: 'unavailable', total: 'unavailable'
    })
    return Object.freeze({
      ...modelText('带用量完成'),
      usage: Object.freeze({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
    })
  }], { store })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  const completed = terminalSnapshot(result)
  assert.notEqual(completed, null)
  if (completed === null) throw new TypeError('terminal snapshot is missing')
  assert.deepEqual({
    attempts: completed.counters.providerAttempts,
    modelTurns: completed.counters.modelTurns,
    input: completed.counters.providerInputTokens,
    output: completed.counters.providerOutputTokens,
    total: completed.counters.providerTotalTokens
  }, {
    attempts: 1, modelTurns: 1, input: 7, output: 3, total: 10
  })
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine commits each trusted success usage once and marks missing usage partial', async () => {
  const withUsageStore = new TerminalCaptureStore()
  const withUsage = harness([Object.freeze({
    ...modelText('cache usage complete'),
    usage: Object.freeze({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      inputCache: Object.freeze({ hitTokens: 7, missTokens: 4 })
    })
  })], { store: withUsageStore })

  assert.equal((await withUsage.engine.start(withUsage.input)).kind, 'completed')
  assert.deepEqual(withUsageStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15,
    cacheHitTokens: 7,
    cacheMissTokens: 4,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: true
  })

  const withoutUsageStore = new TerminalCaptureStore()
  const withoutUsage = harness([modelText('usage omitted')], { store: withoutUsageStore })
  assert.equal((await withoutUsage.engine.start(withoutUsage.input)).kind, 'completed')
  assert.deepEqual(withoutUsageStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'partial',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 1,
    cacheUsageComplete: false
  })
})

test('RunEngine excludes wire failures from usage and records only retry or recovery success', async () => {
  const retryable = new ModelProviderError({
    code: 'provider_unavailable',
    stage: 'model.response',
    retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。',
    statusCode: 503
  })
  const retryStore = new TerminalCaptureStore()
  const retry = harness([retryable, Object.freeze({
    ...modelText('retry success'),
    usage: Object.freeze({ inputTokens: 8, outputTokens: 2, totalTokens: 10 })
  })], { store: retryStore })
  assert.equal((await retry.engine.start(retry.input)).kind, 'completed')
  assert.deepEqual(retryStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 8,
    outputTokens: 2,
    totalTokens: 10,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })

  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request',
    stage: 'model.response',
    retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。',
    statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  const recoveryStore = new TerminalCaptureStore()
  const recovery = harness([legacyContext, Object.freeze({
    ...modelText('recovery success'),
    usage: Object.freeze({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
  })], {
    store: recoveryStore,
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    recoverContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '精简上下文' }]),
      estimatedInputTokens: 4
    })
  })
  assert.equal((await recovery.engine.start(recovery.input)).kind, 'completed')
  assert.equal(recovery.adapter.requests.length, 2)
  assert.deepEqual(recoveryStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine records trusted refusal and invalid tool protocol usage before failing closed', async () => {
  const turns: readonly ModelTurn[] = [
    Object.freeze({
      text: '',
      refusal: 'policy refusal',
      toolCalls: Object.freeze([]),
      finishReason: 'content_filter',
      usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    }),
    Object.freeze({
      ...modelTools([toolCall(0, 'call-invalid-finish', 'normalRead')]),
      finishReason: 'stop',
      usage: Object.freeze({ inputTokens: 6, outputTokens: 2, totalTokens: 8 })
    })
  ]
  for (const turn of turns) {
    const store = new TerminalCaptureStore()
    const fixture = harness([turn], { store })
    assert.equal((await fixture.engine.start(fixture.input)).kind, 'failed')
    assert.deepEqual(store.terminalCheckpoint?.usage, {
      schemaVersion: 1,
      availability: 'complete',
      inputTokens: turn.usage?.inputTokens,
      outputTokens: turn.usage?.outputTokens,
      totalTokens: turn.usage?.totalTokens,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      turnsWithUsage: 1,
      turnsWithoutUsage: 0,
      cacheUsageComplete: false
    })
  }
})

test('RunEngine fails a successful response planning exception against its reserved checkpoint', async () => {
  const store = new TerminalCaptureStore()
  const turn = Object.defineProperty({
    toolCalls: Object.freeze([]),
    finishReason: 'stop' as const,
    usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  }, 'text', {
    enumerable: true,
    get: () => { throw new Error('hostile successful turn text') }
  }) as unknown as ModelTurn
  const fixture = harness([turn], { store })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(store.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine contains nested tool-call Proxy traps inside the reserved success boundary', async () => {
  const store = new TerminalCaptureStore()
  const journalEvents: RunContentJournalEvent[] = []
  const nestedTrap = new Error('nested toolCalls length trap')
  const toolCalls = new Proxy([], {
    get: (target, property, receiver) => {
      if (property === 'length') throw nestedTrap
      return Reflect.get(target, property, receiver) as unknown
    }
  }) as unknown as ModelTurn['toolCalls']
  const turn: ModelTurn = Object.freeze({
    text: '',
    toolCalls,
    finishReason: 'tool_calls',
    usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  })
  const fixture = harness([turn], {
    store,
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(await store.load(fixture.input.runId), null)
  assert.equal((await store.loadTombstone(fixture.input.runId))?.status, 'failed')
  assert.equal(store.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
  assert.deepEqual(store.terminalCheckpoint?.events
    .filter(event => event.type === 'model.attempted')
    .map(event => event.payload.outcome), ['succeeded'])
  assert.equal(journalEvents.some(event => event.type === 'provider.response'), false)
})

test('RunEngine rejects nested usage accessors without leaving the succeeded-attempt path', async () => {
  const store = new TerminalCaptureStore()
  let getterReads = 0
  const usage = Object.defineProperty({
    inputTokens: 3,
    outputTokens: 1
  }, 'totalTokens', {
    enumerable: true,
    get: () => {
      getterReads += 1
      throw new Error('nested usage getter')
    }
  }) as unknown as NonNullable<ModelTurn['usage']>
  const turn: ModelTurn = Object.freeze({
    ...modelText('usage accessor'),
    usage
  })
  const fixture = harness([turn], { store })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(getterReads, 0)
  assert.equal(store.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 0,
    cacheUsageComplete: true
  })
  assert.deepEqual(store.terminalCheckpoint?.events
    .filter(event => event.type === 'model.attempted')
    .map(event => event.payload.outcome), ['succeeded'])
})

test('RunEngine inspects optional turn usage without invoking a top-level accessor', async () => {
  const store = new TerminalCaptureStore()
  let getterReads = 0
  const turn = Object.defineProperty({
    ...modelText('top-level usage accessor')
  }, 'usage', {
    enumerable: true,
    get: () => {
      getterReads += 1
      throw new Error('top-level usage getter')
    }
  }) as unknown as ModelTurn
  const fixture = harness([turn], { store })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(getterReads, 0)
  assert.equal(store.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(store.terminalCheckpoint?.events
    .filter(event => event.type === 'model.attempted')
    .map(event => event.payload.outcome), ['succeeded'])
})

test('RunEngine detaches successful tool protocol state before persistence validation', async () => {
  const delayedTrap = new Error('successful turn was traversed after planning')
  let argumentInspections = 0
  const argumentsValue = new Proxy({ value: 'normalRead' }, {
    ownKeys: target => {
      argumentInspections += 1
      if (argumentInspections > 2) throw delayedTrap
      return Reflect.ownKeys(target)
    }
  })
  let providerStateInspections = 0
  const providerState = new Proxy({
    profileId: deepSeekCompatibilityProfile.id,
    profileVersion: deepSeekCompatibilityProfile.version,
    payload: Object.freeze({ reasoningContent: 'detached reasoning' })
  }, {
    ownKeys: target => {
      providerStateInspections += 1
      if (providerStateInspections > 2) throw delayedTrap
      return Reflect.ownKeys(target)
    }
  })
  const call = Object.freeze({
    ...toolCall(0, 'stateful-protocol', 'normalRead'),
    arguments: argumentsValue
  })
  const turn: ModelTurn = Object.freeze({
    ...modelTools([call], '', 'detached reasoning'),
    providerState,
    usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  })
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([turn, modelText('detached success')], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.equal(outputText(result), 'detached success')
  assert.equal(argumentInspections, 2)
  assert.equal(providerStateInspections, 2)
  const responseTurns = journalEvents
    .filter(event => event.type === 'provider.response')
    .map(event => event.type === 'provider.response' ? event.turn : null)
  assert.equal(responseTurns.length, 2)
  const plannedTurn = responseTurns[0]
  assert.notEqual(plannedTurn, null)
  assert.notStrictEqual(plannedTurn, turn)
  assert.deepEqual(plannedTurn?.toolCalls[0]?.arguments, { value: 'normalRead' })
  const plannedAssistant = fixture.adapter.requests[1]?.messages
    .find(message => message.role === 'assistant')
  assert.deepEqual(
    plannedAssistant?.role === 'assistant'
      ? plannedAssistant.toolCalls?.[0]?.arguments
      : null,
    plannedTurn?.toolCalls[0]?.arguments
  )
  assert.deepEqual(
    plannedAssistant?.role === 'assistant' ? plannedAssistant.providerState : null,
    plannedTurn?.providerState
  )
})

test('RunEngine propagates success persistence errors without a stale checkpoint fallback', async () => {
  for (const phase of ['compareAndSet', 'commitTerminal'] as const) {
    const store = new SuccessCommitSentinelStore(phase)
    const turn = phase === 'compareAndSet'
      ? Object.freeze({
          ...modelTools([toolCall(0, `sentinel-${phase}`, 'normalRead')]),
          usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
        })
      : Object.freeze({
          ...modelText('terminal sentinel'),
          usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
        })
    const fixture = harness([turn], { store })

    await assert.rejects(fixture.engine.start(fixture.input), error => (
      error === store.sentinel && (error as Error).message === 'success store sentinel'
    ))
    const reserved = await store.load(fixture.input.runId)
    assert.equal(reserved?.schemaVersion === 4 ? reserved.status : null, 'calling_model')
    assert.equal(
      reserved?.schemaVersion === 4 ? reserved.providerDispatch.state : null,
      'reserved'
    )
    assert.deepEqual(reserved?.schemaVersion === 4 ? reserved.usage : null, {
      schemaVersion: 1,
      availability: 'complete',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      turnsWithUsage: 0,
      turnsWithoutUsage: 0,
      cacheUsageComplete: true
    })
  }
})

test('RunEngine never treats an abort-named Store failure as run cancellation', async () => {
  for (const phase of ['compareAndSet', 'commitTerminal'] as const) {
    const store = new SuccessCommitAbortNamedStore(phase)
    const turn = phase === 'compareAndSet'
      ? Object.freeze({
          ...modelTools([toolCall(0, `abort-named-${phase}`, 'normalRead')]),
          usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
        })
      : Object.freeze({
          ...modelText('abort-named terminal'),
          usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
        })
    const fixture = harness([turn], { store })

    await assert.rejects(fixture.engine.start(fixture.input), error => (
      error === store.sentinel &&
      (error as Error).message === 'success store abort-named sentinel'
    ))
    const reserved = await store.load(fixture.input.runId)
    assert.equal(reserved?.schemaVersion === 4 ? reserved.status : null, 'calling_model')
    assert.equal(
      reserved?.schemaVersion === 4 ? reserved.providerDispatch.state : null,
      'reserved'
    )
    assert.equal(await store.loadTombstone(fixture.input.runId), null)
  }
})

test('RunEngine unwraps semantic-failure Store errors before aborted-controller handling', async () => {
  const store = new SuccessCommitSentinelStore('commitTerminal')
  const turn: ModelTurn = Object.freeze({
    ...modelText('refused'),
    refusal: 'provider refused',
    usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  })
  const fixture = harness([turn], { store })

  await assert.rejects(fixture.engine.start(fixture.input), error => (
    error === store.sentinel && (error as Error).message === 'success store sentinel'
  ))
  const reserved = await store.load(fixture.input.runId)
  assert.equal(reserved?.schemaVersion === 4 ? reserved.status : null, 'calling_model')
  assert.equal(
    reserved?.schemaVersion === 4 ? reserved.providerDispatch.state : null,
    'reserved'
  )
})

test('RunEngine fails closed when successful turn usage arithmetic is invalid or overflows', async () => {
  const invalidStore = new TerminalCaptureStore()
  const invalid = harness([Object.freeze({
    ...modelText('invalid usage'),
    usage: Object.freeze({ inputTokens: 3, outputTokens: 1, totalTokens: 5 })
  })], { store: invalidStore })
  const invalidResult = await invalid.engine.start(invalid.input)
  assert.equal(invalidResult.kind, 'failed')
  assert.equal(invalidStore.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(invalidStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 0,
    cacheUsageComplete: true
  })

  const overflowStore = new OverflowUsageReservationStore()
  const overflow = harness([Object.freeze({
    ...modelText('overflow usage'),
    usage: Object.freeze({ inputTokens: 1, outputTokens: 0, totalTokens: 1 })
  })], { store: overflowStore })
  const overflowResult = await overflow.engine.start(overflow.input)
  assert.equal(overflowResult.kind, 'failed')
  assert.equal(overflowStore.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(overflowStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine records empty primary and correction success usage independently', async () => {
  const store = new TerminalCaptureStore()
  const fixture = harness([
    Object.freeze({
      ...modelText(''),
      usage: Object.freeze({ inputTokens: 4, outputTokens: 1, totalTokens: 5 })
    }),
    Object.freeze({
      ...modelText('corrected'),
      usage: Object.freeze({ inputTokens: 6, outputTokens: 2, totalTokens: 8 })
    })
  ], { store })

  assert.equal((await fixture.engine.start(fixture.input)).kind, 'completed')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 10,
    outputTokens: 3,
    totalTokens: 13,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 2,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })

  const invalidStore = new TerminalCaptureStore()
  const invalid = harness([
    Object.freeze({
      ...modelText(''),
      usage: Object.freeze({ inputTokens: 2, outputTokens: 1, totalTokens: 3 })
    }),
    Object.freeze({
      ...modelText(''),
      usage: Object.freeze({ inputTokens: 4, outputTokens: 1, totalTokens: 5 })
    })
  ], { store: invalidStore })
  assert.equal((await invalid.engine.start(invalid.input)).kind, 'failed')
  assert.deepEqual(invalidStore.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 6,
    outputTokens: 2,
    totalTokens: 8,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 2,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine commits successful turn usage before a success-side budget failure', async () => {
  const store = new TerminalCaptureStore()
  const fixture = harness([Object.freeze({
    ...modelText('budget exhausted after return'),
    usage: Object.freeze({ inputTokens: 9, outputTokens: 1, totalTokens: 10 })
  })], {
    store,
    monotonicNow: sequenceClock(0, 10, 240_011, 240_020)
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' ? result.error.code : null, 'run_budget_exceeded')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 9,
    outputTokens: 1,
    totalTokens: 10,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
  assert.deepEqual(fixture.observedEvents
    .filter(event => event.type === 'model.attempted' || event.type === 'model.completed')
    .map(event => event.type), ['model.attempted'])
})

test('RunEngine keeps an active budget failure authoritative when the response snapshot is unsafe', async () => {
  const store = new TerminalCaptureStore()
  const journalEvents: RunContentJournalEvent[] = []
  const toolCalls = new Proxy([], {
    get: (target, property, receiver) => {
      if (property === 'length') throw new Error('budget response toolCalls length trap')
      return Reflect.get(target, property, receiver) as unknown
    }
  }) as unknown as ModelTurn['toolCalls']
  const turn: ModelTurn = Object.freeze({
    text: '',
    toolCalls,
    finishReason: 'tool_calls',
    usage: Object.freeze({ inputTokens: 9, outputTokens: 1, totalTokens: 10 })
  })
  const fixture = harness([turn], {
    store,
    monotonicNow: sequenceClock(0, 10, 240_011, 240_020),
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' ? result.error.code : null, 'run_budget_exceeded')
  const terminal = terminalSnapshot(result)
  assert.deepEqual(terminal === null ? null : {
    input: terminal.counters.providerInputTokens,
    output: terminal.counters.providerOutputTokens,
    total: terminal.counters.providerTotalTokens,
    activeDurationMs: terminal.counters.providerActiveDurationMs
  }, {
    input: 9,
    output: 1,
    total: 10,
    activeDurationMs: 240_000
  })
  assert.equal(store.terminalCheckpoint?.providerDispatch.state, 'idle')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 9,
    outputTokens: 1,
    totalTokens: 10,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
  assert.deepEqual(store.terminalCheckpoint?.events
    .filter(event => event.type === 'model.attempted' || event.type === 'model.completed')
    .map(event => event.type), ['model.attempted'])
  assert.equal(journalEvents.some(event => event.type === 'provider.response'), false)
})

test('RunEngine permits resend after pre-success-CAS crash without claiming external billing exactly once', async () => {
  const store = new PreSuccessCasCrashStore()
  const first = harness([Object.freeze({
    ...modelText('first external success'),
    usage: Object.freeze({ inputTokens: 7, outputTokens: 2, totalTokens: 9 })
  })], { store })

  await assert.rejects(first.engine.start(first.input), error => error === store.crash)
  assert.equal(first.adapter.requests.length, 1)
  const crashed = await store.load(first.input.runId)
  assert.equal(store.crashed, true)
  assert.equal(crashed?.schemaVersion === 4 ? crashed.providerDispatch.state : null, 'reserved')
  assert.deepEqual(crashed?.schemaVersion === 4 ? crashed.usage : null, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 0,
    cacheUsageComplete: true
  })

  const second = harness([Object.freeze({
    ...modelText('resent success'),
    usage: Object.freeze({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })
  })], { store })
  const resumed = await second.engine.resume(first.input.runId, second.input.runtime)
  assert.equal(resumed.kind, 'completed')
  assert.equal(second.adapter.requests.length, 1)
  const tombstone = await store.loadTombstone(first.input.runId)
  assert.equal(tombstone?.status, 'completed')
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 5,
    outputTokens: 1,
    totalTokens: 6,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine persists a tool success transition before return crash and recovery never resends it', async () => {
  const store = new PostSuccessCasCrashStore()
  const first = harness([Object.freeze({
    ...modelTools([toolCall(0, 'call-post-success', 'normalRead')]),
    usage: Object.freeze({ inputTokens: 7, outputTokens: 2, totalTokens: 9 })
  })], { store })

  await assert.rejects(first.engine.start(first.input), error => error === store.crash)
  const crashed = await store.load(first.input.runId)
  assert.equal(crashed?.schemaVersion === 4 ? crashed.status : null, 'evaluating_tools')
  assert.equal(crashed?.schemaVersion === 4 ? crashed.providerDispatch.state : null, 'idle')
  assert.deepEqual(crashed?.schemaVersion === 4 ? crashed.usage : null, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 7,
    outputTokens: 2,
    totalTokens: 9,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 1,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })

  const second = harness([Object.freeze({
    ...modelText('after recovered tool'),
    usage: Object.freeze({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })
  })], { store })
  const resumed = await second.engine.resume(first.input.runId, second.input.runtime)
  assert.equal(resumed.kind, 'completed')
  assert.equal(second.adapter.requests.length, 1)
  assert.deepEqual(store.terminalCheckpoint?.usage, {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 12,
    outputTokens: 3,
    totalTokens: 15,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 2,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('RunEngine freezes DeepSeek capability and canonical alias price at creation time', async () => {
  let fixture: ReturnType<typeof harness>
  fixture = harness([async () => {
    const checkpoint = await fixture.store.load('run-1')
    if (checkpoint?.schemaVersion !== 4) throw new TypeError('checkpoint is missing')
    assert.equal(checkpoint.model.model, 'deepseek-reasoner')
    assert.deepEqual(checkpoint.modelCapability, {
      schemaVersion: 1,
      source: 'profile',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      promptCaching: 'deepseek_disk',
      usageExtensions: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'],
      priceCatalogVersion: 'deepseek-cny-2026-07-19'
    })
    assert.deepEqual(checkpoint.modelPrice, {
      schemaVersion: 1,
      catalogVersion: 'deepseek-cny-2026-07-19',
      model: 'deepseek-v4-flash',
      inputCacheHitPicoYuanPerMillionTokens: 20_000_000_000,
      inputCacheMissPicoYuanPerMillionTokens: 1_000_000_000_000,
      outputPicoYuanPerMillionTokens: 2_000_000_000_000
    })
    return modelText('完成')
  }], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile
  })
  const result = await fixture.engine.start(Object.freeze({
    ...fixture.input,
    model: Object.freeze({
      ...fixture.input.model,
      model: 'deepseek-reasoner'
    })
  }))
  assert.equal(result.kind, 'completed')
})

test('RunEngine returns a concurrent terminal before Provider wire when dispatch reservation CAS loses', async () => {
  const store = new TerminalRaceRunStore('provider_reservation')
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([modelText('不应调用 Provider')], {
    store,
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(store.injected, true)
  assert.deepEqual(result, {
    kind: 'cancelled',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    reason: 'other',
    terminal: null
  })
  assert.equal(fixture.adapter.requests.length, 0)
  assert.equal(fixture.tools.preparations, 0)
  assert.equal(fixture.tools.executions, 0)
  assert.equal(journalEvents.some(event => event.type === 'provider.request'), false)
  assert.deepEqual(fixture.events, [
    'run.created', 'run.started', 'context.prepared', 'model.started'
  ])
})

test('RunEngine stops downstream tool work when the atomic success transition loses to a terminal', async () => {
  const store = new TerminalRaceRunStore('success_transition')
  const providerTurn = modelTools([toolCall(0, 'race-call', 'normalRead')])
  const fixture = harness([providerTurn], { store })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(store.injected, true)
  assert.deepEqual(result, {
    kind: 'cancelled',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    reason: 'other',
    terminal: null
  })
  assert.equal(fixture.adapter.requests.length, 1)
  assert.equal(fixture.tools.preparations, 0)
  assert.equal(fixture.tools.executions, 0)
  assert.equal(fixture.events.includes('model.completed'), false)
  assert.equal(fixture.events.some(event => event.startsWith('tool.')), false)
})

test('RunEngine journals a real Provider return before atomic success-transition CAS loss', async () => {
  const store = new TerminalRaceRunStore('success_transition')
  const journalEvents: RunContentJournalEvent[] = []
  const turn = modelTools([toolCall(0, 'journal-race-call', 'normalRead')])
  const fixture = harness([turn], {
    store,
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'cancelled')
  assert.deepEqual(journalEvents
    .filter(event => event.type.startsWith('provider.'))
    .map(event => event.type), ['provider.request', 'provider.response'])
  const response = journalEvents.find(event => event.type === 'provider.response')
  assert.deepEqual(response?.type === 'provider.response' ? response.turn : null, turn)
})

test('RunEngine feeds every tool result in Provider index order before the next model turn', async () => {
  const fixture = harness([
    modelTools([
      toolCall(1, 'call-1', 'slowRead'),
      toolCall(0, 'call-0', 'fastRead')
    ]),
    modelText('全部完成')
  ])
  fixture.tools.delays.set('call-0', 20)
  fixture.tools.delays.set('call-1', 0)

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  const toolMessages = fixture.adapter.requests[1]?.messages.filter(message => message.role === 'tool') ?? []
  assert.deepEqual(toolMessages.map(message => message.role === 'tool' && message.toolCallId), [
    'call-0', 'call-1'
  ])
  assert.deepEqual(fixture.observedEvents
    .filter(event => event.type === 'tool.started')
    .map(event => event.payload), [
    { callId: 'call-0', toolName: 'fastRead', occurrenceId: '0:0' },
    { callId: 'call-1', toolName: 'slowRead', occurrenceId: '0:1' }
  ])
  assert.equal(outputText(result), '全部完成')
  assert.equal(fixture.events.includes('run.progress'), false)
})

test('RunEngine never exposes companion text from a turn that still contains tool calls', async () => {
  const fixture = harness([
    modelTools([toolCall(0, 'call-0', 'normalRead')], '我先查一下'),
    modelText('查询完成')
  ])
  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '查询完成')
  assert.equal(JSON.stringify(result).includes('我先查一下'), false)
  assert.equal(JSON.stringify(fixture.events).includes('我先查一下'), false)
  assert.equal(await fixture.store.load('run-1'), null)
  assert.equal(
    JSON.stringify(await fixture.store.loadTombstone('run-1')).includes('我先查一下'),
    false
  )
})

test('RunEngine uses at most five normal turns and one tools-disabled correction', async () => {
  const turns = Array.from({ length: 5 }, (_, index) => (
    modelTools([toolCall(0, `call-${index}`, 'normalRead')])
  ))
  const fixture = harness([
    ...turns,
    modelTools([toolCall(0, 'correction-call', 'normalRead')])
  ])

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_protocol_error')
  assert.equal(fixture.adapter.requests.length, 6)
  assert.deepEqual(fixture.adapter.requests.map(request => request.toolMode), [
    'auto', 'auto', 'auto', 'auto', 'auto', 'disabled'
  ])
  const snapshot = terminalSnapshot(result)
  assert.equal(snapshot?.counters.modelTurns, 6)
  assert.equal(snapshot?.counters.correctionTurns, 1)
})

test('RunEngine corrects one empty response but keeps refusal distinct', async () => {
  const correctedCandidates: TraceCandidateV1[] = []
  const correctionJournal: RunContentJournalEvent[] = []
  const empty = harness([modelText(''), modelText('纠正后的回答')], {
    onCommittedTraceCandidate: candidate => { correctedCandidates.push(candidate) },
    contentJournal: { record: event => { correctionJournal.push(event) } }
  })
  const corrected = await empty.engine.start(empty.input)
  assert.equal(outputText(corrected), '纠正后的回答')
  assert.equal(empty.adapter.requests[1]?.toolMode, 'disabled')
  const correctedSnapshot = terminalSnapshot(corrected)
  assert.deepEqual(correctedSnapshot === null ? null : {
    providerAttempts: correctedSnapshot.counters.providerAttempts,
    modelTurns: correctedSnapshot.counters.modelTurns,
    correctionTurns: correctedSnapshot.counters.correctionTurns
  }, {
    providerAttempts: 2,
    modelTurns: 2,
    correctionTurns: 1
  })
  assert.deepEqual(correctedCandidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count
  })), [
    { outcome: 'succeeded', attemptKind: 'correction', count: 1 },
    { outcome: 'succeeded', attemptKind: 'primary', count: 1 }
  ])
  assert.deepEqual(correctionJournal
    .filter(isProviderJournalEvent)
    .map(event => ({ type: event.type, ordinal: event.ordinal, kind: event.attemptKind })), [
    { type: 'provider.request', ordinal: 1, kind: 'primary' },
    { type: 'provider.response', ordinal: 1, kind: 'primary' },
    { type: 'provider.request', ordinal: 2, kind: 'correction' },
    { type: 'provider.response', ordinal: 2, kind: 'correction' }
  ])

  const correctionFailure = harness([
    modelText(''),
    new ModelProviderError({
      code: 'provider_unavailable', stage: 'model.response', retryable: false,
      userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
    })
  ])
  const correctionFailed = await correctionFailure.engine.start(correctionFailure.input)
  assert.equal(correctionFailed.kind, 'failed')
  const correctionFailedSnapshot = terminalSnapshot(correctionFailed)
  assert.deepEqual(correctionFailedSnapshot === null ? null : {
    providerAttempts: correctionFailedSnapshot.counters.providerAttempts,
    modelTurns: correctionFailedSnapshot.counters.modelTurns,
    correctionTurns: correctionFailedSnapshot.counters.correctionTurns
  }, {
    providerAttempts: 2,
    modelTurns: 1,
    correctionTurns: 1
  })

  const refusalTurn: ModelTurn = Object.freeze({
    text: '', refusal: 'policy refusal', toolCalls: Object.freeze([]),
    finishReason: 'content_filter'
  })
  const refusal = harness([refusalTurn])
  const refused = await refusal.engine.start(refusal.input)
  assert.equal(refused.kind, 'failed')
  assert.equal(refused.kind === 'failed' && refused.error.details.reason, 'provider_refusal')
  assert.equal(refusal.adapter.requests.length, 1)
})

test('RunEngine rejects an empty correction instead of treating it as allowed silence', async () => {
  const fixture = harness([modelText(''), modelText('')])
  const proactiveInput: StartRunInput = Object.freeze({
    ...fixture.input,
    requestKind: 'proactive_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'proactive_chat',
      profile: 'proactive',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'proactive',
        recallAfterMs: null
      }),
      sessionAddress: fixture.input.sessionAddress,
      actorId: 'actor-1',
      requestMessageId: 'message-current'
    })
  })

  const result = await fixture.engine.start(proactiveInput)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_protocol_error')
  assert.equal(
    result.kind === 'failed' && result.error.details.reason,
    'invalid_correction_response'
  )
  assert.deepEqual(fixture.adapter.requests.map(request => request.toolMode), [
    'auto',
    'disabled'
  ])
  const snapshot = terminalSnapshot(result)
  assert.deepEqual(snapshot === null ? null : {
    status: snapshot.status,
    completion: snapshot.completion,
    providerAttempts: snapshot.counters.providerAttempts,
    modelTurns: snapshot.counters.modelTurns,
    correctionTurns: snapshot.counters.correctionTurns
  }, {
    status: 'failed',
    completion: { kind: 'none' },
    providerAttempts: 2,
    modelTurns: 2,
    correctionTurns: 1
  })
})

test('RunEngine rejects duplicate or malformed call IDs before ledger preparation', async () => {
  for (const turn of [
    modelTools([
      toolCall(0, 'duplicate', 'fastRead'),
      toolCall(1, 'duplicate', 'slowRead')
    ]),
    modelTools([toolCall(0, '', 'fastRead')])
  ]) {
    const fixture = harness([turn])
    const result = await fixture.engine.start(fixture.input)
    assert.equal(result.kind, 'failed')
    assert.equal(result.kind === 'failed' && result.error.code, 'provider_protocol_error')
    assert.equal(fixture.tools.preparations, 0)
    assert.equal(terminalSnapshot(result)?.counters.toolCalls, 0)
    assert.equal(terminalSnapshot(result)?.counters.toolAttempts, 0)
  }
})

test('RunEngine returns one ordered terminal result for unknown, failed and denied tools', async () => {
  const fixture = harness([
    modelTools([
      toolCall(2, 'call-denied', 'deniedRead'),
      toolCall(0, 'call-unknown', 'unknown'),
      toolCall(1, 'call-failed', 'failedRead')
    ]),
    modelText('已说明结果')
  ])
  fixture.tools.outcomes.set('call-denied', denied())
  fixture.tools.outcomes.set('call-failed', failed())

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '已说明结果')
  const toolMessages = fixture.adapter.requests[1]?.messages.filter(message => message.role === 'tool') ?? []
  assert.deepEqual(toolMessages.map(message => message.role === 'tool' && message.toolCallId), [
    'call-unknown', 'call-failed', 'call-denied'
  ])
  const snapshot = terminalSnapshot(result)
  assert.deepEqual(snapshot === null ? null : {
    toolCalls: snapshot.counters.toolCalls,
    toolAttempts: snapshot.counters.toolAttempts,
    toolDenied: snapshot.counters.toolDenied,
    toolExpired: snapshot.counters.toolExpired,
    toolIndeterminate: snapshot.counters.toolIndeterminate
  }, {
    toolCalls: 3,
    toolAttempts: 2,
    toolDenied: 2,
    toolExpired: 0,
    toolIndeterminate: 0
  })
})

test('RunEngine preserves chronological reasoning and tool presentation traces without feeding them back', async () => {
  const store = new TerminalCaptureStore()
  const fixture = harness([
    modelTools([toolCall(0, 'call-1', 'normalRead', 'first')], '', '思考一'),
    modelTools([toolCall(0, 'call-2', 'normalRead', 'second')], '', '思考二'),
    modelTools([toolCall(0, 'call-3', 'normalRead', 'third')], '', '思考三'),
    modelText('全部完成', '思考四')
  ], { store })
  fixture.tools.outcomes.set('call-1', success('结果一'))
  fixture.tools.outcomes.set('call-2', success('结果二'))
  fixture.tools.outcomes.set('call-3', success('结果三'))

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  assert.deepEqual(result.presentationTrace.segments.map(segment => (
    segment.kind === 'reasoning'
      ? `r${segment.turn}:${segment.text}`
      : `t${segment.step}:${segment.index}:${segment.resultSummary}`
  )), [
    'r1:思考一', 't0:0:结果一',
    'r2:思考二', 't1:0:结果二',
    'r3:思考三', 't2:0:结果三',
    'r4:思考四'
  ])
  assert.equal(store.terminalCheckpoint?.reasoningSegments.length, 4)
  assert.equal(JSON.stringify(fixture.adapter.requests).includes('思考一'), false)
  assert.equal(JSON.stringify(fixture.adapter.requests).includes('思考四'), false)
})

test('RunEngine completes visible tool output without asking the Provider for another reply', async () => {
  const fixture = harness([
    modelTools([toolCall(0, 'call-visible', 'visible')])
  ])
  fixture.tools.outcomes.set('call-visible', success('已发送', 'visible'))

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.equal(result.runId, 'run-1')
  assert.equal(result.runRef, '1'.repeat(32))
  assert.deepEqual(
    result.kind === 'completed' ? result.completion : null,
    { kind: 'already_visible', source: 'tool_output' }
  )
  assert.equal(result.kind === 'completed' ? result.output : undefined, null)
  assert.deepEqual(
    result.kind === 'completed'
      ? result.presentationTrace.segments.map(segment => segment.kind === 'tool'
        ? { kind: segment.kind, toolName: segment.toolName, result: segment.resultSummary }
        : { kind: segment.kind })
      : null,
    [{ kind: 'tool', toolName: 'visible', result: '结果已通过工具发送' }]
  )
  assert.equal(fixture.adapter.requests.length, 1)
  const checkpoint = terminalSnapshot(result)
  assert.notEqual(checkpoint, null)
  if (checkpoint === null) throw new TypeError('terminal snapshot is missing')
  assert.deepEqual({
    providerAttempts: checkpoint.counters.providerAttempts,
    toolAttempts: checkpoint.counters.toolAttempts,
    toolCalls: checkpoint.counters.toolCalls
  }, { providerAttempts: 1, toolAttempts: 1, toolCalls: 1 })
})

test('RunEngine counts actual scheduler attempts instead of inferring from the final tool result', async () => {
  const candidates: TraceCandidateV1[] = []
  const fixture = harness([
    modelTools([toolCall(0, 'call-retry', 'normalRead')]),
    modelText('重试后完成')
  ], {
    monotonicNow: sequenceClock(0, 1, 3, 8, 11, 20),
    toolMonotonicNow: sequenceClock(0, 2, 3, 7),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })
  fixture.tools.scriptedOutcomes.set('call-retry', [
    retryableFailure(),
    success('second attempt')
  ])

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '重试后完成')
  const checkpoint = terminalSnapshot(result)
  assert.deepEqual(checkpoint === null ? null : {
    providerAttempts: checkpoint.counters.providerAttempts,
    modelTurns: checkpoint.counters.modelTurns,
    toolCalls: checkpoint.counters.toolCalls,
    toolAttempts: checkpoint.counters.toolAttempts,
    engineActiveDurationMs: checkpoint.counters.engineActiveDurationMs
  }, {
    providerAttempts: 2,
    modelTurns: 2,
    toolCalls: 1,
    toolAttempts: 2,
    engineActiveDurationMs: 20
  })
  assert.deepEqual(candidates[0]?.metricSummary.toolExecutions.map(row => ({
    outcome: row.outcome,
    count: row.count,
    durationCount: row.duration.count
  })), [
    { outcome: 'failed', count: 1, durationCount: 1 },
    { outcome: 'succeeded', count: 1, durationCount: 1 }
  ])
})

test('RunEngine preserves exact counters and cumulative engine time across approval pause and resume', async () => {
  const candidates: TraceCandidateV1[] = []
  const fixture = harness([
    modelTools([toolCall(0, 'call-approved', 'sideEffect')]),
    modelText('审批后完成')
  ], {
    monotonicNow: sequenceClock(0, 1, 2, 10, 20, 21, 23, 30),
    toolMonotonicNow: sequenceClock(0, 4),
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })
  fixture.tools.approvalCalls.add('call-approved')

  const paused = await fixture.engine.start(fixture.input)
  assert.equal(paused.kind, 'paused')
  if (paused.kind !== 'paused') throw new TypeError('approval fixture did not pause')
  const displayed = await fixture.engine.displayApproval({
    runId: paused.runId,
    approvalId: paused.interruption.approvalId,
    messageId: 'approval-message-private-id',
    displayedAt: timestamp,
    ttlSeconds: 60
  })
  assert.notEqual(displayed, null)

  const result = await fixture.engine.decideApproval({
    runId: paused.runId,
    approvalId: paused.interruption.approvalId,
    kind: 'approved',
    decidedAt: timestamp,
    sessionAddress: fixture.input.sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'bot_master' })
  })

  assert.equal(result?.kind, 'completed')
  assert.equal(result === null ? null : outputText(result), '审批后完成')
  const checkpoint = result === null ? null : terminalSnapshot(result)
  assert.deepEqual(checkpoint === null ? null : {
    providerAttempts: checkpoint.counters.providerAttempts,
    modelTurns: checkpoint.counters.modelTurns,
    toolCalls: checkpoint.counters.toolCalls,
    toolAttempts: checkpoint.counters.toolAttempts,
    approvalRequests: checkpoint.counters.approvalRequests,
    toolDenied: checkpoint.counters.toolDenied,
    engineActiveDurationMs: checkpoint.counters.engineActiveDurationMs
  }, {
    providerAttempts: 2,
    modelTurns: 2,
    toolCalls: 1,
    toolAttempts: 1,
    approvalRequests: 1,
    toolDenied: 0,
    engineActiveDurationMs: 20
  })
  assert.deepEqual(candidates[0]?.metricSummary.approvals, [
    { decision: 'approved', count: 1 },
    { decision: 'requested', count: 1 }
  ])
})

test('RunEngine engine duration is the invocation wall span, not parallel attempt durations summed', async () => {
  const fixture = harness([
    modelTools([
      toolCall(0, 'call-parallel-0', 'fastRead'),
      toolCall(1, 'call-parallel-1', 'slowRead')
    ]),
    modelText('并行完成')
  ], {
    monotonicNow: sequenceClock(0, 1, 2, 5, 6, 20),
    toolMonotonicNow: sequenceClock(0, 1, 100, 101)
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  const checkpoint = terminalSnapshot(result)
  assert.equal(
    checkpoint?.counters.engineActiveDurationMs ?? null,
    20
  )
  assert.equal(
    checkpoint?.counters.toolAttempts ?? null,
    2
  )
})

test('RunEngine rejects a whole over-budget batch before preparing any capability and corrects once', async () => {
  const calls = Array.from({ length: 9 }, (_, index) => (
    toolCall(index, `call-${index}`, 'normalRead')
  ))
  const fixture = harness([modelTools(calls), modelText('预算说明')])

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '预算说明')
  assert.equal(fixture.tools.preparations, 0)
  assert.equal(fixture.tools.executions, 0)
  assert.equal(fixture.adapter.requests[1]?.toolMode, 'disabled')
  const checkpoint = terminalSnapshot(result)
  assert.equal(checkpoint?.counters.toolCalls, 9)
  assert.equal(checkpoint?.counters.toolAttempts, 0)
})

test('RunEngine keeps provider retry, context recovery and correction counters separate', async () => {
  const retryable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const retryCandidates: TraceCandidateV1[] = []
  const retry = harness([retryable, modelText('重试成功')], {
    onCommittedTraceCandidate: candidate => { retryCandidates.push(candidate) }
  })
  const retryResult = await retry.engine.start(retry.input)
  assert.equal(outputText(retryResult), '重试成功')
  const retried = terminalSnapshot(retryResult)
  assert.deepEqual({
    provider: retried?.counters.providerRetries,
    recovery: retried?.counters.recoveryAttempts,
    correction: retried?.counters.correctionTurns,
    providerAttempts: retried?.counters.providerAttempts ?? null,
    providerUsage: retried?.counters.providerTotalTokens ?? null
  }, {
    provider: 1,
    recovery: 0,
    correction: 0,
    providerAttempts: 2,
    providerUsage: 'unavailable'
  })
  assert.deepEqual(retried === null ? null : {
    modelTurns: retried.counters.modelTurns,
    providerRetries: retried.counters.providerRetries,
    recoveryAttempts: retried.counters.recoveryAttempts,
    correctionTurns: retried.counters.correctionTurns
  }, {
    modelTurns: 1,
    providerRetries: 1,
    recoveryAttempts: 0,
    correctionTurns: 0
  })
  assert.deepEqual(retryCandidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count
  })), [
    { outcome: 'failed', attemptKind: 'primary', count: 1 },
    { outcome: 'succeeded', attemptKind: 'retry', count: 1 }
  ])

  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  let recoveries = 0
  const recoveredCandidates: TraceCandidateV1[] = []
  const recoveryJournal: RunContentJournalEvent[] = []
  const recovered = harness([
    legacyContext,
    modelTools([toolCall(0, 'recovered-tool', 'normalRead')]),
    retryable,
    modelText('恢复成功')
  ], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    onCommittedTraceCandidate: candidate => { recoveredCandidates.push(candidate) },
    contentJournal: { record: event => { recoveryJournal.push(event) } },
    recoverContext: async () => {
      recoveries += 1
      return Object.freeze({
        messages: Object.freeze([{ role: 'user' as const, content: '精简后的请求' }]),
        estimatedInputTokens: 8
      })
    }
  })
  const recoveredResult = await recovered.engine.start(recovered.input)
  assert.equal(outputText(recoveredResult), '恢复成功')
  const checkpoint = terminalSnapshot(recoveredResult)
  assert.equal(recoveries, 1)
  assert.deepEqual({
    provider: checkpoint?.counters.providerRetries,
    recovery: checkpoint?.counters.recoveryAttempts,
    correction: checkpoint?.counters.correctionTurns
  }, { provider: 1, recovery: 1, correction: 0 })
  assert.deepEqual(checkpoint === null ? null : {
    providerAttempts: checkpoint.counters.providerAttempts,
    modelTurns: checkpoint.counters.modelTurns,
    providerRetries: checkpoint.counters.providerRetries,
    recoveryAttempts: checkpoint.counters.recoveryAttempts,
    correctionTurns: checkpoint.counters.correctionTurns
  }, {
    providerAttempts: 4,
    modelTurns: 2,
    providerRetries: 1,
    recoveryAttempts: 1,
    correctionTurns: 0
  })
  assert.deepEqual(recoveredCandidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count
  })), [
    { outcome: 'failed', attemptKind: 'primary', count: 2 },
    { outcome: 'succeeded', attemptKind: 'recovery', count: 1 },
    { outcome: 'succeeded', attemptKind: 'retry', count: 1 }
  ])
  assert.deepEqual(recoveryJournal
    .filter(isProviderJournalEvent)
    .map(event => ({ type: event.type, ordinal: event.ordinal, kind: event.attemptKind })), [
    { type: 'provider.request', ordinal: 1, kind: 'primary' },
    { type: 'provider.failure', ordinal: 1, kind: 'primary' },
    { type: 'provider.request', ordinal: 2, kind: 'recovery' },
    { type: 'provider.response', ordinal: 2, kind: 'recovery' },
    { type: 'provider.request', ordinal: 3, kind: 'primary' },
    { type: 'provider.failure', ordinal: 3, kind: 'primary' },
    { type: 'provider.request', ordinal: 4, kind: 'retry' },
    { type: 'provider.response', ordinal: 4, kind: 'retry' }
  ])
})

test('RunEngine recalculates output capacity after legacy context recovery', async () => {
  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  const fixture = harness([legacyContext, modelText('恢复后完成')], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '接近容量的旧上下文' }]),
      estimatedInputTokens: 27_647
    }),
    recoverContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '精简后的请求' }]),
      estimatedInputTokens: 8
    })
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '恢复后完成')
  assert.deepEqual(fixture.adapter.requests.map(request => request.maxOutputTokens), [1, 256])
})

test('RunEngine persists recovered output capacity across a process restart', async () => {
  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  const store = new RecoveryCommitCrashStore()
  const runtimeOptions = {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '接近容量的旧上下文' }]),
      estimatedInputTokens: 27_647
    }),
    recoverContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '精简后的请求' }]),
      estimatedInputTokens: 8
    })
  }
  const crashed = harness([legacyContext], { ...runtimeOptions, store })

  await assert.rejects(crashed.engine.start(crashed.input), SimulatedProcessCrash)
  store.restoreProcess()

  const resumed = harness([modelText('重启后恢复完成')], { ...runtimeOptions, store })
  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '重启后恢复完成')
  assert.equal(resumed.adapter.requests.length, 1)
  assert.equal(resumed.adapter.requests[0]?.maxOutputTokens, 256)
})

test('RunEngine preserves a pending retry attempt kind across process restart', async () => {
  const store = new RetryReservationCrashStore()
  const unavailable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const crashed = harness([unavailable], { store })

  await assert.rejects(
    crashed.engine.start(crashed.input),
    SimulatedProcessCrash
  )
  store.restoreProcess()

  const candidates: TraceCandidateV1[] = []
  const journalEvents: RunContentJournalEvent[] = []
  const resumed = harness([modelText('重启后重试成功')], {
    store,
    contentJournal: { record: event => { journalEvents.push(event) } },
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })
  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '重启后重试成功')
  assert.deepEqual(candidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count
  })), [
    { outcome: 'failed', attemptKind: 'primary', count: 1 },
    { outcome: 'succeeded', attemptKind: 'retry', count: 1 }
  ])
  assert.deepEqual(journalEvents
    .filter(event => event.type === 'provider.request' || event.type === 'provider.response')
    .map(event => ({
      type: event.type,
      runRef: event.runRef,
      requestRef: event.requestRef,
      ordinal: event.ordinal,
      attemptKind: event.attemptKind
    })), [
    {
      type: 'provider.request',
      runRef: resumed.input.runRef,
      requestRef: resumed.input.requestRef,
      ordinal: 2,
      attemptKind: 'retry'
    },
    {
      type: 'provider.response',
      runRef: resumed.input.runRef,
      requestRef: resumed.input.requestRef,
      ordinal: 2,
      attemptKind: 'retry'
    }
  ])
})

test('RunEngine skips Provider journal attempts when a recovered ordinal is unavailable', async () => {
  const crashStore = new RetryReservationCrashStore()
  const unavailable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const crashed = harness([unavailable], { store: crashStore })
  await assert.rejects(crashed.engine.start(crashed.input), SimulatedProcessCrash)
  const loaded = await crashStore.load('run-1')
  assert.equal(loaded?.schemaVersion, 4)
  if (loaded?.schemaVersion !== 4) throw new TypeError('recovered checkpoint is missing')

  const recovered = parseRunCheckpoint({
    ...loaded,
    observationCounters: {
      ...loaded.observationCounters,
      providerAttempts: 'unavailable'
    }
  })
  const store = new InMemoryRunStore()
  store.seedLoadedCheckpoint(recovered)
  const journalEvents: RunContentJournalEvent[] = []
  const resumed = harness([modelText('不可用序号仍可完成')], {
    store,
    contentJournal: { record: event => { journalEvents.push(event) } }
  })

  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '不可用序号仍可完成')
  assert.equal(resumed.adapter.requests.length, 1)
  assert.deepEqual(journalEvents.filter(isProviderJournalEvent), [])
  assert.equal(journalEvents.filter(event => event.type === 'run.terminal_committed').length, 1)
})

test('RunEngine keeps a recovered run on its frozen legacy token budget', async () => {
  const currentBudget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 256
  })
  const fixture = harness([modelText('不应执行')])
  const checkpoint = createInitialRunCheckpoint({
    profileId: standardOpenAIProfile.id,
    profileVersion: standardOpenAIProfile.version,
    runId: fixture.input.runId,
    sessionId: fixture.input.sessionId,
    sessionAddress: fixture.input.sessionAddress,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    requestKind: fixture.input.requestKind,
    presentationRoute: fixture.input.presentationRoute,
    observationPolicy: fixture.input.observationPolicy,
    model: fixture.input.model,
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: fixture.input.runtime.snapshot.id,
      fingerprint: fixture.input.runtime.snapshot.fingerprint,
      manifest: fixture.input.runtime.snapshot.manifest
    }),
    budgetLimits: Object.freeze({
      ...currentBudget.limits,
      maxEstimatedTokens: 49_152 as const
    }),
    budgetCounters: Object.freeze({
      ...currentBudget.initialCounters,
      estimatedTokens: 49_152
    }),
    deadlineAt: fixture.input.deadlineAt,
    createdAt: timestamp,
    event: createRunEvent({
      eventId: 'legacy-budget-created',
      runId: fixture.input.runId,
      sessionId: fixture.input.sessionId,
      sequence: 0,
      occurredAt: timestamp,
      type: 'run.created',
      payload: Object.freeze({})
    })
  })
  const store = new InMemoryRunStore()
  store.seedLoadedCheckpoint(checkpoint)
  const resumed = harness([modelText('不应执行')], { store })

  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'run_budget_exceeded')
  assert.equal(resumed.adapter.requests.length, 0)
})

test('RunEngine clamps a recovered legacy run to its remaining token budget', async () => {
  const currentBudget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 256
  })
  const fixture = harness([modelText('旧运行仍可完成')], {
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '旧运行请求' }]),
      estimatedInputTokens: 100
    })
  })
  const checkpoint = createInitialRunCheckpoint({
    profileId: standardOpenAIProfile.id,
    profileVersion: standardOpenAIProfile.version,
    runId: fixture.input.runId,
    sessionId: fixture.input.sessionId,
    sessionAddress: fixture.input.sessionAddress,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    requestKind: fixture.input.requestKind,
    presentationRoute: fixture.input.presentationRoute,
    observationPolicy: fixture.input.observationPolicy,
    model: fixture.input.model,
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: fixture.input.runtime.snapshot.id,
      fingerprint: fixture.input.runtime.snapshot.fingerprint,
      manifest: fixture.input.runtime.snapshot.manifest
    }),
    budgetLimits: Object.freeze({
      ...currentBudget.limits,
      maxEstimatedTokens: 49_152 as const
    }),
    budgetCounters: Object.freeze({
      ...currentBudget.initialCounters,
      estimatedTokens: 49_000
    }),
    deadlineAt: fixture.input.deadlineAt,
    createdAt: timestamp,
    event: createRunEvent({
      eventId: 'legacy-partial-budget-created',
      runId: fixture.input.runId,
      sessionId: fixture.input.sessionId,
      sequence: 0,
      occurredAt: timestamp,
      type: 'run.created',
      payload: Object.freeze({})
    })
  })
  const store = new InMemoryRunStore()
  store.seedLoadedCheckpoint(checkpoint)
  const resumed = harness([modelText('旧运行仍可完成')], {
    store,
    prepareContext: fixture.input.runtime.prepareContext
  })

  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '旧运行仍可完成')
  assert.equal(resumed.adapter.requests.length, 1)
  assert.equal(resumed.adapter.requests[0]?.maxOutputTokens, 52)
})

test('RunEngine enters the fourth Provider call for the production multi-stage token sequence', async () => {
  const currentBudget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })
  const fixture = harness([modelText('最终总结完成')], { maxOutputTokens: 4_096 })
  const created = createInitialRunCheckpoint({
    profileId: standardOpenAIProfile.id,
    profileVersion: standardOpenAIProfile.version,
    runId: fixture.input.runId,
    sessionId: fixture.input.sessionId,
    sessionAddress: fixture.input.sessionAddress,
    runRef: fixture.input.runRef,
    requestRef: fixture.input.requestRef,
    requestKind: fixture.input.requestKind,
    presentationRoute: fixture.input.presentationRoute,
    observationPolicy: fixture.input.observationPolicy,
    model: fixture.input.model,
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: fixture.input.runtime.snapshot.id,
      fingerprint: fixture.input.runtime.snapshot.fingerprint,
      manifest: fixture.input.runtime.snapshot.manifest
    }),
    budgetLimits: currentBudget.limits,
    budgetCounters: currentBudget.initialCounters,
    deadlineAt: fixture.input.deadlineAt,
    createdAt: timestamp,
    event: createRunEvent({
      eventId: 'production-sequence-created',
      runId: fixture.input.runId,
      sessionId: fixture.input.sessionId,
      sequence: 0,
      occurredAt: timestamp,
      type: 'run.created',
      payload: Object.freeze({})
    })
  })
  const prepared = nextRunCheckpoint(created, 'preparing', {
    messages: Object.freeze([{ role: 'user' as const, content: '生成最终总结' }]),
    estimatedInputTokens: 7_660,
    budgetCounters: Object.freeze({
      ...currentBudget.initialCounters,
      modelTurns: 3,
      estimatedTokens: 42_192
    })
  }, [
    createRunEvent({
      eventId: 'production-sequence-started',
      runId: fixture.input.runId,
      sessionId: fixture.input.sessionId,
      sequence: 1,
      occurredAt: timestamp,
      type: 'run.started',
      payload: Object.freeze({})
    }),
    createRunEvent({
      eventId: 'production-sequence-prepared',
      runId: fixture.input.runId,
      sessionId: fixture.input.sessionId,
      sequence: 2,
      occurredAt: timestamp,
      type: 'context.prepared',
      payload: Object.freeze({ messageCount: 1, estimatedInputTokens: 7_660 })
    })
  ], timestamp)
  const store = new TerminalCaptureStore()
  store.seedLoadedCheckpoint(prepared)
  const resumed = harness([modelText('最终总结完成')], {
    store,
    maxOutputTokens: 4_096
  })

  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '最终总结完成')
  assert.equal(resumed.adapter.requests.length, 1)
  assert.equal(resumed.adapter.requests[0]?.maxOutputTokens, 4_096)
  assert.equal(store.terminalCheckpoint?.budgetCounters.modelTurns, 4)
  assert.equal(store.terminalCheckpoint?.budgetCounters.estimatedTokens, 53_948)
})

test('RunEngine rejects a normal turn with no context output capacity before Provider', async () => {
  const fixture = harness([modelText('不应执行')], {
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '超长请求' }]),
      estimatedInputTokens: 27_648
    })
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'context_budget_exceeded')
  assert.equal(fixture.adapter.requests.length, 0)
  assert.equal(fixture.events.includes('model.started'), false)
  assert.equal(terminalSnapshot(result)?.counters.modelTurns, 0)
})

test('RunEngine only reserves tool schema capacity for normal turns', async () => {
  const fixture = harness([modelText(''), modelText('纠错完成')], {
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '接近容量的请求' }]),
      estimatedInputTokens: 27_647
    })
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '纠错完成')
  assert.deepEqual(fixture.adapter.requests.map(request => ({
    toolMode: request.toolMode,
    maxOutputTokens: request.maxOutputTokens
  })), [
    { toolMode: 'auto', maxOutputTokens: 1 },
    { toolMode: 'disabled', maxOutputTokens: 256 }
  ])
})

test('RunEngine persists completed tool evidence when the next model turn has no capacity', async () => {
  const store = new TerminalCaptureStore()
  const fixture = harness([
    modelTools([toolCall(0, 'capacity-tool-1', 'normalRead')])
  ], {
    store,
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '接近容量的工具请求' }]),
      estimatedInputTokens: 27_647
    })
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'context_budget_exceeded')
  assert.equal(fixture.adapter.requests.length, 1)
  assert.equal(fixture.tools.executions, 1)
  assert.equal(fixture.events.includes('tool.attempted'), true)
  assert.equal(fixture.events.includes('tool.completed'), true)
  assert.equal(terminalSnapshot(result)?.counters.toolAttempts, 1)
  const terminal = store.terminalCheckpoint
  const completedCall = terminal?.toolLedgers.at(-1)?.calls[0]
  assert.equal(terminal?.status, 'failed')
  assert.equal(completedCall?.status, 'succeeded')
  assert.deepEqual(completedCall?.result, success('capacity-tool-1'))
  const toolMessage = terminal?.messages.find(message => (
    message.role === 'tool' && message.toolCallId === 'capacity-tool-1'
  ))
  assert.equal(toolMessage?.role, 'tool')
  assert.match(toolMessage?.content ?? '', /capacity-tool-1/)
})

test('RunEngine keeps a stable DeepSeek cache prefix across tool turns', async () => {
  const fixture = harness([
    deepSeekModelTools(
      [toolCall(0, 'cache-call-1', 'normalRead', '第一阶段')],
      '第一阶段推理'
    ),
    deepSeekModelTools(
      [toolCall(0, 'cache-call-2', 'normalRead', '第二阶段')],
      '第二阶段推理'
    ),
    modelText('多阶段任务完成')
  ], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(outputText(result), '多阶段任务完成')
  assert.equal(fixture.adapter.requests.length, 3)
  for (let index = 1; index < fixture.adapter.requests.length; index += 1) {
    const previous = fixture.adapter.requests[index - 1]
    const current = fixture.adapter.requests[index]
    assert.deepEqual(
      current?.messages.slice(0, previous?.messages.length),
      previous?.messages
    )
  }
  assert.equal(fixture.tools.executions, 2)
  assert.deepEqual(fixture.tools.startedCalls, ['cache-call-1', 'cache-call-2'])
})

test('RunEngine preserves recovery then retry attempt kinds across process restart', async () => {
  const store = new RetryReservationCrashStore()
  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  const unavailable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const runtimeOptions = {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    recoverContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '精简后的请求' }]),
      estimatedInputTokens: 8
    })
  }
  const crashed = harness([legacyContext, unavailable], {
    ...runtimeOptions,
    store
  })

  await assert.rejects(
    crashed.engine.start(crashed.input),
    SimulatedProcessCrash
  )
  store.restoreProcess()

  const candidates: TraceCandidateV1[] = []
  const resumed = harness([modelText('重启后恢复重试成功')], {
    ...runtimeOptions,
    store,
    onCommittedTraceCandidate: candidate => { candidates.push(candidate) }
  })
  const result = await resumed.engine.resume('run-1', resumed.input.runtime)

  assert.equal(outputText(result), '重启后恢复重试成功')
  assert.deepEqual(candidates[0]?.metricSummary.providerRequests.map(row => ({
    outcome: row.outcome,
    attemptKind: row.attemptKind,
    count: row.count
  })), [
    { outcome: 'failed', attemptKind: 'primary', count: 1 },
    { outcome: 'failed', attemptKind: 'recovery', count: 1 },
    { outcome: 'succeeded', attemptKind: 'retry', count: 1 }
  ])
})

test('RunEngine preserves the allowed retry count and the final provider error after exhaustion', async () => {
  const unavailable = (): ModelProviderError => new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const fixture = harness([unavailable(), unavailable()], {
    monotonicNow: sequenceClock(0, 1, 3, 5, 8, 10)
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_unavailable')
  assert.equal(fixture.adapter.requests.length, 2)
  const checkpoint = terminalSnapshot(result)
  assert.equal(checkpoint?.counters.providerRetries, 1)
  assert.deepEqual(checkpoint === null ? null : {
    providerAttempts: checkpoint.counters.providerAttempts,
    modelTurns: checkpoint.counters.modelTurns,
    providerRetries: checkpoint.counters.providerRetries,
    providerInputTokens: checkpoint.counters.providerInputTokens,
    providerOutputTokens: checkpoint.counters.providerOutputTokens,
    providerTotalTokens: checkpoint.counters.providerTotalTokens,
    providerActiveDurationMs: checkpoint.counters.providerActiveDurationMs,
    engineActiveDurationMs: checkpoint.counters.engineActiveDurationMs
  }, {
    providerAttempts: 2,
    modelTurns: 0,
    providerRetries: 1,
    providerInputTokens: 'unavailable',
    providerOutputTokens: 'unavailable',
    providerTotalTokens: 'unavailable',
    providerActiveDurationMs: 5,
    engineActiveDurationMs: 10
  })
})

test('RunEngine never applies legacy context recovery after a tool has been prepared', async () => {
  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  let recoveries = 0
  const fixture = harness([
    modelTools([toolCall(0, 'call-0', 'normalRead')]),
    legacyContext
  ], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    recoverContext: async () => {
      recoveries += 1
      return Object.freeze({ messages: Object.freeze([]), estimatedInputTokens: 0 })
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_invalid_request')
  assert.equal(recoveries, 0)
  assert.equal(terminalSnapshot(result)?.counters.recoveryAttempts, 0)
})

test('RunEngine cancels an expired deadline before any Provider call', async () => {
  const fixture = harness([modelText('不应执行')], {
    now: () => new Date('2026-07-14T00:04:00.000Z')
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'cancelled')
  assert.equal(result.runId, 'run-1')
  assert.equal(result.runRef, '1'.repeat(32))
  assert.equal(result.kind === 'cancelled' ? result.reason : null, 'deadline_exceeded')
  assert.equal(terminalSnapshot(result)?.status, 'cancelled')
  assert.equal(fixture.adapter.requests.length, 0)
})

test('RunEngine aborts the run signal when a fatal preparation error wins', async () => {
  let runSignal: AbortSignal | undefined
  const fixture = harness([], {
    prepareContext: async signal => {
      runSignal = signal
      throw new Error('fatal context fixture')
    }
  })

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(runSignal?.aborted, true)
  assert.equal(runSignal?.reason, 'fatal_error')
  assert.equal(fixture.adapter.requests.length, 0)
})

test('RunEngine cancellation wins over a late Provider result and suppresses terminal callbacks', async () => {
  const pendingTurn = deferred<ModelTurn>()
  const started = deferred<void>()
  const journalEvents: RunContentJournalEvent[] = []
  const fixture = harness([
    async () => {
      started.resolve()
      return await pendingTurn.promise
    }
  ], {
    contentJournal: { record: event => { journalEvents.push(event) } }
  })
  const running = fixture.engine.start(fixture.input)
  await started.promise

  const cancelled = await fixture.engine.cancel('run-1', 'user_cancelled')
  const result = await running
  assert.equal(cancelled.kind, 'cancelled')
  assert.equal(result.kind, 'cancelled')
  assert.equal(result.kind === 'cancelled' ? result.reason : null, 'user_cancelled')
  assert.equal(result.runRef, '1'.repeat(32))
  assert.equal(result.kind === 'cancelled' ? result.terminal : undefined, null)
  assert.notEqual(terminalSnapshot(cancelled), null)

  pendingTurn.resolve(modelText('迟到结果'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await fixture.store.load('run-1'), null)
  const checkpoint = terminalSnapshot(cancelled)
  assert.deepEqual(checkpoint === null ? null : {
    providerAttempts: checkpoint.counters.providerAttempts,
    providerRetries: checkpoint.counters.providerRetries,
    recoveryAttempts: checkpoint.counters.recoveryAttempts,
    correctionTurns: checkpoint.counters.correctionTurns,
    providerInputTokens: checkpoint.counters.providerInputTokens,
    providerOutputTokens: checkpoint.counters.providerOutputTokens,
    providerTotalTokens: checkpoint.counters.providerTotalTokens,
    providerActiveDurationMs: checkpoint.counters.providerActiveDurationMs,
    modelTurns: checkpoint.counters.modelTurns,
    toolAttempts: checkpoint.counters.toolAttempts,
    engineActiveDurationMs: checkpoint.counters.engineActiveDurationMs
  }, {
    providerAttempts: 'unavailable',
    providerRetries: 'unavailable',
    recoveryAttempts: 'unavailable',
    correctionTurns: 'unavailable',
    providerInputTokens: 'unavailable',
    providerOutputTokens: 'unavailable',
    providerTotalTokens: 'unavailable',
    providerActiveDurationMs: 'unavailable',
    modelTurns: 'unavailable',
    toolAttempts: 'unavailable',
    engineActiveDurationMs: 'unavailable'
  })
  assert.equal(fixture.events.includes('run.completed'), false)
  assert.equal(fixture.events.filter(type => type === 'run.cancelled').length, 1)
  const failure = journalEvents.find(event => event.type === 'provider.failure')
  assert.equal(failure?.type === 'provider.failure' ? failure.error.code : null, 'cancelled')
})

test('RunEngine marks an in-flight side effect indeterminate when cancellation wins', async () => {
  const toolResult = deferred<ToolResult>()
  const started = deferred<void>()
  const fixture = harness([
    modelTools([toolCall(0, 'call-side-effect', 'sideEffect')])
  ])
  fixture.tools.deferredOutcomes.set('call-side-effect', toolResult)
  fixture.tools.onStarted = () => started.resolve()
  const running = fixture.engine.start(fixture.input)
  await started.promise

  const cancelled = await fixture.engine.cancel('run-1', 'user_cancelled')
  const result = await running
  assert.equal(result.kind, 'cancelled')
  const checkpoint = terminalSnapshot(cancelled)
  assert.deepEqual(checkpoint === null ? null : {
    toolAttempts: checkpoint.counters.toolAttempts,
    toolIndeterminate: checkpoint.counters.toolIndeterminate,
    modelTurns: checkpoint.counters.modelTurns,
    engineActiveDurationMs: checkpoint.counters.engineActiveDurationMs
  }, {
    toolAttempts: 'unavailable',
    toolIndeterminate: 1,
    modelTurns: 'unavailable',
    engineActiveDurationMs: 'unavailable'
  })

  toolResult.resolve(success('迟到副作用'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await fixture.store.load('run-1'), null)
})

test('RunEngine does not call an unstarted side effect indeterminate on cancellation', async () => {
  const contextEntered = deferred<void>()
  const freshContext = deferred<ToolExecutionContext>()
  const fixture = harness([
    modelTools([toolCall(0, 'call-side-effect', 'sideEffect')])
  ], {
    contextFor: async () => {
      contextEntered.resolve()
      return await freshContext.promise
    }
  })
  const running = fixture.engine.start(fixture.input)
  await contextEntered.promise

  const cancelled = await fixture.engine.cancel('run-1', 'user_cancelled')
  const result = await running

  assert.equal(result.kind, 'cancelled')
  assert.equal(fixture.tools.executions, 0)
  const cancelledCheckpoint = terminalSnapshot(cancelled)
  assert.equal(
    cancelledCheckpoint?.counters.toolAttempts ?? null,
    'unavailable'
  )
  freshContext.resolve(execution())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.tools.executions, 0)
})
