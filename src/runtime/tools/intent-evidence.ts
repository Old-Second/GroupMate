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
  | 'game'
  | 'poll_create'
  | 'poll_vote'
  | 'poll_retract'
  | 'poll_close'
  | 'poll_cancel'
  | 'schedule_create'
  | 'schedule_cancel'

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
  ['poll_create', /(?:发起|创建|组织|开|来个|设置).{0,12}投票|\b(?:create|start)\s+(?:a\s+)?poll\b/i],
  ['poll_vote', /(?:我选|改票.{0,8}(?:选|为)|投票.{0,48}(?:选|投|支持))\s*\d|\bvote\s+(?:for\s+)?\d/i],
  ['poll_retract', /撤票|撤(?:回|销).{0,80}(?:我的票|的票)|取消我的.{0,48}票|退出.{0,12}投票/],
  ['poll_close', /(?:提前结束|提前结算|结束|关闭|结算).{0,24}投票|投票.{0,32}(?:提前结束|提前结算|现在结束|现在结算)/],
  ['poll_cancel', /(?:取消|撤销).{0,24}投票|投票.{0,32}(?:取消|撤销)/],
  ['schedule_create', /(?:[0-9一二三四五六七八九十两半]+\s*(?:秒|分钟|小时|天)后|今天|明天|每天).{0,32}(?:提醒|通知)|(?:创建|设置|新建).{0,8}(?:提醒|倒计时|定时任务)|提醒我|\bremind\s+me\b|\bcreate\s+(?:a\s+)?(?:reminder|schedule)\b/i],
  ['schedule_cancel', /(?:取消|删除|撤销|停止|关闭).{0,24}(?:定时任务|提醒|倒计时)|(?:定时任务|提醒|倒计时).{0,32}(?:取消|删除|撤销|停止|关闭)/],
  ['unmute', /解除.{0,6}禁言|取消.{0,6}禁言|解禁|\bunmute\b/i],
  ['mute', /禁言|闭嘴|\bmute\b|\bban\b/i],
  ['send', /发送|转发|发给|\bsend\b|\bforward\b/i],
  ['kick', /踢出|踢走|移出群|\bkick\b/i],
  ['edit_card', /(?:修改|更改|设置|改).{0,8}(?:群名片|名片)/],
  ['set_title', /头衔|专属头衔/],
  ['unset_essence', /取消.{0,4}精华|移除.{0,4}精华/],
  ['set_essence', /设为.{0,4}精华|设置.{0,4}精华|加精/],
  ['recall', /撤回|\brecall\b|delete message/i],
  ['image', /(?:发|发送|生成|处理|看看|看一下|看下|来|找|搜).{0,12}(?:图|图片|图像|照片|头像|壁纸|表情包)|(?:图|照片|头像|壁纸|表情包).{0,12}(?:发给|发到|发送到|发来|给我看看)|画(?!蛇添足)|绘制/],
  ['video', /(?:发|发送|分享|播放|找|搜).{0,12}(?:视频|短片)|(?:视频|短片).{0,20}(?:发给|发到|发送到|发来|分享给|分享到)/],
  ['audio', /语音|朗读|\baudio\b|\bvoice\b/i],
  ['music', /音乐|歌曲|唱一首|播放一首/],
  ['dice', /骰子|掷骰|摇骰/],
  ['rps', /猜拳|石头[、，,\s]*剪刀[、，,\s]*布/],
  ['game', /原神|崩坏.{0,4}星穹铁道|星穹铁道|星铁|游戏.{0,4}(?:面板|资料)|角色面板/]
]

const negatedActionRules: Partial<Readonly<Record<IntentAction, RegExp>>> = Object.freeze({
  poll_create: /(?:不要|别|禁止|不许|无需).{0,6}(?:创建|发起|组织|开).{0,6}投票/,
  poll_vote: /(?:不要|别|禁止|不许).{0,8}(?:投票|改票|选)/,
  schedule_create: /(?:不要|别|禁止|不许|无需).{0,8}(?:创建|设置|新建|提醒|通知|倒计时)/,
  send: /(?:不要|别|禁止|不许|无需).{0,6}(?:发送|转发|发给)|\b(?:do not|don't)\s+(?:send|forward)\b/i,
  mute: /(?:不要|别|禁止|不许).{0,6}(?:禁言|闭嘴)|\b(?:do not|don't)\s+(?:mute|ban)\b/i,
  kick: /(?:不要|别|禁止|不许).{0,6}(?:踢出|踢走|移出群)|\b(?:do not|don't)\s+kick\b/i,
  recall: /(?:不要|别|禁止|不许).{0,6}撤回|\b(?:do not|don't)\s+(?:recall|delete)\b/i,
  image: /(?:不要|别|禁止|不许|无需).{0,6}(?:画|绘制|生成|发送|发|来|找|搜|看).{0,12}(?:图|图片|图像|照片|头像|壁纸|表情包)?/,
  video: /(?:不要|别|禁止|不许|无需).{0,6}(?:发|发送|分享|播放|找|搜).{0,12}(?:视频|短片)/,
  audio: /(?:不要|别|禁止|不许|无需).{0,6}(?:发|发送|生成|用|语音|朗读)/,
  music: /(?:不要|别|禁止|不许|无需).{0,6}(?:发|发送|分享|播放|唱).{0,12}(?:音乐|歌曲|一首)/,
  dice: /(?:不要|别|禁止|不许|无需).{0,6}(?:掷|摇|扔|发|发送).{0,6}(?:骰子|骰)/,
  rps: /(?:不要|别|禁止|不许|无需).{0,6}(?:玩|发|发送|猜拳|石头)/
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
