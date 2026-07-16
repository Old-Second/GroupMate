import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments, isToolResult, openImagePolicy, request } from './query-tool-support.js'
import {
  cancelledResult, executionFailure, indeterminateResult, resourceFromBytes,
  sessionAddressForTarget, visibleDefinition, visibleResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } },
  required: ['urls'], additionalProperties: false
} as const

export function createSendPictureTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendPicture', description: '向当前会话发送一至四张公网图片。',
    inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      const urls = Array.isArray(input.urls)
        ? input.urls.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4) : []
      if (urls.length === 0) return invalidArguments('没有可发送的图片地址。')
      let sent = 0
      try {
        const target = sessionAddressForTarget(context.facts.botId, context.target)
        if (target === null) return executionFailure('图片发送失败。')
        for (const url of urls) {
          const fetched = await request(services.policyFetch, {
            url, policy: openImagePolicy, timeoutMs: 15_000, signal: context.signal
          })
          if (isToolResult(fetched)) return sent > 0 ? indeterminateResult() : fetched
          if (fetched.status < 200 || fetched.status >= 300) {
            return sent > 0 ? indeterminateResult() : executionFailure('图片暂时无法读取。')
          }
          const delivery = await services.qq.sendImage(
            target, resourceFromBytes(fetched.body, fetched.contentType), context.signal
          )
          if (delivery.kind === 'outcome_unknown') return indeterminateResult()
          if (delivery.kind === 'failed_definite') {
            return sent > 0 ? indeterminateResult() : executionFailure('图片发送失败。')
          }
          sent += 1
        }
        return visibleResult(`已发送 ${urls.length} 张图片。`)
      } catch {
        if (sent > 0) return indeterminateResult()
        return context.signal.aborted ? cancelledResult() : executionFailure('图片发送失败。')
      }
    }
  })
}
