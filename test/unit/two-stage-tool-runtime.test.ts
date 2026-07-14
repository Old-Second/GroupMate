import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import type { ToolDefinition, ToolExecutionClass } from '../../src/agent/tools/tool-definition.js'
import { ToolExecutor } from '../../src/agent/tools/tool-executor.js'
import { ToolPolicyEngine } from '../../src/agent/tools/policy-engine.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import { ToolRegistry, type ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'

const schema = {
  type: 'object', properties: { userId: { type: 'string' }, seconds: { type: 'integer' } },
  required: ['userId', 'seconds'], additionalProperties: false
} as const

const baseFacts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'admin', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin', actorGroupRole: 'admin', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
}

const intent = Object.freeze({
  trustedSources: Object.freeze(['current_request'] as const),
  actions: Object.freeze(['mute'] as const),
  explicitTargetIds: Object.freeze(['8']), mentionUserIds: Object.freeze(['8']),
  currentMessageId: 'current', replyMessageId: null
})

function preparation (facts: ToolRuntimeFacts = baseFacts): ToolPreparationContext {
  return Object.freeze({
    runId: 'run-1', profile: 'compatible', facts, intent,
    now: '2026-07-14T00:00:00.000Z'
  })
}

function execution (facts: ToolRuntimeFacts = baseFacts): ToolExecutionContext {
  return Object.freeze({ ...preparation(facts) })
}

function call (
  callId: string,
  requestedName = 'jinyan',
  argumentsValue: Readonly<Record<string, unknown>> = { userId: '8', seconds: 60 }
): ToolCall {
  return Object.freeze({
    runId: 'run-1', callId, snapshotId: 'snapshot-1', requestedName,
    arguments: argumentsValue
  })
}

function success (text: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'none',
    content: Object.freeze([{ type: 'text' as const, text }]), retryable: false
  })
}

function definition (
  execute: ToolDefinition['execute'],
  options: {
    effect?: ToolDefinition['effect']
    permission?: ToolDefinition['permission']
    resourceKeys?: ToolDefinition['resourceKeys']
  } = {}
): ToolDefinition {
  const effect = options.effect ?? 'side_effect'
  return Object.freeze({
    name: 'jinyan', version: 1, aliases: Object.freeze([]), description: 'fixture',
    inputSchema: schema, effect, risk: effect === 'read_only' ? 'low' : 'high',
    readOnly: effect === 'read_only', destructive: false,
    idempotency: effect === 'read_only' ? 'none' : 'call', openWorld: false,
    timeoutMs: 1_000, maxOutputBytes: 4_096, network: 'none',
    permission: options.permission ?? 'group_moderator',
    executionClass: effect, retrySafe: effect === 'read_only',
    resourceKeys: options.resourceKeys ?? (() => Object.freeze(['member:0123456789abcdef01234567'])),
    resolveTarget: (input: Readonly<Record<string, unknown>>) => Object.freeze({
      kind: 'member' as const, groupId: '9', userId: String(input.userId)
    }),
    execute
  })
}

function executor (tool: ToolDefinition) {
  return new ToolExecutor({
    policy: new ToolPolicyEngine(),
    approvalStore: { create: async () => {}, get: async () => null, consume: async () => null },
    pendingCalls: { put: () => {}, take: () => null, delete: () => true },
    idempotencyStore: {
      reserve: async () => Object.freeze({ kind: 'acquired' as const }),
      complete: async () => {}, markIndeterminate: async () => {}
    },
    audit: { emit: () => {} },
    generateId: () => 'generated-id', generateToken: () => 'generated-token',
    hash: value => createHash('sha256').update(value).digest('hex'),
    now: () => new Date('2026-07-14T00:00:00.000Z')
  })
}

function snapshot (tool?: ToolDefinition): ToolSnapshot {
  return new ToolRegistry(tool === undefined ? [] : [tool]).createSnapshot({
    id: 'snapshot-1', facts: baseFacts, enabledTools: tool === undefined ? [] : [tool.name]
  })
}

