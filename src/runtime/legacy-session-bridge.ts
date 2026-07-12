import { randomUUID } from 'node:crypto'
import { AgentError } from '../agent/contracts/error.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import { resolveConversationScope } from '../agent/session/conversation-scope.js'
import {
  legacySessionCodec,
  type LegacyConversationState
} from '../agent/session/legacy-session-codec.js'
import {
  RedisSessionStore,
  type RedisSessionClient
} from '../agent/session/redis-session-store.js'
import type { SessionRecord, SessionSummary } from '../agent/session/session-record.js'

export interface LegacySessionEvent {
  readonly isGroup: boolean
  readonly group_id?: string | number
  readonly user_id?: string | number
  readonly self_id?: string | number
  readonly bot?: { readonly uin?: string | number }
  readonly sender?: {
    readonly user_id?: string | number
    readonly nickname?: string
  }
  readonly message?: readonly Record<string, unknown>[]
}

export interface LegacyConversationSnapshot {
  readonly sessionId: string
  sender: { user_id: string; nickname?: string }
  ctime: string
  utime: string
  num: number
  messages: Record<string, unknown>[]
  conversation: { conversationId?: string }
  parentMessageId?: string
}

export interface LoadOrCreateInput {
  readonly event: LegacySessionEvent
  readonly groupMerge: boolean
  readonly initialMessages: readonly Record<string, unknown>[]
}

export interface SaveLegacyConversationInput {
  readonly event: LegacySessionEvent
  readonly groupMerge: boolean
  readonly snapshot: LegacyConversationSnapshot
  readonly ttlSeconds?: number
}

export interface ForkLegacyConversationInput {
  readonly event: LegacySessionEvent
  readonly groupMerge: boolean
  readonly sourceUserId: string | number
  readonly ttlSeconds?: number
}

export interface LegacySessionBridge {
  resolveAddress(
    event: LegacySessionEvent,
    groupMerge: boolean,
    targetUserId?: string | number
  ): SessionAddress
  loadOrCreate(input: LoadOrCreateInput): Promise<LegacyConversationSnapshot>
  save(input: SaveLegacyConversationInput): Promise<void>
  has(
    event: LegacySessionEvent,
    groupMerge: boolean,
    targetUserId?: string | number
  ): Promise<boolean>
  delete(
    event: LegacySessionEvent,
    groupMerge: boolean,
    targetUserId?: string | number
  ): Promise<boolean>
  list(event: LegacySessionEvent): AsyncIterable<SessionSummary>
  deleteAll(event: LegacySessionEvent): Promise<number>
  fork(input: ForkLegacyConversationInput): Promise<boolean>
}

export interface LegacySessionLogger {
  info(...values: unknown[]): void
}

export interface LegacySessionBridgeOptions {
  readonly redis: RedisSessionClient
  readonly logger?: LegacySessionLogger
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly scanCount?: number
}

function requiredIdentifier (value: string | number | undefined, label: string): string {
  if (value === undefined || String(value).length === 0) {
    throw new AgentError({
      code: 'invalid_session',
      stage: 'session.address',
      retryable: false,
      userMessage: '无法识别当前会话。',
      details: { missing: label }
    })
  }
  return String(value)
}

function cloneMessages (
  messages: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  return messages.map(message => structuredClone(message))
}

function snapshotFromRecord (
  record: SessionRecord<LegacyConversationState>
): LegacyConversationSnapshot {
  return {
    sessionId: record.sessionId,
    sender: {
      user_id: record.startedBy.userId,
      ...(record.startedBy.displayName === undefined
        ? {}
        : { nickname: record.startedBy.displayName })
    },
    ctime: record.createdAt,
    utime: record.updatedAt,
    num: record.turnCount,
    messages: cloneMessages(record.state.messages),
    conversation: record.state.conversationId === undefined
      ? {}
      : { conversationId: record.state.conversationId },
    ...(record.state.parentMessageId === undefined
      ? {}
      : { parentMessageId: record.state.parentMessageId })
  }
}

function normalizeTimestamp (value: unknown, fallback: Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return fallback.toISOString()
}

