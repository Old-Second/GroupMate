import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import { ModelProviderError, type ModelAdapter, type ModelRequest, type ModelTurn } from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { RunAdmission } from '../../src/agent/run/run-admission.js'
import {
  createDefaultRunBudget,
  createLegacyRunBudgetLimits
} from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type RunCheckpoint,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpointV3
} from '../../src/agent/run/run-checkpoint.js'
import { upgradeRunCheckpointV3 } from '../../src/agent/run/run-checkpoint-migration.js'
import {
  RunEngine,
  type RunRuntimeBinding,
  type StartRunInput
} from '../../src/agent/run/run-engine.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import { recordRunUsage } from '../../src/agent/run/run-usage.js'
import { createFrozenObservationPolicy } from '../../src/agent/run/run-observation.js'
import {
  RedisRunStore,
  RUN_STORE_MIGRATION_LUA_MARKER,
  redisRunKeys
} from '../../src/agent/run/redis-run-store.js'
import {
  RunReferenceConflictError,
  RunStoreConflictError,
  type RunStore
} from '../../src/agent/run/run-store.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import { FIXTURE_MODEL_CAPABILITY } from '../helpers/trace-fixture.js'
import { applyToolPreflight, createToolExecutionLedger } from '../../src/agent/run/tool-ledger.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type { ToolExecutionContext, ToolPreparationContext, ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import type { ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'

const timestamp = '2026-07-14T00:00:00.000Z'
const deadlineAt = '2026-07-14T00:04:00.000Z'
const address: SessionAddress = Object.freeze({
  botId: 'bot-private-value',
  scope: Object.freeze({ kind: 'group', groupId: 'group-private-value' })
})
const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-private-value',
  actor: Object.freeze({ userId: 'actor-private-value', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-private-value', groupId: 'group-private-value' }),
  scope: address.scope,
  botGroupRole: 'owner', actorGroupRole: 'owner', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
})

function terminalSnapshot (result: RunAdvanceResult) {
  return result.kind === 'paused' || result.terminal === null
    ? null
    : result.terminal.snapshot
}
const preparation: ToolPreparationContext = Object.freeze({
  runId: 'run-1', profile: 'compatible', facts,
  intent: Object.freeze({
    trustedSources: Object.freeze(['current_request'] as const), actions: Object.freeze([]),
    explicitTargetIds: Object.freeze([]), mentionUserIds: Object.freeze([]),
    currentMessageId: 'message-current', replyMessageId: null
  }),
  now: timestamp
})
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const legacyBudgetLimits = createLegacyRunBudgetLimits(budget.limits)
const emptyManifestFingerprint = createHash('sha256').update('[]').digest('hex')

function runEvent (runId: string, sequence: number, type: 'run.created' | 'run.started' | 'model.started' | 'model.completed' | 'tool.batch_planned' | 'tool.requested' | 'tool.started'): ReturnType<typeof createRunEvent> {
  return createRunEvent({
    eventId: `event-${sequence}`, runId, sessionId: 'session-1', sequence,
    occurredAt: timestamp, type, payload: Object.freeze({})
  })
}

function snapshot (fingerprint = emptyManifestFingerprint): ToolSnapshot {
  const capability = Object.freeze({
    definition: Object.freeze({
      name: 'fixture', version: 1 as const, aliases: Object.freeze([]), description: 'fixture',
      inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false as const }),
      effect: 'read_only' as const, risk: 'low' as const, readOnly: true, destructive: false,
      idempotency: 'none' as const, openWorld: false, timeoutMs: 1_000,
      maxOutputBytes: 4_096, network: 'none' as const, permission: 'any_user' as const,
      executionClass: 'read_only' as const, retrySafe: true,
      resourceKeys: () => Object.freeze(['fixture:000000000000000000000000']),
      resolveTarget: () => Object.freeze({ kind: 'none' as const }),
      execute: async () => success('fixture')
    }),
    canonicalName: 'fixture'
  })
  return Object.freeze({
    id: 'snapshot-1', fingerprint, manifest: Object.freeze([]),
    toolNames: Object.freeze(['fixture']), modelTools: Object.freeze([]),
    resolve: () => capability,
    resolveCall: () => capability
  })
}

function success (text: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'none',
    content: Object.freeze([{ type: 'text' as const, text }]), retryable: false
  })
}

