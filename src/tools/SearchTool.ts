import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import { readResourceKeys } from '../agent/tools/resource-key.js'
import {
  boundedJson, boundedText, clampInteger, configurationFailure, fixedOriginPolicy, invalidArguments,
  isToolResult, parseJsonResponse, readOnlyDefinition, request, textResult
} from './query-tool-support.js'

export type SearchBackend = 'tavily' | 'bing' | 'public'
export type PublicSearchSource = 'bing' | 'google' | 'baidu' | 'duckduckgo'

export interface SearchToolOptions {
  readonly policyFetch: PolicyFetch
  readonly backend: SearchBackend
  readonly publicSource: PublicSearchSource
  readonly tavilyApiKey: string
  readonly bingApiKey: string
}

const inputSchema = {
  type: 'object',
  properties: { q: { type: 'string' }, num: { type: 'integer' } },
  required: ['q', 'num'], additionalProperties: false
} as const

function normalizedResults (data: unknown, limit: number): unknown {
  if (data === null || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const source = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.data)
      ? record.data
      : (record.webPages !== null && typeof record.webPages === 'object' &&
          Array.isArray((record.webPages as Record<string, unknown>).value))
        ? (record.webPages as Record<string, unknown>).value as unknown[]
        : []
  return source.slice(0, limit).map(item => {
    if (item === null || typeof item !== 'object') return item
    const value = item as Record<string, unknown>
    return {
      title: boundedText(value.title ?? value.name, 200),
      url: boundedText(value.url, 2_048),
      content: boundedText(value.content ?? value.snippet ?? value.description, 1_000),
      publishedDate: boundedText(value.published_date ?? value.datePublished, 100)
    }
  })
}

export function createSearchTool (options: SearchToolOptions): ToolDefinition {
  const tavily = fixedOriginPolicy('https://api.tavily.com', ['/search'])
  const bing = fixedOriginPolicy('https://api.bing.microsoft.com', ['/v7.0/search'])
  const publicSearch = fixedOriginPolicy('https://serp.ikechan8370.com', [
    '/bing', '/google', '/baidu', '/duckduckgo'
  ])
  return readOnlyDefinition({
    name: 'search',
    description: '搜索互联网公开信息；需要最新资料或不了解问题时使用。',
    inputSchema,
    network: 'fixed_hosts',
    retrySafe: options.backend !== 'tavily',
    resourceKeys: input => readResourceKeys('search', input),
    execute: async (input, context) => {
      const q = String(input.q ?? '').trim()
      const num = clampInteger(input.num, 1, 8, 5)
      if (q === '') return invalidArguments('搜索关键词不能为空。')
      let response
      if (options.backend === 'tavily') {
        if (options.tavilyApiKey === '') return configurationFailure('搜索服务尚未配置。')
        response = await request(options.policyFetch, {
          url: `${tavily.origin}/search`, policy: tavily.policy, timeoutMs: 10_000,
          signal: context.signal, method: 'POST',
          headers: { authorization: `Bearer ${options.tavilyApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: q, max_results: num, search_depth: 'basic', include_answer: 'basic' })
        })
      } else if (options.backend === 'bing') {
        if (options.bingApiKey === '') return configurationFailure('搜索服务尚未配置。')
        response = await request(options.policyFetch, {
          url: `${bing.origin}/v7.0/search?q=${encodeURIComponent(q)}&mkt=zh-CN&count=${num}`,
          policy: bing.policy, timeoutMs: 10_000, signal: context.signal,
          headers: { 'ocp-apim-subscription-key': options.bingApiKey }
        })
      } else {
        response = await request(options.policyFetch, {
          url: `${publicSearch.origin}/${options.publicSource}?q=${encodeURIComponent(q)}&lang=zh-CN&limit=${num}`,
          policy: publicSearch.policy, timeoutMs: 10_000, signal: context.signal,
          headers: { 'x-from-library': 'GroupMate' }
        })
      }
      if (isToolResult(response)) return response
      const parsed = parseJsonResponse(response)
      if (isToolResult(parsed)) return parsed
      const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      return textResult(boundedJson({
        answer: boundedText(record.answer, 1_000),
        results: normalizedResults(parsed, num)
      }))
    }
  })
}
