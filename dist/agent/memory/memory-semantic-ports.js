import { types as utilTypes } from 'node:util';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, parseMemoryNamespaceRefV1 } from './memory-namespace.js';
import { memoryCanonicalTextWithinLimits } from './memory-resource-limits.js';
export const MEMORY_SEMANTIC_RESOURCE_LIMITS_V1 = Object.freeze({
    inputs: 32,
    dimensions: 4_096,
    vectorHits: 24,
    rerankCandidates: 12,
    queryUtf8Bytes: 4 * 1_024,
    queryCodePoints: 2_000,
    textUtf8Bytes: 4 * 1_024,
    textCodePoints: 2_000,
    modelVersionAsciiBytes: 128,
    opaqueRefAsciiBytes: 128
});
const MEMORY_ID = /^memory:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const VECTOR_STATES = Object.freeze(['fresh', 'stale', 'rebuilding']);
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });
const ABORTED = Object.freeze({ status: 'aborted' });
function isAborted(signal) {
    return signal !== undefined && signal.aborted;
}
function positiveInteger(value, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function fixedAscii(value, pattern) {
    if (typeof value !== 'string' || value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.opaqueRefAsciiBytes ||
        !/^[\x20-\x7e]+$/.test(value) || (pattern !== undefined && !pattern.test(value))) {
        return invalidMemoryValue();
    }
    return value;
}
function modelVersion(value) {
    const parsed = fixedAscii(value, MODEL_VERSION);
    if (Buffer.byteLength(parsed, 'ascii') >
        MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.modelVersionAsciiBytes)
        return invalidMemoryValue();
    return parsed;
}
function canonicalText(value, maximumUtf8Bytes, maximumCodePoints) {
    if (!memoryCanonicalTextWithinLimits(value, maximumUtf8Bytes, maximumCodePoints) ||
        value.length === 0)
        return invalidMemoryValue();
    return value;
}
function finiteVector(value, dimensions) {
    const input = inspectMemoryArray(value, dimensions);
    if (input.length !== dimensions)
        return invalidMemoryValue();
    const vector = input.map(component => {
        if (typeof component !== 'number' || !Number.isFinite(component) ||
            Object.is(component, -0) || Math.abs(component) > 1_000_000) {
            return invalidMemoryValue();
        }
        return component;
    });
    return Object.freeze(vector);
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
function parseEmbeddingRequest(value) {
    const input = inspectMemoryRecord(value, ['purpose', 'modelVersion', 'dimensions', 'texts']);
    if (input.purpose !== 'query' && input.purpose !== 'document')
        return invalidMemoryValue();
    const texts = inspectMemoryArray(input.texts, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.inputs).map(text => canonicalText(text, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textUtf8Bytes, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textCodePoints));
    if (texts.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        purpose: input.purpose,
        modelVersion: modelVersion(input.modelVersion),
        dimensions: positiveInteger(input.dimensions, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions),
        texts: Object.freeze(texts)
    });
}
function parseEmbeddingResult(value, request) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['modelVersion', 'dimensions', 'vectors']);
    if (discriminator.status === 'unavailable') {
        inspectMemoryRecord(value, ['status']);
        return UNAVAILABLE;
    }
    if (discriminator.status !== 'completed')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, [
        'status', 'modelVersion', 'dimensions', 'vectors'
    ]);
    const parsedModelVersion = modelVersion(input.modelVersion);
    const dimensions = positiveInteger(input.dimensions, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions);
    if (parsedModelVersion !== request.modelVersion || dimensions !== request.dimensions) {
        return invalidMemoryValue();
    }
    const vectors = inspectMemoryArray(input.vectors, request.texts.length)
        .map(vector => finiteVector(vector, dimensions));
    if (vectors.length !== request.texts.length)
        return invalidMemoryValue();
    return Object.freeze({
        status: 'completed',
        modelVersion: parsedModelVersion,
        dimensions,
        vectors: Object.freeze(vectors)
    });
}
function parseVectorSearchRequest(value) {
    const input = inspectMemoryRecord(value, [
        'namespaceRefs', 'modelVersion', 'dimensions', 'queryVector', 'maxHits'
    ]);
    const namespaceRefs = inspectMemoryArray(input.namespaceRefs, 4)
        .map(parseMemoryNamespaceRefV1);
    if (namespaceRefs.length === 0 || new Set(namespaceRefs).size !== namespaceRefs.length) {
        return invalidMemoryValue();
    }
    const dimensions = positiveInteger(input.dimensions, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions);
    return Object.freeze({
        namespaceRefs: Object.freeze(namespaceRefs),
        modelVersion: modelVersion(input.modelVersion),
        dimensions,
        queryVector: finiteVector(input.queryVector, dimensions),
        maxHits: positiveInteger(input.maxHits, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.vectorHits)
    });
}
function parseVectorHit(value, maximumRank) {
    const input = inspectMemoryRecord(value, [
        'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision',
        'revisionHash', 'vectorRank', 'distance'
    ]);
    if (typeof input.distance !== 'number' || !Number.isFinite(input.distance) ||
        input.distance < 0 || Object.is(input.distance, -0))
        return invalidMemoryValue();
    return Object.freeze({
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration, Number.MAX_SAFE_INTEGER),
        memoryId: fixedAscii(input.memoryId, MEMORY_ID),
        memoryRevision: positiveInteger(input.memoryRevision, Number.MAX_SAFE_INTEGER),
        revisionHash: fixedAscii(input.revisionHash, HASH),
        vectorRank: positiveInteger(input.vectorRank, maximumRank),
        distance: input.distance
    });
}
function parseVectorSearchResult(value, request) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['state', 'modelVersion', 'dimensions', 'watermark', 'hits']);
    if (discriminator.status === 'unavailable') {
        inspectMemoryRecord(value, ['status']);
        return UNAVAILABLE;
    }
    if (discriminator.status !== 'completed')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, [
        'status', 'state', 'modelVersion', 'dimensions', 'watermark', 'hits'
    ]);
    if (typeof input.state !== 'string' || !VECTOR_STATES.includes(input.state)) {
        return invalidMemoryValue();
    }
    const parsedModelVersion = modelVersion(input.modelVersion);
    const dimensions = positiveInteger(input.dimensions, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions);
    if (parsedModelVersion !== request.modelVersion || dimensions !== request.dimensions) {
        return invalidMemoryValue();
    }
    const hits = inspectMemoryArray(input.hits, request.maxHits)
        .map(hit => parseVectorHit(hit, request.maxHits));
    const namespaces = new Set(request.namespaceRefs);
    if (hits.some(hit => !namespaces.has(hit.namespaceRef)) ||
        new Set(hits.map(hit => `${hit.namespaceRef}\0${hit.memoryId}`)).size !== hits.length ||
        new Set(hits.map(hit => hit.vectorRank)).size !== hits.length ||
        hits.some((_, index) => !hits.some(hit => hit.vectorRank === index + 1))) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        status: 'completed',
        state: input.state,
        modelVersion: parsedModelVersion,
        dimensions,
        watermark: input.watermark === null ? null : fixedAscii(input.watermark),
        hits: Object.freeze(hits)
    });
}
function parseRerankRequest(value) {
    const input = inspectMemoryRecord(value, ['modelVersion', 'queryText', 'candidates']);
    const candidates = inspectMemoryArray(input.candidates, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.rerankCandidates).map(value => {
        const candidate = inspectMemoryRecord(value, ['candidateId', 'text']);
        return Object.freeze({
            candidateId: fixedAscii(candidate.candidateId, MEMORY_ID),
            text: canonicalText(candidate.text, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textUtf8Bytes, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textCodePoints)
        });
    });
    if (candidates.length === 0 ||
        new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        modelVersion: modelVersion(input.modelVersion),
        queryText: canonicalText(input.queryText, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.queryUtf8Bytes, MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.queryCodePoints),
        candidates: Object.freeze(candidates)
    });
}
function parseRerankResult(value, request) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['modelVersion', 'rankedCandidateIds']);
    if (discriminator.status === 'unavailable') {
        inspectMemoryRecord(value, ['status']);
        return UNAVAILABLE;
    }
    if (discriminator.status !== 'completed')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, ['status', 'modelVersion', 'rankedCandidateIds']);
    const parsedModelVersion = modelVersion(input.modelVersion);
    if (parsedModelVersion !== request.modelVersion)
        return invalidMemoryValue();
    const rankedCandidateIds = inspectMemoryArray(input.rankedCandidateIds, request.candidates.length).map(candidateId => fixedAscii(candidateId, MEMORY_ID));
    const expected = new Set(request.candidates.map(candidate => candidate.candidateId));
    if (rankedCandidateIds.length !== expected.size ||
        new Set(rankedCandidateIds).size !== rankedCandidateIds.length ||
        rankedCandidateIds.some(candidateId => !expected.has(candidateId))) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        status: 'completed',
        modelVersion: parsedModelVersion,
        rankedCandidateIds: Object.freeze(rankedCandidateIds)
    });
}
function createPort(adapter, methodName, parseRequest, parseResult) {
    const adapterMethod = dataFunction(adapter, methodName);
    const method = async (requestValue, signal) => {
        if (isAborted(signal))
            return ABORTED;
        let request;
        try {
            request = parseRequest(requestValue);
        }
        catch {
            return UNAVAILABLE;
        }
        let raw;
        try {
            raw = await Reflect.apply(adapterMethod, adapter, [request, signal]);
        }
        catch {
            return isAborted(signal) ? ABORTED : UNAVAILABLE;
        }
        if (isAborted(signal))
            return ABORTED;
        try {
            return parseResult(raw, request);
        }
        catch {
            return UNAVAILABLE;
        }
    };
    return Object.freeze({ [methodName]: method });
}
export function createMemoryEmbedderPortV1(adapter) {
    return createPort(adapter, 'embed', parseEmbeddingRequest, parseEmbeddingResult);
}
export function createMemoryVectorIndexPortV1(adapter) {
    return createPort(adapter, 'search', parseVectorSearchRequest, parseVectorSearchResult);
}
export function createMemoryRerankerPortV1(adapter) {
    return createPort(adapter, 'rerank', parseRerankRequest, parseRerankResult);
}
