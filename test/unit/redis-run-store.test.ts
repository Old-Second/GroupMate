import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { AgentEvent } from '../../src/agent/contracts/event.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  RunCheckpointCodec,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import { createRunTombstone } from '../../src/agent/run/run-store.js'
import {
  RedisRunStore,
  RUN_STORE_LUA_MARKER,
  RUN_STORE_LUA_SCRIPT,
  redisRunKeys
} from '../../src/agent/run/redis-run-store.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const timestamp = '2026-07-14T00:00:00.000Z'
const deadlineAt = '2026-07-14T00:04:00.000Z'
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const emptyManifestFingerprint = createHash('sha256').update('[]').digest('hex')

function event (
  runId: string,
  sequence: number,
  type: AgentEvent['type'] = 'run.created',
  payload: AgentEvent['payload'] = Object.freeze({})
): AgentEvent {
  return createRunEvent({
    eventId: `event-${sequence}`,
    runId,
    sessionId: 'session-1',
    sequence,
    occurredAt: timestamp,
    type,
    payload
  })
}

function checkpoint (runId = 'run-1'): RunCheckpoint {
  return createInitialRunCheckpoint({
    profileId: 'standard', profileVersion: 1, runId,
    sessionId: 'session-1',
    sessionAddress: Object.freeze({
      botId: 'bot-private-value',
      scope: Object.freeze({ kind: 'group_user', groupId: 'group-private-value', userId: 'user-private-value' })
    }),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    toolSnapshot: Object.freeze({
      id: 'snapshot-1', fingerprint: emptyManifestFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt,
    createdAt: timestamp,
    event: event(runId, 0)
  })
}

function preparing (
  source: RunCheckpoint,
  marker: string
): RunCheckpoint {
  return nextRunCheckpoint(source, 'preparing', {
    messages: Object.freeze([{ role: 'user' as const, content: marker }]),
    estimatedInputTokens: 4
  }, [event(source.runId, source.nextEventSequence, 'run.started', { marker })], timestamp)
}

test('RedisRunStore round-trips split checkpoint state and event stream under hashed keys', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpoint()

  assert.deepEqual(await store.create(source), source)
  assert.deepEqual(await store.load(source.runId), source)

  const keys = redisRunKeys(source.runId)
  assert.equal(keys.checkpoint.includes(source.runId), false)
  assert.equal(keys.events.includes(source.runId), false)
  assert.equal(keys.tombstone.includes(source.runId), false)
  assert.equal(await redis.ttl(keys.checkpoint), 300)
  assert.equal(await redis.ttl(keys.events), 300)
  assert.equal(redis.evalCalls.every(call => call.marker === RUN_STORE_LUA_MARKER), true)
  assert.equal(redis.evalCalls.some(call => call.operation === 'create'), true)
  assert.doesNotMatch(RUN_STORE_LUA_SCRIPT, /redis\.call\(['"](?:KEYS|WATCH|MULTI)['"]\)/)
})

test('RedisRunStore create is NX and exactly one revision CAS wins', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const created = await store.create(checkpoint())
  await assert.rejects(store.create(created), error => (
    error instanceof AgentError && error.code === 'checkpoint_conflict'
  ))

  const [first, second] = await Promise.allSettled([
    store.compareAndSet(created, preparing(created, 'first')),
    store.compareAndSet(created, preparing(created, 'second'))
  ])
  assert.deepEqual([first.status, second.status].sort(), ['fulfilled', 'rejected'])
  assert.equal((await store.load(created.runId))?.revision, 1)
  const rejected = first.status === 'rejected' ? first.reason : second.status === 'rejected' ? second.reason : null
  assert.equal(rejected instanceof AgentError && rejected.code, 'checkpoint_conflict')
})

test('RedisRunStore atomically replaces terminal state with one bounded 24-hour tombstone', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const created = await store.create(checkpoint())
  const cancelled = nextRunCheckpoint(created, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(created.runId, 1, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)

  assert.deepEqual(await store.compareAndSet(created, cancelled), cancelled)
  assert.equal(await store.load(created.runId), null)
  const tombstone = await store.loadTombstone(created.runId)
  assert.equal(tombstone?.status, 'cancelled')
  assert.equal(tombstone?.revision, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(tombstone), 'utf8') <= 4 * 1_024)
  const keys = redisRunKeys(created.runId)
  assert.equal(await redis.ttl(keys.checkpoint), -2)
  assert.equal(await redis.ttl(keys.events), -2)
  assert.equal(await redis.ttl(keys.tombstone), 86_400)
})

test('RedisRunStore appends immutable events and supports the explicit finish port', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const created = await store.create(checkpoint())
  const progress = event(created.runId, 1, 'run.progress', { text: '阶段已开始' })

  const appended = await store.appendEvents(created, [progress])

  assert.equal(appended.revision, 1)
  assert.deepEqual(appended.events.at(-1), progress)
  const cancelled = nextRunCheckpoint(appended, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(created.runId, 2, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)
  const tombstone = await store.finish(appended, createRunTombstone(cancelled))
  assert.equal(tombstone.status, 'cancelled')
  assert.equal(await store.load(created.runId), null)
  assert.deepEqual(await store.loadTombstone(created.runId), tombstone)
})

test('RunCheckpointCodec rejects non-JSON, unknown fields and every checkpoint/event boundary', () => {
  const codec = new RunCheckpointCodec()
  const source = checkpoint()
  assert.throws(() => codec.encode({
    ...source,
    apiKey: 'must-not-persist'
  } as unknown as RunCheckpoint), /unknown checkpoint key/)
  assert.throws(() => codec.encode({
    ...source,
    messages: Object.freeze([{ role: 'user', content: 'ok', runtime: () => undefined }])
  } as unknown as RunCheckpoint), /unsupported value|unknown model message key/)
  assert.throws(() => codec.encode({
    ...source,
    messages: Object.freeze([{ role: 'user', content: 'x'.repeat(257 * 1_024) }])
  } as unknown as RunCheckpoint), /checkpoint byte limit/)

  const tooManyEvents = Array.from({ length: 97 }, (_, index) => event(source.runId, index))
  assert.throws(() => codec.encode({
    ...source,
    events: Object.freeze(tooManyEvents),
    nextEventSequence: tooManyEvents.length
  } as RunCheckpoint), /event count limit/)

  const oversizedEvents = Array.from({ length: 90 }, (_, index) => (
    event(source.runId, index, 'run.progress', { text: 'x'.repeat(1_500) })
  ))
  assert.throws(() => codec.encode({
    ...source,
    events: Object.freeze(oversizedEvents),
    nextEventSequence: oversizedEvents.length
  } as RunCheckpoint), /event byte limit/)
})

test('RedisRunStore fails closed for malformed and incompatible persisted state', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = await store.create(checkpoint())
  const keys = redisRunKeys(source.runId)
  await redis.set(keys.checkpoint, JSON.stringify({ schemaVersion: 2 }), { EX: 300 })

  await assert.rejects(store.load(source.runId), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
})

test('RedisRunStore enforces checkpoint key and namespace byte budgets before writes', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  for (let index = 0; index < 16; index += 1) {
    await store.create(checkpoint(`run-${index}`))
  }
  await assert.rejects(store.create(checkpoint('run-over-key-limit')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))

  const largeRedis = new FakeRedis(() => Date.parse(timestamp))
  await largeRedis.set(
    'GROUPMATE:RUN:v1:approval-index:bounded-fixture',
    'x'.repeat(8 * 1_024 * 1_024)
  )
  const largeStore = new RedisRunStore({ client: largeRedis })
  await assert.rejects(largeStore.create(checkpoint('run-byte-limit')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))
  assert.equal(await largeRedis.get(redisRunKeys('run-byte-limit').checkpoint), null)
})

test('RedisRunStore reclaims expired tombstones before namespace admission', async () => {
  let nowMs = Date.parse(timestamp)
  const redis = new FakeRedis(() => nowMs)
  for (let index = 0; index < 129; index += 1) {
    await redis.set(
      `GROUPMATE:RUN:v1:tombstone:expired-${index}`,
      '{}',
      { EX: 1 }
    )
  }
  nowMs += 1_001
  const store = new RedisRunStore({ client: redis })

  await store.create(checkpoint('run-after-reclaim'))

  assert.notEqual(await redis.get(redisRunKeys('run-after-reclaim').checkpoint), null)
})
