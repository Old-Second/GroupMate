import { invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, validResource, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object',
    properties: {
        userId: { type: 'string' }, uid: { type: 'string' }, character: { type: 'string' }
    },
    required: ['userId', 'uid', 'character'], additionalProperties: false
};
export function createGameQueryTool(options, game, name, description) {
    return visibleDefinition({
        name, description, inputSchema, network: 'none',
        execute: async (input, context) => {
            const userId = String(input.userId ?? '').trim() || context.facts.actor.userId;
            const uid = String(input.uid ?? '').trim();
            const character = String(input.character ?? '').trim();
            if (!/^\d{1,20}$/.test(userId) || (uid !== '' && !/^\d{1,20}$/.test(uid))) {
                return invalidArguments('游戏查询参数无效。');
            }
            try {
                const resource = await options.queryGame({ game, userId, uid, character }, context.signal);
                if (!validResource(resource))
                    return executionFailure('游戏面板返回了无效图片。');
                await options.sendImage(resource, context.target, context.signal);
                return visibleResult('游戏资料已发送。');
            }
            catch {
                return context.signal.aborted
                    ? cancelledResult()
                    : executionFailure('游戏资料暂时不可用。');
            }
        }
    });
}
