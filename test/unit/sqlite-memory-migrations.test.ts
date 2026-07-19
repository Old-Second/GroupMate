import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import {
  MEMORY_SQLITE_APPLICATION_ID_V1,
  MEMORY_SQLITE_SCHEMA_VERSION_V1,
  SqliteMemoryDatabaseErrorV1,
  openSqliteMemoryDatabaseV1
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  MEMORY_SQLITE_MIGRATION_V1,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1,
  runSqliteMemoryMigrationSequenceV1,
  sqliteMemorySchemaFingerprintV1,
  type MemorySqliteMigrationV1
} from '../../src/agent/memory/sqlite-memory-migrations.js'

const FIXED_NOW = '2026-07-19T00:00:00.000Z'
const APP_TABLES = [
  'global_usage',
  'heads',
  'namespaces',
  'outbox',
  'proposals',
  'revision_payloads',
  'revisions',
  'schema_migrations',
  'tombstones',
  'usage'
] as const

interface FileState {
  readonly bytes: number
  readonly hash: string
  readonly mtimeNs: bigint
  readonly wal: SidecarState
  readonly shm: SidecarState
  readonly journal: SidecarState
}

interface SidecarState {
  readonly exists: boolean
  readonly bytes: number
  readonly hash: string | null
}

function temporaryDatabasePath (t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-v1-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'memory.sqlite')
}

