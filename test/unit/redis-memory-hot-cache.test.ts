import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  createMemoryHotCachePortV1,
  type MemoryHotCacheRequestV1
} from '../../src/agent/memory/memory-hot-cache.js'
import { encodeMemoryRecordV1 } from '../../src/agent/memory/memory-codec.js'
import {
  MEMORY_HOT_CACHE_KEYS,
  MEMORY_HOT_CACHE_LUA_MARKER,
  MEMORY_HOT_CACHE_LUA_SCRIPT,
  MEMORY_HOT_CACHE_RECORD_FIELD_HASH_DOMAIN,
  MEMORY_HOT_CACHE_STATIC_BYTES,
  RedisMemoryHotCache,
  memoryHotCacheHeadFieldV1,
  memoryHotCacheHeadValueV1,
  memoryHotCacheIndexEntryBytesV1,
  memoryHotCacheMetadataEntryBytesV1,
  memoryHotCacheNamespaceFieldV1,
  memoryHotCacheRecordEntryBytesV1,
  memoryHotCacheRecordFieldV1
} from '../../src/agent/memory/redis-memory-hot-cache.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memoryRecordFixture,
  memorySourceFixture,
  deepFreezeFixture
} from '../helpers/memory-fixture.js'
import { findProjectRoot } from '../helpers/project-root.js'

const PROJECT_ROOT = findProjectRoot(import.meta.url)

function recordHead (record = memoryRecordFixture ()): Readonly<{
  namespaceRef: string
  namespaceGeneration: number
  memoryId: string
  revision: number
  contentHash: string
}> {
  return deepFreezeFixture({
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: record.revision,
    contentHash: record.contentHash
  })
}

function largeMemoryRecordFixture () {
  const sources = Array.from({ length: 5 }, (_, index) => memorySourceFixture({
    messageId: `message-large-${index}`,
    normalizedText: `${index}${'源'.repeat(300)}`
  }))
  return memoryRecordFixture({
    text: `大${'文'.repeat(1_300)}`,
    sources: deepFreezeFixture(sources),
    consent: deepFreezeFixture({
      state: 'explicit',
      approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: sources[0]?.sourceId,
      policyRef: null,
      approvedAt: FIXTURE_TIMES.confirmedAt
    })
  })
}

test('memory hot cache port accepts only the five exact capability-free requests', async () => {
  const seen: MemoryHotCacheRequestV1[] = []
  const port = createMemoryHotCachePortV1({
    execute: async request => {
      seen.push(request)
      if (request.operation === 'record.get') return { status: 'miss', reason: 'not_found' }
      if (request.operation === 'record.put') return { status: 'stored' }
      if (request.operation === 'usage.get') {
        return {
          status: 'usage',
          value: {
            schemaVersion: 1,
            recordCount: 0,
            generationCount: 0,
            recordEntryBytes: 0,
            expiryIndexBytes: 0,
            lruIndexBytes: 0,
            dynamicMetadataBytes: 0,
            staticBytes: 1,
            totalLogicalBytes: 1
          }
        }
      }
      return { status: 'unchanged' }
    }
  })
  const record = memoryRecordFixture()
  const requests = [
    { schemaVersion: 1, operation: 'record.get', head: recordHead(record) },
    { schemaVersion: 1, operation: 'record.put', record },
    {
      schemaVersion: 1,
      operation: 'record.invalidate',
      namespaceRef: record.namespaceRef,
      namespaceGeneration: 1,
      memoryId: record.memoryId,
      deletedRevision: 1
    },
    {
      schemaVersion: 1,
      operation: 'namespace.invalidate',
      namespaceRef: record.namespaceRef,
      deletedGeneration: 1,
      nextGeneration: 2
    },
    { schemaVersion: 1, operation: 'usage.get' }
  ] as const

  for (const request of requests) await port.execute(request)

  assert.deepEqual(seen.map(request => request.operation), [
    'record.get',
    'record.put',
    'record.invalidate',
    'namespace.invalidate',
    'usage.get'
  ])
  assert.equal(seen.every(request => !Object.hasOwn(request, 'capability')), true)
  assert.equal(Object.isFrozen(seen[0]), true)
  assert.equal(Object.isFrozen((seen[0] as Extract<MemoryHotCacheRequestV1, {
    operation: 'record.get'
  }>).head), true)
})

