import { currentGroupMember } from '../CurrentGroupMember.js';
import { chatEntryAuthorized } from '../yunzai-chat-controller.js';
export function createActivityDispatch(options) {
    return async (record, signal) => {
        const bot = await options.botPicker.pick(record.botId);
        if (bot === null || String(bot.uin ?? bot.self_id ?? '') !== record.botId)
            return null;
        const address = { botId: record.botId, scope: { kind: 'group', groupId: record.groupId } };
        const lease = await options.admission.tryAcquire(address, signal);
        if (lease === null)
            return null;
        let authorized = false;
        return {
            authorize: async (freshSignal) => {
                authorized = false;
                const name = record.kind === 'poll' ? 'groupPoll' : 'scheduledTask';
                if (Array.isArray(options.config.disabledTools) && options.config.disabledTools.includes(name))
                    return 'revoked';
                const event = { bot, self_id: record.botId, user_id: record.ownerId, group_id: record.groupId,
                    sender: { user_id: record.ownerId }, isGroup: true, isPrivate: false, message: [] };
                const policy = await options.chatPolicy.snapshot(event);
                if (!chatEntryAuthorized(policy, event))
                    return 'revoked';
                if (await options.chatPolicy.isMuted(address))
                    return 'unavailable';
                const owner = await currentGroupMember(bot, record.groupId, record.ownerId, freshSignal);
                const member = await currentGroupMember(bot, record.groupId, record.botId, freshSignal);
                if (owner === null || member === null || owner.joinedAt === 0 || member.joinedAt === 0)
                    return 'unavailable';
                if (owner.joinedAt * 1000 > record.createdAt || member.joinedAt * 1000 > record.createdAt)
                    return 'revoked';
                for (const userId of record.notifyUserIds ?? []) {
                    const recipient = userId === record.ownerId ? owner : await currentGroupMember(bot, record.groupId, userId, freshSignal);
                    if (recipient === null || recipient.joinedAt === 0)
                        return 'unavailable';
                    if (recipient.joinedAt * 1000 > record.createdAt)
                        return 'revoked';
                }
                authorized = true;
                return 'allowed';
            },
            deliver: async (text, freshSignal) => {
                if (!authorized)
                    return 'failed_definite';
                authorized = false;
                const outbound = await options.outboundFactory.forTarget(address);
                const atoms = [];
                for (const userId of record.notifyUserIds ?? []) {
                    if (atoms.length > 0)
                        atoms.push({ kind: 'text', text: ' ' });
                    atoms.push({ kind: 'at', target: { userId } });
                }
                if (atoms.length > 0)
                    atoms.push({ kind: 'text', text: '\n' });
                atoms.push({ kind: 'text', text });
                const receipt = await outbound.deliver({ media: 'text', atoms }, 1, { signal: freshSignal });
                return receipt.kind;
            },
            release: async () => await lease.release()
        };
    };
}
