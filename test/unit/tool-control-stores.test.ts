import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRecord } from '../../src/agent/tools/approval-store.js'
import type { IdempotencyRecord } from '../../src/agent/tools/idempotency-store.js'
import type { PendingToolCall } from '../../src/agent/tools/pending-call-store.js'
import { InMemoryPendingCallStore } from '../../src/runtime/tools/in-memory-pending-call-store.js'
import { RedisApprovalStore } from '../../src/runtime/tools/redis-approval-store.js'
import { RedisIdempotencyStore } from '../../src/runtime/tools/redis-idempotency-store.js'
import { extractIntentEvidence } from '../../src/runtime/tools/intent-evidence.js'
import { FakeRedis } from '../helpers/fake-redis.js'

test('FakeRedis implements atomic NX, XX, getDel and expiration', async () => {
  let now = 0
  const redis = new FakeRedis(() => now)
  assert.equal(await redis.set('key', 'one', { EX: 2, NX: true }), 'OK')
  assert.equal(await redis.set('key', 'two', { EX: 2, NX: true }), null)
  assert.equal(await redis.get('key'), 'one')
  assert.equal(await redis.set('missing', 'two', { EX: 2, XX: true }), null)
  assert.equal(await redis.set('key', 'updated', { EX: 2, XX: true }), 'OK')
  assert.equal(await redis.getDel('key'), 'updated')
  assert.equal(await redis.getDel('key'), null)

  await redis.set('expiring', 'value', { EX: 1 })
  now = 1_000
  assert.equal(await redis.get('expiring'), null)
  assert.equal(await redis.set('expiring', 'new', { EX: 1, NX: true }), 'OK')
})

function approvalRecord (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    schemaVersion: 1,
    rawVersion: 'version-1',
    tokenHash: 'token-hash-1',
    toolName: 'kickOut',
    toolVersion: 1,
    profile: 'safe',
    runId: 'run-1',
    callId: 'call-1',
    snapshotId: 'snapshot-1',
    argumentHash: 'argument-hash-1',
    pendingCallId: 'pending-1',
    botIdHash: 'bot-hash-1',
    actorIdHash: 'actor-hash-1',
    channelHash: 'channel-hash-1',
    targetHash: 'target-hash-1',
    summaryCode: 'kick_out_approval',
    createdAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2026-07-13T00:02:00.000Z',
    ...overrides
  }
}

test('approval store persists only bounded redacted control data with TTL', async () => {
  let now = Date.parse('2026-07-13T00:00:00.000Z')
  const redis = new FakeRedis(() => now)
  const store = new RedisApprovalStore({ client: redis, botIdHash: 'bot-hash-1' })
  const record = approvalRecord()

  await store.create(record, 120)
  assert.equal(redis.setCalls.length, 1)
  assert.deepEqual(redis.setCalls[0].options, { EX: 120, NX: true })
  const raw = await redis.get(redis.setCalls[0].key)
  assert.ok(raw)
  assert.doesNotMatch(raw, /approval-token|rawArguments|"input"|message text|tool output/)
  assert.deepEqual(await store.get(record.tokenHash), record)

  now += 120_000
  assert.equal(await store.get(record.tokenHash), null)
})

test('approval precheck does not consume and concurrent consume succeeds once', async () => {
  const redis = new FakeRedis()
  const store = new RedisApprovalStore({ client: redis, botIdHash: 'bot-hash-1' })
  const record = approvalRecord()
  await store.create(record, 120)

  assert.equal(await store.consume(record.tokenHash, 'wrong-version'), null)
  assert.ok(await store.get(record.tokenHash))
  const consumed = await Promise.all([
    store.consume(record.tokenHash, record.rawVersion),
    store.consume(record.tokenHash, record.rawVersion)
  ])
  assert.equal(consumed.filter(Boolean).length, 1)
  assert.equal(await store.get(record.tokenHash), null)
})

test('approval store rejects namespace mismatch and removes malformed records', async () => {
  const redis = new FakeRedis()
  const store = new RedisApprovalStore({ client: redis, botIdHash: 'bot-hash-1' })
  await assert.rejects(store.create(approvalRecord({ botIdHash: 'other-bot' }), 120))

  await store.create(approvalRecord(), 120)
  const key = redis.setCalls.at(-1)?.key
  assert.ok(key)
  await redis.set(key, '{malformed', { EX: 120, XX: true })
  assert.equal(await store.get('token-hash-1'), null)
  assert.equal(await redis.get(key), null)
})

