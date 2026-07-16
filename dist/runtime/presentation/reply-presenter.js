import { getChatErrorPresentation } from '../chat-error-presentation.js';
import { aggregatePresentationResults } from './presentation-result.js';
import { buildChatSuggestionButtonRequest, normalizeCitationForwards, normalizeReasoningView, normalizeSuggestions } from './reply-content.js';
import { BLOCKED_RESPONSE_MESSAGE, CANCELLED_MESSAGE, POSTPROCESS_EMPTY_MESSAGE, responseIsBlocked, SESSION_PERSISTENCE_FAILED_MESSAGE } from './response-presentation-safety.js';
import { citationForwardPart, codePointLength, plainTextPart, reasoningForwardPart, repairCodeFences, splitProactiveText, textPart } from './text-presentation.js';
import { deliverWithDefiniteRetry } from './yunzai-outbound-port.js';
import { presentTtsReply } from './tts-reply-presentation.js';
import { presentPictureReply } from '../picture-reply.js';
function frozenResult(outcome, deliveries, skipReason) {
    return Object.freeze({
        schemaVersion: 1,
        outcome,
        ...(skipReason === undefined ? {} : { skipReason }),
        deliveries: Object.freeze([...deliveries])
    });
}
function skipped(reason) {
    return frozenResult('skipped', Object.freeze([]), reason);
}
function failedWithoutDelivery() {
    return frozenResult('failed', Object.freeze([]));
}
function validRecallAfterMs(value) {
    return value === null || (Number.isSafeInteger(value) &&
        value >= 1_000 &&
        value <= 3_600_000 &&
        value % 1_000 === 0);
}
function validOptionalRequestMessageId(value) {
    return value === undefined || (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value, 'utf8') <= 128);
}
function validPresentationMatrix(input) {
    try {
        const route = input.route;
        const profile = input.profile;
        if (route.schemaVersion !== 1 || typeof input.settings.quoteReply !== 'boolean')
            return false;
        if (profile.kind === 'ordinary') {
            if (route.requestKind !== 'ordinary_chat' || route.profile !== 'ordinary' ||
                route.presentationIntent.schemaVersion !== 1 ||
                route.presentationIntent.kind !== 'ordinary' ||
                typeof route.presentationIntent.forcePicture !== 'boolean' ||
                typeof profile.forcePicture !== 'boolean' ||
                profile.forcePicture !== route.presentationIntent.forcePicture)
                return false;
            if (!validOptionalRequestMessageId(route.requestMessageId))
                return false;
            const hasMessageId = route.requestMessageId !== undefined;
            const quoteCurrentRequest = input.settings.quoteReply && hasMessageId &&
                route.sessionAddress.scope.kind !== 'private';
            return typeof profile.quoteCurrentRequest === 'boolean' &&
                profile.quoteCurrentRequest === quoteCurrentRequest;
        }
        if (profile.kind === 'proactive') {
            if (route.requestKind !== 'proactive_chat' || route.profile !== 'proactive' ||
                route.presentationIntent.schemaVersion !== 1 ||
                route.presentationIntent.kind !== 'proactive' ||
                !validOptionalRequestMessageId(route.requestMessageId) ||
                !validRecallAfterMs(route.presentationIntent.recallAfterMs))
                return false;
            return profile.recallAfterMs === route.presentationIntent.recallAfterMs &&
                profile.maxParts === 3 &&
                profile.quoteProbability === 0.1 &&
                profile.delayPerCodePointMs === 200 &&
                profile.maxDelayMs === 3_000;
        }
        return profile.kind === 'recovered_legacy_plain_text' &&
            route.requestKind === 'legacy_unknown' &&
            route.profile === 'recovered_legacy_plain_text';
    }
    catch {
        return false;
    }
}
function resultFromDelivery(delivery) {
    return frozenResult(delivery.kind === 'sent'
        ? 'complete'
        : delivery.kind === 'outcome_unknown'
            ? 'unknown'
            : 'failed', Object.freeze([delivery]));
}
async function deliverLogicalPart(port, part, options) {
    const attempts = await deliverWithDefiniteRetry(port, part, options);
    const final = attempts.at(-1);
    if (final === undefined)
        return failedWithoutDelivery();
    return resultFromDelivery(final);
}
function quoteMessageId(input, profile) {
    if (!input.settings.quoteReply || !profile.quoteCurrentRequest ||
        input.route.requestKind !== 'ordinary_chat' ||
        input.route.sessionAddress.scope.kind === 'private')
        return undefined;
    return input.route.requestMessageId;
}
function consumeSideEffect(invoke) {
    try {
        void Promise.resolve(invoke()).catch(() => undefined);
    }
    catch { }
}
function fireNotification(input, text, hasReasoning) {
    if (input.profile.kind === 'recovered_legacy_plain_text')
        return;
    consumeSideEffect(() => input.hooks.notifyResponsePost({
        runRef: input.result.runRef,
        text,
        hasReasoning
    }));
}
async function presentFixedText(dependencies, input, text, quote = false) {
    const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress);
    const requestMessageId = quote && input.route.requestKind === 'ordinary_chat' &&
        input.route.sessionAddress.scope.kind !== 'private'
        ? input.route.requestMessageId
        : undefined;
    return await deliverLogicalPart(port, plainTextPart(text), {
        ...(requestMessageId === undefined ? {} : { quoteMessageId: requestMessageId }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
    });
}
async function presentOrdinary(dependencies, input, text, reasoningView) {
    const profile = input.profile;
    if (profile.kind !== 'ordinary')
        return failedWithoutDelivery();
    const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress);
    const children = [];
    const citations = normalizeCitationForwards(input.citationForwards);
    const quote = quoteMessageId(input, profile);
    if (input.settings.tts.enabled) {
        if (citations.length > 0) {
            children.push(await deliverLogicalPart(port, citationForwardPart(citations), {
                ...(input.signal === undefined ? {} : { signal: input.signal })
            }));
        }
        children.push(await presentTtsReply({
            text,
            target: input.route.sessionAddress,
            settings: input.settings.tts,
            ...(quote === undefined ? {} : { quoteMessageId: quote }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
        }, {
            tts: dependencies.tts,
            diagnostics: dependencies.ttsDiagnostics,
            outboundFactory: dependencies.outboundFactory
        }));
        if (reasoningView !== undefined) {
            children.push(await deliverLogicalPart(port, reasoningForwardPart(reasoningView.text), {
                ...(input.signal === undefined ? {} : { signal: input.signal })
            }));
        }
    }
    else if (profile.forcePicture ||
        input.settings.picture.userEnabled ||
        (input.settings.picture.autoEnabled &&
            codePointLength(text) >= input.settings.picture.autoThreshold)) {
        children.push(await presentPictureReply({
            text,
            target: input.route.sessionAddress,
            citations,
            reasoningView: reasoningView ?? null,
            settings: input.settings.picture,
            ...(quote === undefined ? {} : { quoteMessageId: quote }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
        }, {
            renderer: dependencies.pictureRenderer,
            outboundFactory: dependencies.outboundFactory
        }));
    }
    else {
        if (citations.length > 0) {
            children.push(await deliverLogicalPart(port, citationForwardPart(citations), {
                ...(input.signal === undefined ? {} : { signal: input.signal })
            }));
        }
        const atoms = await input.hooks.convertText({
            text,
            enableRobotAt: input.settings.enableRobotAt,
            enableMarkdown: input.settings.enableMarkdown
        });
        children.push(await deliverLogicalPart(port, textPart(atoms), {
            ...(quote === undefined ? {} : { quoteMessageId: quote }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
        }));
        if (reasoningView !== undefined) {
            children.push(await deliverLogicalPart(port, reasoningForwardPart(reasoningView.text), {
                ...(input.signal === undefined ? {} : { signal: input.signal })
            }));
        }
    }
    if (input.settings.enableSuggestedResponses) {
        const suggestions = normalizeSuggestions(input.suggestions);
        if (suggestions.length > 0) {
            const buttons = input.settings.enableMarkdown
                ? buildChatSuggestionButtonRequest(suggestions)
                : undefined;
            children.push(await deliverLogicalPart(port, textPart(Object.freeze([{
                    kind: 'text',
                    text: `建议的回复：\n${suggestions.join('\n')}`
                }]), buttons), { ...(input.signal === undefined ? {} : { signal: input.signal }) }));
        }
    }
    return aggregatePresentationResults(children);
}
async function presentProactive(dependencies, input, text) {
    const profile = input.profile;
    if (profile.kind !== 'proactive')
        return failedWithoutDelivery();
    const chunks = splitProactiveText(text, profile.maxParts);
    if (chunks.length === 0)
        return failedWithoutDelivery();
    const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress);
    const children = [];
    for (const chunk of chunks) {
        const quote = input.route.requestKind === 'proactive_chat' &&
            input.route.requestMessageId !== undefined &&
            dependencies.random() < profile.quoteProbability
            ? input.route.requestMessageId
            : undefined;
        const child = await deliverLogicalPart(port, plainTextPart(chunk), {
            ...(quote === undefined ? {} : { quoteMessageId: quote }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        children.push(child);
        if (profile.recallAfterMs !== null) {
            for (const delivery of child.deliveries) {
                if (delivery.kind !== 'sent')
                    continue;
                dependencies.schedule(() => {
                    consumeSideEffect(() => port.recall(delivery.receipt));
                }, profile.recallAfterMs);
            }
        }
        await dependencies.sleep(Math.min(codePointLength(chunk) * profile.delayPerCodePointMs, profile.maxDelayMs), input.signal);
    }
    return aggregatePresentationResults(children);
}
async function presentRecoveredLegacy(dependencies, input, text) {
    const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress);
    return await deliverLogicalPart(port, plainTextPart(text), {
        ...(input.signal === undefined ? {} : { signal: input.signal })
    });
}
export class ReplyPresenter {
    #dependencies;
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    async present(input) {
        if (!validPresentationMatrix(input))
            return failedWithoutDelivery();
        if (input.result.kind === 'completed') {
            if (input.result.completion.kind === 'allowed_silence') {
                return skipped('allowed_silence');
            }
            if (input.result.completion.kind === 'already_visible') {
                if (input.profile.kind === 'ordinary' && input.sessionPersistence === 'failed') {
                    return await presentFixedText(this.#dependencies, input, SESSION_PERSISTENCE_FAILED_MESSAGE);
                }
                return skipped('already_visible');
            }
            return await this.#presentReplyText(input, input.result.completion.text);
        }
        if (input.profile.kind === 'proactive')
            return failedWithoutDelivery();
        const text = input.result.kind === 'failed'
            ? getChatErrorPresentation(input.result.error).message
            : CANCELLED_MESSAGE;
        return await presentFixedText(this.#dependencies, input, text, input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
            input.settings.quoteReply);
    }
    async #presentReplyText(input, canonicalText) {
        const normalizedCanonical = canonicalText.trim().normalize('NFC');
        if (input.profile.kind === 'recovered_legacy_plain_text' &&
            normalizedCanonical === '<EMPTY>') {
            return await presentFixedText(this.#dependencies, input, getChatErrorPresentation({ code: 'legacy_entry_kind_unavailable' }).message);
        }
        const processed = await input.hooks.postprocess({
            text: normalizedCanonical
        });
        const normalized = typeof processed.text === 'string'
            ? processed.text.trim().normalize('NFC')
            : '';
        if (normalized === '') {
            const main = input.profile.kind === 'proactive'
                ? failedWithoutDelivery()
                : await presentFixedText(this.#dependencies, input, POSTPROCESS_EMPTY_MESSAGE, input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
                    input.settings.quoteReply);
            return await this.#appendPersistenceNotice(input, main);
        }
        if (input.profile.kind === 'recovered_legacy_plain_text' && normalized === '<EMPTY>') {
            return await presentFixedText(this.#dependencies, input, getChatErrorPresentation({ code: 'legacy_entry_kind_unavailable' }).message);
        }
        if (responseIsBlocked(normalized, input.settings.blockWords)) {
            const main = await presentFixedText(this.#dependencies, input, BLOCKED_RESPONSE_MESSAGE, input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
                input.settings.quoteReply);
            return await this.#appendPersistenceNotice(input, main);
        }
        const finalText = repairCodeFences(normalized);
        const reasoningView = input.profile.kind === 'ordinary' && input.settings.forwardReasoning
            ? normalizeReasoningView(processed.reasoningView)
            : undefined;
        fireNotification(input, finalText, reasoningView !== undefined);
        const main = input.profile.kind === 'ordinary'
            ? await presentOrdinary(this.#dependencies, input, finalText, reasoningView)
            : input.profile.kind === 'proactive'
                ? await presentProactive(this.#dependencies, input, finalText)
                : await presentRecoveredLegacy(this.#dependencies, input, finalText);
        return await this.#appendPersistenceNotice(input, main);
    }
    async #appendPersistenceNotice(input, main) {
        if (input.profile.kind !== 'ordinary' || input.sessionPersistence !== 'failed' ||
            input.result.kind !== 'completed' || input.result.completion.kind !== 'reply_text') {
            return main;
        }
        const notice = await presentFixedText(this.#dependencies, input, SESSION_PERSISTENCE_FAILED_MESSAGE);
        return aggregatePresentationResults(Object.freeze([main, notice]));
    }
}
