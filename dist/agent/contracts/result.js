import { parseAgentMessage } from './content.js';
import { isAgentErrorCode } from './error.js';
import { parseApprovalInterruption } from '../run/interruption.js';
function parseSerializedAgentError(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('agent result error is invalid');
    }
    const error = value;
    const keys = ['code', 'stage', 'retryable', 'userMessage', 'details'];
    if (Object.keys(error).some(key => !keys.includes(key))) {
        throw new TypeError('agent result error contains unknown keys');
    }
    if (!isAgentErrorCode(error.code) || typeof error.stage !== 'string' ||
        typeof error.retryable !== 'boolean' || typeof error.userMessage !== 'string') {
        throw new TypeError('agent result error fields are invalid');
    }
    if (error.details === null || typeof error.details !== 'object' || Array.isArray(error.details)) {
        throw new TypeError('agent result error details are invalid');
    }
    for (const detail of Object.values(error.details)) {
        if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
            throw new TypeError('agent result error details contain non-primitive data');
        }
        if (typeof detail === 'number' && !Number.isFinite(detail)) {
            throw new TypeError('agent result error details contain a non-finite number');
        }
    }
    return value;
}
export function parseAgentResult(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('agent result must be an object');
    const result = value;
    const allowed = result.status === 'completed'
        ? ['status', 'output']
        : result.status === 'failed'
            ? ['status', 'error']
            : result.status === 'cancelled'
                ? ['status', 'reason']
                : [];
    if (allowed.length === 0 || Object.keys(result).some(key => !allowed.includes(key))) {
        throw new TypeError('agent result branch is invalid');
    }
    if (result.status === 'completed')
        parseAgentMessage(result.output);
    if (result.status === 'failed')
        parseSerializedAgentError(result.error);
    if (result.status === 'cancelled' && (typeof result.reason !== 'string' || result.reason.length === 0)) {
        throw new TypeError('agent result cancellation reason is invalid');
    }
    return value;
}
export function parseRunAdvanceResult(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('run advance result must be an object');
    }
    const result = value;
    if (typeof result.runId !== 'string' || result.runId.length === 0 || result.runId.length > 128) {
        throw new TypeError('run advance result run ID is invalid');
    }
    const allowed = result.kind === 'completed'
        ? ['kind', 'runId', 'output', 'visibleOutput']
        : result.kind === 'paused'
            ? ['kind', 'runId', 'interruption']
            : result.kind === 'failed'
                ? ['kind', 'runId', 'error']
                : result.kind === 'cancelled'
                    ? ['kind', 'runId', 'reason']
                    : [];
    if (allowed.length === 0 || Object.keys(result).some(key => !allowed.includes(key))) {
        throw new TypeError('run advance result branch is invalid');
    }
    if (result.kind === 'completed') {
        if (typeof result.visibleOutput !== 'boolean') {
            throw new TypeError('completed run visibility is invalid');
        }
        if (result.output === null) {
            if (!result.visibleOutput)
                throw new TypeError('completed run output is invalid');
        }
        else {
            parseAgentMessage(result.output);
        }
    }
    if (result.kind === 'paused') {
        const interruption = parseApprovalInterruption(result.interruption);
        if (interruption.runId !== result.runId) {
            throw new TypeError('paused run interruption does not match the run');
        }
    }
    if (result.kind === 'failed')
        parseSerializedAgentError(result.error);
    if (result.kind === 'cancelled' &&
        (typeof result.reason !== 'string' || result.reason.length === 0 || result.reason.length > 128)) {
        throw new TypeError('run cancellation reason is invalid');
    }
    return value;
}
