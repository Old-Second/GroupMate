import type { YunzaiAgentRequestDraft, YunzaiRequestEvent } from './yunzai-request-adapter.js'
import type { PreparedYunzaiMessageEvidenceV1 } from './message-input.js'
import {
  createSceneParticipantV1
} from '../agent/memory/scene-participant.js'
import { MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2 } from '../agent/memory/memory-retrieval.js'
import type {
  PersonalMemoryParticipantDirectoryV1,
  PersonalMemoryParticipantSnapshotV1,
  PersonalMemoryRecallSourceV1
} from '../agent/memory/personal-memory-recall.js'

type YunzaiRecord = Record<string, any>

export interface YunzaiSceneParticipantDirectoryInputV1 {
  readonly event: YunzaiRequestEvent
  readonly messageEvidence: PreparedYunzaiMessageEvidenceV1
  readonly accountId: string
  readonly observedAt: string
  readonly strictTargetUserIds?: readonly string[]
}

export interface YunzaiPersonalMemoryRecallInputV1 {
  readonly request: YunzaiAgentRequestDraft
  readonly event: YunzaiRequestEvent
  readonly messageEvidence: PreparedYunzaiMessageEvidenceV1
  readonly queryText: string
  readonly strictTargetUserIds?: readonly string[]
}

export interface YunzaiPersonalMemoryRecallSourceV1 {
  recall(input: YunzaiPersonalMemoryRecallInputV1, signal?: AbortSignal): Promise<unknown>
}

function abortError (): DOMException {
  return new DOMException('operation was aborted', 'AbortError')
}

function throwIfAborted (signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function qqId (value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null
  }
  const normalized = String(value).trim()
  return /^\d{1,32}$/.test(normalized) ? normalized : null
}

function hostIdentifier (value: string): string | number {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? numeric : value
}

function text (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').trim()
  return normalized === '' ? null : [...normalized].slice(0, 256).join('')
}

function groupRole (value: unknown): 'owner' | 'admin' | 'member' | 'unknown' {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : 'unknown'
}

function unwrapMemberInfo (value: unknown, expectedUserId: string): YunzaiRecord | null {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null
    const record = current as YunzaiRecord
    const userId = qqId(record.user_id ?? record.userId ?? record.qq)
    if (userId !== null) return userId === expectedUserId ? record : null
    current = record.data ?? record.result
  }
  return null
}

async function invokePickMember (
  group: YunzaiRecord,
  userId: string,
  signal: AbortSignal
): Promise<unknown> {
  if (typeof group.pickMember !== 'function') return null
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(abortError())
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const returned = Reflect.apply(group.pickMember, group, [
        hostIdentifier(userId),
        true,
        finish
      ])
      if (returned !== undefined && returned !== null) {
        if (typeof returned === 'object' &&
          typeof (returned as { then?: unknown }).then === 'function') {
          void Promise.resolve(returned).then(finish, fail)
        } else {
          finish(returned)
        }
      }
    } catch (error) {
      fail(error)
    }
  })
}

