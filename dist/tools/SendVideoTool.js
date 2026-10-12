import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments, isToolResult, request } from './query-tool-support.js';
import { cancelledResult, executionFailure, resourceFromBytes, sessionAddressForTarget, dispatchVisible, visibleDefinition } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { id: { type: 'string' } },
    required: ['id'], additionalProperties: false
};
export function createSendVideoTool(services) {
    return visibleDefinition({
        name: 'sendVideo', description: '分享已查到的 B 站 BV 视频；默认发送链接，元数据不可用时仍可分享链接。',
        inputSchema, network: services.videoDownloadEnabled ? 'open_http' : 'fixed_hosts',
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            const id = String(input.id ?? '').trim();
            if (!/^BV[A-Za-z0-9]{10}$/.test(id))
                return invalidArguments('请提供完整的 B 站 BV 标识。');
            try {
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('视频发送失败。');
                const video = await services.resolveVideo(id, context.signal);
                if (!services.videoDownloadEnabled || video.videoUrl === undefined) {
                    return await dispatchVisible(() => services.qq.sendText(target, video.shareText.slice(0, 4_000), context.signal), '视频信息已发送。', '视频发送失败。');
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
                return await dispatchVisible(() => services.qq.sendVideo(target, resourceFromBytes(fetched.body, fetched.contentType), context.signal), '视频已发送。', '视频发送失败。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('视频发送失败。');
            }
        }
    });
}
