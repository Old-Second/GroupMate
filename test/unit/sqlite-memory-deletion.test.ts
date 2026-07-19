import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { encodeMemoryTombstoneV1 } from '../../src/agent/memory/memory-codec.js'
import type { MemoryRevisionV1 } from '../../src/agent/memory/memory-domain.js'
import * as sqliteRepository from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memoryRecordFixture,
  memoryRevisionFixture,
  memoryTombstoneFixture
} from '../helpers/memory-fixture.js'
import {
  approvedProposalV1,
  correctedRevisionV1,
  createSqliteMemoryRepositoryHarnessV1,
  proposalCreateRequestV1,
  proposalDecideRequestV1,
  recordCorrectRequestV1,
  recordCreateRequestV1,
  recordGetRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

type ScrubDeletedNamespaceV1 = (options: {
  readonly database: DatabaseSync
  readonly namespaceRef: string
  readonly namespaceGeneration: number
  readonly now: () => string
}) => {
  readonly status: 'scrubbed'
  readonly processedAggregates: number
  readonly hasMore: boolean
}

type PurgeExpiredTombstonesV1 = (options: {
  readonly database: DatabaseSync
  readonly namespaceRef: string
  readonly now: () => string
}) => {
  readonly status: 'purged'
  readonly processedTombstones: number
  readonly hasMore: boolean
}

type CheckpointDeletionV1 = (options: {
  readonly database: DatabaseSync
}) => {
  readonly schemaVersion: 1
  readonly logicalDeletion: 'committed'
  readonly payloadDeletion: 'secure_delete_on' | 'unverified'
  readonly walCheckpoint: 'truncated' | 'deferred'
  readonly derivedCleanup: 'queued'
}

function forgetRequest (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  revision: number,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    schemaVersion: 1,
    operation: 'record.forget',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedRevision: revision,
    expectedNamespaceGeneration: 1,
    tombstone: memoryTombstoneFixture({ deletedRevision: revision, ...overrides })
  }
}

function namespaceDeleteRequest (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    schemaVersion: 1,
    operation: 'namespace.delete',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedNamespaceGeneration: 1,
    tombstone: memoryTombstoneFixture({
      tombstoneId: 'tombstone:namespace-delete',
      namespaceGeneration: 2,
      memoryId: null,
      deletedRevision: null,
      deletionKind: 'namespace_deleted',
      ...overrides
    })
  }
}

async function approvedRecordWithRevisions (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  revisionCount: number
): Promise<MemoryRevisionV1> {
  assert.equal((await harness.repository.execute(
    proposalCreateRequestV1(harness)
  )).status, 'stored')
  assert.equal((await harness.repository.execute(proposalDecideRequestV1(
    harness,
    approvedProposalV1()
  ))).status, 'stored')
  let current = memoryRevisionFixture()
  for (let revision = 2; revision <= revisionCount; revision += 1) {
    current = correctedRevisionV1(current, {
      text: `隐私正文-marker-${revision}`,
      updatedAt: `2026-07-19T00:${String(revision + 2).padStart(2, '0')}:00.000Z`
    })
    assert.equal((await harness.repository.execute(
      recordCorrectRequestV1(harness, current)
    )).status, 'stored')
  }
  return current
}

test('sqlite memory deletion forgets 1, 2 and 32 revisions plus approved proposal bodies', async () => {
  for (const revisionCount of [1, 2, 32]) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      const current = await approvedRecordWithRevisions(harness, revisionCount)
      const request = forgetRequest(harness, revisionCount)
      const first = await harness.repository.execute(request)
      const replay = await harness.repository.execute(request)
      assert.equal(first.status, 'stored')
      assert.equal(replay.status, 'unchanged')
      assert.equal(
        first.status === 'stored' ? first.receipt : null,
        replay.status === 'unchanged' ? replay.receipt : null
      )
      for (const table of ['proposals', 'heads', 'revisions', 'revision_payloads']) {
        assert.equal(harness.store.database.prepare(
          `SELECT count(*) AS value FROM ${table}`
        ).get()!.value, 0)
      }
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 1)
      assert.equal(harness.store.database.prepare(`
        SELECT count(*) AS value FROM outbox WHERE event_kind = 'record_forgotten'
      `).get()!.value, 1)
      assert.deepEqual(harness.store.database.prepare('PRAGMA foreign_key_check').all(), [])

      const persisted = JSON.stringify({
        tombstone: harness.store.database.prepare('SELECT tombstone_wire FROM tombstones').get(),
        event: harness.store.database.prepare(`
          SELECT event_wire FROM outbox WHERE event_kind = 'record_forgotten'
        `).get()
      })
      for (const forbidden of [
        current.record.text,
        current.record.sources[0]!.normalizedText,
        current.record.sources[0]!.actor.userId,
        current.record.sources[0]!.actor.nickname,
        current.record.contentHash,
        current.revisionHash,
        current.record.sources[0]!.contentHash
      ].filter((value): value is string => typeof value === 'string')) {
        assert.equal(persisted.includes(forbidden), false)
      }
    } finally {
      harness.close()
    }
  }
})

