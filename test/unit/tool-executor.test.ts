import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type {
  ApprovalRecord,
  ApprovalStore
} from '../../src/agent/tools/approval-store.js'
import type { ToolRuntimeFacts, ToolTarget } from '../../src/agent/tools/tool-context.js'
import type { ToolDefinition, ToolEffect } from '../../src/agent/tools/tool-definition.js'
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStore,
  StoredToolOutcome
} from '../../src/agent/tools/idempotency-store.js'
import type {
  PendingCallStore,
  PendingToolCall
} from '../../src/agent/tools/pending-call-store.js'
import type { ToolPolicyDecision } from '../../src/agent/tools/policy-engine.js'
import { ToolUnavailableError, type RegisteredTool, type ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import {
  ToolExecutor,
  type ToolExecutionRequest
} from '../../src/agent/tools/tool-executor.js'
import type { ToolAuditEvent, ToolAuditSink } from '../../src/agent/tools/audit.js'
import { extractIntentEvidence } from '../../src/runtime/tools/intent-evidence.js'

const facts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'owner', isBotMaster: true },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'owner',
  actorGroupRole: 'owner',
  targetRole: 'member',
  targetIsBotMaster: false,
  targetExists: true
}

const schema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false
} as const

interface HarnessOptions {
  effect?: ToolEffect
  handler?: (input: Readonly<Record<string, unknown>>) => Promise<ToolResult>
  decision?: ToolPolicyDecision
  reservation?: IdempotencyReservation
  approvalCreateError?: Error
  definitionTimeoutMs?: number
  maxOutputBytes?: number
  auditErrorOn?: ToolAuditEvent['eventType']
  idempotencyCompleteError?: Error
  idempotencyIndeterminateError?: Error
  pendingPutError?: Error
  expectedApprovalTtlSeconds?: number
}

