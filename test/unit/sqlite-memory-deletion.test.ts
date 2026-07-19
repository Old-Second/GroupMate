import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import { encodeMemoryTombstoneV1 } from '../../src/agent/memory/memory-codec.js'
import type {
  MemoryRevisionV1,
  MemoryTombstoneV1
} from '../../src/agent/memory/memory-domain.js'
import { createSqliteMemoryOutboxV1 } from '../../src/agent/memory/sqlite-memory-outbox.js'
import * as sqliteRepository from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memoryTombstoneFixture,
  personalMemoryNamespaceFixture
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
  readonly tombstone: MemoryTombstoneV1
}) => {
  readonly schemaVersion: 1
  readonly logicalDeletion: 'committed' | 'unverified'
  readonly payloadDeletion: 'secure_delete_on' | 'unverified'
  readonly walCheckpoint: 'truncated' | 'deferred'
  readonly derivedCleanup: 'queued' | 'unverified'
}

function capabilityAt (now: string) {
  const namespace = personalMemoryNamespaceFixture()
  return issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    deepFreezeFixture({
      schemaVersion: 1,
      botInstanceId: FIXTURE_IDS.botInstanceId,
      adapter: 'qq',
      accountId: FIXTURE_IDS.accountId,
      scene: deepFreezeFixture({
        kind: 'private',
        peerUserId: FIXTURE_IDS.subjectUserId
      })
    }),
    [namespace],
    now
  )
}

function atTime<T extends Readonly<Record<string, unknown>>> (request: T, now: string): T {
  return { ...request, capability: capabilityAt(now) } as unknown as T
}

async function ackAllOutbox (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  now: string
): Promise<void> {
  const outbox = createSqliteMemoryOutboxV1({
    database: harness.store.database,
    now: () => now
  })
  const claimed = await outbox.execute({
    schemaVersion: 1,
    operation: 'claim',
    ownerId: 'barrier-test-worker',
    limit: 32
  })
  if (claimed.status === 'empty') return
  assert.equal(claimed.status, 'claimed')
  if (claimed.status !== 'claimed') assert.fail('outbox claim expected')
  for (const event of claimed.events) {
    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: claimed.ownerId,
      leaseToken: claimed.leaseToken,
      eventId: event.eventId,
      sequence: event.sequence
    }), { status: 'acked' })
  }
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

test('sqlite memory deletion validates every old revision and approved proposal before forget accounting', async () => {
  const corruptions = [
    {
      name: 'old revision wire',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 2)
        harness.store.database.prepare(`
          UPDATE revision_payloads SET revision_wire = 'x' WHERE revision = 1
        `).run()
      }
    },
    {
      name: 'old revision bytes',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 2)
        harness.store.database.prepare(`
          UPDATE revisions SET revision_wire_bytes = revision_wire_bytes + 1 WHERE revision = 1
        `).run()
      }
    },
    {
      name: 'old revision hash',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 2)
        harness.store.database.prepare(`
          UPDATE revisions SET revision_hash = ? WHERE revision = 1
        `).run('f'.repeat(64))
      }
    },
    {
      name: 'approved proposal wire',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 1)
        harness.store.database.prepare("UPDATE proposals SET proposal_wire = 'x'").run()
      }
    },
    {
      name: 'approved proposal bytes',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 1)
        harness.store.database.prepare(`
          UPDATE proposals SET proposal_wire_bytes = proposal_wire_bytes + 1
        `).run()
      }
    },
    {
      name: 'approved proposal resulting hash',
      prepare: async (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        await approvedRecordWithRevisions(harness, 1)
        harness.store.database.prepare(`
          UPDATE proposals SET resulting_revision_hash = ?
        `).run('f'.repeat(64))
      }
    }
  ] as const

  for (const corruption of corruptions) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      await corruption.prepare(harness)
      const before = Object.freeze({
        proposals: harness.store.database.prepare('SELECT count(*) AS value FROM proposals').get()!.value,
        revisions: harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value,
        outbox: harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value
      })
      const expectedRevision = Number(before.revisions)
      assert.deepEqual(
        await harness.repository.execute(forgetRequest(harness, expectedRevision)),
        { status: 'corrupt', category: 'canonical_data' },
        corruption.name
      )
      assert.deepEqual({
        proposals: harness.store.database.prepare('SELECT count(*) AS value FROM proposals').get()!.value,
        revisions: harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value,
        outbox: harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value
      }, before, corruption.name)
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 0)
    } finally {
      harness.close()
    }
  }
})

