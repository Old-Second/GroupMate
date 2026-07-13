import { configurationFailure, invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, validResource, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { prompt: { type: 'string' } },
    required: ['prompt'], additionalProperties: false
};
export function createDrawTool(services) {
    return visibleDefinition({
        name: 'draw', description: '根据描述生成图片并发送到当前会话。', inputSchema,
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
                await services.qq.sendImage(context.target, resource, context.signal);
                return visibleResult('图片已发送。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('绘图暂时失败。');
            }
        }
    });
}
