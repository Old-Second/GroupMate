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
import { createDrawTool } from '../../tools/DrawTool.js';
import { createProcessPictureTool } from '../../tools/ProcessPictureTool.js';
import { createSendAudioMessageTool } from '../../tools/SendAudioMessageTool.js';
import { createSendAvatarTool } from '../../tools/SendAvatarTool.js';
import { createSendDiceTool } from '../../tools/SendDiceTool.js';
import { createSendMessageTool } from '../../tools/SendMessageTool.js';
import { createSendMusicTool } from '../../tools/SendMusicTool.js';
import { createSendPictureTool } from '../../tools/SendPictureTool.js';
import { createSendRPSTool } from '../../tools/SendRPSTool.js';
import { createSendVideoTool } from '../../tools/SendVideoTool.js';
import { createEditCardTool } from '../../tools/EditCardTool.js';
import { createHandleMessageTool } from '../../tools/HandleMessageTool.js';
import { createJinyanTool } from '../../tools/JinyanTool.js';
import { createKickOutTool } from '../../tools/KickOutTool.js';
import { createSetTitleTool } from '../../tools/SetTitleTool.js';
export function createToolRuntimeRegistry(...definitionGroups) {
    const definitions = Object.freeze(definitionGroups.flatMap(group => [...group]));
    return Object.freeze({ definitions, registry: new ToolRegistry(definitions) });
}
export function createVisibleToolDefinitions(services) {
    return Object.freeze([
        createDrawTool(services),
        createProcessPictureTool(services),
        createSendPictureTool(services),
        createSendVideoTool(services),
        createSendAvatarTool(services),
        createSendMusicTool(services),
        createSendAudioMessageTool(services),
        createSendDiceTool(services),
        createSendRPSTool(services),
        createSendMessageTool(services)
    ]);
}
export function createManagementToolDefinitions(capabilities) {
    return Object.freeze([
        createEditCardTool(capabilities),
        createJinyanTool(capabilities),
        createKickOutTool(capabilities),
        createSetTitleTool(capabilities),
        createHandleMessageTool(capabilities)
    ]);
}
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
        createQueryGenshinTool({ queryGame: options.queryGame, sendImage: options.sendGameImage }),
        createQueryStarRailTool({ queryGame: options.queryGame, sendImage: options.sendGameImage }),
        createSearchImageTool({
            ...common, backend: options.config.imageSearchSource,
            tavilyApiKey: options.config.tavilyApiKey,
            braveApiKey: options.config.braveSearchApiKey
        }),
        createSearchVideoTool(common),
        createSearchMusicTool(common),
        createImageCaptionTool({ ...common, apiBaseUrl: options.config.extraUrl })
    ]);
    return createToolRuntimeRegistry(definitions);
}
