import { createHash, randomBytes } from 'node:crypto'
import type { ToolRuntimeFacts } from '../../agent/tools/tool-context.js'
import { parseDateTime, validateTimeZone } from '../../tools/local-date-time.js'
import { ACTIVITY_LIMITS, activeActivity, ActivityStore, pruneActivities, type GroupActivity } from './ActivityStore.js'

export interface ActivityRecipientLookup {
  members(signal: AbortSignal): Promise<ReadonlyMap<string, { readonly nickname?: string; readonly card?: string }>>
  current(userId: string, signal: AbortSignal): Promise<Readonly<{ joinedAt: number }> | null>
}

async function notificationRecipients (input: unknown, facts: ToolRuntimeFacts, lookup: ActivityRecipientLookup | undefined,
  now: number, signal: AbortSignal): Promise<string[]> {
  if (input === undefined) return [] // Legacy callers and records remain text-only.
  if (!Array.isArray(input) || input.length > ACTIVITY_LIMITS.recipients ||
    input.some(value => typeof value !== 'string' || value.trim() === '' || value.length > 100)) throw new TypeError('通知对象须为最多 8 位当前群成员，不支持全体艾特。')
  if (input.length === 0) return []
  if (lookup === undefined) throw new TypeError('无法核验通知对象，请稍后重试。')
  let members: Awaited<ReturnType<ActivityRecipientLookup['members']>> | undefined
  const ids: string[] = []
  for (const raw of input) {
    const target = (raw as string).trim()
    let id: string
    if (target === 'self') id = facts.actor.userId
    else if (/^[1-9][0-9]{0,19}$/.test(target)) id = target
    else {
      if (/^(?:all|全体|全体成员|所有人|everyone)$/i.test(target)) throw new TypeError('定时提醒不支持全体艾特。')
      members ??= await lookup.members(signal)
      const matches = [...members].filter(([, member]) => member.card === target || member.nickname === target)
      if (matches.length !== 1) throw new TypeError('通知对象未找到或存在同名成员，请在当前消息中直接艾特对方或提供 QQ 号。')
      id = matches[0][0]
    }
    if (!/^[1-9][0-9]{0,19}$/.test(id) || id === facts.botId) throw new TypeError('通知对象须为当前群成员，不能是机器人自己。')
    if (ids.includes(id)) continue
    const member = await lookup.current(id, signal)
    if (member === null || member.joinedAt === 0 || member.joinedAt * 1000 > now) throw new TypeError('通知对象的当前群成员身份无法核实，请稍后重试。')
    ids.push(id)
  }
  return ids.sort()
}

function hash (text: string): string { return createHash('sha256').update(text).digest('hex') }
function message (value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TypeError(`内容须非空且不超过 ${max} 字。`)
  return value.trim()
}
function integer (value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`数值须为 ${min}～${max} 的整数。`)
  return value
}
function counts (r: GroupActivity): number[] { return r.options.map((_, index) => Object.values(r.votes).filter(votes => votes.includes(index + 1)).length) }
export function activitySummary (r: GroupActivity, now: number): Record<string, unknown> {
  return { id: r.id, kind: r.kind, state: r.state, content: r.content, dueAt: new Date(r.dueAt).toISOString(), timeZone: r.timeZone,
    secondsLeft: activeActivity(r) ? Math.max(0, Math.ceil((r.dueAt - now) / 1000)) : 0,
    remaining: activeActivity(r) ? r.remaining : 0, intervalSeconds: r.intervalMs / 1000,
    ...(r.kind === 'reminder' ? { notifyUserIds: r.notifyUserIds ?? [] } : {}),
    ...(r.kind === 'poll' ? { multiple: r.multiple, options: r.options.map((text, index) => ({ number: index + 1, text, votes: counts(r)[index] })), voters: Object.keys(r.votes).length } : {}) }
}
export function activityNotification (r: GroupActivity): string {
  if (r.kind === 'reminder') return `⏰ ${r.intervalMs > 0 ? '重复提醒' : '定时提醒'}\n\n${r.content}\n\n任务编号：${r.id}`
  const totals = counts(r)
  return `📊 投票结果\n\n${r.content}\n\n${r.options.map((text, index) => `${index + 1}. ${text}：${totals[index]} 票`).join('\n')}\n\n参与 ${Object.keys(r.votes).length} 人 · ${r.multiple ? '多选' : '单选'}\n投票编号：${r.id}`
}

