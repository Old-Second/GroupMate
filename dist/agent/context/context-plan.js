import { domainSeparatedContextHash } from './context-span.js';
import { inspectContextArray, inspectContextRecord, invalidContextValue, MAX_CONTEXT_CANONICAL_MESSAGE_BYTES, MAX_CONTEXT_MESSAGES, requireContextAscii, requireContextHash, requireSafeInteger } from './context-token-estimator.js';
export const CONTEXT_PLAN_HASH_DOMAIN = 'groupmate.context.plan.v1';
export const MAX_CONTEXT_PLAN_BYTES = 32 * 1_024;
export const MAX_CONTEXT_PLAN_REFS = 128;
function includedJson(values) {
    return `[${values.map(value => {
        return `{"spanId":${JSON.stringify(value.spanId)},"representation":${JSON.stringify(value.representation)},"wireStart":${value.wireStart},"wireCount":${value.wireCount},"contentHash":${JSON.stringify(value.contentHash)}}`;
    }).join(',')}]`;
}
function omittedJson(values) {
    return `[${values.map(value => {
        return `{"spanId":${JSON.stringify(value.spanId)},"reason":${JSON.stringify(value.reason)}}`;
    }).join(',')}]`;
}
export function contextPlanPreimage(plan) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${includedJson(plan.included)},"omitted":${omittedJson(plan.omitted)},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`;
}
function fullPlanJson(plan) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"planHash":${JSON.stringify(plan.planHash)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${includedJson(plan.included)},"omitted":${omittedJson(plan.omitted)},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`;
}
function parseIncluded(value) {
    return Object.freeze(inspectContextArray(value, MAX_CONTEXT_PLAN_REFS).map(entry => {
        const input = inspectContextRecord(entry, [
            'spanId', 'representation', 'wireStart', 'wireCount', 'contentHash'
        ]);
        if (input.representation !== 'raw' && input.representation !== 'artifact') {
            return invalidContextValue();
        }
        const spanId = requireContextAscii(input.spanId);
        if (input.representation === 'artifact' && !/^artifact:[0-9a-f]{64}$/.test(spanId)) {
            return invalidContextValue();
        }
        return Object.freeze({
            spanId,
            representation: input.representation,
            wireStart: requireSafeInteger(input.wireStart),
            wireCount: requireSafeInteger(input.wireCount, { positive: true }),
            contentHash: requireContextHash(input.contentHash)
        });
    }));
}
function parseOmitted(value) {
    const reasons = [
        'duplicate', 'superseded', 'artifact', 'budget'
    ];
    return Object.freeze(inspectContextArray(value, MAX_CONTEXT_PLAN_REFS).map(entry => {
        const input = inspectContextRecord(entry, ['spanId', 'reason']);
        if (typeof input.reason !== 'string' || !reasons.includes(input.reason)) {
            return invalidContextValue();
        }
        return Object.freeze({
            spanId: requireContextAscii(input.spanId),
            reason: input.reason
        });
    }));
}
function parsePlanFields(value, includeHash) {
    const keys = [
        'namespaceRef', 'generation', 'previousPlanHash', 'estimatorVersion', 'capabilityHash',
        'mode', 'included', 'omitted', 'artifactRefs', 'prefixMessageCount',
        'estimatedInputTokens', 'estimatedToolTokens', 'reservedOutputTokens',
        'serializedMessageBytes', 'messageCount'
    ];
    const input = includeHash
        ? inspectContextRecord(value, ['schemaVersion', 'planHash', ...keys])
        : inspectContextRecord(value, keys);
    if (includeHash && input.schemaVersion !== 1)
        return invalidContextValue();
    if (input.mode !== 'normal' && input.mode !== 'compacting')
        return invalidContextValue();
    const included = parseIncluded(input.included);
    const omitted = parseOmitted(input.omitted);
    const artifactRefs = Object.freeze(inspectContextArray(input.artifactRefs, MAX_CONTEXT_PLAN_REFS)
        .map(requireContextAscii));
    const allRefs = [...included.map(value => value.spanId), ...omitted.map(value => value.spanId)];
    if (allRefs.length > MAX_CONTEXT_PLAN_REFS || new Set(allRefs).size !== allRefs.length ||
        new Set(artifactRefs).size !== artifactRefs.length)
        return invalidContextValue();
    const representedArtifacts = included
        .filter(value => value.representation === 'artifact')
        .map(value => value.spanId);
    if (representedArtifacts.length !== artifactRefs.length ||
        representedArtifacts.some((ref, index) => ref !== artifactRefs[index]))
        return invalidContextValue();
    let wireCursor = 0;
    for (const entry of included) {
        if (entry.wireStart !== wireCursor)
            return invalidContextValue();
        wireCursor += entry.wireCount;
        if (!Number.isSafeInteger(wireCursor))
            return invalidContextValue();
    }
    const previousPlanHash = input.previousPlanHash === null
        ? null
        : requireContextHash(input.previousPlanHash);
    const partial = {
        schemaVersion: 1,
        namespaceRef: requireContextAscii(input.namespaceRef),
        generation: requireSafeInteger(input.generation, { positive: true }),
        previousPlanHash,
        estimatorVersion: requireContextAscii(input.estimatorVersion),
        capabilityHash: requireContextHash(input.capabilityHash),
        mode: input.mode,
        included,
        omitted,
        artifactRefs,
        prefixMessageCount: requireSafeInteger(input.prefixMessageCount),
        estimatedInputTokens: requireSafeInteger(input.estimatedInputTokens),
        estimatedToolTokens: requireSafeInteger(input.estimatedToolTokens),
        reservedOutputTokens: requireSafeInteger(input.reservedOutputTokens),
        serializedMessageBytes: requireSafeInteger(input.serializedMessageBytes),
        messageCount: requireSafeInteger(input.messageCount)
    };
    if (partial.messageCount !== wireCursor || partial.prefixMessageCount > partial.messageCount) {
        return invalidContextValue();
    }
    if (partial.messageCount > MAX_CONTEXT_MESSAGES ||
        partial.serializedMessageBytes > MAX_CONTEXT_CANONICAL_MESSAGE_BYTES)
        return invalidContextValue();
    const provisional = Object.freeze({ ...partial, planHash: '0'.repeat(64) });
    const planHash = domainSeparatedContextHash(CONTEXT_PLAN_HASH_DOMAIN, contextPlanPreimage(provisional));
    if (includeHash && requireContextHash(input.planHash) !== planHash)
        return invalidContextValue();
    const plan = Object.freeze({
        schemaVersion: 1,
        namespaceRef: partial.namespaceRef,
        planHash,
        generation: partial.generation,
        previousPlanHash: partial.previousPlanHash,
        estimatorVersion: partial.estimatorVersion,
        capabilityHash: partial.capabilityHash,
        mode: partial.mode,
        included: partial.included,
        omitted: partial.omitted,
        artifactRefs: partial.artifactRefs,
        prefixMessageCount: partial.prefixMessageCount,
        estimatedInputTokens: partial.estimatedInputTokens,
        estimatedToolTokens: partial.estimatedToolTokens,
        reservedOutputTokens: partial.reservedOutputTokens,
        serializedMessageBytes: partial.serializedMessageBytes,
        messageCount: partial.messageCount
    });
    if (Buffer.byteLength(fullPlanJson(plan), 'utf8') > MAX_CONTEXT_PLAN_BYTES) {
        return invalidContextValue();
    }
    return plan;
}
export function createContextPlanV1(value) {
    return parsePlanFields(value, false);
}
export function parseContextPlanV1(value) {
    return parsePlanFields(value, true);
}
export function contextPlanHash(value) {
    const plan = parseContextPlanV1(value);
    return domainSeparatedContextHash(CONTEXT_PLAN_HASH_DOMAIN, contextPlanPreimage(plan));
}
export function planEntryMatchesSpan(entry, span, contentHash) {
    return entry.spanId === span.spanId && entry.contentHash === contentHash &&
        entry.wireCount === span.messages.length;
}
