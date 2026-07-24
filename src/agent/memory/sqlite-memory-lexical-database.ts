import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types as utilTypes } from 'node:util'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import {
  MEMORY_DERIVATIVE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

export const MEMORY_LEXICAL_SQLITE_APPLICATION_ID_V1 = 0x474d4654
export const MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1 = 1

export type SqliteMemoryLexicalDatabaseErrorCodeV1 =
  | 'memory_fts_unavailable'
  | 'memory_lexical_unavailable'
  | 'memory_lexical_schema_unsupported'

export class SqliteMemoryLexicalDatabaseErrorV1 extends Error {
  readonly code: SqliteMemoryLexicalDatabaseErrorCodeV1

  constructor (code: SqliteMemoryLexicalDatabaseErrorCodeV1) {
    super(code)
    this.name = 'SqliteMemoryLexicalDatabaseErrorV1'
    this.code = code
  }
}

export interface SqliteMemoryLexicalDatabaseV1 {
  readonly database: DatabaseSync
  readonly close: () => void
}

export interface OpenSqliteMemoryLexicalDatabaseOptionsV1 {
  readonly location: string
  readonly now: () => string
}

interface LexicalSchemaObjectV1 {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string
}

interface FileIdentityV1 {
  readonly device: bigint
  readonly inode: bigint
}

const HASH_CHECK = (column: string): string => `
  length(${column}) = 64 AND
  ${column} = lower(${column}) AND
  ${column} NOT GLOB '*[^0-9a-f]*'
`.trim()
const NAMESPACE_REF_CHECK = HASH_CHECK('namespace_ref')
const LEXICAL_SCHEMA_FINGERPRINT_DOMAIN_V1 =
  'groupmate.memory.sqlite-lexical-schema.v1'
const MAXIMUM_OWNED_SCHEMA_OBJECTS = 16
const MAXIMUM_OWNED_SCHEMA_SQL_BYTES = 128 * 1_024
const FTS_SHADOW_TABLES = Object.freeze(new Set([
  'memory_lexical_search_data',
  'memory_lexical_search_idx',
  'memory_lexical_search_docsize',
  'memory_lexical_search_config'
]))
const require = createRequire(import.meta.url)
let sqliteDatabaseConstructor: typeof import('node:sqlite').DatabaseSync | undefined

const SCHEMA_OBJECTS_V1: readonly LexicalSchemaObjectV1[] = Object.freeze([
  Object.freeze({
    type: 'table' as const,
    name: 'lexical_schema',
    tableName: 'lexical_schema',
    sql: `CREATE TABLE lexical_schema(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  schema_fingerprint TEXT NOT NULL CHECK(${HASH_CHECK('schema_fingerprint')}),
  created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 20 AND 32)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lexical_documents',
    tableName: 'lexical_documents',
    sql: `CREATE TABLE lexical_documents(
  document_id INTEGER PRIMARY KEY,
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  memory_revision INTEGER NOT NULL CHECK(memory_revision > 0),
  revision_hash TEXT NOT NULL CHECK(${HASH_CHECK('revision_hash')}),
  body TEXT NOT NULL CHECK(length(body) > 0),
  body_bytes INTEGER NOT NULL CHECK(
    body_bytes BETWEEN 1 AND ${MEMORY_RESOURCE_LIMITS.textUtf8Bytes}
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK(body_bytes = length(CAST(body AS BLOB))),
  UNIQUE(namespace_ref, namespace_generation, memory_id)
) STRICT`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lexical_index_state',
    tableName: 'lexical_index_state',
    sql: `CREATE TABLE lexical_index_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  status TEXT NOT NULL CHECK(status IN ('empty', 'rebuilding', 'ready')),
  projection_generation INTEGER NOT NULL CHECK(projection_generation >= 0),
  source_last_sequence INTEGER NOT NULL CHECK(source_last_sequence >= 0),
  indexed_records INTEGER NOT NULL CHECK(
    indexed_records BETWEEN 0 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalIndexRecords}
  ),
  indexed_logical_bytes INTEGER NOT NULL CHECK(
    indexed_logical_bytes BETWEEN 0 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalIndexLogicalBytes}
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK(
    (status = 'empty' AND projection_generation = 0 AND source_last_sequence = 0 AND
      indexed_records = 0 AND indexed_logical_bytes = 0) OR
    (status IN ('rebuilding', 'ready') AND projection_generation > 0)
  )
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'memory_lexical_search',
    tableName: 'memory_lexical_search',
    sql: `CREATE VIRTUAL TABLE memory_lexical_search USING fts5(
  body,
  content='lexical_documents',
  content_rowid='document_id',
  tokenize='unicode61 remove_diacritics 2'
)`
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'memory_lexical_documents_ai',
    tableName: 'lexical_documents',
    sql: `CREATE TRIGGER memory_lexical_documents_ai
AFTER INSERT ON lexical_documents BEGIN
  INSERT INTO memory_lexical_search(rowid, body) VALUES (new.document_id, new.body);
  UPDATE lexical_index_state
  SET indexed_records = indexed_records + 1,
    indexed_logical_bytes = indexed_logical_bytes + new.body_bytes,
    updated_at_ms = max(updated_at_ms, new.updated_at_ms)
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN raise(ABORT, 'memory lexical state unavailable') END;
END`
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'memory_lexical_documents_ad',
    tableName: 'lexical_documents',
    sql: `CREATE TRIGGER memory_lexical_documents_ad
AFTER DELETE ON lexical_documents BEGIN
  INSERT INTO memory_lexical_search(memory_lexical_search, rowid, body)
  VALUES ('delete', old.document_id, old.body);
  UPDATE lexical_index_state
  SET indexed_records = indexed_records - 1,
    indexed_logical_bytes = indexed_logical_bytes - old.body_bytes
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN raise(ABORT, 'memory lexical state unavailable') END;
END`
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'memory_lexical_documents_au',
    tableName: 'lexical_documents',
    sql: `CREATE TRIGGER memory_lexical_documents_au
AFTER UPDATE ON lexical_documents BEGIN
  INSERT INTO memory_lexical_search(memory_lexical_search, rowid, body)
  VALUES ('delete', old.document_id, old.body);
  INSERT INTO memory_lexical_search(rowid, body) VALUES (new.document_id, new.body);
  UPDATE lexical_index_state
  SET indexed_logical_bytes = indexed_logical_bytes - old.body_bytes + new.body_bytes,
    updated_at_ms = max(updated_at_ms, new.updated_at_ms)
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN raise(ABORT, 'memory lexical state unavailable') END;
END`
  })
])

function fingerprintRows (rows: readonly LexicalSchemaObjectV1[]): string {
  const canonical = [...rows]
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
    .update(LEXICAL_SCHEMA_FINGERPRINT_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
}

export const MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1 =
  fingerprintRows(SCHEMA_OBJECTS_V1)

const MIGRATION_SQL_V1 = `${[
  ...SCHEMA_OBJECTS_V1.map(object => object.sql),
  `INSERT INTO lexical_schema(
  singleton, schema_version, schema_fingerprint, created_at
) VALUES (1, 1, '${MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1}', '__CREATED_AT__')`,
  `INSERT INTO lexical_index_state(
  singleton, status, projection_generation, source_last_sequence,
  indexed_records, indexed_logical_bytes, updated_at_ms
) VALUES (1, 'empty', 0, 0, 0, 0, 0)`
].map(statement => `${statement};`).join('\n')}\n`

function lexicalUnavailable (): never {
  throw new SqliteMemoryLexicalDatabaseErrorV1('memory_lexical_unavailable')
}

function schemaUnsupported (): never {
  throw new SqliteMemoryLexicalDatabaseErrorV1('memory_lexical_schema_unsupported')
}

function nodeRuntimeSupportsMemorySqlite (): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(process.versions.node)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) &&
    (major > 22 || (major === 22 && minor >= 14))
}

