import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments, isToolResult, request } from './query-tool-support.js';
import { cancelledResult, executionFailure, resourceFromBytes, sessionAddressForTarget, visibleDefinition, visibleDeliveryResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { id: { type: 'string' } },
    required: ['id'], additionalProperties: false
};
export function createSendVideoTool(services) {
    return visibleDefinition({
        name: 'sendVideo', description: '向当前会话分享已搜索到的视频。',
        inputSchema, network: services.videoDownloadEnabled ? 'open_http' : 'none',
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            const id = String(input.id ?? '').trim();
            if (!/^[A-Za-z0-9]{2,32}$/.test(id))
                return invalidArguments('视频标识无效。');
            try {
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('视频发送失败。');
                const video = await services.resolveVideo(id, context.signal);
                if (!services.videoDownloadEnabled || video.videoUrl === undefined) {
                    const delivery = await services.qq.sendText(target, video.shareText.slice(0, 4_000), context.signal);
                    return visibleDeliveryResult(delivery, '视频信息已发送。', '视频发送失败。');
                }
                const maxBytes = Math.min(Math.max(Math.trunc(services.videoMaxBytes), 1), 8 * 1024 * 1024);
                const policy = {
                    kind: 'open_http', maxBytes, allowedContentTypes: ['video/*']
                };
                const fetched = await request(services.policyFetch, {
                    url: video.videoUrl, policy, timeoutMs: 30_000, signal: context.signal
                });
                if (isToolResult(fetched))
                    return fetched;
                if (fetched.status < 200 || fetched.status >= 300)
                    return executionFailure('视频暂时无法下载。');
                const delivery = await services.qq.sendVideo(target, resourceFromBytes(fetched.body, fetched.contentType), context.signal);
                return visibleDeliveryResult(delivery, '视频已发送。', '视频发送失败。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('视频发送失败。');
            }
        }
    });
}
