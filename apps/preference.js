import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'

export class preference extends plugin {
  constructor () {
    super({
      name: 'GroupMate 对话偏好',
      dsc: '设置机器人回复本人时的称呼、语气和详略',
      event: 'message',
      priority: 491,
      rule: getProductionYunzaiAgent().conversationPreferenceController.hostRules()
    })
  }

  async conversationPreference (event) {
    return await getProductionYunzaiAgent().conversationPreferenceController.conversationPreference(event)
  }
}
