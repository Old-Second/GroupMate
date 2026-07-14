import { createHash } from 'node:crypto';
export const resourceKeyPattern = /^[a-z][a-z0-9_.:-]{0,127}$/;
const resourceKindPattern = /^[a-z][a-z0-9_.-]{0,31}$/;
const maxResourceKeys = 8;
function stableValue(value) {
    if (Array.isArray(value))
        return value.map(stableValue);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right, 'en'))
            .map(([key, member]) => [key, stableValue(member)]));
    }
    if (typeof value === 'number' && !Number.isFinite(value))
        return String(value);
    if (typeof value === 'bigint')
        return value.toString();
    return value;
}
function stableString(value) {
    try {
        return JSON.stringify(stableValue(value)) ?? String(value);
    }
    catch {
        return String(value);
    }
}
export function resourceKey(kind, ...sensitiveParts) {
    if (!resourceKindPattern.test(kind))
        throw new TypeError('invalid resource key kind');
    const digest = createHash('sha256')
        .update(JSON.stringify(sensitiveParts))
        .digest('hex')
        .slice(0, 24);
    return `${kind}:${digest}`;
}
export function freezeResourceKeys(keys) {
    if (!Array.isArray(keys) || keys.length > maxResourceKeys ||
        keys.some(key => typeof key !== 'string' || !resourceKeyPattern.test(key)) ||
        new Set(keys).size !== keys.length) {
        throw new TypeError('invalid resource keys');
    }
    return Object.freeze([...keys]);
}
export function readResourceKeys(toolName, input) {
    return freezeResourceKeys([resourceKey('read', toolName, stableString(input))]);
}
export function channelResourceKey(facts, kind, targetId) {
    return resourceKey('channel', facts.botId, kind, targetId);
}
export function currentChannelResourceKeys(_input, facts) {
    return freezeResourceKeys([
        facts.channel.kind === 'group'
            ? channelResourceKey(facts, 'group', facts.channel.groupId)
            : channelResourceKey(facts, 'private', facts.channel.userId)
    ]);
}
export function memberResourceKeys(input, facts) {
    if (facts.channel.kind !== 'group')
        return freezeResourceKeys([]);
    const userId = String(input.userId ?? '').trim() || facts.actor.userId;
    return freezeResourceKeys([
        channelResourceKey(facts, 'group', facts.channel.groupId),
        resourceKey('member', facts.botId, facts.channel.groupId, userId)
    ]);
}
export function messageResourceKeys(input, facts) {
    if (facts.channel.kind !== 'group')
        return freezeResourceKeys([]);
    return freezeResourceKeys([
        channelResourceKey(facts, 'group', facts.channel.groupId),
        resourceKey('message', facts.botId, facts.channel.groupId, String(input.messageId ?? '').trim())
    ]);
}
export function crossChannelResourceKeys(input, facts) {
    const kind = input.targetKind === 'group' ? 'group' : input.targetKind === 'private' ? 'private' : null;
    if (kind === null)
        return freezeResourceKeys([]);
    return freezeResourceKeys([
        channelResourceKey(facts, kind, String(input.targetId ?? '').trim())
    ]);
}
