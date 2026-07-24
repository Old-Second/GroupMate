import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
import { assertSqliteMemoryMigrationV2Ready, MemorySqliteMigrationErrorV2, MEMORY_SQLITE_APPLICATION_ID_V1, MEMORY_SQLITE_MIGRATION_V1, MEMORY_SQLITE_MIGRATIONS_V2, MEMORY_SQLITE_SCHEMA_VERSION_V1, MEMORY_SQLITE_SCHEMA_VERSION_V2, MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1, MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2, runSqliteMemoryMigrationV2, runSqliteMemoryMigrationSequenceV1, sqliteMemorySchemaFingerprintV1 } from './sqlite-memory-migrations.js';
export { MEMORY_SQLITE_APPLICATION_ID_V1, MEMORY_SQLITE_SCHEMA_VERSION_V1, MEMORY_SQLITE_SCHEMA_VERSION_V2 } from './sqlite-memory-migrations.js';
export class SqliteMemoryDatabaseErrorV1 extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = 'SqliteMemoryDatabaseErrorV1';
        this.code = code;
    }
}
const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
const SQLITE_SCHEMA_FORMAT_OFFSET = 44;
const SQLITE_TEXT_ENCODING_OFFSET = 56;
const SQLITE_USER_VERSION_OFFSET = 60;
const SQLITE_APPLICATION_ID_OFFSET = 68;
const require = createRequire(import.meta.url);
let sqliteDatabaseConstructor;
function schemaUnsupported() {
    throw new SqliteMemoryDatabaseErrorV1('memory_schema_unsupported');
}
function sqliteUnavailable() {
    throw new SqliteMemoryDatabaseErrorV1('memory_sqlite_unavailable');
}
function nodeRuntimeSupportsMemorySqlite() {
    const match = /^(\d+)\.(\d+)\./.exec(process.versions.node);
    if (match === null)
        return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return Number.isSafeInteger(major) && Number.isSafeInteger(minor) &&
        (major > 22 || (major === 22 && minor >= 14));
}
function databaseConstructor() {
    if (!nodeRuntimeSupportsMemorySqlite())
        return sqliteUnavailable();
    if (sqliteDatabaseConstructor !== undefined)
        return sqliteDatabaseConstructor;
    try {
        const sqlite = require('node:sqlite');
        sqliteDatabaseConstructor = sqlite.DatabaseSync;
        return sqliteDatabaseConstructor;
    }
    catch {
        return sqliteUnavailable();
    }
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, ['location', 'now']);
    if (typeof input.location !== 'string' || input.location.length === 0 ||
        input.location.length > 4_096 || input.location.includes('\0') ||
        typeof input.now !== 'function')
        return invalidMemoryValue();
    return Object.freeze({
        location: input.location,
        now: input.now
    });
}
function parseOptionsV2(value) {
    const input = inspectMemoryRecord(value, ['location', 'now', 'manifests']);
    if (typeof input.location !== 'string' || input.location.length === 0 ||
        input.location.length > 4_096 || input.location.includes('\0') ||
        typeof input.now !== 'function' || !Array.isArray(input.manifests)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        location: input.location,
        now: input.now,
        manifests: input.manifests
    });
}
function canonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        return invalidMemoryValue();
    }
    return value;
}
function sqliteOptions(readOnly) {
    return {
        open: false,
        readOnly,
        allowExtension: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false
    };
}
function openDatabase(location, readOnly) {
    const SqliteDatabase = databaseConstructor();
    const database = new SqliteDatabase(location, sqliteOptions(readOnly));
    try {
        database.open();
        return database;
    }
    catch {
        try {
            database.close();
        }
        catch {
            // A failed open has no authoritative handle to preserve.
        }
        return sqliteUnavailable();
    }
}
function pragmaValue(database, name) {
    const row = database.prepare(`PRAGMA ${name}`).get();
    return row === undefined ? undefined : Object.values(row)[0];
}
function requirePragmaValue(database, name, expected) {
    if (pragmaValue(database, name) !== expected)
        return schemaUnsupported();
}
function exactMigrationMetadata(database) {
    const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 2
  `).all();
    if (rows.length !== 1)
        return schemaUnsupported();
    const row = rows[0];
    if (row === undefined || row.version !== MEMORY_SQLITE_SCHEMA_VERSION_V1 ||
        row.checksum !== MEMORY_SQLITE_MIGRATION_V1.checksum ||
        row.schema_fingerprint !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1) {
        return schemaUnsupported();
    }
    try {
        canonicalInstant(row.applied_at);
    }
    catch {
        return schemaUnsupported();
    }
}
function exactMigrationMetadataV2(database) {
    const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 3
  `).all();
    if (rows.length !== MEMORY_SQLITE_MIGRATIONS_V2.length)
        return schemaUnsupported();
    rows.forEach((row, index) => {
        const migration = MEMORY_SQLITE_MIGRATIONS_V2[index];
        if (migration === undefined || row.version !== migration.version ||
            row.checksum !== migration.checksum ||
            row.schema_fingerprint !== migration.schemaFingerprint) {
            return schemaUnsupported();
        }
        try {
            canonicalInstant(row.applied_at);
        }
        catch {
            return schemaUnsupported();
        }
    });
}
function validateDatabaseIdentity(database) {
    requirePragmaValue(database, 'application_id', MEMORY_SQLITE_APPLICATION_ID_V1);
    requirePragmaValue(database, 'user_version', MEMORY_SQLITE_SCHEMA_VERSION_V1);
    requirePragmaValue(database, 'foreign_keys', 1);
    if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1) {
        return schemaUnsupported();
    }
    exactMigrationMetadata(database);
}
function validateDatabaseIdentityV2(database) {
    requirePragmaValue(database, 'application_id', MEMORY_SQLITE_APPLICATION_ID_V1);
    requirePragmaValue(database, 'user_version', MEMORY_SQLITE_SCHEMA_VERSION_V2);
    requirePragmaValue(database, 'foreign_keys', 1);
    if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2) {
        return schemaUnsupported();
    }
    exactMigrationMetadataV2(database);
    const state = database.prepare(`
    SELECT trusted_time_high_water_ms, export_fencing_counter,
      export_lease_owner_id, export_lease_token, export_leased_until_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get();
    if (state === undefined || typeof state.trusted_time_high_water_ms !== 'number' ||
        !Number.isSafeInteger(state.trusted_time_high_water_ms) ||
        state.trusted_time_high_water_ms < 0 ||
        typeof state.export_fencing_counter !== 'number' ||
        !Number.isSafeInteger(state.export_fencing_counter) ||
        state.export_fencing_counter < 0)
        return schemaUnsupported();
}
function validateDatabaseIdentityForVersion(database, version) {
    if (version === MEMORY_SQLITE_SCHEMA_VERSION_V1)
        return validateDatabaseIdentity(database);
    if (version === MEMORY_SQLITE_SCHEMA_VERSION_V2)
        return validateDatabaseIdentityV2(database);
    return schemaUnsupported();
}
function validateDatabaseIdentityTransaction(database, immediate) {
    let transactionStarted = false;
    try {
        database.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
        transactionStarted = true;
        validateDatabaseIdentity(database);
        database.exec('COMMIT');
        transactionStarted = false;
    }
    catch (error) {
        if (transactionStarted) {
            try {
                database.exec('ROLLBACK');
            }
            catch {
                // The fixed validation failure remains authoritative.
            }
        }
        throw error;
    }
}
function validateDatabaseIdentityTransactionForVersion(database, immediate, version) {
    let transactionStarted = false;
    try {
        database.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
        transactionStarted = true;
        validateDatabaseIdentityForVersion(database, version);
        database.exec('COMMIT');
        transactionStarted = false;
    }
    catch (error) {
        if (transactionStarted) {
            try {
                database.exec('ROLLBACK');
            }
            catch {
                // The fixed validation failure remains authoritative.
            }
        }
        throw error;
    }
}
function readHeader(location, acceptedVersions = [MEMORY_SQLITE_SCHEMA_VERSION_V1]) {
    let stat;
    try {
        stat = lstatSync(location, { bigint: true });
    }
    catch {
        return sqliteUnavailable();
    }
    if (!stat.isFile() || stat.isSymbolicLink())
        return schemaUnsupported();
    if (stat.size < SQLITE_HEADER_BYTES ||
        stat.size > BigInt(MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes) ||
        stat.size % 4096n !== 0n)
        return sqliteUnavailable();
    if ((stat.mode & 63n) !== 0n)
        return schemaUnsupported();
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
        return schemaUnsupported();
    }
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    let descriptor;
    try {
        descriptor = openSync(location, 'r');
        if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
            return schemaUnsupported();
        }
    }
    catch {
        return sqliteUnavailable();
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
    if (!header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        return sqliteUnavailable();
    }
    const schemaVersion = header.readUInt32BE(SQLITE_USER_VERSION_OFFSET);
    if (header.readUInt16BE(16) !== 4_096 ||
        header.readUInt32BE(SQLITE_SCHEMA_FORMAT_OFFSET) !== 4 ||
        header.readUInt32BE(SQLITE_TEXT_ENCODING_OFFSET) !== 1 ||
        !acceptedVersions.includes(schemaVersion) ||
        header.readUInt32BE(SQLITE_APPLICATION_ID_OFFSET) !== MEMORY_SQLITE_APPLICATION_ID_V1) {
        return schemaUnsupported();
    }
    return Object.freeze({
        identity: Object.freeze({ device: stat.dev, inode: stat.ino }),
        header,
        schemaVersion
    });
}
function sameFileIdentity(location, expected) {
    let stat;
    try {
        stat = lstatSync(location, { bigint: true });
    }
    catch {
        return schemaUnsupported();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expected.device ||
        stat.ino !== expected.inode)
        return schemaUnsupported();
}
function validateSidecarBudget(location) {
    for (const suffix of ['-wal', '-shm']) {
        try {
            const stat = lstatSync(`${location}${suffix}`, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink())
                return schemaUnsupported();
            if (stat.size > BigInt(MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes)) {
                return sqliteUnavailable();
            }
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                return schemaUnsupported();
        }
    }
}
function preflightExistingDatabase(location) {
    const { identity } = readHeader(location);
    validateSidecarBudget(location);
    const database = openDatabase(location, true);
    try {
        validateDatabaseIdentityTransaction(database, false);
    }
    catch (error) {
        if (error instanceof SqliteMemoryDatabaseErrorV1)
            throw error;
        return sqliteUnavailable();
    }
    finally {
        database.close();
    }
    sameFileIdentity(location, identity);
    return identity;
}
function preflightExistingDatabaseV2(location, manifests) {
    const { identity, schemaVersion } = readHeader(location, [
        MEMORY_SQLITE_SCHEMA_VERSION_V1,
        MEMORY_SQLITE_SCHEMA_VERSION_V2
    ]);
    validateSidecarBudget(location);
    const database = openDatabase(location, true);
    try {
        validateDatabaseIdentityTransactionForVersion(database, false, schemaVersion);
        assertSqliteMemoryMigrationV2Ready(database, manifests);
    }
    catch (error) {
        if (error instanceof SqliteMemoryDatabaseErrorV1 ||
            error instanceof MemorySqliteMigrationErrorV2)
            throw error;
        return schemaUnsupported();
    }
    finally {
        database.close();
    }
    sameFileIdentity(location, identity);
    return Object.freeze({ identity, schemaVersion });
}
function configureRuntime(database, inMemory) {
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
  `);
    requirePragmaValue(database, 'page_size', 4_096);
    requirePragmaValue(database, 'journal_mode', inMemory ? 'memory' : 'wal');
    requirePragmaValue(database, 'synchronous', 2);
    requirePragmaValue(database, 'foreign_keys', 1);
    requirePragmaValue(database, 'secure_delete', 1);
    requirePragmaValue(database, 'trusted_schema', 0);
    requirePragmaValue(database, 'temp_store', 1);
    requirePragmaValue(database, 'cache_size', -2_048);
    requirePragmaValue(database, 'busy_timeout', 1_000);
    requirePragmaValue(database, 'wal_autocheckpoint', 1_000);
    requirePragmaValue(database, 'journal_size_limit', 33_554_432);
    requirePragmaValue(database, 'max_page_count', 131_072);
    requirePragmaValue(database, 'mmap_size', inMemory ? undefined : 0);
}
function checkpointForPublication(database) {
    const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (row === undefined || row.busy !== 0)
        return sqliteUnavailable();
}
function fsyncPath(location) {
    const descriptor = openSync(location, 'r');
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function removeOwnedPath(location) {
    try {
        unlinkSync(location);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
function cleanupOwnedBootstrap(location) {
    removeOwnedPath(`${location}-wal`);
    removeOwnedPath(`${location}-shm`);
    removeOwnedPath(`${location}-journal`);
    removeOwnedPath(location);
}
function isErrno(value, code) {
    return value !== null && typeof value === 'object' &&
        Object.getOwnPropertyDescriptor(value, 'code')?.value === code;
}
function bootstrapFileDatabase(location, now) {
    const directory = path.dirname(location);
    const temporary = path.join(directory, `.${path.basename(location)}.bootstrap-${process.pid}-${randomUUID()}`);
    let descriptor;
    let database;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        closeSync(descriptor);
        descriptor = undefined;
        database = openDatabase(temporary, false);
        configureRuntime(database, false);
        runSqliteMemoryMigrationSequenceV1(database, {
            migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1]),
            appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
        });
        validateDatabaseIdentity(database);
        checkpointForPublication(database);
        database.close();
        database = undefined;
        removeOwnedPath(`${temporary}-wal`);
        removeOwnedPath(`${temporary}-shm`);
        removeOwnedPath(`${temporary}-journal`);
        fsyncPath(temporary);
        try {
            linkSync(temporary, location);
            fsyncPath(directory);
            removeOwnedPath(temporary);
            fsyncPath(directory);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
            cleanupOwnedBootstrap(temporary);
        }
    }
    catch (error) {
        if (database !== undefined) {
            try {
                database.close();
            }
            catch {
                // Cleanup remains best-effort; the fixed public error is authoritative.
            }
        }
        if (descriptor !== undefined)
            closeSync(descriptor);
        try {
            cleanupOwnedBootstrap(temporary);
        }
        catch {
            // Never replace the fixed public error with a cleanup path or SQLite message.
        }
        if (error instanceof SqliteMemoryDatabaseErrorV1)
            throw error;
        return sqliteUnavailable();
    }
    preflightExistingDatabase(location);
}
function bootstrapFileDatabaseV2(location, now, manifests) {
    const directory = path.dirname(location);
    const temporary = path.join(directory, `.${path.basename(location)}.bootstrap-v2-${process.pid}-${randomUUID()}`);
    let descriptor;
    let database;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        closeSync(descriptor);
        descriptor = undefined;
        database = openDatabase(temporary, false);
        configureRuntime(database, false);
        runSqliteMemoryMigrationV2(database, {
            manifests,
            appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
        });
        validateDatabaseIdentityV2(database);
        checkpointForPublication(database);
        database.close();
        database = undefined;
        removeOwnedPath(`${temporary}-wal`);
        removeOwnedPath(`${temporary}-shm`);
        removeOwnedPath(`${temporary}-journal`);
        fsyncPath(temporary);
        try {
            linkSync(temporary, location);
            fsyncPath(directory);
            removeOwnedPath(temporary);
            fsyncPath(directory);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
            cleanupOwnedBootstrap(temporary);
        }
    }
    catch (error) {
        if (database !== undefined) {
            try {
                database.close();
            }
            catch {
                // Cleanup remains best-effort; the fixed public error is authoritative.
            }
        }
        if (descriptor !== undefined)
            closeSync(descriptor);
        try {
            cleanupOwnedBootstrap(temporary);
        }
        catch {
            // Never replace the fixed public error with a cleanup path or SQLite message.
        }
        if (error instanceof SqliteMemoryDatabaseErrorV1 ||
            error instanceof MemorySqliteMigrationErrorV2)
            throw error;
        return sqliteUnavailable();
    }
    preflightExistingDatabaseV2(location, manifests);
}
function openWritableDatabase(location, expectedIdentity) {
    const database = openDatabase(location, false);
    try {
        sameFileIdentity(location, expectedIdentity);
        validateDatabaseIdentityTransaction(database, true);
        configureRuntime(database, false);
    }
    catch (error) {
        database.close();
        if (error instanceof SqliteMemoryDatabaseErrorV1)
            throw error;
        return sqliteUnavailable();
    }
    let closed = false;
    const close = () => {
        if (closed)
            return;
        database.close();
        closed = true;
    };
    return Object.freeze({ database, close });
}
function openWritableDatabaseV2(location, expectedIdentity, schemaVersion, now, manifests) {
    const database = openDatabase(location, false);
    try {
        sameFileIdentity(location, expectedIdentity);
        if (schemaVersion === MEMORY_SQLITE_SCHEMA_VERSION_V1) {
            configureRuntime(database, false);
            runSqliteMemoryMigrationV2(database, {
                manifests,
                appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
            });
        }
        validateDatabaseIdentityTransactionForVersion(database, true, MEMORY_SQLITE_SCHEMA_VERSION_V2);
        configureRuntime(database, false);
    }
    catch (error) {
        database.close();
        if (error instanceof SqliteMemoryDatabaseErrorV1 ||
            error instanceof MemorySqliteMigrationErrorV2)
            throw error;
        return sqliteUnavailable();
    }
    let closed = false;
    const close = () => {
        if (closed)
            return;
        database.close();
        closed = true;
    };
    return Object.freeze({ database, close });
}
function openInMemoryDatabase(now) {
    const database = openDatabase(':memory:', false);
    try {
        configureRuntime(database, true);
        runSqliteMemoryMigrationSequenceV1(database, {
            migrations: Object.freeze([MEMORY_SQLITE_MIGRATION_V1]),
            appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
        });
        validateDatabaseIdentity(database);
    }
    catch (error) {
        database.close();
        if (error instanceof SqliteMemoryDatabaseErrorV1)
            throw error;
        return sqliteUnavailable();
    }
    let closed = false;
    const close = () => {
        if (closed)
            return;
        database.close();
        closed = true;
    };
    return Object.freeze({ database, close });
}
function openInMemoryDatabaseV2(now, manifests) {
    const database = openDatabase(':memory:', false);
    try {
        configureRuntime(database, true);
        runSqliteMemoryMigrationV2(database, {
            manifests,
            appliedAt: canonicalInstant(Reflect.apply(now, undefined, []))
        });
        validateDatabaseIdentityV2(database);
    }
    catch (error) {
        database.close();
        if (error instanceof SqliteMemoryDatabaseErrorV1 ||
            error instanceof MemorySqliteMigrationErrorV2)
            throw error;
        return sqliteUnavailable();
    }
    let closed = false;
    const close = () => {
        if (closed)
            return;
        database.close();
        closed = true;
    };
    return Object.freeze({ database, close });
}
function locationExists(location) {
    try {
        lstatSync(location);
        return true;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        return schemaUnsupported();
    }
}
export function openSqliteMemoryDatabaseV1(optionsValue) {
    const options = parseOptions(optionsValue);
    databaseConstructor();
    if (options.location === ':memory:')
        return openInMemoryDatabase(options.now);
    try {
        if (!locationExists(options.location)) {
            bootstrapFileDatabase(options.location, options.now);
        }
        const identity = preflightExistingDatabase(options.location);
        return openWritableDatabase(options.location, identity);
    }
    catch (error) {
        if (error instanceof SqliteMemoryDatabaseErrorV1)
            throw error;
        return sqliteUnavailable();
    }
}
export function openSqliteMemoryDatabaseV2(optionsValue) {
    const options = parseOptionsV2(optionsValue);
    databaseConstructor();
    if (options.location === ':memory:') {
        return openInMemoryDatabaseV2(options.now, options.manifests);
    }
    try {
        if (!locationExists(options.location)) {
            bootstrapFileDatabaseV2(options.location, options.now, options.manifests);
        }
        const preflight = preflightExistingDatabaseV2(options.location, options.manifests);
        return openWritableDatabaseV2(options.location, preflight.identity, preflight.schemaVersion, options.now, options.manifests);
    }
    catch (error) {
        if (error instanceof SqliteMemoryDatabaseErrorV1 ||
            error instanceof MemorySqliteMigrationErrorV2)
            throw error;
        return sqliteUnavailable();
    }
}
