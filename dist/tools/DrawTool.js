import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { configurationFailure, invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, sessionAddressForTarget, validResource, visibleDefinition, visibleDeliveryResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { prompt: { type: 'string' } },
    required: ['prompt'], additionalProperties: false
};
export function createDrawTool(services) {
    return visibleDefinition({
        name: 'draw', description: '根据描述生成图片并发送到当前会话。', inputSchema,
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            if (!services.drawingAvailable)
                return configurationFailure('绘图服务尚未配置。');
            const prompt = String(input.prompt ?? '').trim();
            if (prompt === '')
                return invalidArguments('绘图描述不能为空。');
            try {
                const resource = await services.generateImage(prompt, context.signal);
                if (!validResource(resource))
                    return executionFailure();
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('图片发送失败。');
                const delivery = await services.qq.sendImage(target, resource, context.signal);
                return visibleDeliveryResult(delivery, '图片已发送。', '图片发送失败。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('绘图暂时失败。');
            }
        }
    });
}
