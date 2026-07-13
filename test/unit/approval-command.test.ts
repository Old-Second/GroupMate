import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { ApprovalRecord, ApprovalStore } from '../../src/agent/tools/approval-store.js'
import type { IdempotencyRecord, IdempotencyStore, StoredToolOutcome } from '../../src/agent/tools/idempotency-store.js'
import type { PendingCallStore, PendingToolCall } from '../../src/agent/tools/pending-call-store.js'
import { ToolPolicyEngine } from '../../src/agent/tools/policy-engine.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import { ToolExecutor } from '../../src/agent/tools/tool-executor.js'
import type { ToolRuntimeFacts, ToolTarget } from '../../src/agent/tools/tool-context.js'
import { createManagementToolDefinitions } from '../../src/runtime/tools/tool-runtime-factory.js'
import {
  ApprovalCommandService,
  createApprovalCommandBridge,
  parseApprovalCommand,
  sha256ApprovalValue
} from '../../src/runtime/tools/approval-command.js'

test('approval command parser accepts only the exact confirm and reject grammar', () => {
  const token = 'abcdefghijklmnop'
  assert.deepEqual(parseApprovalCommand(`#确认 ${token}`), { action: 'confirm', token })
  assert.deepEqual(parseApprovalCommand(`#拒绝 ${token}`), { action: 'reject', token })
  for (const text of [
    `确认 ${token}`, `#确认${token}`, `#批准 ${token}`, '#确认 short',
    `#确认 ${token} extra`, `prefix #确认 ${token}`
  ]) assert.equal(parseApprovalCommand(text), null, text)
  assert.match(sha256ApprovalValue(token), /^[a-f0-9]{64}$/)
})

interface TestEvent {
  readonly botId: string
  readonly actorId: string
  readonly channelId: string
  readonly isBotMaster: boolean
  readonly msg?: string
  reply?: (message: string) => Promise<void>
}

class MemoryApprovalStore implements ApprovalStore {
  readonly records = new Map<string, ApprovalRecord>()

  async create (record: ApprovalRecord): Promise<void> {
    this.records.set(record.tokenHash, record)
  }

  async get (tokenHash: string): Promise<ApprovalRecord | null> {
    return this.records.get(tokenHash) ?? null
  }

  async consume (tokenHash: string, expectedRawVersion: string): Promise<ApprovalRecord | null> {
    const record = this.records.get(tokenHash)
    if (record === undefined || record.rawVersion !== expectedRawVersion) return null
    this.records.delete(tokenHash)
    return record
  }
}

class MemoryPendingStore implements PendingCallStore {
  readonly calls = new Map<string, PendingToolCall>()

  put (call: PendingToolCall): void { this.calls.set(call.pendingCallId, call) }

  take (pendingCallId: string, argumentHash: string): PendingToolCall | null {
    const call = this.calls.get(pendingCallId)
    if (call === undefined || call.argumentHash !== argumentHash) return null
    this.calls.delete(pendingCallId)
    return call
  }

  delete (pendingCallId: string): boolean { return this.calls.delete(pendingCallId) }
}

