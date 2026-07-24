import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import {
  MEMORY_DERIVATIVE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'
import {
  assertSqliteMemoryMigrationV2Ready,
  assertSqliteMemoryMigrationV3Ready,
  MemorySqliteMigrationErrorV2,
  MEMORY_SQLITE_APPLICATION_ID_V1,
  MEMORY_SQLITE_MIGRATION_V1,
  MEMORY_SQLITE_MIGRATIONS_V2,
  MEMORY_SQLITE_MIGRATIONS_V3,
  MEMORY_SQLITE_SCHEMA_VERSION_V1,
  MEMORY_SQLITE_SCHEMA_VERSION_V2,
  MEMORY_SQLITE_SCHEMA_VERSION_V3,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V3,
  runSqliteMemoryMigrationV2,
  runSqliteMemoryMigrationV3,
  runSqliteMemoryMigrationSequenceV1,
  sqliteMemorySchemaFingerprintV1
} from './sqlite-memory-migrations.js'
import type { MemoryV1ToV2AggregateManifestV1 } from './memory-lifecycle-domain.js'

export {
  MEMORY_SQLITE_APPLICATION_ID_V1,
  MEMORY_SQLITE_SCHEMA_VERSION_V1,
  MEMORY_SQLITE_SCHEMA_VERSION_V2,
  MEMORY_SQLITE_SCHEMA_VERSION_V3
} from './sqlite-memory-migrations.js'

export type SqliteMemoryDatabaseErrorCodeV1 =
  | 'memory_sqlite_unavailable'
  | 'memory_schema_unsupported'

export class SqliteMemoryDatabaseErrorV1 extends Error {
  readonly code: SqliteMemoryDatabaseErrorCodeV1

  constructor (code: SqliteMemoryDatabaseErrorCodeV1) {
    super(code)
    this.name = 'SqliteMemoryDatabaseErrorV1'
    this.code = code
  }
}

export interface SqliteMemoryDatabaseV1 {
  readonly database: DatabaseSync
  readonly close: () => void
}

interface OpenSqliteMemoryDatabaseOptionsV1 {
  readonly location: string
  readonly now: () => string
}

export interface OpenSqliteMemoryDatabaseOptionsV2 {
  readonly location: string
  readonly now: () => string
  readonly manifests: readonly MemoryV1ToV2AggregateManifestV1[]
}

export type OpenSqliteMemoryDatabaseOptionsV3 = OpenSqliteMemoryDatabaseOptionsV2

interface FileIdentityV1 {
  readonly device: bigint
  readonly inode: bigint
}

const SQLITE_HEADER_BYTES = 100
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')
const SQLITE_SCHEMA_FORMAT_OFFSET = 44
const SQLITE_TEXT_ENCODING_OFFSET = 56
const SQLITE_USER_VERSION_OFFSET = 60
const SQLITE_APPLICATION_ID_OFFSET = 68
const require = createRequire(import.meta.url)
let sqliteDatabaseConstructor: typeof import('node:sqlite').DatabaseSync | undefined

function schemaUnsupported (): never {
  throw new SqliteMemoryDatabaseErrorV1('memory_schema_unsupported')
}

function sqliteUnavailable (): never {
  throw new SqliteMemoryDatabaseErrorV1('memory_sqlite_unavailable')
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
  if (!nodeRuntimeSupportsMemorySqlite()) return sqliteUnavailable()
  if (sqliteDatabaseConstructor !== undefined) return sqliteDatabaseConstructor
  try {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite')
    sqliteDatabaseConstructor = sqlite.DatabaseSync
    return sqliteDatabaseConstructor
  } catch {
    return sqliteUnavailable()
  }
}

function parseOptions (value: OpenSqliteMemoryDatabaseOptionsV1): OpenSqliteMemoryDatabaseOptionsV1 {
  const input = inspectMemoryRecord(value, ['location', 'now'])
  if (typeof input.location !== 'string' || input.location.length === 0 ||
    input.location.length > 4_096 || input.location.includes('\0') ||
    typeof input.now !== 'function') return invalidMemoryValue()
  return Object.freeze({
    location: input.location,
    now: input.now as () => string
  })
}

function parseOptionsV2 (
  value: OpenSqliteMemoryDatabaseOptionsV2
): OpenSqliteMemoryDatabaseOptionsV2 {
  const input = inspectMemoryRecord(value, ['location', 'now', 'manifests'])
  if (typeof input.location !== 'string' || input.location.length === 0 ||
    input.location.length > 4_096 || input.location.includes('\0') ||
    typeof input.now !== 'function' || !Array.isArray(input.manifests)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    location: input.location,
    now: input.now as () => string,
    manifests: input.manifests as readonly MemoryV1ToV2AggregateManifestV1[]
  })
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
  const SqliteDatabase = databaseConstructor()
  const database = new SqliteDatabase(location, sqliteOptions(readOnly))
  try {
    database.open()
    return database
  } catch {
    try {
      database.close()
    } catch {
      // A failed open has no authoritative handle to preserve.
    }
    return sqliteUnavailable()
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

function exactMigrationMetadata (database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 2
  `).all()
  if (rows.length !== 1) return schemaUnsupported()
  const row = rows[0]
  if (row === undefined || row.version !== MEMORY_SQLITE_SCHEMA_VERSION_V1 ||
    row.checksum !== MEMORY_SQLITE_MIGRATION_V1.checksum ||
    row.schema_fingerprint !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1) {
    return schemaUnsupported()
  }
  try {
    canonicalInstant(row.applied_at)
  } catch {
    return schemaUnsupported()
  }
}

function exactMigrationMetadataV2 (database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 3
  `).all()
  if (rows.length !== MEMORY_SQLITE_MIGRATIONS_V2.length) return schemaUnsupported()
  rows.forEach((row, index) => {
    const migration = MEMORY_SQLITE_MIGRATIONS_V2[index]
    if (migration === undefined || row.version !== migration.version ||
      row.checksum !== migration.checksum ||
      row.schema_fingerprint !== migration.schemaFingerprint) {
      return schemaUnsupported()
    }
    try {
      canonicalInstant(row.applied_at)
    } catch {
      return schemaUnsupported()
    }
  })
}

function exactMigrationMetadataV3 (database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 4
  `).all()
  if (rows.length !== MEMORY_SQLITE_MIGRATIONS_V3.length) return schemaUnsupported()
  rows.forEach((row, index) => {
    const migration = MEMORY_SQLITE_MIGRATIONS_V3[index]
    if (migration === undefined || row.version !== migration.version ||
      row.checksum !== migration.checksum ||
      row.schema_fingerprint !== migration.schemaFingerprint) {
      return schemaUnsupported()
    }
    try {
      canonicalInstant(row.applied_at)
    } catch {
      return schemaUnsupported()
    }
  })
}

function validateDatabaseIdentity (database: DatabaseSync): void {
  requirePragmaValue(database, 'application_id', MEMORY_SQLITE_APPLICATION_ID_V1)
  requirePragmaValue(database, 'user_version', MEMORY_SQLITE_SCHEMA_VERSION_V1)
  requirePragmaValue(database, 'foreign_keys', 1)
  if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1) {
    return schemaUnsupported()
  }
  exactMigrationMetadata(database)
}

function validateLifecycleDeploymentStateV2 (database: DatabaseSync): void {
  const state = database.prepare(`
    SELECT trusted_time_high_water_ms, export_fencing_counter,
      export_lease_owner_id, export_lease_token, export_leased_until_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()
  if (state === undefined || typeof state.trusted_time_high_water_ms !== 'number' ||
    !Number.isSafeInteger(state.trusted_time_high_water_ms) ||
    state.trusted_time_high_water_ms < 0 ||
    typeof state.export_fencing_counter !== 'number' ||
    !Number.isSafeInteger(state.export_fencing_counter) ||
    state.export_fencing_counter < 0) return schemaUnsupported()
}

function validateDatabaseIdentityV2 (database: DatabaseSync): void {
  requirePragmaValue(database, 'application_id', MEMORY_SQLITE_APPLICATION_ID_V1)
  requirePragmaValue(database, 'user_version', MEMORY_SQLITE_SCHEMA_VERSION_V2)
  requirePragmaValue(database, 'foreign_keys', 1)
  if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2) {
    return schemaUnsupported()
  }
  exactMigrationMetadataV2(database)
  validateLifecycleDeploymentStateV2(database)
}

