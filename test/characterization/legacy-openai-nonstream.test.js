import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGPTAPI } from '../../utils/openai/chatgpt-api.js'
import { createJsonResponse, loadJsonFixture } from '../helpers/openai-fixture.js'

test('legacy non-stream request preserves multiple tool calls and reasoning', async () => {
  const fixture = await loadJsonFixture('nonstream-multi-tool.json')
  const requests = []
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://fixture.invalid/v1',
    fetch: async (url, options) => {
      requests.push({ url, options })
      return createJsonResponse(fixture)
    },
    getMessageById: async () => undefined,
    upsertMessage: async () => undefined,
    completionParams: { model: 'fixture-model', tools: [] },
    systemMessage: 'fixture system',
    maxModelTokens: 8192,
    maxResponseTokens: 4096
  })

  const result = await client.sendMessage('fixture question', { stream: false })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://fixture.invalid/v1/chat/completions')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-key')
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json')
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.model, 'fixture-model')
  assert.equal(body.stream, false)
  assert.equal(body.max_completion_tokens, 4096)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'fixture system' },
    { role: 'user', content: 'fixture question' }
  ])
  assert.deepEqual(body.tools, [])
  const message = fixture.choices[0].message
  assert.deepEqual(result.toolCalls, message.tool_calls)
  assert.deepEqual(result.functionCall, message.tool_calls[0].function)
  assert.equal(result.thinking_text, 'fixture reasoning')
  assert.deepEqual(result.detail.usage, fixture.usage)
})
