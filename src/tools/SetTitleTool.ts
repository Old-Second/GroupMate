import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { memberResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import {
  asMemberTarget, managementDefinition, managementSuccess, memberTarget,
  type QqManagementCapabilities
} from './management-tool-support.js'

const inputSchema = {
  type: 'object', properties: { userId: { type: 'string' }, title: { type: 'string' } },
  required: ['userId', 'title'], additionalProperties: false
} as const

export function createSetTitleTool (capabilities: QqManagementCapabilities): ToolDefinition {
  return managementDefinition({
    name: 'setTitle', description: '设置当前群内指定成员的专属头衔。',
    inputSchema, permission: 'bot_group_owner', resourceKeys: memberResourceKeys,
    resolveTarget: memberTarget,
    execute: async (input, context) => {
      const target = asMemberTarget(context.target)
      const title = String(input.title ?? '').trim()
      if (target === null || title === '' || Buffer.byteLength(title, 'utf8') > 100) {
        return invalidArguments('群头衔参数无效。')
      }
      await capabilities.setTitle(target, title, context.signal)
      return managementSuccess('群头衔已设置。')
    }
  })
}
