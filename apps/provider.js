import plugin from '../../../lib/plugins/plugin.js'
import {
  legacyProviderCommandPattern,
  unsupportedProviderMessage
} from '../dist/runtime/provider-mode-policy.js'

export class ProviderCompatibility extends plugin {
  constructor () {
    super({
      name: 'GroupMate 旧模型兼容提示',
      dsc: '拦截已移除模型的旧命令并返回统一提示',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: legacyProviderCommandPattern,
          fnc: 'unsupportedProvider'
        }
      ]
    })
  }

  async unsupportedProvider (e) {
    await e.reply(unsupportedProviderMessage)
    return true
  }
}
