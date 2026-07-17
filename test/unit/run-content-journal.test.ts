import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  nextRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import type {
  RunContentJournal,
  RunContentJournalEvent
} from '../../src/agent/run/run-content-journal.js'
import {
  RunEngine,
  type StartRunInput
} from '../../src/agent/run/run-engine.js'
import { createRunTerminalSnapshot } from '../../src/agent/run/run-observation.js'
import {
  RunStoreConflictError,
  type TerminalCommitReceiptV1
} from '../../src/agent/run/run-store.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import { ToolRegistry, type ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import {
  YunzaiAgentServiceBridge,
  type YunzaiAgentServiceBridgeOptions,
  type YunzaiMessageEvent
} from '../../src/runtime/agent-service-bridge.js'
import type { PreparedYunzaiMessageEvidenceV1 } from '../../src/runtime/message-input.js'
import type { GroupMateContentJournal } from '../../src/runtime/logging/groupmate-content-journal.js'
import type {
  YunzaiAgentToolRun,
  YunzaiToolRuntimeBridge
} from '../../src/runtime/tools/yunzai-tool-runtime.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'

const timestamp = '2026-07-14T00:00:00.000Z'

const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-journal',
  actor: Object.freeze({ userId: 'actor-journal', role: 'member', isBotMaster: false }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-journal', groupId: 'group-journal' }),
  scope: Object.freeze({ kind: 'group', groupId: 'group-journal' }),
  botGroupRole: 'member',
  actorGroupRole: 'member',
  targetRole: 'none',
  targetIsBotMaster: false,
  targetExists: false
})

const intent = Object.freeze({
  trustedSources: Object.freeze(['current_request'] as const),
  actions: Object.freeze([]),
  explicitTargetIds: Object.freeze([]),
  mentionUserIds: Object.freeze([]),
  currentMessageId: 'message-journal',
  replyMessageId: null
})

class NoToolsRuntime implements ToolRuntime {
  async prepare (
    _call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    throw new Error('no tools are available')
  }

  async executePrepared (
    _prepared: SerializablePreparedCapability,
    _context: ToolExecutionContext,
    _snapshot: ToolSnapshot,
    _signal: AbortSignal
  ): Promise<ToolResult> {
    throw new Error('no tools are available')
  }
}

class OneTurnAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []

  async complete (request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request)
    return Object.freeze({
      text: '终态日志完成',
      toolCalls: Object.freeze([]),
      finishReason: 'stop'
    })
  }
}

class RecordingTerminalStore extends InMemoryRunStore {
  readonly order: string[] = []
  checkpoint?: RunCheckpoint
  receipt?: TerminalCommitReceiptV1

  override async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: Parameters<InMemoryRunStore['commitTerminal']>[2]
  ): Promise<TerminalCommitReceiptV1> {
    this.order.push('commit.start')
    const receipt = await super.commitTerminal(expected, next, snapshot)
    this.checkpoint = next
    this.receipt = receipt
    this.order.push('commit.success')
    return receipt
  }
}

class LosingTerminalStore extends InMemoryRunStore {
  override async commitTerminal (
    expected: RunCheckpoint,
    _next: RunCheckpoint,
    _snapshot: Parameters<InMemoryRunStore['commitTerminal']>[2]
  ): Promise<TerminalCommitReceiptV1> {
    const concurrent = nextRunCheckpoint(expected, 'cancelled', {
      modelTurn: null,
      preparedBatch: null,
      interruption: null,
      providerDispatch: Object.freeze({ state: 'idle' }),
      engineActivity: Object.freeze({ state: 'idle' }),
      cancellationReason: 'concurrent_terminal'
    }, [], timestamp)
    await super.commitTerminal(
      expected,
      concurrent,
      createRunTerminalSnapshot(concurrent)
    )
    throw new RunStoreConflictError()
  }
}

class FailingTerminalStore extends InMemoryRunStore {
  override async commitTerminal (): Promise<TerminalCommitReceiptV1> {
    throw new Error('terminal store unavailable')
  }
}