test('memory hot cache port rejects hostile, extra-key, and canonical mutation requests', async t => {
  const port = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'unavailable' })
  })
  const record = memoryRecordFixture()
  const valid = { schemaVersion: 1, operation: 'record.get', head: recordHead(record) }
  let getterCalls = 0
  const hostile = Object.defineProperty({
    schemaVersion: 1,
    operation: 'record.get'
  }, 'head', {
    enumerable: true,
    get () {
      getterCalls += 1
      return recordHead(record)
    }
  })
  const cases: readonly unknown[] = [
    null,
    new Proxy(valid, {}),
    hostile,
    { ...valid, extra: true },
    { ...valid, capability: {} },
    { ...valid, head: { ...recordHead(record), extra: true } },
    { schemaVersion: 1, operation: 'record.create', record },
    {
      schemaVersion: 1,
      operation: 'namespace.invalidate',
      namespaceRef: record.namespaceRef,
      deletedGeneration: 1,
      nextGeneration: 3
    }
  ]
  for (const [index, value] of cases.entries()) {
    await t.test(String(index), async () => {
      await assert.rejects(port.execute(value), TypeError)
    })
  }
  assert.equal(getterCalls, 0)
})

test('memory hot cache port validates canonical puts and exact hit bodies', async () => {
  const record = memoryRecordFixture()
  const head = recordHead(record)
  const hitPort = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'hit', record })
  })
  assert.deepEqual(await hitPort.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head
  }), { status: 'hit', record })

  const mismatchPort = createMemoryHotCachePortV1({
    execute: async () => ({
      status: 'hit',
      record: memoryRecordFixture({ revision: 2 })
    })
  })
  assert.deepEqual(await mismatchPort.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head
  }), { status: 'unavailable' })
  await assert.rejects(hitPort.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: { ...record, contentHash: '0'.repeat(64) }
  }), TypeError)
})

test('memory hot cache port returns fixed unavailable for failures or malformed adapter results', async () => {
  const record = memoryRecordFixture()
  const request = { schemaVersion: 1, operation: 'record.get', head: recordHead(record) }
  const throwing = createMemoryHotCachePortV1({
    execute: async () => { throw new Error('redis leaked detail') }
  })
  const malformed = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'miss', reason: 'unknown', detail: record.text })
  })

  assert.deepEqual(await throwing.execute(request), { status: 'unavailable' })
  assert.deepEqual(await malformed.execute(request), { status: 'unavailable' })
})

test('memory hot cache port rejects hostile adapter results without invoking accessors', async t => {
  const record = memoryRecordFixture()
  const request = { schemaVersion: 1, operation: 'record.get', head: recordHead(record) }
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'status', {
    enumerable: true,
    get () {
      getterCalls += 1
      return 'miss'
    }
  })
  const values: readonly unknown[] = [
    new Proxy({ status: 'miss', reason: 'not_found' }, {}),
    hostile,
    { status: 'miss', reason: 'not_found', extra: record.text }
  ]
  for (const [index, value] of values.entries()) {
    await t.test(String(index), async () => {
      const port = createMemoryHotCachePortV1({ execute: async () => value })
      assert.deepEqual(await port.execute(request), { status: 'unavailable' })
    })
  }
  assert.equal(getterCalls, 0)
})

test('memory hot cache port enforces the operation result matrix', async () => {
  const record = memoryRecordFixture()
  const cases = [
    [{ schemaVersion: 1, operation: 'record.get', head: recordHead(record) }, { status: 'stored' }],
    [{ schemaVersion: 1, operation: 'record.put', record }, { status: 'hit', record }],
    [{ schemaVersion: 1, operation: 'usage.get' }, { status: 'unchanged' }],
    [{ schemaVersion: 1, operation: 'record.get', head: recordHead(record) }, { status: 'aborted' }]
  ] as const
  for (const [request, result] of cases) {
    const port = createMemoryHotCachePortV1({ execute: async () => result })
    assert.deepEqual(await port.execute(request), { status: 'unavailable' })
  }
})

test('memory hot cache port proves exact bounded usage and freezes the result', async () => {
  const usage = {
    schemaVersion: 1,
    recordCount: 1,
    generationCount: 1,
    recordEntryBytes: 64,
    expiryIndexBytes: 80,
    lruIndexBytes: 80,
    dynamicMetadataBytes: 229,
    staticBytes: 357,
    totalLogicalBytes: 810
  }
  const port = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'usage', value: usage })
  })
  const result = await port.execute({ schemaVersion: 1, operation: 'usage.get' })
  assert.deepEqual(result, { status: 'usage', value: usage })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(result.status === 'usage' && Object.isFrozen(result.value), true)

  for (const badUsage of [
    { ...usage, recordCount: 2_049 },
    { ...usage, generationCount: 4_097 },
    { ...usage, recordCount: -0 },
    { ...usage, totalLogicalBytes: 14 },
    { ...usage, recordEntryBytes: 16 * 1_024 * 1_024 + 1 },
    { ...usage, expiryIndexBytes: 81, totalLogicalBytes: 811 },
    { ...usage, lruIndexBytes: 81, totalLogicalBytes: 811 },
    { ...usage, dynamicMetadataBytes: 230, totalLogicalBytes: 811 },
    { ...usage, staticBytes: 358, totalLogicalBytes: 811 },
    { ...usage, recordEntryBytes: 63, totalLogicalBytes: 809 },
    {
      ...usage,
      recordEntryBytes: 64 + MEMORY_RESOURCE_LIMITS.recordWireBytes + 1,
      totalLogicalBytes: 810 + MEMORY_RESOURCE_LIMITS.recordWireBytes + 1
    }
  ]) {
    const invalid = createMemoryHotCachePortV1({
      execute: async () => ({ status: 'usage', value: badUsage })
    })
    assert.deepEqual(await invalid.execute({ schemaVersion: 1, operation: 'usage.get' }), {
      status: 'unavailable'
    })
  }
})

