import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RedisTraceStore,
  TRACE_KEY_PREFIX
} from '../../src/runtime/observability/redis-trace-store.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import {
  traceCandidateFixture,
  tracePresentationFixture,
  traceRunRef
} from '../helpers/trace-fixture.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const START = Date.parse('2026-07-16T00:00:00.000Z')

test('Redis trace store is idempotent and presentation is first-write-wins', async () => {
  let now = START
  const redis = new FakeRedis(() => now)
  const store = new RedisTraceStore({ client: redis, now: () => now })
  const candidate = traceCandidateFixture()
  const presentation = tracePresentationFixture(candidate)

  assert.deepEqual(await store.upsertEngine(candidate), {
    schemaVersion: 1,
    kind: 'stored'
  })
  assert.deepEqual(await store.upsertEngine(candidate), {
    schemaVersion: 1,
    kind: 'unchanged'
  })
  now += 60 * 60 * 1_000
  const ttlBeforeAppend = await redis.ttl(`${TRACE_KEY_PREFIX}${candidate.runRef}`)
  assert.deepEqual(await store.appendPresentation(presentation), {
    schemaVersion: 1,
    kind: 'stored'
  })
  assert.deepEqual(await store.upsertEngine(candidate), {
    schemaVersion: 1,
    kind: 'unchanged'
  })
  assert.deepEqual(await store.appendPresentation(presentation), {
    schemaVersion: 1,
    kind: 'unchanged'
  })
  assert.equal(
    await redis.ttl(`${TRACE_KEY_PREFIX}${candidate.runRef}`),
    ttlBeforeAppend
  )
  assert.deepEqual(await store.appendPresentation(tracePresentationFixture(candidate, {
    id: 'b'.repeat(64)
  })), {
    schemaVersion: 1,
    kind: 'rejected',
    code: 'conflict'
  })
  const loaded = await store.load(candidate.runRef)
  assert.equal(loaded.kind, 'found')
  if (loaded.kind === 'found') {
    assert.equal(loaded.record.presentation.kind, 'observed')
    assert.equal(loaded.record.serializedBytes, Buffer.byteLength(JSON.stringify(loaded.record)))
  }
  assert.equal(redis.scanCalls.length, 0)

  now += DAY_MS
  assert.deepEqual(await store.load(candidate.runRef), { kind: 'expired' })
})

test('a fresh process synchronizes generation once and corrupt records are removed', async () => {
  const redis = new FakeRedis(() => START)
  const leader = new RedisTraceStore({ client: redis, now: () => START })
  await leader.advanceGenerationAndClear()
  const fresh = new RedisTraceStore({ client: redis, now: () => START })
  const candidate = traceCandidateFixture({ runRef: traceRunRef(false, 110_000) })
  assert.equal((await fresh.upsertEngine(candidate)).kind, 'stored')
  assert.equal(redis.evalCalls.filter(call => call.operation === 'upsert').length, 2)

  const corruptRef = 'f'.repeat(32)
  const corruptKey = `${TRACE_KEY_PREFIX}${corruptRef}`
  await redis.set(corruptKey, '{"schemaVersion":1,"extra":"private"}', { EX: 300 })
  assert.deepEqual(await fresh.load(corruptRef), { kind: 'corrupt' })
  assert.equal(await redis.get(corruptKey), null)
})

test('generation advance clears records and stale writers cannot resurrect them', async () => {
  const redis = new FakeRedis(() => START)
  const firstStore = new RedisTraceStore({ client: redis, now: () => START })
  const staleStore = new RedisTraceStore({ client: redis, now: () => START })
  const candidate = traceCandidateFixture({ runRef: traceRunRef(false, 50_000) })
  assert.equal((await staleStore.upsertEngine(candidate)).kind, 'stored')

  const barrier = await firstStore.advanceGenerationAndClear()
  assert.equal(barrier.generation, 1)
  assert.equal(barrier.clear.removedRecords, 1)
  assert.deepEqual(await staleStore.upsertEngine(candidate), {
    schemaVersion: 1,
    kind: 'rejected',
    code: 'stale_generation'
  })
  assert.deepEqual(await firstStore.load(candidate.runRef), { kind: 'not_retained' })
})

