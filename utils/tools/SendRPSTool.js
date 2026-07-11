import { AbstractTool } from './AbstractTool.js'
import { canSendToTarget, clampNumber, isTargetGroup, resolveTarget } from './ToolUtils.js'

export class SendRPSTool extends AbstractTool {
  name = 'sendRPS'

  parameters = {
    properties: {
      num: {
        type: 'number',
        description: '石头剪刀布的代号，1、2、3'
      },
      targetGroupIdOrQQNumber: {
        type: 'string',
        description: 'Fill in the target user_id or groupId when you need to send RPS to specific group or user'
      }
    },
    required: ['num']
  }

  func = async function (opts, e) {
    let { num, targetGroupIdOrQQNumber, sender } = opts
    num = clampNumber(num, 1, 3, 1)
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
    if (isTargetGroup(e, groupList, target)) {
      let group = await e.bot.pickGroup(target, true)
      await group.sendMsg(segment.rps(num))
    } else {
      let user = e.bot.pickUser(target)
      if (e.group_id) {
        user = user.asMember(e.group_id)
      }
      await user.sendMsg(segment.rps(num))
    }
    return 'rps has been sent'
  }

  description = 'Use this tool if you want to play rock paper scissors. If you know the group number, use the group number instead of the qq number first. The input should be the number 1, 2 or 3 to represent rock-paper-scissors and the target group number or qq number，and they should be concat with a space'
}