test('two-stage tool runtime prepares serializable capability without executing it', async () => {
  let executions = 0
  const tool = definition(async () => {
    executions += 1
    return success('executed')
  })
  const runtime = executor(tool)
  const prepared = await runtime.prepare(call('call-1'), preparation(), snapshot(tool))

  assert.equal(prepared.kind, 'ready')
  assert.equal(executions, 0)
  assert.equal(JSON.stringify(prepared).includes('function'), false)
  if (prepared.kind !== 'ready') return
  assert.equal(Object.isFrozen(prepared.capability.canonicalArguments), true)
  assert.equal(Object.isFrozen(prepared.capability.resourceKeys), true)

  const result = await runtime.executePrepared(
    prepared.capability, execution(), snapshot(tool), new AbortController().signal
  )
  assert.equal(result.status, 'success')
  assert.equal(executions, 1)
})

test('executePrepared rechecks fresh facts and snapshot before dispatch', async () => {
  let executions = 0
  const tool = definition(async () => {
    executions += 1
    return success('executed')
  })
  const runtime = executor(tool)
  const tools = snapshot(tool)
  const prepared = await runtime.prepare(call('call-1'), preparation(), tools)
  assert.equal(prepared.kind, 'ready')
  if (prepared.kind !== 'ready') return

  const changedFacts: ToolRuntimeFacts = Object.freeze({ ...baseFacts, botGroupRole: 'member' })
  const result = await runtime.executePrepared(
    prepared.capability, execution(changedFacts), tools, new AbortController().signal
  )
  assert.equal(result.status, 'denied')
  assert.equal(executions, 0)

  const otherSnapshot = new ToolRegistry([tool]).createSnapshot({
    id: 'other-snapshot', facts: baseFacts, enabledTools: [tool.name]
  })
  const unavailable = await runtime.executePrepared(
    prepared.capability, execution(), otherSnapshot, new AbortController().signal
  )
  assert.equal(unavailable.status, 'denied')
  assert.equal(executions, 0)
})

interface FakeArguments extends Readonly<Record<string, unknown>> {
  readonly executionClass: ToolExecutionClass
  readonly retrySafe: boolean
  readonly resourceKeys: readonly string[]
  readonly delayMs?: number
  readonly approval?: boolean
  readonly retryOnce?: boolean
}

class FakeRuntime implements ToolRuntime {
  preparations = 0
  executions = 0
  active = 0
  maxActive = 0
  readonly attempts = new Map<string, number>()

  async prepare (
    toolCall: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    this.preparations += 1
    const input = toolCall.arguments as FakeArguments
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1,
      callId: toolCall.callId,
      toolName: toolCall.requestedName,
      toolVersion: 1,
      snapshotId: toolCall.snapshotId,
      canonicalArguments: Object.freeze({ ...input }) as unknown as SerializablePreparedCapability['canonicalArguments'],
      argumentHash: `argument-${toolCall.callId}`,
      target: Object.freeze({ kind: 'none' as const }),
      resourceKeys: Object.freeze([...input.resourceKeys]),
      executionClass: input.executionClass,
      retrySafe: input.retrySafe
    })
    return input.approval === true
      ? Object.freeze({ kind: 'approval_required', capability, summaryCode: 'fixture_approval' })
      : Object.freeze({ kind: 'ready', capability })
  }

  async executePrepared (
    prepared: SerializablePreparedCapability,
    _context: ToolExecutionContext,
    _snapshot: ToolSnapshot,
    signal: AbortSignal
  ): Promise<ToolResult> {
    this.executions += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    const attempt = (this.attempts.get(prepared.callId) ?? 0) + 1
    this.attempts.set(prepared.callId, attempt)
    const args = prepared.canonicalArguments as FakeArguments
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Number(args.delayMs ?? 0))
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('operation was aborted', 'AbortError'))
        }, { once: true })
      })
      if (args.retryOnce === true && attempt === 1) {
        return Object.freeze({
          status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
          userMessage: '工具暂时不可用。', retryable: true
        })
      }
      return success(prepared.callId)
    } finally {
      this.active -= 1
    }
  }
}

