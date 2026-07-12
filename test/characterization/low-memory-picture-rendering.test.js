import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { buildGuobaSchemas } from '../../dist/runtime/guoba-schema.js'

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

  const releaseImport = source.match(
    /import\s*\{(?<names>[^}]*)\}\s*from '\.\.\/dist\/runtime\/browser-release\.js'/
  )
  assert.ok(releaseImport)
  assert.match(releaseImport.groups.names, /\breleaseBrowserAfterRender\b/)
  assert.match(releaseImport.groups.names, /\bcreateBrowserReleaseLog\b/)
  assert.match(source, /finally\s*\{/)
  assert.match(source, /await page\?\.close\(\)/)
  assert.match(source, /if \(Config\.closeBrowserAfterRender && _puppeteer\.browser\)/)
  assert.match(source, /await releaseBrowserAfterRender\(\{/)
  assert.match(source, /logger\.info\(createBrowserReleaseLog\(releaseResult\)\)/)
  assert.doesNotMatch(source, /_puppeteer\.browser\.close\(\)/)
  assert.doesNotMatch(source, /\$\{url\}图片生成失败/)
})

test('low-memory browser cleanup is present in defaults, example config, and Guoba', async () => {
  const defaultConfig = await readFile(new URL('../../utils/config.js', import.meta.url), 'utf8')
  const exampleConfig = JSON.parse(await readFile(new URL('../../config/config.example.json', import.meta.url), 'utf8'))
  const guoba = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  }).find(item => item.field === 'closeBrowserAfterRender')

  assert.match(defaultConfig, /closeBrowserAfterRender:\s*true/)
  assert.equal(exampleConfig.closeBrowserAfterRender, true)
  assert.equal(guoba.field, 'closeBrowserAfterRender')
  assert.match(guoba.label, /Chromium/)
  assert.match(guoba.bottomHelpMessage, /共享浏览器/)
})

test('the optional legacy toolbox is disabled by default for low-memory hosts', async () => {
  const defaultConfig = await readFile(new URL('../../utils/config.js', import.meta.url), 'utf8')
  const exampleConfig = JSON.parse(await readFile(new URL('../../config/config.example.json', import.meta.url), 'utf8'))
  const guoba = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  }).find(item => item.field === 'enableToolbox')

  assert.match(defaultConfig, /enableToolbox:\s*false/)
  assert.equal(exampleConfig.enableToolbox, false)
  assert.match(guoba.bottomHelpMessage, /增加.*内存占用/)
})
