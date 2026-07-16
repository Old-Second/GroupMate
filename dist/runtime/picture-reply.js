import { aggregatePresentationResults } from './presentation/presentation-result.js';
import { normalizeCitationForwards, normalizeReasoningView } from './presentation/reply-content.js';
import { citationForwardPart, plainTextPart, reasoningForwardPart } from './presentation/text-presentation.js';
import { deliverWithDefiniteRetry } from './presentation/yunzai-outbound-port.js';
function frozenResult(outcome, deliveries) {
    return Object.freeze({ schemaVersion: 1, outcome, deliveries: Object.freeze([...deliveries]) });
}
function resultFromDelivery(delivery) {
    return frozenResult(delivery.kind === 'sent'
        ? 'complete'
        : delivery.kind === 'outcome_unknown'
            ? 'unknown'
            : 'failed', [delivery]);
}
async function deliverPart(port, part, input, quote = false) {
    const attempts = await deliverWithDefiniteRetry(port, part, {
        ...(quote && input.quoteMessageId !== undefined
            ? { quoteMessageId: input.quoteMessageId }
            : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const final = attempts.at(-1);
    return final === undefined
        ? frozenResult('failed', [])
        : resultFromDelivery(final);
}
async function presentTextFallback(port, input) {
    const children = [];
    const citations = normalizeCitationForwards(input.citations);
    if (citations.length > 0) {
        children.push(await deliverPart(port, citationForwardPart(citations), input));
    }
    children.push(await deliverPart(port, plainTextPart(input.text), input, true));
    const reasoning = input.reasoningView === null
        ? undefined
        : normalizeReasoningView(input.reasoningView);
    if (reasoning !== undefined) {
        children.push(await deliverPart(port, reasoningForwardPart(reasoning.text), input));
    }
    return aggregatePresentationResults(children);
}
export async function presentPictureReply(input, dependencies) {
    let rendered;
    try {
        rendered = await dependencies.renderer.render({
            replyText: input.text,
            citations: normalizeCitationForwards(input.citations),
            reasoningView: input.reasoningView === null
                ? null
                : normalizeReasoningView(input.reasoningView) ?? null,
            settings: input.settings
        }, input.signal);
    }
    catch {
        rendered = Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
    }
    let port;
    try {
        port = await dependencies.outboundFactory.forTarget(input.target);
    }
    catch {
        return frozenResult('failed', []);
    }
    if (rendered.kind === 'not_rendered')
        return await presentTextFallback(port, input);
    let picture;
    try {
        picture = await deliverPart(port, Object.freeze({
            media: 'picture',
            resource: rendered.resource
        }), input, true);
    }
    catch {
        return frozenResult('unknown', []);
    }
    if (picture.outcome === 'complete' || picture.outcome === 'unknown')
        return picture;
    const fallback = await presentTextFallback(port, input);
    return aggregatePresentationResults([picture, fallback]);
}