function fakeCall (
  callId: string,
  options: Partial<FakeArguments> = {}
): ToolCall {
  return call(callId, 'fixture', Object.freeze({
    executionClass: options.executionClass ?? 'read_only',
    retrySafe: options.retrySafe ?? true,
    resourceKeys: Object.freeze(options.resourceKeys ?? [`read:${callId.padEnd(24, '0').slice(0, 24)}`]),
    delayMs: options.delayMs ?? 0,
    approval: options.approval ?? false,
    retryOnce: options.retryOnce ?? false
  }))
}

async function readyBatch (
  scheduler: ToolScheduler,
  calls: readonly ToolCall[],
  tools = snapshot()
) {
  const result = await scheduler.preflight(calls, {
    snapshot: tools, context: preparation(), remainingToolCalls: 8
  })
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('batch was not ready')
  return { batch: result.batch, tools }
}

test('preflights an entire approval batch before any capability runs', async () => {
  const runtime = new FakeRuntime()
  const scheduler = new ToolScheduler({ runtime })
  const result = await scheduler.preflight([
    fakeCall('call-read'), fakeCall('call-risk', { approval: true, executionClass: 'side_effect', retrySafe: false })
  ], { snapshot: snapshot(), context: preparation(), remainingToolCalls: 8 })

  assert.equal(result.kind, 'approval_required')
  assert.equal(runtime.preparations, 2)
  assert.equal(runtime.executions, 0)
  assert.equal(JSON.stringify(result).includes('function'), false)
})

test('rejects whole-batch budget overflow and duplicate call IDs before preparation', async () => {
  const runtime = new FakeRuntime()
  const scheduler = new ToolScheduler({ runtime })
  const tools = snapshot()
  const overflow = await scheduler.preflight([
    fakeCall('call-1'), fakeCall('call-2')
  ], { snapshot: tools, context: preparation(), remainingToolCalls: 1 })
  assert.deepEqual(overflow, { kind: 'failed', code: 'tool_budget_exceeded' })

  const duplicate = await scheduler.preflight([
    fakeCall('duplicate'), fakeCall('duplicate')
  ], { snapshot: tools, context: preparation(), remainingToolCalls: 8 })
  assert.deepEqual(duplicate, { kind: 'failed', code: 'duplicate_call_id' })
  assert.equal(runtime.preparations, 0)
})

test('bounds per-run and global read-only concurrency to two', async () => {
  const runtime = new FakeRuntime()
  const scheduler = new ToolScheduler({ runtime })
  const first = await readyBatch(scheduler, [
    fakeCall('a', { delayMs: 20 }), fakeCall('b', { delayMs: 20 }),
    fakeCall('c', { delayMs: 20 }), fakeCall('d', { delayMs: 20 })
  ])
  await scheduler.execute(first.batch, {
    snapshot: first.tools, contextFor: async () => execution(), signal: new AbortController().signal
  })
  assert.equal(runtime.maxActive, 2)

  runtime.maxActive = 0
  const left = await readyBatch(scheduler, [fakeCall('e', { delayMs: 20 }), fakeCall('f', { delayMs: 20 })])
  const right = await readyBatch(scheduler, [fakeCall('g', { delayMs: 20 }), fakeCall('h', { delayMs: 20 })])
  await Promise.all([
    scheduler.execute(left.batch, {
      snapshot: left.tools, contextFor: async () => execution(), signal: new AbortController().signal
    }),
    scheduler.execute(right.batch, {
      snapshot: right.tools, contextFor: async () => execution(), signal: new AbortController().signal
    })
  ])
  assert.equal(runtime.maxActive, 2)
})

