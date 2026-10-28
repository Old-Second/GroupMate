import plugin from '../../../lib/plugins/plugin.js'
import { resolveProviderModeForRuntime } from '../dist/runtime/provider-mode-policy.js'

export class history extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin 聊天记录',
      dsc: '导出聊天记录',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#(chatgpt|ChatGPT)(导出)?聊天记录$',
          fnc: 'history',
          permission: 'master'
        }
      ]
    })
  }

  // 刻意保留的诚实桩：OpenAI-compatible 会话没有可导出的旧式聊天记录结构，
  // 这里返回明确说明而不是静默。该入口同时保留被表征测试固定的旧模式读取。
  async history (e) {
    resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    await e.reply('当前暂不支持导出 OpenAI-compatible 聊天记录', e.isGroup)
    return true
  }
}
