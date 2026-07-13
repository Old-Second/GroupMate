import { invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { id: { type: 'string' } },
    required: ['id'], additionalProperties: false
};
export function createSendMusicTool(services) {
    return visibleDefinition({
        name: 'sendMusic', description: '向当前会话分享已搜索到的网易云音乐。', inputSchema,
        execute: async (input, context) => {
            const id = String(input.id ?? '').trim();
            if (!/^\d{1,32}$/.test(id))
                return invalidArguments('音乐标识无效。');
            try {
                await services.qq.sendMusic(context.target, { provider: '163', id }, context.signal);
                return visibleResult('音乐已发送。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('音乐发送失败。');
            }
        }
    });
}
