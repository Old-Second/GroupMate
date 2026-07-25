import { createSceneParticipantV1 } from '../agent/memory/scene-participant.js';
import { MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2 } from '../agent/memory/memory-retrieval.js';
function abortError() {
    return new DOMException('operation was aborted', 'AbortError');
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw abortError();
}
function qqId(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        return null;
    }
    const normalized = String(value).trim();
    return /^\d{1,32}$/.test(normalized) ? normalized : null;
}
function hostIdentifier(value) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value;
}
function text(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.normalize('NFC').trim();
    return normalized === '' ? null : [...normalized].slice(0, 256).join('');
}
function groupRole(value) {
    return value === 'owner' || value === 'admin' || value === 'member' ? value : 'unknown';
}
function unwrapMemberInfo(value, expectedUserId) {
    let current = value;
    for (let depth = 0; depth < 3; depth += 1) {
        if (current === null || typeof current !== 'object' || Array.isArray(current))
            return null;
        const record = current;
        const userId = qqId(record.user_id ?? record.userId ?? record.qq);
        if (userId !== null)
            return userId === expectedUserId ? record : null;
        current = record.data ?? record.result;
    }
    return null;
}
async function invokePickMember(group, userId, signal) {
    if (typeof group.pickMember !== 'function')
        return null;
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            reject(abortError());
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const returned = Reflect.apply(group.pickMember, group, [
                hostIdentifier(userId),
                true,
                finish
            ]);
            if (returned !== undefined && returned !== null) {
                if (typeof returned === 'object' &&
                    typeof returned.then === 'function') {
                    void Promise.resolve(returned).then(finish, fail);
                }
                else {
                    finish(returned);
                }
            }
        }
        catch (error) {
            fail(error);
        }
    });
}
async function refreshMember(event, groupId, userId, signal) {
    throwIfAborted(signal);
    const bot = event.bot;
    if (typeof bot?.sendApi === 'function') {
        try {
            const raw = await Reflect.apply(bot.sendApi, bot, [
                'get_group_member_info',
                Object.freeze({
                    group_id: hostIdentifier(groupId),
                    user_id: hostIdentifier(userId),
                    no_cache: true
                })
            ]);
            throwIfAborted(signal);
            const member = unwrapMemberInfo(raw, userId);
            if (member !== null)
                return member;
        }
        catch (error) {
            if (signal.aborted)
                throw abortError();
        }
    }
    if (typeof bot?.getGroupMemberInfo === 'function') {
        try {
            const raw = await Reflect.apply(bot.getGroupMemberInfo, bot, [
                hostIdentifier(groupId),
                hostIdentifier(userId),
                true
            ]);
            throwIfAborted(signal);
            const member = unwrapMemberInfo(raw, userId);
            if (member !== null)
                return member;
        }
        catch (error) {
            if (signal.aborted)
                throw abortError();
        }
    }
    if (typeof bot?.pickMember === 'function') {
        try {
            let raw = await Reflect.apply(bot.pickMember, bot, [
                hostIdentifier(groupId),
                hostIdentifier(userId)
            ]);
            if (raw !== null && typeof raw === 'object' &&
                typeof raw.getInfo === 'function') {
                raw = await Reflect.apply(raw.getInfo, raw, [true]);
            }
            throwIfAborted(signal);
            const member = unwrapMemberInfo(raw, userId);
            if (member !== null)
                return member;
        }
        catch (error) {
            if (signal.aborted)
                throw abortError();
        }
    }
    try {
        const group = event.group !== undefined
            ? event.group
            : typeof bot?.pickGroup === 'function'
                ? await Reflect.apply(bot.pickGroup, bot, [hostIdentifier(groupId)])
                : null;
        const raw = group === null || typeof group !== 'object'
            ? null
            : await invokePickMember(group, userId, signal);
        throwIfAborted(signal);
        return unwrapMemberInfo(raw, userId);
    }
    catch (error) {
        if (signal.aborted)
            throw abortError();
        return null;
    }
}
function mentionedUserIds(event, accountId) {
    const result = [];
    const seen = new Set();
    const visited = new Set();
    const queue = [event.message];
    let nodes = 0;
    while (queue.length > 0 && nodes < 64 && result.length < 8) {
        const value = queue.shift();
        nodes += 1;
        if (Array.isArray(value)) {
            queue.push(...value.slice(0, 32));
            continue;
        }
        if (value === null || typeof value !== 'object' || visited.has(value))
            continue;
        visited.add(value);
        const record = value;
        const data = record.data !== null && typeof record.data === 'object'
            ? record.data
            : {};
        if (record.type === 'at' || data.type === 'at') {
            const userId = qqId(data.qq ?? data.user_id ?? record.qq ?? record.user_id);
            if (userId !== null && userId !== accountId && !seen.has(userId)) {
                seen.add(userId);
                result.push(userId);
            }
        }
        if (record.message !== undefined)
            queue.push(record.message);
        if (record.data !== undefined && record.data !== data)
            queue.push(record.data);
    }
    return Object.freeze(result);
}
function groupLifecycleId(groupId, member) {
    const raw = member.join_time ?? member.joinTime;
    const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
        ? `qq-group-${groupId}-bot-joined-${seconds}`
        : null;
}
function identityInput(member, userId, evidence) {
    return Object.freeze({
        userId,
        nickname: text(member.nickname),
        groupCard: text(member.card),
        groupTitle: text(member.title ?? member.special_title ?? member.group_title),
        groupRole: groupRole(member.role),
        roleEvidence: evidence
    });
}
export function createYunzaiSceneParticipantDirectoryV1() {
    return Object.freeze({
        async resolve(input, signal) {
            throwIfAborted(signal);
            const event = input.event;
            const accountId = qqId(input.accountId);
            const currentUserId = qqId(event.sender?.user_id ?? event.user_id);
            if (accountId === null || currentUserId === null)
                return null;
            if (event.isGroup !== true && event.isGroup !== false)
                return null;
            if (event.isGroup === false) {
                const current = createSceneParticipantV1(Object.freeze({
                    identity: Object.freeze({
                        userId: currentUserId,
                        nickname: text(event.sender?.nickname),
                        groupCard: null,
                        groupTitle: null,
                        groupRole: 'unknown',
                        roleEvidence: 'unknown'
                    }),
                    scene: Object.freeze({ kind: 'private' }),
                    membership: Object.freeze({
                        state: 'verified_present',
                        source: 'current_event',
                        observedAt: input.observedAt
                    })
                }));
                return Object.freeze({
                    scene: current.scene,
                    current,
                    references: Object.freeze([])
                });
            }
            const groupId = qqId(event.group_id);
            if (groupId === null)
                return null;
            const botMember = await refreshMember(event, groupId, accountId, signal);
            if (botMember === null)
                return null;
            const lifecycle = groupLifecycleId(groupId, botMember);
            if (lifecycle === null)
                return null;
            const scene = Object.freeze({
                kind: 'group',
                groupId,
                groupLifecycleId: lifecycle,
                groupName: text(event.group?.name ?? event.group_name)
            });
            const current = createSceneParticipantV1(Object.freeze({
                identity: identityInput(event.sender ?? {}, currentUserId, 'current_event'),
                scene,
                membership: Object.freeze({
                    state: 'verified_present',
                    source: 'current_event',
                    observedAt: input.observedAt
                })
            }));
            const candidates = [];
            const quotedId = qqId(input.messageEvidence.quotedMessage?.sender.userId);
            if (quotedId !== null && quotedId !== currentUserId) {
                candidates.push(Object.freeze({ userId: quotedId, reason: 'quoted_actor' }));
            }
            for (const userId of mentionedUserIds(event, accountId)) {
                if (userId !== currentUserId) {
                    candidates.push(Object.freeze({ userId, reason: 'mentioned_actor' }));
                }
            }
            let strictTargetCount = 0;
            for (const value of input.strictTargetUserIds ?? []) {
                if (strictTargetCount >= MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects)
                    break;
                strictTargetCount += 1;
                const userId = qqId(value);
                if (userId !== null && userId !== currentUserId) {
                    candidates.push(Object.freeze({ userId, reason: 'explicit_target' }));
                }
            }
            const references = [];
            const seen = new Set();
            for (const candidate of candidates) {
                if (seen.has(candidate.userId))
                    continue;
                if (references.length >= MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects - 1)
                    break;
                seen.add(candidate.userId);
                const member = await refreshMember(event, groupId, candidate.userId, signal);
                throwIfAborted(signal);
                if (member === null)
                    continue;
                const participant = createSceneParticipantV1(Object.freeze({
                    identity: identityInput(member, candidate.userId, 'member_refresh'),
                    scene,
                    membership: Object.freeze({
                        state: 'verified_present',
                        source: 'member_refresh',
                        observedAt: input.observedAt
                    })
                }));
                references.push(Object.freeze({ reason: candidate.reason, participant }));
            }
            return Object.freeze({ scene, current, references: Object.freeze(references) });
        }
    });
}
export function bindYunzaiPersonalMemoryRecallSourceV1(input) {
    return Object.freeze({
        async recall(value, signal) {
            return await input.source.recall(Object.freeze({
                botInstanceId: input.botInstanceId,
                accountId: value.request.sessionAddress.botId,
                participantInput: Object.freeze({
                    event: value.event,
                    messageEvidence: value.messageEvidence,
                    accountId: value.request.sessionAddress.botId,
                    observedAt: value.request.createdAt,
                    ...(value.strictTargetUserIds === undefined
                        ? {}
                        : { strictTargetUserIds: value.strictTargetUserIds })
                }),
                query: Object.freeze({ text: value.queryText, languageHint: null })
            }), signal);
        }
    });
}
