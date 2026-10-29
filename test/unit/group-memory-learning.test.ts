import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import type { ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { projectMemoryRetrievalContextV2 } from '../../src/agent/memory/memory-context-projection.js'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'
import {
  GROUP_MEMORY_LEARNING_LIMITS_V1,
  parseGroupMemoryLearningCandidateV1
} from '../../src/runtime/GroupMemoryLearning.js'

const GROUP = '40004'
const BOT = '10001'
const ADMIN = '20002'
const OTHER_ADMIN = '30003'
const MEMBERS = ['50005', '60006', '70007']

function turn (text: string): ModelTurn {
  return { text, finishReason: 'stop', toolCalls: [], usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 } }
}

interface SetupOptions {
  readonly mode?: 'explicit' | 'shadow' | 'automatic'
  readonly enabled?: () => boolean
  readonly reply?: (request: ModelRequest) => string
  readonly clock?: { now: number }
}

async function setup (t: TestContext, setupOptions: SetupOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-learning-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const requests: ModelRequest[] = []
  const diagnostics: any[] = []
  const roles = new Map<string, string>([[ADMIN, 'admin'], [OTHER_ADMIN, 'admin'], [BOT, 'member']])
  let joined = 1700000000
  const bot = { sendApi: async (_method: string, input: any) => ({
    user_id: input.user_id, group_id: input.group_id,
    role: roles.get(String(input.user_id)) ?? 'member', join_time: joined }) }
  const runtime = await createProductionPersonalMemoryRuntimeV1({
    botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => setupOptions.mode ?? 'automatic',
    recallMaxItems: () => 6, recallMaxTokens: () => 1_200, recallTimeoutMs: () => 150,
    candidateBot: () => bot,
    groupLearningEnabled: setupOptions.enabled ?? (() => true),
    groupLearningDiagnostic: value => diagnostics.push(value),
    candidateModel: { model: () => 'test-model', adapter: { complete: async request => {
      requests.push(request)
      if (setupOptions.reply !== undefined) return turn(setupOptions.reply(request))
      // A personal-memory extraction request never reaches this group test double.
      return turn(JSON.stringify({ candidates: [{ category: '规则', text: '本群禁止刷屏',
        evidence: ['m1', 'm2'], confidence: 0.9 }] }))
    } } }
  })
  t.after(async () => await runtime.close())
  const db = new DatabaseSync(path.join(directory, 'personal-memory.sqlite'), { readOnly: true })
  t.after(() => db.close())
  let sequence = 0
  const event = (userId: string, text: string, extras: Record<string, unknown> = {}) => ({
    isGroup: true, self_id: BOT, group_id: GROUP, user_id: userId, message_id: `learn-${++sequence}`,
    msg: text, message: [{ type: 'text', text }],
    sender: { user_id: userId, nickname: `成员${userId.slice(0, 2)}`, role: roles.get(userId) ?? 'member' }, bot, ...extras })
  const say = (userId: string, text: string, extras: Record<string, unknown> = {}) => {
    runtime.groupObservation!.observe(event(userId, text, extras))
  }
  /** Twenty eligible messages from several speakers; the first two state the shared rule. */
  const window = async (lines: readonly [string, string][] = [
    [ADMIN, '本群禁止刷屏，大家注意'], [MEMBERS[0]!, '同意，本群禁止刷屏']
  ]) => {
    for (const [userId, text] of lines) say(userId, text)
    for (let i = lines.length; i < 20; i += 1) say(MEMBERS[i % MEMBERS.length]!, `普通闲聊第${i}句`)
    await runtime.waitForGroupLearningIdle!()
  }
  const send = async (text: string, userId = ADMIN) => {
    const replies: string[] = []
    await runtime.commands.handle({ event: event(userId, text), text,
      replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined })
    return replies.join('\n')
  }
  const recall = async (text: string) => {
    const e = event(MEMBERS[0]!, text)
    return await runtime.recallSource.recall({ request: { createdAt: new Date().toISOString(), sessionAddress: { botId: BOT } },
      event: e, queryText: text, messageEvidence: { schemaVersion: 1, prompt: text, imageUrls: [],
        currentMessageId: e.message_id, quotedMessageId: null, hasReply: false, replyResolved: true,
        currentSegmentCount: 1, replySegmentCount: 0, ocrTexts: [] } }) as any
  }
  const pending = () => Number(db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n)
  return { runtime, db, requests, diagnostics, roles, say, window, send, recall, pending, directory,
    setJoined: (value: number) => { joined = value } }
}

