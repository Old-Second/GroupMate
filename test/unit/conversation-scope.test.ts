import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalSessionKey,
  legacySessionKey,
  parseCanonicalSessionKey,
  parseLegacySessionKey,
  resolveConversationScope,
  serializeConversationScope
} from '../../src/agent/session/conversation-scope.js'

test('scope resolver preserves current behavior', () => {
  assert.equal(serializeConversationScope(resolveConversationScope({
    isGroup: false,
    userId: '7'
  })), 'private:7')
  assert.equal(serializeConversationScope(resolveConversationScope({
    isGroup: true,
    groupId: '8',
    userId: '7',
    groupMerge: true
  })), 'group:8')
  assert.equal(serializeConversationScope(resolveConversationScope({
    isGroup: true,
    groupId: '8',
    userId: '7',
    groupMerge: false
  })), 'group:8:user:7')
})
test('keys isolate bots and encode only identifier segments', () => {
  const scope = resolveConversationScope({ isGroup: false, userId: 'user:7' })
  assert.equal(
    canonicalSessionKey({ botId: 'bot:1', scope }),
    'GROUPMATE:SESSION:v1:bot%3A1:private:user%3A7'
  )
  assert.equal(legacySessionKey(scope), 'CHATGPT:CONVERSATIONS:private:user:7')
})

test('canonical and legacy keys parse back to their addresses', () => {
  const scope = resolveConversationScope({
    isGroup: true,
    groupId: '8',
    userId: '7',
    groupMerge: false
  })
  assert.deepEqual(
    parseCanonicalSessionKey(canonicalSessionKey({ botId: '10000', scope })),
    { botId: '10000', scope }
  )
  assert.deepEqual(parseLegacySessionKey(legacySessionKey(scope)), scope)
  assert.equal(parseCanonicalSessionKey('GROUPMATE:SESSION:v2:10000:private:7'), null)
  assert.equal(parseLegacySessionKey('CHATGPT:CONVERSATIONS:private:user:7'), null)
})

test('scope resolver rejects empty and oversized identifiers', () => {
  assert.throws(() => resolveConversationScope({ isGroup: false, userId: '' }))
  assert.throws(() => resolveConversationScope({
    isGroup: true,
    groupId: '8',
    userId: 'x'.repeat(129),
    groupMerge: false
  }))
  assert.throws(() => canonicalSessionKey({
    botId: '',
    scope: { kind: 'private', userId: '7' }
  }))
})
