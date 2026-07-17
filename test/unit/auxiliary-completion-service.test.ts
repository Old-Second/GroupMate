import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { createAuxiliaryCompletionService } from '../../src/runtime/auxiliary-completion-service.js'

function completedTurn (text: string): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([]),
    finishReason: 'stop'
  })
}

test('auxiliary completion uses one injected model port with tools disabled', async () => {
  const requests: ModelRequest[] = []
  const service = createAuxiliaryCompletionService({
    model: 'deepseek-chat',
    adapter: Object.freeze({
      complete: async (request: ModelRequest) => {
        requests.push(request)
        return completedTurn('有人聊天吗？')
      }
    }),
    timeoutMs: 10_000,
    temperature: 0.7
  })

  const text = await service.completeText({
    purpose: 'random_greeting',
    messages: Object.freeze([{ role: 'user', content: '写一句招呼' }]),
    maxOutputTokens: 128
  })

  assert.equal(text, '有人聊天吗？')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.model, 'deepseek-chat')
  assert.equal(requests[0]?.toolMode, 'disabled')
  assert.deepEqual(requests[0]?.tools, [])
  assert.equal(requests[0]?.reasoning.enabled, false)
  assert.equal(requests[0]?.temperature, 0.7)
})

test('auxiliary completion rejects tool calls and incomplete output', async () => {
  const service = createAuxiliaryCompletionService({
    model: 'fixture-model',
    adapter: Object.freeze({
      complete: async () => Object.freeze({
        text: '',
        toolCalls: Object.freeze([{
          index: 0,
          callId: 'call-1',
          name: 'sendMessage',
          argumentsText: '{}',
          arguments: Object.freeze({})
        }]),
        finishReason: 'tool_calls'
      })
    })
  })

  await assert.rejects(
    service.completeText({
      purpose: 'suggestion',
      messages: Object.freeze([{ role: 'user', content: '继续' }])
    }),
    /response is invalid/
  )
})

test('auxiliary service construction stays lazy when the model is not configured', async () => {
  let calls = 0
  const service = createAuxiliaryCompletionService({
    model: '',
    adapter: Object.freeze({
      complete: async () => {
        calls += 1
        return completedTurn('must not run')
      }
    })
  })

  await assert.rejects(
    service.completeText({
      purpose: 'random_greeting',
      messages: Object.freeze([{ role: 'user', content: '你好' }])
    }),
    /model is not configured/
  )
  assert.equal(calls, 0)
})

test('auxiliary completion reads the current model configuration for every request', async () => {
  let model = 'first-model'
  const requests: ModelRequest[] = []
  const service = createAuxiliaryCompletionService({
    model: () => model,
    adapter: Object.freeze({
      complete: async (request: ModelRequest) => {
        requests.push(request)
        return completedTurn('ok')
      }
    })
  })

  const input = Object.freeze({
    purpose: 'random_greeting' as const,
    messages: Object.freeze([{ role: 'user' as const, content: '打招呼' }])
  })
  await service.completeText(input)
  model = 'second-model'
  await service.completeText(input)

  assert.deepEqual(requests.map(request => request.model), [
    'first-model',
    'second-model'
  ])
})

test('auxiliary completion reads the current temperature without rebuilding', async () => {
  let temperature = 0.2
  const requests: ModelRequest[] = []
  const service = createAuxiliaryCompletionService({
    model: 'fixture-model',
    temperature: () => temperature,
    timeoutMs: () => 10_000,
    adapter: Object.freeze({
      complete: async (request: ModelRequest) => {
        requests.push(request)
        return completedTurn('ok')
      }
    })
  })
  const input = Object.freeze({
    purpose: 'suggestion' as const,
    messages: Object.freeze([{ role: 'user' as const, content: '继续' }])
  })

  await service.completeText(input)
  temperature = 0.8
  await service.completeText(input)

  assert.deepEqual(requests.map(request => request.temperature), [0.2, 0.8])
})
