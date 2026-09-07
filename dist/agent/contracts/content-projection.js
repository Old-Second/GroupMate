/**
 * The text projection of a message.
 *
 * Every context item reaches the provider as one model message whose `content`
 * is this projection, so the projection is the prompt prefix. A provider can
 * only reuse a cached prefix while the prefix stays byte-identical between
 * turns, which makes stability across replays a hard requirement rather than a
 * cosmetic one.
 *
 * A resource reference is projected as a label derived from where the reference
 * sits — its message and its position in that message — never from the resource
 * locator itself. Host media locators are signed, and the signature is a
 * short-lived scene-wide token the host rotates roughly hourly: projecting the
 * locator would rewrite the text of every image-bearing message on every
 * rotation and would hand the signature to the provider in clear text. The
 * position is immutable once a message is persisted, so the same reference keeps
 * one label for the life of the conversation while distinct references stay
 * distinguishable.
 */
import { createHash } from 'node:crypto';
const RESOURCE_LABEL_DOMAIN = 'groupmate.content.resource-ref.v1';
/** Wide enough that a bounded context cannot realistically collide. */
const RESOURCE_LABEL_HEX = 12;
/**
 * The stable label of the resource reference at `partIndex` of `messageId`.
 *
 * Domain separated and truncated: the label identifies a reference inside one
 * conversation, it is not a commitment to the resource behind it.
 */
export function resourceReferenceLabel(messageId, partIndex) {
    return createHash('sha256')
        .update(RESOURCE_LABEL_DOMAIN, 'utf8')
        .update('\0')
        .update(messageId, 'utf8')
        .update('\0')
        .update(String(partIndex), 'utf8')
        .digest('hex')
        .slice(0, RESOURCE_LABEL_HEX);
}
export function contentPartText(part, messageId, partIndex) {
    switch (part.type) {
        case 'text': return part.text;
        case 'mention': return `@${part.displayName ?? part.userId}`;
        case 'resource_ref':
            return `[${part.resourceType}: #${resourceReferenceLabel(messageId, partIndex)}]`;
        case 'tool_call': return `[工具调用: ${part.name}]`;
        case 'tool_result': return `[工具结果: ${part.status}] ${part.content}`;
    }
}
export function agentMessageText(message) {
    const text = message.parts
        .map((part, index) => contentPartText(part, message.id, index))
        .filter(value => value.length > 0)
        .join('\n');
    return text.length === 0 ? '[空消息]' : text;
}
