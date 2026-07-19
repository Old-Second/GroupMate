import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { classifySqliteMemoryErrcodeV1 } from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  approvedProposalV1,
  createSqliteMemoryRepositoryHarnessV1,
  correctedRevisionV1,
  distinctInitialRevisionV1,
  proposalCreateRequestV1,
  proposalDecideRequestV1,
  recordCorrectRequestV1,
  recordCreateRequestV1,
  recordGetRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

test('sqlite memory classifies base and extended SQLite result codes', () => {
  for (const [errcode, expected] of [
    [5, { status: 'unavailable', category: 'busy', retryable: true }],
    [5 | (1 << 8), { status: 'unavailable', category: 'busy', retryable: true }],
    [6 | (2 << 8), { status: 'unavailable', category: 'busy', retryable: true }],
    [10 | (12 << 8), { status: 'unavailable', category: 'io', retryable: true }],
    [11 | (1 << 8), { status: 'corrupt', category: 'canonical_data' }],
    [26, { status: 'corrupt', category: 'canonical_data' }],
    [19 | (8 << 8), { status: 'unavailable', category: 'storage', retryable: false }],
    [0x80000000, { status: 'unavailable', category: 'storage', retryable: false }]
  ] as const) {
    assert.deepEqual(classifySqliteMemoryErrcodeV1(errcode), expected)
  }
})

test('sqlite memory CAS has one winner and stale writers have zero side effects', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const create = recordCreateRequestV1(harness)
    const created = await harness.repository.execute(create)
    const replayed = await harness.repository.execute(create)
    assert.equal(created.status, 'stored')
    assert.equal(replayed.status, 'unchanged')
    assert.equal(
      (created as { readonly receipt: string }).receipt,
      (replayed as { readonly receipt: string }).receipt
    )

    const correction = recordCorrectRequestV1(harness)
    const winner = await harness.repository.execute(correction)
    const replay = await harness.repository.execute(correction)
    assert.equal(winner.status, 'stored')
    assert.equal(replay.status, 'unchanged')

    const thirdRevision = correctedRevisionV1(correctedRevisionV1(), {
      text: '第三版事实',
      updatedAt: '2026-07-19T00:04:00.000Z'
    })
    assert.equal((await harness.repository.execute(
      recordCorrectRequestV1(harness, thirdRevision)
    )).status, 'stored')
    assert.deepEqual(await harness.repository.execute(create), replayed)
    assert.deepEqual(await harness.repository.execute(correction), replay)

    const staleRevision = correctedRevisionV1(undefined, {
      text: '过时写入不能覆盖当前事实',
      updatedAt: '2026-07-19T00:04:00.000Z'
    })
    const stale = await harness.repository.execute(recordCorrectRequestV1(harness, staleRevision))
    assert.deepEqual(stale, { status: 'conflict', category: 'idempotency' })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value, 3)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 3)
    const loaded = await harness.repository.execute(recordGetRequestV1(harness))
    assert.equal(loaded.status, 'found')
    assert.equal((loaded as { readonly value: { readonly revision: number } }).value.revision, 3)
  } finally {
    harness.close()
  }
})

test('sqlite memory approval rolls the first outbox event back when the second event fails', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(proposalCreateRequestV1(harness))
    harness.store.database.exec(`
      CREATE TEMP TRIGGER fail_second_memory_outbox
      BEFORE INSERT ON outbox
      WHEN NEW.event_kind = 'record_upserted'
      BEGIN
        SELECT RAISE(ABORT, 'private-second-event-failure');
      END;
    `)
    assert.deepEqual(
      await harness.repository.execute(proposalDecideRequestV1(harness)),
      { status: 'unavailable', category: 'storage', retryable: false }
    )
    assert.deepEqual(
      { ...harness.store.database.prepare(`
        SELECT revision, state FROM proposals
      `).get() },
      { revision: 1, state: 'pending' }
    )
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 0)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value, 0)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 1)
    assert.equal(harness.store.database.prepare('SELECT seq AS value FROM sqlite_sequence WHERE name = ?').get('outbox')!.value, 1)

    harness.store.database.exec('DROP TRIGGER fail_second_memory_outbox')
    assert.equal(
      (await harness.repository.execute(proposalDecideRequestV1(
        harness,
        approvedProposalV1()
      ))).status,
      'stored'
    )
    assert.deepEqual(
      harness.store.database.prepare('SELECT sequence FROM outbox ORDER BY sequence').all()
        .map(row => ({ ...row })),
      [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]
    )
  } finally {
    harness.close()
  }
})