function initial (runId = 'run-1', toolSnapshot = snapshot()): RunCheckpoint {
  const runRef = createHash('sha256').update(`run:${runId}`).digest('hex').slice(0, 32)
  return createInitialRunCheckpoint({
    profileId: 'standard', profileVersion: 1, runId,
    sessionId: 'session-1', sessionAddress: address,
    runRef,
    requestRef: createHash('sha256').update(`request:${runId}`).digest('hex').slice(0, 32),
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      }),
      sessionAddress: address,
      actorId: 'actor-private-value',
      requestMessageId: 'message-current'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic', runRef
    }),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: toolSnapshot.id, fingerprint: toolSnapshot.fingerprint,
      manifest: toolSnapshot.manifest
    }),
    budgetLimits: budget.limits, budgetCounters: budget.initialCounters,
    deadlineAt, createdAt: timestamp, event: runEvent(runId, 0, 'run.created')
  })
}

function legacyCheckpoint (source: RunCheckpoint): RunCheckpointV1 {
  const {
    schemaVersion: _schemaVersion,
    runRef: _runRef,
    requestRef: _requestRef,
    requestKind: _requestKind,
    presentationRoute: _presentationRoute,
    completion: _completion,
    observationCounters: _observationCounters,
    providerDispatch: _providerDispatch,
    engineActivity: _engineActivity,
    observationPolicy: _observationPolicy,
    reasoningSegments: _reasoningSegments,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    ...state
  } = source
  return Object.freeze({
    ...state, schemaVersion: 1, budgetLimits: legacyBudgetLimits, visibleOutput: false
  })
}

function checkpointV2 (source: RunCheckpoint): RunCheckpointV2 {
  const {
    schemaVersion: _schemaVersion,
    reasoningSegments: _reasoningSegments,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 2, budgetLimits: legacyBudgetLimits })
}

function checkpointV3 (source: RunCheckpoint): RunCheckpointV3 {
  const {
    schemaVersion: _schemaVersion,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 3, budgetLimits: legacyBudgetLimits })
}

test('InMemoryRunStore rejects a stale v3 upgrade without rewriting the checkpoint', async () => {
  const store = new InMemoryRunStore()
  const source = checkpointV3(initial('run-v3-upgrade-conflict'))
  store.seedLoadedCheckpoint(source)
  const stale = Object.freeze({
    ...source,
    updatedAt: '2026-07-14T00:00:01.000Z'
  })

  await assert.rejects(
    store.upgrade(stale, upgradeRunCheckpointV3(source)),
    RunStoreConflictError
  )
  await assert.rejects(store.upgrade(source, Object.freeze({
    ...upgradeRunCheckpointV3(source),
    messages: Object.freeze([{ role: 'user' as const, content: 'tampered' }])
  })), RunStoreConflictError)
  assert.deepEqual(await store.load(source.runId), source)
  assert.deepEqual(await store.load(source.runId), source)
})

async function persistLegacy (
  redis: FakeRedis,
  checkpoint: RunCheckpointV1
): Promise<void> {
  const keys = redisRunKeys(checkpoint.runId)
  const { events, ...state } = checkpoint
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 1,
    revision: checkpoint.revision,
    events
  }), { EX: 300 })
}

function callingModelPath (source: RunCheckpoint): readonly RunCheckpoint[] {
  const prepared = nextRunCheckpoint(source, 'preparing', {
    messages: Object.freeze([{ role: 'user' as const, content: '继续任务' }]),
    estimatedInputTokens: 8
  }, [runEvent(source.runId, 1, 'run.started')], timestamp)
  const counters = budget.reserveModelTurn(prepared.budgetCounters, {
    kind: 'normal', estimatedInputTokens: 8, maxOutputTokens: 256
  })
  const calling = nextRunCheckpoint(prepared, 'calling_model', {
    budgetCounters: counters,
    modelTurn: Object.freeze({ kind: 'normal', maxOutputTokens: 256 })
  }, [runEvent(source.runId, 2, 'model.started')], timestamp)
  return Object.freeze([source, prepared, calling])
}

