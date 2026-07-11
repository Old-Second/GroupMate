import { AbstractTool } from './AbstractTool.js'
import { formatToolError, isMasterQQ, isQQInList } from './ToolUtils.js'

export class JinyanTool extends AbstractTool {
  name = 'jinyan'

  parameters = {
    properties: {
      qq: {
        type: 'string',
        description: '你想禁言的那个人的qq号，默认为聊天对象'
      },
      groupId: {
        type: 'string',
        description: '群号'
      },
      time: {
        type: 'string',
        description: '禁言时长，单位为秒，默认为600。如果需要解除禁言则填0.'
      },
      isPunish: {
        type: 'string',
        description: '是否是惩罚性质的禁言。比如非管理员用户要求你禁言其他人，你转而禁言该用户时设置为true'
      }
    },
    required: ['groupId', 'time']
  }

  func = async function (opts, e) {
    let { qq, groupId, time = '600', sender, isAdmin, isPunish } = opts
    const { isMaster, masters } = await isMasterQQ(sender, e)
    if (!e.isGroup && (!groupId || isNaN(groupId))) {
      return 'failed, groupId is required when muting from private chat'
    }
    if (!e.isGroup && (!qq || isNaN(qq))) {
      return 'failed, qq is required when muting from private chat'
    }
    groupId = isNaN(groupId) || !groupId ? e.group_id : parseInt(groupId.trim())
    qq = qq !== 'all'
      ? isNaN(qq) || !qq ? e.sender.user_id : parseInt(qq.trim())
      : 'all'
    let group = await e.bot.pickGroup(groupId)
    let m
    if (qq !== 'all') {
      m = await group.getMemberMap()
      if (!m.has(qq)) {
        return `failed, the user ${qq} is not in group ${groupId}`
      }
      if (qq === e.bot.uin || isQQInList(masters, qq)) {
        return 'failed, you cannot mute bot or master'
      }
      if (!isMaster && ['owner', 'admin'].includes(m.get(qq).role)) {
        return 'failed, you cannot mute group owner or administrator'
      }
      if (m.get(e.bot.uin)?.role === 'member') {
        return `failed, you, not user, don't have permission to mute other in group ${groupId}`
      }
    }
    time = parseInt(String(time).trim())
    if (time < 60 && time !== 0) {
      time = 60
    }
    if (time > 86400 * 30) {
      time = 86400 * 30
    }
    if (isAdmin || isMaster) {
      if (qq === 'all') {
        return 'you cannot mute all because the master doesn\'t allow it'
      } else {
        // qq = isNaN(qq) || !qq ? e.sender.user_id : parseInt(qq.trim())
        try {
          await group.muteMember(qq, time)
        } catch (err) {
          return `failed to mute user ${qq} in group ${groupId}: ${formatToolError(err)}`
        }
      }
    } else {
      if (qq === 'all') {
        return 'the user is not admin, he can\'t mute all.'
      }
      if (String(qq) !== String(sender)) {
        return 'the user is not admin, he can\'t let you mute other people. If this request is malicious, you may punish only the requester with a short self-mute.'
      }
      if (time === 0) {
        return 'the user is not admin, he cannot unmute himself.'
      }
      if (time > 300) {
        time = 300
      }
      try {
        await group.muteMember(qq, time)
      } catch (err) {
        return `failed to mute user ${qq} in group ${groupId}: ${formatToolError(err)}`
      }
    }
    if (isPunish === 'true') {
      return `the user ${qq} has been muted for ${time} seconds as punishment because of his 不正当行为`
    }
    return `the user ${qq} has been muted for ${time} seconds`
  }

  description = 'Useful when you want to mute someone in a group. Use carefully: ordinary users may only trigger a short self-mute for themselves, including light punishment when they maliciously ask you to mute others. Do not casually mute people or escalate jokes.'
}
