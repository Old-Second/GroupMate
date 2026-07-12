import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  canonicalSessionKey,
  legacySessionKey,
  resolveConversationScope
} from '../../src/agent/session/conversation-scope.js'
import {
  legacySessionCodec,
  type LegacyConversationState
} from '../../src/agent/session/legacy-session-codec.js'
import { RedisSessionStore } from '../../src/agent/session/redis-session-store.js'
import type { SessionRecord } from '../../src/agent/session/session-record.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const fixedNow = '2026-07-13T00:00:00.000Z'

function address (userId: string): SessionAddress {
  return {
    botId: '10000',
    scope: resolveConversationScope({ isGroup: false, userId })
  }
}

function record (target: SessionAddress, sessionId: string): SessionRecord<LegacyConversationState> {
  return {
    schemaVersion: 1,
    sessionId,
    botId: target.botId,
    scope: target.scope,
    startedBy: {
      userId: target.scope.kind === 'private' ? target.scope.userId : '7',
      displayName: 'member'
    },
    createdAt: fixedNow,
    updatedAt: fixedNow,
    turnCount: 1,
    state: { messages: [{ role: 'system', content: 'system' }] }
  }
}

function legacyRaw (userId = '7'): string {
  return JSON.stringify({
    sender: { user_id: userId, nickname: `member-${userId}` },
    ctime: fixedNow,
    utime: fixedNow,
    num: 1,
    messages: [{ role: 'system', content: 'system' }]
  })
}

function store (redis: FakeRedis, generateId = () => 'session-migrated'): RedisSessionStore<LegacyConversationState> {
  return new RedisSessionStore({
    client: redis,
    codec: legacySessionCodec,
    now: () => new Date(fixedNow),
    generateId,
    scanCount: 2
  })
}

test('canonical data is preferred without reading or deleting legacy data', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(canonicalSessionKey(target), legacySessionCodec.encode(record(target, 'canonical')))
  await redis.set(legacySessionKey(target.scope), legacyRaw())

  assert.equal((await store(redis).get(target))?.sessionId, 'canonical')
  assert.notEqual(await redis.get(legacySessionKey(target.scope)), null)
})

test('get migrates legacy data and preserves positive TTL', async () => {
  let nowMs = Date.parse(fixedNow)
  const redis = new FakeRedis(() => nowMs)
  const target = address('7')
  await redis.set(legacySessionKey(target.scope), legacyRaw(), { EX: 120 })
  const sessionStore = new RedisSessionStore({
    client: redis,
    codec: legacySessionCodec,
    now: () => new Date(nowMs),
    generateId: () => 'session-migrated',
    scanCount: 2
  })

  const migrated = await sessionStore.get(target)

  assert.equal(migrated?.sessionId, 'session-migrated')
  assert.equal(await redis.get(legacySessionKey(target.scope)), null)
  assert.equal(await redis.ttl(canonicalSessionKey(target)), 120)
})

test('legacy migration preserves persistent sessions', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(legacySessionKey(target.scope), legacyRaw())

  await store(redis).get(target)

  assert.equal(await redis.ttl(canonicalSessionKey(target)), -1)
})

test('legacy TTL zero is treated as a miss and is not resurrected', async () => {
  let nowMs = Date.parse(fixedNow)
  const redis = new FakeRedis(() => nowMs)
  const target = address('7')
  await redis.set(legacySessionKey(target.scope), legacyRaw(), { EX: 1 })
  nowMs += 999

  assert.equal(await store(redis).get(target), null)
  assert.equal(await redis.get(canonicalSessionKey(target)), null)
  assert.notEqual(await redis.get(legacySessionKey(target.scope)), null)
})

test('failed canonical migration preserves legacy data', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(legacySessionKey(target.scope), legacyRaw())
  redis.set = async () => { throw new Error('write unavailable') }

  await assert.rejects(store(redis).get(target), (error: unknown) => {
    return error instanceof AgentError && error.code === 'storage_unavailable'
  })
  assert.equal(await redis.get(legacySessionKey(target.scope)), legacyRaw())
})

test('invalid canonical data does not fall back to legacy data', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(canonicalSessionKey(target), '{')
  await redis.set(legacySessionKey(target.scope), legacyRaw())

  await assert.rejects(store(redis).get(target), (error: unknown) => {
    return error instanceof AgentError && error.code === 'storage_invalid_data'
  })
  assert.notEqual(await redis.get(legacySessionKey(target.scope)), null)
})