function approvalFixture (options: {
  readonly putPending?: boolean
  readonly changedInput?: boolean
  readonly changedDefinition?: boolean
  readonly permissionChanged?: boolean
  readonly expired?: boolean
} = {}) {
  const hash = sha256ApprovalValue
  const token = 'abcdefghijklmnop'
  const now = new Date('2026-07-13T00:00:00.000Z')
  let capabilityCalls = 0
  const definitions = createManagementToolDefinitions({
    muteMember: async () => { capabilityCalls += 1 },
    kickMember: async () => {}, setCard: async () => {}, setTitle: async () => {},
    recallMessage: async () => {}, setEssence: async () => {}
  })
  const definition = definitions.find(item => item.name === 'jinyan')
  assert.ok(definition)
  const facts: ToolRuntimeFacts = {
    botId: '10000',
    actor: { userId: '7', role: 'admin', isBotMaster: false },
    channel: { kind: 'group', botId: '10000', groupId: '9' },
    scope: { kind: 'group', groupId: '9' },
    botGroupRole: options.permissionChanged === true ? 'member' : 'admin',
    actorGroupRole: 'admin', targetRole: 'member', targetIsBotMaster: false, targetExists: true
  }
  const snapshot = options.changedDefinition === true
    ? new ToolRegistry([]).createSnapshot({ id: 'snapshot-1', facts, enabledTools: [] })
    : new ToolRegistry([definition]).createSnapshot({ id: 'snapshot-1', facts, enabledTools: ['jinyan'] })
  const input = Object.freeze(options.changedInput === true
    ? { seconds: 61, userId: '8' }
    : { seconds: 60, userId: '8' })
  const originalInput = Object.freeze({ seconds: 60, userId: '8' })
  const argumentHash = hash(JSON.stringify(originalInput))
  const target = definition.resolveTarget(originalInput, facts)
  const expiresAt = new Date(now.getTime() + (options.expired === true ? -1_000 : 120_000)).toISOString()
  const pending: PendingToolCall = Object.freeze({
    schemaVersion: 1, pendingCallId: 'pending-1', toolName: 'jinyan', toolVersion: 1,
    profile: 'safe',
    call: Object.freeze({
      runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1', requestedName: 'jinyan'
    }),
    input, argumentHash,
    intent: Object.freeze({
      trustedSources: ['current_request'] as const, actions: ['mute'] as const,
      mentionUserIds: ['8'], explicitTargetIds: ['8'],
      replyMessageId: null, currentMessageId: 'current'
    }),
    createdAt: now.toISOString(), expiresAt
  })
  const record: ApprovalRecord = Object.freeze({
    schemaVersion: 1, rawVersion: 'raw-1', tokenHash: hash(token),
    toolName: 'jinyan', toolVersion: 1, profile: 'safe', runId: 'run-1', callId: 'call-1',
    snapshotId: 'snapshot-1', argumentHash, pendingCallId: 'pending-1',
    botIdHash: hash('10000'), actorIdHash: hash('7'), channelHash: hash('group:9'),
    targetHash: hash(JSON.stringify(target)), summaryCode: 'jinyan_approval',
    createdAt: now.toISOString(), expiresAt
  })
  const approvals = new MemoryApprovalStore()
  approvals.records.set(record.tokenHash, record)
  const pendingCalls = new MemoryPendingStore()
  if (options.putPending !== false) pendingCalls.put(pending)
  const idempotency = new Map<string, StoredToolOutcome | 'running' | 'indeterminate'>()
  const idempotencyStore: IdempotencyStore = {
    reserve: async (entry: IdempotencyRecord) => {
      const existing = idempotency.get(entry.key)
      if (existing === undefined) { idempotency.set(entry.key, 'running'); return { kind: 'acquired' } }
      if (existing === 'running') return { kind: 'running' }
      if (existing === 'indeterminate') return { kind: 'indeterminate' }
      return { kind: 'completed', outcome: existing }
    },
    complete: async (key, outcome) => { idempotency.set(key, outcome) },
    markIndeterminate: async key => { idempotency.set(key, 'indeterminate') }
  }
  let sequence = 0
  const executor = new ToolExecutor({
    policy: new ToolPolicyEngine(),
    approvalStore: approvals, pendingCalls, idempotencyStore,
    audit: { emit: () => {} },
    generateId: () => `id-${++sequence}`, generateToken: () => 'unused-token',
    hash, now: () => now
  })
  const service = new ApprovalCommandService({
    approvals, pendingCalls, executor, hash, now: () => now,
    bindEvent: async raw => {
      const event = raw as TestEvent
      return {
        botIdHash: hash(event.botId), actorIdHash: hash(event.actorId),
        channelHash: hash(event.channelId), isBotMaster: event.isBotMaster
      }
    },
    resolveRuntime: async () => ({
      snapshot, initialFacts: facts, refreshFacts: async (_target: ToolTarget) => facts
    })
  })
  const originalEvent: TestEvent = {
    botId: '10000', actorId: '7', channelId: 'group:9', isBotMaster: false
  }
  return {
    service, token, originalEvent, approvals, pendingCalls,
    capabilityCalls: () => capabilityCalls
  }
}

