import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextItem } from '../../src/agent/context/context-item.js'
import { currentGroupMember } from '../../src/runtime/CurrentGroupMember.js'
import { memoryContextBoundary } from '../../src/runtime/MemoryContextBoundary.js'
import { captureMemoryContextProof, provenMemoryContextBoundary } from '../../src/runtime/MemoryContextBoundary.js'
import { parseContextDependencyProof } from '../../src/agent/context/ContextDependency.js'
import { captureSceneDependency, sceneBoundary, invalidateGroupScene } from '../../src/runtime/SceneBoundary.js'
import { bindRunBoundaryGuard, runBoundaryGuard, transferRunBoundaryGuard } from '../../src/agent/run/RunBoundary.js'

const signal = new AbortController().signal
const record = { namespaceRef: 'a'.repeat(64), memoryId: 'memory:test', revision: 1, revisionHash: 'b'.repeat(64) }
const memory = { memoryRecord: record } as ContextItem

test('current group authority reads no-cache RPC and ignores cached admin roles', async () => {
  const calls: unknown[] = []
  const bot = { getMemberMap: () => new Map([[7, { role: 'admin' }]]),
    sendApi: async (action: string, params: unknown) => {
      calls.push([action, params])
      return { status: 'ok', retcode: 0, data: { user_id: 7, group_id: 8, role: 'member', join_time: 123 } }
    } }
  assert.deepEqual(await currentGroupMember(bot, '8', '7', signal), { userId: '7', role: 'member', joinedAt: 123 })
  assert.deepEqual(calls, [['get_group_member_info', { group_id: 8, user_id: 7, no_cache: true }]])
})

test('an absent member or wrong identity cannot fall back to cached authority', async () => {
  let fallbacks = 0
  for (const raw of [{ status: 'failed', retcode: 1200 }, { user_id: 9, role: 'admin' },
    { user_id: 7, group_id: 9, role: 'owner' }, { user_id: 7, role: 'unknown' }]) {
    assert.equal(await currentGroupMember({ sendApi: async () => raw,
      getGroupMemberInfo: () => { fallbacks++; return { user_id: 7, role: 'admin' } } }, '8', '7', signal), null)
  }
  assert.equal(fallbacks, 0)
})

test('member refresh aborts a hanging lookup without accepting a late result', async () => {
  const controller = new AbortController()
  const result = currentGroupMember({ sendApi: async () => await new Promise(() => {}) }, '8', '7', controller.signal)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
})

test('all boundaries reject disappeared, corrected or isolated memory dependencies', async () => {
  let current = [memory]
  const guard = memoryContextBoundary([memory], async () => current)
  for (const boundary of ['provider', 'tool', 'response', 'final'] as const) {
    await guard(boundary, signal)
    for (const change of [{ ...record, revision: 2 }, { ...record, revisionHash: 'c'.repeat(64) },
      { ...record, namespaceRef: 'd'.repeat(64) }, { ...record, memoryId: 'memory:other' }]) {
      current = [{ memoryRecord: change } as ContextItem]
      await assert.rejects(guard(boundary, signal), { code: 'authorization_changed' })
    }
    current = []
    await assert.rejects(guard(boundary, signal), { code: 'authorization_changed' })
    current = [memory]
  }
})

test('unavailable dependency authority fails closed while empty context has zero lookups', async () => {
  await assert.rejects(memoryContextBoundary([memory], async () => { throw new Error('private error') })('provider', signal),
    { code: 'authorization_changed', message: '当前资料或权限已发生变化，请重新提问。' })
  let queries = 0
  await memoryContextBoundary([], async () => { queries++; return [] })('final', signal)
  assert.equal(queries, 0)
})

test('final authority survives explicit projection but serialized data never acquires a guard', () => {
  const guard = async () => {}
  const source = bindRunBoundaryGuard({ kind: 'completed' }, guard)
  assert.equal(runBoundaryGuard(transferRunBoundaryGuard(source, { kind: 'completed' })), guard)
  assert.equal(runBoundaryGuard(JSON.parse(JSON.stringify(source))), undefined)
})

test('persisted memory proof keeps inherited dependencies and detects policy disable/re-enable', async () => {
  let stamp = 'f'.repeat(64)
  const authority = async () => stamp
  const prior = await captureMemoryContextProof([memory], authority, signal)
  const next = await captureMemoryContextProof([], authority, signal, prior)
  const restored = parseContextDependencyProof(JSON.parse(JSON.stringify(next)))
  const guard = provenMemoryContextBoundary(restored, authority)
  await guard('provider', signal)
  stamp = 'e'.repeat(64)
  await assert.rejects(guard('final', signal), { code: 'authorization_changed' })
  assert.equal(restored.memories.length, 1)
  assert.throws(() => parseContextDependencyProof({ ...restored, memories: [record, record] }))
  assert.throws(() => parseContextDependencyProof({ ...restored, authorityStamp: 'invalid' }))
})

test('scene notices, authoritative departure and rejoin invalidate all later boundaries', async () => {
  let joined = 100
  let present = true
  const bot = { getGroupMemberInfo: async (_group: unknown, user: unknown, noCache: boolean) => {
    assert.equal(noCache, true)
    return present ? { user_id: user, role: 'member', join_time: joined } : null
  } }
  const scene = await captureSceneDependency(bot, '1', '2', '3', signal)
  const guard = sceneBoundary(bot, scene)
  await guard('provider', signal)
  joined++
  await assert.rejects(guard('response', signal), { code: 'authorization_changed' })
  joined--
  present = false
  await assert.rejects(guard('final', signal), { code: 'authorization_changed' })
  present = true
  invalidateGroupScene('1', '2')
  await assert.rejects(guard('tool', signal), { code: 'authorization_changed' })
  await sceneBoundary(bot, await captureSceneDependency(bot, '1', '2', '3', signal))('provider', signal)
})
