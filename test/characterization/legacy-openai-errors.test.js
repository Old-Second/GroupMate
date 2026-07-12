import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGPTAPI } from '../../utils/openai/chatgpt-api.js'
import {
  createJsonResponse,
  createSseResponse,
  loadJsonFixture,
  loadTextFixture
} from '../helpers/openai-fixture.js'

function createClient (fetch) {
  return new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://fixture.invalid/v1',
    fetch,
    getMessageById: async () => undefined,
    upsertMessage: async () => undefined,
    completionParams: { model: 'fixture-model' },
    systemMessage: 'fixture system'
  })
}

test('legacy client rejects a missing OpenAI-compatible API key', () => {
  assert.throws(() => new ChatGPTAPI({ apiKey: '', fetch: async () => {} }), {
    message: 'OpenAI missing required apiKey'
  })
})

test('legacy non-stream request exposes a malformed response detail', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const fixture = await loadJsonFixture('malformed-no-choices.json')
  const client = createClient(async () => createJsonResponse(fixture))

  await assert.rejects(client.sendMessage('fixture question', { stream: false }), {
    message: 'OpenAI error: fixture malformed response'
  })
})

test('legacy non-stream timeout aborts the injected request', async t => {
  t.mock.method(console, 'log', () => {})
  let aborted = false
  const client = createClient(async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('fixture request aborted'))
    }, { once: true })
  }))

  await assert.rejects(client.sendMessage('fixture question', {
    stream: false,
    timeoutMs: 50
  }), {
    name: 'TimeoutError',
    message: 'OpenAI timed out waiting for response'
  })
  assert.equal(aborted, true)
})

test('legacy non-stream HTTP 429 retains OpenAI status evidence', async t => {
  t.mock.method(console, 'log', () => {})
  const client = createClient(async () => createJsonResponse({
    detail: { message: 'fixture rate limited' }
  }, 429))

  await assert.rejects(client.sendMessage('fixture question', { stream: false }), error => {
    assert.equal(error.name, 'Error')
    assert.equal(error.statusCode, 429)
    assert.equal(error.statusText, 'Fixture Error')
    assert.match(error.message, /^OpenAI error 429:/)
    return true
  })
})

test('legacy stream HTTP 429 retains ChatGPT status evidence', async t => {
  t.mock.method(console, 'log', () => {})
  const client = createClient(async () => createSseResponse(JSON.stringify({
    detail: { message: 'fixture rate limited' }
  }), 429))

  await assert.rejects(client.sendMessage('fixture question', { stream: true }), error => {
    assert.equal(error.name, 'Error')
    assert.equal(error.statusCode, 429)
    assert.equal(error.statusText, '')
    assert.match(error.message, /^ChatGPT error 429:/)
    return true
  })
})

test('legacy non-stream text-only response omits reasoning and tools', async t => {
  t.mock.method(console, 'log', () => {})
  const fixture = await loadJsonFixture('nonstream-text-only.json')
  const client = createClient(async () => createJsonResponse(fixture))

  const result = await client.sendMessage('fixture question', { stream: false })

  assert.equal(result.text, 'fixture response')
  assert.equal(result.thinking_text, undefined)
  assert.equal(result.raw_thinking_text, undefined)
  assert.equal(result.toolCalls, undefined)
})

test('legacy stream text-only response keeps empty reasoning fields', async t => {
  t.mock.method(console, 'log', () => {})
  const fixture = await loadTextFixture('stream-text-only.sse')
  const client = createClient(async () => createSseResponse(fixture))

  const streamResult = await client.sendMessage('fixture question', { stream: true })

  assert.equal(streamResult.text, 'fixture stream response')
  assert.equal(streamResult.thinking_text, '')
  assert.equal(streamResult.raw_thinking_text, '')
  assert.equal(streamResult.toolCalls, undefined)
})

test('legacy stream rejects malformed event data as a syntax error', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  const fixture = 'data: {fixture malformed stream\n\ndata: [DONE]\n\n'
  const client = createClient(async () => createSseResponse(fixture))

  await assert.rejects(client.sendMessage('fixture question', { stream: true }), {
    name: 'SyntaxError'
  })
})
