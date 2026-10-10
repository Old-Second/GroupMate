import { createHash } from 'node:crypto'
import { hostParticipationEvent, type ParticipationEvent } from '../../agent/participation/ParticipationContract.js'
import type { YunzaiMessageEvent } from '../agent-service-bridge.js'

const ref = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
function scalar (value: unknown, signed = false): string | null {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && (signed ? value !== 0 : value > 0)) ? String(value) : null
}

export function projectYunzaiParticipation (input: Readonly<{
  event: YunzaiMessageEvent
  botId: unknown
  now: number
  explicitlyAddressed: boolean
  eligible: boolean
}>): ParticipationEvent | null {
  const event = input.event
  const bot = scalar(input.botId)
  const group = scalar(event.group_id)
  const actor = scalar(event.sender?.user_id ?? event.user_id)
  const message = scalar(event.message_id, true)
  if (bot === null || group === null || actor === null || message === null || event.isGroup !== true || actor === bot) return null
  const msg = typeof event.msg === 'string' ? event.msg : ''
  // Only protocol at segments are direct evidence; text from images/quotes is never inspected.
  const hostAt = Array.isArray(event.message) && event.message.slice(0, 128).some(segment =>
    segment !== null && typeof segment === 'object' && segment.type === 'at' &&
    scalar(segment.qq ?? segment.data?.qq) === bot)
  return hostParticipationEvent({ schemaVersion: 1, scopeRef: ref([bot, 'group', group]), actorRef: ref([bot, actor]),
    messageRef: ref([bot, group, message]), at: input.now, origin: 'current',
    addressed: input.explicitlyAddressed || hostAt,
    acknowledgement: /^(?:好[的吧]?|嗯+|哈+|收到|谢谢|ok)[!！。\s]*$/iu.test(msg.trim().slice(0, 128)) && msg.length <= 128,
    eligible: input.eligible })
}
