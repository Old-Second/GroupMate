import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import {
  openSqliteMemoryDatabaseV2,
  openSqliteMemoryDatabaseV3,
  SqliteMemoryDatabaseErrorV1
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  MEMORY_SQLITE_MIGRATION_V1,
  MEMORY_SQLITE_MIGRATION_V2,
  MEMORY_SQLITE_MIGRATION_V3,
  MEMORY_SQLITE_MIGRATIONS_V3,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V3,
  MEMORY_SQLITE_SCHEMA_VERSION_V3,
  runSqliteMemoryMigrationSequenceV1,
  sqliteMemorySchemaFingerprintV1
} from '../../src/agent/memory/sqlite-memory-migrations.js'

const V2_TIME = '2026-07-25T00:00:00.000Z'
const V3_TIME = '2026-07-25T00:01:00.000Z'

function temporaryDatabasePath (t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-v3-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'memory.sqlite')
}

function pragmaValue (database: DatabaseSync, name: string): SQLOutputValue | undefined {
  const row = database.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

function durableFileState (location: string): Readonly<Record<string, unknown>> {
  const stat = statSync(location, { bigint: true })
  return Object.freeze({
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    hash: createHash('sha256').update(readFileSync(location)).digest('hex')
  })
}

test('sqlite memory v3 fresh bootstrap freezes policy and multi-projector schema', () => {
  assert.equal(MEMORY_SQLITE_SCHEMA_VERSION_V3, 3)
  assert.equal(MEMORY_SQLITE_MIGRATION_V3.version, 3)
  assert.equal(MEMORY_SQLITE_MIGRATIONS_V3.length, 3)
  assert.equal(
    createHash('sha256').update(MEMORY_SQLITE_MIGRATION_V3.sql).digest('hex'),
    MEMORY_SQLITE_MIGRATION_V3.checksum
  )
  const store = openSqliteMemoryDatabaseV3({
    location: ':memory:', now: () => V3_TIME, manifests: []
  })
  try {
    assert.equal(pragmaValue(store.database, 'user_version'), 3)
    assert.equal(
      sqliteMemorySchemaFingerprintV1(store.database),
      MEMORY_SQLITE_SCHEMA_FINGERPRINT_V3
    )
    assert.deepEqual(store.database.prepare(`
      SELECT version, checksum, schema_fingerprint, applied_at
      FROM schema_migrations ORDER BY version ASC
    `).all().map(row => ({ ...row })), MEMORY_SQLITE_MIGRATIONS_V3.map(migration => ({
      version: migration.version,
      checksum: migration.checksum,
      schema_fingerprint: migration.schemaFingerprint,
      applied_at: V3_TIME
    })))
    const tables = store.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all().map(row => String(row.name))
    for (const table of [
      'personal_memory_policies',
      'memory_derivative_jobs',
      'memory_derivative_projectors',
      'memory_derivative_usage'
    ]) assert.ok(tables.includes(table), table)
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE lower(coalesce(sql, '')) LIKE '%fts5%'
        OR name LIKE 'memory_lexical_%'
    `).get()?.count, 0)
    assert.deepEqual(store.database.prepare(`
      SELECT projector_kind, status, projection_generation,
        last_applied_sequence, rebuild_after_sequence, index_fingerprint
      FROM memory_derivative_projectors ORDER BY projector_kind ASC
    `).all().map(row => ({ ...row })), [
      {
        projector_kind: 'lexical',
        status: 'rebuild_required',
        projection_generation: 0,
        last_applied_sequence: 0,
        rebuild_after_sequence: 0,
        index_fingerprint: null
      },
      {
        projector_kind: 'vector',
        status: 'disabled',
        projection_generation: 0,
        last_applied_sequence: 0,
        rebuild_after_sequence: 0,
        index_fingerprint: null
      }
    ])
    assert.deepEqual({ ...store.database.prepare(`
      SELECT queued_records, queued_logical_bytes
      FROM memory_derivative_usage WHERE singleton = 1
    `).get() }, { queued_records: 0, queued_logical_bytes: 0 })
  } finally {
    store.close()
  }
})

test('sqlite memory v3 binds policy generation and keeps independent projector watermarks', () => {
  const store = openSqliteMemoryDatabaseV3({
    location: ':memory:', now: () => V3_TIME, manifests: []
  })
  try {
    const namespaceRef = 'a'.repeat(64)
    store.database.prepare(`
      INSERT INTO namespaces(
        namespace_ref, namespace_wire, namespace_wire_bytes,
        namespace_generation, created_at_ms, updated_at_ms
      ) VALUES (?, '{}', 2, 1, 0, 0)
    `).run(namespaceRef)
    store.database.prepare(`
      INSERT INTO personal_memory_policies(
        namespace_ref, namespace_generation, state, candidate_mode,
        policy_generation, decided_by_actor_ref_hash, decision_source_ref_hash,
        policy_hash, policy_wire, policy_wire_bytes, updated_at_ms
      ) VALUES (?, 1, 'opted_in', 'shadow', 1, ?, ?, ?, '{}', 2, 0)
    `).run(namespaceRef, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    assert.throws(() => store.database.prepare(`
      UPDATE personal_memory_policies SET namespace_generation = 2
      WHERE namespace_ref = ?
    `).run(namespaceRef))

    const inserted = store.database.prepare(`
      INSERT INTO memory_derivative_jobs(
        job_id, namespace_ref, namespace_generation, aggregate_kind,
        aggregate_id, event_kind, memory_revision, revision_hash,
        content_epoch, occurred_at_ms, logical_bytes
      ) VALUES (?, ?, 1, 'record', ?, 'record_upserted', 1, ?, 1, 1, 64)
    `).run('job:shared', namespaceRef, 'memory:one', 'e'.repeat(64))
    const sequence = Number(inserted.lastInsertRowid)
    store.database.prepare(`
      UPDATE memory_derivative_projectors
      SET status = 'ready', projection_generation = 1,
        index_fingerprint = ?, last_applied_sequence = ?,
        rebuild_after_sequence = ?, updated_at_ms = 1
      WHERE projector_kind = 'lexical'
    `).run('f'.repeat(64), sequence, sequence)
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM memory_derivative_jobs
    `).get()?.count, 1)
    assert.deepEqual(store.database.prepare(`
      SELECT projector_kind, status, last_applied_sequence
      FROM memory_derivative_projectors ORDER BY projector_kind ASC
    `).all().map(row => ({ ...row })), [
      { projector_kind: 'lexical', status: 'ready', last_applied_sequence: sequence },
      { projector_kind: 'vector', status: 'disabled', last_applied_sequence: 0 }
    ])
    assert.deepEqual({ ...store.database.prepare(`
      SELECT queued_records, queued_logical_bytes
      FROM memory_derivative_usage WHERE singleton = 1
    `).get() }, { queued_records: 1, queued_logical_bytes: 64 })
    store.database.prepare('DELETE FROM memory_derivative_jobs WHERE sequence = ?')
      .run(sequence)
    assert.deepEqual({ ...store.database.prepare(`
      SELECT queued_records, queued_logical_bytes
      FROM memory_derivative_usage WHERE singleton = 1
    `).get() }, { queued_records: 0, queued_logical_bytes: 0 })
  } finally {
    store.close()
  }
})

