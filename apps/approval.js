import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'

export class approval extends plugin {
  constructor () {
    super({
      name: 'GroupMate 工具审批',
      dsc: '确认或拒绝一次性工具操作',
      event: 'message',
      priority: 1143,
      rule: [
        { reg: '^(确认|拒绝)$', fnc: 'confirmToolOperation' }
      ]
    })
  }

  async confirmToolOperation (event) {
    return await getProductionYunzaiAgent().approvalController.confirmToolOperation(event)
  }
}
