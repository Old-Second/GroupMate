import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'

function projectDiagnosticEvent (event, commandArgument = '') {
  return Object.freeze({
    authorized: event?.isMaster === true,
    commandArgument,
    replyText: async text => {
      if (typeof event?.reply !== 'function') throw new TypeError('diagnostic reply is unavailable')
      await event.reply(text, true)
    }
  })
}

export class diagnostics extends plugin {
  constructor () {
    super({
      name: 'GroupMate 主人诊断',
      dsc: '查看 GroupMate 状态和脱敏运行轨迹',
      event: 'message',
      priority: 1142,
      rule: [
        { reg: '^#GroupMate状态$', fnc: 'status', permission: 'master' },
        { reg: '^#GroupMate诊断\\s+([0-9a-f]{32})$', fnc: 'diagnose', permission: 'master' }
      ]
    })
  }

  async status (event) {
    return await getProductionYunzaiAgent().diagnosticsController.handleStatus(
      projectDiagnosticEvent(event)
    )
  }

  async diagnose (event) {
    const message = typeof event?.msg === 'string' ? event.msg : ''
    const match = /^#GroupMate诊断\s+([0-9a-f]{32})$/.exec(message)
    return await getProductionYunzaiAgent().diagnosticsController.handleInspect(
      projectDiagnosticEvent(event, match?.[1] ?? '')
    )
  }
}
