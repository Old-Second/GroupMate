import { ToolRegistry } from '../../agent/tools/tool-registry.js';
import { createGithubTool } from '../../tools/GithubTool.js';
import { createImageCaptionTool } from '../../tools/ImageCaptionTool.js';
import { createQueryGenshinTool } from '../../tools/QueryGenshinTool.js';
import { createQueryStarRailTool } from '../../tools/QueryStarRailTool.js';
import { createQueryUserinfoTool } from '../../tools/QueryUserinfoTool.js';
import { createSearchImageTool } from '../../tools/SearchImageTool.js';
import { createSearchMusicTool } from '../../tools/SearchMusicTool.js';
import { createSearchTool } from '../../tools/SearchTool.js';
import { createSearchVideoTool } from '../../tools/SearchVideoTool.js';
import { createWeatherTool } from '../../tools/WeatherTool.js';
import { createWebsiteTool } from '../../tools/WebsiteTool.js';
export function createQueryToolRuntime(options) {
    const common = { policyFetch: options.policyFetch };
    const definitions = Object.freeze([
        createSearchTool({
            ...common, backend: options.config.searchSource,
            publicSource: options.config.publicSearchSource,
            tavilyApiKey: options.config.tavilyApiKey,
            bingApiKey: options.config.bingApiKey
        }),
        createWebsiteTool(common),
        createWeatherTool({
            ...common, apiKey: options.config.amapKey, apiBaseUrl: options.config.amapApiBaseUrl
        }),
        createGithubTool({
            ...common, apiBaseUrl: options.config.githubApiBaseUrl, apiKey: options.config.githubApiKey
        }),
        createQueryUserinfoTool({ currentGroupMembers: options.currentGroupMembers }),
        createQueryGenshinTool({ queryGame: options.queryGame }),
        createQueryStarRailTool({ queryGame: options.queryGame }),
        createSearchImageTool({
            ...common, backend: options.config.imageSearchSource,
            tavilyApiKey: options.config.tavilyApiKey,
            braveApiKey: options.config.braveSearchApiKey
        }),
        createSearchVideoTool(common),
        createSearchMusicTool(common),
        createImageCaptionTool({ ...common, apiBaseUrl: options.config.extraUrl })
    ]);
    return Object.freeze({ definitions, registry: new ToolRegistry(definitions) });
}
