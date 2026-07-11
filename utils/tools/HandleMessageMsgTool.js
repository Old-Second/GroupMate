import { AbstractTool } from './AbstractTool.js'
import { formatToolError, isMasterQQ, normalizeBoolean } from './ToolUtils.js'

export class HandleMessageMsgTool extends AbstractTool {
  name = 'handleMsg'

  parameters = {
    properties: {
      type: {
        type: 'string',
        enum: ['recall', 'essence', 'un-essence'],
        description: 'what do you want to do with the message'
      },
      messageId: {
        type: 'string',
        description: 'which message to handle. This must be an explicit message id; do not use the current request message unless the user explicitly asked to handle it'
      },
      confirmByOwnerOrMaster: {
        type: 'string',
        enum: ['true', 'false'],
        description: '是否已经由机器人主人、群主或群管理员在当前请求中明确确认处理该消息。没有明确确认必须填false'
      }
    },
    required: ['type', 'messageId', 'confirmByOwnerOrMaster']
  }

  func = async function (opts, e) {
    let { type = 'recall', messageId, sender, confirmByOwnerOrMaster } = opts
    logger.mark(`[chatgpt-plugin] handleMsg request: type=${type}, messageId=${messageId}, currentMessageId=${e.message_id}, currentSeq=${e.seq}, sender=${sender}`)
    if (!e.isGroup) {
      return 'failed, message management is only available in group chat'
    }
    if (!messageId) {
      return 'failed, explicit messageId is required'
    }
    const messageIdText = String(messageId)
    if ([e.message_id, e.seq].filter(Boolean).map(item => String(item)).includes(messageIdText)) {
      return 'failed, refusing to handle the current request message. Reply to a separate target message or provide another explicit messageId.'
    }
    if (!normalizeBoolean(confirmByOwnerOrMaster)) {
      return 'failed, handling group messages requires explicit confirmation from bot master, group owner, or group administrator'
    }
    try {
      const { isMaster } = await isMasterQQ(sender, e)
      const memberMap = await e.group.getMemberMap()
      const requesterRole = memberMap.get(Number(sender))?.role || memberMap.get(String(sender))?.role || e.sender?.role
      if (!isMaster && !['owner', 'admin'].includes(requesterRole)) {
        return 'failed, only bot master, group owner, or group administrator can handle group messages'
      }
      switch (type) {
        case 'recall': {
          await e.group.recallMsg(messageId)
          break
        }
        case 'essence': {
          await e.bot.setEssenceMessage(messageId)
          break
        }
        case 'un-essence': {
          await e.bot.removeEssenceMessage(messageId)
          break
        }
      }
      return 'success!'
    } catch (err) {
      logger.error(err)
      return 'operation failed: ' + formatToolError(err)
    }
  }

  description = '用来在群聊中撤回指定消息或将指定消息设为/取消精华。必须有明确的 messageId 和管理员确认，不能因为用户@机器人就自动撤回当前消息'
}
