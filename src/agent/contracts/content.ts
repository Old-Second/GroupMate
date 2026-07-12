export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface MessageProvenance {
  readonly source: string
  readonly trust: 'trusted' | 'untrusted'
  readonly sensitivity: 'public' | 'group' | 'private' | 'sensitive'
  readonly sourceId: string
  readonly createdAt: string
}
export type AgentContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'resource_ref'; readonly resourceType: 'image' | 'audio' | 'file'; readonly resourceId: string; readonly mimeType?: string; readonly expiresAt?: string }
  | { readonly type: 'mention'; readonly userId: string; readonly displayName?: string }
  | { readonly type: 'tool_call'; readonly toolCallId: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool_result'; readonly toolCallId: string; readonly status: 'ok' | 'error' | 'denied' | 'indeterminate'; readonly content: string }

export interface QuotedMessageSnapshot {
  readonly messageId: string
  readonly sender: { readonly userId: string; readonly displayName?: string }
  readonly parts: readonly AgentContentPart[]
}

export interface AgentMessage {
  readonly id: string
  readonly role: AgentMessageRole
  readonly parts: readonly AgentContentPart[]
  readonly createdAt: string
  readonly provenance: MessageProvenance
  readonly replyTo?: QuotedMessageSnapshot
}

type UnknownRecord = Record<string, unknown>

function asRecord (value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function assertExactKeys (value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key))
  if (unknownKey !== undefined) {
    throw new TypeError(`${label} contains unknown key: ${unknownKey}`)
  }
}

function requireString (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function requireIsoTimestamp (value: unknown, label: string): string {
  const timestamp = requireString(value, label)
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError(`${label} must be an ISO timestamp`)
  }
  return timestamp
}

function parseContentPart (value: unknown): AgentContentPart {
  const part = asRecord(value, 'message part')
  switch (part.type) {
    case 'text':
      assertExactKeys(part, ['type', 'text'], 'text part')
      requireString(part.text, 'text part text')
      return value as AgentContentPart
    case 'resource_ref': {
      assertExactKeys(part, ['type', 'resourceType', 'resourceId', 'mimeType', 'expiresAt'], 'resource part')
      if (!['image', 'audio', 'file'].includes(String(part.resourceType))) {
        throw new TypeError('resource part type is invalid')
      }
      const resourceId = requireString(part.resourceId, 'resource ID')
      if (/^data:[^,]*;base64,/i.test(resourceId)) {
        throw new TypeError('inline base64 resources are not allowed')
      }
      if (part.mimeType !== undefined) requireString(part.mimeType, 'resource mime type')
      if (part.expiresAt !== undefined) requireIsoTimestamp(part.expiresAt, 'resource expiry')
      return value as AgentContentPart
    }
    case 'mention':
      assertExactKeys(part, ['type', 'userId', 'displayName'], 'mention part')
      requireString(part.userId, 'mention user ID')
      if (part.displayName !== undefined) requireString(part.displayName, 'mention display name')
      return value as AgentContentPart
    case 'tool_call':
      assertExactKeys(part, ['type', 'toolCallId', 'name', 'arguments'], 'tool call part')
      requireString(part.toolCallId, 'tool call ID')
      requireString(part.name, 'tool name')
      asRecord(part.arguments, 'tool arguments')
      return value as AgentContentPart
    case 'tool_result':
      assertExactKeys(part, ['type', 'toolCallId', 'status', 'content'], 'tool result part')
      requireString(part.toolCallId, 'tool call ID')
      if (!['ok', 'error', 'denied', 'indeterminate'].includes(String(part.status))) {
        throw new TypeError('tool result status is invalid')
      }
      if (typeof part.content !== 'string') throw new TypeError('tool result content must be a string')
      return value as AgentContentPart
    default:
      throw new TypeError('message part type is invalid')
  }
}

function parseProvenance (value: unknown): MessageProvenance {
  const provenance = asRecord(value, 'message provenance')
  assertExactKeys(provenance, ['source', 'trust', 'sensitivity', 'sourceId', 'createdAt'], 'message provenance')
  requireString(provenance.source, 'provenance source')
  if (!['trusted', 'untrusted'].includes(String(provenance.trust))) {
    throw new TypeError('provenance trust is invalid')
  }
  if (!['public', 'group', 'private', 'sensitive'].includes(String(provenance.sensitivity))) {
    throw new TypeError('provenance sensitivity is invalid')
  }
  requireString(provenance.sourceId, 'provenance source ID')
  requireIsoTimestamp(provenance.createdAt, 'provenance timestamp')
  return value as MessageProvenance
}

function parseQuotedMessage (value: unknown): QuotedMessageSnapshot {
  const quote = asRecord(value, 'quoted message')
  assertExactKeys(quote, ['messageId', 'sender', 'parts'], 'quoted message')
  requireString(quote.messageId, 'quoted message ID')
  const sender = asRecord(quote.sender, 'quoted sender')
  assertExactKeys(sender, ['userId', 'displayName'], 'quoted sender')
  requireString(sender.userId, 'quoted sender user ID')
  if (sender.displayName !== undefined) requireString(sender.displayName, 'quoted sender display name')
  if (!Array.isArray(quote.parts)) throw new TypeError('quoted message parts must be an array')
  quote.parts.forEach(parseContentPart)
  return value as QuotedMessageSnapshot
}

export function parseAgentMessage (value: unknown): AgentMessage {
  const message = asRecord(value, 'agent message')
  assertExactKeys(message, ['id', 'role', 'parts', 'createdAt', 'provenance', 'replyTo'], 'agent message')
  requireString(message.id, 'message ID')
  if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) {
    throw new TypeError('message role is invalid')
  }
  if (!Array.isArray(message.parts)) throw new TypeError('message parts must be an array')
  message.parts.forEach(parseContentPart)
  requireIsoTimestamp(message.createdAt, 'message timestamp')
  parseProvenance(message.provenance)
  if (message.replyTo !== undefined) parseQuotedMessage(message.replyTo)
  return value as AgentMessage
}
