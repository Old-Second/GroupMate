import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import { sendRemoteImages, visibleDefinition, type VisibleToolServices } from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { userIds: { type: 'array', items: { type: 'string' } } },
  required: ['userIds'], additionalProperties: false
} as const

export function createSendAvatarTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendAvatar', description: '向当前会话发送一至四个用户头像。',
    inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      const userIds = Array.isArray(input.userIds)
        ? input.userIds.map(String).filter(value => /^\d{1,20}$/.test(value)).slice(0, 4) : []
      if (userIds.length === 0) return invalidArguments('没有有效的用户账号。')
      return await sendRemoteImages(services, userIds.map(userId =>
        `https://q1.qlogo.cn/g?b=qq&s=160&nk=${encodeURIComponent(userId)}`
      ), context, '头像')
    }
  })
}