test('memory hot cache port permits namespace capacity skip and no other namespace skip', async () => {
  const record = memoryRecordFixture()
  const request = {
    schemaVersion: 1,
    operation: 'namespace.invalidate',
    namespaceRef: record.namespaceRef,
    deletedGeneration: 1,
    nextGeneration: 2
  } as const
  const capacity = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'skipped', reason: 'capacity' })
  })
  assert.deepEqual(await capacity.execute(request), { status: 'skipped', reason: 'capacity' })

  const stale = createMemoryHotCachePortV1({
    execute: async () => ({ status: 'skipped', reason: 'stale' })
  })
  assert.deepEqual(await stale.execute(request), { status: 'unavailable' })
})

test('memory hot cache port returns fixed aborted before adapter execution', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const port = createMemoryHotCachePortV1({
    execute: async () => {
      calls += 1
      return { status: 'unavailable' }
    }
  })

  assert.deepEqual(await port.execute({ schemaVersion: 1, operation: 'usage.get' }, controller.signal), {
    status: 'aborted'
  })
  assert.equal(calls, 0)
})

test('memory hot cache port preserves an explicit completion observed before a late abort', async () => {
  const controller = new AbortController()
  const port = createMemoryHotCachePortV1({
    execute: async () => {
      controller.abort()
      return { status: 'stored' }
    }
  })
  assert.deepEqual(await port.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: memoryRecordFixture()
  }, controller.signal), { status: 'stored' })
})

test('RedisMemoryHotCache freezes five keys and the identity-stable record-field vector', () => {
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  assert.equal(
    MEMORY_HOT_CACHE_RECORD_FIELD_HASH_DOMAIN,
    'groupmate.memory.hot.record-field.v1'
  )
  assert.equal(field, '230b820b3bad23b68952fcea0003a3c9916ef9366f04bd5de0ac85aa03fdaf84')
  assert.equal(memoryHotCacheRecordFieldV1({ ...recordHead(record), revision: 99 }), field)
  assert.equal(memoryHotCacheRecordFieldV1({
    ...recordHead(record),
    contentHash: 'f'.repeat(64)
  }), field)
  assert.equal(memoryHotCacheHeadFieldV1(field), `h:${field}`)
  assert.equal(memoryHotCacheHeadValueV1(1, field), `0000000000000001|${field}`)
  assert.deepEqual(MEMORY_HOT_CACHE_KEYS, [
    'GROUPMATE:MEMORY_HOT:v1:records',
    'GROUPMATE:MEMORY_HOT:v1:expires',
    'GROUPMATE:MEMORY_HOT:v1:lru',
    'GROUPMATE:MEMORY_HOT:v1:metadata',
    'GROUPMATE:MEMORY_HOT:v1:script-version'
  ])
  assert.equal(MEMORY_HOT_CACHE_LUA_SCRIPT.split('\n', 1)[0], MEMORY_HOT_CACHE_LUA_MARKER)
})

test('RedisMemoryHotCache stores only domain-hashed identity in keys, fields, and indexes', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()

  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record }), {
    status: 'stored'
  })
  const snapshot = redis.memoryHotSnapshotForTest()
  assert.deepEqual(snapshot.topLevelKeys, MEMORY_HOT_CACHE_KEYS)
  const visibleNames = JSON.stringify({
    keys: snapshot.topLevelKeys,
    recordFields: snapshot.records.map(([field]) => field),
    expiryMembers: snapshot.expires.map(([field]) => field),
    lruMembers: snapshot.lru.map(([field]) => field),
    metadataFields: snapshot.metadata.map(([field]) => field)
  })
  for (const forbidden of [
    record.memoryId,
    FIXTURE_IDS.accountId,
    FIXTURE_IDS.subjectUserId,
    FIXTURE_IDS.groupId,
    record.sources[0]?.actor.nickname ?? '',
    record.sources[0]?.actor.groupCard ?? '',
    record.text
  ]) assert.equal(visibleNames.includes(forbidden), false)
  assert.equal(redis.evalCalls.every(call => call.marker === MEMORY_HOT_CACHE_LUA_MARKER), true)
})