async function refreshMember (
  event: YunzaiRecord,
  groupId: string,
  userId: string,
  signal: AbortSignal
): Promise<YunzaiRecord | null> {
  throwIfAborted(signal)
  const bot = event.bot as YunzaiRecord | undefined
  if (typeof bot?.sendApi === 'function') {
    try {
      const raw = await Reflect.apply(bot.sendApi, bot, [
        'get_group_member_info',
        Object.freeze({
          group_id: hostIdentifier(groupId),
          user_id: hostIdentifier(userId),
          no_cache: true
        })
      ])
      throwIfAborted(signal)
      const member = unwrapMemberInfo(raw, userId)
      if (member !== null) return member
    } catch (error) {
      if (signal.aborted) throw abortError()
    }
  }
  if (typeof bot?.getGroupMemberInfo === 'function') {
    try {
      const raw = await Reflect.apply(bot.getGroupMemberInfo, bot, [
        hostIdentifier(groupId),
        hostIdentifier(userId),
        true
      ])
      throwIfAborted(signal)
      const member = unwrapMemberInfo(raw, userId)
      if (member !== null) return member
    } catch (error) {
      if (signal.aborted) throw abortError()
    }
  }
  if (typeof bot?.pickMember === 'function') {
    try {
      let raw = await Reflect.apply(bot.pickMember, bot, [
        hostIdentifier(groupId),
        hostIdentifier(userId)
      ])
      if (raw !== null && typeof raw === 'object' &&
        typeof (raw as YunzaiRecord).getInfo === 'function') {
        raw = await Reflect.apply((raw as YunzaiRecord).getInfo, raw, [true])
      }
      throwIfAborted(signal)
      const member = unwrapMemberInfo(raw, userId)
      if (member !== null) return member
    } catch (error) {
      if (signal.aborted) throw abortError()
    }
  }
  try {
    const group = event.group !== undefined
      ? event.group
      : typeof bot?.pickGroup === 'function'
        ? await Reflect.apply(bot.pickGroup, bot, [hostIdentifier(groupId)])
        : null
    const raw = group === null || typeof group !== 'object'
      ? null
      : await invokePickMember(group, userId, signal)
    throwIfAborted(signal)
    return unwrapMemberInfo(raw, userId)
  } catch (error) {
    if (signal.aborted) throw abortError()
    return null
  }
}

function mentionedUserIds (event: YunzaiRecord, accountId: string): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const visited = new Set<object>()
  const queue: unknown[] = [event.message]
  let nodes = 0
  while (queue.length > 0 && nodes < 64 && result.length < 8) {
    const value = queue.shift()
    nodes += 1
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 32))
      continue
    }
    if (value === null || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    const record = value as YunzaiRecord
    const data = record.data !== null && typeof record.data === 'object'
      ? record.data as YunzaiRecord
      : {}
    if (record.type === 'at' || data.type === 'at') {
      const userId = qqId(data.qq ?? data.user_id ?? record.qq ?? record.user_id)
      if (userId !== null && userId !== accountId && !seen.has(userId)) {
        seen.add(userId)
        result.push(userId)
      }
    }
    if (record.message !== undefined) queue.push(record.message)
    if (record.data !== undefined && record.data !== data) queue.push(record.data)
  }
  return Object.freeze(result)
}

function groupLifecycleId (groupId: string, member: YunzaiRecord): string | null {
  const raw = member.join_time ?? member.joinTime
  const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
    ? `qq-group-${groupId}-bot-joined-${seconds}`
    : null
}

function identityInput (member: YunzaiRecord, userId: string, evidence: 'current_event' | 'member_refresh') {
  return Object.freeze({
    userId,
    nickname: text(member.nickname),
    groupCard: text(member.card),
    groupTitle: text(member.title ?? member.special_title ?? member.group_title),
    groupRole: groupRole(member.role),
    roleEvidence: evidence
  })
}

