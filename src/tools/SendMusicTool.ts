import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import {
  cancelledResult, executionFailure, sessionAddressForTarget, visibleDefinition, visibleDeliveryResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { id: { type: 'string' } },
  required: ['id'], additionalProperties: false
} as const

export function createSendMusicTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendMusic', description: '向当前会话分享已搜索到的网易云音乐。', inputSchema,
    resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      const id = String(input.id ?? '').trim()
      if (!/^\d{1,32}$/.test(id)) return invalidArguments('音乐标识无效。')
      try {
        const target = sessionAddressForTarget(context.facts.botId, context.target)
        if (target === null) return executionFailure('音乐发送失败。')
        const delivery = await services.qq.sendMusic(target, { provider: '163', id }, context.signal)
        return visibleDeliveryResult(delivery, '音乐已发送。', '音乐发送失败。')
      } catch {
        return context.signal.aborted ? cancelledResult() : executionFailure('音乐发送失败。')
      }
    }
  })
}
