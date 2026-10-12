import { readResourceKeys } from '../agent/tools/resource-key.js';
import { boundedJson, boundedText, clampInteger, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure } from './query-tool-support.js';
export function bilibiliVideoId(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname) ||
            url.username !== '' || url.password !== '' || url.port !== '')
            return null;
        return /^\/video\/(BV[A-Za-z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
    }
    catch {
        return null;
    }
}
const inputSchema = {
    type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'integer' } },
    required: ['keyword', 'limit'], additionalProperties: false
};
export function createSearchVideoTool(options) {
    const api = fixedOriginPolicy('https://api.bilibili.com', ['/x/web-interface/search/type']);
    return readOnlyDefinition({
        name: 'searchVideo', description: '按关键词搜索哔哩哔哩公开视频；接口不可用时使用网页检索，返回可分享的 BV 标识。',
        inputSchema, network: 'fixed_hosts', retrySafe: false, timeoutMs: 20_000,
        resourceKeys: input => readResourceKeys('searchVideo', input),
        execute: async (input, context) => {
            const keyword = String(input.keyword ?? '').trim();
            const limit = clampInteger(input.limit, 1, 5, 5);
            if (keyword === '')
                return invalidArguments('视频搜索关键词不能为空。');
            const response = await request(options.policyFetch, {
                url: `${api.origin}/x/web-interface/search/type?keyword=${encodeURIComponent(keyword)}&search_type=video`,
                policy: api.policy, timeoutMs: 5_000, signal: context.signal,
                headers: { referer: 'https://www.bilibili.com', 'user-agent': 'GroupMate/0.1' }
            });
            const parsed = isToolResult(response) ? response : parseJsonResponse(response);
            const data = parsed !== null && typeof parsed === 'object'
                ? parsed.data : undefined;
            const rows = data !== null && typeof data === 'object' && Array.isArray(data.result)
                ? data.result : [];
            const videos = rows.flatMap(item => {
                const value = item !== null && typeof item === 'object' ? item : {};
                const id = boundedText(value.bvid, 100);
                if (!/^BV[A-Za-z0-9]{10}$/.test(id))
                    return [];
                return [{
                        id, title: boundedText(value.title, 300).replace(/<[^>]*>/g, ''),
                        author: boundedText(value.author, 200), play: value.play,
                        publishedAt: value.pubdate, source: 'bilibili'
                    }];
            }).slice(0, limit);
            if (!isToolResult(parsed) && parsed?.code !== undefined &&
                parsed.code !== 0)
                videos.length = 0;
            if (videos.length > 0)
                return textResult(boundedJson(videos));
            if (context.signal.aborted)
                return isToolResult(parsed) ? parsed : upstreamFailure('视频搜索已取消。', false);
            if (options.fallbackSearch === undefined) {
                return isToolResult(parsed) ? parsed : upstreamFailure('视频搜索暂时没有结果。', false);
            }
            const fallback = await options.fallbackSearch.execute({
                q: `site:bilibili.com/video/ ${keyword}`, num: 8
            }, context);
            if (fallback.status !== 'success')
                return fallback;
            try {
                const text = fallback.content.find(item => item.type === 'text');
                const results = text?.type === 'text' ? JSON.parse(text.text).results : [];
                const seen = new Set();
                const matches = (Array.isArray(results) ? results : []).flatMap((row) => {
                    const id = bilibiliVideoId(typeof row?.url === 'string' ? row.url : '');
                    if (id === null || seen.has(id))
                        return [];
                    seen.add(id);
                    return [{ id, title: boundedText(row.title, 300).replace(/<[^>]*>/g, ''),
                            url: `https://www.bilibili.com/video/${id}`, source: 'web_search' }];
                }).slice(0, limit);
                return matches.length > 0 ? textResult(boundedJson(matches)) : upstreamFailure('未找到可分享的公开视频，请换一个关键词。', false);
            }
            catch {
                return upstreamFailure('视频搜索暂时不可用。', false);
            }
        }
    });
}
