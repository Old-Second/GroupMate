import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { decodeMemoryOutboxEventV1 } from '../../src/agent/memory/memory-codec.js'
import { createMemoryNamespaceV1 } from '../../src/agent/memory/memory-namespace.js'
import {
  FIXTURE_IDS,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture
} from '../helpers/memory-fixture.js'
import {
  approvedProposalV1,
  createSqliteMemoryRepositoryHarnessV1,
  correctedRevisionV1,
  distinctInitialRevisionV1,
  proposalCreateRequestV1,
  proposalDecideRequestV1,
  recordCorrectRequestV1,
  recordCreateRequestV1,
  recordGetRequestV1,
  recordListRequestV1,
  rejectedProposalV1,
  usageGetRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

test('sqlite memory repository stores and reloads idempotent proposals with stable receipts', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    assert.deepEqual(await harness.repository.execute(usageGetRequestV1(harness)), {
      status: 'not_found'
    })
    const request = proposalCreateRequestV1(harness)
    const first = await harness.repository.execute(request)
    const second = await harness.repository.execute(request)
    assert.equal(first.status, 'stored')
    assert.equal(second.status, 'unchanged')
    assert.equal(
      (first as { readonly receipt: string }).receipt,
      (second as { readonly receipt: string }).receipt
    )
    assert.match((first as { readonly receipt: string }).receipt, /^memory-receipt:v1:[0-9a-f]{64}$/)

    const loaded = await harness.repository.execute({
      schemaVersion: 1,
      operation: 'proposal.load',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      proposalId: FIXTURE_IDS.proposalId
    })
    assert.deepEqual(loaded, { status: 'found', value: memoryProposalFixture() })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 1)
  } finally {
    harness.close()
  }
})

test('sqlite memory repository atomically approves or declines a proposal', async () => {
  for (const approved of [true, false]) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      await harness.repository.execute(proposalCreateRequestV1(harness))
      const decision = approved ? approvedProposalV1() : rejectedProposalV1()
      const result = await harness.repository.execute(proposalDecideRequestV1(
        harness,
        decision,
        approved ? undefined : null
      ))
      assert.equal(result.status, 'stored')
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM proposals').get()!.value, 1)
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, approved ? 1 : 0)
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value, approved ? 1 : 0)
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revision_payloads').get()!.value, approved ? 1 : 0)
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, approved ? 3 : 2)
      const proposalBinding = harness.store.database.prepare(`
        SELECT resulting_memory_id, resulting_revision, resulting_revision_hash FROM proposals
      `).get()
      assert.deepEqual({ ...proposalBinding }, approved
        ? {
            resulting_memory_id: FIXTURE_IDS.memoryId,
            resulting_revision: 1,
            resulting_revision_hash: memoryRevisionFixture().revisionHash
          }
        : {
            resulting_memory_id: null,
            resulting_revision: null,
            resulting_revision_hash: null
          })
      const outboxRows = harness.store.database.prepare(`
        SELECT sequence, event_wire, logical_bytes FROM outbox ORDER BY sequence ASC
      `).all()
      for (const row of outboxRows) {
        const wire = String(row.event_wire)
        const event = decodeMemoryOutboxEventV1(wire)
        assert.equal(event.sequence, row.sequence)
        assert.equal(Buffer.byteLength(wire, 'utf8'), row.logical_bytes)
        assert.equal(wire.includes('喜欢无糖咖啡'), false)
        assert.equal(wire.includes('群友甲'), false)
        assert.equal(wire.includes('normalizedText'), false)
      }
      assert.deepEqual(
        await harness.repository.execute(recordGetRequestV1(harness)),
        approved
          ? { status: 'found', value: memoryRecordFixture() }
          : { status: 'not_found' }
      )
    } finally {
      harness.close()
    }
  }
})

test('sqlite memory approved proposal is immutably bound to its original memory revision', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(proposalCreateRequestV1(harness))
    assert.equal((await harness.repository.execute(proposalDecideRequestV1(harness))).status, 'stored')

    const alternateRecord = memoryRecordFixture({ memoryId: 'memory:alternate-binding' })
    const alternateRevision = memoryRevisionFixture({
      memoryId: alternateRecord.memoryId,
      record: alternateRecord
    })
    assert.deepEqual(await harness.repository.execute(proposalDecideRequestV1(
      harness,
      approvedProposalV1(),
      alternateRevision
    )), {
      status: 'conflict',
      category: 'idempotency'
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 1)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value, 1)
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM outbox').get()!.value, 3)
  } finally {
    harness.close()
  }
})

