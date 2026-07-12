import { parseAgentMessage } from './content.js';
const agentErrorCodes = [
    'invalid_request',
    'invalid_session',
    'storage_unavailable',
    'storage_invalid_data',
    'context_budget_exceeded',
    'cancelled',
    'internal'
];
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
    if (result.status === 'failed') {
        if (result.error === null || typeof result.error !== 'object' || Array.isArray(result.error)) {
            throw new TypeError('agent result error is invalid');
        }
        const error = result.error;
        const keys = ['code', 'stage', 'retryable', 'userMessage', 'details'];
        if (Object.keys(error).some(key => !keys.includes(key)))
            throw new TypeError('agent result error contains unknown keys');
        if (!agentErrorCodes.includes(error.code) || typeof error.stage !== 'string' || typeof error.retryable !== 'boolean' || typeof error.userMessage !== 'string') {
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
    }
    if (result.status === 'cancelled' && (typeof result.reason !== 'string' || result.reason.length === 0)) {
        throw new TypeError('agent result cancellation reason is invalid');
    }
    return value;
}
