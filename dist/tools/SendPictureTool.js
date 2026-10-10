import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments, isToolResult, openImagePolicy, request } from './query-tool-support.js';
import { cancelledResult, executionFailure, indeterminateResult, resourceFromBytes, sessionAddressForTarget, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } },
    required: ['urls'], additionalProperties: false
};
export function createSendPictureTool(services) {
    return visibleDefinition({
        name: 'sendPicture', description: '向当前会话发送一至四张公网图片。',
        inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            const urls = Array.isArray(input.urls)
                ? input.urls.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4) : [];
            if (urls.length === 0)
                return invalidArguments('没有可发送的图片地址。');
            let sent = 0;
            let dispatching = false;
            const controller = new AbortController();
            const abort = () => controller.abort();
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted)
                abort();
            // Leave the executor time to commit the confirmed/unknown result before
            // its 30s deadline. The deadline covers downloading AND QQ dispatch.
            const deadline = Date.now() + 25_000;
            const timer = setTimeout(abort, 25_000);
            const partial = () => visibleResult(`已发送 ${sent} 张图片，其余图片暂时无法发送。`);
            try {
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('图片发送失败。');
                for (const url of urls) {
                    if (controller.signal.aborted || Date.now() >= deadline)
                        return sent > 0 ? partial() : cancelledResult();
                    const fetched = await request(services.policyFetch, {
                        url, policy: openImagePolicy, timeoutMs: Math.max(100, Math.min(8_000, deadline - Date.now())),
                        signal: controller.signal, diagnosticTag: 'image_fetch'
                    });
                    if (isToolResult(fetched))
                        return sent > 0 ? partial() : fetched;
                    if (fetched.status < 200 || fetched.status >= 300) {
                        return sent > 0 ? partial() : executionFailure('图片暂时无法读取。');
                    }
                    if (controller.signal.aborted)
                        return sent > 0 ? partial() : cancelledResult();
                    dispatching = true;
                    const delivery = await services.qq.sendImage(target, resourceFromBytes(fetched.body, fetched.contentType), controller.signal);
                    dispatching = false;
                    if (delivery.kind === 'outcome_unknown')
                        return indeterminateResult();
                    if (delivery.kind === 'failed_definite') {
                        return sent > 0 ? partial() : executionFailure('图片发送失败。');
                    }
                    sent += 1;
                }
                return visibleResult(`已发送 ${urls.length} 张图片。`);
            }
            catch {
                if (dispatching)
                    return indeterminateResult();
                if (sent > 0)
                    return partial();
                return context.signal.aborted ? cancelledResult() : executionFailure('图片发送失败。');
            }
            finally {
                clearTimeout(timer);
                context.signal.removeEventListener('abort', abort);
            }
        }
    });
}
