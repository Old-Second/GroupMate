import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MemoryRevisionV1 } from '../../src/agent/memory/memory-domain.js'
import * as sqliteRepository from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_TIMES,
  memoryRecordFixture,
  memoryRevisionFixture
} from '../helpers/memory-fixture.js'
import {
  createSqliteMemoryRepositoryHarnessV1,
  recordCreateRequestV1,
  recordGetRequestV1,
  recordListRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

type PurgeExpiredRecordsV1 = (options: {
  readonly database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']
  readonly namespaceRef: string
  readonly now: () => string
  readonly actorRef: string
  readonly reasonCode: string
}) => {
  readonly status: 'purged'
  readonly processedRecords: number
  readonly hasMore: boolean
}

function expiringRevision (suffix: string): MemoryRevisionV1 {
  const memoryId = `memory:retention-${suffix}`
  const record = memoryRecordFixture({
    memoryId,
    retention: {
      validUntil: '2026-07-19T00:00:20.000Z',
      purgeAt: '2026-07-19T00:00:30.000Z'
    }
  })
  return memoryRevisionFixture({
    memoryId,
    record,
    changedAt: record.updatedAt
  })
}

test('sqlite memory retention excludes validUntil at the exact boundary', async () => {
  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    const revision = expiringRevision('boundary')
    assert.equal((await harness.repository.execute(
      recordCreateRequestV1(harness, revision)
    )).status, 'stored')

    now = revision.record.retention.validUntil
    assert.deepEqual(
      await harness.repository.execute(recordGetRequestV1(harness, revision.memoryId)),
      { status: 'not_found' }
    )
    const page = await harness.repository.execute(recordListRequestV1(harness))
    assert.equal(page.status, 'page')
    assert.deepEqual(page.status === 'page' ? page.records : null, [])
  } finally {
    harness.close()
  }
})

test('sqlite memory retention purges at most 32 due records per explicit batch', async () => {
  const purgeExpired = (
    sqliteRepository as unknown as {
      readonly purgeExpiredSqliteMemoryRecordsV1?: PurgeExpiredRecordsV1
    }
  ).purgeExpiredSqliteMemoryRecordsV1
  assert.equal(typeof purgeExpired, 'function')
  if (purgeExpired === undefined) assert.fail('purge helper must exist')

  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    for (let index = 0; index < 33; index += 1) {
      const revision = expiringRevision(String(index).padStart(2, '0'))
      assert.equal((await harness.repository.execute(
        recordCreateRequestV1(harness, revision)
      )).status, 'stored')
    }
    now = '2026-07-19T00:00:30.000Z'

    assert.deepEqual(purgeExpired({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => now,
      actorRef: 'actor:retention-maintenance-v1',
      reasonCode: 'retention_expired'
    }), {
      status: 'purged',
      processedRecords: 32,
      hasMore: true
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 1)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 32)

    assert.deepEqual(purgeExpired({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => now,
      actorRef: 'actor:retention-maintenance-v1',
      reasonCode: 'retention_expired'
    }), {
      status: 'purged',
      processedRecords: 1,
      hasMore: false
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 0)
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM outbox WHERE event_kind = 'record_forgotten'
    `).get()!.value, 33)
  } finally {
    harness.close()
  }
})

test('sqlite memory retention rolls an entire purge batch back on one row failure', async () => {
  const purgeExpired = (
    sqliteRepository as unknown as {
      readonly purgeExpiredSqliteMemoryRecordsV1?: PurgeExpiredRecordsV1
    }
  ).purgeExpiredSqliteMemoryRecordsV1
  assert.equal(typeof purgeExpired, 'function')
  if (purgeExpired === undefined) assert.fail('purge helper must exist')

  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    for (const suffix of ['rollback-a', 'rollback-b']) {
      assert.equal((await harness.repository.execute(recordCreateRequestV1(
        harness,
        expiringRevision(suffix)
      ))).status, 'stored')
    }
    harness.store.database.exec(`
      CREATE TEMP TRIGGER fail_second_retention_tombstone
      BEFORE INSERT ON tombstones
      WHEN NEW.memory_id = 'memory:retention-rollback-b'
      BEGIN
        SELECT RAISE(ABORT, 'fixed-retention-batch-failure');
      END;
    `)
    now = '2026-07-19T00:00:30.000Z'

    assert.deepEqual(purgeExpired({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => now,
      actorRef: 'actor:retention-maintenance-v1',
      reasonCode: 'retention_expired'
    }), {
      status: 'unavailable',
      category: 'storage',
      retryable: false
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 2)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 0)
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM outbox WHERE event_kind = 'record_forgotten'
    `).get()!.value, 0)
  } finally {
    harness.close()
  }
})
