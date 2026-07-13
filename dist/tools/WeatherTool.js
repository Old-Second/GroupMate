import { boundedJson, configurationFailure, fixedOriginPolicy, invalidArguments, isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure } from './query-tool-support.js';
const inputSchema = {
    type: 'object', properties: { city: { type: 'string' } },
    required: ['city'], additionalProperties: false
};
export function createWeatherTool(options) {
    const api = fixedOriginPolicy(options.apiBaseUrl, ['/v3/config/district', '/v3/weather/weatherInfo']);
    return readOnlyDefinition({
        name: 'weather', description: '查询指定区县的实时天气。',
        inputSchema, network: 'fixed_hosts',
        execute: async (input, context) => {
            if (options.apiKey === '')
                return configurationFailure('天气服务尚未配置。');
            const city = String(input.city ?? '').trim();
            if (city === '')
                return invalidArguments('天气查询地点不能为空。');
            const districtResponse = await request(options.policyFetch, {
                url: `${api.origin}/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=1&key=${encodeURIComponent(options.apiKey)}`,
                policy: api.policy, timeoutMs: 10_000, signal: context.signal
            });
            if (isToolResult(districtResponse))
                return districtResponse;
            const districtJson = parseJsonResponse(districtResponse);
            if (isToolResult(districtJson))
                return districtJson;
            const districts = districtJson?.districts;
            const first = Array.isArray(districts) && districts[0] !== null && typeof districts[0] === 'object'
                ? districts[0] : undefined;
            const adcode = typeof first?.adcode === 'string' ? first.adcode : '';
            if (adcode === '')
                return upstreamFailure('未找到对应的天气区域。', false);
            const weatherResponse = await request(options.policyFetch, {
                url: `${api.origin}/v3/weather/weatherInfo?city=${encodeURIComponent(adcode)}&key=${encodeURIComponent(options.apiKey)}`,
                policy: api.policy, timeoutMs: 10_000, signal: context.signal
            });
            if (isToolResult(weatherResponse))
                return weatherResponse;
            const weatherJson = parseJsonResponse(weatherResponse);
            if (isToolResult(weatherJson))
                return weatherJson;
            const lives = weatherJson?.lives;
            if (!Array.isArray(lives) || lives.length === 0)
                return upstreamFailure('天气服务暂时没有可用数据。', false);
            return textResult(boundedJson({ city: first?.name ?? city, weather: lives[0] }));
        }
    });
}
