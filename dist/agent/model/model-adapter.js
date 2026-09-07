import { types as utilTypes } from 'node:util';
import { AgentError } from '../contracts/error.js';
const CACHE_ISOLATION_ID = /^gm_[gu]_[A-Za-z0-9_-]{43}$/;
export const MAX_MODEL_IMAGE_URLS = 8;
export const MAX_MODEL_IMAGE_URL_LENGTH = 8_192;
const PUBLIC_IMAGE_URL = /^https?:$/i;
export function publicModelImageUrl(value) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > MAX_MODEL_IMAGE_URL_LENGTH) {
        throw modelRequestError('invalid_model_image_url');
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw modelRequestError('invalid_model_image_url');
    }
    if (!PUBLIC_IMAGE_URL.test(url.protocol) || url.username !== '' ||
        url.password !== '' || url.hash !== '') {
        throw modelRequestError('invalid_model_image_url');
    }
    return value;
}
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
// The provider body is diagnostic content, not a scalar error field: it stays off
// `details` so it never reaches the run checkpoint or the redacted trace, and only
// the content journal may persist it.
export const PROVIDER_BODY_MAX_LENGTH = 4_096;
export function sanitizeProviderText(value, maxLength) {
    return value
        .slice(0, maxLength)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
        .replace(/https?:\/\/[^\s"']+/gi, '[url]');
}
// The journal projection rejects an over-long body, so the byte bound has to hold
// here as well: a multi-byte body must lose characters, not the whole record.
export function boundedProviderBody(value) {
    const sanitized = sanitizeProviderText(value, PROVIDER_BODY_MAX_LENGTH).trim();
    const kept = [];
    let bytes = 0;
    for (const character of sanitized) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > PROVIDER_BODY_MAX_LENGTH)
            break;
        kept.push(character);
        bytes += size;
    }
    return kept.join('');
}
export class ModelProviderError extends AgentError {
    statusCode;
    providerCode;
    profileCode;
    providerBody;
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
        const providerBody = options.providerBody === undefined
            ? ''
            : boundedProviderBody(options.providerBody);
        this.providerBody = providerBody === '' ? undefined : providerBody;
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
