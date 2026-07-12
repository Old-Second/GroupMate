export function buildLegacyThinkingForwardMessages (thinking, thinkingSegments) {
  if (Array.isArray(thinkingSegments) && thinkingSegments.length > 0) {
    return thinkingSegments.map(item => String(item || '').trim()).filter(Boolean)
  }
  if (!thinking) {
    return []
  }
  return String(thinking)
    .split(/\n{2,}(?=【(?:模型思考|工具调用)[^】]*】)/)
    .map(item => item.trim())
    .filter(Boolean)
}

export function buildLegacyQuoteForwardMessages (quotes) {
  return quotes
    .filter(item => item.text && item.text.trim() !== '')
    .map(item => `${item.text} - ${item.url}`)
}

export function selectLegacyPresentationMode ({
  useTTS,
  forcePictureMode,
  userPictureMode,
  autoPicture,
  responseLength,
  autoPictureThreshold
}) {
  if (useTTS) return 'tts'
  if (forcePictureMode || userPictureMode || (autoPicture && responseLength > autoPictureThreshold)) {
    return 'picture'
  }
  return 'text'
}

export async function presentLegacyReply ({
  event,
  message,
  quote,
  data,
  markdownEnabled,
  handler,
  logger,
  schedule
}) {
  let payload = message
  if (markdownEnabled) {
    const buttons = await handler.call('chatgpt.button.post', event, data)
    if (buttons) {
      const button = { type: 'button', content: buttons }
      if (Array.isArray(payload)) payload.push(button)
      else payload = [payload, button]
    }
  }

  const recallSeconds = Number(data?.recallMsg) || 0
  const result = await event.reply(payload, quote, { ...data, recallMsg: 0 })
  if (recallSeconds > 0 && result?.message_id) {
    schedule(() => {
      const target = event.group?.recallMsg ? event.group : event.friend
      if (target?.recallMsg) {
        target.recallMsg(result.message_id).catch(error => logger.warn('撤回机器人消息失败', error))
      }
    }, recallSeconds * 1000)
  }
  return result
}
