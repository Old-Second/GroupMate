import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openSqliteMemoryDatabaseV3 } from '../../src/agent/memory/sqlite-memory-database.js'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'
import { createProductionMemoryRetentionV1 } from '../../src/runtime/ProductionMemoryRetention.js'

test('production retention purges due bodies and retries a failed index rebuild, preserving valid records', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-retention-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1({ botInstanceId: 'groupmate-production',
    storageDirectory: directory, deploymentMode: () => 'explicit', groupAllowlist: () => [],
    recallMaxItems: () => 6, recallMaxTokens: () => 1200, recallTimeoutMs: () => 150 })
  let message = 0
  const send = async (text: string, userId: string) => {
    const replies: string[] = []
    await runtime.commands.handle({ event: { isGroup: false, self_id: '10001', user_id: userId,
      message_id: `retention-${++message}`, sender: { user_id: userId } }, text,
      replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined })
    return replies.join('')
  }
  await send('#长期记忆 开启', '20002')
  assert.match(await send('#长期记忆 记住 任务截止需要清理的短期事实', '20002'), /已记住/)
  await send('#长期记忆 开启', '30003')
  assert.match(await send('#长期记忆 记住 我喜欢读科幻小说', '30003'), /已记住/)
  await runtime.close()
  const store = openSqliteMemoryDatabaseV3({ location: path.join(directory, 'personal-memory.sqlite'),
    now: () => new Date().toISOString(), manifests: [] })
  t.after(() => store.close())
  const db = store.database
  const head = db.prepare('SELECT namespace_ref, purge_at_ms FROM heads ORDER BY purge_at_ms ASC').all()
  assert.ok(Number(head[0]!.purge_at_ms) < Number(head[1]!.purge_at_ms))
  const due = new Date(Number(head[0]!.purge_at_ms)).toISOString()
  const retained = JSON.stringify(db.prepare('SELECT * FROM revision_payloads WHERE namespace_ref = ?').all(head[1]!.namespace_ref!))
  let rebuilds = 0
  const retention = createProductionMemoryRetentionV1({ database: db, botInstanceId: 'groupmate-production',
    now: () => due, rebuildLexical: async () => {
      rebuilds += 1
      if (rebuilds === 1) throw new Error('index temporarily unavailable')
      return rebuilds
    }, resumeDeletion: async () => true })
  t.after(async () => await retention.close())
  assert.ok(await retention.run() >= 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM revision_payloads WHERE namespace_ref = ?').get(head[0]!.namespace_ref!)?.n, 0)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM revision_payloads WHERE namespace_ref = ?').all(head[1]!.namespace_ref!)), retained)
  assert.equal(rebuilds, 1)
  assert.equal(retention.inspect().status, 'degraded')
  assert.equal(Object.values(db.prepare('PRAGMA quick_check').get()!)[0], 'ok')
  const commands = db.prepare('SELECT count(*) AS n FROM lifecycle_commands').get()?.n
  assert.equal(await retention.run(), 0)
  assert.equal(rebuilds, 2)
  assert.equal(retention.inspect().status, 'completed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM lifecycle_commands').get()?.n, commands)
  retention.start()
  await retention.close()
  assert.equal(await retention.run(), 0)
})
