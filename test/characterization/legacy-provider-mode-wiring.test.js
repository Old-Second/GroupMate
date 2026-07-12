import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const runtimeModeFiles = [
  'apps/chat.js',
  'model/conversation.js',
  'apps/management.js',
  'apps/prompts.js',
  'apps/history.js'
]

async function readProjectFile (path) {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('every persisted global provider mode read passes through the runtime policy', async () => {
  for (const path of runtimeModeFiles) {
    const source = await readProjectFile(path)
    assert.match(
      source,
      /provider-mode-policy\.js/,
      `${path} must import the provider mode policy`
    )

    const modeReadLines = source.split('\n').filter(line =>
      line.includes("redis.get('CHATGPT:USE')")
    )
    assert.ok(modeReadLines.length > 0, `${path} must retain a characterized mode read`)
    for (const line of modeReadLines) {
      assert.match(
        line,
        /resolveProviderModeForRuntime/,
        `${path} has an unguarded global mode read: ${line.trim()}`
      )
    }
  }
})

test('user mode and imported mode values are resolved without persisting migrations', async () => {
  const chatSource = await readProjectFile('apps/chat.js')
  const conversationSource = await readProjectFile('model/conversation.js')
  const managementSource = await readProjectFile('apps/management.js')

  assert.match(chatSource, /resolveProviderModeForRuntime\([^\n]*userData\.mode/)
  assert.match(conversationSource, /resolveProviderModeForRuntime\([^\n]*userData\.mode/)
  assert.match(managementSource, /resolveProviderMode\(redisConfig\.useMode\)/)
  assert.doesNotMatch(
    managementSource,
    /redis\.set\('CHATGPT:USE',\s*redisConfig\.useMode\)/
  )
  assert.doesNotMatch(
    managementSource,
    /redis\.set\('CHATGPT:USE',\s*'(?:api3|bing|browser|claude2?|gemini|qwen|chatglm4?|xh|azure)'\)/
  )
})

test('runtime migration logging is fixed metadata without raw mode or actor fields', async () => {
  const policySource = await readProjectFile('src/runtime/provider-mode-policy.ts')

  assert.match(policySource, /event: 'provider\.mode\.migrated'/)
  assert.match(policySource, /migrated: true/)
  assert.doesNotMatch(policySource, /userId|groupId|rawMode|storedMode/)
})
