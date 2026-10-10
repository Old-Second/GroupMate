import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'

async function fixture (t: { after: (fn: () => unknown) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-memory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1({ botInstanceId: 'groupmate-production',
    storageDirectory: directory, deploymentMode: () => 'automatic', groupAllowlist: () => ['40004', '50005'],
    recallMaxItems: () => 6, recallMaxTokens: () => 1200, recallTimeoutMs: () => 150 })
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
  const send = async (text: string, groupId = '40004') => {
    const replies: string[] = []
    await runtime.commands.handle({ event: event(groupId), text,
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
  return { runtime, db, send, recall, setRole: (value: string) => { role = value },
    setJoined: (value: number) => { joined = value }, refreshCount: () => refreshed,
    stopLookup: () => { lookupAvailable = false }, directory }
}

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
