import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { configurationFailure, invalidArguments, isToolResult, openImagePolicy, request } from './query-tool-support.js'
import {
  backgroundResourceResult, cancelledResult, executionFailure, resourceFromBytes,
  validResource, visibleDefinition, type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: {
    type: { type: 'string', enum: ['hed', 'scribble'] },
    imageUrl: { type: 'string' }, userId: { type: 'string' }
  },
  required: ['type', 'imageUrl', 'userId'], additionalProperties: false
} as const

export function createProcessPictureTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'processPicture', description: '处理图片并返回可供后续发送的图片资源。',
    inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      if (!services.pictureProcessingAvailable) return configurationFailure('图片处理服务尚未配置。')
      const userId = String(input.userId ?? '').trim()
      const imageUrl = String(input.imageUrl ?? '').trim() ||
        (userId === '' ? '' : `https://q1.qlogo.cn/g?b=qq&s=160&nk=${encodeURIComponent(userId)}`)
      if (imageUrl === '') return invalidArguments('需要提供图片地址或用户账号。')
      const fetched = await request(services.policyFetch, {
        url: imageUrl, policy: openImagePolicy, timeoutMs: 15_000, signal: context.signal
      })
      if (isToolResult(fetched)) return fetched
      if (fetched.status < 200 || fetched.status >= 300) return executionFailure('图片暂时无法读取。')
      try {
        const output = await services.processImage(
          resourceFromBytes(fetched.body, fetched.contentType),
          input.type === 'scribble' ? 'scribble' : 'hed', context.signal
        )
        if (!validResource(output)) return executionFailure()
        return backgroundResourceResult(output, context.callId)
      } catch {
        return context.signal.aborted ? cancelledResult() : executionFailure('图片处理暂时失败。')
      }
    }
  })
}
