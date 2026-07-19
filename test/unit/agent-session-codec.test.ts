import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentMessage } from '../../src/agent/contracts/content.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  parseAgentSessionState,
  type AgentSessionState,
  type ProviderProtocolSpan
} from '../../src/agent/session/agent-session-state.js'
import { agentSessionCodec } from '../../src/agent/session/agent-session-codec.js'
import { LegacySessionProjector } from '../../src/agent/session/legacy-session-projector.js'
import type { LegacyConversationState } from '../../src/agent/session/legacy-session-codec.js'
import type { SessionRecord } from '../../src/agent/session/session-record.js'

const address: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})
const timestamp = '2026-07-14T01:00:00.000Z'

function semanticMessage (id: string, role: 'user' | 'assistant', text: string): AgentMessage {
  return Object.freeze({
    id,
    role,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt: timestamp,
    provenance: Object.freeze({
      source: 'test', trust: 'untrusted', sensitivity: 'group',
      sourceId: id, createdAt: timestamp
    })
  })
}

function protocolSpan (): ProviderProtocolSpan {
  const argumentsText = '{ "url": "https://fixture.invalid", "label": "e\\u0301" }'
  return Object.freeze({
    kind: 'provider_protocol_span',
    id: 'span-1',
    profileId: 'deepseek',
    profileVersion: 1,
    createdAt: timestamp,
    messages: Object.freeze([
      Object.freeze({
        role: 'assistant' as const,
        content: null,
        toolCalls: Object.freeze([
          Object.freeze({
            callId: 'call-1',
            name: 'website',
            argumentsText,
            arguments: Object.freeze({ url: 'https://fixture.invalid', label: 'e\u0301' })
          }),
          Object.freeze({ callId: 'call-2', name: 'weather', arguments: Object.freeze({ city: 'fixture' }) })
        ]),
        providerState: Object.freeze({
          profileId: 'deepseek', profileVersion: 1,
          payload: Object.freeze({ reasoningContent: 'opaque fixture reasoning' })
        })
      }),
      Object.freeze({ role: 'tool' as const, content: 'page fixture', toolCallId: 'call-1' }),
      Object.freeze({ role: 'tool' as const, content: 'weather fixture', toolCallId: 'call-2' })
    ])
  })
}

function canonicalRecord (): SessionRecord<AgentSessionState> {
  return Object.freeze({
    schemaVersion: 1,
    sessionId: 'session-1',
    botId: address.botId,
    scope: address.scope,
    startedBy: Object.freeze({ userId: 'actor-1', displayName: 'member' }),
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 1,
    state: Object.freeze({
      schemaVersion: 1,
      messages: Object.freeze([
        Object.freeze({ kind: 'message' as const, message: semanticMessage('user-1', 'user', 'hello') }),
        protocolSpan(),
        Object.freeze({ kind: 'message' as const, message: semanticMessage('assistant-1', 'assistant', 'done') })
      ])
    })
  })
}

test('agent session codec round-trips semantic messages and one atomic provider span', () => {
  const encoded = agentSessionCodec.encode(canonicalRecord())
  const decoded = agentSessionCodec.decodeCanonical(encoded, address)

  assert.deepEqual(decoded, canonicalRecord())
  assert.equal(Object.isFrozen(decoded.state.messages), true)
  assert.equal(Object.isFrozen(decoded.state.messages[1]), true)
  const span = decoded.state.messages[1]
  assert.equal(span?.kind, 'provider_protocol_span')
  if (span?.kind !== 'provider_protocol_span') throw new Error('protocol span expected')
  const assistant = span.messages[0]
  assert.equal(assistant?.role, 'assistant')
  if (assistant?.role !== 'assistant') throw new Error('assistant message expected')
  assert.equal(
    assistant.toolCalls?.[0]?.argumentsText,
    '{ "url": "https://fixture.invalid", "label": "e\\u0301" }'
  )
  assert.doesNotMatch(encoded, /reasoningView/)
})

test('agent session rejects oversized exact tool argument text while accepting legacy spans', () => {
  const span = protocolSpan()
  const assistant = span.messages[0]
  assert.equal(assistant?.role, 'assistant')
  if (assistant?.role !== 'assistant') throw new Error('assistant message expected')
  assert.throws(() => parseAgentSessionState({
    schemaVersion: 1,
    messages: [{
      ...span,
      messages: [{
        ...assistant,
        toolCalls: [{
          ...assistant.toolCalls?.[0],
          argumentsText: 'x'.repeat(32 * 1_024 + 1)
        }, assistant.toolCalls?.[1]]
      }, ...span.messages.slice(1)]
    }]
  }), /argument/i)

  assert.doesNotThrow(() => parseAgentSessionState({
    schemaVersion: 1,
    messages: [{
      ...span,
      messages: [{
        ...assistant,
        toolCalls: assistant.toolCalls?.map(({ argumentsText: _argumentsText, ...call }) => call)
      }, ...span.messages.slice(1)]
    }]
  }))
})

test('agent session state rejects incomplete, mismatched or display-only protocol state', () => {
  const span = protocolSpan()
  assert.throws(() => parseAgentSessionState({
    schemaVersion: 1,
    messages: [{ ...span, messages: span.messages.slice(0, 2) }]
  }), /protocol span/i)
  assert.throws(() => parseAgentSessionState({
    schemaVersion: 1,
    messages: [{
      ...span,
      messages: [{
        ...span.messages[0],
        providerState: { profileId: 'standard', profileVersion: 1, payload: {} }
      }, ...span.messages.slice(1)]
    }]
  }), /profile/i)
  assert.throws(() => parseAgentSessionState({
    schemaVersion: 1,
    messages: [{
      ...span,
      messages: [{ ...span.messages[0], reasoningView: 'must not persist' }, ...span.messages.slice(1)]
    }]
  }), /unknown|reasoning/i)
})

test('legacy projector copies only bounded semantic history without continuation state', () => {
  const legacy: SessionRecord<LegacyConversationState> = {
    schemaVersion: 1,
    sessionId: 'legacy-session-1',
    botId: address.botId,
    scope: address.scope,
    startedBy: { userId: 'actor-1' },
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 2,
    state: {
      conversationId: 'legacy-conversation-private',
      parentMessageId: 'legacy-parent-private',
      messages: [
        { role: 'system', content: 'old system prompt' },
        { role: 'user', content: 'legacy user' },
        { role: 'assistant', content: 'legacy assistant', reasoning_content: 'private reasoning' },
        { role: 'tool', content: 'private tool result', tool_call_id: 'call-private' }
      ]
    }
  }
  const projected = new LegacySessionProjector().project(legacy, timestamp)

  assert.deepEqual(projected.state.messages.map(item => (
    item.kind === 'message' ? [item.message.role, item.message.parts[0]] : item.kind
  )), [
    ['user', { type: 'text', text: 'legacy user' }],
    ['assistant', { type: 'text', text: 'legacy assistant' }]
  ])
  assert.deepEqual(projected.state.migratedFrom, {
    kind: 'legacy', sourceVersion: 1, migratedAt: timestamp
  })
  const serialized = agentSessionCodec.encode(projected)
  assert.doesNotMatch(serialized, /conversation-private|parent-private|private reasoning|private tool result/)
})
