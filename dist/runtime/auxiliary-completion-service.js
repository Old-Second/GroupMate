const DEFAULT_OUTPUT_TOKENS = Object.freeze({ random_greeting: 128, suggestion: 512 });
const PURPOSES = Object.freeze([
    'random_greeting', 'suggestion'
]);
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
function currentNumber(value) {
    return typeof value === 'function' ? value() : value;
}
function boundedTimeout(configured) {
    const value = currentNumber(configured);
    return Number.isSafeInteger(value) && Number(value) > 0
        ? Math.min(Number(value), MAX_TIMEOUT_MS)
        : MAX_TIMEOUT_MS;
}
function boundedTemperature(configured) {
    const value = currentNumber(configured);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2
        ? value
        : undefined;
}
function cloneMessage(message) {
    if (message.role === 'tool')
        throw new TypeError('auxiliary tool messages are forbidden');
    if (message.role === 'assistant') {
        if (typeof message.content !== 'string' || message.content === '' ||
            message.toolCalls !== undefined || message.providerState !== undefined) {
            throw new TypeError('auxiliary assistant message is invalid');
        }
        return Object.freeze({ role: 'assistant', content: message.content });
    }
    if (message.content === '')
        throw new TypeError('auxiliary message is empty');
    return Object.freeze({ role: message.role, content: message.content });
}
function requestFor(input, options, model) {
    if (!PURPOSES.includes(input.purpose) || !Array.isArray(input.messages) ||
        input.messages.length === 0 || input.messages.length > 64) {
        throw new TypeError('auxiliary completion input is invalid');
    }
    const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS[input.purpose];
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 ||
        maxOutputTokens > 4_096) {
        throw new TypeError('auxiliary output token limit is invalid');
    }
    const temperature = boundedTemperature(options.temperature);
    return Object.freeze({
        model,
        messages: Object.freeze(input.messages.map(cloneMessage)),
        tools: Object.freeze([]),
        toolMode: 'disabled',
        streaming: false,
        maxOutputTokens,
        reasoning: Object.freeze({ enabled: false }),
        ...(temperature === undefined ? {} : { temperature })
    });
}
function currentModel(configured) {
    const model = typeof configured === 'function' ? configured() : configured;
    if (typeof model !== 'string' || model.length > 256) {
        throw new TypeError('auxiliary completion model configuration is invalid');
    }
    return model;
}
function completedText(turn) {
    const text = turn.text.normalize('NFC').trim();
    if (turn.refusal !== undefined || turn.toolCalls.length > 0 ||
        turn.finishReason !== 'stop' || text === '' ||
        Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new TypeError('auxiliary completion response is invalid');
    }
    return text;
}
export function createAuxiliaryCompletionService(options) {
    if ((typeof options.model !== 'string' && typeof options.model !== 'function') ||
        (typeof options.model === 'string' && options.model.length > 256) ||
        typeof options.adapter?.complete !== 'function') {
        throw new TypeError('auxiliary completion configuration is invalid');
    }
    return Object.freeze({
        async completeText(input) {
            const model = currentModel(options.model);
            if (model.trim() === '') {
                throw new Error('auxiliary completion model is not configured');
            }
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort(new DOMException('auxiliary completion timed out', 'TimeoutError'));
            }, boundedTimeout(options.timeoutMs));
            timer.unref?.();
            try {
                return completedText(await options.adapter.complete(requestFor(input, options, model), controller.signal));
            }
            finally {
                clearTimeout(timer);
            }
        }
    });
}
let activeService = null;
export function configureAuxiliaryCompletionService(options) {
    if (activeService !== null) {
        throw new Error('auxiliary completion service is already configured');
    }
    activeService = createAuxiliaryCompletionService(options);
    return activeService;
}
export async function completeAuxiliaryText(input) {
    if (activeService === null) {
        throw new Error('auxiliary completion service is not configured');
    }
    return await activeService.completeText(input);
}
