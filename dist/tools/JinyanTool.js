import { memberResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments } from './query-tool-support.js';
import { asMemberTarget, managementDefinition, managementSuccess, memberTarget } from './management-tool-support.js';
const inputSchema = {
    type: 'object', properties: { userId: { type: 'string' }, seconds: { type: 'integer' } },
    required: ['userId', 'seconds'], additionalProperties: false
};
export function createJinyanTool(capabilities) {
    return managementDefinition({
        name: 'jinyan', aliases: ['mute', 'ban', 'jinyanTool'],
        description: '禁言或解除禁言当前群内指定成员。',
        inputSchema, permission: 'group_moderator', resourceKeys: memberResourceKeys,
        resolveTarget: memberTarget,
        execute: async (input, context) => {
            const target = asMemberTarget(context.target);
            const seconds = input.seconds;
            if (target === null || typeof seconds !== 'number' || !Number.isInteger(seconds) ||
                seconds < 0 || seconds > 30 * 24 * 60 * 60)
                return invalidArguments('禁言时长无效。');
            await capabilities.muteMember(target, seconds, context.signal);
            return managementSuccess(seconds === 0 ? '已解除禁言。' : '已执行禁言。');
        }
    });
}
