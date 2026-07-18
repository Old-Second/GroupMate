import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  ModelProviderError,
  type ModelRequest,
  type ProviderRequestMetadata
} from '../../src/agent/model/model-adapter.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import {
  buildImmutableChatRequest,
  OpenAICompatibleAdapter
} from '../../src/agent/model/openai-compatible-adapter.js'
import type { OpenAICompatibleProfile } from '../../src/agent/model/openai-compatible-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'

const FIXTURES = new URL('../../../test/fixtures/openai/', import.meta.url)
const CACHE_ISOLATION_ID = `gm_g_${'A'.repeat(43)}`

interface FixtureResponseOptions {
  readonly status?: number
  readonly contentType?: string
  readonly chunkBytes?: number
}

async function loadText (name: string): Promise<string> {
  return await readFile(new URL(name, FIXTURES), 'utf8')
}

function fixtureResponse (body: string, options: FixtureResponseOptions = {}) {
  const status = options.status ?? 200
  const contentType = options.contentType ?? 'application/json'
  const chunkBytes = options.chunkBytes ?? Math.max(1, Buffer.byteLength(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Fixture Error',
    headers: {
      get (name: string) {
        return name.toLowerCase() === 'content-type' ? contentType : null
      }
    },
    body: {
      async * [Symbol.asyncIterator] () {
        const bytes = Buffer.from(body)
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))
        }
      }
    }
  }
}

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function frozenRequest (overrides: Partial<ModelRequest> = {}): ModelRequest {
  return deepFreeze({
    model: 'fixture-model',
    messages: [
      { role: 'system', content: 'fixture system' },
      { role: 'user', content: 'fixture question' }
    ],
    tools: [],
    toolMode: 'disabled',
    streaming: false,
    maxOutputTokens: 256,
    reasoning: { enabled: false },
    ...overrides
  } as ModelRequest)
}

function requestWithRawMetadata (metadata: unknown): ModelRequest {
  return Object.freeze({
    ...frozenRequest(),
    metadata
  }) as ModelRequest
}

function fixtureTool () {
  return deepFreeze({
    name: 'weather',
    description: 'fixture weather lookup',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false
    }
  })
}

function adapterWithFetch (
  fetch: ConstructorParameters<typeof OpenAICompatibleAdapter>[0]['fetch'],
  profile: OpenAICompatibleProfile = standardOpenAIProfile
) {
  return new OpenAICompatibleAdapter({
    endpoint: 'https://fixture.invalid/v1/chat/completions',
    apiKey: 'fixture-key',
    profile,
    fetch
  })
}

function isProviderError (
  code: ModelProviderError['code'],
  retryable?: boolean
): (error: unknown) => boolean {
  return error => error instanceof ModelProviderError &&
    error.code === code &&
    (retryable === undefined || error.retryable === retryable)
}

test('standard profile disables tools without mutating input', async () => {
  const captured: unknown[] = []
  const adapter = adapterWithFetch(async (_url, init) => {
    captured.push(JSON.parse(init.body))
    return fixtureResponse(await loadText('standard-text.json'))
  })
  const request = frozenRequest()
  const before = structuredClone(request)

  const turn = await adapter.complete(request, new AbortController().signal)

  assert.deepEqual(request, before)
  const body = captured[0] as Record<string, unknown>
  assert.equal('tools' in body, false)
  assert.equal('functions' in body, false)
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.max_completion_tokens, 256)
  assert.equal('max_tokens' in body, false)
  assert.equal('reasoning_content' in body, false)
  assert.equal('thinking' in body, false)
  assert.equal(turn.text, 'fixture standard response')
  assert.equal(turn.providerState, undefined)
  assert.deepEqual(turn.usage, {
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15
  })
})

test('standard metadata is wire-neutral while DeepSeek emits one exact top-level user_id', async () => {
  const metadata: ProviderRequestMetadata = Object.freeze({
    cacheIsolationId: CACHE_ISOLATION_ID
  })
  const standardBodies: Array<Record<string, unknown>> = []
  const deepSeekBodies: Array<Record<string, unknown>> = []
  await adapterWithFetch(async (_url, init) => {
    standardBodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return fixtureResponse(await loadText('standard-text.json'))
  }).complete(frozenRequest({ metadata }), new AbortController().signal)
  await adapterWithFetch(async (_url, init) => {
    deepSeekBodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return fixtureResponse(await loadText('standard-text.json'))
  }, deepSeekCompatibilityProfile).complete(
    frozenRequest({ metadata }),
    new AbortController().signal
  )

  assert.equal('user_id' in (standardBodies[0] ?? {}), false)
  assert.equal(deepSeekBodies[0]?.user_id, CACHE_ISOLATION_ID)
  assert.equal(
    JSON.stringify(deepSeekBodies[0]?.messages).includes(CACHE_ISOLATION_ID),
    false
  )
  assert.deepEqual(Reflect.ownKeys(metadata), ['cacheIsolationId'])
  assert.equal(Object.isFrozen(metadata), true)
})

