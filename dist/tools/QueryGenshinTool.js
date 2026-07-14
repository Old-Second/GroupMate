import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { createGameQueryTool } from './game-query-support.js';
export function createQueryGenshinTool(options) {
    return createGameQueryTool(options, 'genshin', 'queryGenshin', '查询原神玩家或角色资料。', currentChannelResourceKeys);
}