test('RedisMemoryHotCache uses Redis TIME for fixed expiry and two-stage confirmed LRU', async () => {
  let nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))

  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record }), {
    status: 'stored'
  })
  const expiresAt = nowMs + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs
  assert.equal(redis.memoryHotExpiryForTest(field), expiresAt)
  assert.equal(redis.memoryHotLruForTest(field), nowMs)

  nowMs += 1_000
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  }), { status: 'hit', record })
  assert.equal(redis.memoryHotExpiryForTest(field), expiresAt)
  assert.equal(redis.memoryHotLruForTest(field), nowMs)
  assert.deepEqual(redis.evalCalls.slice(-2).map(call => call.operation), ['peek', 'confirm_hit'])
})

test('RedisMemoryHotCache duplicate put updates LRU without renewing expiry', async () => {
  let nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))

  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record }), {
    status: 'stored'
  })
  const expiresAt = redis.memoryHotExpiryForTest(field)
  nowMs += 5_000
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record }), {
    status: 'unchanged'
  })
  assert.equal(redis.memoryHotExpiryForTest(field), expiresAt)
  assert.equal(redis.memoryHotLruForTest(field), nowMs)
})

test('RedisMemoryHotCache replaces newer heads and rejects stale or conflicting puts', async () => {
  let nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const first = memoryRecordFixture()
  const newer = memoryRecordFixture({ revision: 2 })
  const sameRevisionConflict = memoryRecordFixture({ text: '不同内容' })

  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: first }), {
    status: 'stored'
  })
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: sameRevisionConflict
  }), { status: 'unavailable' })
  nowMs += 10
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: newer }), {
    status: 'stored'
  })
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: first }), {
    status: 'skipped', reason: 'stale'
  })
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(newer)
  }), { status: 'hit', record: newer })

  const nextGeneration = memoryRecordFixture({ namespaceGeneration: 2 })
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: nextGeneration
  }), { status: 'stored' })
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: newer }), {
    status: 'skipped', reason: 'stale'
  })
})

test('RedisMemoryHotCache enforces expiry and canonical validUntil at exact boundaries', async () => {
  let nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const expiry = nowMs + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })

  nowMs = expiry - 1
  assert.equal((await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  })).status, 'hit')
  nowMs = expiry
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  }), { status: 'miss', reason: 'expired' })

  const validUntilMs = nowMs + 10
  const bounded = memoryRecordFixture({
    retention: deepFreezeFixture({
      validUntil: new Date(validUntilMs).toISOString(),
      purgeAt: new Date(validUntilMs + 1).toISOString()
    })
  })
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: bounded }), {
    status: 'stored'
  })
  nowMs = validUntilMs
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(bounded)
  }), { status: 'miss', reason: 'expired' })
})

test('RedisMemoryHotCache corrupt cleanup uses exact wire CAS and preserves a concurrent winner', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const first = memoryRecordFixture()
  const winner = memoryRecordFixture({ revision: 2 })
  const field = memoryHotCacheRecordFieldV1(recordHead(first))
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record: first })
  redis.corruptMemoryHotRecordForTest(field, '{')
  redis.afterNextMemoryHotEval(operation => {
    if (operation !== 'peek') return false
    redis.replaceMemoryHotRecordForTest(field, encodeMemoryRecordV1(winner), winner.revision)
    return true
  })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(first)
  }), { status: 'miss', reason: 'corrupt' })
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(winner)
  }), { status: 'hit', record: winner })
})

test('RedisMemoryHotCache never confirms a concurrently installed unaccounted oversized wire', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  const oversized = 'x'.repeat(MEMORY_RESOURCE_LIMITS.recordWireBytes + 1)
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  redis.afterNextMemoryHotEval(operation => {
    if (operation !== 'peek') return false
    redis.replaceMemoryHotRecordWithoutAccountingForTest(field, oversized)
    return true
  })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  }), { status: 'unavailable' })
  assert.equal(redis.memoryHotSnapshotForTest().records[0]?.[1].length, oversized.length)
})

test('RedisMemoryHotCache rejects an unaccounted oversized wire before peek body transport', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  const oversized = 'x'.repeat(MEMORY_RESOURCE_LIMITS.recordWireBytes + 1)
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  redis.replaceMemoryHotRecordWithoutAccountingForTest(field, oversized)

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  }), { status: 'unavailable' })
  assert.equal(redis.memoryHotSnapshotForTest().records[0]?.[1].length, oversized.length)
})

