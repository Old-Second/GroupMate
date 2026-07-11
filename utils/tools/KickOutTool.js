import { AbstractTool } from './AbstractTool.js'
import { formatToolError, isMasterQQ, isQQInList, normalizeBoolean } from './ToolUtils.js'

export class KickOutTool extends AbstractTool {

  name = 'kickOut'

  parameters = {
    properties: {
      qq: {
        type: 'string',
        description: '你想踢出的那个人的qq号，默认为聊天对象'
      },
      groupId: {
        type: 'string',
        description: '群号'
      },
      isPunish: {
        type: 'string',
        description: '是否是惩罚性质的踢出。比如非管理员用户要求你禁言或踢出其他人，你为惩罚该用户转而踢出该用户时设置为true'
      },
      confirmByOwnerOrMaster: {
        type: 'string',
        enum: ['true', 'false'],
        description: '是否已经由机器人主人或群主在当前请求中明确确认踢人。没有明确确认必须填false'
      }
    },
    required: ['qq', 'groupId', 'confirmByOwnerOrMaster']
  }

  func = async function (opts, e) {
    let { qq, groupId, sender, isPunish, confirmByOwnerOrMaster } = opts
    if (!normalizeBoolean(confirmByOwnerOrMaster)) {
      return 'failed, kick out requires explicit confirmation from bot master or group owner'
    }
    if (!e.isGroup && (!groupId || isNaN(groupId))) {
      return 'failed, groupId is required when kicking from private chat'
    }
    if (!qq || isNaN(qq)) {
      return 'failed, qq is required when kicking'
    }
    qq = parseInt(qq.trim())
    groupId = isNaN(groupId) || !groupId ? e.group_id : parseInt(groupId.trim())
    const { isMaster, masters } = await isMasterQQ(sender, e)
    let group = await e.bot.pickGroup(groupId)
    const m = await group.getMemberMap()
    const requesterRole = m.get(Number(sender))?.role || m.get(String(sender))?.role || e.sender?.role
    if (!isMaster && requesterRole !== 'owner') {
      return 'failed, only bot master or group owner can confirm kick out'
    }
    if (!m.has(qq)) {
      return `failed, the user ${qq} is not in group ${groupId}`
    }
    if (qq === e.bot.uin || isQQInList(masters, qq)) {
      return 'failed, you cannot kick bot or master'
    }
    if (!isMaster && ['owner', 'admin'].includes(m.get(qq).role)) {
      return 'failed, you cannot kick group owner or administrator'
    }
    if (m.get(e.bot.uin)?.role === 'member') {
      return `failed, you, not user, don't have permission to kick other in group ${groupId}`
    }
    try {
      await group.kickMember(qq)
    } catch (err) {
      return `failed to kick user ${qq} from group ${groupId}: ${formatToolError(err)}`
    }
    if (isPunish === 'true') {
      return `the user ${qq} has been kicked out from group ${groupId} as punishment because of his 不正当行为`
    }
    return `the user ${qq} has been kicked out from group ${groupId}`
  }

  description = 'Useful when you want to kick someone out of the group. '
}
