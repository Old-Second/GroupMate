import { parseJsonValue } from './json-value.js';
import { normalizeModelReasoningTrace } from './model-adapter.js';
import { parseProviderTurnState } from '../run/provider-state.js';
const PROFILE_ID = 'deepseek';
const PROFILE_VERSION = 1;
const LEGACY_CONTEXT_PROFILE_CODE = 'deepseek_invalid_legacy_context';
const LEGACY_CONTEXT_MESSAGE = /^deepseek-[a-z0-9.-]+ does not support successive user or assistant messages \(messages\[\d+\] and messages\[\d+\] in your input\)\. You should interleave the user\/assistant messages in the message sequence\.$/i;
const EMPTY_OBJECT = Object.freeze({});
function hasToolCalls(message) {
    if (message.tool_calls === undefined)
        return false;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        throw new TypeError('DeepSeek tool calls must be a non-empty array');
    }
    return true;
}
function captureDeepSeekAssistantState(message) {
    if (!hasToolCalls(message))
        return undefined;
    if (typeof message.reasoning_content !== 'string') {
        throw new TypeError('DeepSeek reasoning_content is required for assistant tool calls');
    }
    return parseProviderTurnState({
        profileId: PROFILE_ID,
        profileVersion: PROFILE_VERSION,
        payload: {
            reasoningContent: message.reasoning_content
        }
    });
}
function extractDeepSeekAssistantReasoning(message) {
    const value = message.reasoning_content;
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new TypeError('DeepSeek reasoning_content is invalid');
    }
    return normalizeModelReasoningTrace(value);
}
function restoreDeepSeekAssistantState(state) {
    const parsed = parseProviderTurnState(state);
    if (parsed.profileId !== PROFILE_ID || parsed.profileVersion !== PROFILE_VERSION) {
        throw new TypeError('DeepSeek provider state profile does not match');
    }
    if (parsed.payload === null || typeof parsed.payload !== 'object' ||
        Array.isArray(parsed.payload)) {
        throw new TypeError('DeepSeek provider state payload is invalid');
    }
    const payload = parsed.payload;
    const keys = Object.keys(payload);
    if (keys.length !== 1 || keys[0] !== 'reasoningContent' ||
        typeof payload.reasoningContent !== 'string') {
        throw new TypeError('DeepSeek provider state reasoning content is invalid');
    }
    return Object.freeze({
        reasoning_content: payload.reasoningContent
    });
}
function encodeDeepSeekReasoningOptions(input) {
    return Object.freeze({
        thinking: Object.freeze({ type: input.enabled ? 'enabled' : 'disabled' }),
        ...(input.effort === undefined ? {} : { reasoning_effort: input.effort })
    });
}
function readDeepSeekError(error) {
    if (error.truncated)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(error.body);
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const nested = parsed.error;
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested))
        return undefined;
    try {
        const safe = parseJsonValue(nested, { maxBytes: 16_384 });
        return safe !== null && typeof safe === 'object' && !Array.isArray(safe)
            ? safe
            : undefined;
    }
    catch {
        return undefined;
    }
}
function isKnownLegacyContextError(error) {
    if (error.status !== 400 || error.providerCode !== 'invalid_request_error')
        return false;
    const detail = readDeepSeekError(error);
    return typeof detail?.message === 'string' && LEGACY_CONTEXT_MESSAGE.test(detail.message) &&
        detail.type === 'invalid_request_error' &&
        detail.param === null &&
        detail.code === 'invalid_request_error';
}
function classifyDeepSeekError(error) {
    if (isKnownLegacyContextError(error)) {
        return Object.freeze({
            code: 'provider_invalid_request',
            retryable: false,
            userMessage: '请求格式不正确，请联系机器人主人。',
            profileCode: LEGACY_CONTEXT_PROFILE_CODE
        });
    }
    if (error.status === 402) {
        return Object.freeze({
            code: 'provider_invalid_request',
            retryable: false,
            userMessage: 'AI 服务余额不足，请联系机器人主人。',
            profileCode: 'deepseek_balance_insufficient'
        });
    }
    if (error.status === 422) {
        return Object.freeze({
            code: 'provider_invalid_request',
            retryable: false,
            userMessage: '请求参数不受支持，请联系机器人主人。',
            profileCode: 'deepseek_invalid_parameters'
        });
    }
    if (error.status === 503) {
        return Object.freeze({
            code: 'provider_unavailable',
            retryable: true,
            userMessage: 'AI 服务繁忙，请稍后重试。',
            profileCode: 'deepseek_overloaded'
        });
    }
    return undefined;
}
function deepSeekRecoveryHint(error) {
    return error.code === 'provider_invalid_request' &&
        error.stage === 'model.response' &&
        error.statusCode === 400 &&
        error.profileCode === LEGACY_CONTEXT_PROFILE_CODE
        ? 'drop_optional_context_once'
        : 'none';
}
export const deepSeekCompatibilityProfile = Object.freeze({
    id: PROFILE_ID,
    version: PROFILE_VERSION,
    capabilities: Object.freeze({
        supportsDeveloperRole: false,
        supportsToolChoice: false,
        outputTokenField: 'max_tokens',
        requiresAssistantContentForToolCalls: true,
        requiresReasoningStateForToolCalls: true
    }),
    encodeToolControls: (input) => input.enabled
        ? Object.freeze({ tools: Object.freeze([...input.tools]) })
        : EMPTY_OBJECT,
    encodeRequestExtensions: encodeDeepSeekReasoningOptions,
    extractAssistantReasoning: extractDeepSeekAssistantReasoning,
    captureAssistantState: captureDeepSeekAssistantState,
    restoreAssistantExtensions: restoreDeepSeekAssistantState,
    classifyError: classifyDeepSeekError,
    recoveryHint: deepSeekRecoveryHint
});
