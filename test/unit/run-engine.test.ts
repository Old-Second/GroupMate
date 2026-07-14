import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelAdapter, ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { ModelProviderError } from '../../src/agent/model/model-adapter.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import { RunEngine, type StartRunInput } from '../../src/agent/run/run-engine.js'
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
    return Object.freeze({ kind: 'ready', capability })
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
}

function harness (
  items: readonly ScriptedItem[],
  options: HarnessOptions = {}
) {
  const adapter = new ScriptedAdapter(items)
  const tools = new ScriptedToolRuntime()
  const store = new InMemoryRunStore()
  const events: string[] = []
  let id = 0
  const engine = new RunEngine({
    adapter,
    profile: options.profile ?? standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: tools }),
    store,
    budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
    now: options.now ?? (() => new Date(timestamp)),
    generateId: () => `generated-${++id}`,
    observer: event => { events.push(event.type) }
  })
  const input: StartRunInput = Object.freeze({
    runId: 'run-1',
    sessionId: 'session-1',
    sessionAddress: Object.freeze({ botId: facts.botId, scope: facts.scope }),
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

function outputText (result: Awaited<ReturnType<RunEngine['start']>>): string | null {
  if (result.kind !== 'completed' || result.output === null) return null
  const part = result.output.parts[0]
  return part?.type === 'text' ? part.text : null
}

test('RunEngine completes one valid pure-text turn and emits ordered events', async () => {
  const fixture = harness([modelText('完成')])
  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'completed')
  assert.equal(outputText(result), '完成')
  assert.equal(result.kind === 'completed' && result.visibleOutput, false)
  assert.deepEqual(fixture.events, [
    'run.created', 'run.started', 'context.prepared', 'model.started',
    'model.completed', 'run.completed'
  ])
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(checkpoint?.status, 'completed')
  assert.equal(checkpoint?.budgetCounters.modelTurns, 1)
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
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(JSON.stringify(checkpoint).includes('我先查一下'), true)
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
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(checkpoint?.budgetCounters.modelTurns, 6)
  assert.equal(checkpoint?.budgetCounters.correctionTurns, 1)
})

test('RunEngine corrects one empty response but keeps refusal distinct', async () => {
  const empty = harness([modelText(''), modelText('纠正后的回答')])
  const corrected = await empty.engine.start(empty.input)
  assert.equal(outputText(corrected), '纠正后的回答')
  assert.equal(empty.adapter.requests[1]?.toolMode, 'disabled')

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
    assert.deepEqual((await fixture.store.load('run-1'))?.toolLedgers, [])
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
  const ledger = (await fixture.store.load('run-1'))?.toolLedgers[0]
  assert.deepEqual(ledger?.calls.map(call => call.status), ['denied', 'failed', 'denied'])
})

test('RunEngine completes visible tool output without asking the Provider for another reply', async () => {
  const fixture = harness([
    modelTools([toolCall(0, 'call-visible', 'visible')])
  ])
  fixture.tools.outcomes.set('call-visible', success('已发送', 'visible'))

  const result = await fixture.engine.start(fixture.input)

  assert.deepEqual(result, {
    kind: 'completed', runId: 'run-1', output: null, visibleOutput: true
  })
  assert.equal(fixture.adapter.requests.length, 1)
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
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(checkpoint?.budgetCounters.toolCalls, 0)
  assert.equal(checkpoint?.toolLedgers[0]?.calls.every(call => call.status === 'failed'), true)
})

test('RunEngine keeps provider retry, context recovery and correction counters separate', async () => {
  const retryable = new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const retry = harness([retryable, modelText('重试成功')])
  assert.equal(outputText(await retry.engine.start(retry.input)), '重试成功')
  const retried = await retry.store.load('run-1')
  assert.deepEqual({
    provider: retried?.budgetCounters.providerRetries,
    recovery: retried?.budgetCounters.recoveryAttempts,
    correction: retried?.budgetCounters.correctionTurns
  }, { provider: 1, recovery: 0, correction: 0 })

  const legacyContext = new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.response', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。', statusCode: 400,
    providerCode: 'invalid_request_error',
    profileCode: 'deepseek_invalid_legacy_context'
  })
  let recoveries = 0
  const recovered = harness([legacyContext, modelText('恢复成功')], {
    profile: deepSeekCompatibilityProfile as typeof standardOpenAIProfile,
    recoverContext: async () => {
      recoveries += 1
      return Object.freeze({
        messages: Object.freeze([{ role: 'user' as const, content: '精简后的请求' }]),
        estimatedInputTokens: 8
      })
    }
  })
  assert.equal(outputText(await recovered.engine.start(recovered.input)), '恢复成功')
  const checkpoint = await recovered.store.load('run-1')
  assert.equal(recoveries, 1)
  assert.deepEqual({
    provider: checkpoint?.budgetCounters.providerRetries,
    recovery: checkpoint?.budgetCounters.recoveryAttempts,
    correction: checkpoint?.budgetCounters.correctionTurns
  }, { provider: 0, recovery: 1, correction: 0 })
})

test('RunEngine preserves the allowed retry count and the final provider error after exhaustion', async () => {
  const unavailable = (): ModelProviderError => new ModelProviderError({
    code: 'provider_unavailable', stage: 'model.response', retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。', statusCode: 503
  })
  const fixture = harness([unavailable(), unavailable()])

  const result = await fixture.engine.start(fixture.input)

  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' && result.error.code, 'provider_unavailable')
  assert.equal(fixture.adapter.requests.length, 2)
  assert.equal((await fixture.store.load('run-1'))?.budgetCounters.providerRetries, 1)
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
  assert.equal((await fixture.store.load('run-1'))?.budgetCounters.recoveryAttempts, 0)
})

test('RunEngine cancels an expired deadline before any Provider call', async () => {
  const fixture = harness([modelText('不应执行')], {
    now: () => new Date('2026-07-14T00:04:00.000Z')
  })

  const result = await fixture.engine.start(fixture.input)

  assert.deepEqual(result, {
    kind: 'cancelled', runId: 'run-1', reason: 'deadline_exceeded'
  })
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
  assert.deepEqual(result, cancelled)

  pendingTurn.resolve(modelText('迟到结果'))
  await new Promise(resolve => setImmediate(resolve))
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(checkpoint?.status, 'cancelled')
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

  await fixture.engine.cancel('run-1', 'user_cancelled')
  const result = await running
  assert.equal(result.kind, 'cancelled')
  const checkpoint = await fixture.store.load('run-1')
  assert.equal(checkpoint?.toolLedgers[0]?.calls[0]?.status, 'indeterminate')

  toolResult.resolve(success('迟到副作用'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await fixture.store.load('run-1'))?.status, 'cancelled')
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

  await fixture.engine.cancel('run-1', 'user_cancelled')
  const result = await running

  assert.equal(result.kind, 'cancelled')
  assert.equal(fixture.tools.executions, 0)
  assert.equal(
    (await fixture.store.load('run-1'))?.toolLedgers[0]?.calls[0]?.status,
    'cancelled'
  )
  freshContext.resolve(execution())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.tools.executions, 0)
})