test('sqlite memory fails closed on a corrupt current revision without falling back', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(recordCreateRequestV1(harness))
    await harness.repository.execute(recordCorrectRequestV1(harness))
    await harness.repository.execute(recordCreateRequestV1(
      harness,
      distinctInitialRevisionV1('healthy-neighbour', '2026-07-19T00:04:00.000Z')
    ))
    harness.store.database.prepare(`
      DELETE FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = 1
        AND memory_id = ? AND revision = 2
    `).run(harness.namespaceRef, 'memory:fixture-1')

    assert.deepEqual(await harness.repository.execute(recordGetRequestV1(harness)), {
      status: 'corrupt',
      category: 'canonical_data'
    })
    const page = await harness.repository.execute({
      schemaVersion: 1,
      operation: 'record.list',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      cursor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(page.status, 'page')
    assert.deepEqual(
      (page as { readonly records: readonly { readonly memoryId: string }[] }).records
        .map(record => record.memoryId),
      ['memory:healthy-neighbour']
    )
    assert.equal((page as { readonly corruptRecords: number }).corruptRecords, 1)
    assert.match(
      (page as { readonly corruptRefs: readonly string[] }).corruptRefs[0]!,
      /^memory-cursor:v1:[0-9a-f]{64}$/
    )
    assert.equal((page as { readonly nextCursor: string | null }).nextCursor, null)
    assert.equal((await harness.repository.execute(recordGetRequestV1(
      harness,
      'memory:healthy-neighbour'
    ))).status, 'found')
  } finally {
    harness.close()
  }
})

test('sqlite memory pagination advances past a corrupt row cursor', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    for (const [suffix, updatedAt] of [
      ['page-a', '2026-07-19T00:05:00.000Z'],
      ['page-b-corrupt', '2026-07-19T00:04:00.000Z'],
      ['page-c', '2026-07-19T00:03:00.000Z']
    ] as const) {
      assert.equal((await harness.repository.execute(recordCreateRequestV1(
        harness,
        distinctInitialRevisionV1(suffix, updatedAt)
      ))).status, 'stored')
    }
    const deletePayload = harness.store.database.prepare(`
      DELETE FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = 1 AND memory_id = ?
    `)
    deletePayload.run(harness.namespaceRef, 'memory:page-a')
    deletePayload.run(harness.namespaceRef, 'memory:page-b-corrupt')

    const first = await harness.repository.execute({
      schemaVersion: 1,
      operation: 'record.list',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      cursor: null,
      limit: 2,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(first.status, 'page')
    assert.deepEqual(
      (first as { readonly records: readonly { readonly memoryId: string }[] }).records
        .map(record => record.memoryId),
      []
    )
    assert.equal((first as { readonly corruptRecords: number }).corruptRecords, 2)
    const cursor = (first as { readonly nextCursor: string | null }).nextCursor
    assert.equal(
      cursor,
      (first as { readonly corruptRefs: readonly string[] }).corruptRefs[1]
    )

    const second = await harness.repository.execute({
      schemaVersion: 1,
      operation: 'record.list',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      cursor,
      limit: 2,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(second.status, 'page')
    assert.deepEqual(
      (second as { readonly records: readonly { readonly memoryId: string }[] }).records
        .map(record => record.memoryId),
      ['memory:page-c']
    )
    assert.equal((second as { readonly corruptRecords: number }).corruptRecords, 0)
    assert.equal((second as { readonly nextCursor: string | null }).nextCursor, null)
  } finally {
    harness.close()
  }
})

test('sqlite memory reports a bounded busy result when another writer owns the lock', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-busy-'))
  const location = path.join(directory, 'memory.sqlite')
  const first = createSqliteMemoryRepositoryHarnessV1(location)
  const second = createSqliteMemoryRepositoryHarnessV1(location)
  try {
    second.store.database.exec('BEGIN IMMEDIATE')
    assert.deepEqual(await first.repository.execute(recordCreateRequestV1(first)), {
      status: 'unavailable',
      category: 'busy',
      retryable: true
    })
    assert.equal(first.store.database.prepare('SELECT count(*) AS value FROM namespaces').get()!.value, 0)
  } finally {
    try {
      second.store.database.exec('ROLLBACK')
    } catch {
      // The lock may already have been released by a failed test assertion.
    }
    second.close()
    first.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sqlite memory rolls every canonical component back when outbox insertion fails', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    harness.store.database.exec(`
      CREATE TEMP TRIGGER fail_memory_outbox
      BEFORE INSERT ON outbox
      BEGIN
        SELECT RAISE(ABORT, 'fixed-test-failure');
      END;
    `)
    const result = await harness.repository.execute(recordCreateRequestV1(harness))
    assert.deepEqual(result, { status: 'unavailable', category: 'storage', retryable: false })
    for (const table of ['heads', 'revisions', 'revision_payloads', 'outbox']) {
      assert.equal(harness.store.database.prepare(`SELECT count(*) AS value FROM ${table}`).get()!.value, 0)
    }
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM namespaces').get()!.value, 0)
    assert.equal(harness.store.database.prepare('SELECT canonical_logical_bytes AS value FROM global_usage').get()!.value, 0)
  } finally {
    harness.close()
  }
})

test('sqlite memory distinguishes abort before execution from commit after abort', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const before = new AbortController()
    before.abort()
    assert.deepEqual(
      await harness.repository.execute(recordCreateRequestV1(harness), before.signal),
      { status: 'aborted' }
    )

    const after = new AbortController()
    const pending = harness.repository.execute(recordCreateRequestV1(harness), after.signal)
    after.abort()
    const committed = await pending
    assert.equal(committed.status, 'committed_after_abort')
    assert.match(
      (committed as { readonly receipt: string }).receipt,
      /^memory-receipt:v1:[0-9a-f]{64}$/
    )
    assert.equal((await harness.repository.execute(recordGetRequestV1(harness))).status, 'found')
  } finally {
    harness.close()
  }
})
