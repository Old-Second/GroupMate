import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { buildGuobaSchemas } from '../../dist/runtime/guoba-schema.js'
import { presentPictureReply } from '../../dist/runtime/picture-reply.js'
import { createGroupMatePictureRenderer } from '../../dist/runtime/presentation/groupmate-picture-renderer.js'

test('typed picture renderer preserves one-shot low-memory release behavior without chat source coupling', async () => {
  const renderCalls = []
  const outboundParts = []
  const renderer = createGroupMatePictureRenderer({
    template: '<script><!--__GROUPMATE_DOCUMENT__--></script><script><!--__GROUPMATE_QR_SCRIPT__--></script>',
    remote: null,
    chatViewWidth: 720.9,
    live2dAssets: { resolve: () => null },
    browser: {
      async render (input) {
        renderCalls.push(input)
        return {
          kind: 'rendered',
          source: 'local',
          resource: {
            kind: 'buffer', data: new Uint8Array([137, 80, 78, 71]),
            mimeType: 'image/png', byteLength: 4
          }
        }
      }
    }
  })
  const target = { botId: 'bot-1', scope: { kind: 'group', groupId: 'group-1' } }
  const result = await presentPictureReply({
    text: '低内存正文', target, citations: [], reasoningView: null,
    settings: {
      userEnabled: true, autoEnabled: false, autoThreshold: 1200,
      deviceScaleFactor: 9, closeBrowserAfterRender: true,
      showQRCode: false, live2d: null
    }
  }, {
    renderer,
    outboundFactory: {
      async forTarget () {
        return {
          target,
          async deliver (part, attempt) {
            outboundParts.push(part)
            return {
              kind: 'sent', media: part.media, attempt,
              receipt: { schemaVersion: 1, media: part.media, messageId: 'picture-1' }
            }
          },
          async recall () { return { kind: 'recalled' } }
        }
      }
    }
  })

  assert.equal(result.outcome, 'complete')
  assert.equal(renderCalls.length, 1)
  assert.equal(renderCalls[0].closeBrowserAfterRender, true)
  assert.equal(renderCalls[0].maxContentHeightCssPx, 4096)
  assert.deepEqual(renderCalls[0].viewport, { width: 720, deviceScaleFactor: 4 })
  assert.deepEqual(outboundParts.map(part => part.media), ['picture'])
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
