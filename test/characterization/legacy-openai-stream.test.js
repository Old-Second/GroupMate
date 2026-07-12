import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGPTAPI } from '../../utils/openai/chatgpt-api.js'
import { createSseResponse, loadTextFixture } from '../helpers/openai-fixture.js'

test('legacy stream assembles reasoning and one fragmented tool call', async t => {
  t.mock.method(console, 'log', () => {})
  const fixture = [
    'data: {"id":"fixture-stream-0","choices":[{"delta":{"role":"assistant","reasoning_content":"fixture "}}]}',
    '',
    await loadTextFixture('stream-single-tool.sse')
  ].join('\n')
  const progress = []
  const requests = []
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://fixture.invalid/v1',
    fetch: async (url, options) => {
      requests.push({ url, options })
      return createSseResponse(fixture)
    },
    getMessageById: async () => undefined,
    upsertMessage: async () => undefined,
    completionParams: { model: 'fixture-model', tools: [] },
    systemMessage: 'fixture system',
    maxModelTokens: 8192,
    maxResponseTokens: 4096
  })

  const result = await client.sendMessage('fixture question', {
    stream: true,
    onProgress: value => progress.push({
      reasoning: value.thinking_text,
      toolCalls: structuredClone(value.toolCalls || [])
    })
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://fixture.invalid/v1/chat/completions')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-key')
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    max_completion_tokens: 4096,
    model: 'fixture-model',
    temperature: 1,
    top_p: 1,
    tools: [],
    messages: [
      { role: 'system', content: 'fixture system' },
      { role: 'user', content: 'fixture question' }
    ],
    stream: true
  })
  assert.deepEqual(progress, [
    { reasoning: 'fixture ', toolCalls: [] },
    { reasoning: 'fixture checking ', toolCalls: [] },
    {
      reasoning: 'fixture checking ',
      toolCalls: [{
        id: 'call_weather',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":' }
      }]
    },
    {
      reasoning: 'fixture checking ',
      toolCalls: [{
        id: 'call_weather',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":"Wuhan"}' }
      }]
    }
  ])
  assert.equal(result.thinking_text, 'fixture checking ')
  assert.deepEqual(result.toolCalls, [{
    id: 'call_weather',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Wuhan"}' }
  }])
  assert.deepEqual(result.functionCall, {
    name: 'weather',
    arguments: '{"city":"Wuhan"}'
  })
})
