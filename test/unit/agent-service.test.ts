import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentMessage } from '../../src/agent/contracts/content.js'
import type { CompletionDisposition } from '../../src/agent/contracts/completion.js'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import { EMPTY_PRESENTATION_TRACE } from '../../src/agent/contracts/presentation-trace.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import { NoopMemoryStore } from '../../src/agent/context/noop-memory-store.js'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import {
  RunAdmission,
  RunAdmissionRejectionError,
  type RunLease
} from '../../src/agent/run/run-admission.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import { RunEngine } from '../../src/agent/run/run-engine.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import {
  RunReferenceConflictError,
  type TerminalCommitReceiptV1,
  type RunStore
} from '../../src/agent/run/run-store.js'
import {
  createInitialRunObservationCounters,
  terminalObservationId,
  type RunTerminalSnapshotV2
} from '../../src/agent/run/run-observation.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import type { AgentSessionState } from '../../src/agent/session/agent-session-state.js'
import { RedisAgentSessionStore } from '../../src/agent/session/redis-agent-session-store.js'
import type { SessionStore } from '../../src/agent/session/session-store.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import type { ToolDefinition } from '../../src/agent/tools/tool-definition.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import {
  AgentService,
  projectFinalPresentation,
  projectRunAdvanceResult,
  type FinalChatReplyEnvelope
} from '../../src/runtime/agent-service.js'
import { AgentServiceBridge } from '../../src/runtime/agent-service-bridge.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'
import {
  activateRequestObservation,
  beginRequestObservation,
  createRequestObservationDraft
} from '../../src/runtime/request-observation.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'

const createdAt = '2026-07-14T01:00:00.000Z'
const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-1',
  actor: Object.freeze({ userId: 'actor-1', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
  scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' }),
  botGroupRole: 'owner', actorGroupRole: 'owner', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
})
const intent = Object.freeze({
  trustedSources: Object.freeze(['current_request'] as const),
  actions: Object.freeze([]), explicitTargetIds: Object.freeze([]),
  mentionUserIds: Object.freeze([]), currentMessageId: 'message-1',
  replyMessageId: null
})

function request (
  id: string,
  text: string,
  requestKind: 'ordinary_chat' | 'proactive_chat' = 'ordinary_chat'
): YunzaiAgentRequestDraft {
  const message: AgentMessage = Object.freeze({
    id: `message-${id}`,
    role: 'user',
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt,
    provenance: Object.freeze({
      source: 'qq_message', trust: 'untrusted', sensitivity: 'group',
      sourceId: `message-${id}`, createdAt
    })
  })
  const sessionAddress = Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'group_user' as const, groupId: 'group-1', userId: 'actor-1' })
  })
  const presentationRoute = requestKind === 'ordinary_chat'
    ? Object.freeze({
        schemaVersion: 1 as const,
        requestKind: 'ordinary_chat' as const,
        profile: 'ordinary' as const,
        presentationIntent: Object.freeze({
          schemaVersion: 1 as const,
          kind: 'ordinary' as const,
          forcePicture: false
        }),
        sessionAddress,
        actorId: 'actor-1',
        requestMessageId: message.id
      })
    : Object.freeze({
        schemaVersion: 1 as const,
        requestKind: 'proactive_chat' as const,
        profile: 'proactive' as const,
        presentationIntent: Object.freeze({
          schemaVersion: 1 as const,
          kind: 'proactive' as const,
          recallAfterMs: null
        }),
        sessionAddress,
        actorId: 'actor-1',
        requestMessageId: message.id
      })
  return Object.freeze({
    requestId: id,
    requestRef: createHash('sha256').update(`request:${id}`).digest('hex').slice(0, 32),
    requestKind,
    presentationRoute,
    createdAt,
    deadlineAt: '2026-07-14T01:04:00.000Z',
    sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'owner' }),
    channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
    message,
    references: Object.freeze({ currentMessageId: message.id, quotedMessageId: null }),
    systemInstructions: Object.freeze(['You are GroupMate.']),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    contextBudget: Object.freeze({
      modelContextTokens: 8_192, reservedOutputTokens: 256,
      reservedToolTokens: 512, safetyMarginTokens: 128,
      maxItems: 64, maxBytes: 256 * 1_024
    }),
    sessionTtlSeconds: 600
  })
}

function toolDefinition (name: string): ToolDefinition {
  return Object.freeze({
    name, version: 1, aliases: Object.freeze([]), description: `${name} fixture`,
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({ value: Object.freeze({ type: 'string' as const }) }),
      required: Object.freeze(['value']), additionalProperties: false as const
    }),
    effect: 'read_only', risk: 'low', readOnly: true, destructive: false,
    idempotency: 'none', openWorld: false, timeoutMs: 1_000, maxOutputBytes: 4_096,
    network: 'none', permission: 'any_user', executionClass: 'read_only', retrySafe: true,
    resourceKeys: (input: Readonly<Record<string, unknown>>) => Object.freeze([
      `${name}:${String(input.value)}`
    ]),
    resolveTarget: () => Object.freeze({ kind: 'none' as const }),
    execute: async () => result(name)
  })
}

function result (text: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'none',
    content: Object.freeze([{ type: 'text' as const, text }]), retryable: false
  })
}

class ServiceToolRuntime implements ToolRuntime {
  readonly #approvalRequired: boolean
  readonly executions: string[] = []

  constructor (approvalRequired = false) {
    this.#approvalRequired = approvalRequired
  }

  async prepare (call: ToolCall): Promise<PreparedToolCall> {
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1,
      callId: call.callId,
      toolName: call.requestedName,
      toolVersion: 1,
      snapshotId: call.snapshotId,
      canonicalArguments: call.arguments as SerializablePreparedCapability['canonicalArguments'],
      argumentHash: `hash-${call.callId}`,
      target: Object.freeze({ kind: 'none' }),
      resourceKeys: Object.freeze([`${call.requestedName}:${call.callId}`]),
      executionClass: 'read_only', retrySafe: true
    })
    return this.#approvalRequired
      ? Object.freeze({ kind: 'approval_required', capability, summaryCode: 'website_approval' })
      : Object.freeze({ kind: 'ready', capability })
  }

  async executePrepared (prepared: SerializablePreparedCapability): Promise<ToolResult> {
    this.executions.push(prepared.callId)
    return result(prepared.toolName)
  }
}

class ServiceAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  readonly #turns: ModelTurn[] = [
    Object.freeze({
      text: 'internal companion text', finishReason: 'tool_calls' as const,
      toolCalls: Object.freeze([
        Object.freeze({
          index: 0, callId: 'call-website', name: 'website',
          argumentsText: '{"value":"one"}', arguments: Object.freeze({ value: 'one' })
        }),
        Object.freeze({
          index: 1, callId: 'call-weather', name: 'weather',
          argumentsText: '{"value":"two"}', arguments: Object.freeze({ value: 'two' })
        })
      ])
    }),
    Object.freeze({
      text: '任务完成。', finishReason: 'stop' as const, toolCalls: Object.freeze([])
    }),
    Object.freeze({
      text: '临时任务完成。', finishReason: 'stop' as const, toolCalls: Object.freeze([])
    }),
    Object.freeze({
      text: '终态已提交。', finishReason: 'stop' as const, toolCalls: Object.freeze([])
    })
  ]

  async complete (value: ModelRequest): Promise<ModelTurn> {
    this.requests.push(value)
    const turn = this.#turns.shift()
    if (turn === undefined) throw new Error('service adapter script exhausted')
    return turn
  }
}

class SerialAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  active = 0
  peak = 0
  #releaseFirst: (() => void) | undefined
  readonly firstStarted: Promise<void>
  #markFirstStarted: (() => void) | undefined

  constructor () {
    this.firstStarted = new Promise(resolve => {
      this.#markFirstStarted = resolve
    })
  }

  releaseFirst (): void {
    this.#releaseFirst?.()
  }

  async complete (value: ModelRequest): Promise<ModelTurn> {
    this.requests.push(value)
    const call = this.requests.length
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    try {
      if (call === 1) {
        this.#markFirstStarted?.()
        await new Promise<void>(resolve => {
          this.#releaseFirst = resolve
        })
      }
      return Object.freeze({
        text: `第 ${call} 次完成。`,
        finishReason: 'stop' as const,
        toolCalls: Object.freeze([])
      })
    } finally {
      this.active -= 1
    }
  }
}

class InjectedCollisionRunStore implements RunStore {
  readonly base = new InMemoryRunStore()
  createCalls = 0
  readonly #collisions: number

  constructor (collisions: number) {
    this.#collisions = collisions
  }

  create: RunStore['create'] = async checkpoint => {
    this.createCalls += 1
    if (this.createCalls <= this.#collisions) throw new RunReferenceConflictError()
    return await this.base.create(checkpoint)
  }

  load: RunStore['load'] = async runId => await this.base.load(runId)
  upgrade: RunStore['upgrade'] = async (expected, next) => (
    await this.base.upgrade(expected, next)
  )

  compareAndSet: RunStore['compareAndSet'] = async (expected, next) => (
    await this.base.compareAndSet(expected, next)
  )

  appendEvents: RunStore['appendEvents'] = async (expected, events) => (
    await this.base.appendEvents(expected, events)
  )

  commitTerminal: RunStore['commitTerminal'] = async (expected, next, snapshot) => (
    await this.base.commitTerminal(expected, next, snapshot)
  )

  loadTombstone: RunStore['loadTombstone'] = async runId => (
    await this.base.loadTombstone(runId)
  )

  observationUsage: RunStore['observationUsage'] = async () => (
    await this.base.observationUsage()
  )
}

function terminalFactsFor (
  runRef: string,
  completion: CompletionDisposition,
  revision = 3
) {
  const observationId = terminalObservationId(runRef, revision)
  const counters = createInitialRunObservationCounters()
  const completionObservation = completion.kind === 'reply_text'
    ? Object.freeze({ kind: 'reply_text' as const, lengthBucket: '1_40' as const })
    : completion.kind === 'already_visible'
      ? Object.freeze({ kind: 'already_visible' as const, source: 'tool_output' as const })
      : Object.freeze({
          kind: 'allowed_silence' as const,
          reason: 'proactive_empty_directive' as const
        })
  return Object.freeze({
    snapshot: Object.freeze({
      schemaVersion: 2 as const,
      observationId,
      runRef,
      revision,
      status: 'completed' as const,
      finishedAt: createdAt,
      completion: completionObservation,
      errorCode: null,
      cancellationReason: null,
      counters,
      engineDurationMs: counters.engineActiveDurationMs
    }),
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      observationId,
      runRef,
      revision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 100,
      eventBytesDeleted: 20,
      tombstoneBytes: 200
    })
  })
}

function terminalOutput (text: string): AgentMessage {
  return Object.freeze({
    id: `terminal-${text}`,
    role: 'assistant',
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt,
    provenance: Object.freeze({
      source: 'agent_output',
      trust: 'trusted',
      sensitivity: 'group',
      sourceId: `terminal-${text}`,
      createdAt
    })
  })
}

function completedResult (
  runId: string,
  runRef: string,
  completion: CompletionDisposition
): Extract<RunAdvanceResult, { readonly kind: 'completed' }> {
  return Object.freeze({
    kind: 'completed',
    runId,
    runRef,
    completion,
    output: completion.kind === 'already_visible'
      ? null
      : terminalOutput(completion.kind === 'allowed_silence' ? '<EMPTY>' : completion.text),
    presentationTrace: EMPTY_PRESENTATION_TRACE,
    terminal: terminalFactsFor(runRef, completion)
  })
}

function cancelledResult (
  runId: string,
  runRef: string,
  reason: string
): Extract<RunAdvanceResult, { readonly kind: 'cancelled' }> {
  const revision = 4
  const observationId = terminalObservationId(runRef, revision)
  const counters = createInitialRunObservationCounters()
  return Object.freeze({
    kind: 'cancelled',
    runId,
    runRef,
    reason,
    terminal: Object.freeze({
      snapshot: Object.freeze({
        schemaVersion: 2,
        observationId,
        runRef,
        revision,
        status: 'cancelled',
        finishedAt: createdAt,
        completion: Object.freeze({ kind: 'none' }),
        errorCode: null,
        cancellationReason: reason,
        counters,
        engineDurationMs: counters.engineActiveDurationMs
      }),
      receipt: Object.freeze({
        schemaVersion: 1,
        observationId,
        runRef,
        revision,
        deletedKeyCount: 2,
        createdKeyCount: 1,
        checkpointBytesDeleted: 100,
        eventBytesDeleted: 20,
        tombstoneBytes: 200
      })
    })
  })
}

function noOpLease (): RunLease {
  return Object.freeze({
    leaseId: 'contract-lease',
    sessionAddress: request('lease', 'lease').sessionAddress,
    release: async () => undefined
  })
}

function contractSessions (
  save: SessionStore<AgentSessionState>['save'] = async () => undefined
): SessionStore<AgentSessionState> {
  return Object.freeze({
    get: async () => null,
    save,
    delete: async () => false,
    list: async function * () {},
    deleteAll: async () => 0,
    fork: async () => { throw new Error('not used by contract test') }
  })
}

function contractContextEngine (): ContextEngine {
  return new ContextEngine({
    estimator: {
      estimate: () => 1,
      estimateModelMessage: () => 1
    },
    memoryStore: new NoopMemoryStore()
  })
}

function contractSnapshot () {
  const definitions = Object.freeze([toolDefinition('website')])
  return new ToolRegistry(definitions).createSnapshot({
    id: 'snapshot-contract', facts, enabledTools: ['website']
  })
}

function contractRuntime () {
  const snapshot = contractSnapshot()
  return Object.freeze({
    binding: Object.freeze({
      snapshot,
      prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
        runId: 'contract-run', profile: 'compatible', facts, intent, now: createdAt
      }),
      contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
        runId: 'contract-run', profile: 'compatible', facts, intent, now: createdAt
      })
    })
  })
}

function contractEngine (
  methods: Partial<Pick<
    RunEngine,
    'start' | 'resume' | 'cancel' | 'loadCheckpoint' | 'pendingApproval' |
    'displayApproval' | 'decideApproval'
  >>
): RunEngine {
  return Object.freeze({
    start: async () => { throw new Error('unexpected start') },
    resume: async () => { throw new Error('unexpected resume') },
    cancel: async () => { throw new Error('unexpected cancel') },
    loadCheckpoint: async () => null,
    pendingApproval: async () => null,
    displayApproval: async () => null,
    decideApproval: async () => null,
    ...methods
  }) as unknown as RunEngine
}

