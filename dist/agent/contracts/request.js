import { parseAgentMessage } from './content.js';
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
function timestamp(value, label) {
    const result = text(value, label);
    if (new Date(result).toISOString() !== result)
        throw new TypeError(`${label} must be an ISO timestamp`);
    return result;
}
function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new TypeError(`${label} must be a non-negative safe integer`);
    return Number(value);
}
function parseSession(value) {
    const session = record(value, 'session');
    exact(session, ['botId', 'scope'], 'session');
    text(session.botId, 'bot ID');
    const scope = record(session.scope, 'conversation scope');
    if (scope.kind === 'private') {
        exact(scope, ['kind', 'userId'], 'private scope');
        text(scope.userId, 'scope user ID');
    }
    else if (scope.kind === 'group') {
        exact(scope, ['kind', 'groupId'], 'group scope');
        text(scope.groupId, 'scope group ID');
    }
    else if (scope.kind === 'group_user') {
        exact(scope, ['kind', 'groupId', 'userId'], 'group-user scope');
        text(scope.groupId, 'scope group ID');
        text(scope.userId, 'scope user ID');
    }
    else {
        throw new TypeError('conversation scope kind is invalid');
    }
    return value;
}
function parseActor(value) {
    const actor = record(value, 'actor');
    exact(actor, ['userId', 'displayName', 'role'], 'actor');
    text(actor.userId, 'actor user ID');
    if (actor.displayName !== undefined)
        text(actor.displayName, 'actor display name');
    if (!['owner', 'admin', 'member'].includes(String(actor.role)))
        throw new TypeError('actor role is invalid');
    return value;
}
function parseChannel(value) {
    const channel = record(value, 'channel');
    if (channel.kind === 'private') {
        exact(channel, ['kind', 'botId', 'userId'], 'private channel');
        text(channel.botId, 'channel bot ID');
        text(channel.userId, 'channel user ID');
    }
    else if (channel.kind === 'group') {
        exact(channel, ['kind', 'botId', 'groupId'], 'group channel');
        text(channel.botId, 'channel bot ID');
        text(channel.groupId, 'channel group ID');
    }
    else {
        throw new TypeError('channel kind is invalid');
    }
    return value;
}
export function parseAgentRequest(value) {
    const request = record(value, 'agent request');
    exact(request, ['schemaVersion', 'requestId', 'createdAt', 'session', 'actor', 'channel', 'message', 'limits', 'model', 'transport'], 'agent request');
    if (request.schemaVersion !== 1)
        throw new TypeError('request schema version is invalid');
    text(request.requestId, 'request ID');
    timestamp(request.createdAt, 'request timestamp');
    parseSession(request.session);
    parseActor(request.actor);
    parseChannel(request.channel);
    parseAgentMessage(request.message);
    const limits = record(request.limits, 'request limits');
    exact(limits, ['deadlineAt', 'maxModelTurns', 'maxToolCalls', 'maxInputTokens'], 'request limits');
    timestamp(limits.deadlineAt, 'request deadline');
    safeInteger(limits.maxModelTurns, 'maximum model turns');
    safeInteger(limits.maxToolCalls, 'maximum tool calls');
    if (limits.maxInputTokens !== undefined)
        safeInteger(limits.maxInputTokens, 'maximum input tokens');
    const model = record(request.model, 'request model');
    exact(model, ['model', 'streaming', 'capabilities'], 'request model');
    text(model.model, 'model name');
    if (typeof model.streaming !== 'boolean')
        throw new TypeError('model streaming must be boolean');
    const capabilities = record(model.capabilities, 'model capabilities');
    exact(capabilities, ['tools', 'vision'], 'model capabilities');
    if (typeof capabilities.tools !== 'boolean' || typeof capabilities.vision !== 'boolean') {
        throw new TypeError('model capabilities must be boolean');
    }
    if (request.transport !== undefined) {
        const transport = record(request.transport, 'transport metadata');
        for (const metadata of Object.values(transport)) {
            if (!['string', 'number', 'boolean'].includes(typeof metadata)) {
                throw new TypeError('transport metadata must contain primitives');
            }
        }
    }
    return value;
}