test('DeepSeek auxiliary requests remain compatible when conversation metadata is absent', async () => {
  let body: Record<string, unknown> | undefined
  await adapterWithFetch(async (_url, init) => {
    body = JSON.parse(init.body) as Record<string, unknown>
    return fixtureResponse(await loadText('standard-text.json'))
  }, deepSeekCompatibilityProfile).complete(
    frozenRequest(),
    new AbortController().signal
  )

  assert.equal('user_id' in (body ?? {}), false)
})

test('request metadata codec rejects proxy, accessor, symbol, hidden and extra fields', async () => {
  const accessor = Object.freeze(Object.defineProperty({}, 'cacheIsolationId', {
    enumerable: true,
    get: () => CACHE_ISOLATION_ID
  }))
  const symbol = Symbol('private-metadata')
  const withSymbol = Object.freeze({
    cacheIsolationId: CACHE_ISOLATION_ID,
    [symbol]: 'secret'
  })
  const withHidden = Object.freeze(Object.defineProperty({
    cacheIsolationId: CACHE_ISOLATION_ID
  }, 'hidden', { value: 'secret', enumerable: false }))
  const proxy = new Proxy({ cacheIsolationId: CACHE_ISOLATION_ID }, {
    ownKeys: () => { throw new Error('proxy trap must not escape') }
  })
  const invalidValues: unknown[] = [
    proxy,
    accessor,
    withSymbol,
    withHidden,
    Object.freeze({ cacheIsolationId: CACHE_ISOLATION_ID, extra: true }),
    Object.freeze({ cacheIsolationId: 'raw-user-identity' }),
    Object.freeze(Object.assign(Object.create(null), {
      cacheIsolationId: CACHE_ISOLATION_ID
    }))
  ]

  for (const metadata of invalidValues) {
    let attempts = 0
    await assert.rejects(
      adapterWithFetch(async () => {
        attempts += 1
        return fixtureResponse(await loadText('standard-text.json'))
      }, deepSeekCompatibilityProfile).complete(
        requestWithRawMetadata(metadata),
        new AbortController().signal
      ),
      isProviderError('provider_invalid_request', false)
    )
    assert.equal(attempts, 0)
  }
})

