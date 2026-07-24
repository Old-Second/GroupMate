import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { encodeCanonicalMemoryRecordV1, parseCanonicalMemoryRecordV1 } from './memory-canonical-wire.js';
import { inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
const SOURCE_OPERATIONS = ['namespace.get', 'head.get', 'record.getExact'];
const SOURCE_REQUEST_FIELDS = ['namespaceRef', 'memoryId', 'head'];
const ADAPTER_CONTRACT_RESULT = Object.freeze({
    status: 'corrupt',
    category: 'adapter_contract'
});
const ADAPTER_IO_RESULT = Object.freeze({
    status: 'unavailable',
    category: 'io',
    retryable: true
});
const ABORTED_RESULT = Object.freeze({ status: 'aborted' });
const NOT_FOUND_RESULT = Object.freeze({ status: 'not_found' });
const CONFLICT_RESULT = Object.freeze({ status: 'conflict' });
const DENIED_RESULT = Object.freeze({ status: 'denied' });
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        Object.is(value, -0))
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
function canonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        return invalidMemoryValue();
    }
    return value;
}
function parseHead(value) {
    const input = inspectMemoryRecord(value, [
        'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision', 'contentHash'
    ]);
    return Object.freeze({
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        memoryId: memoryId(input.memoryId),
        revision: positiveInteger(input.revision),
        contentHash: contentHash(input.contentHash)
    });
}
function parseSourceRequest(value) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'operation'], SOURCE_REQUEST_FIELDS);
    if (discriminator.schemaVersion !== 1 ||
        typeof discriminator.operation !== 'string' ||
        !SOURCE_OPERATIONS.includes(discriminator.operation)) {
        return invalidMemoryValue();
    }
    if (discriminator.operation === 'namespace.get') {
        const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'namespaceRef']);
        return Object.freeze({
            schemaVersion: 1,
            operation: 'namespace.get',
            namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef)
        });
    }
    if (discriminator.operation === 'head.get') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion', 'operation', 'namespaceRef', 'memoryId'
        ]);
        return Object.freeze({
            schemaVersion: 1,
            operation: 'head.get',
            namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
            memoryId: memoryId(input.memoryId)
        });
    }
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'head']);
    return Object.freeze({
        schemaVersion: 1,
        operation: 'record.getExact',
        head: parseHead(input.head)
    });
}
function retryableCategory(category, retryable) {
    if (typeof retryable !== 'boolean' || retryable !== (category !== 'storage')) {
        return invalidMemoryValue();
    }
    return retryable;
}
function parseSourceResult(value, request, signalAborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], [
        'namespaceGeneration', 'head', 'record', 'category', 'retryable'
    ]);
    const status = discriminator.status;
    if (status === 'found') {
        if (request.operation === 'namespace.get') {
            const input = inspectMemoryRecord(value, ['status', 'namespaceGeneration']);
            return Object.freeze({
                status,
                namespaceGeneration: positiveInteger(input.namespaceGeneration)
            });
        }
        if (request.operation === 'head.get') {
            const input = inspectMemoryRecord(value, ['status', 'head']);
            const head = parseHead(input.head);
            if (head.namespaceRef !== request.namespaceRef || head.memoryId !== request.memoryId) {
                return invalidMemoryValue();
            }
            return Object.freeze({ status, head });
        }
        const input = inspectMemoryRecord(value, ['status', 'record']);
        const record = parseCanonicalMemoryRecordV1(input.record);
        encodeCanonicalMemoryRecordV1(record);
        if (!recordMatchesHead(record, request.head))
            return invalidMemoryValue();
        return Object.freeze({ status, record });
    }
    if (status === 'absent') {
        if (request.operation !== 'head.get')
            return invalidMemoryValue();
        const input = inspectMemoryRecord(value, ['status', 'namespaceGeneration']);
        return Object.freeze({
            status,
            namespaceGeneration: positiveInteger(input.namespaceGeneration)
        });
    }
    if (status === 'expired') {
        if (request.operation === 'head.get') {
            const input = inspectMemoryRecord(value, ['status', 'head']);
            const head = parseHead(input.head);
            if (head.namespaceRef !== request.namespaceRef || head.memoryId !== request.memoryId) {
                return invalidMemoryValue();
            }
            return Object.freeze({ status, head });
        }
        if (request.operation !== 'record.getExact')
            return invalidMemoryValue();
        inspectMemoryRecord(value, ['status']);
        return Object.freeze({ status });
    }
    if (status === 'not_found') {
        inspectMemoryRecord(value, ['status']);
        return Object.freeze({ status });
    }
    if (status === 'stale') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'record.getExact')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        if (input.category !== 'canonical_data')
            return invalidMemoryValue();
        return Object.freeze({ status, category: 'canonical_data' });
    }
    if (status === 'unavailable') {
        const input = inspectMemoryRecord(value, ['status', 'category', 'retryable']);
        if (input.category !== 'busy' && input.category !== 'storage' && input.category !== 'io') {
            return invalidMemoryValue();
        }
        return Object.freeze({
            status,
            category: input.category,
            retryable: retryableCategory(input.category, input.retryable)
        });
    }
    if (status === 'aborted') {
        inspectMemoryRecord(value, ['status']);
        if (!signalAborted)
            return invalidMemoryValue();
        return ABORTED_RESULT;
    }
    return invalidMemoryValue();
}
function recordMatchesHead(record, head) {
    return record.namespaceRef === head.namespaceRef &&
        record.namespaceGeneration === head.namespaceGeneration &&
        record.memoryId === head.memoryId &&
        record.revision === head.revision &&
        record.contentHash === head.contentHash;
}
function sameHead(left, right) {
    return left.namespaceRef === right.namespaceRef &&
        left.namespaceGeneration === right.namespaceGeneration &&
        left.memoryId === right.memoryId &&
        left.revision === right.revision &&
        left.contentHash === right.contentHash;
}
function foundHeadValue(result) {
    return result.status === 'found' && 'head' in result ? result.head : null;
}
function foundRecordValue(result) {
    return result.status === 'found' && 'record' in result ? result.record : null;
}
function portExecute(value) {
    const input = inspectMemoryRecord(value, ['execute']);
    if (typeof input.execute !== 'function' || utilTypes.isProxy(input.execute)) {
        return invalidMemoryValue();
    }
    return input.execute;
}
export function createMemoryHeadSourcePortV1(optionsValue) {
    const adapterExecute = portExecute(optionsValue);
    const execute = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const request = parseSourceRequest(requestValue);
            if (signalScope.isAborted())
                return ABORTED_RESULT;
            let result;
            try {
                result = await Reflect.apply(adapterExecute, undefined, [request, signalScope.signal]);
            }
            catch {
                return signalScope.isAborted() ? ABORTED_RESULT : ADAPTER_IO_RESULT;
            }
            if (signalScope.isAborted())
                return ABORTED_RESULT;
            try {
                return parseSourceResult(result, request, signalScope.isAborted());
            }
            catch {
                return ADAPTER_CONTRACT_RESULT;
            }
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
function parseReadRequest(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'capability', 'namespaceRef', 'memoryId'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        capability: input.capability,
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        memoryId: memoryId(input.memoryId)
    });
}
function sourceTerminal(result) {
    if (result.status === 'not_found' || result.status === 'absent' ||
        result.status === 'expired')
        return NOT_FOUND_RESULT;
    if (result.status === 'corrupt' || result.status === 'unavailable' ||
        result.status === 'aborted')
        return result;
    return null;
}
export function createMemoryReadThroughV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, ['now', 'source', 'cache']);
    if (typeof options.now !== 'function' || utilTypes.isProxy(options.now)) {
        return invalidMemoryValue();
    }
    const now = options.now;
    const sourceExecute = portExecute(options.source);
    const cacheExecute = portExecute(options.cache);
    const execute = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const request = parseReadRequest(requestValue);
            if (signalScope.isAborted())
                return ABORTED_RESULT;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                let attemptTime;
                try {
                    attemptTime = canonicalInstant(Reflect.apply(now, undefined, []));
                }
                catch {
                    return invalidMemoryValue();
                }
                if (!memoryAccessCapabilityAllowsV1(request.capability, request.namespaceRef, attemptTime))
                    return DENIED_RESULT;
                const headResult = await Reflect.apply(sourceExecute, options.source, [{
                        schemaVersion: 1,
                        operation: 'head.get',
                        namespaceRef: request.namespaceRef,
                        memoryId: request.memoryId
                    }, signalScope.signal]);
                const canonicalHead = foundHeadValue(headResult);
                if (canonicalHead === null) {
                    const terminal = sourceTerminal(headResult);
                    if (terminal !== null)
                        return terminal;
                    return ADAPTER_CONTRACT_RESULT;
                }
                const cached = await Reflect.apply(cacheExecute, options.cache, [{
                        schemaVersion: 1,
                        operation: 'record.get',
                        head: canonicalHead
                    }, signalScope.signal]);
                if (signalScope.isAborted())
                    return ABORTED_RESULT;
                if (cached.status === 'aborted')
                    return ABORTED_RESULT;
                let record = null;
                let source = 'canonical';
                if (cached.status === 'hit') {
                    record = cached.record;
                    source = 'hot';
                }
                else {
                    const canonical = await Reflect.apply(sourceExecute, options.source, [{
                            schemaVersion: 1,
                            operation: 'record.getExact',
                            head: canonicalHead
                        }, signalScope.signal]);
                    if (signalScope.isAborted())
                        return ABORTED_RESULT;
                    if (canonical.status === 'stale') {
                        if (attempt === 0)
                            continue;
                        return CONFLICT_RESULT;
                    }
                    const canonicalRecord = foundRecordValue(canonical);
                    if (canonicalRecord === null) {
                        const terminal = sourceTerminal(canonical);
                        if (terminal !== null)
                            return terminal;
                        return ADAPTER_CONTRACT_RESULT;
                    }
                    record = canonicalRecord;
                    const refill = await Reflect.apply(cacheExecute, options.cache, [{
                            schemaVersion: 1,
                            operation: 'record.put',
                            record
                        }, signalScope.signal]);
                    if (signalScope.isAborted())
                        return ABORTED_RESULT;
                    if (refill.status === 'aborted')
                        return ABORTED_RESULT;
                }
                if (signalScope.isAborted())
                    return ABORTED_RESULT;
                const confirmed = await Reflect.apply(sourceExecute, options.source, [{
                        schemaVersion: 1,
                        operation: 'head.get',
                        namespaceRef: request.namespaceRef,
                        memoryId: request.memoryId
                    }, signalScope.signal]);
                if (signalScope.isAborted())
                    return ABORTED_RESULT;
                const confirmedHead = foundHeadValue(confirmed);
                if (confirmedHead !== null && sameHead(canonicalHead, confirmedHead)) {
                    if (record === null)
                        return ADAPTER_CONTRACT_RESULT;
                    let completedAt;
                    try {
                        completedAt = canonicalInstant(Reflect.apply(now, undefined, []));
                    }
                    catch {
                        return invalidMemoryValue();
                    }
                    if (!memoryAccessCapabilityAllowsV1(request.capability, request.namespaceRef, completedAt))
                        return DENIED_RESULT;
                    if (signalScope.isAborted())
                        return ABORTED_RESULT;
                    return Object.freeze({ status: 'found', source, record });
                }
                if (confirmed.status === 'corrupt' || confirmed.status === 'unavailable' ||
                    confirmed.status === 'aborted')
                    return confirmed;
                if (attempt === 0)
                    continue;
                return CONFLICT_RESULT;
            }
            return CONFLICT_RESULT;
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