function pragmaValue (
  database: DatabaseSync,
  name: string
): SQLOutputValue | undefined {
  const row = database.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

function sha256 (value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileState (location: string): FileState {
  const stat = statSync(location, { bigint: true })
  return Object.freeze({
    bytes: Number(stat.size),
    hash: sha256(readFileSync(location)),
    mtimeNs: stat.mtimeNs,
    wal: sidecarState(`${location}-wal`),
    shm: sidecarState(`${location}-shm`),
    journal: sidecarState(`${location}-journal`)
  })
}

function sidecarState (location: string): SidecarState {
  if (!existsSync(location)) {
    return Object.freeze({ exists: false, bytes: 0, hash: null })
  }
  const stat = statSync(location)
  return Object.freeze({
    exists: true,
    bytes: stat.size,
    hash: sha256(readFileSync(location))
  })
}

function independentSchemaFingerprint (database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type ASC, name ASC
  `).all().map(row => ({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.tbl_name),
    sql: String(row.sql)
  }))
  return createHash('sha256')
    .update('groupmate.memory.sqlite-schema.v1', 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(rows), 'utf8')
    .digest('hex')
}

function captureOpenError (
  location: string,
  expectedCode: SqliteMemoryDatabaseErrorV1['code']
): SqliteMemoryDatabaseErrorV1 {
  let captured: unknown
  let opened: ReturnType<typeof openSqliteMemoryDatabaseV1> | undefined
  try {
    opened = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
  } catch (error) {
    captured = error
  } finally {
    opened?.close()
  }
  assert.ok(captured instanceof SqliteMemoryDatabaseErrorV1)
  assert.equal(captured.code, expectedCode)
  assert.ok(!captured.message.includes(location))
  return captured
}

function assertRejectedWithoutMutation (
  location: string,
  expectedCode: SqliteMemoryDatabaseErrorV1['code'] = 'memory_schema_unsupported'
): void {
  const before = fileState(location)
  captureOpenError(location, expectedCode)
  assert.deepEqual(fileState(location), before)
}

function createValidFileDatabase (location: string): void {
  const memory = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
  memory.close()
}

function mutateFileDatabase (location: string, mutate: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(location, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  try {
    assert.equal(pragmaValue(database, 'journal_mode'), 'wal')
    const journal = database.prepare('PRAGMA journal_mode = DELETE').get()
    assert.equal(journal === undefined ? undefined : Object.values(journal)[0], 'delete')
    mutate(database)
  } finally {
    database.close()
  }
}

function tablePrimaryKey (database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .filter(row => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(row => String(row.name))
}

function foreignKeyColumns (
  database: DatabaseSync,
  table: string,
  referencedTable: string
): readonly { readonly from: string; readonly to: string }[] {
  return database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all()
    .filter(row => row.table === referencedTable)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map(row => ({ from: String(row.from), to: String(row.to) }))
}

function quoteIdentifier (value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function indexKeyColumns (
  database: DatabaseSync,
  indexName: string
): readonly { readonly name: string; readonly descending: number }[] {
  return database.prepare(`PRAGMA index_xinfo(${quoteIdentifier(indexName)})`)
    .all()
    .filter(row => row.key === 1)
    .map(row => ({ name: String(row.name), descending: Number(row.desc) }))
}

function assertFixedPragmas (database: DatabaseSync, kind: 'file' | 'memory'): void {
  assert.equal(pragmaValue(database, 'page_size'), 4096)
  assert.equal(pragmaValue(database, 'journal_mode'), kind === 'file' ? 'wal' : 'memory')
  assert.equal(pragmaValue(database, 'synchronous'), 2)
  assert.equal(pragmaValue(database, 'foreign_keys'), 1)
  assert.equal(pragmaValue(database, 'secure_delete'), 1)
  assert.equal(pragmaValue(database, 'trusted_schema'), 0)
  assert.equal(pragmaValue(database, 'temp_store'), 1)
  assert.equal(pragmaValue(database, 'cache_size'), -2048)
  assert.equal(pragmaValue(database, 'busy_timeout'), 1000)
  assert.equal(pragmaValue(database, 'wal_autocheckpoint'), 1000)
  assert.equal(pragmaValue(database, 'journal_size_limit'), 33_554_432)
  assert.equal(pragmaValue(database, 'max_page_count'), 131_072)
  assert.equal(pragmaValue(database, 'mmap_size'), kind === 'file' ? 0 : undefined)
}

test('sqlite memory bootstrap initializes a bounded in-memory v1 database', () => {
  assert.equal(MEMORY_SQLITE_APPLICATION_ID_V1, 0x474d454d)
  assert.equal(MEMORY_SQLITE_SCHEMA_VERSION_V1, 1)
  assert.equal(MEMORY_SQLITE_MIGRATION_V1.version, 1)
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  try {
    assert.equal(pragmaValue(memory.database, 'application_id'), MEMORY_SQLITE_APPLICATION_ID_V1)
    assert.equal(pragmaValue(memory.database, 'user_version'), MEMORY_SQLITE_SCHEMA_VERSION_V1)
    assertFixedPragmas(memory.database, 'memory')

    const migration = memory.database.prepare(`
      SELECT version, checksum, schema_fingerprint, applied_at
      FROM schema_migrations
    `).get()
    assert.deepEqual({ ...migration }, {
      version: 1,
      checksum: MEMORY_SQLITE_MIGRATION_V1.checksum,
      schema_fingerprint: MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1,
      applied_at: FIXED_NOW
    })
  } finally {
    memory.close()
  }
})

test('sqlite memory bootstrap publishes a file once and reopens it idempotently', t => {
  const location = temporaryDatabasePath(t)
  const first = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
  const firstFingerprint = independentSchemaFingerprint(first.database)
  const firstMigration = first.database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
  `).get()
  first.close()

  const reopened = openSqliteMemoryDatabaseV1({
    location,
    now: () => { throw new Error('migration time must not be requested on reopen') }
  })
  try {
    assertFixedPragmas(reopened.database, 'file')
    assert.equal(independentSchemaFingerprint(reopened.database), firstFingerprint)
    assert.equal(
      reopened.database.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count,
      1
    )
    assert.deepEqual(
      { ...reopened.database.prepare(`
        SELECT version, checksum, schema_fingerprint, applied_at
        FROM schema_migrations
      `).get() },
      { ...firstMigration }
    )
  } finally {
    reopened.close()
  }
})

