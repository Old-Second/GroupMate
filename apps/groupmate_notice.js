// Yunzai loads JavaScript plugin classes; all invalidation state and logic live in TypeScript.
import plugin from '../../../lib/plugins/plugin.js'
import { invalidateYunzaiGroupNotice } from '../dist/runtime/SceneBoundary.js'

export class groupmateNotice extends plugin {
  constructor () {
    super({ name: 'GroupMate 群状态失效', dsc: '失效在途群任务的权限证据', event: 'notice.group', priority: 1 })
  }

  async accept (event) {
    invalidateYunzaiGroupNotice(event)
    return false
  }
}
