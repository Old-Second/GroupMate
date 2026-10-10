import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { updateCommandMessage } from '../../src/runtime/UpdateCommandPolicy.js'
import { handleUpdateCommand } from '../../src/runtime/yunzai-update-controller.js'

test('master update and force aliases are read-only help; non-master receives nothing', async () => {
  let calls = 0
  assert.equal(await handleUpdateCommand({ isMaster: false, root: 'unused', reply: async () => { calls++ } }), false)
  assert.equal(calls, 0)
  assert.equal(updateCommandMessage({ isMaster: false, version: '0.1.0', commit: 'abcdef0' }), null)
  const replies: string[] = []
  for (const command of ['#GroupMate更新', '#GroupMate强制更新']) {
    assert.ok(command)
    await handleUpdateCommand({ isMaster: true, root: process.cwd(), reply: async message => { replies.push(message) } })
  }
  assert.equal(replies.length, 2)
  assert.match(replies[0], /0\.1\.0.*[a-f0-9]{7}/)
  assert.match(replies[0], /groupmate 分支/)
  const shell = await readFile(path.resolve('apps/update.js'), 'utf8')
  assert.match(shell, /\(强制\)\?/)
  assert.doesNotMatch(shell, /child_process|Restart|exec|setTimeout|pull|checkout/)
  const controller = await readFile(path.resolve('src/runtime/yunzai-update-controller.ts'), 'utf8')
  assert.doesNotMatch(controller, /restart|checkout|pull|shell:\s*true/)
  assert.equal(updateCommandMessage({ isMaster: true, version: 'unsafe\nsecret', commit: 'unsafe\nsecret' })?.includes('secret'), false)
})
