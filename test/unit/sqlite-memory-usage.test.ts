import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  encodeMemoryProposalV1,
  encodeMemoryRevisionV1
} from '../../src/agent/memory/memory-codec.js'
import { memoryNamespaceWireV1 } from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  memoryProposalFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'
import {
  createSqliteMemoryRepositoryHarnessV1,
  correctedRevisionV1,
  proposalCreateRequestV1,
  recordCorrectRequestV1,
  recordCreateRequestV1,
  usageGetRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

test('sqlite memory usage is transactionally maintained without aggregate scans', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    await harness.repository.execute(proposalCreateRequestV1(harness))
    await harness.repository.execute(recordCreateRequestV1(harness))
    const usage = await harness.repository.execute(usageGetRequestV1(harness))
    assert.equal(usage.status, 'usage')
    if (usage.status !== 'usage') assert.fail('usage result expected')
    const value = usage.value
    assert.equal(value.namespaceGeneration, 1)
    assert.equal(value.pendingProposalRecords, 1)
    assert.equal(value.activeMemoryRecords, 1)
    assert.equal(value.retainedRevisionRecords, 1)
    assert.equal(value.tombstoneRecords, 0)
    assert.equal(value.pendingOutboxRecords, 2)
    const expectedCanonicalBytes = [
      memoryNamespaceWireV1(personalMemoryNamespaceFixture()),
      encodeMemoryProposalV1(memoryProposalFixture()),
      encodeMemoryRevisionV1(memoryRevisionFixture())
    ].reduce((total, wire) => total + Buffer.byteLength(wire, 'utf8'), 0)
    assert.equal(value.canonicalLogicalBytes, expectedCanonicalBytes)
    const outboxBytes = harness.store.database.prepare(`
      SELECT logical_bytes FROM outbox ORDER BY sequence
    `).all().reduce((total, row) => total + Number(row.logical_bytes), 0)
    assert.equal(value.outboxLogicalBytes, outboxBytes)
    assert.deepEqual({ ...harness.store.database.prepare(`
      SELECT namespace_records, active_memory_records, canonical_logical_bytes,
             pending_outbox_records, outbox_logical_bytes
      FROM global_usage WHERE singleton = 1
    `).get() }, {
      namespace_records: 1,
      active_memory_records: 1,
      canonical_logical_bytes: expectedCanonicalBytes,
      pending_outbox_records: 2,
      outbox_logical_bytes: outboxBytes
    })

    const queryPlan = harness.store.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT namespace_ref, namespace_generation, pending_proposal_records,
             active_memory_records, retained_revision_records, tombstone_records,
             canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes
      FROM usage
      WHERE namespace_ref = ? AND namespace_generation = ?
    `).all(harness.namespaceRef, 1)
    assert.equal(queryPlan.some(row => String(row.detail).includes('SCAN usage')), false)
  } finally {
    harness.close()
  }
})

test('sqlite memory enforces the per-memory revision 32 to 33 boundary', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    let current = memoryRevisionFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness, current))).status, 'stored')
    for (let revision = 2; revision <= 32; revision += 1) {
      const minute = String(revision + 1).padStart(2, '0')
      const next = correctedRevisionV1(current, {
        text: `修订事实 ${revision}`,
        updatedAt: `2026-07-19T00:${minute}:00.000Z`
      })
      assert.equal((await harness.repository.execute(
        recordCorrectRequestV1(harness, next)
      )).status, 'stored')
      current = next
    }
    const overflow = correctedRevisionV1(current, {
      text: '第 33 个修订必须被拒绝',
      updatedAt: '2026-07-19T00:34:00.000Z'
    })
    assert.deepEqual(await harness.repository.execute(
      recordCorrectRequestV1(harness, overflow)
    ), {
      status: 'capacity',
      category: 'retained_revisions'
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM revisions').get()!.value, 32)
  } finally {
    harness.close()
  }
})

test('sqlite memory rejects the deployment namespace projected +1 without creating a row', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    harness.store.database.prepare(`
      UPDATE global_usage SET namespace_records = 4096 WHERE singleton = 1
    `).run()
    assert.deepEqual(await harness.repository.execute(recordCreateRequestV1(harness)), {
      status: 'capacity',
      category: 'namespaces'
    })
    assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM namespaces').get()!.value, 0)
  } finally {
    harness.close()
  }
})

test('sqlite memory enforces namespace, deployment, revision and outbox +1 budgets', async () => {
  for (const [column, value, expectedCategory] of [
    ['active_memory_records', 4_096, 'active_records'],
    ['canonical_logical_bytes', 64 * 1_024 * 1_024, 'canonical_bytes'],
    ['pending_outbox_records', 4_096, 'outbox_records'],
    ['outbox_logical_bytes', 16 * 1_024 * 1_024, 'outbox_bytes']
  ] as const) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      await harness.repository.execute(proposalCreateRequestV1(harness))
      harness.store.database.prepare(`UPDATE usage SET ${column} = ?`).run(value)
      if (column === 'active_memory_records' || column === 'canonical_logical_bytes') {
        harness.store.database.prepare(`UPDATE global_usage SET ${column} = ?`).run(value)
      } else {
        harness.store.database.prepare(`UPDATE global_usage SET ${column} = ?`).run(value)
      }
      const result = await harness.repository.execute(recordCreateRequestV1(harness))
      assert.deepEqual(result, { status: 'capacity', category: expectedCategory })
      assert.equal(harness.store.database.prepare('SELECT count(*) AS value FROM heads').get()!.value, 0)
    } finally {
      harness.close()
    }
  }
})

test('sqlite memory independently enforces global and pending proposal +1 budgets', async () => {
  for (const [setup, request, expectedCategory] of [
    [
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        harness.store.database.prepare(`
          UPDATE usage SET active_memory_records = 0
        `).run()
        harness.store.database.prepare(`
          UPDATE global_usage SET active_memory_records = ? WHERE singleton = 1
        `).run(MEMORY_RESOURCE_LIMITS.deploymentActiveRecords)
      },
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => (
        recordCreateRequestV1(harness)
      ),
      'active_records'
    ],
    [
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        harness.store.database.prepare(`
          UPDATE usage SET canonical_logical_bytes = 0
        `).run()
        harness.store.database.prepare(`
          UPDATE global_usage SET canonical_logical_bytes = ? WHERE singleton = 1
        `).run(MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes)
      },
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => (
        recordCreateRequestV1(harness)
      ),
      'canonical_bytes'
    ],
    [
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => {
        harness.store.database.prepare(`
          UPDATE usage SET pending_proposal_records = ?
        `).run(MEMORY_RESOURCE_LIMITS.namespacePendingProposals)
      },
      (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>) => (
        proposalCreateRequestV1(harness, memoryProposalFixture({
          proposalId: 'proposal:pending-overflow'
        }))
      ),
      'pending_proposals'
    ]
  ] as const) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      assert.equal(
        (await harness.repository.execute(proposalCreateRequestV1(harness))).status,
        'stored'
      )
      setup(harness)
      assert.deepEqual(await harness.repository.execute(request(harness)), {
        status: 'capacity',
        category: expectedCategory
      })
    } finally {
      harness.close()
    }
  }
})
