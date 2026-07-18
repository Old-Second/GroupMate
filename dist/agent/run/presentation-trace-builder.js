import { types as utilTypes } from 'node:util';
import { PRESENTATION_TRACE_MAX_ARGUMENT_CODE_POINTS, PRESENTATION_TRACE_MAX_BYTES, PRESENTATION_TRACE_MAX_REASONING_SEGMENTS, PRESENTATION_TRACE_MAX_RESULT_CODE_POINTS, PRESENTATION_TRACE_MAX_SEGMENTS, PRESENTATION_TRACE_MAX_TOOL_SEGMENTS, parsePresentationTrace, parsePresentationUsageSummary } from '../contracts/presentation-trace.js';
import { calculateModelCost } from '../model/model-cost.js';
import { parseModelPriceSnapshot } from '../model/model-price-catalog.js';
import { parseRunUsageSummary } from './run-usage.js';
const REDACTED = '[已隐藏]';
const TRUNCATION_MARKER = '…（内容已截断）';
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MAX_SAFE_JSON_DEPTH = 8;
const MAX_SAFE_JSON_NODES = 512;
const MAX_SAFE_JSON_ARRAY_ITEMS = 128;
const SENSITIVE_KEYS = new Set([
    'apikey', 'token', 'accesstoken', 'refreshtoken', 'authtoken',
    'secret', 'clientsecret', 'password', 'passwd', 'authorization',
    'cookie', 'credential', 'privatekey'
]);
const RUN_USAGE_KEYS = Object.freeze([
    'schemaVersion', 'availability', 'inputTokens', 'outputTokens', 'totalTokens',
    'cacheHitTokens', 'cacheMissTokens', 'turnsWithUsage', 'turnsWithoutUsage',
    'cacheUsageComplete'
]);
const MODEL_PRICE_KEYS = Object.freeze([
    'schemaVersion', 'catalogVersion', 'model',
    'inputCacheHitPicoYuanPerMillionTokens',
    'inputCacheMissPicoYuanPerMillionTokens',
    'outputPicoYuanPerMillionTokens'
]);
function normalizedKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isSensitiveKey(key) {
    return SENSITIVE_KEYS.has(normalizedKey(key));
}
function ownDataValue(value, key, label) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} must contain own data properties`);
    }
    return descriptor.value;
}
function exactDataRecord(value, keys, optionalKeys = []) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError('trace projection record is invalid');
    }
    const ownKeys = Reflect.ownKeys(value);
    const allowed = [...keys, ...optionalKeys];
    if (ownKeys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
        keys.some(key => !ownKeys.includes(key))) {
        throw new TypeError('trace projection record keys are invalid');
    }
    const result = Object.create(null);
    for (const key of ownKeys) {
        if (typeof key !== 'string')
            throw new TypeError('trace projection key is invalid');
        result[key] = ownDataValue(value, key, 'trace projection record');
    }
    return Object.freeze(result);
}
function ownArrayValues(value) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw new TypeError('trace projection array is invalid');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        Number(lengthDescriptor.value) > MAX_SAFE_JSON_ARRAY_ITEMS) {
        throw new TypeError('trace projection array is invalid');
    }
    const length = Number(lengthDescriptor.value);
    const allowedKeys = new Set(['length']);
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        result.push(ownDataValue(value, key, 'trace projection array'));
    }
    if (Reflect.ownKeys(value).some(key => (typeof key !== 'string' || !allowedKeys.has(key)))) {
        throw new TypeError('trace projection array keys are invalid');
    }
    return Object.freeze(result);
}
function scrubUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return value;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return value;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
        if (isSensitiveKey(key))
            parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
}
function scrubString(value) {
    const normalized = value.normalize('NFC');
    const withHeadersHidden = normalized
        .replace(/\bauthorization\s*[:=]\s*[^\r\n]*/giu, `Authorization: ${REDACTED}`)
        .replace(/\bcookie\s*[:=]\s*[^\r\n]*/giu, `Cookie: ${REDACTED}`)
        .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
    return withHeadersHidden.replace(/https?:\/\/[^\s<>"']+/giu, candidate => scrubUrl(candidate));
}
function safeJsonValue(value, state, depth = 0) {
    state.nodes += 1;
    if (state.nodes > MAX_SAFE_JSON_NODES || depth > MAX_SAFE_JSON_DEPTH) {
        throw new TypeError('trace projection JSON limit exceeded');
    }
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return scrubString(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new TypeError('trace projection number is invalid');
        return value;
    }
    if (Array.isArray(value)) {
        return Object.freeze(ownArrayValues(value).map(item => (safeJsonValue(item, state, depth + 1))));
    }
    if (typeof value !== 'object')
        throw new TypeError('trace projection value is unsupported');
    if (utilTypes.isProxy(value))
        throw new TypeError('trace projection proxy is invalid');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('trace projection object prototype is invalid');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) {
        throw new TypeError('trace projection object key is invalid');
    }
    const normalizedEntries = keys.map(rawKey => {
        const key = String(rawKey).normalize('NFC');
        const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('trace projection object must contain own data properties');
        }
        return Object.freeze({ key, value: descriptor.value });
    }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    if (new Set(normalizedEntries.map(entry => entry.key)).size !== normalizedEntries.length) {
        throw new TypeError('trace projection object keys collide after normalization');
    }
    const result = Object.create(null);
    for (const entry of normalizedEntries) {
        result[entry.key] = isSensitiveKey(entry.key)
            ? REDACTED
            : safeJsonValue(entry.value, state, depth + 1);
    }
    return Object.freeze(result);
}
function truncateText(value, maxCodePoints) {
    const text = value.trim().normalize('NFC');
    const points = [...text];
    if (points.length <= maxCodePoints) {
        return Object.freeze({ text: text === '' ? '-' : text, truncated: false });
    }
    const marker = [...TRUNCATION_MARKER];
    const retained = Math.max(0, maxCodePoints - marker.length);
    return Object.freeze({
        text: `${points.slice(0, retained).join('')}${TRUNCATION_MARKER}`,
        truncated: true
    });
}
function argumentSummary(value) {
    const sanitized = safeJsonValue(value, { nodes: 0 });
    return truncateText(JSON.stringify(sanitized), PRESENTATION_TRACE_MAX_ARGUMENT_CODE_POINTS);
}
function resourceSummary(value) {
    const resource = exactDataRecord(value, ['type', 'resourceType', 'resourceId'], ['mimeType']);
    if (resource.type !== 'resource_ref' || typeof resource.resourceType !== 'string' ||
        typeof resource.resourceId !== 'string' ||
        (resource.mimeType !== undefined && typeof resource.mimeType !== 'string')) {
        throw new TypeError('trace resource result is invalid');
    }
    const resourceType = scrubString(resource.resourceType).trim().normalize('NFC');
    const mimeType = typeof resource.mimeType === 'string'
        ? scrubString(resource.mimeType).trim().normalize('NFC')
        : '';
    if (resourceType === '')
        throw new TypeError('trace resource type is invalid');
    return `资源：${resourceType}${mimeType === '' ? '' : ` (${mimeType})`}`;
}
function successResultSummary(result) {
    if (result.effect === 'visible')
        return '结果已通过工具发送';
    if (result.effect !== 'none' && result.effect !== 'background') {
        throw new TypeError('trace tool effect is invalid');
    }
    const lines = ownArrayValues(result.content).map(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new TypeError('trace tool content item is invalid');
        }
        const type = ownDataValue(item, 'type', 'trace tool content item');
        if (type === 'text') {
            const textItem = exactDataRecord(item, ['type', 'text']);
            if (typeof textItem.text !== 'string')
                throw new TypeError('trace tool text is invalid');
            return scrubString(textItem.text).trim().normalize('NFC');
        }
        if (type === 'resource_ref')
            return resourceSummary(item);
        throw new TypeError('trace tool content type is invalid');
    }).filter(line => line !== '');
    return lines.length === 0
        ? '执行成功，工具未返回文本结果'
        : lines.join('\n');
}
function resultSummary(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('trace tool result is missing');
    }
    const status = ownDataValue(value, 'status', 'trace tool result');
    let summary;
    if (status === 'success') {
        const result = exactDataRecord(value, ['status', 'effect', 'content', 'retryable']);
        if (result.retryable !== false)
            throw new TypeError('trace success result is invalid');
        summary = successResultSummary(result);
    }
    else if (status === 'denied') {
        const result = exactDataRecord(value, ['status', 'effect', 'reasonCode', 'userMessage', 'retryable']);
        if (typeof result.userMessage !== 'string')
            throw new TypeError('trace denied result is invalid');
        summary = scrubString(result.userMessage);
    }
    else if (status === 'failed' || status === 'indeterminate') {
        const result = exactDataRecord(value, ['status', 'effect', 'errorCode', 'userMessage', 'retryable']);
        if (typeof result.userMessage !== 'string')
            throw new TypeError('trace failed result is invalid');
        summary = scrubString(result.userMessage);
    }
    else {
        throw new TypeError('trace tool result status is invalid');
    }
    return truncateText(summary, PRESENTATION_TRACE_MAX_RESULT_CODE_POINTS);
}
function toolOutcome(status) {
    if (status === 'succeeded')
        return 'succeeded';
    if (status === 'denied' || status === 'rejected' || status === 'expired')
        return 'denied';
    if (status === 'failed' || status === 'cancelled')
        return 'failed';
    return 'indeterminate';
}
function projectToolCall(call) {
    const step = ownDataValue(call, 'step', 'tool ledger call');
    const index = ownDataValue(call, 'index', 'tool ledger call');
    const toolName = ownDataValue(call, 'toolName', 'tool ledger call');
    const status = ownDataValue(call, 'status', 'tool ledger call');
    const argumentsValue = ownDataValue(call, 'arguments', 'tool ledger call');
    const result = ownDataValue(call, 'result', 'tool ledger call');
    if (!Number.isSafeInteger(step) || Number(step) < 0 ||
        !Number.isSafeInteger(index) || Number(index) < 0 ||
        typeof toolName !== 'string' || !TOOL_NAME.test(toolName) ||
        typeof status !== 'string' ||
        !['denied', 'rejected', 'expired', 'succeeded', 'failed', 'cancelled', 'indeterminate']
            .includes(status)) {
        throw new TypeError('terminal tool ledger call is invalid');
    }
    const argumentsSummary = argumentSummary(argumentsValue);
    const resultText = resultSummary(result);
    return Object.freeze({
        kind: 'tool',
        step: Number(step),
        index: Number(index),
        toolName,
        outcome: toolOutcome(status),
        argumentsSummary: argumentsSummary.text,
        resultSummary: resultText.text,
        truncated: argumentsSummary.truncated || resultText.truncated
    });
}
function segmentWithMarker(segment, retainedCodePoints) {
    const field = segment.kind === 'reasoning' ? segment.text : segment.resultSummary;
    const points = [...field];
    const markerPoints = [...TRUNCATION_MARKER];
    const retained = Math.max(0, Math.min(retainedCodePoints, points.length, (segment.kind === 'reasoning'
        ? 2_000
        : PRESENTATION_TRACE_MAX_RESULT_CODE_POINTS) - markerPoints.length));
    const marked = `${points.slice(0, retained).join('')}${TRUNCATION_MARKER}`;
    return segment.kind === 'reasoning'
        ? Object.freeze({ ...segment, text: marked, truncated: true })
        : Object.freeze({ ...segment, resultSummary: marked, truncated: true });
}
function traceBytes(segments, truncated, usage) {
    return Buffer.byteLength(JSON.stringify({
        schemaVersion: 2,
        truncated,
        segments,
        ...(usage === undefined ? {} : { usage })
    }), 'utf8');
}
function fitMarkedSegment(prefix, segment, usage) {
    const field = segment.kind === 'reasoning' ? segment.text : segment.resultSummary;
    let low = 0;
    let high = [...field].length;
    let fitted = null;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = segmentWithMarker(segment, middle);
        if (traceBytes([...prefix, candidate], true, usage) <= PRESENTATION_TRACE_MAX_BYTES) {
            fitted = candidate;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    return fitted;
}
function finalizeTruncatedPrefix(prefix, usage, candidate) {
    if (candidate !== undefined) {
        const fitted = fitMarkedSegment(prefix, candidate, usage);
        if (fitted !== null) {
            return parsePresentationTrace({
                schemaVersion: 2,
                truncated: true,
                segments: [...prefix, fitted],
                ...(usage === undefined ? {} : { usage })
            });
        }
    }
    const previous = prefix.at(-1);
    if (previous === undefined) {
        return parsePresentationTrace({
            schemaVersion: 2,
            truncated: true,
            segments: [],
            ...(usage === undefined ? {} : { usage })
        });
    }
    const earlier = prefix.slice(0, -1);
    const fittedPrevious = fitMarkedSegment(earlier, previous, usage);
    if (fittedPrevious === null) {
        return parsePresentationTrace({
            schemaVersion: 2,
            truncated: true,
            segments: [],
            ...(usage === undefined ? {} : { usage })
        });
    }
    return parsePresentationTrace({
        schemaVersion: 2,
        truncated: true,
        segments: [...earlier, fittedPrevious],
        ...(usage === undefined ? {} : { usage })
    });
}
function detachedDataRecord(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => (typeof key !== 'string' || !keys.includes(key))) || keys.some(key => !ownKeys.includes(key))) {
        throw new TypeError(`${label} keys are invalid`);
    }
    const result = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain enumerable own data properties`);
        }
        result[key] = descriptor.value;
    }
    return Object.freeze(result);
}
function projectUsage(usageValue, priceValue) {
    const usage = parseRunUsageSummary(detachedDataRecord(usageValue, RUN_USAGE_KEYS, 'presentation run usage'));
    const price = priceValue === null
        ? null
        : parseModelPriceSnapshot(detachedDataRecord(priceValue, MODEL_PRICE_KEYS, 'presentation model price'));
    const allMissIsNotUpperBound = usage.availability === 'complete' &&
        !usage.cacheUsageComplete && price !== null &&
        price.inputCacheMissPicoYuanPerMillionTokens <
            price.inputCacheHitPicoYuanPerMillionTokens;
    const cost = usage.availability !== 'complete' || allMissIsNotUpperBound
        ? Object.freeze({
            kind: 'unavailable',
            catalogVersion: price?.catalogVersion ?? null,
            billingAuthority: false
        })
        : calculateModelCost(price ?? undefined, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            ...(usage.cacheUsageComplete
                ? {
                    inputCache: Object.freeze({
                        hitTokens: usage.cacheHitTokens,
                        missTokens: usage.cacheMissTokens
                    })
                }
                : {})
        });
    return parsePresentationUsageSummary({
        schemaVersion: 1,
        availability: usage.availability,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheHitTokens: usage.cacheHitTokens,
        cacheMissTokens: usage.cacheMissTokens,
        cacheUsageComplete: usage.cacheUsageComplete,
        cost: cost.kind === 'unavailable'
            ? cost
            : Object.freeze({ ...cost, picoYuan: cost.picoYuan.toString(10) })
    });
}
function candidateOrder(left, right) {
    if (left.segment.step !== right.segment.step) {
        return left.segment.step - right.segment.step;
    }
    if (left.segment.kind !== right.segment.kind) {
        return left.segment.kind === 'reasoning' ? -1 : 1;
    }
    const leftIndex = left.segment.kind === 'reasoning'
        ? left.segment.turn
        : left.segment.index;
    const rightIndex = right.segment.kind === 'reasoning'
        ? right.segment.turn
        : right.segment.index;
    return leftIndex - rightIndex || left.ordinal - right.ordinal;
}
export function buildPresentationTrace(input) {
    let usage;
    try {
        usage = projectUsage(input.usage, input.modelPrice);
    }
    catch {
        usage = undefined;
    }
    try {
        const candidates = [];
        let projectionTruncated = false;
        let ordinal = 0;
        for (const segment of input.reasoningSegments) {
            try {
                const step = ownDataValue(segment, 'step', 'reasoning segment');
                const turn = ownDataValue(segment, 'turn', 'reasoning segment');
                const sourceText = ownDataValue(segment, 'text', 'reasoning segment');
                const sourceTruncated = ownDataValue(segment, 'truncated', 'reasoning segment');
                if (!Number.isSafeInteger(step) || Number(step) < 0 ||
                    !Number.isSafeInteger(turn) || Number(turn) <= 0 ||
                    typeof sourceText !== 'string' || typeof sourceTruncated !== 'boolean') {
                    throw new TypeError('reasoning segment is invalid');
                }
                const text = truncateText(sourceText, 2_000);
                candidates.push(Object.freeze({
                    ordinal: ordinal++,
                    segment: Object.freeze({
                        kind: 'reasoning',
                        step: Number(step),
                        turn: Number(turn),
                        text: text.text,
                        truncated: sourceTruncated || text.truncated
                    })
                }));
            }
            catch {
                projectionTruncated = true;
            }
        }
        for (const ledger of input.toolLedgers) {
            let calls;
            try {
                calls = ownArrayValues(ownDataValue(ledger, 'calls', 'tool ledger'));
            }
            catch {
                projectionTruncated = true;
                continue;
            }
            for (const call of calls) {
                try {
                    candidates.push(Object.freeze({
                        ordinal: ordinal++,
                        segment: projectToolCall(call)
                    }));
                }
                catch {
                    projectionTruncated = true;
                }
            }
        }
        candidates.sort(candidateOrder);
        const prefix = [];
        let reasoningCount = 0;
        let toolCount = 0;
        for (const candidate of candidates) {
            const isReasoning = candidate.segment.kind === 'reasoning';
            if (prefix.length >= PRESENTATION_TRACE_MAX_SEGMENTS ||
                (isReasoning && reasoningCount >= PRESENTATION_TRACE_MAX_REASONING_SEGMENTS) ||
                (!isReasoning && toolCount >= PRESENTATION_TRACE_MAX_TOOL_SEGMENTS)) {
                return finalizeTruncatedPrefix(prefix, usage);
            }
            if (traceBytes([...prefix, candidate.segment], projectionTruncated, usage) >
                PRESENTATION_TRACE_MAX_BYTES) {
                return finalizeTruncatedPrefix(prefix, usage, candidate.segment);
            }
            prefix.push(candidate.segment);
            if (isReasoning)
                reasoningCount += 1;
            else
                toolCount += 1;
            if (candidate.segment.truncated)
                projectionTruncated = true;
        }
        return parsePresentationTrace({
            schemaVersion: 2,
            truncated: projectionTruncated,
            segments: prefix,
            ...(usage === undefined ? {} : { usage })
        });
    }
    catch {
        return parsePresentationTrace({
            schemaVersion: 2,
            truncated: true,
            segments: [],
            ...(usage === undefined ? {} : { usage })
        });
    }
}
