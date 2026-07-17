import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'

export class chatgpt extends plugin {
  constructor () {
    super({
      name: 'ChatGpt 对话',
      dsc: '与人工智能对话，畅聊无限可能~',
      event: 'message',
      priority: 1144,
      rule: getProductionYunzaiAgent().chatController.rules
    })
  }

  async chatgpt (event) {
    return await getProductionYunzaiAgent().chatController.chatgpt(event)
  }

  async chatgpt1 (event) {
    return await getProductionYunzaiAgent().chatController.chatgpt1(event)
  }

  async getAllConversations (event) {
    return await getProductionYunzaiAgent().chatController.getAllConversations(event)
  }

  async destroyConversations (event) {
    return await getProductionYunzaiAgent().chatController.destroyConversations(event)
  }

  async endAllConversations (event) {
    return await getProductionYunzaiAgent().chatController.endAllConversations(event)
  }

  async switch2Picture (event) {
    return await getProductionYunzaiAgent().chatController.switch2Picture(event)
  }

  async switch2Text (event) {
    return await getProductionYunzaiAgent().chatController.switch2Text(event)
  }

  async switch2Audio (event) {
    return await getProductionYunzaiAgent().chatController.switch2Audio(event)
  }

  async switchTTSSource (event) {
    return await getProductionYunzaiAgent().chatController.switchTTSSource(event)
  }

  async setDefaultRole (event) {
    return await getProductionYunzaiAgent().chatController.setDefaultRole(event)
  }

  async totalAvailable (event) {
    return await getProductionYunzaiAgent().chatController.totalAvailable(event)
  }

  async joinConversation (event) {
    return await getProductionYunzaiAgent().chatController.joinConversation(event)
  }
}
