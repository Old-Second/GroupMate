import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import type { MemoryOutboxPortV1 } from '../../src/agent/memory/memory-outbox.js'
import * as sqliteOutbox from '../../src/agent/memory/sqlite-memory-outbox.js'
import {
  checkpointSqliteMemoryDeletionV1,
  purgeExpiredSqliteMemoryTombstonesV1
} from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryTombstoneFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'
import {
  createSqliteMemoryRepositoryHarnessV1,
  distinctInitialRevisionV1,
  recordCreateRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

type CreateSqliteOutboxV1 = (options: {
  readonly database: DatabaseSync
  readonly now: () => string
}) => MemoryOutboxPortV1

function outboxFactory (): CreateSqliteOutboxV1 {
  const factory = (
    sqliteOutbox as unknown as {
      readonly createSqliteMemoryOutboxV1?: CreateSqliteOutboxV1
    }
  ).createSqliteMemoryOutboxV1
  assert.equal(typeof factory, 'function')
  if (factory === undefined) assert.fail('sqlite outbox factory must exist')
  return factory
}

function claim (ownerId: string, limit = 32) {
  return { schemaVersion: 1, operation: 'claim', ownerId, limit } as const
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

function forgetRequest (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  now: string,
  tombstoneId: string = FIXTURE_IDS.tombstoneId
) {
  return atTime({
    schemaVersion: 1,
    operation: 'record.forget',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedRevision: 1,
    expectedNamespaceGeneration: 1,
    tombstone: memoryTombstoneFixture({
      tombstoneId,
      deletedAt: now,
      expiresAt: new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1_000).toISOString()
    })
  }, now)
}

test('sqlite memory outbox leases ordered events for exactly 60 seconds and validates the strict ack tuple', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    for (const [suffix, updatedAt] of [
      ['outbox-a', '2026-07-19T00:03:00.000Z'],
      ['outbox-b', '2026-07-19T00:04:00.000Z']
    ] as const) {
      assert.equal((await harness.repository.execute(recordCreateRequestV1(
        harness,
        distinctInitialRevisionV1(suffix, updatedAt)
      ))).status, 'stored')
    }
    now = '2026-07-19T00:04:00.000Z'
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const result = await outbox.execute(claim('worker-a', 2))
    assert.equal(result.status, 'claimed')
    if (result.status !== 'claimed') assert.fail('claim expected')
    assert.deepEqual(result.events.map(event => event.sequence), [1, 2])
    assert.match(result.leaseToken, /^memory-lease:v1:[0-9a-f]{64}$/)
    assert.equal(result.leasedUntil, '2026-07-19T00:05:00.000Z')

    const first = result.events[0]!
    const before = harness.store.database.prepare(`
      SELECT pending_outbox_records, outbox_logical_bytes
      FROM global_usage WHERE singleton = 1
    `).get()!
    for (const request of [
      {
        schemaVersion: 1,
        operation: 'ack',
        ownerId: 'worker-b',
        leaseToken: result.leaseToken,
        eventId: first.eventId,
        sequence: first.sequence
      },
      {
        schemaVersion: 1,
        operation: 'ack',
        ownerId: 'worker-a',
        leaseToken: `memory-lease:v1:${'f'.repeat(64)}`,
        eventId: first.eventId,
        sequence: first.sequence
      },
      {
        schemaVersion: 1,
        operation: 'ack',
        ownerId: 'worker-a',
        leaseToken: result.leaseToken,
        eventId: result.events[1]!.eventId,
        sequence: first.sequence
      }
    ] as const) assert.deepEqual(await outbox.execute(request), { status: 'lease_conflict' })
    assert.deepEqual(harness.store.database.prepare(`
      SELECT pending_outbox_records, outbox_logical_bytes
      FROM global_usage WHERE singleton = 1
    `).get(), before)

    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'worker-a',
      leaseToken: result.leaseToken,
      eventId: first.eventId,
      sequence: first.sequence
    }), { status: 'acked' })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 1)
    const usage = await outbox.execute({ schemaVersion: 1, operation: 'usage' })
    assert.equal(usage.status, 'usage')
    if (usage.status !== 'usage') assert.fail('usage expected')
    assert.equal(usage.value.pendingRecords, 1)
    assert.equal(usage.value.leasedRecords, 1)
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox reclaims a crashed lease at the exact expiry boundary', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    now = FIXTURE_TIMES.updatedAt
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const first = await outbox.execute(claim('crashed-worker', 1))
    assert.equal(first.status, 'claimed')
    if (first.status !== 'claimed') assert.fail('claim expected')

    now = first.leasedUntil
    const reclaimed = await outbox.execute(claim('recovery-worker', 1))
    assert.equal(reclaimed.status, 'claimed')
    if (reclaimed.status !== 'claimed') assert.fail('reclaim expected')
    assert.equal(reclaimed.events[0]!.eventId, first.events[0]!.eventId)
    assert.notEqual(reclaimed.leaseToken, first.leaseToken)
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox retry preserves sequence, skips delayed rows and blocks attempt 16', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    for (const [suffix, updatedAt] of [
      ['retry-a', '2026-07-19T00:03:00.000Z'],
      ['retry-b', '2026-07-19T00:04:00.000Z']
    ] as const) {
      await harness.repository.execute(recordCreateRequestV1(
        harness,
        distinctInitialRevisionV1(suffix, updatedAt)
      ))
    }
    now = '2026-07-19T00:04:00.000Z'
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const first = await outbox.execute(claim('retry-worker', 1))
    assert.equal(first.status, 'claimed')
    if (first.status !== 'claimed') assert.fail('claim expected')
    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'retry',
      ownerId: 'retry-worker',
      leaseToken: first.leaseToken,
      eventId: first.events[0]!.eventId,
      sequence: first.events[0]!.sequence,
      retryAt: '2026-07-19T00:10:00.000Z',
      reasonCode: 'downstream_unavailable'
    }), { status: 'retried' })
    const skipped = await outbox.execute(claim('later-worker', 1))
    assert.equal(skipped.status, 'claimed')
    if (skipped.status !== 'claimed') assert.fail('later event expected')
    assert.equal(skipped.events[0]!.sequence, 2)
    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'later-worker',
      leaseToken: skipped.leaseToken,
      eventId: skipped.events[0]!.eventId,
      sequence: skipped.events[0]!.sequence
    }), { status: 'acked' })

    now = '2026-07-19T00:10:00.000Z'
    for (let attempt = 2; attempt <= 16; attempt += 1) {
      const claimed = await outbox.execute(claim('retry-worker', 1))
      assert.equal(claimed.status, 'claimed')
      if (claimed.status !== 'claimed') assert.fail(`attempt ${attempt} claim expected`)
      assert.equal(claimed.events[0]!.sequence, 1)
      assert.deepEqual(await outbox.execute({
        schemaVersion: 1,
        operation: 'retry',
        ownerId: 'retry-worker',
        leaseToken: claimed.leaseToken,
        eventId: claimed.events[0]!.eventId,
        sequence: claimed.events[0]!.sequence,
        retryAt: now,
        reasonCode: 'downstream_unavailable'
      }), { status: 'retried' })
    }
    assert.deepEqual(await outbox.execute(claim('blocked-worker', 1)), { status: 'empty' })
    assert.deepEqual({ ...harness.store.database.prepare(`
      SELECT sequence, attempt_count, lease_owner_id, last_reason_code
      FROM outbox WHERE sequence = 1
    `).get() }, {
      sequence: 1,
      attempt_count: 16,
      lease_owner_id: null,
      last_reason_code: 'downstream_unavailable'
    })
    assert.equal(harness.store.database.prepare(`
      SELECT pending_outbox_records AS value FROM global_usage WHERE singleton = 1
    `).get()!.value, 1)
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox rolls ack back and preserves old generation usage', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    assert.equal((await harness.repository.execute({
      schemaVersion: 1,
      operation: 'namespace.delete',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      expectedNamespaceGeneration: 1,
      tombstone: memoryTombstoneFixture({
        tombstoneId: 'tombstone:outbox-namespace-delete',
        namespaceGeneration: 2,
        memoryId: null,
        deletedRevision: null,
        deletionKind: 'namespace_deleted'
      })
    })).status, 'stored')
    now = FIXTURE_TIMES.deletedAt
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const claimed = await outbox.execute(claim('old-generation-worker', 1))
    assert.equal(claimed.status, 'claimed')
    if (claimed.status !== 'claimed') assert.fail('claim expected')
    assert.equal(claimed.events[0]!.namespaceGeneration, 1)

    harness.store.database.exec(`
      CREATE TEMP TRIGGER fail_outbox_global_usage
      BEFORE UPDATE ON global_usage
      BEGIN
        SELECT RAISE(ABORT, 'fixed-outbox-ack-failure');
      END;
    `)
    const ack = {
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'old-generation-worker',
      leaseToken: claimed.leaseToken,
      eventId: claimed.events[0]!.eventId,
      sequence: claimed.events[0]!.sequence
    } as const
    assert.deepEqual(await outbox.execute(ack), {
      status: 'unavailable',
      category: 'storage',
      retryable: false
    })
    assert.equal(harness.store.database.prepare(`
      SELECT count(*) AS value FROM outbox WHERE sequence = 1
    `).get()!.value, 1)
    assert.equal(harness.store.database.prepare(`
      SELECT pending_outbox_records AS value FROM usage
      WHERE namespace_generation = 1
    `).get()!.value, 1)

    harness.store.database.exec('DROP TRIGGER fail_outbox_global_usage')
    assert.deepEqual(await outbox.execute(ack), { status: 'acked' })
    assert.equal(harness.store.database.prepare(`
      SELECT pending_outbox_records AS value FROM usage
      WHERE namespace_generation = 1
    `).get()!.value, 0)
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox performs zero writes on pre-abort and keeps post-abort ack success', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    now = FIXTURE_TIMES.updatedAt
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const before = new AbortController()
    before.abort()
    assert.deepEqual(await outbox.execute(claim('aborted-worker', 1), before.signal), {
      status: 'aborted'
    })
    assert.equal(harness.store.database.prepare(`
      SELECT lease_owner_id AS value FROM outbox
    `).get()!.value, null)

    const claimed = await outbox.execute(claim('ack-worker', 1))
    assert.equal(claimed.status, 'claimed')
    if (claimed.status !== 'claimed') assert.fail('claim expected')
    const after = new AbortController()
    const pending = outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'ack-worker',
      leaseToken: claimed.leaseToken,
      eventId: claimed.events[0]!.eventId,
      sequence: claimed.events[0]!.sequence
    }, after.signal)
    after.abort()
    assert.deepEqual(await pending, { status: 'acked' })
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox rolls back ack when canonical event bytes cannot prove the usage delta', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  let now: string = FIXTURE_TIMES.observedAt
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    now = FIXTURE_TIMES.updatedAt
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    const claimed = await outbox.execute(claim('corrupt-worker', 1))
    assert.equal(claimed.status, 'claimed')
    if (claimed.status !== 'claimed') assert.fail('claim expected')
    const bytes = Number(harness.store.database.prepare(`
      SELECT logical_bytes AS value FROM outbox WHERE sequence = 1
    `).get()!.value)
    harness.store.database.prepare(`
      UPDATE outbox SET event_wire = ? WHERE sequence = 1
    `).run('x'.repeat(bytes))

    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'corrupt-worker',
      leaseToken: claimed.leaseToken,
      eventId: claimed.events[0]!.eventId,
      sequence: claimed.events[0]!.sequence
    }), { status: 'corrupt', category: 'canonical_data' })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 1)
    assert.equal(harness.store.database.prepare(`
      SELECT pending_outbox_records AS value FROM global_usage WHERE singleton = 1
    `).get()!.value, 1)
  } finally {
    harness.close()
  }
})