test('RedisMemoryHotCache fails closed on an oversized expired victim during put cleanup', async () => {
  let nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  const oversized = 'x'.repeat(MEMORY_RESOURCE_LIMITS.recordWireBytes + 1)
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  redis.replaceMemoryHotRecordWithoutAccountingForTest(field, oversized)
  nowMs += MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: memoryRecordFixture({ memoryId: 'memory:cleanup-candidate' })
  }), { status: 'unavailable' })
  assert.equal(redis.memoryHotSnapshotForTest().records[0]?.[1].length, oversized.length)
})

test('RedisMemoryHotCache rejects replacement and removal projected counter underflow without writes', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const first = largeMemoryRecordFixture()
  const newer = memoryRecordFixture({ revision: 2 })

  const replacementRedis = new FakeRedis(() => nowMs)
  const replacementCache = new RedisMemoryHotCache({ client: replacementRedis })
  const field = memoryHotCacheRecordFieldV1(recordHead(first))
  await replacementCache.execute({ schemaVersion: 1, operation: 'record.put', record: first })
  replacementRedis.corruptMemoryHotMetadataForTest(
    'record-entry-bytes',
    '0000000000000064'
  )
  assert.deepEqual(await replacementCache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: newer
  }), { status: 'unavailable' })
  assert.equal(
    replacementRedis.memoryHotSnapshotForTest().records[0]?.[1],
    encodeMemoryRecordV1(first)
  )

  const removalRedis = new FakeRedis(() => nowMs)
  const removalCache = new RedisMemoryHotCache({ client: removalRedis })
  await removalCache.execute({ schemaVersion: 1, operation: 'record.put', record: first })
  removalRedis.corruptMemoryHotMetadataForTest('record-entry-bytes', '0000000000000064')
  assert.deepEqual(await removalCache.execute({
    schemaVersion: 1,
    operation: 'record.invalidate',
    namespaceRef: first.namespaceRef,
    namespaceGeneration: first.namespaceGeneration,
    memoryId: first.memoryId,
    deletedRevision: first.revision
  }), { status: 'unavailable' })
  assert.equal(removalRedis.memoryHotSnapshotForTest().records.length, 1)
})

test('RedisMemoryHotCache replacement may evict within byte pressure before storing', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const replacement = memoryRecordFixture({ revision: 2 })
  const targetField = memoryHotCacheRecordFieldV1(recordHead(replacement))
  const recordCount = 1_024
  const wireBudget = MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes -
    MEMORY_HOT_CACHE_STATIC_BYTES - 82 - recordCount * 371
  const remainingBase = Math.floor((wireBudget - 1) / (recordCount - 1))
  const remainingExtra = (wireBudget - 1) % (recordCount - 1)
  const wireBytes = Array.from(
    { length: recordCount },
    (_, index) => index === 0 ? 1 : remainingBase + (index <= remainingExtra ? 1 : 0)
  )
  assert.equal(wireBytes.every(bytes => bytes <= MEMORY_RESOURCE_LIMITS.recordWireBytes), true)
  const fields = Array.from(
    { length: recordCount },
    (_, index) => index === 0 ? targetField : index.toString(16).padStart(64, '0')
  )
  const redis = new FakeRedis(() => nowMs)
  redis.seedMemoryHotEntriesForTest({
    count: recordCount,
    wireBytes,
    expiresAtMs: nowMs + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs,
    lruMs: 1,
    namespaceRef: replacement.namespaceRef,
    fields
  })
  const cache = new RedisMemoryHotCache({ client: redis })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: replacement
  }), { status: 'stored' })
  assert.equal(redis.memoryHotSnapshotForTest().records.length, recordCount - 1)
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(replacement)
  }), { status: 'hit', record: replacement })
})

test('RedisMemoryHotCache reports hand-calculated multibyte logical usage', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture({ text: '多字节🙂' })
  const wire = encodeMemoryRecordV1(record)
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  const generationField = memoryHotCacheNamespaceFieldV1(record.namespaceRef)
  const headField = memoryHotCacheHeadFieldV1(field)
  const headValue = memoryHotCacheHeadValueV1(record.revision, field)
  const recordEntryBytes = memoryHotCacheRecordEntryBytesV1(field, wire)
  const expiryIndexBytes = memoryHotCacheIndexEntryBytesV1(field)
  const lruIndexBytes = memoryHotCacheIndexEntryBytesV1(field)
  const dynamicMetadataBytes = memoryHotCacheMetadataEntryBytesV1(
    generationField,
    '0000000000000001'
  ) + memoryHotCacheMetadataEntryBytesV1(headField, headValue)
  const totalLogicalBytes = MEMORY_HOT_CACHE_STATIC_BYTES + recordEntryBytes +
    expiryIndexBytes + lruIndexBytes + dynamicMetadataBytes

  assert.equal(MEMORY_HOT_CACHE_STATIC_BYTES, 357)
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'usage.get' }), {
    status: 'usage',
    value: {
      schemaVersion: 1,
      recordCount: 1,
      generationCount: 1,
      recordEntryBytes,
      expiryIndexBytes,
      lruIndexBytes,
      dynamicMetadataBytes,
      staticBytes: 357,
      totalLogicalBytes
    }
  })
  const counters = redis.memoryHotSnapshotForTest().metadata
    .filter(([field]) => !field.startsWith('g:') && !field.startsWith('h:'))
  assert.equal(counters.length, 6)
  assert.equal(counters.every(([, value]) => /^\d{16}$/.test(value)), true)
})

