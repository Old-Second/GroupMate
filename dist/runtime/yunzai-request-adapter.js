import { parseAgentMessage } from '../agent/contracts/content.js';
import { resolveConversationScope } from '../agent/session/conversation-scope.js';
import { buildModelMessageInput } from './message-input.js';
function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        String(value).length === 0 || String(value).length > 128) {
        throw new TypeError(`${label} is missing or invalid`);
    }
    return String(value);
}
function timestamp(value, label) {
    try {
        if (new Date(value).toISOString() !== value)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function actorRole(value) {
    return value === 'owner' || value === 'admin' ? value : 'member';
}
function publicImageReference(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function frozenModel(input) {
    if (typeof input.model !== 'string' || input.model.length === 0 ||
        typeof input.streaming !== 'boolean' || !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens <= 0 || typeof input.reasoning?.enabled !== 'boolean') {
        throw new TypeError('Yunzai request model configuration is invalid');
    }
    return Object.freeze({
        model: input.model,
        streaming: input.streaming,
        maxOutputTokens: input.maxOutputTokens,
        reasoning: Object.freeze({
            enabled: input.reasoning.enabled,
            ...(input.reasoning.effort === undefined ? {} : { effort: input.reasoning.effort })
        }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.topP === undefined ? {} : { topP: input.topP })
    });
}
function frozenBudget(input) {
    return Object.freeze({
        modelContextTokens: input.modelContextTokens,
        reservedOutputTokens: input.reservedOutputTokens,
        reservedToolTokens: input.reservedToolTokens,
        safetyMarginTokens: input.safetyMarginTokens,
        maxItems: input.maxItems,
        maxBytes: input.maxBytes
    });
}
export async function adaptYunzaiRequest(input) {
    const createdAt = timestamp(input.createdAt, 'request creation timestamp');
    const deadlineAt = timestamp(input.deadlineAt, 'request deadline');
    if (new Date(deadlineAt).getTime() <= new Date(createdAt).getTime()) {
        throw new TypeError('request deadline is invalid');
    }
    const requestId = identifier(input.requestId, 'request ID');
    const botId = identifier(input.event.self_id ?? input.event.bot?.uin, 'bot identity');
    const actorId = identifier(input.event.sender?.user_id ?? input.event.user_id, 'actor identity');
    const isGroup = input.event.isGroup === true;
    const groupId = isGroup ? identifier(input.event.group_id, 'group identity') : undefined;
    const scope = resolveConversationScope({
        isGroup,
        groupId,
        userId: actorId,
        groupMerge: input.groupMerge
    });
    const sessionAddress = Object.freeze({
        botId,
        scope: Object.freeze({ ...scope })
    });
    const channel = isGroup
        ? Object.freeze({ kind: 'group', botId, groupId: groupId })
        : Object.freeze({ kind: 'private', botId, userId: actorId });
    const displayName = input.event.sender?.card ?? input.event.sender?.nickname;
    const actor = Object.freeze({
        userId: actorId,
        ...(typeof displayName === 'string' && displayName.length > 0
            ? { displayName: displayName.slice(0, 256) }
            : {}),
        role: actorRole(input.event.sender?.role)
    });
    const messageInput = await buildModelMessageInput({
        event: input.event,
        currentPrompt: input.currentPrompt
    });
    const messageId = messageInput.currentMessageId ?? requestId;
    const parts = [Object.freeze({
            type: 'text',
            text: messageInput.prompt.length === 0 ? '[空消息]' : messageInput.prompt
        })];
    for (const resourceId of messageInput.imageUrls.filter(publicImageReference)) {
        parts.push(Object.freeze({
            type: 'resource_ref', resourceType: 'image', resourceId
        }));
    }
    const message = parseAgentMessage(Object.freeze({
        id: messageId,
        role: 'user',
        parts: Object.freeze(parts),
        createdAt,
        provenance: Object.freeze({
            source: 'qq_message',
            trust: 'untrusted',
            sensitivity: isGroup ? 'group' : 'private',
            sourceId: messageId,
            createdAt
        }),
        ...(messageInput.quotedMessage === undefined
            ? {}
            : { replyTo: messageInput.quotedMessage })
    }));
    if (!Array.isArray(input.systemInstructions) || input.systemInstructions.length === 0 ||
        input.systemInstructions.length > 16 || input.systemInstructions.some(value => (typeof value !== 'string' || value.length === 0 || value.length > 16_384))) {
        throw new TypeError('system instructions are invalid');
    }
    if (input.sessionTtlSeconds !== undefined && (!Number.isSafeInteger(input.sessionTtlSeconds) ||
        input.sessionTtlSeconds <= 0)) {
        throw new TypeError('session TTL is invalid');
    }
    return Object.freeze({
        requestId,
        createdAt,
        deadlineAt,
        sessionAddress,
        actor,
        channel,
        message,
        references: Object.freeze({
            currentMessageId: messageId,
            quotedMessageId: messageInput.quotedMessageId
        }),
        systemInstructions: Object.freeze([...input.systemInstructions]),
        model: frozenModel(input.model),
        contextBudget: frozenBudget(input.contextBudget),
        ...(input.sessionTtlSeconds === undefined
            ? {}
            : { sessionTtlSeconds: input.sessionTtlSeconds })
    });
}
