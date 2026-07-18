import { types as utilTypes } from 'node:util';
export const PRESENTATION_TRACE_MAX_BYTES = 16 * 1_024;
export const PRESENTATION_TRACE_MAX_SEGMENTS = 14;
export const PRESENTATION_TRACE_MAX_REASONING_SEGMENTS = 6;
export const PRESENTATION_TRACE_MAX_TOOL_SEGMENTS = 8;
export const PRESENTATION_TRACE_MAX_REASONING_CODE_POINTS = 2_000;
export const PRESENTATION_TRACE_MAX_TOTAL_REASONING_CODE_POINTS = 8_000;
export const PRESENTATION_TRACE_MAX_ARGUMENT_CODE_POINTS = 500;
export const PRESENTATION_TRACE_MAX_RESULT_CODE_POINTS = 1_000;
const TRACE_V1_KEYS = Object.freeze(['schemaVersion', 'truncated', 'segments']);
const TRACE_V2_KEYS = Object.freeze(['schemaVersion', 'truncated', 'segments', 'usage']);
const USAGE_KEYS = Object.freeze([
    'schemaVersion', 'availability', 'inputTokens', 'outputTokens', 'totalTokens',
    'cacheHitTokens', 'cacheMissTokens', 'cacheUsageComplete', 'cost'
]);
const COST_VALUE_KEYS = Object.freeze([
    'kind', 'currency', 'picoYuan', 'catalogVersion', 'billingAuthority'
]);
const COST_UNAVAILABLE_KEYS = Object.freeze([
    'kind', 'catalogVersion', 'billingAuthority'
]);
const REASONING_KEYS = Object.freeze([
    'kind', 'step', 'turn', 'text', 'truncated'
]);
const TOOL_KEYS = Object.freeze([
    'kind', 'step', 'index', 'toolName', 'outcome', 'argumentsSummary',
    'resultSummary', 'truncated'
]);
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const CANONICAL_PICO_YUAN = /^(?:0|[1-9][0-9]*)$/;
const MAX_PICO_YUAN_DIGITS = 128;
const MAX_CATALOG_VERSION_CODE_POINTS = 128;
const TOOL_OUTCOMES = new Set([
    'succeeded', 'denied', 'failed', 'indeterminate'
]);
export const EMPTY_PRESENTATION_TRACE = Object.freeze({
    schemaVersion: 1,
    truncated: false,
    segments: Object.freeze([])
});
function exactDataRecord(value, expectedKeys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const ownKeys = Reflect.ownKeys(value);
    const unknown = ownKeys.find(key => (typeof key !== 'string' || !expectedKeys.includes(key)));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains an unknown key`);
    const missing = expectedKeys.find(key => !ownKeys.includes(key));
    if (missing !== undefined)
        throw new TypeError(`${label} key is missing: ${missing}`);
    const entries = [];
    for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain own data properties`);
        }
        entries.push([key, descriptor.value]);
    }
    return Object.freeze(Object.fromEntries(entries));
}
function exactArrayValues(value, maxLength, label) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > maxLength) {
        throw new TypeError(`${label} limit is invalid`);
    }
    const length = Number(lengthDescriptor.value);
    const allowed = new Set(['length']);
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        allowed.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain own data properties`);
        }
        result.push(descriptor.value);
    }
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) {
        throw new TypeError(`${label} contains an unknown key`);
    }
    return Object.freeze(result);
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
function positiveInteger(value, label) {
    const parsed = nonNegativeInteger(value, label);
    if (parsed === 0)
        throw new TypeError(`${label} is invalid`);
    return parsed;
}
function safeSum(left, right, label) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum))
        throw new TypeError(`${label} is invalid`);
    return sum;
}
function boundedCatalogVersion(value, label) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.normalize('NFC') !== value ||
        [...value].length > MAX_CATALOG_VERSION_CODE_POINTS) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function parsePresentationCost(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError('presentation usage cost is invalid');
    }
    const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (kindDescriptor === undefined || !Object.hasOwn(kindDescriptor, 'value')) {
        throw new TypeError('presentation usage cost must contain own data properties');
    }
    if (kindDescriptor.value === 'unavailable') {
        const cost = exactDataRecord(value, COST_UNAVAILABLE_KEYS, 'presentation usage cost');
        if (cost.billingAuthority !== false ||
            (cost.catalogVersion !== null && typeof cost.catalogVersion !== 'string')) {
            throw new TypeError('presentation usage cost is invalid');
        }
        return Object.freeze({
            kind: 'unavailable',
            catalogVersion: cost.catalogVersion === null
                ? null
                : boundedCatalogVersion(cost.catalogVersion, 'presentation cost catalog version'),
            billingAuthority: false
        });
    }
    const cost = exactDataRecord(value, COST_VALUE_KEYS, 'presentation usage cost');
    if ((cost.kind !== 'exact' && cost.kind !== 'upper_bound') ||
        cost.currency !== 'CNY' || cost.billingAuthority !== false ||
        typeof cost.picoYuan !== 'string' ||
        cost.picoYuan.length > MAX_PICO_YUAN_DIGITS ||
        !CANONICAL_PICO_YUAN.test(cost.picoYuan)) {
        throw new TypeError('presentation usage cost is invalid');
    }
    return Object.freeze({
        kind: cost.kind,
        currency: 'CNY',
        picoYuan: cost.picoYuan,
        catalogVersion: boundedCatalogVersion(cost.catalogVersion, 'presentation cost catalog version'),
        billingAuthority: false
    });
}
export function parsePresentationUsageSummary(value) {
    const usage = exactDataRecord(value, USAGE_KEYS, 'presentation usage');
    if (usage.schemaVersion !== 1 ||
        (usage.availability !== 'complete' && usage.availability !== 'partial' &&
            usage.availability !== 'unavailable') ||
        typeof usage.cacheUsageComplete !== 'boolean') {
        throw new TypeError('presentation usage is invalid');
    }
    const inputTokens = nonNegativeInteger(usage.inputTokens, 'presentation input tokens');
    const outputTokens = nonNegativeInteger(usage.outputTokens, 'presentation output tokens');
    const totalTokens = nonNegativeInteger(usage.totalTokens, 'presentation total tokens');
    const cacheHitTokens = nonNegativeInteger(usage.cacheHitTokens, 'presentation cache hit tokens');
    const cacheMissTokens = nonNegativeInteger(usage.cacheMissTokens, 'presentation cache miss tokens');
    const cacheTokens = safeSum(cacheHitTokens, cacheMissTokens, 'presentation cache token sum');
    if (safeSum(inputTokens, outputTokens, 'presentation token sum') !== totalTokens ||
        cacheTokens > inputTokens ||
        (usage.cacheUsageComplete && cacheTokens !== inputTokens) ||
        (usage.availability !== 'complete' && usage.cacheUsageComplete)) {
        throw new TypeError('presentation usage is inconsistent');
    }
    const cost = parsePresentationCost(usage.cost);
    if ((cost.kind === 'exact' &&
        (usage.availability !== 'complete' || !usage.cacheUsageComplete)) ||
        (cost.kind === 'upper_bound' &&
            (usage.availability !== 'complete' || usage.cacheUsageComplete)) ||
        (cost.kind === 'unavailable' && usage.availability === 'complete' &&
            cost.catalogVersion !== null)) {
        throw new TypeError('presentation usage cost state is inconsistent');
    }
    return Object.freeze({
        schemaVersion: 1,
        availability: usage.availability,
        inputTokens,
        outputTokens,
        totalTokens,
        cacheHitTokens,
        cacheMissTokens,
        cacheUsageComplete: usage.cacheUsageComplete,
        cost
    });
}
function boundedNfcText(value, label, maxCodePoints) {
    if (typeof value !== 'string' || value.trim() === '' ||
        value.normalize('NFC') !== value || [...value].length > maxCodePoints) {
        throw new TypeError(`${label} must be non-empty NFC text within its limit`);
    }
    return value;
}
function parseReasoningSegment(value) {
    const segment = exactDataRecord(value, REASONING_KEYS, 'reasoning trace segment');
    if (segment.kind !== 'reasoning' || typeof segment.truncated !== 'boolean') {
        throw new TypeError('reasoning trace segment is invalid');
    }
    return Object.freeze({
        kind: 'reasoning',
        step: nonNegativeInteger(segment.step, 'reasoning trace step'),
        turn: positiveInteger(segment.turn, 'reasoning trace turn'),
        text: boundedNfcText(segment.text, 'reasoning trace text', PRESENTATION_TRACE_MAX_REASONING_CODE_POINTS),
        truncated: segment.truncated
    });
}
function parseToolSegment(value) {
    const segment = exactDataRecord(value, TOOL_KEYS, 'tool trace segment');
    if (segment.kind !== 'tool' || typeof segment.toolName !== 'string' ||
        !TOOL_NAME.test(segment.toolName) ||
        typeof segment.outcome !== 'string' ||
        !TOOL_OUTCOMES.has(segment.outcome) ||
        typeof segment.truncated !== 'boolean') {
        throw new TypeError('tool trace segment is invalid');
    }
    return Object.freeze({
        kind: 'tool',
        step: nonNegativeInteger(segment.step, 'tool trace step'),
        index: nonNegativeInteger(segment.index, 'tool trace index'),
        toolName: segment.toolName,
        outcome: segment.outcome,
        argumentsSummary: boundedNfcText(segment.argumentsSummary, 'tool argument summary', PRESENTATION_TRACE_MAX_ARGUMENT_CODE_POINTS),
        resultSummary: boundedNfcText(segment.resultSummary, 'tool result summary', PRESENTATION_TRACE_MAX_RESULT_CODE_POINTS),
        truncated: segment.truncated
    });
}
function parseSegment(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError('presentation trace segment is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('presentation trace segment must contain own data properties');
    }
    const discriminator = descriptor.value;
    if (discriminator === 'reasoning')
        return parseReasoningSegment(value);
    if (discriminator === 'tool')
        return parseToolSegment(value);
    throw new TypeError('presentation trace segment kind is invalid');
}
function validateChronology(segments) {
    let previousStep = -1;
    let previousTurn = 0;
    let previousKind = null;
    let previousToolIndex = -1;
    for (const segment of segments) {
        if (segment.step < previousStep ||
            (segment.step === previousStep && previousKind === 'tool' && segment.kind === 'reasoning')) {
            throw new TypeError('presentation trace segment order is invalid');
        }
        if (segment.kind === 'reasoning') {
            if (segment.turn <= previousTurn) {
                throw new TypeError('presentation reasoning order is invalid');
            }
            previousTurn = segment.turn;
        }
        else {
            if (segment.step !== previousStep)
                previousToolIndex = -1;
            if (segment.index <= previousToolIndex) {
                throw new TypeError('presentation tool order is invalid');
            }
            previousToolIndex = segment.index;
        }
        if (segment.step !== previousStep && segment.kind === 'reasoning') {
            previousToolIndex = -1;
        }
        previousStep = segment.step;
        previousKind = segment.kind;
    }
}
export function parsePresentationTrace(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError('presentation trace is invalid');
    }
    const schemaDescriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
    if (schemaDescriptor === undefined || !Object.hasOwn(schemaDescriptor, 'value')) {
        throw new TypeError('presentation trace must contain own data properties');
    }
    const schemaVersion = schemaDescriptor.value;
    const hasUsage = Object.hasOwn(value, 'usage');
    const keys = schemaVersion === 1
        ? TRACE_V1_KEYS
        : schemaVersion === 2
            ? hasUsage ? TRACE_V2_KEYS : TRACE_V1_KEYS
            : [];
    const trace = exactDataRecord(value, keys, 'presentation trace');
    if ((trace.schemaVersion !== 1 && trace.schemaVersion !== 2) ||
        typeof trace.truncated !== 'boolean' || !Array.isArray(trace.segments)) {
        throw new TypeError('presentation trace segment limit or schema is invalid');
    }
    const segments = Object.freeze(exactArrayValues(trace.segments, PRESENTATION_TRACE_MAX_SEGMENTS, 'presentation trace segments').map(parseSegment));
    const reasoningCount = segments.filter(segment => segment.kind === 'reasoning').length;
    const toolCount = segments.length - reasoningCount;
    const reasoningCodePoints = segments.reduce((total, segment) => (total + (segment.kind === 'reasoning' ? [...segment.text].length : 0)), 0);
    if (reasoningCount > PRESENTATION_TRACE_MAX_REASONING_SEGMENTS ||
        toolCount > PRESENTATION_TRACE_MAX_TOOL_SEGMENTS ||
        reasoningCodePoints > PRESENTATION_TRACE_MAX_TOTAL_REASONING_CODE_POINTS) {
        throw new TypeError('presentation trace segment kind limit exceeded');
    }
    if (!trace.truncated && segments.some(segment => segment.truncated)) {
        throw new TypeError('presentation trace truncation state is invalid');
    }
    validateChronology(segments);
    const parsed = Object.freeze({
        schemaVersion: trace.schemaVersion,
        truncated: trace.truncated,
        segments,
        ...(trace.schemaVersion === 2 && hasUsage
            ? { usage: parsePresentationUsageSummary(trace.usage) }
            : {})
    });
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > PRESENTATION_TRACE_MAX_BYTES) {
        throw new TypeError('presentation trace byte limit exceeded');
    }
    return trace.schemaVersion === 1 && segments.length === 0 && !parsed.truncated
        ? EMPTY_PRESENTATION_TRACE
        : parsed;
}
