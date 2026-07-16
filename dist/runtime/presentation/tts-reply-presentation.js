import { codePointLength, plainTextPart } from './text-presentation.js';
import { aggregatePresentationResults } from './presentation-result.js';
import { preprocessTtsText, shouldFallbackVitsToText, shouldSendTtsText } from '../tts-presentation.js';
import { deliverWithDefiniteRetry } from './yunzai-outbound-port.js';
export const TTS_LONG_TEXT_NOTICE = '回复的内容过长，已转为文本模式';
export const TTS_SYNTHESIS_DIAGNOSTIC_EVENT = 'groupmate.tts.synthesis_non_ready';
function frozenResult(outcome, deliveries) {
    return Object.freeze({
        schemaVersion: 1,
        outcome,
        deliveries: Object.freeze([...deliveries])
    });
}
function resultFromDelivery(delivery) {
    return frozenResult(delivery.kind === 'sent'
        ? 'complete'
        : delivery.kind === 'outcome_unknown'
            ? 'unknown'
            : 'failed', Object.freeze([delivery]));
}
async function deliverPart(port, part, options) {
    const attempts = await deliverWithDefiniteRetry(port, part, options);
    const final = attempts.at(-1);
    return final === undefined
        ? frozenResult('failed', Object.freeze([]))
        : resultFromDelivery(final);
}
function deliveryOptions(quoteMessageId, signal) {
    return Object.freeze({
        ...(quoteMessageId === undefined ? {} : { quoteMessageId }),
        ...(signal === undefined ? {} : { signal })
    });
}
function textFirstSynthesisFailure(text) {
    const delivery = text.deliveries.at(-1);
    if (delivery === undefined)
        return frozenResult('failed', Object.freeze([]));
    return frozenResult(delivery.kind === 'sent'
        ? 'partial'
        : delivery.kind === 'outcome_unknown'
            ? 'unknown'
            : 'failed', Object.freeze([delivery]));
}
async function synthesizeTotal(tts, input, signal) {
    try {
        return await tts.synthesize(input, signal);
    }
    catch {
        return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_exception' });
    }
}
function voicePart(synthesis) {
    return Object.freeze({ media: 'voice', resource: synthesis.audio });
}
function reportSynthesisFailure(diagnostics, code) {
    try {
        void Promise.resolve(diagnostics.reportSynthesisFailure(code)).catch(() => undefined);
    }
    catch { }
}
export async function presentTtsReply(input, dependencies) {
    const prepared = preprocessTtsText({
        text: input.text,
        mode: input.settings.mode,
        filter: input.settings.filter,
        azureEmotionEnabled: input.settings.azureEmotionEnabled
    });
    const characters = codePointLength(prepared.spokenText);
    const fallbackVits = shouldFallbackVitsToText({
        ttsMode: input.settings.mode,
        textCharacters: characters,
        threshold: input.settings.autoFallbackThreshold
    });
    const textFirst = shouldSendTtsText({
        alsoSendText: input.settings.alsoSendText,
        textCharacters: characters,
        threshold: input.settings.autoFallbackThreshold
    });
    const port = await dependencies.outboundFactory.forTarget(input.target);
    const quoted = deliveryOptions(input.quoteMessageId, input.signal);
    const unquoted = deliveryOptions(undefined, input.signal);
    if (fallbackVits) {
        const notice = await deliverPart(port, plainTextPart(TTS_LONG_TEXT_NOTICE), unquoted);
        const body = prepared.bodyText === ''
            ? frozenResult('failed', Object.freeze([]))
            : await deliverPart(port, plainTextPart(prepared.bodyText), quoted);
        return aggregatePresentationResults(Object.freeze([notice, body]));
    }
    const text = textFirst
        ? prepared.bodyText === ''
            ? frozenResult('failed', Object.freeze([]))
            : await deliverPart(port, plainTextPart(prepared.bodyText), quoted)
        : undefined;
    const synthesis = prepared.spokenText === ''
        ? Object.freeze({
            kind: 'failed_definite',
            code: 'empty_after_filter'
        })
        : await synthesizeTotal(dependencies.tts, Object.freeze({
            target: input.target,
            text: prepared.spokenText,
            mode: input.settings.mode,
            voice: input.settings.activeVoice,
            ...(prepared.emotion === undefined ? {} : { emotion: prepared.emotion }),
            ...(prepared.emotionDegree === undefined
                ? {}
                : { emotionDegree: prepared.emotionDegree })
        }), input.signal);
    if (synthesis.kind !== 'ready') {
        reportSynthesisFailure(dependencies.diagnostics, synthesis.code);
        if (text !== undefined)
            return textFirstSynthesisFailure(text);
        if (prepared.bodyText === '')
            return frozenResult('failed', Object.freeze([]));
        return await deliverPart(port, plainTextPart(prepared.bodyText), quoted);
    }
    const voice = await deliverPart(port, voicePart(synthesis), unquoted);
    if (text !== undefined) {
        return aggregatePresentationResults(Object.freeze([text, voice]));
    }
    const voiceDelivery = voice.deliveries.at(-1);
    if (voiceDelivery?.kind !== 'failed_definite')
        return voice;
    if (prepared.bodyText === '')
        return voice;
    const fallback = await deliverPart(port, plainTextPart(prepared.bodyText), quoted);
    return aggregatePresentationResults(Object.freeze([voice, fallback]));
}
