import type { ConversationScope, SessionAddress } from '../contracts/identity.js'

const canonicalPrefix = 'GROUPMATE:SESSION:v1:'
const legacyPrefix = 'CHATGPT:CONVERSATIONS:'
const maxIdentifierLength = 128

export interface ConversationScopeInput {
  readonly isGroup: boolean
  readonly groupId?: string | number
  readonly userId: string | number
  readonly groupMerge?: boolean
}
function identifier (value: string | number | undefined, label: string): string {
  const result = value === undefined ? '' : String(value)
  if (result.length === 0 || result.length > maxIdentifierLength) {
    throw new TypeError(`${label} must contain between 1 and ${maxIdentifierLength} characters`)
  }
  return result
}

function encodedIdentifier (value: string | number | undefined, label: string): string {
  return encodeURIComponent(identifier(value, label))
}

function decodedIdentifier (value: string, label: string): string {
  try {
    return identifier(decodeURIComponent(value), label)
  } catch (error) {
    throw new TypeError(`${label} is not valid percent-encoding`, { cause: error })
  }
}

export function resolveConversationScope (input: ConversationScopeInput): ConversationScope {
  const userId = identifier(input.userId, 'user ID')
  if (!input.isGroup) return { kind: 'private', userId }
  const groupId = identifier(input.groupId, 'group ID')
  return input.groupMerge === true
    ? { kind: 'group', groupId }
    : { kind: 'group_user', groupId, userId }
}

export function serializeConversationScope (scope: ConversationScope): string {
  switch (scope.kind) {
    case 'private':
      return `private:${identifier(scope.userId, 'user ID')}`
    case 'group':
      return `group:${identifier(scope.groupId, 'group ID')}`
    case 'group_user':
      return `group:${identifier(scope.groupId, 'group ID')}:user:${identifier(scope.userId, 'user ID')}`
  }
}

export function canonicalSessionKey (address: SessionAddress): string {
  const botId = encodedIdentifier(address.botId, 'bot ID')
  switch (address.scope.kind) {
    case 'private':
      return `${canonicalPrefix}${botId}:private:${encodedIdentifier(address.scope.userId, 'user ID')}`
    case 'group':
      return `${canonicalPrefix}${botId}:group:${encodedIdentifier(address.scope.groupId, 'group ID')}`
    case 'group_user':
      return `${canonicalPrefix}${botId}:group:${encodedIdentifier(address.scope.groupId, 'group ID')}:user:${encodedIdentifier(address.scope.userId, 'user ID')}`
  }
}

export function legacySessionKey (scope: ConversationScope): string {
  return `${legacyPrefix}${serializeConversationScope(scope)}`
}

export function parseCanonicalSessionKey (key: string): SessionAddress | null {
  if (!key.startsWith(canonicalPrefix)) return null
  const segments = key.slice(canonicalPrefix.length).split(':')
  try {
    const botId = decodedIdentifier(segments[0] ?? '', 'bot ID')
    if (segments.length === 3 && segments[1] === 'private') {
      return { botId, scope: { kind: 'private', userId: decodedIdentifier(segments[2], 'user ID') } }
    }
    if (segments.length === 3 && segments[1] === 'group') {
      return { botId, scope: { kind: 'group', groupId: decodedIdentifier(segments[2], 'group ID') } }
    }
    if (segments.length === 5 && segments[1] === 'group' && segments[3] === 'user') {
      return {
        botId,
        scope: {
          kind: 'group_user',
          groupId: decodedIdentifier(segments[2], 'group ID'),
          userId: decodedIdentifier(segments[4], 'user ID')
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export function parseLegacySessionKey (key: string): ConversationScope | null {
  if (!key.startsWith(legacyPrefix)) return null
  const segments = key.slice(legacyPrefix.length).split(':')
  const numericId = (value: string | undefined): value is string => /^\d+$/.test(value ?? '')
  if (segments.length === 2 && segments[0] === 'private' && numericId(segments[1])) {
    return { kind: 'private', userId: segments[1] }
  }
  if (segments.length === 2 && segments[0] === 'group' && numericId(segments[1])) {
    return { kind: 'group', groupId: segments[1] }
  }
  if (segments.length === 4 && segments[0] === 'group' && numericId(segments[1]) && segments[2] === 'user' && numericId(segments[3])) {
    return { kind: 'group_user', groupId: segments[1], userId: segments[3] }
  }
  return null
}