test('sqlite memory outbox audits bounded global and namespace counters before usage and ack', async () => {
  const corruptions = [
    ['global_usage', 'pending_outbox_records', -1],
    ['global_usage', 'pending_outbox_records', 1],
    ['global_usage', 'outbox_logical_bytes', -1],
    ['global_usage', 'outbox_logical_bytes', 1],
    ['usage', 'pending_outbox_records', -1],
    ['usage', 'pending_outbox_records', 1],
    ['usage', 'outbox_logical_bytes', -1],
    ['usage', 'outbox_logical_bytes', 1]
  ] as const
  for (const [table, column, delta] of corruptions) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    let now: string = FIXTURE_TIMES.observedAt
    try {
      assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
      now = FIXTURE_TIMES.updatedAt
      const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
      const claimed = await outbox.execute(claim('counter-audit-worker', 1))
      assert.equal(claimed.status, 'claimed')
      if (claimed.status !== 'claimed') assert.fail('claimed event expected')
      harness.store.database.prepare(`
        UPDATE ${table} SET ${column} = ${column} + ?
        ${table === 'global_usage'
          ? 'WHERE singleton = 1'
          : 'WHERE namespace_ref = ? AND namespace_generation = 1'}
      `).run(...(table === 'global_usage' ? [delta] : [delta, harness.namespaceRef]))

      if (table === 'global_usage') {
        assert.deepEqual(await outbox.execute({ schemaVersion: 1, operation: 'usage' }), {
          status: 'corrupt',
          category: 'canonical_data'
        }, `${table}.${column}.${delta}.usage`)
      }
      assert.deepEqual(await outbox.execute({
        schemaVersion: 1,
        operation: 'ack',
        ownerId: claimed.ownerId,
        leaseToken: claimed.leaseToken,
        eventId: claimed.events[0]!.eventId,
        sequence: claimed.events[0]!.sequence
      }), { status: 'corrupt', category: 'canonical_data' }, `${table}.${column}.${delta}.ack`)
      assert.equal(harness.store.database.prepare(`
        SELECT count(*) AS value FROM outbox WHERE sequence = ?
      `).get(claimed.events[0]!.sequence)!.value, 1, `${table}.${column}.${delta}.row`)
    } finally {
      harness.close()
    }
  }
})