test('an automatic group candidate stays pending until a current administrator approves it', async t => {
  const f = await setup(t)
  await f.window()
  assert.equal(f.requests.length, 1)
  const request = f.requests[0]!
  assert.equal(request.toolMode, 'disabled')
  assert.deepEqual(request.tools, [])
  // Speakers reach the extractor as anonymous labels only.
  for (const value of [GROUP, BOT, ADMIN, ...MEMBERS, '成员']) assert.doesNotMatch(request.messages[1]!.content!, new RegExp(value))
  assert.equal(f.pending(), 1)
  const wire = JSON.parse(String(f.db.prepare('SELECT proposal_wire FROM proposals').get()?.proposal_wire))
  assert.equal(wire.proposedBy.kind, 'model')
  assert.equal(wire.kind, 'group_rule')
  assert.equal(wire.sensitivity, 'group')
  assert.deepEqual(wire.sources.map((source: any) => source.sourceKind), ['group_history', 'group_history'])
  assert.deepEqual(wire.sources.map((source: any) => source.actor.userId), [ADMIN, MEMBERS[0]])
  assert.equal(Date.parse(wire.suggestedRetention.validUntil) > Date.parse(wire.proposedAt), true)
  assert.equal((await f.recall('刷屏')).candidates?.length ?? 0, 0)
  assert.match(await f.send('#群记忆 候选', MEMBERS[1]!), /只有当前群管理员/)
  const listed = await f.send('#群记忆 候选')
  assert.match(listed, /\[自动\] 本群禁止刷屏/)
  assert.match(listed, /前审核/)
  const id = /@[0-9a-f]{8}/u.exec(listed)![0]
  assert.match(await f.send(`#群记忆 通过 ${id}`, MEMBERS[1]!), /只有当前群管理员/)
  f.roles.set(ADMIN, 'member')
  // The cached event role is not authority; every review refreshes the current role.
  assert.match(await f.send(`#群记忆 通过 ${id}`), /只有当前群管理员/)
  f.roles.set(ADMIN, 'admin')
  assert.match(await f.send(`#群记忆 通过 ${id}`), /已保存当前群记忆：本群禁止刷屏/)
  assert.equal(f.pending(), 0)
  const recalled = await f.recall('刷屏')
  assert.deepEqual(recalled.candidates.map((c: any) => c.text), ['本群禁止刷屏'])
  assert.equal(recalled.candidates[0].consent, 'explicit')
  assert.match(JSON.stringify(projectMemoryRetrievalContextV2(recalled)), /group_memory_record/)
  const memory = /@[0-9a-f]{8}/u.exec(await f.send('#群记忆 列表'))![0]
  assert.match(await f.send(`#群记忆 遗忘 ${memory}`), /已遗忘/)
  assert.equal((await f.recall('刷屏')).candidates?.length ?? 0, 0)
  const usage = f.diagnostics.find(item => item.stage === 'usage')
  assert.equal(usage.inputTokens, 900)
  assert.equal(usage.outputTokens, 60)
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /刷屏|40004|20002/)
})