function harness (options: HarnessOptions = {}) {
  const calls: string[] = []
  const audits: ToolAuditEvent[] = []
  const pending = new Map<string, PendingToolCall>()
  let handlerCalls = 0
  const effect = options.effect ?? 'side_effect'
  const target: ToolTarget = { kind: 'member', groupId: '9', userId: '8' }
  const definition: ToolDefinition = {
    name: 'fixtureTool',
    version: 1,
    aliases: [],
    description: 'fixture tool',
    inputSchema: schema,
    effect,
    risk: effect === 'read_only' ? 'low' : 'medium',
    readOnly: effect === 'read_only',
    destructive: false,
    idempotency: effect === 'read_only' ? 'none' : 'call',
    openWorld: false,
    timeoutMs: options.definitionTimeoutMs ?? 1_000,
    maxOutputBytes: options.maxOutputBytes ?? 4_096,
    network: 'none',
    permission: 'any_user',
    resolveTarget: input => {
      assert.equal(Object.isFrozen(input), true)
      calls.push('schema.validate', 'target.resolve')
      return target
    },
    execute: async input => {
      calls.push('handler.execute')
      handlerCalls += 1
      return options.handler === undefined
        ? { status: 'success', effect: 'background', content: [{ type: 'text', text: String(input.text) }], retryable: false }
        : options.handler(input)
    }
  }
  const registered: RegisteredTool = Object.freeze({ definition: Object.freeze(definition), canonicalName: definition.name })
  const snapshot: ToolSnapshot = {
    id: 'snapshot-1',
    modelTools: [],
    toolNames: ['fixtureTool'],
    resolve: () => registered,
    resolveCall: call => {
      calls.push('snapshot.resolve')
      if (call.snapshotId !== 'snapshot-1' || call.requestedName !== 'fixtureTool') throw new ToolUnavailableError()
      return registered
    }
  }
  const approvalStore: ApprovalStore = {
    create: async (_record: ApprovalRecord, ttlSeconds: number) => {
      calls.push('approval.create')
      assert.equal(ttlSeconds, options.expectedApprovalTtlSeconds ?? 120)
      if (options.approvalCreateError !== undefined) throw options.approvalCreateError
    },
    get: async () => null,
    consume: async () => null
  }
  const pendingCalls: PendingCallStore = {
    put: call => {
      calls.push('pending.put')
      if (options.pendingPutError !== undefined) throw options.pendingPutError
      pending.set(call.pendingCallId, call)
    },
    take: (id, argumentHash) => {
      const call = pending.get(id)
      if (call?.argumentHash !== argumentHash) return null
      pending.delete(id)
      return call
    },
    delete: id => {
      calls.push('pending.delete')
      return pending.delete(id)
    }
  }
  const idempotencyStore: IdempotencyStore = {
    reserve: async (_record: IdempotencyRecord, ttlSeconds: number) => {
      calls.push('idempotency.reserve')
      assert.equal(ttlSeconds, 300)
      return options.reservation ?? { kind: 'acquired' }
    },
    complete: async (_key: string, _result: StoredToolOutcome, ttlSeconds: number) => {
      calls.push('idempotency.complete')
      assert.equal(ttlSeconds, 300)
      if (options.idempotencyCompleteError !== undefined) throw options.idempotencyCompleteError
    },
    markIndeterminate: async (_key: string, ttlSeconds: number) => {
      calls.push('idempotency.indeterminate')
      assert.equal(ttlSeconds, 300)
      if (options.idempotencyIndeterminateError !== undefined) throw options.idempotencyIndeterminateError
    }
  }
  const audit: ToolAuditSink = {
    emit: event => {
      audits.push(event)
      if (event.eventType === 'started') calls.push('audit.started')
      if (event.eventType === 'completed') calls.push('audit.completed')
      if (event.eventType === 'indeterminate') calls.push('audit.indeterminate')
      if (options.auditErrorOn === event.eventType) throw new Error('audit://secret')
    }
  }
  const policy = {
    decide: () => {
      calls.push('policy.decide')
      return options.decision ?? { kind: 'allow', reasonCode: 'policy_allowed' }
    }
  }
  let generated = 0
  const executor = new ToolExecutor({
    policy: policy as never,
    approvalStore,
    pendingCalls,
    idempotencyStore,
    audit,
    generateId: () => `generated-${++generated}`,
    generateToken: () => 'approval-token-123456',
    hash: value => `hash:${value}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  })
  const request = (overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest => ({
    snapshot,
    call: {
      runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1',
      requestedName: 'fixtureTool', arguments: { text: 'hello' }
    },
    profile: 'compatible',
    initialFacts: facts,
    intent: extractIntentEvidence({ text: '执行操作', mentions: ['8'], reply: null }),
    refreshFacts: async (resolvedTarget, signal) => {
      calls.push('facts.refresh')
      assert.deepEqual(resolvedTarget, target)
      assert.equal(signal.aborted, false)
      return facts
    },
    ...overrides
  })
  return {
    executor, request, calls, audits, pending,
    handlerCalls: () => handlerCalls
  }
}

test('executor runs one validated tool call in the fixed order', async () => {
  const fixture = harness()
  const outcome = await fixture.executor.execute(fixture.request())

  assert.equal(outcome.kind, 'completed')
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'success')
  assert.deepEqual(fixture.calls, [
    'snapshot.resolve', 'schema.validate', 'target.resolve', 'facts.refresh',
    'policy.decide', 'idempotency.reserve', 'audit.started', 'handler.execute',
    'idempotency.complete', 'audit.completed'
  ])
  assert.equal(fixture.handlerCalls(), 1)
  assert.deepEqual(fixture.audits.map(event => event.eventType), ['requested', 'started', 'completed'])
  assert.doesNotMatch(JSON.stringify(fixture.audits), /hello|10000|userId|groupId/)
})

test('executor rejects unavailable and malformed calls without execution', async () => {
  const unavailable = harness()
  const unavailableOutcome = await unavailable.executor.execute(unavailable.request({
    call: {
      runId: 'run-1', callId: 'call-1', snapshotId: 'other',
      requestedName: 'fixtureTool', arguments: {}
    }
  }))
  assert.equal(unavailableOutcome.kind === 'completed' && unavailableOutcome.result.status, 'denied')
  assert.equal(unavailable.handlerCalls(), 0)

  const malformed = harness()
  const malformedOutcome = await malformed.executor.execute(malformed.request({
    call: {
      runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1',
      requestedName: 'fixtureTool', arguments: '{broken-json'
    }
  }))
  assert.deepEqual(malformedOutcome.kind === 'completed' && malformedOutcome.result, {
    status: 'denied', effect: 'none', reasonCode: 'invalid_arguments',
    userMessage: '工具参数无效。', retryable: false
  })
  assert.equal(malformed.handlerCalls(), 0)
})

test('policy denial never reserves or executes a side effect', async () => {
  const fixture = harness({
    decision: {
      kind: 'deny', reasonCode: 'permission_denied',
      userMessage: '当前身份不能执行该操作。'
    }
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'denied')
  assert.equal(fixture.handlerCalls(), 0)
  assert.equal(fixture.calls.includes('idempotency.reserve'), false)
})

test('approval stores pending arguments before the hashed control record', async () => {
  const fixture = harness({
    decision: { kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval' }
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.deepEqual(outcome, {
    kind: 'approval_required', toolName: 'fixtureTool', token: 'approval-token-123456',
    expiresAt: '2026-07-13T00:02:00.000Z', summaryCode: 'fixture_approval'
  })
  assert.deepEqual(fixture.calls.slice(-2), ['pending.put', 'approval.create'])
  assert.equal(fixture.pending.size, 1)
  assert.doesNotMatch(JSON.stringify([...fixture.pending.values()].map(call => ({ ...call, input: undefined }))), /approval-token-123456/)
  assert.equal(fixture.handlerCalls(), 0)
})

test('approval uses the TTL captured by the current run', async () => {
  const fixture = harness({
    decision: { kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval' },
    expectedApprovalTtlSeconds: 30
  })
  const outcome = await fixture.executor.execute(fixture.request({ approvalTtlSeconds: 30 }))
  assert.equal(outcome.kind, 'approval_required')
  if (outcome.kind === 'approval_required') {
    assert.equal(outcome.expiresAt, '2026-07-13T00:00:30.000Z')
  }
})

test('approval storage failure removes pending input and fails closed', async () => {
  const fixture = harness({
    decision: { kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval' },
    approvalCreateError: new Error('redis://secret')
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'failed')
  assert.equal(outcome.kind === 'completed' && outcome.result.status === 'failed' && outcome.result.errorCode, 'tool_control_unavailable')
  assert.deepEqual(fixture.calls.slice(-3), ['pending.put', 'approval.create', 'pending.delete'])
  assert.equal(fixture.pending.size, 0)
})

test('pending approval capacity failure is returned as a fixed control error', async () => {
  const fixture = harness({
    decision: { kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval' },
    pendingPutError: new Error('raw pending arguments')
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.equal(outcome.kind === 'completed' && outcome.result.status === 'failed' && outcome.result.errorCode, 'tool_control_unavailable')
  assert.equal(fixture.calls.includes('approval.create'), false)
  assert.equal(fixture.handlerCalls(), 0)
})

test('approval grant must match the frozen call and argument hash', async () => {
  const fixture = harness({
    decision: { kind: 'approval_required', reasonCode: 'approval_required', summaryCode: 'fixture_approval' }
  })
  const outcome = await fixture.executor.execute(fixture.request({
    approvalGrant: { tokenHash: 'hash:token', callId: 'other', argumentHash: 'hash:{}' }
  }))
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'denied')
  assert.equal(fixture.handlerCalls(), 0)
})

test('pre-aborted execution does not call the handler', async () => {
  const fixture = harness()
  const controller = new AbortController()
  controller.abort()
  const outcome = await fixture.executor.execute(fixture.request({ signal: controller.signal }))
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'failed')
  assert.equal(outcome.kind === 'completed' && outcome.result.status === 'failed' && outcome.result.errorCode, 'tool_cancelled')
  assert.equal(fixture.handlerCalls(), 0)
})

test('audit failure before execution fails closed without calling the handler', async () => {
  const fixture = harness({ auditErrorOn: 'requested' })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.equal(outcome.kind === 'completed' && outcome.result.status === 'failed' && outcome.result.errorCode, 'tool_control_unavailable')
  assert.equal(fixture.handlerCalls(), 0)
  assert.doesNotMatch(JSON.stringify(outcome), /audit|secret/)
})

test('a started side effect timeout is indeterminate and ignores late settlement', async () => {
  let settle!: (result: ToolResult) => void
  const fixture = harness({
    definitionTimeoutMs: 100,
    handler: async () => new Promise<ToolResult>(resolve => { settle = resolve })
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.deepEqual(outcome.kind === 'completed' && outcome.result, {
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  })
  assert.equal(fixture.calls.filter(call => call === 'idempotency.indeterminate').length, 1)
  assert.equal(fixture.calls.filter(call => call === 'audit.indeterminate').length, 1)

  const callCount = fixture.calls.length
  const auditCount = fixture.audits.length
  settle({ status: 'success', effect: 'background', content: [], retryable: false })
  await delay(0)
  assert.equal(fixture.calls.length, callCount)
  assert.equal(fixture.audits.length, auditCount)
})

test('read-only failures, invalid results and output overruns stay typed', async () => {
  const thrown = harness({
    effect: 'read_only',
    handler: async () => { throw new Error('https://provider.invalid/?token=secret') }
  })
  const thrownResult = await thrown.executor.execute(thrown.request())
  assert.equal(thrownResult.kind === 'completed' && thrownResult.result.status, 'failed')
  assert.doesNotMatch(JSON.stringify(thrownResult), /provider|token=secret/)

  const invalid = harness({
    effect: 'read_only',
    handler: async () => ({ status: 'success', effect: 'none', content: [], retryable: true } as never)
  })
  const invalidResult = await invalid.executor.execute(invalid.request())
  assert.equal(invalidResult.kind === 'completed' && invalidResult.result.status === 'failed' && invalidResult.result.errorCode, 'tool_invalid_result')

  const oversized = harness({
    effect: 'read_only', maxOutputBytes: 1_024,
    handler: async () => ({
      status: 'success', effect: 'none', content: [{ type: 'text', text: 'x'.repeat(2_000) }], retryable: false
    })
  })
  const oversizedResult = await oversized.executor.execute(oversized.request())
  assert.equal(oversizedResult.kind === 'completed' && oversizedResult.result.status === 'failed' && oversizedResult.result.errorCode, 'tool_output_too_large')
})

test('post-side-effect control failures remain indeterminate without throwing or replaying', async () => {
  const fixture = harness({
    idempotencyCompleteError: new Error('redis://secret'),
    idempotencyIndeterminateError: new Error('redis://secret')
  })
  const outcome = await fixture.executor.execute(fixture.request())
  assert.equal(outcome.kind === 'completed' && outcome.result.status, 'indeterminate')
  assert.equal(fixture.handlerCalls(), 1)
  assert.doesNotMatch(JSON.stringify(outcome), /redis|secret/)
})

test('idempotency duplicates return safe stored state without re-execution', async () => {
  const cases: readonly [IdempotencyReservation, string, string?][] = [
    [{ kind: 'running' }, 'failed', 'tool_in_progress'],
    [{ kind: 'indeterminate' }, 'indeterminate', 'tool_outcome_unknown'],
    [{
      kind: 'completed',
      outcome: { status: 'success', effect: 'background', completedAt: '2026-07-13T00:00:00.000Z' }
    }, 'success'],
    [{
      kind: 'completed',
      outcome: { status: 'failed', effect: 'none', errorCode: 'upstream_unavailable', completedAt: '2026-07-13T00:00:00.000Z' }
    }, 'failed', 'upstream_unavailable']
  ]

  for (const [reservation, status, code] of cases) {
    const fixture = harness({ reservation })
    const outcome = await fixture.executor.execute(fixture.request())
    assert.equal(outcome.kind === 'completed' && outcome.result.status, status)
    if (code !== undefined && outcome.kind === 'completed') {
      assert.equal('errorCode' in outcome.result ? outcome.result.errorCode : '', code)
    }
    assert.equal(fixture.handlerCalls(), 0)
    assert.doesNotMatch(JSON.stringify(outcome), /stored output|hello/)
  }
})