test('sqlite memory v3 atomically upgrades v2 and reopens without requesting time', t => {
  const location = temporaryDatabasePath(t)
  const v2 = openSqliteMemoryDatabaseV2({
    location, now: () => V2_TIME, manifests: []
  })
  v2.close()
  const upgraded = openSqliteMemoryDatabaseV3({
    location, now: () => V3_TIME, manifests: []
  })
  upgraded.close()
  const reopened = openSqliteMemoryDatabaseV3({
    location,
    now: () => { throw new Error('reopen must not request migration time') },
    manifests: []
  })
  try {
    assert.equal(pragmaValue(reopened.database, 'user_version'), 3)
    assert.equal(
      sqliteMemorySchemaFingerprintV1(reopened.database),
      MEMORY_SQLITE_SCHEMA_FINGERPRINT_V3
    )
  } finally {
    reopened.close()
  }
})

test('sqlite memory v3 policy and derivative queues enforce fixed capacity and state invariants', () => {
  const store = openSqliteMemoryDatabaseV3({
    location: ':memory:', now: () => V3_TIME, manifests: []
  })
  try {
    const ref = 'a'.repeat(64)
    assert.throws(() => store.database.prepare(`
      INSERT INTO personal_memory_policies(
        namespace_ref, namespace_generation, state, candidate_mode,
        policy_generation, decided_by_actor_ref_hash, decision_source_ref_hash,
        policy_hash, policy_wire, policy_wire_bytes, updated_at_ms
      ) VALUES (?, 1, 'opted_out', 'shadow', 1, ?, ?, ?, '{}', 2, 0)
    `).run(ref, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)))
    assert.throws(() => store.database.prepare(`
      INSERT INTO memory_derivative_jobs(
        job_id, namespace_ref, namespace_generation, aggregate_kind,
        aggregate_id, event_kind, memory_revision, revision_hash,
        content_epoch, occurred_at_ms, logical_bytes
      ) VALUES (?, ?, 1, 'record', ?, 'record_upserted', 1, ?, 1, 0, 1025)
    `).run('job:1', ref, 'memory:1', 'b'.repeat(64)))
    store.database.prepare(`
      UPDATE memory_derivative_usage
      SET queued_records = 8192, queued_logical_bytes = 0
      WHERE singleton = 1
    `).run()
    assert.throws(() => store.database.prepare(`
      INSERT INTO memory_derivative_jobs(
        job_id, namespace_ref, namespace_generation, aggregate_kind,
        aggregate_id, event_kind, memory_revision, revision_hash,
        content_epoch, occurred_at_ms, logical_bytes
      ) VALUES (?, ?, 1, 'record', ?, 'record_upserted', 1, ?, 1, 0, 1)
    `).run('job:2', ref, 'memory:2', 'b'.repeat(64)))
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM memory_derivative_jobs
    `).get()?.count, 0)
    store.database.prepare('DELETE FROM memory_derivative_usage WHERE singleton = 1').run()
    assert.throws(() => store.database.prepare(`
      INSERT INTO memory_derivative_jobs(
        job_id, namespace_ref, namespace_generation, aggregate_kind,
        aggregate_id, event_kind, memory_revision, revision_hash,
        content_epoch, occurred_at_ms, logical_bytes
      ) VALUES (?, ?, 1, 'record', ?, 'record_upserted', 1, ?, 1, 0, 1)
    `).run('job:3', ref, 'memory:3', 'b'.repeat(64)))
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM memory_derivative_jobs
    `).get()?.count, 0)
    assert.throws(() => store.database.prepare(`
      UPDATE memory_derivative_projectors
      SET status = 'ready', projection_generation = 1,
        index_fingerprint = NULL
      WHERE projector_kind = 'lexical'
    `).run())
  } finally {
    store.close()
  }
})

