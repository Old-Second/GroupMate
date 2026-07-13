import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import {
  boundedJson, invalidArguments, readOnlyDefinition, textResult, upstreamFailure
} from './query-tool-support.js'

export type GameKind = 'genshin' | 'star_rail'

export interface GameQueryInput {
  readonly game: GameKind
  readonly userId: string
  readonly uid: string
  readonly character: string
}

export interface GameQueryToolOptions {
  readonly queryGame: (input: GameQueryInput, signal: AbortSignal) => Promise<unknown>
}

const inputSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' }, uid: { type: 'string' }, character: { type: 'string' }
  },
  required: ['userId', 'uid', 'character'], additionalProperties: false
} as const

export function createGameQueryTool (
  options: GameQueryToolOptions,
  game: GameKind,
  name: 'queryGenshin' | 'queryStarRail',
  description: string
): ToolDefinition {
  return readOnlyDefinition({
    name, description, inputSchema, network: 'none', timeoutMs: 20_000,
    execute: async (input, context) => {
      const userId = String(input.userId ?? '').trim() || context.facts.actor.userId
      const uid = String(input.uid ?? '').trim()
      const character = String(input.character ?? '').trim()
      if (!/^\d{1,20}$/.test(userId) || (uid !== '' && !/^\d{1,20}$/.test(uid))) {
        return invalidArguments('游戏查询参数无效。')
      }
      try {
        const result = await options.queryGame({ game, userId, uid, character }, context.signal)
        return textResult(boundedJson(result))
      } catch {
        return upstreamFailure('游戏资料暂时不可用。')
      }
    }
  })
}
