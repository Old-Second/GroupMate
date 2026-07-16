import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { cancelledResult, executionFailure, indeterminateResult, sessionAddressForTarget, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { count: { type: 'integer' } },
    required: ['count'], additionalProperties: false
};
export function createSendDiceTool(services) {
    return visibleDefinition({
        name: 'sendDice', description: '在当前会话投掷一至五枚骰子。', inputSchema,
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            const count = typeof input.count === 'number' && Number.isFinite(input.count)
                ? Math.min(Math.max(Math.trunc(input.count), 1), 5) : 1;
            let sent = 0;
            try {
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('骰子发送失败。');
                for (let index = 0; index < count; index += 1) {
                    const delivery = await services.qq.sendDice(target, context.signal);
                    if (delivery.kind === 'outcome_unknown')
                        return indeterminateResult();
                    if (delivery.kind === 'failed_definite') {
                        return sent > 0 ? indeterminateResult() : executionFailure('骰子发送失败。');
                    }
                    sent += 1;
                }
                return visibleResult(`已投掷 ${count} 枚骰子。`);
            }
            catch {
                if (sent > 0)
                    return indeterminateResult();
                return context.signal.aborted ? cancelledResult() : executionFailure('骰子发送失败。');
            }
        }
    });
}
