import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

async function source (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('production chat uses AgentService sessions while legacy core remains unreachable', async () => {
  const chat = await source('apps/chat.js')
  const core = await source('model/core.js')
  const manager = await source('src/runtime/conversation-manager.ts')

  assert.match(chat, /dist\/runtime\/agent-service-bridge\.js/)
  assert.match(chat, /dist\/runtime\/conversation-manager\.js/)
  assert.match(core, /dist\/runtime\/legacy-session-bridge\.js/)
  assert.doesNotMatch(chat, /legacy-session-bridge\.js|sessionBridge\.save|loadOrCreate\(/)
  assert.doesNotMatch(manager, /LegacySessionBridge|legacy-session-bridge/)
  for (const runtimeSource of [chat, manager]) {
    assert.doesNotMatch(runtimeSource, /CHATGPT:CONVERSATIONS:/)
    assert.doesNotMatch(runtimeSource, /redis\.keys\(/)
  }
  assert.doesNotMatch(chat, /model\/conversation\.js/)
  assert.doesNotMatch(chat, /function getConversationScope/)
  assert.doesNotMatch(core, /legacy\/conversation-scope\.js/)
})

test('legacy JavaScript session modules are removed after TypeScript wiring', async () => {
  for (const file of ['model/conversation.js', 'model/legacy/conversation-scope.js']) {
    let code: string | undefined
    try {
      await access(path.join(root, file))
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code
    }
    assert.equal(code, 'ENOENT', `${file} must be removed`)
  }
})