test('serializes conflicts and visible or side-effect calls', async () => {
  for (const calls of [
    [
      fakeCall('conflict-1', { delayMs: 10, resourceKeys: ['read:111111111111111111111111'] }),
      fakeCall('conflict-2', { delayMs: 10, resourceKeys: ['read:111111111111111111111111'] })
    ],
    [
      fakeCall('visible-1', { delayMs: 10, executionClass: 'visible_output', retrySafe: false }),
      fakeCall('visible-2', { delayMs: 10, executionClass: 'visible_output', retrySafe: false })
    ],
    [
      fakeCall('effect-1', { delayMs: 10, executionClass: 'side_effect', retrySafe: false }),
      fakeCall('effect-2', { delayMs: 10, executionClass: 'side_effect', retrySafe: false })
    ],
    [
      fakeCall('unknown-resource-1', { delayMs: 10, resourceKeys: [] }),
      fakeCall('unknown-resource-2', { delayMs: 10, resourceKeys: [] })
    ]
  ]) {
    const runtime = new FakeRuntime()
    const scheduler = new ToolScheduler({ runtime })
    const prepared = await readyBatch(scheduler, calls)
    await scheduler.execute(prepared.batch, {
      snapshot: prepared.tools, contextFor: async () => execution(), signal: new AbortController().signal
    })
    assert.equal(runtime.maxActive, 1)
  }
})

test('retries only retry-safe read failures once and preserves provider order', async () => {
  const runtime = new FakeRuntime()
  const scheduler = new ToolScheduler({ runtime })
  const prepared = await readyBatch(scheduler, [
    fakeCall('slow', { delayMs: 20, retryOnce: true }),
    fakeCall('fast', { delayMs: 0 }),
    fakeCall('visible', {
      executionClass: 'visible_output', retrySafe: false, retryOnce: true
    })
  ])
  const result = await scheduler.execute(prepared.batch, {
    snapshot: prepared.tools, contextFor: async () => execution(), signal: new AbortController().signal
  })

  assert.deepEqual(result.results.map(item => item.callId), ['slow', 'fast', 'visible'])
  assert.equal(runtime.attempts.get('slow'), 2)
  assert.equal(runtime.attempts.get('fast'), 1)
  assert.equal(runtime.attempts.get('visible'), 1)
  assert.equal(result.results[0]?.result.status, 'success')
  assert.equal(result.results[2]?.result.status, 'failed')
})

test('fails before-dispatch context refresh without claiming a possible side effect', async () => {
  const runtime = new FakeRuntime()
  const scheduler = new ToolScheduler({ runtime })
  const prepared = await readyBatch(scheduler, [
    fakeCall('context-failure', { executionClass: 'side_effect', retrySafe: false })
  ])
  const result = await scheduler.execute(prepared.batch, {
    snapshot: prepared.tools,
    contextFor: async () => { throw new Error('facts unavailable') },
    signal: new AbortController().signal
  })

  assert.equal(runtime.executions, 0)
  assert.equal(result.results[0]?.result.status, 'failed')
})

test('aborted started side effect becomes indeterminate and cannot settle late', async () => {
  let resolveLate: ((result: ToolResult) => void) | undefined
  let executions = 0
  const tool = definition(async () => {
    executions += 1
    return await new Promise<ToolResult>(resolve => { resolveLate = resolve })
  })
  const runtime = executor(tool)
  const tools = snapshot(tool)
  const prepared = await runtime.prepare(call('call-side-effect'), preparation(), tools)
  assert.equal(prepared.kind, 'ready')
  if (prepared.kind !== 'ready') return
  const controller = new AbortController()
  const pending = runtime.executePrepared(prepared.capability, execution(), tools, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'indeterminate')
  assert.equal(executions, 1)
  resolveLate?.(success('late'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(result.status, 'indeterminate')
})