test('RedisMemoryHotCache enforces 2048/2049 with deterministic lexical LRU eviction', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  redis.seedMemoryHotEntriesForTest({
    count: 2_048,
    wireBytes: 1,
    expiresAtMs: nowMs + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs,
    lruMs: 7
  })
  const before = redis.memoryHotSnapshotForTest().records.map(([field]) => field)
  const lexicalVictim = before[0]
  const cache = new RedisMemoryHotCache({ client: redis })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: memoryRecordFixture()
  }), { status: 'stored' })
  const after = redis.memoryHotSnapshotForTest()
  assert.equal(after.records.length, 2_048)
  assert.equal(after.records.some(([field]) => field === lexicalVictim), false)
})

test('RedisMemoryHotCache proves the 16 MiB exact and plus-one boundaries', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const recordCount = 1_024
  const wireBudget = MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes -
    MEMORY_HOT_CACHE_STATIC_BYTES - 82 - recordCount * 371
  const baseWireBytes = Math.floor(wireBudget / recordCount)
  const wireRemainder = wireBudget % recordCount
  const wireBytes = Array.from(
    { length: recordCount },
    (_, index) => baseWireBytes + (index < wireRemainder ? 1 : 0)
  )
  assert.equal(wireBytes.every(bytes => bytes <= MEMORY_RESOURCE_LIMITS.recordWireBytes), true)
  const exactRedis = new FakeRedis(() => nowMs)
  exactRedis.seedMemoryHotEntriesForTest({
    count: recordCount,
    wireBytes,
    expiresAtMs: nowMs + 1_000,
    lruMs: nowMs
  })
  const exactCache = new RedisMemoryHotCache({ client: exactRedis })
  const exactUsage = await exactCache.execute({ schemaVersion: 1, operation: 'usage.get' })
  assert.equal(
    exactUsage.status === 'usage' && exactUsage.value.totalLogicalBytes,
    MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
  )

  const overRedis = new FakeRedis(() => nowMs)
  const overWireBytes = [...wireBytes]
  overWireBytes[recordCount - 1] += 1
  overRedis.seedMemoryHotEntriesForTest({
    count: recordCount,
    wireBytes: overWireBytes,
    expiresAtMs: nowMs + 1_000,
    lruMs: nowMs,
    allowOverLimit: true
  })
  const overCache = new RedisMemoryHotCache({ client: overRedis })
  assert.deepEqual(await overCache.execute({ schemaVersion: 1, operation: 'usage.get' }), {
    status: 'unavailable'
  })
})

test('RedisMemoryHotCache removes only 32 of 33 expired victims in one put', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  redis.seedMemoryHotEntriesForTest({
    count: 33,
    wireBytes: 1,
    expiresAtMs: nowMs,
    lruMs: 1
  })
  const cache = new RedisMemoryHotCache({ client: redis })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: memoryRecordFixture()
  }), { status: 'stored' })
  const snapshot = redis.memoryHotSnapshotForTest()
  assert.equal(snapshot.records.length, 2)
  assert.equal(snapshot.expires.filter(([, score]) => score <= nowMs).length, 1)
})

test('RedisMemoryHotCache shares one 32-victim budget across expiry and LRU and keeps evictions on skip', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const count = 2_048
  const baseBytes = MEMORY_HOT_CACHE_STATIC_BYTES + 82 + count * 371
  const wireBytes = Array.from({ length: count }, () => 1)
  wireBytes[count - 1] = MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes -
    baseBytes - (count - 1)
  const expiresAtMs = Array.from(
    { length: count },
    (_, index) => index === 0 ? nowMs : nowMs + 100_000
  )
  const redis = new FakeRedis(() => nowMs)
  redis.seedMemoryHotEntriesForTest({
    count,
    wireBytes,
    expiresAtMs,
    lruMs: 1
  })
  const before = redis.memoryHotSnapshotForTest().records.length
  const cache = new RedisMemoryHotCache({ client: redis })
  const candidate = largeMemoryRecordFixture()
  assert.equal(Buffer.byteLength(encodeMemoryRecordV1(candidate), 'utf8') > 11_872, true)

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: candidate
  }), { status: 'skipped', reason: 'capacity' })
  assert.equal(before - redis.memoryHotSnapshotForTest().records.length, 32)
})

