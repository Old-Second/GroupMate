import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('legacy chat delegates reply input construction to the TypeScript adapter', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /import\s*\{\s*buildModelMessageInput\s*\}\s*from '\.\.\/dist\/runtime\/message-input\.js'/
  )
  assert.match(source, /\bcreateMessageInputLog\b/)

  const methodStart = source.indexOf('  async abstractChat (e, prompt, use, forcePictureMode = false) {')
  const methodEnd = source.indexOf('\n  async cacheContent ', methodStart)
  assert.notEqual(methodStart, -1)
  assert.notEqual(methodEnd, -1)
  const method = source.slice(methodStart, methodEnd)

  assert.equal(method.match(/await buildModelMessageInput\(\{/g)?.length ?? 0, 1)
  assert.match(method, /const currentRequestText = prompt/)
  assert.match(method, /await buildModelMessageInput\(\{\s*event: e,\s*currentPrompt: currentRequestText\s*\}\)/)
  assert.match(method, /e\.groupmateCurrentRequestText = currentRequestText/)
  assert.match(method, /prompt = messageInput\.prompt/)
  assert.match(method, /e\.groupmateMessageInputImages = messageInput\.imageUrls/)
  assert.match(method, /logger\.info\(createMessageInputLog\(messageInput\)\)/)

  const authorizationIndex = method.indexOf('if (!chatPermission) {')
  const trustedTextIndex = method.indexOf('const currentRequestText = prompt')
  const inputIndex = method.indexOf('await buildModelMessageInput({')
  const trustedEventIndex = method.indexOf('e.groupmateCurrentRequestText = currentRequestText')
  const imageIndex = method.indexOf('await getImg(e)')
  const blockWordIndex = method.indexOf('Config.promptBlockWords.find')
  assert.ok(authorizationIndex >= 0 && authorizationIndex < trustedTextIndex)
  assert.ok(trustedTextIndex < inputIndex)
  assert.ok(inputIndex < trustedEventIndex)
  assert.ok(trustedEventIndex < imageIndex)
  assert.ok(imageIndex < blockWordIndex)
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