test('fresh admission maps only the three fixed rejection reasons before run claim', async () => {
  const cases = [
    Object.freeze({
      error: new RunAdmissionRejectionError('queue_full'),
      reason: 'queue_full' as const,
      kind: 'failed' as const
    }),
    Object.freeze({
      error: new RunAdmissionRejectionError('queue_aborted'),
      reason: 'queue_aborted' as const,
      kind: 'cancelled' as const
    }),
    Object.freeze({
      error: new Error('private redis admission failure'),
      reason: 'unavailable' as const,
      kind: 'failed' as const
    })
  ]
  for (const [index, entry] of cases.entries()) {
    let monotonic = 10
    const service = new AgentService({
      sessions: contractSessions(),
      runStore: new InMemoryRunStore(),
      admission: {
        acquire: async () => { throw entry.error },
        recover: async () => noOpLease()
      },
      contextEngine: contractContextEngine(),
      progressPresenter: new RunProgressPresenter(),
      createEngine: () => contractEngine({}),
      createRuntime: async () => contractRuntime(),
      generateId: () => `admission-contract-${index}`,
      createRunRef: () => `${index + 1}`.repeat(32),
      monotonicNow: () => monotonic++
    })

    const outcome = await service.handle(request(
      `admission-contract-${index}`,
      '验证准入拒绝'
    ))

    assert.equal(outcome.kind, entry.kind)
    assert.equal(outcome.runRef, 'unavailable')
    assert.equal(outcome.requestObservationDraft.runRef, 'unavailable')
    assert.equal(outcome.requestObservationDraft.terminalObservationId, 'not_attempted')
    assert.equal(outcome.requestObservationDraft.outcome, 'rejected_admission')
    assert.equal(outcome.requestObservationDraft.admissionRejectionReason, entry.reason)
    assert.equal(outcome.sessionPersistence, 'not_attempted')
  }
})

test('run reference initialization failure cannot strand AgentService shutdown', async () => {
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => noOpLease()
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({}),
    createRuntime: async () => contractRuntime(),
    generateId: () => 'run-ref-initialization-failure',
    createRunRef: () => { throw new Error('injected run reference failure') }
  })

  await assert.rejects(
    service.handle(request('run-ref-initialization-failure', '验证同步初始化失败')),
    /injected run reference failure/
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  const shutdown = await Promise.race([
    service.shutdown('process_shutdown'),
    new Promise<'timeout'>(resolve => {
      timeout = setTimeout(() => { resolve('timeout') }, 50)
    })
  ])
  if (timeout !== undefined) clearTimeout(timeout)
  assert.equal(shutdown, 0)
})

test('terminal session-save failure preserves every completed disposition and committed fact', async () => {
  const dispositions: readonly CompletionDisposition[] = Object.freeze([
    Object.freeze({ kind: 'reply_text', text: '保留正文' }),
    Object.freeze({ kind: 'already_visible', source: 'tool_output' }),
    Object.freeze({ kind: 'allowed_silence', reason: 'proactive_empty_directive' })
  ])
  for (const [index, completion] of dispositions.entries()) {
    const runRef = `${index + 4}`.repeat(32)
    const original = completedResult(`save-failure-${index}`, runRef, completion)
    const observed: string[] = []
    let monotonic = 100
    const service = new AgentService({
      sessions: contractSessions(async () => {
        observed.push('session_save')
        throw new Error('injected session persistence failure')
      }),
      runStore: new InMemoryRunStore(),
      admission: {
        acquire: async () => noOpLease(),
        recover: async () => noOpLease()
      },
      contextEngine: contractContextEngine(),
      progressPresenter: new RunProgressPresenter(),
      createEngine: () => contractEngine({
        start: async () => original
      }),
      createRuntime: async () => contractRuntime(),
      generateId: () => `save-failure-${index}`,
      createRunRef: () => runRef,
      monotonicNow: () => monotonic++,
      onTerminalSnapshot: () => { observed.push('snapshot') },
      onTerminalCommitReceipt: () => { observed.push('receipt') }
    })

    const outcome = await service.handle(request(
      `save-failure-request-${index}`,
      '验证持久化失败不改写终态'
    ))

    assert.equal(outcome.kind, 'completed')
    if (outcome.kind !== 'completed') assert.fail('completed result was rewritten')
    assert.deepEqual(outcome.completion, completion)
    assert.deepEqual(outcome.output, original.output)
    assert.deepEqual(outcome.terminal, original.terminal)
    assert.equal(outcome.sessionPersistence, 'failed')
    assert.equal(outcome.requestObservationDraft.outcome, 'failed_session_save')
    assert.equal(
      outcome.requestObservationDraft.terminalObservationId,
      original.terminal.snapshot.observationId
    )
    assert.equal(Object.hasOwn(outcome, 'text'), false)
    assert.equal(Object.hasOwn(outcome, 'visibleOutput'), false)
    assert.deepEqual(observed, ['snapshot', 'receipt', 'session_save'])
  }
})

test('chat reply envelope projects exact RunAdvanceResult without text or visibleOutput', () => {
  const runRef = '7'.repeat(32)
  const result = completedResult(
    'projection-completed',
    runRef,
    Object.freeze({ kind: 'reply_text', text: '投影正文' })
  )
  const context = activateRequestObservation({
    context: beginRequestObservation({
      requestRef: '6'.repeat(32),
      requestKind: 'ordinary_chat',
      startedAtMonotonicMs: 10
    }),
    runRef,
    queueDurationMs: 1,
    sessionLoadDurationMs: 2
  })
  const completedDraft = createRequestObservationDraft({
    context,
    outcome: 'completed',
    admissionRejectionReason: 'not_applicable',
    sessionSaveDurationMs: 3,
    terminalObservationId: result.terminal.snapshot.observationId
  })
  const wrapped = Object.freeze({
    ...result,
    requestObservationDraft: completedDraft,
    sessionPersistence: 'saved' as const,
    text: 'legacy leak',
    visibleOutput: true
  }) as unknown as FinalChatReplyEnvelope

  const projected = projectRunAdvanceResult(wrapped)
  if (projected.kind !== 'completed') assert.fail('completed projection changed kind')
  assert.deepEqual(Reflect.ownKeys(projected), [
    'kind', 'runId', 'runRef', 'completion', 'output', 'presentationTrace', 'terminal'
  ])
  assert.equal(Object.hasOwn(projected, 'requestObservationDraft'), false)
  assert.equal(Object.hasOwn(projected, 'sessionPersistence'), false)
  assert.equal(Object.hasOwn(projected, 'text'), false)
  assert.equal(Object.hasOwn(projected, 'visibleOutput'), false)
  assert.equal(projected.completion, result.completion)
  assert.equal(projected.presentationTrace, result.presentationTrace)
  assert.equal(projected.terminal, result.terminal)

  const presentation = projectFinalPresentation(wrapped)
  assert.deepEqual(presentation.result, projected)
  if (presentation.result.kind !== 'completed') assert.fail('completed projection changed kind')
  assert.equal(presentation.result.completion, result.completion)
  assert.equal(presentation.result.output, result.output)
  assert.equal(presentation.result.terminal, result.terminal)
  assert.equal(presentation.sessionPersistence, 'saved')
  assert.deepEqual(Reflect.ownKeys(presentation), ['result', 'sessionPersistence'])

  assert.throws(() => projectFinalPresentation(Object.freeze({
    ...wrapped,
    sessionPersistence: 'failed'
  }) as FinalChatReplyEnvelope), /session persistence/i)
  assert.throws(() => projectFinalPresentation(Object.freeze({
    ...wrapped,
    sessionPersistence: 'not_attempted'
  }) as FinalChatReplyEnvelope), /session persistence/i)

  const noSaveDraft = createRequestObservationDraft({
    context,
    outcome: 'completed',
    admissionRejectionReason: 'not_applicable',
    sessionSaveDurationMs: 'not_attempted',
    terminalObservationId: result.terminal.snapshot.observationId
  })
  assert.equal(projectFinalPresentation(Object.freeze({
    ...result,
    requestObservationDraft: noSaveDraft,
    sessionPersistence: 'not_attempted'
  })).sessionPersistence, 'not_attempted')
  assert.throws(() => projectFinalPresentation(Object.freeze({
    ...result,
    requestObservationDraft: noSaveDraft,
    sessionPersistence: 'saved'
  })), /session persistence/i)

  assert.throws(() => projectFinalPresentation(Object.freeze({
    kind: 'failed',
    runId: result.runId,
    runRef,
    error: Object.freeze({
      code: 'internal_error',
      stage: 'agent.service',
      retryable: false,
      userMessage: '处理请求时出现异常，请稍后重试',
      details: Object.freeze({})
    }),
    terminal: null,
    requestObservationDraft: noSaveDraft,
    sessionPersistence: 'not_attempted'
  })), /terminal observation/i)

  const failedSaveDraft = createRequestObservationDraft({
    context,
    outcome: 'failed_session_save',
    admissionRejectionReason: 'not_applicable',
    sessionSaveDurationMs: 4,
    terminalObservationId: result.terminal.snapshot.observationId
  })
  assert.equal(projectFinalPresentation(Object.freeze({
    ...result,
    requestObservationDraft: failedSaveDraft,
    sessionPersistence: 'failed'
  })).sessionPersistence, 'failed')

  const proactiveContext = activateRequestObservation({
    context: beginRequestObservation({
      requestRef: '5'.repeat(32),
      requestKind: 'proactive_chat',
      startedAtMonotonicMs: 15
    }),
    runRef,
    queueDurationMs: 1,
    sessionLoadDurationMs: 'not_attempted'
  })
  const proactiveDraft = createRequestObservationDraft({
    context: proactiveContext,
    outcome: 'completed',
    admissionRejectionReason: 'not_applicable',
    sessionSaveDurationMs: 'not_attempted',
    terminalObservationId: result.terminal.snapshot.observationId
  })
  assert.equal(projectFinalPresentation(Object.freeze({
    ...result,
    requestObservationDraft: proactiveDraft,
    sessionPersistence: 'not_attempted'
  })).sessionPersistence, 'not_attempted')
})

