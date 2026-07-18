import { types as utilTypes } from 'node:util';
import { AgentError } from '../contracts/error.js';
const CACHE_ISOLATION_ID = /^gm_[gu]_[A-Za-z0-9_-]{43}$/;
export function parseProviderRequestMetadata(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
        Array.isArray(value)) {
        throw modelRequestError('invalid_provider_request_metadata');
    }
    let prototype;
    let keys;
    let descriptor;
    try {
        prototype = Object.getPrototypeOf(value);
        keys = Reflect.ownKeys(value);
        descriptor = Object.getOwnPropertyDescriptor(value, 'cacheIsolationId');
    }
    catch {
        throw modelRequestError('invalid_provider_request_metadata');
    }
    if (prototype !== Object.prototype || keys.length !== 1 ||
        keys[0] !== 'cacheIsolationId' || descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
        typeof descriptor.value !== 'string' || !CACHE_ISOLATION_ID.test(descriptor.value)) {
        throw modelRequestError('invalid_provider_request_metadata');
    }
    return Object.freeze({ cacheIsolationId: descriptor.value });
}
export const MAX_MODEL_REASONING_CODE_POINTS = 2_000;
export function normalizeModelReasoningTrace(value) {
    const normalized = value.trim().normalize('NFC');
    if (normalized === '')
        return undefined;
    const points = [...normalized];
    const truncated = points.length > MAX_MODEL_REASONING_CODE_POINTS;
    return Object.freeze({
        text: truncated
            ? points.slice(0, MAX_MODEL_REASONING_CODE_POINTS).join('')
            : normalized,
        truncated
    });
}
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