test('sqlite memory v3 migration rollback and reopen reject tampering without repair', t => {
  const rollback = new DatabaseSync(':memory:')
  rollback.exec('PRAGMA foreign_keys = ON')
  runSqliteMemoryMigrationSequenceV1(rollback, {
    migrations: [MEMORY_SQLITE_MIGRATION_V1, MEMORY_SQLITE_MIGRATION_V2],
    appliedAt: V2_TIME
  })
  const broken = Object.freeze({
    ...MEMORY_SQLITE_MIGRATION_V3,
    schemaFingerprint: 'f'.repeat(64)
  })
  assert.throws(() => runSqliteMemoryMigrationSequenceV1(rollback, {
    migrations: [MEMORY_SQLITE_MIGRATION_V1, MEMORY_SQLITE_MIGRATION_V2, broken],
    appliedAt: V3_TIME
  }), TypeError)
  assert.equal(pragmaValue(rollback, 'user_version'), 2)
  assert.equal(sqliteMemorySchemaFingerprintV1(rollback), MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2)
  rollback.close()

  const stateLocation = temporaryDatabasePath(t)
  const valid = openSqliteMemoryDatabaseV3({
    location: stateLocation, now: () => V3_TIME, manifests: []
  })
  valid.database.exec('PRAGMA ignore_check_constraints = ON')
  valid.database.prepare(`
    UPDATE memory_derivative_projectors
    SET status = 'ready', projection_generation = 0
    WHERE projector_kind = 'lexical'
  `).run()
  valid.close()
  assert.throws(() => openSqliteMemoryDatabaseV3({
    location: stateLocation,
    now: () => { throw new Error('state-tampered reopen must not request time') },
    manifests: []
  }), error => error instanceof SqliteMemoryDatabaseErrorV1 &&
    error.code === 'memory_schema_unsupported')

  const location = temporaryDatabasePath(t)
  const store = openSqliteMemoryDatabaseV3({
    location, now: () => V3_TIME, manifests: []
  })
  store.close()
  const attacker = new DatabaseSync(location)
  attacker.exec('CREATE TABLE attacker(value TEXT)')
  attacker.close()
  const before = durableFileState(location)
  assert.throws(() => openSqliteMemoryDatabaseV3({
    location,
    now: () => { throw new Error('tampered reopen must not request time') },
    manifests: []
  }), error => error instanceof SqliteMemoryDatabaseErrorV1 &&
    error.code === 'memory_schema_unsupported')
  assert.deepEqual(durableFileState(location), before)
})