function executingPath (
  source: RunCheckpoint,
  executionClass: SerializablePreparedCapability['executionClass']
): readonly RunCheckpoint[] {
  const callingPath = callingModelPath(source)
  const calling = callingPath.at(-1)
  if (calling === undefined) throw new TypeError('calling checkpoint is missing')
  const call = Object.freeze({
    index: 0, callId: 'call-1', name: 'fixture', argumentsText: '{}',
    arguments: Object.freeze({})
  })
  const ledger = createToolExecutionLedger(0, [call])
  const assistant = Object.freeze({
    role: 'assistant' as const, content: null,
    toolCalls: Object.freeze([{ callId: 'call-1', name: 'fixture', arguments: Object.freeze({}) }])
  })
  const evaluating = nextRunCheckpoint(calling, 'evaluating_tools', {
    messages: Object.freeze([...calling.messages, assistant]),
    modelTurn: null,
    toolLedgers: Object.freeze([ledger])
  }, [
    runEvent(source.runId, 3, 'model.completed'),
    runEvent(source.runId, 4, 'tool.batch_planned')
  ], timestamp)
  const capability: SerializablePreparedCapability = Object.freeze({
    schemaVersion: 1, callId: 'call-1', toolName: 'fixture', toolVersion: 1,
    snapshotId: source.toolSnapshot.id, canonicalArguments: Object.freeze({}),
    argumentHash: 'hash-call-1', target: Object.freeze({ kind: 'none' }),
    resourceKeys: Object.freeze(['fixture:000000000000000000000000']),
    executionClass, retrySafe: executionClass === 'read_only'
  })
  const batch = Object.freeze({
    schemaVersion: 1 as const,
    calls: Object.freeze([{ kind: 'ready' as const, capability }])
  })
  const counters = budget.reserveToolBatch(evaluating.budgetCounters, 1)
  const executing = nextRunCheckpoint(evaluating, 'executing_tools', {
    budgetCounters: counters,
    toolLedgers: Object.freeze([applyToolPreflight(ledger, batch)]),
    preparedBatch: batch
  }, [
    runEvent(source.runId, 5, 'tool.requested'),
    runEvent(source.runId, 6, 'tool.started')
  ], timestamp)
  return Object.freeze([...callingPath, evaluating, executing])
}

class ScriptedAdapter implements ModelAdapter {
  calls = 0
  constructor (readonly turn: ModelTurn) {}
  async complete (_request: ModelRequest, _signal: AbortSignal): Promise<ModelTurn> {
    this.calls += 1
    return this.turn
  }
}

class TerminalCheckpointStore extends InMemoryRunStore {
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

class CountingRuntime implements ToolRuntime {
  preparations = 0
  executions = 0
  async prepare (
    call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    this.preparations += 1
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1, callId: call.callId, toolName: 'fixture', toolVersion: 1,
      snapshotId: call.snapshotId, canonicalArguments: Object.freeze({}),
      argumentHash: 'hash-call-1', target: Object.freeze({ kind: 'none' }),
      resourceKeys: Object.freeze(['fixture:000000000000000000000000']),
      executionClass: 'read_only', retrySafe: true
    })
    return Object.freeze({ kind: 'ready' as const, capability })
  }

  async executePrepared (): Promise<ToolResult> {
    this.executions += 1
    return success('recovered')
  }
}

class ApprovalRuntime extends CountingRuntime {
  override async prepare (
    call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    this.preparations += 1
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1,
      callId: call.callId,
      toolName: 'fixture',
      toolVersion: 1,
      snapshotId: call.snapshotId,
      canonicalArguments: Object.freeze({}),
      argumentHash: 'hash-call-approval',
      target: Object.freeze({ kind: 'none' }),
      resourceKeys: Object.freeze(['fixture:000000000000000000000000']),
      executionClass: 'read_only',
      retrySafe: true
    })
    return Object.freeze({
      kind: 'approval_required' as const,
      capability,
      summaryCode: 'fixture_approval'
    })
  }
}

function runtimeBinding (toolSnapshot: ToolSnapshot): RunRuntimeBinding {
  return Object.freeze({
    snapshot: toolSnapshot,
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '继续任务' }]),
      estimatedInputTokens: 8
    }),
    prepareToolContext: async () => preparation,
    contextFor: async () => Object.freeze({ ...preparation }) as ToolExecutionContext
  })
}

function textTurn (text: string): ModelTurn {
  return Object.freeze({ text, toolCalls: Object.freeze([]), finishReason: 'stop' })
}

function approvalTurn (): ModelTurn {
  return Object.freeze({
    text: '',
    toolCalls: Object.freeze([Object.freeze({
      index: 0,
      callId: 'call-approval',
      name: 'fixture',
      argumentsText: '{}',
      arguments: Object.freeze({})
    })]),
    finishReason: 'tool_calls'
  })
}

