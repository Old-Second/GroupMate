import { memberResourceKeys } from '../agent/tools/resource-key.js';
import { clipText } from './search-result-support.js';
import { boundedJson, invalidArguments, readOnlyDefinition, targetNotFound, textResult, upstreamFailure } from './query-tool-support.js';
const inputSchema = {
    type: 'object', properties: { userId: { type: 'string' } },
    required: ['userId'], additionalProperties: false
};
function safeMember(member) {
    return Object.freeze({
        userId: String(member.userId),
        ...(member.nickname === undefined ? {} : { nickname: clipText(member.nickname, 100) }),
        ...(member.card === undefined ? {} : { card: clipText(member.card, 100) }),
        ...(member.role === undefined ? {} : { role: member.role }),
        ...(member.title === undefined ? {} : { title: clipText(member.title, 100) })
    });
}
export function createQueryUserinfoTool(options) {
    return readOnlyDefinition({
        name: 'queryUserinfo', description: '查询当前群成员的公开昵称、群名片、角色和头衔。userId可用账号、self（自己）、当前群准确名片或昵称；已有真实艾特对象直接用账号，不再要求提供QQ号。只接受唯一准确匹配，同名时补问一次具体对象。私聊只查当前用户；不提供陌生人、私聊记录或私密资料。查看/发送头像用sendAvatar，不能用文字资料猜测头像画面。',
        inputSchema, network: 'none', retrySafe: true, resourceKeys: memberResourceKeys,
        execute: async (input, context) => {
            const reference = String(input.userId ?? '').trim().normalize('NFC');
            const userId = reference === '' || /^(?:self|me|我|自己)$/i.test(reference)
                ? context.facts.actor.userId : reference;
            if (context.facts.channel.kind !== 'group') {
                if (userId !== context.facts.actor.userId)
                    return invalidArguments('私聊中只能查询当前用户。');
                return textResult(boundedJson({
                    userId: context.facts.actor.userId,
                    displayName: context.facts.actor.displayName,
                    role: context.facts.actor.role
                }));
            }
            try {
                const members = await options.currentGroupMembers(context.facts.channel.groupId, context.signal);
                let member = members.get(userId);
                if (member === undefined && !/^\d{1,20}$/.test(userId)) {
                    const matches = new Map();
                    for (const candidate of members.values()) {
                        if ([candidate.card, candidate.nickname].some(value => typeof value === 'string' && value.trim().normalize('NFC') === userId)) {
                            matches.set(candidate.userId, candidate);
                        }
                    }
                    if (matches.size > 1)
                        return invalidArguments('当前群中有同名成员，请指定其中一人的账号或实际艾特对象。');
                    member = matches.values().next().value;
                }
                if (member === undefined)
                    return targetNotFound('当前群中未找到该成员。');
                return textResult(boundedJson(safeMember(member)));
            }
            catch {
                return upstreamFailure('群成员资料暂时不可用。');
            }
        }
    });
}
