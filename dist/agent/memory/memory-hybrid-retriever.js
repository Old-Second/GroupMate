import { types as utilTypes } from 'node:util';
import { createMemorySemanticCircuitBreakerV1 } from './memory-semantic-circuit-breaker.js';
import { MEMORY_SEMANTIC_RESOURCE_LIMITS_V1 } from './memory-semantic-ports.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { parseMemoryRetrievalResultV2 } from './memory-retrieval.js';
const RRF_K = 60;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
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
function parseSemanticConfiguration(value) {
    const discriminator = inspectMemoryRecord(value, ['enabled'], ['embeddingModelVersion', 'embeddingDimensions', 'rerankModelVersion']);
    if (discriminator.enabled === false) {
        inspectMemoryRecord(value, ['enabled']);
        return Object.freeze({ enabled: false });
    }
    if (discriminator.enabled !== true)
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, [
        'enabled', 'embeddingModelVersion', 'embeddingDimensions', 'rerankModelVersion'
    ]);
    if (typeof input.embeddingModelVersion !== 'string' ||
        !MODEL_VERSION.test(input.embeddingModelVersion) ||
        typeof input.embeddingDimensions !== 'number' ||
        !Number.isSafeInteger(input.embeddingDimensions) || input.embeddingDimensions <= 0 ||
        input.embeddingDimensions > MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions ||
        Object.is(input.embeddingDimensions, -0) ||
        (input.rerankModelVersion !== null && (typeof input.rerankModelVersion !== 'string' ||
            !MODEL_VERSION.test(input.rerankModelVersion))))
        return invalidMemoryValue();
    return Object.freeze({
        enabled: true,
        embeddingModelVersion: input.embeddingModelVersion,
        embeddingDimensions: input.embeddingDimensions,
        rerankModelVersion: input.rerankModelVersion
    });
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, ['lexical', 'canonical', 'semantic', 'now'], ['embedder', 'vectorIndex', 'reranker']);
    if (typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
        return invalidMemoryValue();
    }
    dataFunction(input.lexical, 'retrieve');
    dataFunction(input.canonical, 'rehydrate');
    const semantic = parseSemanticConfiguration(input.semantic);
    if (semantic.enabled) {
        dataFunction(input.embedder, 'embed');
        dataFunction(input.vectorIndex, 'search');
        if (semantic.rerankModelVersion !== null) {
            dataFunction(input.reranker, 'rerank');
        }
    }
    return Object.freeze({
        lexical: input.lexical,
        canonical: input.canonical,
        semantic,
        now: input.now,
        ...(input.embedder === undefined ? {} : { embedder: input.embedder }),
        ...(input.vectorIndex === undefined
            ? {}
            : { vectorIndex: input.vectorIndex }),
        ...(input.reranker === undefined ? {} : { reranker: input.reranker })
    });
}
function isEnabled(options) {
    return options.semantic.enabled && options.embedder !== undefined &&
        options.vectorIndex !== undefined;
}
function canonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        return null;
    }
    return value;
}
function currentTimeMs(now) {
    let value;
    try {
        value = Reflect.apply(now, undefined, []);
    }
    catch {
        return null;
    }
    const instant = canonicalInstant(value);
    return instant === null ? null : Date.parse(instant);
}
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
function abortError() {
    return new DOMException('operation was aborted', 'AbortError');
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw abortError();
}
function sourceProjection(record) {
    if (record.namespace.scope.kind !== 'personal')
        return Object.freeze([]);
    const subjectUserId = record.namespace.scope.subjectUserId;
    return Object.freeze(record.sources
        .filter(source => source.actor.userId === subjectUserId)
        .slice(0, 8)
        .map(source => Object.freeze({
        schemaVersion: 1,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        messageId: source.messageId,
        actor: Object.freeze({
            userId: source.actor.userId,
            displayName: source.actor.displayName
        }),
        scene: source.scene.kind === 'private'
            ? Object.freeze({ kind: 'private' })
            : Object.freeze({
                kind: 'group',
                groupId: source.scene.groupId,
                groupLifecycleId: source.scene.groupLifecycleId,
                groupName: source.scene.groupName
            }),
        observedAt: source.observedAt
    })));
}
function estimatedTokens(text) {
    return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
}
function vectorCandidate(result, hit, requestedNamespaces, nowMs) {
    if (result.status !== 'found')
        return null;
    const record = result.record;
    if (!requestedNamespaces.has(record.namespaceRef) ||
        record.namespace.scope.kind !== 'personal' ||
        record.namespaceRef !== hit.namespaceRef ||
        record.namespaceGeneration !== hit.namespaceGeneration ||
        record.memoryId !== hit.memoryId || record.revision !== hit.memoryRevision ||
        result.revisionHash !== hit.revisionHash || record.deletionState !== 'active' ||
        record.validity.state === 'superseded' || record.conflict.state === 'confirmed' ||
        Date.parse(record.retention.validUntil) <= nowMs)
        return null;
    const sources = sourceProjection(record);
    if (sources.length === 0)
        return null;
    return Object.freeze({
        schemaVersion: 2,
        memoryId: record.memoryId,
        revision: record.revision,
        revisionHash: result.revisionHash,
        namespaceRef: record.namespaceRef,
        kind: record.kind,
        text: record.text,
        createdAt: record.createdAt,
        observedAt: record.observedAt,
        updatedAt: record.updatedAt,
        validUntil: record.retention.validUntil,
        confidence: record.confidence,
        sensitivity: record.sensitivity,
        conflict: record.conflict.state,
        consent: record.consent.state,
        estimatedTokens: estimatedTokens(record.text),
        sources,
        ranking: Object.freeze({
            exactMatch: false,
            lexicalRank: null,
            vectorRank: hit.vectorRank,
            rerankRank: null,
            fusedRank: hit.vectorRank
        })
    });
}
function sameCanonicalCandidate(left, right) {
    return left.namespaceRef === right.namespaceRef && left.memoryId === right.memoryId &&
        left.revision === right.revision && left.revisionHash === right.revisionHash &&
        left.text === right.text;
}
function rrfScore(lexicalRank, vectorRank, rerankRank) {
    return (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank)) +
        (vectorRank === null ? 0 : 1 / (RRF_K + vectorRank)) +
        (rerankRank === null ? 0 : 1 / (RRF_K + rerankRank));
}
function fuseCandidates(lexical, vector, rerankRanks = new Map()) {
    const merged = new Map();
    lexical.forEach((candidate, index) => {
        merged.set(candidate.memoryId, Object.freeze({
            candidate,
            lexicalRank: candidate.ranking.lexicalRank ?? index + 1,
            vectorRank: null
        }));
    });
    vector.forEach((candidate, index) => {
        const previous = merged.get(candidate.memoryId);
        const vectorRank = candidate.ranking.vectorRank ?? index + 1;
        if (previous === undefined || !sameCanonicalCandidate(previous.candidate, candidate)) {
            merged.set(candidate.memoryId, Object.freeze({
                candidate,
                lexicalRank: null,
                vectorRank
            }));
            return;
        }
        merged.set(candidate.memoryId, Object.freeze({
            candidate: Object.freeze({
                ...candidate,
                ranking: Object.freeze({
                    ...candidate.ranking,
                    exactMatch: previous.candidate.ranking.exactMatch,
                    lexicalRank: previous.lexicalRank
                })
            }),
            lexicalRank: previous.lexicalRank,
            vectorRank
        }));
    });
    return Object.freeze([...merged.values()].map(value => {
        const rerankRank = rerankRanks.get(value.candidate.memoryId) ?? null;
        return Object.freeze({
            ...value,
            rerankRank,
            score: rrfScore(value.lexicalRank, value.vectorRank, rerankRank)
        });
    }).sort((left, right) => (right.score - left.score ||
        Number(right.candidate.ranking.exactMatch) -
            Number(left.candidate.ranking.exactMatch) ||
        (left.candidate.updatedAt < right.candidate.updatedAt ? 1
            : left.candidate.updatedAt > right.candidate.updatedAt ? -1
                : left.candidate.memoryId < right.candidate.memoryId ? -1 : 1))));
}
function budgetCandidates(fused, request) {
    const candidates = [];
    let tokens = 0;
    let bytes = 0;
    for (const value of fused) {
        if (candidates.length >= request.limits.maxCandidates)
            break;
        const candidate = Object.freeze({
            ...value.candidate,
            ranking: Object.freeze({
                exactMatch: value.candidate.ranking.exactMatch,
                lexicalRank: value.lexicalRank,
                vectorRank: value.vectorRank,
                rerankRank: value.rerankRank,
                fusedRank: candidates.length + 1
            })
        });
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
        if (tokens + candidate.estimatedTokens > request.limits.maxTokens ||
            bytes + candidateBytes > request.limits.maxBytes)
            continue;
        tokens += candidate.estimatedTokens;
        bytes += candidateBytes;
        candidates.push(candidate);
    }
    return Object.freeze(candidates);
}
function vectorUnavailableFallback(lexical) {
    if (lexical.mode === 'none')
        return lexical;
    return Object.freeze({
        ...lexical,
        index: Object.freeze({
            ...lexical.index,
            vector: 'unavailable'
        })
    });
}
function sharedWatermark(lexical, vector) {
    return lexical !== null && lexical === vector ? lexical : null;
}
function newCircuit(now) {
    return createMemorySemanticCircuitBreakerV1({
        failureThreshold: CIRCUIT_FAILURE_THRESHOLD,
        cooldownMs: CIRCUIT_COOLDOWN_MS,
        now: () => currentTimeMs(now) ?? Number.NaN
    });
}
export function createHybridMemoryRetrieverV2(optionsValue) {
    const options = parseOptions(optionsValue);
    const lexicalRetrieve = dataFunction(options.lexical, 'retrieve');
    const rehydrate = dataFunction(options.canonical, 'rehydrate');
    const embeddingCircuit = newCircuit(options.now);
    const vectorCircuit = newCircuit(options.now);
    const rerankCircuit = newCircuit(options.now);
    const retrieve = async (request, signal) => {
        throwIfAborted(signal);
        let lexical;
        try {
            lexical = parseMemoryRetrievalResultV2(await Reflect.apply(lexicalRetrieve, options.lexical, [request, signal]));
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw abortError();
            return Object.freeze({
                schemaVersion: 2,
                status: 'unavailable',
                reason: 'index_unavailable'
            });
        }
        if (lexical.status !== 'completed' || !isEnabled(options) || lexical.mode === 'none') {
            return lexical;
        }
        const nowMs = currentTimeMs(options.now);
        if (nowMs === null)
            return vectorUnavailableFallback(lexical);
        const embeddingPermit = embeddingCircuit.acquire();
        if (embeddingPermit.status === 'blocked')
            return vectorUnavailableFallback(lexical);
        const embedding = await options.embedder.embed({
            purpose: 'query',
            modelVersion: options.semantic.embeddingModelVersion,
            dimensions: options.semantic.embeddingDimensions,
            texts: [request.query.text]
        }, signal);
        if (embedding.status === 'aborted') {
            embeddingPermit.settle('success');
            throw abortError();
        }
        embeddingPermit.settle(embedding.status === 'completed' ? 'success' : 'failure');
        if (embedding.status !== 'completed')
            return vectorUnavailableFallback(lexical);
        const vectorPermit = vectorCircuit.acquire();
        if (vectorPermit.status === 'blocked')
            return vectorUnavailableFallback(lexical);
        const vectorResult = await options.vectorIndex.search({
            namespaceRefs: request.subjects.map(subject => subject.namespaceRef),
            modelVersion: options.semantic.embeddingModelVersion,
            dimensions: options.semantic.embeddingDimensions,
            queryVector: embedding.vectors[0],
            maxHits: Math.min(MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.vectorHits, request.limits.maxCandidates * 2)
        }, signal);
        if (vectorResult.status === 'aborted') {
            vectorPermit.settle('success');
            throw abortError();
        }
        vectorPermit.settle(vectorResult.status === 'completed' ? 'success' : 'failure');
        if (vectorResult.status !== 'completed')
            return vectorUnavailableFallback(lexical);
        const requestedNamespaces = new Set(request.subjects.map(subject => subject.namespaceRef));
        const vectorCandidates = [];
        for (const hit of vectorResult.hits) {
            throwIfAborted(signal);
            let result;
            try {
                result = await Reflect.apply(rehydrate, options.canonical, [{
                        capability: request.capability,
                        identity: {
                            namespaceRef: hit.namespaceRef,
                            namespaceGeneration: hit.namespaceGeneration,
                            memoryId: hit.memoryId,
                            memoryRevision: hit.memoryRevision,
                            revisionHash: hit.revisionHash
                        }
                    }, signal]);
            }
            catch (error) {
                if (signal?.aborted === true || isAbortError(error))
                    throw abortError();
                return vectorUnavailableFallback(lexical);
            }
            if (result.status === 'aborted')
                throw abortError();
            if (result.status === 'unavailable')
                return vectorUnavailableFallback(lexical);
            if (result.status === 'denied') {
                return Object.freeze({
                    schemaVersion: 2,
                    status: 'denied',
                    reason: 'namespace_denied'
                });
            }
            const candidate = vectorCandidate(result, hit, requestedNamespaces, nowMs);
            if (candidate !== null)
                vectorCandidates.push(candidate);
        }
        let fused = fuseCandidates(lexical.candidates, vectorCandidates);
        if (options.semantic.rerankModelVersion !== null && options.reranker !== undefined &&
            fused.length > 0) {
            const rerankPermit = rerankCircuit.acquire();
            if (rerankPermit.status === 'allowed') {
                const rerank = await options.reranker.rerank({
                    modelVersion: options.semantic.rerankModelVersion,
                    queryText: request.query.text,
                    candidates: fused.slice(0, request.limits.maxCandidates).map(value => ({
                        candidateId: value.candidate.memoryId,
                        text: value.candidate.text
                    }))
                }, signal);
                if (rerank.status === 'aborted') {
                    rerankPermit.settle('success');
                    throw abortError();
                }
                rerankPermit.settle(rerank.status === 'completed' ? 'success' : 'failure');
                if (rerank.status === 'completed') {
                    const ranks = new Map(rerank.rankedCandidateIds.map((candidateId, index) => [candidateId, index + 1]));
                    fused = fuseCandidates(lexical.candidates, vectorCandidates, ranks);
                }
            }
        }
        const candidates = budgetCandidates(fused, request);
        const mode = candidates.some(candidate => candidate.ranking.vectorRank !== null)
            ? 'hybrid'
            : lexical.mode;
        return Object.freeze({
            schemaVersion: 2,
            status: 'completed',
            mode,
            candidates,
            index: Object.freeze({
                lexical: lexical.index.lexical,
                vector: vectorResult.state,
                watermark: sharedWatermark(lexical.index.watermark, vectorResult.watermark)
            })
        });
    };
    return Object.freeze({ retrieve });
}
