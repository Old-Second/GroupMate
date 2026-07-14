import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ModelProviderError,
  type ModelAdapter,
  type ModelRequest,
  type ModelTurn
} from '../../src/agent/model/model-adapter.js'
import {
  RestrictedCompletionFacade,
  createOpenAICompatibleCompletionFacade
} from '../../src/runtime/completion-facade.js'

const messages = Object.freeze([
  Object.freeze({ role: 'system' as const, content: 'Translate exactly.' }),
  Object.freeze({ role: 'user' as const, content: 'fixture input' })
])

function turn (text: string): ModelTurn {
  return Object.freeze({
    text,
    finishReason: 'stop',
    toolCalls: Object.freeze([])
  })
}

class ScriptedAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  readonly #script: Array<ModelTurn | Error | ((signal: AbortSignal) => Promise<ModelTurn>)>

  constructor (...script: Array<ModelTurn | Error | ((signal: AbortSignal) => Promise<ModelTurn>)>) {
    this.#script = script
  }

  async complete (request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    this.requests.push(request)
    const next = this.#script.shift()
    if (next === undefined) throw new Error('completion script exhausted')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? await next(signal) : next
  }
}

function transientError (): ModelProviderError {
  return new ModelProviderError({
    code: 'provider_unavailable',
    stage: 'model.transport',
    retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。'
  })
}

test('completion facade is one tools-disabled text turn without session state', async () => {
  const adapter = new ScriptedAdapter(turn(' fixture translation '))
  const facade = new RestrictedCompletionFacade({
    adapter,
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'explicit'
  })

  const text = await facade.completeText({
    purpose: 'translation', messages, maxOutputTokens: 128
  }, new AbortController().signal)

  assert.equal(text, 'fixture translation')
  assert.equal(adapter.requests.length, 1)
  assert.deepEqual(adapter.requests[0], {
    model: 'fixture-model',
    messages,
    tools: [],
    toolMode: 'disabled',
    streaming: false,
    maxOutputTokens: 128,
    reasoning: { enabled: false }
  })
  assert.equal(Object.hasOwn(adapter.requests[0] as object, 'maxTurns'), false)
  assert.equal(Object.hasOwn(adapter.requests[0] as object, 'sessionId'), false)
  assert.equal(Object.hasOwn(adapter.requests[0] as object, 'checkpoint'), false)
})

test('completion facade retries exactly one classified transient failure', async () => {
  const adapter = new ScriptedAdapter(transientError(), turn('second attempt'))
  const facade = new RestrictedCompletionFacade({
    adapter, model: 'fixture-model', profileId: 'standard', selectionSource: 'default'
  })
  assert.equal(await facade.completeText({
    purpose: 'suggestion', messages
  }, new AbortController().signal), 'second attempt')
  assert.equal(adapter.requests.length, 2)
  assert.deepEqual(adapter.requests[0], adapter.requests[1])

  const exhausted = new ScriptedAdapter(transientError(), transientError(), turn('forbidden'))
  await assert.rejects(new RestrictedCompletionFacade({
    adapter: exhausted,
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'default'
  }).completeText({ purpose: 'smoke', messages }, new AbortController().signal), error => (
    error instanceof ModelProviderError && error.code === 'provider_unavailable'
  ))
  assert.equal(exhausted.requests.length, 2)
})

