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
    name: 'sendAvatar', description: '向当前会话发送1～4个用户头像。userIds可用账号或self（当前用户）；当前真实艾特对象直接使用其账号。明确要看自己的头像时直接调用，不先查群资料、不重复要QQ号；重复对象只发送一次。工具发送成功不代表模型已经看到了图片画面。',
    inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      const userIds = Array.isArray(input.userIds)
        ? [...new Set(input.userIds.map(String).map(value => value.trim())
            .map(value => /^(?:self|me|我|自己)$/i.test(value) ? context.facts.actor.userId : value)
            .filter(value => /^\d{1,20}$/.test(value)))].slice(0, 4) : []
      if (userIds.length === 0) return invalidArguments('没有有效的用户账号。')
      return await sendRemoteImages(services, userIds.map(userId =>
        `https://q1.qlogo.cn/g?b=qq&s=160&nk=${encodeURIComponent(userId)}`
      ), context, '头像')
    }
  })
}
