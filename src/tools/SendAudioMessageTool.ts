import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { configurationFailure, invalidArguments } from './query-tool-support.js'
import {
  cancelledResult, executionFailure, validResource, visibleDefinition, visibleResult,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' } },
  required: ['text', 'voice'], additionalProperties: false
} as const

export function createSendAudioMessageTool (services: VisibleToolServices): ToolDefinition {
  return visibleDefinition({
    name: 'sendAudioMessage', description: '将短文本转换为语音并发送到当前会话。', inputSchema,
    execute: async (input, context) => {
      if (!services.ttsAvailable) return configurationFailure('语音服务尚未配置。')
      const text = String(input.text ?? '').trim()
      const voice = String(input.voice ?? '').trim()
      if (text === '' || Buffer.byteLength(text, 'utf8') > 4_000) return invalidArguments('语音文本无效或过长。')
      try {
        const resource = await services.synthesizeAudio(text, voice, context.signal)
        if (!validResource(resource)) return executionFailure()
        await services.qq.sendAudio(context.target, resource, context.signal)
        return visibleResult('语音已发送。')
      } catch {
        return context.signal.aborted ? cancelledResult() : executionFailure('语音发送失败。')
      }
    }
  })
}
