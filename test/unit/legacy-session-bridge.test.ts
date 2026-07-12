import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import { legacySessionKey, resolveConversationScope } from '../../src/agent/session/conversation-scope.js'
import { createLegacySessionBridge } from '../../src/runtime/legacy-session-bridge.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const now = () => new Date('2026-07-13T00:00:00.000Z')
const event = {
  isGroup: true,
  group_id: 8,
  user_id: 7,
  self_id: 10000,
  sender: { user_id: 7, nickname: 'member' },
  message: []
}

test('bridge creates an unwritten compatibility snapshot and persists it on save', async () => {
  const redis = new FakeRedis(() => now().getTime())
  const bridge = createLegacySessionBridge({
    redis,
    now,
    generateId: () => 'session-1'
  })
  const snapshot = await bridge.loadOrCreate({
    event,
    groupMerge: false,
    initialMessages: [{ role: 'system', content: 'system' }]
  })
  assert.equal(snapshot.num, 0)
  assert.equal(await redis.get('GROUPMATE:SESSION:v1:10000:group:8:user:7'), null)

  snapshot.num = 1
  snapshot.conversation = { conversationId: 'conversation-1' }
  snapshot.parentMessageId = 'message-1'
  await bridge.save({ event, groupMerge: false, snapshot, ttlSeconds: 60 })

  const loaded = await bridge.loadOrCreate({ event, groupMerge: false, initialMessages: [] })
  assert.equal(loaded.num, 1)
  assert.equal(loaded.conversation.conversationId, 'conversation-1')
  assert.equal(loaded.parentMessageId, 'message-1')
})

test('bridge migrates legacy sessions and resolves bot and target scopes', async () => {
  const redis = new FakeRedis(() => now().getTime())
  const scope = resolveConversationScope({
    isGroup: true,
    groupId: '8',
    userId: '9',
    groupMerge: false
  })
  await redis.set(legacySessionKey(scope), JSON.stringify({
    sender: { user_id: 9, nickname: 'target' },
    ctime: now().toISOString(),
    utime: now().toISOString(),
    num: 2,
    messages: [{ role: 'system', content: 'legacy' }]
  }))
  const bridge = createLegacySessionBridge({
    redis,
    now,
    generateId: () => 'migrated-session'
  })

  assert.deepEqual(bridge.resolveAddress(event, false, 9), {
    botId: '10000',
    scope
  })
  assert.equal(await bridge.has(event, false, 9), true)
  assert.equal(await redis.get(legacySessionKey(scope)), null)
})

test('bridge rejects events without a bot identity', async () => {
  const bridge = createLegacySessionBridge({ redis: new FakeRedis(), now })
  assert.throws(() => bridge.resolveAddress({
    isGroup: false,
    user_id: 7,
    sender: { user_id: 7 }
  }, false), (error: unknown) => {
    return error instanceof AgentError && error.code === 'invalid_session'
  })
})

test('bridge logs contain fixed metadata without sender or message content', async () => {
  const logs: unknown[][] = []
  const bridge = createLegacySessionBridge({
    redis: new FakeRedis(() => now().getTime()),
    now,
    generateId: () => 'session-1',
    logger: { info: (...values: unknown[]) => logs.push(values) }
  })

  await bridge.loadOrCreate({
    event,
    groupMerge: false,
    initialMessages: [{ role: 'user', content: 'private-message-content' }]
  })

  const serialized = JSON.stringify(logs)
  assert.match(serialized, /session\.loaded|schemaVersion|scopeKind/)
  assert.doesNotMatch(serialized, /member|private-message-content|user_id/)
})