function startInput (
  source: RunCheckpoint,
  runtime: RunRuntimeBinding
): StartRunInput {
  if (source.presentationRoute === null ||
    source.requestKind !== 'ordinary_chat') {
    throw new TypeError('start fixture identity is invalid')
  }
  return Object.freeze({
    runId: source.runId,
    runRef: source.runRef,
    requestRef: source.requestRef,
    requestKind: source.requestKind,
    presentationRoute: source.presentationRoute,
    observationPolicy: source.observationPolicy,
    sessionId: source.sessionId,
    sessionAddress: source.sessionAddress,
    deadlineAt: source.deadlineAt,
    model: source.model,
    runtime
  })
}

async function persistPath (store: RunStore, path: readonly RunCheckpoint[]): Promise<void> {
  await store.create(path[0])
  for (let index = 1; index < path.length; index += 1) {
    await store.compareAndSet(path[index - 1], path[index])
  }
}

function sequenceClock (...values: number[]): () => number {
  const remaining = [...values]
  return () => {
    const value = remaining.shift()
    if (value === undefined) throw new Error('monotonic clock script exhausted')
    return value
  }
}

test('RunEngine resumes a complete calling-model checkpoint exactly once', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = initial()
  const path = callingModelPath(source)
  await persistPath(store, path)
  const adapter = new ScriptedAdapter(textTurn('恢复完成'))
  const toolRuntime = new CountingRuntime()
  const engine = new RunEngine({
    adapter, profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }), store, budget,
    now: () => new Date(timestamp), generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'completed')
  assert.equal(adapter.calls, 1)
  assert.equal(await store.load(source.runId), null)
  assert.equal((await store.loadTombstone(source.runId))?.status, 'completed')
})

test('RunEngine resumes a committed evaluating-tools success without redispatching or duplicating usage', async () => {
  const store = new TerminalCheckpointStore()
  const source = initial('run-committed-success-recovery')
  const path = executingPath(source, 'read_only')
  const evaluating = path.at(-2)
  if (evaluating === undefined || evaluating.status !== 'evaluating_tools') {
    throw new TypeError('evaluating checkpoint is missing')
  }
  const committed = Object.freeze({
    ...evaluating,
    usage: recordRunUsage(evaluating.usage, Object.freeze({
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9
    })),
    providerDispatch: Object.freeze({ state: 'idle' })
  }) as RunCheckpoint
  await persistPath(store, [...path.slice(0, -2), committed])
  const adapter = new ScriptedAdapter(Object.freeze({
    ...textTurn('恢复工具后完成'),
    usage: Object.freeze({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })
  }))
  const toolRuntime = new CountingRuntime()
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }),
    store,
    budget,
    now: () => new Date(timestamp),
    generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'completed')
  assert.equal(toolRuntime.preparations, 1)
  assert.equal(toolRuntime.executions, 1)
  assert.equal(adapter.calls, 1)
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

test('RunEngine upgrades v2 without allocating or changing its request references', async () => {
  const store = new InMemoryRunStore()
  const source = checkpointV2(initial('run-v2-load'))
  store.seedLoadedCheckpoint(source)
  let runRefAllocations = 0
  let requestRefAllocations = 0
  const engine = new RunEngine({
    adapter: new ScriptedAdapter(textTurn('unused')),
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: new CountingRuntime() }),
    store,
    budget,
    now: () => new Date(timestamp),
    generateId: () => 'unused-id',
    createRunRef: () => {
      runRefAllocations += 1
      return '7'.repeat(32)
    },
    createRequestRef: () => {
      requestRefAllocations += 1
      return '8'.repeat(32)
    }
  })

  const upgraded = await engine.loadCheckpoint(source.runId)

  assert.equal(upgraded?.schemaVersion, 5)
  assert.equal(upgraded?.runRef, source.runRef)
  assert.equal(upgraded?.requestRef, source.requestRef)
  assert.deepEqual(upgraded?.reasoningSegments, [])
  assert.deepEqual({ runRefAllocations, requestRefAllocations }, {
    runRefAllocations: 0,
    requestRefAllocations: 0
  })
})

