import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'

async function fixture (t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-derived-index-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const failures: string[] = []
  const runtime = await createProductionPersonalMemoryRuntimeV1({
    botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => 'automatic', recallMaxItems: () => 6, recallMaxTokens: () => 1_200,
    recallTimeoutMs: () => 150,
    derivedIndexFailure: operation => { failures.push(operation) }
  })
  t.after(async () => await runtime.close())
  const canonical = new DatabaseSync(path.join(directory, 'personal-memory.sqlite'), { readOnly: true })
  t.after(() => canonical.close())
  let sequence = 0
  const send = async (text: string) => {
    const replies: string[] = []
    await runtime.commands.handle({
      event: { isGroup: true, self_id: '10001', group_id: '40004', user_id: '20002',
        message_id: `group-${++sequence}`,
        sender: { user_id: '20002', nickname: '测试成员', role: 'owner' },
        bot: { sendApi: async (_method: string, input: { user_id: string }) => ({
          user_id: input.user_id, role: String(input.user_id) === '10001' ? 'member' : 'owner',
          join_time: 1_700_000_000
        }) } },
      text, replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined
    })
    return replies.join('\n')
  }
  const heads = (): number =>
    Number(canonical.prepare('SELECT count(*) AS n FROM heads').get()?.n)
  /** Breaks the derived projection only; the canonical store stays intact. */
  const breakLexicalIndex = (): void => {
    const lexical = new DatabaseSync(path.join(directory, 'personal-memory-lexical.sqlite'))
    try { lexical.exec('DROP TABLE lexical_documents') } finally { lexical.close() }
  }
  return { failures, send, heads, breakLexicalIndex }
}

test('a healthy group memory write rebuilds the lexical index without reporting a failure', async t => {
  const { failures, send, heads } = await fixture(t)
  const reply = await send('#群记忆 记住 规则 本群禁止发广告')
  assert.match(reply, /已保存/)
  assert.equal(heads(), 1)
  assert.deepEqual(failures, [])
})

test('a failed lexical rebuild keeps the canonical write and is reported, not swallowed', async t => {
  const { failures, send, heads, breakLexicalIndex } = await fixture(t)
  await send('#群记忆 记住 规则 本群禁止发广告')
  breakLexicalIndex()
  const reply = await send('#群记忆 记住 规则 本群禁止刷屏')
  // The canonical receipt stays truthful: the member is told the memory was saved, and it was.
  assert.match(reply, /已保存/)
  assert.equal(heads(), 2)
  // Without this signal the derived index silently drifts and recall degrades with no evidence.
  assert.deepEqual(failures, ['proposal.approve'])
})

test('forgetting a group memory with a broken index is also reported', async t => {
  const { failures, send, breakLexicalIndex } = await fixture(t)
  await send('#群记忆 记住 规则 本群禁止发广告')
  const listed = await send('#群记忆 列表')
  const selector = /@([0-9a-f]{8})/u.exec(listed)?.[1]
  assert.ok(selector !== undefined, listed)
  breakLexicalIndex()
  assert.match(await send(`#群记忆 遗忘 @${selector}`), /已遗忘/)
  assert.deepEqual(failures, ['record.forget'])
})
