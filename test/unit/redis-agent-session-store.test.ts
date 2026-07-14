import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import { canonicalSessionKey, legacySessionKey } from '../../src/agent/session/conversation-scope.js'
import { agentSessionCodec } from '../../src/agent/session/agent-session-codec.js'
import {
  AGENT_SESSION_NAMESPACE,
  RedisAgentSessionStore,
  agentSessionKey
} from '../../src/agent/session/redis-agent-session-store.js'
import { legacySessionCodec } from '../../src/agent/session/legacy-session-codec.js'
import type { SessionRecord } from '../../src/agent/session/session-record.js'
import type { AgentSessionState } from '../../src/agent/session/agent-session-state.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const timestamp = '2026-07-14T01:00:00.000Z'
const address: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' })
})

function v2Record (text = 'canonical v2'): SessionRecord<AgentSessionState> {
  return {
    schemaVersion: 1,
    sessionId: 'session-v2',
    botId: address.botId,
    scope: address.scope,
    startedBy: { userId: 'actor-1' },
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 1,
    state: {
      schemaVersion: 1,
      messages: [{
        kind: 'message',
        message: {
          id: 'message-v2', role: 'user', parts: [{ type: 'text', text }],
          createdAt: timestamp,
          provenance: {
            source: 'test', trust: 'untrusted', sensitivity: 'group',
            sourceId: 'message-v2', createdAt: timestamp
          }
        }
      }]
    }
  }
}

function v1Record () {
  return {
    schemaVersion: 1 as const,
    sessionId: 'session-v1',
    botId: address.botId,
    scope: address.scope,
    startedBy: { userId: 'actor-1' },
    createdAt: timestamp,
    updatedAt: timestamp,
    turnCount: 1,
    state: { messages: [{ role: 'user', content: 'legacy v1' }] }
  }
}

test('v2 session wins without rewriting the preserved v1 source', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  await redis.set(agentSessionKey(address), agentSessionCodec.encode(v2Record()))
  await redis.set(canonicalSessionKey(address), legacySessionCodec.encode(v1Record()))
  const store = new RedisAgentSessionStore({ redis, now: () => new Date(timestamp) })

  const loaded = await store.get(address)
  assert.equal(loaded?.sessionId, 'session-v2')
  assert.notEqual(await redis.get(canonicalSessionKey(address)), null)
})

test('v1 and raw legacy sessions project copy-on-read into v2 without deletion', async () => {
  for (const source of ['v1', 'legacy'] as const) {
    const redis = new FakeRedis(() => Date.parse(timestamp))
    const sourceKey = source === 'v1' ? canonicalSessionKey(address) : legacySessionKey(address.scope)
    const sourceRaw = source === 'v1'
      ? legacySessionCodec.encode(v1Record())
      : JSON.stringify({
          sender: { user_id: 'actor-1' }, ctime: timestamp, utime: timestamp,
          num: 1, messages: [{ role: 'user', content: `legacy ${source}` }]
        })
    await redis.set(sourceKey, sourceRaw, { EX: 600 })
    const store = new RedisAgentSessionStore({
      redis,
      now: () => new Date(timestamp),
      generateId: () => `migrated-${source}`
    })

    const loaded = await store.get(address)
    assert.equal(loaded?.state.migratedFrom?.kind, 'legacy')
    assert.notEqual(await redis.get(sourceKey), null)
    assert.notEqual(await redis.get(agentSessionKey(address)), null)
    assert.ok((await redis.ttl(agentSessionKey(address))) > 0)
  }
})

test('projection failure writes a fresh v2 session and emits only fixed metadata', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  await redis.set(canonicalSessionKey(address), JSON.stringify({ privateValue: 'do-not-log' }))
  const events: unknown[] = []
  const store = new RedisAgentSessionStore({
    redis,
    now: () => new Date(timestamp),
    generateId: () => 'fresh-session',
    onProjectionFailure: event => events.push(event)
  })

  const loaded = await store.get(address)
  assert.equal(loaded?.sessionId, 'fresh-session')
  assert.deepEqual(loaded?.state.messages, [])
  assert.notEqual(await redis.get(canonicalSessionKey(address)), null)
  assert.notEqual(await redis.get(agentSessionKey(address)), null)
  assert.match(agentSessionKey(address), new RegExp(`^${AGENT_SESSION_NAMESPACE}`))
  assert.doesNotMatch(JSON.stringify(events), /do-not-log|actor-1|group-1|bot-1/)
})