test('RedisMemoryHotCache record invalidation is exact, revision-bounded, and idempotent', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const record = memoryRecordFixture({ revision: 2 })
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  const request = {
    schemaVersion: 1,
    operation: 'record.invalidate',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId
  } as const

  assert.deepEqual(await cache.execute({ ...request, deletedRevision: 1 }), {
    status: 'unchanged'
  })
  assert.deepEqual(await cache.execute({ ...request, deletedRevision: 2 }), {
    status: 'invalidated'
  })
  assert.deepEqual(await cache.execute({ ...request, deletedRevision: 2 }), {
    status: 'unchanged'
  })
})

test('RedisMemoryHotCache namespace invalidation advances a monotonic fence without scanning bodies', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  const oldRecord = memoryRecordFixture()
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record: oldRecord })
  const oldField = memoryHotCacheRecordFieldV1(recordHead(oldRecord))
  const invalidate = {
    schemaVersion: 1,
    operation: 'namespace.invalidate',
    namespaceRef: oldRecord.namespaceRef,
    deletedGeneration: 1,
    nextGeneration: 2
  } as const

  assert.deepEqual(await cache.execute(invalidate), { status: 'invalidated' })
  assert.equal(redis.memoryHotSnapshotForTest().records.some(([field]) => field === oldField), true)
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(oldRecord)
  }), { status: 'miss', reason: 'stale' })
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record: oldRecord }), {
    status: 'skipped', reason: 'stale'
  })
  assert.deepEqual(await cache.execute(invalidate), { status: 'unchanged' })
})

test('RedisMemoryHotCache maps the 4097th namespace fence to a capacity skip', async () => {
  const redis = new FakeRedis(() => Date.parse(FIXTURE_TIMES.confirmedAt))
  const cache = new RedisMemoryHotCache({ client: redis })
  let result
  for (let index = 1; index <= MEMORY_RESOURCE_LIMITS.deploymentNamespaces; index += 1) {
    result = await cache.execute({
      schemaVersion: 1,
      operation: 'namespace.invalidate',
      namespaceRef: index.toString(16).padStart(64, '0'),
      deletedGeneration: 1,
      nextGeneration: 2
    })
  }
  assert.deepEqual(result, { status: 'invalidated' })
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'namespace.invalidate',
    namespaceRef: (MEMORY_RESOURCE_LIMITS.deploymentNamespaces + 1)
      .toString(16).padStart(64, '0'),
    deletedGeneration: 1,
    nextGeneration: 2
  }), { status: 'skipped', reason: 'capacity' })
})

test('RedisMemoryHotCache rejects zero and unsafe dynamic fence or head revisions', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const record = memoryRecordFixture()
  const field = memoryHotCacheRecordFieldV1(recordHead(record))
  const generationField = memoryHotCacheNamespaceFieldV1(record.namespaceRef)
  const headField = memoryHotCacheHeadFieldV1(field)
  for (const invalid of ['0000000000000000', '9999999999999999']) {
    const fenceRedis = new FakeRedis(() => nowMs)
    const fenceCache = new RedisMemoryHotCache({ client: fenceRedis })
    await fenceCache.execute({ schemaVersion: 1, operation: 'record.put', record })
    fenceRedis.corruptMemoryHotMetadataForTest(generationField, invalid)
    assert.deepEqual(await fenceCache.execute({
      schemaVersion: 1,
      operation: 'record.get',
      head: recordHead(record)
    }), { status: 'unavailable' })

    const headRedis = new FakeRedis(() => nowMs)
    const headCache = new RedisMemoryHotCache({ client: headRedis })
    await headCache.execute({ schemaVersion: 1, operation: 'record.put', record })
    headRedis.corruptMemoryHotMetadataForTest(headField, `${invalid}|${field}`)
    assert.deepEqual(await headCache.execute({
      schemaVersion: 1,
      operation: 'record.get',
      head: recordHead(record)
    }), { status: 'unavailable' })
  }
})

