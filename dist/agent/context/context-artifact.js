import { CONTEXT_ARTIFACT_CONTENT_HASH_DOMAIN, CONTEXT_ARTIFACT_SAFE_PREFIX, MAX_CONTEXT_ARTIFACT_CONTENT_BYTES, MAX_CONTEXT_ARTIFACT_REFS, createContextSpanV1, domainSeparatedContextHash, parseContextSourceRefs } from './context-span.js';
import { estimateModelMessagesTokens, CONTEXT_TOKEN_ESTIMATOR_VERSION, inspectContextArray, inspectContextRecord, invalidContextValue, normalizeContextString, requireContextAscii, requireContextHash, requireSafeInteger } from './context-token-estimator.js';
export const CONTEXT_ARTIFACT_ID_HASH_DOMAIN = 'groupmate.context.artifact-id.v1';
export { CONTEXT_ARTIFACT_CONTENT_HASH_DOMAIN, CONTEXT_ARTIFACT_SAFE_PREFIX, MAX_CONTEXT_ARTIFACT_CONTENT_BYTES, MAX_CONTEXT_ARTIFACT_REFS } from './context-span.js';
export const MAX_CONTEXT_ARTIFACT_BYTES = 16 * 1_024;
function enumValue(value, values) {
    return typeof value === 'string' && values.includes(value)
        ? value
        : invalidContextValue();
}
function generatorJson(value) {
    return `{"kind":${JSON.stringify(value.kind)},"version":${JSON.stringify(value.version)}}`;
}
function refsJson(refs) {
    return `[${refs.map(value => {
        return `{"ref":${JSON.stringify(value.ref)},"contentHash":${JSON.stringify(value.contentHash)}}`;
    }).join(',')}]`;
}
function artifactIdPreimage(value) {
    return `{"kind":${JSON.stringify(value.kind)},"namespaceRef":${JSON.stringify(value.namespaceRef)},"generation":${value.generation},"sourceSpanIds":[${value.sourceSpanIds.map(id => JSON.stringify(id)).join(',')}],"sourceRefs":${refsJson(value.sourceRefs)},"generator":${generatorJson(value.generator)},"estimatorVersion":${JSON.stringify(value.estimatorVersion)},"contentHash":${JSON.stringify(value.contentHash)}}`;
}
function artifactJson(value) {
    return `{"schemaVersion":1,"artifactId":${JSON.stringify(value.artifactId)},"namespaceRef":${JSON.stringify(value.namespaceRef)},"generation":${value.generation},"kind":${JSON.stringify(value.kind)},"sourceSpanIds":[${value.sourceSpanIds.map(id => JSON.stringify(id)).join(',')}],"sourceRefs":${refsJson(value.sourceRefs)},"content":${JSON.stringify(value.content)},"generator":${generatorJson(value.generator)},"estimatorVersion":${JSON.stringify(value.estimatorVersion)},"tokenEstimate":${value.tokenEstimate},"contentHash":${JSON.stringify(value.contentHash)}}`;
}
export function contextArtifactContentHash(content) {
    const normalized = normalizeContextString(content);
    if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > MAX_CONTEXT_ARTIFACT_CONTENT_BYTES) {
        return invalidContextValue();
    }
    return domainSeparatedContextHash(CONTEXT_ARTIFACT_CONTENT_HASH_DOMAIN, normalized);
}
function parseGenerator(value) {
    const input = inspectContextRecord(value, ['kind', 'version']);
    return Object.freeze({
        kind: enumValue(input.kind, ['deterministic', 'model']),
        version: requireContextAscii(input.version)
    });
}
function artifactIdFor(value) {
    return `artifact:${domainSeparatedContextHash(CONTEXT_ARTIFACT_ID_HASH_DOMAIN, artifactIdPreimage(value))}`;
}
function parseArtifactFields(value, includeComputed) {
    const baseKeys = [
        'namespaceRef', 'generation', 'kind', 'sourceSpanIds', 'sourceRefs', 'content', 'generator',
        'estimatorVersion'
    ];
    const input = includeComputed
        ? inspectContextRecord(value, ['schemaVersion', 'artifactId', ...baseKeys, 'tokenEstimate', 'contentHash'])
        : inspectContextRecord(value, baseKeys);
    if (includeComputed && input.schemaVersion !== 1)
        return invalidContextValue();
    const content = normalizeContextString(input.content);
    if (content.length === 0 || Buffer.byteLength(content, 'utf8') > MAX_CONTEXT_ARTIFACT_CONTENT_BYTES) {
        return invalidContextValue();
    }
    const sourceRefs = parseContextSourceRefs(input.sourceRefs, MAX_CONTEXT_ARTIFACT_REFS);
    const sourceSpanIds = Object.freeze(inspectContextArray(input.sourceSpanIds, MAX_CONTEXT_ARTIFACT_REFS).map(requireContextAscii));
    if (sourceSpanIds.length === 0 || new Set(sourceSpanIds).size !== sourceSpanIds.length ||
        sourceRefs.length < sourceSpanIds.length)
        return invalidContextValue();
    const partial = Object.freeze({
        schemaVersion: 1,
        namespaceRef: requireContextAscii(input.namespaceRef),
        generation: requireSafeInteger(input.generation),
        kind: enumValue(input.kind, ['tool_digest', 'conversation_summary']),
        sourceSpanIds,
        sourceRefs,
        content,
        generator: parseGenerator(input.generator),
        estimatorVersion: requireContextAscii(input.estimatorVersion),
        contentHash: contextArtifactContentHash(content)
    });
    if (partial.estimatorVersion !== CONTEXT_TOKEN_ESTIMATOR_VERSION) {
        return invalidContextValue();
    }
    const artifactId = artifactIdFor(partial);
    const tokenEstimate = estimateModelMessagesTokens(Object.freeze([
        Object.freeze({ role: 'user', content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}${content}` })
    ]));
    if (includeComputed && (input.artifactId !== artifactId || requireContextHash(input.contentHash) !== partial.contentHash ||
        requireSafeInteger(input.tokenEstimate) !== tokenEstimate))
        return invalidContextValue();
    const artifact = Object.freeze({
        schemaVersion: 1,
        artifactId,
        namespaceRef: partial.namespaceRef,
        generation: partial.generation,
        kind: partial.kind,
        sourceSpanIds: partial.sourceSpanIds,
        sourceRefs: partial.sourceRefs,
        content: partial.content,
        generator: partial.generator,
        estimatorVersion: partial.estimatorVersion,
        tokenEstimate,
        contentHash: partial.contentHash
    });
    if (Buffer.byteLength(artifactJson(artifact), 'utf8') > MAX_CONTEXT_ARTIFACT_BYTES) {
        return invalidContextValue();
    }
    return artifact;
}
export function createContextArtifactV1(value) {
    return parseArtifactFields(value, false);
}
export function parseContextArtifactV1(value) {
    return parseArtifactFields(value, true);
}
export function contextArtifactToSpan(artifactValue, semanticOrder, priority = 'low') {
    const artifact = parseContextArtifactV1(artifactValue);
    return createContextSpanV1(Object.freeze({
        spanId: artifact.artifactId,
        namespaceRef: artifact.namespaceRef,
        kind: 'artifact',
        source: 'artifact',
        trust: 'untrusted',
        requirement: 'optional',
        priority,
        semanticOrder: requireSafeInteger(semanticOrder),
        originGeneration: artifact.generation,
        provenance: Object.freeze({
            kind: 'context_artifact',
            ref: artifact.artifactId,
            revision: 1,
            contentHash: artifact.contentHash
        }),
        supersedes: null,
        messages: Object.freeze([
            Object.freeze({
                role: 'user',
                content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}${artifact.content}`
            })
        ]),
        sourceRefs: artifact.sourceRefs,
        toolProtocol: null
    }));
}