test('trace store returns stable recent summaries, exact usage, and bounded clear', async () => {
  let now = START
  const redis = new FakeRedis(() => now)
  const store = new RedisTraceStore({ client: redis, now: () => now })
  const success = traceCandidateFixture({
    runRef: traceRunRef(true, 70_000),
    sampledSuccess: true
  })
  const failure = traceCandidateFixture({
    runRef: traceRunRef(false, 90_000),
    status: 'failed',
    finishedAt: new Date(START + 1).toISOString()
  })
  await store.upsertEngine(success)
  now += 1
  await store.upsertEngine(failure)
  const recent = await store.listRecent(2)
  assert.deepEqual(recent.map(item => item.runRef), [failure.runRef, success.runRef])
  assert.deepEqual(recent.map(item => item.retention), ['failed', 'sampled_success'])
  const usage = await store.usage()
  assert.equal(usage.records, 2)
  assert.ok(usage.bytes > 0)
  const cleared = await store.clear(1)
  assert.equal(cleared.removedRecords, 1)
  assert.equal(cleared.remainingRecords, 1)
})

test('append capacity pressure evicts another success before any failure', async () => {
  const redis = new FakeRedis(() => START)
  const store = new RedisTraceStore({ client: redis, now: () => START })
  const current = traceCandidateFixture({
    runRef: traceRunRef(true, 130_000),
    sampledSuccess: true
  })
  const currentKey = `${TRACE_KEY_PREFIX}${current.runRef}`
  const expiresAtMs = Date.parse(current.expiresAt)
  redis.seedTraceForTest({
    key: currentKey,
    value: JSON.stringify(current),
    expiresAtMs: expiresAtMs - 64,
    index: 'success',
    logicalBytes: 32 * 1024
  })

  const otherSuccessKey = `${TRACE_KEY_PREFIX}${'e'.repeat(32)}`
  redis.seedTraceForTest({
    key: otherSuccessKey,
    value: '{}',
    expiresAtMs: expiresAtMs - 63,
    index: 'success',
    logicalBytes: 32 * 1024
  })
  const failureKey = `${TRACE_KEY_PREFIX}${'d'.repeat(32)}`
  redis.seedTraceForTest({
    key: failureKey,
    value: '{}',
    expiresAtMs: expiresAtMs - 62,
    index: 'failure',
    logicalBytes: 32 * 1024
  })
  for (let index = 0; index < 61; index += 1) {
    const key = `${TRACE_KEY_PREFIX}${index.toString(16).padStart(32, '0')}`
    redis.seedTraceForTest({
      key,
      value: '{}',
      expiresAtMs: expiresAtMs - 61 + index,
      index: 'failure',
      logicalBytes: 32 * 1024
    })
  }

  assert.equal((await store.appendPresentation(tracePresentationFixture(current))).kind, 'stored')
  assert.equal(await redis.get(otherSuccessKey), null)
  assert.equal(await redis.get(failureKey), '{}')
})

test('listRecent atomically removes corrupt indexed records', async () => {
  const redis = new FakeRedis(() => START)
  const store = new RedisTraceStore({ client: redis, now: () => START })
  const candidate = traceCandidateFixture({ runRef: traceRunRef(true, 150_000) })
  const key = `${TRACE_KEY_PREFIX}${candidate.runRef}`
  assert.equal((await store.upsertEngine(candidate)).kind, 'stored')
  await redis.set(key, '{"schemaVersion":1,"extra":"private"}', { EX: 300 })

  assert.deepEqual(await store.listRecent(1), [])
  assert.equal(await redis.get(key), null)
  assert.deepEqual(await store.usage(), { schemaVersion: 1, records: 0, bytes: 0 })
})