export function createYunzaiSceneParticipantDirectoryV1 (): PersonalMemoryParticipantDirectoryV1<
YunzaiSceneParticipantDirectoryInputV1
> {
  return Object.freeze({
    async resolve (
      input: YunzaiSceneParticipantDirectoryInputV1,
      signal: AbortSignal
    ) {
      throwIfAborted(signal)
      const event = input.event as YunzaiRecord
      const accountId = qqId(input.accountId)
      const currentUserId = qqId(event.sender?.user_id ?? event.user_id)
      if (accountId === null || currentUserId === null) return null
      if (event.isGroup !== true && event.isGroup !== false) return null
      if (event.isGroup === false) {
        const current = createSceneParticipantV1(Object.freeze({
          identity: Object.freeze({
            userId: currentUserId,
            nickname: text(event.sender?.nickname),
            groupCard: null,
            groupTitle: null,
            groupRole: 'unknown',
            roleEvidence: 'unknown'
          }),
          scene: Object.freeze({ kind: 'private' as const }),
          membership: Object.freeze({
            state: 'verified_present' as const,
            source: 'current_event' as const,
            observedAt: input.observedAt
          })
        }))
        return Object.freeze({
          scene: current.scene,
          current,
          references: Object.freeze([])
        })
      }

      const groupId = qqId(event.group_id)
      if (groupId === null) return null
      const botMember = await refreshMember(event, groupId, accountId, signal)
      if (botMember === null) return null
      const lifecycle = groupLifecycleId(groupId, botMember)
      if (lifecycle === null) return null
      const scene = Object.freeze({
        kind: 'group' as const,
        groupId,
        groupLifecycleId: lifecycle,
        groupName: text(event.group?.name ?? event.group_name)
      })
      const current = createSceneParticipantV1(Object.freeze({
        identity: identityInput(event.sender ?? {}, currentUserId, 'current_event'),
        scene,
        membership: Object.freeze({
          state: 'verified_present' as const,
          source: 'current_event' as const,
          observedAt: input.observedAt
        })
      }))

      const candidates: Array<Readonly<{
        userId: string
        reason: 'quoted_actor' | 'mentioned_actor' | 'explicit_target'
      }>> = []
      const quotedId = qqId(input.messageEvidence.quotedMessage?.sender.userId)
      if (quotedId !== null && quotedId !== currentUserId) {
        candidates.push(Object.freeze({ userId: quotedId, reason: 'quoted_actor' as const }))
      }
      for (const userId of mentionedUserIds(event, accountId)) {
        if (userId !== currentUserId) {
          candidates.push(Object.freeze({ userId, reason: 'mentioned_actor' as const }))
        }
      }
      let strictTargetCount = 0
      for (const value of input.strictTargetUserIds ?? []) {
        if (strictTargetCount >= MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects) break
        strictTargetCount += 1
        const userId = qqId(value)
        if (userId !== null && userId !== currentUserId) {
          candidates.push(Object.freeze({ userId, reason: 'explicit_target' as const }))
        }
      }

      const references: PersonalMemoryParticipantSnapshotV1['references'][number][] = []
      const seen = new Set<string>()
      for (const candidate of candidates) {
        if (seen.has(candidate.userId)) continue
        if (references.length >= MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects - 1) break
        seen.add(candidate.userId)
        const member = await refreshMember(event, groupId, candidate.userId, signal)
        throwIfAborted(signal)
        if (member === null) continue
        const participant = createSceneParticipantV1(Object.freeze({
          identity: identityInput(member, candidate.userId, 'member_refresh'),
          scene,
          membership: Object.freeze({
            state: 'verified_present' as const,
            source: 'member_refresh' as const,
            observedAt: input.observedAt
          })
        }))
        references.push(Object.freeze({ reason: candidate.reason, participant }))
      }
      return Object.freeze({ scene, current, references: Object.freeze(references) })
    }
  })
}

export function bindYunzaiPersonalMemoryRecallSourceV1 (input: {
  readonly botInstanceId: string
  readonly source: PersonalMemoryRecallSourceV1<YunzaiSceneParticipantDirectoryInputV1>
}): YunzaiPersonalMemoryRecallSourceV1 {
  return Object.freeze({
    async recall (value: YunzaiPersonalMemoryRecallInputV1, signal?: AbortSignal) {
      return await input.source.recall(Object.freeze({
        botInstanceId: input.botInstanceId,
        accountId: value.request.sessionAddress.botId,
        participantInput: Object.freeze({
          event: value.event,
          messageEvidence: value.messageEvidence,
          accountId: value.request.sessionAddress.botId,
          observedAt: value.request.createdAt,
          ...(value.strictTargetUserIds === undefined
            ? {}
            : { strictTargetUserIds: value.strictTargetUserIds })
        }),
        query: Object.freeze({ text: value.queryText, languageHint: null })
      }), signal)
    }
  })
}
