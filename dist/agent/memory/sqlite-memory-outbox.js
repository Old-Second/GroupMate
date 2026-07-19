import { randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { decodeMemoryOutboxEventV1 } from './memory-codec.js';
import { createMemoryOutboxPortV1 } from './memory-outbox.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const SQLITE_MEMORY_OUTBOX_LEASE_DURATION_MS_V1 = 60_000;
export const SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 = 16;
class CanonicalMemoryOutboxDataErrorV1 extends Error {
}
function rowValue(row, key) {
    if (row === undefined)
        return undefined;
    return Object.getOwnPropertyDescriptor(row, key)?.value;
}
function exactInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        throw new CanonicalMemoryOutboxDataErrorV1();
    return value;
}
function positiveInteger(value) {
    const result = exactInteger(value);
    if (result === 0)
        throw new CanonicalMemoryOutboxDataErrorV1();
    return result;
}
function exactString(value) {
    if (typeof value !== 'string')
        throw new CanonicalMemoryOutboxDataErrorV1();
    return value;
}
function canonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) ||
        new Date(milliseconds).toISOString() !== value)
        return invalidMemoryValue();
    return value;
}
function nowInstant(now) {
    let value;
    try {
        value = Reflect.apply(now, undefined, []);
    }
    catch {
        return invalidMemoryValue();
    }
    return canonicalInstant(value);
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, ['database', 'now']);
    const database = input.database;
    if (database === null || typeof database !== 'object' || utilTypes.isProxy(database) ||
        typeof database.prepare !== 'function' ||
        typeof database.exec !== 'function' ||
        typeof input.now !== 'function')
        return invalidMemoryValue();
    return Object.freeze({
        database: database,
        now: input.now
    });
}
function loadUsage(database, namespaceRef, generation) {
    const row = database.prepare(`
    SELECT pending_proposal_records, active_memory_records, retained_revision_records,
           tombstone_records, canonical_logical_bytes, pending_outbox_records,
           outbox_logical_bytes
    FROM usage
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).get(namespaceRef, generation);
    if (row === undefined)
        throw new CanonicalMemoryOutboxDataErrorV1();
    return Object.freeze({
        pendingProposalRecords: exactInteger(rowValue(row, 'pending_proposal_records')),
        activeMemoryRecords: exactInteger(rowValue(row, 'active_memory_records')),
        retainedRevisionRecords: exactInteger(rowValue(row, 'retained_revision_records')),
        tombstoneRecords: exactInteger(rowValue(row, 'tombstone_records')),
        canonicalLogicalBytes: exactInteger(rowValue(row, 'canonical_logical_bytes')),
        pendingOutboxRecords: exactInteger(rowValue(row, 'pending_outbox_records')),
        outboxLogicalBytes: exactInteger(rowValue(row, 'outbox_logical_bytes'))
    });
}
function loadGlobalUsage(database) {
    const row = database.prepare(`
    SELECT namespace_records, active_memory_records, canonical_logical_bytes,
           pending_outbox_records, outbox_logical_bytes
    FROM global_usage
    WHERE singleton = 1
  `).get();
    if (row === undefined)
        throw new CanonicalMemoryOutboxDataErrorV1();
    return Object.freeze({
        namespaceRecords: exactInteger(rowValue(row, 'namespace_records')),
        activeMemoryRecords: exactInteger(rowValue(row, 'active_memory_records')),
        canonicalLogicalBytes: exactInteger(rowValue(row, 'canonical_logical_bytes')),
        pendingOutboxRecords: exactInteger(rowValue(row, 'pending_outbox_records')),
        outboxLogicalBytes: exactInteger(rowValue(row, 'outbox_logical_bytes'))
    });
}
function storeUsage(database, namespaceRef, generation, usage, nowMs) {
    const result = database.prepare(`
    UPDATE usage
    SET pending_proposal_records = ?, active_memory_records = ?,
        retained_revision_records = ?, tombstone_records = ?,
        canonical_logical_bytes = ?, pending_outbox_records = ?,
        outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(usage.pendingProposalRecords, usage.activeMemoryRecords, usage.retainedRevisionRecords, usage.tombstoneRecords, usage.canonicalLogicalBytes, usage.pendingOutboxRecords, usage.outboxLogicalBytes, nowMs, namespaceRef, generation);
    if (result.changes !== 1)
        throw new CanonicalMemoryOutboxDataErrorV1();
}
function storeGlobalUsage(database, usage, nowMs) {
    const result = database.prepare(`
    UPDATE global_usage
    SET namespace_records = ?, active_memory_records = ?, canonical_logical_bytes = ?,
        pending_outbox_records = ?, outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(usage.namespaceRecords, usage.activeMemoryRecords, usage.canonicalLogicalBytes, usage.pendingOutboxRecords, usage.outboxLogicalBytes, nowMs);
    if (result.changes !== 1)
        throw new CanonicalMemoryOutboxDataErrorV1();
}
function deleteUsageWhenEmpty(database, namespaceRef, generation, usage) {
    if (usage.pendingProposalRecords !== 0 || usage.activeMemoryRecords !== 0 ||
        usage.retainedRevisionRecords !== 0 || usage.tombstoneRecords !== 0 ||
        usage.canonicalLogicalBytes !== 0 || usage.pendingOutboxRecords !== 0 ||
        usage.outboxLogicalBytes !== 0)
        return;
    const deleted = database.prepare(`
    DELETE FROM usage WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(namespaceRef, generation);
    if (deleted.changes !== 1)
        throw new CanonicalMemoryOutboxDataErrorV1();
}
function sqliteErrorNumber(error) {
    if (error === null || typeof error !== 'object' || utilTypes.isProxy(error))
        return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
        ? descriptor.value
        : null;
}
function sqliteFailure(error) {
    const errcode = sqliteErrorNumber(error);
    const primary = errcode !== null && errcode >= 0 && errcode <= 0x7fffffff
        ? errcode & 0xff
        : null;
    if (primary === 5 || primary === 6) {
        return Object.freeze({
            status: 'unavailable',
            category: 'busy',
            retryable: true
        });
    }
    if (primary === 10) {
        return Object.freeze({
            status: 'unavailable',
            category: 'io',
            retryable: true
        });
    }
    if (primary === 11 || primary === 26) {
        return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
    }
    return Object.freeze({
        status: 'unavailable',
        category: 'storage',
        retryable: false
    });
}
function runImmediate(database, operation) {
    let transactionStarted = false;
    try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const result = operation();
        database.exec('COMMIT');
        transactionStarted = false;
        return result;
    }
    catch (error) {
        if (transactionStarted) {
            try {
                database.exec('ROLLBACK');
            }
            catch {
                // The fixed canonical/storage result remains authoritative.
            }
        }
        if (error instanceof CanonicalMemoryOutboxDataErrorV1) {
            return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
        }
        return sqliteFailure(error);
    }
}
function runDiagnostic(operation) {
    try {
        return operation();
    }
    catch (error) {
        if (error instanceof CanonicalMemoryOutboxDataErrorV1) {
            return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
        }
        return sqliteFailure(error);
    }
}
function boundedOutboxCounters(database, namespace) {
    const where = namespace === undefined
        ? ''
        : 'WHERE namespace_ref = ? AND namespace_generation = ?';
    const statement = database.prepare(`
    SELECT COUNT(*) AS records, COALESCE(SUM(logical_bytes), 0) AS logical_bytes
    FROM (
      SELECT logical_bytes
      FROM outbox
      ${where}
      ORDER BY sequence ASC
      LIMIT ${MEMORY_RESOURCE_LIMITS.unackedOutboxRecords + 1}
    )
  `);
    const row = namespace === undefined
        ? statement.get()
        : statement.get(namespace.namespaceRef, namespace.generation);
    const counters = Object.freeze({
        records: exactInteger(rowValue(row, 'records')),
        logicalBytes: exactInteger(rowValue(row, 'logical_bytes'))
    });
    if (counters.records > MEMORY_RESOURCE_LIMITS.unackedOutboxRecords ||
        counters.logicalBytes > MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    return counters;
}
function auditOutboxCounters(database, namespace) {
    // Ack is destructive and usage is diagnostic, so both pay this bounded audit.
    // Ordinary enqueue paths continue to maintain exact counters without scanning rows.
    const global = loadGlobalUsage(database);
    const globalCounters = boundedOutboxCounters(database);
    if (global.pendingOutboxRecords !== globalCounters.records ||
        global.outboxLogicalBytes !== globalCounters.logicalBytes ||
        global.pendingOutboxRecords > MEMORY_RESOURCE_LIMITS.unackedOutboxRecords ||
        global.outboxLogicalBytes > MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    if (namespace === undefined)
        return Object.freeze({ global });
    const usage = loadUsage(database, namespace.namespaceRef, namespace.generation);
    const namespaceCounters = boundedOutboxCounters(database, namespace);
    if (usage.pendingOutboxRecords !== namespaceCounters.records ||
        usage.outboxLogicalBytes !== namespaceCounters.logicalBytes ||
        usage.pendingOutboxRecords > MEMORY_RESOURCE_LIMITS.unackedOutboxRecords ||
        usage.outboxLogicalBytes > MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    return Object.freeze({ global, usage });
}
function decodeClaimedRow(row) {
    const wire = exactString(rowValue(row, 'event_wire'));
    const logicalBytes = positiveInteger(rowValue(row, 'logical_bytes'));
    if (Buffer.byteLength(wire, 'utf8') !== logicalBytes) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    let event;
    try {
        event = decodeMemoryOutboxEventV1(wire);
    }
    catch {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    const attemptCount = exactInteger(rowValue(row, 'attempt_count'));
    if (attemptCount >= SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 ||
        event.sequence !== positiveInteger(rowValue(row, 'sequence')) ||
        event.eventId !== exactString(rowValue(row, 'event_id')) ||
        event.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
        event.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
        event.aggregate !== exactString(rowValue(row, 'aggregate')) ||
        event.aggregateId !== exactString(rowValue(row, 'aggregate_id')) ||
        event.revision !== positiveInteger(rowValue(row, 'revision')) ||
        event.eventKind !== exactString(rowValue(row, 'event_kind')) ||
        Date.parse(event.occurredAt) !== exactInteger(rowValue(row, 'occurred_at_ms'))) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    return Object.freeze({ event, logicalBytes });
}
function claimEvents(database, request, nowMs) {
    const rows = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
           aggregate_id, revision, event_kind, occurred_at_ms, event_wire,
           logical_bytes, attempt_count
    FROM outbox
    WHERE available_at_ms <= ? AND attempt_count < ?
      AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    ORDER BY sequence ASC
    LIMIT ?
  `).all(nowMs, SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1, nowMs, request.limit);
    if (rows.length === 0)
        return Object.freeze({ status: 'empty' });
    const claimed = rows.map(decodeClaimedRow);
    const leaseToken = `memory-lease:v1:${randomBytes(32).toString('hex')}`;
    const leasedUntilMs = nowMs + SQLITE_MEMORY_OUTBOX_LEASE_DURATION_MS_V1;
    if (!Number.isSafeInteger(leasedUntilMs))
        throw new CanonicalMemoryOutboxDataErrorV1();
    for (const row of claimed) {
        const updated = database.prepare(`
      UPDATE outbox
      SET lease_owner_id = ?, lease_token = ?, leased_until_ms = ?
      WHERE sequence = ? AND event_id = ? AND available_at_ms <= ?
        AND attempt_count < ?
        AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    `).run(request.ownerId, leaseToken, leasedUntilMs, row.event.sequence, row.event.eventId, nowMs, SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1, nowMs);
        if (updated.changes !== 1)
            throw new CanonicalMemoryOutboxDataErrorV1();
    }
    return Object.freeze({
        status: 'claimed',
        ownerId: request.ownerId,
        leaseToken,
        leasedUntil: new Date(leasedUntilMs).toISOString(),
        events: Object.freeze(claimed.map(row => row.event))
    });
}
function activeLeaseRow(database, request, nowMs) {
    const row = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
           aggregate_id, revision, event_kind, occurred_at_ms, event_wire,
           logical_bytes, attempt_count
    FROM outbox
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ?
  `).get(request.sequence, request.eventId, request.ownerId, request.leaseToken, nowMs);
    if (row === undefined)
        return null;
    const claimed = decodeClaimedRow(row);
    if (claimed.event.eventId !== request.eventId ||
        claimed.event.sequence !== request.sequence)
        throw new CanonicalMemoryOutboxDataErrorV1();
    return row;
}
function ackEvent(database, request, nowMs) {
    const row = activeLeaseRow(database, request, nowMs);
    if (row === null)
        return Object.freeze({ status: 'lease_conflict' });
    const namespaceRef = exactString(rowValue(row, 'namespace_ref'));
    const generation = positiveInteger(rowValue(row, 'namespace_generation'));
    const logicalBytes = positiveInteger(rowValue(row, 'logical_bytes'));
    const audited = auditOutboxCounters(database, { namespaceRef, generation });
    const usage = audited.usage;
    if (usage === undefined)
        throw new CanonicalMemoryOutboxDataErrorV1();
    const global = audited.global;
    const nextUsage = Object.freeze({
        ...usage,
        pendingOutboxRecords: usage.pendingOutboxRecords - 1,
        outboxLogicalBytes: usage.outboxLogicalBytes - logicalBytes
    });
    const nextGlobal = Object.freeze({
        ...global,
        pendingOutboxRecords: global.pendingOutboxRecords - 1,
        outboxLogicalBytes: global.outboxLogicalBytes - logicalBytes
    });
    if (nextUsage.pendingOutboxRecords < 0 || nextUsage.outboxLogicalBytes < 0 ||
        nextGlobal.pendingOutboxRecords < 0 || nextGlobal.outboxLogicalBytes < 0) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    const deleted = database.prepare(`
    DELETE FROM outbox
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ?
  `).run(request.sequence, request.eventId, request.ownerId, request.leaseToken, nowMs);
    if (deleted.changes !== 1)
        throw new CanonicalMemoryOutboxDataErrorV1();
    storeUsage(database, namespaceRef, generation, nextUsage, nowMs);
    storeGlobalUsage(database, nextGlobal, nowMs);
    deleteUsageWhenEmpty(database, namespaceRef, generation, nextUsage);
    return Object.freeze({ status: 'acked' });
}
function retryEvent(database, request, nowMs) {
    const row = activeLeaseRow(database, request, nowMs);
    if (row === null)
        return Object.freeze({ status: 'lease_conflict' });
    const attemptCount = exactInteger(rowValue(row, 'attempt_count'));
    const occurredAtMs = exactInteger(rowValue(row, 'occurred_at_ms'));
    const retryAtMs = Date.parse(request.retryAt);
    if (attemptCount >= SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 ||
        retryAtMs < occurredAtMs || !Number.isSafeInteger(retryAtMs)) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    const updated = database.prepare(`
    UPDATE outbox
    SET available_at_ms = ?, lease_owner_id = NULL, lease_token = NULL,
        leased_until_ms = NULL, attempt_count = ?, last_reason_code = ?
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ? AND attempt_count = ?
  `).run(retryAtMs, attemptCount + 1, request.reasonCode, request.sequence, request.eventId, request.ownerId, request.leaseToken, nowMs, attemptCount);
    if (updated.changes !== 1)
        throw new CanonicalMemoryOutboxDataErrorV1();
    return Object.freeze({ status: 'retried' });
}
function outboxUsage(database, nowMs) {
    const global = auditOutboxCounters(database).global;
    const leasedRows = database.prepare(`
    SELECT sequence
    FROM outbox
    WHERE lease_owner_id IS NOT NULL AND leased_until_ms > ?
    ORDER BY sequence ASC
    LIMIT 4097
  `).all(nowMs);
    if (leasedRows.length > global.pendingOutboxRecords) {
        throw new CanonicalMemoryOutboxDataErrorV1();
    }
    return Object.freeze({
        status: 'usage',
        value: Object.freeze({
            schemaVersion: 1,
            pendingRecords: global.pendingOutboxRecords,
            leasedRecords: leasedRows.length,
            logicalBytes: global.outboxLogicalBytes
        })
    });
}
function executeAdapter(database, now, request, signal) {
    if (signal?.aborted === true)
        return Object.freeze({ status: 'aborted' });
    const nowMs = Date.parse(nowInstant(now));
    switch (request.operation) {
        case 'claim':
            return runImmediate(database, () => claimEvents(database, request, nowMs));
        case 'ack':
            return runImmediate(database, () => ackEvent(database, request, nowMs));
        case 'retry':
            return runImmediate(database, () => retryEvent(database, request, nowMs));
        case 'usage':
            return runDiagnostic(() => outboxUsage(database, nowMs));
    }
}
export function createSqliteMemoryOutboxV1(optionsValue) {
    const options = parseOptions(optionsValue);
    return createMemoryOutboxPortV1({
        now: options.now,
        execute: async (request, signal) => executeAdapter(options.database, options.now, request, signal)
    });
}
