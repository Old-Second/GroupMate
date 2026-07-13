import { invalidArguments } from './query-tool-support.js';
import { asMemberTarget, managementDefinition, managementSuccess, memberTarget } from './management-tool-support.js';
const inputSchema = {
    type: 'object', properties: { userId: { type: 'string' }, card: { type: 'string' } },
    required: ['userId', 'card'], additionalProperties: false
};
export function createEditCardTool(capabilities) {
    return managementDefinition({
        name: 'editCard', description: '修改当前群内指定成员的群名片。',
        inputSchema, permission: 'group_moderator', resolveTarget: memberTarget,
        execute: async (input, context) => {
            const target = asMemberTarget(context.target);
            const card = String(input.card ?? '').trim();
            if (target === null || card === '' || Buffer.byteLength(card, 'utf8') > 300) {
                return invalidArguments('群名片参数无效。');
            }
            await capabilities.setCard(target, card, context.signal);
            return managementSuccess('群名片已修改。');
        }
    });
}