function validateDatabaseIdentityV3 (database: DatabaseSync): void {
  requirePragmaValue(database, 'application_id', MEMORY_SQLITE_APPLICATION_ID_V1)
  requirePragmaValue(database, 'user_version', MEMORY_SQLITE_SCHEMA_VERSION_V3)
  requirePragmaValue(database, 'foreign_keys', 1)
  if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V3) {
    return schemaUnsupported()
  }
  exactMigrationMetadataV3(database)
  validateLifecycleDeploymentStateV2(database)
  const usage = database.prepare(`
    SELECT queued_records, queued_logical_bytes, updated_at_ms
    FROM memory_derivative_usage WHERE singleton = 1
  `).get()
  if (usage === undefined || typeof usage.queued_records !== 'number' ||
    !Number.isSafeInteger(usage.queued_records) || usage.queued_records < 0 ||
    usage.queued_records > MEMORY_DERIVATIVE_RESOURCE_LIMITS.derivativeJobRecords ||
    typeof usage.queued_logical_bytes !== 'number' ||
    !Number.isSafeInteger(usage.queued_logical_bytes) || usage.queued_logical_bytes < 0 ||
    usage.queued_logical_bytes >
      MEMORY_DERIVATIVE_RESOURCE_LIMITS.derivativeJobLogicalBytesTotal ||
    typeof usage.updated_at_ms !== 'number' ||
    !Number.isSafeInteger(usage.updated_at_ms) || usage.updated_at_ms < 0) {
    return schemaUnsupported()
  }
  const projectors = database.prepare(`
    SELECT projector_kind, status, projection_generation, index_fingerprint,
      last_applied_sequence, rebuild_after_sequence,
      scan_namespace_ref, scan_memory_id, updated_at_ms
    FROM memory_derivative_projectors
    ORDER BY projector_kind ASC LIMIT 3
  `).all()
  if (projectors.length !== 2 || projectors[0]?.projector_kind !== 'lexical' ||
    projectors[1]?.projector_kind !== 'vector') return schemaUnsupported()
  for (const projector of projectors) {
    if ((projector.status !== 'disabled' && projector.status !== 'rebuild_required' &&
      projector.status !== 'rebuilding' && projector.status !== 'ready') ||
      typeof projector.projection_generation !== 'number' ||
      !Number.isSafeInteger(projector.projection_generation) ||
      projector.projection_generation < 0 ||
      (projector.index_fingerprint !== null && (
        typeof projector.index_fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(projector.index_fingerprint)
      )) || typeof projector.last_applied_sequence !== 'number' ||
      !Number.isSafeInteger(projector.last_applied_sequence) ||
      projector.last_applied_sequence < 0 ||
      typeof projector.rebuild_after_sequence !== 'number' ||
      !Number.isSafeInteger(projector.rebuild_after_sequence) ||
      projector.rebuild_after_sequence < 0 ||
      (projector.scan_namespace_ref !== null && (
        typeof projector.scan_namespace_ref !== 'string' ||
        !/^[0-9a-f]{64}$/.test(projector.scan_namespace_ref)
      )) || (projector.scan_memory_id !== null && (
        typeof projector.scan_memory_id !== 'string' ||
        projector.scan_memory_id.length < 1 || projector.scan_memory_id.length > 128
      )) || ((projector.scan_namespace_ref === null) !==
        (projector.scan_memory_id === null)) ||
      typeof projector.updated_at_ms !== 'number' ||
      !Number.isSafeInteger(projector.updated_at_ms) || projector.updated_at_ms < 0) {
      return schemaUnsupported()
    }
    const inactive = projector.status === 'disabled' ||
      projector.status === 'rebuild_required'
    if ((inactive && (
      projector.projection_generation !== 0 || projector.index_fingerprint !== null ||
      projector.scan_namespace_ref !== null
    )) || (!inactive && (
      projector.projection_generation === 0 || projector.index_fingerprint === null
    )) || (projector.status === 'ready' && (
      projector.scan_namespace_ref !== null ||
      projector.last_applied_sequence < projector.rebuild_after_sequence
    ))) return schemaUnsupported()
  }
}