test('RunEngine upgrades v1 before any recovered tool or Provider action', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = initial('run-v1-action-gate')
  const path = executingPath(source, 'read_only')
  const latest = path.at(-1)
  if (latest === undefined) throw new TypeError('legacy path is missing')
  await persistLegacy(redis, legacyCheckpoint(latest))
  const upgradedRunRef = '3'.repeat(32)
  const upgradedRequestRef = '4'.repeat(32)
  let runRefAllocations = 0
  let requestRefAllocations = 0
  let toolObservedUpgrade = false
  let providerObservedUpgrade = false
  const baseRuntime = new CountingRuntime()
  const checkedRuntime: ToolRuntime = Object.freeze({
    prepare: async (...args: Parameters<ToolRuntime['prepare']>) => (
      await baseRuntime.prepare(...args)
    ),
    executePrepared: async () => {
      const checkpoint = await store.load(source.runId)
      assert.equal(checkpoint?.schemaVersion, 5)
      if (checkpoint?.schemaVersion !== 5) throw new TypeError('v1 was not upgraded')
      assert.equal(checkpoint.runRef, upgradedRunRef)
      assert.equal(checkpoint.requestRef, upgradedRequestRef)
      toolObservedUpgrade = true
      return await baseRuntime.executePrepared()
    }
  })
  const adapter: ModelAdapter = Object.freeze({
    complete: async () => {
      const checkpoint = await store.load(source.runId)
      assert.equal(checkpoint?.schemaVersion, 5)
      if (checkpoint?.schemaVersion !== 5) throw new TypeError('v1 was not upgraded')
      assert.equal(checkpoint.runRef, upgradedRunRef)
      assert.equal(checkpoint.requestRef, upgradedRequestRef)
      providerObservedUpgrade = true
      return textTurn('迁移后完成')
    }
  })
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: checkedRuntime }),
    store,
    budget,
    now: () => new Date(timestamp),
    generateId: () => 'generated-id',
    createRunRef: () => {
      runRefAllocations += 1
      return upgradedRunRef
    },
    createRequestRef: () => {
      requestRefAllocations += 1
      return upgradedRequestRef
    }
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'completed')
  assert.equal(toolObservedUpgrade, true)
  assert.equal(providerObservedUpgrade, true)
  assert.equal(runRefAllocations, 1)
  assert.equal(requestRefAllocations, 1)
  assert.equal(redis.evalCalls.some(call => call.marker === RUN_STORE_MIGRATION_LUA_MARKER), true)
})

test('RunEngine lets a v1 runRef upgrade conflict escape before recovery actions', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const collisionRef = '9'.repeat(32)
  await store.create(Object.freeze({
    ...initial('run-reference-holder'),
    runRef: collisionRef
  }))
  const legacy = legacyCheckpoint(initial('run-v1-reference-collision'))
  await persistLegacy(redis, legacy)
  const adapter = new ScriptedAdapter(textTurn('不应调用'))
  const toolRuntime = new CountingRuntime()
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }),
    store,
    budget,
    now: () => new Date(timestamp),
    generateId: () => 'generated-id',
    createRunRef: () => collisionRef,
    createRequestRef: () => 'a'.repeat(32)
  })

  await assert.rejects(
    engine.resume(legacy.runId, runtimeBinding(snapshot())),
    error => error instanceof RunReferenceConflictError
  )
  assert.equal(adapter.calls, 0)
  assert.equal(toolRuntime.preparations, 0)
  assert.equal(toolRuntime.executions, 0)
})

test('RunEngine fails closed when the recovered Profile or ToolSnapshot changed', async () => {
  for (const changedRuntime of [
    runtimeBinding(snapshot('b'.repeat(64))),
    runtimeBinding(Object.freeze({ ...snapshot(), id: 'snapshot-changed' }))
  ]) {
    const redis = new FakeRedis(() => Date.parse(timestamp))
    const store = new RedisRunStore({ client: redis })
    const source = initial()
    await store.create(source)
    const adapter = new ScriptedAdapter(textTurn('不应调用'))
    const engine = new RunEngine({
      adapter, profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: new CountingRuntime() }),
      store, budget, now: () => new Date(timestamp), generateId: () => 'generated-id'
    })

    const result = await engine.resume(source.runId, changedRuntime)

    assert.equal(result.kind, 'failed')
    assert.equal(result.kind === 'failed' && result.error.code, 'checkpoint_invalid')
    assert.equal(adapter.calls, 0)
  }
})