test('DeepSeek reserves user_id from reasoning extensions and metadata cannot override core fields', async () => {
  let attempts = 0
  const metadata = Object.freeze({ cacheIsolationId: CACHE_ISOLATION_ID })
  await assert.rejects(
    new OpenAICompatibleAdapter({
      endpoint: 'https://fixture.invalid/v1/chat/completions',
      apiKey: 'fixture-key',
      profile: Object.freeze({
        ...deepSeekCompatibilityProfile,
        id: 'deepseek-reserved-fixture',
        encodeRequestExtensions: () => Object.freeze({ user_id: 'raw-private-id' })
      }),
      fetch: async () => {
        attempts += 1
        return fixtureResponse(await loadText('standard-text.json'))
      }
    }).complete(frozenRequest({ metadata }), new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  await assert.rejects(
    new OpenAICompatibleAdapter({
      endpoint: 'https://fixture.invalid/v1/chat/completions',
      apiKey: 'fixture-key',
      profile: Object.freeze({
        ...deepSeekCompatibilityProfile,
        id: 'deepseek-metadata-fixture',
        encodeRequestMetadata: () => Object.freeze({ model: 'overridden-model' })
      }),
      fetch: async () => {
        attempts += 1
        return fixtureResponse(await loadText('standard-text.json'))
      }
    }).complete(frozenRequest({ metadata }), new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  for (const [id, encodeRequestMetadata] of [
    ['deepseek-metadata-temperature', () => Object.freeze({ temperature: 2 })],
    ['deepseek-metadata-top-p', () => Object.freeze({ top_p: 1 })]
  ] as const) {
    await assert.rejects(
      new OpenAICompatibleAdapter({
        endpoint: 'https://fixture.invalid/v1/chat/completions',
        apiKey: 'fixture-key',
        profile: Object.freeze({
          ...deepSeekCompatibilityProfile,
          id,
          encodeRequestMetadata
        }),
        fetch: async () => {
          attempts += 1
          return fixtureResponse(await loadText('standard-text.json'))
        }
      }).complete(frozenRequest({ metadata }), new AbortController().signal),
      isProviderError('provider_invalid_request', false)
    )
  }
  await assert.rejects(
    new OpenAICompatibleAdapter({
      endpoint: 'https://fixture.invalid/v1/chat/completions',
      apiKey: 'fixture-key',
      profile: Object.freeze({
        ...deepSeekCompatibilityProfile,
        id: 'deepseek-reasoning-top-p',
        encodeRequestExtensions: () => Object.freeze({ top_p: 1 })
      }),
      fetch: async () => {
        attempts += 1
        return fixtureResponse(await loadText('standard-text.json'))
      }
    }).complete(frozenRequest({ metadata }), new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  assert.equal(attempts, 0)
})

test('DeepSeek non-streaming final turns expose display reasoning without provider state', async () => {
  const response = JSON.stringify({
    id: 'fixture-deepseek-final',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'fixture final answer',
        reasoning_content: '  最终轮思考  '
      }
    }]
  })
  const adapter = adapterWithFetch(
    async () => fixtureResponse(response),
    deepSeekCompatibilityProfile
  )

  const turn = await adapter.complete(frozenRequest(), new AbortController().signal)

  assert.deepEqual(turn.reasoning, {
    text: '最终轮思考',
    truncated: false
  })
  assert.equal(turn.providerState, undefined)
})

test('DeepSeek non-streaming turns decode input cache usage', async () => {
  const response = JSON.stringify({
    id: 'fixture-deepseek-cache-usage',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'fixture cached answer' }
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20
    }
  })
  const adapter = adapterWithFetch(
    async () => fixtureResponse(response),
    deepSeekCompatibilityProfile
  )

  const turn = await adapter.complete(frozenRequest(), new AbortController().signal)

  assert.deepEqual(turn.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputCache: { hitTokens: 80, missTokens: 20 }
  })
})

test('standard profile ignores provider-specific input cache usage', async () => {
  const response = JSON.stringify({
    id: 'fixture-standard-cache-usage',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'fixture standard answer' }
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20
    }
  })
  const adapter = adapterWithFetch(async () => fixtureResponse(response))

  const turn = await adapter.complete(frozenRequest(), new AbortController().signal)

  assert.deepEqual(turn.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120
  })
})

test('DeepSeek streaming usage-only final chunks decode input cache usage', async () => {
  const stream = [
    'data: {"id":"fixture-deepseek-cache-stream","choices":[{"index":0,"delta":{"content":"fixture cached answer"}}]}',
    '',
    'data: {"id":"fixture-deepseek-cache-stream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  const adapter = adapterWithFetch(async () => fixtureResponse(stream, {
    contentType: 'text/event-stream',
    chunkBytes: 13
  }), deepSeekCompatibilityProfile)

  const turn = await adapter.complete(frozenRequest({ streaming: true }), new AbortController().signal)

  assert.deepEqual(turn.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputCache: { hitTokens: 80, missTokens: 20 }
  })
})

test('DeepSeek leaves input cache usage absent when both cache counters are absent', async () => {
  const response = JSON.stringify({
    id: 'fixture-deepseek-no-cache-usage',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'fixture answer' }
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  })
  const adapter = adapterWithFetch(
    async () => fixtureResponse(response),
    deepSeekCompatibilityProfile
  )

  const turn = await adapter.complete(frozenRequest(), new AbortController().signal)

  assert.equal(turn.usage?.inputCache, undefined)
})

test('DeepSeek rejects malformed input cache usage as a provider protocol error', async () => {
  const malformedCaches = [
    { prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 101 },
    { prompt_cache_hit_tokens: 80.5, prompt_cache_miss_tokens: 19.5 },
    { prompt_cache_hit_tokens: '80', prompt_cache_miss_tokens: 20 },
    { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 19 }
  ]

  for (const cacheUsage of malformedCaches) {
    const response = JSON.stringify({
      id: 'fixture-deepseek-invalid-cache-usage',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'fixture answer' }
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        ...cacheUsage
      }
    })
    const adapter = adapterWithFetch(
      async () => fixtureResponse(response),
      deepSeekCompatibilityProfile
    )

    await assert.rejects(
      adapter.complete(frozenRequest(), new AbortController().signal),
      isProviderError('provider_protocol_error', false)
    )
  }
})

