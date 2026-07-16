import assert from 'node:assert/strict'
import { test } from 'node:test'
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
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'

const timestamp = '2026-07-16T00:00:00.000Z'
const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-1',
  actor: Object.freeze({ userId: 'actor-1', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' }),
  botGroupRole: 'owner',
  actorGroupRole: 'owner',
  targetRole: 'member',
  targetIsBotMaster: false,
  targetExists: true
})
const preparation: ToolPreparationContext = Object.freeze({
  runId: 'run-1',
  profile: 'compatible',
  facts,
  intent: Object.freeze({
    trustedSources: Object.freeze(['current_request'] as const),
    actions: Object.freeze([]),
    explicitTargetIds: Object.freeze([]),
    mentionUserIds: Object.freeze([]),
    currentMessageId: 'message-private-id',
    replyMessageId: null
  }),
  now: timestamp
})
const execution: ToolExecutionContext = Object.freeze({ ...preparation })
const schema = Object.freeze({
  type: 'object' as const,
  properties: Object.freeze({}),
  required: Object.freeze([]),
  additionalProperties: false as const
})

function success (text = 'safe'): ToolResult {
  return Object.freeze({
    status: 'success',
    effect: 'none',
    content: Object.freeze([{ type: 'text' as const, text }]),
    retryable: false
  })
}

function failed (retryable = false): ToolResult {
  return Object.freeze({
    status: 'failed',
    effect: 'none',
    errorCode: 'upstream_unavailable',
    userMessage: 'safe',
    retryable
  })
}

function denied (): ToolResult {
  return Object.freeze({
    status: 'denied',
    effect: 'none',
    reasonCode: 'permission_denied',
    userMessage: 'safe',
    retryable: false
  })
}

function indeterminate (): ToolResult {
  return Object.freeze({
    status: 'indeterminate',
    effect: 'possible',
    errorCode: 'tool_outcome_unknown',
    userMessage: 'safe',
    retryable: false
  })
}

function definition (
  name: string,
  executionClass: ToolDefinition['executionClass'] = 'read_only',
  retrySafe = executionClass === 'read_only'
): ToolDefinition {
  return Object.freeze({
    name,
    version: 1,
    aliases: Object.freeze([]),
    description: 'fixture',
    inputSchema: schema,
    effect: executionClass === 'read_only' ? 'read_only' : executionClass,
    risk: executionClass === 'read_only' ? 'low' : 'high',
    readOnly: executionClass === 'read_only',
    destructive: false,
    idempotency: executionClass === 'read_only' ? 'none' : 'call',
    openWorld: false,
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    network: 'none',
    permission: 'any_user',
    executionClass,
    retrySafe,
    resourceKeys: () => Object.freeze([`fixture:${name.padEnd(24, '0').slice(0, 24)}`]),
    resolveTarget: () => Object.freeze({ kind: 'none' as const }),
    execute: async () => success()
  })
}

const definitions = Object.freeze([
  definition('read'),
  definition('no_retry', 'read_only', false),
  definition('side_effect', 'side_effect', false)
])

function snapshot (): ToolSnapshot {
  return new ToolRegistry(definitions).createSnapshot({
    id: 'snapshot-1',
    facts,
    enabledTools: definitions.map(item => item.name)
  })
}

function capability (
  callId: string,
  toolName = 'read'
): SerializablePreparedCapability {
  const registered = snapshot().resolve(toolName).definition
  return Object.freeze({
    schemaVersion: 1,
    callId,
    toolName,
    toolVersion: 1,
    snapshotId: 'snapshot-1',
    canonicalArguments: Object.freeze({}),
    argumentHash: `hash-${callId}`,
    target: Object.freeze({ kind: 'none' }),
    resourceKeys: Object.freeze([`fixture:${callId.padEnd(24, '0').slice(0, 24)}`]),
    executionClass: registered.executionClass,
    retrySafe: registered.retrySafe
  })
}