function pendingCall (
  id: string,
  text = 'hello',
  overrides: Partial<PendingToolCall> = {}
): PendingToolCall {
  return {
    schemaVersion: 1,
    pendingCallId: id,
    toolName: 'sendMessage',
    toolVersion: 1,
    profile: 'safe',
    call: { runId: 'run-1', callId: `call-${id}`, snapshotId: 'snapshot-1', requestedName: 'sendMessage' },
    input: Object.freeze({ text }),
    intent: extractIntentEvidence({ text: '发送消息', mentions: [], reply: null }),
    argumentHash: `hash-${id}`,
    createdAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2026-07-13T00:02:00.000Z',
    ...overrides
  }
}

test('pending store enforces entry count, total bytes, TTL and hash binding', () => {
  let now = 0
  const store = new InMemoryPendingCallStore({
    now: () => now,
    maxEntries: 2,
    maxEntryBytes: 1_024,
    maxTotalBytes: 1_200,
    ttlMs: 120_000
  })
  store.put(pendingCall('one', 'a'.repeat(200)))
  store.put(pendingCall('two', 'b'.repeat(200)))
  store.put(pendingCall('three', 'c'.repeat(200)))
  assert.equal(store.take('one', 'hash-one'), null)
  assert.equal(store.take('three', 'wrong-hash'), null)
  assert.equal(store.take('three', 'hash-three')?.input.text, 'c'.repeat(200))
  assert.equal(store.take('three', 'hash-three'), null)

  store.put(pendingCall('expires'))
  now = 120_000
  assert.equal(store.take('expires', 'hash-expires'), null)
})

test('pending store rejects oversized entries and restart loses pending calls safely', () => {
  const options = {
    now: () => 0,
    maxEntries: 32,
    maxEntryBytes: 32 * 1024,
    maxTotalBytes: 256 * 1024,
    ttlMs: 120_000
  }
  const first = new InMemoryPendingCallStore(options)
  assert.throws(() => first.put(pendingCall('oversized', 'x'.repeat(33 * 1024))), RangeError)
  first.put(pendingCall('pending'))
  const restarted = new InMemoryPendingCallStore(options)
  assert.equal(restarted.take('pending', 'hash-pending'), null)
})

function idempotencyRecord (key = 'idempotency-hash-1'): IdempotencyRecord {
  return {
    schemaVersion: 1,
    key,
    toolName: 'sendMessage',
    toolVersion: 1,
    runIdHash: 'run-hash-1',
    callIdHash: 'call-hash-1',
    startedAt: '2026-07-13T00:00:00.000Z'
  }
}

test('idempotency store reserves with NX and exposes only safe states', async () => {
  const redis = new FakeRedis()
  const store = new RedisIdempotencyStore({ client: redis, botIdHash: 'bot-hash-1' })
  const record = idempotencyRecord()
  assert.deepEqual(await store.reserve(record, 300), { kind: 'acquired' })
  assert.deepEqual(await store.reserve(record, 300), { kind: 'running' })

  await store.complete(record.key, {
    status: 'success', effect: 'visible', completedAt: '2026-07-13T00:00:01.000Z'
  }, 300)
  assert.deepEqual(await store.reserve(record, 300), {
    kind: 'completed',
    outcome: { status: 'success', effect: 'visible', completedAt: '2026-07-13T00:00:01.000Z' }
  })
  const raw = await redis.get(redis.setCalls[0].key)
  assert.ok(raw)
  assert.doesNotMatch(raw, /tool output|message text|"content"|rawArguments/)
})

test('idempotency indeterminate and malformed states never reacquire execution', async () => {
  const redis = new FakeRedis()
  const store = new RedisIdempotencyStore({ client: redis, botIdHash: 'bot-hash-1' })
  const first = idempotencyRecord('first')
  await store.reserve(first, 300)
  await store.markIndeterminate(first.key, 300)
  assert.deepEqual(await store.reserve(first, 300), { kind: 'indeterminate' })

  const second = idempotencyRecord('second')
  await store.reserve(second, 300)
  const key = redis.setCalls.at(-1)?.key
  assert.ok(key)
  await redis.set(key, '{malformed', { EX: 300, XX: true })
  assert.deepEqual(await store.reserve(second, 300), { kind: 'indeterminate' })
})
