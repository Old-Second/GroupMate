import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import { readResourceKeys } from '../agent/tools/resource-key.js'
import {
  clampInteger, configurationFailure, fixedOriginPolicy, invalidArguments,
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

const OUTPUT_LIMIT_BYTES = 16 * 1024

interface SearchResult {
  readonly title: string
  readonly url: string
  readonly content: string
  readonly publishedDate: string
}

function clipText (value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= limit) return text
  if (limit === 0) return ''
  const last = text.charCodeAt(limit - 1)
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)}…`
}

function normalizedResults (data: unknown, limit: number): { results: SearchResult[]; truncated: boolean } {
  if (data === null || typeof data !== 'object') return { results: [], truncated: false }
  const record = data as Record<string, unknown>
  const source = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.data)
      ? record.data
      : (record.webPages !== null && typeof record.webPages === 'object' &&
          Array.isArray((record.webPages as Record<string, unknown>).value))
        ? (record.webPages as Record<string, unknown>).value as unknown[]
        : []
  let truncated = source.length > limit
  const clip = (value: unknown, size: number): string => {
    const text = clipText(value, size)
    if (typeof value === 'string' && text !== value) truncated = true
    return text
  }
  const results = source.slice(0, limit).flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const value = item as Record<string, unknown>
    // Keep citation URLs intact. A sliced URL is not a usable source.
    if (typeof value.url !== 'string' || value.url.length > 2048) return []
    try {
      const url = new URL(value.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return []
    } catch { return [] }
    return [{
      title: clip(value.title ?? value.name, 200),
      url: value.url,
      content: clip(value.content ?? value.snippet ?? value.description, 1_000),
      publishedDate: clip(value.published_date ?? value.datePublished, 100)
    }]
  })
  return { results, truncated }
}

function searchResult (data: unknown, limit: number): ReturnType<typeof textResult> {
  const record = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
  const normalized = normalizedResults(data, limit)
  const results = normalized.results
  const answer = clipText(record.answer, 1000)
  let snippetLimit = 1000
  let count = results.length
  let truncated = normalized.truncated || (typeof record.answer === 'string' && answer !== record.answer)
  for (;;) {
    const result = textResult(JSON.stringify({
      answer: clipText(answer, snippetLimit),
      results: results.slice(0, count).map(item => ({ ...item, content: clipText(item.content, snippetLimit) })),
      truncated
    }))
    // The executor measures the whole JSON-encoded ToolResult, including the
    // escaped JSON text. Character counts understate Chinese/emoji output.
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= OUTPUT_LIMIT_BYTES) return result
    truncated = true
    if (snippetLimit > 0) snippetLimit = Math.floor(snippetLimit / 2)
    else count--
  }
}

export function createSearchTool (options: SearchToolOptions): ToolDefinition {
  const tavily = fixedOriginPolicy('https://api.tavily.com', ['/search'])
  const bing = fixedOriginPolicy('https://api.bing.microsoft.com', ['/v7.0/search'])
  const publicSearch = fixedOriginPolicy('https://serp.ikechan8370.com', [
    '/bing', '/google', '/baidu', '/duckduckgo'
  ])
  return readOnlyDefinition({
    name: 'search',
    description: '搜索互联网公开信息；需要最新资料或不了解问题时直接使用，无需先问是否联网。num为1～8，通常3～5条即可。结果过长会缩短摘要并保留完整来源链接，truncated表示已压缩；先利用已有结果，不因压缩重复同一搜索。',
    inputSchema,
    network: 'fixed_hosts',
    maxOutputBytes: OUTPUT_LIMIT_BYTES,
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
      return searchResult(parsed, num)
    }
  })
}
