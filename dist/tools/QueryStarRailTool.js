import { createGameQueryTool } from './game-query-support.js';
export function createQueryStarRailTool(options) {
    return createGameQueryTool(options, 'star_rail', 'queryStarRail', '查询崩坏：星穹铁道玩家或角色资料。');
}
