import { AbstractTool } from './AbstractTool.js'
import { convertFaces } from '../face.js'
import { Config } from '../config.js'
import { canSendToTarget, formatToolError, isCurrentTarget, isTargetGroup, resolveTarget } from './ToolUtils.js'

export class SendMessageToSpecificGroupOrUserTool extends AbstractTool {
  name = 'sendMessage'

  parameters = {
    properties: {
      msg: {
        type: 'string',
        description: 'text to be sent'
      },
      targetGroupIdOrQQNumber: {
        type: 'string',
        description: 'target qq or group number'
      }
    },
    required: ['msg']
  }

  func = async function (opt, e) {
    let { msg, sender, targetGroupIdOrQQNumber } = opt
    const target = resolveTarget(e, targetGroupIdOrQQNumber)
    const permission = await canSendToTarget(e, target, sender)
    if (!permission.allowed) {
      return permission.reason
    }

    let groupList
    try {
      groupList = await e.bot.getGroupList()
    } catch (err) {
      groupList = e.bot.gl
    }
    try {
      if (isCurrentTarget(e, target)) {
        await e.reply(await convertFaces(msg, true, e))
        return 'msg has been sent to current chat'
      }
      if (isTargetGroup(e, groupList, target)) {
        let group = await e.bot.pickGroup(target)
        await group.sendMsg(await convertFaces(msg, true, e))
        return 'msg has been sent to group' + target
      } else {
        if (!permission.isMaster) {
          if (!Config.enableToolPrivateSend) {
            return 'you are not allowed to pm other group members'
          }
        }
        let user = e.bot.pickUser(target)
        if (e.group_id) {
          user = user.asMember(e.group_id)
        }
        // let user = await e.bot.pickFriend(target)
        await user.sendMsg(msg)
        return 'msg has been sent to user' + target
      }
    } catch (err) {
      return `failed to send msg, error: ${formatToolError(err)}`
    }
  }

  description = 'Useful when you want to send a text message to specific user or group.  If no extra description needed, just reply <EMPTY> at the next turn'
}
