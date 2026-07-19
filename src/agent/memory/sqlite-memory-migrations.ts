import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { invalidMemoryValue } from './memory-namespace.js'

export const MEMORY_SQLITE_APPLICATION_ID_V1 = 0x474d454d
export const MEMORY_SQLITE_SCHEMA_VERSION_V1 = 1
export const MEMORY_SQLITE_SCHEMA_FINGERPRINT_DOMAIN_V1 =
  'groupmate.memory.sqlite-schema.v1'

export interface MemorySqliteMigrationV1 {
  readonly version: number
  readonly sql: string
  readonly checksum: string
  readonly schemaFingerprint: string
}

interface SqliteSchemaObjectV1 {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string
}

interface RunSqliteMemoryMigrationSequenceOptionsV1 {
  readonly migrations: readonly MemorySqliteMigrationV1[]
  readonly appliedAt: string
}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const MAXIMUM_SCHEMA_OBJECTS = 256
const MAXIMUM_SCHEMA_OBJECT_SQL_BYTES = 64 * 1_024
const MAXIMUM_SCHEMA_SQL_BYTES = 1 * 1_024 * 1_024
const NAMESPACE_REF_CHECK = `
  length(namespace_ref) = 64 AND
  namespace_ref = lower(namespace_ref) AND
  namespace_ref NOT GLOB '*[^0-9a-f]*'
`.trim()
const HASH_CHECK = (column: string): string => `
  length(${column}) = 64 AND
  ${column} = lower(${column}) AND
  ${column} NOT GLOB '*[^0-9a-f]*'
`.trim()

