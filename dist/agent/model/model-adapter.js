import { AgentError } from '../contracts/error.js';
const SAFE_CODE = /^[a-z0-9_.:-]{1,128}$/i;
export class ModelProviderError extends AgentError {
    statusCode;
    providerCode;
    profileCode;
    constructor(options) {
        super({
            code: options.code,
            stage: options.stage,
            retryable: options.retryable,
            userMessage: options.userMessage,
            details: options.details
        });
        this.name = 'ModelProviderError';
        this.statusCode = options.statusCode ?? null;
        this.providerCode = options.providerCode && SAFE_CODE.test(options.providerCode)
            ? options.providerCode
            : undefined;
        this.profileCode = options.profileCode && SAFE_CODE.test(options.profileCode)
            ? options.profileCode
            : undefined;
    }
}
export function modelProtocolError(reason) {
    return new ModelProviderError({
        code: 'provider_protocol_error',
        stage: 'model.decode',
        retryable: false,
        userMessage: 'AI 服务响应格式异常，请稍后重试。',
        details: { reason }
    });
}
export function modelRequestError(reason) {
    return new ModelProviderError({
        code: 'provider_invalid_request',
        stage: 'model.request',
        retryable: false,
        userMessage: '请求格式不正确，请联系机器人主人。',
        details: { reason }
    });
}
