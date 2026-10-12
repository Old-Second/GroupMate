import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore, ACTIVITY_LIMITS, decodeActivityData, type ActivityRedisClient, type GroupActivity } from '../../src/runtime/activities/ActivityStore.js'
import { GroupActivityService, activityNotification } from '../../src/runtime/activities/GroupActivityService.js'
import { ActivityWorker, type ActivityDispatchLease } from '../../src/runtime/activities/ActivityWorker.js'
import { createGroupPollTool, createScheduledTaskTool } from '../../src/tools/GroupActivityTool.js'
import type { AuthorizedToolContext, ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import { ToolPolicyEngine } from '../../src/agent/tools/policy-engine.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import { extractIntentEvidence } from '../../src/runtime/tools/intent-evidence.js'
import { toolAvailableInScene } from '../../src/runtime/tools/tool-availability.js'

class MemoryRedis implements ActivityRedisClient {
  raw: string | null = null
  commits = 0
  failAfterCommit = false
  async get (): Promise<string | null> { return this.raw }
  async eval (_script: string, input: { keys: string[]; arguments: string[] }): Promise<number> {
    if ((this.raw ?? '') !== input.arguments[0]) return 0
    this.raw = input.arguments[1]
    this.commits++
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('lost receipt') }
    return 1
  }
}
const facts: ToolRuntimeFacts = { botId: '10000', actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' }, scope: { kind: 'group', groupId: '9' },
  actorGroupRole: 'member', botGroupRole: 'member', targetRole: 'none', targetExists: true, targetIsBotMaster: false }
