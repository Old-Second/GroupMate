import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseGroupMatePictureRemoteRequest,
  parseGroupMatePictureRemoteResponse,
  renderGroupMateHtml
} from '../../src/runtime/presentation/groupmate-picture-contract.js'

const request = Object.freeze({
  schemaVersion: 1 as const,
  replyText: '最终回复',
  citations: Object.freeze([{
    title: '资料 <一>',
    text: '引用 & 正文',
    sourceUrl: 'https://example.com/source'
  }]),
  reasoningView: Object.freeze({ text: '受限推理', truncated: false }),
  showQRCode: true
})

test('remote picture request and response accept exact bounded schemas only', () => {
  assert.deepEqual(parseGroupMatePictureRemoteRequest(JSON.stringify(request)), request)
  assert.deepEqual(parseGroupMatePictureRemoteResponse(JSON.stringify({
    schemaVersion: 1,
    pagePath: `/groupmate/reply/v1/${'a'.repeat(32)}`,
    expiresInSeconds: 600
  })), {
    schemaVersion: 1,
    pagePath: `/groupmate/reply/v1/${'a'.repeat(32)}`,
    expiresInSeconds: 600
  })

  for (const key of [
    'actorId', 'requestMessageId', 'route', 'receipt', 'prompt', 'inputReplySnapshot',
    'model', 'viewHost', 'cloudTranscode', 'cookie', 'apiKey', 'hooks'
  ]) {
    assert.equal(parseGroupMatePictureRemoteRequest(JSON.stringify({ ...request, [key]: 'forbidden' })), null)
  }
  assert.equal(parseGroupMatePictureRemoteRequest(JSON.stringify({ ...request, replyText: '' })), null)
  assert.equal(parseGroupMatePictureRemoteRequest(JSON.stringify({
    ...request, replyText: 'x'.repeat(24_001)
  })), null)
  assert.equal(parseGroupMatePictureRemoteRequest(JSON.stringify({
    ...request, reasoningView: { text: 'x'.repeat(2_001), truncated: false }
  })), null)
  assert.equal(parseGroupMatePictureRemoteRequest(JSON.stringify({
    ...request, citations: [{ ...request.citations[0], extra: true }]
  })), null)
  assert.equal(parseGroupMatePictureRemoteRequest(`${JSON.stringify(request)}${' '.repeat(65_536)}`), null)
  assert.equal(parseGroupMatePictureRemoteResponse(JSON.stringify({
    schemaVersion: 1,
    pagePath: 'https://evil.invalid/groupmate/reply/v1/' + 'a'.repeat(32),
    expiresInSeconds: 600
  })), null)
  assert.equal(parseGroupMatePictureRemoteResponse(JSON.stringify({
    schemaVersion: 1,
    pagePath: `/groupmate/reply/v1/${'a'.repeat(32)}`,
    expiresInSeconds: 601
  })), null)
})

test('GroupMate HTML escapes response citation and reasoning without prompt identity', () => {
  const template = '<script type="application/json"><!--__GROUPMATE_DOCUMENT__--></script><script><!--__GROUPMATE_QR_SCRIPT__--></script>'
  const html = renderGroupMateHtml(template, {
    ...request,
    replyText: '</script><img src=x onerror=prompt(1)>\u2028',
    citations: [{ title: '<来源>', text: '& 引用', sourceUrl: 'https://example.com' }],
    reasoningView: { text: '> 推\u2029理', truncated: true }
  })
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /\\u003c\/script\\u003e/)
  assert.match(html, /\\u003c来源\\u003e/)
  assert.match(html, /\\u0026 引用/)
  assert.match(html, /\\u2028/)
  assert.match(html, /\\u2029/)
  assert.doesNotMatch(html, /actorId|requestMessageId|inputReplySnapshot|model|apiKey|cookie/)
  assert.equal(html.includes('<!--__GROUPMATE_DOCUMENT__-->'), false)
  assert.equal(html.includes('<!--__GROUPMATE_QR_SCRIPT__-->'), false)
})

test('GroupMate HTML preserves replacement tokens without duplicating template content', () => {
  const template = 'UNIQUE_PREFIX<script id="document" type="application/json"><!--__GROUPMATE_DOCUMENT__--></script>' +
    'UNIQUE_MIDDLE<script><!--__GROUPMATE_QR_SCRIPT__--></script>UNIQUE_SUFFIX'
  const replacementTokens = "$' $` $& $$"
  const html = renderGroupMateHtml(template, {
    schemaVersion: 1,
    replyText: `reply ${replacementTokens}`,
    citations: [{
      title: `citation title ${replacementTokens}`,
      text: `citation text ${replacementTokens}`
    }],
    reasoningView: { text: `reasoning ${replacementTokens}`, truncated: false },
    showQRCode: false
  })
  const match = html.match(/<script id="document" type="application\/json">([\s\S]*?)<\/script>/)
  assert.notEqual(match, null)
  assert.deepEqual(JSON.parse(match?.[1] ?? ''), {
    schemaVersion: 1,
    replyText: `reply ${replacementTokens}`,
    citations: [{
      title: `citation title ${replacementTokens}`,
      text: `citation text ${replacementTokens}`
    }],
    reasoningView: { text: `reasoning ${replacementTokens}`, truncated: false },
    showQRCode: false
  })
  for (const marker of ['UNIQUE_PREFIX', 'UNIQUE_MIDDLE', 'UNIQUE_SUFFIX']) {
    assert.equal(html.split(marker).length - 1, 1)
  }
  assert.equal(html.includes('<!--__GROUPMATE_DOCUMENT__-->'), false)
  assert.equal(html.includes('<!--__GROUPMATE_QR_SCRIPT__-->'), false)
})