test('RunEngine never replays a recovered non-read capability without a terminal checkpoint', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = initial()
  const path = executingPath(source, 'side_effect')
  await persistPath(store, path)
  const toolRuntime = new CountingRuntime()
  const engine = new RunEngine({
    adapter: new ScriptedAdapter(textTurn('不应调用')),
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }),
    store, budget, now: () => new Date(timestamp), generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'tool_outcome_unknown')
  assert.equal(toolRuntime.preparations, 0)
  assert.equal(toolRuntime.executions, 0)
  assert.equal((await store.loadTombstone(source.runId))?.errorCode, 'tool_outcome_unknown')
})

test('RunEngine re-prepares a recovered read-only batch before executing it', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = initial()
  const path = executingPath(source, 'read_only')
  await persistPath(store, path)
  const toolRuntime = new CountingRuntime()
  const adapter = new ScriptedAdapter(textTurn('只读恢复完成'))
  const engine = new RunEngine({
    adapter, profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }), store, budget,
    now: () => new Date(timestamp), generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'completed')
  assert.equal(toolRuntime.preparations, 1)
  assert.equal(toolRuntime.executions, 1)
  assert.equal(adapter.calls, 1)
})

test('RunEngine degrades every ambiguous dispatch and activity counter after reserved recovery', async () => {
  for (const [name, priorDuration] of [
    ['dispatch-before-wire', 0],
    ['dispatch-after-wire', 4]
  ] as const) {
    const store = new InMemoryRunStore()
    const source = initial(`run-${name}`)
    const path = callingModelPath(source)
    const calling = path.at(-1)
    if (calling === undefined) throw new TypeError('calling checkpoint is missing')
    const crashed = nextRunCheckpoint(calling, 'calling_model', {
      observationCounters: Object.freeze({
        ...calling.observationCounters,
        providerAttempts: 1,
        modelTurns: 0,
        toolAttempts: 0,
        providerRetries: 0,
        recoveryAttempts: 0,
        correctionTurns: 0,
        providerInputTokens: 'unavailable',
        providerOutputTokens: 'unavailable',
        providerTotalTokens: 'unavailable',
        providerActiveDurationMs: priorDuration,
        engineActiveDurationMs: 7
      }),
      providerDispatch: Object.freeze({ state: 'reserved' }),
      engineActivity: Object.freeze({ state: 'reserved' })
    }, [], timestamp)
    await persistPath(store, [...path, crashed])
    const adapter = new ScriptedAdapter(Object.freeze({
      ...textTurn('恢复后完成'),
      usage: Object.freeze({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }))
    const engine = new RunEngine({
      adapter,
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: new CountingRuntime() }),
      store,
      budget,
      now: () => new Date(timestamp),
      monotonicNow: sequenceClock(0, 1, 2, 5),
      generateId: () => 'generated-id'
    })

    const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

    assert.equal(result.kind, 'completed')
    assert.equal(adapter.calls, 1)
    const terminal = terminalSnapshot(result)
    assert.deepEqual(terminal === null ? null : {
      providerAttempts: terminal.counters.providerAttempts,
      providerRetries: terminal.counters.providerRetries,
      recoveryAttempts: terminal.counters.recoveryAttempts,
      correctionTurns: terminal.counters.correctionTurns,
      providerInputTokens: terminal.counters.providerInputTokens,
      providerOutputTokens: terminal.counters.providerOutputTokens,
      providerTotalTokens: terminal.counters.providerTotalTokens,
      providerActiveDurationMs: terminal.counters.providerActiveDurationMs,
      modelTurns: terminal.counters.modelTurns,
      toolAttempts: terminal.counters.toolAttempts,
      engineActiveDurationMs: terminal.counters.engineActiveDurationMs,
      toolCalls: terminal.counters.toolCalls,
      approvalRequests: terminal.counters.approvalRequests
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
      engineActiveDurationMs: 'unavailable',
      toolCalls: 0,
      approvalRequests: 0
    })
  }
})

