// modified from StarRail-plugin | 已经过StarRail-plugin作者本人同意
import plugin from '../../../lib/plugins/plugin.js'
import { pluginRoot } from '../dist/runtime/plugin-context.js'
import { handleUpdateCommand } from '../dist/runtime/yunzai-update-controller.js'

// The Yunzai interface stays JavaScript; update policy is built from TypeScript.
export class Update extends plugin {
  constructor () {
    super({
      name: 'chatgpt更新插件',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#?(groupmate|GroupMate|GROUPMATE|chatgpt|柴特寄批踢|GPT|ChatGPT|柴特鸡批踢|Chat|CHAT|CHATGPT|柴特|ChatGPT-Plugin|ChatGPT-plugin|chatgpt-plugin)(插件)?(强制)?更新$',
          fnc: 'update'
        }
      ]
    })
  }

  async update () {
    return await handleUpdateCommand({
      isMaster: this.e.isMaster === true,
      root: pluginRoot,
      reply: message => this.reply(message)
    })
  }
}
