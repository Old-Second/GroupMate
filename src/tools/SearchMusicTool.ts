import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import {
  boundedJson, boundedText, clampInteger, fixedOriginPolicy, invalidArguments, isToolResult,
  parseJsonResponse, readOnlyDefinition, request, textResult, upstreamFailure
} from './query-tool-support.js'

export interface SearchMusicToolOptions { readonly policyFetch: PolicyFetch }

const inputSchema = {
  type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'integer' } },
  required: ['keyword', 'limit'], additionalProperties: false
} as const

export function createSearchMusicTool (options: SearchMusicToolOptions): ToolDefinition {
  const api = fixedOriginPolicy('https://music.163.com', ['/api/search/get/web'])
  return readOnlyDefinition({
    name: 'searchMusic', description: '按歌曲名或歌手搜索网易云音乐公开曲目。',
    inputSchema, network: 'fixed_hosts',
    execute: async (input, context) => {
      const keyword = String(input.keyword ?? '').trim()
      const limit = clampInteger(input.limit, 1, 6, 6)
      if (keyword === '') return invalidArguments('音乐搜索关键词不能为空。')
      const response = await request(options.policyFetch, {
        url: `${api.origin}/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit}`,
        policy: api.policy, timeoutMs: 10_000, signal: context.signal,
        headers: { referer: 'https://music.163.com', 'user-agent': 'GroupMate/0.1' }
      })
      if (isToolResult(response)) return response
      const parsed = parseJsonResponse(response)
      if (isToolResult(parsed)) return parsed
      const result = parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).result : undefined
      const songs = result !== null && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).songs)
        ? (result as Record<string, unknown>).songs as unknown[] : []
      if (songs.length === 0) return upstreamFailure('音乐搜索暂时没有结果。', false)
      return textResult(boundedJson(songs.slice(0, limit).map(item => {
        const song = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
        const artists = Array.isArray(song.artists) ? song.artists : []
        return {
          id: song.id, name: boundedText(song.name, 200),
          artists: artists.map(artist => artist !== null && typeof artist === 'object'
            ? boundedText((artist as Record<string, unknown>).name, 100) : '').filter(Boolean),
          aliases: Array.isArray(song.alias) ? song.alias.slice(0, 5) : []
        }
      })))
    }
  })
}
