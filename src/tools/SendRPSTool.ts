import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import {
  cancelledResult, executionFailure, sessionAddressForTarget, visibleDefinition, visibleDeliveryResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { value: { type: 'integer', enum: [1, 2, 3] } },
  required: ['value'], additionalProperties: false
} as const

export function createSendRPSTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendRPS', description: '在当前会话发送石头、剪刀或布。', inputSchema,
    resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      if (input.value !== 1 && input.value !== 2 && input.value !== 3) {
        return invalidArguments('石头剪刀布参数无效。')
      }
      try {
        const target = sessionAddressForTarget(context.facts.botId, context.target)
        if (target === null) return executionFailure('石头剪刀布发送失败。')
        const delivery = await services.qq.sendRps(target, input.value, context.signal)
        return visibleDeliveryResult(delivery, '石头剪刀布已发送。', '石头剪刀布发送失败。')
      } catch {
        return context.signal.aborted ? cancelledResult() : executionFailure('石头剪刀布发送失败。')
      }
    }
  })
}
