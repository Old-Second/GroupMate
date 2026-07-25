import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
const MEMORY_ID = /^memory:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const STALE = Object.freeze({ status: 'stale' });
const DENIED = Object.freeze({ status: 'denied' });
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });
const ABORTED = Object.freeze({ status: 'aborted' });
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function fixedId(value, pattern) {
    if (typeof value !== 'string' || !pattern.test(value))
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
function dataFunction(value, name) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
        return invalidMemoryValue();
    }
    let current = value;
    while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor !== undefined) {
            if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
                utilTypes.isProxy(descriptor.value))
                return invalidMemoryValue();
            return descriptor.value;
        }
        current = Object.getPrototypeOf(current);
    }
    return invalidMemoryValue();
}
function parseIdentity(value) {
    const input = inspectMemoryRecord(value, [
        'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision', 'revisionHash'
    ]);
    return Object.freeze({
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        memoryId: fixedId(input.memoryId, MEMORY_ID),
        memoryRevision: positiveInteger(input.memoryRevision),
        revisionHash: fixedId(input.revisionHash, HASH)
    });
}
function parseRequest(value) {
    const input = inspectMemoryRecord(value, ['capability', 'identity']);
    if (input.capability === null || typeof input.capability !== 'object' ||
        utilTypes.isProxy(input.capability))
        return invalidMemoryValue();
    return Object.freeze({
        capability: input.capability,
        identity: parseIdentity(input.identity)
    });
}
function parseVerification(value) {
    const input = inspectMemoryRecord(value, ['status']);
    if (input.status === 'current')
        return Object.freeze({ status: 'current' });
    if (input.status === 'stale')
        return STALE;
    if (input.status === 'unavailable')
        return UNAVAILABLE;
    if (input.status === 'aborted')
        return ABORTED;
    return invalidMemoryValue();
}
function sameHead(left, right) {
    return left.namespaceRef === right.namespaceRef &&
        left.namespaceGeneration === right.namespaceGeneration &&
        left.memoryId === right.memoryId && left.revision === right.revision &&
        left.contentHash === right.contentHash;
}
function headFromResult(value) {
    return value.status === 'found' && 'head' in value ? value.head : null;
}
function recordFromResult(value) {
    return value.status === 'found' && 'record' in value ? value.record : null;
}
function sourceFailure(value) {
    if (value.status === 'aborted')
        return ABORTED;
    if (value.status === 'corrupt' || value.status === 'unavailable')
        return UNAVAILABLE;
    return STALE;
}
function verificationFailure(value) {
    if (value.status === 'current')
        return null;
    if (value.status === 'aborted')
        return ABORTED;
    if (value.status === 'unavailable')
        return UNAVAILABLE;
    return STALE;
}
function isAborted(signal) {
    return signal !== undefined && signal.aborted;
}
export function createMemoryCanonicalRehydratorV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, ['source', 'verifier', 'now']);
    if (typeof options.now !== 'function' || utilTypes.isProxy(options.now)) {
        return invalidMemoryValue();
    }
    const now = options.now;
    const sourceExecute = dataFunction(options.source, 'execute');
    const verify = dataFunction(options.verifier, 'verify');
    const rehydrate = async (requestValue, signal) => {
        if (isAborted(signal))
            return ABORTED;
        const request = parseRequest(requestValue);
        let readAt;
        try {
            readAt = canonicalInstant(Reflect.apply(now, undefined, []));
        }
        catch {
            return UNAVAILABLE;
        }
        if (!memoryAccessCapabilityAllowsV1(request.capability, request.identity.namespaceRef, readAt))
            return DENIED;
        let verified;
        try {
            verified = parseVerification(await Reflect.apply(verify, options.verifier, [request.identity, signal]));
        }
        catch {
            return isAborted(signal) ? ABORTED : UNAVAILABLE;
        }
        const firstFailure = verificationFailure(verified);
        if (firstFailure !== null)
            return firstFailure;
        const headResult = await Reflect.apply(sourceExecute, options.source, [{
                schemaVersion: 1,
                operation: 'head.get',
                namespaceRef: request.identity.namespaceRef,
                memoryId: request.identity.memoryId
            }, signal]);
        const head = headFromResult(headResult);
        if (head === null)
            return sourceFailure(headResult);
        if (head.namespaceGeneration !== request.identity.namespaceGeneration ||
            head.revision !== request.identity.memoryRevision)
            return STALE;
        const recordResult = await Reflect.apply(sourceExecute, options.source, [{
                schemaVersion: 1,
                operation: 'record.getExact',
                head
            }, signal]);
        const record = recordFromResult(recordResult);
        if (record === null)
            return sourceFailure(recordResult);
        if (record.namespaceRef !== request.identity.namespaceRef ||
            record.namespaceGeneration !== request.identity.namespaceGeneration ||
            record.memoryId !== request.identity.memoryId ||
            record.revision !== request.identity.memoryRevision)
            return UNAVAILABLE;
        try {
            verified = parseVerification(await Reflect.apply(verify, options.verifier, [request.identity, signal]));
        }
        catch {
            return isAborted(signal) ? ABORTED : UNAVAILABLE;
        }
        const secondFailure = verificationFailure(verified);
        if (secondFailure !== null)
            return secondFailure;
        const confirmedResult = await Reflect.apply(sourceExecute, options.source, [{
                schemaVersion: 1,
                operation: 'head.get',
                namespaceRef: request.identity.namespaceRef,
                memoryId: request.identity.memoryId
            }, signal]);
        const confirmed = headFromResult(confirmedResult);
        if (confirmed === null)
            return sourceFailure(confirmedResult);
        if (!sameHead(head, confirmed))
            return STALE;
        if (isAborted(signal))
            return ABORTED;
        let completedAt;
        try {
            completedAt = canonicalInstant(Reflect.apply(now, undefined, []));
        }
        catch {
            return UNAVAILABLE;
        }
        if (!memoryAccessCapabilityAllowsV1(request.capability, request.identity.namespaceRef, completedAt))
            return DENIED;
        return Object.freeze({
            status: 'found',
            record,
            revisionHash: request.identity.revisionHash
        });
    };
    return Object.freeze({ rehydrate });
}