test('request-scoped presentation lifecycle owns the initial claimed run', async () => {
  const runId = 'request-scoped-lifecycle'
  const runRef = '4'.repeat(32)
  const calls: string[] = []
  let fallbackFactoryCalls = 0
  const interruption = Object.freeze({
    schemaVersion: 1 as const,
    approvalId: 'request-scoped-approval',
    runId,
    step: 0,
    callId: 'request-scoped-call',
    toolFingerprint: 'a'.repeat(64),
    argumentHash: 'b'.repeat(64),
    action: 'website',
    target: 'none',
    keyParameters: Object.freeze([]),
    requester: Object.freeze({ userId: 'actor-1', role: 'bot_master' as const }),
    approverPolicy: Object.freeze({
      profile: 'safe' as const,
      allowedRoles: Object.freeze(['bot_master'] as const),
      eligibleActorIds: Object.freeze(['actor-1']),
      requireDifferentActor: false
    }),
    approvalAddress: request('request-scoped-address', 'unused').sessionAddress,
    createdAt
  })
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => noOpLease()
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({
      start: async (_input, options) => {
        await options?.afterCheckpointCreated?.({
          runId,
          runRef,
          observationPolicy: Object.freeze({
            schemaVersion: 1,
            levelAtStart: 'basic',
            sampledSuccess: false
          })
        })
        return Object.freeze({
          kind: 'paused' as const,
          runId,
          runRef,
          interruption
        })
      }
    }),
    createRuntime: async () => contractRuntime(),
    createPresentationLifecycle: async () => {
      fallbackFactoryCalls += 1
      throw new Error('fallback lifecycle must not be constructed')
    },
    generateId: () => runId,
    createRunRef: () => runRef
  })
  const lifecycle = Object.freeze({
    async onRunStarted (input: {
      readonly runId: string
      readonly runRef: string
    }) {
      calls.push(`start:${input.runId}:${input.runRef}`)
    },
    async onRunSettled (input: {
      readonly runId: string
      readonly status: 'paused' | 'terminal'
    }) {
      calls.push(`settle:${input.runId}:${input.status}`)
    }
  })

  const output = await service.handle(
    request('request-scoped-lifecycle', '需要审批'),
    { presentationLifecycle: lifecycle }
  )

  assert.equal(output.kind, 'paused')
  assert.equal(fallbackFactoryCalls, 0)
  assert.deepEqual(calls, [
    `start:${runId}:${runRef}`,
    `settle:${runId}:paused`
  ])
})

test('same-process resume reuses one active request context and creates one final draft', async () => {
  const runRef = '8'.repeat(32)
  const runId = 'same-process-resume'
  const interruption = Object.freeze({
    schemaVersion: 1 as const,
    approvalId: 'same-process-approval',
    runId,
    step: 0,
    callId: 'same-process-call',
    toolFingerprint: 'a'.repeat(64),
    argumentHash: 'b'.repeat(64),
    action: 'website',
    target: 'none',
    keyParameters: Object.freeze([]),
    requester: Object.freeze({ userId: 'actor-1', role: 'bot_master' as const }),
    approverPolicy: Object.freeze({
      profile: 'safe' as const,
      allowedRoles: Object.freeze(['bot_master'] as const),
      eligibleActorIds: Object.freeze(['actor-1']),
      requireDifferentActor: false
    }),
    approvalAddress: request('same-process-address', 'unused').sessionAddress,
    createdAt
  })
  const terminal = completedResult(
    runId,
    runRef,
    Object.freeze({ kind: 'reply_text', text: '恢复完成' })
  )
  let monotonic = 200
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => noOpLease()
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({
      start: async () => Object.freeze({
        kind: 'paused' as const,
        runId,
        runRef,
        interruption
      }),
      resume: async () => terminal
    }),
    createRuntime: async () => contractRuntime(),
    generateId: () => runId,
    createRunRef: () => runRef,
    monotonicNow: () => monotonic++
  })

  const paused = await service.handle(request('same-process', '等待后恢复'))
  assert.equal(paused.kind, 'paused')
  if (paused.kind !== 'paused') assert.fail('run did not pause')
  const activeContext = paused.requestObservationContext
  for (const forbidden of [
    'outcome', 'sessionSaveDurationMs', 'terminalObservationId',
    'requestObservationDraft', 'sessionPersistence'
  ]) {
    assert.equal(Object.hasOwn(paused, forbidden), false)
  }

  const resumed = await service.resume(runId)
  assert.notEqual(resumed, null)
  if (resumed === null || resumed.kind === 'approval_deferred') {
    assert.fail('same-process resume did not return a final envelope')
  }
  assert.equal(resumed.kind, 'completed')
  assert.equal(resumed.requestObservationDraft.requestRef, activeContext.requestRef)
  assert.equal(resumed.requestObservationDraft.runRef, activeContext.runRef)
  assert.equal(
    resumed.requestObservationDraft.startedAtMonotonicMs,
    activeContext.startedAtMonotonicMs
  )
  assert.equal(await service.resume(runId), null)
})

