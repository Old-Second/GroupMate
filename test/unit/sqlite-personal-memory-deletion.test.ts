import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { createSqlitePersonalMemoryDeletionCleanupV1 } from '../../src/agent/memory/sqlite-personal-memory-deletion.js'
import { openSqliteMemoryDatabaseV3 } from '../../src/agent/memory/sqlite-memory-database.js'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import { personalMemoryNamespaceFixture } from '../helpers/memory-fixture.js'

const NOW = '2026-10-29T00:00:00.000Z'
const BOT = 'groupmate-primary'

function harness (t: TestContext) {
  const store = openSqliteMemoryDatabaseV3({ location: ':memory:', now: () => NOW, manifests: [] })
  t.after(() => store.close())
  const rebuilds: string[] = []
  let rebuildFails = false
  const cleanup = createSqlitePersonalMemoryDeletionCleanupV1({
    database: store.database, botInstanceId: BOT, now: () => NOW,
    rebuildLexical: async () => {
      rebuilds.push(NOW)
      if (rebuildFails) throw new Error('lexical index unavailable')
      return rebuilds.length
    }
  })
  return { store, cleanup, rebuilds, failRebuild: () => { rebuildFails = true } }
}

/** Plants the durable rows a logical namespace deletion leaves behind, without a lifecycle command. */
function plantPendingDeletion (database: DatabaseSync, options: Readonly<{
  generation?: number
  deletingGeneration?: number
  corruptNamespaceWire?: boolean
}> = {}): void {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const wire = JSON.stringify(namespace)
  const stored = options.corruptNamespaceWire === true ? `${wire} ` : wire
  database.prepare(`INSERT INTO namespaces(namespace_ref, namespace_wire, namespace_wire_bytes,
      namespace_generation, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(namespaceRef, stored, Buffer.byteLength(wire), options.generation ?? 2,
      Date.parse(NOW), Date.parse(NOW))
  const checkpoint = JSON.stringify({ schemaVersion: 1, namespaceRef, stage: 'logical_committed' })
  database.prepare(`INSERT INTO namespace_deletion_checkpoints(namespace_ref, deletion_ref,
      deleting_generation, observed_current_generation, canonical_bodies, payload_deletion,
      wal_checkpoint, derived_cleanup, stage, receipt_hash, checkpoint_wire, checkpoint_wire_bytes,
      updated_at_ms) VALUES (?, ?, ?, ?, 'scrub_pending', 'secure_delete_on', 'deferred', 'queued',
      'logical_committed', ?, ?, ?, ?)`)
    .run(namespaceRef, `deletion:${'1'.repeat(32)}`, options.deletingGeneration ?? 1,
      options.generation ?? 2, createHash('sha256').update(checkpoint).digest('hex'),
      checkpoint, Buffer.byteLength(checkpoint), Date.parse(NOW))
}

test('a database with no deletion receipt has nothing pending and resumes trivially', async t => {
  const { cleanup, rebuilds } = harness(t)
  assert.equal(cleanup.hasPending(), false)
  assert.equal(await cleanup.resume(), true)
  assert.equal(await cleanup.resume(personalMemoryNamespaceFixture()), true)
  assert.deepEqual(rebuilds, [])
})

test('a planted logical deletion is pending until cleanup finishes', async t => {
  const { store, cleanup } = harness(t)
  plantPendingDeletion(store.database)
  assert.equal(cleanup.hasPending(), true)
})

test('a deletion receipt for another bot instance is never cleaned up here', async t => {
  const store = openSqliteMemoryDatabaseV3({ location: ':memory:', now: () => NOW, manifests: [] })
  t.after(() => store.close())
  const cleanup = createSqlitePersonalMemoryDeletionCleanupV1({
    database: store.database, botInstanceId: 'another-bot-instance', now: () => NOW,
    rebuildLexical: async () => 0
  })
  plantPendingDeletion(store.database)
  assert.equal(await cleanup.resume(), false)
  assert.equal(cleanup.hasPending(), true)
})

test('a namespace wire whose byte count disagrees with the row is refused before parsing', async t => {
  const { store, cleanup, rebuilds } = harness(t)
  plantPendingDeletion(store.database, { corruptNamespaceWire: true })
  assert.equal(await cleanup.resume(), false)
  assert.deepEqual(rebuilds, [])
  assert.equal(cleanup.hasPending(), true)
})

test('a receipt the namespace generation has not moved past is not pending work', async t => {
  const { store, cleanup, rebuilds } = harness(t)
  plantPendingDeletion(store.database, { generation: 2, deletingGeneration: 2 })
  assert.equal(cleanup.hasPending(), false)
  assert.equal(await cleanup.resume(), true)
  assert.deepEqual(rebuilds, [])
})

test('an unreadable checkpoint table reports pending work instead of silence', async t => {
  const { store, cleanup } = harness(t)
  store.database.exec('DROP TABLE namespace_deletion_checkpoints')
  // Fail closed: a deletion that cannot be inspected must never look complete.
  assert.equal(cleanup.hasPending(), true)
  assert.equal(await cleanup.resume(), false)
})
