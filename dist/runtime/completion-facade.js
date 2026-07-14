import { ModelProviderError, modelProtocolError } from '../agent/model/model-adapter.js';
import { OpenAICompatibleAdapter } from '../agent/model/openai-compatible-adapter.js';
import { resolveOpenAICompatibleModelRuntimeConfig } from './model-runtime-config.js';
const PURPOSES = Object.freeze([
    'translation', 'random_greeting', 'suggestion', 'smoke'
]);
const DEFAULT_OUTPUT_TOKENS = Object.freeze({
    translation: 2_048,
    random_greeting: 128,
    suggestion: 512,
    smoke: 64
});
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_MESSAGES = 64;
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRYABLE_CODES = new Set([
    'provider_timeout', 'provider_rate_limited', 'provider_unavailable'
]);
function invalidRequest(reason) {
    return new ModelProviderError({
        code: 'provider_invalid_request',
        stage: 'completion.input',
        retryable: false,
        userMessage: '请求格式不正确，请联系机器人主人。',
        details: { reason }
    });
}
function timeoutError() {
    return new ModelProviderError({
        code: 'provider_timeout',
        stage: 'completion.timeout',
        retryable: true,
        userMessage: 'AI 服务响应超时，请稍后重试。'
    });
}
function cancelledError() {
    return new ModelProviderError({
        code: 'cancelled',
        stage: 'completion.cancelled',
        retryable: false,
        userMessage: '任务已取消。'
    });
}
function boundedNumber(value, label, minimum, maximum) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        value < minimum || value > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function timeoutMs(value) {
    const timeout = value ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > DEFAULT_TIMEOUT_MS) {
        throw new TypeError('completion timeout is invalid');
    }
    return timeout;
}
function cloneTextMessage(message) {
    if (message.role === 'tool')
        throw invalidRequest('tool_messages_forbidden');
    if (message.role === 'assistant') {
        if (typeof message.content !== 'string' || message.content.length === 0 ||
            message.toolCalls !== undefined || message.providerState !== undefined) {
            throw invalidRequest('assistant_protocol_state_forbidden');
        }
        return Object.freeze({ role: 'assistant', content: message.content });
    }
    if (typeof message.content !== 'string' || message.content.length === 0) {
        throw invalidRequest('empty_message_content');
    }
    return Object.freeze({ role: message.role, content: message.content });
}
function requestFor(input, options) {
    if (!PURPOSES.includes(input.purpose) || !Array.isArray(input.messages) ||
        input.messages.length === 0 || input.messages.length > MAX_MESSAGES) {
        throw invalidRequest('invalid_completion_input');
    }
    const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS[input.purpose];
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 ||
        maxOutputTokens > MAX_OUTPUT_TOKENS) {
        throw new TypeError('completion output token limit is invalid');
    }
    return Object.freeze({
        model: options.model,
        messages: Object.freeze(input.messages.map(cloneTextMessage)),
        tools: Object.freeze([]),
        toolMode: 'disabled',
        streaming: false,
        maxOutputTokens,
        reasoning: Object.freeze({ enabled: false }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { topP: options.topP })
    });
}
function completedText(turn) {
    if (turn.refusal !== undefined && turn.refusal.length > 0) {
        throw modelProtocolError('restricted_completion_refusal');
    }
    if (turn.toolCalls.length > 0) {
        throw modelProtocolError('restricted_completion_tool_call');
    }
    if (turn.finishReason !== 'stop') {
        throw modelProtocolError('restricted_completion_finish_reason');
    }
    const text = turn.text.normalize('NFC').trim();
    if (text.length === 0)
        throw modelProtocolError('restricted_completion_empty');
    if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
        throw modelProtocolError('restricted_completion_output_too_large');
    }
    return text;
}
function linkedTimeoutSignal(callerSignal, durationMs) {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal.reason);
    if (callerSignal.aborted)
        onCallerAbort();
    else
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
        controller.abort(new DOMException('completion timed out', 'TimeoutError'));
    }, durationMs);
    timer.unref?.();
    return Object.freeze({
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            callerSignal.removeEventListener('abort', onCallerAbort);
        }
    });
}
function normalizedFailure(error, callerSignal, attemptSignal) {
    if (callerSignal.aborted)
        return cancelledError();
    if (attemptSignal.aborted)
        return timeoutError();
    return error;
}
export class RestrictedCompletionFacade {
    profileId;
    selectionSource;
    #adapter;
    #model;
    #timeoutMs;
    #temperature;
    #topP;
    constructor(options) {
        if (typeof options.model !== 'string' || options.model.length === 0 ||
            options.model.length > 256 || !['standard', 'deepseek'].includes(options.profileId) ||
            !['default', 'explicit'].includes(options.selectionSource)) {
            throw new TypeError('completion facade configuration is invalid');
        }
        this.#adapter = options.adapter;
        this.#model = options.model;
        this.profileId = options.profileId;
        this.selectionSource = options.selectionSource;
        this.#timeoutMs = timeoutMs(options.timeoutMs);
        this.#temperature = boundedNumber(options.temperature, 'completion temperature', 0, 2);
        this.#topP = boundedNumber(options.topP, 'completion top P', 0, 1);
    }
    async completeText(input, callerSignal) {
        if (!(callerSignal instanceof AbortSignal))
            throw new TypeError('completion signal is invalid');
        if (callerSignal.aborted)
            throw cancelledError();
        const request = requestFor(input, {
            model: this.#model,
            ...(this.#temperature === undefined ? {} : { temperature: this.#temperature }),
            ...(this.#topP === undefined ? {} : { topP: this.#topP })
        });
        const linked = linkedTimeoutSignal(callerSignal, this.#timeoutMs);
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return completedText(await this.#adapter.complete(request, linked.signal));
                }
                catch (rawError) {
                    const error = normalizedFailure(rawError, callerSignal, linked.signal);
                    const retry = attempt === 0 && error instanceof ModelProviderError &&
                        error.retryable && RETRYABLE_CODES.has(error.code) && !linked.signal.aborted;
                    if (!retry)
                        throw error;
                }
            }
            throw modelProtocolError('restricted_completion_retry_exhausted');
        }
        finally {
            linked.dispose();
        }
    }
}
export function createOpenAICompatibleCompletionFacade(options) {
    const runtimeConfig = resolveOpenAICompatibleModelRuntimeConfig(Object.hasOwn(options, 'openAiCompatibilityProfile')
        ? { openAiCompatibilityProfile: options.openAiCompatibilityProfile }
        : {});
    const adapter = new OpenAICompatibleAdapter({
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        profile: runtimeConfig.profile,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.organization === undefined ? {} : { organization: options.organization })
    });
    return new RestrictedCompletionFacade({
        adapter,
        model: options.model,
        profileId: runtimeConfig.configuredProfile,
        selectionSource: runtimeConfig.selectionSource,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { topP: options.topP })
    });
}
export function createCompletionFacadeFromConfig(config, transport = {}) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError('completion runtime configuration is invalid');
    }
    const configuredTimeout = Number.isSafeInteger(config.defaultTimeoutMs) &&
        Number(config.defaultTimeoutMs) > 0
        ? Math.min(Number(config.defaultTimeoutMs), DEFAULT_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
    return createOpenAICompatibleCompletionFacade({
        endpoint: typeof config.openAiBaseUrl === 'string' ? config.openAiBaseUrl : '',
        apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
        model: typeof config.model === 'string' ? config.model : '',
        ...(Object.hasOwn(config, 'openAiCompatibilityProfile')
            ? { openAiCompatibilityProfile: config.openAiCompatibilityProfile }
            : {}),
        ...(transport.fetch === undefined ? {} : { fetch: transport.fetch }),
        timeoutMs: configuredTimeout,
        ...(typeof config.temperature === 'number' && Number.isFinite(config.temperature) &&
            config.temperature >= 0 && config.temperature <= 2
            ? { temperature: config.temperature }
            : {})
    });
}