test('completion facade rejects non-retryable, empty, refusal, tool and oversized output', async t => {
  const invalidTurns: Array<Readonly<{ name: string; value: ModelTurn }>> = [
    { name: 'empty', value: turn('   ') },
    {
      name: 'refusal',
      value: Object.freeze({
        text: '', refusal: 'no', finishReason: 'stop', toolCalls: Object.freeze([])
      })
    },
    {
      name: 'tool',
      value: Object.freeze({
        text: '', finishReason: 'tool_calls',
        toolCalls: Object.freeze([Object.freeze({
          index: 0, callId: 'call-1', name: 'website',
          argumentsText: '{}', arguments: Object.freeze({})
        })])
      })
    },
    { name: 'oversized', value: turn('x'.repeat(64 * 1024 + 1)) }
  ]

  for (const fixture of invalidTurns) {
    await t.test(fixture.name, async () => {
      const adapter = new ScriptedAdapter(fixture.value)
      await assert.rejects(new RestrictedCompletionFacade({
        adapter,
        model: 'fixture-model',
        profileId: 'standard',
        selectionSource: 'default'
      }).completeText({ purpose: 'smoke', messages }, new AbortController().signal), error => (
        error instanceof ModelProviderError && error.code === 'provider_protocol_error'
      ))
      assert.equal(adapter.requests.length, 1)
    })
  }

  const nonRetryable = new ScriptedAdapter(new ModelProviderError({
    code: 'provider_invalid_request', stage: 'model.request', retryable: false,
    userMessage: '请求格式不正确，请联系机器人主人。'
  }))
  await assert.rejects(new RestrictedCompletionFacade({
    adapter: nonRetryable,
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'default'
  }).completeText({ purpose: 'smoke', messages }, new AbortController().signal))
  assert.equal(nonRetryable.requests.length, 1)
})

test('completion facade enforces output tokens, overall timeout and caller cancellation', async () => {
  const timed = new ScriptedAdapter(async signal => await new Promise<ModelTurn>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  await assert.rejects(new RestrictedCompletionFacade({
    adapter: timed,
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'default',
    timeoutMs: 5
  }).completeText({ purpose: 'smoke', messages }, new AbortController().signal), error => (
    error instanceof ModelProviderError && error.code === 'provider_timeout'
  ))
  assert.equal(timed.requests.length, 1)

  const neverCalled = new ScriptedAdapter(turn('forbidden'))
  const controller = new AbortController()
  controller.abort('caller_cancelled')
  await assert.rejects(new RestrictedCompletionFacade({
    adapter: neverCalled,
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'default'
  }).completeText({ purpose: 'smoke', messages }, controller.signal), error => (
    error instanceof ModelProviderError && error.code === 'cancelled'
  ))
  assert.equal(neverCalled.requests.length, 0)

  await assert.rejects(new RestrictedCompletionFacade({
    adapter: new ScriptedAdapter(turn('forbidden')),
    model: 'fixture-model',
    profileId: 'standard',
    selectionSource: 'default'
  }).completeText({
    purpose: 'smoke', messages, maxOutputTokens: 4_097
  }, new AbortController().signal), /output token limit/i)
})

test('completion facade selects standard or DeepSeek only from explicit configuration', () => {
  const standard = createOpenAICompatibleCompletionFacade({
    endpoint: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model'
  })
  assert.equal(standard.profileId, 'standard')
  assert.equal(standard.selectionSource, 'default')

  const deepseek = createOpenAICompatibleCompletionFacade({
    endpoint: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    openAiCompatibilityProfile: 'deepseek'
  })
  assert.equal(deepseek.profileId, 'deepseek')
  assert.equal(deepseek.selectionSource, 'explicit')

  assert.throws(() => createOpenAICompatibleCompletionFacade({
    endpoint: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'deepseek-reasoner',
    openAiCompatibilityProfile: 'auto'
  }), /standard or deepseek/i)
})

test('completion facade inherits the bounded Adapter response limit without hidden retries', async () => {
  let fetchCalls = 0
  const facade = createOpenAICompatibleCompletionFacade({
    endpoint: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    fetch: async () => {
      fetchCalls += 1
      const raw = JSON.stringify({
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) }
        }]
      })
      return Object.freeze({
        ok: true, status: 200, statusText: 'OK', text: async () => raw
      })
    }
  })
  await assert.rejects(facade.completeText({
    purpose: 'smoke', messages
  }, new AbortController().signal), error => (
    error instanceof ModelProviderError && error.code === 'provider_protocol_error'
  ))
  assert.equal(fetchCalls, 1)
})