test('sqlite memory bootstrap never overwrites a concurrent valid publisher', t => {
  const location = temporaryDatabasePath(t)
  let published = false
  const opened = openSqliteMemoryDatabaseV1({
    location,
    now: () => {
      if (!published) {
        published = true
        const winner = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
        try {
          winner.database.prepare(`
            UPDATE global_usage SET updated_at_ms = ? WHERE singleton = 1
          `).run(777)
        } finally {
          winner.close()
        }
      }
      return FIXED_NOW
    }
  })
  try {
    assert.equal(published, true)
    assert.equal(
      opened.database.prepare('SELECT updated_at_ms FROM global_usage WHERE singleton = 1').get()?.updated_at_ms,
      777
    )
  } finally {
    opened.close()
  }
})

test('sqlite memory v1 migration checksum and schema fingerprint are independently reproducible', () => {
  assert.ok(!MEMORY_SQLITE_MIGRATION_V1.sql.startsWith('\uFEFF'))
  assert.ok(!MEMORY_SQLITE_MIGRATION_V1.sql.includes('\r'))
  assert.ok(MEMORY_SQLITE_MIGRATION_V1.sql.endsWith('\n'))
  assert.equal(sha256(MEMORY_SQLITE_MIGRATION_V1.sql), MEMORY_SQLITE_MIGRATION_V1.checksum)

  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  try {
    assert.equal(independentSchemaFingerprint(memory.database), MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1)
  } finally {
    memory.close()
  }
})

test('sqlite memory schema fingerprint rejects SQL before crossing its JS read budget', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const oversizedLiteral = 'x'.repeat(65 * 1_024)
    database.exec(`
      CREATE TABLE oversized_schema(
        value TEXT CHECK(value != '${oversizedLiteral}')
      ) STRICT
    `)
    assert.throws(
      () => sqliteMemorySchemaFingerprintV1(database),
      /invalid canonical memory value/
    )
  } finally {
    database.close()
  }
})

test('sqlite memory v1 schema is strict, generation-bound and has no FTS objects', () => {
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  try {
    const applicationRows = memory.database.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all()
    assert.deepEqual(applicationRows.map(row => row.name), [...APP_TABLES])
    const tableList = memory.database.prepare('PRAGMA main.table_list').all()
    for (const row of applicationRows) {
      assert.equal(
        tableList.find(table => table.name === row.name)?.strict,
        1,
        `${String(row.name)} must be a real STRICT table`
      )
      assert.doesNotMatch(`${String(row.name)} ${String(row.sql)}`, /fts/i)
    }

    for (const table of [
      'proposals', 'revisions', 'revision_payloads', 'heads', 'tombstones', 'usage', 'outbox'
    ]) {
      const columns = new Set(
        memory.database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
          .all()
          .map(row => row.name)
      )
      assert.ok(columns.has('namespace_ref'), `${table} lacks namespace_ref`)
      assert.ok(columns.has('namespace_generation'), `${table} lacks namespace_generation`)
    }
    const outboxSql = String(
      applicationRows.find(row => row.name === 'outbox')?.sql
    )
    assert.match(outboxSql, /sequence\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i)

    assert.deepEqual(tablePrimaryKey(memory.database, 'namespaces'), ['namespace_ref'])
    assert.deepEqual(tablePrimaryKey(memory.database, 'proposals'), [
      'namespace_ref', 'namespace_generation', 'proposal_id'
    ])
    assert.deepEqual(tablePrimaryKey(memory.database, 'revisions'), [
      'namespace_ref', 'namespace_generation', 'memory_id', 'revision'
    ])
    assert.deepEqual(tablePrimaryKey(memory.database, 'revision_payloads'), [
      'namespace_ref', 'namespace_generation', 'memory_id', 'revision'
    ])
    assert.deepEqual(tablePrimaryKey(memory.database, 'heads'), [
      'namespace_ref', 'namespace_generation', 'memory_id'
    ])
    assert.deepEqual(tablePrimaryKey(memory.database, 'tombstones'), [
      'namespace_ref', 'namespace_generation', 'tombstone_id'
    ])
    assert.deepEqual(tablePrimaryKey(memory.database, 'usage'), [
      'namespace_ref', 'namespace_generation'
    ])
    assert.deepEqual(foreignKeyColumns(memory.database, 'revision_payloads', 'revisions'), [
      { from: 'namespace_ref', to: 'namespace_ref' },
      { from: 'namespace_generation', to: 'namespace_generation' },
      { from: 'memory_id', to: 'memory_id' },
      { from: 'revision', to: 'revision' }
    ])
    assert.deepEqual(foreignKeyColumns(memory.database, 'heads', 'revisions'), [
      { from: 'namespace_ref', to: 'namespace_ref' },
      { from: 'namespace_generation', to: 'namespace_generation' },
      { from: 'memory_id', to: 'memory_id' },
      { from: 'current_revision', to: 'revision' }
    ])
  } finally {
    memory.close()
  }
})

