import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { ToolAuditEvent, ToolAuditSink } from '../../src/agent/tools/audit.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts,
  ToolTarget
} from '../../src/agent/tools/tool-context.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type { ToolDefinition, ToolEffect } from '../../src/agent/tools/tool-definition.js'
import { ToolExecutor } from '../../src/agent/tools/tool-executor.js'
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStore,
  StoredToolOutcome
} from '../../src/agent/tools/idempotency-store.js'
import type { ToolPolicyDecision } from '../../src/agent/tools/policy-engine.js'
import {
  ToolUnavailableError,
  type RegisteredTool,
  type ToolSnapshot
} from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import { extractIntentEvidence } from '../../src/runtime/tools/intent-evidence.js'

const facts: ToolRuntimeFacts = Object.freeze({
  botId: '10000',
  actor: Object.freeze({ userId: '7', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: '10000', groupId: '9' }),
  scope: Object.freeze({ kind: 'group', groupId: '9' }),
  botGroupRole: 'owner',
  actorGroupRole: 'owner',
  targetRole: 'member',
  targetIsBotMaster: false,
  targetExists: true
})

const schema = Object.freeze({
  type: 'object' as const,
  properties: Object.freeze({ text: Object.freeze({ type: 'string' as const }) }),
  required: Object.freeze(['text']),
  additionalProperties: false as const
})

interface HarnessOptions {
  readonly effect?: ToolEffect
  readonly idempotency?: 'call' | 'semantic'
  readonly handler?: (input: Readonly<Record<string, unknown>>) => Promise<ToolResult>
  readonly decision?: ToolPolicyDecision
  readonly reservation?: IdempotencyReservation
  readonly definitionTimeoutMs?: number
  readonly maxOutputBytes?: number
  readonly auditErrorOn?: ToolAuditEvent['eventType']
  readonly idempotencyCompleteError?: Error
  readonly idempotencyIndeterminateError?: Error
  readonly statefulIdempotency?: boolean
}

