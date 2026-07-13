import { boundedJson, boundedText, clampInteger, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult } from './query-tool-support.js';
const searchTypes = ['repositories', 'issues', 'users', 'code', 'custom'];
const inputSchema = {
    type: 'object',
    properties: {
        q: { type: 'string' },
        type: { type: 'string', enum: searchTypes },
        num: { type: 'integer' },
        path: { type: 'string' }
    },
    required: ['q', 'type', 'num', 'path'], additionalProperties: false
};
const customPathPatterns = [
    /^\/repos\/[^/?#]+\/[^/?#]+(?:\/[A-Za-z0-9_.\/-]+)?(?:\?[^#]*)?$/,
    /^\/users\/[^/?#]+(?:\/[A-Za-z0-9_.\/-]+)?(?:\?[^#]*)?$/,
    /^\/orgs\/[^/?#]+(?:\/[A-Za-z0-9_.\/-]+)?(?:\?[^#]*)?$/
];
function safeCustomPath(value) {
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('://') ||
        /%(?:2e|2f|5c)/i.test(value))
        return false;
    const pathname = value.split('?', 1)[0];
    if (pathname.split('/').some(segment => segment === '.' || segment === '..'))
        return false;
    return customPathPatterns.some(pattern => pattern.test(value));
}
function withPerPage(path, num) {
    const url = new URL(path, 'https://placeholder.invalid');
    if (!url.searchParams.has('per_page'))
        url.searchParams.set('per_page', String(num));
    return `${url.pathname}${url.search}`;
}
function normalize(data, limit) {
    const values = Array.isArray(data)
        ? data
        : data !== null && typeof data === 'object' && Array.isArray(data.items)
            ? data.items
            : [data];
    return values.slice(0, limit).map(item => {
        if (item === null || typeof item !== 'object')
            return item;
        const value = item;
        return {
            name: boundedText(value.full_name ?? value.name ?? value.login ?? value.title, 200),
            url: boundedText(value.html_url, 2_048),
            state: boundedText(value.state, 50),
            description: boundedText(value.description ?? value.body, 500),
            language: boundedText(value.language, 100),
            stars: typeof value.stargazers_count === 'number' ? value.stargazers_count : undefined,
            updatedAt: boundedText(value.updated_at, 100)
        };
    });
}
export function createGithubTool(options) {
    const api = fixedOriginPolicy(options.apiBaseUrl, ['/search', '/repos', '/users', '/orgs']);
    return readOnlyDefinition({
        name: 'github', description: '查询 GitHub 仓库、议题、用户和公开 API 资源。',
        inputSchema, network: 'fixed_hosts',
        execute: async (input, context) => {
            const type = String(input.type);
            const q = String(input.q ?? '').trim();
            const path = String(input.path ?? '').trim();
            const num = clampInteger(input.num, 1, 10, 5);
            let relative;
            if (type === 'custom') {
                if (!safeCustomPath(path))
                    return invalidArguments('GitHub 自定义路径不受支持。');
                relative = withPerPage(path, num);
            }
            else {
                if (!searchTypes.includes(type) || type === 'custom' || q === '') {
                    return invalidArguments('GitHub 查询参数无效。');
                }
                relative = `/search/${type}?q=${encodeURIComponent(q)}&per_page=${num}`;
            }
            const headers = {
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'GroupMate/0.1'
            };
            if (options.apiKey !== '')
                headers.authorization = `Bearer ${options.apiKey}`;
            const response = await request(options.policyFetch, {
                url: `${api.origin}${relative}`, policy: api.policy, timeoutMs: 10_000,
                signal: context.signal, headers
            });
            if (isToolResult(response))
                return response;
            const parsed = parseJsonResponse(response);
            if (isToolResult(parsed))
                return parsed;
            return textResult(boundedJson(normalize(parsed, num)));
        }
    });
}
