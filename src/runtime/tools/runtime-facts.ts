import type {
  ActorIdentity,
  ChannelIdentity,
  ConversationScope
} from '../../agent/contracts/identity.js'
import type { ToolRuntimeFacts, ToolTarget } from '../../agent/tools/tool-context.js'

type RuntimeIdentifier = string | number
type GroupRole = 'owner' | 'admin' | 'member' | 'none'

export interface ToolRuntimeFactsSource {
  readonly botId: RuntimeIdentifier
  readonly actor: {
    readonly userId: RuntimeIdentifier
    readonly displayName?: string
    readonly role: 'owner' | 'admin' | 'member'
  }
  readonly channel:
    | { readonly kind: 'private'; readonly botId: RuntimeIdentifier; readonly userId: RuntimeIdentifier }
    | { readonly kind: 'group'; readonly botId: RuntimeIdentifier; readonly groupId: RuntimeIdentifier }
  readonly scope:
    | { readonly kind: 'private'; readonly userId: RuntimeIdentifier }
    | { readonly kind: 'group'; readonly groupId: RuntimeIdentifier }
    | { readonly kind: 'group_user'; readonly groupId: RuntimeIdentifier; readonly userId: RuntimeIdentifier }
  readonly botMasterIds: readonly RuntimeIdentifier[]
  readonly botGroupRole: GroupRole
  readonly actorGroupRole: GroupRole
  readonly lookupTarget?: (
    target: ToolTarget,
    signal: AbortSignal
  ) => Promise<{ readonly exists: boolean; readonly role: GroupRole }>
}

function abortError (): Error {
  return new DOMException('operation was aborted', 'AbortError')
}

function throwIfAborted (signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function identifier (value: RuntimeIdentifier, label: string): string {
  const result = typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
    : value
  if (result.length === 0 || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError(`${label} is invalid`)
  }
  return result
}

function role (value: unknown, label: string): GroupRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member' && value !== 'none') {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function actorIdentity (source: ToolRuntimeFactsSource['actor']): ActorIdentity {
  if (source.role !== 'owner' && source.role !== 'admin' && source.role !== 'member') {
    throw new TypeError('actor role is invalid')
  }
  if (source.displayName !== undefined && (typeof source.displayName !== 'string' || Buffer.byteLength(source.displayName, 'utf8') > 256)) {
    throw new TypeError('actor display name is invalid')
  }
  return Object.freeze({
    userId: identifier(source.userId, 'actor user ID'),
    ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    role: source.role
  })
}

function channelIdentity (source: ToolRuntimeFactsSource['channel'], botId: string): ChannelIdentity {
  if (identifier(source.botId, 'channel bot ID') !== botId) throw new TypeError('channel bot ID does not match')
  return source.kind === 'private'
    ? Object.freeze({ kind: 'private', botId, userId: identifier(source.userId, 'channel user ID') })
    : Object.freeze({ kind: 'group', botId, groupId: identifier(source.groupId, 'channel group ID') })
}

function conversationScope (source: ToolRuntimeFactsSource['scope']): ConversationScope {
  if (source.kind === 'private') return Object.freeze({ kind: 'private', userId: identifier(source.userId, 'scope user ID') })
  if (source.kind === 'group') return Object.freeze({ kind: 'group', groupId: identifier(source.groupId, 'scope group ID') })
  return Object.freeze({
    kind: 'group_user',
    groupId: identifier(source.groupId, 'scope group ID'),
    userId: identifier(source.userId, 'scope user ID')
  })
}

function validateScope (channel: ChannelIdentity, scope: ConversationScope, actorId: string): void {
  if (channel.kind === 'private') {
    if (scope.kind !== 'private' || channel.userId !== actorId || scope.userId !== actorId) {
      throw new TypeError('private runtime scope is inconsistent')
    }
    return
  }
  if (scope.kind === 'private' || scope.groupId !== channel.groupId ||
    (scope.kind === 'group_user' && scope.userId !== actorId)) {
    throw new TypeError('group runtime scope is inconsistent')
  }
}

function targetUserId (target: ToolTarget): string | null {
  if (target.kind === 'member' || target.kind === 'private') return target.userId
  return null
}

function normalizeTarget (target: ToolTarget): ToolTarget {
  if (target.kind === 'none') return Object.freeze({ kind: 'none' })
  if (target.kind === 'private') {
    return Object.freeze({ kind: 'private', userId: identifier(target.userId, 'target user ID') })
  }
  if (target.kind === 'group') {
    return Object.freeze({ kind: 'group', groupId: identifier(target.groupId, 'target group ID') })
  }
  if (target.kind === 'member') {
    return Object.freeze({
      kind: 'member',
      groupId: identifier(target.groupId, 'target group ID'),
      userId: identifier(target.userId, 'target user ID')
    })
  }
  return Object.freeze({
    kind: 'message',
    groupId: identifier(target.groupId, 'target group ID'),
    messageId: identifier(target.messageId, 'target message ID')
  })
}

export async function resolveToolRuntimeFacts (
  source: ToolRuntimeFactsSource,
  target: ToolTarget,
  signal = new AbortController().signal
): Promise<ToolRuntimeFacts> {
  throwIfAborted(signal)
  const botId = identifier(source.botId, 'bot ID')
  const normalizedTarget = normalizeTarget(target)
  const actor = actorIdentity(source.actor)
  const channel = channelIdentity(source.channel, botId)
  const scope = conversationScope(source.scope)
  validateScope(channel, scope, actor.userId)
  const masters = new Set(source.botMasterIds.map(value => identifier(value, 'bot master ID')))
  const actorWithMaster = Object.freeze({ ...actor, isBotMaster: masters.has(actor.userId) })
  const botGroupRole = role(source.botGroupRole, 'bot group role')
  const actorGroupRole = role(source.actorGroupRole, 'actor group role')

  let targetExists = normalizedTarget.kind === 'none'
  let targetRole: GroupRole = 'none'
  if (normalizedTarget.kind !== 'none') {
    if (source.lookupTarget === undefined) throw new TypeError('target lookup is unavailable')
    const resolved = await source.lookupTarget(normalizedTarget, signal)
    throwIfAborted(signal)
    if (typeof resolved?.exists !== 'boolean') throw new TypeError('target existence is invalid')
    targetExists = resolved.exists
    targetRole = role(resolved.role, 'target role')
  }
  const userId = targetUserId(normalizedTarget)

  return Object.freeze({
    botId,
    actor: actorWithMaster,
    channel,
    scope,
    botGroupRole,
    actorGroupRole,
    targetRole,
    targetIsBotMaster: userId === null ? false : masters.has(userId),
    targetExists
  })
}
