import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
import { memoryCanonicalTextWithinLimits } from './memory-resource-limits.js';
export const MEMORY_LEXICAL_SEARCH_LIMITS_V1 = Object.freeze({
    namespaces: 4,
    hits: 24,
    queryUtf8Bytes: 4 * 1_024,
    queryCodePoints: 2_000,
    opaqueRefAsciiBytes: 128
});
const MEMORY_ID = /^memory:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const MEMORY_LEXICAL_BODY_HASH_DOMAIN_V1 = 'groupmate.memory.lexical-body.v1';
const STATES = Object.freeze(['fresh', 'stale', 'rebuilding']);
const ABORTED = Object.freeze({ status: 'aborted' });
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });
function positiveInteger(value, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        value > maximum || Object.is(value, -0))
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
function fixedAscii(value, pattern) {
    if (typeof value !== 'string' || value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > MEMORY_LEXICAL_SEARCH_LIMITS_V1.opaqueRefAsciiBytes ||
        !/^[\x20-\x7e]+$/.test(value) || (pattern !== undefined && !pattern.test(value))) {
        return invalidMemoryValue();
    }
    return value;
}
export function memoryLexicalBodyHashV1(value) {
    if (typeof value !== 'string' || value.length === 0)
        return invalidMemoryValue();
    return createHash('sha256')
        .update(MEMORY_LEXICAL_BODY_HASH_DOMAIN_V1, 'utf8')
        .update('\0', 'utf8')
        .update(value, 'utf8')
        .digest('hex');
}
export function parseMemoryLexicalSearchRequestV1(value) {
    const input = inspectMemoryRecord(value, ['namespaceRefs', 'queryText', 'maxHits']);
    const namespaceRefs = inspectMemoryArray(input.namespaceRefs, MEMORY_LEXICAL_SEARCH_LIMITS_V1.namespaces).map(parseMemoryNamespaceRefV1);
    if (namespaceRefs.length === 0 || new Set(namespaceRefs).size !== namespaceRefs.length ||
        !memoryCanonicalTextWithinLimits(input.queryText, MEMORY_LEXICAL_SEARCH_LIMITS_V1.queryUtf8Bytes, MEMORY_LEXICAL_SEARCH_LIMITS_V1.queryCodePoints) || input.queryText.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        namespaceRefs: Object.freeze(namespaceRefs),
        queryText: input.queryText,
        maxHits: positiveInteger(input.maxHits, MEMORY_LEXICAL_SEARCH_LIMITS_V1.hits)
    });
}
function parseHit(value, maximumRank) {
    const input = inspectMemoryRecord(value, [
        'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision',
        'revisionHash', 'bodyHash', 'updatedAt', 'exactMatch', 'lexicalRank', 'bm25'
    ]);
    if (typeof input.exactMatch !== 'boolean' || typeof input.bm25 !== 'number' ||
        !Number.isFinite(input.bm25) || Object.is(input.bm25, -0))
        return invalidMemoryValue();
    return Object.freeze({
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration, Number.MAX_SAFE_INTEGER),
        memoryId: fixedAscii(input.memoryId, MEMORY_ID),
        memoryRevision: positiveInteger(input.memoryRevision, Number.MAX_SAFE_INTEGER),
        revisionHash: fixedAscii(input.revisionHash, HASH),
        bodyHash: fixedAscii(input.bodyHash, HASH),
        updatedAt: canonicalInstant(input.updatedAt),
        exactMatch: input.exactMatch,
        lexicalRank: positiveInteger(input.lexicalRank, maximumRank),
        bm25: input.bm25
    });
}
export function parseMemoryLexicalSearchResultV1(value, request) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['state', 'watermark', 'hits']);
    if (discriminator.status === 'unavailable') {
        inspectMemoryRecord(value, ['status']);
        return UNAVAILABLE;
    }
    if (discriminator.status === 'aborted') {
        inspectMemoryRecord(value, ['status']);
        return ABORTED;
    }
    if (discriminator.status !== 'completed')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, ['status', 'state', 'watermark', 'hits']);
    if (typeof input.state !== 'string' || !STATES.includes(input.state)) {
        return invalidMemoryValue();
    }
    const hits = inspectMemoryArray(input.hits, request.maxHits)
        .map(hit => parseHit(hit, request.maxHits));
    const namespaces = new Set(request.namespaceRefs);
    if (hits.some(hit => !namespaces.has(hit.namespaceRef)) ||
        new Set(hits.map(hit => `${hit.namespaceRef}\0${hit.memoryId}`)).size !== hits.length ||
        new Set(hits.map(hit => hit.lexicalRank)).size !== hits.length ||
        hits.some((_, index) => !hits.some(hit => hit.lexicalRank === index + 1))) {
        return invalidMemoryValue();
    }
    const watermark = input.watermark === null ? null : fixedAscii(input.watermark);
    return Object.freeze({
        status: 'completed',
        state: input.state,
        watermark,
        hits: Object.freeze(hits)
    });
}
function adapterSearch(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
        return invalidMemoryValue();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'search');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
        return invalidMemoryValue();
    }
    return descriptor.value;
}
function isAborted(signal) {
    return signal !== undefined && signal.aborted;
}
export function createMemoryLexicalIndexPortV1(adapter) {
    const searchAdapter = adapterSearch(adapter);
    const search = async (requestValue, signal) => {
        if (isAborted(signal))
            return ABORTED;
        const request = parseMemoryLexicalSearchRequestV1(requestValue);
        let raw;
        try {
            raw = await Reflect.apply(searchAdapter, adapter, [request, signal]);
        }
        catch {
            return isAborted(signal) ? ABORTED : UNAVAILABLE;
        }
        if (isAborted(signal))
            return ABORTED;
        try {
            return parseMemoryLexicalSearchResultV1(raw, request);
        }
        catch {
            return UNAVAILABLE;
        }
    };
    return Object.freeze({ search });
}
