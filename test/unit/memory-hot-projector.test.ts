import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  createMemoryHeadSourcePortV1,
  type MemoryHeadSourceRequestV1
} from '../../src/agent/memory/memory-head-reader.js'
import { createMemoryHotCachePortV1 } from '../../src/agent/memory/memory-hot-cache.js'
import {
  createMemoryHotProjectorV1,
  MEMORY_HOT_PROJECTOR_RETRY_BACKOFF_MS_V1,
  MEMORY_HOT_PROJECTOR_RETRY_REASON_V1
} from '../../src/agent/memory/memory-hot-projector.js'
import {
  createMemoryOutboxPortV1,
  type MemoryOutboxRequestV1,
  type MemoryOutboxResultV1
} from '../../src/agent/memory/memory-outbox.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryOutboxEventFixture,
  memoryRecordFixture
} from '../helpers/memory-fixture.js'
import { findProjectRoot } from '../helpers/project-root.js'

const NOW = '2026-07-19T00:05:00.000Z'
const LEASE_TOKEN = `memory-lease:v1:${'a'.repeat(64)}`
const OWNER_ID = 'memory-projector:test'
const PROJECT_ROOT = findProjectRoot(import.meta.url)

function head (record = memoryRecordFixture()) {
  return deepFreezeFixture({
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: record.revision,
    contentHash: record.contentHash
  })
}

function event (overrides: Readonly<Record<string, unknown>> = {}) {
  return memoryOutboxEventFixture(overrides)
}

interface OutboxHarnessOptions {
  readonly ackResult?: MemoryOutboxResultV1
  readonly retryResult?: MemoryOutboxResultV1
  readonly claimResult?: MemoryOutboxResultV1
}

function outboxHarness (
  events: readonly ReturnType<typeof event>[],
  options: OutboxHarnessOptions = {}
) {
  const requests: MemoryOutboxRequestV1[] = []
  const outbox = createMemoryOutboxPortV1({
    now: () => NOW,
    execute: async request => {
      requests.push(request)
      if (request.operation === 'claim') {
        if (options.claimResult !== undefined) return options.claimResult
        const claimed = events.slice(0, request.limit)
        if (claimed.length === 0) return { status: 'empty' }
        return {
          status: 'claimed',
          ownerId: request.ownerId,
          leaseToken: LEASE_TOKEN,
          leasedUntil: '2026-07-19T00:06:00.000Z',
          events: claimed
        }
      }
      if (request.operation === 'ack') return options.ackResult ?? { status: 'acked' }
      if (request.operation === 'retry') return options.retryResult ?? { status: 'retried' }
      return {
        status: 'usage',
        value: {
          schemaVersion: 1,
          pendingRecords: events.length,
          leasedRecords: 0,
          logicalBytes: 0
        }
      }
    }
  })
  return { outbox, requests }
}

function sourcePort (execute?: (
  request: MemoryHeadSourceRequestV1
) => Promise<unknown> | unknown) {
  const record = memoryRecordFixture()
  return createMemoryHeadSourcePortV1({
    execute: async request => {
      if (execute !== undefined) return await execute(request)
      if (request.operation === 'namespace.get') {
        return { status: 'found', namespaceGeneration: record.namespaceGeneration }
      }
      if (request.operation === 'head.get') return { status: 'found', head: head(record) }
      return { status: 'found', record }
    }
  })
}

