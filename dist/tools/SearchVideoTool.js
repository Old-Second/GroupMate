import { readResourceKeys } from '../agent/tools/resource-key.js';
import { boundedJson, boundedText, clampInteger, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure } from './query-tool-support.js';
const inputSchema = {
    type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'integer' } },
    required: ['keyword', 'limit'], additionalProperties: false
};
export function createSearchVideoTool(options) {
    const api = fixedOriginPolicy('https://api.bilibili.com', ['/x/web-interface/search/type']);
    return readOnlyDefinition({
        name: 'searchVideo', description: '按关键词搜索哔哩哔哩公开视频。',
        inputSchema, network: 'fixed_hosts', retrySafe: true,
        resourceKeys: input => readResourceKeys('searchVideo', input),
        execute: async (input, context) => {
            const keyword = String(input.keyword ?? '').trim();
            const limit = clampInteger(input.limit, 1, 5, 5);
            if (keyword === '')
                return invalidArguments('视频搜索关键词不能为空。');
            const response = await request(options.policyFetch, {
                url: `${api.origin}/x/web-interface/search/type?keyword=${encodeURIComponent(keyword)}&search_type=video`,
                policy: api.policy, timeoutMs: 10_000, signal: context.signal,
                headers: { referer: 'https://www.bilibili.com', 'user-agent': 'GroupMate/0.1' }
            });
            if (isToolResult(response))
                return response;
            const parsed = parseJsonResponse(response);
            if (isToolResult(parsed))
                return parsed;
            const data = parsed !== null && typeof parsed === 'object'
                ? parsed.data : undefined;
            const rows = data !== null && typeof data === 'object' && Array.isArray(data.result)
                ? data.result : [];
            if (rows.length === 0)
                return upstreamFailure('视频搜索暂时没有结果。', false);
            return textResult(boundedJson(rows.slice(0, limit).map(item => {
                const value = item !== null && typeof item === 'object' ? item : {};
                return {
                    id: boundedText(value.bvid, 100), title: boundedText(value.title, 300),
                    author: boundedText(value.author, 200), play: value.play,
                    publishedAt: value.pubdate
                };
            })));
        }
    });
}
