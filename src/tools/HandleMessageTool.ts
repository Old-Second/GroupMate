import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { messageResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import {
  asMessageTarget, managementDefinition, managementSuccess, messageTarget,
  type QqManagementCapabilities
} from './management-tool-support.js'

const inputSchema = {
  type: 'object', properties: {
    type: { type: 'string', enum: ['recall', 'essence', 'unessence'] },
    messageId: { type: 'string' }
  },
  required: ['type', 'messageId'], additionalProperties: false
} as const

export function createHandleMessageTool (capabilities: QqManagementCapabilities): ToolDefinition {
  return managementDefinition({
    name: 'handleMsg', description: '撤回当前群内指定消息，或设置、取消精华。',
    inputSchema, permission: 'group_moderator', destructive: true,
    resourceKeys: messageResourceKeys, resolveTarget: messageTarget,
    execute: async (input, context) => {
      const target = asMessageTarget(context.target)
      if (target === null || target.messageId === '') return invalidArguments('消息管理参数无效。')
      if (input.type === 'recall') await capabilities.recallMessage(target, context.signal)
      else await capabilities.setEssence(target, input.type === 'essence', context.signal)
      return managementSuccess('消息管理操作已完成。')
    }
  })
}
