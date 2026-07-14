import { AgentError, isAgentErrorCode } from '../contracts/error.js';
import { parseJsonValue } from '../model/json-value.js';
import { appendRunCheckpointEvents } from './run-checkpoint.js';
import { RUN_RESOURCE_LIMITS } from './run-limits.js';
import { isTerminalRunStatus } from './run-state.js';
export class RunStoreConflictError extends AgentError {
    code;
    constructor() {
        super({
            code: 'checkpoint_conflict',
            stage: 'run.checkpoint',
            retryable: false,
            userMessage: '任务状态已发生变化，请重新发起。'
        });
        this.name = 'RunStoreConflictError';
        this.code = 'checkpoint_conflict';
    }
}
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOMBSTONE_KEYS = Object.freeze([
    'schemaVersion', 'runId', 'sessionId', 'revision', 'status', 'finishedAt',
    'visibleOutput', 'errorCode', 'cancellationReason', 'providerRetries',
    'recoveryAttempts', 'correctionTurns'
]);
function record(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('run tombstone is invalid');
    }
    return value;
}
function nonNegative(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function parseRunTombstone(value) {
    const input = record(parseJsonValue(value, {
        maxBytes: RUN_RESOURCE_LIMITS.tombstoneBytes,
        maxDepth: 4,
        maxNodes: 32
    }));
    const unknown = Object.keys(input).find(key => !TOMBSTONE_KEYS.includes(key));
    const missing = TOMBSTONE_KEYS.find(key => !Object.hasOwn(input, key));
    if (unknown !== undefined || missing !== undefined || input.schemaVersion !== 1 ||
        typeof input.runId !== 'string' || !CODE.test(input.runId) ||
        typeof input.sessionId !== 'string' || !CODE.test(input.sessionId) ||
        !nonNegative(input.revision) || typeof input.status !== 'string' ||
        !isTerminalRunStatus(input.status) ||
        typeof input.finishedAt !== 'string' ||
        new Date(input.finishedAt).toISOString() !== input.finishedAt ||
        typeof input.visibleOutput !== 'boolean' ||
        (input.errorCode !== null && !isAgentErrorCode(input.errorCode)) ||
        (input.cancellationReason !== null &&
            (typeof input.cancellationReason !== 'string' || !CODE.test(input.cancellationReason))) ||
        !nonNegative(input.providerRetries) || !nonNegative(input.recoveryAttempts) ||
        !nonNegative(input.correctionTurns)) {
        throw new TypeError('run tombstone is invalid');
    }
    const raw = JSON.stringify(input);
    if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
        throw new TypeError('run tombstone byte limit exceeded');
    }
    return Object.freeze(JSON.parse(raw));
}
export function createRunTombstone(checkpoint) {
    if (!isTerminalRunStatus(checkpoint.status)) {
        throw new TypeError('terminal checkpoint is required');
    }
    return parseRunTombstone({
        schemaVersion: 1,
        runId: checkpoint.runId,
        sessionId: checkpoint.sessionId,
        revision: checkpoint.revision,
        status: checkpoint.status,
        finishedAt: checkpoint.updatedAt,
        visibleOutput: checkpoint.visibleOutput,
        errorCode: checkpoint.error?.code ?? null,
        cancellationReason: checkpoint.cancellationReason,
        providerRetries: checkpoint.budgetCounters.providerRetries,
        recoveryAttempts: checkpoint.budgetCounters.recoveryAttempts,
        correctionTurns: checkpoint.budgetCounters.correctionTurns
    });
}
export function checkpointWithAppendedEvents(expected, events) {
    return appendRunCheckpointEvents(expected, events);
}