test('rejected, duplicate and conflicting candidates never overwrite existing group memory', async t => {
  const f = await setup(t, { reply: () => JSON.stringify({ candidates: [
    { category: '规则', text: '本群禁止刷屏', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '规则', text: '本群禁止刷屏。', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '规则', text: '本群禁止在晚上刷屏', evidence: ['m3', 'm4'], confidence: 0.8 }
  ] }) })
  assert.match(await f.send('#群记忆 记住 规则 本群禁止刷屏'), /已保存/)
  await f.window([[ADMIN, '本群禁止刷屏'], [MEMBERS[0]!, '本群禁止刷屏'],
    [ADMIN, '本群禁止在晚上刷屏'], [MEMBERS[1]!, '对，本群禁止在晚上刷屏']])
  assert.equal(f.requests.length, 1)
  // The saved rule and its punctuation variant are duplicates; the new rule is a conflict candidate.
  assert.equal(f.pending(), 1)
  const wire = JSON.parse(String(f.db.prepare('SELECT proposal_wire FROM proposals WHERE state = \'pending\'').get()?.proposal_wire))
  assert.equal(wire.text, '本群禁止在晚上刷屏')
  assert.equal(wire.conflict.state, 'possible')
  assert.equal(wire.conflict.relatedMemoryIds.length, 1)
  const listed = await f.send('#群记忆 候选')
  assert.match(listed, /与已有记录相近/)
  const id = /@[0-9a-f]{8}/u.exec(listed)![0]
  assert.match(await f.send(`#群记忆 拒绝 ${id}`), /已拒绝/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.deepEqual((await f.recall('刷屏')).candidates.map((c: any) => c.text), ['本群禁止刷屏'])
})

test('classified culture candidates are reviewed through #群文化 by another administrator', async t => {
  const f = await setup(t, { reply: () => JSON.stringify({ candidates: [
    { category: '梗说明', text: '本群使用“星球梗”指代熬夜', evidence: ['m1'], confidence: 0.9 },
    { category: '梗说明', text: '本群使用星球梗指代熬夜', evidence: ['m1', 'm2'], confidence: 0.9 }
  ] }) })
  await f.window([[ADMIN, '本群使用星球梗指代熬夜'], [MEMBERS[0]!, '哈哈对，星球梗就是指代熬夜']])
  assert.equal(f.pending(), 1)
  assert.match(await f.send('#群记忆 候选'), /没有待审核/)
  const listed = await f.send('#群文化 候选')
  assert.match(listed, /\[自动\] 本群梗说明：本群使用星球梗指代熬夜/)
  const id = /@[0-9a-f]{8}/u.exec(listed)![0]
  assert.match(await f.send(`#群记忆 通过 ${id}`), /请使用“#群文化 通过/)
  // The speaker whose message is the evidence cannot approve that culture description.
  assert.match(await f.send(`#群文化 通过 ${id}`), /另一位当前管理员/)
  assert.match(await f.send(`#群文化 通过 ${id}`, OTHER_ADMIN), /不代表全群共识/)
  const recalled = await f.recall('星球梗')
  assert.equal(recalled.candidates.length, 1)
  assert.match(JSON.stringify(projectMemoryRetrievalContextV2(recalled)), /不证明全群共识/)
})

test('administrator and owner switches stop candidate generation before any model call', async t => {
  let enabled = true
  const f = await setup(t, { enabled: () => enabled })
  assert.match(await f.send('#群记忆 关闭'), /已关闭/)
  await f.window()
  assert.equal(f.requests.length, 0)
  assert.equal(f.pending(), 0)
  assert.match(await f.send('#群记忆 开启'), /已开启/)
  enabled = false
  await f.window()
  assert.equal(f.requests.length, 0)
  enabled = true
  await f.window()
  assert.equal(f.requests.length, 1)
  assert.equal(f.pending(), 1)
})

test('culture switch rejects culture candidates while rule candidates continue', async t => {
  const f = await setup(t, { reply: () => JSON.stringify({ candidates: [
    { category: '梗说明', text: '本群使用星球梗指代熬夜', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '规则', text: '本群禁止刷屏', evidence: ['m3', 'm4'], confidence: 0.9 }
  ] }) })
  assert.match(await f.send('#群文化 关闭'), /已关闭/)
  await f.window([[ADMIN, '本群使用星球梗指代熬夜'], [MEMBERS[0]!, '星球梗指代熬夜'],
    [ADMIN, '本群禁止刷屏'], [MEMBERS[1]!, '本群禁止刷屏']])
  assert.equal(f.pending(), 1)
  assert.match(await f.send('#群记忆 候选'), /本群禁止刷屏/)
})

for (const mode of ['explicit'] as const) {
  test(`${mode} deployment mode never observes group messages`, async t => {
    const f = await setup(t, { mode })
    await f.window()
    assert.equal(f.requests.length, 0)
  })
}

test('quoted, media, command, credential, bot and single-speaker messages never form a batch', async t => {
  const f = await setup(t)
  for (let i = 0; i < 20; i += 1) f.say(ADMIN, `本群禁止刷屏第${i}次`)
  await f.runtime.waitForGroupLearningIdle!()
  assert.equal(f.requests.length, 0)
  for (let i = 0; i < 25; i += 1) {
    f.say(MEMBERS[0]!, '本群禁止刷屏', { source: { seq: 1 } })
    f.say(MEMBERS[1]!, '本群禁止刷屏', { message: [{ type: 'image', url: 'https://example.invalid/a.png' }] })
    f.say(MEMBERS[2]!, '#群记忆 列表')
    f.say(MEMBERS[0]!, '密码是 hunter2345')
    f.say(BOT, '本群禁止刷屏')
  }
  await f.runtime.waitForGroupLearningIdle!()
  assert.equal(f.requests.length, 0)
  // One more eligible speaker completes the twenty-message window.
  f.say(MEMBERS[2]!, '本群禁止刷屏')
  await f.runtime.waitForGroupLearningIdle!()
  assert.equal(f.requests.length, 1)
  assert.doesNotMatch(f.requests[0]!.messages[1]!.content!, /hunter|#群记忆|example\.invalid/)
})

test('a group cools down after one extraction and invalid model output stores nothing', async t => {
  const f = await setup(t, { reply: () => 'not json' })
  await f.window()
  assert.equal(f.requests.length, 1)
  assert.equal(f.pending(), 0)
  assert.ok(f.diagnostics.some(item => item.stage === 'extraction' && item.outcome === 'failed'))
  await f.window()
  assert.equal(f.requests.length, 1)
})

test('pending automatic candidates cap further model calls for the group', async t => {
  const { createGroupMemoryLearningV1 } = await import('../../src/runtime/GroupMemoryLearning.js')
  const { openGroupMemoryPolicyStoreV1 } = await import('../../src/runtime/GroupMemoryPolicy.js')
  const { openSqliteMemoryDatabaseV3 } = await import('../../src/agent/memory/sqlite-memory-database.js')
  const { createSqliteMemoryLifecycleAdapterV1 } = await import('../../src/agent/memory/sqlite-memory-lifecycle.js')
  const { createMemoryLifecyclePortV1 } = await import('../../src/agent/memory/memory-lifecycle-port.js')
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-learning-pending-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-10-28T01:00:00.000Z')
  const clock = () => new Date(now).toISOString()
  const canonical = openSqliteMemoryDatabaseV3({ location: path.join(directory, 'canonical.sqlite'), now: clock, manifests: [] })
  t.after(() => canonical.close())
  const policy = openGroupMemoryPolicyStoreV1(path.join(directory, 'policy.sqlite'))
  t.after(() => policy.close())
  const adapter = createSqliteMemoryLifecycleAdapterV1({ database: canonical.database, now: clock })
  const lifecycle = createMemoryLifecyclePortV1({ now: clock, execute: adapter.execute })
  let calls = 0
  const bot = { sendApi: async (_method: string, input: any) => ({ user_id: input.user_id, role: 'member', join_time: 1700000000 }) }
  const learner = createGroupMemoryLearningV1({ botInstanceId: 'groupmate-production', database: canonical.database,
    policy, lifecycle, bot: () => bot, enabled: () => true, now: clock,
    limits: { groupCooldownMs: 1_000, groupDailyExtractions: 10, pendingAutoCandidatesPerGroup: 4 },
    model: { model: () => 'test-model', adapter: { complete: async () => {
      calls += 1
      return turn(JSON.stringify({ candidates: [1, 2, 3].map(index => ({ category: '群体事实',
        text: `本群讨论第${calls}批话题${index}`, evidence: [`m${index}`, `m${index + 1}`], confidence: 0.9 })) }))
    } } } })
  t.after(async () => await learner.close())
  let sequence = 0
  const fill = async () => {
    for (let i = 0; i < 20; i += 1) {
      const text = i < 4 ? `本群讨论第${calls + 1}批话题1 话题2 话题3` : `普通消息${i}`
      learner.observe({ isGroup: true, self_id: BOT, group_id: GROUP, user_id: MEMBERS[i % 3],
        message_id: `pending-${++sequence}`, msg: text, sender: { user_id: MEMBERS[i % 3] } })
    }
    await learner.waitForIdle()
    now += 2_000
  }
  const pending = () => Number(canonical.database.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n)
  await fill()
  assert.equal(pending(), 3)
  await fill()
  // The fourth candidate fills the cap; the rest of that batch is dropped.
  assert.equal(pending(), 4)
  assert.equal(calls, 2)
  await fill()
  assert.equal(calls, 2)
  assert.equal(pending(), 4)
})

test('closing group memory discards buffered messages so reopening starts a fresh window', async t => {
  const f = await setup(t)
  for (let i = 0; i < 19; i += 1) f.say(MEMBERS[i % 3]!, `本群禁止刷屏第${i}次`)
  assert.match(await f.send('#群记忆 关闭'), /已关闭/)
  assert.match(await f.send('#群记忆 开启'), /已开启/)
  f.say(MEMBERS[0]!, '本群禁止刷屏')
  await f.runtime.waitForGroupLearningIdle!()
  assert.equal(f.requests.length, 0)
  await f.window()
  assert.equal(f.requests.length, 1)
  assert.doesNotMatch(f.requests[0]!.messages[1]!.content!, /第\d+次/)
})

test('candidate parser enforces group-wide wording, grounding and evidence rules', () => {
  const limits = GROUP_MEMORY_LEARNING_LIMITS_V1
  const at = Date.parse('2026-10-28T00:00:00.000Z')
  const message = (userId: string, text: string, role: 'admin' | 'member' = 'member', index = 0) => ({
    messageId: `m-${userId}-${index}`, userId, nickname: null, groupCard: null, groupTitle: null, role, text,
    observedAtMs: at + index })
  const messages = [
    message(MEMBERS[0]!, '本群禁止刷屏'), message(MEMBERS[1]!, '赞成，本群禁止刷屏', 'member', 1),
    message(ADMIN, '本群每周五晚上读科幻小说', 'admin', 2), message(MEMBERS[2]!, '我住在海淀', 'member', 3),
    message(MEMBERS[0]!, '今晚八点开黑', 'member', 4)
  ]
  const parse = (value: unknown) => parseGroupMemoryLearningCandidateV1(value, messages, limits)
  assert.equal(parse({ category: '规则', text: '本群禁止刷屏', evidence: ['m1', 'm2'], confidence: 0.9 })?.kind, 'group_rule')
  // An administrator announcement for the group is enough evidence on its own.
  assert.equal(parse({ category: '群体事实', text: '本群每周五晚上读科幻小说', evidence: ['m3'], confidence: 0.9 })?.kind, 'other')
  assert.equal(parse({ category: '主题偏好', text: '本群偏好讨论科幻小说', evidence: ['m3'], confidence: 0.9 })?.text,
    '本群主题偏好：本群偏好讨论科幻小说')
  for (const value of [
    { category: '规则', text: '本群禁止刷屏', evidence: ['m1'], confidence: 0.9 },
    { category: '规则', text: '本群禁止刷屏', evidence: ['m1', 'm2'], confidence: 0.3 },
    { category: '规则', text: '本群禁止刷屏', evidence: ['m9'], confidence: 0.9 },
    { category: '规则', text: '本群禁止发广告', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '群体事实', text: '本群成员都住在海淀', evidence: ['m4', 'm1'], confidence: 0.9 },
    { category: '群体事实', text: '我住在海淀', evidence: ['m4', 'm1'], confidence: 0.9 },
    { category: '群体事实', text: '本群今晚八点开黑', evidence: ['m5', 'm1'], confidence: 0.9 },
    { category: '主题偏好', text: '本群禁止刷屏', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '权限', text: '本群禁止刷屏', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '规则', text: '本群禁止刷屏 @20002', evidence: ['m1', 'm2'], confidence: 0.9 },
    { category: '规则', text: '本群禁止刷屏', evidence: 'm1', confidence: 0.9 }
  ]) assert.equal(parse(value), null, JSON.stringify(value))
})

test('daily caps hold per group and globally across groups', async t => {
  const { createGroupMemoryLearningV1 } = await import('../../src/runtime/GroupMemoryLearning.js')
  const { openGroupMemoryPolicyStoreV1 } = await import('../../src/runtime/GroupMemoryPolicy.js')
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-learning-caps-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const policy = openGroupMemoryPolicyStoreV1(path.join(directory, 'policy.sqlite'))
  t.after(() => policy.close())
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  let now = Date.parse('2026-10-28T01:00:00.000Z')
  let calls = 0
  const learner = createGroupMemoryLearningV1({ botInstanceId: 'groupmate-production', database, policy,
    lifecycle: { execute: async () => { throw new Error('no writes expected') } } as any,
    model: { model: () => 'test-model', adapter: { complete: async () => { calls += 1; return turn('{"candidates":[]}') } } },
    enabled: () => true, now: () => new Date(now).toISOString(),
    // An unavailable host never reaches the model; scheduling still consumes the reserved budget.
    bot: () => undefined,
    limits: { groupDailyExtractions: 2, globalDailyExtractions: 3, groupCooldownMs: 1_000 } })
  t.after(async () => await learner.close())
  let sequence = 0
  const fill = async (groupId: string) => {
    for (let i = 0; i < 20; i += 1) {
      learner.observe({ isGroup: true, self_id: BOT, group_id: groupId, user_id: MEMBERS[i % 3],
        message_id: `cap-${++sequence}`, msg: `普通消息${i}`, sender: { user_id: MEMBERS[i % 3] } })
    }
    await learner.waitForIdle()
    now += 2_000
  }
  const scheduled = () => learner.inspect().dailyExtractions
  await fill('40004'); await fill('40004'); await fill('40004')
  assert.equal(scheduled(), 2)
  await fill('40005'); await fill('40005')
  assert.equal(scheduled(), 3)
  assert.equal(calls, 0)
  now += 86_400_000
  await fill('40005')
  assert.equal(scheduled(), 1)
  assert.equal(learner.inspect().bufferedMessages <= 20 * 2, true)
})