function validateDatabaseIdentityForVersion (
  database: DatabaseSync,
  version: number
): void {
  if (version === MEMORY_SQLITE_SCHEMA_VERSION_V1) return validateDatabaseIdentity(database)
  if (version === MEMORY_SQLITE_SCHEMA_VERSION_V2) return validateDatabaseIdentityV2(database)
  if (version === MEMORY_SQLITE_SCHEMA_VERSION_V3) return validateDatabaseIdentityV3(database)
  return schemaUnsupported()
}

function validateDatabaseIdentityTransaction (
  database: DatabaseSync,
  immediate: boolean
): void {
  let transactionStarted = false
  try {
    database.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
    transactionStarted = true
    validateDatabaseIdentity(database)
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The fixed validation failure remains authoritative.
      }
    }
    throw error
  }
}

function validateDatabaseIdentityTransactionForVersion (
  database: DatabaseSync,
  immediate: boolean,
  version: number
): void {
  let transactionStarted = false
  try {
    database.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
    transactionStarted = true
    validateDatabaseIdentityForVersion(database, version)
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The fixed validation failure remains authoritative.
      }
    }
    throw error
  }
}

function readHeader (
  location: string,
  acceptedVersions: readonly number[] = [MEMORY_SQLITE_SCHEMA_VERSION_V1]
): {
    readonly identity: FileIdentityV1
    readonly header: Buffer
    readonly schemaVersion: number
  } {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(location, { bigint: true })
  } catch {
    return sqliteUnavailable()
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return schemaUnsupported()
  if (stat.size < SQLITE_HEADER_BYTES ||
    stat.size > BigInt(MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes) ||
    stat.size % 4_096n !== 0n) return sqliteUnavailable()
  if ((stat.mode & 0o077n) !== 0n) return schemaUnsupported()
  if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
    return schemaUnsupported()
  }

  const header = Buffer.alloc(SQLITE_HEADER_BYTES)
  let descriptor: number | undefined
  try {
    descriptor = openSync(location, 'r')
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      return schemaUnsupported()
    }
  } catch {
    return sqliteUnavailable()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  if (!header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    return sqliteUnavailable()
  }
  const schemaVersion = header.readUInt32BE(SQLITE_USER_VERSION_OFFSET)
  if (header.readUInt16BE(16) !== 4_096 ||
    header.readUInt32BE(SQLITE_SCHEMA_FORMAT_OFFSET) !== 4 ||
    header.readUInt32BE(SQLITE_TEXT_ENCODING_OFFSET) !== 1 ||
    !acceptedVersions.includes(schemaVersion) ||
    header.readUInt32BE(SQLITE_APPLICATION_ID_OFFSET) !== MEMORY_SQLITE_APPLICATION_ID_V1) {
    return schemaUnsupported()
  }
  return Object.freeze({
    identity: Object.freeze({ device: stat.dev, inode: stat.ino }),
    header,
    schemaVersion
  })
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

function validateSidecarBudget (location: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      const stat = lstatSync(`${location}${suffix}`, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) return schemaUnsupported()
      if (stat.size > BigInt(MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes)) {
        return sqliteUnavailable()
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return schemaUnsupported()
    }
  }
}

