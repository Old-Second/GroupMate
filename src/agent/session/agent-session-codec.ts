import type { SessionAddress } from '../contracts/identity.js'
import { parseJsonValue, type JsonValue } from '../model/json-value.js'
import { canonicalSessionKey } from './conversation-scope.js'
import {
  parseAgentSessionState,
  type AgentSessionState
} from './agent-session-state.js'
import type { SessionCodec, SessionRecord } from './session-record.js'

const SESSION_BYTES = 512 * 1_024

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact (value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${label} contains unknown keys`)
  }
}

function text (value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function timestamp (value: unknown, label: string): string {
  const result = text(value, label, 64)
  try {
    if (new Date(result).toISOString() !== result) throw new TypeError()
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  return result
}

function parseCanonicalRecord (
  value: unknown,
  address: SessionAddress
): SessionRecord<AgentSessionState> {
  const cloned = parseJsonValue(value, {
    maxBytes: SESSION_BYTES,
    maxDepth: 36,
    maxNodes: 40_000
  })
  const session = record(cloned, 'agent session')
  exact(session, [
    'schemaVersion', 'sessionId', 'botId', 'scope', 'startedBy',
    'createdAt', 'updatedAt', 'turnCount', 'state'
  ], 'agent session')
  if (session.schemaVersion !== 1 || session.botId !== address.botId ||
    canonicalSessionKey({
      botId: String(session.botId),
      scope: session.scope as SessionAddress['scope']
    }) !== canonicalSessionKey(address)) {
    throw new TypeError('agent session address does not match its key')
  }
  const startedBy = record(session.startedBy, 'agent session starter')
  exact(startedBy, ['userId', 'displayName'], 'agent session starter')
  const parsedStartedBy = Object.freeze({
    userId: text(startedBy.userId, 'agent session starter ID'),
    ...(startedBy.displayName === undefined
      ? {}
      : { displayName: text(startedBy.displayName, 'agent session starter name', 256) })
  })
  if (!Number.isSafeInteger(session.turnCount) || Number(session.turnCount) < 0) {
    throw new TypeError('agent session turn count is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: text(session.sessionId, 'agent session ID'),
    botId: address.botId,
    scope: Object.freeze({ ...address.scope }),
    startedBy: parsedStartedBy,
    createdAt: timestamp(session.createdAt, 'agent session creation timestamp'),
    updatedAt: timestamp(session.updatedAt, 'agent session update timestamp'),
    turnCount: Number(session.turnCount),
    state: parseAgentSessionState(session.state)
  })
}

export const agentSessionCodec: SessionCodec<AgentSessionState> = Object.freeze({
  encode (session: SessionRecord<AgentSessionState>) {
    const parsed = parseCanonicalRecord(session, {
      botId: session.botId,
      scope: session.scope
    })
    return JSON.stringify(parsed as unknown as JsonValue)
  },

  decodeCanonical (raw: string, address: SessionAddress) {
    return parseCanonicalRecord(JSON.parse(raw) as unknown, address)
  },

  decodeLegacy () {
    throw new TypeError('legacy sessions require the bounded legacy projector')
  }
})
