import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { memoryLifecycleActorCapabilityRoleV1, memoryMaintenanceCapabilityAllowsRequestV1, memoryPolicyCapabilityAllowsBindingV1, memoryPolicyCapabilityAllowsV1 } from './memory-lifecycle-authority.js';
import { assertMemoryRevisionChangeBundleV1, buildMemoryCorrectionProposalApprovalBundleV1, buildMemoryProposalApprovalBundleV1, buildMemoryProposalDecisionV2, projectMemoryProposalLifecycleV2, projectMemoryRecordLifecycleV2 } from './memory-lifecycle-builder.js';
import { decodeMemoryProposalV2, decodeMemoryRevisionEvidenceV1, decodeMemoryRevisionV2, decodeMemoryConsentEvidenceV1, decodeMemoryV1ToV2AggregateManifestV1, encodeDeletionStatusV1, encodeMemoryConsentEvidenceV1, encodeMemoryProposalV2, encodeMemoryRevisionEvidenceV1, encodeMemoryRevisionV2 } from './memory-lifecycle-codec.js';
import { decodeMemoryLifecycleCommandWireV1, memoryLifecycleCommandHashV1, memoryLifecycleCommandRefHashV1, parseMemoryLifecycleCommandV1 } from './memory-lifecycle-command.js';
import { memoryLifecycleDomainHashV1, createDeletionMutationReceiptV1, createDeletionStatusV1, parseMemoryLifecycleInstantV1 } from './memory-lifecycle-domain.js';
import { MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 } from './memory-lifecycle-port.js';
import { decideMemoryLifecycleActorPolicyV1, evaluateGroupMemoryAdmissionV1, memoryConsentMatchesNamespaceV1 } from './memory-lifecycle-policy.js';
import { createMemoryLifecycleResultV1, decodeMemoryLifecycleStableResultWireV1, encodeMemoryLifecycleStableResultWireV1, memoryLifecycleResultIsLedgerStableV1, memoryLifecycleStableResultHashV1 } from './memory-lifecycle-result.js';
import { decodeMemoryOutboxEventV1, encodeMemoryOutboxEventV1, encodeMemoryTombstoneV1 } from './memory-codec.js';
import { createMemoryOutboxEventV1, createMemoryTombstoneV1 } from './memory-domain.js';
import { memoryNamespaceRefV1, memoryNamespaceWireV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
import { MEMORY_CURSOR_HASH_DOMAIN_V1, MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1 } from './sqlite-memory-repository.js';
export class CanonicalLifecycleMutationDataErrorV1 extends Error {
}
class LifecycleMutationCapacityErrorV1 extends Error {
    category;
    constructor(category) {
        super('memory lifecycle mutation capacity');
        this.category = category;
    }
}
const SUPPORTED_OPERATIONS = new Set([
    'proposal.create', 'proposal.approve', 'proposal.reject', 'proposal.withdraw',
    'proposal.expire', 'record.correct', 'record.renew', 'record.changeConflict',
    'record.forget', 'namespace.delete'
]);
const PROPOSAL_DECISION_OPERATIONS = new Set([
    'proposal.approve', 'proposal.reject', 'proposal.withdraw', 'proposal.expire'
]);
const RECORD_OPERATIONS = new Set([
    'record.correct', 'record.renew', 'record.changeConflict'
]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const AGGREGATE_REF_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-aggregate-ref.v1';
const MUTATION_RECEIPT_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-mutation-receipt.v1';
const PROPOSAL_RESULT_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-proposal-result.v1';
const DELETION_REPOSITORY_RECEIPT_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-deletion-repository-receipt.v1';
const NAMESPACE_CANONICAL_SOFT_BYTES = MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes - (2 * 1_024 * 1_024);
const DEPLOYMENT_CANONICAL_SOFT_BYTES = MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes - (8 * 1_024 * 1_024);
const PENDING_PROPOSAL_SOFT_RECORDS = 240;
const OUTBOX_SOFT_RECORDS = MEMORY_RESOURCE_LIMITS.unackedOutboxRecords - 256;
const OUTBOX_SOFT_BYTES = MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes - (1 * 1_024 * 1_024);
function rowValue(row, name) {
    if (!Object.hasOwn(row, name))
        throw new CanonicalLifecycleMutationDataErrorV1();
    return row[name];
}
function exactString(value) {
    if (typeof value !== 'string')
        throw new CanonicalLifecycleMutationDataErrorV1();
    return value;
}
function exactInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        throw new CanonicalLifecycleMutationDataErrorV1();
    return value;
}
function positiveInteger(value) {
    const parsed = exactInteger(value);
    if (parsed === 0)
        throw new CanonicalLifecycleMutationDataErrorV1();
    return parsed;
}
function requireOneChange(changes) {
    if (changes !== 1 && changes !== 1n)
        throw new CanonicalLifecycleMutationDataErrorV1();
}
function domainHash(domain, preimage) {
    return createHash('sha256')
        .update(domain, 'utf8')
        .update('\0', 'utf8')
        .update(preimage, 'utf8')
        .digest('hex');
}
function freezeTrustedNow(database, now) {
    let wall;
    try {
        wall = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []));
    }
    catch {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const wallMs = Date.parse(wall);
    const row = database.prepare(`
    SELECT trusted_time_high_water_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get();
    if (row === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    const persisted = exactInteger(rowValue(row, 'trusted_time_high_water_ms'));
    const trustedMs = Math.max(wallMs, persisted);
    if (trustedMs > persisted) {
        requireOneChange(database.prepare(`
      UPDATE lifecycle_deployment_state SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persisted).changes);
    }
    return new Date(trustedMs).toISOString();
}
function resultFor(operation, commandHash, payload) {
    return createMemoryLifecycleResultV1({
        schemaVersion: 1,
        operation,
        commandHash,
        ...payload
    });
}
function denial(operation, commandHash, category) {
    return resultFor(operation, commandHash, { status: 'denied', category });
}
function stableResult(result) {
    if (!memoryLifecycleResultIsLedgerStableV1(result)) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return result;
}
function lockedAccessAllows(envelope, wire, freshNow) {
    return memoryAccessCapabilityAllowsV1(envelope.access, wire.namespaceRef, freshNow);
}
function actorAllows(envelope, wire, action, beforeRequirement, afterRequirement, initiatedByActorRef, freshNow) {
    if (envelope.authority.kind !== 'actor')
        return false;
    return decideMemoryLifecycleActorPolicyV1(envelope.authority.capability, {
        botInstanceId: envelope.access.botInstanceId,
        accountId: envelope.access.accountId,
        sceneRef: envelope.access.sceneRef,
        namespaceRef: wire.namespaceRef,
        generation: wire.expectedNamespaceGeneration,
        actorRef: wire.initiatedByActorRef,
        action,
        beforeRequirement,
        afterRequirement,
        initiatedByActorRef,
        targetMode: 'none',
        expectedRevision: null
    }, freshNow).allowed;
}
function canonicalRequirement(namespace, value) {
    if (namespace.scope.kind === 'group' && value.sensitivity === 'sensitive')
        return 'elevated';
    return 'ordinary';
}
function groupAdmissionAllows(namespace, value) {
    return namespace.scope.kind !== 'group' || evaluateGroupMemoryAdmissionV1(namespace, {
        kind: value.kind,
        sensitivity: value.sensitivity,
        sources: value.sources
    }).allowed;
}
function policyAllows(envelope, wire, proposal, evidence, freshNow) {
    if (envelope.authority.kind !== 'policy' || evidence.policyRef === null ||
        evidence.policyGeneration === null || !memoryConsentMatchesNamespaceV1(proposal.namespace, evidence.evidenceKind))
        return false;
    const common = {
        botInstanceId: envelope.access.botInstanceId,
        accountId: envelope.access.accountId,
        sceneRef: envelope.access.sceneRef,
        namespaceRef: wire.namespaceRef,
        generation: wire.expectedNamespaceGeneration,
        policyRef: evidence.policyRef,
        policyGeneration: evidence.policyGeneration,
        consent: evidence.evidenceKind
    };
    const binding = {
        ...common,
        createdByActorRef: wire.initiatedByActorRef
    };
    const bindingAllowed = memoryPolicyCapabilityAllowsBindingV1(envelope.authority.capability, binding, freshNow);
    const contentAllowed = memoryPolicyCapabilityAllowsV1(envelope.authority.capability, {
        ...common,
        kind: proposal.kind,
        sensitivity: proposal.sensitivity,
        sourceKinds: [...new Set(proposal.sources.map(source => source.sourceKind))],
        retentionPolicyRef: proposal.retentionPolicyRef
    }, freshNow);
    return bindingAllowed && contentAllowed;
}
function maintenanceAllowsExpire(envelope, wire, freshNow) {
    return envelope.authority.kind === 'maintenance' &&
        wire.initiatedByActorRef === MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 &&
        memoryMaintenanceCapabilityAllowsRequestV1(envelope.authority.capability, {
            botInstanceId: envelope.access.botInstanceId,
            accountId: envelope.access.accountId,
            namespaceRef: wire.namespaceRef,
            currentGeneration: wire.expectedNamespaceGeneration,
            targetGeneration: wire.expectedNamespaceGeneration,
            deletionRef: null,
            operation: 'proposal.expireDue',
            limit: 1
        }, freshNow);
}
function canonicalWire(wireValue, bytesValue, decode) {
    const wire = exactString(wireValue);
    const bytes = positiveInteger(bytesValue);
    if (Buffer.byteLength(wire, 'utf8') !== bytes) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    try {
        return Object.freeze({ wire, bytes, value: decode(wire) });
    }
    catch {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
}
function loadNamespace(database, namespaceRef) {
    const row = database.prepare(`
    SELECT namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef);
    if (row === undefined)
        return null;
    const loaded = canonicalWire(rowValue(row, 'namespace_wire'), rowValue(row, 'namespace_wire_bytes'), wire => parseMemoryNamespaceV1(JSON.parse(wire)));
    if (memoryNamespaceRefV1(loaded.value) !== namespaceRef ||
        memoryNamespaceWireV1(loaded.value) !== loaded.wire) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return Object.freeze({
        namespace: loaded.value,
        generation: positiveInteger(rowValue(row, 'namespace_generation')),
        wireBytes: loaded.bytes
    });
}
function insertNamespace(database, namespace, generation, nowMs) {
    const namespaceRef = memoryNamespaceRefV1(namespace);
    const wire = memoryNamespaceWireV1(namespace);
    const bytes = Buffer.byteLength(wire, 'utf8');
    requireOneChange(database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation,
      created_at_ms, updated_at_ms, content_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(namespaceRef, wire, bytes, generation, nowMs, nowMs).changes);
    requireOneChange(database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes
    ) VALUES (?, ?, 0, 0, 0, 0, ?, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `).run(namespaceRef, generation, bytes, nowMs).changes);
    requireOneChange(database.prepare(`
    INSERT INTO lifecycle_namespace_usage(
      namespace_ref, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes, updated_at_ms
    ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
  `).run(namespaceRef, nowMs).changes);
    requireOneChange(database.prepare(`
    UPDATE global_usage SET namespace_records = namespace_records + 1,
      canonical_logical_bytes = canonical_logical_bytes + ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(bytes, nowMs).changes);
}
function loadProposal(database, namespaceRef, generation, proposalId) {
    const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
  `).get(namespaceRef, generation, proposalId);
    if (row === undefined)
        return null;
    const loaded = canonicalWire(rowValue(row, 'proposal_wire'), rowValue(row, 'proposal_wire_bytes'), decodeMemoryProposalV2);
    const proposal = loaded.value;
    const decidedAt = rowValue(row, 'decided_at_ms');
    if (proposal.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
        proposal.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
        proposal.proposalId !== exactString(rowValue(row, 'proposal_id')) ||
        proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
        proposal.state !== exactString(rowValue(row, 'state')) ||
        Date.parse(proposal.proposedAt) !== exactInteger(rowValue(row, 'proposed_at_ms')) ||
        (proposal.decision === null ? null : Date.parse(proposal.decision.decidedAt)) !== decidedAt ||
        (proposal.decision?.resultingMemoryId ?? null) !== rowValue(row, 'resulting_memory_id') ||
        (proposal.decision?.resultingMemoryRevision ?? null) !== rowValue(row, 'resulting_revision') ||
        (proposal.decision?.resultingRevisionHash ?? null) !== rowValue(row, 'resulting_revision_hash')) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return Object.freeze({ proposal, wire: loaded.wire, bytes: loaded.bytes });
}
function cursorRefForRevision(revision) {
    return domainHash(MEMORY_CURSOR_HASH_DOMAIN_V1, JSON.stringify({
        namespaceRef: revision.record.namespaceRef,
        namespaceGeneration: revision.record.namespaceGeneration,
        updatedAt: revision.record.updatedAt,
        memoryId: revision.memoryId,
        currentRevision: revision.revision
    }));
}
function loadHeadRevision(database, namespaceRef, generation, memoryId) {
    const row = database.prepare(`
    SELECT h.current_revision, h.current_revision_hash, h.content_hash, h.cursor_ref,
      h.updated_at_ms, h.valid_until_ms, h.purge_at_ms,
      r.namespace_ref, r.namespace_generation, r.memory_id, r.revision, r.operation,
      r.revision_hash, r.previous_revision_hash, r.changed_at_ms, r.revision_wire_bytes,
      p.revision_wire
    FROM heads h
    JOIN revisions r ON r.namespace_ref = h.namespace_ref
      AND r.namespace_generation = h.namespace_generation
      AND r.memory_id = h.memory_id AND r.revision = h.current_revision
    JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
      AND p.namespace_generation = r.namespace_generation
      AND p.memory_id = r.memory_id AND p.revision = r.revision
    WHERE h.namespace_ref = ? AND h.namespace_generation = ? AND h.memory_id = ?
  `).get(namespaceRef, generation, memoryId);
    if (row === undefined)
        return null;
    const loaded = canonicalWire(rowValue(row, 'revision_wire'), rowValue(row, 'revision_wire_bytes'), decodeMemoryRevisionV2);
    const revision = loaded.value;
    if (revision.record.namespaceRef !== namespaceRef ||
        revision.record.namespaceGeneration !== generation || revision.memoryId !== memoryId ||
        revision.revision !== positiveInteger(rowValue(row, 'revision')) ||
        revision.operation !== exactString(rowValue(row, 'operation')) ||
        revision.revisionHash !== exactString(rowValue(row, 'revision_hash')) ||
        revision.previousRevisionHash !== rowValue(row, 'previous_revision_hash') ||
        Date.parse(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms')) ||
        revision.revision !== positiveInteger(rowValue(row, 'current_revision')) ||
        revision.revisionHash !== exactString(rowValue(row, 'current_revision_hash')) ||
        revision.record.contentHash !== exactString(rowValue(row, 'content_hash')) ||
        cursorRefForRevision(revision) !== exactString(rowValue(row, 'cursor_ref')) ||
        Date.parse(revision.record.updatedAt) !== exactInteger(rowValue(row, 'updated_at_ms')) ||
        Date.parse(revision.record.retention.validUntil) !==
            exactInteger(rowValue(row, 'valid_until_ms')) ||
        Date.parse(revision.record.retention.purgeAt) !== exactInteger(rowValue(row, 'purge_at_ms'))) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return Object.freeze({ revision, wire: loaded.wire, bytes: loaded.bytes });
}
function loadRevision(database, namespaceRef, generation, memoryId, revisionNumber) {
    const row = database.prepare(`
    SELECT r.namespace_ref, r.namespace_generation, r.memory_id, r.revision, r.operation,
      r.revision_hash, r.previous_revision_hash, r.changed_at_ms, r.revision_wire_bytes,
      p.revision_wire
    FROM revisions r
    JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
      AND p.namespace_generation = r.namespace_generation
      AND p.memory_id = r.memory_id AND p.revision = r.revision
    WHERE r.namespace_ref = ? AND r.namespace_generation = ? AND r.memory_id = ?
      AND r.revision = ?
  `).get(namespaceRef, generation, memoryId, revisionNumber);
    if (row === undefined)
        return null;
    const loaded = canonicalWire(rowValue(row, 'revision_wire'), rowValue(row, 'revision_wire_bytes'), decodeMemoryRevisionV2);
    const revision = loaded.value;
    if (revision.record.namespaceRef !== namespaceRef ||
        revision.record.namespaceGeneration !== generation || revision.memoryId !== memoryId ||
        revision.revision !== positiveInteger(rowValue(row, 'revision')) ||
        revision.operation !== exactString(rowValue(row, 'operation')) ||
        revision.revisionHash !== exactString(rowValue(row, 'revision_hash')) ||
        revision.previousRevisionHash !== rowValue(row, 'previous_revision_hash') ||
        Date.parse(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms'))) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return Object.freeze({ revision, wire: loaded.wire, bytes: loaded.bytes });
}
function coreUsage(row) {
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
function loadUsage(database, namespaceRef, generation) {
    const namespaceRow = database.prepare(`
    SELECT pending_proposal_records, active_memory_records, retained_revision_records,
      tombstone_records, canonical_logical_bytes, pending_outbox_records,
      outbox_logical_bytes, lifecycle_command_records, lifecycle_command_logical_bytes
    FROM usage WHERE namespace_ref = ? AND namespace_generation = ?
  `).get(namespaceRef, generation);
    const namespaceCommandRow = database.prepare(`
    SELECT lifecycle_command_records, lifecycle_command_logical_bytes
    FROM lifecycle_namespace_usage WHERE namespace_ref = ?
  `).get(namespaceRef);
    const globalRow = database.prepare(`
    SELECT namespace_records, pending_proposal_records, active_memory_records,
      retained_revision_records, tombstone_records, canonical_logical_bytes,
      pending_outbox_records, outbox_logical_bytes, lifecycle_command_records,
      lifecycle_command_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get();
    if (namespaceRow === undefined || namespaceCommandRow === undefined || globalRow === undefined) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return Object.freeze({
        namespace: coreUsage(namespaceRow),
        generationCommands: Object.freeze({
            records: exactInteger(rowValue(namespaceRow, 'lifecycle_command_records')),
            bytes: exactInteger(rowValue(namespaceRow, 'lifecycle_command_logical_bytes'))
        }),
        namespaceCommands: Object.freeze({
            records: exactInteger(rowValue(namespaceCommandRow, 'lifecycle_command_records')),
            bytes: exactInteger(rowValue(namespaceCommandRow, 'lifecycle_command_logical_bytes'))
        }),
        global: Object.freeze({
            namespaceRecords: exactInteger(rowValue(globalRow, 'namespace_records')),
            ...coreUsage(globalRow),
            records: exactInteger(rowValue(globalRow, 'lifecycle_command_records')),
            bytes: exactInteger(rowValue(globalRow, 'lifecycle_command_logical_bytes'))
        })
    });
}
function assertActualNotGreater(actual, stored) {
    for (const [name, value] of Object.entries(stored)) {
        if (exactInteger(rowValue(actual, name)) > value) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
    }
}
function validateUsageLowerBounds(database, namespaceRef, generation, usage, mutationDelta) {
    const actual = database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
        AND state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads WHERE namespace_ref = ? AND namespace_generation = ?)
        AS active_memory_records,
      (SELECT count(*) FROM revisions WHERE namespace_ref = ? AND namespace_generation = ?)
        AS retained_revision_records,
      (SELECT count(*) FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ?)
        AS tombstone_records,
      coalesce((SELECT namespace_wire_bytes FROM namespaces
        WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(proposal_wire_bytes) FROM proposals
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(revision_wire_bytes) FROM revisions
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(tombstone_wire_bytes) FROM tombstones
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(manifest_wire_bytes) FROM memory_v1_to_v2_manifests
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(evidence_wire_bytes) FROM consent_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(evidence_wire_bytes) FROM revision_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints
          WHERE namespace_ref = ? AND deleting_generation = ?), 0) +
        coalesce((SELECT sum(job_wire_bytes) FROM export_jobs
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(reservation_wire_bytes) FROM export_audit_reservations
          WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?)
        AS pending_outbox_records,
      coalesce((SELECT sum(logical_bytes) FROM outbox
        WHERE namespace_ref = ? AND namespace_generation = ?), 0) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_commands
        WHERE namespace_ref = ? AND namespace_generation = ?) AS lifecycle_command_records,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_command_logical_bytes
  `).get(...Array.from({ length: 20 }, () => [namespaceRef, generation]).flat());
    if (actual === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    assertActualNotGreater(actual, {
        pending_proposal_records: addExact(usage.namespace.pendingProposalRecords, mutationDelta.pendingProposalRecords),
        active_memory_records: addExact(usage.namespace.activeMemoryRecords, mutationDelta.activeMemoryRecords),
        retained_revision_records: addExact(usage.namespace.retainedRevisionRecords, mutationDelta.retainedRevisionRecords),
        tombstone_records: addExact(usage.namespace.tombstoneRecords, mutationDelta.tombstoneRecords),
        canonical_logical_bytes: addExact(usage.namespace.canonicalLogicalBytes, mutationDelta.canonicalLogicalBytes),
        pending_outbox_records: usage.namespace.pendingOutboxRecords,
        outbox_logical_bytes: usage.namespace.outboxLogicalBytes,
        lifecycle_command_records: usage.generationCommands.records,
        lifecycle_command_logical_bytes: usage.generationCommands.bytes
    });
    const payloadCoverage = database.prepare(`
    SELECT (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS payloads,
      (SELECT count(*) FROM revisions r JOIN revision_payloads p
        ON p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id AND p.revision = r.revision
        WHERE r.revision_wire_bytes = length(CAST(p.revision_wire AS BLOB))) AS valid_payloads
  `).get();
    if (payloadCoverage === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    const revisions = exactInteger(rowValue(payloadCoverage, 'revisions'));
    if (exactInteger(rowValue(payloadCoverage, 'payloads')) !== revisions ||
        exactInteger(rowValue(payloadCoverage, 'valid_payloads')) !== revisions) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const globalActual = database.prepare(`
    SELECT (SELECT count(*) FROM namespaces) AS namespace_records,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads) AS active_memory_records,
      (SELECT count(*) FROM revisions) AS retained_revision_records,
      (SELECT count(*) FROM tombstones) AS tombstone_records,
      (SELECT coalesce(sum(namespace_wire_bytes), 0) FROM namespaces) +
        (SELECT coalesce(sum(proposal_wire_bytes), 0) FROM proposals) +
        (SELECT coalesce(sum(revision_wire_bytes), 0) FROM revisions) +
        (SELECT coalesce(sum(tombstone_wire_bytes), 0) FROM tombstones) +
        (SELECT coalesce(sum(manifest_wire_bytes), 0) FROM memory_v1_to_v2_manifests) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM consent_evidence) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM revision_evidence) +
        (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits) +
        (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands) +
        (SELECT coalesce(sum(checkpoint_wire_bytes), 0) FROM namespace_deletion_checkpoints) +
        (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) +
        (SELECT coalesce(sum(reservation_wire_bytes), 0) FROM export_audit_reservations)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox) AS pending_outbox_records,
      (SELECT coalesce(sum(logical_bytes), 0) FROM outbox) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_commands) AS lifecycle_command_records,
      (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands)
        AS lifecycle_command_logical_bytes
  `).get();
    if (globalActual === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    assertActualNotGreater(globalActual, {
        namespace_records: addExact(usage.global.namespaceRecords, mutationDelta.namespaceRecords),
        pending_proposal_records: addExact(usage.global.pendingProposalRecords, mutationDelta.pendingProposalRecords),
        active_memory_records: addExact(usage.global.activeMemoryRecords, mutationDelta.activeMemoryRecords),
        retained_revision_records: addExact(usage.global.retainedRevisionRecords, mutationDelta.retainedRevisionRecords),
        tombstone_records: addExact(usage.global.tombstoneRecords, mutationDelta.tombstoneRecords),
        canonical_logical_bytes: addExact(usage.global.canonicalLogicalBytes, mutationDelta.canonicalLogicalBytes),
        pending_outbox_records: usage.global.pendingOutboxRecords,
        outbox_logical_bytes: usage.global.outboxLogicalBytes,
        lifecycle_command_records: usage.global.records,
        lifecycle_command_logical_bytes: usage.global.bytes
    });
    const namespaceCommands = database.prepare(`
    SELECT count(*) AS lifecycle_command_records,
      coalesce(sum(result_wire_bytes), 0) AS lifecycle_command_logical_bytes
    FROM lifecycle_commands WHERE namespace_ref = ?
  `).get(namespaceRef);
    if (namespaceCommands === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    assertActualNotGreater(namespaceCommands, {
        lifecycle_command_records: usage.namespaceCommands.records,
        lifecycle_command_logical_bytes: usage.namespaceCommands.bytes
    });
}
function addExact(left, right) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return result;
}
function addDelta(left, right) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || Object.is(result, -0)) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return result;
}
function projectedUsage(usage, delta) {
    const addCore = (value) => Object.freeze({
        pendingProposalRecords: addExact(value.pendingProposalRecords, delta.pendingProposalRecords),
        activeMemoryRecords: addExact(value.activeMemoryRecords, delta.activeMemoryRecords),
        retainedRevisionRecords: addExact(value.retainedRevisionRecords, delta.retainedRevisionRecords),
        tombstoneRecords: addExact(value.tombstoneRecords, delta.tombstoneRecords),
        canonicalLogicalBytes: addExact(value.canonicalLogicalBytes, delta.canonicalLogicalBytes),
        pendingOutboxRecords: addExact(value.pendingOutboxRecords, delta.pendingOutboxRecords),
        outboxLogicalBytes: addExact(value.outboxLogicalBytes, delta.outboxLogicalBytes)
    });
    return Object.freeze({
        namespace: addCore(usage.namespace),
        generationCommands: Object.freeze({
            records: addExact(usage.generationCommands.records, delta.commandRecords),
            bytes: addExact(usage.generationCommands.bytes, delta.commandBytes)
        }),
        namespaceCommands: Object.freeze({
            records: addExact(usage.namespaceCommands.records, delta.commandRecords),
            bytes: addExact(usage.namespaceCommands.bytes, delta.commandBytes)
        }),
        global: Object.freeze({
            namespaceRecords: addExact(usage.global.namespaceRecords, delta.namespaceRecords),
            ...addCore(usage.global),
            records: addExact(usage.global.records, delta.commandRecords),
            bytes: addExact(usage.global.bytes, delta.commandBytes)
        })
    });
}
function capacityFailure(usage, reserveEligible = false) {
    if (usage.global.namespaceRecords > MEMORY_RESOURCE_LIMITS.deploymentNamespaces)
        return 'namespaces';
    if (usage.namespace.pendingProposalRecords > PENDING_PROPOSAL_SOFT_RECORDS) {
        return 'pending_proposals';
    }
    if (usage.namespace.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
        usage.global.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords) {
        return 'active_records';
    }
    if (usage.namespace.retainedRevisionRecords >
        usage.namespace.activeMemoryRecords * MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
        return 'retained_revisions';
    }
    const namespaceCanonicalLimit = reserveEligible
        ? MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes
        : NAMESPACE_CANONICAL_SOFT_BYTES;
    const deploymentCanonicalLimit = reserveEligible
        ? MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes
        : DEPLOYMENT_CANONICAL_SOFT_BYTES;
    const outboxRecordLimit = reserveEligible
        ? MEMORY_RESOURCE_LIMITS.unackedOutboxRecords
        : OUTBOX_SOFT_RECORDS;
    const outboxByteLimit = reserveEligible
        ? MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes
        : OUTBOX_SOFT_BYTES;
    if (usage.namespace.canonicalLogicalBytes > namespaceCanonicalLimit ||
        usage.global.canonicalLogicalBytes > deploymentCanonicalLimit) {
        return 'canonical_bytes';
    }
    if (usage.global.pendingOutboxRecords > outboxRecordLimit)
        return 'outbox_records';
    if (usage.global.outboxLogicalBytes > outboxByteLimit)
        return 'outbox_bytes';
    if (usage.namespaceCommands.records >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace ||
        usage.namespaceCommands.bytes >
            MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace ||
        usage.global.records >
            MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerDeployment ||
        usage.global.bytes >
            MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerDeployment) {
        return 'command_ledger';
    }
    return null;
}
function storeUsage(database, namespaceRef, generation, usage, nowMs) {
    requireOneChange(database.prepare(`
    UPDATE usage SET pending_proposal_records = ?, active_memory_records = ?,
      retained_revision_records = ?, tombstone_records = ?, canonical_logical_bytes = ?,
      pending_outbox_records = ?, outbox_logical_bytes = ?,
      lifecycle_command_records = ?, lifecycle_command_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(usage.namespace.pendingProposalRecords, usage.namespace.activeMemoryRecords, usage.namespace.retainedRevisionRecords, usage.namespace.tombstoneRecords, usage.namespace.canonicalLogicalBytes, usage.namespace.pendingOutboxRecords, usage.namespace.outboxLogicalBytes, usage.generationCommands.records, usage.generationCommands.bytes, nowMs, namespaceRef, generation).changes);
    requireOneChange(database.prepare(`
    UPDATE lifecycle_namespace_usage SET lifecycle_command_records = ?,
      lifecycle_command_logical_bytes = ?, updated_at_ms = ? WHERE namespace_ref = ?
  `).run(usage.namespaceCommands.records, usage.namespaceCommands.bytes, nowMs, namespaceRef).changes);
    requireOneChange(database.prepare(`
    UPDATE global_usage SET namespace_records = ?, pending_proposal_records = ?,
      active_memory_records = ?, retained_revision_records = ?, tombstone_records = ?,
      canonical_logical_bytes = ?,
      pending_outbox_records = ?, outbox_logical_bytes = ?, lifecycle_command_records = ?,
      lifecycle_command_logical_bytes = ?, updated_at_ms = ? WHERE singleton = 1
  `).run(usage.global.namespaceRecords, usage.global.pendingProposalRecords, usage.global.activeMemoryRecords, usage.global.retainedRevisionRecords, usage.global.tombstoneRecords, usage.global.canonicalLogicalBytes, usage.global.pendingOutboxRecords, usage.global.outboxLogicalBytes, usage.global.records, usage.global.bytes, nowMs).changes);
}
function nextOutboxSequence(database, count) {
    const row = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`).get();
    const next = row === undefined ? 1 : addExact(exactInteger(rowValue(row, 'seq')), 1);
    if (!Number.isSafeInteger(next + count - 1))
        throw new CanonicalLifecycleMutationDataErrorV1();
    return next;
}
function prepareEvent(sequence, namespaceRef, generation, aggregate, aggregateId, revision, eventKind, occurredAt) {
    const eventId = `event:${domainHash(MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1, JSON.stringify({
        sequence,
        namespaceRef,
        namespaceGeneration: generation,
        aggregate,
        aggregateId,
        revision,
        eventKind
    }))}`;
    const event = createMemoryOutboxEventV1({
        eventId,
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
    return Object.freeze({ event, wire, bytes: Buffer.byteLength(wire, 'utf8') });
}
function insertEvent(database, prepared) {
    const event = prepared.event;
    requireOneChange(database.prepare(`
    INSERT INTO outbox(
      sequence, event_id, namespace_ref, namespace_generation, aggregate,
      aggregate_id, revision, event_kind, occurred_at_ms, available_at_ms,
      event_wire, logical_bytes, lease_owner_id, lease_token, leased_until_ms,
      attempt_count, last_reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL)
  `).run(event.sequence, event.eventId, event.namespaceRef, event.namespaceGeneration, event.aggregate, event.aggregateId, event.revision, event.eventKind, Date.parse(event.occurredAt), Date.parse(event.occurredAt), prepared.wire, prepared.bytes).changes);
}
function aggregateRefHash(ref) {
    return memoryLifecycleDomainHashV1(AGGREGATE_REF_HASH_DOMAIN_V1, ref);
}
function proposalResultHash(wire) {
    return memoryLifecycleDomainHashV1(PROPOSAL_RESULT_HASH_DOMAIN_V1, wire);
}
function mutationReceiptHash(commandHash, resultRef, resultRevision, resultHash) {
    return memoryLifecycleDomainHashV1(MUTATION_RECEIPT_HASH_DOMAIN_V1, JSON.stringify({
        commandHash,
        resultRef,
        resultRevision,
        resultHash
    }));
}
function storedResult(operation, commandHash, resultRef, resultRevision, resultHash, status = 'stored') {
    return stableResult(resultFor(operation, commandHash, {
        status,
        resultRef,
        resultRevision,
        resultHash,
        receiptHash: mutationReceiptHash(commandHash, resultRef, resultRevision, resultHash)
    }));
}
function existingLedgerResult(database, wire, commandHash, aggregateRef) {
    const row = database.prepare(`
    SELECT namespace_generation, command_hash, operation, aggregate_ref_hash,
      result_wire, result_wire_bytes, result_hash, committed_at_ms, expires_at_ms
    FROM lifecycle_commands WHERE namespace_ref = ? AND command_ref = ?
  `).get(wire.namespaceRef, wire.commandRef);
    if (row === undefined)
        return null;
    const resultWire = exactString(rowValue(row, 'result_wire'));
    const storedCommandHash = exactString(rowValue(row, 'command_hash'));
    const storedOperation = exactString(rowValue(row, 'operation'));
    const storedAggregateHash = exactString(rowValue(row, 'aggregate_ref_hash'));
    const committedAt = exactInteger(rowValue(row, 'committed_at_ms'));
    const expiresAt = positiveInteger(rowValue(row, 'expires_at_ms'));
    if (Buffer.byteLength(resultWire, 'utf8') !== positiveInteger(rowValue(row, 'result_wire_bytes')) ||
        memoryLifecycleStableResultHashV1(resultWire) !== exactString(rowValue(row, 'result_hash')) ||
        !HASH_PATTERN.test(storedCommandHash) || !HASH_PATTERN.test(storedAggregateHash) ||
        expiresAt - committedAt !== MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    let result;
    try {
        result = decodeMemoryLifecycleStableResultWireV1(resultWire);
    }
    catch {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    if (result.commandHash !== storedCommandHash || result.operation !== storedOperation) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    if (storedCommandHash !== commandHash || storedOperation !== wire.operation)
        return 'conflict';
    if (positiveInteger(rowValue(row, 'namespace_generation')) !== wire.expectedNamespaceGeneration ||
        storedAggregateHash !== aggregateRefHash(aggregateRef)) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    if ((result.status === 'stored' || result.status === 'unchanged') && 'resultRef' in result) {
        if (result.receiptHash !== mutationReceiptHash(commandHash, result.resultRef, result.resultRevision, result.resultHash))
            throw new CanonicalLifecycleMutationDataErrorV1();
    }
    return result;
}
function commitStableResult(database, wire, commandHash, aggregateRef, result, baseDelta, events, freshNow, reserveEligible = false) {
    const resultWire = encodeMemoryLifecycleStableResultWireV1(result);
    const resultBytes = Buffer.byteLength(resultWire, 'utf8');
    const usageBefore = loadUsage(database, wire.namespaceRef, wire.expectedNamespaceGeneration);
    validateUsageLowerBounds(database, wire.namespaceRef, wire.expectedNamespaceGeneration, usageBefore, baseDelta);
    const outboxBytes = events.reduce((total, event) => addExact(total, event.bytes), 0);
    const delta = Object.freeze({
        ...baseDelta,
        canonicalLogicalBytes: addDelta(baseDelta.canonicalLogicalBytes, resultBytes),
        pendingOutboxRecords: addDelta(baseDelta.pendingOutboxRecords, events.length),
        outboxLogicalBytes: addDelta(baseDelta.outboxLogicalBytes, outboxBytes),
        commandRecords: 1,
        commandBytes: resultBytes
    });
    const usage = projectedUsage(usageBefore, delta);
    const capacity = capacityFailure(usage, reserveEligible);
    if (capacity !== null)
        throw new LifecycleMutationCapacityErrorV1(capacity);
    for (const event of events)
        insertEvent(database, event);
    requireOneChange(database.prepare(`
    INSERT INTO lifecycle_commands(
      namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
      committed_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(wire.namespaceRef, wire.expectedNamespaceGeneration, wire.commandRef, commandHash, wire.operation, aggregateRefHash(aggregateRef), resultWire, resultBytes, memoryLifecycleStableResultHashV1(resultWire), Date.parse(freshNow), Date.parse(freshNow) + MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs).changes);
    storeUsage(database, wire.namespaceRef, wire.expectedNamespaceGeneration, usage, Date.parse(freshNow));
    return result;
}
const ZERO_DELTA = Object.freeze({
    namespaceRecords: 0,
    pendingProposalRecords: 0,
    activeMemoryRecords: 0,
    retainedRevisionRecords: 0,
    tombstoneRecords: 0,
    canonicalLogicalBytes: 0,
    pendingOutboxRecords: 0,
    outboxLogicalBytes: 0
});
function proposalEvent(database, proposal, occurredAt) {
    return prepareEvent(nextOutboxSequence(database, 1), proposal.namespaceRef, proposal.namespaceGeneration, 'proposal', proposal.proposalId, proposal.revision, 'proposal_changed', occurredAt);
}
function recordEvent(sequence, revision, occurredAt) {
    return prepareEvent(sequence, revision.record.namespaceRef, revision.record.namespaceGeneration, 'record', revision.memoryId, revision.revision, 'record_upserted', occurredAt);
}
function deletionRepositoryReceiptHash(commandHash, namespaceRef, generationBefore, generationAfter, memoryId, deletedRevision, committedAt) {
    return memoryLifecycleDomainHashV1(DELETION_REPOSITORY_RECEIPT_HASH_DOMAIN_V1, JSON.stringify({
        commandHash,
        namespaceRef,
        generationBefore,
        generationAfter,
        memoryId,
        deletedRevision,
        committedAt
    }));
}
function createDeletionReceiptAndTombstone(wire, commandHash, freshNow, memoryId, deletedRevision) {
    const namespaceDelete = wire.operation === 'namespace.delete';
    const generationAfter = namespaceDelete
        ? addExact(wire.expectedNamespaceGeneration, 1)
        : wire.expectedNamespaceGeneration;
    const common = {
        commandRefHash: memoryLifecycleCommandRefHashV1(wire.commandRef),
        operation: namespaceDelete ? 'delete_namespace' : 'forget',
        repositoryReceiptHash: deletionRepositoryReceiptHash(commandHash, wire.namespaceRef, wire.expectedNamespaceGeneration, generationAfter, memoryId, deletedRevision, freshNow),
        namespaceRef: wire.namespaceRef,
        generationBefore: wire.expectedNamespaceGeneration,
        generationAfter,
        deletingGeneration: wire.expectedNamespaceGeneration,
        memoryId,
        deletedRevision,
        committedAt: freshNow
    };
    const provisional = createDeletionMutationReceiptV1({
        ...common,
        tombstoneReceiptHash: '0'.repeat(64)
    });
    const tombstone = createMemoryTombstoneV1({
        tombstoneId: provisional.tombstoneId,
        namespaceRef: wire.namespaceRef,
        namespaceGeneration: generationAfter,
        memoryId,
        deletedRevision,
        deletionKind: namespaceDelete ? 'namespace_deleted' : 'memory_forgotten',
        deletedAt: freshNow,
        deletedByActorRef: wire.initiatedByActorRef,
        reasonCode: namespaceDelete
            ? 'memory_lifecycle_namespace_delete_v1'
            : 'memory_lifecycle_forget_v1',
        expiresAt: provisional.tombstoneExpiresAt
    });
    const receipt = createDeletionMutationReceiptV1({
        ...common,
        tombstoneReceiptHash: tombstone.receiptHash
    });
    if (receipt.deletionRef !== provisional.deletionRef ||
        receipt.tombstoneId !== provisional.tombstoneId ||
        receipt.tombstoneExpiresAt !== provisional.tombstoneExpiresAt) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const tombstoneWire = encodeMemoryTombstoneV1(tombstone);
    return Object.freeze({
        receipt,
        tombstone,
        tombstoneWire,
        tombstoneBytes: Buffer.byteLength(tombstoneWire, 'utf8')
    });
}
function insertDeletionTombstone(database, value) {
    const tombstone = value.tombstone;
    requireOneChange(database.prepare(`
    INSERT INTO tombstones(
      namespace_ref, namespace_generation, tombstone_id, memory_id,
      deleted_revision, deletion_kind, deleted_at_ms, expires_at_ms,
      receipt_hash, tombstone_wire, tombstone_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tombstone.namespaceRef, tombstone.namespaceGeneration, tombstone.tombstoneId, tombstone.memoryId, tombstone.deletedRevision, tombstone.deletionKind, Date.parse(tombstone.deletedAt), Date.parse(tombstone.expiresAt), tombstone.receiptHash, value.tombstoneWire, value.tombstoneBytes).changes);
}
function deletionResult(operation, commandHash, receipt, complete = false) {
    return stableResult(resultFor(operation, commandHash, {
        status: complete ? 'deletion_complete' : 'deletion_pending',
        receipt
    }));
}
function loadValidatedRecordCarriers(database, namespaceRef, generation, head, freshNow) {
    const memoryId = head.revision.memoryId;
    const revisionRows = database.prepare(`
    SELECT revision FROM revisions
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    if (revisionRows.length === 0 ||
        revisionRows.length > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions ||
        revisionRows.length !== head.revision.revision) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const revisions = revisionRows.map((row, index) => {
        const revisionNumber = positiveInteger(rowValue(row, 'revision'));
        if (revisionNumber !== index + 1)
            throw new CanonicalLifecycleMutationDataErrorV1();
        const loaded = loadRevision(database, namespaceRef, generation, memoryId, revisionNumber);
        if (loaded === null)
            throw new CanonicalLifecycleMutationDataErrorV1();
        return loaded;
    });
    let canonicalBytes = revisions.reduce((total, revision) => addExact(total, revision.bytes), 0);
    const revisionEvidenceRows = database.prepare(`
    SELECT evidence_id, revision, evidence_hash, evidence_wire, evidence_wire_bytes,
      changed_at_ms FROM revision_evidence
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC LIMIT 32
  `).all(namespaceRef, generation, memoryId);
    const expectedRevisionEvidence = revisions.filter(revision => revision.revision.evidence.kind === 'revision');
    if (revisionEvidenceRows.length !== expectedRevisionEvidence.length) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    revisionEvidenceRows.forEach((row, index) => {
        const loaded = canonicalWire(rowValue(row, 'evidence_wire'), rowValue(row, 'evidence_wire_bytes'), decodeMemoryRevisionEvidenceV1);
        const revision = expectedRevisionEvidence[index]?.revision;
        if (revision === undefined || loaded.value.evidenceId !== exactString(rowValue(row, 'evidence_id')) ||
            loaded.value.evidenceHash !== exactString(rowValue(row, 'evidence_hash')) ||
            loaded.value.revision !== positiveInteger(rowValue(row, 'revision')) ||
            loaded.value.changedAt !== new Date(exactInteger(rowValue(row, 'changed_at_ms'))).toISOString() ||
            revision.evidence.evidenceId !== loaded.value.evidenceId ||
            revision.evidence.evidenceHash !== loaded.value.evidenceHash) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
        canonicalBytes = addExact(canonicalBytes, loaded.bytes);
    });
    const proposalRows = database.prepare(`
    SELECT proposal_id FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
    ORDER BY proposal_id ASC LIMIT 33
  `).all(namespaceRef, generation, memoryId);
    if (proposalRows.length > 32) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const proposalIds = [];
    for (const row of proposalRows) {
        const proposalId = exactString(rowValue(row, 'proposal_id'));
        const proposal = loadProposal(database, namespaceRef, generation, proposalId);
        if (proposal === null || proposal.proposal.state !== 'approved' ||
            proposal.proposal.decision?.resultingMemoryId !== memoryId) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
        proposalIds.push(proposalId);
        canonicalBytes = addExact(canonicalBytes, proposal.bytes);
        const evidenceRows = database.prepare(`
      SELECT evidence_id, evidence_hash, evidence_wire, evidence_wire_bytes, created_at_ms
      FROM consent_evidence WHERE namespace_ref = ? AND namespace_generation = ?
        AND proposal_id = ? ORDER BY evidence_id ASC LIMIT 2
    `).all(namespaceRef, generation, proposalId);
        if (evidenceRows.length !== 1)
            throw new CanonicalLifecycleMutationDataErrorV1();
        const evidence = canonicalWire(rowValue(evidenceRows[0], 'evidence_wire'), rowValue(evidenceRows[0], 'evidence_wire_bytes'), decodeMemoryConsentEvidenceV1);
        if (evidence.value.evidenceId !== exactString(rowValue(evidenceRows[0], 'evidence_id')) ||
            evidence.value.evidenceHash !== exactString(rowValue(evidenceRows[0], 'evidence_hash')) ||
            evidence.value.proposalId !== proposalId ||
            Date.parse(evidence.value.approvedAt) !==
                exactInteger(rowValue(evidenceRows[0], 'created_at_ms')) ||
            proposal.proposal.decision?.consentEvidenceId !== evidence.value.evidenceId ||
            proposal.proposal.decision?.consentEvidenceHash !== evidence.value.evidenceHash) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
        canonicalBytes = addExact(canonicalBytes, evidence.bytes);
    }
    const manifestRows = database.prepare(`
    SELECT manifest_id, aggregate_kind, aggregate_id, manifest_hash,
      manifest_wire, manifest_wire_bytes, applied_at_ms
    FROM memory_v1_to_v2_manifests
    WHERE namespace_ref = ? AND namespace_generation = ? AND (
      (aggregate_kind = 'memory' AND aggregate_id = ?) OR
      (aggregate_kind = 'proposal' AND aggregate_id IN (
        SELECT proposal_id FROM proposals WHERE namespace_ref = ?
          AND namespace_generation = ? AND resulting_memory_id = ?
      ))
    ) ORDER BY aggregate_kind ASC, aggregate_id ASC LIMIT 34
  `).all(namespaceRef, generation, memoryId, namespaceRef, generation, memoryId);
    if (manifestRows.length > proposalIds.length + 1) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const manifestIds = manifestRows.map(row => {
        const loaded = canonicalWire(rowValue(row, 'manifest_wire'), rowValue(row, 'manifest_wire_bytes'), decodeMemoryV1ToV2AggregateManifestV1);
        const manifest = loaded.value;
        const aggregateKind = exactString(rowValue(row, 'aggregate_kind'));
        const aggregateId = exactString(rowValue(row, 'aggregate_id'));
        const appliedAtMs = exactInteger(rowValue(row, 'applied_at_ms'));
        if (manifest.manifestId !== exactString(rowValue(row, 'manifest_id')) ||
            manifest.manifestHash !== exactString(rowValue(row, 'manifest_hash')) ||
            manifest.namespaceRef !== namespaceRef || manifest.namespaceGeneration !== generation ||
            manifest.aggregate.kind !== aggregateKind ||
            manifest.aggregate.aggregateId !== aggregateId ||
            appliedAtMs < 0 || appliedAtMs > Date.parse(freshNow) ||
            (aggregateKind === 'memory'
                ? aggregateId !== memoryId
                : aggregateKind !== 'proposal' || !proposalIds.includes(aggregateId))) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
        canonicalBytes = addExact(canonicalBytes, loaded.bytes);
        return manifest.manifestId;
    });
    const outboxRows = database.prepare(`
    SELECT sequence, event_id, aggregate, aggregate_id, revision, event_kind,
      occurred_at_ms, event_wire, logical_bytes
    FROM outbox WHERE namespace_ref = ? AND namespace_generation = ? AND (
      (aggregate = 'record' AND aggregate_id = ?) OR
      (aggregate = 'proposal' AND aggregate_id IN (
        SELECT proposal_id FROM proposals WHERE namespace_ref = ?
          AND namespace_generation = ? AND resulting_memory_id = ?
      ))
    ) ORDER BY sequence ASC LIMIT 129
  `).all(namespaceRef, generation, memoryId, namespaceRef, generation, memoryId);
    if (outboxRows.length > 128)
        throw new CanonicalLifecycleMutationDataErrorV1();
    let outboxBytes = 0;
    for (const row of outboxRows) {
        const loaded = canonicalWire(rowValue(row, 'event_wire'), rowValue(row, 'logical_bytes'), decodeMemoryOutboxEventV1);
        const event = loaded.value;
        if (event.sequence !== positiveInteger(rowValue(row, 'sequence')) ||
            event.eventId !== exactString(rowValue(row, 'event_id')) ||
            event.namespaceRef !== namespaceRef || event.namespaceGeneration !== generation ||
            event.aggregate !== exactString(rowValue(row, 'aggregate')) ||
            event.aggregateId !== exactString(rowValue(row, 'aggregate_id')) ||
            event.revision !== positiveInteger(rowValue(row, 'revision')) ||
            event.eventKind !== exactString(rowValue(row, 'event_kind')) ||
            Date.parse(event.occurredAt) !== exactInteger(rowValue(row, 'occurred_at_ms'))) {
            throw new CanonicalLifecycleMutationDataErrorV1();
        }
        outboxBytes = addExact(outboxBytes, loaded.bytes);
    }
    return Object.freeze({
        proposalIds: Object.freeze(proposalIds),
        manifestIds: Object.freeze(manifestIds),
        revisionCount: revisions.length,
        canonicalBytes,
        outboxRecords: outboxRows.length,
        outboxBytes
    });
}
export function deleteValidatedSqliteRecordCarriersV1(database, namespaceRef, generation, memoryId, carriers) {
    const consentDeleted = database.prepare(`
    DELETE FROM consent_evidence WHERE namespace_ref = ? AND namespace_generation = ?
      AND proposal_id IN (
        SELECT proposal_id FROM proposals WHERE namespace_ref = ?
          AND namespace_generation = ? AND resulting_memory_id = ?
      )
  `).run(namespaceRef, generation, namespaceRef, generation, memoryId);
    if (Number(consentDeleted.changes) !== carriers.proposalIds.length) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const proposalsDeleted = database.prepare(`
    DELETE FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
      AND resulting_memory_id = ?
  `).run(namespaceRef, generation, memoryId);
    if (Number(proposalsDeleted.changes) !== carriers.proposalIds.length) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    database.prepare(`
    DELETE FROM revision_evidence WHERE namespace_ref = ? AND namespace_generation = ?
      AND memory_id = ?
  `).run(namespaceRef, generation, memoryId);
    const manifestsDeleted = database.prepare(`
    DELETE FROM memory_v1_to_v2_manifests
    WHERE namespace_ref = ? AND namespace_generation = ? AND (
      (aggregate_kind = 'memory' AND aggregate_id = ?) OR
      (aggregate_kind = 'proposal' AND aggregate_id IN (
        ${carriers.proposalIds.length === 0
        ? "SELECT '' WHERE 0"
        : carriers.proposalIds.map(() => '?').join(',')}
      ))
    )
  `).run(namespaceRef, generation, memoryId, ...carriers.proposalIds);
    if (Number(manifestsDeleted.changes) !== carriers.manifestIds.length) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const revisionsDeleted = database.prepare(`
    DELETE FROM revisions WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).run(namespaceRef, generation, memoryId);
    if (Number(revisionsDeleted.changes) !== carriers.revisionCount) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const outboxDeleted = carriers.proposalIds.length === 0
        ? database.prepare(`
        DELETE FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
          AND aggregate = 'record' AND aggregate_id = ?
      `).run(namespaceRef, generation, memoryId)
        : database.prepare(`
        DELETE FROM outbox WHERE namespace_ref = ? AND namespace_generation = ? AND (
          (aggregate = 'record' AND aggregate_id = ?) OR
          (aggregate = 'proposal' AND aggregate_id IN (
            ${carriers.proposalIds.map(() => '?').join(',')}
          ))
        )
      `).run(namespaceRef, generation, memoryId, ...carriers.proposalIds);
    if (Number(outboxDeleted.changes) !== carriers.outboxRecords) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const residual = database.prepare(`
    SELECT 'proposal' AS carrier FROM proposals
      WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
    UNION ALL
    SELECT 'head' AS carrier FROM heads
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    UNION ALL
    SELECT 'revision' AS carrier FROM revisions
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    UNION ALL
    SELECT 'revision_payload' AS carrier FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    UNION ALL
    SELECT 'revision' AS carrier FROM revision_evidence
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    UNION ALL
    SELECT CASE aggregate_kind WHEN 'proposal' THEN 'proposal' ELSE 'revision' END AS carrier
      FROM memory_v1_to_v2_manifests
      WHERE namespace_ref = ? AND namespace_generation = ? AND (
        (aggregate_kind = 'memory' AND aggregate_id = ?) OR
        (aggregate_kind = 'proposal' AND aggregate_id IN (
          ${carriers.proposalIds.length === 0
        ? "SELECT '' WHERE 0"
        : carriers.proposalIds.map(() => '?').join(',')}
        ))
      )
    UNION ALL
    SELECT 'content_outbox' AS carrier FROM outbox
      WHERE namespace_ref = ? AND namespace_generation = ? AND (
        (aggregate = 'record' AND aggregate_id = ?) OR
        (aggregate = 'proposal' AND aggregate_id IN (
          SELECT proposal_id FROM proposals WHERE namespace_ref = ?
            AND namespace_generation = ? AND resulting_memory_id = ?
        ))
      )
    LIMIT 1
  `).get(namespaceRef, generation, memoryId, namespaceRef, generation, memoryId, namespaceRef, generation, memoryId, namespaceRef, generation, memoryId, namespaceRef, generation, memoryId, namespaceRef, generation, memoryId, ...carriers.proposalIds, namespaceRef, generation, memoryId, namespaceRef, generation, memoryId);
    if (residual !== undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
}
export function loadValidatedSqliteRecordCarriersV1(database, namespaceRef, generation, memoryId, freshNow) {
    const head = loadHeadRevision(database, namespaceRef, generation, memoryId);
    if (head === null)
        return null;
    return Object.freeze({
        revision: head.revision,
        carriers: loadValidatedRecordCarriers(database, namespaceRef, generation, head, parseMemoryLifecycleInstantV1(freshNow))
    });
}
function insertRevision(database, revision) {
    const revisionWire = encodeMemoryRevisionV2(revision);
    const revisionBytes = Buffer.byteLength(revisionWire, 'utf8');
    requireOneChange(database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(revision.record.namespaceRef, revision.record.namespaceGeneration, revision.memoryId, revision.revision, revision.operation, revision.revisionHash, revision.previousRevisionHash, Date.parse(revision.changedAt), revisionBytes).changes);
    requireOneChange(database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, ?, ?, ?, ?)
  `).run(revision.record.namespaceRef, revision.record.namespaceGeneration, revision.memoryId, revision.revision, revisionWire).changes);
    return revisionBytes;
}
function insertRevisionEvidence(database, material) {
    const evidence = material.evidence;
    const wire = encodeMemoryRevisionEvidenceV1(evidence);
    const bytes = Buffer.byteLength(wire, 'utf8');
    requireOneChange(database.prepare(`
    INSERT INTO revision_evidence(
      namespace_ref, namespace_generation, evidence_id, memory_id, revision,
      evidence_hash, evidence_wire, evidence_wire_bytes, changed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(evidence.namespaceRef, evidence.namespaceGeneration, evidence.evidenceId, evidence.memoryId, evidence.revision, evidence.evidenceHash, wire, bytes, Date.parse(evidence.changedAt)).changes);
    return bytes;
}
function updateHead(database, revision) {
    requireOneChange(database.prepare(`
    UPDATE heads SET current_revision = ?, current_revision_hash = ?, content_hash = ?,
      cursor_ref = ?, updated_at_ms = ?, valid_until_ms = ?, purge_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).run(revision.revision, revision.revisionHash, revision.record.contentHash, cursorRefForRevision(revision), Date.parse(revision.record.updatedAt), Date.parse(revision.record.retention.validUntil), Date.parse(revision.record.retention.purgeAt), revision.record.namespaceRef, revision.record.namespaceGeneration, revision.memoryId).changes);
}
function insertConsentEvidence(database, evidence) {
    const wire = encodeMemoryConsentEvidenceV1(evidence);
    const bytes = Buffer.byteLength(wire, 'utf8');
    requireOneChange(database.prepare(`
    INSERT INTO consent_evidence(
      namespace_ref, namespace_generation, evidence_id, proposal_id,
      evidence_hash, evidence_wire, evidence_wire_bytes, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(evidence.namespaceRef, evidence.namespaceGeneration, evidence.evidenceId, evidence.proposalId, evidence.evidenceHash, wire, bytes, Date.parse(evidence.approvedAt)).changes);
    return bytes;
}
function updateProposal(database, before, after) {
    const wire = encodeMemoryProposalV2(after);
    const bytes = Buffer.byteLength(wire, 'utf8');
    requireOneChange(database.prepare(`
    UPDATE proposals SET revision = ?, state = ?, decided_at_ms = ?,
      resulting_memory_id = ?, resulting_revision = ?, resulting_revision_hash = ?,
      proposal_wire = ?, proposal_wire_bytes = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
      AND revision = 1 AND state = 'pending'
  `).run(after.revision, after.state, after.decision === null ? null : Date.parse(after.decision.decidedAt), after.decision?.resultingMemoryId ?? null, after.decision?.resultingMemoryRevision ?? null, after.decision?.resultingRevisionHash ?? null, wire, bytes, after.namespaceRef, after.namespaceGeneration, after.proposalId).changes);
    return bytes - before.bytes;
}
function executeProposalCreate(database, envelope, wire, commandHash, freshNow) {
    const proposal = envelope.command.material;
    const namespaceRef = proposal.namespaceRef;
    const aggregateRef = proposal.proposalId;
    const existingNamespace = loadNamespace(database, namespaceRef);
    if (existingNamespace !== null && existingNamespace.generation !== wire.expectedNamespaceGeneration) {
        return denial('proposal.create', commandHash, 'authority');
    }
    if (!actorAllows(envelope, wire, proposal.intent.kind === 'correction' ? 'propose_correction' : 'propose_create', 'none', 'none', proposal.initiatedByActorRef, freshNow) || !groupAdmissionAllows(proposal.namespace, proposal)) {
        return denial('proposal.create', commandHash, 'authority');
    }
    if (Date.parse(wire.occurredAt) > Date.parse(freshNow) ||
        projectMemoryProposalLifecycleV2(proposal, freshNow).logicalState === 'expired_due') {
        return denial('proposal.create', commandHash, 'authority');
    }
    if (existingNamespace !== null && (memoryNamespaceWireV1(existingNamespace.namespace) !== memoryNamespaceWireV1(proposal.namespace)))
        throw new CanonicalLifecycleMutationDataErrorV1();
    const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
    if (replay === 'conflict') {
        return resultFor('proposal.create', commandHash, { status: 'conflict', category: 'idempotency' });
    }
    if (replay !== null)
        return replay;
    if (proposal.intent.kind === 'correction') {
        const head = loadHeadRevision(database, namespaceRef, wire.expectedNamespaceGeneration, proposal.intent.targetMemoryId);
        if (head === null) {
            if (existingNamespace === null)
                return denial('proposal.create', commandHash, 'authority');
            const result = resultFor('proposal.create', commandHash, {
                status: 'conflict', category: 'revision'
            });
            return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
        }
        if (head.revision.revision !== proposal.intent.targetRevision ||
            head.revision.revisionHash !== proposal.intent.targetRevisionHash) {
            const result = resultFor('proposal.create', commandHash, {
                status: 'conflict', category: 'revision'
            });
            return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
        }
    }
    if (existingNamespace === null) {
        if (wire.expectedNamespaceGeneration !== 1) {
            return denial('proposal.create', commandHash, 'authority');
        }
        insertNamespace(database, proposal.namespace, 1, Date.parse(freshNow));
    }
    const existing = loadProposal(database, namespaceRef, wire.expectedNamespaceGeneration, proposal.proposalId);
    const proposalWire = encodeMemoryProposalV2(proposal);
    const proposalBytes = Buffer.byteLength(proposalWire, 'utf8');
    if (existing !== null) {
        if (existing.wire !== proposalWire) {
            return resultFor('proposal.create', commandHash, { status: 'conflict', category: 'idempotency' });
        }
        const unchanged = storedResult('proposal.create', commandHash, proposal.proposalId, 1, proposalResultHash(proposalWire), 'unchanged');
        return commitStableResult(database, wire, commandHash, aggregateRef, unchanged, ZERO_DELTA, [], freshNow);
    }
    requireOneChange(database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, ?, ?, 1, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId, Date.parse(proposal.proposedAt), proposalWire, proposalBytes).changes);
    const event = proposalEvent(database, proposal, wire.occurredAt);
    const result = storedResult('proposal.create', commandHash, proposal.proposalId, 1, proposalResultHash(proposalWire));
    const committed = commitStableResult(database, wire, commandHash, aggregateRef, result, {
        ...ZERO_DELTA,
        pendingProposalRecords: 1,
        canonicalLogicalBytes: proposalBytes
    }, [event], freshNow, true);
    requireOneChange(database.prepare(`
    UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(Date.parse(freshNow), namespaceRef, wire.expectedNamespaceGeneration).changes);
    return committed;
}
function proposalDecisionAfterImage(operation, wire, proposal, freshNow) {
    return buildMemoryProposalDecisionV2({
        commandRef: wire.commandRef,
        operation,
        namespaceRef: wire.namespaceRef,
        namespaceGeneration: wire.expectedNamespaceGeneration,
        proposal,
        decidedByActorRef: wire.initiatedByActorRef,
        freshNow,
        reason: null
    });
}
function proposalDecisionAuthorityAllows(envelope, wire, operation, namespace, proposal, freshNow) {
    if (Date.parse(wire.occurredAt) > Date.parse(freshNow))
        return false;
    if (operation === 'proposal.expire')
        return maintenanceAllowsExpire(envelope, wire, freshNow);
    if (operation === 'proposal.approve') {
        const evidence = envelope.command.material;
        if (evidence.approvedAt !== wire.occurredAt || proposal === null ||
            !groupAdmissionAllows(namespace, proposal))
            return false;
        if (evidence.evidenceKind === 'explicit') {
            return actorAllows(envelope, wire, 'approve', canonicalRequirement(namespace, proposal), canonicalRequirement(namespace, proposal), proposal.initiatedByActorRef, freshNow);
        }
        return policyAllows(envelope, wire, proposal, evidence, freshNow);
    }
    if (operation === 'proposal.withdraw' && proposal === null)
        return false;
    return actorAllows(envelope, wire, operation === 'proposal.reject' ? 'reject' : 'withdraw_own_proposal', proposal === null ? 'none' : canonicalRequirement(namespace, proposal), 'none', proposal?.initiatedByActorRef ?? null, freshNow);
}
function executeProposalDecision(database, envelope, wire, commandHash, freshNow) {
    const operation = wire.operation;
    const aggregateRef = wire.aggregateRef;
    const namespace = loadNamespace(database, wire.namespaceRef);
    if (namespace === null || namespace.generation !== wire.expectedNamespaceGeneration) {
        return denial(operation, commandHash, 'authority');
    }
    const loaded = loadProposal(database, wire.namespaceRef, wire.expectedNamespaceGeneration, aggregateRef);
    if (!proposalDecisionAuthorityAllows(envelope, wire, operation, namespace.namespace, loaded?.proposal ?? null, freshNow))
        return denial(operation, commandHash, 'authority');
    const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
    if (replay === 'conflict') {
        return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
    }
    if (replay !== null)
        return replay;
    if (loaded === null) {
        const result = resultFor(operation, commandHash, { status: 'not_found' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const proposal = loaded.proposal;
    if (proposal.state !== 'pending') {
        const result = resultFor(operation, commandHash, { status: 'already_decided' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    if (wire.expectedRevision !== proposal.revision ||
        wire.expectedAggregateHash !== proposal.consentTargetHash) {
        const result = resultFor(operation, commandHash, { status: 'conflict', category: 'revision' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const lifecycle = projectMemoryProposalLifecycleV2(proposal, freshNow);
    if (operation === 'proposal.approve' && !lifecycle.approveEligible) {
        const result = resultFor(operation, commandHash, { status: 'proposal_expired' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    if (operation === 'proposal.expire' && lifecycle.approveEligible) {
        return denial(operation, commandHash, 'authority');
    }
    if (operation === 'proposal.approve') {
        const evidence = envelope.command.material;
        const correctionIntent = proposal.intent.kind === 'correction' ? proposal.intent : null;
        const head = correctionIntent !== null
            ? loadHeadRevision(database, wire.namespaceRef, wire.expectedNamespaceGeneration, correctionIntent.targetMemoryId)
            : null;
        if (correctionIntent !== null && head === null) {
            const result = resultFor(operation, commandHash, { status: 'not_found' });
            return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
        }
        if (head !== null && (head.revision.revision !== correctionIntent?.targetRevision ||
            head.revision.revisionHash !== correctionIntent.targetRevisionHash)) {
            const result = resultFor(operation, commandHash, { status: 'conflict', category: 'revision' });
            return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
        }
        if (head !== null && head.revision.revision >= MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
            throw new LifecycleMutationCapacityErrorV1('retained_revisions');
        }
        const bundle = head === null
            ? buildMemoryProposalApprovalBundleV1({
                commandRef: wire.commandRef,
                operation,
                namespaceRef: wire.namespaceRef,
                namespaceGeneration: wire.expectedNamespaceGeneration,
                proposal,
                approvedByActorRef: evidence.approvedByActorRef,
                freshNow: evidence.approvedAt,
                evidenceSource: evidence.source,
                reason: null
            })
            : buildMemoryCorrectionProposalApprovalBundleV1({
                commandRef: wire.commandRef,
                operation,
                namespaceRef: wire.namespaceRef,
                namespaceGeneration: wire.expectedNamespaceGeneration,
                proposal,
                beforeRevision: head.revision,
                approvedByActorRef: evidence.approvedByActorRef,
                freshNow: evidence.approvedAt,
                evidenceSource: evidence.source,
                reason: null
            });
        if (encodeMemoryConsentEvidenceV1(bundle.consentEvidence) !==
            encodeMemoryConsentEvidenceV1(evidence))
            throw new CanonicalLifecycleMutationDataErrorV1();
        const proposalDelta = updateProposal(database, loaded, bundle.proposal);
        const consentBytes = insertConsentEvidence(database, bundle.consentEvidence);
        let revisionEvidenceBytes = 0;
        if ('revisionEvidence' in bundle) {
            revisionEvidenceBytes = insertRevisionEvidence(database, {
                schemaVersion: 1,
                kind: 'revision_change_v1',
                evidence: bundle.revisionEvidence,
                revision: bundle.revision
            });
        }
        const revisionBytes = insertRevision(database, bundle.revision);
        if (head === null) {
            requireOneChange(database.prepare(`
        INSERT INTO heads(
          namespace_ref, namespace_generation, memory_id, current_revision,
          current_revision_hash, content_hash, cursor_ref, updated_at_ms,
          valid_until_ms, purge_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(bundle.record.namespaceRef, bundle.record.namespaceGeneration, bundle.record.memoryId, bundle.record.revision, bundle.revision.revisionHash, bundle.record.contentHash, cursorRefForRevision(bundle.revision), Date.parse(bundle.record.updatedAt), Date.parse(bundle.record.retention.validUntil), Date.parse(bundle.record.retention.purgeAt)).changes);
        }
        else {
            updateHead(database, bundle.revision);
        }
        const firstSequence = nextOutboxSequence(database, 2);
        const events = [
            prepareEvent(firstSequence, wire.namespaceRef, wire.expectedNamespaceGeneration, 'proposal', bundle.proposal.proposalId, bundle.proposal.revision, 'proposal_changed', wire.occurredAt),
            recordEvent(firstSequence + 1, bundle.revision, wire.occurredAt)
        ];
        const result = storedResult(operation, commandHash, bundle.proposal.proposalId, bundle.proposal.revision, proposalResultHash(encodeMemoryProposalV2(bundle.proposal)));
        const committed = commitStableResult(database, wire, commandHash, aggregateRef, result, {
            ...ZERO_DELTA,
            pendingProposalRecords: -1,
            activeMemoryRecords: head === null ? 1 : 0,
            retainedRevisionRecords: 1,
            canonicalLogicalBytes: proposalDelta + consentBytes + revisionEvidenceBytes + revisionBytes
        }, events, freshNow);
        requireOneChange(database.prepare(`
      UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
      WHERE namespace_ref = ? AND namespace_generation = ?
    `).run(Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
        return committed;
    }
    const after = proposalDecisionAfterImage(operation, wire, proposal, freshNow);
    const proposalDelta = updateProposal(database, loaded, after);
    const event = proposalEvent(database, after, wire.occurredAt);
    const afterWire = encodeMemoryProposalV2(after);
    const result = storedResult(operation, commandHash, after.proposalId, after.revision, proposalResultHash(afterWire));
    const committed = commitStableResult(database, wire, commandHash, aggregateRef, result, {
        ...ZERO_DELTA,
        pendingProposalRecords: -1,
        canonicalLogicalBytes: proposalDelta
    }, [event], freshNow);
    requireOneChange(database.prepare(`
    UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
    return committed;
}
function executeRecordMutation(database, envelope, wire, commandHash, freshNow) {
    const operation = wire.operation;
    const aggregateRef = wire.aggregateRef;
    const action = operation === 'record.correct' ? 'correct' :
        operation === 'record.renew' ? 'renew' : 'change_conflict';
    const namespace = loadNamespace(database, wire.namespaceRef);
    if (namespace === null || namespace.generation !== wire.expectedNamespaceGeneration) {
        return denial(operation, commandHash, 'authority');
    }
    const head = loadHeadRevision(database, wire.namespaceRef, wire.expectedNamespaceGeneration, aggregateRef);
    if (head === null) {
        if (Date.parse(wire.occurredAt) > Date.parse(freshNow) || !actorAllows(envelope, wire, action, 'none', 'none', null, freshNow))
            return denial(operation, commandHash, 'authority');
        const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
        if (replay === 'conflict') {
            return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
        }
        if (replay !== null)
            return replay;
        const result = resultFor(operation, commandHash, { status: 'not_found' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const before = loadRevision(database, wire.namespaceRef, wire.expectedNamespaceGeneration, aggregateRef, wire.expectedRevision);
    if (before === null) {
        if (Date.parse(wire.occurredAt) > Date.parse(freshNow) || !actorAllows(envelope, wire, action, canonicalRequirement(namespace.namespace, head.revision.record), 'none', null, freshNow))
            return denial(operation, commandHash, 'authority');
        const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
        if (replay === 'conflict') {
            return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
        }
        if (replay !== null)
            return replay;
        const result = resultFor(operation, commandHash, { status: 'conflict', category: 'revision' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const material = envelope.command.material;
    const bundle = assertMemoryRevisionChangeBundleV1(before.revision, operation, material);
    if (bundle.revision.changedAt !== wire.occurredAt ||
        Date.parse(wire.occurredAt) > Date.parse(freshNow) ||
        !groupAdmissionAllows(namespace.namespace, bundle.revision.record) || !actorAllows(envelope, wire, action, canonicalRequirement(namespace.namespace, before.revision.record), canonicalRequirement(namespace.namespace, bundle.revision.record), null, freshNow))
        return denial(operation, commandHash, 'authority');
    const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
    if (replay === 'conflict') {
        return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
    }
    if (replay !== null)
        return replay;
    if (head.revision.revision !== wire.expectedRevision ||
        head.revision.revisionHash !== wire.expectedAggregateHash) {
        const result = resultFor(operation, commandHash, { status: 'conflict', category: 'revision' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const lifecycle = projectMemoryRecordLifecycleV2(head.revision.record, freshNow);
    if (lifecycle.state === 'purge_due') {
        const result = resultFor(operation, commandHash, { status: 'record_purge_due' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    if (operation !== 'record.renew' && lifecycle.state === 'expired') {
        const result = resultFor(operation, commandHash, { status: 'record_expired' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    if (head.revision.revision >= MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
        const result = resultFor(operation, commandHash, { status: 'history_limit' });
        return commitStableResult(database, wire, commandHash, aggregateRef, stableResult(result), ZERO_DELTA, [], freshNow);
    }
    const evidenceBytes = insertRevisionEvidence(database, bundle);
    const revisionBytes = insertRevision(database, bundle.revision);
    updateHead(database, bundle.revision);
    const event = recordEvent(nextOutboxSequence(database, 1), bundle.revision, wire.occurredAt);
    const result = storedResult(operation, commandHash, bundle.revision.memoryId, bundle.revision.revision, bundle.revision.revisionHash);
    const committed = commitStableResult(database, wire, commandHash, aggregateRef, result, {
        ...ZERO_DELTA,
        retainedRevisionRecords: 1,
        canonicalLogicalBytes: evidenceBytes + revisionBytes
    }, [event], freshNow);
    requireOneChange(database.prepare(`
    UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
    return committed;
}
function deletionActorAllows(envelope, wire, requirement, freshNow) {
    if (envelope.authority.kind !== 'actor' || Date.parse(wire.occurredAt) > Date.parse(freshNow)) {
        return false;
    }
    const role = memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability);
    if (wire.operation === 'record.forget') {
        const exact = wire.expectedRevision !== null && wire.expectedAggregateHash !== null;
        if (role === 'personal_bot_master' ? exact : !exact)
            return false;
        return decideMemoryLifecycleActorPolicyV1(envelope.authority.capability, {
            botInstanceId: envelope.access.botInstanceId,
            accountId: envelope.access.accountId,
            sceneRef: envelope.access.sceneRef,
            namespaceRef: wire.namespaceRef,
            generation: wire.expectedNamespaceGeneration,
            actorRef: wire.initiatedByActorRef,
            action: 'forget',
            beforeRequirement: requirement,
            afterRequirement: 'none',
            initiatedByActorRef: null,
            targetMode: role === 'personal_bot_master'
                ? 'opaque_delete_only'
                : 'expected_revision',
            expectedRevision: role === 'personal_bot_master' ? null : wire.expectedRevision
        }, freshNow).allowed;
    }
    return actorAllows(envelope, wire, 'delete_namespace', 'elevated', 'none', null, freshNow);
}
function executeRecordForget(database, envelope, wire, commandHash, freshNow) {
    const operation = 'record.forget';
    const memoryId = wire.aggregateRef;
    const namespace = loadNamespace(database, wire.namespaceRef);
    if (namespace === null || namespace.generation !== wire.expectedNamespaceGeneration) {
        return denial(operation, commandHash, 'authority');
    }
    const head = loadHeadRevision(database, wire.namespaceRef, wire.expectedNamespaceGeneration, memoryId);
    if (!deletionActorAllows(envelope, wire, head === null ? 'ordinary' : canonicalRequirement(namespace.namespace, head.revision.record), freshNow))
        return denial(operation, commandHash, 'authority');
    const replay = existingLedgerResult(database, wire, commandHash, memoryId);
    if (replay === 'conflict') {
        return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
    }
    if (replay !== null)
        return replay;
    if (head === null) {
        return commitStableResult(database, wire, commandHash, memoryId, stableResult(resultFor(operation, commandHash, { status: 'not_found' })), ZERO_DELTA, [], freshNow);
    }
    if ((wire.expectedRevision !== null && wire.expectedRevision !== head.revision.revision) ||
        (wire.expectedAggregateHash !== null &&
            wire.expectedAggregateHash !== head.revision.revisionHash)) {
        return commitStableResult(database, wire, commandHash, memoryId, stableResult(resultFor(operation, commandHash, {
            status: 'conflict', category: 'revision'
        })), ZERO_DELTA, [], freshNow);
    }
    const carriers = loadValidatedRecordCarriers(database, wire.namespaceRef, wire.expectedNamespaceGeneration, head, freshNow);
    const deletion = createDeletionReceiptAndTombstone(wire, commandHash, freshNow, memoryId, head.revision.revision);
    deleteValidatedSqliteRecordCarriersV1(database, wire.namespaceRef, wire.expectedNamespaceGeneration, memoryId, carriers);
    insertDeletionTombstone(database, deletion);
    const event = prepareEvent(nextOutboxSequence(database, 1), wire.namespaceRef, wire.expectedNamespaceGeneration, 'record', memoryId, head.revision.revision, 'record_forgotten', wire.occurredAt);
    const committed = commitStableResult(database, wire, commandHash, memoryId, deletionResult(operation, commandHash, deletion.receipt), {
        ...ZERO_DELTA,
        activeMemoryRecords: -1,
        retainedRevisionRecords: -carriers.revisionCount,
        tombstoneRecords: 1,
        canonicalLogicalBytes: deletion.tombstoneBytes - carriers.canonicalBytes,
        pendingOutboxRecords: -carriers.outboxRecords,
        outboxLogicalBytes: -carriers.outboxBytes
    }, [event], freshNow);
    requireOneChange(database.prepare(`
    UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
    return committed;
}
function namespaceDeletionCarrierKinds(database, namespaceRef, generation) {
    const probes = [
        [
            'proposal',
            "SELECT 1 AS present FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? UNION ALL SELECT 1 AS present FROM consent_evidence WHERE namespace_ref = ? AND namespace_generation = ? UNION ALL SELECT 1 AS present FROM memory_v1_to_v2_manifests WHERE namespace_ref = ? AND namespace_generation = ? AND aggregate_kind = 'proposal' LIMIT 1",
            3
        ],
        [
            'head',
            'SELECT 1 AS present FROM heads WHERE namespace_ref = ? AND namespace_generation = ? LIMIT 1',
            1
        ],
        [
            'revision',
            "SELECT 1 AS present FROM revisions WHERE namespace_ref = ? AND namespace_generation = ? UNION ALL SELECT 1 AS present FROM revision_evidence WHERE namespace_ref = ? AND namespace_generation = ? UNION ALL SELECT 1 AS present FROM memory_v1_to_v2_manifests WHERE namespace_ref = ? AND namespace_generation = ? AND aggregate_kind = 'memory' LIMIT 1",
            3
        ],
        [
            'revision_payload',
            'SELECT 1 AS present FROM revision_payloads WHERE namespace_ref = ? AND namespace_generation = ? LIMIT 1',
            1
        ],
        [
            'content_outbox',
            "SELECT 1 AS present FROM outbox WHERE namespace_ref = ? AND namespace_generation = ? AND event_kind IN ('proposal_changed', 'record_upserted') LIMIT 1",
            1
        ]
    ];
    const remaining = probes.filter(([, sql, bindings]) => database.prepare(sql).get(...Array.from({ length: bindings }, () => [namespaceRef, generation]).flat()) !== undefined).map(([kind]) => kind);
    return Object.freeze(remaining);
}
function executeNamespaceDelete(database, envelope, wire, commandHash, freshNow) {
    const operation = 'namespace.delete';
    const aggregateRef = wire.namespaceRef;
    if (!deletionActorAllows(envelope, wire, 'elevated', freshNow)) {
        return denial(operation, commandHash, 'authority');
    }
    const replay = existingLedgerResult(database, wire, commandHash, aggregateRef);
    if (replay === 'conflict') {
        return resultFor(operation, commandHash, { status: 'conflict', category: 'idempotency' });
    }
    if (replay !== null)
        return replay;
    const namespace = loadNamespace(database, wire.namespaceRef);
    if (namespace === null || namespace.generation !== wire.expectedNamespaceGeneration) {
        return denial(operation, commandHash, 'authority');
    }
    const usage = loadUsage(database, wire.namespaceRef, wire.expectedNamespaceGeneration);
    validateUsageLowerBounds(database, wire.namespaceRef, wire.expectedNamespaceGeneration, usage, ZERO_DELTA);
    const deletion = createDeletionReceiptAndTombstone(wire, commandHash, freshNow, null, null);
    const remainingCarrierKinds = namespaceDeletionCarrierKinds(database, wire.namespaceRef, wire.expectedNamespaceGeneration);
    const status = createDeletionStatusV1({
        deletionRef: deletion.receipt.deletionRef,
        namespaceRef: wire.namespaceRef,
        deletingGeneration: wire.expectedNamespaceGeneration,
        observedCurrentGeneration: deletion.receipt.generationAfter,
        remainingCarrierKinds,
        canonicalBodies: remainingCarrierKinds.length === 0 ? 'verified_absent' : 'scrub_pending',
        payloadDeletion: 'unverified',
        walCheckpoint: 'unverified',
        derivedCleanup: 'queued',
        stage: 'logical_committed',
        observedAt: freshNow
    });
    const checkpointWire = encodeDeletionStatusV1(status);
    const checkpointBytes = Buffer.byteLength(checkpointWire, 'utf8');
    const result = deletionResult(operation, commandHash, deletion.receipt);
    const resultWire = encodeMemoryLifecycleStableResultWireV1(result);
    const resultBytes = Buffer.byteLength(resultWire, 'utf8');
    const event = prepareEvent(nextOutboxSequence(database, 1), wire.namespaceRef, deletion.receipt.generationAfter, 'namespace', wire.namespaceRef, deletion.receipt.generationAfter, 'namespace_deleted', wire.occurredAt);
    const globalAfter = Object.freeze({
        ...usage.global,
        tombstoneRecords: addExact(usage.global.tombstoneRecords, 1),
        canonicalLogicalBytes: addExact(usage.global.canonicalLogicalBytes, deletion.tombstoneBytes + checkpointBytes + resultBytes),
        pendingOutboxRecords: addExact(usage.global.pendingOutboxRecords, 1),
        outboxLogicalBytes: addExact(usage.global.outboxLogicalBytes, event.bytes),
        records: addExact(usage.global.records, 1),
        bytes: addExact(usage.global.bytes, resultBytes)
    });
    const oldGenerationAfter = Object.freeze({
        ...usage.namespace,
        canonicalLogicalBytes: addExact(usage.namespace.canonicalLogicalBytes - namespace.wireBytes, checkpointBytes + resultBytes)
    });
    if (usage.namespace.canonicalLogicalBytes < namespace.wireBytes) {
        throw new CanonicalLifecycleMutationDataErrorV1();
    }
    const projectedForCapacity = Object.freeze({
        namespace: oldGenerationAfter,
        generationCommands: Object.freeze({
            records: addExact(usage.generationCommands.records, 1),
            bytes: addExact(usage.generationCommands.bytes, resultBytes)
        }),
        namespaceCommands: Object.freeze({
            records: addExact(usage.namespaceCommands.records, 1),
            bytes: addExact(usage.namespaceCommands.bytes, resultBytes)
        }),
        global: globalAfter
    });
    const capacity = capacityFailure(projectedForCapacity, true);
    if (capacity !== null)
        throw new LifecycleMutationCapacityErrorV1(capacity);
    const checkpointUsage = database.prepare(`
    SELECT n.deletion_checkpoint_records AS namespace_records,
      g.deletion_checkpoint_records AS global_records,
      g.deletion_checkpoint_logical_bytes AS global_bytes
    FROM lifecycle_namespace_usage n CROSS JOIN global_usage g
    WHERE n.namespace_ref = ? AND g.singleton = 1
  `).get(wire.namespaceRef);
    if (checkpointUsage === undefined)
        throw new CanonicalLifecycleMutationDataErrorV1();
    if (exactInteger(rowValue(checkpointUsage, 'namespace_records')) + 1 >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace ||
        exactInteger(rowValue(checkpointUsage, 'global_records')) + 1 >
            MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerDeployment ||
        exactInteger(rowValue(checkpointUsage, 'global_bytes')) + checkpointBytes >
            MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointBytesPerDeployment) {
        throw new LifecycleMutationCapacityErrorV1('canonical_bytes');
    }
    requireOneChange(database.prepare(`
    UPDATE namespaces SET namespace_generation = ?, content_epoch = content_epoch + 1,
      updated_at_ms = ? WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(deletion.receipt.generationAfter, Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
    requireOneChange(database.prepare(`
    UPDATE usage SET canonical_logical_bytes = ?, lifecycle_command_records = ?,
      lifecycle_command_logical_bytes = ?, deletion_checkpoint_records = 1,
      deletion_checkpoint_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(oldGenerationAfter.canonicalLogicalBytes, projectedForCapacity.generationCommands.records, projectedForCapacity.generationCommands.bytes, checkpointBytes, Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes);
    requireOneChange(database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes
    ) VALUES (?, ?, 0, 0, 0, 1, ?, 1, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `).run(wire.namespaceRef, deletion.receipt.generationAfter, namespace.wireBytes + deletion.tombstoneBytes, event.bytes, Date.parse(freshNow)).changes);
    insertDeletionTombstone(database, deletion);
    insertEvent(database, event);
    requireOneChange(database.prepare(`
    INSERT INTO namespace_deletion_checkpoints(
      namespace_ref, deletion_ref, deleting_generation, observed_current_generation,
      canonical_bodies, payload_deletion, wal_checkpoint, derived_cleanup, stage,
      receipt_hash, checkpoint_wire, checkpoint_wire_bytes, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(wire.namespaceRef, status.deletionRef, status.deletingGeneration, status.observedCurrentGeneration, status.canonicalBodies, status.payloadDeletion, status.walCheckpoint, status.derivedCleanup, status.stage, deletion.receipt.receiptHash, checkpointWire, checkpointBytes, Date.parse(freshNow)).changes);
    requireOneChange(database.prepare(`
    INSERT INTO lifecycle_commands(
      namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
      committed_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(wire.namespaceRef, wire.expectedNamespaceGeneration, wire.commandRef, commandHash, operation, aggregateRefHash(aggregateRef), resultWire, resultBytes, memoryLifecycleStableResultHashV1(resultWire), Date.parse(freshNow), Date.parse(freshNow) + MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs).changes);
    requireOneChange(database.prepare(`
    UPDATE lifecycle_namespace_usage SET lifecycle_command_records = ?,
      lifecycle_command_logical_bytes = ?, deletion_checkpoint_records =
        deletion_checkpoint_records + 1,
      deletion_checkpoint_logical_bytes = deletion_checkpoint_logical_bytes + ?,
      updated_at_ms = ? WHERE namespace_ref = ?
  `).run(projectedForCapacity.namespaceCommands.records, projectedForCapacity.namespaceCommands.bytes, checkpointBytes, Date.parse(freshNow), wire.namespaceRef).changes);
    requireOneChange(database.prepare(`
    UPDATE global_usage SET tombstone_records = ?, canonical_logical_bytes = ?,
      pending_outbox_records = ?, outbox_logical_bytes = ?, lifecycle_command_records = ?,
      lifecycle_command_logical_bytes = ?, deletion_checkpoint_records =
        deletion_checkpoint_records + 1,
      deletion_checkpoint_logical_bytes = deletion_checkpoint_logical_bytes + ?,
      updated_at_ms = ? WHERE singleton = 1
  `).run(globalAfter.tombstoneRecords, globalAfter.canonicalLogicalBytes, globalAfter.pendingOutboxRecords, globalAfter.outboxLogicalBytes, globalAfter.records, globalAfter.bytes, checkpointBytes, Date.parse(freshNow)).changes);
    return result;
}
function executeMutation(database, envelope, freshNow) {
    const command = parseMemoryLifecycleCommandV1(envelope.command);
    const wire = decodeMemoryLifecycleCommandWireV1(command.wire);
    const commandHash = memoryLifecycleCommandHashV1(command.wire);
    if (!SUPPORTED_OPERATIONS.has(wire.operation)) {
        return resultFor('proposal.create', commandHash, {
            status: 'unavailable', category: 'storage', retryable: false
        });
    }
    const operation = wire.operation;
    if (!lockedAccessAllows(envelope, wire, freshNow))
        return denial(operation, commandHash, 'access');
    const namespace = loadNamespace(database, wire.namespaceRef);
    if (wire.operation !== 'proposal.create' && wire.operation !== 'namespace.delete' && (namespace === null || namespace.generation !== wire.expectedNamespaceGeneration))
        return denial(operation, commandHash, 'authority');
    if (wire.operation === 'proposal.create') {
        return executeProposalCreate(database, envelope, wire, commandHash, freshNow);
    }
    if (PROPOSAL_DECISION_OPERATIONS.has(operation)) {
        return executeProposalDecision(database, envelope, wire, commandHash, freshNow);
    }
    if (RECORD_OPERATIONS.has(operation)) {
        return executeRecordMutation(database, envelope, wire, commandHash, freshNow);
    }
    if (operation === 'record.forget') {
        return executeRecordForget(database, envelope, wire, commandHash, freshNow);
    }
    if (operation === 'namespace.delete') {
        return executeNamespaceDelete(database, envelope, wire, commandHash, freshNow);
    }
    throw new CanonicalLifecycleMutationDataErrorV1();
}
function sqliteErrcode(error) {
    if (error === null || typeof error !== 'object' || utilTypes.isProxy(error))
        return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
        ? descriptor.value
        : null;
}
function failureResult(error, operation, commandHash) {
    if (error instanceof LifecycleMutationCapacityErrorV1) {
        return resultFor(operation, commandHash, { status: 'capacity', category: error.category });
    }
    if (error instanceof CanonicalLifecycleMutationDataErrorV1 || error instanceof SyntaxError ||
        error instanceof TypeError) {
        return resultFor(operation, commandHash, { status: 'corrupt', category: 'canonical_data' });
    }
    const errcode = sqliteErrcode(error);
    const primary = errcode === null ? null : errcode & 0xff;
    if (primary === 5 || primary === 6)
        return resultFor(operation, commandHash, {
            status: 'unavailable', category: 'busy', retryable: true
        });
    if (primary === 10)
        return resultFor(operation, commandHash, {
            status: 'unavailable', category: 'io', retryable: true
        });
    if (primary === 11 || primary === 26)
        return resultFor(operation, commandHash, {
            status: 'corrupt', category: 'canonical_data'
        });
    return resultFor(operation, commandHash, {
        status: 'unavailable', category: 'storage', retryable: false
    });
}
export function createSqliteMemoryLifecycleMutationAdapterV1(options) {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
        options.database === null || typeof options.database !== 'object' ||
        utilTypes.isProxy(options.database) || typeof options.database.exec !== 'function' ||
        typeof options.database.prepare !== 'function' || typeof options.now !== 'function' ||
        utilTypes.isProxy(options.now))
        throw new TypeError('invalid lifecycle mutation adapter options');
    const { database, now } = options;
    return Object.freeze({
        execute: async (envelope) => {
            let operation = 'proposal.create';
            let commandHash = '0'.repeat(64);
            try {
                const command = parseMemoryLifecycleCommandV1(envelope.command);
                const wire = decodeMemoryLifecycleCommandWireV1(command.wire);
                if (SUPPORTED_OPERATIONS.has(wire.operation))
                    operation = wire.operation;
                commandHash = memoryLifecycleCommandHashV1(command.wire);
            }
            catch {
                return failureResult(new CanonicalLifecycleMutationDataErrorV1(), operation, commandHash);
            }
            let started = false;
            try {
                database.exec('BEGIN IMMEDIATE');
                started = true;
                const freshNow = freezeTrustedNow(database, now);
                const result = executeMutation(database, envelope, freshNow);
                database.exec('COMMIT');
                started = false;
                return result;
            }
            catch (error) {
                if (started) {
                    try {
                        database.exec('ROLLBACK');
                    }
                    catch { }
                }
                return failureResult(error, operation, commandHash);
            }
        }
    });
}