function databaseConstructor (): typeof import('node:sqlite').DatabaseSync {
  if (!nodeRuntimeSupportsMemorySqlite()) return lexicalUnavailable()
  if (sqliteDatabaseConstructor !== undefined) return sqliteDatabaseConstructor
  try {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite')
    sqliteDatabaseConstructor = sqlite.DatabaseSync
    return sqliteDatabaseConstructor
  } catch {
    return lexicalUnavailable()
  }
}

function parseOptions (
  value: OpenSqliteMemoryLexicalDatabaseOptionsV1
): OpenSqliteMemoryLexicalDatabaseOptionsV1 {
  const input = inspectMemoryRecord(value, ['location', 'now'])
  if (typeof input.location !== 'string' || input.location.length === 0 ||
    input.location.length > 4_096 || input.location.includes('\0') ||
    typeof input.now !== 'function') return invalidMemoryValue()
  return Object.freeze({ location: input.location, now: input.now as () => string })
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function sqliteOptions (readOnly: boolean): {
  readonly open: false
  readonly readOnly: boolean
  readonly allowExtension: false
  readonly enableForeignKeyConstraints: true
  readonly enableDoubleQuotedStringLiterals: false
} {
  return {
    open: false,
    readOnly,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false
  }
}

function openDatabase (location: string, readOnly: boolean): DatabaseSync {
  const Database = databaseConstructor()
  const database = new Database(location, sqliteOptions(readOnly))
  try {
    database.open()
    return database
  } catch {
    try {
      database.close()
    } catch {
      // A failed open has no authoritative handle to preserve.
    }
    return lexicalUnavailable()
  }
}

function pragmaValue (database: DatabaseSync, name: string): SQLOutputValue | undefined {
  const row = database.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

function requirePragmaValue (
  database: DatabaseSync,
  name: string,
  expected: SQLOutputValue | undefined
): void {
  if (pragmaValue(database, name) !== expected) return schemaUnsupported()
}

export function assertSqliteMemoryFts5AvailableV1 (
  execute: (sql: string) => void
): void {
  if (typeof execute !== 'function' || utilTypes.isProxy(execute)) return invalidMemoryValue()
  try {
    const result = Reflect.apply(execute, undefined, [
      `DROP TABLE IF EXISTS temp.groupmate_memory_fts5_probe;
CREATE VIRTUAL TABLE temp.groupmate_memory_fts5_probe USING fts5(value);
DROP TABLE temp.groupmate_memory_fts5_probe;`
    ])
    if (result !== undefined) throw new TypeError('SQLite execute must complete synchronously')
  } catch {
    try {
      Reflect.apply(execute, undefined, [
        'DROP TABLE IF EXISTS temp.groupmate_memory_fts5_probe;'
      ])
    } catch {
      // The fixed feature-availability result remains authoritative.
    }
    throw new SqliteMemoryLexicalDatabaseErrorV1('memory_fts_unavailable')
  }
}

function ownedSchemaRows (database: DatabaseSync): readonly LexicalSchemaObjectV1[] {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type ASC, name ASC
    LIMIT ${MAXIMUM_OWNED_SCHEMA_OBJECTS + FTS_SHADOW_TABLES.size + 1}
  `).all()
  const owned: LexicalSchemaObjectV1[] = []
  let totalBytes = 0
  for (const row of rows) {
    if (typeof row.type !== 'string' || typeof row.name !== 'string' ||
      typeof row.tbl_name !== 'string' || typeof row.sql !== 'string') {
      return invalidMemoryValue()
    }
    if (FTS_SHADOW_TABLES.has(row.name)) continue
    totalBytes += Buffer.byteLength(row.sql, 'utf8')
    if (owned.length >= MAXIMUM_OWNED_SCHEMA_OBJECTS ||
      totalBytes > MAXIMUM_OWNED_SCHEMA_SQL_BYTES) return invalidMemoryValue()
    owned.push(Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql
    }))
  }
  return owned
}

export function sqliteMemoryLexicalSchemaFingerprintV1 (database: DatabaseSync): string {
  return fingerprintRows(ownedSchemaRows(database))
}

function validateFtsShadowTables (database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_schema
    WHERE name GLOB 'memory_lexical_search_*'
    ORDER BY name ASC
    LIMIT ${FTS_SHADOW_TABLES.size + 1}
  `).all()
  if (rows.length !== FTS_SHADOW_TABLES.size) return schemaUnsupported()
  for (const row of rows) {
    if (row.type !== 'table' || typeof row.name !== 'string' ||
      !FTS_SHADOW_TABLES.has(row.name) || row.tbl_name !== row.name) {
      return schemaUnsupported()
    }
  }
  const expectedColumns = new Map<string, readonly string[]>([
    ['memory_lexical_search_config', ['k', 'v']],
    ['memory_lexical_search_data', ['id', 'block']],
    ['memory_lexical_search_docsize', ['id', 'sz']],
    ['memory_lexical_search_idx', ['segid', 'term', 'pgno']]
  ])
  for (const [table, columns] of expectedColumns) {
    const actual = database.prepare(`PRAGMA table_info("${table}")`).all()
      .map(row => String(row.name))
    if (actual.length !== columns.length ||
      actual.some((column, index) => column !== columns[index])) return schemaUnsupported()
  }
}

function validateDatabase (database: DatabaseSync): void {
  requirePragmaValue(database, 'application_id', MEMORY_LEXICAL_SQLITE_APPLICATION_ID_V1)
  requirePragmaValue(database, 'user_version', MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1)
  if (sqliteMemoryLexicalSchemaFingerprintV1(database) !==
    MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1) return schemaUnsupported()
  validateFtsShadowTables(database)
  const metadata = database.prepare(`
    SELECT schema_version, schema_fingerprint, created_at
    FROM lexical_schema WHERE singleton = 1
  `).get()
  if (metadata?.schema_version !== MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1 ||
    metadata.schema_fingerprint !== MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1) {
    return schemaUnsupported()
  }
  try {
    canonicalInstant(metadata.created_at)
  } catch {
    return schemaUnsupported()
  }
  const state = database.prepare(`
    SELECT status, projection_generation, source_last_sequence,
      indexed_records, indexed_logical_bytes, updated_at_ms
    FROM lexical_index_state WHERE singleton = 1
  `).get()
  if (state === undefined ||
    (state.status !== 'empty' && state.status !== 'rebuilding' && state.status !== 'ready') ||
    typeof state.projection_generation !== 'number' ||
    !Number.isSafeInteger(state.projection_generation) || state.projection_generation < 0 ||
    typeof state.source_last_sequence !== 'number' ||
    !Number.isSafeInteger(state.source_last_sequence) || state.source_last_sequence < 0 ||
    typeof state.indexed_records !== 'number' ||
    !Number.isSafeInteger(state.indexed_records) || state.indexed_records < 0 ||
    state.indexed_records > MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalIndexRecords ||
    typeof state.indexed_logical_bytes !== 'number' ||
    !Number.isSafeInteger(state.indexed_logical_bytes) || state.indexed_logical_bytes < 0 ||
    state.indexed_logical_bytes > MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalIndexLogicalBytes ||
    typeof state.updated_at_ms !== 'number' ||
    !Number.isSafeInteger(state.updated_at_ms) || state.updated_at_ms < 0 ||
    (state.status === 'empty' && (
      state.projection_generation !== 0 || state.source_last_sequence !== 0 ||
      state.indexed_records !== 0 || state.indexed_logical_bytes !== 0
    )) || (state.status !== 'empty' && state.projection_generation === 0)) {
    return schemaUnsupported()
  }
}

function configureRuntime (database: DatabaseSync, inMemory: boolean): void {
  database.exec(`
    PRAGMA page_size = 4096;
    PRAGMA journal_mode = ${inMemory ? 'MEMORY' : 'WAL'};
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -1024;
    PRAGMA busy_timeout = 500;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = 33554432;
    PRAGMA max_page_count = 65536;
    PRAGMA mmap_size = 0;
  `)
  requirePragmaValue(database, 'page_size', 4_096)
  requirePragmaValue(database, 'journal_mode', inMemory ? 'memory' : 'wal')
  requirePragmaValue(database, 'synchronous', 2)
  requirePragmaValue(database, 'foreign_keys', 1)
  requirePragmaValue(database, 'secure_delete', 1)
  requirePragmaValue(database, 'trusted_schema', 0)
  requirePragmaValue(database, 'cache_size', -1_024)
  requirePragmaValue(database, 'busy_timeout', 500)
  requirePragmaValue(database, 'journal_size_limit', 33_554_432)
  requirePragmaValue(database, 'max_page_count', 65_536)
  requirePragmaValue(database, 'mmap_size', inMemory ? undefined : 0)
}

function createSchema (database: DatabaseSync, createdAt: string): void {
  let started = false
  try {
    database.exec('BEGIN IMMEDIATE')
    started = true
    assertSqliteMemoryFts5AvailableV1(sql => database.exec(sql))
    database.exec(MIGRATION_SQL_V1.replace('__CREATED_AT__', createdAt))
    database.exec(`
      PRAGMA application_id = ${MEMORY_LEXICAL_SQLITE_APPLICATION_ID_V1};
      PRAGMA user_version = ${MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1};
    `)
    validateDatabase(database)
    database.exec('COMMIT')
    started = false
  } catch (error) {
    if (started) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The original fixed schema failure remains authoritative.
      }
    }
    throw error
  }
}