function fixture (
  store: InMemoryRunStore,
  contentJournal: RunContentJournal
): Readonly<{
    engine: RunEngine
    input: StartRunInput
    adapter: OneTurnAdapter
  }> {
  const adapter = new OneTurnAdapter()
  const snapshot = new ToolRegistry([]).createSnapshot({
    id: 'snapshot-journal',
    facts,
    enabledTools: Object.freeze([])
  })
  let monotonic = 0
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: new NoToolsRuntime() }),
    store,
    budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 128 }),
    now: () => new Date(timestamp),
    monotonicNow: () => ++monotonic,
    generateId: (() => {
      let id = 0
      return () => `journal-id-${++id}`
    })(),
    contentJournal
  })
  const input: StartRunInput = Object.freeze({
    runId: 'run-journal',
    runRef: 'a'.repeat(32),
    requestRef: 'b'.repeat(32),
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      }),
      sessionAddress: Object.freeze({ botId: facts.botId, scope: facts.scope }),
      actorId: facts.actor.userId,
      requestMessageId: intent.currentMessageId
    }),
    observationPolicy: Object.freeze({
      schemaVersion: 1,
      levelAtStart: 'basic',
      sampledSuccess: false
    }),
    sessionId: 'session-journal',
    sessionAddress: Object.freeze({ botId: facts.botId, scope: facts.scope }),
    deadlineAt: '2026-07-14T00:04:00.000Z',
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 128,
      reasoning: Object.freeze({ enabled: false })
    }),
    runtime: Object.freeze({
      snapshot,
      prepareContext: async () => Object.freeze({
        messages: Object.freeze([{ role: 'user' as const, content: '记录完整终态' }]),
        estimatedInputTokens: 8
      }),
      prepareToolContext: async () => Object.freeze({
        runId: 'run-journal',
        profile: 'compatible' as const,
        facts,
        intent,
        now: timestamp
      }),
      contextFor: async () => Object.freeze({
        runId: 'run-journal',
        profile: 'compatible' as const,
        facts,
        intent,
        now: timestamp
      })
    })
  })
  return Object.freeze({ engine, input, adapter })
}

test('RunEngine journals the complete checkpoint and exact receipt only after terminal commit succeeds', async () => {
  const store = new RecordingTerminalStore()
  const events: RunContentJournalEvent[] = []
  const run = fixture(store, {
    record: event => {
      events.push(event)
      if (event.type === 'run.terminal_committed') {
        store.order.push('journal.terminal')
        throw new Error('terminal journal unavailable')
      }
    }
  })

  const result = await run.engine.start(run.input)

  assert.equal(result.kind, 'completed')
  assert.equal(result.kind === 'completed' ? result.output?.parts[0]?.type : null, 'text')
  assert.deepEqual(store.order, ['commit.start', 'commit.success', 'journal.terminal'])
  const terminal = events.find(event => event.type === 'run.terminal_committed')
  assert.notEqual(terminal, undefined)
  assert.equal(terminal?.type === 'run.terminal_committed' ? terminal.occurredAt : null, timestamp)
  assert.equal(terminal?.type === 'run.terminal_committed' ? terminal.runRef : null, run.input.runRef)
  assert.equal(terminal?.type === 'run.terminal_committed' ? terminal.requestRef : null, run.input.requestRef)
  assert.strictEqual(
    terminal?.type === 'run.terminal_committed' ? terminal.checkpoint : undefined,
    store.checkpoint
  )
  assert.strictEqual(
    terminal?.type === 'run.terminal_committed' ? terminal.receipt : undefined,
    store.receipt
  )
  assert.strictEqual(result.kind === 'completed' ? result.terminal.receipt : undefined, store.receipt)
})

test('RunEngine emits no terminal journal event when terminal CAS loses or commit fails', async () => {
  for (const store of [new LosingTerminalStore(), new FailingTerminalStore()]) {
    const events: RunContentJournalEvent[] = []
    const run = fixture(store, { record: event => { events.push(event) } })

    if (store instanceof LosingTerminalStore) {
      const result = await run.engine.start(run.input)
      assert.equal(result.kind, 'cancelled')
    } else {
      await assert.rejects(run.engine.start(run.input), /terminal store unavailable/)
    }
    assert.equal(events.some(event => event.type === 'run.terminal_committed'), false)
  }
})