test('DeepSeek streaming tool turns preserve full provider state beside display reasoning', async () => {
  const stream = [
    'data: {"id":"fixture-deepseek-stream","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"checking "}}]}',
    '',
    'data: {"id":"fixture-deepseek-stream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}',
    '',
    'data: {"id":"fixture-deepseek-stream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Wuhan\\"}"}}]},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  const adapter = adapterWithFetch(async () => fixtureResponse(stream, {
    contentType: 'text/event-stream',
    chunkBytes: 13
  }), deepSeekCompatibilityProfile)

  const turn = await adapter.complete(frozenRequest({
    streaming: true,
    tools: [fixtureTool()],
    toolMode: 'auto'
  }), new AbortController().signal)

  assert.deepEqual(turn.reasoning, {
    text: 'checking',
    truncated: false
  })
  assert.deepEqual(turn.providerState?.payload, {
    reasoningContent: 'checking '
  })
})

test('DeepSeek display truncation never truncates tool continuation state', async () => {
  const fullReasoning = '思'.repeat(2_001)
  const response = JSON.stringify({
    id: 'fixture-deepseek-tool-long-reasoning',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: fullReasoning,
        tool_calls: [{
          id: 'call-weather',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Wuhan"}' }
        }]
      }
    }]
  })
  const adapter = adapterWithFetch(
    async () => fixtureResponse(response),
    deepSeekCompatibilityProfile
  )

  const turn = await adapter.complete(frozenRequest({
    tools: [fixtureTool()],
    toolMode: 'auto'
  }), new AbortController().signal)

  assert.deepEqual(turn.reasoning, {
    text: '思'.repeat(2_000),
    truncated: true
  })
  assert.deepEqual(turn.providerState?.payload, {
    reasoningContent: fullReasoning
  })
})

test('DeepSeek tool continuation keeps the prior wire message prefix and reasoning state', async () => {
  const captured: Array<Record<string, unknown>> = []
  const responses = [
    JSON.stringify({
      id: 'fixture-deepseek-cache-tool',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'cacheable reasoning prefix',
          tool_calls: [{
            id: 'call-weather',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Wuhan"}' }
          }]
        }
      }]
    }),
    JSON.stringify({
      id: 'fixture-deepseek-cache-final',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'fixture final answer' }
      }]
    })
  ]
  const adapter = adapterWithFetch(async (_url, init) => {
    captured.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = responses.shift()
    if (response === undefined) throw new Error('fixture response exhausted')
    return fixtureResponse(response)
  }, deepSeekCompatibilityProfile)
  const firstRequest = frozenRequest({
    tools: [fixtureTool()],
    toolMode: 'auto'
  })

  const toolTurn = await adapter.complete(firstRequest, new AbortController().signal)
  assert.ok(toolTurn.providerState)
  await adapter.complete(frozenRequest({
    messages: [
      ...firstRequest.messages,
      {
        role: 'assistant',
        content: toolTurn.text,
        toolCalls: toolTurn.toolCalls.map(call => ({
          callId: call.callId,
          name: call.name,
          arguments: call.arguments
        })),
        providerState: toolTurn.providerState
      },
      { role: 'tool', toolCallId: 'call-weather', content: 'fixture weather result' }
    ],
    tools: [fixtureTool()],
    toolMode: 'auto'
  }), new AbortController().signal)

  const firstMessages = captured[0]?.messages as Array<Record<string, unknown>>
  const secondMessages = captured[1]?.messages as Array<Record<string, unknown>>
  assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages)
  assert.equal(
    secondMessages[firstMessages.length]?.reasoning_content,
    'cacheable reasoning prefix'
  )
  assert.deepEqual(captured[1]?.tools, captured[0]?.tools)
})

test('OpenAI-compatible adapter sends standard tools through one HTTP attempt', async () => {
  let attempts = 0
  let body: Record<string, unknown> | undefined
  const adapter = adapterWithFetch(async (_url, init) => {
    attempts += 1
    body = JSON.parse(init.body) as Record<string, unknown>
    return fixtureResponse(await loadText('standard-text.json'))
  })

  await adapter.complete(frozenRequest({
    tools: [fixtureTool()],
    toolMode: 'auto'
  }), new AbortController().signal)

  assert.equal(attempts, 1)
  assert.equal(body?.tool_choice, 'auto')
  assert.equal(Array.isArray(body?.tools), true)
  assert.equal('functions' in (body ?? {}), false)
})

