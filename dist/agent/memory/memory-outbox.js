import { encodeMemoryOutboxEventV1 } from './memory-codec.js';
import { parseMemoryOutboxEventV1 } from './memory-domain.js';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
const OUTBOX_OPERATIONS = ['claim', 'ack', 'retry', 'usage'];
const OUTBOX_REQUEST_FIELDS = [
    'ownerId', 'limit', 'leaseToken', 'eventId', 'sequence', 'retryAt', 'reasonCode'
];
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LEASE_PATTERN = /^memory-lease:v1:[0-9a-f]{64}$/;
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
function nonnegativeInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
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
function workerId(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !WORKER_ID_PATTERN.test(value))
        return invalidMemoryValue();
    return value;
}
function leaseToken(value) {
    if (typeof value !== 'string' || !LEASE_PATTERN.test(value))
        return invalidMemoryValue();
    return value;
}
function eventId(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !value.startsWith('event:') || value.length === 'event:'.length)
        return invalidMemoryValue();
    return value;
}
function reasonCode(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !WORKER_ID_PATTERN.test(value))
        return invalidMemoryValue();
    return value;
}
function parseMemoryOutboxRequestV1(value, now) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'operation'], OUTBOX_REQUEST_FIELDS);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(discriminator.operation, OUTBOX_OPERATIONS);
    if (operation === 'claim') {
        const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'ownerId', 'limit']);
        return Object.freeze({
            schemaVersion: 1,
            operation,
            ownerId: workerId(input.ownerId),
            limit: positiveInteger(input.limit, MEMORY_RESOURCE_LIMITS.operationBatchRecords)
        });
    }
    if (operation === 'ack') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion', 'operation', 'ownerId', 'leaseToken', 'eventId', 'sequence'
        ]);
        return Object.freeze({
            schemaVersion: 1,
            operation,
            ownerId: workerId(input.ownerId),
            leaseToken: leaseToken(input.leaseToken),
            eventId: eventId(input.eventId),
            sequence: positiveInteger(input.sequence)
        });
    }
    if (operation === 'retry') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion', 'operation', 'ownerId', 'leaseToken', 'eventId', 'sequence',
            'retryAt', 'reasonCode'
        ]);
        const retryAt = canonicalInstant(input.retryAt);
        if (Date.parse(retryAt) < Date.parse(now))
            return invalidMemoryValue();
        return Object.freeze({
            schemaVersion: 1,
            operation,
            ownerId: workerId(input.ownerId),
            leaseToken: leaseToken(input.leaseToken),
            eventId: eventId(input.eventId),
            sequence: positiveInteger(input.sequence),
            retryAt,
            reasonCode: reasonCode(input.reasonCode)
        });
    }
    inspectMemoryRecord(value, ['schemaVersion', 'operation']);
    return Object.freeze({ schemaVersion: 1, operation: 'usage' });
}
function parseOutboxUsage(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'pendingRecords', 'leasedRecords', 'logicalBytes'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        pendingRecords: nonnegativeInteger(input.pendingRecords),
        leasedRecords: nonnegativeInteger(input.leasedRecords),
        logicalBytes: nonnegativeInteger(input.logicalBytes)
    });
}
function parseClaimedResult(value, request, now) {
    const input = inspectMemoryRecord(value, [
        'status', 'ownerId', 'leaseToken', 'leasedUntil', 'events'
    ]);
    if (input.status !== 'claimed' || workerId(input.ownerId) !== request.ownerId) {
        return invalidMemoryValue();
    }
    const leasedUntil = canonicalInstant(input.leasedUntil);
    if (Date.parse(leasedUntil) <= Date.parse(now))
        return invalidMemoryValue();
    const events = inspectMemoryArray(input.events, MEMORY_RESOURCE_LIMITS.operationBatchRecords).map(value => {
        const event = parseMemoryOutboxEventV1(value);
        encodeMemoryOutboxEventV1(event);
        return event;
    });
    if (events.length === 0 || events.length > request.limit ||
        new Set(events.map(event => event.eventId)).size !== events.length ||
        new Set(events.map(event => event.sequence)).size !== events.length ||
        events.some((event, index) => index > 0 && event.sequence <= events[index - 1].sequence)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        status: 'claimed',
        ownerId: request.ownerId,
        leaseToken: leaseToken(input.leaseToken),
        leasedUntil,
        events: Object.freeze(events)
    });
}
function parseMemoryOutboxResultV1(value, request, now, signalAborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], [
        'ownerId', 'leaseToken', 'leasedUntil', 'events', 'value', 'category', 'retryable'
    ]);
    const status = discriminator.status;
    if (status === 'empty') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'claim')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'claimed') {
        if (request.operation !== 'claim')
            return invalidMemoryValue();
        return parseClaimedResult(value, request, now);
    }
    if (status === 'acked') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'ack')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'retried') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'retry')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'lease_conflict') {
        inspectMemoryRecord(value, ['status']);
        if (request.operation !== 'ack' && request.operation !== 'retry')
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    if (status === 'usage') {
        const input = inspectMemoryRecord(value, ['status', 'value']);
        if (request.operation !== 'usage')
            return invalidMemoryValue();
        return Object.freeze({ status, value: parseOutboxUsage(input.value) });
    }
    if (status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status,
            category: enumValue(input.category, ['canonical_data', 'adapter_contract'])
        });
    }
    if (status === 'unavailable') {
        const input = inspectMemoryRecord(value, ['status', 'category', 'retryable']);
        if (typeof input.retryable !== 'boolean')
            return invalidMemoryValue();
        return Object.freeze({
            status,
            category: enumValue(input.category, ['busy', 'storage', 'io']),
            retryable: input.retryable
        });
    }
    if (status === 'aborted') {
        inspectMemoryRecord(value, ['status']);
        if (!signalAborted)
            return invalidMemoryValue();
        return Object.freeze({ status });
    }
    return invalidMemoryValue();
}
function outboxResultNeedsCompletionTime(value) {
    const input = inspectMemoryRecord(value, ['status'], [
        'ownerId', 'leaseToken', 'leasedUntil', 'events', 'value', 'category', 'retryable'
    ]);
    return input.status === 'claimed';
}
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
export function createMemoryOutboxPortV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, ['now', 'execute']);
    if (typeof options.now !== 'function' || typeof options.execute !== 'function') {
        return invalidMemoryValue();
    }
    const now = options.now;
    const adapterExecute = options.execute;
    const execute = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            let currentTime;
            try {
                currentTime = canonicalInstant(Reflect.apply(now, undefined, []));
            }
            catch {
                return invalidMemoryValue();
            }
            const request = parseMemoryOutboxRequestV1(requestValue, currentTime);
            if (signalScope.isAborted())
                return ABORTED_RESULT;
            let adapterResult;
            try {
                adapterResult = await Reflect.apply(adapterExecute, undefined, [
                    request,
                    signalScope.signal
                ]);
            }
            catch {
                return ADAPTER_IO_RESULT;
            }
            let needsCompletionTime;
            try {
                needsCompletionTime = outboxResultNeedsCompletionTime(adapterResult);
            }
            catch {
                return ADAPTER_CONTRACT_RESULT;
            }
            let completedAt = currentTime;
            if (needsCompletionTime) {
                try {
                    completedAt = canonicalInstant(Reflect.apply(now, undefined, []));
                }
                catch {
                    return invalidMemoryValue();
                }
            }
            try {
                return parseMemoryOutboxResultV1(adapterResult, request, completedAt, signalScope.isAborted());
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
