import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { currentChannelResourceKeys } from '../agent/tools/resource-key.js'
import { invalidArguments } from './query-tool-support.js'
import { httpUrl, urlIdentity } from './search-result-support.js'
import { sendRemoteImages, visibleDefinition, type VisibleToolServices } from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } },
  required: ['urls'], additionalProperties: false
} as const

export function createSendPictureTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendPicture', description: '向当前会话发送1～4张公网图片。只使用当前用户给出的或本次searchImage已成功返回的完整url。搜新图时必须先完成搜索，不能与searchImage同批，也不能拿历史图片/头像地址代替新结果，默认按请求张数发送，无需再问要不要发。重复地址只发送一次；确定坏地址会跳过，部分成功只报告已确认数量，不重发成功前缀；投递未知时停止且不重试。不能用于其他会话。',
    inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
    execute: async (input, context) => {
      const urls: string[] = [], seen = new Set<string>()
      for (const value of Array.isArray(input.urls) ? input.urls : []) {
        const url = httpUrl(value)
        if (url === null || seen.has(urlIdentity(url))) continue
        seen.add(urlIdentity(url))
        urls.push(url)
        if (urls.length === 4) break
      }
      if (urls.length === 0) return invalidArguments('没有可发送的图片地址。')
      return await sendRemoteImages(services, urls, context, '图片')
    }
  })
}
