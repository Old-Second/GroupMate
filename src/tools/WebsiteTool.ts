import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import { readResourceKeys } from '../agent/tools/resource-key.js'
import {
  decodeText, isToolResult, openWebPolicy, readOnlyDefinition, request,
  textResult, upstreamFailure
} from './query-tool-support.js'

export interface WebsiteToolOptions { readonly policyFetch: PolicyFetch }

const inputSchema = {
  type: 'object', properties: { url: { type: 'string' } },
  required: ['url'], additionalProperties: false
} as const

function cleanHtml (html: string): string {
  return html
    .replace(/<(script|style|head|figure)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createWebsiteTool (options: WebsiteToolOptions): ToolDefinition {
  return readOnlyDefinition({
    name: 'website', description: '读取公开网页或文本 API 的正文内容。',
    inputSchema, network: 'open_http', timeoutMs: 20_000, retrySafe: true,
    resourceKeys: input => readResourceKeys('website', input),
    execute: async (input, context) => {
      const response = await request(options.policyFetch, {
        url: String(input.url ?? ''), policy: openWebPolicy, timeoutMs: 20_000,
        signal: context.signal, headers: { 'user-agent': 'GroupMate/0.1' }
      })
      if (isToolResult(response)) return response
      if (response.status < 200 || response.status >= 300) return upstreamFailure('网页服务暂时不可用。')
      const raw = decodeText(response)
      const text = response.contentType === 'text/html' ? cleanHtml(raw) : raw.trim()
      return textResult(text.length <= 12_000 ? text : `${text.slice(0, 12_000)}…`)
    }
  })
}