function sameFileIdentity (location: string, expected: FileIdentityV1): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(location, { bigint: true })
  } catch {
    return schemaUnsupported()
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expected.device ||
    stat.ino !== expected.inode) return schemaUnsupported()
}

function fileIdentity (location: string): FileIdentityV1 {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(location, { bigint: true })
  } catch {
    return lexicalUnavailable()
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return schemaUnsupported()
  if ((stat.mode & 0o077n) !== 0n) return schemaUnsupported()
  if (stat.size > BigInt(MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalSqliteMainFileBytes)) {
    return lexicalUnavailable()
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      const sidecar = lstatSync(`${location}${suffix}`, { bigint: true })
      if (!sidecar.isFile() || sidecar.isSymbolicLink() ||
        (sidecar.mode & 0o077n) !== 0n) return schemaUnsupported()
      if (sidecar.size > BigInt(MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes)) {
        return lexicalUnavailable()
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return schemaUnsupported()
    }
  }
  return Object.freeze({ device: stat.dev, inode: stat.ino })
}

function preflightExisting (location: string): FileIdentityV1 {
  const identity = fileIdentity(location)
  const database = openDatabase(location, true)
  try {
    database.exec('BEGIN')
    validateDatabase(database)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Validation is read-only and the fixed failure remains authoritative.
    }
    if (error instanceof SqliteMemoryLexicalDatabaseErrorV1) throw error
    return schemaUnsupported()
  } finally {
    database.close()
  }
  sameFileIdentity(location, identity)
  return identity
}

