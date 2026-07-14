import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { createGameQueryTool, type GameQueryToolOptions } from './game-query-support.js'

export function createQueryStarRailTool (options: GameQueryToolOptions): ToolDefinition {
  return createGameQueryTool(
    options, 'star_rail', 'queryStarRail', '查询崩坏：星穹铁道玩家或角色资料。',
    currentChannelResourceKeys
  )
}