test('sqlite memory deletion fails closed on conflicting tombstone reuse', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    const request = forgetRequest(harness, 1)
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    assert.deepEqual(await harness.repository.execute(forgetRequest(harness, 1, {
      reasonCode: 'conflicting_reason'
    })), { status: 'conflict', category: 'idempotency' })
    assert.deepEqual(await harness.repository.execute(forgetRequest(harness, 1, {
      tombstoneId: 'tombstone:different-for-same-memory'
    })), { status: 'conflict', category: 'idempotency' })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 1)
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM outbox WHERE event_kind = 'record_forgotten'
    `).get()!.value, 1)
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion advances namespace generation before bounded body scrub', async () => {
  const scrub = (
    sqliteRepository as unknown as {
      readonly scrubDeletedSqliteMemoryNamespaceV1?: ScrubDeletedNamespaceV1
    }
  ).scrubDeletedSqliteMemoryNamespaceV1
  assert.equal(typeof scrub, 'function')
  if (scrub === undefined) assert.fail('namespace scrub helper must exist')

  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    for (let index = 0; index < 33; index += 1) {
      const memoryId = `memory:namespace-delete-${String(index).padStart(2, '0')}`
      const record = memoryRecordFixture({ memoryId })
      const revision = memoryRevisionFixture({ memoryId, record })
      assert.equal((await harness.repository.execute(
        recordCreateRequestV1(harness, revision)
      )).status, 'stored')
    }
    harness.store.database.exec(`
      CREATE TEMP TRIGGER fail_inline_namespace_scrub
      BEFORE DELETE ON revisions
      BEGIN
        SELECT RAISE(ABORT, 'namespace-delete-must-not-inline-scrub');
      END;
    `)
    const request = namespaceDeleteRequest(harness)
    const first = await harness.repository.execute(request)
    const replay = await harness.repository.execute(request)
    assert.equal(first.status, 'stored')
    assert.equal(replay.status, 'unchanged')
    assert.deepEqual(await harness.repository.execute(
      recordGetRequestV1(harness, 'memory:namespace-delete-00')
    ), { status: 'not_found' })
    assert.deepEqual(await harness.repository.execute(recordCreateRequestV1(harness)), {
      status: 'conflict',
      category: 'generation'
    })
    assert.equal(harness.store.database.prepare(`
      SELECT namespace_generation AS value FROM namespaces
    `).get()!.value, 2)
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM revisions WHERE namespace_generation = 1
    `).get()!.value, 33)
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM usage WHERE namespace_generation = 1
    `).get()!.value, 1)
    assert.deepEqual({ ...harness.store.database.prepare(`
      SELECT active_memory_records, retained_revision_records, tombstone_records,
             pending_outbox_records
      FROM usage WHERE namespace_generation = 2
    `).get() }, {
      active_memory_records: 0,
      retained_revision_records: 0,
      tombstone_records: 1,
      pending_outbox_records: 1
    })

    harness.store.database.exec('DROP TRIGGER fail_inline_namespace_scrub')
    assert.deepEqual(scrub({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      namespaceGeneration: 1,
      now: () => FIXTURE_TIMES.deletedAt
    }), {
      status: 'scrubbed',
      processedAggregates: 32,
      hasMore: true
    })
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM revisions WHERE namespace_generation = 1
    `).get()!.value, 1)
    assert.deepEqual(scrub({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      namespaceGeneration: 1,
      now: () => FIXTURE_TIMES.deletedAt
    }), {
      status: 'scrubbed',
      processedAggregates: 1,
      hasMore: false
    })
    assert.deepEqual(harness.store.database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion keeps a 30 day barrier and expires tombstones only in explicit batches', async () => {
  const purgeTombstones = (
    sqliteRepository as unknown as {
      readonly purgeExpiredSqliteMemoryTombstonesV1?: PurgeExpiredTombstonesV1
    }
  ).purgeExpiredSqliteMemoryTombstonesV1
  assert.equal(typeof purgeTombstones, 'function')
  if (purgeTombstones === undefined) assert.fail('tombstone purge helper must exist')

  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    const request = forgetRequest(harness, 1)
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    const wire = String(harness.store.database.prepare(
      'SELECT tombstone_wire AS value FROM tombstones'
    ).get()!.value)
    assert.equal(wire, encodeMemoryTombstoneV1(request.tombstone))
    assert.equal(
      Date.parse(request.tombstone.expiresAt) - Date.parse(request.tombstone.deletedAt),
      30 * 24 * 60 * 60 * 1_000
    )

    assert.deepEqual(purgeTombstones({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => '2026-08-19T00:01:59.999Z'
    }), { status: 'purged', processedTombstones: 0, hasMore: false })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 1)
    assert.deepEqual(purgeTombstones({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => FIXTURE_TIMES.tombstoneExpiresAt
    }), { status: 'purged', processedTombstones: 1, hasMore: false })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 0)
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion checkpoint reports logical payload WAL and derived states separately', () => {
  const checkpoint = (
    sqliteRepository as unknown as {
      readonly checkpointSqliteMemoryDeletionV1?: CheckpointDeletionV1
    }
  ).checkpointSqliteMemoryDeletionV1
  assert.equal(typeof checkpoint, 'function')
  if (checkpoint === undefined) assert.fail('checkpoint helper must exist')

  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    assert.deepEqual(checkpoint({ database: harness.store.database }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'queued'
    })
  } finally {
    harness.close()
  }

  const checkpointFailure = {
    prepare (sql: string) {
      if (sql === 'PRAGMA secure_delete') return { get: () => ({ secure_delete: 1 }) }
      throw new Error('private-checkpoint-failure')
    },
    exec () {}
  } as unknown as DatabaseSync
  assert.deepEqual(checkpoint({ database: checkpointFailure }), {
    schemaVersion: 1,
    logicalDeletion: 'committed',
    payloadDeletion: 'secure_delete_on',
    walCheckpoint: 'deferred',
    derivedCleanup: 'queued'
  })
})