export class GroupActivityService {
  constructor (readonly store: ActivityStore, readonly now: () => number = Date.now) {}

  async perform (kind: GroupActivity['kind'], input: Readonly<Record<string, unknown>>, facts: ToolRuntimeFacts,
    requestId: string, signal: AbortSignal, recipientLookup?: ActivityRecipientLookup): Promise<unknown> {
    if (facts.channel.kind !== 'group' || facts.actorGroupRole === 'none' || facts.botGroupRole === 'none') throw new TypeError('仅当前群的现有成员可用。')
    const groupId = facts.channel.groupId
    const moderator = facts.actor.isBotMaster || ['admin', 'owner'].includes(facts.actorGroupRole)
    const now = this.now()
    const operation = input.operation
    const notifyUserIds = kind === 'reminder' && operation === 'create'
      ? await notificationRecipients(input.notifyTargets, facts, recipientLookup, now, signal) : []
    const scoped = (r: GroupActivity): boolean => r.kind === kind && r.botId === facts.botId && r.groupId === groupId
    const creationInput = kind === 'reminder'
      ? [input.text, input.at, input.timeZone, input.delaySeconds, input.intervalSeconds, input.occurrences,
          ...(notifyUserIds.length > 0 ? [notifyUserIds] : [])]
      : [input.title, input.options, input.closesAt, input.timeZone, input.multiple]
    const requestKey = hash(JSON.stringify([facts.botId, groupId, facts.actor.userId, requestId, kind, creationInput]))
    const id = randomBytes(8).toString('hex')
    return await this.store.update(data => {
      pruneActivities(data, now)
      if (operation === 'list') {
        const offset = integer(input.offset ?? 0, 0, ACTIVITY_LIMITS.records)
        const records = data.records.filter(r => scoped(r) && (kind === 'poll' || moderator || r.ownerId === facts.actor.userId))
          .sort((a, b) => Number(activeActivity(b)) - Number(activeActivity(a)) || b.createdAt - a.createdAt)
        return { activities: records.slice(offset, offset + 4).map(r => activitySummary(r, now)), total: records.length,
          nextOffset: offset + 4 < records.length ? offset + 4 : null }
      }
      if (operation === 'create') {
        const existing = data.records.find(r => r.requestKey === requestKey)
        if (existing !== undefined) return activitySummary(existing, now)
        const ownGroup = data.records.filter(r => activeActivity(r) && r.botId === facts.botId && r.groupId === groupId)
        if (data.records.length >= ACTIVITY_LIMITS.records || ownGroup.length >= ACTIVITY_LIMITS.perGroup ||
          ownGroup.filter(r => r.ownerId === facts.actor.userId).length >= ACTIVITY_LIMITS.perActor ||
          (kind === 'poll' && ownGroup.filter(r => r.kind === 'poll').length >= ACTIVITY_LIMITS.pollsPerGroup)) throw new TypeError('任务或投票容量已满，请先取消旧任务。')
        const zone = validateTimeZone(input.timeZone)
        let dueAt: number
        let content: string
        let intervalMs = 0
        let remaining = 1
        let options: string[] = []
        let multiple = false
        if (kind === 'reminder') {
          content = message(input.text, 500)
          const delay = integer(input.delaySeconds, 0, 90 * 86400)
          if ((typeof input.at !== 'string') || (input.at === '' ? delay === 0 : delay !== 0)) throw new TypeError('请只提供 at 具体时间或 delaySeconds 倒计时中的一个。')
          dueAt = input.at === '' ? now + delay * 1000 : parseDateTime(input.at, zone)
          remaining = integer(input.occurrences, 1, 30)
          const seconds = integer(input.intervalSeconds, 0, 30 * 86400)
          if ((remaining > 1 && seconds < 60) || (remaining === 1 && seconds !== 0)) throw new TypeError('重复提醒间隔至少 60 秒；一次提醒 intervalSeconds=0、occurrences=1。')
          intervalMs = seconds * 1000
        } else {
          content = message(input.title, 200)
          if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 10) throw new TypeError('投票须有 2～10 个选项。')
          options = input.options.map(value => message(value, 80))
          if (new Set(options).size !== options.length || typeof input.multiple !== 'boolean') throw new TypeError('投票选项不能重复，须明确单选或多选。')
          multiple = input.multiple
          // No deadline means manual closure within the bounded 90-day retention horizon.
          dueAt = input.closesAt === '' ? now + ACTIVITY_LIMITS.horizonMs : parseDateTime(input.closesAt, zone)
        }
        if (dueAt <= now || dueAt + intervalMs * (remaining - 1) > now + ACTIVITY_LIMITS.horizonMs) throw new TypeError('截止时间须在未来，全部次数须在 90 天以内。')
        const r: GroupActivity = { schemaVersion: 1, id, kind, botId: facts.botId, groupId, ownerId: facts.actor.userId,
          requestKey, createdAt: now, updatedAt: now, dueAt, state: 'pending', token: '', leaseUntil: 0,
          content, timeZone: zone, intervalMs, remaining, options, multiple, votes: {},
          ...(kind === 'reminder' ? { notifyUserIds } : {}) }
        data.records.push(r)
        return activitySummary(r, now)
      }
      const r = data.records.find(r => scoped(r) && r.id === input.id)
      if (r === undefined || (kind === 'reminder' && !moderator && r.ownerId !== facts.actor.userId)) throw new TypeError('当前群没有可访问的该任务或投票。')
      if (operation === 'status') return activitySummary(r, now)
      if (operation === 'cancel' || operation === 'close') {
        if (!moderator && r.ownerId !== facts.actor.userId) throw new TypeError('仅发起人或当前管理员可以取消或结算。')
        if (operation === 'close' && kind !== 'poll') throw new TypeError('仅投票支持提前结算。')
        if (r.state === 'dispatching') {
          if (operation === 'close') throw new TypeError('投票已经进入结算发送。')
          r.remaining = 0
          r.updatedAt = now
          return { ...activitySummary(r, now), notice: '本次已进入发送，不能撤回；后续次数已取消。' }
        }
        if (!activeActivity(r)) return activitySummary(r, now)
        r.state = operation === 'cancel' ? 'cancelled' : 'pending'
        if (operation === 'close') r.dueAt = now
        else r.remaining = 0
        r.token = ''
        r.leaseUntil = 0
        r.updatedAt = now
        return activitySummary(r, now)
      }
      if (kind === 'poll' && (operation === 'vote' || operation === 'retract')) {
        if (r.state !== 'pending' || r.dueAt <= now) throw new TypeError('投票已截止或取消，不能再改票。')
        const voter = hash(JSON.stringify([facts.botId, groupId, facts.actor.userId]))
        if (operation === 'retract') delete r.votes[voter]
        else {
          if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > (r.multiple ? r.options.length : 1)) throw new TypeError('请选择有效选项；单选只接受一个选项。')
          const choices = input.choices.map(value => integer(value, 1, r.options.length))
          if (new Set(choices).size !== choices.length) throw new TypeError('选项编号不能重复。')
          if (!Object.hasOwn(r.votes, voter) && Object.keys(r.votes).length >= ACTIVITY_LIMITS.voters) throw new TypeError('投票人数已达 100 人上限。')
          r.votes[voter] = choices
        }
        r.updatedAt = now
        return activitySummary(r, now)
      }
      throw new TypeError('操作无效。')
    }, signal)
  }
}