test('sqlite memory heads persist exact cursor constraints and restart-safe indexes', () => {
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  try {
    const tableSql = String(memory.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'heads'
    `).get()?.sql)
    assert.match(tableSql, /length\s*\(\s*cursor_ref\s*\)\s*=\s*64/i)
    assert.match(tableSql, /cursor_ref\s*=\s*lower\s*\(\s*cursor_ref\s*\)/i)
    assert.match(tableSql, /cursor_ref\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'/i)

    const indexes = memory.database.prepare("PRAGMA index_list('heads')").all()
    const cursorIndex = indexes.find(row => (
      row.unique === 1 && row.partial === 0 &&
      JSON.stringify(indexKeyColumns(memory.database, String(row.name))) ===
        JSON.stringify([{ name: 'cursor_ref', descending: 0 }])
    ))
    assert.ok(cursorIndex, 'heads must have a global cursor_ref unique index')

    const expectedSeek = [
      { name: 'namespace_ref', descending: 0 },
      { name: 'namespace_generation', descending: 0 },
      { name: 'updated_at_ms', descending: 1 },
      { name: 'memory_id', descending: 0 }
    ]
    assert.ok(indexes.some(row => (
      row.unique === 0 && row.partial === 0 &&
      JSON.stringify(indexKeyColumns(memory.database, String(row.name))) ===
        JSON.stringify(expectedSeek)
    )), 'heads must have the stable seek index')
  } finally {
    memory.close()
  }
})

test('sqlite memory disables extension loading and closes idempotently', () => {
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  assert.throws(() => memory.database.enableLoadExtension(true))
  assert.throws(() => memory.database.loadExtension('/definitely-not-a-memory-extension'))
  memory.close()
  memory.close()
  assert.throws(() => memory.database.prepare('SELECT 1').get())
})

test('sqlite memory refuses existing empty and non-SQLite files without mutation', t => {
  const empty = temporaryDatabasePath(t)
  writeFileSync(empty, '')
  assertRejectedWithoutMutation(empty, 'memory_sqlite_unavailable')

  const corrupt = temporaryDatabasePath(t)
  writeFileSync(corrupt, Buffer.from('not a sqlite database', 'utf8'))
  assertRejectedWithoutMutation(corrupt, 'memory_sqlite_unavailable')
})

test('sqlite memory independently gates application identity and future schema version', t => {
  for (const mutation of [
    { name: 'zero-app-id', sql: 'PRAGMA application_id = 0' },
    { name: 'wrong-app-id', sql: 'PRAGMA application_id = 1' },
    { name: 'future-version', sql: 'PRAGMA user_version = 2' }
  ]) {
    const location = temporaryDatabasePath(t)
    createValidFileDatabase(location)
    mutateFileDatabase(location, database => database.exec(mutation.sql))
    assertRejectedWithoutMutation(location)
  }
})

test('sqlite memory independently gates migration checksum, fingerprint and row presence', t => {
  for (const mutation of [
    `UPDATE schema_migrations SET checksum = '${'0'.repeat(64)}' WHERE version = 1`,
    `UPDATE schema_migrations SET schema_fingerprint = '${'1'.repeat(64)}' WHERE version = 1`,
    'DELETE FROM schema_migrations WHERE version = 1'
  ]) {
    const location = temporaryDatabasePath(t)
    createValidFileDatabase(location)
    mutateFileDatabase(location, database => database.exec(mutation))
    assertRejectedWithoutMutation(location)
  }
})

test('sqlite memory fingerprint rejects missing and extra cursor schema without silent repair', t => {
  for (const mutation of ['drop-unique', 'drop-seek', 'add-extra'] as const) {
    const location = temporaryDatabasePath(t)
    const fixture = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
    fixture.close()

    const database = new DatabaseSync(location, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true
    })
    try {
      assert.equal(
        Object.values(database.prepare('PRAGMA journal_mode = DELETE').get() ?? {})[0],
        'delete'
      )
      if (mutation === 'add-extra') {
        database.exec('CREATE INDEX unexpected_memory_index_v1 ON heads(memory_id)')
      } else {
        const expected = mutation === 'drop-unique'
          ? [{ name: 'cursor_ref', descending: 0 }]
          : [
              { name: 'namespace_ref', descending: 0 },
              { name: 'namespace_generation', descending: 0 },
              { name: 'updated_at_ms', descending: 1 },
              { name: 'memory_id', descending: 0 }
            ]
        const index = database.prepare("PRAGMA index_list('heads')").all().find(row => (
          JSON.stringify(indexKeyColumns(database, String(row.name))) === JSON.stringify(expected)
        ))
        assert.ok(index)
        database.exec(`DROP INDEX ${quoteIdentifier(String(index.name))}`)
      }
    } finally {
      database.close()
    }
    assertRejectedWithoutMutation(location)
  }
})

test('sqlite memory fail-closed preflight preserves canonical WAL while SHM tracks reader locks', t => {
  const location = temporaryDatabasePath(t)
  createValidFileDatabase(location)
  const writer = new DatabaseSync(location, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  try {
    writer.exec(`
      PRAGMA wal_autocheckpoint = 0;
      CREATE INDEX unexpected_live_wal_index_v1 ON heads(memory_id);
    `)
    assert.equal(pragmaValue(writer, 'journal_mode'), 'wal')
    assert.ok(existsSync(`${location}-wal`))
    assert.ok(existsSync(`${location}-shm`))
    const before = fileState(location)
    captureOpenError(location, 'memory_schema_unsupported')
    const after = fileState(location)
    assert.deepEqual({
      bytes: after.bytes,
      hash: after.hash,
      mtimeNs: after.mtimeNs,
      wal: after.wal,
      journal: after.journal,
      shmExists: after.shm.exists,
      shmBytes: after.shm.bytes
    }, {
      bytes: before.bytes,
      hash: before.hash,
      mtimeNs: before.mtimeNs,
      wal: before.wal,
      journal: before.journal,
      shmExists: before.shm.exists,
      shmBytes: before.shm.bytes
    })
  } finally {
    writer.close()
  }
})

test('sqlite memory migration sequence rolls back DDL, identity and version together', () => {
  const database = new DatabaseSync(':memory:', {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  let markerCalls = 0
  database.function('memory_migration_marker', { directOnly: true }, () => {
    markerCalls += 1
    return null
  })
  const sql = `CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE halfway(value TEXT NOT NULL) STRICT;
SELECT memory_migration_marker();
THIS IS INTENTIONALLY INVALID SQL;
`
  const migration: MemorySqliteMigrationV1 = Object.freeze({
    version: 1,
    sql,
    checksum: sha256(sql),
    schemaFingerprint: '0'.repeat(64)
  })
  try {
    assert.throws(() => runSqliteMemoryMigrationSequenceV1(database, {
      migrations: Object.freeze([migration]),
      appliedAt: FIXED_NOW
    }))
    assert.equal(markerCalls, 1)
    assert.equal(pragmaValue(database, 'application_id'), 0)
    assert.equal(pragmaValue(database, 'user_version'), 0)
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('halfway', 'schema_migrations')").get()?.count,
      0
    )
  } finally {
    database.close()
  }
})

test('sqlite memory migration sequence advances an authenticated existing version in order', () => {
  const migrationSql = 'CREATE TABLE migration_v2_probe(value TEXT NOT NULL) STRICT;\n'
  const scratch = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  let schemaFingerprint: string
  try {
    scratch.database.exec(migrationSql)
    schemaFingerprint = independentSchemaFingerprint(scratch.database)
  } finally {
    scratch.close()
  }
  const migrationV2: MemorySqliteMigrationV1 = Object.freeze({
    version: 2,
    sql: migrationSql,
    checksum: sha256(migrationSql),
    schemaFingerprint
  })
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  try {
    runSqliteMemoryMigrationSequenceV1(memory.database, {
      migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1, migrationV2]),
      appliedAt: '2026-07-19T00:01:00.000Z'
    })
    assert.equal(pragmaValue(memory.database, 'application_id'), 0x474d454d)
    assert.equal(pragmaValue(memory.database, 'user_version'), 2)
    assert.equal(
      memory.database.prepare("SELECT type FROM sqlite_schema WHERE name = 'migration_v2_probe'").get()?.type,
      'table'
    )
    assert.deepEqual(memory.database.prepare(`
      SELECT version, checksum, schema_fingerprint, applied_at
      FROM schema_migrations ORDER BY version ASC
    `).all().map(row => ({ ...row })), [
      {
        version: 1,
        checksum: MEMORY_SQLITE_MIGRATION_V1.checksum,
        schema_fingerprint: MEMORY_SQLITE_MIGRATION_V1.schemaFingerprint,
        applied_at: FIXED_NOW
      },
      {
        version: 2,
        checksum: migrationV2.checksum,
        schema_fingerprint: migrationV2.schemaFingerprint,
        applied_at: '2026-07-19T00:01:00.000Z'
      }
    ])
  } finally {
    memory.close()
  }
})

test('sqlite memory migration sequence rolls a failed next version back to the prior authority', () => {
  const memory = openSqliteMemoryDatabaseV1({ location: ':memory:', now: () => FIXED_NOW })
  let markerCalls = 0
  memory.database.function('memory_next_migration_marker', { directOnly: true }, () => {
    markerCalls += 1
    return null
  })
  const sql = `CREATE TABLE migration_v2_halfway(value TEXT NOT NULL) STRICT;
SELECT memory_next_migration_marker();
THIS IS INTENTIONALLY INVALID SQL;
`
  const migrationV2: MemorySqliteMigrationV1 = Object.freeze({
    version: 2,
    sql,
    checksum: sha256(sql),
    schemaFingerprint: '0'.repeat(64)
  })
  try {
    assert.throws(() => runSqliteMemoryMigrationSequenceV1(memory.database, {
      migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1, migrationV2]),
      appliedAt: '2026-07-19T00:02:00.000Z'
    }))
    assert.equal(markerCalls, 1)
    assert.equal(pragmaValue(memory.database, 'application_id'), 0x474d454d)
    assert.equal(pragmaValue(memory.database, 'user_version'), 1)
    assert.equal(
      memory.database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'migration_v2_halfway'").get()?.count,
      0
    )
    assert.equal(
      memory.database.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count,
      1
    )
  } finally {
    memory.close()
  }
})

test('sqlite memory database path must remain a regular private file', t => {
  const location = temporaryDatabasePath(t)
  const memory = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
  memory.close()
  const stat = lstatSync(location)
  assert.ok(stat.isFile())
  assert.ok(!stat.isSymbolicLink())
  const mode = stat.mode & 0o777
  assert.equal(mode & 0o077, 0)
})