test('approval recovery defers each admission failure and retries with restart durations', async () => {
  const runId = 'restarted-approval-run'
  const runRef = '9'.repeat(32)
  const requestRef = 'a'.repeat(32)
  const checkpoint = Object.freeze({
    runId,
    runRef,
    requestRef,
    requestKind: 'ordinary_chat' as const,
    status: 'waiting_approval' as const,
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    events: Object.freeze([])
  }) as unknown as RunCheckpoint
  const recoveryErrors = [
    new RunAdmissionRejectionError('queue_full'),
    new RunAdmissionRejectionError('queue_aborted'),
    new Error('private redis recovery failure')
  ]
  let recoverCalls = 0
  let releases = 0
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => {
        const error = recoveryErrors[recoverCalls++]
        if (error !== undefined) throw error
        return Object.freeze({
          ...noOpLease(),
          release: async () => { releases += 1 }
        })
      }
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({
      loadCheckpoint: async () => checkpoint,
      decideApproval: async input => completedResult(
        input.runId,
        runRef,
        Object.freeze({ kind: 'reply_text', text: '重启恢复完成' })
      )
    }),
    createRuntime: async () => contractRuntime(),
    recoverRuntime: async () => contractRuntime()
  })
  const decision = Object.freeze({
    runId,
    approvalId: 'restarted-approval',
    kind: 'approved' as const,
    decidedAt: createdAt,
    sessionAddress: request('restart-address', 'unused').sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'bot_master' as const })
  })

  for (const reason of ['queue_full', 'queue_aborted', 'unavailable'] as const) {
    const deferred = await service.decideApproval(decision)
    assert.deepEqual(deferred, {
      kind: 'approval_deferred',
      reason,
      retryable: true,
      runRef,
      requestRef
    })
    assert.equal(deferred === null ? false : Object.hasOwn(deferred, 'requestObservationDraft'), false)
  }

  const completed = await service.decideApproval(decision)
  assert.notEqual(completed, null)
  if (completed === null || completed.kind === 'approval_deferred') {
    assert.fail('recovery retry did not reach the terminal envelope')
  }
  assert.equal(completed.kind, 'completed')
  assert.equal(completed.requestObservationDraft.requestRef, requestRef)
  assert.equal(completed.requestObservationDraft.runRef, runRef)
  assert.equal(completed.requestObservationDraft.startedAtMonotonicMs, 'unavailable')
  assert.equal(completed.requestObservationDraft.queueDurationMs, 'unavailable')
  assert.equal(completed.requestObservationDraft.sessionLoadDurationMs, 'unavailable')
  assert.equal(completed.requestObservationDraft.sessionSaveDurationMs, 'not_attempted')
  assert.equal(completed.sessionPersistence, 'not_attempted')
  assert.equal(recoverCalls, 4)
  assert.equal(releases, 1)
})

test('approval recovery infrastructure failure never masquerades as a missing run', async () => {
  const runId = 'recovery-infrastructure-failure'
  const runRef = 'c'.repeat(32)
  const checkpoint = Object.freeze({
    runId,
    runRef,
    requestRef: 'd'.repeat(32),
    requestKind: 'ordinary_chat' as const,
    status: 'waiting_approval' as const,
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    events: Object.freeze([])
  }) as unknown as RunCheckpoint
  let releases = 0
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => Object.freeze({
        ...noOpLease(),
        release: async () => { releases += 1 }
      })
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({
      loadCheckpoint: async () => checkpoint
    }),
    createRuntime: async () => contractRuntime(),
    recoverRuntime: async () => {
      throw new Error('injected private recovery runtime failure')
    }
  })

  await assert.rejects(service.decideApproval({
    runId,
    approvalId: 'recovery-infrastructure-approval',
    kind: 'approved',
    decidedAt: createdAt,
    sessionAddress: request('recovery-failure-address', 'unused').sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'bot_master' })
  }), /injected private recovery runtime failure/)
  assert.equal(releases, 1)
})

test('restart recovery observes a pre-aborted signal before resume or approval decision', async () => {
  const runId = 'restart-pre-aborted'
  const runRef = 'e'.repeat(32)
  const requestRef = 'f'.repeat(32)
  const checkpoint = Object.freeze({
    runId,
    runRef,
    requestRef,
    requestKind: 'ordinary_chat' as const,
    status: 'waiting_approval' as const,
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    events: Object.freeze([])
  }) as unknown as RunCheckpoint
  const observedAbortState: boolean[] = []
  const createService = (): AgentService => new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => noOpLease(),
      recover: async (_checkpoint, signal) => {
        observedAbortState.push(signal?.aborted === true)
        if (signal?.aborted === true) {
          throw new RunAdmissionRejectionError('queue_aborted')
        }
        return noOpLease()
      }
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({ loadCheckpoint: async () => checkpoint }),
    createRuntime: async () => contractRuntime(),
    recoverRuntime: async () => contractRuntime()
  })
  const controller = new AbortController()
  controller.abort('caller_abort')
  const expected = {
    kind: 'approval_deferred',
    reason: 'queue_aborted',
    retryable: true,
    runRef,
    requestRef
  }

  const resumed = await createService().resume(runId, { signal: controller.signal })
  const decided = await createService().decideApproval({
    runId,
    approvalId: 'restart-pre-aborted-approval',
    kind: 'approved',
    decidedAt: createdAt,
    sessionAddress: request('restart-pre-aborted-address', 'unused').sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'bot_master' })
  }, { signal: controller.signal })

  assert.deepEqual(resumed, expected)
  assert.deepEqual(decided, expected)
  assert.deepEqual(observedAbortState, [true, true])
})

test('resume cleanup preserves a terminal cancellation and delivers both callbacks', async () => {
  const runId = 'resume-cleanup-terminal'
  const runRef = '1'.repeat(32)
  const interruption = Object.freeze({
    schemaVersion: 1 as const,
    approvalId: 'resume-cleanup-approval',
    runId,
    step: 0,
    callId: 'resume-cleanup-call',
    toolFingerprint: 'a'.repeat(64),
    argumentHash: 'b'.repeat(64),
    action: 'website',
    target: 'none',
    keyParameters: Object.freeze([]),
    requester: Object.freeze({ userId: 'actor-1', role: 'bot_master' as const }),
    approverPolicy: Object.freeze({
      profile: 'safe' as const,
      allowedRoles: Object.freeze(['bot_master'] as const),
      eligibleActorIds: Object.freeze(['actor-1']),
      requireDifferentActor: false
    }),
    approvalAddress: request('resume-cleanup-address', 'unused').sessionAddress,
    createdAt
  })
  const committed = cancelledResult(runId, runRef, 'service_failure')
  const observed: string[] = []
  let releases = 0
  const service = new AgentService({
    sessions: contractSessions(),
    runStore: new InMemoryRunStore(),
    admission: {
      acquire: async () => Object.freeze({
        ...noOpLease(),
        release: async () => { releases += 1 }
      }),
      recover: async () => noOpLease()
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: () => contractEngine({
      start: async () => Object.freeze({
        kind: 'paused' as const,
        runId,
        runRef,
        interruption
      }),
      resume: async () => { throw new Error('injected resume failure') },
      cancel: async () => committed
    }),
    createRuntime: async () => contractRuntime(),
    generateId: () => runId,
    createRunRef: () => runRef,
    onTerminalSnapshot: snapshot => { observed.push(`snapshot:${snapshot.observationId}`) },
    onTerminalCommitReceipt: receipt => { observed.push(`receipt:${receipt.observationId}`) }
  })

  const paused = await service.handle(request('resume-cleanup', '等待恢复清理'))
  assert.equal(paused.kind, 'paused')
  const outcome = await service.resume(runId)

  assert.notEqual(outcome, null)
  if (outcome === null || outcome.kind === 'approval_deferred') {
    assert.fail('resume cleanup did not return a final envelope')
  }
  assert.equal(outcome.kind, 'cancelled')
  if (outcome.kind !== 'cancelled') assert.fail('resume cleanup rewrote cancellation as failure')
  assert.deepEqual(outcome.terminal, committed.terminal)
  assert.equal(outcome.requestObservationDraft.outcome, 'completed')
  assert.equal(
    outcome.requestObservationDraft.terminalObservationId,
    committed.terminal?.snapshot.observationId
  )
  assert.equal(outcome.sessionPersistence, 'not_attempted')
  assert.deepEqual(observed, [
    `snapshot:${committed.terminal?.snapshot.observationId}`,
    `receipt:${committed.terminal?.receipt.observationId}`
  ])
  assert.equal(releases, 1)
})

test('real RunEngine create failure never exposes the unclaimed candidate run reference', async () => {
  const base = new InMemoryRunStore()
  const runStore: RunStore = Object.freeze({
    create: async () => { throw new Error('injected run store create failure') },
    load: base.load.bind(base),
    upgrade: base.upgrade.bind(base),
    compareAndSet: base.compareAndSet.bind(base),
    appendEvents: base.appendEvents.bind(base),
    commitTerminal: base.commitTerminal.bind(base),
    loadTombstone: base.loadTombstone.bind(base),
    observationUsage: base.observationUsage.bind(base)
  })
  let providerCalls = 0
  let generated = 0
  const candidateRunRef = '2'.repeat(32)
  const service = new AgentService({
    sessions: contractSessions(),
    runStore,
    admission: {
      acquire: async () => noOpLease(),
      recover: async () => noOpLease()
    },
    contextEngine: contractContextEngine(),
    progressPresenter: new RunProgressPresenter(),
    createEngine: observer => new RunEngine({
      adapter: Object.freeze({
        complete: async () => {
          providerCalls += 1
          return Object.freeze({
            text: 'must not run', finishReason: 'stop' as const,
            toolCalls: Object.freeze([])
          })
        }
      }),
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: new ServiceToolRuntime() }),
      store: runStore,
      budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
      now: () => new Date(createdAt),
      generateId: () => `create-failure-engine-${++generated}`,
      observer
    }),
    createRuntime: async () => contractRuntime(),
    generateId: () => `create-failure-service-${++generated}`,
    createRunRef: () => candidateRunRef,
    monotonicNow: () => generated++
  })

  const outcome = await service.handle(request('create-failure', '验证创建失败'))

  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.runRef, 'unavailable')
  assert.equal(outcome.terminal, null)
  assert.equal(outcome.requestObservationDraft.outcome, 'failed_run_create')
  assert.equal(outcome.requestObservationDraft.runRef, 'unavailable')
  assert.equal(outcome.requestObservationDraft.terminalObservationId, 'not_attempted')
  assert.equal(outcome.sessionPersistence, 'not_attempted')
  assert.equal(providerCalls, 0)
})