test('sqlite memory outbox event ids distinguish a recreated memory incarnation from a blocked old forget event', async () => {
  let now: string = FIXTURE_TIMES.observedAt
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => now)
  try {
    const outbox = outboxFactory()({ database: harness.store.database, now: () => now })
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    now = FIXTURE_TIMES.updatedAt
    const created = await outbox.execute(claim('incarnation-create-worker', 1))
    assert.equal(created.status, 'claimed')
    if (created.status !== 'claimed') assert.fail('create event expected')
    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: created.ownerId,
      leaseToken: created.leaseToken,
      eventId: created.events[0]!.eventId,
      sequence: created.events[0]!.sequence
    }), { status: 'acked' })

    now = FIXTURE_TIMES.deletedAt
    assert.equal((await harness.repository.execute(forgetRequest(harness, now))).status, 'stored')
    let firstForgottenEventId = ''
    for (let attempt = 1; attempt <= 16; attempt += 1) {
      const forgotten = await outbox.execute(claim('incarnation-retry-worker', 1))
      assert.equal(forgotten.status, 'claimed')
      if (forgotten.status !== 'claimed') assert.fail(`forget attempt ${attempt} expected`)
      firstForgottenEventId = forgotten.events[0]!.eventId
      assert.deepEqual(await outbox.execute({
        schemaVersion: 1,
        operation: 'retry',
        ownerId: forgotten.ownerId,
        leaseToken: forgotten.leaseToken,
        eventId: forgotten.events[0]!.eventId,
        sequence: forgotten.events[0]!.sequence,
        retryAt: now,
        reasonCode: 'downstream_unavailable'
      }), { status: 'retried' })
    }
    assert.deepEqual(await outbox.execute(claim('incarnation-blocked-worker', 1)), {
      status: 'empty'
    })

    now = FIXTURE_TIMES.tombstoneExpiresAt
    assert.deepEqual(purgeExpiredSqliteMemoryTombstonesV1({
      database: harness.store.database,
      namespaceRef: harness.namespaceRef,
      now: () => now
    }), { status: 'purged', processedTombstones: 1, hasMore: false })
    assert.equal((await harness.repository.execute(atTime(
      recordCreateRequestV1(harness),
      now
    ))).status, 'stored')
    const secondForget = forgetRequest(
      harness,
      now,
      'tombstone:incarnation-2'
    )
    assert.equal((await harness.repository.execute(secondForget)).status, 'stored')
    assert.deepEqual(checkpointSqliteMemoryDeletionV1({
      database: harness.store.database,
      tombstone: secondForget.tombstone
    }), {
      schemaVersion: 1,
      logicalDeletion: 'committed',
      payloadDeletion: 'secure_delete_on',
      walCheckpoint: 'truncated',
      derivedCleanup: 'queued'
    })

    const forgottenRows = harness.store.database.prepare(`
      SELECT event_id FROM outbox
      WHERE event_kind = 'record_forgotten'
      ORDER BY sequence ASC
    `).all()
    assert.equal(forgottenRows.length, 2)
    assert.equal(forgottenRows[0]!.event_id, firstForgottenEventId)
    assert.notEqual(forgottenRows[1]!.event_id, firstForgottenEventId)
  } finally {
    harness.close()
  }
})
