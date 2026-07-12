import { getUin, getUserData } from '../utils/common.js'
import { Config } from '../utils/config.js'
import { resolveProviderModeForRuntime } from '../dist/runtime/provider-mode-policy.js'

export const originalValues = ['api', 'API']
export const correspondingValues = ['api', 'api']

function getConversationScope (e, userId = e.sender?.user_id) {
  if (e.isGroup) {
    return Config.groupMerge ? `group:${e.group_id}` : `group:${e.group_id}:user:${userId}`
  }
  return `private:${userId}`
}

export class ConversationManager {
  async endConversation (e) {
    const userData = await getUserData(e.user_id)
    resolveProviderModeForRuntime((userData.mode === 'default' ? null : userData.mode) || await redis.get('CHATGPT:USE'), logger)

    const scope = getConversationScope(e)
    await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)

    let ats = (e.message || []).filter(message => message.type === 'at')
    if (Config.toggleMode === 'at') {
      ats = ats.filter(item => item.qq !== getUin(e))
    }

    if (ats.length === 0) {
      const key = `CHATGPT:CONVERSATIONS:${scope}`
      const conversation = await redis.get(key)
      if (!conversation) {
        await this.reply('当前没有开启对话', true)
        return
      }
      await redis.del(key)
      await this.reply('已结束当前对话，请@我进行聊天以开启新的对话', true)
      return
    }

    const at = ats[0]
    const targetScope = getConversationScope(e, at.qq)
    const targetName = String(at.text || '').replace(/^@/, '')
    const key = `CHATGPT:CONVERSATIONS:${targetScope}`
    const conversation = await redis.get(key)
    if (!conversation) {
      await this.reply(`当前${targetName}没有开启对话`, true)
      return
    }
    await redis.del(key)
    await this.reply(`已结束${targetName}的对话，TA仍可以@我进行聊天以开启新的对话`, true)
  }

  async endAllConversations () {
    const keys = await redis.keys('CHATGPT:CONVERSATIONS:*')
    for (const key of keys) {
      await redis.del(key)
      if (Config.debug) {
        logger.info('delete api conversation')
      }
    }
    await this.reply(`结束了${keys.length}个用户的对话。`, true)
  }
}
