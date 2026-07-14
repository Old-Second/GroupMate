import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentMessage } from '../../src/agent/contracts/content.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import { NoopMemoryStore } from '../../src/agent/context/noop-memory-store.js'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { RunAdmission } from '../../src/agent/run/run-admission.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import { RunEngine } from '../../src/agent/run/run-engine.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import { RedisAgentSessionStore } from '../../src/agent/session/redis-agent-session-store.js'
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
import { AgentService } from '../../src/runtime/agent-service.js'
import { getAgentServiceBridge } from '../../src/runtime/agent-service-bridge.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'
import type { YunzaiAgentRequest } from '../../src/runtime/yunzai-request-adapter.js'
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

function request (id: string, text: string): YunzaiAgentRequest {
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
  return Object.freeze({
    requestId: id,
    createdAt,
    deadlineAt: '2026-07-14T01:04:00.000Z',
    sessionAddress: Object.freeze({
      botId: 'bot-1',
      scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' })
    }),
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

test('AgentService owns context, progress, run execution and terminal session writes', async () => {
  const redis = new FakeRedis(() => Date.parse(createdAt))
  const sessions = new RedisAgentSessionStore({
    redis, now: () => new Date(createdAt), generateId: () => 'session-1'
  })
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
    generateId: () => `service-run-${++generated}`
  })

  const completed = await service.handle(request('request-1', '请完成两阶段任务'), {
    signal: new AbortController().signal
  })
  assert.equal(completed.kind, 'completed')
  assert.equal(completed.kind === 'completed' ? completed.text : '', '任务完成。')
  assert.equal(adapter.requests.length, 2)
  assert.deepEqual(progress, ['正在读取网页', '正在查询天气'])
  assert.equal(adapter.requests[1]?.messages.some(message => (
    message.role === 'user' && message.content === 'internal companion text'
  )), false)

  const stored = await sessions.get(request('lookup', 'unused').sessionAddress)
  assert.equal(stored?.turnCount, 1)
  assert.deepEqual(stored?.state.messages.map(item => (
    item.kind === 'message' ? item.message.role : item.kind
  )), ['user', 'assistant'])

  const ephemeral = await service.handleEphemeral(request('request-2', '临时任务'), {
    signal: new AbortController().signal
  })
  assert.equal(ephemeral.kind, 'completed')
  assert.equal((await sessions.get(request('lookup', 'unused').sessionAddress))?.turnCount, 1)

  const callerAbort = new AbortController()
  callerAbort.abort('untrusted cancellation detail')
  const aborted = await service.handle(request('request-aborted', '不应进入模型'), {
    signal: callerAbort.signal
  })
  assert.equal(aborted.kind, 'cancelled')
  assert.equal(aborted.kind === 'cancelled' ? aborted.reason : null, 'user_cancelled')

  let bridgeCreations = 0
  const firstBridge = getAgentServiceBridge(() => {
    bridgeCreations += 1
    return service
  })
  const secondBridge = getAgentServiceBridge(() => {
    bridgeCreations += 1
    return service
  })
  assert.equal(firstBridge, secondBridge)
  assert.equal(firstBridge.conversations, service.conversations)
  assert.equal(bridgeCreations, 1)
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

test('AgentService cancellation releases a paused run before the next session turn', async () => {
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
  let generated = 0
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
      scheduler: new ToolScheduler({ runtime: new ServiceToolRuntime(true) }),
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
    now: () => new Date(createdAt),
    generateId: () => `cancel-service-${++generated}`
  })

  const paused = await service.handle(request('cancel-1', '执行需要审批的任务'))
  assert.equal(paused.kind, 'paused')
  const cancelled = await service.cancel(paused.runId, 'approval_delivery_failed')
  assert.equal(cancelled.kind, 'cancelled')

  const next = await service.handle(request('cancel-2', '继续下一轮'))
  assert.equal(next.kind, 'completed')
  assert.equal(next.kind === 'completed' ? next.text : null, '取消后可继续。')

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

  const cancelledCount = await service.shutdown('process_shutdown')
  assert.equal(cancelledCount, 1)
  assert.equal(await service.shutdown('ignored_second_reason'), 1)
  const shutdownCheckpoint = await runStore.load(pendingShutdown.runId)
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