test('OpenAI-compatible adapter rejects profile attempts to override standard fields', async () => {
  let attempts = 0
  const adapter = new OpenAICompatibleAdapter({
    endpoint: 'https://fixture.invalid/v1/chat/completions',
    apiKey: 'fixture-key',
    profile: {
      ...standardOpenAIProfile,
      id: 'fixture-profile',
      encodeToolControls: () => ({ model: 'overridden-model' })
    },
    fetch: async () => {
      attempts += 1
      return fixtureResponse(await loadText('standard-text.json'))
    }
  })

  await assert.rejects(
    adapter.complete(frozenRequest(), new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  assert.equal(attempts, 0)
})

test('assembles interleaved indexed tool calls in provider order', async () => {
  const fixture = await loadText('standard-multi-tool.sse')
  const adapter = adapterWithFetch(async () => fixtureResponse(fixture, {
    contentType: 'text/event-stream',
    chunkBytes: 17
  }))

  const turn = await adapter.complete(frozenRequest({
    tools: [fixtureTool()],
    toolMode: 'auto',
    streaming: true
  }), new AbortController().signal)

  assert.deepEqual(turn.toolCalls.map(call => [call.index, call.callId, call.name]), [
    [0, 'call-weather', 'weather'],
    [1, 'call-web', 'website']
  ])
  assert.deepEqual(turn.toolCalls.map(call => call.arguments), [
    { city: 'Wuhan' },
    { url: 'https://fixture.invalid/' }
  ])
  assert.equal(turn.finishReason, 'tool_calls')
  assert.deepEqual(turn.usage, {
    inputTokens: 18,
    outputTokens: 9,
    totalTokens: 27
  })
})

test('rejects duplicate call IDs before returning a model turn', async () => {
  const body = JSON.stringify({
    id: 'fixture-duplicate',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-duplicate', type: 'function', function: { name: 'weather', arguments: '{}' } },
          { id: 'call-duplicate', type: 'function', function: { name: 'website', arguments: '{}' } }
        ]
      }
    }]
  })
  const adapter = adapterWithFetch(async () => fixtureResponse(body))

  await assert.rejects(
    adapter.complete(frozenRequest(), new AbortController().signal),
    isProviderError('provider_protocol_error', false)
  )
})

test('rejects inconsistent streaming fragments and malformed arguments', async () => {
  const inconsistent = [
    'data: {"id":"fixture-conflict","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-a","type":"function","function":{"name":"weather","arguments":"{"}}]}}]}',
    '',
    'data: {"id":"fixture-conflict","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-b","function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  const malformed = JSON.stringify({
    id: 'fixture-malformed-arguments',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-malformed',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":' }
        }]
      }
    }]
  })

  await assert.rejects(
    adapterWithFetch(async () => fixtureResponse(inconsistent, {
      contentType: 'text/event-stream'
    })).complete(frozenRequest({ streaming: true }), new AbortController().signal),
    isProviderError('provider_protocol_error', false)
  )
  await assert.rejects(
    adapterWithFetch(async () => fixtureResponse(malformed)).complete(
      frozenRequest(),
      new AbortController().signal
    ),
    isProviderError('provider_protocol_error', false)
  )
})

test('requires a streaming finish reason and accepts absent usage', async () => {
  const missingFinish = [
    'data: {"id":"fixture-no-finish","choices":[{"index":0,"delta":{"content":"fixture text"}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  const withoutUsage = [
    'data: {"id":"fixture-no-usage","choices":[{"index":0,"delta":{"content":"fixture text"}}]}',
    '',
    'data: {"id":"fixture-no-usage","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')

  await assert.rejects(
    adapterWithFetch(async () => fixtureResponse(missingFinish, {
      contentType: 'text/event-stream'
    })).complete(frozenRequest({ streaming: true }), new AbortController().signal),
    isProviderError('provider_protocol_error', false)
  )
  const turn = await adapterWithFetch(async () => fixtureResponse(withoutUsage, {
    contentType: 'text/event-stream'
  })).complete(frozenRequest({ streaming: true }), new AbortController().signal)
  assert.equal(turn.text, 'fixture text')
  assert.equal(turn.usage, undefined)
})

