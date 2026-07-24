import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { memoryLifecycleActorCapabilityAllowsV1 } from './memory-lifecycle-authority.js';
import { memoryLifecycleDomainHashV1, parseMemoryLifecycleInstantV1, parseMemoryLifecyclePositiveIntegerV1 } from './memory-lifecycle-domain.js';
import { inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const MEMORY_EXPORT_COMMAND_OPERATIONS_V1 = Object.freeze([
    'export.prepare',
    'export.generate',
    'export.claimDelivery'
]);
export const MEMORY_EXPORT_COMMAND_HASH_DOMAIN_V1 = 'groupmate.memory.export-command.v1';
export const MEMORY_EXPORT_COMMAND_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-command-ref.v1';
export const MEMORY_EXPORT_ID_HASH_DOMAIN_V1 = 'groupmate.memory.export-id.v1';
export const MEMORY_EXPORT_RESULT_HASH_DOMAIN_V1 = 'groupmate.memory.export-result.v1';
export const MEMORY_EXPORT_MANIFEST_RECEIPT_HASH_DOMAIN_V1 = 'groupmate.memory.export-manifest-receipt.v1';
export const MEMORY_EXPORT_EXCLUSIONS_HASH_DOMAIN_V1 = 'groupmate.memory.export-exclusions.v1';
export const MEMORY_EXPORT_CLAIM_RECEIPT_HASH_DOMAIN_V1 = 'groupmate.memory.export-claim-receipt.v1';
export const MEMORY_EXPORT_DELIVERY_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-delivery-ref.v1';
export const MEMORY_EXPORT_RESOLVE_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-resolve-ref.v1';
export const MEMORY_EXPORT_MAX_WIRE_BYTES_V1 = 80 * 1_024 * 1_024;
export const MEMORY_EXPORT_MAX_CHUNK_BYTES_V1 = 64 * 1_024;
export const MEMORY_EXPORT_EXCLUSIONS_V1 = Object.freeze([
    'sqlite_physical_layout',
    'transactional_outbox',
    'redis_derived_cache',
    'groupmate_configuration',
    'qq_server_history',
    'groupmate_content_journal',
    'provider_logs',
    'delivered_export_artifacts_from_future_memory_deletion'
]);
export const MEMORY_EXPORT_EXCLUSIONS_HASH_V1 = memoryLifecycleDomainHashV1(MEMORY_EXPORT_EXCLUSIONS_HASH_DOMAIN_V1, JSON.stringify(MEMORY_EXPORT_EXCLUSIONS_V1));
const deliveryHandleBrand = Symbol('MemoryExportDeliveryHandleV1');
const generateAttemptBrand = Symbol('MemoryExportGenerateAttemptV1');
const COMMAND_REF = /^command:[0-9a-f]{64}$/;
const ACTOR_REF = /^actor:[0-9a-f]{64}$/;
const EXPORT_ID = /^export:[0-9a-f]{64}$/;
const DELIVERY_REF = /^delivery:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const deliveryHandleStates = new WeakMap();
const generateAttemptStates = new WeakMap();
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function parsePattern(value, pattern) {
    if (typeof value !== 'string' || !pattern.test(value))
        return invalidMemoryValue();
    return value;
}
function parseHash(value) {
    return parsePattern(value, HASH);
}
function parseNullableHash(value) {
    return value === null ? null : parseHash(value);
}
function parseExportId(value) {
    return parsePattern(value, EXPORT_ID);
}
function parseNullableExportId(value) {
    return value === null ? null : parseExportId(value);
}
function parseNonnegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function parseWireObject(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
        'expectedNamespaceGeneration', 'exportId', 'expectedManifestHash', 'retryOfExportId',
        'expectedSnapshotSha256', 'occurredAt'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(input.operation, MEMORY_EXPORT_COMMAND_OPERATIONS_V1);
    const exportId = parseNullableExportId(input.exportId);
    const expectedManifestHash = parseNullableHash(input.expectedManifestHash);
    const retryOfExportId = parseNullableExportId(input.retryOfExportId);
    const expectedSnapshotSha256 = parseNullableHash(input.expectedSnapshotSha256);
    const hasSnapshotComparison = retryOfExportId !== null;
    if (hasSnapshotComparison !== (expectedSnapshotSha256 !== null))
        return invalidMemoryValue();
    if (operation === 'export.prepare') {
        if (exportId !== null || expectedManifestHash !== null)
            return invalidMemoryValue();
    }
    else if (exportId === null || expectedManifestHash === null) {
        return invalidMemoryValue();
    }
    else if (operation === 'export.claimDelivery' && hasSnapshotComparison) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        commandRef: parsePattern(input.commandRef, COMMAND_REF),
        operation,
        initiatedByActorRef: parsePattern(input.initiatedByActorRef, ACTOR_REF),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        expectedNamespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.expectedNamespaceGeneration),
        exportId,
        expectedManifestHash,
        retryOfExportId,
        expectedSnapshotSha256,
        occurredAt: parseMemoryLifecycleInstantV1(input.occurredAt)
    });
}
export function encodeMemoryExportCommandWireV1(value) {
    const wire = JSON.stringify(parseWireObject(value));
    if (Buffer.byteLength(wire, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes)
        return invalidMemoryValue();
    return wire;
}
export function decodeMemoryExportCommandWireV1(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes)
        return invalidMemoryValue();
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const parsed = parseWireObject(value);
    if (JSON.stringify(parsed) !== raw)
        return invalidMemoryValue();
    return parsed;
}
export function createMemoryExportCommandV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
        'expectedNamespaceGeneration', 'exportId', 'expectedManifestHash', 'retryOfExportId',
        'expectedSnapshotSha256', 'occurredAt'
    ]);
    return Object.freeze({ wire: encodeMemoryExportCommandWireV1({ schemaVersion: 1, ...input }) });
}
export function parseMemoryExportCommandV1(value) {
    const input = inspectMemoryRecord(value, ['wire']);
    return Object.freeze({ wire: encodeMemoryExportCommandWireV1(decodeMemoryExportCommandWireV1(input.wire)) });
}
export function memoryExportCommandHashV1(value) {
    const command = typeof value === 'string'
        ? Object.freeze({ wire: value })
        : parseMemoryExportCommandV1(value);
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_COMMAND_HASH_DOMAIN_V1, parseMemoryExportCommandV1(command).wire);
}
export function memoryExportCommandRefHashV1(value) {
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_COMMAND_REF_HASH_DOMAIN_V1, parsePattern(value, COMMAND_REF));
}
export function deriveMemoryExportIdV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'namespaceRef', 'namespaceGeneration'
    ]);
    const commandRef = parsePattern(input.commandRef, COMMAND_REF);
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const generation = parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration);
    return `export:${memoryLifecycleDomainHashV1(MEMORY_EXPORT_ID_HASH_DOMAIN_V1, `${commandRef}\0${namespaceRef}\0${generation}\0export`)}`;
}
export function memoryExportResolveRefV1(commandRefValue) {
    return `resolve:${memoryLifecycleDomainHashV1(MEMORY_EXPORT_RESOLVE_REF_HASH_DOMAIN_V1, parsePattern(commandRefValue, COMMAND_REF))}`;
}
function parseLineCounts(value) {
    const input = inspectMemoryRecord(value, [
        'proposal', 'proposalStatus', 'recordHead', 'recordRevision', 'tombstone',
        'lifecycleAudit'
    ]);
    return Object.freeze({
        proposal: parseNonnegativeInteger(input.proposal),
        proposalStatus: parseNonnegativeInteger(input.proposalStatus),
        recordHead: parseNonnegativeInteger(input.recordHead),
        recordRevision: parseNonnegativeInteger(input.recordRevision),
        tombstone: parseNonnegativeInteger(input.tombstone),
        lifecycleAudit: parseNonnegativeInteger(input.lifecycleAudit)
    });
}
function parseStableBase(input, expectedOperation) {
    if (input.schemaVersion !== 1 || input.operation !== expectedOperation) {
        return invalidMemoryValue();
    }
    const exclusionsHash = parseHash(input.exclusionsHash);
    if (exclusionsHash !== MEMORY_EXPORT_EXCLUSIONS_HASH_V1)
        return invalidMemoryValue();
    return {
        schemaVersion: 1,
        commandRefHash: parseHash(input.commandRefHash),
        commandHash: parseHash(input.commandHash),
        operation: expectedOperation,
        exportId: parseExportId(input.exportId),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
        contentEpoch: parseMemoryLifecyclePositiveIntegerV1(input.contentEpoch),
        exclusionsHash
    };
}
function assertArtifactExpiry(startedAt, expiresAt) {
    const duration = Date.parse(expiresAt) - Date.parse(startedAt);
    if (duration <= 0 || duration >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportTerminalTtlMs) {
        return invalidMemoryValue();
    }
}
function parsePreparedManifestFields(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'status', 'commandRefHash', 'commandHash', 'operation', 'exportId',
        'namespaceRef', 'namespaceGeneration', 'contentEpoch', 'retryOfExportId',
        'expectedSnapshotSha256', 'preparedAt', 'artifactExpiresAt', 'exclusionsHash'
    ]);
    if (input.status !== 'prepared')
        return invalidMemoryValue();
    const base = parseStableBase(input, 'export.prepare');
    const retryOfExportId = parseNullableExportId(input.retryOfExportId);
    const expectedSnapshotSha256 = parseNullableHash(input.expectedSnapshotSha256);
    if ((retryOfExportId === null) !== (expectedSnapshotSha256 === null)) {
        return invalidMemoryValue();
    }
    const preparedAt = parseMemoryLifecycleInstantV1(input.preparedAt);
    const artifactExpiresAt = parseMemoryLifecycleInstantV1(input.artifactExpiresAt);
    assertArtifactExpiry(preparedAt, artifactExpiresAt);
    return Object.freeze({
        ...base,
        status: 'prepared',
        operation: 'export.prepare',
        retryOfExportId,
        expectedSnapshotSha256,
        preparedAt,
        artifactExpiresAt
    });
}
function parseSnapshotManifestFields(value, status) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'status', 'commandRefHash', 'commandHash', 'operation', 'exportId',
        'namespaceRef', 'namespaceGeneration', 'contentEpoch', 'snapshotAt', 'counts',
        'contentBytes', 'wireBytes', 'sha256', 'artifactExpiresAt', 'completeness',
        'snapshotChanged', 'exclusionsHash'
    ]);
    if (input.status !== status || input.completeness !== 'complete')
        return invalidMemoryValue();
    const base = parseStableBase(input, 'export.generate');
    const snapshotAt = parseMemoryLifecycleInstantV1(input.snapshotAt);
    const artifactExpiresAt = parseMemoryLifecycleInstantV1(input.artifactExpiresAt);
    const contentBytes = parseNonnegativeInteger(input.contentBytes, MEMORY_EXPORT_MAX_WIRE_BYTES_V1);
    const wireBytes = parseNonnegativeInteger(input.wireBytes, MEMORY_EXPORT_MAX_WIRE_BYTES_V1);
    if (contentBytes === 0 || wireBytes <= contentBytes)
        return invalidMemoryValue();
    assertArtifactExpiry(snapshotAt, artifactExpiresAt);
    if (status === 'deliverable') {
        const snapshotChanged = enumValue(input.snapshotChanged, ['not_comparable', 'matched']);
        return Object.freeze({
            ...base,
            status,
            operation: 'export.generate',
            snapshotAt,
            counts: parseLineCounts(input.counts),
            contentBytes,
            wireBytes,
            sha256: parseHash(input.sha256),
            artifactExpiresAt,
            completeness: 'complete',
            snapshotChanged
        });
    }
    if (input.snapshotChanged !== 'changed')
        return invalidMemoryValue();
    return Object.freeze({
        ...base,
        status,
        operation: 'export.generate',
        snapshotAt,
        counts: parseLineCounts(input.counts),
        contentBytes,
        wireBytes,
        sha256: parseHash(input.sha256),
        artifactExpiresAt,
        completeness: 'complete',
        snapshotChanged: 'changed'
    });
}
function parseFailedManifestFields(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'status', 'commandRefHash', 'commandHash', 'operation', 'exportId',
        'namespaceRef', 'namespaceGeneration', 'contentEpoch', 'failedAt', 'category',
        'exclusionsHash'
    ]);
    if (input.status !== 'failed')
        return invalidMemoryValue();
    const base = parseStableBase(input, 'export.generate');
    return Object.freeze({
        ...base,
        status: 'failed',
        operation: 'export.generate',
        failedAt: parseMemoryLifecycleInstantV1(input.failedAt),
        category: enumValue(input.category, ['aborted', 'corrupt', 'capacity', 'unavailable'])
    });
}
function parseStableResultFields(value) {
    const discriminator = inspectMemoryRecord(value, ['status'], [
        'schemaVersion', 'commandRefHash', 'commandHash', 'operation', 'exportId', 'namespaceRef',
        'namespaceGeneration', 'contentEpoch', 'retryOfExportId', 'expectedSnapshotSha256',
        'preparedAt', 'artifactExpiresAt', 'snapshotAt', 'counts', 'contentBytes', 'wireBytes',
        'sha256', 'completeness', 'snapshotChanged', 'failedAt', 'category', 'exclusionsHash'
    ]);
    if (discriminator.status === 'prepared')
        return parsePreparedManifestFields(value);
    if (discriminator.status === 'deliverable') {
        return parseSnapshotManifestFields(value, 'deliverable');
    }
    if (discriminator.status === 'snapshot_changed') {
        return parseSnapshotManifestFields(value, 'snapshot_changed');
    }
    if (discriminator.status === 'failed')
        return parseFailedManifestFields(value);
    return invalidMemoryValue();
}
function manifestReceiptHashFromFields(fields) {
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_MANIFEST_RECEIPT_HASH_DOMAIN_V1, JSON.stringify(fields));
}
export function memoryExportManifestReceiptHashV1(value) {
    return manifestReceiptHashFromFields(parseStableResultFields(value));
}
export function createMemoryExportStableResultV1(value) {
    const fields = parseStableResultFields(value);
    return Object.freeze({
        ...fields,
        receiptHash: manifestReceiptHashFromFields(fields)
    });
}
export function parseMemoryExportStableResultV1(value) {
    const input = inspectMemoryRecord(value, ['status', 'receiptHash'], [
        'schemaVersion', 'commandRefHash', 'commandHash', 'operation', 'exportId', 'namespaceRef',
        'namespaceGeneration', 'contentEpoch', 'retryOfExportId', 'expectedSnapshotSha256',
        'preparedAt', 'artifactExpiresAt', 'snapshotAt', 'counts', 'contentBytes', 'wireBytes',
        'sha256', 'completeness', 'snapshotChanged', 'failedAt', 'category', 'exclusionsHash'
    ]);
    const { receiptHash, ...fieldValues } = input;
    const fields = parseStableResultFields(fieldValues);
    const parsedReceiptHash = parseHash(receiptHash);
    if (parsedReceiptHash !== manifestReceiptHashFromFields(fields))
        return invalidMemoryValue();
    return Object.freeze({ ...fields, receiptHash: parsedReceiptHash });
}
export function encodeMemoryExportStableResultWireV1(value) {
    const wire = JSON.stringify(parseMemoryExportStableResultV1(value));
    if (Buffer.byteLength(wire, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) {
        return invalidMemoryValue();
    }
    return wire;
}
export function decodeMemoryExportStableResultWireV1(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) {
        return invalidMemoryValue();
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const parsed = parseMemoryExportStableResultV1(value);
    if (JSON.stringify(parsed) !== raw)
        return invalidMemoryValue();
    return parsed;
}
export function memoryExportStableResultHashV1(value) {
    const wire = typeof value === 'string'
        ? encodeMemoryExportStableResultWireV1(decodeMemoryExportStableResultWireV1(value))
        : encodeMemoryExportStableResultWireV1(value);
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_RESULT_HASH_DOMAIN_V1, wire);
}
export function memoryExportStableResultIsBodyFreeV1(value) {
    try {
        encodeMemoryExportStableResultWireV1(value);
        return true;
    }
    catch {
        return false;
    }
}
function parseEnvelope(value) {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'command', 'access', 'actor']);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    for (const capability of [input.access, input.actor]) {
        if (capability === null || typeof capability !== 'object' || utilTypes.isProxy(capability)) {
            return invalidMemoryValue();
        }
    }
    return Object.freeze({
        schemaVersion: 1,
        command: parseMemoryExportCommandV1(input.command),
        access: input.access,
        actor: input.actor
    });
}
export function parseMemoryExportAuthorizationEnvelopeV1(value) {
    return parseEnvelope(value);
}
function createDeliveryHandle(exportId, deliveryRefValue, claimReceiptHashValue) {
    const deliveryRef = parsePattern(deliveryRefValue, DELIVERY_REF);
    const handle = Object.freeze({
        schemaVersion: 1,
        exportId: parseExportId(exportId),
        [deliveryHandleBrand]: true
    });
    deliveryHandleStates.set(handle, Object.freeze({
        deliveryRef,
        deliveryRefHash: memoryExportDeliveryRefHashV1(deliveryRef),
        claimReceiptHash: parseHash(claimReceiptHashValue)
    }));
    return handle;
}
export function memoryExportDeliveryHandleIsV1(value) {
    return value !== null && typeof value === 'object' && !utilTypes.isProxy(value) &&
        deliveryHandleStates.has(value);
}
export function consumeMemoryExportDeliveryHandleV1(value) {
    if (!memoryExportDeliveryHandleIsV1(value))
        return invalidMemoryValue();
    const handle = value;
    const state = deliveryHandleStates.get(handle);
    if (state === undefined)
        return invalidMemoryValue();
    deliveryHandleStates.delete(handle);
    return Object.freeze({
        schemaVersion: 1,
        exportId: handle.exportId,
        deliveryRef: state.deliveryRef,
        deliveryRefHash: state.deliveryRefHash,
        claimReceiptHash: state.claimReceiptHash
    });
}
export function memoryExportDeliveryRefHashV1(value) {
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_DELIVERY_REF_HASH_DOMAIN_V1, parsePattern(value, DELIVERY_REF));
}
export function memoryExportClaimReceiptHashV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandHash', 'manifestHash', 'deliveryRefHash'
    ]);
    return memoryLifecycleDomainHashV1(MEMORY_EXPORT_CLAIM_RECEIPT_HASH_DOMAIN_V1, `${parseHash(input.commandHash)}\0${parseHash(input.manifestHash)}\0${parseHash(input.deliveryRefHash)}`);
}
function createGenerateAttempt(command, commandHash) {
    if (command.operation !== 'export.generate' || command.exportId === null) {
        return invalidMemoryValue();
    }
    const attempt = Object.freeze({
        schemaVersion: 1,
        exportId: command.exportId,
        [generateAttemptBrand]: true
    });
    generateAttemptStates.set(attempt, {
        commandHash,
        acquired: false,
        closed: false
    });
    return attempt;
}
export function acquireMemoryExportGenerateAttemptV1(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
        return invalidMemoryValue();
    }
    const attempt = value;
    const state = generateAttemptStates.get(attempt);
    if (state === undefined || state.closed || state.acquired)
        return invalidMemoryValue();
    state.acquired = true;
    return attempt;
}
function generateAttemptWasAcquired(attempt) {
    const state = generateAttemptStates.get(attempt);
    return state !== undefined && !state.closed && state.acquired;
}
function closeGenerateAttempt(attempt) {
    if (attempt === null)
        return;
    const state = generateAttemptStates.get(attempt);
    if (state !== undefined)
        state.closed = true;
}
function assertStableBinding(result, command, commandHash) {
    if (result.commandRefHash !== memoryExportCommandRefHashV1(command.commandRef) ||
        result.commandHash !== commandHash || result.operation !== command.operation ||
        result.namespaceRef !== command.namespaceRef ||
        result.namespaceGeneration !== command.expectedNamespaceGeneration) {
        return invalidMemoryValue();
    }
    if (command.operation === 'export.prepare') {
        if (result.status !== 'prepared' || result.exportId !== deriveMemoryExportIdV1({
            commandRef: command.commandRef,
            namespaceRef: command.namespaceRef,
            namespaceGeneration: command.expectedNamespaceGeneration
        }) || result.retryOfExportId !== command.retryOfExportId ||
            result.expectedSnapshotSha256 !== command.expectedSnapshotSha256) {
            return invalidMemoryValue();
        }
        return;
    }
    if (command.operation !== 'export.generate' || result.status === 'prepared' ||
        result.exportId !== command.exportId)
        return invalidMemoryValue();
    const expectsComparison = command.expectedSnapshotSha256 !== null;
    if (result.status === 'snapshot_changed' && (!expectsComparison || result.sha256 === command.expectedSnapshotSha256))
        return invalidMemoryValue();
    if (result.status === 'deliverable') {
        const expectedProjection = expectsComparison ? 'matched' : 'not_comparable';
        if (result.snapshotChanged !== expectedProjection ||
            (expectsComparison && result.sha256 !== command.expectedSnapshotSha256)) {
            return invalidMemoryValue();
        }
    }
}
function parseSimpleAdapterResult(value, operation, signalAborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['category', 'retryable']);
    if (discriminator.status === 'denied') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'denied',
            category: enumValue(input.category, ['access', 'authority'])
        });
    }
    if (discriminator.status === 'conflict') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        const categories = operation === 'export.prepare'
            ? ['generation', 'idempotency']
            : ['generation', 'idempotency', 'state'];
        return Object.freeze({
            status: 'conflict',
            category: enumValue(input.category, categories)
        });
    }
    if (discriminator.status === 'capacity') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        const categories = operation === 'export.prepare'
            ? ['export_jobs', 'canonical_bytes']
            : operation === 'export.generate'
                ? ['canonical_bytes', 'artifact_bytes']
                : ['canonical_bytes'];
        return Object.freeze({
            status: 'capacity',
            category: enumValue(input.category, categories)
        });
    }
    if (discriminator.status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'corrupt',
            category: enumValue(input.category, ['canonical_data', 'adapter_contract'])
        });
    }
    if (discriminator.status === 'unavailable') {
        const input = inspectMemoryRecord(value, ['status', 'category', 'retryable']);
        if (typeof input.retryable !== 'boolean')
            return invalidMemoryValue();
        const categories = operation === 'export.prepare'
            ? ['busy', 'storage', 'io']
            : ['busy', 'storage', 'io', 'artifact'];
        const category = enumValue(input.category, categories);
        if (input.retryable !== (category === 'busy' || category === 'io')) {
            return invalidMemoryValue();
        }
        return Object.freeze({
            status: 'unavailable',
            category,
            retryable: input.retryable
        });
    }
    if (discriminator.status === 'aborted') {
        inspectMemoryRecord(value, ['status']);
        if (!signalAborted)
            return invalidMemoryValue();
        return Object.freeze({ status: 'aborted' });
    }
    return invalidMemoryValue();
}
function parseAdapterResult(value, command, commandHash, signalAborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], [
        'schemaVersion', 'commandRefHash', 'commandHash', 'operation', 'exportId', 'namespaceRef',
        'namespaceGeneration', 'contentEpoch', 'retryOfExportId', 'expectedSnapshotSha256',
        'preparedAt', 'artifactExpiresAt', 'snapshotAt', 'counts', 'contentBytes', 'wireBytes',
        'sha256', 'completeness', 'snapshotChanged', 'failedAt', 'category', 'exclusionsHash',
        'receiptHash', 'manifest', 'deliveryRef', 'claimReceiptHash', 'retryable'
    ]);
    if (['prepared', 'deliverable', 'snapshot_changed', 'failed'].includes(discriminator.status)) {
        const stable = parseMemoryExportStableResultV1(value);
        assertStableBinding(stable, command, commandHash);
        return stable;
    }
    if (discriminator.status === 'delivery_claimed') {
        if (command.operation !== 'export.claimDelivery')
            return invalidMemoryValue();
        const input = inspectMemoryRecord(value, [
            'status', 'manifest', 'deliveryRef', 'claimReceiptHash'
        ]);
        const parsedManifest = parseMemoryExportStableResultV1(input.manifest);
        if (parsedManifest.status !== 'deliverable')
            return invalidMemoryValue();
        const manifest = parsedManifest;
        const manifestHash = memoryExportStableResultHashV1(manifest);
        if (manifest.exportId !== command.exportId ||
            manifest.namespaceRef !== command.namespaceRef ||
            manifest.namespaceGeneration !== command.expectedNamespaceGeneration ||
            manifestHash !== command.expectedManifestHash) {
            return invalidMemoryValue();
        }
        const deliveryRef = parsePattern(input.deliveryRef, DELIVERY_REF);
        const deliveryRefHash = memoryExportDeliveryRefHashV1(deliveryRef);
        const claimReceiptHash = parseHash(input.claimReceiptHash);
        if (claimReceiptHash !== memoryExportClaimReceiptHashV1({
            commandHash,
            manifestHash,
            deliveryRefHash
        }))
            return invalidMemoryValue();
        return Object.freeze({
            status: 'delivery_claimed',
            manifest,
            deliveryRef,
            claimReceiptHash
        });
    }
    return parseSimpleAdapterResult(value, command.operation, signalAborted);
}
const DENIED_ACCESS = Object.freeze({ status: 'denied', category: 'access' });
const DENIED_AUTHORITY = Object.freeze({
    status: 'denied',
    category: 'authority'
});
const ABORTED = Object.freeze({ status: 'aborted' });
const ADAPTER_CORRUPT = Object.freeze({
    status: 'corrupt',
    category: 'adapter_contract'
});
const IO_UNAVAILABLE = Object.freeze({
    status: 'unavailable',
    category: 'io',
    retryable: true
});
function resolveRequired(commandRef) {
    return Object.freeze({
        status: 'resolve_required',
        category: 'outcome_unknown',
        resolveRef: memoryExportResolveRefV1(commandRef)
    });
}
async function finishGenerate(attempt, command, commandHash, outcome, proposedTerminal, cleanup, cleanupPartial, finalizeGenerate) {
    let cleanupSucceeded = true;
    if (cleanup) {
        try {
            await Reflect.apply(cleanupPartial, undefined, [attempt]);
        }
        catch {
            cleanupSucceeded = false;
        }
    }
    let finalizeValue;
    try {
        finalizeValue = await Reflect.apply(finalizeGenerate, undefined, [attempt, outcome]);
    }
    catch {
        return Object.freeze({
            cleanupSucceeded,
            finalization: 'unknown',
            terminal: null
        });
    }
    const discriminator = inspectMemoryRecord(finalizeValue, ['status'], ['manifest']);
    if (discriminator.status === 'not_committed') {
        inspectMemoryRecord(finalizeValue, ['status']);
        return Object.freeze({
            cleanupSucceeded,
            finalization: 'not_committed',
            terminal: null
        });
    }
    if (discriminator.status !== 'terminal')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(finalizeValue, ['status', 'manifest']);
    const terminal = parseMemoryExportStableResultV1(input.manifest);
    if (terminal.status === 'prepared')
        return invalidMemoryValue();
    assertStableBinding(terminal, command, commandHash);
    if (proposedTerminal !== undefined &&
        memoryExportStableResultHashV1(terminal) !== memoryExportStableResultHashV1(proposedTerminal)) {
        return invalidMemoryValue();
    }
    if (proposedTerminal === undefined && terminal.status !== 'failed')
        return invalidMemoryValue();
    return Object.freeze({
        cleanupSucceeded,
        finalization: 'terminal',
        terminal
    });
}
export function createMemoryExportPortV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, [
        'now', 'execute', 'cleanupPartial', 'finalizeGenerate'
    ]);
    for (const callback of [
        options.now, options.execute, options.cleanupPartial, options.finalizeGenerate
    ]) {
        if (typeof callback !== 'function' || utilTypes.isProxy(callback))
            return invalidMemoryValue();
    }
    const now = options.now;
    const adapterExecute = options.execute;
    const cleanupPartial = options.cleanupPartial;
    const finalizeGenerate = options.finalizeGenerate;
    const claimReceiptByCommandHash = new Map();
    const execute = async (envelopeValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        let generateAttempt = null;
        try {
            const envelope = parseEnvelope(envelopeValue);
            const command = decodeMemoryExportCommandWireV1(envelope.command.wire);
            const commandHash = memoryExportCommandHashV1(envelope.command);
            if (signalScope.isAborted())
                return ABORTED;
            let currentTime;
            try {
                currentTime = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []));
            }
            catch {
                return invalidMemoryValue();
            }
            if (!memoryAccessCapabilityAllowsV1(envelope.access, command.namespaceRef, currentTime))
                return DENIED_ACCESS;
            const action = command.operation === 'export.claimDelivery' ? 'claim_export' : 'export';
            if (!memoryLifecycleActorCapabilityAllowsV1(envelope.actor, Object.freeze({
                botInstanceId: envelope.access.botInstanceId,
                accountId: envelope.access.accountId,
                sceneRef: envelope.access.sceneRef,
                namespaceRef: command.namespaceRef,
                generation: command.expectedNamespaceGeneration,
                actorRef: command.initiatedByActorRef,
                action,
                requiredAuthority: 'elevated'
            }), currentTime))
                return DENIED_AUTHORITY;
            let adapterValue;
            let adapterThrew = false;
            generateAttempt = command.operation === 'export.generate'
                ? createGenerateAttempt(command, commandHash)
                : null;
            try {
                adapterValue = await Reflect.apply(adapterExecute, undefined, [
                    envelope,
                    signalScope.signal,
                    generateAttempt ?? undefined
                ]);
            }
            catch {
                adapterThrew = true;
            }
            const signalAborted = signalScope.isAborted();
            if (command.operation === 'export.generate') {
                if (generateAttempt === null)
                    return invalidMemoryValue();
                let result;
                let resultInvalid = false;
                if (!adapterThrew) {
                    try {
                        result = parseAdapterResult(adapterValue, command, commandHash, signalAborted);
                    }
                    catch {
                        resultInvalid = true;
                    }
                }
                const stableResult = result !== undefined && (result.status === 'deliverable' || result.status === 'snapshot_changed' ||
                    result.status === 'failed') ? result : undefined;
                if (!generateAttemptWasAcquired(generateAttempt)) {
                    if (adapterThrew)
                        return signalAborted ? ABORTED : IO_UNAVAILABLE;
                    if (stableResult !== undefined) {
                        return signalAborted
                            ? Object.freeze({
                                status: 'committed_after_abort',
                                resolveRef: memoryExportResolveRefV1(command.commandRef),
                                committedResultHash: memoryExportStableResultHashV1(stableResult)
                            })
                            : stableResult;
                    }
                    if (resultInvalid || result === undefined ||
                        result.status === 'delivery_claimed' || result.status === 'prepared') {
                        return signalAborted ? ABORTED : ADAPTER_CORRUPT;
                    }
                    return result;
                }
                let outcome;
                if (stableResult?.status === 'deliverable')
                    outcome = 'deliverable';
                else if (stableResult?.status === 'snapshot_changed')
                    outcome = 'snapshot_changed';
                else if (stableResult?.status === 'failed')
                    outcome = 'failed';
                else if (signalAborted)
                    outcome = 'aborted';
                else if (adapterThrew)
                    outcome = 'unavailable';
                else if (resultInvalid || result === undefined)
                    outcome = 'invalid';
                else if (result.status === 'unavailable')
                    outcome = 'unavailable';
                else if (result.status === 'aborted')
                    outcome = 'aborted';
                else
                    outcome = 'failed';
                const cleanup = adapterThrew || resultInvalid || result === undefined ||
                    result.status !== 'deliverable';
                let finish;
                try {
                    finish = await finishGenerate(generateAttempt, command, commandHash, outcome, stableResult, cleanup, cleanupPartial, finalizeGenerate);
                }
                catch {
                    if (!cleanup) {
                        try {
                            await Reflect.apply(cleanupPartial, undefined, [generateAttempt]);
                        }
                        catch {
                        }
                    }
                    return resolveRequired(command.commandRef);
                }
                if (finish.finalization === 'unknown') {
                    if (!cleanup) {
                        try {
                            await Reflect.apply(cleanupPartial, undefined, [generateAttempt]);
                        }
                        catch {
                        }
                    }
                    return resolveRequired(command.commandRef);
                }
                if (!finish.cleanupSucceeded)
                    return resolveRequired(command.commandRef);
                if (signalScope.isAborted()) {
                    if (finish.terminal !== null) {
                        return Object.freeze({
                            status: 'committed_after_abort',
                            resolveRef: memoryExportResolveRefV1(command.commandRef),
                            committedResultHash: memoryExportStableResultHashV1(finish.terminal)
                        });
                    }
                    if (finish.finalization === 'not_committed')
                        return ABORTED;
                    return resolveRequired(command.commandRef);
                }
                if (finish.terminal !== null)
                    return finish.terminal;
                if (stableResult !== undefined)
                    return resolveRequired(command.commandRef);
                if (adapterThrew)
                    return IO_UNAVAILABLE;
                if (resultInvalid || result === undefined)
                    return ADAPTER_CORRUPT;
                if (result.status === 'delivery_claimed' || result.status === 'prepared') {
                    return ADAPTER_CORRUPT;
                }
                return result;
            }
            if (adapterThrew) {
                return signalAborted ? resolveRequired(command.commandRef) : IO_UNAVAILABLE;
            }
            let result;
            try {
                result = parseAdapterResult(adapterValue, command, commandHash, signalAborted);
            }
            catch {
                return signalAborted ? resolveRequired(command.commandRef) : ADAPTER_CORRUPT;
            }
            if (command.operation === 'export.prepare') {
                if (result.status !== 'prepared') {
                    if (result.status === 'delivery_claimed' || result.status === 'deliverable' ||
                        result.status === 'snapshot_changed' || result.status === 'failed') {
                        return ADAPTER_CORRUPT;
                    }
                    return result;
                }
                if (signalAborted) {
                    return Object.freeze({
                        status: 'committed_after_abort',
                        resolveRef: memoryExportResolveRefV1(command.commandRef),
                        committedResultHash: memoryExportStableResultHashV1(result)
                    });
                }
                return result;
            }
            if (result.status !== 'delivery_claimed') {
                if (result.status === 'prepared' || result.status === 'deliverable' ||
                    result.status === 'snapshot_changed' || result.status === 'failed') {
                    return ADAPTER_CORRUPT;
                }
                return result;
            }
            const priorClaimReceipt = claimReceiptByCommandHash.get(commandHash);
            if (priorClaimReceipt !== undefined && priorClaimReceipt !== result.claimReceiptHash) {
                return ADAPTER_CORRUPT;
            }
            if (priorClaimReceipt === undefined) {
                if (claimReceiptByCommandHash.size >=
                    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerDeployment) {
                    const oldest = claimReceiptByCommandHash.keys().next().value;
                    if (oldest !== undefined)
                        claimReceiptByCommandHash.delete(oldest);
                }
                claimReceiptByCommandHash.set(commandHash, result.claimReceiptHash);
            }
            if (signalAborted) {
                return Object.freeze({
                    status: 'committed_after_abort',
                    resolveRef: memoryExportResolveRefV1(command.commandRef),
                    committedResultHash: result.claimReceiptHash
                });
            }
            return Object.freeze({
                status: 'delivery_claimed',
                manifest: result.manifest,
                handle: createDeliveryHandle(result.manifest.exportId, result.deliveryRef, result.claimReceiptHash)
            });
        }
        finally {
            closeGenerateAttempt(generateAttempt);
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