export function createLegacySessionBridge (
  options: LegacySessionBridgeOptions
): LegacySessionBridge {
  const now = options.now ?? (() => new Date())
  const store = new RedisSessionStore<LegacyConversationState>({
    client: options.redis,
    codec: legacySessionCodec,
    now,
    generateId: options.generateId,
    scanCount: options.scanCount
  })

  const resolveAddress = (
    event: LegacySessionEvent,
    groupMerge: boolean,
    targetUserId?: string | number
  ): SessionAddress => {
    const botId = requiredIdentifier(event.self_id ?? event.bot?.uin, 'botId')
    const userId = requiredIdentifier(
      targetUserId ?? event.sender?.user_id ?? event.user_id,
      'userId'
    )
    return {
      botId,
      scope: resolveConversationScope({
        isGroup: event.isGroup,
        groupId: event.group_id,
        userId,
        groupMerge
      })
    }
  }

  const log = (eventName: string, address: SessionAddress, count: number): void => {
    options.logger?.info('groupmate.session', {
      event: eventName,
      schemaVersion: 1,
      scopeKind: address.scope.kind,
      count
    })
  }

  return {
    resolveAddress,

    async loadOrCreate (input) {
      const address = resolveAddress(input.event, input.groupMerge)
      const record = await store.get(address)
      if (record !== null) {
        log('session.loaded', address, record.turnCount)
        return snapshotFromRecord(record)
      }
      const timestamp = now().toISOString()
      const senderId = requiredIdentifier(
        input.event.sender?.user_id ?? input.event.user_id,
        'userId'
      )
      const snapshot: LegacyConversationSnapshot = {
        sessionId: options.generateId?.() ?? randomUUID(),
        sender: {
          user_id: senderId,
          ...(input.event.sender?.nickname === undefined
            ? {}
            : { nickname: input.event.sender.nickname })
        },
        ctime: timestamp,
        utime: timestamp,
        num: 0,
        messages: cloneMessages(input.initialMessages),
        conversation: {}
      }
      log('session.loaded', address, 0)
      return snapshot
    },

    async save (input) {
      const address = resolveAddress(input.event, input.groupMerge)
      const timestamp = now()
      const state: {
        messages: readonly Record<string, unknown>[]
        conversationId?: string
        parentMessageId?: string
      } = { messages: cloneMessages(input.snapshot.messages) }
      if (input.snapshot.conversation.conversationId !== undefined) {
        state.conversationId = input.snapshot.conversation.conversationId
      }
      if (input.snapshot.parentMessageId !== undefined) {
        state.parentMessageId = input.snapshot.parentMessageId
      }
      await store.save({
        schemaVersion: 1,
        sessionId: input.snapshot.sessionId,
        botId: address.botId,
        scope: address.scope,
        startedBy: {
          userId: input.snapshot.sender.user_id,
          ...(input.snapshot.sender.nickname === undefined
            ? {}
            : { displayName: input.snapshot.sender.nickname })
        },
        createdAt: normalizeTimestamp(input.snapshot.ctime, timestamp),
        updatedAt: normalizeTimestamp(input.snapshot.utime, timestamp),
        turnCount: input.snapshot.num,
        state
      }, { ttlSeconds: input.ttlSeconds })
      log('session.saved', address, input.snapshot.num)
    },

    async has (event, groupMerge, targetUserId) {
      return await store.get(resolveAddress(event, groupMerge, targetUserId)) !== null
    },

    async delete (event, groupMerge, targetUserId) {
      const address = resolveAddress(event, groupMerge, targetUserId)
      const deleted = await store.delete(address)
      log('session.deleted', address, deleted ? 1 : 0)
      return deleted
    },

    async * list (event) {
      const address = resolveAddress(event, false)
      yield * store.list({ botId: address.botId })
    },

    async deleteAll (event) {
      const address = resolveAddress(event, false)
      const deleted = await store.deleteAll({ botId: address.botId })
      log('session.deleted_all', address, deleted)
      return deleted
    },

    async fork (input) {
      const source = resolveAddress(input.event, input.groupMerge, input.sourceUserId)
      const target = resolveAddress(input.event, input.groupMerge)
      const userId = requiredIdentifier(
        input.event.sender?.user_id ?? input.event.user_id,
        'userId'
      )
      try {
        await store.fork(source, target, {
          userId,
          ...(input.event.sender?.nickname === undefined
            ? {}
            : { displayName: input.event.sender.nickname })
        }, { ttlSeconds: input.ttlSeconds })
        log('session.forked', target, 1)
        return true
      } catch (error) {
        if (error instanceof AgentError && error.code === 'invalid_session') return false
        throw error
      }
    }
  }
}
