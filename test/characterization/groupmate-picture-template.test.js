import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  renderGroupMateHtml
} from '../../dist/runtime/presentation/groupmate-picture-contract.js'
import { qrCodeBrowserScript } from '../../dist/runtime/presentation/qr-code-svg.js'

test('GroupMate reply template has one bounded document slot and one fixed QR program', async () => {
  const template = await readFile(new URL('../../resources/reply/groupmate.html', import.meta.url), 'utf8')
  assert.equal(template.match(/<!--__GROUPMATE_DOCUMENT__-->/g)?.length, 1)
  assert.equal(template.match(/<!--__GROUPMATE_QR_SCRIPT__-->/g)?.length, 1)
  assert.match(template, /\bGroupMate\b/)
  assert.doesNotMatch(template, /CHATGPT-PLUGIN|\bChatGPT\b|user avatar|QQ|model name/i)
  assert.match(template, /\.textContent\s*=/)
  assert.doesNotMatch(template, /\.innerHTML\s*=/)
  assert.match(template, /groupmate-bot-name/)
  assert.match(template, /toneStyle/)

  const html = renderGroupMateHtml(template, {
    schemaVersion: 1,
    replyText: '<最终正文>',
    citations: [{ title: '资料', text: '引用' }],
    reasoningView: { text: '推理', truncated: false },
    showQRCode: true
  }, { botName: '派蒙', toneStyle: 'Creative' })
  assert.equal(html.includes('<!--__GROUPMATE_DOCUMENT__-->'), false)
  assert.equal(html.includes('<!--__GROUPMATE_QR_SCRIPT__-->'), false)
  assert.equal(html.includes(qrCodeBrowserScript()), true)
  assert.doesNotMatch(html, /<最终正文>/)
  assert.match(html, /"botName":"派蒙"/)
  assert.match(html, /"toneStyle":"creative"/)
})
