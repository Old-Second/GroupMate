import { createHash } from 'node:crypto';
import { isAgentErrorCode } from '../contracts/error.js';
import { RUN_REF_PATTERN } from './run-reference.js';
import { isTerminalRunStatus } from './run-state.js';
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
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
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
    const policy = record(value, 'observation policy');
    exactKeys(policy, ['schemaVersion', 'levelAtStart', 'sampledSuccess'], 'observation policy');
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
