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

  async history (e) {
    resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    await e.reply('当前暂不支持导出 OpenAI-compatible 聊天记录', e.isGroup)
    return true
  }
}
