import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { value: { type: 'integer', enum: [1, 2, 3] } },
    required: ['value'], additionalProperties: false
};
export function createSendRPSTool(services) {
    return visibleDefinition({
        name: 'sendRPS', description: '在当前会话发送石头、剪刀或布。', inputSchema,
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            if (input.value !== 1 && input.value !== 2 && input.value !== 3) {
                return invalidArguments('石头剪刀布参数无效。');
            }
            try {
                await services.qq.sendRps(context.target, input.value, context.signal);
                return visibleResult('石头剪刀布已发送。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('石头剪刀布发送失败。');
            }
        }
    });
}
