import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { ModelProviderError } from '../../src/agent/model/model-adapter.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  nextRunCheckpoint,
  parseRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import {
  RunEngine,
  type RunEngineOptions,
  type StartRunInput
} from '../../src/agent/run/run-engine.js'
import { createRunTerminalSnapshot } from '../../src/agent/run/run-observation.js'
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

function modelText (text: string): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([]),
    finishReason: 'stop'
  })
}

function modelTools (
  calls: readonly ModelTurn['toolCalls'][number][],
  text = '内部过程正文'
): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([...calls]),
    finishReason: 'tool_calls'
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
  readonly prepareContext?: StartRunInput['runtime']['prepareContext']
  readonly recoverContext?: StartRunInput['runtime']['recoverContext']
  readonly contextFor?: StartRunInput['runtime']['contextFor']
  readonly now?: () => Date
  readonly store?: RunStore
  readonly monotonicNow?: () => number
  readonly toolMonotonicNow?: () => number
  readonly onCommittedTraceCandidate?: RunEngineOptions['onCommittedTraceCandidate']
  readonly onTraceCandidateProjectionFailure?: RunEngineOptions['onTraceCandidateProjectionFailure']
}

function harness (
  items: readonly ScriptedItem[],
  options: HarnessOptions = {}
) {
  const adapter = new ScriptedAdapter(items)
  const tools = new ScriptedToolRuntime()
  const store = options.store ?? new InMemoryRunStore()
  const events: string[] = []
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
    budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
    now: options.now ?? (() => new Date(timestamp)),
    ...(options.monotonicNow === undefined
      ? {}
      : { monotonicNow: options.monotonicNow }),
    generateId: () => `generated-${++id}`,
    observer: event => { events.push(event.type) },
    ...(options.onCommittedTraceCandidate === undefined
      ? {}
      : { onCommittedTraceCandidate: options.onCommittedTraceCandidate }),
    ...(options.onTraceCandidateProjectionFailure === undefined
      ? {}
      : { onTraceCandidateProjectionFailure: options.onTraceCandidateProjectionFailure })
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
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
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
  return { adapter, tools, store, events, engine, input }
}

class TerminalRaceRunStore implements RunStore {
  readonly base = new InMemoryRunStore()
  injected = false
  readonly #phase: 'provider_reservation' | 'dispatch_completion' | 'terminal_commit'

  constructor (phase: 'provider_reservation' | 'dispatch_completion' | 'terminal_commit') {
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
    const completion = expected.status === 'calling_model' &&
      expected.providerDispatch.state === 'reserved' &&
      next.status === expected.status &&
      next.providerDispatch.state === 'idle'
    const shouldInject = this.#phase === 'provider_reservation'
      ? reservation
      : completion
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
  let fixture: ReturnType<typeof harness>
  fixture = harness([async () => {
    const reserved = await fixture.store.load('run-1')
    assert.equal(reserved?.schemaVersion, 2)
    if (reserved?.schemaVersion !== 2) throw new TypeError('reserved checkpoint is missing')
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
  }])

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
})

test('RunEngine returns a concurrent terminal before Provider wire when dispatch reservation CAS loses', async () => {
  const store = new TerminalRaceRunStore('provider_reservation')
  const fixture = harness([modelText('不应调用 Provider')], { store })

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
  assert.deepEqual(fixture.events, [
    'run.created', 'run.started', 'context.prepared', 'model.started'
  ])
})

test('RunEngine stops model completion evaluation when dispatch-completion CAS loses to a terminal', async () => {
  const store = new TerminalRaceRunStore('dispatch_completion')
  let modelEvaluationReads = 0
  const providerTurn: ModelTurn = Object.freeze({
    text: 'wire 已完成但不应继续求值',
    toolCalls: Object.freeze([]),
    get finishReason (): ModelTurn['finishReason'] {
      modelEvaluationReads += 1
      return 'stop'
    }
  })
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
  assert.equal(modelEvaluationReads, 0)
  assert.equal(fixture.tools.preparations, 0)
  assert.equal(fixture.tools.executions, 0)
  assert.equal(fixture.events.includes('model.completed'), false)
  assert.equal(fixture.events.some(event => event.startsWith('tool.')), false)
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
  const empty = harness([modelText(''), modelText('纠正后的回答')], {
    onCommittedTraceCandidate: candidate => { correctedCandidates.push(candidate) }
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
  const recovered = harness([
    legacyContext,
    modelTools([toolCall(0, 'recovered-tool', 'normalRead')]),
    retryable,
    modelText('恢复成功')
  ], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    onCommittedTraceCandidate: candidate => { recoveredCandidates.push(candidate) },
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
  const resumed = harness([modelText('重启后重试成功')], {
    store,
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
  const fixture = harness([
    async () => {
      started.resolve()
      return await pendingTurn.promise
    }
  ])
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
