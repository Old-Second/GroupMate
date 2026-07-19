import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { createMemoryTombstoneV1, createMemoryOutboxEventV1, parseMemoryTombstoneV1 } from './memory-domain.js';
import { decodeMemoryOutboxEventV1, decodeMemoryProposalV1, decodeMemoryRevisionV1, decodeMemoryTombstoneV1, encodeMemoryOutboxEventV1, encodeMemoryProposalV1, encodeMemoryRecordV1, encodeMemoryRevisionV1, encodeMemoryTombstoneV1 } from './memory-codec.js';
import { inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, memoryNamespaceWireV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { createMemoryRepositoryPortV1, memoryApprovalBindsInitialRevisionV1 } from './memory-repository.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
export const MEMORY_CURSOR_HASH_DOMAIN_V1 = 'groupmate.memory.cursor.v1';
export const MEMORY_MUTATION_RECEIPT_HASH_DOMAIN_V1 = 'groupmate.memory.mutation-receipt.v1';
export const MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1 = 'groupmate.memory.outbox-event-id.v1';
class CanonicalMemoryDataErrorV1 extends Error {
}
const CURSOR_PREFIX = 'memory-cursor:v1:';
const RECEIPT_PREFIX = 'memory-receipt:v1:';
const RETENTION_TOMBSTONE_HASH_DOMAIN_V1 = 'groupmate.memory.retention-tombstone.v1';
function domainHash(domain, preimage) {
    return createHash('sha256')
        .update(domain, 'utf8')
        .update('\0', 'utf8')
        .update(preimage, 'utf8')
        .digest('hex');
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
function instantMilliseconds(value) {
    canonicalInstant(value);
    return Date.parse(value);
}
function exactInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        throw new CanonicalMemoryDataErrorV1();
    return value;
}
function positiveInteger(value) {
    const result = exactInteger(value);
    if (result === 0)
        throw new CanonicalMemoryDataErrorV1();
    return result;
}
function exactString(value) {
    if (typeof value !== 'string')
        throw new CanonicalMemoryDataErrorV1();
    return value;
}
function rowValue(row, key) {
    if (row === undefined)
        return undefined;
    return Object.getOwnPropertyDescriptor(row, key)?.value;
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
function namespaceFromWire(namespaceRef, wire, wireBytes) {
    if (Buffer.byteLength(wire, 'utf8') !== wireBytes) {
        throw new CanonicalMemoryDataErrorV1();
    }
    let value;
    try {
        value = JSON.parse(wire);
    }
    catch {
        throw new CanonicalMemoryDataErrorV1();
    }
    let namespace;
    try {
        namespace = parseMemoryNamespaceV1(value);
    }
    catch {
        throw new CanonicalMemoryDataErrorV1();
    }
    if (memoryNamespaceRefV1(namespace) !== namespaceRef ||
        memoryNamespaceWireV1(namespace) !== wire)
        throw new CanonicalMemoryDataErrorV1();
    return namespace;
}
function loadNamespace(database, namespaceRef) {
    const row = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces
    WHERE namespace_ref = ?
  `).get(namespaceRef);
    if (row === undefined)
        return null;
    const storedRef = exactString(rowValue(row, 'namespace_ref'));
    const wire = exactString(rowValue(row, 'namespace_wire'));
    const wireBytes = positiveInteger(rowValue(row, 'namespace_wire_bytes'));
    const generation = positiveInteger(rowValue(row, 'namespace_generation'));
    if (storedRef !== namespaceRef)
        throw new CanonicalMemoryDataErrorV1();
    return Object.freeze({
        namespaceRef,
        namespace: namespaceFromWire(namespaceRef, wire, wireBytes),
        namespaceWire: wire,
        namespaceWireBytes: wireBytes,
        generation
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
        throw new CanonicalMemoryDataErrorV1();
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
        throw new CanonicalMemoryDataErrorV1();
    return Object.freeze({
        namespaceRecords: exactInteger(rowValue(row, 'namespace_records')),
        activeMemoryRecords: exactInteger(rowValue(row, 'active_memory_records')),
        canonicalLogicalBytes: exactInteger(rowValue(row, 'canonical_logical_bytes')),
        pendingOutboxRecords: exactInteger(rowValue(row, 'pending_outbox_records')),
        outboxLogicalBytes: exactInteger(rowValue(row, 'outbox_logical_bytes'))
    });
}
function storeUsage(database, namespaceRef, generation, usage, updatedAtMs) {
    const result = database.prepare(`
    UPDATE usage
    SET pending_proposal_records = ?, active_memory_records = ?,
        retained_revision_records = ?, tombstone_records = ?,
        canonical_logical_bytes = ?, pending_outbox_records = ?,
        outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(usage.pendingProposalRecords, usage.activeMemoryRecords, usage.retainedRevisionRecords, usage.tombstoneRecords, usage.canonicalLogicalBytes, usage.pendingOutboxRecords, usage.outboxLogicalBytes, updatedAtMs, namespaceRef, generation);
    if (result.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
}
function storeGlobalUsage(database, usage, updatedAtMs) {
    const result = database.prepare(`
    UPDATE global_usage
    SET namespace_records = ?, active_memory_records = ?, canonical_logical_bytes = ?,
        pending_outbox_records = ?, outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(usage.namespaceRecords, usage.activeMemoryRecords, usage.canonicalLogicalBytes, usage.pendingOutboxRecords, usage.outboxLogicalBytes, updatedAtMs);
    if (result.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
}
function mutationReceipt(request, generation) {
    let payload;
    switch (request.operation) {
        case 'proposal.create':
            payload = { proposalWire: encodeMemoryProposalV1(request.proposal) };
            break;
        case 'proposal.decide':
            payload = {
                proposalWire: encodeMemoryProposalV1(request.nextProposal),
                revisionWire: request.initialRevision === null
                    ? null
                    : encodeMemoryRevisionV1(request.initialRevision)
            };
            break;
        case 'record.create':
            payload = { revisionWire: encodeMemoryRevisionV1(request.initialRevision) };
            break;
        case 'record.correct':
            payload = { revisionWire: encodeMemoryRevisionV1(request.nextRevision) };
            break;
        case 'record.forget':
        case 'namespace.delete':
            payload = { tombstone: request.tombstone.receiptHash };
            break;
        default:
            return invalidMemoryValue();
    }
    const preimage = JSON.stringify({
        operation: request.operation,
        namespaceRef: request.namespaceRef,
        namespaceGeneration: generation,
        payload
    });
    return `${RECEIPT_PREFIX}${domainHash(MEMORY_MUTATION_RECEIPT_HASH_DOMAIN_V1, preimage)}`;
}
function cursorRefForFields(namespaceRef, namespaceGeneration, updatedAt, memoryId, currentRevision) {
    const preimage = JSON.stringify({
        namespaceRef,
        namespaceGeneration,
        updatedAt,
        memoryId,
        currentRevision
    });
    return domainHash(MEMORY_CURSOR_HASH_DOMAIN_V1, preimage);
}
function cursorRef(record) {
    return cursorRefForFields(record.namespaceRef, record.namespaceGeneration, record.updatedAt, record.memoryId, record.revision);
}
function canonicalMemoryId(value) {
    const memoryId = exactString(value);
    if (!memoryAsciiWithinLimit(memoryId, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !memoryId.startsWith('memory:') || memoryId.length === 'memory:'.length) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return memoryId;
}
function instantFromMilliseconds(value) {
    const milliseconds = exactInteger(value);
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime()))
        throw new CanonicalMemoryDataErrorV1();
    return Object.freeze({ milliseconds, instant: date.toISOString() });
}
function headCursorFromRow(row, namespaceRef, generation) {
    const memoryId = canonicalMemoryId(rowValue(row, 'memory_id'));
    const currentRevision = positiveInteger(rowValue(row, 'current_revision'));
    const storedCursor = exactString(rowValue(row, 'cursor_ref'));
    if (!/^[0-9a-f]{64}$/.test(storedCursor))
        throw new CanonicalMemoryDataErrorV1();
    const updatedAt = instantFromMilliseconds(rowValue(row, 'updated_at_ms'));
    return Object.freeze({
        memoryId,
        currentRevision,
        cursorRef: storedCursor,
        updatedAtMs: updatedAt.milliseconds,
        hashMatches: storedCursor === cursorRefForFields(namespaceRef, generation, updatedAt.instant, memoryId, currentRevision)
    });
}
function outboxEventId(sequence, namespaceRef, generation, aggregate, aggregateId, revision, eventKind) {
    const preimage = JSON.stringify({
        sequence,
        namespaceRef,
        namespaceGeneration: generation,
        aggregate,
        aggregateId,
        revision,
        eventKind
    });
    return `event:${domainHash(MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1, preimage)}`;
}
function nextOutboxSequence(database) {
    const row = database.prepare(`
    SELECT seq FROM sqlite_sequence WHERE name = 'outbox'
  `).get();
    if (row === undefined)
        return 1;
    const current = exactInteger(rowValue(row, 'seq'));
    if (current >= Number.MAX_SAFE_INTEGER)
        throw new CanonicalMemoryDataErrorV1();
    return current + 1;
}
function prepareOutboxEvent(sequence, namespaceRef, generation, aggregate, aggregateId, revision, eventKind, occurredAt) {
    const event = createMemoryOutboxEventV1({
        eventId: outboxEventId(sequence, namespaceRef, generation, aggregate, aggregateId, revision, eventKind),
        sequence,
        namespaceRef,
        namespaceGeneration: generation,
        aggregate,
        aggregateId,
        revision,
        eventKind,
        occurredAt
    });
    const wire = encodeMemoryOutboxEventV1(event);
    return Object.freeze({
        event,
        wire,
        wireBytes: Buffer.byteLength(wire, 'utf8')
    });
}
function insertOutboxEvent(database, prepared) {
    const event = prepared.event;
    database.prepare(`
    INSERT INTO outbox(
      sequence, event_id, namespace_ref, namespace_generation, aggregate,
      aggregate_id, revision, event_kind, occurred_at_ms, available_at_ms,
      event_wire, logical_bytes, lease_owner_id, lease_token, leased_until_ms,
      attempt_count, last_reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL)
  `).run(event.sequence, event.eventId, event.namespaceRef, event.namespaceGeneration, event.aggregate, event.aggregateId, event.revision, event.eventKind, instantMilliseconds(event.occurredAt), instantMilliseconds(event.occurredAt), prepared.wire, prepared.wireBytes);
}
function capacityResult(usage, global, memoryRevisionRecords) {
    if (global.namespaceRecords > MEMORY_RESOURCE_LIMITS.deploymentNamespaces) {
        return Object.freeze({ status: 'capacity', category: 'namespaces' });
    }
    if (usage.pendingProposalRecords > MEMORY_RESOURCE_LIMITS.namespacePendingProposals) {
        return Object.freeze({ status: 'capacity', category: 'pending_proposals' });
    }
    if (usage.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
        global.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords) {
        return Object.freeze({ status: 'capacity', category: 'active_records' });
    }
    if (memoryRevisionRecords !== undefined &&
        memoryRevisionRecords > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
        return Object.freeze({ status: 'capacity', category: 'retained_revisions' });
    }
    if (usage.canonicalLogicalBytes > MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes ||
        global.canonicalLogicalBytes > MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes) {
        return Object.freeze({ status: 'capacity', category: 'canonical_bytes' });
    }
    if (global.pendingOutboxRecords > MEMORY_RESOURCE_LIMITS.unackedOutboxRecords) {
        return Object.freeze({ status: 'capacity', category: 'outbox_records' });
    }
    if (global.outboxLogicalBytes > MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes) {
        return Object.freeze({ status: 'capacity', category: 'outbox_bytes' });
    }
    return null;
}
function ensureNamespace(database, namespace, expectedGeneration, nowMs) {
    const namespaceRef = memoryNamespaceRefV1(namespace);
    const existing = loadNamespace(database, namespaceRef);
    const global = loadGlobalUsage(database);
    if (existing !== null) {
        if (existing.namespaceWire !== memoryNamespaceWireV1(namespace)) {
            throw new CanonicalMemoryDataErrorV1();
        }
        if (existing.generation !== expectedGeneration) {
            return Object.freeze({
                namespace: existing,
                usage: Object.freeze({
                    pendingProposalRecords: 0,
                    activeMemoryRecords: 0,
                    retainedRevisionRecords: 0,
                    tombstoneRecords: 0,
                    canonicalLogicalBytes: 0,
                    pendingOutboxRecords: 0,
                    outboxLogicalBytes: 0
                }),
                global,
                created: false,
                failure: Object.freeze({ status: 'conflict', category: 'generation' })
            });
        }
        return Object.freeze({
            namespace: existing,
            usage: loadUsage(database, namespaceRef, existing.generation),
            global,
            created: false,
            failure: null
        });
    }
    if (expectedGeneration !== 1) {
        return Object.freeze({
            namespace: Object.freeze({
                namespaceRef,
                namespace,
                namespaceWire: memoryNamespaceWireV1(namespace),
                namespaceWireBytes: Buffer.byteLength(memoryNamespaceWireV1(namespace), 'utf8'),
                generation: 1
            }),
            usage: Object.freeze({
                pendingProposalRecords: 0,
                activeMemoryRecords: 0,
                retainedRevisionRecords: 0,
                tombstoneRecords: 0,
                canonicalLogicalBytes: 0,
                pendingOutboxRecords: 0,
                outboxLogicalBytes: 0
            }),
            global,
            created: false,
            failure: Object.freeze({ status: 'conflict', category: 'generation' })
        });
    }
    const wire = memoryNamespaceWireV1(namespace);
    const wireBytes = Buffer.byteLength(wire, 'utf8');
    const projectedUsage = Object.freeze({
        pendingProposalRecords: 0,
        activeMemoryRecords: 0,
        retainedRevisionRecords: 0,
        tombstoneRecords: 0,
        canonicalLogicalBytes: wireBytes,
        pendingOutboxRecords: 0,
        outboxLogicalBytes: 0
    });
    const projectedGlobal = Object.freeze({
        ...global,
        namespaceRecords: global.namespaceRecords + 1,
        canonicalLogicalBytes: global.canonicalLogicalBytes + wireBytes
    });
    const failure = capacityResult(projectedUsage, projectedGlobal);
    const row = Object.freeze({
        namespaceRef,
        namespace,
        namespaceWire: wire,
        namespaceWireBytes: wireBytes,
        generation: 1
    });
    if (failure !== null) {
        return Object.freeze({
            namespace: row,
            usage: projectedUsage,
            global: projectedGlobal,
            created: false,
            failure
        });
    }
    database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(namespaceRef, wire, wireBytes, nowMs, nowMs);
    database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms
    ) VALUES (?, 1, 0, 0, 0, 0, ?, 0, 0, ?)
  `).run(namespaceRef, wireBytes, nowMs);
    storeGlobalUsage(database, projectedGlobal, nowMs);
    return Object.freeze({
        namespace: row,
        usage: projectedUsage,
        global: projectedGlobal,
        created: true,
        failure: null
    });
}
function unchangedResult(request, generation, value) {
    return Object.freeze({
        commit: false,
        result: Object.freeze({
            status: 'unchanged',
            value,
            receipt: mutationReceipt(request, generation)
        })
    });
}
function storedResult(request, generation, value) {
    return Object.freeze({
        commit: true,
        result: Object.freeze({
            status: 'stored',
            value,
            receipt: mutationReceipt(request, generation)
        })
    });
}
function failureOutcome(result) {
    return Object.freeze({ commit: false, result });
}
function proposalPendingWire(proposal) {
    return encodeMemoryProposalV1({
        ...proposal,
        revision: 1,
        state: 'pending',
        decision: null
    });
}
function loadProposalRow(database, namespaceRef, generation, proposalId) {
    const row = database.prepare(`
    SELECT revision, state, proposed_at_ms, decided_at_ms, proposal_wire,
           proposal_wire_bytes, resulting_memory_id, resulting_revision,
           resulting_revision_hash
    FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
  `).get(namespaceRef, generation, proposalId);
    if (row === undefined)
        return null;
    const wire = exactString(rowValue(row, 'proposal_wire'));
    const wireBytes = positiveInteger(rowValue(row, 'proposal_wire_bytes'));
    if (Buffer.byteLength(wire, 'utf8') !== wireBytes)
        throw new CanonicalMemoryDataErrorV1();
    let proposal;
    try {
        proposal = decodeMemoryProposalV1(wire);
    }
    catch {
        throw new CanonicalMemoryDataErrorV1();
    }
    const decidedAt = rowValue(row, 'decided_at_ms');
    const resultingMemoryValue = rowValue(row, 'resulting_memory_id');
    const resultingRevisionValue = rowValue(row, 'resulting_revision');
    const resultingRevisionHashValue = rowValue(row, 'resulting_revision_hash');
    const resultingMemoryId = resultingMemoryValue === null
        ? null
        : exactString(resultingMemoryValue);
    const resultingRevision = resultingRevisionValue === null
        ? null
        : positiveInteger(resultingRevisionValue);
    const resultingRevisionHash = resultingRevisionHashValue === null
        ? null
        : exactString(resultingRevisionHashValue);
    if (proposal.namespaceRef !== namespaceRef || proposal.proposalId !== proposalId ||
        proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
        proposal.state !== exactString(rowValue(row, 'state')) ||
        instantMilliseconds(proposal.proposedAt) !== exactInteger(rowValue(row, 'proposed_at_ms')) ||
        (proposal.decision === null
            ? decidedAt !== null
            : instantMilliseconds(proposal.decision.decidedAt) !== exactInteger(decidedAt)) ||
        (proposal.state === 'approved'
            ? resultingMemoryId === null || resultingRevision === null || resultingRevisionHash === null
            : resultingMemoryId !== null || resultingRevision !== null ||
                resultingRevisionHash !== null)) {
        throw new CanonicalMemoryDataErrorV1();
    }
    if (resultingMemoryId !== null && resultingRevision !== null &&
        resultingRevisionHash !== null) {
        const stored = loadStoredRevision(database, namespaceRef, generation, resultingMemoryId, resultingRevision);
        if (stored === null || stored.revision.revisionHash !== resultingRevisionHash ||
            !memoryApprovalBindsInitialRevisionV1(proposal, stored.revision, namespaceRef, generation)) {
            throw new CanonicalMemoryDataErrorV1();
        }
    }
    return Object.freeze({
        proposal,
        wire,
        wireBytes,
        resultingMemoryId,
        resultingRevision,
        resultingRevisionHash
    });
}
function insertRevision(database, revision, wire, wireBytes) {
    const record = revision.record;
    database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.namespaceRef, record.namespaceGeneration, revision.memoryId, revision.revision, revision.operation, revision.revisionHash, revision.previousRevisionHash, instantMilliseconds(revision.changedAt), wireBytes);
    database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, ?, ?, ?, ?)
  `).run(record.namespaceRef, record.namespaceGeneration, revision.memoryId, revision.revision, wire);
}
function insertHead(database, revision) {
    const record = revision.record;
    database.prepare(`
    INSERT INTO heads(
      namespace_ref, namespace_generation, memory_id, current_revision,
      current_revision_hash, content_hash, cursor_ref, updated_at_ms,
      valid_until_ms, purge_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.namespaceRef, record.namespaceGeneration, record.memoryId, record.revision, revision.revisionHash, record.contentHash, cursorRef(record), instantMilliseconds(record.updatedAt), instantMilliseconds(record.retention.validUntil), instantMilliseconds(record.retention.purgeAt));
}
function loadStoredRevision(database, namespaceRef, generation, memoryId, revisionNumber) {
    const row = database.prepare(`
    SELECT r.operation, r.revision_hash, r.previous_revision_hash,
           r.changed_at_ms, r.revision_wire_bytes, p.revision_wire
    FROM revisions AS r
    JOIN revision_payloads AS p
      ON p.namespace_ref = r.namespace_ref
     AND p.namespace_generation = r.namespace_generation
     AND p.memory_id = r.memory_id
     AND p.revision = r.revision
    WHERE r.namespace_ref = ? AND r.namespace_generation = ?
      AND r.memory_id = ? AND r.revision = ?
  `).get(namespaceRef, generation, memoryId, revisionNumber);
    if (row === undefined) {
        const metadata = database.prepare(`
      SELECT revision FROM revisions
      WHERE namespace_ref = ? AND namespace_generation = ?
        AND memory_id = ? AND revision = ?
    `).get(namespaceRef, generation, memoryId, revisionNumber);
        const payload = database.prepare(`
      SELECT revision FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = ?
        AND memory_id = ? AND revision = ?
    `).get(namespaceRef, generation, memoryId, revisionNumber);
        if (metadata !== undefined || payload !== undefined)
            throw new CanonicalMemoryDataErrorV1();
        return null;
    }
    const wire = exactString(rowValue(row, 'revision_wire'));
    const wireBytes = positiveInteger(rowValue(row, 'revision_wire_bytes'));
    if (Buffer.byteLength(wire, 'utf8') !== wireBytes)
        throw new CanonicalMemoryDataErrorV1();
    let revision;
    try {
        revision = decodeMemoryRevisionV1(wire);
    }
    catch {
        throw new CanonicalMemoryDataErrorV1();
    }
    const previousHash = rowValue(row, 'previous_revision_hash');
    if (revision.record.namespaceRef !== namespaceRef ||
        revision.record.namespaceGeneration !== generation ||
        revision.memoryId !== memoryId || revision.revision !== revisionNumber ||
        revision.operation !== exactString(rowValue(row, 'operation')) ||
        revision.revisionHash !== exactString(rowValue(row, 'revision_hash')) ||
        revision.previousRevisionHash !== (previousHash === null ? null : exactString(previousHash)) ||
        instantMilliseconds(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms'))) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return Object.freeze({ revision, wire, wireBytes });
}
function loadHead(database, namespaceRef, generation, memoryId) {
    const row = database.prepare(`
    SELECT current_revision, current_revision_hash, content_hash, cursor_ref,
           updated_at_ms, valid_until_ms, purge_at_ms
    FROM heads
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).get(namespaceRef, generation, memoryId);
    if (row === undefined)
        return null;
    const currentRevision = positiveInteger(rowValue(row, 'current_revision'));
    const stored = loadStoredRevision(database, namespaceRef, generation, memoryId, currentRevision);
    if (stored === null)
        throw new CanonicalMemoryDataErrorV1();
    const record = stored.revision.record;
    const storedCursor = exactString(rowValue(row, 'cursor_ref'));
    const updatedAtMs = exactInteger(rowValue(row, 'updated_at_ms'));
    const validUntilMs = exactInteger(rowValue(row, 'valid_until_ms'));
    const purgeAtMs = exactInteger(rowValue(row, 'purge_at_ms'));
    if (stored.revision.revisionHash !== exactString(rowValue(row, 'current_revision_hash')) ||
        record.contentHash !== exactString(rowValue(row, 'content_hash')) ||
        storedCursor !== cursorRef(record) ||
        updatedAtMs !== instantMilliseconds(record.updatedAt) ||
        validUntilMs !== instantMilliseconds(record.retention.validUntil) ||
        purgeAtMs !== instantMilliseconds(record.retention.purgeAt)) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return Object.freeze({
        ...stored,
        cursorRef: storedCursor,
        updatedAtMs,
        validUntilMs,
        purgeAtMs
    });
}
function loadValidatedAssociatedProposalBodies(database, namespaceRef, generation, memoryId) {
    const rows = database.prepare(`
    SELECT proposal_id
    FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
    ORDER BY proposal_id ASC
    LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    if (rows.length > MEMORY_RESOURCE_LIMITS.operationBatchRecords) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return Object.freeze(rows.map(row => {
        const proposalId = exactString(rowValue(row, 'proposal_id'));
        const stored = loadProposalRow(database, namespaceRef, generation, proposalId);
        if (stored === null || stored.proposal.state !== 'approved' ||
            stored.resultingMemoryId !== memoryId || stored.resultingRevision !== 1 ||
            stored.resultingRevisionHash === null)
            throw new CanonicalMemoryDataErrorV1();
        return Object.freeze({
            proposalId,
            state: stored.proposal.state,
            wireBytes: stored.wireBytes
        });
    }));
}
function loadValidatedRevisionBodies(database, namespaceRef, generation, memoryId, head) {
    const metadataRows = database.prepare(`
    SELECT revision
    FROM revisions
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC
    LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    const payloadRows = database.prepare(`
    SELECT revision
    FROM revision_payloads
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC
    LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    if (metadataRows.length === 0 ||
        metadataRows.length > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions ||
        payloadRows.length !== metadataRows.length ||
        head.revision.revision !== metadataRows.length)
        throw new CanonicalMemoryDataErrorV1();
    const revisions = [];
    let wireBytes = 0;
    for (let index = 0; index < metadataRows.length; index += 1) {
        const revisionNumber = index + 1;
        if (positiveInteger(rowValue(metadataRows[index], 'revision')) !== revisionNumber ||
            positiveInteger(rowValue(payloadRows[index], 'revision')) !== revisionNumber) {
            throw new CanonicalMemoryDataErrorV1();
        }
        const stored = loadStoredRevision(database, namespaceRef, generation, memoryId, revisionNumber);
        if (stored === null || stored.revision.previousRevisionHash !==
            (index === 0 ? null : revisions[index - 1].revision.revisionHash)) {
            throw new CanonicalMemoryDataErrorV1();
        }
        revisions.push(stored);
        wireBytes += stored.wireBytes;
    }
    const current = revisions.at(-1);
    if (current === undefined || current.wire !== head.wire ||
        current.revision.revisionHash !== head.revision.revisionHash) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return Object.freeze({ rows: Object.freeze(revisions), wireBytes });
}
function projectedOutboxUsage(usage, global, events) {
    const bytes = events.reduce((total, event) => total + event.wireBytes, 0);
    return Object.freeze({
        usage: Object.freeze({
            ...usage,
            pendingOutboxRecords: usage.pendingOutboxRecords + events.length,
            outboxLogicalBytes: usage.outboxLogicalBytes + bytes
        }),
        global: Object.freeze({
            ...global,
            pendingOutboxRecords: global.pendingOutboxRecords + events.length,
            outboxLogicalBytes: global.outboxLogicalBytes + bytes
        })
    });
}
function proposalCreate(database, request, nowMs) {
    const namespaceState = ensureNamespace(database, request.proposal.namespace, request.expectedNamespaceGeneration, nowMs);
    if (namespaceState.failure !== null)
        return failureOutcome(namespaceState.failure);
    const existing = loadProposalRow(database, request.namespaceRef, namespaceState.namespace.generation, request.proposal.proposalId);
    const proposalWire = encodeMemoryProposalV1(request.proposal);
    if (existing !== null) {
        if (proposalPendingWire(existing.proposal) === proposalWire) {
            return unchangedResult(request, namespaceState.namespace.generation, request.proposal);
        }
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const proposalBytes = Buffer.byteLength(proposalWire, 'utf8');
    const sequence = nextOutboxSequence(database);
    const event = prepareOutboxEvent(sequence, request.namespaceRef, namespaceState.namespace.generation, 'proposal', request.proposal.proposalId, request.proposal.revision, 'proposal_changed', request.proposal.proposedAt);
    const projected = projectedOutboxUsage(Object.freeze({
        ...namespaceState.usage,
        pendingProposalRecords: namespaceState.usage.pendingProposalRecords + 1,
        canonicalLogicalBytes: namespaceState.usage.canonicalLogicalBytes + proposalBytes
    }), Object.freeze({
        ...namespaceState.global,
        canonicalLogicalBytes: namespaceState.global.canonicalLogicalBytes + proposalBytes
    }), [event]);
    const failure = capacityResult(projected.usage, projected.global);
    if (failure !== null)
        return failureOutcome(failure);
    database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id,
      resulting_revision, resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(request.namespaceRef, namespaceState.namespace.generation, request.proposal.proposalId, request.proposal.revision, request.proposal.state, instantMilliseconds(request.proposal.proposedAt), proposalWire, proposalBytes);
    insertOutboxEvent(database, event);
    storeUsage(database, request.namespaceRef, namespaceState.namespace.generation, projected.usage, nowMs);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, namespaceState.namespace.generation, request.proposal);
}
function proposalDecide(database, request, nowMs) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'generation'
        }));
    }
    const usage = loadUsage(database, request.namespaceRef, namespace.generation);
    const global = loadGlobalUsage(database);
    const existing = loadProposalRow(database, request.namespaceRef, namespace.generation, request.nextProposal.proposalId);
    if (existing === null) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'revision'
        }));
    }
    const nextWire = encodeMemoryProposalV1(request.nextProposal);
    if (existing.wire === nextWire) {
        if (request.initialRevision !== null) {
            if (existing.resultingMemoryId !== request.initialRevision.memoryId ||
                existing.resultingRevision !== request.initialRevision.revision ||
                existing.resultingRevisionHash !== request.initialRevision.revisionHash) {
                return failureOutcome(Object.freeze({
                    status: 'conflict',
                    category: 'idempotency'
                }));
            }
            const stored = loadStoredRevision(database, request.namespaceRef, namespace.generation, request.initialRevision.memoryId, request.initialRevision.revision);
            const head = loadHead(database, request.namespaceRef, namespace.generation, request.initialRevision.memoryId);
            if (stored === null || head === null ||
                stored.wire !== encodeMemoryRevisionV1(request.initialRevision)) {
                throw new CanonicalMemoryDataErrorV1();
            }
        }
        return unchangedResult(request, namespace.generation, request.nextProposal);
    }
    if (existing.proposal.revision !== request.expectedRevision ||
        existing.proposal.state !== 'pending') {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'revision'
        }));
    }
    if (proposalPendingWire(request.nextProposal) !== existing.wire) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    if (request.initialRevision !== null && loadActiveForgetTombstoneForMemory(database, request.namespaceRef, namespace.generation, request.initialRevision.memoryId, nowMs) !== null) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const sequence = nextOutboxSequence(database);
    const proposalEvent = prepareOutboxEvent(sequence, request.namespaceRef, namespace.generation, 'proposal', request.nextProposal.proposalId, request.nextProposal.revision, 'proposal_changed', request.nextProposal.decision.decidedAt);
    const events = [proposalEvent];
    let revisionWire = null;
    let revisionBytes = 0;
    if (request.initialRevision !== null) {
        const revision = request.initialRevision;
        const stored = loadStoredRevision(database, request.namespaceRef, namespace.generation, revision.memoryId, revision.revision);
        const head = loadHead(database, request.namespaceRef, namespace.generation, revision.memoryId);
        if ((stored === null) !== (head === null))
            throw new CanonicalMemoryDataErrorV1();
        if (stored !== null && head !== null) {
            return failureOutcome(Object.freeze({
                status: 'conflict',
                category: 'idempotency'
            }));
        }
        revisionWire = encodeMemoryRevisionV1(revision);
        revisionBytes = Buffer.byteLength(revisionWire, 'utf8');
        events.push(prepareOutboxEvent(sequence + 1, request.namespaceRef, namespace.generation, 'record', revision.memoryId, revision.revision, 'record_upserted', revision.changedAt));
    }
    const proposalBytesDelta = Buffer.byteLength(nextWire, 'utf8') - existing.wireBytes;
    const projectedBaseUsage = Object.freeze({
        ...usage,
        pendingProposalRecords: usage.pendingProposalRecords - 1,
        activeMemoryRecords: usage.activeMemoryRecords + (request.initialRevision === null ? 0 : 1),
        retainedRevisionRecords: usage.retainedRevisionRecords +
            (request.initialRevision === null ? 0 : 1),
        canonicalLogicalBytes: usage.canonicalLogicalBytes + proposalBytesDelta + revisionBytes
    });
    if (projectedBaseUsage.pendingProposalRecords < 0)
        throw new CanonicalMemoryDataErrorV1();
    const projectedBaseGlobal = Object.freeze({
        ...global,
        activeMemoryRecords: global.activeMemoryRecords +
            (request.initialRevision === null ? 0 : 1),
        canonicalLogicalBytes: global.canonicalLogicalBytes + proposalBytesDelta + revisionBytes
    });
    const projected = projectedOutboxUsage(projectedBaseUsage, projectedBaseGlobal, events);
    const failure = capacityResult(projected.usage, projected.global, request.initialRevision === null ? undefined : 1);
    if (failure !== null)
        return failureOutcome(failure);
    const updated = database.prepare(`
    UPDATE proposals
    SET revision = ?, state = ?, decided_at_ms = ?, resulting_memory_id = ?,
        resulting_revision = ?, resulting_revision_hash = ?, proposal_wire = ?,
        proposal_wire_bytes = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
      AND revision = ? AND state = 'pending'
  `).run(request.nextProposal.revision, request.nextProposal.state, instantMilliseconds(request.nextProposal.decision.decidedAt), request.initialRevision?.memoryId ?? null, request.initialRevision?.revision ?? null, request.initialRevision?.revisionHash ?? null, nextWire, Buffer.byteLength(nextWire, 'utf8'), request.namespaceRef, namespace.generation, request.nextProposal.proposalId, request.expectedRevision);
    if (updated.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
    if (request.initialRevision !== null && revisionWire !== null) {
        insertRevision(database, request.initialRevision, revisionWire, revisionBytes);
        insertHead(database, request.initialRevision);
    }
    for (const event of events)
        insertOutboxEvent(database, event);
    storeUsage(database, request.namespaceRef, namespace.generation, projected.usage, nowMs);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, namespace.generation, request.nextProposal);
}
function recordCreate(database, request, nowMs) {
    const revision = request.initialRevision;
    const namespaceState = ensureNamespace(database, revision.record.namespace, request.expectedNamespaceGeneration, nowMs);
    if (namespaceState.failure !== null)
        return failureOutcome(namespaceState.failure);
    if (loadActiveForgetTombstoneForMemory(database, request.namespaceRef, namespaceState.namespace.generation, revision.memoryId, nowMs) !== null) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const wire = encodeMemoryRevisionV1(revision);
    const existing = loadStoredRevision(database, request.namespaceRef, namespaceState.namespace.generation, revision.memoryId, revision.revision);
    if (existing !== null) {
        if (existing.wire === wire) {
            const head = loadHead(database, request.namespaceRef, namespaceState.namespace.generation, revision.memoryId);
            if (head === null || head.revision.revision < revision.revision) {
                throw new CanonicalMemoryDataErrorV1();
            }
            return unchangedResult(request, namespaceState.namespace.generation, revision.record);
        }
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    if (loadHead(database, request.namespaceRef, namespaceState.namespace.generation, revision.memoryId) !== null)
        throw new CanonicalMemoryDataErrorV1();
    const wireBytes = Buffer.byteLength(wire, 'utf8');
    const event = prepareOutboxEvent(nextOutboxSequence(database), request.namespaceRef, namespaceState.namespace.generation, 'record', revision.memoryId, revision.revision, 'record_upserted', revision.changedAt);
    const projected = projectedOutboxUsage(Object.freeze({
        ...namespaceState.usage,
        activeMemoryRecords: namespaceState.usage.activeMemoryRecords + 1,
        retainedRevisionRecords: namespaceState.usage.retainedRevisionRecords + 1,
        canonicalLogicalBytes: namespaceState.usage.canonicalLogicalBytes + wireBytes
    }), Object.freeze({
        ...namespaceState.global,
        activeMemoryRecords: namespaceState.global.activeMemoryRecords + 1,
        canonicalLogicalBytes: namespaceState.global.canonicalLogicalBytes + wireBytes
    }), [event]);
    const failure = capacityResult(projected.usage, projected.global, 1);
    if (failure !== null)
        return failureOutcome(failure);
    insertRevision(database, revision, wire, wireBytes);
    insertHead(database, revision);
    insertOutboxEvent(database, event);
    storeUsage(database, request.namespaceRef, namespaceState.namespace.generation, projected.usage, nowMs);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, namespaceState.namespace.generation, revision.record);
}
function revisionCountForMemory(database, namespaceRef, generation, memoryId) {
    const rows = database.prepare(`
    SELECT revision
    FROM revisions
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC
    LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    if (rows.length > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions)
        return rows.length;
    rows.forEach((row, index) => {
        if (positiveInteger(rowValue(row, 'revision')) !== index + 1) {
            throw new CanonicalMemoryDataErrorV1();
        }
    });
    return rows.length;
}
function loadTombstone(database, namespaceRef, generation, tombstoneId) {
    const row = database.prepare(`
    SELECT memory_id, deleted_revision, deletion_kind, deleted_at_ms, expires_at_ms,
           receipt_hash, tombstone_wire, tombstone_wire_bytes
    FROM tombstones
    WHERE namespace_ref = ? AND namespace_generation = ? AND tombstone_id = ?
  `).get(namespaceRef, generation, tombstoneId);
    if (row === undefined)
        return null;
    const wire = exactString(rowValue(row, 'tombstone_wire'));
    const wireBytes = positiveInteger(rowValue(row, 'tombstone_wire_bytes'));
    if (Buffer.byteLength(wire, 'utf8') !== wireBytes)
        throw new CanonicalMemoryDataErrorV1();
    let tombstone;
    try {
        tombstone = decodeMemoryTombstoneV1(wire);
    }
    catch {
        throw new CanonicalMemoryDataErrorV1();
    }
    const memoryId = rowValue(row, 'memory_id');
    const deletedRevision = rowValue(row, 'deleted_revision');
    if (tombstone.namespaceRef !== namespaceRef ||
        tombstone.namespaceGeneration !== generation ||
        tombstone.tombstoneId !== tombstoneId ||
        tombstone.memoryId !== (memoryId === null ? null : canonicalMemoryId(memoryId)) ||
        tombstone.deletedRevision !== (deletedRevision === null
            ? null
            : positiveInteger(deletedRevision)) ||
        tombstone.deletionKind !== exactString(rowValue(row, 'deletion_kind')) ||
        instantMilliseconds(tombstone.deletedAt) !== exactInteger(rowValue(row, 'deleted_at_ms')) ||
        instantMilliseconds(tombstone.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
        tombstone.receiptHash !== exactString(rowValue(row, 'receipt_hash'))) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return Object.freeze({ tombstone, wire, wireBytes });
}
function loadActiveTombstoneById(database, namespaceRef, generation, tombstoneId, nowMs) {
    const row = database.prepare(`
    SELECT expires_at_ms
    FROM tombstones
    WHERE namespace_ref = ? AND namespace_generation = ? AND tombstone_id = ?
      AND expires_at_ms > ?
  `).get(namespaceRef, generation, tombstoneId, nowMs);
    if (row === undefined)
        return null;
    const expiresAtMs = exactInteger(rowValue(row, 'expires_at_ms'));
    const stored = loadTombstone(database, namespaceRef, generation, tombstoneId);
    if (stored === null || instantMilliseconds(stored.tombstone.expiresAt) !== expiresAtMs ||
        expiresAtMs <= nowMs)
        throw new CanonicalMemoryDataErrorV1();
    return stored;
}
function loadActiveForgetTombstoneForMemory(database, namespaceRef, generation, memoryId, nowMs) {
    const rows = database.prepare(`
    SELECT tombstone_id, expires_at_ms
    FROM tombstones
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      AND deletion_kind = 'memory_forgotten' AND expires_at_ms > ?
    ORDER BY expires_at_ms ASC, tombstone_id ASC
    LIMIT 2
  `).all(namespaceRef, generation, memoryId, nowMs);
    if (rows.length === 0)
        return null;
    if (rows.length !== 1)
        throw new CanonicalMemoryDataErrorV1();
    const tombstoneId = exactString(rowValue(rows[0], 'tombstone_id'));
    const expiresAtMs = exactInteger(rowValue(rows[0], 'expires_at_ms'));
    const stored = loadTombstone(database, namespaceRef, generation, tombstoneId);
    if (stored === null || stored.tombstone.deletionKind !== 'memory_forgotten' ||
        stored.tombstone.memoryId !== memoryId ||
        instantMilliseconds(stored.tombstone.expiresAt) !== expiresAtMs || expiresAtMs <= nowMs) {
        throw new CanonicalMemoryDataErrorV1();
    }
    return stored;
}
function insertTombstone(database, tombstone, wire, wireBytes) {
    database.prepare(`
    INSERT INTO tombstones(
      namespace_ref, namespace_generation, tombstone_id, memory_id,
      deleted_revision, deletion_kind, deleted_at_ms, expires_at_ms,
      receipt_hash, tombstone_wire, tombstone_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tombstone.namespaceRef, tombstone.namespaceGeneration, tombstone.tombstoneId, tombstone.memoryId, tombstone.deletedRevision, tombstone.deletionKind, instantMilliseconds(tombstone.deletedAt), instantMilliseconds(tombstone.expiresAt), tombstone.receiptHash, wire, wireBytes);
}
function recordForgetMutation(database, request, nowMs) {
    const tombstoneWire = encodeMemoryTombstoneV1(request.tombstone);
    const existingTombstone = loadActiveTombstoneById(database, request.namespaceRef, request.tombstone.namespaceGeneration, request.tombstone.tombstoneId, nowMs);
    if (existingTombstone !== null) {
        return existingTombstone.wire === tombstoneWire
            ? unchangedResult(request, request.tombstone.namespaceGeneration, request.tombstone)
            : failureOutcome(Object.freeze({
                status: 'conflict',
                category: 'idempotency'
            }));
    }
    const priorTombstone = loadActiveForgetTombstoneForMemory(database, request.namespaceRef, request.expectedNamespaceGeneration, request.tombstone.memoryId ?? '', nowMs);
    if (priorTombstone !== null) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'generation'
        }));
    }
    const memoryId = request.tombstone.memoryId;
    if (memoryId === null || request.tombstone.deletedRevision !== request.expectedRevision) {
        throw new CanonicalMemoryDataErrorV1();
    }
    const head = loadHead(database, request.namespaceRef, namespace.generation, memoryId);
    if (head === null || head.revision.revision !== request.expectedRevision) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'revision'
        }));
    }
    const proposalRows = loadValidatedAssociatedProposalBodies(database, request.namespaceRef, namespace.generation, memoryId);
    const proposalBytes = proposalRows.reduce((total, row) => total + row.wireBytes, 0);
    const revisionBodies = loadValidatedRevisionBodies(database, request.namespaceRef, namespace.generation, memoryId, head);
    if (revisionBodies.rows.length !== request.expectedRevision) {
        throw new CanonicalMemoryDataErrorV1();
    }
    const revisionBytes = revisionBodies.wireBytes;
    const usage = loadUsage(database, request.namespaceRef, namespace.generation);
    const global = loadGlobalUsage(database);
    const tombstoneBytes = Buffer.byteLength(tombstoneWire, 'utf8');
    const baseUsage = Object.freeze({
        ...usage,
        activeMemoryRecords: usage.activeMemoryRecords - 1,
        retainedRevisionRecords: usage.retainedRevisionRecords - revisionBodies.rows.length,
        tombstoneRecords: usage.tombstoneRecords + 1,
        canonicalLogicalBytes: usage.canonicalLogicalBytes - proposalBytes - revisionBytes +
            tombstoneBytes
    });
    const baseGlobal = Object.freeze({
        ...global,
        activeMemoryRecords: global.activeMemoryRecords - 1,
        canonicalLogicalBytes: global.canonicalLogicalBytes - proposalBytes - revisionBytes +
            tombstoneBytes
    });
    if (baseUsage.activeMemoryRecords < 0 || baseUsage.retainedRevisionRecords < 0 ||
        baseUsage.canonicalLogicalBytes < 0 || baseGlobal.activeMemoryRecords < 0 ||
        baseGlobal.canonicalLogicalBytes < 0)
        throw new CanonicalMemoryDataErrorV1();
    const event = prepareOutboxEvent(nextOutboxSequence(database), request.namespaceRef, namespace.generation, 'record', memoryId, request.expectedRevision, 'record_forgotten', request.tombstone.deletedAt);
    const projected = projectedOutboxUsage(baseUsage, baseGlobal, [event]);
    const failure = capacityResult(projected.usage, projected.global);
    if (failure !== null)
        return failureOutcome(failure);
    const proposalsDeleted = database.prepare(`
    DELETE FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
  `).run(request.namespaceRef, namespace.generation, memoryId);
    if (proposalsDeleted.changes !== proposalRows.length)
        throw new CanonicalMemoryDataErrorV1();
    const headDeleted = database.prepare(`
    DELETE FROM heads
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      AND current_revision = ?
  `).run(request.namespaceRef, namespace.generation, memoryId, request.expectedRevision);
    if (headDeleted.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
    const revisionsDeleted = database.prepare(`
    DELETE FROM revisions
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).run(request.namespaceRef, namespace.generation, memoryId);
    if (revisionsDeleted.changes !== revisionBodies.rows.length) {
        throw new CanonicalMemoryDataErrorV1();
    }
    insertTombstone(database, request.tombstone, tombstoneWire, tombstoneBytes);
    insertOutboxEvent(database, event);
    storeUsage(database, request.namespaceRef, namespace.generation, projected.usage, nowMs);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, namespace.generation, request.tombstone);
}
function namespaceDelete(database, request, nowMs) {
    const nextGeneration = request.expectedNamespaceGeneration + 1;
    const tombstoneWire = encodeMemoryTombstoneV1(request.tombstone);
    const existingTombstone = loadActiveTombstoneById(database, request.namespaceRef, nextGeneration, request.tombstone.tombstoneId, nowMs);
    if (existingTombstone !== null) {
        return existingTombstone.wire === tombstoneWire
            ? unchangedResult(request, nextGeneration, request.tombstone)
            : failureOutcome(Object.freeze({
                status: 'conflict',
                category: 'idempotency'
            }));
    }
    const priorRows = database.prepare(`
    SELECT tombstone_id
    FROM tombstones
    WHERE namespace_ref = ? AND namespace_generation = ?
      AND deletion_kind = 'namespace_deleted' AND expires_at_ms > ?
    ORDER BY expires_at_ms ASC, tombstone_id ASC
    LIMIT 2
  `).all(request.namespaceRef, nextGeneration, nowMs);
    for (const row of priorRows) {
        const tombstoneId = exactString(rowValue(row, 'tombstone_id'));
        if (loadActiveTombstoneById(database, request.namespaceRef, nextGeneration, tombstoneId, nowMs) === null) {
            throw new CanonicalMemoryDataErrorV1();
        }
    }
    if (priorRows.length > 0) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'generation'
        }));
    }
    const oldUsage = loadUsage(database, request.namespaceRef, namespace.generation);
    const global = loadGlobalUsage(database);
    const tombstoneBytes = Buffer.byteLength(tombstoneWire, 'utf8');
    const retainedOldUsage = Object.freeze({
        ...oldUsage,
        canonicalLogicalBytes: oldUsage.canonicalLogicalBytes - namespace.namespaceWireBytes
    });
    const baseNewUsage = Object.freeze({
        pendingProposalRecords: 0,
        activeMemoryRecords: 0,
        retainedRevisionRecords: 0,
        tombstoneRecords: 1,
        canonicalLogicalBytes: namespace.namespaceWireBytes + tombstoneBytes,
        pendingOutboxRecords: 0,
        outboxLogicalBytes: 0
    });
    const baseGlobal = Object.freeze({
        ...global,
        activeMemoryRecords: global.activeMemoryRecords - oldUsage.activeMemoryRecords,
        canonicalLogicalBytes: global.canonicalLogicalBytes + tombstoneBytes
    });
    if (retainedOldUsage.canonicalLogicalBytes < 0 || baseGlobal.activeMemoryRecords < 0) {
        throw new CanonicalMemoryDataErrorV1();
    }
    const event = prepareOutboxEvent(nextOutboxSequence(database), request.namespaceRef, nextGeneration, 'namespace', request.namespaceRef, nextGeneration, 'namespace_deleted', request.tombstone.deletedAt);
    const projected = projectedOutboxUsage(baseNewUsage, baseGlobal, [event]);
    const failure = capacityResult(projected.usage, projected.global);
    if (failure !== null)
        return failureOutcome(failure);
    const advanced = database.prepare(`
    UPDATE namespaces
    SET namespace_generation = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(nextGeneration, nowMs, request.namespaceRef, request.expectedNamespaceGeneration);
    if (advanced.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
    storeUsage(database, request.namespaceRef, request.expectedNamespaceGeneration, retainedOldUsage, nowMs);
    database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms
    ) VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
  `).run(request.namespaceRef, nextGeneration, projected.usage.tombstoneRecords, projected.usage.canonicalLogicalBytes, projected.usage.pendingOutboxRecords, projected.usage.outboxLogicalBytes, nowMs);
    insertTombstone(database, request.tombstone, tombstoneWire, tombstoneBytes);
    insertOutboxEvent(database, event);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, nextGeneration, request.tombstone);
}
function recordCorrect(database, request, nowMs) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'generation'
        }));
    }
    const next = request.nextRevision;
    const nextWire = encodeMemoryRevisionV1(next);
    const usage = loadUsage(database, request.namespaceRef, namespace.generation);
    const global = loadGlobalUsage(database);
    const existingTarget = loadStoredRevision(database, request.namespaceRef, namespace.generation, next.memoryId, next.revision);
    if (existingTarget !== null) {
        if (existingTarget.wire === nextWire) {
            const replayHead = loadHead(database, request.namespaceRef, namespace.generation, next.memoryId);
            if (replayHead === null || replayHead.revision.revision < next.revision) {
                throw new CanonicalMemoryDataErrorV1();
            }
            return unchangedResult(request, namespace.generation, next.record);
        }
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'idempotency'
        }));
    }
    const head = loadHead(database, request.namespaceRef, namespace.generation, next.memoryId);
    if (head === null || head.revision.revision !== request.expectedRevision) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'revision'
        }));
    }
    if (next.previousRevisionHash !== head.revision.revisionHash) {
        return failureOutcome(Object.freeze({
            status: 'conflict',
            category: 'revision'
        }));
    }
    const revisionCount = revisionCountForMemory(database, request.namespaceRef, namespace.generation, next.memoryId);
    const wireBytes = Buffer.byteLength(nextWire, 'utf8');
    const event = prepareOutboxEvent(nextOutboxSequence(database), request.namespaceRef, namespace.generation, 'record', next.memoryId, next.revision, 'record_upserted', next.changedAt);
    const projected = projectedOutboxUsage(Object.freeze({
        ...usage,
        retainedRevisionRecords: usage.retainedRevisionRecords + 1,
        canonicalLogicalBytes: usage.canonicalLogicalBytes + wireBytes
    }), Object.freeze({
        ...global,
        canonicalLogicalBytes: global.canonicalLogicalBytes + wireBytes
    }), [event]);
    const failure = capacityResult(projected.usage, projected.global, revisionCount + 1);
    if (failure !== null)
        return failureOutcome(failure);
    insertRevision(database, next, nextWire, wireBytes);
    const updated = database.prepare(`
    UPDATE heads
    SET current_revision = ?, current_revision_hash = ?, content_hash = ?,
        cursor_ref = ?, updated_at_ms = ?, valid_until_ms = ?, purge_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      AND current_revision = ? AND current_revision_hash = ?
  `).run(next.revision, next.revisionHash, next.record.contentHash, cursorRef(next.record), instantMilliseconds(next.record.updatedAt), instantMilliseconds(next.record.retention.validUntil), instantMilliseconds(next.record.retention.purgeAt), request.namespaceRef, namespace.generation, next.memoryId, request.expectedRevision, head.revision.revisionHash);
    if (updated.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
    insertOutboxEvent(database, event);
    storeUsage(database, request.namespaceRef, namespace.generation, projected.usage, nowMs);
    storeGlobalUsage(database, projected.global, nowMs);
    return storedResult(request, namespace.generation, next.record);
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
export function classifySqliteMemoryErrcodeV1(errcode) {
    const primaryCode = errcode !== null && Number.isSafeInteger(errcode) && errcode >= 0 &&
        errcode <= 0x7fffffff
        ? errcode & 0xff
        : null;
    if (primaryCode === 5 || primaryCode === 6) {
        return Object.freeze({
            status: 'unavailable',
            category: 'busy',
            retryable: true
        });
    }
    if (primaryCode === 10) {
        return Object.freeze({
            status: 'unavailable',
            category: 'io',
            retryable: true
        });
    }
    if (primaryCode === 11 || primaryCode === 26) {
        return Object.freeze({
            status: 'corrupt',
            category: 'canonical_data'
        });
    }
    return Object.freeze({
        status: 'unavailable',
        category: 'storage',
        retryable: false
    });
}
function unavailableForSqliteError(error) {
    return classifySqliteMemoryErrcodeV1(sqliteErrorNumber(error));
}
function runImmediateTransaction(database, operation) {
    let transactionStarted = false;
    try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const outcome = operation();
        database.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK');
        transactionStarted = false;
        return outcome.result;
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
        if (error instanceof CanonicalMemoryDataErrorV1) {
            return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
        }
        return unavailableForSqliteError(error);
    }
}
function runReadTransaction(database, operation) {
    let transactionStarted = false;
    try {
        database.exec('BEGIN');
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
        if (error instanceof CanonicalMemoryDataErrorV1) {
            return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
        }
        return unavailableForSqliteError(error);
    }
}
function maintenanceFailure(error) {
    if (error instanceof CanonicalMemoryDataErrorV1) {
        return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
    }
    const failure = unavailableForSqliteError(error);
    if (failure.status === 'corrupt' || failure.status === 'unavailable')
        return failure;
    return Object.freeze({
        status: 'unavailable',
        category: 'storage',
        retryable: false
    });
}
function runMaintenanceTransaction(database, operation) {
    let transactionStarted = false;
    try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const outcome = operation();
        database.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK');
        transactionStarted = false;
        return outcome.result;
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
        return maintenanceFailure(error);
    }
}
function proposalLoad(database, request) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null)
        return Object.freeze({ status: 'not_found' });
    const proposal = loadProposalRow(database, request.namespaceRef, namespace.generation, request.proposalId);
    return proposal === null
        ? Object.freeze({ status: 'not_found' })
        : Object.freeze({ status: 'found', value: proposal.proposal });
}
function recordGet(database, request, nowMs) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null)
        return Object.freeze({ status: 'not_found' });
    const head = loadHead(database, request.namespaceRef, namespace.generation, request.memoryId);
    if (head === null || head.validUntilMs <= nowMs) {
        return Object.freeze({ status: 'not_found' });
    }
    return Object.freeze({ status: 'found', value: head.revision.record });
}
function usageGet(database, request) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null)
        return Object.freeze({ status: 'not_found' });
    const usage = loadUsage(database, request.namespaceRef, namespace.generation);
    const value = Object.freeze({
        schemaVersion: 1,
        namespaceRef: request.namespaceRef,
        namespaceGeneration: namespace.generation,
        ...usage
    });
    return Object.freeze({ status: 'usage', value });
}
function cursorAnchor(database, request, generation) {
    if (request.cursor === null)
        return null;
    const raw = request.cursor.slice(CURSOR_PREFIX.length);
    const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, memory_id, current_revision,
           cursor_ref, updated_at_ms
    FROM heads
    WHERE cursor_ref = ?
  `).get(raw);
    if (row === undefined)
        return false;
    const namespaceRef = exactString(rowValue(row, 'namespace_ref'));
    const storedGeneration = positiveInteger(rowValue(row, 'namespace_generation'));
    if (namespaceRef !== request.namespaceRef || storedGeneration !== generation)
        return false;
    const cursor = headCursorFromRow(row, request.namespaceRef, generation);
    if (!cursor.hashMatches || cursor.cursorRef !== raw)
        return false;
    return Object.freeze({ updatedAtMs: cursor.updatedAtMs, memoryId: cursor.memoryId });
}
function recordList(database, request, nowMs) {
    const namespace = loadNamespace(database, request.namespaceRef);
    if (namespace === null) {
        return request.cursor === null
            ? Object.freeze({
                status: 'page',
                records: Object.freeze([]),
                nextCursor: null,
                corruptRecords: 0,
                corruptRefs: Object.freeze([])
            })
            : Object.freeze({ status: 'invalid_cursor' });
    }
    const anchor = cursorAnchor(database, request, namespace.generation);
    if (anchor === false)
        return Object.freeze({ status: 'invalid_cursor' });
    const rows = anchor === null
        ? database.prepare(`
        SELECT memory_id, current_revision, cursor_ref, updated_at_ms
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND valid_until_ms > ?
        ORDER BY updated_at_ms DESC, memory_id ASC
        LIMIT ?
      `).all(request.namespaceRef, namespace.generation, nowMs, request.limit + 1)
        : database.prepare(`
        SELECT memory_id, current_revision, cursor_ref, updated_at_ms
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND valid_until_ms > ?
          AND (updated_at_ms < ? OR (updated_at_ms = ? AND memory_id > ?))
        ORDER BY updated_at_ms DESC, memory_id ASC
        LIMIT ?
      `).all(request.namespaceRef, namespace.generation, nowMs, anchor.updatedAtMs, anchor.updatedAtMs, anchor.memoryId, request.limit + 1);
    const records = [];
    const corruptRefs = [];
    let wireBytes = Buffer.byteLength('[]', 'utf8');
    let hasMore = rows.length > request.limit;
    let lastConsumedCursor = null;
    for (const row of rows.slice(0, request.limit)) {
        const cursor = headCursorFromRow(row, request.namespaceRef, namespace.generation);
        if (!cursor.hashMatches)
            throw new CanonicalMemoryDataErrorV1();
        let head;
        try {
            head = loadHead(database, request.namespaceRef, namespace.generation, cursor.memoryId);
        }
        catch (error) {
            if (!(error instanceof CanonicalMemoryDataErrorV1))
                throw error;
            corruptRefs.push(`${CURSOR_PREFIX}${cursor.cursorRef}`);
            lastConsumedCursor = cursor.cursorRef;
            continue;
        }
        if (head === null || head.cursorRef !== cursor.cursorRef ||
            head.revision.revision !== cursor.currentRevision ||
            head.updatedAtMs !== cursor.updatedAtMs)
            throw new CanonicalMemoryDataErrorV1();
        const recordWireBytes = Buffer.byteLength(encodeMemoryRecordV1(head.revision.record), 'utf8');
        const projectedWireBytes = wireBytes + recordWireBytes + (records.length === 0 ? 0 : 1);
        if (projectedWireBytes > request.maxWireBytes) {
            hasMore = true;
            break;
        }
        records.push(head.revision.record);
        wireBytes = projectedWireBytes;
        lastConsumedCursor = cursor.cursorRef;
    }
    const nextCursor = hasMore && lastConsumedCursor !== null
        ? `${CURSOR_PREFIX}${lastConsumedCursor}`
        : null;
    return Object.freeze({
        status: 'page',
        records: Object.freeze(records),
        nextCursor,
        corruptRecords: corruptRefs.length,
        corruptRefs: Object.freeze(corruptRefs)
    });
}
function executeAdapter(database, now, request, signal) {
    if (signal?.aborted === true)
        return Object.freeze({ status: 'aborted' });
    const currentTime = nowInstant(now);
    const nowMs = instantMilliseconds(currentTime);
    switch (request.operation) {
        case 'proposal.create':
            return runImmediateTransaction(database, () => proposalCreate(database, request, nowMs));
        case 'proposal.decide':
            return runImmediateTransaction(database, () => proposalDecide(database, request, nowMs));
        case 'record.create':
            return runImmediateTransaction(database, () => recordCreate(database, request, nowMs));
        case 'record.correct':
            return runImmediateTransaction(database, () => recordCorrect(database, request, nowMs));
        case 'record.forget':
            return runImmediateTransaction(database, () => recordForgetMutation(database, request, nowMs));
        case 'namespace.delete':
            return runImmediateTransaction(database, () => namespaceDelete(database, request, nowMs));
        case 'proposal.load':
            return runReadTransaction(database, () => proposalLoad(database, request));
        case 'record.get':
            return runReadTransaction(database, () => recordGet(database, request, nowMs));
        case 'record.list':
            return runReadTransaction(database, () => recordList(database, request, nowMs));
        case 'usage.get':
            return runReadTransaction(database, () => usageGet(database, request));
    }
}
export function createSqliteMemoryRepositoryV1(optionsValue) {
    const options = parseOptions(optionsValue);
    return createMemoryRepositoryPortV1({
        now: options.now,
        execute: async (request, signal) => executeAdapter(options.database, options.now, request, signal)
    });
}
export function purgeExpiredSqliteMemoryRecordsV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, [
        'database', 'namespaceRef', 'now', 'actorRef', 'reasonCode'
    ]);
    const common = parseOptions({
        database: input.database,
        now: input.now
    });
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    if (!memoryAsciiWithinLimit(input.actorRef, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !input.actorRef.startsWith('actor:') || input.actorRef.length === 'actor:'.length ||
        !memoryAsciiWithinLimit(input.reasonCode, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.reasonCode))
        return invalidMemoryValue();
    const actorRef = input.actorRef;
    const reasonCode = input.reasonCode;
    const currentTime = nowInstant(common.now);
    const nowMs = instantMilliseconds(currentTime);
    return runMaintenanceTransaction(common.database, () => {
        const namespace = loadNamespace(common.database, namespaceRef);
        if (namespace === null) {
            return Object.freeze({
                commit: true,
                result: Object.freeze({
                    status: 'purged',
                    processedRecords: 0,
                    hasMore: false
                })
            });
        }
        const rows = common.database.prepare(`
        SELECT memory_id, current_revision
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND purge_at_ms <= ?
        ORDER BY purge_at_ms ASC, memory_id ASC
        LIMIT 32
      `).all(namespaceRef, namespace.generation, nowMs);
        for (const row of rows) {
            const memoryId = canonicalMemoryId(rowValue(row, 'memory_id'));
            const revision = positiveInteger(rowValue(row, 'current_revision'));
            const tombstone = createMemoryTombstoneV1({
                tombstoneId: `tombstone:retention:${domainHash(RETENTION_TOMBSTONE_HASH_DOMAIN_V1, JSON.stringify({ namespaceRef, generation: namespace.generation, memoryId, revision }))}`,
                namespaceRef,
                namespaceGeneration: namespace.generation,
                memoryId,
                deletedRevision: revision,
                deletionKind: 'memory_forgotten',
                deletedAt: currentTime,
                deletedByActorRef: actorRef,
                reasonCode,
                expiresAt: new Date(nowMs + MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs).toISOString()
            });
            const outcome = recordForgetMutation(common.database, Object.freeze({
                operation: 'record.forget',
                namespaceRef,
                expectedRevision: revision,
                expectedNamespaceGeneration: namespace.generation,
                tombstone
            }), nowMs);
            if (!outcome.commit) {
                if (outcome.result.status === 'capacity' || outcome.result.status === 'corrupt' ||
                    outcome.result.status === 'unavailable') {
                    return Object.freeze({ commit: false, result: outcome.result });
                }
                return Object.freeze({
                    commit: false,
                    result: Object.freeze({
                        status: 'corrupt',
                        category: 'canonical_data'
                    })
                });
            }
        }
        const currentNamespace = loadNamespace(common.database, namespaceRef);
        const hasMore = currentNamespace !== null && common.database.prepare(`
        SELECT memory_id
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND purge_at_ms <= ?
        ORDER BY purge_at_ms ASC, memory_id ASC
        LIMIT 1
      `).get(namespaceRef, currentNamespace.generation, nowMs) !== undefined;
        return Object.freeze({
            commit: true,
            result: Object.freeze({
                status: 'purged',
                processedRecords: rows.length,
                hasMore
            })
        });
    });
}
function usageIsPhysicallyEmpty(usage) {
    return usage.pendingProposalRecords === 0 && usage.activeMemoryRecords === 0 &&
        usage.retainedRevisionRecords === 0 && usage.tombstoneRecords === 0 &&
        usage.canonicalLogicalBytes === 0 && usage.pendingOutboxRecords === 0 &&
        usage.outboxLogicalBytes === 0;
}
function deleteUsageWhenEmpty(database, namespaceRef, generation, usage) {
    if (!usageIsPhysicallyEmpty(usage))
        return;
    const deleted = database.prepare(`
    DELETE FROM usage
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(namespaceRef, generation);
    if (deleted.changes !== 1)
        throw new CanonicalMemoryDataErrorV1();
}
export function scrubDeletedSqliteMemoryNamespaceV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, [
        'database', 'namespaceRef', 'namespaceGeneration', 'now'
    ]);
    const common = parseOptions({
        database: input.database,
        now: input.now
    });
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    if (typeof input.namespaceGeneration !== 'number' ||
        !Number.isSafeInteger(input.namespaceGeneration) || input.namespaceGeneration <= 0 ||
        Object.is(input.namespaceGeneration, -0))
        return invalidMemoryValue();
    const generation = input.namespaceGeneration;
    const nowMs = instantMilliseconds(nowInstant(common.now));
    return runMaintenanceTransaction(common.database, () => {
        const namespace = loadNamespace(common.database, namespaceRef);
        if (namespace === null || namespace.generation <= generation) {
            throw new CanonicalMemoryDataErrorV1();
        }
        const usageRow = common.database.prepare(`
        SELECT namespace_ref FROM usage
        WHERE namespace_ref = ? AND namespace_generation = ?
      `).get(namespaceRef, generation);
        if (usageRow === undefined) {
            const residual = common.database.prepare(`
          SELECT proposal_id AS aggregate_id FROM proposals
          WHERE namespace_ref = ? AND namespace_generation = ?
          UNION ALL
          SELECT memory_id AS aggregate_id FROM revisions
          WHERE namespace_ref = ? AND namespace_generation = ?
          LIMIT 1
        `).get(namespaceRef, generation, namespaceRef, generation);
            if (residual !== undefined)
                throw new CanonicalMemoryDataErrorV1();
            return Object.freeze({
                commit: true,
                result: Object.freeze({
                    status: 'scrubbed',
                    processedAggregates: 0,
                    hasMore: false
                })
            });
        }
        const usage = loadUsage(common.database, namespaceRef, generation);
        const global = loadGlobalUsage(common.database);
        const proposalRows = common.database.prepare(`
        SELECT proposal_id
        FROM proposals
        WHERE namespace_ref = ? AND namespace_generation = ?
        ORDER BY proposal_id ASC
        LIMIT 32
      `).all(namespaceRef, generation);
        let processedAggregates = 0;
        let pendingDeleted = 0;
        let activeDeleted = 0;
        let revisionsDeleted = 0;
        let canonicalBytesDeleted = 0;
        if (proposalRows.length > 0) {
            for (const row of proposalRows) {
                const proposalId = exactString(rowValue(row, 'proposal_id'));
                const stored = loadProposalRow(common.database, namespaceRef, generation, proposalId);
                if (stored === null)
                    throw new CanonicalMemoryDataErrorV1();
                if (stored.proposal.state === 'pending')
                    pendingDeleted += 1;
                canonicalBytesDeleted += stored.wireBytes;
                const deleted = common.database.prepare(`
            DELETE FROM proposals
            WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
          `).run(namespaceRef, generation, proposalId);
                if (deleted.changes !== 1)
                    throw new CanonicalMemoryDataErrorV1();
            }
            processedAggregates = proposalRows.length;
        }
        else {
            const memoryRows = common.database.prepare(`
          SELECT memory_id
          FROM revisions
          WHERE namespace_ref = ? AND namespace_generation = ?
          GROUP BY memory_id
          ORDER BY memory_id ASC
          LIMIT 32
        `).all(namespaceRef, generation);
            for (const row of memoryRows) {
                const memoryId = canonicalMemoryId(rowValue(row, 'memory_id'));
                const head = loadHead(common.database, namespaceRef, generation, memoryId);
                if (head === null)
                    throw new CanonicalMemoryDataErrorV1();
                const revisionBodies = loadValidatedRevisionBodies(common.database, namespaceRef, generation, memoryId, head);
                canonicalBytesDeleted += revisionBodies.wireBytes;
                const headDelete = common.database.prepare(`
            DELETE FROM heads
            WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
          `).run(namespaceRef, generation, memoryId);
                if (headDelete.changes !== 1)
                    throw new CanonicalMemoryDataErrorV1();
                const revisionDelete = common.database.prepare(`
            DELETE FROM revisions
            WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
          `).run(namespaceRef, generation, memoryId);
                if (revisionDelete.changes !== revisionBodies.rows.length) {
                    throw new CanonicalMemoryDataErrorV1();
                }
                activeDeleted += 1;
                revisionsDeleted += revisionBodies.rows.length;
            }
            processedAggregates = memoryRows.length;
        }
        const nextUsage = Object.freeze({
            ...usage,
            pendingProposalRecords: usage.pendingProposalRecords - pendingDeleted,
            activeMemoryRecords: usage.activeMemoryRecords - activeDeleted,
            retainedRevisionRecords: usage.retainedRevisionRecords - revisionsDeleted,
            canonicalLogicalBytes: usage.canonicalLogicalBytes - canonicalBytesDeleted
        });
        const nextGlobal = Object.freeze({
            ...global,
            canonicalLogicalBytes: global.canonicalLogicalBytes - canonicalBytesDeleted
        });
        if (nextUsage.pendingProposalRecords < 0 || nextUsage.activeMemoryRecords < 0 ||
            nextUsage.retainedRevisionRecords < 0 || nextUsage.canonicalLogicalBytes < 0 ||
            nextGlobal.canonicalLogicalBytes < 0)
            throw new CanonicalMemoryDataErrorV1();
        storeUsage(common.database, namespaceRef, generation, nextUsage, nowMs);
        storeGlobalUsage(common.database, nextGlobal, nowMs);
        deleteUsageWhenEmpty(common.database, namespaceRef, generation, nextUsage);
        const hasMore = common.database.prepare(`
        SELECT proposal_id AS aggregate_id FROM proposals
        WHERE namespace_ref = ? AND namespace_generation = ?
        UNION ALL
        SELECT memory_id AS aggregate_id FROM revisions
        WHERE namespace_ref = ? AND namespace_generation = ?
        LIMIT 1
      `).get(namespaceRef, generation, namespaceRef, generation) !== undefined;
        return Object.freeze({
            commit: true,
            result: Object.freeze({
                status: 'scrubbed',
                processedAggregates,
                hasMore
            })
        });
    });
}
export function purgeExpiredSqliteMemoryTombstonesV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, ['database', 'namespaceRef', 'now']);
    const common = parseOptions({
        database: input.database,
        now: input.now
    });
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const nowMs = instantMilliseconds(nowInstant(common.now));
    return runMaintenanceTransaction(common.database, () => {
        const namespace = loadNamespace(common.database, namespaceRef);
        if (namespace === null) {
            return Object.freeze({
                commit: true,
                result: Object.freeze({
                    status: 'purged',
                    processedTombstones: 0,
                    hasMore: false
                })
            });
        }
        const rows = common.database.prepare(`
        SELECT namespace_generation, tombstone_id, tombstone_wire_bytes
        FROM tombstones
        WHERE namespace_ref = ? AND expires_at_ms <= ?
        ORDER BY expires_at_ms ASC, namespace_generation ASC, tombstone_id ASC
        LIMIT 32
      `).all(namespaceRef, nowMs);
        const usageByGeneration = new Map();
        let canonicalBytesDeleted = 0;
        for (const row of rows) {
            const generation = positiveInteger(rowValue(row, 'namespace_generation'));
            const tombstoneId = exactString(rowValue(row, 'tombstone_id'));
            const wireBytes = positiveInteger(rowValue(row, 'tombstone_wire_bytes'));
            const tombstone = loadTombstone(common.database, namespaceRef, generation, tombstoneId);
            if (tombstone === null || tombstone.wireBytes !== wireBytes) {
                throw new CanonicalMemoryDataErrorV1();
            }
            const usage = usageByGeneration.get(generation) ??
                loadUsage(common.database, namespaceRef, generation);
            if (usage.tombstoneRecords <= 0 || usage.canonicalLogicalBytes < wireBytes) {
                throw new CanonicalMemoryDataErrorV1();
            }
            usageByGeneration.set(generation, Object.freeze({
                ...usage,
                tombstoneRecords: usage.tombstoneRecords - 1,
                canonicalLogicalBytes: usage.canonicalLogicalBytes - wireBytes
            }));
            canonicalBytesDeleted += wireBytes;
            const deleted = common.database.prepare(`
          DELETE FROM tombstones
          WHERE namespace_ref = ? AND namespace_generation = ? AND tombstone_id = ?
        `).run(namespaceRef, generation, tombstoneId);
            if (deleted.changes !== 1)
                throw new CanonicalMemoryDataErrorV1();
        }
        const global = loadGlobalUsage(common.database);
        const nextGlobal = Object.freeze({
            ...global,
            canonicalLogicalBytes: global.canonicalLogicalBytes - canonicalBytesDeleted
        });
        if (nextGlobal.canonicalLogicalBytes < 0)
            throw new CanonicalMemoryDataErrorV1();
        for (const [generation, usage] of usageByGeneration) {
            storeUsage(common.database, namespaceRef, generation, usage, nowMs);
            deleteUsageWhenEmpty(common.database, namespaceRef, generation, usage);
        }
        storeGlobalUsage(common.database, nextGlobal, nowMs);
        const hasMore = common.database.prepare(`
        SELECT tombstone_id
        FROM tombstones
        WHERE namespace_ref = ? AND expires_at_ms <= ?
        ORDER BY expires_at_ms ASC, namespace_generation ASC, tombstone_id ASC
        LIMIT 1
      `).get(namespaceRef, nowMs) !== undefined;
        return Object.freeze({
            commit: true,
            result: Object.freeze({
                status: 'purged',
                processedTombstones: rows.length,
                hasMore
            })
        });
    });
}
function deletionOutboxQueued(database, tombstone) {
    const aggregate = tombstone.deletionKind === 'memory_forgotten' ? 'record' : 'namespace';
    const aggregateId = tombstone.deletionKind === 'memory_forgotten'
        ? tombstone.memoryId
        : tombstone.namespaceRef;
    const revision = tombstone.deletionKind === 'memory_forgotten'
        ? tombstone.deletedRevision
        : tombstone.namespaceGeneration;
    const eventKind = tombstone.deletionKind === 'memory_forgotten'
        ? 'record_forgotten'
        : 'namespace_deleted';
    if (aggregateId === null || revision === null)
        return false;
    const rows = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
           aggregate_id, revision, event_kind, occurred_at_ms, event_wire,
           logical_bytes
    FROM outbox
    WHERE namespace_ref = ? AND namespace_generation = ? AND aggregate = ?
      AND aggregate_id = ? AND revision = ? AND event_kind = ?
      AND occurred_at_ms = ?
    ORDER BY sequence ASC
    LIMIT 2
  `).all(tombstone.namespaceRef, tombstone.namespaceGeneration, aggregate, aggregateId, revision, eventKind, instantMilliseconds(tombstone.deletedAt));
    if (rows.length !== 1)
        return false;
    const row = rows[0];
    const sequence = positiveInteger(rowValue(row, 'sequence'));
    const wire = exactString(rowValue(row, 'event_wire'));
    const logicalBytes = positiveInteger(rowValue(row, 'logical_bytes'));
    if (Buffer.byteLength(wire, 'utf8') !== logicalBytes)
        return false;
    const event = decodeMemoryOutboxEventV1(wire);
    return event.sequence === sequence &&
        event.eventId === exactString(rowValue(row, 'event_id')) &&
        event.eventId === outboxEventId(sequence, tombstone.namespaceRef, tombstone.namespaceGeneration, aggregate, aggregateId, revision, eventKind) &&
        event.namespaceRef === tombstone.namespaceRef &&
        event.namespaceGeneration === tombstone.namespaceGeneration &&
        event.aggregate === aggregate && event.aggregateId === aggregateId &&
        event.revision === revision && event.eventKind === eventKind &&
        event.occurredAt === tombstone.deletedAt &&
        instantMilliseconds(event.occurredAt) === exactInteger(rowValue(row, 'occurred_at_ms')) &&
        exactString(rowValue(row, 'namespace_ref')) === tombstone.namespaceRef &&
        positiveInteger(rowValue(row, 'namespace_generation')) === tombstone.namespaceGeneration &&
        exactString(rowValue(row, 'aggregate')) === aggregate &&
        exactString(rowValue(row, 'aggregate_id')) === aggregateId &&
        positiveInteger(rowValue(row, 'revision')) === revision &&
        exactString(rowValue(row, 'event_kind')) === eventKind;
}
function memoryDeletionBodiesAbsent(database, tombstone) {
    const memoryId = tombstone.memoryId;
    if (memoryId === null || tombstone.deletedRevision === null)
        return false;
    for (const table of ['heads', 'revisions', 'revision_payloads']) {
        if (database.prepare(`
      SELECT memory_id FROM ${table}
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      LIMIT 1
    `).get(tombstone.namespaceRef, tombstone.namespaceGeneration, memoryId) !== undefined) {
            return false;
        }
    }
    return database.prepare(`
    SELECT proposal_id FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
    LIMIT 1
  `).get(tombstone.namespaceRef, tombstone.namespaceGeneration, memoryId) === undefined;
}
function deletionCheckpointFacts(database, tombstone, tombstoneWire) {
    try {
        const stored = loadTombstone(database, tombstone.namespaceRef, tombstone.namespaceGeneration, tombstone.tombstoneId);
        if (stored === null || stored.wire !== tombstoneWire) {
            return Object.freeze({
                logicalDeletion: 'unverified',
                derivedCleanup: 'unverified'
            });
        }
        const logicallyDeleted = tombstone.deletionKind === 'memory_forgotten'
            ? memoryDeletionBodiesAbsent(database, tombstone)
            : (loadNamespace(database, tombstone.namespaceRef)?.generation ?? 0) >=
                tombstone.namespaceGeneration;
        if (!logicallyDeleted) {
            return Object.freeze({
                logicalDeletion: 'unverified',
                derivedCleanup: 'unverified'
            });
        }
        return Object.freeze({
            logicalDeletion: 'committed',
            derivedCleanup: deletionOutboxQueued(database, tombstone)
                ? 'queued'
                : 'unverified'
        });
    }
    catch {
        return Object.freeze({
            logicalDeletion: 'unverified',
            derivedCleanup: 'unverified'
        });
    }
}
export function checkpointSqliteMemoryDeletionV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, ['database', 'tombstone']);
    const database = input.database;
    if (database === null || typeof database !== 'object' || utilTypes.isProxy(database) ||
        typeof database.prepare !== 'function' ||
        typeof database.exec !== 'function')
        return invalidMemoryValue();
    const tombstone = parseMemoryTombstoneV1(input.tombstone);
    const tombstoneWire = encodeMemoryTombstoneV1(tombstone);
    const facts = deletionCheckpointFacts(database, tombstone, tombstoneWire);
    let payloadDeletion = 'unverified';
    try {
        const row = database.prepare('PRAGMA secure_delete').get();
        if (row !== undefined && Object.values(row)[0] === 1)
            payloadDeletion = 'secure_delete_on';
    }
    catch {
        // Logical deletion remains committed even if the invariant cannot be re-read here.
    }
    let walCheckpoint = 'deferred';
    try {
        const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (row !== undefined && rowValue(row, 'busy') === 0)
            walCheckpoint = 'truncated';
    }
    catch {
        // Checkpoint is deliberately independent from the already committed logical delete.
    }
    return Object.freeze({
        schemaVersion: 1,
        logicalDeletion: facts.logicalDeletion,
        payloadDeletion,
        walCheckpoint,
        derivedCleanup: facts.derivedCleanup
    });
}
