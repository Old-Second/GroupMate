import { normalizeReasoningView } from './presentation/reply-content.js';
function normalizeText(value) {
    return value.trim().normalize('NFC');
}
function separateInlineThinking(text) {
    const match = /<think>(.*?)<\/think>/s.exec(text);
    if (match === null || match.index === undefined) {
        return Object.freeze({ text, thinking: '' });
    }
    return Object.freeze({
        text: text.slice(match.index + match[0].length),
        thinking: match[1] ?? ''
    });
}
export function createRuntimePresentationHooks(adapters) {
    const hooks = {
        async postprocess({ text }) {
            let current = text;
            let thinking = '';
            for (const processor of await adapters.loadPostprocessors()) {
                const output = await processor.processInner({
                    text: current,
                    ...(thinking === '' ? {} : { thinking_text: thinking })
                });
                current = typeof output.text === 'string' ? output.text : '';
                thinking = typeof output.thinking_text === 'string' ? output.thinking_text : thinking;
            }
            const inline = separateInlineThinking(current);
            current = inline.text;
            if (inline.thinking !== '')
                thinking += inline.thinking;
            const reasoningView = normalizeReasoningView({
                text: thinking,
                truncated: false
            });
            return Object.freeze({
                text: normalizeText(current),
                ...(reasoningView === undefined ? {} : { reasoningView })
            });
        },
        convertText: async (input) => Object.freeze([...(await adapters.convertText(input))]),
        notifyResponsePost: (input) => adapters.notifyResponsePost(input)
    };
    return Object.freeze(hooks);
}
export const PLAIN_TEXT_PRESENTATION_HOOKS = Object.freeze({
    postprocess: async ({ text }) => {
        const inline = separateInlineThinking(text);
        const reasoningView = normalizeReasoningView({
            text: inline.thinking,
            truncated: false
        });
        return Object.freeze({
            text: normalizeText(inline.text),
            ...(reasoningView === undefined ? {} : { reasoningView })
        });
    },
    convertText: async ({ text }) => Object.freeze([{ kind: 'text', text }]),
    notifyResponsePost: () => undefined
});
