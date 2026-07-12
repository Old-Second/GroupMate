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