test('save writes canonical data before cleaning stale legacy data', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(legacySessionKey(target.scope), legacyRaw())

  await store(redis).save(record(target, 'saved'), { ttlSeconds: 60 })

  assert.equal(await redis.get(legacySessionKey(target.scope)), null)
  assert.equal(await redis.ttl(canonicalSessionKey(target)), 60)
})

test('delete removes canonical and legacy keys', async () => {
  const redis = new FakeRedis()
  const target = address('7')
  await redis.set(canonicalSessionKey(target), legacySessionCodec.encode(record(target, 'canonical')))
  await redis.set(legacySessionKey(target.scope), legacyRaw())

  assert.equal(await store(redis).delete(target), true)
  assert.equal(await redis.get(canonicalSessionKey(target)), null)
  assert.equal(await redis.get(legacySessionKey(target.scope)), null)
})

test('list uses bounded SCAN, de-duplicates scopes and skips corrupt data', async () => {
  const redis = new FakeRedis()
  for (const userId of ['1', '2', '3']) {
    const target = address(userId)
    await redis.set(canonicalSessionKey(target), legacySessionCodec.encode(record(target, `canonical-${userId}`)))
  }
  await redis.set(legacySessionKey(address('1').scope), legacyRaw('1'))
  await redis.set(legacySessionKey(address('4').scope), legacyRaw('4'))
  await redis.set(legacySessionKey(address('5').scope), '{')

  const summaries = []
  for await (const summary of store(redis).list({ botId: '10000' }, { limit: 4 })) {
    summaries.push(summary)
  }

  assert.equal(summaries.length, 4)
  assert.deepEqual(summaries.map(summary => summary.source), [
    'canonical', 'canonical', 'canonical', 'legacy'
  ])
  assert.equal(redis.scanCalls.every(call => call.COUNT === 2), true)
})

test('deleteAll deletes both namespaces with bounded SCAN pages', async () => {
  const redis = new FakeRedis()
  for (const userId of ['1', '2', '3']) {
    const target = address(userId)
    await redis.set(canonicalSessionKey(target), legacySessionCodec.encode(record(target, `canonical-${userId}`)))
  }
  await redis.set(legacySessionKey(address('4').scope), legacyRaw('4'))
  await redis.set(legacySessionKey(address('5').scope), legacyRaw('5'))

  assert.equal(await store(redis).deleteAll({ botId: '10000' }), 5)
  assert.equal((await redis.scan(0, { MATCH: 'GROUPMATE:SESSION:v1:*', COUNT: 100 })).keys.length, 0)
  assert.equal((await redis.scan(0, { MATCH: 'CHATGPT:CONVERSATIONS:*', COUNT: 100 })).keys.length, 0)
  assert.equal(redis.scanCalls.slice(0, -2).every(call => call.COUNT === 2), true)
})

test('fork creates an independent session and leaves the source unchanged', async () => {
  const redis = new FakeRedis()
  const source = address('7')
  const target = address('8')
  await redis.set(canonicalSessionKey(source), legacySessionCodec.encode(record(source, 'source-session')))

  const forked = await store(redis, () => 'fork-session').fork(
    source,
    target,
    { userId: '8', displayName: 'target' }
  )

  assert.equal(forked.sessionId, 'fork-session')
  assert.equal((await store(redis).get(source))?.sessionId, 'source-session')
  assert.equal((await store(redis).get(target))?.sessionId, 'fork-session')
  assert.notEqual(forked.state, (await store(redis).get(source))?.state)
})

test('pre-aborted signals cancel Redis session operations', async () => {
  const redis = new FakeRedis()
  const controller = new AbortController()
  controller.abort()
  const sessionStore = store(redis)

  await assert.rejects(sessionStore.get(address('7'), { signal: controller.signal }), (error: unknown) => {
    return error instanceof AgentError && error.code === 'cancelled'
  })
  await assert.rejects(async () => {
    for await (const _summary of sessionStore.list({ botId: '10000' }, { signal: controller.signal })) {
      // The iterator must fail before yielding.
    }
  }, (error: unknown) => error instanceof AgentError && error.code === 'cancelled')
})
