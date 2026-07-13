import { invalidArguments, isToolResult, request } from './query-tool-support.js';
import { cancelledResult, executionFailure, resourceFromBytes, visibleDefinition, visibleResult } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { id: { type: 'string' } },
    required: ['id'], additionalProperties: false
};
export function createSendVideoTool(services) {
    return visibleDefinition({
        name: 'sendVideo', description: '向当前会话分享已搜索到的视频。',
        inputSchema, network: services.videoDownloadEnabled ? 'open_http' : 'none',
        execute: async (input, context) => {
            const id = String(input.id ?? '').trim();
            if (!/^[A-Za-z0-9]{2,32}$/.test(id))
                return invalidArguments('视频标识无效。');
            try {
                const video = await services.resolveVideo(id, context.signal);
                if (!services.videoDownloadEnabled || video.videoUrl === undefined) {
                    await services.qq.sendText(context.target, video.shareText.slice(0, 4_000), context.signal);
                    return visibleResult('视频信息已发送。');
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
                await services.qq.sendVideo(context.target, resourceFromBytes(fetched.body, fetched.contentType), context.signal);
                return visibleResult('视频已发送。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('视频发送失败。');
            }
        }
    });
}
