import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { ActivityStore, ACTIVITY_LIMITS, decodeActivityData, type ActivityData, type ActivityRedisClient, type GroupActivity } from '../../src/runtime/activities/ActivityStore.js'
import { GroupActivityService, activityNotification, type ActivityRecipientLookup } from '../../src/runtime/activities/GroupActivityService.js'
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
const reminder = { operation: 'create', id: '', text: '记得喝水', at: '', timeZone: 'Asia/Shanghai', delaySeconds: 10, intervalSeconds: 0, occurrences: 1, notifyTargets: [] as string[] }
function fixture () {
  let clock = Date.UTC(2026, 9, 12)
  const redis = new MemoryRedis()
  const store = new ActivityStore(redis)
  const service = new GroupActivityService(store, () => clock)
  const members = new Map([['7', { nickname: '小甲', card: '甲' }], ['8', { nickname: '小乙', card: '乙' }], ['10', { nickname: '重名', card: '甲' }]])
  const recipients: ActivityRecipientLookup = { members: async () => members,
    current: async id => members.has(id) ? { joinedAt: Math.floor(clock / 1000) - 100 } : null }
  const perform = async (kind: GroupActivity['kind'], input: Record<string, unknown>, current = facts, request = 'run1'): Promise<any> => await service.perform(kind, input, current, request, signal, recipients)
  const created = async (input = reminder): Promise<string> => (await perform('reminder', input)).id
  return { redis, store, service, recipients, members, perform, created, now: () => clock, advance: (ms: number) => { clock += ms } }
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
test('notification wording authorizes scheduling but a negated notification does not', () => {
  const definition = createScheduledTaskTool(fixture().service)
  const base = { profile: 'compatible' as const, definition, facts, input: reminder, target: { kind: 'group' as const, groupId: '9' } }
  for (const [text, expected] of [['30秒后通知小乙开会', 'allow'], ['30秒后不要通知小乙开会', 'deny'], ['通知功能怎么用', 'deny']]) {
    assert.equal(new ToolPolicyEngine().decide({ ...base, intent: extractIntentEvidence({ text, mentions: [], reply: null }) }).kind, expected)
  }
})
test('self, numeric IDs and unique names become deduplicated durable notification targets across restart', async () => {
  const f = fixture()
  const input = { ...reminder, notifyTargets: ['self', '8', '小乙'] }
  const id = await f.created(input)
  assert.deepEqual((await f.perform('reminder', { operation: 'status', id })).notifyUserIds, ['7', '8'])
  const restarted = new ActivityStore(f.redis)
  assert.deepEqual((await restarted.read()).records[0].notifyUserIds, ['7', '8'])
  const ids = (await restarted.read()).records[0].notifyUserIds!
  assert.throws(() => ids.push('11'), TypeError)
  const same = await f.created({ ...reminder, notifyTargets: ['小乙', '7'] })
  assert.equal(same, id)
  assert.notEqual(await f.created({ ...reminder, notifyTargets: ['self'] }), id)
  assert.notEqual(await f.created(), id)
})
test('ambiguous, missing, bot, all and excessive recipients are rejected before writing', async () => {
  const f = fixture()
  for (const notifyTargets of [['甲'], ['不存在'], ['10000'], ['all'], ['0'], ['99'], Array(9).fill('7'), ['']]) {
    await assert.rejects(f.perform('reminder', { ...reminder, notifyTargets }), TypeError)
    assert.equal(f.redis.raw, null)
  }
  await assert.rejects(f.service.perform('reminder', { ...reminder, notifyTargets: ['self'] }, facts, 'no-port', signal), /无法核验/)
  assert.equal(f.redis.raw, null)
})
test('the scheduled tool forwards its recipient lookup and errors cannot create a partial task', async () => {
  const f = fixture()
  const context = { runId: 'run', facts, signal } as AuthorizedToolContext
  const tool = createScheduledTaskTool(f.service, () => f.recipients)
  assert.ok('type' in tool.inputSchema && tool.inputSchema.type === 'object')
  if ('type' in tool.inputSchema && tool.inputSchema.type === 'object') assert.ok(tool.inputSchema.required.includes('notifyTargets'))
  assert.equal((await tool.execute({ ...reminder, notifyTargets: ['小乙'] }, context)).status, 'success')
  assert.deepEqual((await f.store.read()).records[0].notifyUserIds, ['8'])
  assert.equal((await tool.execute({ ...reminder, notifyTargets: ['甲'] }, context)).status, 'denied')
  assert.equal((await f.store.read()).records.length, 1)
})
test('legacy records stay text-only and invalid durable targets never become notification atoms', async () => {
  const f = fixture()
  await f.created()
  await f.store.update(data => { delete data.records[0].notifyUserIds })
  const raw = f.redis.raw!
  assert.equal(decodeActivityData(raw).records[0].notifyUserIds, undefined)
  for (const notifyUserIds of [['all'], ['0'], ['7', '7'], ['10000'], Array(9).fill('8'), [8]]) {
    const data = JSON.parse(raw)
    data.records[0].notifyUserIds = notifyUserIds
    assert.throws(() => decodeActivityData(JSON.stringify(data)), /invalid/)
  }
  assert.deepEqual((await f.perform('reminder', { operation: 'list' })).activities[0].notifyUserIds, [])
})
test('reminder and poll notifications separate title, body, results and actionable IDs', async () => {
  const f = fixture()
  const id = await f.created({ ...reminder, text: '第一行\n第二行' })
  const r = (await f.store.read()).records[0]
  assert.equal(activityNotification(r), `⏰ 定时提醒\n\n第一行\n第二行\n\n任务编号：${id}`)
  assert.match(activityNotification({ ...r, intervalMs: 60000 }), /^⏰ 重复提醒\n\n/)
  const pollId = (await f.perform('poll', poll)).id
  await f.perform('poll', { operation: 'vote', id: pollId, choices: [2] })
  assert.equal(activityNotification((await f.store.read()).records[1]),
    `📊 投票结果\n\n聚餐时间\n\n1. 周五：0 票\n2. 周六：1 票\n\n参与 1 人 · 单选\n投票编号：${pollId}`)
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
test('a settled poll leaves no future occurrences in its durable record or in either projection', async () => {
  const f = fixture()
  const id = (await f.perform('poll', { ...poll, closesAt: '2026-10-12T00:00:10Z' })).id
  assert.equal((await f.store.read()).records[0].remaining, 1)
  f.advance(10000)
  const w = worker(f)
  assert.equal(await w.create().tick(), 1)
  const record = (await f.store.read()).records[0]
  assert.equal(record.state, 'completed')
  assert.equal(record.remaining, 0)
  const summary = await f.perform('poll', { ...poll, id, operation: 'status' })
  assert.equal(summary.remaining, 0)
  assert.equal(summary.secondsLeft, 0)
  assert.equal((await f.perform('poll', { ...poll, operation: 'list' })).activities[0].remaining, 0)
})
test('leaving an active state zeroes the pending count while a recoverable one keeps it', async () => {
  const unknown = fixture()
  await unknown.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  await unknown.store.update(data => { data.records[0].state = 'dispatching'; data.records[0].token = 'a'.repeat(32); data.records[0].leaseUntil = unknown.now() + 1000 })
  unknown.advance(10000)
  assert.equal(await worker(unknown).create().tick(), 0)
  assert.deepEqual([(await unknown.store.read()).records[0].state, (await unknown.store.read()).records[0].remaining], ['indeterminate', 0])

  const stale = fixture()
  await stale.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  stale.advance(10000 + 86400001)
  assert.equal(await worker(stale).create().tick(), 0)
  assert.deepEqual([(await stale.store.read()).records[0].state, (await stale.store.read()).records[0].remaining], ['expired', 0])

  const deferred = fixture()
  await deferred.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  deferred.advance(10000)
  assert.equal(await worker(deferred, { authorize: async () => 'unavailable' }).create().tick(), 0)
  assert.deepEqual([(await deferred.store.read()).records[0].state, (await deferred.store.read()).records[0].remaining], ['pending', 3])
})
test('cancelling during send zeroes the pending count before the dispatch is finalized', async () => {
  const f = fixture()
  const id = await f.created({ ...reminder, intervalSeconds: 60, occurrences: 3 })
  f.advance(10000)
  let duringSend: number | undefined
  const w = worker(f, { deliver: async (text: string) => {
    await f.perform('reminder', { operation: 'cancel', id })
    duringSend = (await f.store.read()).records[0].remaining
    assert.match(text, /记得喝水/)
    return 'sent'
  } })
  assert.equal(await w.create().tick(), 1)
  assert.equal(duringSend, 0)
  const record = (await f.store.read()).records[0]
  assert.equal(record.state, 'cancelled')
  assert.equal(record.remaining, 0)
  assert.equal((await f.perform('reminder', { operation: 'status', id })).remaining, 0)
})
test('an absolute local due time notifies once and reaches the same zeroed terminal state', async () => {
  const f = fixture()
  const id = await f.created({ ...reminder, delaySeconds: 0, at: '2026-10-12T08:00:30' })
  const w = worker(f)
  assert.equal(await w.create().tick(), 0)
  f.advance(30000)
  assert.equal(await w.create().tick(), 1)
  assert.match(w.messages[0], /记得喝水/)
  const summary = await f.perform('reminder', { operation: 'status', id })
  assert.equal(summary.state, 'completed')
  assert.equal(summary.remaining, 0)
  assert.equal((await f.store.read()).records[0].remaining, 0)
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
test('acknowledged CAS snapshots cannot be mutated through a returned alias', async () => {
  const f = fixture()
  await f.created({ ...reminder, notifyTargets: ['self'] })
  const committed = await f.store.update(data => { data.records[0].content = '新正文'; return data.records[0] })
  assert.throws(() => { committed.content = '篡改' }, TypeError)
  assert.throws(() => committed.notifyUserIds!.push('8'), TypeError)
  assert.equal((await f.store.read()).records[0].content, '新正文')
  assert.deepEqual(JSON.parse(f.redis.raw!).records[0].notifyUserIds, ['7'])
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

/**
 * The dispatch signal used to be `AbortSignal.any([<worker lifetime>, AbortSignal.timeout(...)])`,
 * which left about 2.2 KiB of live heap per dispatch registered against the worker-lifetime
 * signal. It is now a per-dispatch controller released when the dispatch returns, so these fix
 * both halves of the contract: everything that used to be cancelled still is, and nothing new is.
 */

/** `#run` hands the worker-lifetime signal to the due-selection CAS, the only place it is observable. */
function observeWorkerSignal (f: ReturnType<typeof fixture>): () => AbortSignal {
  const seen: AbortSignal[] = []
  const update = f.store.update.bind(f.store)
  Object.defineProperty(f.store, 'update', {
    configurable: true,
    value: async (mutate: (data: ActivityData) => unknown, signal?: AbortSignal): Promise<unknown> => {
      if (signal !== undefined && !seen.includes(signal)) seen.push(signal)
      return await update(mutate, signal)
    }
  })
  return () => seen[0]
}
test('an in-flight dispatch holds one scoped registration and closing the worker still aborts it', async () => {
  const f = fixture()
  await f.created()
  f.advance(10000)
  const workerSignal = observeWorkerSignal(f)
  let captured: AbortSignal | null = null
  let admit = (): void => {}
  let arrive = (): void => {}
  const gate = new Promise<void>(resolve => { admit = resolve })
  const arrived = new Promise<void>(resolve => { arrive = resolve })
  const w = new ActivityWorker({ store: f.store, now: f.now, acquire: async (_record, signal) => {
    captured = signal
    arrive()
    await gate
    return { authorize: async () => 'allowed', deliver: async () => 'sent', release: async () => undefined }
  } })
  const running = w.tick()
  await arrived
  assert.equal(getEventListeners(workerSignal(), 'abort').length, 1)
  assert.equal(captured!.aborted, false)
  const closing = w.close()
  assert.equal(captured!.aborted, true)
  assert.equal((captured!.reason as Error).name, 'AbortError')
  admit()
  assert.equal(await running, 0)
  await closing
  assert.equal(getEventListeners(workerSignal(), 'abort').length, 0)
  assert.equal((await f.store.read()).records[0].state, 'pending')
})
test('the dispatch budget aborts only its own dispatch and the next dispatch starts clean', async () => {
  const f = fixture()
  await f.created()
  f.advance(10000)
  const captured: AbortSignal[] = []
  let attempt = 0
  const w = new ActivityWorker({ store: f.store, now: f.now, dispatchTimeoutMs: 20,
    acquire: async (_record, signal) => {
      captured.push(signal)
      if (++attempt === 1) await new Promise(resolve => setTimeout(resolve, 80))
      return { authorize: async () => 'allowed', deliver: async () => 'sent', release: async () => undefined }
    } })
  assert.equal(await w.tick(), 0)
  assert.equal(captured[0].aborted, true)
  assert.equal((captured[0].reason as Error).name, 'TimeoutError')
  assert.equal((await f.store.read()).records[0].state, 'pending')
  assert.equal(await w.tick(), 1)
  assert.notEqual(captured[1], captured[0])
  assert.equal(captured[1].aborted, false)
  assert.equal((await f.store.read()).records[0].state, 'completed')
  await w.close()
})
test('a successful dispatch releases its registration and is never cancelled afterwards', async () => {
  const f = fixture()
  await f.perform('reminder', { ...reminder, intervalSeconds: 60, occurrences: 10 })
  f.advance(10000)
  const workerSignal = observeWorkerSignal(f)
  const delivered: AbortSignal[] = []
  const w = new ActivityWorker({ store: f.store, now: f.now, acquire: async (_record, signal) => ({
    authorize: async () => 'allowed',
    deliver: async () => { delivered.push(signal); return 'sent' },
    release: async () => undefined
  }) })
  for (let round = 0; round < 9; round++) {
    assert.equal(await w.tick(), 1)
    assert.equal(getEventListeners(workerSignal(), 'abort').length, 0)
    f.advance(60000)
  }
  assert.equal(delivered.length, 9)
  assert.equal(new Set(delivered).size, 9)
  assert.equal(delivered.some(signal => signal.aborted), false)
  await w.close()
  assert.equal(delivered.some(signal => signal.aborted), false)
})
