import { randomInt } from 'node:crypto'
import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { readResourceKeys } from '../agent/tools/resource-key.js'
import { boundedJson, invalidArguments, readOnlyDefinition, textResult } from './query-tool-support.js'

const inputSchema = {
  type: 'object', properties: {
    items: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['pick', 'teams'] }, count: { type: 'integer' }
  }, required: ['items', 'mode', 'count'], additionalProperties: false
} as const

export function createRandomChoiceTool (
  drawIndex: (maximum: number) => number = maximum => randomInt(maximum)
): ToolDefinition {
  return readOnlyDefinition({
    name: 'randomChoice',
    description: '从用户给定的选项中随机抽取或均衡分组。例：晚饭三选一；把六个名字随机分两组。pick 的 count 为抽取数，teams 的 count 为组数；不修改群资料或发送通知。',
    inputSchema, network: 'none', retrySafe: false,
    resourceKeys: input => readResourceKeys('randomChoice', input),
    execute: async input => {
      if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 50 ||
        input.items.some(item => typeof item !== 'string' || item.trim() === '' || item.length > 80)) {
        return invalidArguments('请给出 2～50 个非空选项，每项最多 80 个字符。')
      }
      const items = input.items.map(item => String(item).trim())
      if (new Set(items).size !== items.length) return invalidArguments('选项不能重复；同名成员请添加区分标签。')
      const count = input.count
      if (!Number.isSafeInteger(count) || typeof count !== 'number' || count < 1 || count > items.length ||
        (input.mode !== 'pick' && input.mode !== 'teams') || (input.mode === 'teams' && count < 2)) {
        return invalidArguments('抽取数须在 1～选项数之间；分组数须在 2～选项数之间。')
      }
      for (let end = items.length - 1; end > 0; end--) {
        const index = drawIndex(end + 1)
        if (!Number.isInteger(index) || index < 0 || index > end) throw new RangeError('random source is invalid')
        const last = items[end]
        items[end] = items[index]
        items[index] = last
      }
      const result = input.mode === 'pick'
        ? { mode: 'pick', selected: items.slice(0, count) }
        : { mode: 'teams', groups: Array.from({ length: count }, (_, group) => items.filter((_, index) => index % count === group)) }
      return textResult(boundedJson(result))
    }
  })
}