test('approval command confirms the frozen call through the same executor once', async () => {
  const fixture = approvalFixture()
  assert.deepEqual(await fixture.service.resolve({
    action: 'confirm', token: fixture.token, event: fixture.originalEvent
  }), { handled: true, message: '操作已确认并执行。', effect: 'background' })
  assert.equal(fixture.capabilityCalls(), 1)
})

test('wrong actor, bot or channel cannot consume an approval', async () => {
  for (const override of [
    { actorId: '8' }, { botId: '20000' }, { channelId: 'group:10' }
  ]) {
    const fixture = approvalFixture()
    const invalid = await fixture.service.resolve({
      action: 'confirm', token: fixture.token,
      event: { ...fixture.originalEvent, ...override }
    })
    assert.equal(invalid.message, '该审批无效或已过期。')
    assert.equal(fixture.capabilityCalls(), 0)
    const valid = await fixture.service.resolve({
      action: 'confirm', token: fixture.token, event: fixture.originalEvent
    })
    assert.equal(valid.message, '操作已确认并执行。')
  }
})

test('bot master may confirm the original call only in the same bot and channel', async () => {
  const fixture = approvalFixture()
  const result = await fixture.service.resolve({
    action: 'confirm', token: fixture.token,
    event: { ...fixture.originalEvent, actorId: '999', isBotMaster: true }
  })
  assert.equal(result.message, '操作已确认并执行。')
  assert.equal(fixture.capabilityCalls(), 1)
})

test('reject consumes approval and deletes pending call without execution', async () => {
  const fixture = approvalFixture()
  assert.deepEqual(await fixture.service.resolve({
    action: 'reject', token: fixture.token, event: fixture.originalEvent
  }), { handled: true, message: '操作已拒绝。', effect: 'none' })
  assert.equal(fixture.capabilityCalls(), 0)
  assert.equal(fixture.pendingCalls.calls.size, 0)
})

test('expired, missing pending, changed arguments and changed definition fail closed', async () => {
  for (const options of [
    { expired: true }, { putPending: false }, { changedInput: true }, { changedDefinition: true }
  ]) {
    const fixture = approvalFixture(options)
    const result = await fixture.service.resolve({
      action: 'confirm', token: fixture.token, event: fixture.originalEvent
    })
    assert.equal(result.message, '该审批无效或已过期。')
    assert.equal(fixture.capabilityCalls(), 0)
  }
})

test('permission recheck denies a previously approved call before capability execution', async () => {
  const fixture = approvalFixture({ permissionChanged: true })
  const result = await fixture.service.resolve({
    action: 'confirm', token: fixture.token, event: fixture.originalEvent
  })
  assert.equal(result.message, '机器人当前没有执行该操作的群权限。')
  assert.equal(fixture.capabilityCalls(), 0)
})

test('two simultaneous confirms cause one underlying capability call', async () => {
  const fixture = approvalFixture()
  const results = await Promise.all([
    fixture.service.resolve({ action: 'confirm', token: fixture.token, event: fixture.originalEvent }),
    fixture.service.resolve({ action: 'confirm', token: fixture.token, event: fixture.originalEvent })
  ])
  assert.equal(results.filter(result => result.message === '操作已确认并执行。').length, 1)
  assert.equal(results.filter(result => result.message === '该审批无效或已过期。').length, 1)
  assert.equal(fixture.capabilityCalls(), 1)
})

test('approval bridge replies only for exact commands', async () => {
  const replies: string[] = []
  const bridge = createApprovalCommandBridge(() => ({
    resolve: async () => ({ handled: true, message: '操作已拒绝。', effect: 'none' })
  }))
  assert.equal(await bridge({ msg: 'hello', reply: async message => { replies.push(message) } }), false)
  assert.equal(await bridge({
    msg: '#拒绝 abcdefghijklmnop', reply: async message => { replies.push(message) }
  }), true)
  assert.deepEqual(replies, ['操作已拒绝。'])
})

test('thin approval app contains no store, policy or token implementation', async () => {
  const source = await readFile('apps/approval.js', 'utf8')
  assert.match(source, /createApprovalCommandBridge/)
  assert.doesNotMatch(source, /redis|ApprovalStore|PendingCallStore|ToolPolicy|createHash|tokenHash|consume\(/)
})
