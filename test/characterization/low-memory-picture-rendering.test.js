import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('chat picture mode delegates one-shot rendering to the TypeScript coordinator', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /import\s*\{\s*presentPictureReply\s*\}\s*from '\.\.\/dist\/runtime\/picture-reply\.js'/
  )
  const branchStart = source.indexOf("} else if (presentationMode === 'picture') {")
  const branchEnd = source.indexOf('\n      } else {', branchStart)
  assert.notEqual(branchStart, -1)
  assert.notEqual(branchEnd, -1)
  const pictureBranch = source.slice(branchStart, branchEnd)

  assert.equal(pictureBranch.match(/\bpresentPictureReply\(\{/g)?.length ?? 0, 1)
  assert.equal(pictureBranch.match(/\bthis\.renderImage\(/g)?.length ?? 0, 1)
  assert.match(pictureBranch, /const pictureReplyResult = await presentPictureReply/)
  assert.match(pictureBranch, /sendTextFallback:\s*sendTextReply/)
  assert.match(
    pictureBranch,
    /reportFailure:\s*\(error\)\s*=>\s*logger\.error\(createChatErrorLog/
  )
  assert.match(
    pictureBranch,
    /if \(pictureReplyResult === 'picture' && Config\.enableSuggestedResponses/
  )
})

test('local Chromium rendering always closes its page and optionally its browser', async () => {
  const source = await readFile(new URL('../../utils/common.js', import.meta.url), 'utf8')

  assert.match(source, /finally\s*\{/)
  assert.match(source, /await page\?\.close\(\)/)
  assert.match(source, /if \(Config\.closeBrowserAfterRender && _puppeteer\.browser\)/)
  assert.doesNotMatch(source, /\$\{url\}图片生成失败/)
})

test('low-memory browser cleanup is present in defaults, example config, and Guoba', async () => {
  const defaultConfig = await readFile(new URL('../../utils/config.js', import.meta.url), 'utf8')
  const exampleConfig = JSON.parse(await readFile(new URL('../../config/config.example.json', import.meta.url), 'utf8'))
  const guoba = await readFile(new URL('../../guoba.support.js', import.meta.url), 'utf8')

  assert.match(defaultConfig, /closeBrowserAfterRender:\s*true/)
  assert.equal(exampleConfig.closeBrowserAfterRender, true)
  assert.match(guoba, /field:\s*'closeBrowserAfterRender'/)
  assert.match(guoba, /关闭 Chromium/)
})
