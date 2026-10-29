import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { projectMemoryRetrievalContextV2 } from '../../src/agent/memory/memory-context-projection.js'
import { projectCultureRecordV1 } from '../../src/agent/contracts/CultureRecord.js'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'

function runtimeOptions (directory: string) {
  return { botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => 'automatic' as const, recallMaxItems: () => 6, recallMaxTokens: () => 1200, recallTimeoutMs: () => 150 }
}

async function fixture (t: { after: (fn: () => unknown) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-memory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1(runtimeOptions(directory))
  t.after(async () => await runtime.close())
  const db = new DatabaseSync(path.join(directory, 'personal-memory.sqlite'), { readOnly: true })
  t.after(() => db.close())
  let role = 'owner'
  let joined = 1700000000
  let refreshed = 0
  let sequence = 0
  let lookupAvailable = true
  const event = (groupId = '40004', userId = '20002') => ({ isGroup: true,
    self_id: '10001', group_id: groupId, user_id: userId, message_id: `group-${++sequence}`,
    sender: { user_id: userId, nickname: '测试成员', role: 'owner' },
    bot: { sendApi: async (_method: string, input: any) => {
      refreshed += 1
      if (!lookupAvailable) throw new Error('unavailable')
      return { user_id: input.user_id, role: String(input.user_id) === '10001' ? 'member' : role, join_time: joined }
    } } })
  const send = async (text: string, groupId = '40004', userId = '20002', extras = {}) => {
    const replies: string[] = []
    await runtime.commands.handle({ event: { ...event(groupId, userId), ...extras }, text,
      replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined })
    return replies.join('\n')
  }
  const recall = async (text: string, groupId = '40004', userId = '20002') => {
    const e = event(groupId, userId)
    return await runtime.recallSource.recall({ request: { createdAt: new Date().toISOString(), sessionAddress: { botId: '10001' } },
      event: e, queryText: text, messageEvidence: { schemaVersion: 1, prompt: text, imageUrls: [],
        currentMessageId: e.message_id, quotedMessageId: null, hasReply: false, replyResolved: true,
        currentSegmentCount: 1, replySegmentCount: 0, ocrTexts: [] } }) as any
  }
  const authority = async (refs: any[], groupId = '40004') => {
    const e = event(groupId)
    return await runtime.recallSource.authority!({ request: { createdAt: new Date().toISOString(), sessionAddress: { botId: '10001' } },
      event: e, queryText: '与检索排名无关的边界校验', messageEvidence: { schemaVersion: 1, prompt: '新问题', imageUrls: [],
        currentMessageId: e.message_id, quotedMessageId: null, hasReply: false } }, refs, new AbortController().signal)
  }
  return { runtime, db, send, recall, authority, setRole: (value: string) => { role = value },
    setJoined: (value: number) => { joined = value }, refreshCount: () => refreshed,
    stopLookup: () => { lookupAvailable = false }, directory }
}

test('group dependency authority preserves valid heads and rejects correction, wrong group and bot rejoin', async t => {
  const f = await fixture(t)
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  const recalled = await f.recall('刷屏')
  const refs = recalled.candidates.map((candidate: any) => ({ namespaceRef: candidate.namespaceRef,
    memoryId: candidate.memoryId, revision: candidate.revision, revisionHash: candidate.revisionHash }))
  assert.equal(refs.length, 1)
  const stamp = await f.authority(refs)
  assert.match(stamp!, /^[a-f0-9]{64}$/)
  assert.equal(await f.authority(refs, '50005'), null)
  f.setJoined(1700000200)
  assert.equal(await f.authority(refs), null)
  f.setJoined(1700000000)
  const list = await f.send('#群记忆 列表')
  const id = /@[0-9a-f]{8}/u.exec(list)![0]
  await f.send(`#群记忆 更正 ${id} 本群禁止重复刷屏`)
  assert.equal(await f.authority(refs), null)
})

test('group memory CRUD, renewal and physical deletion preserve another group', async t => {
  const f = await fixture(t)
  assert.match(await f.send('#群记忆 记住 规则 本群禁止刷屏'), /已保存/)
  assert.match(await f.send('#群记忆 记住 共同偏好 本群共同偏好是周末读科幻小说', '50005'), /已保存/)
  const list = await f.send('#群记忆 列表')
  const id = /@[0-9a-f]{8}/u.exec(list)![0]
  assert.match(await f.send(`#群记忆 更正 ${id} 本群禁止重复刷屏`), /已更正/)
  assert.match(await f.send(`#群记忆 续期 ${id} 30`), /已续期/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 2)
  assert.match(await f.send(`#群记忆 遗忘 ${id}`), /已遗忘/)
  assert.equal((await f.recall('重复刷屏')).candidates?.length ?? 0, 0)
  assert.match(await f.send('#群记忆 删除全部 确认'), /正文与检索索引已清理/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM revision_payloads').get()?.n, 1)
  assert.match(await f.send('#群记忆 列表', '50005'), /科幻小说/)
  assert.equal((await f.runtime.operations.execute({ schemaVersion: 1, action: 'verify' }) as any).status, 'completed')
})

test('group memory retrieval is shared with current members and fenced by group and bot lifecycle', async t => {
  const f = await fixture(t)
  await f.send('#群记忆 记住 文化 本群每周末读科幻小说')
  f.setRole('member')
  const result = await f.recall('科幻小说', '40004', '30003')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.candidates.map((c: any) => c.text), ['本群每周末读科幻小说'])
  assert.equal((await f.recall('科幻小说', '50005')).candidates?.length ?? 0, 0)
  assert.equal((await f.recall('科幻小说', '60006')).candidates?.length ?? 0, 0)
  f.setJoined(1700000100)
  assert.equal((await f.recall('科幻小说')).candidates?.length ?? 0, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
})

test('group administrator revocation overrides cached owner event before every mutation', async t => {
  const f = await fixture(t)
  f.setRole('admin')
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  const list = await f.send('#群记忆 列表')
  const id = /@[0-9a-f]{8}/u.exec(list)![0]
  f.setRole('member')
  const before = JSON.stringify(f.db.prepare('SELECT * FROM revision_payloads').all())
  for (const text of [`#群记忆 更正 ${id} 本群禁止发广告`, `#群记忆 遗忘 ${id}`,
    '#群记忆 记住 规则 本群禁止发广告', '#群记忆 删除全部 确认', '#群记忆 导出']) {
    assert.match(await f.send(text), /只有当前群/)
  }
  assert.match(await f.send('#群记忆 列表'), /禁止刷屏/)
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM revision_payloads').all()), before)
  assert.ok(f.refreshCount() >= 14)
  f.stopLookup()
  assert.match(await f.send('#群记忆 记住 规则 本群禁止发广告'), /无法核实/)
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM revision_payloads').all()), before)
})

test('group lists and scoped selectors can manage a record beyond the first control page', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 65; i += 1) assert.match(await f.send(`#群记忆 记住 规则 本群禁止刷屏第${i}条`), /已保存/)
  const page = await f.send('#群记忆 列表 9')
  assert.equal(page.match(/@[0-9a-f]{8}/gu)?.length, 1)
  const id = /@[0-9a-f]{8}/u.exec(page)![0]
  assert.match(await f.send(`#群记忆 更正 ${id} 本群禁止重复刷屏`), /已更正/)
  assert.match(await f.send('#群记忆 列表 10'), /这一页没有/)
})

