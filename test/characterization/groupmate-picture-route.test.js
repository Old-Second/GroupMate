import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { test } from 'node:test'
import groupMateReplyRoute from '../../server/modules/groupmate_reply_route.js'

const validBody = JSON.stringify({
  schemaVersion: 1,
  replyText: '安全最终正文',
  citations: [{ title: '来源', text: '引用' }],
  reasoningView: { text: '推理', truncated: false },
  showQRCode: true
})

test('bounded GroupMate Fastify route isolates JSON parsing TTL capacity and headers', async t => {
  let now = 1_000_000
  let tokenIndex = 0
  const server = Fastify()
  t.after(async () => await server.close())
  await server.register(groupMateReplyRoute, {
    now: () => now,
    randomBytes: () => Buffer.from((++tokenIndex).toString(16).padStart(32, '0'), 'hex'),
    appearance: () => ({ botName: 'REMOTE-CONFIG-MUST-NOT-BE-CACHED', toneStyle: 'precise' })
  })
  server.post('/sibling-json', async request => ({ objectBody: typeof request.body === 'object' }))
  await server.ready()

  const sibling = await server.inject({
    method: 'POST', url: '/sibling-json', payload: { value: 1 }
  })
  assert.deepEqual(sibling.json(), { objectBody: true })

  const urls = []
  for (let index = 0; index < 64; index++) {
    const response = await server.inject({
      method: 'POST', url: '/groupmate/reply/v1',
      headers: { 'content-type': 'application/json' }, payload: validBody
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(Object.keys(response.json()).sort(), ['expiresInSeconds', 'pagePath', 'schemaVersion'])
    urls.push(response.json().pagePath)
  }
  assert.equal((await server.inject({ method: 'GET', url: urls[0] })).statusCode, 200)
  const sixtyFifth = await server.inject({
    method: 'POST', url: '/groupmate/reply/v1',
    headers: { 'content-type': 'application/json' }, payload: validBody
  })
  assert.equal(sixtyFifth.statusCode, 201)
  urls.push(sixtyFifth.json().pagePath)
  assert.equal((await server.inject({ method: 'GET', url: urls[0] })).statusCode, 404)
  assert.equal((await server.inject({ method: 'GET', url: urls[1] })).statusCode, 200)
  const visible = await server.inject({ method: 'GET', url: urls.at(-1) })
  assert.equal(visible.statusCode, 200)
  assert.match(visible.headers['content-type'], /^text\/html; charset=utf-8/)
  assert.equal(visible.headers['cache-control'], 'no-store')
  assert.equal(visible.headers['referrer-policy'], 'no-referrer')
  assert.equal(
    visible.headers['content-security-policy'],
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
  )
  assert.match(visible.body, /安全最终正文/)
  assert.doesNotMatch(visible.body, /REMOTE-CONFIG-MUST-NOT-BE-CACHED/)
  assert.doesNotMatch(
    visible.body,
    /"(?:actorId|requestMessageId|inputReplySnapshot|apiKey|cookie|model)"\s*:/
  )

  now += 600_001
  assert.equal((await server.inject({ method: 'GET', url: urls.at(-1) })).statusCode, 404)
  const invalid = await server.inject({
    method: 'POST', url: '/groupmate/reply/v1',
    headers: { 'content-type': 'text/plain' }, payload: validBody
  })
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(invalid.json(), { schemaVersion: 1, error: 'invalid_request' })
  assert.equal((await server.inject({
    method: 'POST', url: '/groupmate/reply/v1',
    headers: { 'content-type': 'application/json' }, payload: `${validBody}${'x'.repeat(65_536)}`
  })).statusCode, 400)
})