test('AgentService owns context, progress, run execution and terminal session writes', async () => {
  const redis = new FakeRedis(() => Date.parse(createdAt))
  const persistedSessions = new RedisAgentSessionStore({
    redis, now: () => new Date(createdAt), generateId: () => 'session-1'
  })
  let rejectSessionSave = false
  let rejectSnapshotObserver = false
  let rejectReceiptObserver = false
  const terminalOrder: string[] = []
  const sessions: SessionStore<AgentSessionState> = {
    get: async (address, options) => await persistedSessions.get(address, options),
    save: async (record, options) => {
      terminalOrder.push('session_save')
      if (rejectSessionSave) throw new Error('injected terminal session save failure')
      await persistedSessions.save(record, options)
    },
    delete: async (address, options) => await persistedSessions.delete(address, options),
    list: (query, options) => persistedSessions.list(query, options),
    deleteAll: async (query, options) => await persistedSessions.deleteAll(query, options),
    fork: async (source, target, startedBy, options) => (
      await persistedSessions.fork(source, target, startedBy, options)
    )
  }
  const runStore = new InMemoryRunStore()
  const adapter = new ServiceAdapter()
  const toolRuntime = new ServiceToolRuntime()
  const definitions = Object.freeze([toolDefinition('website'), toolDefinition('weather')])
  const snapshot = new ToolRegistry(definitions).createSnapshot({
    id: 'snapshot-service-1', facts, enabledTools: definitions.map(value => value.name)
  })
  const progress: string[] = []
  let generated = 0
  const presenter = new RunProgressPresenter()
  const service = new AgentService({
    sessions,
    runStore,
    admission: new RunAdmission({ client: redis, generateId: () => `lease-${++generated}` }),
    contextEngine: new ContextEngine({
      estimator: {
        estimate: message => Math.max(1, Math.ceil(JSON.stringify(message.parts).length / 4)),
        estimateModelMessage: message => Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
      },
      memoryStore: new NoopMemoryStore()
    }),
    progressPresenter: presenter,
    createEngine: observer => new RunEngine({
      adapter,
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: toolRuntime }),
      store: runStore,
      budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
      now: () => new Date(createdAt),
      generateId: () => `engine-${++generated}`,
      observer
    }),
    createRuntime: async () => Object.freeze({
      binding: Object.freeze({
        snapshot,
        prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
          runId: 'service-run-1', profile: 'compatible', facts, intent, now: createdAt
        }),
        contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
          runId: 'service-run-1', profile: 'compatible', facts, intent, now: createdAt
        })
      }),
      progress: async (text: string) => { progress.push(text) }
    }),
    now: () => new Date(createdAt),
    generateId: () => `service-run-${++generated}`,
    onTerminalSnapshot: (snapshot: RunTerminalSnapshotV2) => {
      terminalOrder.push('snapshot')
      if (rejectSnapshotObserver) throw new Error('private snapshot observer failure')
      assert.match(snapshot.observationId, /^[0-9a-f]{64}$/)
    },
    onTerminalCommitReceipt: (receipt: TerminalCommitReceiptV1) => {
      terminalOrder.push('receipt')
      if (rejectReceiptObserver) throw new Error('private receipt observer failure')
      assert.match(receipt.observationId, /^[0-9a-f]{64}$/)
    }
  })

  const completed = await service.handle(request('request-1', '请完成两阶段任务'), {
    signal: new AbortController().signal
  })
  assert.equal(completed.kind, 'completed')
  assert.equal(completed.kind === 'completed' && completed.completion.kind === 'reply_text'
    ? completed.completion.text
    : '', '任务完成。')
  assert.equal(completed.kind === 'completed' ? completed.sessionPersistence : null, 'saved')
  assert.equal(
    completed.kind === 'completed' ? completed.requestObservationDraft.outcome : null,
    'completed'
  )
  assert.equal(
    completed.kind === 'completed'
      ? completed.requestObservationDraft.terminalObservationId
      : null,
    completed.kind === 'completed' ? completed.terminal.snapshot.observationId : null
  )
  assert.equal(
    completed.kind === 'completed'
      ? Object.hasOwn(completed.requestObservationDraft, 'requestDurationMs')
      : true,
    false
  )
  assert.deepEqual(terminalOrder, ['snapshot', 'receipt', 'session_save'])
  assert.equal(adapter.requests.length, 2)
  assert.deepEqual(progress, ['正在读取网页（步骤 1）', '正在查询天气（步骤 2）'])
  assert.equal(adapter.requests[1]?.messages.some(message => (
    message.role === 'user' && message.content === 'internal companion text'
  )), false)

  const stored = await sessions.get(request('lookup', 'unused').sessionAddress)
  assert.equal(stored?.turnCount, 1)
  assert.deepEqual(stored?.state.messages.map(item => (
    item.kind === 'message' ? item.message.role : item.kind
  )), ['user', 'assistant'])

  terminalOrder.length = 0
  const invalidEphemeral = await service.handleEphemeral(request(
    'request-invalid-ephemeral',
    '入口类型不匹配'
  ))
  assert.equal(invalidEphemeral.kind, 'failed')
  assert.equal(invalidEphemeral.requestObservationDraft.outcome, 'failed_request_validation')

  const ephemeral = await service.handleEphemeral(request(
    'request-2',
    '临时任务',
    'proactive_chat'
  ), {
    signal: new AbortController().signal
  })
  assert.equal(ephemeral.kind, 'completed')
  assert.equal(ephemeral.kind === 'completed' ? ephemeral.sessionPersistence : null, 'not_attempted')
  assert.deepEqual(terminalOrder, ['snapshot', 'receipt'])
  assert.equal((await sessions.get(request('lookup', 'unused').sessionAddress))?.turnCount, 1)

  const callerAbort = new AbortController()
  callerAbort.abort('untrusted cancellation detail')
  const aborted = await service.handle(request('request-aborted', '不应进入模型'), {
    signal: callerAbort.signal
  })
  assert.equal(aborted.kind, 'cancelled')
  assert.equal(aborted.kind === 'cancelled' ? aborted.reason : null, 'user_cancelled')
  assert.equal(aborted.runRef, 'unavailable')
  assert.equal(aborted.requestObservationDraft.outcome, 'rejected_admission')
  assert.equal(aborted.requestObservationDraft.admissionRejectionReason, 'queue_aborted')
  assert.equal(aborted.sessionPersistence, 'not_attempted')

  rejectSessionSave = true
  rejectSnapshotObserver = true
  rejectReceiptObserver = true
  terminalOrder.length = 0
  const committedBeforeSessionFailure = await service.handle(
    request('request-3', '保留已提交终态'),
    { signal: new AbortController().signal }
  )
  assert.equal(committedBeforeSessionFailure.kind, 'completed')
  assert.equal(committedBeforeSessionFailure.kind === 'completed' &&
    committedBeforeSessionFailure.completion.kind === 'reply_text'
    ? committedBeforeSessionFailure.completion.text
    : null, '终态已提交。')
  assert.equal(committedBeforeSessionFailure.kind === 'completed'
    ? committedBeforeSessionFailure.sessionPersistence
    : null, 'failed')
  assert.equal(committedBeforeSessionFailure.kind === 'completed'
    ? committedBeforeSessionFailure.requestObservationDraft.outcome
    : null, 'failed_session_save')
  assert.equal(committedBeforeSessionFailure.terminal.snapshot.status, 'completed')
  assert.equal(committedBeforeSessionFailure.terminal.snapshot.runRef, committedBeforeSessionFailure.runRef)
  assert.equal(committedBeforeSessionFailure.terminal.receipt.runRef, committedBeforeSessionFailure.runRef)
  assert.equal(await runStore.load(committedBeforeSessionFailure.runId), null)
  assert.deepEqual(terminalOrder, ['snapshot', 'receipt', 'session_save'])

  const firstBridge = new AgentServiceBridge(service)
  const secondBridge = new AgentServiceBridge(service)
  assert.notEqual(firstBridge, secondBridge)
  assert.equal(firstBridge.conversations, service.conversations)
  assert.equal(secondBridge.conversations, service.conversations)
})

