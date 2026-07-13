import plugin from '../../../lib/plugins/plugin.js'
import { createApprovalCommandBridge } from '../dist/runtime/tools/approval-command.js'

const handleApprovalCommand = createApprovalCommandBridge()

export class approval extends plugin {
  constructor () {
    super({
      name: 'GroupMate 工具审批',
      dsc: '确认或拒绝一次性工具操作',
      event: 'message',
      priority: 1143,
      rule: [
        { reg: '^#确认\\s+[A-Za-z0-9_-]{16,64}$', fnc: 'confirmToolOperation' },
        { reg: '^#拒绝\\s+[A-Za-z0-9_-]{16,64}$', fnc: 'confirmToolOperation' }
      ]
    })
  }

  async confirmToolOperation (event) {
    return await handleApprovalCommand(event)
  }
}