function batch (...capabilities: readonly SerializablePreparedCapability[]) {
  return Object.freeze({
    schemaVersion: 1 as const,
    calls: Object.freeze(capabilities.map(item => Object.freeze({
      kind: 'ready' as const,
      capability: item
    })))
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

class ScriptedRuntime implements ToolRuntime {
  readonly script: Array<ToolResult | Error>
  executions = 0

  constructor (script: readonly (ToolResult | Error)[]) {
    this.script = [...script]
  }

  async prepare (
    _call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    throw new Error('prepare is outside this fixture')
  }

  async executePrepared (): Promise<ToolResult> {
    this.executions += 1
    const item = this.script.shift()
    if (item === undefined) throw new Error('tool script exhausted')
    if (item instanceof Error) throw item
    return item
  }
}

async function executeOne (input: {
  readonly script: readonly (ToolResult | Error)[]
  readonly clock: () => number
  readonly toolName?: string
  readonly contextFor?: () => ToolExecutionContext | Promise<ToolExecutionContext>
  readonly signal?: AbortSignal
}) {
  const runtime = new ScriptedRuntime(input.script)
  const scheduler = new ToolScheduler({ runtime, monotonicNow: input.clock })
  const result = await scheduler.execute(batch(capability('call-1', input.toolName)), {
    snapshot: snapshot(),
    contextFor: input.contextFor ?? (() => execution),
    signal: input.signal ?? new AbortController().signal
  })
  return { runtime, scheduled: result.results[0] }
}

test('ToolScheduler emits zero attempts for completed replay, pre-execute abort and context failure', async () => {
  const runtime = new ScriptedRuntime([])
  const scheduler = new ToolScheduler({ runtime, monotonicNow: sequenceClock() })
  const replay = await scheduler.execute(Object.freeze({
    schemaVersion: 1,
    calls: Object.freeze([completedPreparedCall('call-1', 'read', success())])
  }), {
    snapshot: snapshot(),
    contextFor: () => execution,
    signal: new AbortController().signal
  })
  assert.deepEqual(replay.results[0]?.attemptObservations, [])

  const controller = new AbortController()
  controller.abort()
  const aborted = await executeOne({
    script: [],
    clock: sequenceClock(),
    signal: controller.signal
  })
  assert.deepEqual(aborted.scheduled?.attemptObservations, [])
  assert.equal(aborted.runtime.executions, 0)

  const contextFailed = await executeOne({
    script: [],
    clock: sequenceClock(),
    contextFor: async () => { throw new Error('private context failure') }
  })
  assert.deepEqual(contextFailed.scheduled?.attemptObservations, [])
  assert.equal(contextFailed.runtime.executions, 0)
})

test('ToolScheduler projects each parsed result to one exact body-free attempt observation', async () => {
  const cases = [
    [success('private tool output'), 'succeeded', null],
    [failed(false), 'failed', 'upstream_unavailable'],
    [denied(), 'denied', 'permission_denied'],
    [indeterminate(), 'indeterminate', 'tool_outcome_unknown']
  ] as const
  for (const [result, outcome, resultCode] of cases) {
    const fixture = await executeOne({
      script: [result],
      clock: sequenceClock(10.2, 13.7)
    })
    assert.equal(fixture.runtime.executions, 1)
    assert.deepEqual(fixture.scheduled?.attemptObservations, [{
      schemaVersion: 1,
      ordinal: 1,
      outcome,
      durationMs: 4,
      resultCode
    }])
    const observation = fixture.scheduled?.attemptObservations[0]
    assert.deepEqual(Object.keys(observation ?? {}).sort(), [
      'durationMs', 'ordinal', 'outcome', 'resultCode', 'schemaVersion'
    ])
    assert.equal(JSON.stringify(observation).includes('private tool output'), false)
    assert.equal(JSON.stringify(observation).includes('call-1'), false)
    assert.equal(JSON.stringify(observation).includes('read'), false)
  }
})

test('ToolScheduler preserves both retry outcomes with consecutive ordinals', async () => {
  const fixture = await executeOne({
    script: [failed(true), success()],
    clock: sequenceClock(0, 3, 10, 16)
  })
  assert.equal(fixture.runtime.executions, 2)
  assert.deepEqual(fixture.scheduled?.attemptObservations, [
    {
      schemaVersion: 1,
      ordinal: 1,
      outcome: 'failed',
      durationMs: 3,
      resultCode: 'upstream_unavailable'
    },
    {
      schemaVersion: 1,
      ordinal: 2,
      outcome: 'succeeded',
      durationMs: 6,
      resultCode: null
    }
  ])
  assert.equal(fixture.scheduled?.result.status, 'success')

  const ineligible = await executeOne({
    script: [failed(true), success()],
    clock: sequenceClock(0, 1),
    toolName: 'no_retry'
  })
  assert.equal(ineligible.runtime.executions, 1)
  assert.equal(ineligible.scheduled?.attemptObservations.length, 1)
})

test('ToolScheduler records a thrown execution as an attempted safe failure or indeterminate outcome', async () => {
  const read = await executeOne({
    script: [new Error('private read failure')],
    clock: sequenceClock(2, 5)
  })
  assert.deepEqual(read.scheduled?.attemptObservations, [{
    schemaVersion: 1,
    ordinal: 1,
    outcome: 'failed',
    durationMs: 3,
    resultCode: 'tool_execution_failed'
  }])
  assert.equal(read.scheduled?.result.status, 'failed')

  const sideEffect = await executeOne({
    script: [new Error('private side effect failure')],
    clock: sequenceClock(2, 5),
    toolName: 'side_effect'
  })
  assert.deepEqual(sideEffect.scheduled?.attemptObservations, [{
    schemaVersion: 1,
    ordinal: 1,
    outcome: 'indeterminate',
    durationMs: 3,
    resultCode: 'tool_outcome_unknown'
  }])
  assert.equal(sideEffect.scheduled?.result.status, 'indeterminate')
})

test('ToolScheduler bounds non-monotonic and over-timeout attempt durations', async () => {
  const backwards = await executeOne({
    script: [success()],
    clock: sequenceClock(10, 9)
  })
  assert.equal(backwards.scheduled?.attemptObservations[0]?.durationMs, 0)

  const capped = await executeOne({
    script: [success()],
    clock: sequenceClock(10, 5_010)
  })
  assert.equal(capped.scheduled?.attemptObservations[0]?.durationMs, 1_000)
})

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T> (): Deferred<T> {
  let resolver: ((value: T) => void) | undefined
  const promise = new Promise<T>(resolve => { resolver = resolve })
  return Object.freeze({
    promise,
    resolve: (value: T) => {
      if (resolver === undefined) throw new Error('deferred resolver is missing')
      resolver(value)
    }
  })
}

test('ToolScheduler keeps parallel observations aligned to input order when completion order differs', async () => {
  const first = deferred<ToolResult>()
  const second = deferred<ToolResult>()
  const firstStarted = deferred<void>()
  const secondStarted = deferred<void>()
  const runtime: ToolRuntime = Object.freeze({
    prepare: async () => { throw new Error('prepare is outside this fixture') },
    executePrepared: async (prepared: SerializablePreparedCapability) => {
      if (prepared.callId === 'call-1') {
        firstStarted.resolve()
        return await first.promise
      }
      secondStarted.resolve()
      return await second.promise
    }
  })
  const scheduler = new ToolScheduler({
    runtime,
    monotonicNow: sequenceClock(0, 1, 5, 10)
  })
  const running = scheduler.execute(batch(
    capability('call-1'),
    capability('call-2')
  ), {
    snapshot: snapshot(),
    contextFor: () => execution,
    signal: new AbortController().signal
  })
  await Promise.all([firstStarted.promise, secondStarted.promise])
  second.resolve(denied())
  await Promise.resolve()
  first.resolve(success())
  const result = await running

  assert.deepEqual(result.results.map(item => item.callId), ['call-1', 'call-2'])
  assert.deepEqual(result.results.map(item => item.attemptObservations[0]), [
    {
      schemaVersion: 1,
      ordinal: 1,
      outcome: 'succeeded',
      durationMs: 10,
      resultCode: null
    },
    {
      schemaVersion: 1,
      ordinal: 1,
      outcome: 'denied',
      durationMs: 4,
      resultCode: 'permission_denied'
    }
  ])
})
