import { createHash } from 'node:crypto';
import { isApprovalActorEligible, parseApprovalReplyText } from '../agent/run/interruption.js';
import { createApprovalRunIndex, deleteApprovalRunIndex, RUN_STORE_NAMESPACE } from '../agent/run/redis-run-store.js';
import { canonicalSessionKey } from '../agent/session/conversation-scope.js';
import { buildModelMessageInput } from './message-input.js';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INDEX_GRACE_SECONDS = 300;
function boundedIdentifier(value, label) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function boundedStableReference(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function timestamp(value, label) {
    if (typeof value !== 'string' || value.length > 64 ||
        new Date(value).toISOString() !== value) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
export function redisApprovalReferenceKey(address, messageId) {
    const hash = createHash('sha256')
        .update(canonicalSessionKey(address))
        .update('\0')
        .update(boundedStableReference(messageId, 'approval message ID'))
        .digest('hex');
    return `${RUN_STORE_NAMESPACE}approval-index:${hash}`;
}
function persistedReference(reference) {
    return Object.freeze({
        schemaVersion: 1,
        runId: boundedIdentifier(reference.runId, 'approval run ID'),
        approvalId: boundedIdentifier(reference.approvalId, 'approval ID')
    });
}
function encodeReference(reference) {
    return JSON.stringify(persistedReference(reference));
}
function decodeReference(raw, approvalAddress, messageId) {
    if (Buffer.byteLength(raw, 'utf8') > 1_024) {
        throw new TypeError('approval reference byte limit exceeded');
    }
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('approval reference is invalid');
    }
    const record = value;
    const keys = Object.keys(record);
    if (keys.length !== 3 || !['schemaVersion', 'runId', 'approvalId']
        .every(key => Object.hasOwn(record, key)) || record.schemaVersion !== 1) {
        throw new TypeError('approval reference is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        approvalAddress,
        messageId: boundedStableReference(messageId, 'approval message ID'),
        runId: boundedIdentifier(record.runId, 'approval run ID'),
        approvalId: boundedIdentifier(record.approvalId, 'approval ID')
    });
}
function sameAddress(left, right) {
    try {
        return canonicalSessionKey(left) === canonicalSessionKey(right);
    }
    catch {
        return false;
    }
}
function yunzaiIdentifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        String(value).length === 0 || String(value).length > 128) {
        throw new TypeError(`${label} is invalid`);
    }
    return String(value);
}
function yunzaiActorRole(actorId, senderRole, masterIds) {
    if (masterIds.some(value => String(value) === actorId))
        return 'bot_master';
    if (senderRole === 'owner')
        return 'group_owner';
    if (senderRole === 'admin')
        return 'group_admin';
    return 'member';
}
function yunzaiOccurredAt(now) {
    return now().toISOString();
}
export async function projectYunzaiApprovalReply(event, options) {
    const text = typeof event.msg === 'string' ? event.msg.normalize('NFC').trim() : '';
    if (parseApprovalReplyText(text) === null)
        return null;
    const input = await buildModelMessageInput({ event, currentPrompt: text });
    if (input.quotedMessageId === null)
        return null;
    const botId = yunzaiIdentifier(options.botId, 'approval bot ID');
    const actorId = yunzaiIdentifier(event.sender?.user_id ?? event.user_id, 'approval actor ID');
    const sessionAddress = event.isGroup === true
        ? Object.freeze({
            botId,
            scope: Object.freeze({
                kind: 'group',
                groupId: yunzaiIdentifier(event.group_id, 'approval group ID')
            })
        })
        : Object.freeze({
            botId,
            scope: Object.freeze({ kind: 'private', userId: actorId })
        });
    return Object.freeze({
        text,
        quotedMessageId: input.quotedMessageId,
        sessionAddress,
        actor: Object.freeze({
            userId: actorId,
            role: yunzaiActorRole(actorId, event.sender?.role, options.masterIds)
        }),
        occurredAt: yunzaiOccurredAt(options.now ?? (() => new Date()))
    });
}
export class RedisApprovalReferenceIndex {
    #client;
    constructor(client) {
        this.#client = client;
    }
    async create(reference, ttlSeconds) {
        return await createApprovalRunIndex(this.#client, redisApprovalReferenceKey(reference.approvalAddress, reference.messageId), encodeReference(reference), ttlSeconds);
    }
    async load(address, messageId) {
        const raw = await this.#client.get(redisApprovalReferenceKey(address, messageId));
        return raw === null ? null : decodeReference(raw, address, messageId);
    }
    async delete(reference) {
        await deleteApprovalRunIndex(this.#client, redisApprovalReferenceKey(reference.approvalAddress, reference.messageId), encodeReference(reference));
    }
}
export class RunApprovalRouter {
    #control;
    #index;
    #runtimeFor;
    constructor(options) {
        this.#control = options.control;
        this.#index = options.index;
        this.#runtimeFor = options.runtimeFor;
    }
    async registerDisplayed(input) {
        if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 ||
            input.ttlSeconds > 300) {
            throw new TypeError('approval TTL is invalid');
        }
        const pending = await this.#control.pendingApproval(input.runId, input.approvalId);
        if (pending === null || pending.approvalMessageId !== undefined)
            return null;
        const reference = Object.freeze({
            schemaVersion: 1,
            approvalAddress: pending.approvalAddress,
            messageId: boundedStableReference(input.messageId, 'approval message ID'),
            runId: pending.runId,
            approvalId: pending.approvalId
        });
        if (!await this.#index.create(reference, input.ttlSeconds + INDEX_GRACE_SECONDS)) {
            return null;
        }
        try {
            const displayed = await this.#control.displayApproval(input);
            if (displayed === null)
                await this.#index.delete(reference);
            return displayed;
        }
        catch (error) {
            await this.#index.delete(reference).catch(() => undefined);
            throw error;
        }
    }
    async route(reply, onResult) {
        const kind = parseApprovalReplyText(reply.text);
        if (kind === null || reply.quotedMessageId === null)
            return false;
        let occurredAt;
        try {
            occurredAt = timestamp(reply.occurredAt, 'approval reply timestamp');
        }
        catch {
            return false;
        }
        const reference = await this.#index.load(reply.sessionAddress, reply.quotedMessageId);
        if (reference === null)
            return false;
        const pending = await this.#control.pendingApproval(reference.runId, reference.approvalId);
        if (pending === null || pending.approvalMessageId !== reference.messageId ||
            pending.displayedAt === undefined || pending.expiresAt === undefined ||
            !sameAddress(reply.sessionAddress, pending.approvalAddress))
            return false;
        const expired = new Date(occurredAt).getTime() >= new Date(pending.expiresAt).getTime();
        if (!expired && !isApprovalActorEligible(pending, reply.actor))
            return false;
        const runtime = await this.#runtimeFor?.(reference.runId);
        const result = await this.#control.decideApproval({
            runId: reference.runId,
            approvalId: reference.approvalId,
            kind: expired ? 'expired' : kind,
            decidedAt: occurredAt,
            sessionAddress: reply.sessionAddress,
            ...(expired ? {} : { actor: reply.actor })
        }, runtime);
        if (result === null)
            return false;
        if (result.kind === 'approval_deferred')
            return true;
        await this.#index.delete(reference);
        await onResult?.(result, reference);
        return true;
    }
    async expire(address, messageId, occurredAt, onResult) {
        const reference = await this.#index.load(address, messageId);
        if (reference === null)
            return false;
        const pending = await this.#control.pendingApproval(reference.runId, reference.approvalId);
        if (pending === null || pending.expiresAt === undefined ||
            new Date(timestamp(occurredAt, 'approval expiration timestamp')).getTime() <
                new Date(pending.expiresAt).getTime())
            return false;
        const runtime = await this.#runtimeFor?.(reference.runId);
        const result = await this.#control.decideApproval({
            runId: reference.runId,
            approvalId: reference.approvalId,
            kind: 'expired',
            decidedAt: occurredAt,
            sessionAddress: pending.approvalAddress
        }, runtime);
        if (result === null)
            return false;
        if (result.kind === 'approval_deferred')
            return true;
        await this.#index.delete(reference);
        await onResult?.(result, reference);
        return true;
    }
}
