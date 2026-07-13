import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { invalidArguments } from './query-tool-support.js'
import {
  asMemberTarget, managementDefinition, managementSuccess, memberTarget,
  type QqManagementCapabilities
} from './management-tool-support.js'

const inputSchema = {
  type: 'object', properties: { userId: { type: 'string' } },
  required: ['userId'], additionalProperties: false
} as const

export function createKickOutTool (capabilities: QqManagementCapabilities): ToolDefinition {
  return managementDefinition({
    name: 'kickOut', aliases: ['kick', 'kickout'], description: '将当前群内指定普通成员移出群。',
    inputSchema, permission: 'group_owner_or_master', destructive: true, resolveTarget: memberTarget,
    execute: async (_input, context) => {
      const target = asMemberTarget(context.target)
      if (target === null || target.userId === '') return invalidArguments('移出群成员参数无效。')
      await capabilities.kickMember(target, context.signal)
      return managementSuccess('成员已移出群。')
    }
  })
}
