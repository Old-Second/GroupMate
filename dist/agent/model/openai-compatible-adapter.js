import { createParser } from 'eventsource-parser';
import { jsonByteLength, parseJsonValue } from './json-value.js';
import { ModelProviderError, modelProtocolError, modelRequestError } from './model-adapter.js';
import { asWireRecord, iterateResponseBytes, readBoundedResponseText, readBoundedWireError } from './openai-wire.js';
import { normalizeCompleteToolCalls, SseToolCallAccumulator } from './sse-tool-call-accumulator.js';
import { parseProviderTurnState } from '../run/provider-state.js';
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js';
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESPONSE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PROFILE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const RESERVED_MESSAGE_EXTENSION_KEYS = new Set(['role', 'content', 'tool_calls', 'function_call']);
const RESERVED_REQUEST_EXTENSION_KEYS = new Set([
    'model', 'messages', 'stream', 'tools', 'functions', 'tool_choice',
    'max_tokens', 'max_completion_tokens'
]);
const ALLOWED_TOOL_CONTROL_KEYS = new Set(['tools', 'tool_choice']);
const defaultFetch = async (url, init) => {
    const { default: nodeFetch } = await import('node-fetch');
    return await nodeFetch(url, init);
};
function safeErrorName(value) {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
        return undefined;
    if (typeof DOMException !== 'undefined' && value instanceof DOMException) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name');
            const name = descriptor?.get?.call(value);
            if (typeof name === 'string')
                return name;
        }
        catch {
            return undefined;
        }
    }
    let current = value;
    for (let depth = 0; current && depth < 4; depth += 1) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
            if (descriptor)
                return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
                    ? descriptor.value
                    : undefined;
            current = Object.getPrototypeOf(current);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function normalizeEndpoint(value) {
    let endpoint;
    try {
        endpoint = new URL(value);
    }
    catch {
        throw modelRequestError('invalid_provider_endpoint');
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw modelRequestError('invalid_provider_endpoint');
    }
    endpoint.hash = '';
    endpoint.search = '';
    const path = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = path.endsWith('/chat/completions')
        ? path
        : `${path}/chat/completions`;
    return endpoint.toString();
}
function assertString(value, reason, maxLength) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw modelRequestError(reason);
    }
    return value;
}
function assertFiniteNumber(value, reason) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw modelRequestError(reason);
    return value;
}
function cloneJsonObject(value, reason, maxBytes) {
    let parsed;
    try {
        parsed = parseJsonValue(value, { maxBytes });
    }
    catch {
        throw modelRequestError(reason);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw modelRequestError(reason);
    }
    return parsed;
}
function assertExtensionKeys(extensions, reserved, reason) {
    if (Object.keys(extensions).some(key => reserved.has(key)))
        throw modelRequestError(reason);
}
function wireToolCall(call) {
    if (!CALL_ID.test(call.callId))
        throw modelRequestError('invalid_tool_call_id');
    if (!TOOL_NAME.test(call.name))
        throw modelRequestError('invalid_tool_name');
    const argumentsValue = cloneJsonObject(call.arguments, 'invalid_tool_arguments', RUN_RESOURCE_LIMITS.toolArgumentsBytes);
    return Object.freeze({
        id: call.callId,
        type: 'function',
        function: Object.freeze({
            name: call.name,
            arguments: JSON.stringify(argumentsValue)
        })
    });
}
function wireMessage(message, profile) {
    if (message.role === 'system' || message.role === 'developer' || message.role === 'user') {
        const role = message.role === 'developer' && !profile.capabilities.supportsDeveloperRole
            ? 'system'
            : message.role;
        return Object.freeze({
            role,
            content: assertString(message.content, 'invalid_model_message_content', RUN_RESOURCE_LIMITS.requestBytes)
        });
    }
    if (message.role === 'tool') {
        if (!CALL_ID.test(message.toolCallId))
            throw modelRequestError('invalid_tool_result_call_id');
        if (typeof message.content !== 'string' ||
            Buffer.byteLength(message.content, 'utf8') > RUN_RESOURCE_LIMITS.toolResultBytes) {
            throw modelRequestError('invalid_tool_result_content');
        }
        return Object.freeze({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: message.content
        });
    }
    if (message.role !== 'assistant')
        throw modelRequestError('invalid_model_message_role');
    const calls = message.toolCalls?.map(wireToolCall) ?? [];
    if (calls.length > 0 && profile.capabilities.requiresReasoningStateForToolCalls &&
        message.providerState === undefined) {
        throw modelRequestError('missing_provider_state');
    }
    let extensions = Object.freeze({});
    if (message.providerState !== undefined) {
        try {
            extensions = profile.restoreAssistantExtensions(message.providerState);
        }
        catch {
            throw modelRequestError('invalid_provider_state');
        }
        assertExtensionKeys(extensions, RESERVED_MESSAGE_EXTENSION_KEYS, 'invalid_message_extensions');
    }
    const content = calls.length > 0 && profile.capabilities.requiresAssistantContentForToolCalls
        ? message.content ?? ''
        : message.content;
    if (content !== null && typeof content !== 'string') {
        throw modelRequestError('invalid_model_message_content');
    }
    return Object.freeze({
        role: 'assistant',
        content,
        ...(calls.length === 0 ? {} : { tool_calls: Object.freeze(calls) }),
        ...extensions
    });
}
function wireToolDefinition(value) {
    if (!TOOL_NAME.test(value.name))
        throw modelRequestError('invalid_tool_name');
    if (typeof value.description !== 'string' || value.description.length === 0 ||
        value.description.length > 4_096) {
        throw modelRequestError('invalid_tool_description');
    }
    const parameters = cloneJsonObject(value.parameters, 'invalid_tool_schema', RUN_RESOURCE_LIMITS.requestBytes);
    return Object.freeze({
        type: 'function',
        function: Object.freeze({
            name: value.name,
            description: value.description,
            parameters
        })
    });
}
export function buildImmutableChatRequest(request, profile) {
    if (!PROFILE_ID.test(profile.id) || !Number.isSafeInteger(profile.version) || profile.version <= 0) {
        throw modelRequestError('invalid_compatibility_profile');
    }
    const model = assertString(request.model, 'invalid_model', 256);
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
        throw modelRequestError('invalid_model_messages');
    }
    if (!Array.isArray(request.tools))
        throw modelRequestError('invalid_model_tools');
    if (!['auto', 'required', 'disabled'].includes(request.toolMode)) {
        throw modelRequestError('invalid_tool_mode');
    }
    if (typeof request.streaming !== 'boolean')
        throw modelRequestError('invalid_streaming_mode');
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
        throw modelRequestError('invalid_output_token_limit');
    }
    if (request.reasoning === null || typeof request.reasoning !== 'object' ||
        typeof request.reasoning.enabled !== 'boolean') {
        throw modelRequestError('invalid_reasoning_options');
    }
    if (request.temperature !== undefined)
        assertFiniteNumber(request.temperature, 'invalid_temperature');
    if (request.topP !== undefined)
        assertFiniteNumber(request.topP, 'invalid_top_p');
    const tools = Object.freeze(request.tools.map(wireToolDefinition));
    if (request.toolMode === 'required' && tools.length === 0) {
        throw modelRequestError('required_tools_missing');
    }
    const toolControls = profile.encodeToolControls({
        enabled: request.toolMode !== 'disabled' && tools.length > 0,
        mode: request.toolMode,
        tools
    });
    if (Object.keys(toolControls).some(key => !ALLOWED_TOOL_CONTROL_KEYS.has(key))) {
        throw modelRequestError('invalid_tool_controls');
    }
    if (Object.hasOwn(toolControls, 'functions'))
        throw modelRequestError('legacy_functions_forbidden');
    if (!profile.capabilities.supportsToolChoice && Object.hasOwn(toolControls, 'tool_choice')) {
        throw modelRequestError('unsupported_tool_choice');
    }
    const requestExtensions = profile.encodeRequestExtensions(request.reasoning);
    assertExtensionKeys(requestExtensions, RESERVED_REQUEST_EXTENSION_KEYS, 'invalid_request_extensions');
    const tokenField = profile.capabilities.outputTokenField;
    const candidate = {
        model,
        messages: Object.freeze(request.messages.map(message => wireMessage(message, profile))),
        stream: request.streaming,
        [tokenField]: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.topP === undefined ? {} : { top_p: request.topP }),
        ...requestExtensions,
        ...toolControls
    };
    if (Object.hasOwn(candidate, 'functions'))
        throw modelRequestError('legacy_functions_forbidden');
    try {
        const parsed = parseJsonValue(candidate, { maxBytes: RUN_RESOURCE_LIMITS.requestBytes });
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('request is not an object');
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof ModelProviderError)
            throw error;
        throw modelRequestError('request_body_too_large_or_invalid');
    }
}
function parseUsage(value, profile) {
    if (value === undefined)
        return undefined;
    const usage = asWireRecord(value, 'invalid_usage');
    const inputTokens = usage.prompt_tokens;
    const outputTokens = usage.completion_tokens;
    const totalTokens = usage.total_tokens;
    if (![inputTokens, outputTokens, totalTokens].every(token => (Number.isSafeInteger(token) && Number(token) >= 0))) {
        throw modelProtocolError('invalid_usage');
    }
    const common = Object.freeze({
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens
    });
    try {
        const extensions = profile.decodeUsageExtensions(usage, common);
        return Object.freeze({ ...common, ...extensions });
    }
    catch {
        throw modelProtocolError('invalid_usage');
    }
}
function parseFinishReason(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw modelProtocolError('missing_finish_reason');
    }
    if (['stop', 'length', 'tool_calls', 'content_filter'].includes(value)) {
        return value;
    }
    return 'unknown';
}
function validateFinishReason(finishReason, toolCalls) {
    if (toolCalls.length > 0 && finishReason !== 'tool_calls') {
        throw modelProtocolError('tool_calls_finish_reason_mismatch');
    }
    if (toolCalls.length === 0 && finishReason === 'tool_calls') {
        throw modelProtocolError('missing_tool_calls');
    }
}
function parseResponseId(value) {
    return typeof value === 'string' && RESPONSE_ID.test(value) ? value : undefined;
}
function captureProviderState(message, profile) {
    let captured;
    try {
        captured = profile.captureAssistantState(message);
    }
    catch {
        throw modelProtocolError('invalid_provider_state');
    }
    if (captured === undefined)
        return undefined;
    let parsed;
    try {
        parsed = parseProviderTurnState(captured);
    }
    catch {
        throw modelProtocolError('invalid_provider_state');
    }
    if (parsed.profileId !== profile.id || parsed.profileVersion !== profile.version) {
        throw modelProtocolError('provider_state_profile_mismatch');
    }
    return parsed;
}
function captureDisplayReasoning(message, profile) {
    try {
        return profile.extractAssistantReasoning(message);
    }
    catch {
        throw modelProtocolError('invalid_reasoning_content');
    }
}
function parseJsonText(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw modelProtocolError('invalid_json_response');
    }
}
async function readBoundedJsonTurn(response, profile, signal) {
    const bounded = await readBoundedResponseText(response, signal, RUN_RESOURCE_LIMITS.providerResponseBytes, { overflowReason: 'provider_response_too_large' });
    const root = asWireRecord(parseJsonText(bounded.text), 'invalid_json_response');
    if (root.error !== undefined || root.detail !== undefined) {
        throw new ModelProviderError({
            code: 'provider_invalid_request',
            stage: 'model.response',
            retryable: false,
            userMessage: '请求格式不正确，请联系机器人主人。'
        });
    }
    if (!Array.isArray(root.choices) || root.choices.length === 0) {
        throw modelProtocolError('missing_choices');
    }
    const choice = asWireRecord(root.choices.find(value => asWireRecord(value, 'invalid_choice').index === 0) ?? root.choices[0], 'invalid_choice');
    const finishReason = parseFinishReason(choice.finish_reason);
    const message = asWireRecord(choice.message, 'missing_assistant_message');
    if (message.role !== undefined && message.role !== 'assistant') {
        throw modelProtocolError('invalid_assistant_role');
    }
    if (message.function_call !== undefined)
        throw modelProtocolError('legacy_function_call_unsupported');
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw modelProtocolError('invalid_assistant_content');
    }
    if (message.refusal !== undefined && typeof message.refusal !== 'string') {
        throw modelProtocolError('invalid_assistant_refusal');
    }
    const toolCalls = normalizeCompleteToolCalls(message.tool_calls);
    validateFinishReason(finishReason, toolCalls);
    let frozenMessage;
    try {
        const parsed = parseJsonValue(message, {
            maxBytes: RUN_RESOURCE_LIMITS.providerResponseBytes
        });
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('assistant message is not an object');
        }
        frozenMessage = parsed;
    }
    catch {
        throw modelProtocolError('invalid_assistant_message');
    }
    const providerState = captureProviderState(frozenMessage, profile);
    const reasoning = captureDisplayReasoning(frozenMessage, profile);
    return Object.freeze({
        text: typeof message.content === 'string' ? message.content : '',
        ...(typeof message.refusal === 'string' ? { refusal: message.refusal } : {}),
        toolCalls,
        finishReason,
        ...(root.usage === undefined ? {} : { usage: parseUsage(root.usage, profile) }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(providerState === undefined ? {} : { providerState }),
        ...(parseResponseId(root.id) === undefined ? {} : { responseId: parseResponseId(root.id) })
    });
}
class SseLineGuard {
    #lineBytes = 0;
    add(chunk) {
        for (const byte of chunk) {
            if (byte === 0x0a || byte === 0x0d) {
                this.#lineBytes = 0;
                continue;
            }
            this.#lineBytes += 1;
            if (this.#lineBytes > RUN_RESOURCE_LIMITS.sseLineBytes) {
                throw modelProtocolError('sse_line_too_large');
            }
        }
    }
}
class AssistantExtensionAccumulator {
    #values = new Map();
    addDelta(delta) {
        if (delta.function_call !== undefined)
            throw modelProtocolError('legacy_function_call_unsupported');
        for (const [key, value] of Object.entries(delta)) {
            if (['role', 'content', 'refusal', 'tool_calls'].includes(key) || value === undefined)
                continue;
            if (RESERVED_MESSAGE_EXTENSION_KEYS.has(key)) {
                throw modelProtocolError('invalid_assistant_extension');
            }
            const previous = this.#values.get(key);
            if (typeof value === 'string') {
                if (previous !== undefined && typeof previous !== 'string') {
                    throw modelProtocolError('inconsistent_assistant_extension');
                }
                this.#values.set(key, `${previous ?? ''}${value}`);
            }
            else {
                let parsed;
                try {
                    parsed = parseJsonValue(value, {
                        maxBytes: RUN_RESOURCE_LIMITS.providerStateBytes
                    });
                }
                catch {
                    throw modelProtocolError('invalid_assistant_extension');
                }
                if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(parsed)) {
                    throw modelProtocolError('inconsistent_assistant_extension');
                }
                this.#values.set(key, parsed);
            }
            if (jsonByteLength(Object.freeze(Object.fromEntries(this.#values))) >
                RUN_RESOURCE_LIMITS.providerStateBytes) {
                throw modelProtocolError('provider_state_too_large');
            }
        }
    }
    value() {
        return Object.freeze(Object.fromEntries(this.#values));
    }
}
function parseSseChoice(root) {
    if (!Array.isArray(root.choices))
        throw modelProtocolError('invalid_stream_choices');
    if (root.choices.length === 0)
        return undefined;
    const choice = root.choices.find(value => asWireRecord(value, 'invalid_stream_choice').index === 0) ??
        root.choices[0];
    return asWireRecord(choice, 'invalid_stream_choice');
}
async function readBoundedEventStream(response, profile, signal) {
    const toolAccumulator = new SseToolCallAccumulator();
    const extensionAccumulator = new AssistantExtensionAccumulator();
    const lineGuard = new SseLineGuard();
    const decoder = new TextDecoder();
    let responseBytes = 0;
    let text = '';
    let refusal = '';
    let finishReason;
    let usage;
    let responseId;
    let done = false;
    const parser = createParser(event => {
        if (event.type !== 'event')
            return;
        if (done)
            throw modelProtocolError('stream_data_after_done');
        if (event.data === '[DONE]') {
            done = true;
            return;
        }
        const root = asWireRecord(parseJsonText(event.data), 'invalid_stream_event');
        if (root.error !== undefined || root.detail !== undefined) {
            throw new ModelProviderError({
                code: 'provider_invalid_request',
                stage: 'model.response',
                retryable: false,
                userMessage: '请求格式不正确，请联系机器人主人。'
            });
        }
        const nextResponseId = parseResponseId(root.id);
        if (nextResponseId !== undefined) {
            if (responseId !== undefined && responseId !== nextResponseId) {
                throw modelProtocolError('inconsistent_response_id');
            }
            responseId = nextResponseId;
        }
        if (root.usage !== undefined)
            usage = parseUsage(root.usage, profile);
        const choice = parseSseChoice(root);
        if (choice === undefined)
            return;
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            const nextFinishReason = parseFinishReason(choice.finish_reason);
            if (finishReason !== undefined && finishReason !== nextFinishReason) {
                throw modelProtocolError('inconsistent_finish_reason');
            }
            finishReason = nextFinishReason;
        }
        const delta = asWireRecord(choice.delta ?? {}, 'invalid_stream_delta');
        if (delta.role !== undefined && delta.role !== 'assistant') {
            throw modelProtocolError('invalid_assistant_role');
        }
        if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string')
                throw modelProtocolError('invalid_assistant_content');
            text += delta.content;
        }
        if (delta.refusal !== undefined && delta.refusal !== null) {
            if (typeof delta.refusal !== 'string')
                throw modelProtocolError('invalid_assistant_refusal');
            refusal += delta.refusal;
        }
        if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls))
                throw modelProtocolError('invalid_tool_calls');
            delta.tool_calls.forEach(call => toolAccumulator.add(call));
        }
        extensionAccumulator.addDelta(delta);
    });
    for await (const chunk of iterateResponseBytes(response, signal)) {
        responseBytes += chunk.byteLength;
        if (responseBytes > RUN_RESOURCE_LIMITS.providerResponseBytes) {
            throw modelProtocolError('provider_response_too_large');
        }
        lineGuard.add(chunk);
        parser.feed(decoder.decode(chunk, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail.length > 0)
        parser.feed(tail);
    parser.feed('\n\n');
    if (!done)
        throw modelProtocolError('stream_missing_done');
    if (finishReason === undefined)
        throw modelProtocolError('missing_finish_reason');
    const toolCalls = toolAccumulator.finalize();
    validateFinishReason(finishReason, toolCalls);
    const toolCallsWire = toolCalls.map(call => Object.freeze({
        id: call.callId,
        type: 'function',
        function: Object.freeze({ name: call.name, arguments: call.argumentsText })
    }));
    const assistantMessage = Object.freeze({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(refusal.length > 0 ? { refusal } : {}),
        ...(toolCallsWire.length > 0 ? { tool_calls: Object.freeze(toolCallsWire) } : {}),
        ...extensionAccumulator.value()
    });
    const providerState = captureProviderState(assistantMessage, profile);
    const reasoning = captureDisplayReasoning(assistantMessage, profile);
    return Object.freeze({
        text,
        ...(refusal.length > 0 ? { refusal } : {}),
        toolCalls,
        finishReason,
        ...(usage === undefined ? {} : { usage }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(providerState === undefined ? {} : { providerState }),
        ...(responseId === undefined ? {} : { responseId })
    });
}
function baseWireErrorClassification(error) {
    if (error.status === 401 || error.status === 403) {
        return {
            code: 'provider_authentication',
            retryable: false,
            userMessage: 'AI 服务鉴权失败，请联系机器人主人。'
        };
    }
    if (error.status === 408) {
        return {
            code: 'provider_timeout',
            retryable: true,
            userMessage: 'AI 服务响应超时，请稍后重试。'
        };
    }
    if (error.status === 429) {
        return {
            code: 'provider_rate_limited',
            retryable: true,
            userMessage: 'AI 服务请求过多，请稍后重试。'
        };
    }
    if (error.status >= 500) {
        return {
            code: 'provider_unavailable',
            retryable: true,
            userMessage: 'AI 服务繁忙，请稍后重试。'
        };
    }
    return {
        code: 'provider_invalid_request',
        retryable: false,
        userMessage: '请求格式不正确，请联系机器人主人。'
    };
}
async function classifyBoundedResponse(response, profile, signal) {
    const wireError = await readBoundedWireError(response, signal, RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes);
    const classification = profile.classifyError(wireError) ??
        baseWireErrorClassification(wireError);
    return new ModelProviderError({
        code: classification.code,
        stage: 'model.response',
        retryable: classification.retryable,
        userMessage: classification.userMessage,
        details: { status: wireError.status },
        statusCode: wireError.status,
        providerCode: wireError.providerCode,
        profileCode: classification.profileCode
    });
}
function classifyTransportFailure(error, signal) {
    if (signal.aborted) {
        const reasonName = safeErrorName(signal.reason);
        if (reasonName === 'TimeoutError') {
            return new ModelProviderError({
                code: 'provider_timeout',
                stage: 'model.transport',
                retryable: true,
                userMessage: 'AI 服务响应超时，请稍后重试。'
            });
        }
        return new ModelProviderError({
            code: 'cancelled',
            stage: 'model.transport',
            retryable: false,
            userMessage: '任务已取消。'
        });
    }
    const name = safeErrorName(error);
    if (name === 'TimeoutError') {
        return new ModelProviderError({
            code: 'provider_timeout',
            stage: 'model.transport',
            retryable: true,
            userMessage: 'AI 服务响应超时，请稍后重试。'
        });
    }
    return new ModelProviderError({
        code: 'provider_unavailable',
        stage: 'model.transport',
        retryable: true,
        userMessage: '无法连接 AI 服务，请稍后重试。'
    });
}
export class OpenAICompatibleAdapter {
    #endpoint;
    #headers;
    #profile;
    #fetch;
    constructor(options) {
        this.#endpoint = normalizeEndpoint(options.endpoint);
        if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
            throw modelRequestError('missing_provider_api_key');
        }
        this.#profile = options.profile;
        this.#fetch = options.fetch ?? defaultFetch;
        this.#headers = Object.freeze({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
            ...(options.organization === undefined
                ? {}
                : { 'OpenAI-Organization': assertString(options.organization, 'invalid_organization', 256) })
        });
    }
    async complete(request, signal) {
        if (signal.aborted)
            throw classifyTransportFailure(signal.reason, signal);
        const bodyObject = buildImmutableChatRequest(request, this.#profile);
        const body = JSON.stringify(bodyObject);
        if (Buffer.byteLength(body, 'utf8') > RUN_RESOURCE_LIMITS.requestBytes) {
            throw modelRequestError('request_body_too_large');
        }
        const init = {
            method: 'POST',
            headers: this.#headers,
            body,
            signal
        };
        let response;
        try {
            response = await this.#fetch(this.#endpoint, init);
        }
        catch (error) {
            if (error instanceof ModelProviderError)
                throw error;
            throw classifyTransportFailure(error, signal);
        }
        if (!response.ok)
            throw await classifyBoundedResponse(response, this.#profile, signal);
        try {
            return request.streaming
                ? await readBoundedEventStream(response, this.#profile, signal)
                : await readBoundedJsonTurn(response, this.#profile, signal);
        }
        catch (error) {
            if (error instanceof ModelProviderError)
                throw error;
            if (signal.aborted)
                throw classifyTransportFailure(error, signal);
            throw modelProtocolError('unreadable_provider_response');
        }
    }
}
