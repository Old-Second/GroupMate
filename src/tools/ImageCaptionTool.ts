import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import { readResourceKeys } from '../agent/tools/resource-key.js'
import {
  decodeText, fixedOriginPolicy, isToolResult, openImagePolicy, readOnlyDefinition,
  request, textResult, upstreamFailure
} from './query-tool-support.js'

export interface ImageCaptionToolOptions {
  readonly policyFetch: PolicyFetch
  readonly apiBaseUrl: string
}

const inputSchema = {
  type: 'object',
  properties: {
    imageUrl: { type: 'string' }, userId: { type: 'string' }, question: { type: 'string' }
  },
  required: ['imageUrl', 'userId', 'question'], additionalProperties: false
} as const

function multipart (image: Uint8Array, contentType: string, boundary: string): Uint8Array {
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  )
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  return Buffer.concat([prefix, Buffer.from(image), suffix])
}

export function createImageCaptionTool (options: ImageCaptionToolOptions): ToolDefinition {
  const api = options.apiBaseUrl === '' ? null : fixedOriginPolicy(
    options.apiBaseUrl,
    ['/image-captioning', '/visual-qa'],
    ['text/plain', 'application/json'],
    64 * 1024
  )
  return readOnlyDefinition({
    name: 'imageCaption', description: '识别公开图片内容或回答有关图片的问题。',
    inputSchema, network: 'open_http', timeoutMs: 20_000, retrySafe: false,
    resourceKeys: input => readResourceKeys('imageCaption', input),
    execute: async (input, context) => {
      if (api === null) {
        return {
          status: 'failed', effect: 'none', errorCode: 'configuration_missing',
          userMessage: '图片识别服务尚未配置。', retryable: false
        }
      }
      const userId = String(input.userId ?? '').trim() || context.facts.actor.userId
      const imageUrl = String(input.imageUrl ?? '').trim() ||
        `https://q1.qlogo.cn/g?b=qq&s=160&nk=${encodeURIComponent(userId)}`
      const question = String(input.question ?? '').trim()
      const image = await request(options.policyFetch, {
        url: imageUrl, policy: openImagePolicy, timeoutMs: 15_000, signal: context.signal
      })
      if (isToolResult(image)) return image
      if (image.status < 200 || image.status >= 300) return upstreamFailure('图片暂时无法读取。')
      const boundary = `groupmate-${context.callId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'call'}`
      const endpoint = question === '' ? '/image-captioning' : `/visual-qa?q=${encodeURIComponent(question)}`
      const caption = await request(options.policyFetch, {
        url: `${api.origin}${endpoint}`, policy: api.policy, timeoutMs: 20_000,
        signal: context.signal, method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipart(image.body, image.contentType || 'application/octet-stream', boundary)
      })
      if (isToolResult(caption)) return caption
      if (caption.status < 200 || caption.status >= 300) return upstreamFailure('图片识别服务暂时不可用。')
      const text = decodeText(caption).trim()
      return text === '' ? upstreamFailure('图片识别服务未返回结果。', false) : textResult(text.slice(0, 12_000))
    }
  })
}
