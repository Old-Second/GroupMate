import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'
import {
  canSendToTarget,
  fetchImageBuffer,
  formatToolError,
  isCurrentTarget,
  isTargetGroup,
  resolveTarget
} from './ToolUtils.js'

async function buildBase64ImageMessage (url) {
  const image = await fetchImageBuffer(url)
  return segment.image(`base64://${image.buffer.toString('base64')}`)
}

async function sendPictureWithFallback (sendFn, pic) {
  try {
    await sendFn(pic.message)
  } catch (err) {
    try {
      await sendFn(await buildBase64ImageMessage(pic.url))
    } catch (fallbackErr) {
      throw new Error(`${formatToolError(err)}; base64 fallback failed: ${formatToolError(fallbackErr)}`)
    }
  }
}

function formatPictureSendResult (targetLabel, target, pictures, errs) {
  if (errs.length === pictures.length) {
    return `failed to send pictures to ${targetLabel}${target}, errors: ${errs.join('、')}`
  }
  return `picture has been sent to ${targetLabel}${target}` + (errs.length > 0 ? `, but some pictures failed to send (${errs.join('、')})` : '')
}

export class SendPictureTool extends AbstractTool {
  name = 'sendPicture'

  parameters = {
    properties: {
      urlOfPicture: {
        type: 'string',
        description: 'the url of the pictures, not text, split with space if more than one. can be left blank.'
      },
      targetGroupIdOrQQNumber: {
        type: 'string',
        description: 'Fill in the target user\'s qq number or groupId when you need to send picture to specific user or group, otherwise leave blank'
      }
    },
    required: ['urlOfPicture']
  }

  func = async function (opt, e) {
    let { urlOfPicture, targetGroupIdOrQQNumber, sender } = opt
    if (typeof urlOfPicture === 'object') {
      urlOfPicture = urlOfPicture.join(' ')
    }
    const target = resolveTarget(e, targetGroupIdOrQQNumber)
    const permission = await canSendToTarget(e, target, sender)
    if (!permission.allowed) {
      return permission.reason
    }
    // 处理错误url和picture留空的情况
    const urlRegex = /(?:(?:https?|ftp):\/\/)?(?:\S+(?::\S*)?@)?(?:((?:(?:[a-z0-9\u00a1-\u4dff\u9fd0-\uffff][a-z0-9\u00a1-\u4dff\u9fd0-\uffff_-]{0,62})?[a-z0-9\u00a1-\u4dff\u9fd0-\uffff]\.)+(?:[a-z\u00a1-\u4dff\u9fd0-\uffff]{2,}\.?))(?::\d{2,5})?)(?:\/[\w\u00a1-\u4dff\u9fd0-\uffff$-_.+!*'(),%]+)*(?:\?(?:[\w\u00a1-\u4dff\u9fd0-\uffff$-_.+!*(),%:@&=]|(?:[\[\]])|(?:[\u00a1-\u4dff\u9fd0-\uffff]))*)?(?:#(?:[\w\u00a1-\u4dff\u9fd0-\uffff$-_.+!*'(),;:@&=]|(?:[\[\]]))*)?\/?/i
    if (/https:\/\/example.com/.test(urlOfPicture) || !urlOfPicture || !urlRegex.test(urlOfPicture)) urlOfPicture = ''
    if (!urlOfPicture) {
      return 'Because there is no correct URL for the picture ,tell user the reason and ask user if he want to use SearchImageTool'
    }
    let pictures = urlOfPicture.trim().split(/\s+/).filter(Boolean)
    logger.mark('pictures to send: ', pictures)
    pictures = pictures.map(img => ({ url: img, message: segment.image(img) }))
    let errs = []
    try {
      if (isCurrentTarget(e, target)) {
        for (let pic of pictures) {
          try {
            await sendPictureWithFallback(msg => e.reply(msg), pic)
          } catch (err) {
            errs.push(`${pic.url}: ${formatToolError(err)}`)
          }
        }
        return formatPictureSendResult('current chat', '', pictures, errs)
      }

      let groupList
      try {
        groupList = await e.bot.getGroupList()
      } catch (err) {
        groupList = e.bot.gl
      }
      if (isTargetGroup(e, groupList, target)) {
        let group = await e.bot.pickGroup(target)
        for (let pic of pictures) {
          try {
            await sendPictureWithFallback(msg => group.sendMsg(msg), pic)
          } catch (err) {
            errs.push(`${pic.url}: ${formatToolError(err)}`)
          }
        }
        // await group.sendMsg(pictures)
        return formatPictureSendResult('group', target, pictures, errs)
      } else {
        if (!Config.enableToolPrivateSend && !permission.isMaster) {
          return 'you are not allowed to pm other group members'
        }
        let user = e.bot.pickUser(target)
        if (e.group_id) {
          user = user.asMember(e.group_id)
        }
        for (let pic of pictures) {
          try {
            await sendPictureWithFallback(msg => user.sendMsg(msg), pic)
          } catch (err) {
            if (!e.isGroup && target + '' === e.sender?.user_id + '') {
              try {
                await sendPictureWithFallback(msg => e.reply(msg), pic)
                continue
              } catch (replyErr) {
                errs.push(`${pic.url}: ${formatToolError(replyErr)}`)
                continue
              }
            }
            errs.push(`${pic.url}: ${formatToolError(err)}`)
          }
        }
        return formatPictureSendResult('user', target, pictures, errs)
      }
    } catch (err) {
      return `failed to send pictures, error: ${formatToolError(err)}`
    }
  }

  description = 'Useful when you want to send one or more pictures.  If no extra description needed, just reply <EMPTY> at the next turn'
}
