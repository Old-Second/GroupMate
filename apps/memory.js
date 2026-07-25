import plugin from '../../../lib/plugins/plugin.js'
import {
  productionPersonalMemoryCommandGatewayV1
} from '../dist/runtime/personal-memory-command.js'

const memoryCommands = productionPersonalMemoryCommandGatewayV1()

export class memory extends plugin {
  constructor () {
    super({
      name: 'GroupMate 个人长期记忆',
      dsc: '管理当前 QQ 用户自己的长期记忆',
      event: 'message',
      priority: 490,
      rule: [
        { reg: '^#长期记忆(?:\\s*.*)?$', fnc: 'personalMemory' }
      ]
    })
  }

  async personalMemory (event) {
    return await memoryCommands.handle(Object.freeze({
      event,
      text: typeof event?.msg === 'string' ? event.msg : '',
      replyText: async text => {
        if (typeof event?.reply !== 'function') throw new TypeError('memory reply is unavailable')
        await event.reply(text, true)
      },
      sendPrivateFile: async (filePath, fileName) => {
        if (event?.isGroup !== false || typeof event?.friend?.sendFile !== 'function') {
          throw new TypeError('private memory export is unavailable')
        }
        await event.friend.sendFile(filePath, fileName)
      }
    }))
  }
}
