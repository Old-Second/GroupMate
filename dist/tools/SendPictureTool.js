import { invalidArguments, isToolResult, openImagePolicy, request } from './query-tool-support.js';
import { cancelledResult, executionFailure, indeterminateResult, resourceFromBytes, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } },
    required: ['urls'], additionalProperties: false
};
export function createSendPictureTool(services) {
    return visibleDefinition({
        name: 'sendPicture', description: '向当前会话发送一至四张公网图片。',
        inputSchema, network: 'open_http',
        execute: async (input, context) => {
            const urls = Array.isArray(input.urls)
                ? input.urls.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4) : [];
            if (urls.length === 0)
                return invalidArguments('没有可发送的图片地址。');
            let sent = 0;
            try {
                for (const url of urls) {
                    const fetched = await request(services.policyFetch, {
                        url, policy: openImagePolicy, timeoutMs: 15_000, signal: context.signal
                    });
                    if (isToolResult(fetched))
                        return sent > 0 ? indeterminateResult() : fetched;
                    if (fetched.status < 200 || fetched.status >= 300) {
                        return sent > 0 ? indeterminateResult() : executionFailure('图片暂时无法读取。');
                    }
                    await services.qq.sendImage(context.target, resourceFromBytes(fetched.body, fetched.contentType), context.signal);
                    sent += 1;
                }
                return visibleResult(`已发送 ${urls.length} 张图片。`);
            }
            catch {
                if (sent > 0)
                    return indeterminateResult();
                return context.signal.aborted ? cancelledResult() : executionFailure('图片发送失败。');
            }
        }
    });
}
