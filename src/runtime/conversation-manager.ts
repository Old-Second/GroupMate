import { AgentError } from '../agent/contracts/error.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import { resolveConversationScope } from '../agent/session/conversation-scope.js'
import type { ConversationSessionPort } from './agent-service.js'

export const originalValues = ['api', 'API'] as const

export interface ConversationCommandResult {
  readonly message: string
  readonly quote: boolean
  readonly success: boolean
}

export interface ConversationCommandEvent {
  readonly isGroup: boolean
  readonly group_id?: string | number
  readonly user_id?: string | number
  readonly self_id?: string | number
  readonly bot?: { readonly uin?: string | number }
  readonly sender?: {
    readonly user_id?: string | number
    readonly nickname?: string
    readonly card?: string
  }
  readonly message?: readonly Readonly<Record<string, unknown>>[]
}

interface ConversationCommandInput {
  readonly bridge: ConversationSessionPort
  readonly event: ConversationCommandEvent
}

interface ScopedConversationCommandInput extends ConversationCommandInput {
  readonly groupMerge: boolean
  readonly toggleMode: string
  readonly ttlSeconds?: number
}

interface AtSegment extends Readonly<Record<string, unknown>> {
  readonly type: 'at'
  readonly qq: string | number
  readonly text?: string
}

function identifier (value: unknown, label: string): string {
  const text = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : ''
  if (text.length === 0 || text.length > 128) {
    throw new AgentError({
      code: 'invalid_session',
      stage: 'conversation.command',
      retryable: false,
      userMessage: '无法识别当前会话。',
      details: { missing: label }
    })
  }
  return text
}

function senderDisplayName (event: ConversationCommandEvent): string | undefined {
  for (const value of [event.sender?.card, event.sender?.nickname]) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

export function resolveConversationCommandAddress (
  event: ConversationCommandEvent,
  groupMerge: boolean,
  targetUserId?: string | number
): SessionAddress {
  const botId = identifier(event.self_id ?? event.bot?.uin, 'botId')
  const userId = identifier(
    targetUserId ?? event.sender?.user_id ?? event.user_id,
    'userId'
  )
  return Object.freeze({
    botId,
    scope: Object.freeze(resolveConversationScope({
      isGroup: event.isGroup,
      groupId: event.group_id,
      userId,
      groupMerge
    }))
  })
}

function atSegments (
  event: ConversationCommandEvent,
  toggleMode: string
): AtSegment[] {
  const segments = (event.message ?? []).filter((segment): segment is AtSegment => {
    return segment.type === 'at' &&
      (typeof segment.qq === 'string' || typeof segment.qq === 'number')
  })
  if (toggleMode !== 'at') return segments
  const botId = resolveConversationCommandAddress(event, false).botId
  return segments.filter(segment => String(segment.qq) !== botId)
}

function targetName (segment: AtSegment): string {
  return String(segment.text ?? '').replace(/^@/, '')
}

export async function listConversations (
  input: ConversationCommandInput
): Promise<ConversationCommandResult> {
  const address = resolveConversationCommandAddress(input.event, false)
  const summaries = []
  for await (const value of input.bridge.list({ botId: address.botId })) summaries.push(value)
  if (summaries.length === 0) {
    return {
      message: '当前没有人正在与机器人对话',
      quote: true,
      success: false
    }
  }
  let response = '当前对话列表：(格式为【开始时间 ｜ qq昵称 ｜ 对话长度 ｜ 最后活跃时间】)\n'
  for (const value of summaries) {
    response += `${value.createdAt} ｜ ${value.startedBy.displayName ?? value.startedBy.userId} ｜ ${value.turnCount} ｜ ${value.updatedAt} \n`
  }
  return { message: response, quote: true, success: true }
}

export async function endConversation (
  input: ScopedConversationCommandInput
): Promise<ConversationCommandResult> {
  const mentions = atSegments(input.event, input.toggleMode)
  if (mentions.length === 0) {
    const address = resolveConversationCommandAddress(input.event, input.groupMerge)
    const deleted = await input.bridge.delete(address)
    return deleted
      ? {
          message: '已结束当前对话，请@我进行聊天以开启新的对话',
          quote: true,
          success: true
        }
      : { message: '当前没有开启对话', quote: true, success: false }
  }
  const target = mentions[0]
  const name = targetName(target)
  const address = resolveConversationCommandAddress(
    input.event,
    input.groupMerge,
    target.qq
  )
  const deleted = await input.bridge.delete(address)
  return deleted
    ? {
        message: `已结束${name}的对话，TA仍可以@我进行聊天以开启新的对话`,
        quote: true,
        success: true
      }
    : { message: `当前${name}没有开启对话`, quote: true, success: false }
}

export async function endAllConversations (
  input: ConversationCommandInput
): Promise<ConversationCommandResult> {
  const address = resolveConversationCommandAddress(input.event, false)
  const deleted = await input.bridge.deleteAll({ botId: address.botId })
  return {
    message: `结束了${deleted}个用户的对话。`,
    quote: true,
    success: true
  }
}

export async function joinConversation (
  input: ScopedConversationCommandInput
): Promise<ConversationCommandResult> {
  const mentions = atSegments(input.event, input.toggleMode)
  if (mentions.length === 0) {
    return {
      message: '指令错误，使用本指令时请同时@某人',
      quote: true,
      success: false
    }
  }
  const target = mentions[0]
  const name = targetName(target)
  const source = resolveConversationCommandAddress(
    input.event,
    input.groupMerge,
    target.qq
  )
  const destination = resolveConversationCommandAddress(input.event, input.groupMerge)
  const userId = identifier(
    input.event.sender?.user_id ?? input.event.user_id,
    'userId'
  )
  const displayName = senderDisplayName(input.event)
  try {
    await input.bridge.fork(source, destination, {
      userId,
      ...(displayName === undefined ? {} : { displayName })
    }, input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds })
    return { message: `加入${name}的对话成功`, quote: false, success: true }
  } catch (error) {
    if (error instanceof AgentError && error.code === 'invalid_session') {
      return { message: `${name}当前未开启对话，无法加入`, quote: true, success: false }
    }
    throw error
  }
}
