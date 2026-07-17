import { createHash } from 'node:crypto';
import { isAgentErrorCode } from '../contracts/error.js';
import { RUN_REF_PATTERN } from './run-reference.js';
import { isTerminalRunStatus } from './run-state.js';
export const DURATION_BUCKET_BOUNDS_MS = Object.freeze([
    10,
    25,
    50,
    100,
    250,
    500,
    1_000,
    2_500,
    5_000,
    10_000,
    30_000,
    60_000,
    120_000,
    'inf'
]);
const COUNTER_KEYS = Object.freeze([
    'schemaVersion',
    'providerAttempts',
    'modelTurns',
    'toolAttempts',
    'providerRetries',
    'recoveryAttempts',
    'correctionTurns',
    'toolCalls',
    'approvalRequests',
    'toolDenied',
    'toolExpired',
    'toolIndeterminate',
    'estimatedTokens',
    'providerInputTokens',
    'providerOutputTokens',
    'providerTotalTokens',
    'providerActiveDurationMs',
    'engineActiveDurationMs'
]);
const PROVIDER_USAGE_KEYS = new Set([
    'providerInputTokens',
    'providerOutputTokens',
    'providerTotalTokens'
]);
const COMPLETION_BUCKETS = Object.freeze([
    '1_40', '41_200', '201_1000', '1001_4000', 'over_4000'
]);
const TERMINAL_SNAPSHOT_KEYS = Object.freeze([
    'schemaVersion',
    'observationId',
    'runRef',
    'revision',
    'status',
    'finishedAt',
    'completion',
    'errorCode',
    'cancellationReason',
    'counters',
    'engineDurationMs'
]);
const TERMINAL_CANCELLATION_REASONS = new Set([
    'user_cancelled',
    'deadline_exceeded',
    'process_shutdown',
    'approval_delivery_failed',
    'service_failure',
    'fatal_error',
    'other'
]);
const DURATION_BUCKET_KEYS = Object.freeze([
    'count',
    'sumMs',
    'unavailableCount',
    'le10',
    'le25',
    'le50',
    'le100',
    'le250',
    'le500',
    'le1000',
    'le2500',
    'le5000',
    'le10000',
    'le30000',
    'le60000',
    'le120000',
    'inf'
]);
const DURATION_CUMULATIVE_KEYS = Object.freeze([
    'le10',
    'le25',
    'le50',
    'le100',
    'le250',
    'le500',
    'le1000',
    'le2500',
    'le5000',
    'le10000',
    'le30000',
    'le60000',
    'le120000',
    'inf'
]);
const METRIC_SUMMARY_KEYS = Object.freeze([
    'schemaVersion', 'providerRequests', 'toolExecutions', 'approvals'
]);
const PROVIDER_METRIC_ROW_KEYS = Object.freeze([
    'outcome', 'attemptKind', 'count', 'duration'
]);
const TOOL_METRIC_ROW_KEYS = Object.freeze([
    'outcome', 'count', 'duration'
]);
const APPROVAL_METRIC_ROW_KEYS = Object.freeze([
    'decision', 'count'
]);
const PROVIDER_METRIC_OUTCOMES = new Set([
    'succeeded', 'failed', 'cancelled', 'unknown'
]);
const PROVIDER_ATTEMPT_KINDS = new Set([
    'primary', 'retry', 'recovery', 'correction'
]);
const TOOL_METRIC_OUTCOMES = new Set([
    'succeeded', 'failed', 'denied', 'indeterminate'
]);
const APPROVAL_METRIC_DECISIONS = new Set([
    'requested', 'approved', 'denied', 'expired'
]);
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function exactOwnData(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const input = value;
    let actual;
    try {
        actual = Reflect.ownKeys(input);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (actual.length !== keys.length || actual.some(key => (typeof key !== 'string' || !keys.includes(key)))) {
        throw new TypeError(`${label} keys are invalid`);
    }
    const output = {};
    for (const key of keys) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(input, key);
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError(`${label} field is invalid`);
        }
        output[key] = descriptor.value;
    }
    return output;
}
function exactKeys(value, keys, label) {
    const unknown = Object.keys(value).find(key => !keys.includes(key));
    const missing = keys.find(key => !Object.hasOwn(value, key));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains unknown key: ${unknown}`);
    if (missing !== undefined)
        throw new TypeError(`${label} key is missing: ${missing}`);
}
function exactOwnKeys(value, keys, label) {
    const actual = Reflect.ownKeys(value);
    const unknown = actual.find(key => typeof key !== 'string' || !keys.includes(key));
    const missing = keys.find(key => !Object.hasOwn(value, key));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains unknown key`);
    if (missing !== undefined || actual.length !== keys.length) {
        throw new TypeError(`${label} key is missing`);
    }
}
function parseCount(value, key, allowNotAttempted) {
    if (value === 'unavailable')
        return value;
    if (allowNotAttempted && value === 'not_attempted')
        return value;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${key} observation count is invalid`);
    }
    return Number(value);
}
function nonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
function positiveSafeInteger(value, label) {
    const parsed = nonNegativeSafeInteger(value, label);
    if (parsed === 0)
        throw new TypeError(`${label} is invalid`);
    return parsed;
}
function exactArray(value, maximum, label) {
    if (!Array.isArray(value))
        throw new TypeError(`${label} is invalid`);
    let keys;
    let lengthDescriptor;
    try {
        keys = Reflect.ownKeys(value);
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum ||
        keys.length !== Number(length) + 1 || !keys.includes('length')) {
        throw new TypeError(`${label} is invalid`);
    }
    return Object.freeze(Array.from({ length: Number(length) }, (_, index) => {
        const key = String(index);
        if (!keys.includes(key))
            throw new TypeError(`${label} is sparse`);
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError(`${label} item is invalid`);
        }
        return descriptor.value;
    }));
}
function assertSortedUnique(values, label) {
    for (let index = 1; index < values.length; index += 1) {
        if ((values[index - 1] ?? '') >= (values[index] ?? '')) {
            throw new TypeError(`${label} order is invalid`);
        }
    }
}
export function parseDurationBucketCounts(value) {
    const input = exactOwnData(value, DURATION_BUCKET_KEYS, 'duration bucket counts');
    const count = nonNegativeSafeInteger(input.count, 'duration count');
    const sumMs = nonNegativeSafeInteger(input.sumMs, 'duration sum');
    const unavailableCount = nonNegativeSafeInteger(input.unavailableCount, 'duration unavailable count');
    if (count === 0 && sumMs !== 0) {
        throw new TypeError('duration sum requires a measured sample');
    }
    let previous = 0;
    const cumulative = Object.fromEntries(DURATION_CUMULATIVE_KEYS.map(key => {
        const current = nonNegativeSafeInteger(input[key], `duration ${key}`);
        if (current < previous || current > count) {
            throw new TypeError('duration cumulative buckets are invalid');
        }
        previous = current;
        return [key, current];
    }));
    if (cumulative.inf !== count) {
        throw new TypeError('duration infinity bucket is invalid');
    }
    return Object.freeze({
        count,
        sumMs,
        unavailableCount,
        ...cumulative
    });
}
export function parseRunTraceMetricSummary(value) {
    const input = exactOwnData(value, METRIC_SUMMARY_KEYS, 'run trace metric summary');
    if (input.schemaVersion !== 1) {
        throw new TypeError('run trace metric summary schema is invalid');
    }
    const providerRequests = Object.freeze(exactArray(input.providerRequests, 16, 'provider metric rows').map(value => {
        const row = exactOwnData(value, PROVIDER_METRIC_ROW_KEYS, 'provider metric row');
        if (typeof row.outcome !== 'string' || !PROVIDER_METRIC_OUTCOMES.has(row.outcome) ||
            typeof row.attemptKind !== 'string' || !PROVIDER_ATTEMPT_KINDS.has(row.attemptKind)) {
            throw new TypeError('provider metric row fields are invalid');
        }
        const count = positiveSafeInteger(row.count, 'provider metric count');
        const duration = parseDurationBucketCounts(row.duration);
        if (duration.count + duration.unavailableCount !== count) {
            throw new TypeError('provider metric duration count is invalid');
        }
        return Object.freeze({
            outcome: row.outcome,
            attemptKind: row.attemptKind,
            count,
            duration
        });
    }));
    assertSortedUnique(providerRequests.map(row => `${row.outcome}\0${row.attemptKind}`), 'provider metric rows');
    const toolExecutions = Object.freeze(exactArray(input.toolExecutions, 4, 'tool metric rows').map(value => {
        const row = exactOwnData(value, TOOL_METRIC_ROW_KEYS, 'tool metric row');
        if (typeof row.outcome !== 'string' ||
            !TOOL_METRIC_OUTCOMES.has(row.outcome)) {
            throw new TypeError('tool metric row fields are invalid');
        }
        const count = positiveSafeInteger(row.count, 'tool metric count');
        const duration = parseDurationBucketCounts(row.duration);
        if (duration.count + duration.unavailableCount !== count) {
            throw new TypeError('tool metric duration count is invalid');
        }
        return Object.freeze({
            outcome: row.outcome,
            count,
            duration
        });
    }));
    assertSortedUnique(toolExecutions.map(row => row.outcome), 'tool metric rows');
    const approvals = Object.freeze(exactArray(input.approvals, 4, 'approval metric rows').map(value => {
        const row = exactOwnData(value, APPROVAL_METRIC_ROW_KEYS, 'approval metric row');
        if (typeof row.decision !== 'string' || !APPROVAL_METRIC_DECISIONS.has(row.decision)) {
            throw new TypeError('approval metric row fields are invalid');
        }
        return Object.freeze({
            decision: row.decision,
            count: positiveSafeInteger(row.count, 'approval metric count')
        });
    }));
    assertSortedUnique(approvals.map(row => row.decision), 'approval metric rows');
    return Object.freeze({
        schemaVersion: 1,
        providerRequests,
        toolExecutions,
        approvals
    });
}
export function createFrozenObservationPolicy(input) {
    if (!['off', 'basic', 'diagnostic'].includes(input.levelAtStart)) {
        throw new TypeError('observation level is invalid');
    }
    if (typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef)) {
        throw new TypeError('run reference is invalid');
    }
    let sampledSuccess = false;
    if (input.levelAtStart !== 'off') {
        const hash = createHash('sha256')
            .update(`groupmate:success:v1:${input.runRef}`, 'ascii')
            .digest();
        sampledSuccess = hash.readUInt32BE(0) % 100 < 5;
    }
    return Object.freeze({
        schemaVersion: 1,
        levelAtStart: input.levelAtStart,
        sampledSuccess
    });
}
export function parseFrozenObservationPolicy(value) {
    const policy = exactOwnData(value, ['schemaVersion', 'levelAtStart', 'sampledSuccess'], 'observation policy');
    if (policy.schemaVersion !== 1 ||
        (policy.levelAtStart !== 'off' && policy.levelAtStart !== 'basic' &&
            policy.levelAtStart !== 'diagnostic') ||
        typeof policy.sampledSuccess !== 'boolean' ||
        (policy.levelAtStart === 'off' && policy.sampledSuccess)) {
        throw new TypeError('observation policy is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        levelAtStart: policy.levelAtStart,
        sampledSuccess: policy.sampledSuccess
    });
}
export function createInitialRunObservationCounters() {
    return Object.freeze({
        schemaVersion: 1,
        providerAttempts: 0,
        modelTurns: 0,
        toolAttempts: 0,
        providerRetries: 0,
        recoveryAttempts: 0,
        correctionTurns: 0,
        toolCalls: 0,
        approvalRequests: 0,
        toolDenied: 0,
        toolExpired: 0,
        toolIndeterminate: 0,
        estimatedTokens: 0,
        providerInputTokens: 'not_attempted',
        providerOutputTokens: 'not_attempted',
        providerTotalTokens: 'not_attempted',
        providerActiveDurationMs: 0,
        engineActiveDurationMs: 0
    });
}
export function parseRunObservationCounters(value) {
    const counters = record(value, 'run observation counters');
    exactKeys(counters, COUNTER_KEYS, 'run observation counters');
    if (counters.schemaVersion !== 1) {
        throw new TypeError('run observation counters schema version is invalid');
    }
    const parsed = {};
    for (const key of COUNTER_KEYS.slice(1)) {
        parsed[key] = parseCount(counters[key], key, PROVIDER_USAGE_KEYS.has(key));
    }
    return Object.freeze({
        schemaVersion: 1,
        providerAttempts: parsed.providerAttempts,
        modelTurns: parsed.modelTurns,
        toolAttempts: parsed.toolAttempts,
        providerRetries: parsed.providerRetries,
        recoveryAttempts: parsed.recoveryAttempts,
        correctionTurns: parsed.correctionTurns,
        toolCalls: parsed.toolCalls,
        approvalRequests: parsed.approvalRequests,
        toolDenied: parsed.toolDenied,
        toolExpired: parsed.toolExpired,
        toolIndeterminate: parsed.toolIndeterminate,
        estimatedTokens: parsed.estimatedTokens,
        providerInputTokens: parsed.providerInputTokens,
        providerOutputTokens: parsed.providerOutputTokens,
        providerTotalTokens: parsed.providerTotalTokens,
        providerActiveDurationMs: parsed.providerActiveDurationMs,
        engineActiveDurationMs: parsed.engineActiveDurationMs
    });
}
export function terminalObservationId(runRef, revision) {
    if (typeof runRef !== 'string' || !RUN_REF_PATTERN.test(runRef)) {
        throw new TypeError('terminal observation run reference is invalid');
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError('terminal observation revision is invalid');
    }
    return createHash('sha256')
        .update(`groupmate:terminal:v2\0${runRef}\0${revision}`, 'utf8')
        .digest('hex');
}
export function parseCompletionObservation(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('completion observation is invalid');
    }
    const input = value;
    if (input.kind === 'reply_text') {
        exactOwnKeys(input, ['kind', 'lengthBucket'], 'completion observation');
        if (!COMPLETION_BUCKETS.includes(input.lengthBucket)) {
            throw new TypeError('completion observation length bucket is invalid');
        }
        return Object.freeze({
            kind: 'reply_text',
            lengthBucket: input.lengthBucket
        });
    }
    if (input.kind === 'already_visible') {
        exactOwnKeys(input, ['kind', 'source'], 'completion observation');
        if (input.source !== 'tool_output') {
            throw new TypeError('completion observation source is invalid');
        }
        return Object.freeze({ kind: 'already_visible', source: 'tool_output' });
    }
    if (input.kind === 'allowed_silence') {
        exactOwnKeys(input, ['kind', 'reason'], 'completion observation');
        if (input.reason !== 'proactive_empty_directive') {
            throw new TypeError('completion observation reason is invalid');
        }
        return Object.freeze({
            kind: 'allowed_silence',
            reason: 'proactive_empty_directive'
        });
    }
    if (input.kind === 'none') {
        exactOwnKeys(input, ['kind'], 'completion observation');
        return Object.freeze({ kind: 'none' });
    }
    throw new TypeError('completion observation kind is invalid');
}
function textLengthBucket(text) {
    const length = [...text].length;
    if (length <= 40)
        return '1_40';
    if (length <= 200)
        return '41_200';
    if (length <= 1_000)
        return '201_1000';
    if (length <= 4_000)
        return '1001_4000';
    return 'over_4000';
}
function completionObservation(completion) {
    if (completion === null)
        return Object.freeze({ kind: 'none' });
    if (completion.kind === 'reply_text') {
        return Object.freeze({
            kind: 'reply_text',
            lengthBucket: textLengthBucket(completion.text)
        });
    }
    if (completion.kind === 'already_visible') {
        return Object.freeze({ kind: 'already_visible', source: 'tool_output' });
    }
    return Object.freeze({
        kind: 'allowed_silence',
        reason: 'proactive_empty_directive'
    });
}
function terminalCancellationReason(value) {
    if (value === null)
        return null;
    return TERMINAL_CANCELLATION_REASONS.has(value) ? value : 'other';
}
export function parseRunTerminalSnapshot(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('run terminal snapshot is invalid');
    }
    const input = value;
    exactOwnKeys(input, TERMINAL_SNAPSHOT_KEYS, 'run terminal snapshot');
    if (input.schemaVersion !== 2 ||
        typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef) ||
        !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
        typeof input.status !== 'string' ||
        !isTerminalRunStatus(input.status) ||
        typeof input.finishedAt !== 'string') {
        throw new TypeError('run terminal snapshot fields are invalid');
    }
    try {
        if (new Date(input.finishedAt).toISOString() !== input.finishedAt) {
            throw new TypeError('run terminal snapshot timestamp is invalid');
        }
    }
    catch {
        throw new TypeError('run terminal snapshot timestamp is invalid');
    }
    const revision = Number(input.revision);
    if (input.observationId !== terminalObservationId(input.runRef, revision)) {
        throw new TypeError('run terminal snapshot observation ID is invalid');
    }
    const completion = parseCompletionObservation(input.completion);
    if (input.errorCode !== null && !isAgentErrorCode(input.errorCode)) {
        throw new TypeError('run terminal snapshot error code is invalid');
    }
    if (input.cancellationReason !== null &&
        (typeof input.cancellationReason !== 'string' ||
            !TERMINAL_CANCELLATION_REASONS.has(input.cancellationReason))) {
        throw new TypeError('run terminal snapshot cancellation reason is invalid');
    }
    if (input.status === 'completed') {
        if (completion.kind === 'none' || input.errorCode !== null ||
            input.cancellationReason !== null) {
            throw new TypeError('run terminal snapshot completed matrix is invalid');
        }
    }
    else if (input.status === 'failed') {
        if (completion.kind !== 'none' || input.errorCode === null ||
            input.cancellationReason !== null) {
            throw new TypeError('run terminal snapshot failed matrix is invalid');
        }
    }
    else if (completion.kind !== 'none' || input.errorCode !== null ||
        input.cancellationReason === null) {
        throw new TypeError('run terminal snapshot cancelled matrix is invalid');
    }
    const counters = parseRunObservationCounters(input.counters);
    if (input.engineDurationMs === 'not_attempted' ||
        input.engineDurationMs !== counters.engineActiveDurationMs) {
        throw new TypeError('run terminal snapshot engine duration is invalid');
    }
    return Object.freeze({
        schemaVersion: 2,
        observationId: input.observationId,
        runRef: input.runRef,
        revision,
        status: input.status,
        finishedAt: input.finishedAt,
        completion,
        errorCode: input.errorCode,
        cancellationReason: input.cancellationReason,
        counters,
        engineDurationMs: input.engineDurationMs
    });
}
export function createRunTerminalSnapshot(checkpoint) {
    if (!isTerminalRunStatus(checkpoint.status)) {
        throw new TypeError('terminal checkpoint is required');
    }
    if (checkpoint.providerDispatch.state !== 'idle' ||
        checkpoint.engineActivity.state !== 'idle') {
        throw new TypeError('terminal checkpoint contains a reservation');
    }
    return parseRunTerminalSnapshot({
        schemaVersion: 2,
        observationId: terminalObservationId(checkpoint.runRef, checkpoint.revision),
        runRef: checkpoint.runRef,
        revision: checkpoint.revision,
        status: checkpoint.status,
        finishedAt: checkpoint.updatedAt,
        completion: completionObservation(checkpoint.completion),
        errorCode: checkpoint.error?.code ?? null,
        cancellationReason: terminalCancellationReason(checkpoint.cancellationReason),
        counters: checkpoint.observationCounters,
        engineDurationMs: checkpoint.observationCounters.engineActiveDurationMs
    });
}