test('sqlite memory rejects a corrupted approved proposal revision binding', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(proposalCreateRequestV1(harness))
    assert.equal((await harness.repository.execute(proposalDecideRequestV1(harness))).status, 'stored')
    harness.store.database.prepare(`
      UPDATE proposals SET resulting_revision_hash = ? WHERE proposal_id = ?
    `).run('f'.repeat(64), FIXTURE_IDS.proposalId)

    assert.deepEqual(await harness.repository.execute({
      schemaVersion: 1,
      operation: 'proposal.load',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      proposalId: FIXTURE_IDS.proposalId
    }), {
      status: 'corrupt',
      category: 'canonical_data'
    })
  } finally {
    harness.close()
  }
})

test('sqlite memory rejects a coherent proposal binding to a different legal revision', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(proposalCreateRequestV1(harness))
    assert.equal((await harness.repository.execute(proposalDecideRequestV1(harness))).status, 'stored')
    const alternateRecord = memoryRecordFixture({
      memoryId: 'memory:coherent-corrupt-binding',
      text: '这是另一条合法但未被当前 proposal 批准的事实'
    })
    const alternateRevision = memoryRevisionFixture({
      memoryId: alternateRecord.memoryId,
      record: alternateRecord
    })
    assert.equal((await harness.repository.execute(recordCreateRequestV1(
      harness,
      alternateRevision
    ))).status, 'stored')
    harness.store.database.prepare(`
      UPDATE proposals
      SET resulting_memory_id = ?, resulting_revision = ?, resulting_revision_hash = ?
      WHERE proposal_id = ?
    `).run(
      alternateRevision.memoryId,
      alternateRevision.revision,
      alternateRevision.revisionHash,
      FIXTURE_IDS.proposalId
    )

    assert.deepEqual(await harness.repository.execute({
      schemaVersion: 1,
      operation: 'proposal.load',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      proposalId: FIXTURE_IDS.proposalId
    }), {
      status: 'corrupt',
      category: 'canonical_data'
    })
  } finally {
    harness.close()
  }
})