const signal = new AbortController().signal
const poll = { operation: 'create', id: '', title: '聚餐时间', options: ['周五', '周六'], choices: [], closesAt: '', timeZone: 'Asia/Shanghai', multiple: false }
const reminder = { operation: 'create', id: '', text: '记得喝水', at: '', timeZone: 'Asia/Shanghai', delaySeconds: 10, intervalSeconds: 0, occurrences: 1 }
function fixture () {
  let clock = Date.UTC(2026, 9, 12)
  const redis = new MemoryRedis()
  const store = new ActivityStore(redis)
  const service = new GroupActivityService(store, () => clock)
  const perform = async (kind: GroupActivity['kind'], input: Record<string, unknown>, current = facts, request = 'run1'): Promise<any> => await service.perform(kind, input, current, request, signal)
  const created = async (input = reminder): Promise<string> => (await perform('reminder', input)).id
  return { redis, store, service, perform, created, now: () => clock, advance: (ms: number) => { clock += ms } }
}
function worker (f: ReturnType<typeof fixture>, options: Partial<ActivityDispatchLease> = {}) {
  const messages: string[] = []
  let released = 0
  const create = (): ActivityWorker => new ActivityWorker({ store: f.store, now: f.now, acquire: async () => ({
    authorize: async () => 'allowed', deliver: async text => { messages.push(text); return 'sent' },
    release: async () => { released++ }, ...options }) })
  return { create, messages, releases: () => released }
}
test('group tools have strict schemas, explicit-intent gates and no private or disabled discovery', () => {
  const f = fixture()
  const tools = [createGroupPollTool(f.service), createScheduledTaskTool(f.service)]
  new ToolRegistry(tools)
  const policy = new ToolPolicyEngine()
  for (const definition of tools) {
    assert.equal(toolAvailableInScene(definition, facts, []), true)
    assert.equal(toolAvailableInScene(definition, facts, [definition.name]), false)
    assert.equal(toolAvailableInScene(definition, { ...facts, channel: { kind: 'private', botId: '10000', userId: '7' } }, []), false)
    const input = definition.name === 'groupPoll' ? poll : reminder
    const base = { profile: 'compatible' as const, definition, input, facts, target: { kind: 'group' as const, groupId: '9' } }
    assert.equal(policy.decide({ ...base, intent: extractIntentEvidence({ text: '你好', mentions: [], reply: null }) }).kind, 'deny')
    const intent = extractIntentEvidence({ text: definition.name === 'groupPoll' ? '发起聚餐投票' : '10秒后提醒我喝水', mentions: [], reply: null })
    assert.equal(policy.decide({ ...base, intent }).kind, 'allow')
    assert.equal(policy.decide({ ...base, profile: 'strict', intent }).kind, 'approval_required')
    assert.equal(policy.decide({ ...base, input: { operation: 'list' }, profile: 'strict', intent }).kind, 'allow')
  }
})
test('questions about tools and cancellation requests cannot authorize creation or a different poll mutation', () => {
  const f = fixture()
  const policy = new ToolPolicyEngine()
  for (const definition of [createGroupPollTool(f.service), createScheduledTaskTool(f.service)]) {
    const base = { profile: 'compatible' as const, definition, facts, target: { kind: 'group' as const, groupId: '9' } }
    for (const text of ['解释一下你的提醒和投票功能', definition.name === 'groupPoll' ? '取消投票abc' : '取消定时任务abc，不要再提醒']) {
      const intent = extractIntentEvidence({ text, mentions: [], reply: null })
      assert.equal(policy.decide({ ...base, input: { operation: 'create' }, intent }).kind, 'deny')
    }
  }
  const intent = extractIntentEvidence({ text: '给投票abc投票，我选2', mentions: [], reply: null })
  const definition = createGroupPollTool(f.service)
  const base = { profile: 'compatible' as const, definition, facts, target: { kind: 'group' as const, groupId: '9' }, intent }
  assert.equal(policy.decide({ ...base, input: { operation: 'vote' } }).kind, 'allow')
  assert.equal(policy.decide({ ...base, input: { operation: 'close' } }).kind, 'deny')
})
test('votes are one per actor, replaceable, retractable and only aggregate counts are returned', async () => {
  const f = fixture()
  const id = (await f.perform('poll', poll)).id
  const vote = { ...poll, operation: 'vote', id, choices: [1] }
  const result = await f.perform('poll', vote)
  assert.equal(result.voters, 1)
  assert.deepEqual(result.options.map((o: any) => o.votes), [1, 0])
  await f.perform('poll', { ...vote, choices: [2] })
  assert.deepEqual((await f.perform('poll', { ...vote, operation: 'status' })).options.map((o: any) => o.votes), [0, 1])
  assert.equal((await f.perform('poll', { ...vote, operation: 'retract' })).voters, 0)
  assert.equal(JSON.stringify(result).includes('ownerId'), false)
  assert.equal(JSON.stringify(result).includes('botId'), false)
})
test('simultaneous votes and duplicate creation do not lose updates', async () => {
  const f = fixture()
  const [one, two] = await Promise.all([f.perform('poll', poll), f.perform('poll', { ...poll, id: 'unused', offset: 4, choices: [2] })])
  assert.equal(one.id, two.id)
  await Promise.all(['7', '8', '10', '11'].map(userId => f.perform('poll', { ...poll, operation: 'vote', id: one.id, choices: [1] },
    { ...facts, actor: { ...facts.actor, userId } })))
  assert.equal((await f.perform('poll', { ...poll, operation: 'status', id: one.id })).voters, 4)
})
test('single and multiple choices validate counts, range and duplicate options', async () => {
  const f = fixture()
  const id = (await f.perform('poll', poll)).id
  for (const choices of [[1, 2], [0], [3], [], [1.5]]) await assert.rejects(f.perform('poll', { ...poll, id, operation: 'vote', choices }), TypeError)
  await assert.rejects(f.perform('poll', { ...poll, options: ['甲', '甲'] }), /重复/)
  const multi = (await f.perform('poll', { ...poll, multiple: true })).id
  assert.equal((await f.perform('poll', { ...poll, id: multi, operation: 'vote', choices: [1, 2] })).voters, 1)
  await assert.rejects(f.perform('poll', { ...poll, id: multi, operation: 'vote', choices: [1, 1] }), /重复/)
})
test('cross-group, cross-bot, private and nonmember access is rejected; only creator or current admin cancels', async () => {
  const f = fixture()
  const id = (await f.perform('poll', poll)).id
  const cancel = { ...poll, operation: 'cancel', id }
  await assert.rejects(f.perform('poll', cancel, { ...facts, channel: { ...facts.channel, kind: 'group', groupId: 'other' } }), /没有/)
  await assert.rejects(f.perform('poll', cancel, { ...facts, botId: '20000' }), /没有/)
  await assert.rejects(f.perform('poll', cancel, { ...facts, actorGroupRole: 'none' }), /现有成员/)
  await assert.rejects(f.perform('poll', cancel, { ...facts, actor: { ...facts.actor, userId: '8' } }), /发起人/)
  assert.equal((await f.perform('poll', cancel, { ...facts, actorGroupRole: 'admin', actor: { ...facts.actor, userId: '8' } })).state, 'cancelled')
  await assert.rejects(f.perform('poll', { ...cancel, operation: 'vote', choices: [1] }), /截止或取消/)
})
test('reminder list and status are private to its creator and current administrators', async () => {
  const f = fixture()
  const id = await f.created()
  const other = { ...facts, actor: { ...facts.actor, userId: '8' } }
  assert.equal((await f.perform('reminder', { operation: 'list' }, other)).activities.length, 0)
  await assert.rejects(f.perform('reminder', { operation: 'status', id }, other), /没有/)
})
test('poll deadline closes voting before a delayed worker runs and only one summary is sent', async () => {
  const f = fixture()
  const id = (await f.perform('poll', { ...poll, closesAt: '2026-10-12T00:00:10Z' })).id
  await f.perform('poll', { ...poll, id, operation: 'vote', choices: [2] })
  f.advance(10000)
  await assert.rejects(f.perform('poll', { ...poll, id, operation: 'vote', choices: [1] }), /截止/)
  const w = worker(f)
  assert.equal(await w.create().tick(), 1)
  assert.equal(await w.create().tick(), 0)
  assert.match(w.messages[0], /周六：1 票/)
})
test('manual poll closure uses the same durable scheduled dispatch and cancellation suppresses notification', async () => {
  const f = fixture()
  const id = (await f.perform('poll', poll)).id
  await f.perform('poll', { ...poll, id, operation: 'close' })
  const w = worker(f)
  assert.equal(await w.create().tick(), 1)
  const next = (await f.perform('poll', { ...poll, title: '游戏' })).id
  await f.perform('poll', { ...poll, id: next, operation: 'cancel' })
  assert.equal(await w.create().tick(), 0)
})
test('future reminder survives a new worker and concurrent workers claim exactly once', async () => {
  const f = fixture()
  await f.created()
  const w = worker(f)
  assert.equal(await w.create().tick(), 0)
  f.advance(10000)
  const result = await Promise.all([w.create().tick(), w.create().tick()])
  assert.equal(result.reduce((a, b) => a + b), 1)
  assert.equal(w.messages.length, 1)
  assert.equal(w.releases(), 1)
})
test('cancel racing with membership authorization prevents the first dispatch', async () => {
  const f = fixture()
  const id = await f.created()
  f.advance(10000)
  const w = worker(f, { authorize: async () => { await f.perform('reminder', { operation: 'cancel', id }); return 'allowed' } })
  assert.equal(await w.create().tick(), 0)
  assert.equal(w.messages.length, 0)
  assert.equal((await f.store.read()).records[0].state, 'cancelled')
})
test('completed one-time and final recurring notifications have zero future occurrences', async () => {
  for (const occurrences of [1, 2]) {
    const f = fixture()
    const id = await f.created({ ...reminder, intervalSeconds: occurrences === 1 ? 0 : 60, occurrences })
    f.advance(10000)
    const w = worker(f)
    assert.equal(await w.create().tick(), 1)
    if (occurrences === 2) {
      const first = await f.perform('reminder', { operation: 'status', id })
      assert.equal(first.state, 'pending')
      assert.equal(first.remaining, 1)
      f.advance(60000)
      assert.equal(await w.create().tick(), 1)
    }
    const summary = await f.perform('reminder', { operation: 'status', id })
    assert.equal(summary.state, 'completed')
    assert.equal(summary.remaining, 0)
    assert.equal((await f.store.read()).records[0].remaining, 0)
    assert.equal(await w.create().tick(), 0)
    assert.equal(w.messages.length, occurrences)
  }
})
test('older terminal snapshots do not show pending countdowns or future occurrences', async () => {
  const f = fixture()
  const id = await f.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  for (const state of ['completed', 'cancelled', 'expired', 'failed', 'indeterminate'] as const) {
    await f.store.update(data => { data.records[0].state = state })
    const summary = await f.perform('reminder', { operation: 'status', id })
    assert.equal(summary.remaining, 0)
    assert.equal(summary.secondsLeft, 0)
    const list = await f.perform('reminder', { operation: 'list' })
    assert.equal(list.activities[0].remaining, 0)
  }
})
test('cancel during send does not promise recall and suppresses every later recurrence', async () => {
  const f = fixture()
  const id = await f.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  f.advance(10000)
  const w = worker(f, { deliver: async () => { const result = await f.perform('reminder', { operation: 'cancel', id }); assert.match(result.notice, /不能撤回/); return 'sent' } })
  assert.equal(await w.create().tick(), 1)
  f.advance(60000)
  assert.equal(await w.create().tick(), 0)
  assert.equal((await f.store.read()).records[0].state, 'cancelled')
})
test('unconfirmed receipt and exceptions after dispatch never repeat, including across restart', async () => {
  for (const deliver of [async () => 'outcome_unknown' as const, async (): Promise<never> => { throw new Error('receipt lost') }]) {
    const f = fixture()
    await f.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
    f.advance(10000)
    assert.equal(await worker(f, { deliver }).create().tick(), 0)
    assert.equal((await f.store.read()).records[0].state, 'indeterminate')
    f.advance(600000)
    assert.equal(await worker(f).create().tick(), 0)
  }
})
test('expired pre-dispatch claims recover, persisted dispatches become unknown and are never replayed', async () => {
  for (const state of ['claimed', 'dispatching'] as const) {
    const f = fixture()
    await f.created()
    await f.store.update(data => { data.records[0].state = state; data.records[0].token = 'a'.repeat(32); data.records[0].leaseUntil = f.now() + 1000 })
    f.advance(10000)
    const w = worker(f)
    assert.equal(await w.create().tick(), state === 'claimed' ? 1 : 0)
    assert.equal((await f.store.read()).records[0].state, state === 'claimed' ? 'completed' : 'indeterminate')
  }
})
test('CAS transport failure after dispatch marker persists unknown and sends nothing', async () => {
  const f = fixture()
  await f.created()
  f.advance(10000)
  const w = worker(f, { authorize: async () => { f.redis.failAfterCommit = true; return 'allowed' } })
  assert.equal(await w.create().tick(), 0)
  assert.equal(w.messages.length, 0)
  assert.equal((await f.store.read()).records[0].state, 'indeterminate')
})
test('temporary authority failure defers; revocation cancels with zero sends', async () => {
  const f = fixture()
  await f.created()
  f.advance(10000)
  assert.equal(await worker(f, { authorize: async () => 'unavailable' }).create().tick(), 0)
  assert.equal((await f.store.read()).records[0].state, 'pending')
  assert.equal(await worker(f, { authorize: async () => 'revoked' }).create().tick(), 0)
  assert.equal((await f.store.read()).records[0].state, 'cancelled')
})
test('repeat recovery skips accumulated occurrences and reminders older than one day expire', async () => {
  const f = fixture()
  await f.created({ ...reminder, intervalSeconds: 60, occurrences: 5 })
  f.advance(10_000 + 120000)
  const w = worker(f)
  assert.equal(await w.create().tick(), 1)
  const next = (await f.store.read()).records[0]
  assert.equal(next.remaining, 2)
  assert.equal(next.dueAt, f.now() + 60000)
  f.advance(86400000 + 60001)
  assert.equal(await w.create().tick(), 0)
  assert.equal((await f.store.read()).records[0].state, 'expired')
})
test('resource bounds reject overlong or excessive tasks and clean only expired terminal records', async () => {
  const f = fixture()
  for (const input of [{ ...reminder, delaySeconds: 0 }, { ...reminder, at: '2026-10-12T00:00:10Z' },
    { ...reminder, occurrences: 31 }, { ...reminder, intervalSeconds: 1, occurrences: 2 },
    { ...reminder, text: 'x'.repeat(501) }]) await assert.rejects(f.perform('reminder', input), TypeError)
  for (let index = 0; index < ACTIVITY_LIMITS.perActor; index++) await f.created({ ...reminder, text: `test${index}` })
  await assert.rejects(f.created({ ...reminder, text: 'excess' }), /容量/)
  assert.throws(() => decodeActivityData('x'.repeat(ACTIVITY_LIMITS.bytes + 1)), /budget/)
  assert.throws(() => decodeActivityData('{"schemaVersion":2,"records":[]}'), /invalid/)
  const first = (await f.store.read()).records[0]
  await f.perform('reminder', { operation: 'cancel', id: first.id })
  f.advance(ACTIVITY_LIMITS.retentionMs)
  await f.perform('reminder', { operation: 'list' })
  assert.equal((await f.store.read()).records.some(r => r.id === first.id), false)
})
test('storage confirmation loss is visible as unknown to the caller and the created id can be found', async () => {
  const f = fixture()
  f.redis.failAfterCommit = true
  const context = { runId: 'run', facts, signal } as AuthorizedToolContext
  const result = await createScheduledTaskTool(f.service).execute(reminder, context)
  assert.equal(result.status, 'indeterminate')
  assert.equal((await f.perform('reminder', { operation: 'list' })).activities.length, 1)
})
test('immutable cached reads are invalidated by another writer and cannot mutate durable authority', async () => {
  const f = fixture()
  const id = await f.created()
  const first = await f.store.read()
  assert.equal(await f.store.read(), first)
  assert.throws(() => { first.records[0].state = 'completed' }, TypeError)
  const other = new GroupActivityService(new ActivityStore(f.redis), f.now)
  await other.perform('reminder', { operation: 'cancel', id }, facts, 'other', signal)
  const second = await f.store.read()
  assert.notEqual(second, first)
  assert.equal(second.records[0].state, 'cancelled')
})
test('activity lists are paginated and only a fresh actor may fill or change their own ballot', async () => {
  const f = fixture()
  for (let index = 0; index < 5; index++) await f.created({ ...reminder, text: `页${index}` })
  const page = await f.perform('reminder', { operation: 'list', offset: 0 })
  assert.equal(page.activities.length, 4)
  assert.equal(page.total, 5)
  assert.equal(page.nextOffset, 4)
  assert.equal((await f.perform('reminder', { operation: 'list', offset: 4 })).activities.length, 1)
  const id = (await f.perform('poll', poll)).id
  for (let index = 0; index < 100; index++) await f.perform('poll', { ...poll, operation: 'vote', id, choices: [1] },
    { ...facts, actor: { ...facts.actor, userId: String(100 + index) } })
  await assert.rejects(f.perform('poll', { ...poll, operation: 'vote', id, choices: [1] }), /100/)
  assert.equal((await f.perform('poll', { ...poll, operation: 'vote', id, choices: [2] },
    { ...facts, actor: { ...facts.actor, userId: '100' } })).voters, 100)
})
test('closing a worker aborts owned dispatch, clears the timer and never starts future work', async () => {
  const f = fixture()
  await f.created()
  const w = worker(f).create()
  w.start()
  await w.close()
  f.advance(10000)
  assert.equal(await w.tick(), 0)
})
