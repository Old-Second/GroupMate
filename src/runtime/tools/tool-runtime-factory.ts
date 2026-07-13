import type { ToolDefinition } from '../../agent/tools/tool-definition.js'
import { ToolRegistry } from '../../agent/tools/tool-registry.js'
import { createGithubTool } from '../../tools/GithubTool.js'
import { createImageCaptionTool } from '../../tools/ImageCaptionTool.js'
import { createQueryGenshinTool } from '../../tools/QueryGenshinTool.js'
import { createQueryStarRailTool } from '../../tools/QueryStarRailTool.js'
import {
  createQueryUserinfoTool,
  type GroupMemberSummary
} from '../../tools/QueryUserinfoTool.js'
import { createSearchImageTool, type ImageSearchBackend } from '../../tools/SearchImageTool.js'
import { createSearchMusicTool } from '../../tools/SearchMusicTool.js'
import {
  createSearchTool,
  type PublicSearchSource,
  type SearchBackend
} from '../../tools/SearchTool.js'
import { createSearchVideoTool } from '../../tools/SearchVideoTool.js'
import { createWeatherTool } from '../../tools/WeatherTool.js'
import { createWebsiteTool } from '../../tools/WebsiteTool.js'
import type { GameQueryInput } from '../../tools/game-query-support.js'
import { PolicyFetch } from './policy-fetch.js'
import { createDrawTool } from '../../tools/DrawTool.js'
import { createProcessPictureTool } from '../../tools/ProcessPictureTool.js'
import { createSendAudioMessageTool } from '../../tools/SendAudioMessageTool.js'
import { createSendAvatarTool } from '../../tools/SendAvatarTool.js'
import { createSendDiceTool } from '../../tools/SendDiceTool.js'
import { createSendMessageTool } from '../../tools/SendMessageTool.js'
import { createSendMusicTool } from '../../tools/SendMusicTool.js'
import { createSendPictureTool } from '../../tools/SendPictureTool.js'
import { createSendRPSTool } from '../../tools/SendRPSTool.js'
import { createSendVideoTool } from '../../tools/SendVideoTool.js'
import type { VisibleToolServices } from '../../tools/visible-tool-support.js'
import { createEditCardTool } from '../../tools/EditCardTool.js'
import { createHandleMessageTool } from '../../tools/HandleMessageTool.js'
import { createJinyanTool } from '../../tools/JinyanTool.js'
import { createKickOutTool } from '../../tools/KickOutTool.js'
import { createSetTitleTool } from '../../tools/SetTitleTool.js'
import type { QqManagementCapabilities } from '../../tools/management-tool-support.js'

export interface QueryToolRuntimeConfig {
  readonly searchSource: SearchBackend
  readonly publicSearchSource: PublicSearchSource
  readonly tavilyApiKey: string
  readonly bingApiKey: string
  readonly amapKey: string
  readonly amapApiBaseUrl: string
  readonly githubApiBaseUrl: string
  readonly githubApiKey: string
  readonly imageSearchSource: ImageSearchBackend
  readonly braveSearchApiKey: string
  readonly extraUrl: string
}

export interface QueryToolRuntimeOptions {
  readonly policyFetch: PolicyFetch
  readonly config: QueryToolRuntimeConfig
  readonly currentGroupMembers: (
    groupId: string,
    signal: AbortSignal
  ) => Promise<ReadonlyMap<string, GroupMemberSummary>>
  readonly queryGame: (input: GameQueryInput, signal: AbortSignal) => Promise<unknown>
}

export interface QueryToolRuntime {
  readonly definitions: readonly ToolDefinition[]
  readonly registry: ToolRegistry
}

export function createVisibleToolDefinitions (services: VisibleToolServices): readonly ToolDefinition[] {
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
  ])
}

export function createManagementToolDefinitions (
  capabilities: QqManagementCapabilities
): readonly ToolDefinition[] {
  return Object.freeze([
    createEditCardTool(capabilities),
    createJinyanTool(capabilities),
    createKickOutTool(capabilities),
    createSetTitleTool(capabilities),
    createHandleMessageTool(capabilities)
  ])
}

export function createQueryToolRuntime (options: QueryToolRuntimeOptions): QueryToolRuntime {
  const common = { policyFetch: options.policyFetch }
  const definitions: readonly ToolDefinition[] = Object.freeze([
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
  ])
  return Object.freeze({ definitions, registry: new ToolRegistry(definitions) })
}
