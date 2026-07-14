import type { AgentMessage } from '../contracts/content.js'
import { parseJsonValue } from '../model/json-value.js'
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js'
import {
  parseAgentSessionState,
  type AgentSessionState,
  type SemanticConversationMessage
} from './agent-session-state.js'
import type { LegacyConversationState } from './legacy-session-codec.js'
import type { SessionRecord } from './session-record.js'

function timestamp (value: string): string {
  if (new Date(value).toISOString() !== value) throw new TypeError('migration timestamp is invalid')
  return value
}

function sensitivity (
  scope: SessionRecord<unknown>['scope']
): AgentMessage['provenance']['sensitivity'] {
  return scope.kind === 'private' ? 'private' : 'group'
}

export class LegacySessionProjector {
  project (
    legacy: SessionRecord<LegacyConversationState>,
    migratedAt: string
  ): SessionRecord<AgentSessionState> {
    const parsedMessages = parseJsonValue(legacy.state.messages, {
      maxBytes: RUN_RESOURCE_LIMITS.providerProtocolChainBytes,
      maxDepth: 16,
      maxNodes: 8_192
    })
    if (!Array.isArray(parsedMessages) || parsedMessages.length > 64) {
      throw new TypeError('legacy session history is invalid')
    }
    const projected: SemanticConversationMessage[] = []
    for (const [index, raw] of parsedMessages.entries()) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('legacy session message is invalid')
      }
      const role = raw.role
      if (role === 'system' || role === 'tool' || role === 'function') continue
      if (role !== 'user' && role !== 'assistant') {
        throw new TypeError('legacy session message role is invalid')
      }
      if (raw.content === null || raw.content === undefined || raw.content === '') continue
      if (typeof raw.content !== 'string') {
        throw new TypeError('legacy session message content is invalid')
      }
      const id = `legacy-${legacy.sessionId}-${index}`
      const message: AgentMessage = Object.freeze({
        id,
        role,
        parts: Object.freeze([{ type: 'text' as const, text: raw.content }]),
        createdAt: legacy.updatedAt,
        provenance: Object.freeze({
          source: 'legacy_session',
          trust: 'untrusted',
          sensitivity: sensitivity(legacy.scope),
          sourceId: id,
          createdAt: legacy.updatedAt
        })
      })
      projected.push(Object.freeze({ kind: 'message', message }))
    }
    const state = parseAgentSessionState({
      schemaVersion: 1,
      messages: projected,
      migratedFrom: {
        kind: 'legacy', sourceVersion: 1, migratedAt: timestamp(migratedAt)
      }
    })
    return Object.freeze({
      schemaVersion: 1,
      sessionId: legacy.sessionId,
      botId: legacy.botId,
      scope: Object.freeze({ ...legacy.scope }),
      startedBy: Object.freeze({ ...legacy.startedBy }),
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      turnCount: legacy.turnCount,
      state
    })
  }
}
