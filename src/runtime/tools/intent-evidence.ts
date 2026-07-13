export type IntentAction =
  | 'send'
  | 'mute'
  | 'unmute'
  | 'kick'
  | 'edit_card'
  | 'set_title'
  | 'recall'
  | 'set_essence'
  | 'unset_essence'
  | 'image'
  | 'video'
  | 'audio'
  | 'music'
  | 'dice'
  | 'rps'

export interface IntentEvidence {
  readonly trustedSources: readonly ['current_request']
  readonly actions: readonly IntentAction[]
  readonly mentionUserIds: readonly string[]
  readonly explicitTargetIds: readonly string[]
  readonly replyMessageId: string | null
  readonly currentMessageId: string | null
}

export interface IntentEvidenceInput {
  readonly text: string
  readonly mentions: readonly (string | number | { readonly userId: string | number })[]
  readonly reply: { readonly messageId: string | number } | null
  readonly currentMessageId?: string | number
}

const actionRules: readonly [IntentAction, RegExp][] = [
  ['unmute', /解除.{0,6}禁言|取消.{0,6}禁言|解禁|\bunmute\b/i],
  ['mute', /禁言|闭嘴|\bmute\b|\bban\b/i],
  ['send', /发送|转发|发给|\bsend\b|\bforward\b/i],
  ['kick', /踢出|踢走|移出群|\bkick\b/i],
  ['edit_card', /(?:修改|更改|设置|改).{0,8}(?:群名片|名片)/],
  ['set_title', /头衔|专属头衔/],
  ['unset_essence', /取消.{0,4}精华|移除.{0,4}精华/],
  ['set_essence', /设为.{0,4}精华|设置.{0,4}精华|加精/],
  ['recall', /撤回|\brecall\b|delete message/i],
  ['image', /(?:发|发送|生成|画|处理|看看).{0,12}(?:图片|图像|照片|头像)/],
  ['video', /(?:发|发送|播放|找).{0,12}(?:视频|短片)/],
  ['audio', /语音|朗读|\baudio\b|\bvoice\b/i],
  ['music', /音乐|歌曲|唱一首|播放一首/],
  ['dice', /骰子|掷骰|摇骰/],
  ['rps', /猜拳|石头剪刀布/]
]

const negatedActionRules: Partial<Readonly<Record<IntentAction, RegExp>>> = Object.freeze({
  send: /(?:不要|别|禁止|不许|无需).{0,6}(?:发送|转发|发给)|\b(?:do not|don't)\s+(?:send|forward)\b/i,
  mute: /(?:不要|别|禁止|不许).{0,6}(?:禁言|闭嘴)|\b(?:do not|don't)\s+(?:mute|ban)\b/i,
  kick: /(?:不要|别|禁止|不许).{0,6}(?:踢出|踢走|移出群)|\b(?:do not|don't)\s+kick\b/i,
  recall: /(?:不要|别|禁止|不许).{0,6}撤回|\b(?:do not|don't)\s+(?:recall|delete)\b/i
})

function identifier (value: string | number, label: string): string {
  const result = typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
    : value
  if (result.length === 0 || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError(`${label} is invalid`)
  }
  return result
}

function mentionId (mention: IntentEvidenceInput['mentions'][number]): string {
  if (typeof mention === 'object') return identifier(mention.userId, 'mention user ID')
  return identifier(mention, 'mention user ID')
}

export function extractIntentEvidence (input: IntentEvidenceInput): IntentEvidence {
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > 32 * 1024 || !Array.isArray(input.mentions)) {
    throw new TypeError('intent evidence input is invalid')
  }
  const actions = actionRules
    .filter(([action, pattern]) => pattern.test(input.text) &&
      !(action === 'mute' && /解除.{0,6}禁言|取消.{0,6}禁言|解禁|\bunmute\b/i.test(input.text)) &&
      !(negatedActionRules[action]?.test(input.text) ?? false))
    .map(([action]) => action)
  const mentionUserIds = [...new Set(input.mentions.map(mentionId))].slice(0, 32)
  const explicitTargetIds: string[] = []
  const pattern = /(?:群|QQ|用户|好友|消息)\s*[:：#]?\s*([A-Za-z0-9_-]{1,128})/gi
  for (const match of input.text.matchAll(pattern)) {
    if (match[1] !== undefined && !explicitTargetIds.includes(match[1])) explicitTargetIds.push(match[1])
    if (explicitTargetIds.length === 32) break
  }
  return Object.freeze({
    trustedSources: Object.freeze(['current_request'] as const),
    actions: Object.freeze(actions),
    mentionUserIds: Object.freeze(mentionUserIds),
    explicitTargetIds: Object.freeze(explicitTargetIds),
    replyMessageId: input.reply === null ? null : identifier(input.reply.messageId, 'reply message ID'),
    currentMessageId: input.currentMessageId === undefined ? null : identifier(input.currentMessageId, 'current message ID')
  })
}