test('enforces request, SSE line and aggregate response byte limits', async () => {
  let requestAttempts = 0
  const oversizedRequest = frozenRequest({
    messages: [{ role: 'user', content: `fixture ${'x'.repeat(RUN_RESOURCE_LIMITS.requestBytes)}` }]
  })
  await assert.rejects(
    adapterWithFetch(async () => {
      requestAttempts += 1
      return fixtureResponse('{}')
    }).complete(oversizedRequest, new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  assert.equal(requestAttempts, 0)

  const oversizedLine = `data: ${'x'.repeat(RUN_RESOURCE_LIMITS.sseLineBytes)}\n\n`
  await assert.rejects(
    adapterWithFetch(async () => fixtureResponse(oversizedLine, {
      contentType: 'text/event-stream',
      chunkBytes: 1_024
    })).complete(frozenRequest({ streaming: true }), new AbortController().signal),
    isProviderError('provider_protocol_error', false)
  )

  const oversizedResponse = JSON.stringify({
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'x'.repeat(RUN_RESOURCE_LIMITS.providerResponseBytes) }
    }]
  })
  await assert.rejects(
    adapterWithFetch(async () => fixtureResponse(oversizedResponse, { chunkBytes: 4_096 }))
      .complete(frozenRequest(), new AbortController().signal),
    isProviderError('provider_protocol_error', false)
  )
})

test('final request byte limit includes the DeepSeek user_id metadata field', async () => {
  let low = 1
  let high = RUN_RESOURCE_LIMITS.requestBytes
  let fitted = 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = frozenRequest({
      messages: [{ role: 'user', content: 'x'.repeat(middle) }]
    })
    try {
      buildImmutableChatRequest(candidate, deepSeekCompatibilityProfile)
      fitted = middle
      low = middle + 1
    } catch (error) {
      assert.equal(isProviderError('provider_invalid_request', false)(error), true)
      high = middle - 1
    }
  }
  const nearLimit = frozenRequest({
    messages: [{ role: 'user', content: 'x'.repeat(fitted) }]
  })
  assert.ok(
    Buffer.byteLength(JSON.stringify(
      buildImmutableChatRequest(nearLimit, deepSeekCompatibilityProfile)
    ), 'utf8') <= RUN_RESOURCE_LIMITS.requestBytes
  )
  let attempts = 0
  await assert.rejects(
    adapterWithFetch(async () => {
      attempts += 1
      return fixtureResponse(await loadText('standard-text.json'))
    }, deepSeekCompatibilityProfile).complete(frozenRequest({
      messages: nearLimit.messages,
      metadata: Object.freeze({ cacheIsolationId: CACHE_ISOLATION_ID })
    }), new AbortController().signal),
    isProviderError('provider_invalid_request', false)
  )
  assert.equal(attempts, 0)
})

test('bounds error bodies and classifies stable HTTP failures without retrying', async () => {
  const errorFixture = await loadText('standard-error.json')
  const cases = [
    [400, 'provider_invalid_request', false],
    [401, 'provider_authentication', false],
    [429, 'provider_rate_limited', true],
    [500, 'provider_unavailable', true]
  ] as const

  for (const [status, code, retryable] of cases) {
    let attempts = 0
    const body = status === 429
      ? `${errorFixture}${'private-error-body'.repeat(RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes)}`
      : errorFixture
    const adapter = adapterWithFetch(async () => {
      attempts += 1
      return fixtureResponse(body, { status, chunkBytes: 1_024 })
    })
    let observed: unknown
    try {
      await adapter.complete(frozenRequest(), new AbortController().signal)
    } catch (error) {
      observed = error
    }
    assert.equal(isProviderError(code, retryable)(observed), true)
    assert.equal(attempts, 1)
    assert.doesNotMatch(JSON.stringify(observed), /private-error-body|fixture invalid request/)
  }
})

test('classifies a timeout abort without starting a second request', async () => {
  let attempts = 0
  const controller = new AbortController()
  const adapter = adapterWithFetch(async (_url, init) => {
    attempts += 1
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      void resolve
    })
  })
  const completion = adapter.complete(frozenRequest(), controller.signal)
  controller.abort(new DOMException('fixture timeout', 'TimeoutError'))

  await assert.rejects(completion, isProviderError('provider_timeout', true))
  assert.equal(attempts, 1)
})