function cachePort (execute?: (request: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown) {
  return createMemoryHotCachePortV1({
    execute: async request => {
      if (execute !== undefined) return await execute(request as unknown as Readonly<Record<string, unknown>>)
      if (request.operation === 'record.put') return { status: 'stored' }
      if (request.operation === 'record.get') return { status: 'miss', reason: 'not_found' }
      return { status: 'invalidated' }
    }
  })
}

function usageAtGenerationCount (generationCount: number) {
  const staticBytes = 357
  const dynamicMetadataBytes = generationCount * 82
  return {
    status: 'usage',
    value: {
      schemaVersion: 1,
      recordCount: 0,
      generationCount,
      recordEntryBytes: 0,
      expiryIndexBytes: 0,
      lruIndexBytes: 0,
      dynamicMetadataBytes,
      staticBytes,
      totalLogicalBytes: dynamicMetadataBytes + staticBytes
    }
  }
}

function createProjector (
  outbox: ReturnType<typeof outboxHarness>['outbox'],
  source = sourcePort(),
  cache = cachePort()
) {
  return createMemoryHotProjectorV1({
    ownerId: OWNER_ID,
    now: () => NOW,
    outbox,
    source,
    cache
  })
}

function operationRequests (
  requests: readonly MemoryOutboxRequestV1[],
  operation: MemoryOutboxRequestV1['operation']
) {
  return requests.filter(request => request.operation === operation)
}

test('projector returns empty without a cache side effect', async () => {
  const harness = outboxHarness([])
  let cacheCalls = 0
  const result = await createProjector(
    harness.outbox,
    sourcePort(),
    cachePort(() => {
      cacheCalls += 1
      return { status: 'unavailable' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'empty' })
  assert.equal(cacheCalls, 0)
  assert.deepEqual(harness.requests, [{
    schemaVersion: 1,
    operation: 'claim',
    ownerId: OWNER_ID,
    limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords
  }])
})

test('proposal projection has no Redis side effect and uses the exact ack identity', async () => {
  const proposal = event({
    aggregate: 'proposal',
    aggregateId: 'proposal:projection',
    eventKind: 'proposal_changed'
  })
  const harness = outboxHarness([proposal])
  let cacheCalls = 0
  const result = await createProjector(
    harness.outbox,
    sourcePort(),
    cachePort(() => {
      cacheCalls += 1
      return { status: 'unavailable' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.equal(cacheCalls, 0)
  assert.deepEqual(operationRequests(harness.requests, 'ack'), [{
    schemaVersion: 1,
    operation: 'ack',
    ownerId: OWNER_ID,
    leaseToken: LEASE_TOKEN,
    eventId: proposal.eventId,
    sequence: proposal.sequence
  }])
})

test('upsert projects an exact stable record and acks every harmless put outcome', async t => {
  for (const putResult of [
    { status: 'stored' },
    { status: 'unchanged' },
    { status: 'skipped', reason: 'capacity' },
    { status: 'skipped', reason: 'expired' }
  ] as const) {
    await t.test(JSON.stringify(putResult), async () => {
      const upsert = event()
      const harness = outboxHarness([upsert])
      const sourceRequests: MemoryHeadSourceRequestV1[] = []
      const cacheRequests: Readonly<Record<string, unknown>>[] = []
      const result = await createProjector(
        harness.outbox,
        sourcePort(request => {
          sourceRequests.push(request)
          if (request.operation === 'head.get') return { status: 'found', head: head() }
          if (request.operation === 'record.getExact') {
            return { status: 'found', record: memoryRecordFixture() }
          }
          return { status: 'found', namespaceGeneration: 1 }
        }),
        cachePort(request => {
          cacheRequests.push(request)
          return request.operation === 'record.get'
            ? { status: 'miss', reason: 'not_found' }
            : putResult
        })
      ).projectBatch()
      assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
      assert.deepEqual(sourceRequests.map(request => request.operation), [
        'head.get', 'record.getExact', 'head.get', 'head.get'
      ])
      assert.deepEqual(cacheRequests.map(request => request.operation), [
        'record.get', 'record.put'
      ])
    })
  }
})

test('a stale record event reconciles the current exact head instead of trusting the event tuple', async () => {
  const upsert = event()
  for (const current of [
    memoryRecordFixture({ revision: 2 }),
    memoryRecordFixture({ namespaceGeneration: 2 })
  ]) {
    const harness = outboxHarness([upsert])
    const cacheRequests: Readonly<Record<string, unknown>>[] = []
    const result = await createProjector(
      harness.outbox,
      sourcePort(async request => request.operation === 'head.get'
        ? { status: 'found', head: head(current) }
        : { status: 'found', record: current }),
      cachePort(request => {
        cacheRequests.push(request)
        return request.operation === 'record.get'
          ? { status: 'hit', record: current }
          : { status: 'stored' }
      })
    ).projectBatch()
    assert.equal(result.status, 'completed')
    assert.deepEqual(cacheRequests.map(request => request.operation), ['record.get'])
    assert.equal(operationRequests(harness.requests, 'ack').length, 1)
  }
})

test('record reconciliation restarts once when the head changes before put', async () => {
  const upsert = event()
  const harness = outboxHarness([upsert])
  let headCalls = 0
  const first = memoryRecordFixture()
  const second = memoryRecordFixture({ revision: 2 })
  const cacheRequests: Readonly<Record<string, unknown>>[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => {
      if (request.operation === 'record.getExact') {
        return { status: 'found', record: request.head.revision === 1 ? first : second }
      }
      headCalls += 1
      const current = headCalls === 1 ? first : second
      return { status: 'found', head: head(current) }
    }),
        cachePort(request => {
          cacheRequests.push(request)
          if (request.operation === 'record.get') {
            const requestedHead = request.head as ReturnType<typeof head>
            return requestedHead.revision === 1
              ? { status: 'miss', reason: 'not_found' }
              : { status: 'hit', record: second }
      }
      return { status: 'stored' }
    })
  ).projectBatch()

  assert.equal(result.status, 'completed')
  assert.deepEqual(cacheRequests.map(request => request.operation), [
    'record.get', 'record.get'
  ])
  assert.equal(operationRequests(harness.requests, 'ack').length, 1)
})

test('record reconciliation repairs a same-revision different-content race after put', async () => {
  const oldRecord = memoryRecordFixture()
  const recreated = memoryRecordFixture({ text: '同版本但属于新 incarnation 的正文' })
  const upsert = event()
  const harness = outboxHarness([upsert])
  const heads = [oldRecord, oldRecord, recreated, recreated, recreated, recreated]
  const puts: string[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => {
      if (request.operation === 'head.get') {
        const current = heads.shift()
        assert.ok(current)
        return { status: 'found', head: head(current) }
      }
      assert.equal(request.operation, 'record.getExact')
      return {
        status: 'found',
        record: request.head.contentHash === oldRecord.contentHash ? oldRecord : recreated
      }
    }),
    cachePort(request => {
      if (request.operation === 'record.get') return { status: 'miss', reason: 'mismatch' }
      if (request.operation === 'record.put') {
        const record = request.record as ReturnType<typeof memoryRecordFixture>
        puts.push(record.contentHash)
        return { status: 'stored' }
      }
      return { status: 'unavailable' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.deepEqual(puts, [oldRecord.contentHash, recreated.contentHash])
})

test('exact-load uncertainty with an unchanged post-head is retained instead of acknowledged', async t => {
  for (const exactResult of [
    { status: 'stale' },
    { status: 'not_found' },
    { status: 'expired' }
  ] as const) {
    await t.test(exactResult.status, async () => {
      const harness = outboxHarness([event()])
      let headCalls = 0
      const result = await createProjector(
        harness.outbox,
        sourcePort(request => {
          if (request.operation === 'head.get') {
            headCalls += 1
            return { status: 'found', head: head() }
          }
          assert.equal(request.operation, 'record.getExact')
          return exactResult
        }),
        cachePort(request => request.operation === 'record.get'
          ? { status: 'miss', reason: 'not_found' }
          : { status: 'stored' })
      ).projectBatch()

      assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
      assert.equal(headCalls, 2)
      assert.equal(operationRequests(harness.requests, 'ack').length, 0)
      assert.equal(operationRequests(harness.requests, 'retry').length, 1)
    })
  }
})

test('record put is fenced by both a pre-put and post-put canonical head read', async () => {
  const harness = outboxHarness([event()])
  const operations: string[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => {
      operations.push(request.operation)
      if (request.operation === 'head.get') return { status: 'found', head: head() }
      return { status: 'found', record: memoryRecordFixture() }
    }),
    cachePort(request => {
      operations.push(String(request.operation))
      return request.operation === 'record.get'
        ? { status: 'miss', reason: 'not_found' }
        : { status: 'stored' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.deepEqual(operations, [
    'head.get',
    'record.get',
    'record.getExact',
    'head.get',
    'record.put',
    'head.get'
  ])
})

test('stale cache evidence is event-bounded invalidated before refilling a lower recreated revision', async () => {
  const recreated = memoryRecordFixture({ revision: 1, text: '30 天后重建的新事实' })
  const delayed = event({ revision: 5 })
  const harness = outboxHarness([delayed])
  let getCalls = 0
  const cacheRequests: Readonly<Record<string, unknown>>[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => request.operation === 'head.get'
      ? { status: 'found', head: head(recreated) }
      : { status: 'found', record: recreated }),
    cachePort(request => {
      cacheRequests.push(request)
      if (request.operation === 'record.get') {
        getCalls += 1
        return getCalls === 1
          ? { status: 'miss', reason: 'stale' }
          : { status: 'miss', reason: 'not_found' }
      }
      if (request.operation === 'record.invalidate') return { status: 'invalidated' }
      return { status: 'stored' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  const invalidation = cacheRequests.find(request => request.operation === 'record.invalidate')
  assert.deepEqual(invalidation, {
    schemaVersion: 1,
    operation: 'record.invalidate',
    namespaceRef: delayed.namespaceRef,
    namespaceGeneration: delayed.namespaceGeneration,
    memoryId: delayed.aggregateId,
    deletedRevision: delayed.revision
  })
  assert.equal(cacheRequests.some(request => Object.values(request).includes(Number.MAX_SAFE_INTEGER)), false)
})

test('old revision 5 trigger repairs a recreated revision 1 only after bounded invalidation', async () => {
  const delayed = event({ revision: 5, eventKind: 'record_forgotten' })
  const recreated = memoryRecordFixture({ revision: 1, text: '旧墓碑过期后的新记忆' })
  const harness = outboxHarness([delayed])
  const operations: string[] = []
  let cacheGetCalls = 0
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => {
      operations.push(request.operation)
      return request.operation === 'head.get'
        ? { status: 'found', head: head(recreated) }
        : { status: 'found', record: recreated }
    }),
    cachePort(request => {
      operations.push(String(request.operation))
      if (request.operation === 'record.get') {
        cacheGetCalls += 1
        return cacheGetCalls === 1
          ? { status: 'miss', reason: 'stale' }
          : { status: 'miss', reason: 'not_found' }
      }
      if (request.operation === 'record.invalidate') return { status: 'invalidated' }
      return { status: 'stored' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.ok(operations.indexOf('record.invalidate') < operations.indexOf('record.put'))
  assert.equal(cacheGetCalls, 2)
})

test('a stale put is event-bounded invalidated before the stable canonical refill', async () => {
  const target = event({ revision: 5 })
  const current = memoryRecordFixture({ revision: 1, text: '当前较低版本 incarnation' })
  const harness = outboxHarness([target])
  const cacheOperations: string[] = []
  let putCalls = 0
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => request.operation === 'head.get'
      ? { status: 'found', head: head(current) }
      : { status: 'found', record: current }),
    cachePort(request => {
      cacheOperations.push(String(request.operation))
      if (request.operation === 'record.get') return { status: 'miss', reason: 'not_found' }
      if (request.operation === 'record.invalidate') return { status: 'invalidated' }
      putCalls += 1
      return putCalls === 1
        ? { status: 'skipped', reason: 'stale' }
        : { status: 'stored' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.deepEqual(cacheOperations, [
    'record.get', 'record.put', 'record.invalidate', 'record.get', 'record.put'
  ])
})

test('canonical or Redis uncertainty retains the exact lease retry without ack or sensitive diagnostics', async t => {
  for (const failure of ['canonical', 'redis'] as const) {
    await t.test(failure, async () => {
      const upsert = event()
      const harness = outboxHarness([upsert])
      const result = await createProjector(
        harness.outbox,
        failure === 'canonical'
          ? sourcePort(async () => ({ status: 'unavailable', category: 'busy', retryable: true }))
          : sourcePort(),
        failure === 'redis'
          ? cachePort(async () => ({ status: 'unavailable' }))
          : cachePort()
      ).projectBatch()
      assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
      assert.equal(operationRequests(harness.requests, 'ack').length, 0)
      const retry = operationRequests(harness.requests, 'retry')[0]
      assert.ok(retry?.operation === 'retry')
      assert.equal(retry.reasonCode, MEMORY_HOT_PROJECTOR_RETRY_REASON_V1)
      assert.equal(retry.retryAt, new Date(
        Date.parse(NOW) + MEMORY_HOT_PROJECTOR_RETRY_BACKOFF_MS_V1
      ).toISOString())
      assert.equal(retry.reasonCode.includes(upsert.namespaceRef), false)
      assert.equal(retry.reasonCode.includes(upsert.aggregateId), false)
      assert.equal(JSON.stringify(result).includes(memoryRecordFixture().text), false)
    })
  }
})

test('retryAt stays at the fixed bounded backoff for a future-dated event', async () => {
  const futureOccurredAt = '2026-07-19T00:05:30.000Z'
  const target = event({ occurredAt: futureOccurredAt })
  const harness = outboxHarness([target])
  const result = await createProjector(
    harness.outbox,
    sourcePort(async () => ({ status: 'unavailable', category: 'busy', retryable: true }))
  ).projectBatch()

  assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
  const retry = operationRequests(harness.requests, 'retry')[0]
  assert.ok(retry?.operation === 'retry')
  assert.equal(retry.retryAt, new Date(
    Date.parse(NOW) + MEMORY_HOT_PROJECTOR_RETRY_BACKOFF_MS_V1
  ).toISOString())
})

test('retry request clock drift becomes a fixed incomplete result', async () => {
  const target = event()
  const times = [NOW, NOW, '2026-07-19T00:05:10.000Z']
  const outbox = createMemoryOutboxPortV1({
    now: () => times.shift() ?? times.at(-1) ?? NOW,
    execute: async request => request.operation === 'claim'
      ? {
          status: 'claimed',
          ownerId: request.ownerId,
          leaseToken: LEASE_TOKEN,
          leasedUntil: '2026-07-19T00:06:00.000Z',
          events: [target]
        }
      : { status: 'retried' }
  })

  assert.deepEqual(await createProjector(
    outbox,
    sourcePort(async () => ({ status: 'unavailable', category: 'busy', retryable: true }))
  ).projectBatch(), {
    status: 'incomplete',
    claimed: 1,
    acked: 0,
    retried: 0,
    reason: 'retry_failed'
  })
})

test('forgotten projection reconciles a current head and invalidates only proven stable absence', async () => {
  const forgotten = event({ eventKind: 'record_forgotten' })
  for (const currentState of ['found', 'expired'] as const) {
    const harness = outboxHarness([forgotten])
    const cacheRequests: Readonly<Record<string, unknown>>[] = []
    const result = await createProjector(
      harness.outbox,
      sourcePort(async request => request.operation === 'head.get'
        ? currentState === 'found'
          ? { status: 'found', head: head() }
          : { status: 'expired', head: head() }
        : { status: 'found', namespaceGeneration: 1 }),
      cachePort(request => {
        cacheRequests.push(request)
        return currentState === 'found'
          ? { status: 'hit', record: memoryRecordFixture() }
          : { status: 'miss', reason: 'expired' }
      })
    ).projectBatch()
    assert.equal(result.status, 'completed')
    assert.deepEqual(cacheRequests.map(request => request.operation), ['record.get'])
  }

  const harness = outboxHarness([forgotten])
  const cacheRequests: Readonly<Record<string, unknown>>[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(async request => request.operation === 'head.get'
      ? { status: 'absent', namespaceGeneration: 1 }
      : { status: 'found', namespaceGeneration: 1 }),
    cachePort(request => {
      cacheRequests.push(request)
      return { status: 'unchanged' }
    })
  ).projectBatch()
  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.deepEqual(cacheRequests, [{
    schemaVersion: 1,
    operation: 'record.invalidate',
    namespaceRef: forgotten.namespaceRef,
    namespaceGeneration: forgotten.namespaceGeneration,
    memoryId: forgotten.aggregateId,
    deletedRevision: forgotten.revision
  }])
})

test('forgotten projection repairs a concurrent recreate after invalidation before ack', async () => {
  const forgotten = event({ eventKind: 'record_forgotten' })
  const recreated = memoryRecordFixture({ text: '并发重建后的新 incarnation' })
  const harness = outboxHarness([forgotten])
  let headCalls = 0
  const cacheOperations: string[] = []
  const result = await createProjector(
    harness.outbox,
    sourcePort(request => {
      if (request.operation === 'record.getExact') {
        return { status: 'found', record: recreated }
      }
      headCalls += 1
      return headCalls === 1
        ? { status: 'absent', namespaceGeneration: 1 }
        : { status: 'found', head: head(recreated) }
    }),
    cachePort(request => {
      cacheOperations.push(String(request.operation))
      if (request.operation === 'record.invalidate') return { status: 'invalidated' }
      if (request.operation === 'record.get') return { status: 'miss', reason: 'not_found' }
      return { status: 'stored' }
    })
  ).projectBatch()

  assert.deepEqual(result, { status: 'completed', claimed: 1, acked: 1, retried: 0 })
  assert.deepEqual(cacheOperations, ['record.invalidate', 'record.get', 'record.put'])
})

test('forgotten projection retains retry when canonical generation is missing, lower, or unprovable', async t => {
  const forgotten = event({ namespaceGeneration: 2, eventKind: 'record_forgotten' })
  for (const canonical of [
    { status: 'not_found' },
    { status: 'absent', namespaceGeneration: 1 },
    { status: 'unavailable', category: 'storage', retryable: false }
  ] as const) {
    await t.test(JSON.stringify(canonical), async () => {
      const harness = outboxHarness([forgotten])
      let cacheCalls = 0
      const result = await createProjector(
        harness.outbox,
        sourcePort(async () => canonical),
        cachePort(() => {
          cacheCalls += 1
          return { status: 'invalidated' }
        })
      ).projectBatch()
      assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
      assert.equal(cacheCalls, 0)
    })
  }
})

test('namespace deletion requires a proven next generation and acks the bounded fence outcome', async t => {
  const namespaceRef = memoryRecordFixture().namespaceRef
  const deleted = event({
    namespaceGeneration: 2,
    aggregate: 'namespace',
    aggregateId: namespaceRef,
    revision: 2,
    eventKind: 'namespace_deleted'
  })
  for (const cacheResult of [
    { status: 'invalidated' },
    { status: 'unchanged' },
    { status: 'skipped', reason: 'capacity' }
  ] as const) {
    await t.test(JSON.stringify(cacheResult), async () => {
      const harness = outboxHarness([deleted])
      const cacheRequests: Readonly<Record<string, unknown>>[] = []
      const result = await createProjector(
        harness.outbox,
        sourcePort(async request => request.operation === 'namespace.get'
          ? { status: 'found', namespaceGeneration: 2 }
          : { status: 'not_found' }),
        cachePort(request => {
          cacheRequests.push(request)
          if (request.operation === 'usage.get') {
            return usageAtGenerationCount(MEMORY_RESOURCE_LIMITS.deploymentNamespaces)
          }
          return cacheResult
        })
      ).projectBatch()
      assert.equal(result.status, 'completed')
      assert.deepEqual(cacheRequests[0], {
        schemaVersion: 1,
        operation: 'namespace.invalidate',
        namespaceRef,
        deletedGeneration: 1,
        nextGeneration: 2
      })
      assert.equal(cacheRequests.length, cacheResult.status === 'skipped' ? 2 : 1)
    })
  }
})

test('namespace fence capacity retains retry unless exact usage proves the 4096 boundary', async () => {
  const namespaceRef = memoryRecordFixture().namespaceRef
  const deleted = event({
    namespaceGeneration: 2,
    aggregate: 'namespace',
    aggregateId: namespaceRef,
    revision: 2,
    eventKind: 'namespace_deleted'
  })
  for (const usageResult of [
    usageAtGenerationCount(MEMORY_RESOURCE_LIMITS.deploymentNamespaces - 1),
    { status: 'unavailable' }
  ]) {
    const harness = outboxHarness([deleted])
    const result = await createProjector(
      harness.outbox,
      sourcePort(async request => request.operation === 'namespace.get'
        ? { status: 'found', namespaceGeneration: 2 }
        : { status: 'not_found' }),
      cachePort(request => request.operation === 'namespace.invalidate'
        ? { status: 'skipped', reason: 'capacity' }
        : usageResult)
    ).projectBatch()
    assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
  }
})

test('impossible or unproven namespace deletion is retained through retry', async () => {
  const namespaceRef = memoryRecordFixture().namespaceRef
  for (const generation of [1, 3]) {
    const deleted = event({
      namespaceGeneration: generation,
      aggregate: 'namespace',
      aggregateId: namespaceRef,
      revision: generation,
      eventKind: 'namespace_deleted'
    })
    const harness = outboxHarness([deleted])
    let cacheCalls = 0
    const result = await createProjector(
      harness.outbox,
      sourcePort(async request => request.operation === 'namespace.get'
        ? { status: 'found', namespaceGeneration: 2 }
        : { status: 'not_found' }),
      cachePort(() => {
        cacheCalls += 1
        return { status: 'invalidated' }
      })
    ).projectBatch()
    assert.deepEqual(result, { status: 'retained', claimed: 1, acked: 0, retried: 1 })
    assert.equal(cacheCalls, 0)
  }
})

test('ack or retry lease conflict returns a fixed incomplete result', async t => {
  const proposal = event({
    aggregate: 'proposal',
    aggregateId: 'proposal:lease-conflict',
    eventKind: 'proposal_changed'
  })
  const cases: readonly [OutboxHarnessOptions, string][] = [
    [{ ackResult: { status: 'lease_conflict' } }, 'ack_failed'],
    [{
      retryResult: { status: 'lease_conflict' }
    }, 'retry_failed']
  ]
  for (const [options, reason] of cases) {
    await t.test(reason, async () => {
      const target = reason === 'retry_failed' ? event() : proposal
      const harness = outboxHarness([target], options)
      const result = await createProjector(
        harness.outbox,
        reason === 'retry_failed'
          ? sourcePort(async () => ({ status: 'unavailable', category: 'io', retryable: true }))
          : sourcePort(),
        cachePort()
      ).projectBatch()
      assert.deepEqual(result, {
        status: 'incomplete',
        claimed: 1,
        acked: 0,
        retried: 0,
        reason
      })
    })
  }
})

test('projector replay converges after Redis success followed by ack failure', async () => {
  const upsert = event()
  const firstOutbox = outboxHarness([upsert], { ackResult: { status: 'lease_conflict' } })
  let stored = false
  const cache = cachePort(request => {
    if (request.operation === 'record.get') {
      return stored
        ? { status: 'hit', record: memoryRecordFixture() }
        : { status: 'miss', reason: 'not_found' }
    }
    if (request.operation !== 'record.put') return { status: 'unavailable' }
    if (stored) return { status: 'unchanged' }
    stored = true
    return { status: 'stored' }
  })
  assert.equal((await createProjector(firstOutbox.outbox, sourcePort(), cache).projectBatch()).status, 'incomplete')

  const replayOutbox = outboxHarness([upsert])
  assert.deepEqual(await createProjector(replayOutbox.outbox, sourcePort(), cache).projectBatch(), {
    status: 'completed',
    claimed: 1,
    acked: 1,
    retried: 0
  })
})

test('a delayed older sequence remains order-independent after a newer trigger was projected', async () => {
  const current = memoryRecordFixture({ revision: 2 })
  let cached = false
  const cache = cachePort(request => {
    if (request.operation === 'record.get') {
      return cached
        ? { status: 'hit', record: current }
        : { status: 'miss', reason: 'not_found' }
    }
    if (request.operation === 'record.put') {
      cached = true
      return { status: 'stored' }
    }
    return { status: 'unavailable' }
  })
  const source = sourcePort(request => request.operation === 'head.get'
    ? { status: 'found', head: head(current) }
    : { status: 'found', record: current })
  const newer = outboxHarness([event({ eventId: 'event:newer', sequence: 2, revision: 2 })])
  const older = outboxHarness([event({ eventId: 'event:older', sequence: 1, revision: 1 })])

  assert.equal((await createProjector(newer.outbox, source, cache).projectBatch()).status, 'completed')
  assert.equal((await createProjector(older.outbox, source, cache).projectBatch()).status, 'completed')
  assert.equal(operationRequests(newer.requests, 'ack').length, 1)
  assert.equal(operationRequests(older.requests, 'ack').length, 1)
})

test('one batch claims exactly 32 ordered events and leaves the 33rd untouched', async () => {
  const events = Array.from({ length: 33 }, (_, index) => event({
    eventId: `event:batch-${index + 1}`,
    sequence: index + 1,
    aggregate: 'proposal',
    aggregateId: `proposal:batch-${index + 1}`,
    eventKind: 'proposal_changed'
  }))
  const harness = outboxHarness(events)
  const result = await createProjector(harness.outbox).projectBatch()
  assert.deepEqual(result, { status: 'completed', claimed: 32, acked: 32, retried: 0 })
  assert.equal(operationRequests(harness.requests, 'ack').length, 32)
  assert.equal(operationRequests(harness.requests, 'ack').some(request =>
    request.operation === 'ack' && request.sequence === 33
  ), false)
})

test('module-wide concurrency guard is non-waiting and the busy call claims nothing', async () => {
  let releaseClaim: (() => void) | undefined
  let claims = 0
  const outbox = createMemoryOutboxPortV1({
    now: () => NOW,
    execute: async request => {
      assert.equal(request.operation, 'claim')
      claims += 1
      await new Promise<void>(resolve => { releaseClaim = resolve })
      return { status: 'empty' }
    }
  })
  const projector = createProjector(outbox)
  const first = projector.projectBatch()
  while (releaseClaim === undefined) await Promise.resolve()
  assert.deepEqual(await projector.projectBatch(), { status: 'busy' })
  assert.equal(claims, 1)
  releaseClaim()
  assert.deepEqual(await first, { status: 'empty' })
})

test('abort cleanup retries only the started current event without the aborted signal', async () => {
  const controller = new AbortController()
  const firstEvent = event({ eventId: 'event:abort-current', sequence: 1 })
  const untouched = event({
    eventId: 'event:abort-untouched',
    sequence: 2,
    aggregate: 'proposal',
    aggregateId: 'proposal:abort-untouched',
    eventKind: 'proposal_changed'
  })
  const outboxRequests: MemoryOutboxRequestV1[] = []
  const cleanupSignals: Array<AbortSignal | undefined> = []
  const outbox = createMemoryOutboxPortV1({
    now: () => NOW,
    execute: async (request, signal) => {
      outboxRequests.push(request)
      if (request.operation === 'claim') {
        return {
          status: 'claimed',
          ownerId: request.ownerId,
          leaseToken: LEASE_TOKEN,
          leasedUntil: '2026-07-19T00:06:00.000Z',
          events: [firstEvent, untouched]
        }
      }
      assert.equal(request.operation, 'retry')
      cleanupSignals.push(signal)
      return { status: 'retried' }
    }
  })
  let sourceCalls = 0
  const source = sourcePort(() => {
    sourceCalls += 1
    controller.abort()
    return { status: 'aborted' }
  })

  assert.deepEqual(
    await createProjector(outbox, source).projectBatch(controller.signal),
    { status: 'aborted' }
  )
  assert.equal(sourceCalls, 1)
  assert.deepEqual(operationRequests(outboxRequests, 'retry').map(request => (
    request.operation === 'retry' ? request.eventId : ''
  )), [firstEvent.eventId])
  assert.deepEqual(cleanupSignals, [undefined])
})

test('abort cleanup remains aborted when the retry request is rejected', async () => {
  const controller = new AbortController()
  const target = event({ eventId: 'event:abort-retry-rejected' })
  const times = [NOW, NOW, '2026-07-19T00:05:10.000Z']
  const outbox = createMemoryOutboxPortV1({
    now: () => times.shift() ?? times.at(-1) ?? NOW,
    execute: async request => request.operation === 'claim'
      ? {
          status: 'claimed',
          ownerId: request.ownerId,
          leaseToken: LEASE_TOKEN,
          leasedUntil: '2026-07-19T00:06:00.000Z',
          events: [target]
        }
      : { status: 'retried' }
  })
  const source = sourcePort(() => {
    controller.abort()
    return { status: 'aborted' }
  })

  assert.deepEqual(
    await createProjector(outbox, source).projectBatch(controller.signal),
    { status: 'aborted' }
  )
})

test('abort after claim but before the first event does not consume any attempt', async () => {
  const controller = new AbortController()
  const target = event()
  const requests: MemoryOutboxRequestV1[] = []
  const outbox = createMemoryOutboxPortV1({
    now: () => NOW,
    execute: async request => {
      requests.push(request)
      assert.equal(request.operation, 'claim')
      controller.abort()
      return {
        status: 'claimed',
        ownerId: request.ownerId,
        leaseToken: LEASE_TOKEN,
        leasedUntil: '2026-07-19T00:06:00.000Z',
        events: [target]
      }
    }
  })
  let sourceCalls = 0
  const result = await createProjector(
    outbox,
    sourcePort(() => {
      sourceCalls += 1
      return { status: 'not_found' }
    })
  ).projectBatch(controller.signal)

  assert.deepEqual(result, { status: 'aborted' })
  assert.equal(sourceCalls, 0)
  assert.equal(operationRequests(requests, 'retry').length, 0)
})

test('projector aborts before claim and strict options reject hostile values', async () => {
  const harness = outboxHarness([])
  const projector = createProjector(harness.outbox)
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await projector.projectBatch(controller.signal), { status: 'aborted' })
  assert.equal(harness.requests.length, 0)

  assert.throws(() => createMemoryHotProjectorV1({
    ownerId: OWNER_ID,
    now: () => NOW,
    outbox: harness.outbox,
    source: sourcePort(),
    cache: cachePort(),
    extra: true
  } as never), TypeError)
  assert.throws(() => createMemoryHotProjectorV1(new Proxy({
    ownerId: OWNER_ID,
    now: () => NOW,
    outbox: harness.outbox,
    source: sourcePort(),
    cache: cachePort()
  }, {}) as never), TypeError)

  await assert.rejects(
    async () => await projector.projectBatch({ aborted: false } as AbortSignal),
    TypeError
  )
})

test('projector has no timer, production composition, Redis key, or SQLite open side effect', async () => {
  const source = await readFile(path.join(
    PROJECT_ROOT,
    'src/agent/memory/memory-hot-projector.ts'
  ), 'utf8')
  assert.equal(/setInterval|setTimeout|DatabaseSync|openSqliteMemoryDatabase|MEMORY_HOT_CACHE_KEYS/.test(source), false)
  assert.equal(/production|yunzai|guoba|config\/config/.test(source), false)
})