test('RedisMemoryHotCache rejects malformed, oversize, wrong-tuple, and wrong-hash bodies', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  for (const corruption of ['oversize', 'tuple', 'hash'] as const) {
    const redis = new FakeRedis(() => nowMs)
    const cache = new RedisMemoryHotCache({ client: redis })
    const record = memoryRecordFixture()
    const field = memoryHotCacheRecordFieldV1(recordHead(record))
    await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
    if (corruption === 'oversize') {
      redis.corruptMemoryHotRecordForTest(
        field,
        'x'.repeat(MEMORY_RESOURCE_LIMITS.recordWireBytes + 1)
      )
    } else if (corruption === 'tuple') {
      redis.corruptMemoryHotRecordForTest(
        field,
        encodeMemoryRecordV1(memoryRecordFixture({ memoryId: 'memory:other' }))
      )
    }
    const head = corruption === 'hash'
      ? { ...recordHead(record), contentHash: 'f'.repeat(64) }
      : recordHead(record)
    const result = await cache.execute({ schemaVersion: 1, operation: 'record.get', head })
    assert.equal(result.status, corruption === 'oversize' ? 'unavailable' : 'miss')
    assert.equal(Object.hasOwn(result, 'record'), false)
    if (corruption !== 'oversize') {
      assert.equal(redis.memoryHotSnapshotForTest().records.length, 0)
    }
  }
})

test('RedisMemoryHotCache maps eval, metadata, and version failures to fixed unavailable', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const record = memoryRecordFixture()
  const redis = new FakeRedis(() => nowMs)
  const cache = new RedisMemoryHotCache({ client: redis })
  redis.failNextMemoryHotEval()
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'record.put', record }), {
    status: 'unavailable'
  })
  await cache.execute({ schemaVersion: 1, operation: 'record.put', record })
  redis.corruptMemoryHotMetadataForTest('record-count', '1')
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'usage.get' }), {
    status: 'unavailable'
  })
  redis.corruptMemoryHotMetadataForTest('record-count', '0000000000000001')
  redis.corruptMemoryHotMetadataForTest('expiry-index-bytes', '0000000000000081')
  assert.deepEqual(await cache.execute({ schemaVersion: 1, operation: 'usage.get' }), {
    status: 'unavailable'
  })
  redis.corruptMemoryHotMetadataForTest('expiry-index-bytes', '0000000000000080')
  redis.setMemoryHotScriptVersionForTest('drift')
  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.get',
    head: recordHead(record)
  }), { status: 'unavailable' })
})

test('RedisMemoryHotCache ignores 96000 unrelated keys without scan or generic expiry traversal', async () => {
  const nowMs = Date.parse(FIXTURE_TIMES.confirmedAt)
  const redis = new FakeRedis(() => nowMs)
  redis.seedUnrelatedKeysForTest(96_000)
  const visits = redis.genericExpirySweepVisitsForTest()
  const cache = new RedisMemoryHotCache({ client: redis })

  assert.deepEqual(await cache.execute({
    schemaVersion: 1,
    operation: 'record.put',
    record: memoryRecordFixture()
  }), { status: 'stored' })
  assert.equal(redis.scanCalls.length, 0)
  assert.equal(redis.genericExpirySweepVisitsForTest(), visits)
})

test('memory hot Lua and production remain scan-free, timer-free, and unwired', async () => {
  assert.doesNotMatch(
    MEMORY_HOT_CACHE_LUA_SCRIPT,
    /redis\.call\(['"](?:SCAN|HSCAN|KEYS|WATCH|MULTI|EXPIRE|PEXPIRE|PEXPIREAT)['"]/
  )
  assert.match(MEMORY_HOT_CACHE_LUA_SCRIPT, /redis\.call\('TIME'\)/)
  assert.equal(
    [...MEMORY_HOT_CACHE_LUA_SCRIPT.matchAll(/redis\.call\('HGET', recordsKey/g)].length,
    1
  )
  assert.equal(
    MEMORY_HOT_CACHE_LUA_SCRIPT.indexOf("redis.call('HSTRLEN', recordsKey, field)") <
      MEMORY_HOT_CACHE_LUA_SCRIPT.indexOf("redis.call('HGET', recordsKey, field)"),
    true
  )
  assert.match(
    MEMORY_HOT_CACHE_LUA_SCRIPT,
    /local function removeRecord[\s\S]*?string\.len\(wire\) > RECORD_WIRE_LIMIT/
  )
  const productionFiles = [
    'src/runtime/production-yunzai-agent.ts',
    'src/runtime/agent-service-bridge.ts'
  ]
  for (const file of productionFiles) {
    const source = await readFile(path.join(PROJECT_ROOT, file), 'utf8')
    assert.doesNotMatch(source, /redis-memory-hot-cache|memory-hot-cache|MEMORY_HOT/)
  }
  assert.doesNotMatch(MEMORY_HOT_CACHE_LUA_SCRIPT, /setInterval|setTimeout/)
  assert.doesNotMatch(
    await readFile(path.join(PROJECT_ROOT, 'src/agent/memory/memory-hot-cache.ts'), 'utf8'),
    /proposal\.approve|record\.create|record\.correct|record\.forget/
  )
})
