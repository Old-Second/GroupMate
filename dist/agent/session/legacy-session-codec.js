function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function exact(value, keys, label) {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains unknown key: ${unknown}`);
}
function text(value, label) {
    if (typeof value !== 'string' || value.length === 0)
        throw new TypeError(`${label} must be a non-empty string`);
    return value;
}
function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
        throw new TypeError(`${label} must be a string or number`);
    }
    return String(value);
}
function isoTimestamp(value, label) {
    const result = text(value, label);
    if (new Date(result).toISOString() !== result)
        throw new TypeError(`${label} must be an ISO timestamp`);
    return result;
}
function timestampOrNow(value, now, label) {
    return value === undefined ? now.toISOString() : isoTimestamp(value, label);
}
function turnCount(value) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new TypeError('turn count must be a non-negative safe integer');
    return Number(value);
}
function messages(value) {
    if (!Array.isArray(value))
        throw new TypeError('session messages must be an array');
    for (const message of value)
        record(message, 'session message');
    return value;
}
function sameScope(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === 'private' && right.kind === 'private')
        return left.userId === right.userId;
    if (left.kind === 'group' && right.kind === 'group')
        return left.groupId === right.groupId;
    return left.kind === 'group_user' && right.kind === 'group_user' &&
        left.groupId === right.groupId && left.userId === right.userId;
}
function parseScope(value) {
    const scope = record(value, 'conversation scope');
    if (scope.kind === 'private') {
        exact(scope, ['kind', 'userId'], 'private conversation scope');
        return { kind: 'private', userId: text(scope.userId, 'scope user ID') };
    }
    if (scope.kind === 'group') {
        exact(scope, ['kind', 'groupId'], 'group conversation scope');
        return { kind: 'group', groupId: text(scope.groupId, 'scope group ID') };
    }
    if (scope.kind === 'group_user') {
        exact(scope, ['kind', 'groupId', 'userId'], 'group-user conversation scope');
        return {
            kind: 'group_user',
            groupId: text(scope.groupId, 'scope group ID'),
            userId: text(scope.userId, 'scope user ID')
        };
    }
    throw new TypeError('conversation scope kind is invalid');
}
function parseState(value) {
    const state = record(value, 'session state');
    exact(state, ['messages', 'conversationId', 'parentMessageId'], 'session state');
    const parsed = { messages: messages(state.messages) };
    if (state.conversationId !== undefined)
        parsed.conversationId = text(state.conversationId, 'conversation ID');
    if (state.parentMessageId !== undefined)
        parsed.parentMessageId = text(state.parentMessageId, 'parent message ID');
    return parsed;
}
function parseCanonicalRecord(value, address) {
    const canonical = record(value, 'canonical session');
    exact(canonical, [
        'schemaVersion', 'sessionId', 'botId', 'scope', 'startedBy',
        'createdAt', 'updatedAt', 'turnCount', 'state'
    ], 'canonical session');
    if (canonical.schemaVersion !== 1)
        throw new TypeError('canonical session schema version is invalid');
    const sessionId = text(canonical.sessionId, 'session ID');
    const botId = text(canonical.botId, 'bot ID');
    const scope = parseScope(canonical.scope);
    if (botId !== address.botId || !sameScope(scope, address.scope)) {
        throw new TypeError('canonical session address does not match its key');
    }
    const startedBy = record(canonical.startedBy, 'session starter');
    exact(startedBy, ['userId', 'displayName'], 'session starter');
    const parsedStartedBy = {
        userId: text(startedBy.userId, 'starter user ID')
    };
    if (startedBy.displayName !== undefined)
        parsedStartedBy.displayName = text(startedBy.displayName, 'starter display name');
    return {
        schemaVersion: 1,
        sessionId,
        botId,
        scope: address.scope,
        startedBy: parsedStartedBy,
        createdAt: isoTimestamp(canonical.createdAt, 'session creation time'),
        updatedAt: isoTimestamp(canonical.updatedAt, 'session update time'),
        turnCount: turnCount(canonical.turnCount),
        state: parseState(canonical.state)
    };
}
export const legacySessionCodec = {
    encode(session) {
        const validated = parseCanonicalRecord(session, {
            botId: session.botId,
            scope: session.scope
        });
        return JSON.stringify(validated);
    },
    decodeCanonical(raw, address) {
        return parseCanonicalRecord(JSON.parse(raw), address);
    },
    decodeLegacy(raw, input) {
        const legacy = record(JSON.parse(raw), 'legacy session');
        const sender = record(legacy.sender, 'legacy sender');
        const userId = identifier(sender.user_id, 'legacy sender user ID');
        const startedBy = { userId };
        if (sender.nickname !== undefined && String(sender.nickname).length > 0) {
            startedBy.displayName = String(sender.nickname);
        }
        const state = { messages: messages(legacy.messages) };
        if (legacy.conversation !== undefined) {
            const conversation = record(legacy.conversation, 'legacy conversation continuation');
            if (conversation.conversationId !== undefined) {
                state.conversationId = text(conversation.conversationId, 'conversation ID');
            }
        }
        if (legacy.parentMessageId !== undefined) {
            state.parentMessageId = text(legacy.parentMessageId, 'parent message ID');
        }
        return {
            schemaVersion: 1,
            sessionId: text(input.sessionId, 'session ID'),
            botId: text(input.address.botId, 'bot ID'),
            scope: input.address.scope,
            startedBy,
            createdAt: timestampOrNow(legacy.ctime, input.now, 'legacy creation time'),
            updatedAt: timestampOrNow(legacy.utime, input.now, 'legacy update time'),
            turnCount: turnCount(legacy.num),
            state
        };
    }
};