function harness (options: HarnessOptions = {}) {
  const calls: string[] = []
  const audits: ToolAuditEvent[] = []
  const idempotencyStates = new Map<string, IdempotencyReservation>()
  let handlerCalls = 0
  const effect = options.effect ?? 'side_effect'
  const target: ToolTarget = Object.freeze({ kind: 'member', groupId: '9', userId: '8' })
  const definition: ToolDefinition = Object.freeze({
    name: 'fixtureTool',
    version: 1,
    aliases: Object.freeze([]),
    description: 'fixture tool',
    inputSchema: schema,
    effect,
    risk: effect === 'read_only' ? 'low' : 'medium',
    readOnly: effect === 'read_only',
    destructive: false,
    idempotency: effect === 'read_only' ? 'none' : (options.idempotency ?? 'call'),
    openWorld: false,
    timeoutMs: options.definitionTimeoutMs ?? 1_000,
    maxOutputBytes: options.maxOutputBytes ?? 4_096,
    network: 'none',
    permission: 'any_user',
    executionClass: effect,
    retrySafe: effect === 'read_only',
    resourceKeys: () => Object.freeze([]),
    resolveTarget: (input: Readonly<Record<string, unknown>>) => {
      assert.equal(Object.isFrozen(input), true)
      calls.push('target.resolve')
      return target
    },
    execute: async (input: Readonly<Record<string, unknown>>) => {
      calls.push('handler.execute')
      handlerCalls += 1
      if (options.handler !== undefined) return await options.handler(input)
      return Object.freeze({
        status: 'success' as const,
        effect: effect === 'read_only' ? 'none' as const : 'background' as const,
        content: Object.freeze([{ type: 'text' as const, text: String(input.text) }]),
        retryable: false as const
      })
    }
  })
  const registered: RegisteredTool = Object.freeze({
    definition,
    canonicalName: definition.name
  })
  const snapshot: ToolSnapshot = Object.freeze({
    id: 'snapshot-1',
    modelTools: Object.freeze([]),
    toolNames: Object.freeze(['fixtureTool']),
    manifest: Object.freeze([]),
    fingerprint: '0'.repeat(64),
    resolve: () => registered,
    resolveCall: (call: ToolCall) => {
      calls.push('snapshot.resolve')
      if (call.snapshotId !== 'snapshot-1' || call.requestedName !== 'fixtureTool') {
        throw new ToolUnavailableError()
      }
      return registered
    }
  })
  const idempotencyStore: IdempotencyStore = {
    reserve: async (record: IdempotencyRecord, ttlSeconds: number) => {
      calls.push('idempotency.reserve')
      assert.equal(ttlSeconds, 300)
      if (options.statefulIdempotency === true) {
        const existing = idempotencyStates.get(record.key)
        if (existing !== undefined) return existing
        idempotencyStates.set(record.key, Object.freeze({ kind: 'running' as const }))
      }
      return options.reservation ?? Object.freeze({ kind: 'acquired' as const })
    },
    complete: async (key: string, outcome: StoredToolOutcome, ttlSeconds: number) => {
      calls.push('idempotency.complete')
      assert.equal(ttlSeconds, 300)
      if (options.idempotencyCompleteError !== undefined) throw options.idempotencyCompleteError
      if (options.statefulIdempotency === true) {
        idempotencyStates.set(key, Object.freeze({ kind: 'completed' as const, outcome }))
      }
    },
    markIndeterminate: async (key: string, ttlSeconds: number) => {
      calls.push('idempotency.indeterminate')
      assert.equal(ttlSeconds, 300)
      if (options.idempotencyIndeterminateError !== undefined) {
        throw options.idempotencyIndeterminateError
      }
      if (options.statefulIdempotency === true) {
        idempotencyStates.set(key, Object.freeze({ kind: 'indeterminate' as const }))
      }
    }
  }
  const audit: ToolAuditSink = {
    emit: event => {
      audits.push(event)
      calls.push(`audit.${event.eventType}`)
      if (options.auditErrorOn === event.eventType) throw new Error('audit://secret')
    }
  }
  const policy = {
    decide: () => {
      calls.push('policy.decide')
      return options.decision ?? Object.freeze({
        kind: 'allow' as const,
        reasonCode: 'policy_allowed' as const
      })
    }
  }
  let generated = 0
  const executor = new ToolExecutor({
    policy: policy as never,
    idempotencyStore,
    audit,
    generateId: () => `generated-${++generated}`,
    hash: value => `hash:${value}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  })
  const call = (overrides: Readonly<Record<string, unknown>> = {}) => Object.freeze({
    runId: 'run-1',
    runRef: 'a'.repeat(32),
    callId: 'call-1',
    snapshotId: 'snapshot-1',
    requestedName: 'fixtureTool',
    arguments: Object.freeze({ text: 'hello' }),
    ...overrides
  }) as Parameters<ToolExecutor['prepare']>[0]
  const preparationContext = (runId = 'run-1'): ToolPreparationContext => Object.freeze({
    runId,
    runRef: 'a'.repeat(32),
    profile: 'compatible',
    facts,
    intent: extractIntentEvidence({ text: '执行操作', mentions: ['8'], reply: null }),
    now: '2026-07-13T00:00:00.000Z'
  })
  const executionContext = (
    runId = 'run-1',
    approved = false
  ): ToolExecutionContext => Object.freeze({
    ...preparationContext(runId),
    ...(approved
      ? { approval: Object.freeze({ kind: 'approved' as const, decidedAt: '2026-07-13T00:00:01.000Z' }) }
      : {})
  })
  return {
    executor,
    snapshot,
    call,
    preparationContext,
    executionContext,
    calls,
    audits,
    handlerCalls: () => handlerCalls
  }
}

async function ready (
  fixture: ReturnType<typeof harness>,
  call = fixture.call(),
  context = fixture.preparationContext()
) {
  const prepared = await fixture.executor.prepare(call, context, fixture.snapshot)
  assert.equal(prepared.kind, 'ready')
  if (prepared.kind !== 'ready') assert.fail('expected ready capability')
  return prepared.capability
}

test('executor prepares without dispatch and executes only the frozen capability', async () => {
  const fixture = harness()
  const capability = await ready(fixture)
  assert.equal(fixture.handlerCalls(), 0)

  const result = await fixture.executor.executePrepared(
    capability,
    fixture.executionContext(),
    fixture.snapshot,
    new AbortController().signal
  )

  assert.equal(result.status, 'success')
  assert.equal(fixture.handlerCalls(), 1)
  assert.deepEqual(fixture.audits.map(event => event.eventType), [
    'requested', 'started', 'completed'
  ])
  assert.ok(fixture.audits.every(event => event.runRef === 'a'.repeat(32)))
  assert.ok(fixture.audits.every(event => event.terminalObservationId === 'not_attempted'))
  assert.ok(fixture.calls.indexOf('audit.started') < fixture.calls.indexOf('handler.execute'))
})

test('semantic idempotency executes identical arguments once across model call IDs', async () => {
  const fixture = harness({ idempotency: 'semantic', statefulIdempotency: true })
  for (const callId of ['call-1', 'call-2']) {
    const call = fixture.call({ callId })
    const capability = await ready(fixture, call)
    const result = await fixture.executor.executePrepared(
      capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
    )
    assert.equal(result.status, 'success')
  }
  assert.equal(fixture.handlerCalls(), 1)
})

test('call idempotency keeps distinct model call IDs independent', async () => {
  const fixture = harness({ idempotency: 'call', statefulIdempotency: true })
  for (const callId of ['call-1', 'call-2']) {
    const capability = await ready(fixture, fixture.call({ callId }))
    await fixture.executor.executePrepared(
      capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
    )
  }
  assert.equal(fixture.handlerCalls(), 2)
})

test('prepare rejects unavailable, malformed and policy-denied calls before dispatch', async () => {
  const unavailable = harness()
  const unavailableResult = await unavailable.executor.prepare(
    unavailable.call({ requestedName: 'missing' }),
    unavailable.preparationContext(),
    unavailable.snapshot
  )
  assert.equal(unavailableResult.kind, 'completed')

  const malformed = harness()
  const malformedResult = await malformed.executor.prepare(
    malformed.call({ arguments: Object.freeze({}) }),
    malformed.preparationContext(),
    malformed.snapshot
  )
  assert.equal(malformedResult.kind, 'completed')

  const denied = harness({
    decision: Object.freeze({
      kind: 'deny', reasonCode: 'permission_denied', userMessage: '当前身份不能执行该操作。'
    })
  })
  const deniedResult = await denied.executor.prepare(
    denied.call(), denied.preparationContext(), denied.snapshot
  )
  assert.equal(deniedResult.kind, 'completed')
  assert.equal(denied.handlerCalls(), 0)
})

test('native approval returns a serializable interruption and rechecks approval before dispatch', async () => {
  const fixture = harness({
    decision: Object.freeze({
      kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval'
    })
  })
  const prepared = await fixture.executor.prepare(
    fixture.call(), fixture.preparationContext(), fixture.snapshot
  )
  assert.equal(prepared.kind, 'approval_required')
  if (prepared.kind !== 'approval_required') assert.fail('expected approval')
  assert.equal(fixture.handlerCalls(), 0)

  const denied = await fixture.executor.executePrepared(
    prepared.capability,
    fixture.executionContext(),
    fixture.snapshot,
    new AbortController().signal
  )
  assert.equal(denied.status, 'denied')
  assert.equal(denied.status === 'denied' ? denied.reasonCode : '', 'approval_invalid')

  const completed = await fixture.executor.executePrepared(
    prepared.capability,
    fixture.executionContext('run-1', true),
    fixture.snapshot,
    new AbortController().signal
  )
  assert.equal(completed.status, 'success')
  assert.equal(fixture.handlerCalls(), 1)
})

test('pre-aborted execution and pre-dispatch audit failure never call the handler', async () => {
  const aborted = harness()
  const capability = await ready(aborted)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await aborted.executor.executePrepared(
    capability, aborted.executionContext(), aborted.snapshot, controller.signal
  )
  assert.equal(cancelled.status, 'failed')
  assert.equal(cancelled.status === 'failed' ? cancelled.errorCode : '', 'tool_cancelled')
  assert.equal(aborted.handlerCalls(), 0)

  const auditFailure = harness({ auditErrorOn: 'requested' })
  const prepared = await auditFailure.executor.prepare(
    auditFailure.call(), auditFailure.preparationContext(), auditFailure.snapshot
  )
  assert.equal(prepared.kind, 'completed')
  if (prepared.kind === 'completed') {
    assert.equal(prepared.result.status === 'failed' ? prepared.result.errorCode : '', 'tool_control_unavailable')
  }
  assert.equal(auditFailure.handlerCalls(), 0)
})

test('started side effects become indeterminate at timeout and ignore late settlement', async () => {
  const fixture = harness({
    definitionTimeoutMs: 5,
    handler: async () => {
      await delay(50)
      return Object.freeze({
        status: 'success' as const,
        effect: 'background' as const,
        content: Object.freeze([]),
        retryable: false as const
      })
    }
  })
  const capability = await ready(fixture)
  const result = await fixture.executor.executePrepared(
    capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
  )
  assert.equal(result.status, 'indeterminate')
  assert.equal(fixture.audits.at(-1)?.eventType, 'indeterminate')
})

test('read-only thrown, invalid and oversized results stay typed failures', async () => {
  const cases: readonly HarnessOptions[] = [
    { effect: 'read_only', handler: async () => { throw new Error('upstream://secret') } },
    { effect: 'read_only', handler: async () => ({ invalid: true }) as never },
    {
      effect: 'read_only',
      maxOutputBytes: 256,
      handler: async () => Object.freeze({
        status: 'success' as const,
        effect: 'none' as const,
        content: Object.freeze([{ type: 'text' as const, text: 'x'.repeat(1_024) }]),
        retryable: false as const
      })
    }
  ]
  for (const options of cases) {
    const fixture = harness(options)
    const capability = await ready(fixture)
    const result = await fixture.executor.executePrepared(
      capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
    )
    assert.equal(result.status, 'failed')
  }
})

test('post-side-effect control failure remains indeterminate and is never replayed', async () => {
  const fixture = harness({
    statefulIdempotency: true,
    idempotencyCompleteError: new Error('redis://secret')
  })
  const capability = await ready(fixture)
  const result = await fixture.executor.executePrepared(
    capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
  )
  assert.equal(result.status, 'indeterminate')
  assert.equal(fixture.handlerCalls(), 1)
})

test('stored idempotency states return safe results without re-execution', async () => {
  for (const reservation of [
    Object.freeze({ kind: 'running' as const }),
    Object.freeze({ kind: 'indeterminate' as const }),
    Object.freeze({
      kind: 'completed' as const,
      outcome: Object.freeze({
        status: 'success' as const,
        effect: 'background' as const,
        completedAt: '2026-07-13T00:00:00.000Z'
      })
    })
  ]) {
    const fixture = harness({ reservation })
    const capability = await ready(fixture)
    await fixture.executor.executePrepared(
      capability, fixture.executionContext(), fixture.snapshot, new AbortController().signal
    )
    assert.equal(fixture.handlerCalls(), 0)
  }
})