test('RunEngine engine-reserved recovery preserves independently proven Provider aggregates', async () => {
  const store = new InMemoryRunStore()
  const source = initial('run-engine-reserved')
  const path = executingPath(source, 'read_only')
  const executing = path.at(-1)
  if (executing === undefined) throw new TypeError('executing checkpoint is missing')
  const crashed = nextRunCheckpoint(executing, 'executing_tools', {
    budgetCounters: Object.freeze({
      ...executing.budgetCounters,
      usedActiveRuntimeMs: 4
    }),
    observationCounters: Object.freeze({
      ...executing.observationCounters,
      providerAttempts: 1,
      modelTurns: 1,
      toolAttempts: 0,
      toolCalls: 1,
      providerInputTokens: 7,
      providerOutputTokens: 3,
      providerTotalTokens: 10,
      providerActiveDurationMs: 4,
      engineActiveDurationMs: 13
    }),
    providerDispatch: Object.freeze({ state: 'idle' }),
    engineActivity: Object.freeze({ state: 'reserved' })
  }, [], timestamp)
  await persistPath(store, [...path, crashed])
  const adapter = new ScriptedAdapter(Object.freeze({
    ...textTurn('恢复完成'),
    usage: Object.freeze({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
  }))
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: new CountingRuntime() }),
    store,
    budget,
    now: () => new Date(timestamp),
    monotonicNow: sequenceClock(0, 1, 2, 5),
    generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'completed')
  const terminal = terminalSnapshot(result)
  assert.deepEqual(terminal === null ? null : {
    providerAttempts: terminal.counters.providerAttempts,
    providerInputTokens: terminal.counters.providerInputTokens,
    providerOutputTokens: terminal.counters.providerOutputTokens,
    providerTotalTokens: terminal.counters.providerTotalTokens,
    providerActiveDurationMs: terminal.counters.providerActiveDurationMs,
    modelTurns: terminal.counters.modelTurns,
    toolAttempts: terminal.counters.toolAttempts,
    engineActiveDurationMs: terminal.counters.engineActiveDurationMs
  }, {
    providerAttempts: 2,
    providerInputTokens: 12,
    providerOutputTokens: 5,
    providerTotalTokens: 17,
    providerActiveDurationMs: 5,
    modelTurns: 'unavailable',
    toolAttempts: 'unavailable',
    engineActiveDurationMs: 'unavailable'
  })
})

test('RunEngine clears a crashed waiting-approval activity reservation without starting new work', async () => {
  const store = new InMemoryRunStore()
  const source = initial('run-waiting-reserved')
  const toolSnapshot = snapshot()
  const setupRuntime = new ApprovalRuntime()
  let generated = 0
  const setupEngine = new RunEngine({
    adapter: new ScriptedAdapter(approvalTurn()),
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: setupRuntime }),
    store,
    budget,
    now: () => new Date(timestamp),
    monotonicNow: sequenceClock(0, 1, 2, 3),
    generateId: () => `generated-${++generated}`
  })

  const paused = await setupEngine.start(
    startInput(source, runtimeBinding(toolSnapshot))
  )
  assert.equal(paused.kind, 'paused')
  const waiting = await store.load(source.runId)
  if (waiting?.schemaVersion !== 5 || waiting.status !== 'waiting_approval') {
    throw new TypeError('waiting approval fixture is missing')
  }
  assert.equal(waiting.engineActivity.state, 'idle')
  const crashed = nextRunCheckpoint(waiting, 'waiting_approval', {
    engineActivity: Object.freeze({ state: 'reserved' })
  }, [], timestamp)
  await store.compareAndSet(waiting, crashed)

  const adapter = new ScriptedAdapter(textTurn('不应调用'))
  const recoveryRuntime = new CountingRuntime()
  let recoveryClockCalls = 0
  const recoveryEngine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: recoveryRuntime }),
    store,
    budget,
    now: () => new Date(timestamp),
    monotonicNow: () => {
      recoveryClockCalls += 1
      return 10
    },
    generateId: () => 'recovery-generated-id'
  })

  const recoveredResult = await recoveryEngine.resume(source.runId)
  const recovered = await store.load(source.runId)
  assert.deepEqual(recovered?.schemaVersion === 5 ? {
    resultKind: recoveredResult.kind,
    revision: recovered.revision,
    providerDispatch: recovered.providerDispatch.state,
    engineActivity: recovered.engineActivity.state,
    counters: recovered.observationCounters
  } : null, {
    resultKind: 'paused',
    revision: crashed.revision + 1,
    providerDispatch: 'idle',
    engineActivity: 'idle',
    counters: Object.freeze({
      ...crashed.observationCounters,
      modelTurns: 'unavailable',
      toolAttempts: 'unavailable',
      engineActiveDurationMs: 'unavailable'
    })
  })

  if (recovered?.schemaVersion !== 5) {
    throw new TypeError('recovered waiting checkpoint is missing')
  }
  const idleRevision = recovered.revision
  const idleResult = await recoveryEngine.resume(source.runId)
  const stillIdle = await store.load(source.runId)
  assert.equal(idleResult.kind, 'paused')
  assert.equal(stillIdle?.revision, idleRevision)
  assert.equal(
    stillIdle?.schemaVersion === 5 ? stillIdle.engineActivity.state : null,
    'idle'
  )
  assert.equal(recoveryClockCalls, 0)
  assert.equal(adapter.calls, 0)
  assert.equal(recoveryRuntime.preparations, 0)
  assert.equal(recoveryRuntime.executions, 0)
})