test('group admission rejects personal, quoted, third-party and sensitive details even for owner', async t => {
  const f = await fixture(t)
  for (const text of ['我是前端工程师', '小明喜欢喝茶', '本群张三住在海淀', '本群成员的手机号是12345678901',
    '本群共同偏好：“我喜欢绿茶”', '本群共同偏好是讨论小明的糖尿病', '本群共同偏好是转发私聊',
    '本群共同偏好是保存银行卡密码123456', '本群共同偏好是我喜欢绿茶',
    '本群共同偏好是转述模型回答', '本群要求保存他的姓名']) {
    assert.match(await f.send(`#群记忆 记住 群体事实 ${text}`), /只保存明确/)
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
  assert.match(await f.send('#群记忆 记住 群体事实 本群成立于2020年'), /已保存/)
})

test('group owner export delivers a bounded canonical artifact while administrator export is denied', async t => {
  const f = await fixture(t)
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  let file = ''
  const replies: string[] = []
  const send = async () => await f.runtime.commands.handle({ event: { isGroup: true,
    self_id: '10001', user_id: '20002', group_id: '40004', message_id: 'group-export-1',
    sender: { user_id: '20002' }, bot: { sendApi: async (_method: string, input: any) =>
      ({ user_id: input.user_id, role: input.user_id === 10001 ? 'member' : 'owner', join_time: 1700000000 }) } },
    text: '#群记忆 导出', replyText: async value => { replies.push(value) },
    sendPrivateFile: async location => { file = location } })
  f.setRole('admin')
  assert.match(await f.send('#群记忆 导出'), /只有当前群主/)
  await send()
  assert.match(replies.join(''), /已私发导出/)
  assert.ok(file.endsWith('.jsonl'))
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM export_jobs WHERE state = 'delivered'").get()?.n, 1)
})


test('culture requires independent current admin review and remains descriptive untrusted data', async t => {
  const f = await fixture(t)
  f.setRole('member')
  const proposed = await f.send('#群文化 提议 主题偏好 本群偏好讨论望远镜')
  assert.match(proposed, /尚未保存/)
  assert.equal((await f.recall('望远镜')).candidates?.length ?? 0, 0)
  assert.match(await f.send('#群文化 通过 1', '40004', '30003'), /只有当前群/)
  f.setRole('admin')
  assert.match(await f.send('#群文化 通过 1'), /不能自行通过/)
  const list = await f.send('#群文化 候选')
  assert.match(list, /望远镜/)
  // Short ordinals replace the eight hex digit handle, and both review surfaces number them alike.
  assert.match(list, /^1\. \[文化\] /mu)
  assert.doesNotMatch(list, /@[0-9a-f]{8}/u)
  assert.match(await f.send('#群文化 通过 1', '40004', '30003'), /不代表全群共识/)
  const recalled = await f.recall('望远镜')
  assert.equal(recalled.candidates.length, 1)
  const culture = projectCultureRecordV1(recalled.candidates[0])!
  assert.equal(culture.kind, 'topic_preference')
  assert.equal(culture.consensusVerified, false)
  assert.equal(culture.descriptionOnly, true)
  assert.equal(culture.sources.length, 1)
  assert.ok(Date.parse(culture.validUntil) - Date.now() <= 30 * 86400000)
  const memory = projectMemoryRetrievalContextV2(recalled)[0]!
  assert.equal(memory.message.provenance.trust, 'untrusted')
  assert.match(JSON.stringify(memory), /不证明全群共识/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM consent_evidence').get()?.n, 1)
  assert.equal((await f.recall('望远镜', '50005')).candidates?.length ?? 0, 0)
})

test('culture conflict remains pending; explicit correction, renewal, forgetting and authority invalidation work', async t => {
  const f = await fixture(t)
  // A single pending candidate is always ordinal 1; approving or rejecting it renumbers the rest.
  const propose = async (text: string) => { await f.send(`#群文化 提议 语言约定 ${text}`); return '1' }
  const first = await propose('本群使用短句')
  await f.send(`#群文化 通过 ${first}`, '40004', '30003')
  const initial = await f.recall('短句')
  const refs = initial.candidates.map((c: any) => ({ namespaceRef: c.namespaceRef, memoryId: c.memoryId,
    revision: c.revision, revisionHash: c.revisionHash }))
  assert.ok(await f.authority(refs))
  const second = await propose('本群使用长句')
  assert.match(await f.send(`#群文化 通过 ${second}`, '40004', '30003'), /保持待审核/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.match(await f.send('#群文化 候选'), /长句/)
  assert.match(await f.send(`#群文化 拒绝 ${second}`, '40004', '30003'), /已拒绝/)
  const memory = /@[0-9a-f]{8}/u.exec(await f.send('#群文化 列表'))![0]
  assert.match(await f.send(`#群文化 更正 ${memory} 本群语言约定：本群使用简短句子`), /已更正/)
  assert.equal(await f.authority(refs), null)
  assert.match(await f.send(`#群文化 续期 ${memory} 2`), /已续期/)
  assert.match(await f.send(`#群文化 遗忘 ${memory}`), /已遗忘/)
  assert.equal((await f.recall('简短句子')).candidates?.length ?? 0, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM revision_payloads').get()?.n, 0)
})

test('culture pilot, fresh role, scope, text source and sensitive content gates cannot be bypassed', async t => {
  const f = await fixture(t)
  assert.match(await f.send('#群文化 关闭', '50005'), /已关闭/)
  assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗', '50005'), /管理员关闭/)
  assert.match(await f.send('#群记忆 关闭', '60006'), /已关闭/)
  assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗', '60006'), /管理员关闭/)
  for (const extras of [{ source: { seq: 1 } }, { message: [{ type: 'reply' }] }, { message: [{ type: 'image' }] }]) {
    assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗', '40004', '20002', extras), /纯文字/)
  }
  for (const text of ['本群禁止刷屏', '本群要求讨论望远镜']) {
    assert.match(await f.send(`#群文化 提议 主题偏好 ${text}`), /群规则/)
  }
  for (const text of ['小明喜欢喝茶', '本群共同偏好是我喜欢绿茶', '本群成员的手机号是12345678901']) {
    assert.match(await f.send(`#群文化 提议 主题偏好 ${text}`), /只保存明确/)
  }
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  const rule = /@[0-9a-f]{8}/u.exec(await f.send('#群记忆 列表'))![0]
  assert.match(await f.send(`#群文化 遗忘 ${rule}`), /只能遗忘文化/)
  f.stopLookup()
  assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗'), /无法核实/)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n, 0)
})

test('culture pending and approved caps are atomic canonical limits without reducing group rule capacity', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 32; i += 1) {
    assert.match(await f.send(`#群文化 提议 梗说明 本群使用第${i}种星球梗`), /已提交/)
  }
  assert.match(await f.send('#群文化 提议 梗说明 本群使用第32种星球梗'), /未完成/)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n, 32)
  const candidates = await f.send('#群文化 候选')
  // The list is bounded at 16 lines so one group message stays readable; the rest surface after review.
  assert.equal(candidates.match(/^\d+\. /gmu)?.length, 16)
  assert.match(await f.send('#群文化 拒绝 1'), /已拒绝 1 条/)
  assert.match(await f.send('#群文化 提议 梗说明 本群使用新星球梗'), /已提交/)
  while (Number(f.db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n) > 0) {
    assert.match(await f.send('#群文化 拒绝 全部'), /已拒绝/)
  }
  for (let i = 0; i < 64; i += 1) {
    // Existing manual admin assertions retain their semantics; they also obey the shared culture cap.
    assert.match(await f.send(`#群记忆 记住 文化 本群每周读第${i}种科幻小说`), /已保存/)
  }
  assert.match(await f.send('#群记忆 记住 文化 本群每周读新科幻小说'), /未完成/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 64)
  assert.match(await f.send('#群记忆 记住 规则 本群禁止刷屏'), /已保存/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 65)
})


test('culture disabled recall and live dependency authority fail closed while legacy culture remains', async t => {
  const f = await fixture(t)
  await f.send('#群文化 提议 主题偏好 本群喜欢讨论望远镜')
  await f.send('#群文化 通过 1', '40004', '30003')
  await f.send('#群记忆 记住 文化 本群每周读科幻小说')
  const initial = await f.recall('望远镜')
  const refs = initial.candidates.map((c: any) => ({ namespaceRef: c.namespaceRef, memoryId: c.memoryId,
    revision: c.revision, revisionHash: c.revisionHash }))
  const before = await f.authority(refs)
  assert.ok(before)
  assert.match(await f.send('#群文化 关闭'), /群文化已关闭/)
  assert.equal((await f.recall('望远镜')).candidates?.length ?? 0, 0)
  assert.equal(await f.authority(refs), null)
  assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗'), /管理员关闭/)
  assert.equal((await f.recall('科幻小说')).candidates?.length, 1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 2)
  assert.match(await f.send('#群文化 开启'), /群文化已开启/)
  const reopened = await f.authority(refs)
  // Reopening is a new policy generation: a run proven before the close cannot resume.
  assert.ok(reopened)
  assert.notEqual(reopened, before)
  f.setJoined(1700000200)
  assert.equal(await f.authority(refs), null)
})


test('group memory and culture default on in every group without any configured group list', async t => {
  const f = await fixture(t)
  assert.match(await f.send('#群记忆 状态', '70007'), /群记忆：已开启；群文化：已开启/)
  assert.match(await f.send('#群记忆 记住 规则 本群禁止刷屏', '70007'), /已保存/)
  assert.deepEqual((await f.recall('刷屏', '70007')).candidates.map((c: any) => c.text), ['本群禁止刷屏'])
  f.setRole('member')
  assert.match(await f.send('#群文化 提议 梗说明 本群使用星球梗', '70007'), /已提交/)
})

test('only a current group administrator command closes group memory, durably across restart', async t => {
  const f = await fixture(t)
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  const initial = await f.recall('刷屏')
  const refs = initial.candidates.map((c: any) => ({ namespaceRef: c.namespaceRef, memoryId: c.memoryId,
    revision: c.revision, revisionHash: c.revisionHash }))
  assert.ok(await f.authority(refs))
  f.setRole('member')
  assert.match(await f.send('#群记忆 关闭'), /只有当前群管理员/)
  assert.equal((await f.recall('刷屏')).candidates.length, 1)
  f.setRole('admin')
  assert.match(await f.send('#群记忆 关闭'), /群记忆已关闭/)
  assert.match(await f.send('#群记忆 关闭'), /群记忆已关闭/)
  assert.match(await f.send('#群记忆 状态'), /群记忆：已关闭/)
  assert.equal((await f.recall('刷屏')).status, 'unavailable')
  assert.equal(await f.authority(refs), null)
  assert.match(await f.send('#群记忆 记住 规则 本群禁止灌水'), /管理员关闭/)
  // Closing stops injection and new or changed content; existing content remains listable and forgettable.
  const id = /@[0-9a-f]{8}/u.exec(await f.send('#群记忆 列表'))![0]
  assert.match(await f.send(`#群记忆 更正 ${id} 本群禁止重复刷屏`), /管理员关闭/)
  assert.match(await f.send(`#群记忆 续期 ${id} 30`), /管理员关闭/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.match(await f.send('#群记忆 状态', '50005'), /群记忆：已开启/)
  assert.match(await f.send(`#群记忆 遗忘 ${id}`), /已遗忘/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)

  await f.runtime.close()
  const restarted = await createProductionPersonalMemoryRuntimeV1(runtimeOptions(f.directory))
  t.after(async () => await restarted.close())
  const replies: string[] = []
  await restarted.commands.handle({ event: { isGroup: true, self_id: '10001', group_id: '40004', user_id: '20002',
    message_id: 'group-restart-status', sender: { user_id: '20002' }, bot: { sendApi: async () => ({}) } },
  text: '#群记忆 状态', replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined })
  assert.match(replies.join(''), /群记忆：已关闭/)
})

test('reopening group memory restores recall only after the administrator command', async t => {
  const f = await fixture(t)
  await f.send('#群记忆 记住 规则 本群禁止刷屏')
  assert.match(await f.send('#群记忆 关闭'), /已关闭/)
  assert.match(await f.send('#群文化 开启'), /群记忆仍处于关闭状态/)
  assert.equal((await f.recall('刷屏')).status, 'unavailable')
  assert.match(await f.send('#群记忆 开启'), /群记忆已开启/)
  assert.equal((await f.recall('刷屏')).candidates.length, 1)
  f.stopLookup()
  assert.match(await f.send('#群记忆 关闭'), /无法核实/)
  assert.match(await f.send('#群记忆 状态'), /群记忆：已开启/)
})