test('AgentService retries one runRef collision and fails the second with zero model or tool calls', async () => {
  for (const collisions of [1, 2]) {
    const redis = new FakeRedis(() => Date.parse(createdAt))
    const sessions = new RedisAgentSessionStore({
      redis,
      now: () => new Date(createdAt),
      generateId: () => `session-collision-${collisions}`
    })
    const runStore = new InjectedCollisionRunStore(collisions)
    let providerCalls = 0
    let toolPreparations = 0
    let toolExecutions = 0
    let runtimeCreations = 0
    const adapter: ModelAdapter = Object.freeze({
      complete: async () => {
        providerCalls += 1
        return Object.freeze({
          text: '碰撞恢复完成。',
          finishReason: 'stop' as const,
          toolCalls: Object.freeze([])
        })
      }
    })
    const delegateRuntime = new ServiceToolRuntime()
    const toolRuntime: ToolRuntime = Object.freeze({
      prepare: async (...args: Parameters<ToolRuntime['prepare']>) => {
        toolPreparations += 1
        return await delegateRuntime.prepare(args[0])
      },
      executePrepared: async (...args: Parameters<ToolRuntime['executePrepared']>) => {
        toolExecutions += 1
        return await delegateRuntime.executePrepared(args[0])
      }
    })
    const definitions = Object.freeze([toolDefinition('website')])
    const snapshot = new ToolRegistry(definitions).createSnapshot({
      id: `snapshot-collision-${collisions}`,
      facts,
      enabledTools: ['website']
    })
    let generated = 0
    let runRefIndex = 0
    const runRefs = ['5'.repeat(32), '6'.repeat(32)] as const
    const service = new AgentService({
      sessions,
      runStore,
      admission: new RunAdmission({
        client: redis,
        generateId: () => `collision-lease-${collisions}-${++generated}`
      }),
      contextEngine: new ContextEngine({
        estimator: {
          estimate: message => Math.max(1, Math.ceil(JSON.stringify(message.parts).length / 4)),
          estimateModelMessage: message => Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
        },
        memoryStore: new NoopMemoryStore()
      }),
      progressPresenter: new RunProgressPresenter(),
      createEngine: observer => new RunEngine({
        adapter,
        profile: standardOpenAIProfile,
        scheduler: new ToolScheduler({ runtime: toolRuntime }),
        store: runStore,
        budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
        now: () => new Date(createdAt),
        generateId: () => `collision-engine-${collisions}-${++generated}`,
        observer
      }),
      createRuntime: async () => {
        runtimeCreations += 1
        return Object.freeze({
          binding: Object.freeze({
            snapshot,
            prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
              runId: 'collision-run', profile: 'compatible', facts, intent, now: createdAt
            }),
            contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
              runId: 'collision-run', profile: 'compatible', facts, intent, now: createdAt
            })
          })
        })
      },
      now: () => new Date(createdAt),
      generateId: () => `collision-service-${collisions}-${++generated}`,
      createRunRef: () => runRefs[Math.min(runRefIndex++, 1)]
    })

    const result = await service.handle(request(
      `collision-request-${collisions}`,
      '验证运行引用碰撞'
    ))

    assert.equal(runStore.createCalls, 2)
    assert.equal(runtimeCreations, 1)
    if (collisions === 1) {
      assert.equal(result.kind, 'completed')
      assert.equal(result.runRef, runRefs[1])
      assert.equal(providerCalls, 1)
      assert.equal(await runStore.base.load(result.runId), null)
      assert.equal(
        result.kind === 'completed' ? result.terminal.snapshot.runRef : null,
        runRefs[1]
      )
      assert.equal(
        (await runStore.base.loadTombstone(result.runId))?.runRef,
        runRefs[1]
      )
    } else {
      assert.equal(result.kind, 'failed')
      assert.equal(result.kind === 'failed' ? result.error.code : null, 'checkpoint_conflict')
      assert.equal(await runStore.base.load(result.runId), null)
      assert.equal(providerCalls, 0)
    }
    assert.equal(toolPreparations, 0)
    assert.equal(toolExecutions, 0)
  }
})

test('AgentService serializes active runs for the same canonical session', async () => {
  const redis = new FakeRedis(() => Date.parse(createdAt))
  const sessions = new RedisAgentSessionStore({
    redis, now: () => new Date(createdAt), generateId: () => 'session-serial'
  })
  const runStore = new InMemoryRunStore()
  const adapter = new SerialAdapter()
  const definitions = Object.freeze([toolDefinition('website')])
  const snapshot = new ToolRegistry(definitions).createSnapshot({
    id: 'snapshot-service-serial', facts, enabledTools: ['website']
  })
  let generated = 0
  const service = new AgentService({
    sessions,
    runStore,
    admission: new RunAdmission({ client: redis, generateId: () => `serial-lease-${++generated}` }),
    contextEngine: new ContextEngine({
      estimator: {
        estimate: message => Math.max(1, Math.ceil(JSON.stringify(message.parts).length / 4)),
        estimateModelMessage: message => Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
      },
      memoryStore: new NoopMemoryStore()
    }),
    progressPresenter: new RunProgressPresenter(),
    createEngine: observer => new RunEngine({
      adapter,
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: new ServiceToolRuntime() }),
      store: runStore,
      budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
      now: () => new Date(createdAt),
      generateId: () => `serial-engine-${++generated}`,
      observer
    }),
    createRuntime: async () => Object.freeze({
      binding: Object.freeze({
        snapshot,
        prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
          runId: 'serial-run', profile: 'compatible', facts, intent, now: createdAt
        }),
        contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
          runId: 'serial-run', profile: 'compatible', facts, intent, now: createdAt
        })
      })
    }),
    now: () => new Date(createdAt),
    generateId: () => `serial-service-${++generated}`
  })

  const first = service.handle(request('serial-1', '第一条消息'))
  await adapter.firstStarted
  const second = service.handle(request('serial-2', '第二条消息'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.peak, 1)

  adapter.releaseFirst()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(result => result.kind), ['completed', 'completed'])
  assert.equal(adapter.requests.length, 2)
  assert.equal(adapter.peak, 1)
  assert.equal(adapter.requests[1]?.messages.some(message => (
    message.role === 'assistant' && message.content === '第 1 次完成。'
  )), true)
  assert.equal((await sessions.get(request('lookup', 'unused').sessionAddress))?.turnCount, 2)
})

