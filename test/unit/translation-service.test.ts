import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ModelProviderError,
  type ModelRequest,
  type ModelTurn
} from '../../src/agent/model/model-adapter.js'
import { createTranslationService } from '../../src/runtime/translation-service.js'

function completedTurn (text: string): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([]),
    finishReason: 'stop'
  })
}

function streamedJson (payload: unknown) {
  return Object.freeze({
    ok: true,
    headers: Object.freeze({ get: () => null }),
    body: Object.freeze({
      async * [Symbol.asyncIterator] () {
        yield Buffer.from(JSON.stringify(payload))
      }
    })
  })
}

test('translation service uses the injected production model port without tools', async () => {
  const requests: ModelRequest[] = []
  const service = createTranslationService({
    model: Object.freeze({
      model: 'deepseek-chat',
      adapter: Object.freeze({
        complete: async (request: ModelRequest) => {
          requests.push(request)
          return completedTurn('你好')
        }
      }),
      timeoutMs: 10_000,
      temperature: 0.2
    }),
    fetch: async () => { throw new Error('legacy translation must not run') }
  })

  assert.equal(await service.translate('hello', '中', 'en'), '你好')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.model, 'deepseek-chat')
  assert.equal(requests[0]?.toolMode, 'disabled')
  assert.deepEqual(requests[0]?.tools, [])
  assert.equal(requests[0]?.streaming, false)
  assert.equal(requests[0]?.reasoning.enabled, false)
  assert.equal(requests[0]?.temperature, 0.2)
  assert.match(requests[0]?.messages[0]?.content ?? '', /\[en\].*\[zh-CHS\]/)
  assert.equal(requests[0]?.messages[1]?.content, 'hello')
})

test('translation service falls back to the bounded legacy API after model failure', async () => {
  const logs: string[] = []
  const service = createTranslationService({
    model: Object.freeze({
      model: 'deepseek-chat',
      adapter: Object.freeze({
        complete: async () => { throw new Error('provider unavailable') }
      })
    }),
    fetch: async (_url, init) => {
      assert.equal(init?.method, 'POST')
      assert.equal(typeof init?.body, 'string')
      return streamedJson(Object.freeze({
        errorCode: 0,
        translateResult: Object.freeze([
          Object.freeze([Object.freeze({ tgt: '旧版结果' })])
        ])
      }))
    },
    logger: Object.freeze({ info: code => { logs.push(code) } }),
    now: () => 1_000,
    random: () => 0.5
  })

  assert.equal(await service.translate('hello', '中', 'en'), '旧版结果')
  assert.deepEqual(logs, ['groupmate.translation.model_fallback'])
  assert.doesNotMatch(logs.join('\n'), /hello|provider unavailable/)
})

test('translation fails closed on model configuration drift without calling legacy fallback', async () => {
  let fallbackCalls = 0
  const drift = new ModelProviderError({
    code: 'provider_invalid_request',
    stage: 'model.configuration',
    retryable: false,
    userMessage: 'API 配置已变更，请重启机器人后再试。',
    details: Object.freeze({ reason: 'model_transport_configuration_changed' })
  })
  const service = createTranslationService({
    model: Object.freeze({
      model: 'deepseek-chat',
      adapter: Object.freeze({
        complete: async () => { throw drift }
      })
    }),
    fetch: async () => {
      fallbackCalls += 1
      throw new Error('legacy fallback must not run')
    }
  })

  await assert.rejects(service.translate('hello', '中', 'en'), error => error === drift)
  assert.equal(fallbackCalls, 0)
})

test('translation service preserves array order through the same model port', async () => {
  const inputs: string[] = []
  const service = createTranslationService({
    model: Object.freeze({
      model: 'fixture-model',
      adapter: Object.freeze({
        complete: async (request: ModelRequest) => {
          const text = request.messages[1]?.content ?? ''
          inputs.push(text)
          return completedTurn(`translated:${text}`)
        }
      })
    })
  })

  assert.deepEqual(
    await service.translate(Object.freeze(['一', '二']), '英'),
    ['translated:一', 'translated:二']
  )
  assert.deepEqual(inputs, ['一', '二'])
})