const SCHEMA_OBJECTS_V1: readonly SqliteSchemaObjectV1[] = Object.freeze([
  Object.freeze({
    type: 'table' as const,
    name: 'schema_migrations',
    tableName: 'schema_migrations',
    sql: `CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version > 0),
  checksum TEXT NOT NULL CHECK(${HASH_CHECK('checksum')}),
  schema_fingerprint TEXT NOT NULL CHECK(${HASH_CHECK('schema_fingerprint')}),
  applied_at TEXT NOT NULL CHECK(length(applied_at) BETWEEN 20 AND 32)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'namespaces',
    tableName: 'namespaces',
    sql: `CREATE TABLE namespaces(
  namespace_ref TEXT PRIMARY KEY CHECK(${NAMESPACE_REF_CHECK}),
  namespace_wire TEXT NOT NULL CHECK(length(namespace_wire) > 0),
  namespace_wire_bytes INTEGER NOT NULL CHECK(namespace_wire_bytes > 0),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'proposals',
    tableName: 'proposals',
    sql: `CREATE TABLE proposals(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected', 'expired')),
  proposed_at_ms INTEGER NOT NULL CHECK(proposed_at_ms >= 0),
  decided_at_ms INTEGER CHECK(decided_at_ms IS NULL OR decided_at_ms >= proposed_at_ms),
  resulting_memory_id TEXT CHECK(
    resulting_memory_id IS NULL OR length(resulting_memory_id) BETWEEN 1 AND 128
  ),
  resulting_revision INTEGER CHECK(
    resulting_revision IS NULL OR resulting_revision = 1
  ),
  resulting_revision_hash TEXT CHECK(
    resulting_revision_hash IS NULL OR (${HASH_CHECK('resulting_revision_hash')})
  ),
  proposal_wire TEXT NOT NULL CHECK(length(proposal_wire) > 0),
  proposal_wire_bytes INTEGER NOT NULL CHECK(proposal_wire_bytes > 0),
  CHECK(
    (state = 'approved' AND resulting_memory_id IS NOT NULL AND
      resulting_revision IS NOT NULL AND resulting_revision_hash IS NOT NULL) OR
    (state != 'approved' AND resulting_memory_id IS NULL AND
      resulting_revision IS NULL AND resulting_revision_hash IS NULL)
  ),
  PRIMARY KEY(namespace_ref, namespace_generation, proposal_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE,
  FOREIGN KEY(namespace_ref, namespace_generation, resulting_memory_id, resulting_revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'revisions',
    tableName: 'revisions',
    sql: `CREATE TABLE revisions(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  operation TEXT NOT NULL CHECK(operation IN ('created', 'corrected', 'retention_changed', 'conflict_changed')),
  revision_hash TEXT NOT NULL CHECK(${HASH_CHECK('revision_hash')}),
  previous_revision_hash TEXT CHECK(previous_revision_hash IS NULL OR (${HASH_CHECK('previous_revision_hash')})),
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
  revision_wire_bytes INTEGER NOT NULL CHECK(revision_wire_bytes > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id, revision),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'revision_payloads',
    tableName: 'revision_payloads',
    sql: `CREATE TABLE revision_payloads(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  revision_wire TEXT NOT NULL CHECK(length(revision_wire) > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id, revision),
  FOREIGN KEY(namespace_ref, namespace_generation, memory_id, revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'heads',
    tableName: 'heads',
    sql: `CREATE TABLE heads(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  current_revision_hash TEXT NOT NULL CHECK(${HASH_CHECK('current_revision_hash')}),
  content_hash TEXT NOT NULL CHECK(${HASH_CHECK('content_hash')}),
  cursor_ref TEXT NOT NULL CHECK(
    length(cursor_ref) = 64 AND
    cursor_ref = lower(cursor_ref) AND
    cursor_ref NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  valid_until_ms INTEGER NOT NULL CHECK(valid_until_ms >= 0),
  purge_at_ms INTEGER NOT NULL CHECK(purge_at_ms >= valid_until_ms),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id),
  FOREIGN KEY(namespace_ref, namespace_generation, memory_id, current_revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'tombstones',
    tableName: 'tombstones',
    sql: `CREATE TABLE tombstones(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  tombstone_id TEXT NOT NULL CHECK(length(tombstone_id) BETWEEN 1 AND 128),
  memory_id TEXT CHECK(memory_id IS NULL OR length(memory_id) BETWEEN 1 AND 128),
  deleted_revision INTEGER CHECK(deleted_revision IS NULL OR deleted_revision > 0),
  deletion_kind TEXT NOT NULL CHECK(deletion_kind IN ('memory_forgotten', 'namespace_deleted')),
  deleted_at_ms INTEGER NOT NULL CHECK(deleted_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > deleted_at_ms),
  receipt_hash TEXT NOT NULL CHECK(${HASH_CHECK('receipt_hash')}),
  tombstone_wire TEXT NOT NULL CHECK(length(tombstone_wire) > 0),
  tombstone_wire_bytes INTEGER NOT NULL CHECK(tombstone_wire_bytes > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, tombstone_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'usage',
    tableName: 'usage',
    sql: `CREATE TABLE usage(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  pending_proposal_records INTEGER NOT NULL CHECK(pending_proposal_records >= 0),
  active_memory_records INTEGER NOT NULL CHECK(active_memory_records >= 0),
  retained_revision_records INTEGER NOT NULL CHECK(retained_revision_records >= 0),
  tombstone_records INTEGER NOT NULL CHECK(tombstone_records >= 0),
  canonical_logical_bytes INTEGER NOT NULL CHECK(canonical_logical_bytes >= 0),
  pending_outbox_records INTEGER NOT NULL CHECK(pending_outbox_records >= 0),
  outbox_logical_bytes INTEGER NOT NULL CHECK(outbox_logical_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(namespace_ref, namespace_generation),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'global_usage',
    tableName: 'global_usage',
    sql: `CREATE TABLE global_usage(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  namespace_records INTEGER NOT NULL CHECK(namespace_records >= 0),
  active_memory_records INTEGER NOT NULL CHECK(active_memory_records >= 0),
  canonical_logical_bytes INTEGER NOT NULL CHECK(canonical_logical_bytes >= 0),
  pending_outbox_records INTEGER NOT NULL CHECK(pending_outbox_records >= 0),
  outbox_logical_bytes INTEGER NOT NULL CHECK(outbox_logical_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'outbox',
    tableName: 'outbox',
    sql: `CREATE TABLE outbox(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  aggregate TEXT NOT NULL CHECK(aggregate IN ('proposal', 'record', 'namespace')),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('proposal_changed', 'record_upserted', 'record_forgotten', 'namespace_deleted')),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= occurred_at_ms),
  event_wire TEXT NOT NULL CHECK(length(event_wire) > 0),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes > 0),
  lease_owner_id TEXT,
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) = 80),
  leased_until_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_reason_code TEXT,
  CHECK(
    (lease_owner_id IS NULL AND lease_token IS NULL AND leased_until_ms IS NULL) OR
    (lease_owner_id IS NOT NULL AND lease_token IS NOT NULL AND leased_until_ms IS NOT NULL)
  ),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_proposals_pending_v1',
    tableName: 'proposals',
    sql: `CREATE INDEX memory_proposals_pending_v1
ON proposals(namespace_ref ASC, namespace_generation ASC, state ASC, proposed_at_ms ASC, proposal_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_revisions_hash_v1',
    tableName: 'revisions',
    sql: `CREATE UNIQUE INDEX memory_revisions_hash_v1
ON revisions(namespace_ref ASC, namespace_generation ASC, revision_hash ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_proposals_resulting_memory_v1',
    tableName: 'proposals',
    sql: `CREATE INDEX memory_proposals_resulting_memory_v1
ON proposals(namespace_ref ASC, namespace_generation ASC, resulting_memory_id ASC,
  resulting_revision ASC, proposal_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_cursor_ref_v1',
    tableName: 'heads',
    sql: `CREATE UNIQUE INDEX memory_heads_cursor_ref_v1
ON heads(cursor_ref ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_seek_v1',
    tableName: 'heads',
    sql: `CREATE INDEX memory_heads_seek_v1
ON heads(namespace_ref ASC, namespace_generation ASC, updated_at_ms DESC, memory_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_purge_v1',
    tableName: 'heads',
    sql: `CREATE INDEX memory_heads_purge_v1
ON heads(namespace_ref ASC, namespace_generation ASC, purge_at_ms ASC, memory_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_active_memory_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_active_memory_v1
ON tombstones(namespace_ref ASC, namespace_generation ASC, memory_id ASC,
  deletion_kind ASC, expires_at_ms ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_active_namespace_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_active_namespace_v1
ON tombstones(namespace_ref ASC, namespace_generation ASC, deletion_kind ASC,
  expires_at_ms ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_expiry_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_expiry_v1
ON tombstones(namespace_ref ASC, expires_at_ms ASC, namespace_generation ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_event_id_v1',
    tableName: 'outbox',
    sql: `CREATE UNIQUE INDEX memory_outbox_event_id_v1
ON outbox(event_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_available_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_available_v1
ON outbox(available_at_ms ASC, sequence ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_namespace_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_namespace_v1
ON outbox(namespace_ref ASC, namespace_generation ASC, sequence ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_lease_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_lease_v1
ON outbox(lease_owner_id ASC, leased_until_ms ASC, sequence ASC)`
  })
])

function sha256 (value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fingerprintRows (rows: readonly SqliteSchemaObjectV1[]): string {
  const canonicalRows = [...rows]
    .sort((left, right) => (
      left.type < right.type
        ? -1
        : left.type > right.type
          ? 1
          : left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : 0
    ))
    .map(row => ({
      type: row.type,
      name: row.name,
      tableName: row.tableName,
      sql: row.sql
    }))
  return createHash('sha256')
    .update(MEMORY_SQLITE_SCHEMA_FINGERPRINT_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(canonicalRows), 'utf8')
    .digest('hex')
}

export const MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1 = fingerprintRows(SCHEMA_OBJECTS_V1)

const INITIAL_DATA_SQL_V1 = `INSERT INTO global_usage(
  singleton,
  namespace_records,
  active_memory_records,
  canonical_logical_bytes,
  pending_outbox_records,
  outbox_logical_bytes,
  updated_at_ms
) VALUES (1, 0, 0, 0, 0, 0, 0)`

const MIGRATION_SQL_V1 = `${[
  ...SCHEMA_OBJECTS_V1.map(value => value.sql),
  INITIAL_DATA_SQL_V1
].map(value => `${value};`).join('\n')}\n`

export const MEMORY_SQLITE_MIGRATION_V1: MemorySqliteMigrationV1 = Object.freeze({
  version: 1,
  sql: MIGRATION_SQL_V1,
  checksum: sha256(MIGRATION_SQL_V1),
  schemaFingerprint: MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1
})

function schemaRowsFromDatabase (database: DatabaseSync): readonly SqliteSchemaObjectV1[] {
  const rows = database.prepare(`
    WITH bounded_schema AS (
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY type ASC, name ASC
      LIMIT ${MAXIMUM_SCHEMA_OBJECTS + 1}
    ), measured_schema AS (
      SELECT
        type,
        name,
        tbl_name,
        sql,
        length(CAST(sql AS BLOB)) AS sql_bytes,
        count(*) OVER () AS object_count,
        sum(length(CAST(sql AS BLOB))) OVER () AS total_sql_bytes
      FROM bounded_schema
    )
    SELECT
      type,
      name,
      tbl_name,
      sql_bytes,
      object_count,
      total_sql_bytes,
      CASE
        WHEN object_count <= ${MAXIMUM_SCHEMA_OBJECTS}
          AND sql_bytes <= ${MAXIMUM_SCHEMA_OBJECT_SQL_BYTES}
          AND total_sql_bytes <= ${MAXIMUM_SCHEMA_SQL_BYTES}
        THEN sql
        ELSE NULL
      END AS sql
    FROM measured_schema
    ORDER BY type ASC, name ASC
  `).all()
  if (rows.length > MAXIMUM_SCHEMA_OBJECTS) return invalidMemoryValue()
  let totalSqlBytes = 0
  return rows.map(row => {
    if (typeof row.type !== 'string' || typeof row.name !== 'string' ||
      typeof row.tbl_name !== 'string' ||
      typeof row.sql !== 'string' || typeof row.sql_bytes !== 'number' ||
      !Number.isSafeInteger(row.sql_bytes) || row.sql_bytes < 0 ||
      row.object_count !== rows.length || typeof row.total_sql_bytes !== 'number' ||
      !Number.isSafeInteger(row.total_sql_bytes) || row.total_sql_bytes < 0) {
      return invalidMemoryValue()
    }
    const sqlBytes = Buffer.byteLength(row.sql, 'utf8')
    totalSqlBytes += sqlBytes
    if (sqlBytes !== row.sql_bytes || sqlBytes > MAXIMUM_SCHEMA_OBJECT_SQL_BYTES ||
      totalSqlBytes > MAXIMUM_SCHEMA_SQL_BYTES ||
      row.total_sql_bytes > MAXIMUM_SCHEMA_SQL_BYTES) return invalidMemoryValue()
    return Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql
    })
  })
}

export function sqliteMemorySchemaFingerprintV1 (database: DatabaseSync): string {
  return fingerprintRows(schemaRowsFromDatabase(database))
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function exactObject (
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidMemoryValue()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => (
    typeof key !== 'string' || !keys.includes(key)
  ))) return invalidMemoryValue()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return invalidMemoryValue()
    result[key] = descriptor.value
  }
  return result
}

function parseMigration (value: unknown, expectedVersion: number): MemorySqliteMigrationV1 {
  const input = exactObject(value, ['version', 'sql', 'checksum', 'schemaFingerprint'])
  if (input.version !== expectedVersion || typeof input.sql !== 'string' ||
    input.sql.startsWith('\uFEFF') || input.sql.includes('\r') || !input.sql.endsWith('\n') ||
    typeof input.checksum !== 'string' || !HASH_PATTERN.test(input.checksum) ||
    sha256(input.sql) !== input.checksum ||
    typeof input.schemaFingerprint !== 'string' ||
    !HASH_PATTERN.test(input.schemaFingerprint)) return invalidMemoryValue()
  return Object.freeze({
    version: expectedVersion,
    sql: input.sql,
    checksum: input.checksum,
    schemaFingerprint: input.schemaFingerprint
  })
}

function parseMigrationSequence (
  value: unknown
): readonly MemorySqliteMigrationV1[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > 32) {
    return invalidMemoryValue()
  }
  return Object.freeze(value.map((migration, index) => parseMigration(migration, index + 1)))
}

function pragmaNumber (database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalidMemoryValue()
  return value
}

function validateAppliedMigrations (
  database: DatabaseSync,
  currentVersion: number,
  migrations: readonly MemorySqliteMigrationV1[]
): void {
  const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 33
  `).all()
  if (rows.length !== currentVersion) return invalidMemoryValue()
  rows.forEach((row, index) => {
    const migration = migrations[index]
    if (migration === undefined || row.version !== migration.version ||
      row.checksum !== migration.checksum ||
      row.schema_fingerprint !== migration.schemaFingerprint) {
      return invalidMemoryValue()
    }
    canonicalInstant(row.applied_at)
  })
}

export function runSqliteMemoryMigrationSequenceV1 (
  database: DatabaseSync,
  optionsValue: RunSqliteMemoryMigrationSequenceOptionsV1
): void {
  const options = exactObject(optionsValue, ['migrations', 'appliedAt'])
  const migrations = parseMigrationSequence(options.migrations)
  const appliedAt = canonicalInstant(options.appliedAt)

  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const applicationId = pragmaNumber(database, 'application_id')
    const currentVersion = pragmaNumber(database, 'user_version')
    if (currentVersion < 0 || currentVersion > migrations.length ||
      (currentVersion === 0 && applicationId !== 0) ||
      (currentVersion > 0 && applicationId !== MEMORY_SQLITE_APPLICATION_ID_V1)) {
      return invalidMemoryValue()
    }
    if (currentVersion > 0) {
      validateAppliedMigrations(database, currentVersion, migrations)
      const currentMigration = migrations[currentVersion - 1]
      if (currentMigration === undefined ||
        sqliteMemorySchemaFingerprintV1(database) !== currentMigration.schemaFingerprint) {
        return invalidMemoryValue()
      }
    }
    for (const migration of migrations.slice(currentVersion)) {
      database.exec(migration.sql)
      if (sqliteMemorySchemaFingerprintV1(database) !== migration.schemaFingerprint) {
        return invalidMemoryValue()
      }
      const insert = database.prepare(`
        INSERT INTO schema_migrations(version, checksum, schema_fingerprint, applied_at)
        VALUES (?, ?, ?, ?)
      `)
      insert.setAllowBareNamedParameters(false)
      insert.run(
        migration.version,
        migration.checksum,
        migration.schemaFingerprint,
        appliedAt
      )
      database.exec(`
        PRAGMA application_id = ${MEMORY_SQLITE_APPLICATION_ID_V1};
        PRAGMA user_version = ${migration.version};
      `)
    }
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The original fixed migration failure remains authoritative.
      }
    }
    throw error
  }
}
