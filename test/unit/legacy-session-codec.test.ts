import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConversationScope } from '../../src/agent/session/conversation-scope.js'
import {
  legacySessionCodec,
  type LegacyConversationState
} from '../../src/agent/session/legacy-session-codec.js'
import type { SessionRecord } from '../../src/agent/session/session-record.js'

const address = {
  botId: '10000',
  scope: resolveConversationScope({ isGroup: false, userId: '7' })
}

const raw = JSON.stringify({
  sender: { user_id: 7, nickname: 'member' },
  ctime: '2026-07-12T23:00:00.000Z',
  utime: '2026-07-12T23:30:00.000Z',
  num: 3,
  messages: [{ role: 'system', content: 'system' }],
  conversation: { conversationId: 'conversation-1' },
  parentMessageId: 'message-1'
})

test('codec decodes the fixed legacy session fixture', () => {
  const record = legacySessionCodec.decodeLegacy(raw, {
    address,
    now: new Date('2026-07-13T00:00:00.000Z'),
    sessionId: 'session-1'
  })

  assert.deepEqual(record, {
    schemaVersion: 1,
    sessionId: 'session-1',
    botId: '10000',
    scope: { kind: 'private', userId: '7' },
    startedBy: { userId: '7', displayName: 'member' },
    createdAt: '2026-07-12T23:00:00.000Z',
    updatedAt: '2026-07-12T23:30:00.000Z',
    turnCount: 3,
    state: {
      messages: [{ role: 'system', content: 'system' }],
      conversationId: 'conversation-1',
      parentMessageId: 'message-1'
    }
  })
  assert.equal('sender' in record.state, false)
})

test('codec round-trips canonical records', () => {
  const record: SessionRecord<LegacyConversationState> = {
    schemaVersion: 1,
    sessionId: 'session-1',
    botId: address.botId,
    scope: address.scope,
    startedBy: { userId: '7' },
    createdAt: '2026-07-12T23:00:00.000Z',
    updatedAt: '2026-07-12T23:30:00.000Z',
    turnCount: 3,
    state: { messages: [], conversationId: 'conversation-1' }
  }

  assert.deepEqual(
    legacySessionCodec.decodeCanonical(legacySessionCodec.encode(record), address),
    record
  )
})

test('codec rejects malformed legacy and canonical data', () => {
  const decodeLegacy = (value: string): unknown => legacySessionCodec.decodeLegacy(value, {
    address,
    now: new Date('2026-07-13T00:00:00.000Z'),
    sessionId: 'session-1'
  })
  assert.throws(() => decodeLegacy('{'))
  assert.throws(() => decodeLegacy(JSON.stringify({
    sender: { user_id: 7 },
    num: -1,
    messages: []
  })))
  assert.throws(() => decodeLegacy(JSON.stringify({ sender: {}, num: 0, messages: [] })))
  assert.throws(() => decodeLegacy(JSON.stringify({
    sender: { user_id: 7 },
    num: 0,
    messages: {}
  })))

  const invalidCanonical = JSON.stringify({
    schemaVersion: 2,
    sessionId: 'session-1'
  })
  assert.throws(() => legacySessionCodec.decodeCanonical(invalidCanonical, address))

  const canonicalWithUnknownScopeData = JSON.parse(legacySessionCodec.encode({
    schemaVersion: 1,
    sessionId: 'session-1',
    botId: address.botId,
    scope: address.scope,
    startedBy: { userId: '7' },
    createdAt: '2026-07-12T23:00:00.000Z',
    updatedAt: '2026-07-12T23:30:00.000Z',
    turnCount: 0,
    state: { messages: [] }
  }))
  canonicalWithUnknownScopeData.scope.unknown = 'must-not-survive'
  assert.throws(() => legacySessionCodec.decodeCanonical(
    JSON.stringify(canonicalWithUnknownScopeData),
    address
  ))
})