function checkpointForPublication (database: DatabaseSync): void {
  const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  if (row === undefined || row.busy !== 0) return lexicalUnavailable()
}

function fsyncPath (location: string): void {
  const descriptor = openSync(location, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function removeOwnedPath (location: string): void {
  try {
    unlinkSync(location)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

function cleanupOwnedBootstrap (location: string): void {
  removeOwnedPath(`${location}-wal`)
  removeOwnedPath(`${location}-shm`)
  removeOwnedPath(`${location}-journal`)
  removeOwnedPath(location)
}

function isErrno (value: unknown, code: string): boolean {
  return value !== null && typeof value === 'object' &&
    Object.getOwnPropertyDescriptor(value, 'code')?.value === code
}

function locationExists (location: string): boolean {
  try {
    lstatSync(location)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    return schemaUnsupported()
  }
}

function bootstrapFile (location: string, now: () => string): void {
  const directory = path.dirname(location)
  const temporary = path.join(
    directory,
    `.${path.basename(location)}.bootstrap-${process.pid}-${randomUUID()}`
  )
  let descriptor: number | undefined
  let database: DatabaseSync | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    closeSync(descriptor)
    descriptor = undefined
    database = openDatabase(temporary, false)
    configureRuntime(database, false)
    createSchema(database, canonicalInstant(Reflect.apply(now, undefined, [])))
    checkpointForPublication(database)
    database.close()
    database = undefined
    removeOwnedPath(`${temporary}-wal`)
    removeOwnedPath(`${temporary}-shm`)
    removeOwnedPath(`${temporary}-journal`)
    fsyncPath(temporary)
    try {
      linkSync(temporary, location)
      fsyncPath(directory)
      removeOwnedPath(temporary)
      fsyncPath(directory)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      cleanupOwnedBootstrap(temporary)
    }
  } catch (error) {
    if (database !== undefined) {
      try {
        database.close()
      } catch {
        // Cleanup remains best-effort.
      }
    }
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      cleanupOwnedBootstrap(temporary)
    } catch {
      // Never replace the fixed public error with cleanup details.
    }
    if (error instanceof SqliteMemoryLexicalDatabaseErrorV1) throw error
    return lexicalUnavailable()
  }
  preflightExisting(location)
}

function openWritable (
  location: string,
  identity: FileIdentityV1
): SqliteMemoryLexicalDatabaseV1 {
  const database = openDatabase(location, false)
  try {
    sameFileIdentity(location, identity)
    database.exec('BEGIN IMMEDIATE')
    validateDatabase(database)
    database.exec('COMMIT')
    configureRuntime(database, false)
    assertSqliteMemoryFts5AvailableV1(sql => database.exec(sql))
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Validation may already have committed.
    }
    database.close()
    if (error instanceof SqliteMemoryLexicalDatabaseErrorV1) throw error
    return lexicalUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openInMemory (now: () => string): SqliteMemoryLexicalDatabaseV1 {
  const database = openDatabase(':memory:', false)
  try {
    configureRuntime(database, true)
    createSchema(database, canonicalInstant(Reflect.apply(now, undefined, [])))
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryLexicalDatabaseErrorV1) throw error
    return lexicalUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

export function openSqliteMemoryLexicalDatabaseV1 (
  optionsValue: OpenSqliteMemoryLexicalDatabaseOptionsV1
): SqliteMemoryLexicalDatabaseV1 {
  const options = parseOptions(optionsValue)
  databaseConstructor()
  if (options.location === ':memory:') return openInMemory(options.now)
  try {
    if (!locationExists(options.location)) bootstrapFile(options.location, options.now)
    return openWritable(options.location, preflightExisting(options.location))
  } catch (error) {
    if (error instanceof SqliteMemoryLexicalDatabaseErrorV1) throw error
    return lexicalUnavailable()
  }
}
