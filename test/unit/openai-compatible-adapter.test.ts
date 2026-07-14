import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  ModelProviderError,
  type ModelRequest
} from '../../src/agent/model/model-adapter.js'
import { OpenAICompatibleAdapter } from '../../src/agent/model/openai-compatible-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'

const FIXTURES = new URL('../../../test/fixtures/openai/', import.meta.url)

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
  fetch: ConstructorParameters<typeof OpenAICompatibleAdapter>[0]['fetch']
) {
  return new OpenAICompatibleAdapter({
    endpoint: 'https://fixture.invalid/v1/chat/completions',
    apiKey: 'fixture-key',
    profile: standardOpenAIProfile,
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
