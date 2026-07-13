function abortError() {
    return new DOMException('operation was aborted', 'AbortError');
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw abortError();
}
function identifier(value, label) {
    const result = typeof value === 'number'
        ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
        : value;
    if (result.length === 0 || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new TypeError(`${label} is invalid`);
    }
    return result;
}
function role(value, label) {
    if (value !== 'owner' && value !== 'admin' && value !== 'member' && value !== 'none') {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function actorIdentity(source) {
    if (source.role !== 'owner' && source.role !== 'admin' && source.role !== 'member') {
        throw new TypeError('actor role is invalid');
    }
    if (source.displayName !== undefined && (typeof source.displayName !== 'string' || Buffer.byteLength(source.displayName, 'utf8') > 256)) {
        throw new TypeError('actor display name is invalid');
    }
    return Object.freeze({
        userId: identifier(source.userId, 'actor user ID'),
        ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
        role: source.role
    });
}
function channelIdentity(source, botId) {
    if (identifier(source.botId, 'channel bot ID') !== botId)
        throw new TypeError('channel bot ID does not match');
    return source.kind === 'private'
        ? Object.freeze({ kind: 'private', botId, userId: identifier(source.userId, 'channel user ID') })
        : Object.freeze({ kind: 'group', botId, groupId: identifier(source.groupId, 'channel group ID') });
}
function conversationScope(source) {
    if (source.kind === 'private')
        return Object.freeze({ kind: 'private', userId: identifier(source.userId, 'scope user ID') });
    if (source.kind === 'group')
        return Object.freeze({ kind: 'group', groupId: identifier(source.groupId, 'scope group ID') });
    return Object.freeze({
        kind: 'group_user',
        groupId: identifier(source.groupId, 'scope group ID'),
        userId: identifier(source.userId, 'scope user ID')
    });
}
function validateScope(channel, scope, actorId) {
    if (channel.kind === 'private') {
        if (scope.kind !== 'private' || channel.userId !== actorId || scope.userId !== actorId) {
            throw new TypeError('private runtime scope is inconsistent');
        }
        return;
    }
    if (scope.kind === 'private' || scope.groupId !== channel.groupId ||
        (scope.kind === 'group_user' && scope.userId !== actorId)) {
        throw new TypeError('group runtime scope is inconsistent');
    }
}
function targetUserId(target) {
    if (target.kind === 'member' || target.kind === 'private')
        return target.userId;
    return null;
}
function normalizeTarget(target) {
    if (target.kind === 'none')
        return Object.freeze({ kind: 'none' });
    if (target.kind === 'private') {
        return Object.freeze({ kind: 'private', userId: identifier(target.userId, 'target user ID') });
    }
    if (target.kind === 'group') {
        return Object.freeze({ kind: 'group', groupId: identifier(target.groupId, 'target group ID') });
    }
    if (target.kind === 'member') {
        return Object.freeze({
            kind: 'member',
            groupId: identifier(target.groupId, 'target group ID'),
            userId: identifier(target.userId, 'target user ID')
        });
    }
    return Object.freeze({
        kind: 'message',
        groupId: identifier(target.groupId, 'target group ID'),
        messageId: identifier(target.messageId, 'target message ID')
    });
}
export async function resolveToolRuntimeFacts(source, target, signal = new AbortController().signal) {
    throwIfAborted(signal);
    const botId = identifier(source.botId, 'bot ID');
    const normalizedTarget = normalizeTarget(target);
    const actor = actorIdentity(source.actor);
    const channel = channelIdentity(source.channel, botId);
    const scope = conversationScope(source.scope);
    validateScope(channel, scope, actor.userId);
    const masters = new Set(source.botMasterIds.map(value => identifier(value, 'bot master ID')));
    const actorWithMaster = Object.freeze({ ...actor, isBotMaster: masters.has(actor.userId) });
    const botGroupRole = role(source.botGroupRole, 'bot group role');
    const actorGroupRole = role(source.actorGroupRole, 'actor group role');
    let targetExists = normalizedTarget.kind === 'none';
    let targetRole = 'none';
    if (normalizedTarget.kind !== 'none') {
        if (source.lookupTarget === undefined)
            throw new TypeError('target lookup is unavailable');
        const resolved = await source.lookupTarget(normalizedTarget, signal);
        throwIfAborted(signal);
        if (typeof resolved?.exists !== 'boolean')
            throw new TypeError('target existence is invalid');
        targetExists = resolved.exists;
        targetRole = role(resolved.role, 'target role');
    }
    const userId = targetUserId(normalizedTarget);
    return Object.freeze({
        botId,
        actor: actorWithMaster,
        channel,
        scope,
        botGroupRole,
        actorGroupRole,
        targetRole,
        targetIsBotMaster: userId === null ? false : masters.has(userId),
        targetExists
    });
}