test('sqlite memory namespace scrub validates proposal and historical revision bodies before deletion', async () => {
  const scrub = sqliteRepository.scrubDeletedSqliteMemoryNamespaceV1
  for (const branch of ['proposal', 'revision'] as const) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      if (branch === 'proposal') {
        await approvedRecordWithRevisions(harness, 1)
      } else {
        const initial = memoryRevisionFixture()
        assert.equal((await harness.repository.execute(recordCreateRequestV1(
          harness,
          initial
        ))).status, 'stored')
        assert.equal((await harness.repository.execute(recordCorrectRequestV1(
          harness,
          correctedRevisionV1(initial)
        ))).status, 'stored')
      }
      assert.equal((await harness.repository.execute(namespaceDeleteRequest(harness))).status, 'stored')
      if (branch === 'proposal') {
        harness.store.database.prepare("UPDATE proposals SET proposal_wire = 'x'").run()
      } else {
        harness.store.database.prepare(`
          UPDATE revision_payloads SET revision_wire = 'x'
          WHERE namespace_generation = 1 AND revision = 1
        `).run()
      }
      const before = Object.freeze({
        proposals: harness.store.database.prepare(`
          SELECT count(*) AS value FROM proposals WHERE namespace_generation = 1
        `).get()!.value,
        revisions: harness.store.database.prepare(`
          SELECT count(*) AS value FROM revisions WHERE namespace_generation = 1
        `).get()!.value
      })
      assert.deepEqual(scrub({
        database: harness.store.database,
        namespaceRef: harness.namespaceRef,
        namespaceGeneration: 1,
        now: () => FIXTURE_TIMES.deletedAt
      }), { status: 'corrupt', category: 'canonical_data' }, branch)
      assert.deepEqual({
        proposals: harness.store.database.prepare(`
          SELECT count(*) AS value FROM proposals WHERE namespace_generation = 1
        `).get()!.value,
        revisions: harness.store.database.prepare(`
          SELECT count(*) AS value FROM revisions WHERE namespace_generation = 1
        `).get()!.value
      }, before, branch)
    } finally {
      harness.close()
    }
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

test('sqlite memory deletion blocks direct recreation through the active barrier after old events are acked', async () => {
  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    now = FIXTURE_TIMES.updatedAt
    await ackAllOutbox(harness, now)

    now = FIXTURE_TIMES.deletedAt
    const request = atTime(forgetRequest(harness, 1), now)
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    await ackAllOutbox(harness, now)
    assert.equal((await harness.repository.execute(atTime(request, now))).status, 'unchanged')

    now = new Date(Date.parse(FIXTURE_TIMES.tombstoneExpiresAt) - 1).toISOString()
    assert.deepEqual(await harness.repository.execute(atTime(
      recordCreateRequestV1(harness),
      now
    )), { status: 'conflict', category: 'idempotency' })

    now = FIXTURE_TIMES.tombstoneExpiresAt
    assert.deepEqual(await harness.repository.execute(atTime(request, now)), {
      status: 'conflict',
      category: 'revision'
    })
    assert.equal((await harness.repository.execute(atTime(
      recordCreateRequestV1(harness),
      now
    ))).status, 'stored')
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion blocks pending proposal approval from reviving an actively forgotten memory', async () => {
  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    now = FIXTURE_TIMES.updatedAt
    await ackAllOutbox(harness, now)

    now = FIXTURE_TIMES.deletedAt
    assert.equal((await harness.repository.execute(atTime(
      forgetRequest(harness, 1),
      now
    ))).status, 'stored')
    assert.equal((await harness.repository.execute(atTime(
      proposalCreateRequestV1(harness),
      now
    ))).status, 'stored')
    assert.deepEqual(await harness.repository.execute(atTime(
      proposalDecideRequestV1(harness, approvedProposalV1()),
      now
    )), { status: 'conflict', category: 'idempotency' })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 0)
  } finally {
    harness.close()
  }
})