test('translation service uses legacy fallback when production model is unconfigured', async () => {
  let modelCalls = 0
  const service = createTranslationService({
    model: Object.freeze({
      model: '',
      adapter: Object.freeze({
        complete: async () => {
          modelCalls += 1
          return completedTurn('must not run')
        }
      })
    }),
    fetch: async () => streamedJson(Object.freeze({
        errorCode: 0,
        translateResult: Object.freeze([
          Object.freeze([Object.freeze({ tgt: '降级结果' })])
        ])
      }))
  })

  assert.equal(await service.translate('hello', '中', 'en'), '降级结果')
  assert.equal(modelCalls, 0)
})

test('translation reads the current model configuration without rebuilding the service', async () => {
  let model = 'first-model'
  const requests: ModelRequest[] = []
  const service = createTranslationService({
    model: Object.freeze({
      model: () => model,
      adapter: Object.freeze({
        complete: async (request: ModelRequest) => {
          requests.push(request)
          return completedTurn('翻译结果')
        }
      })
    })
  })

  await service.translate('one', '中', 'en')
  model = 'second-model'
  await service.translate('two', '中', 'en')

  assert.deepEqual(requests.map(request => request.model), [
    'first-model',
    'second-model'
  ])
})

test('translation reads current temperature without rebuilding the service', async () => {
  let temperature = 0.1
  const requests: ModelRequest[] = []
  const service = createTranslationService({
    model: Object.freeze({
      model: 'fixture-model',
      temperature: () => temperature,
      timeoutMs: () => 10_000,
      adapter: Object.freeze({
        complete: async (request: ModelRequest) => {
          requests.push(request)
          return completedTurn('翻译')
        }
      })
    })
  })

  await service.translate('one', '中', 'en')
  temperature = 0.9
  await service.translate('two', '中', 'en')

  assert.deepEqual(requests.map(request => request.temperature), [0.1, 0.9])
})

test('translation propagates caller abort without starting the legacy fallback', async () => {
  const controller = new AbortController()
  let fallbackCalls = 0
  const service = createTranslationService({
    model: Object.freeze({
      model: 'fixture-model',
      adapter: Object.freeze({
        complete: async (_request: ModelRequest, signal?: AbortSignal) => {
          await new Promise((resolve, reject) => {
            const abort = () => reject(signal?.reason)
            signal?.addEventListener('abort', abort, { once: true })
          })
          return completedTurn('unreachable')
        }
      })
    }),
    fetch: async () => {
      fallbackCalls += 1
      throw new Error('legacy fallback must not run')
    }
  })

  const pending = service.translate('hello', '日', 'zh-CHS', controller.signal)
  controller.abort(new DOMException('cancelled', 'AbortError'))

  await assert.rejects(pending, /cancelled/)
  assert.equal(fallbackCalls, 0)
})

test('legacy translation consumes only a bounded streamed JSON response', async () => {
  const service = createTranslationService({
    fetch: async () => streamedJson({
      errorCode: 0,
      translateResult: [[{ tgt: '流式结果' }]]
    })
  })

  assert.equal(await service.translateOld('hello', '中'), '流式结果')
})

test('legacy translation aborts and closes a stalled response stream', async () => {
  const controller = new AbortController()
  let returnCalls = 0
  const service = createTranslationService({
    fetch: async () => Object.freeze({
      ok: true,
      headers: Object.freeze({ get: () => null }),
      body: Object.freeze({
        [Symbol.asyncIterator] () {
          return {
            next: async () => await new Promise<IteratorResult<unknown>>(() => undefined),
            return: async () => {
              returnCalls += 1
              return { done: true, value: undefined }
            }
          }
        }
      })
    })
  })

  const pending = service.translateOld('hello', '中', controller.signal)
  controller.abort(new DOMException('cancelled stream', 'AbortError'))

  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => {
      reject(new Error('legacy stream did not abort'))
    }, 50))
  ]), /cancelled stream/)
  assert.equal(returnCalls, 1)
})
