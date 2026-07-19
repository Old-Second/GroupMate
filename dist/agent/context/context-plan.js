import { domainSeparatedContextHash } from './context-span.js';
import { inspectContextArray, inspectContextRecord, invalidContextValue, MAX_CONTEXT_CANONICAL_MESSAGE_BYTES, MAX_CONTEXT_MESSAGES, requireContextAscii, requireContextHash, requireSafeInteger, serializeModelMessages } from './context-token-estimator.js';
export const CONTEXT_PLAN_HASH_DOMAIN = 'groupmate.context.plan.v1';
export const CONTEXT_WIRE_HASH_DOMAIN = 'groupmate.context.wire.v1';
export const MAX_CONTEXT_PLAN_BYTES = 32 * 1_024;
export const MAX_CONTEXT_PLAN_REFS = 128;
function includedJson(values) {
    return `[${values.map(value => {
        return `{"spanId":${JSON.stringify(value.spanId)},"representation":${JSON.stringify(value.representation)},"wireStart":${value.wireStart},"wireCount":${value.wireCount},"wireHash":${JSON.stringify(value.wireHash)},"contentHash":${JSON.stringify(value.contentHash)}}`;
    }).join(',')}]`;
}
function legacyIncludedJson(values) {
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
function legacyContextPlanPreimage(plan) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${legacyIncludedJson(plan.included)},"omitted":${omittedJson(plan.omitted)},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`;
}
function fullPlanJson(plan) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"planHash":${JSON.stringify(plan.planHash)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${includedJson(plan.included)},"omitted":${omittedJson(plan.omitted)},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`;
}
function fullLegacyPlanJson(plan) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"planHash":${JSON.stringify(plan.planHash)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${legacyIncludedJson(plan.included)},"omitted":${omittedJson(plan.omitted)},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`;
}
function parseIncluded(value) {
    return Object.freeze(inspectContextArray(value, MAX_CONTEXT_PLAN_REFS).map(entry => {
        const input = inspectContextRecord(entry, [
            'spanId', 'representation', 'wireStart', 'wireCount', 'wireHash', 'contentHash'
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
            wireHash: requireContextHash(input.wireHash),
            contentHash: requireContextHash(input.contentHash)
        });
    }));
}
function parseLegacyIncluded(value) {
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
function parseLegacyPlanFields(value) {
    const keys = [
        'namespaceRef', 'generation', 'previousPlanHash', 'estimatorVersion', 'capabilityHash',
        'mode', 'included', 'omitted', 'artifactRefs', 'prefixMessageCount',
        'estimatedInputTokens', 'estimatedToolTokens', 'reservedOutputTokens',
        'serializedMessageBytes', 'messageCount'
    ];
    const input = inspectContextRecord(value, ['schemaVersion', 'planHash', ...keys]);
    if (input.schemaVersion !== 1 ||
        (input.mode !== 'normal' && input.mode !== 'compacting'))
        return invalidContextValue();
    const included = parseLegacyIncluded(input.included);
    const omitted = parseOmitted(input.omitted);
    const artifactRefs = Object.freeze(inspectContextArray(input.artifactRefs, MAX_CONTEXT_PLAN_REFS)
        .map(requireContextAscii));
    const allRefs = [...included.map(entry => entry.spanId), ...omitted.map(entry => entry.spanId)];
    if (allRefs.length > MAX_CONTEXT_PLAN_REFS || new Set(allRefs).size !== allRefs.length ||
        new Set(artifactRefs).size !== artifactRefs.length)
        return invalidContextValue();
    const representedArtifacts = included
        .filter(entry => entry.representation === 'artifact')
        .map(entry => entry.spanId);
    if (representedArtifacts.length !== artifactRefs.length ||
        representedArtifacts.some((ref, index) => ref !== artifactRefs[index])) {
        return invalidContextValue();
    }
    let wireCursor = 0;
    for (const entry of included) {
        if (entry.wireStart !== wireCursor)
            return invalidContextValue();
        wireCursor += entry.wireCount;
        if (!Number.isSafeInteger(wireCursor))
            return invalidContextValue();
    }
    const partial = Object.freeze({
        schemaVersion: 1,
        namespaceRef: requireContextAscii(input.namespaceRef),
        generation: requireSafeInteger(input.generation, { positive: true }),
        previousPlanHash: input.previousPlanHash === null
            ? null
            : requireContextHash(input.previousPlanHash),
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
    });
    if (partial.messageCount !== wireCursor || partial.prefixMessageCount > partial.messageCount ||
        partial.messageCount > MAX_CONTEXT_MESSAGES ||
        partial.serializedMessageBytes > MAX_CONTEXT_CANONICAL_MESSAGE_BYTES) {
        return invalidContextValue();
    }
    const provisional = Object.freeze({
        ...partial,
        planHash: '0'.repeat(64)
    });
    const planHash = domainSeparatedContextHash(CONTEXT_PLAN_HASH_DOMAIN, legacyContextPlanPreimage(provisional));
    if (requireContextHash(input.planHash) !== planHash)
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
    if (Buffer.byteLength(fullLegacyPlanJson(plan), 'utf8') > MAX_CONTEXT_PLAN_BYTES) {
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
export function parseLegacyContextPlanV1(value) {
    return parseLegacyPlanFields(value);
}
export function upgradeLegacyContextPlanV1(value, messages) {
    const legacy = parseLegacyContextPlanV1(value);
    if (messages.length !== legacy.messageCount)
        return invalidContextValue();
    const included = Object.freeze(legacy.included.map(entry => {
        const wire = Object.freeze(messages.slice(entry.wireStart, entry.wireStart + entry.wireCount));
        if (wire.length !== entry.wireCount)
            return invalidContextValue();
        return Object.freeze({ ...entry, wireHash: contextWireHash(wire) });
    }));
    return createContextPlanV1(Object.freeze({
        namespaceRef: legacy.namespaceRef,
        generation: legacy.generation,
        previousPlanHash: legacy.previousPlanHash,
        estimatorVersion: legacy.estimatorVersion,
        capabilityHash: legacy.capabilityHash,
        mode: legacy.mode,
        included,
        omitted: legacy.omitted,
        artifactRefs: legacy.artifactRefs,
        prefixMessageCount: legacy.prefixMessageCount,
        estimatedInputTokens: legacy.estimatedInputTokens,
        estimatedToolTokens: legacy.estimatedToolTokens,
        reservedOutputTokens: legacy.reservedOutputTokens,
        serializedMessageBytes: legacy.serializedMessageBytes,
        messageCount: legacy.messageCount
    }));
}
export function contextPlanHash(value) {
    const plan = parseContextPlanV1(value);
    return domainSeparatedContextHash(CONTEXT_PLAN_HASH_DOMAIN, contextPlanPreimage(plan));
}
export function contextWireHash(messages) {
    return domainSeparatedContextHash(CONTEXT_WIRE_HASH_DOMAIN, serializeModelMessages(messages));
}
export function planEntryMatchesSpan(entry, span, contentHash) {
    return entry.spanId === span.spanId && entry.wireHash === contextWireHash(span.messages) &&
        entry.contentHash === contentHash &&
        entry.wireCount === span.messages.length;
}
