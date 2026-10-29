// Yunzai loads JavaScript plugin classes; eligibility, bounds and extraction live in TypeScript.
import plugin from '../../../lib/plugins/plugin.js'
import { observeProductionGroupMessageV1 } from '../dist/runtime/group-memory-observation.js'

export class groupMemoryLearning extends plugin {
  constructor () {
    super({ name: 'GroupMate 群记忆自动候选', dsc: '从群聊发现待管理员审核的群记忆候选', event: 'message.group', priority: 489 })
  }

  async accept (event) {
    observeProductionGroupMessageV1(event)
    return false
  }
}
