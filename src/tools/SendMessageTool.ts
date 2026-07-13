import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { invalidArguments } from './query-tool-support.js'
import {
  cancelledResult, crossChannelDefinition, executionFailure, visibleResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: {
    text: { type: 'string' },
    targetKind: { type: 'string', enum: ['group', 'private'] },
    targetId: { type: 'string' }
  },
  required: ['text', 'targetKind', 'targetId'], additionalProperties: false
} as const

export function createSendMessageTool (services: VisibleToolServices): ToolDefinition {
  return crossChannelDefinition({
    inputSchema,
    execute: async (input, context) => {
      if ((context.target.kind !== 'group' && context.target.kind !== 'private') ||
        !services.canSendCrossChannel(context.target)) {
        return {
          status: 'denied', effect: 'none', reasonCode: 'cross_channel_disabled',
          userMessage: '当前未允许跨会话发送。', retryable: false
        }
      }
      const text = String(input.text ?? '').trim()
      const targetId = String(input.targetId ?? '').trim()
      if (text === '' || Buffer.byteLength(text, 'utf8') > 8_000 || !/^\d{1,32}$/.test(targetId)) {
        return invalidArguments('跨会话消息参数无效。')
      }
      try {
        await services.qq.sendText(context.target, text, context.signal)
        return visibleResult('消息已发送。')
      } catch {
        return context.signal.aborted ? cancelledResult() : executionFailure('消息发送失败。')
      }
    }
  })
}