test('AgentService cancellation releases a paused run and shutdown waits for approval control', async () => {
  const redis = new FakeRedis(() => Date.parse(createdAt))
  const sessions = new RedisAgentSessionStore({
    redis, now: () => new Date(createdAt), generateId: () => 'session-cancel'
  })
  const runStore = new InMemoryRunStore()
  const turns: ModelTurn[] = [
    Object.freeze({
      text: '', finishReason: 'tool_calls',
      toolCalls: Object.freeze([Object.freeze({
        index: 0, callId: 'call-approval', name: 'website',
        argumentsText: '{"value":"one"}', arguments: Object.freeze({ value: 'one' })
      })])
    }),
    Object.freeze({
      text: '取消后可继续。', finishReason: 'stop', toolCalls: Object.freeze([])
    })
  ]
  const adapter: ModelAdapter = Object.freeze({
    complete: async () => {
      const turn = turns.shift()
      if (turn === undefined) throw new Error('cancel adapter script exhausted')
      return turn
    }
  })
  const definitions = Object.freeze([toolDefinition('website')])
  const snapshot = new ToolRegistry(definitions).createSnapshot({
    id: 'snapshot-service-cancel', facts, enabledTools: ['website']
  })
  const toolRuntime = new ServiceToolRuntime(true)
  let generated = 0
  let blockResumedPresentation = false
  let markResumeStarted = (): void => undefined
  let releaseResumedPresentation = (): void => undefined
  const resumeStarted = new Promise<void>(resolve => { markResumeStarted = resolve })
  const resumeRelease = new Promise<void>(resolve => { releaseResumedPresentation = resolve })
  const service = new AgentService({
    sessions,
    runStore,
    admission: new RunAdmission({
      client: redis, generateId: () => `cancel-lease-${++generated}`
    }),
    contextEngine: new ContextEngine({
      estimator: {
        estimate: message => Math.max(1, Math.ceil(JSON.stringify(message.parts).length / 4)),
        estimateModelMessage: message => Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
      },
      memoryStore: new NoopMemoryStore()
    }),
    progressPresenter: new RunProgressPresenter(),
    createEngine: observer => new RunEngine({
      adapter,
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: toolRuntime }),
      store: runStore,
      budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
      now: () => new Date(createdAt),
      generateId: () => `cancel-engine-${++generated}`,
      observer
    }),
    createRuntime: async () => Object.freeze({
      binding: Object.freeze({
        snapshot,
        prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
          runId: 'cancel-run', profile: 'safe', facts, intent, now: createdAt
        }),
        contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
          runId: 'cancel-run', profile: 'safe', facts, intent, now: createdAt
        }),
        approvalControlContext: async () => Object.freeze({
          eligibleApprovers: Object.freeze([
            Object.freeze({ userId: 'actor-1', role: 'bot_master' as const })
          ])
        })
      })
    }),
    createPresentationLifecycle: () => Object.freeze({
      onRunStarted: async () => {
        if (!blockResumedPresentation) return
        markResumeStarted()
        await resumeRelease
      },
      onRunSettled: async () => undefined
    }),
    now: () => new Date(createdAt),
    generateId: () => `cancel-service-${++generated}`
  })

  const paused = await service.handle(request('cancel-1', '执行需要审批的任务'))
  assert.equal(paused.kind, 'paused')
  const cancelled = await service.cancel(paused.runId, 'approval_delivery_failed')
  if (cancelled === null) assert.fail('pending cancellation must return an envelope')
  assert.equal(cancelled.kind, 'cancelled')

  const next = await service.handle(request('cancel-2', '继续下一轮'))
  assert.equal(next.kind, 'completed')
  assert.equal(next.kind === 'completed' && next.completion.kind === 'reply_text'
    ? next.completion.text
    : null, '取消后可继续。')

  turns.push(Object.freeze({
    text: '', finishReason: 'tool_calls',
    toolCalls: Object.freeze([Object.freeze({
      index: 0, callId: 'call-shutdown-approval', name: 'website',
      argumentsText: '{"value":"shutdown"}',
      arguments: Object.freeze({ value: 'shutdown' })
    })])
  }))
  const pendingShutdown = await service.handle(
    request('cancel-3', '等待审批后关闭进程')
  )
  assert.equal(pendingShutdown.kind, 'paused')
  if (pendingShutdown.kind !== 'paused') return
  assert.ok(await service.displayApproval({
    runId: pendingShutdown.runId,
    approvalId: pendingShutdown.interruption.approvalId,
    messageId: 'shutdown-approval-message',
    displayedAt: '2026-07-17T00:00:01.000Z',
    ttlSeconds: 120
  }) !== null)

  blockResumedPresentation = true
  const decision = service.decideApproval({
    runId: pendingShutdown.runId,
    approvalId: pendingShutdown.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-17T00:00:02.000Z',
    sessionAddress: pendingShutdown.interruption.approvalAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'bot_master' as const })
  })
  await resumeStarted

  let shutdownSettled = false
  const shutdown = service.shutdown('process_shutdown').then(value => {
    shutdownSettled = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shutdownSettled, false)
  const waitingDuringShutdown = await runStore.load(pendingShutdown.runId)
  assert.ok(waitingDuringShutdown !== null)
  if (waitingDuringShutdown.schemaVersion === 1) {
    assert.fail('shutdown race fixture must persist a resumable v2+ checkpoint')
  }
  assert.equal(waitingDuringShutdown.status, 'waiting_approval')
  assert.equal(waitingDuringShutdown.engineActivity.state, 'idle')
  assert.equal(waitingDuringShutdown.providerDispatch.state, 'idle')
  assert.deepEqual(toolRuntime.executions, [])
  releaseResumedPresentation()

  const [decisionResult, cancelledCount] = await Promise.all([decision, shutdown])
  assert.equal(decisionResult?.kind, 'cancelled')
  assert.deepEqual(toolRuntime.executions, [])
  assert.equal(cancelledCount, 1)
  assert.equal(await service.shutdown('ignored_second_reason'), 1)
  const shutdownCheckpoint = await runStore.loadTombstone(pendingShutdown.runId)
  assert.equal(shutdownCheckpoint?.status, 'cancelled')
  assert.equal(shutdownCheckpoint?.cancellationReason, 'process_shutdown')

  const afterShutdown = await service.handle(
    request('cancel-4', '关闭后不应再启动新运行')
  )
  assert.equal(afterShutdown.kind, 'cancelled')
  assert.equal(
    afterShutdown.kind === 'cancelled' ? afterShutdown.reason : null,
    'process_shutdown'
  )
})
