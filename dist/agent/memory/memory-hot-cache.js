import { types as utilTypes } from 'node:util';
import { encodeCanonicalMemoryRecordV1, parseCanonicalMemoryRecordV1 } from './memory-canonical-wire.js';
import { inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
export const MEMORY_HOT_CACHE_ACCOUNTING_V1 = Object.freeze({
    staticBytes: 357,
    recordFieldBytes: 64,
    indexEntryBytes: 80,
    headMetadataBytes: 147,
    generationMetadataBytes: 82
});
const REQUEST_OPERATIONS = [
    'record.get',
    'record.put',
    'record.invalidate',
    'namespace.invalidate',
    'usage.get'
];
const REQUEST_FIELDS = [
    'head',
    'record',
    'namespaceRef',
    'namespaceGeneration',
    'memoryId',
    'deletedRevision',
    'deletedGeneration',
    'nextGeneration'
];
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function nonnegativeInteger(value, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function memoryId(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !value.startsWith('memory:') || value.length === 'memory:'.length) {
        return invalidMemoryValue();
    }
    return value;
}
function contentHash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseHead(value) {
    const input = inspectMemoryRecord(value, [
        'namespaceRef',
        'namespaceGeneration',
        'memoryId',
        'revision',
        'contentHash'
    ]);
    return Object.freeze({
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        memoryId: memoryId(input.memoryId),
        revision: positiveInteger(input.revision),
        contentHash: contentHash(input.contentHash)
    });
}
function parseRequest(value) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'operation'], REQUEST_FIELDS);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(discriminator.operation, REQUEST_OPERATIONS);
    if (operation === 'record.get') {
        const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'head']);
        return Object.freeze({ schemaVersion: 1, operation, head: parseHead(input.head) });
    }
    if (operation === 'record.put') {
        const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'record']);
        const record = parseCanonicalMemoryRecordV1(input.record);
        encodeCanonicalMemoryRecordV1(record);
        return Object.freeze({ schemaVersion: 1, operation, record });
    }
    if (operation === 'record.invalidate') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion',
            'operation',
            'namespaceRef',
            'namespaceGeneration',
            'memoryId',
            'deletedRevision'
        ]);
        return Object.freeze({
            schemaVersion: 1,
            operation,
            namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
            namespaceGeneration: positiveInteger(input.namespaceGeneration),
            memoryId: memoryId(input.memoryId),
            deletedRevision: positiveInteger(input.deletedRevision)
        });
    }
    if (operation === 'namespace.invalidate') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion',
            'operation',
            'namespaceRef',
            'deletedGeneration',
            'nextGeneration'
        ]);
        const deletedGeneration = positiveInteger(input.deletedGeneration);
        const nextGeneration = positiveInteger(input.nextGeneration);
        if (nextGeneration !== deletedGeneration + 1)
            return invalidMemoryValue();
        return Object.freeze({
            schemaVersion: 1,
            operation,
            namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
            deletedGeneration,
            nextGeneration
        });
    }
    inspectMemoryRecord(value, ['schemaVersion', 'operation']);
    return Object.freeze({ schemaVersion: 1, operation });
}
function recordMatchesHead(record, head) {
    return record.namespaceRef === head.namespaceRef &&
        record.namespaceGeneration === head.namespaceGeneration &&
        record.memoryId === head.memoryId &&
        record.revision === head.revision &&
        record.contentHash === head.contentHash;
}
function parseUsage(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion',
        'recordCount',
        'generationCount',
        'recordEntryBytes',
        'expiryIndexBytes',
        'lruIndexBytes',
        'dynamicMetadataBytes',
        'staticBytes',
        'totalLogicalBytes'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const result = Object.freeze({
        schemaVersion: 1,
        recordCount: nonnegativeInteger(input.recordCount, MEMORY_RESOURCE_LIMITS.redisHotRecords),
        generationCount: nonnegativeInteger(input.generationCount, MEMORY_RESOURCE_LIMITS.deploymentNamespaces),
        recordEntryBytes: nonnegativeInteger(input.recordEntryBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
        expiryIndexBytes: nonnegativeInteger(input.expiryIndexBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
        lruIndexBytes: nonnegativeInteger(input.lruIndexBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
        dynamicMetadataBytes: nonnegativeInteger(input.dynamicMetadataBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
        staticBytes: nonnegativeInteger(input.staticBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
        totalLogicalBytes: nonnegativeInteger(input.totalLogicalBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes)
    });
    if (result.staticBytes !== MEMORY_HOT_CACHE_ACCOUNTING_V1.staticBytes ||
        result.expiryIndexBytes !== result.recordCount *
            MEMORY_HOT_CACHE_ACCOUNTING_V1.indexEntryBytes ||
        result.lruIndexBytes !== result.recordCount *
            MEMORY_HOT_CACHE_ACCOUNTING_V1.indexEntryBytes ||
        result.dynamicMetadataBytes !== result.recordCount *
            MEMORY_HOT_CACHE_ACCOUNTING_V1.headMetadataBytes + result.generationCount *
            MEMORY_HOT_CACHE_ACCOUNTING_V1.generationMetadataBytes ||
        result.recordEntryBytes < result.recordCount *
            MEMORY_HOT_CACHE_ACCOUNTING_V1.recordFieldBytes ||
        result.recordEntryBytes > result.recordCount *
            (MEMORY_HOT_CACHE_ACCOUNTING_V1.recordFieldBytes +
                MEMORY_RESOURCE_LIMITS.recordWireBytes) ||
        result.totalLogicalBytes !==
            result.recordEntryBytes + result.expiryIndexBytes + result.lruIndexBytes +
                result.dynamicMetadataBytes + result.staticBytes)
        return invalidMemoryValue();
    return result;
}
function parseResult(value, request, signalAborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['record', 'reason', 'value']);
    const status = discriminator.status;
    if (status === 'hit') {
        if (request.operation !== 'record.get')
            return invalidMemoryValue();
        const input = inspectMemoryRecord(value, ['status', 'record']);
        const record = parseCanonicalMemoryRecordV1(input.record);
        encodeCanonicalMemoryRecordV1(record);
        if (!recordMatchesHead(record, request.head))
            return invalidMemoryValue();
        return Object.freeze({ status, record });
    }
    if (status === 'miss') {
        if (request.operation !== 'record.get')
            return invalidMemoryValue();
        const input = inspectMemoryRecord(value, ['status', 'reason']);
        return Object.freeze({
            status,
            reason: enumValue(input.reason, [
                'not_found', 'expired', 'stale', 'mismatch', 'corrupt'
            ])
        });
    }
    if (status === 'stored') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'record.put')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'unchanged') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'record.put' &&
            request.operation !== 'record.invalidate' &&
            request.operation !== 'namespace.invalidate')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'invalidated') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'record.invalidate' &&
            request.operation !== 'namespace.invalidate')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'skipped') {
        const input = inspectMemoryRecord(value, ['status', 'reason']);
        if (request.operation === 'namespace.invalidate') {
            if (input.reason !== 'capacity')
                return invalidMemoryValue();
            return Object.freeze({ status, reason: 'capacity' });
        }
        if (request.operation !== 'record.put')
            return invalidMemoryValue();
        return Object.freeze({
            status,
            reason: enumValue(input.reason, ['capacity', 'expired', 'stale'])
        });
    }
    if (status === 'usage') {
        if (request.operation !== 'usage.get')
            return invalidMemoryValue();
        const input = inspectMemoryRecord(value, ['status', 'value']);
        return Object.freeze({ status, value: parseUsage(input.value) });
    }
    if (status === 'unavailable') {
        inspectMemoryRecord(value, ['status']);
        return UNAVAILABLE_RESULT;
    }
    if (status === 'aborted') {
        inspectMemoryRecord(value, ['status']);
        if (!signalAborted)
            return invalidMemoryValue();
        return ABORTED_RESULT;
    }
    return invalidMemoryValue();
}
const UNAVAILABLE_RESULT = Object.freeze({ status: 'unavailable' });
const ABORTED_RESULT = Object.freeze({ status: 'aborted' });
export function createMemoryHotCachePortV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, ['execute']);
    if (typeof options.execute !== 'function' || utilTypes.isProxy(options.execute)) {
        return invalidMemoryValue();
    }
    const adapterExecute = options.execute;
    const execute = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const request = parseRequest(requestValue);
            if (signalScope.isAborted())
                return ABORTED_RESULT;
            let result;
            try {
                result = await Reflect.apply(adapterExecute, undefined, [request, signalScope.signal]);
            }
            catch {
                return UNAVAILABLE_RESULT;
            }
            try {
                return parseResult(result, request, signalScope.isAborted());
            }
            catch {
                return UNAVAILABLE_RESULT;
            }
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