test('RunAdmission enforces global two, per-session one and a FIFO queue of three', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  let generated = 0
  const admission = new RunAdmission({
    client: redis, generateId: () => `lease-${++generated}`, leaseTtlSeconds: 300
  })
  const other = (id: string): SessionAddress => Object.freeze({
    botId: 'bot-private-value', scope: Object.freeze({ kind: 'private', userId: id })
  })
  const first = await admission.acquire(other('session-a'))
  const second = await admission.acquire(other('session-b'))
  const queuedOne = admission.acquire(other('session-c'))
  const queuedTwo = admission.acquire(other('session-d'))
  const queuedThree = admission.acquire(other('session-e'))

  await assert.rejects(admission.acquire(other('session-f')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))
  assert.equal(admission.activeCount, 2)
  assert.equal(admission.queuedCount, 3)

  await first.release()
  const third = await queuedOne
  assert.equal(third.leaseId, 'lease-3')
  await second.release()
  const fourth = await queuedTwo
  await third.release()
  const fifth = await queuedThree
  await Promise.all([fourth.release(), fifth.release()])
  assert.equal(admission.activeCount, 0)
  assert.equal(admission.queuedCount, 0)
})

test('RunAdmission serializes one session, removes an aborted waiter and hashes Redis keys', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  let generated = 0
  const admission = new RunAdmission({
    client: redis, generateId: () => `lease-${++generated}`, leaseTtlSeconds: 300
  })
  const first = await admission.acquire(address)
  const controller = new AbortController()
  const aborted = admission.acquire(address, controller.signal)
  controller.abort()
  await assert.rejects(aborted, error => (
    error instanceof AgentError && error.code === 'cancelled'
  ))
  assert.equal(admission.queuedCount, 0)

  const waiting = admission.acquire(address)
  await first.release()
  const second = await waiting
  const keys = (await redis.scan(0, { MATCH: 'GROUPMATE:RUN:v1:admission:*', COUNT: 100 })).keys
  assert.equal(keys.some(key => key.includes(address.botId)), false)
  assert.equal(keys.some(key => key.includes('group-private-value')), false)
  assert.equal(await redis.ttl(keys[0] ?? ''), 300)
  await second.release()
})

test('RunAdmission rebuilds a lease only from a valid non-terminal checkpoint', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const staleAdmission = new RunAdmission({
    client: redis,
    generateId: () => 'lease-from-previous-process'
  })
  const staleLease = await staleAdmission.acquire(address)
  const admission = new RunAdmission({ client: redis, generateId: () => 'lease-recovered' })
  const source = initial('run-recovered')
  const lease = await admission.recover(source)
  assert.equal(lease.leaseId, 'lease-recovered')
  assert.equal(redis.evalCalls.some(call => call.operation === 'admission_recover'), true)
  await lease.release()
  await staleLease.release()

  await assert.rejects(admission.recover({
    ...source,
    status: 'completed'
  } as RunCheckpoint), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
})

test('RunEngine keeps a final retryable provider error typed after restart', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = initial()
  const path = callingModelPath(source)
  await persistPath(store, path)
  const failure = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  class FailingAdapter implements ModelAdapter {
    calls = 0
    async complete (): Promise<ModelTurn> {
      this.calls += 1
      throw failure
    }
  }
  const adapter = new FailingAdapter()
  const engine = new RunEngine({
    adapter, profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: new CountingRuntime() }),
    store, budget, now: () => new Date(timestamp), generateId: () => 'generated-id'
  })

  const result = await engine.resume(source.runId, runtimeBinding(snapshot()))

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_unavailable')
  assert.equal(adapter.calls, 2)
  assert.equal((await store.loadTombstone(source.runId))?.counters.providerRetries, 1)
})
