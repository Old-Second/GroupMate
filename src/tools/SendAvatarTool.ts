import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { invalidArguments, isToolResult, openImagePolicy, request } from './query-tool-support.js'
import {
  cancelledResult, executionFailure, indeterminateResult, resourceFromBytes, visibleDefinition, visibleResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { userIds: { type: 'array', items: { type: 'string' } } },
  required: ['userIds'], additionalProperties: false
} as const

export function createSendAvatarTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendAvatar', description: '向当前会话发送一至四个用户头像。',
    inputSchema, network: 'open_http',
    execute: async (input, context) => {
      const userIds = Array.isArray(input.userIds)
        ? input.userIds.map(String).filter(value => /^\d{1,20}$/.test(value)).slice(0, 4) : []
      if (userIds.length === 0) return invalidArguments('没有有效的用户账号。')
      let sent = 0
      try {
        for (const userId of userIds) {
          const fetched = await request(services.policyFetch, {
            url: `https://q1.qlogo.cn/g?b=qq&s=160&nk=${encodeURIComponent(userId)}`,
            policy: openImagePolicy, timeoutMs: 15_000, signal: context.signal
          })
          if (isToolResult(fetched)) return sent > 0 ? indeterminateResult() : fetched
          await services.qq.sendImage(
            context.target, resourceFromBytes(fetched.body, fetched.contentType), context.signal
          )
          sent += 1
        }
        return visibleResult(`已发送 ${userIds.length} 个头像。`)
      } catch {
        if (sent > 0) return indeterminateResult()
        return context.signal.aborted ? cancelledResult() : executionFailure('头像发送失败。')
      }
    }
  })
}
