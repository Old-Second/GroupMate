import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { pluginId } from '../dist/runtime/plugin-context.js'

export class ChatGPTMarkdownHandler extends plugin {
  constructor () {
    super({
      name: 'chatgptmd处理器',
      priority: -100,
      namespace: pluginId,
      handler: [{
        key: 'chatgpt.markdown.convert',
        fn: 'mdHandler'
      }]
    })
  }

  async mdHandler (e, options, reject) {
    const { content, prompt, use } = options
    if (Config.enableMd) {
      let mode = transUse(use)
      return `> ${prompt}\n\n---\n${content}\n\n---\n*当前模式：${mode}*`
    } else {
      return content
    }
  }
}

function transUse (use) {
  return use === 'api' ? (Config.model || 'OpenAI-compatible') : 'OpenAI-compatible'
}
