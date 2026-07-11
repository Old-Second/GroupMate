import { AbstractTool } from './AbstractTool.js'
import { canSendToTarget, formatToolError, isCurrentTarget, isTargetGroup, resolveTarget } from './ToolUtils.js'

function buildMusicLink (id) {
  return `网易云音乐：https://music.163.com/#/song?id=${id}`
}

async function buildMusicMsg (id) {
  if (typeof segment.music !== 'function') {
    return buildMusicLink(id)
  }
  return await segment.music(id + '', '163')
}

async function sendMusicToChat (sendFn, id) {
  try {
    await sendFn(await buildMusicMsg(id))
    return 'music card'
  } catch (err) {
    await sendFn(buildMusicLink(id))
    return `music link fallback (${formatToolError(err)})`
  }
}

async function sendMusicToCurrentChat (e, id) {
  if (e.isGroup) {
    const group = await e.bot.pickGroup(e.group_id)
    return await sendMusicToChat(msg => group.sendMsg(msg), id)
  }
  return await sendMusicToChat(msg => e.reply(msg), id)
}

export class SendMusicTool extends AbstractTool {
  name = 'sendMusic'

  parameters = {
    properties: {
      id: {
        type: 'string',
        description: '音乐的id'
      },
      targetGroupIdOrQQNumber: {
        type: 'string',
        description: 'Fill in the target user_id or groupId when you need to send music to specific group or user, otherwise leave blank'
      }
    },
    required: ['id']
  }

  func = async function (opts, e) {
    let { id, targetGroupIdOrQQNumber, sender } = opts
    const target = resolveTarget(e, targetGroupIdOrQQNumber)
    const permission = await canSendToTarget(e, target, sender)
    if (!permission.allowed) {
      return permission.reason
    }

    try {
      if (isCurrentTarget(e, target)) {
        const sentAs = await sendMusicToCurrentChat(e, id)
        return `the music has been shared to current chat as ${sentAs}`
      }

      let groupList
      try {
        groupList = await e.bot.getGroupList()
      } catch (err) {
        groupList = e.bot.gl
      }
      if (isTargetGroup(e, groupList, target)) {
        let group = await e.bot.pickGroup(target)
        if (typeof group.shareMusic === 'function') {
          await group.shareMusic('163', id)
          return `the music has been shared to group${target}`
        } else {
          const sentAs = await sendMusicToChat(msg => group.sendMsg(msg), id)
          return `the music has been shared to group${target} as ${sentAs}`
        }
      } else {
        if (!permission.isMaster) {
          return 'you are not allowed to pm other group members'
        }
        let user = e.bot.pickUser(target)
        if (e.group_id) {
          user = user.asMember(e.group_id)
        }
        const sentAs = await sendMusicToChat(msg => user.sendMsg(msg), id)
        return `the music has been shared to user${target} as ${sentAs}`
      }
    } catch (err) {
      return `music share failed: ${formatToolError(err)}`
    }
  }

  description = 'Useful when you want to share music. You must use searchMusic first to get the music id.  If no extra description needed, just reply <EMPTY> at the next turn'
}
