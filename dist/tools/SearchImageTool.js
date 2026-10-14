import { readResourceKeys } from '../agent/tools/resource-key.js';
import { clipText, httpUrl, urlIdentity } from './search-result-support.js';
import { clampInteger, configurationFailure, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure } from './query-tool-support.js';
const inputSchema = {
    type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } },
    required: ['q', 'limit'], additionalProperties: false
};
const OUTPUT_LIMIT_BYTES = 16 * 1024;
function normalize(data, backend, limit) {
    if (data === null || typeof data !== 'object')
        return { images: [], truncated: false };
    const record = data;
    const candidates = backend === 'tavily'
        ? (Array.isArray(record.images) ? record.images : [])
        : backend === 'brave'
            ? (Array.isArray(record.results) ? record.results : [])
            : (Array.isArray(record.data) ? record.data : Array.isArray(record.results) ? record.results : []);
    const images = [], seen = new Set();
    let truncated = false;
    for (const item of candidates.slice(0, 64)) {
        if (images.length >= limit)
            break;
        if (item === null || typeof item !== 'object' && typeof item !== 'string' || Array.isArray(item))
            continue;
        const value = typeof item === 'string' ? { url: item } : item;
        const properties = value.properties !== null && typeof value.properties === 'object'
            ? value.properties : {};
        const thumbnail = value.thumbnail !== null && typeof value.thumbnail === 'object'
            ? value.thumbnail : {};
        const url = httpUrl(value.url ?? value.murl ?? value.image ?? properties.url ?? thumbnail.src);
        if (url === null || seen.has(urlIdentity(url)))
            continue;
        seen.add(urlIdentity(url));
        const title = clipText(value.title ?? value.desc, 200);
        const description = clipText(value.description ?? value.desc, 500);
        truncated ||= typeof (value.title ?? value.desc) === 'string' && title !== (value.title ?? value.desc);
        truncated ||= typeof (value.description ?? value.desc) === 'string' && description !== (value.description ?? value.desc);
        images.push({
            title,
            url,
            thumbnail: httpUrl(thumbnail.src ?? value.turl ?? value.thumbnail) ?? url,
            source: httpUrl(value.purl ?? value.hostPageUrl) ?? '',
            description
        });
    }
    return { images, truncated };
}
function imageResult(images, truncated) {
    let textLimit = 500, count = images.length, compactLinks = false;
    for (;;) {
        const result = textResult(JSON.stringify({ images: images.slice(0, count).map(image => ({
                url: image.url,
                title: clipText(image.title, textLimit),
                ...(!compactLinks ? { thumbnail: image.thumbnail, source: image.source } : {}),
                description: clipText(image.description, textLimit)
            })), truncated }));
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= OUTPUT_LIMIT_BYTES)
            return result;
        truncated = true;
        if (textLimit > 0)
            textLimit = Math.floor(textLimit / 2);
        else if (!compactLinks)
            compactLinks = true;
        else
            count--;
    }
}
export function createSearchImageTool(options) {
    const tavily = fixedOriginPolicy('https://api.tavily.com', ['/search']);
    const brave = fixedOriginPolicy('https://api.search.brave.com', ['/res/v1/images/search']);
    const publicSearch = fixedOriginPolicy('https://serp.ikechan8370.com', ['/image/bing']);
    return readOnlyDefinition({
        name: 'searchImage', description: '搜索公开图片，返回images候选列表及完整url。limit为1～6，未指定张数通常1～2张，不追问数量。用户明确要看图/搜图并发来时，使用候选url继续sendPicture，不再问是否发送；只要链接或不发送时只返回链接。truncated表示说明压缩，已有地址可用，无需重复搜同一关键词。',
        inputSchema, network: 'fixed_hosts', maxOutputBytes: OUTPUT_LIMIT_BYTES,
        retrySafe: options.backend !== 'tavily', timeoutMs: 12_000,
        resourceKeys: input => readResourceKeys('searchImage', input),
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
                    url: `${tavily.origin}/search`, policy: tavily.policy, timeoutMs: 8_000, diagnosticTag: 'image_search',
                    signal: context.signal, method: 'POST',
                    headers: { authorization: `Bearer ${options.tavilyApiKey}`, 'content-type': 'application/json' },
                    // Sending images needs candidate URLs, not the additional description work.
                    body: JSON.stringify({ query: q, max_results: limit, include_images: true, include_image_descriptions: false })
                });
            }
            else if (options.backend === 'brave') {
                if (options.braveApiKey === '')
                    return configurationFailure('图片搜索服务尚未配置。');
                response = await request(options.policyFetch, {
                    url: `${brave.origin}/res/v1/images/search?q=${encodeURIComponent(q)}&count=${limit}&safesearch=moderate`,
                    policy: brave.policy, timeoutMs: 8_000, signal: context.signal, diagnosticTag: 'image_search',
                    headers: { accept: 'application/json', 'x-subscription-token': options.braveApiKey }
                });
            }
            else {
                response = await request(options.policyFetch, {
                    url: `${publicSearch.origin}/image/bing?q=${encodeURIComponent(q)}&limit=${limit}`,
                    policy: publicSearch.policy, timeoutMs: 8_000, signal: context.signal, diagnosticTag: 'image_search',
                    headers: { 'x-from-library': 'GroupMate' }
                });
            }
            if (isToolResult(response))
                return response;
            const parsed = parseJsonResponse(response);
            if (isToolResult(parsed))
                return parsed;
            const { images, truncated } = normalize(parsed, options.backend, limit);
            if (images.length === 0)
                return upstreamFailure('图片搜索暂时没有结果。', false);
            return imageResult(images, truncated);
        }
    });
}
