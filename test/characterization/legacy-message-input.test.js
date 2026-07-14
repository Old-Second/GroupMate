import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('production chat delegates reply input construction through AgentService', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')
  const bridge = await readFile(
    new URL('../../src/runtime/agent-service-bridge.ts', import.meta.url),
    'utf8'
  )
  const adapter = await readFile(
    new URL('../../src/runtime/yunzai-request-adapter.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /getYunzaiAgentServiceBridge/)
  assert.doesNotMatch(source, /buildModelMessageInput|createMessageInputLog/)
  assert.match(bridge, /await adaptYunzaiRequest\(\{/)
  assert.match(adapter, /await buildModelMessageInput\(\{/)

  const methodStart = source.indexOf('  async abstractChat (e, prompt, use, forcePictureMode = false) {')
  const methodEnd = source.indexOf('\n  async cacheContent ', methodStart)
  assert.notEqual(methodStart, -1)
  assert.notEqual(methodEnd, -1)
  const method = source.slice(methodStart, methodEnd)

  assert.equal(method.match(/this\.agentServiceBridge\.handle\(e, prompt,/g)?.length ?? 0, 1)
  assert.match(method, /e\.groupmateCurrentRequestText = prompt/)

  const authorizationIndex = method.indexOf('if (!chatPermission) {')
  const trustedEventIndex = method.indexOf('e.groupmateCurrentRequestText = prompt')
  const imageIndex = method.indexOf('await getImg(e)')
  const blockWordIndex = method.indexOf('Config.promptBlockWords.find')
  const handleIndex = method.indexOf('this.agentServiceBridge.handle(e, prompt,')
  assert.ok(authorizationIndex >= 0 && authorizationIndex < trustedEventIndex)
  assert.ok(trustedEventIndex < imageIndex)
  assert.ok(imageIndex < blockWordIndex)
  assert.ok(blockWordIndex < handleIndex)
})

test('legacy image lookup reuses images resolved with the reply input', async () => {
  const source = await readFile(new URL('../../utils/common.js', import.meta.url), 'utf8')
  const methodStart = source.indexOf('export async function getImg (e) {')
  const methodEnd = source.indexOf('\nexport async function getImageOcrText ', methodStart)
  assert.notEqual(methodStart, -1)
  assert.notEqual(methodEnd, -1)
  const method = source.slice(methodStart, methodEnd)

  assert.match(method, /Array\.isArray\(e\.groupmateMessageInputImages\)/)
  assert.match(method, /e\.img = e\.groupmateMessageInputImages/)
  assert.match(method, /return e\.img/)
  assert.ok(
    method.indexOf('Array.isArray(e.groupmateMessageInputImages)') < method.indexOf('if (e.source)')
  )
})