test('sqlite memory proposal create receipt remains stable after decision and reopen', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-receipt-'))
  const location = path.join(directory, 'memory.sqlite')
  let harness = createSqliteMemoryRepositoryHarnessV1(location)
  try {
    const request = proposalCreateRequestV1(harness)
    const created = await harness.repository.execute(request)
    assert.equal(created.status, 'stored')
    const receipt = (created as { readonly receipt: string }).receipt
    assert.equal(
      (await harness.repository.execute(proposalDecideRequestV1(harness))).status,
      'stored'
    )
    const terminalReplay = await harness.repository.execute(request)
    assert.deepEqual(terminalReplay, {
      status: 'unchanged',
      value: memoryProposalFixture(),
      receipt
    })
    harness.close()

    harness = createSqliteMemoryRepositoryHarnessV1(location)
    assert.deepEqual(await harness.repository.execute(proposalCreateRequestV1(harness)), {
      status: 'unchanged',
      value: memoryProposalFixture(),
      receipt
    })
  } finally {
    harness.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sqlite memory cursor survives reopen and rejects unknown, stale and cross-scope cursors', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-repository-'))
  const location = path.join(directory, 'memory.sqlite')
  let first = createSqliteMemoryRepositoryHarnessV1(location)
  try {
    for (const [suffix, updatedAt] of [
      ['cursor-a', '2026-07-19T00:05:00.000Z'],
      ['cursor-b', '2026-07-19T00:04:00.000Z'],
      ['cursor-c', '2026-07-19T00:03:00.000Z']
    ] as const) {
      await first.repository.execute(recordCreateRequestV1(
        first,
        distinctInitialRevisionV1(suffix, updatedAt)
      ))
    }
    const page = await first.repository.execute(recordListRequestV1(first, null, 2))
    assert.equal(page.status, 'page')
    const cursor = (page as { readonly nextCursor: string | null }).nextCursor
    assert.match(cursor!, /^memory-cursor:v1:[0-9a-f]{64}$/)
    first.close()

    first = createSqliteMemoryRepositoryHarnessV1(location)
    const next = await first.repository.execute(recordListRequestV1(first, cursor, 2))
    assert.equal(next.status, 'page')
    assert.deepEqual(
      (next as { readonly records: readonly { readonly memoryId: string }[] }).records.map(value => value.memoryId),
      ['memory:cursor-c']
    )
    assert.deepEqual(
      await first.repository.execute(recordListRequestV1(
        first,
        `memory-cursor:v1:${'f'.repeat(64)}`,
        2
      )),
      { status: 'invalid_cursor' }
    )

    const otherNamespace = createMemoryNamespaceV1({
      botInstanceId: FIXTURE_IDS.botInstanceId,
      adapter: 'qq',
      accountId: FIXTURE_IDS.accountId,
      scope: { kind: 'personal', subjectUserId: FIXTURE_IDS.secondUserId }
    })
    const other = createSqliteMemoryRepositoryHarnessV1(
      location,
      undefined,
      otherNamespace
    )
    try {
      for (const [suffix, updatedAt] of [
        ['other-a', '2026-07-19T00:07:00.000Z'],
        ['other-b', '2026-07-19T00:06:00.000Z']
      ] as const) {
        assert.equal((await other.repository.execute(recordCreateRequestV1(
          other,
          distinctInitialRevisionV1(suffix, updatedAt, otherNamespace)
        ))).status, 'stored')
      }
      const otherPage = await other.repository.execute(recordListRequestV1(other, null, 1))
      assert.equal(otherPage.status, 'page')
      const crossScopeCursor = (otherPage as { readonly nextCursor: string | null }).nextCursor
      assert.notEqual(crossScopeCursor, null)
      assert.deepEqual(
        await first.repository.execute(recordListRequestV1(first, crossScopeCursor, 2)),
        { status: 'invalid_cursor' }
      )
    } finally {
      other.close()
    }

    first.store.database.prepare(`
      UPDATE heads SET cursor_ref = ? WHERE memory_id = ?
    `).run('e'.repeat(64), 'memory:cursor-b')
    assert.deepEqual(
      await first.repository.execute(recordListRequestV1(first, cursor, 2)),
      { status: 'invalid_cursor' }
    )
  } finally {
    first.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sqlite memory seek cursor orders equal timestamps and becomes stale after correction', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const revisions = ['equal-a', 'equal-b', 'equal-c'].map(suffix => (
      distinctInitialRevisionV1(suffix, '2026-07-19T00:05:00.000Z')
    ))
    for (const revision of revisions) {
      assert.equal((await harness.repository.execute(
        recordCreateRequestV1(harness, revision)
      )).status, 'stored')
    }
    const first = await harness.repository.execute(recordListRequestV1(harness, null, 2))
    assert.equal(first.status, 'page')
    assert.deepEqual(
      (first as { readonly records: readonly { readonly memoryId: string }[] }).records
        .map(record => record.memoryId),
      ['memory:equal-a', 'memory:equal-b']
    )
    const cursor = (first as { readonly nextCursor: string | null }).nextCursor
    const second = await harness.repository.execute(recordListRequestV1(harness, cursor, 2))
    assert.deepEqual(
      (second as { readonly records: readonly { readonly memoryId: string }[] }).records
        .map(record => record.memoryId),
      ['memory:equal-c']
    )

    const firstOnly = await harness.repository.execute(recordListRequestV1(harness, null, 1))
    const staleCursor = (firstOnly as { readonly nextCursor: string | null }).nextCursor
    const corrected = correctedRevisionV1(revisions[0]!, {
      memoryId: 'memory:equal-a',
      updatedAt: '2026-07-19T00:06:00.000Z'
    })
    assert.equal((await harness.repository.execute(
      recordCorrectRequestV1(harness, corrected)
    )).status, 'stored')
    assert.deepEqual(
      await harness.repository.execute(recordListRequestV1(harness, staleCursor, 2)),
      { status: 'invalid_cursor' }
    )
  } finally {
    harness.close()
  }
})
