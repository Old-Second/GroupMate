import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { decodeCanonicalMemoryRevisionV1 } from '../agent/memory/memory-canonical-wire.js';
import { createLexicalMemoryRetrieverV2 } from '../agent/memory/memory-lexical-retriever.js';
import { createMemoryControlRepositoryPortV1 } from '../agent/memory/memory-control-repository.js';
import { consumeMemoryExportDeliveryHandleV1, createMemoryExportPortV1, MEMORY_EXPORT_MAX_CHUNK_BYTES_V1, MEMORY_EXPORT_MAX_WIRE_BYTES_V1 } from '../agent/memory/memory-export-port.js';
import { createMemoryLifecyclePortV1 } from '../agent/memory/memory-lifecycle-port.js';
import { createPersonalMemoryEnrollmentPortV1 } from '../agent/memory/personal-memory-enrollment.js';
import { createPersonalMemoryLifecycleFacadeV1 } from '../agent/memory/personal-memory-lifecycle-facade.js';
import { createPersonalMemoryRecallSourceV1 } from '../agent/memory/personal-memory-recall.js';
import { openSqliteMemoryDatabaseV3 } from '../agent/memory/sqlite-memory-database.js';
import { openSqliteMemoryLexicalDatabaseV1, MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1 } from '../agent/memory/sqlite-memory-lexical-database.js';
import { createSqliteMemoryLexicalIndexV1, MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1 } from '../agent/memory/sqlite-memory-lexical-index.js';
import { createSqliteMemoryControlRepositoryV1 } from '../agent/memory/sqlite-memory-control-repository.js';
import { createSqliteMemoryExportAdapterV1 } from '../agent/memory/sqlite-memory-export.js';
import { createSqliteMemoryLifecycleAdapterV1 } from '../agent/memory/sqlite-memory-lifecycle.js';
import { createSqlitePersonalMemoryEnrollmentAdapterV1 } from '../agent/memory/sqlite-personal-memory-enrollment.js';
import { createSqliteMemoryCanonicalRehydratorV1 } from '../agent/memory/sqlite-memory-canonical-rehydrator.js';
import { bindYunzaiPersonalMemoryRecallSourceV1, createYunzaiSceneParticipantDirectoryV1 } from './yunzai-scene-participant-directory.js';
import { createYunzaiPersonalMemoryControllerV1 } from './yunzai-personal-memory-controller.js';
const CANONICAL_FILE = 'personal-memory.sqlite';
const LEXICAL_FILE = 'personal-memory-lexical.sqlite';
const EXPORT_DIRECTORY = 'exports';
const EXPORT_DELIVERY_DIRECTORY = 'export-delivery';
const MAX_RECALL_ITEMS = 12;
const MAX_RECALL_TOKENS = 2_400;
const MAX_RECALL_TIMEOUT_MS = 500;
const DEFAULT_RECALL_ITEMS = 6;
const DEFAULT_RECALL_TOKENS = 1_200;
const DEFAULT_RECALL_TIMEOUT_MS = 150;
const MAX_GROUP_ALLOWLIST = 256;
function nowIso() {
    return new Date().toISOString();
}
function abortError() {
    return new DOMException('operation was aborted', 'AbortError');
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw abortError();
}
function boundedInteger(source, fallback, maximum) {
    try {
        const value = Reflect.apply(source, undefined, []);
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
            ? Math.min(value, maximum)
            : fallback;
    }
    catch {
        return fallback;
    }
}
function configuredGroupAllowlist(source) {
    try {
        const value = Reflect.apply(source, undefined, []);
        if (!Array.isArray(value))
            return Object.freeze([]);
        const result = [];
        const seen = new Set();
        for (const item of value) {
            if (result.length >= MAX_GROUP_ALLOWLIST)
                break;
            const normalized = typeof item === 'string' || typeof item === 'number'
                ? String(item).trim()
                : '';
            if (!/^[1-9][0-9]{0,31}$/.test(normalized) || seen.has(normalized))
                continue;
            seen.add(normalized);
            result.push(normalized);
        }
        return Object.freeze(result);
    }
    catch {
        return Object.freeze([]);
    }
}
function integerRow(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('personal memory SQLite counter is invalid');
    }
    return value;
}
function stringRow(value) {
    if (typeof value !== 'string') {
        throw new TypeError('personal memory SQLite identity is invalid');
    }
    return value;
}
function fileBytes(location) {
    const size = statSync(location).size;
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new TypeError('personal memory SQLite file size is invalid');
    }
    return size;
}
function sourceLastSequence(database) {
    const row = database.prepare(`
    SELECT coalesce(max(sequence), 0) AS sequence
    FROM memory_derivative_jobs
  `).get();
    return integerRow(row?.sequence);
}
function beginCanonicalProjection(database, updatedAt) {
    database.exec('BEGIN IMMEDIATE');
    try {
        const row = database.prepare(`
      SELECT projection_generation
      FROM memory_derivative_projectors
      WHERE projector_kind = 'lexical'
    `).get();
        const projectionGeneration = integerRow(row?.projection_generation) + 1;
        const lastSequence = sourceLastSequence(database);
        const changed = database.prepare(`
      UPDATE memory_derivative_projectors
      SET status = 'rebuilding', projection_generation = ?, index_fingerprint = ?,
        rebuild_after_sequence = ?, scan_namespace_ref = NULL, scan_memory_id = NULL,
        updated_at_ms = ?
      WHERE projector_kind = 'lexical'
    `).run(projectionGeneration, MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1, lastSequence, Date.parse(updatedAt)).changes;
        if (changed !== 1)
            throw new TypeError('personal memory projector state is unavailable');
        database.exec('COMMIT');
        return Object.freeze({ projectionGeneration, sourceLastSequence: lastSequence });
    }
    catch (error) {
        try {
            database.exec('ROLLBACK');
        }
        catch { }
        throw error;
    }
}
function completeCanonicalProjection(database, projectionGeneration, lastSequence, updatedAt) {
    database.exec('BEGIN IMMEDIATE');
    try {
        const changed = database.prepare(`
      UPDATE memory_derivative_projectors
      SET status = 'ready', last_applied_sequence = ?, rebuild_after_sequence = ?,
        scan_namespace_ref = NULL, scan_memory_id = NULL, updated_at_ms = ?
      WHERE projector_kind = 'lexical' AND status = 'rebuilding'
        AND projection_generation = ? AND index_fingerprint = ?
    `).run(lastSequence, lastSequence, Date.parse(updatedAt), projectionGeneration, MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1).changes;
        if (changed !== 1)
            throw new TypeError('personal memory projector state is unavailable');
        database.prepare('DELETE FROM memory_derivative_jobs WHERE sequence <= ?').run(lastSequence);
        database.exec('COMMIT');
    }
    catch (error) {
        try {
            database.exec('ROLLBACK');
        }
        catch { }
        throw error;
    }
}
function projectionRows(database, cursor) {
    const predicate = cursor === null
        ? ''
        : `AND (h.namespace_ref > ? OR
      (h.namespace_ref = ? AND h.memory_id > ?))`;
    const statement = database.prepare(`
    SELECT h.namespace_ref, h.namespace_generation, h.memory_id,
      h.current_revision, h.current_revision_hash, h.content_hash,
      p.revision_wire
    FROM heads AS h
    JOIN namespaces AS n
      ON n.namespace_ref = h.namespace_ref
     AND n.namespace_generation = h.namespace_generation
    JOIN revision_payloads AS p
      ON p.namespace_ref = h.namespace_ref
     AND p.namespace_generation = h.namespace_generation
     AND p.memory_id = h.memory_id
     AND p.revision = h.current_revision
    WHERE 1 = 1 ${predicate}
    ORDER BY h.namespace_ref ASC, h.memory_id ASC
    LIMIT ${MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1}
  `);
    return cursor === null
        ? statement.all()
        : statement.all(cursor.namespaceRef, cursor.namespaceRef, cursor.memoryId);
}
function parseProjectionRow(row) {
    const wire = stringRow(row.revision_wire);
    const revision = decodeCanonicalMemoryRevisionV1(wire);
    const record = revision.record;
    const namespaceRef = stringRow(row.namespace_ref);
    const namespaceGeneration = integerRow(row.namespace_generation);
    const memoryId = stringRow(row.memory_id);
    const memoryRevision = integerRow(row.current_revision);
    const revisionHash = stringRow(row.current_revision_hash);
    const contentHash = stringRow(row.content_hash);
    if (record.namespaceRef !== namespaceRef ||
        record.namespaceGeneration !== namespaceGeneration ||
        record.memoryId !== memoryId || record.revision !== memoryRevision ||
        record.contentHash !== contentHash || revision.revisionHash !== revisionHash) {
        throw new TypeError('personal memory canonical projection row is invalid');
    }
    return Object.freeze({ record, revisionHash });
}
function lastCursor(rows) {
    const row = rows.at(-1);
    if (row === undefined)
        throw new TypeError('personal memory projection cursor is unavailable');
    return Object.freeze({
        namespaceRef: stringRow(row.namespace_ref),
        memoryId: stringRow(row.memory_id)
    });
}
function createLexicalProjector(options) {
    let active = null;
    let rerunRequested = false;
    const rebuild = async (signal) => {
        if (active !== null) {
            rerunRequested = true;
            return await active;
        }
        active = (async () => {
            let projected = 0;
            do {
                rerunRequested = false;
                throwIfAborted(signal);
                const startedAt = options.now();
                const state = beginCanonicalProjection(options.canonical, startedAt);
                options.lexical.beginProjection({
                    projectionGeneration: state.projectionGeneration,
                    sourceLastSequence: 0,
                    updatedAt: startedAt
                });
                let cursor = null;
                let currentProjected = 0;
                while (true) {
                    throwIfAborted(signal);
                    const rows = projectionRows(options.canonical, cursor);
                    if (rows.length === 0)
                        break;
                    const documents = rows.map(parseProjectionRow);
                    options.lexical.applyProjectionBatch({
                        projectionGeneration: state.projectionGeneration,
                        sourceLastSequence: state.sourceLastSequence,
                        updatedAt: options.now(),
                        documents
                    });
                    currentProjected += documents.length;
                    cursor = lastCursor(rows);
                    if (rows.length < MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1)
                        break;
                    await new Promise(resolve => setImmediate(resolve));
                }
                const completedAt = options.now();
                options.lexical.completeProjection({
                    projectionGeneration: state.projectionGeneration,
                    sourceLastSequence: state.sourceLastSequence,
                    updatedAt: completedAt
                });
                completeCanonicalProjection(options.canonical, state.projectionGeneration, state.sourceLastSequence, completedAt);
                projected = currentProjected;
            } while (rerunRequested);
            return projected;
        })().finally(() => { active = null; });
        return await active;
    };
    return Object.freeze({
        rebuild,
        waitForIdle: async () => { if (active !== null)
            await active; }
    });
}
function exactMaintenanceRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('personal memory maintenance request is invalid');
    }
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('action')) {
        throw new TypeError('personal memory maintenance request is invalid');
    }
    const input = value;
    if (input.schemaVersion !== 1 ||
        (input.action !== 'verify' && input.action !== 'rebuild_lexical')) {
        throw new TypeError('personal memory maintenance request is invalid');
    }
    return Object.freeze({ schemaVersion: 1, action: input.action });
}
function createOperationsPort(options) {
    const inspect = async (signal) => {
        throwIfAborted(signal);
        const canonical = options.canonical.prepare(`
      SELECT g.namespace_records, g.canonical_logical_bytes,
        (SELECT count(*)
         FROM heads AS h
         JOIN namespaces AS n
           ON n.namespace_ref = h.namespace_ref
          AND n.namespace_generation = h.namespace_generation
        ) AS active_memory_records
      FROM global_usage AS g WHERE g.singleton = 1
    `).get();
        const lexical = options.lexical.prepare(`
      SELECT status, indexed_records, indexed_logical_bytes
      FROM lexical_index_state WHERE singleton = 1
    `).get();
        const extraction = options.canonical.prepare(`
      SELECT queued_records, queued_logical_bytes
      FROM memory_derivative_usage WHERE singleton = 1
    `).get();
        const namespaces = integerRow(canonical?.namespace_records);
        const activeRecords = integerRow(canonical?.active_memory_records);
        const lexicalRecords = integerRow(lexical?.indexed_records);
        const lexicalStatus = lexical?.status === 'ready'
            ? (lexicalRecords === activeRecords ? 'ready' : 'lagging')
            : lexical?.status === 'rebuilding' ? 'rebuilding' : 'lagging';
        const pendingRecords = integerRow(extraction?.queued_records);
        return Object.freeze({
            schemaVersion: 1,
            status: lexicalStatus === 'ready' ? 'ready' : 'degraded',
            canonical: Object.freeze({
                namespaces,
                activeRecords,
                logicalBytes: integerRow(canonical?.canonical_logical_bytes),
                sqliteFileBytes: fileBytes(options.canonicalLocation)
            }),
            lexical: Object.freeze({
                status: lexicalStatus,
                records: lexicalRecords,
                logicalBytes: integerRow(lexical?.indexed_logical_bytes),
                sqliteFileBytes: fileBytes(options.lexicalLocation),
                lagRecords: Math.max(0, activeRecords - lexicalRecords)
            }),
            extraction: Object.freeze({
                status: pendingRecords === 0 ? 'idle' : 'paused',
                pendingRecords,
                deadLetterRecords: 0,
                logicalBytes: integerRow(extraction?.queued_logical_bytes)
            }),
            hotCache: Object.freeze({ status: 'disabled', records: 0, logicalBytes: 0 }),
            semantic: Object.freeze({
                embedding: 'disabled', vector: 'disabled', rerank: 'disabled'
            })
        });
    };
    return Object.freeze({
        inspect,
        async execute(value, signal) {
            const request = exactMaintenanceRequest(value);
            throwIfAborted(signal);
            const affectedRecords = request.action === 'rebuild_lexical'
                ? await options.projector.rebuild(signal)
                : 0;
            if (request.action === 'verify')
                await inspect(signal);
            return Object.freeze({
                schemaVersion: 1,
                status: 'completed',
                action: request.action,
                affectedRecords
            });
        }
    });
}
function createExportDeliveryRuntime(storageDirectory) {
    const directory = path.join(storageDirectory, EXPORT_DELIVERY_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const senders = new Map();
    let persistentDelivery = null;
    const removeQuietly = async (location) => {
        try {
            await unlink(location);
        }
        catch { }
    };
    const consumeArtifact = async (source, manifest) => {
        const sender = senders.get(manifest.exportId);
        if (sender === undefined)
            throw new TypeError('personal memory export sender is unavailable');
        const suffix = randomBytes(8).toString('hex');
        const partial = path.join(directory, `memory-export-${suffix}.part`);
        const complete = path.join(directory, `memory-export-${suffix}.jsonl`);
        const file = await open(partial, 'wx', 0o600);
        let closed = false;
        let bytes = 0;
        try {
            const sink = Object.freeze({
                maximumWireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
                maximumChunkBytes: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
                write: async (chunk) => {
                    if (chunk.byteLength > MEMORY_EXPORT_MAX_CHUNK_BYTES_V1 ||
                        bytes + chunk.byteLength > MEMORY_EXPORT_MAX_WIRE_BYTES_V1) {
                        throw new TypeError('personal memory export exceeds delivery limits');
                    }
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        const written = await file.write(chunk, offset, chunk.byteLength - offset, null);
                        if (written.bytesWritten <= 0) {
                            throw new TypeError('personal memory export delivery write failed');
                        }
                        offset += written.bytesWritten;
                    }
                    bytes += chunk.byteLength;
                },
                commit: async () => undefined,
                abort: async () => undefined
            });
            await source.streamInto(sink);
            await file.sync();
            await file.close();
            closed = true;
            await rename(partial, complete);
            await sender(complete, `GroupMate Personal Memory ${new Date().toISOString().slice(0, 10)}.jsonl`);
        }
        finally {
            if (!closed) {
                try {
                    await file.close();
                }
                catch { }
            }
            await removeQuietly(partial);
            await removeQuietly(complete);
        }
    };
    const delivery = Object.freeze({
        async redeemAndSend(handle, sendFile) {
            const persistent = persistentDelivery;
            if (persistent === null)
                return 'unavailable';
            const consumed = consumeMemoryExportDeliveryHandleV1(handle);
            if (senders.has(consumed.exportId))
                return 'unavailable';
            senders.set(consumed.exportId, sendFile);
            try {
                const result = await persistent.redeemOnce(consumed);
                return result.status;
            }
            finally {
                senders.delete(consumed.exportId);
            }
        }
    });
    return Object.freeze({
        consumeArtifact,
        delivery,
        bind: (value) => {
            if (persistentDelivery !== null) {
                throw new TypeError('personal memory export delivery is already bound');
            }
            persistentDelivery = value;
        },
        close: () => { senders.clear(); }
    });
}
export async function createProductionPersonalMemoryRuntimeV1(options) {
    mkdirSync(options.storageDirectory, { recursive: true, mode: 0o700 });
    const canonicalLocation = path.join(options.storageDirectory, CANONICAL_FILE);
    const lexicalLocation = path.join(options.storageDirectory, LEXICAL_FILE);
    let canonical = null;
    let lexical = null;
    try {
        canonical = openSqliteMemoryDatabaseV3({
            location: canonicalLocation,
            now: nowIso,
            manifests: []
        });
        lexical = openSqliteMemoryLexicalDatabaseV1({
            location: lexicalLocation,
            now: nowIso
        });
        const lexicalIndex = createSqliteMemoryLexicalIndexV1({ database: lexical.database });
        const projector = createLexicalProjector({
            canonical: canonical.database,
            lexical: lexicalIndex,
            now: nowIso
        });
        await projector.rebuild();
        const enrollmentAdapter = createSqlitePersonalMemoryEnrollmentAdapterV1({
            database: canonical.database,
            now: nowIso
        });
        const enrollment = createPersonalMemoryEnrollmentPortV1({
            now: nowIso,
            read: enrollmentAdapter.read,
            decide: enrollmentAdapter.decide
        });
        const lifecycleAdapter = createSqliteMemoryLifecycleAdapterV1({
            database: canonical.database,
            now: nowIso
        });
        const lifecycle = createMemoryLifecyclePortV1({
            now: nowIso,
            execute: lifecycleAdapter.execute
        });
        const controlAdapter = createSqliteMemoryControlRepositoryV1({
            database: canonical.database,
            now: nowIso
        });
        const control = createMemoryControlRepositoryPortV1({
            now: nowIso,
            execute: controlAdapter.execute
        });
        const exportDeliveryRuntime = createExportDeliveryRuntime(options.storageDirectory);
        const exportAdapter = createSqliteMemoryExportAdapterV1({
            database: canonical.database,
            now: nowIso,
            artifactDirectory: path.join(options.storageDirectory, EXPORT_DIRECTORY),
            leaseOwnerId: 'groupmate-production-memory-export',
            consumeArtifact: exportDeliveryRuntime.consumeArtifact
        });
        exportDeliveryRuntime.bind(exportAdapter.persistentDelivery);
        const exportPort = createMemoryExportPortV1({
            now: nowIso,
            execute: exportAdapter.execute,
            cleanupPartial: exportAdapter.cleanupPartial,
            finalizeGenerate: exportAdapter.finalizeGenerate
        });
        const facade = createPersonalMemoryLifecycleFacadeV1({
            enrollment,
            lifecycle,
            control,
            export: exportPort
        });
        const source = createPersonalMemoryRecallSourceV1({
            deploymentMode: options.deploymentMode,
            groupAllowlist: () => configuredGroupAllowlist(options.groupAllowlist),
            participants: createYunzaiSceneParticipantDirectoryV1(),
            enrollment,
            retriever: createLexicalMemoryRetrieverV2({
                index: lexicalIndex,
                canonical: createSqliteMemoryCanonicalRehydratorV1({
                    database: canonical.database,
                    now: nowIso
                }),
                now: nowIso
            }),
            timeoutMs: boundedInteger(options.recallTimeoutMs, DEFAULT_RECALL_TIMEOUT_MS, MAX_RECALL_TIMEOUT_MS),
            limits: Object.freeze({
                maxCandidates: boundedInteger(options.recallMaxItems, DEFAULT_RECALL_ITEMS, MAX_RECALL_ITEMS),
                maxTokens: boundedInteger(options.recallMaxTokens, DEFAULT_RECALL_TOKENS, MAX_RECALL_TOKENS),
                maxBytes: 32 * 1_024
            })
        });
        const recallSource = bindYunzaiPersonalMemoryRecallSourceV1({
            botInstanceId: options.botInstanceId,
            source
        });
        const operations = createOperationsPort({
            canonical: canonical.database,
            canonicalLocation,
            lexical: lexical.database,
            lexicalLocation,
            projector
        });
        const commands = createYunzaiPersonalMemoryControllerV1({
            botInstanceId: options.botInstanceId,
            database: canonical.database,
            mode: options.deploymentMode,
            groupAllowlist: () => configuredGroupAllowlist(options.groupAllowlist),
            now: nowIso,
            facade,
            control,
            exportDelivery: exportDeliveryRuntime.delivery,
            rebuildLexical: async () => await projector.rebuild()
        });
        let closed = false;
        return Object.freeze({
            recallSource: Object.freeze({
                recall: async (input, signal) => await recallSource.recall(input, signal)
            }),
            operations: Object.freeze({
                inspect: async (signal) => await operations.inspect(signal),
                execute: async (request, signal) => await operations.execute(request, signal)
            }),
            commands,
            close: async () => {
                if (closed)
                    return;
                closed = true;
                await projector.waitForIdle().catch(() => undefined);
                exportDeliveryRuntime.close();
                lexical?.close();
                canonical?.close();
            }
        });
    }
    catch (error) {
        try {
            lexical?.close();
        }
        catch { }
        try {
            canonical?.close();
        }
        catch { }
        throw error;
    }
}
