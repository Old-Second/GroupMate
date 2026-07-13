import { boundedJson, boundedText, clampInteger, configurationFailure, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure } from './query-tool-support.js';
const inputSchema = {
    type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } },
    required: ['q', 'limit'], additionalProperties: false
};
function normalize(data, backend, limit) {
    if (data === null || typeof data !== 'object')
        return [];
    const record = data;
    const candidates = backend === 'tavily'
        ? (Array.isArray(record.images) ? record.images : [])
        : backend === 'brave'
            ? (Array.isArray(record.results) ? record.results : [])
            : (Array.isArray(record.data) ? record.data : Array.isArray(record.results) ? record.results : []);
    return candidates.slice(0, limit).flatMap(item => {
        if (typeof item === 'string')
            return [{ url: item, thumbnail: item, title: '' }];
        if (item === null || typeof item !== 'object')
            return [];
        const value = item;
        const properties = value.properties !== null && typeof value.properties === 'object'
            ? value.properties : {};
        const thumbnail = value.thumbnail !== null && typeof value.thumbnail === 'object'
            ? value.thumbnail : {};
        const url = boundedText(value.url ?? value.murl ?? value.image ?? properties.url ?? thumbnail.src, 2_048);
        return url === '' ? [] : [{
                title: boundedText(value.title ?? value.desc, 200),
                url,
                thumbnail: boundedText(thumbnail.src ?? value.turl ?? value.thumbnail ?? url, 2_048),
                source: boundedText(value.purl ?? value.hostPageUrl, 2_048),
                description: boundedText(value.description ?? value.desc, 500)
            }];
    });
}
export function createSearchImageTool(options) {
    const tavily = fixedOriginPolicy('https://api.tavily.com', ['/search']);
    const brave = fixedOriginPolicy('https://api.search.brave.com', ['/res/v1/images/search']);
    const publicSearch = fixedOriginPolicy('https://serp.ikechan8370.com', ['/image/bing']);
    return readOnlyDefinition({
        name: 'searchImage', description: '搜索公开图片并返回候选图片地址。',
        inputSchema, network: 'fixed_hosts',
        execute: async (input, context) => {
            const q = String(input.q ?? '').trim();
            const limit = clampInteger(input.limit, 1, 6, 2);
            if (q === '')
                return invalidArguments('图片搜索关键词不能为空。');
            let response;
            if (options.backend === 'tavily') {
                if (options.tavilyApiKey === '')
                    return configurationFailure('图片搜索服务尚未配置。');
                response = await request(options.policyFetch, {
                    url: `${tavily.origin}/search`, policy: tavily.policy, timeoutMs: 10_000,
                    signal: context.signal, method: 'POST',
                    headers: { authorization: `Bearer ${options.tavilyApiKey}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ query: q, max_results: limit, include_images: true, include_image_descriptions: true })
                });
            }
            else if (options.backend === 'brave') {
                if (options.braveApiKey === '')
                    return configurationFailure('图片搜索服务尚未配置。');
                response = await request(options.policyFetch, {
                    url: `${brave.origin}/res/v1/images/search?q=${encodeURIComponent(q)}&count=${limit}&safesearch=moderate`,
                    policy: brave.policy, timeoutMs: 10_000, signal: context.signal,
                    headers: { accept: 'application/json', 'x-subscription-token': options.braveApiKey }
                });
            }
            else {
                response = await request(options.policyFetch, {
                    url: `${publicSearch.origin}/image/bing?q=${encodeURIComponent(q)}&limit=${limit}`,
                    policy: publicSearch.policy, timeoutMs: 10_000, signal: context.signal,
                    headers: { 'x-from-library': 'GroupMate' }
                });
            }
            if (isToolResult(response))
                return response;
            const parsed = parseJsonResponse(response);
            if (isToolResult(parsed))
                return parsed;
            const images = normalize(parsed, options.backend, limit);
            if (images.length === 0)
                return upstreamFailure('图片搜索暂时没有结果。', false);
            return textResult(boundedJson(images));
        }
    });
}