test('sqlite memory namespace deletion replays only while its exact tombstone is active', async () => {
  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    now = FIXTURE_TIMES.deletedAt
    const request = atTime(namespaceDeleteRequest(harness), now)
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    assert.equal((await harness.repository.execute(atTime(request, now))).status, 'unchanged')

    now = FIXTURE_TIMES.tombstoneExpiresAt
    assert.deepEqual(await harness.repository.execute(atTime(request, now)), {
      status: 'conflict',
      category: 'generation'
    })
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion checkpoint proves exact logical deletion and queued cleanup independently', async () => {
  const checkpoint = (
    sqliteRepository as unknown as {
      readonly checkpointSqliteMemoryDeletionV1?: CheckpointDeletionV1
    }
  ).checkpointSqliteMemoryDeletionV1
  assert.equal(typeof checkpoint, 'function')
  if (checkpoint === undefined) assert.fail('checkpoint helper must exist')

  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const request = forgetRequest(harness, 1)
    assert.deepEqual(checkpoint({
      database: harness.store.database,
      tombstone: request.tombstone
    }), {
      schemaVersion: 1,
      logicalDeletion: 'unverified',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'unverified'
    })
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    assert.deepEqual(checkpoint({
      database: harness.store.database,
      tombstone: request.tombstone
    }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'queued'
    })

    const checkpointFailure = {
      prepare (sql: string) {
        if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)') {
          throw new Error('private-checkpoint-failure')
        }
        return harness.store.database.prepare(sql)
      },
      exec (sql: string) {
        return harness.store.database.exec(sql)
      }
    } as unknown as DatabaseSync
    assert.deepEqual(checkpoint({
      database: checkpointFailure,
      tombstone: request.tombstone
    }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'deferred',
      derivedCleanup: 'queued'
    })

    harness.store.database.prepare(`
      DELETE FROM outbox WHERE event_kind = 'record_forgotten'
    `).run()
    assert.deepEqual(checkpoint({
      database: harness.store.database,
      tombstone: request.tombstone
    }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'unverified'
    })
    assert.deepEqual(checkpoint({
      database: harness.store.database,
      tombstone: memoryTombstoneFixture({ tombstoneId: 'tombstone:wrong-checkpoint' })
    }), {
      schemaVersion: 1,
      logicalDeletion: 'unverified',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'unverified'
    })
  } finally {
    harness.close()
  }
})

test('sqlite memory deletion checkpoint verifies namespace generation and exact tombstone wire', async () => {
  const checkpoint = sqliteRepository.checkpointSqliteMemoryDeletionV1 as unknown as CheckpointDeletionV1
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    const request = namespaceDeleteRequest(harness)
    assert.equal((await harness.repository.execute(request)).status, 'stored')
    assert.deepEqual(checkpoint({ database: harness.store.database, tombstone: request.tombstone }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'queued'
    })
    harness.store.database.prepare(`
      UPDATE tombstones SET tombstone_wire = 'x'
      WHERE tombstone_id = ?
    `).run(request.tombstone.tombstoneId)
    assert.deepEqual(checkpoint({ database: harness.store.database, tombstone: request.tombstone }), {
      schemaVersion: 1,
      logicalDeletion: 'unverified',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'unverified'
    })
  } finally {
    harness.close()
  }
})
