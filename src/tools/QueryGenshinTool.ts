import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { createGameQueryTool, type GameQueryToolOptions } from './game-query-support.js'

export function createQueryGenshinTool (options: GameQueryToolOptions): ToolDefinition {
  return createGameQueryTool(options, 'genshin', 'queryGenshin', '查询原神玩家或角色资料。')
}