test('Yunzai bridge journals the exact normalized request once before run claim and swallows failures', async () => {
  const order: string[] = []
  const journalRequests: YunzaiAgentRequestDraft[] = []
  const claimedRequests: YunzaiAgentRequestDraft[] = []
  const stopAfterClaim = new Error('stop after claim')
  const requestJournal: Pick<GroupMateContentJournal, 'recordRequest'> = {
    recordRequest: request => {
      order.push('journal.request')
      journalRequests.push(request)
      throw new Error('request journal unavailable')
    }
  }
  const toolSnapshot = new ToolRegistry([]).createSnapshot({
    id: 'snapshot-bridge-journal',
    facts,
    enabledTools: Object.freeze([])
  })
  const toolRun: YunzaiAgentToolRun = Object.freeze({
    profile: 'compatible',
    snapshot: toolSnapshot,
    promptAddition: '',
    systemAddition: '',
    binding: Object.freeze({
      snapshot: toolSnapshot,
      prepareToolContext: async () => Object.freeze({
        runId: 'run-bridge-journal',
        profile: 'compatible' as const,
        facts,
        intent,
        now: timestamp
      }),
      contextFor: async () => Object.freeze({
        runId: 'run-bridge-journal',
        profile: 'compatible' as const,
        facts,
        intent,
        now: timestamp
      }),
      approvalControlContext: async () => Object.freeze({
        eligibleApprovers: Object.freeze([])
      })
    })
  })
  const toolRuntime: YunzaiToolRuntimeBridge = {
    runtime: new NoToolsRuntime(),
    prepareAgentRun: async () => toolRun,
    recoverAgentRun: async () => toolRun
  }
  const options: YunzaiAgentServiceBridgeOptions = {
    config: Object.freeze({ model: 'fixture-model' }),
    redis: {} as YunzaiAgentServiceBridgeOptions['redis'],
    getMasterIds: async () => Object.freeze([]),
    getBotId: () => 'bot-journal',
    segment: () => Object.freeze({}),
    now: () => new Date(timestamp),
    generateId: () => 'request-bridge-journal',
    createRequestRef: () => 'c'.repeat(32),
    monotonicNow: () => 1
  }
  const constructorInput = {
    options,
    bridge: {
      handle: async (request: YunzaiAgentRequestDraft) => {
        order.push('run.claim')
        claimedRequests.push(request)
        throw stopAfterClaim
      }
    } as unknown as ConstructorParameters<typeof YunzaiAgentServiceBridge>[0]['bridge'],
    router: {} as ConstructorParameters<typeof YunzaiAgentServiceBridge>[0]['router'],
    toolRuntime,
    prepared: new Map(),
    outboundFactory: {} as ConstructorParameters<typeof YunzaiAgentServiceBridge>[0]['outboundFactory'],
    onApprovalOutcome: async () => undefined,
    rememberBot: () => undefined,
    requestJournal
  }
  const bridge = new YunzaiAgentServiceBridge(constructorInput)
  const event: YunzaiMessageEvent = {
    isGroup: true,
    group_id: 'group-journal',
    self_id: 'bot-journal',
    user_id: 'actor-journal',
    message_id: 'message-journal',
    sender: Object.freeze({
      user_id: 'actor-journal',
      nickname: '日志用户',
      role: 'member'
    }),
    message: Object.freeze([])
  }
  const messageEvidence: PreparedYunzaiMessageEvidenceV1 = Object.freeze({
    schemaVersion: 1,
    prompt: '记录完整标准化请求',
    imageUrls: Object.freeze([]),
    currentMessageId: 'message-journal',
    quotedMessageId: null,
    hasReply: false,
    replyResolved: false,
    currentSegmentCount: 1,
    replySegmentCount: 0,
    ocrTexts: Object.freeze([])
  })

  await assert.rejects(bridge.handle(event, messageEvidence, {
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      }),
      sessionAddress: Object.freeze({
        botId: 'bot-journal',
        scope: Object.freeze({
          kind: 'group_user',
          groupId: 'group-journal',
          userId: 'actor-journal'
        })
      }),
      actorId: 'actor-journal',
      requestMessageId: 'message-journal'
    })
  }), error => error === stopAfterClaim)

  assert.deepEqual(order, ['journal.request', 'run.claim'])
  assert.equal(journalRequests.length, 1)
  assert.equal(claimedRequests.length, 1)
  assert.strictEqual(journalRequests[0], claimedRequests[0])
  assert.deepEqual(Reflect.ownKeys(journalRequests[0] ?? {}), [
    'requestId', 'requestRef', 'requestKind', 'presentationRoute', 'createdAt',
    'deadlineAt', 'sessionAddress', 'actor', 'channel', 'message', 'references',
    'systemInstructions', 'model', 'contextBudget'
  ])
  assert.equal(journalRequests[0]?.message.parts[0]?.type, 'text')
  assert.equal(
    journalRequests[0]?.message.parts[0]?.type === 'text'
      ? journalRequests[0].message.parts[0].text
      : null,
    '记录完整标准化请求'
  )
})