function preflightExistingDatabase (location: string): FileIdentityV1 {
  const { identity } = readHeader(location)
  validateSidecarBudget(location)
  const database = openDatabase(location, true)
  try {
    validateDatabaseIdentityTransaction(database, false)
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1) throw error
    return sqliteUnavailable()
  } finally {
    database.close()
  }
  sameFileIdentity(location, identity)
  return identity
}

function preflightExistingDatabaseV2 (
  location: string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): { readonly identity: FileIdentityV1; readonly schemaVersion: number } {
  const { identity, schemaVersion } = readHeader(location, [
    MEMORY_SQLITE_SCHEMA_VERSION_V1,
    MEMORY_SQLITE_SCHEMA_VERSION_V2
  ])
  validateSidecarBudget(location)
  const database = openDatabase(location, true)
  try {
    validateDatabaseIdentityTransactionForVersion(database, false, schemaVersion)
    assertSqliteMemoryMigrationV2Ready(database, manifests)
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return schemaUnsupported()
  } finally {
    database.close()
  }
  sameFileIdentity(location, identity)
  return Object.freeze({ identity, schemaVersion })
}

function preflightExistingDatabaseV3 (
  location: string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): { readonly identity: FileIdentityV1; readonly schemaVersion: number } {
  const { identity, schemaVersion } = readHeader(location, [
    MEMORY_SQLITE_SCHEMA_VERSION_V1,
    MEMORY_SQLITE_SCHEMA_VERSION_V2,
    MEMORY_SQLITE_SCHEMA_VERSION_V3
  ])
  validateSidecarBudget(location)
  const database = openDatabase(location, true)
  try {
    validateDatabaseIdentityTransactionForVersion(database, false, schemaVersion)
    assertSqliteMemoryMigrationV3Ready(database, manifests)
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return schemaUnsupported()
  } finally {
    database.close()
  }
  sameFileIdentity(location, identity)
  return Object.freeze({ identity, schemaVersion })
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
    PRAGMA cache_size = -2048;
    PRAGMA busy_timeout = 1000;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = 33554432;
    PRAGMA max_page_count = 131072;
    PRAGMA mmap_size = 0;
  `)
  requirePragmaValue(database, 'page_size', 4_096)
  requirePragmaValue(database, 'journal_mode', inMemory ? 'memory' : 'wal')
  requirePragmaValue(database, 'synchronous', 2)
  requirePragmaValue(database, 'foreign_keys', 1)
  requirePragmaValue(database, 'secure_delete', 1)
  requirePragmaValue(database, 'trusted_schema', 0)
  requirePragmaValue(database, 'temp_store', 1)
  requirePragmaValue(database, 'cache_size', -2_048)
  requirePragmaValue(database, 'busy_timeout', 1_000)
  requirePragmaValue(database, 'wal_autocheckpoint', 1_000)
  requirePragmaValue(database, 'journal_size_limit', 33_554_432)
  requirePragmaValue(database, 'max_page_count', 131_072)
  requirePragmaValue(database, 'mmap_size', inMemory ? undefined : 0)
}

function checkpointForPublication (database: DatabaseSync): void {
  const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  if (row === undefined || row.busy !== 0) return sqliteUnavailable()
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

function bootstrapFileDatabase (
  location: string,
  now: () => string
): void {
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
    runSqliteMemoryMigrationSequenceV1(database, {
      migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1]),
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentity(database)
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
        // Cleanup remains best-effort; the fixed public error is authoritative.
      }
    }
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      cleanupOwnedBootstrap(temporary)
    } catch {
      // Never replace the fixed public error with a cleanup path or SQLite message.
    }
    if (error instanceof SqliteMemoryDatabaseErrorV1) throw error
    return sqliteUnavailable()
  }
  preflightExistingDatabase(location)
}

function bootstrapFileDatabaseV2 (
  location: string,
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): void {
  const directory = path.dirname(location)
  const temporary = path.join(
    directory,
    `.${path.basename(location)}.bootstrap-v2-${process.pid}-${randomUUID()}`
  )
  let descriptor: number | undefined
  let database: DatabaseSync | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    closeSync(descriptor)
    descriptor = undefined
    database = openDatabase(temporary, false)
    configureRuntime(database, false)
    runSqliteMemoryMigrationV2(database, {
      manifests,
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentityV2(database)
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
        // Cleanup remains best-effort; the fixed public error is authoritative.
      }
    }
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      cleanupOwnedBootstrap(temporary)
    } catch {
      // Never replace the fixed public error with a cleanup path or SQLite message.
    }
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  preflightExistingDatabaseV2(location, manifests)
}

function bootstrapFileDatabaseV3 (
  location: string,
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): void {
  const directory = path.dirname(location)
  const temporary = path.join(
    directory,
    `.${path.basename(location)}.bootstrap-v3-${process.pid}-${randomUUID()}`
  )
  let descriptor: number | undefined
  let database: DatabaseSync | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    closeSync(descriptor)
    descriptor = undefined
    database = openDatabase(temporary, false)
    configureRuntime(database, false)
    runSqliteMemoryMigrationV3(database, {
      manifests,
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentityV3(database)
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
        // Cleanup remains best-effort; the fixed public error is authoritative.
      }
    }
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      cleanupOwnedBootstrap(temporary)
    } catch {
      // Never replace the fixed public error with a cleanup path or SQLite message.
    }
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  preflightExistingDatabaseV3(location, manifests)
}

function openWritableDatabase (
  location: string,
  expectedIdentity: FileIdentityV1
): SqliteMemoryDatabaseV1 {
  const database = openDatabase(location, false)
  try {
    sameFileIdentity(location, expectedIdentity)
    validateDatabaseIdentityTransaction(database, true)
    configureRuntime(database, false)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openWritableDatabaseV2 (
  location: string,
  expectedIdentity: FileIdentityV1,
  schemaVersion: number,
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): SqliteMemoryDatabaseV1 {
  const database = openDatabase(location, false)
  try {
    sameFileIdentity(location, expectedIdentity)
    if (schemaVersion === MEMORY_SQLITE_SCHEMA_VERSION_V1) {
      configureRuntime(database, false)
      runSqliteMemoryMigrationV2(database, {
        manifests,
        appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
      })
    }
    validateDatabaseIdentityTransactionForVersion(
      database,
      true,
      MEMORY_SQLITE_SCHEMA_VERSION_V2
    )
    configureRuntime(database, false)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openWritableDatabaseV3 (
  location: string,
  expectedIdentity: FileIdentityV1,
  schemaVersion: number,
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): SqliteMemoryDatabaseV1 {
  const database = openDatabase(location, false)
  try {
    sameFileIdentity(location, expectedIdentity)
    if (schemaVersion < MEMORY_SQLITE_SCHEMA_VERSION_V3) {
      configureRuntime(database, false)
      runSqliteMemoryMigrationV3(database, {
        manifests,
        appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
      })
    }
    validateDatabaseIdentityTransactionForVersion(
      database,
      true,
      MEMORY_SQLITE_SCHEMA_VERSION_V3
    )
    configureRuntime(database, false)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openInMemoryDatabase (now: () => string): SqliteMemoryDatabaseV1 {
  const database = openDatabase(':memory:', false)
  try {
    configureRuntime(database, true)
    runSqliteMemoryMigrationSequenceV1(database, {
      migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1]),
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentity(database)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openInMemoryDatabaseV2 (
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): SqliteMemoryDatabaseV1 {
  const database = openDatabase(':memory:', false)
  try {
    configureRuntime(database, true)
    runSqliteMemoryMigrationV2(database, {
      manifests,
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentityV2(database)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
}

function openInMemoryDatabaseV3 (
  now: () => string,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): SqliteMemoryDatabaseV1 {
  const database = openDatabase(':memory:', false)
  try {
    configureRuntime(database, true)
    runSqliteMemoryMigrationV3(database, {
      manifests,
      appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
    })
    validateDatabaseIdentityV3(database)
  } catch (error) {
    database.close()
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    database.close()
    closed = true
  }
  return Object.freeze({ database, close })
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

export function openSqliteMemoryDatabaseV1 (
  optionsValue: OpenSqliteMemoryDatabaseOptionsV1
): SqliteMemoryDatabaseV1 {
  const options = parseOptions(optionsValue)
  databaseConstructor()
  if (options.location === ':memory:') return openInMemoryDatabase(options.now)
  try {
    if (!locationExists(options.location)) {
      bootstrapFileDatabase(options.location, options.now)
    }
    const identity = preflightExistingDatabase(options.location)
    return openWritableDatabase(options.location, identity)
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1) throw error
    return sqliteUnavailable()
  }
}

export function openSqliteMemoryDatabaseV2 (
  optionsValue: OpenSqliteMemoryDatabaseOptionsV2
): SqliteMemoryDatabaseV1 {
  const options = parseOptionsV2(optionsValue)
  databaseConstructor()
  if (options.location === ':memory:') {
    return openInMemoryDatabaseV2(options.now, options.manifests)
  }
  try {
    if (!locationExists(options.location)) {
      bootstrapFileDatabaseV2(options.location, options.now, options.manifests)
    }
    const preflight = preflightExistingDatabaseV2(options.location, options.manifests)
    return openWritableDatabaseV2(
      options.location,
      preflight.identity,
      preflight.schemaVersion,
      options.now,
      options.manifests
    )
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
}

export function openSqliteMemoryDatabaseV3 (
  optionsValue: OpenSqliteMemoryDatabaseOptionsV3
): SqliteMemoryDatabaseV1 {
  const options = parseOptionsV2(optionsValue)
  databaseConstructor()
  if (options.location === ':memory:') {
    return openInMemoryDatabaseV3(options.now, options.manifests)
  }
  try {
    if (!locationExists(options.location)) {
      bootstrapFileDatabaseV3(options.location, options.now, options.manifests)
    }
    const preflight = preflightExistingDatabaseV3(options.location, options.manifests)
    return openWritableDatabaseV3(
      options.location,
      preflight.identity,
      preflight.schemaVersion,
      options.now,
      options.manifests
    )
  } catch (error) {
    if (error instanceof SqliteMemoryDatabaseErrorV1 ||
      error instanceof MemorySqliteMigrationErrorV2) throw error
    return sqliteUnavailable()
  }
}
