import { memoryLifecycleDomainHashV1, parseDeletionMutationReceiptV1, parseMemoryLifecycleHashV1, parseMemoryLifecycleHashedRefV1, parseMemoryLifecyclePositiveIntegerV1 } from './memory-lifecycle-domain.js';
import { MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1 } from './memory-lifecycle-command.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const MEMORY_LIFECYCLE_STABLE_RESULT_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-result.v1';
export const MEMORY_LIFECYCLE_RESOLVE_REF_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-resolve-ref.v1';
export const MEMORY_LIFECYCLE_RESULT_STATUSES_V1 = Object.freeze([
    'stored',
    'unchanged',
    'deletion_pending',
    'deletion_complete',
    'not_found',
    'opaque_not_applied',
    'already_decided',
    'proposal_expired',
    'record_expired',
    'record_purge_due',
    'denied',
    'conflict',
    'capacity',
    'history_limit',
    'corrupt',
    'unavailable',
    'committed_after_abort',
    'resolve_required',
    'aborted'
]);
export const MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1 = Object.freeze([
    'stored',
    'unchanged',
    'deletion_pending',
    'deletion_complete',
    'not_found',
    'opaque_not_applied',
    'already_decided',
    'proposal_expired',
    'record_expired',
    'record_purge_due',
    'conflict',
    'history_limit'
]);
const HASHED_REF = /^[0-9a-f]{64}$/;
const RESOLVE_REF = /^resolve:[0-9a-f]{64}$/;
const DELETION_OPERATIONS = new Set([
    'record.forget', 'namespace.delete'
]);
const PROPOSAL_RESULT_OPERATIONS = new Set([
    'proposal.create', 'proposal.approve', 'proposal.reject', 'proposal.withdraw',
    'proposal.expire'
]);
const COMMON_OUTER_STATUSES = [
    'denied', 'corrupt', 'unavailable', 'committed_after_abort', 'resolve_required', 'aborted'
];
function resultStatusSet(...values) {
    return new Set(values);
}
const OPERATION_STATUS_MATRIX = Object.freeze({
    'proposal.create': resultStatusSet('stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'proposal.createAndApprove': resultStatusSet('stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'proposal.approve': resultStatusSet('stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'proposal.reject': resultStatusSet('stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'proposal.withdraw': resultStatusSet('stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'proposal.expire': resultStatusSet('stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'record.correct': resultStatusSet('stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due', 'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES),
    'record.renew': resultStatusSet('stored', 'unchanged', 'not_found', 'record_purge_due', 'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES),
    'record.changeConflict': resultStatusSet('stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due', 'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES),
    'record.forget': resultStatusSet('unchanged', 'deletion_pending', 'deletion_complete', 'not_found', 'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES),
    'namespace.delete': resultStatusSet('unchanged', 'deletion_pending', 'deletion_complete', 'not_found', 'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES)
});
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function parseHash(value) {
    if (typeof value !== 'string' || !HASHED_REF.test(value))
        return invalidMemoryValue();
    return value;
}
function parseResolveRef(value, commandHash) {
    if (typeof value !== 'string' || !RESOLVE_REF.test(value) ||
        value !== memoryLifecycleResolveRefV1(commandHash))
        return invalidMemoryValue();
    return value;
}
function expectedResultRefPrefix(operation) {
    if (PROPOSAL_RESULT_OPERATIONS.has(operation))
        return 'proposal:';
    return 'memory:';
}
function expectedFixedResultRevision(operation) {
    if (operation === 'proposal.create' || operation === 'proposal.createAndApprove')
        return 1;
    if (operation.startsWith('proposal.'))
        return 2;
    return null;
}
function parseOperationAndStatus(value) {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'commandHash', 'status'], [
        'resultRef', 'resultRevision', 'resultHash', 'receiptHash', 'receipt', 'category',
        'retryable', 'resolveRef', 'committedResultHash'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(input.operation, MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1);
    const status = enumValue(input.status, MEMORY_LIFECYCLE_RESULT_STATUSES_V1);
    if (!OPERATION_STATUS_MATRIX[operation].has(status))
        return invalidMemoryValue();
    return Object.freeze({ operation, status });
}
function parseResultObject(value) {
    const discriminator = parseOperationAndStatus(value);
    const operation = discriminator.operation;
    const status = discriminator.status;
    const baseKeys = ['schemaVersion', 'operation', 'commandHash', 'status'];
    const commandHashInput = inspectMemoryRecord(value, baseKeys, [
        'resultRef', 'resultRevision', 'resultHash', 'receiptHash', 'receipt', 'category',
        'retryable', 'resolveRef', 'committedResultHash'
    ]).commandHash;
    const commandHash = parseHash(commandHashInput);
    const base = { schemaVersion: 1, operation, commandHash };
    if (status === 'stored' || status === 'unchanged') {
        if (DELETION_OPERATIONS.has(operation)) {
            if (status !== 'unchanged')
                return invalidMemoryValue();
            const input = inspectMemoryRecord(value, [...baseKeys, 'receipt']);
            const receipt = parseDeletionMutationReceiptV1(input.receipt);
            const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace';
            if (receipt.operation !== expectedReceiptOperation)
                return invalidMemoryValue();
            return Object.freeze({ ...base, status, receipt });
        }
        const input = inspectMemoryRecord(value, [
            ...baseKeys, 'resultRef', 'resultRevision', 'resultHash', 'receiptHash'
        ]);
        const resultRevision = parseMemoryLifecyclePositiveIntegerV1(input.resultRevision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions);
        const fixedRevision = expectedFixedResultRevision(operation);
        if (fixedRevision !== null && resultRevision !== fixedRevision)
            return invalidMemoryValue();
        return Object.freeze({
            ...base,
            status,
            resultRef: parseMemoryLifecycleHashedRefV1(input.resultRef, expectedResultRefPrefix(operation)),
            resultRevision,
            resultHash: parseMemoryLifecycleHashV1(input.resultHash),
            receiptHash: parseMemoryLifecycleHashV1(input.receiptHash)
        });
    }
    if (status === 'deletion_pending' || status === 'deletion_complete') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'receipt']);
        const receipt = parseDeletionMutationReceiptV1(input.receipt);
        const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace';
        if (receipt.operation !== expectedReceiptOperation)
            return invalidMemoryValue();
        return Object.freeze({ ...base, status, receipt });
    }
    if (status === 'denied') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category']);
        return Object.freeze({
            ...base,
            status,
            category: enumValue(input.category, ['access', 'authority'])
        });
    }
    if (status === 'conflict') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category']);
        return Object.freeze({
            ...base,
            status,
            category: enumValue(input.category, ['revision', 'generation', 'idempotency'])
        });
    }
    if (status === 'capacity') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category']);
        return Object.freeze({
            ...base,
            status,
            category: enumValue(input.category, [
                'pending_proposals', 'active_records', 'retained_revisions', 'namespaces',
                'canonical_bytes', 'outbox_records', 'outbox_bytes', 'audit_records',
                'audit_bytes', 'command_ledger', 'maintenance_capacity', 'ledger_capacity'
            ])
        });
    }
    if (status === 'corrupt') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category']);
        return Object.freeze({
            ...base,
            status,
            category: enumValue(input.category, ['canonical_data', 'adapter_contract'])
        });
    }
    if (status === 'unavailable') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category', 'retryable']);
        if (typeof input.retryable !== 'boolean')
            return invalidMemoryValue();
        const category = enumValue(input.category, ['busy', 'storage', 'io']);
        if (input.retryable !== (category !== 'storage'))
            return invalidMemoryValue();
        return Object.freeze({
            ...base,
            status,
            category,
            retryable: input.retryable
        });
    }
    if (status === 'committed_after_abort') {
        const deletionOperation = DELETION_OPERATIONS.has(operation);
        const input = inspectMemoryRecord(value, [...baseKeys, 'resolveRef', 'committedResultHash'], deletionOperation ? ['receipt'] : []);
        const receipt = deletionOperation && input.receipt !== undefined
            ? parseDeletionMutationReceiptV1(input.receipt)
            : null;
        if (receipt !== null) {
            const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace';
            if (receipt.operation !== expectedReceiptOperation)
                return invalidMemoryValue();
        }
        return Object.freeze({
            ...base,
            status,
            resolveRef: parseResolveRef(input.resolveRef, commandHash),
            committedResultHash: parseMemoryLifecycleHashV1(input.committedResultHash),
            ...(receipt === null ? {} : { receipt })
        });
    }
    if (status === 'resolve_required') {
        const input = inspectMemoryRecord(value, [...baseKeys, 'category', 'resolveRef']);
        if (input.category !== 'outcome_unknown')
            return invalidMemoryValue();
        return Object.freeze({
            ...base,
            status,
            category: 'outcome_unknown',
            resolveRef: parseResolveRef(input.resolveRef, commandHash)
        });
    }
    inspectMemoryRecord(value, baseKeys);
    return Object.freeze({ ...base, status });
}
function assertResultWireLimit(result) {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes)
        return invalidMemoryValue();
    return result;
}
function isLedgerStableResult(result) {
    return result.status === 'stored' || result.status === 'unchanged' ||
        result.status === 'deletion_pending' || result.status === 'deletion_complete' ||
        result.status === 'not_found' || result.status === 'opaque_not_applied' ||
        result.status === 'already_decided' || result.status === 'proposal_expired' ||
        result.status === 'record_expired' || result.status === 'record_purge_due' ||
        result.status === 'history_limit' ||
        (result.status === 'conflict' && result.category !== 'idempotency');
}
function parseLedgerStableResultObject(value) {
    const result = assertResultWireLimit(parseResultObject(value));
    if (!isLedgerStableResult(result))
        return invalidMemoryValue();
    return result;
}
export function createMemoryLifecycleResultV1(value) {
    return assertResultWireLimit(parseResultObject(value));
}
export function parseMemoryLifecycleResultV1(value) {
    return assertResultWireLimit(parseResultObject(value));
}
export function createMemoryLifecycleStableResultV1(value) {
    return parseLedgerStableResultObject(value);
}
export function parseMemoryLifecycleStableResultV1(value) {
    return parseLedgerStableResultObject(value);
}
export function encodeMemoryLifecycleStableResultWireV1(value) {
    const wire = JSON.stringify(parseLedgerStableResultObject(value));
    if (Buffer.byteLength(wire, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes)
        return invalidMemoryValue();
    return wire;
}
export function decodeMemoryLifecycleStableResultWireV1(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes)
        return invalidMemoryValue();
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const result = parseLedgerStableResultObject(value);
    if (JSON.stringify(result) !== raw)
        return invalidMemoryValue();
    return result;
}
export function memoryLifecycleStableResultHashV1(value) {
    const wire = typeof value === 'string'
        ? encodeMemoryLifecycleStableResultWireV1(decodeMemoryLifecycleStableResultWireV1(value))
        : encodeMemoryLifecycleStableResultWireV1(value);
    return memoryLifecycleDomainHashV1(MEMORY_LIFECYCLE_STABLE_RESULT_HASH_DOMAIN_V1, wire);
}
export function memoryLifecycleResolveRefV1(commandHashValue) {
    const commandHash = parseHash(commandHashValue);
    return `resolve:${memoryLifecycleDomainHashV1(MEMORY_LIFECYCLE_RESOLVE_REF_HASH_DOMAIN_V1, commandHash)}`;
}
export function memoryLifecycleResultIsLedgerStableV1(value) {
    try {
        if (typeof value === 'string') {
            decodeMemoryLifecycleStableResultWireV1(value);
            return true;
        }
        return isLedgerStableResult(parseMemoryLifecycleResultV1(value));
    }
    catch {
        return false;
    }
}
