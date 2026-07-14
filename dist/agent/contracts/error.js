export const AGENT_ERROR_CODES = Object.freeze([
    'invalid_request',
    'invalid_session',
    'storage_unavailable',
    'storage_invalid_data',
    'context_budget_exceeded',
    'provider_authentication',
    'provider_invalid_request',
    'provider_rate_limited',
    'provider_unavailable',
    'provider_timeout',
    'provider_protocol_error',
    'run_budget_exceeded',
    'checkpoint_conflict',
    'checkpoint_invalid',
    'approval_expired',
    'authorization_changed',
    'tool_outcome_unknown',
    'cancelled',
    'internal_error',
    'internal'
]);
export function isAgentErrorCode(value) {
    return typeof value === 'string' && AGENT_ERROR_CODES.includes(value);
}
export class AgentError extends Error {
    code;
    stage;
    retryable;
    userMessage;
    details;
    cause;
    constructor(options) {
        super(options.userMessage, { cause: options.cause });
        this.name = 'AgentError';
        this.code = options.code;
        this.stage = options.stage;
        this.retryable = options.retryable;
        this.userMessage = options.userMessage;
        this.details = Object.freeze({ ...(options.details ?? {}) });
        this.cause = options.cause;
    }
}
export function serializeAgentError(error) {
    return Object.freeze({
        code: error.code,
        stage: error.stage,
        retryable: error.retryable,
        userMessage: error.userMessage,
        details: error.details
    });
}
