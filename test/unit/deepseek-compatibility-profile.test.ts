import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  ModelProviderError,
  modelProtocolError,
  type ModelRequest
} from '../../src/agent/model/model-adapter.js'
import {
  parseJsonValue,
  type JsonObject
} from '../../src/agent/model/json-value.js'
import { buildImmutableChatRequest } from '../../src/agent/model/openai-compatible-adapter.js'
import {
  deepSeekCompatibilityProfile
} from '../../src/agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import {
  resolveOpenAICompatibleModelRuntimeConfig,
  selectOpenAICompatibleProfile
} from '../../src/runtime/model-runtime-config.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'

const FIXTURES = new URL('../../../test/fixtures/openai/', import.meta.url)

async function readFixture (name: string): Promise<JsonObject> {
  const parsed = parseJsonValue(JSON.parse(
    await readFile(new URL(name, FIXTURES), 'utf8')
  ))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('fixture must be an object')
  }
  return parsed as JsonObject
}

function fixtureRequest (overrides: Partial<ModelRequest> = {}): ModelRequest {
  return Object.freeze({
    model: 'fixture-model',
    messages: Object.freeze([{ role: 'user' as const, content: 'fixture request' }]),
    tools: Object.freeze([]),
    toolMode: 'disabled' as const,
    streaming: false,
    maxOutputTokens: 512,
    reasoning: Object.freeze({ enabled: true, effort: 'max' as const }),
    ...overrides
  })
}

test('DeepSeek profile owns thinking tool protocol without changing standard', async () => {
  const fixture = await readFixture('deepseek-thinking-tool.json')
  const choice = (fixture.choices as readonly JsonObject[])[0]
  const message = choice.message as JsonObject
  const state = deepSeekCompatibilityProfile.captureAssistantState(message)

  assert.deepEqual(deepSeekCompatibilityProfile.encodeToolControls({
    enabled: false,
    mode: 'disabled',
    tools: []
  }), {})
  assert.deepEqual(deepSeekCompatibilityProfile.restoreAssistantExtensions(state!), {
    reasoning_content: 'fixture bounded reasoning'
  })
  assert.equal(
    standardOpenAIProfile.captureAssistantState({ reasoning_content: 'ignored' }),
    undefined
  )
  assert.deepEqual(deepSeekCompatibilityProfile.encodeRequestExtensions({
    enabled: true,
    effort: 'max'
  }), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'max'
  })
})

test('DeepSeek owns bounded display reasoning independently of provider state', () => {
  const display = deepSeekCompatibilityProfile.extractAssistantReasoning({
    role: 'assistant',
    content: 'fixture answer',
    reasoning_content: `  ${'思'.repeat(2_001)}  `
  })

  assert.deepEqual(display, {
    text: '思'.repeat(2_000),
    truncated: true
  })
  assert.equal(deepSeekCompatibilityProfile.extractAssistantReasoning({
    role: 'assistant',
    content: 'fixture answer',
    reasoning_content: null
  }), undefined)
  assert.equal(standardOpenAIProfile.extractAssistantReasoning({
    reasoning_content: 'ignored'
  }), undefined)
  assert.throws(() => deepSeekCompatibilityProfile.extractAssistantReasoning({
    reasoning_content: 1
  }), /reasoning/i)
})

test('DeepSeek profile owns cache usage extensions and validates cache counters', () => {
  const common = Object.freeze({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })

  assert.deepEqual(deepSeekCompatibilityProfile.decodeUsageExtensions({
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20
  }, common), {
    inputCache: { hitTokens: 80, missTokens: 20 }
  })
  assert.deepEqual(standardOpenAIProfile.decodeUsageExtensions({
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20
  }, common), {})
  assert.deepEqual(deepSeekCompatibilityProfile.decodeUsageExtensions({}, common), {})
  assert.throws(() => deepSeekCompatibilityProfile.decodeUsageExtensions({
    prompt_cache_hit_tokens: 80
  }, common), /cache/i)
})

test('DeepSeek profile restores a complete assistant tool span and owns wire differences', async () => {
  const fixture = await readFixture('deepseek-thinking-tool.json')
  const choice = (fixture.choices as readonly JsonObject[])[0]
  const message = choice.message as JsonObject
  const calls = message.tool_calls as readonly JsonObject[]
  const fn = calls[0].function as JsonObject
  const state = deepSeekCompatibilityProfile.captureAssistantState(message)
  assert.ok(state)

  const body = buildImmutableChatRequest(fixtureRequest({
    messages: Object.freeze([
      {
        role: 'assistant',
        content: String(message.content),
        toolCalls: Object.freeze([{
          callId: String(calls[0].id),
          name: String(fn.name),
          arguments: parseJsonValue(JSON.parse(String(fn.arguments))) as JsonObject
        }]),
        providerState: state
      },
      { role: 'tool', toolCallId: String(calls[0].id), content: 'fixture result' }
    ]),
    tools: Object.freeze([{
      name: 'weather',
      description: 'fixture weather lookup',
      parameters: Object.freeze({ type: 'object', additionalProperties: false })
    }]),
    toolMode: 'auto'
  }), deepSeekCompatibilityProfile)

  assert.equal(body.max_tokens, 512)
  assert.equal('max_completion_tokens' in body, false)
  assert.equal('tool_choice' in body, false)
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'max')
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].reasoning_content, 'fixture bounded reasoning')
  assert.equal(messages[1].tool_call_id, 'call-fixture-weather')
})

test('DeepSeek profile rejects incomplete or oversized reasoning tool state', () => {
  assert.throws(() => deepSeekCompatibilityProfile.captureAssistantState({
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call-missing-reasoning',
      type: 'function',
      function: { name: 'weather', arguments: '{}' }
    }]
  }), /reasoning/i)
  assert.throws(() => deepSeekCompatibilityProfile.captureAssistantState({
    role: 'assistant',
    content: '',
    reasoning_content: 'x'.repeat(RUN_RESOURCE_LIMITS.providerStateBytes),
    tool_calls: [{
      id: 'call-oversized-reasoning',
      type: 'function',
      function: { name: 'weather', arguments: '{}' }
    }]
  }), /state|reasoning/i)
  assert.throws(() => deepSeekCompatibilityProfile.restoreAssistantExtensions({
    profileId: 'standard',
    profileVersion: 1,
    payload: { reasoningContent: 'fixture' }
  }), /profile/i)
  assert.equal(
    deepSeekCompatibilityProfile.recoveryHint(modelProtocolError('missing_reasoning_content')),
    'none'
  )
})

test('selects profiles explicitly and never infers from URL or model', () => {
  assert.equal(selectOpenAICompatibleProfile('standard').id, 'standard')
  assert.equal(selectOpenAICompatibleProfile('deepseek').id, 'deepseek')
  assert.throws(() => selectOpenAICompatibleProfile('auto'), /compatibility profile/i)

  const inferred = resolveOpenAICompatibleModelRuntimeConfig({
    openAiBaseUrl: 'https://deepseek.fixture.invalid/v1',
    model: 'deepseek-reasoner'
  })
  assert.equal(inferred.profile.id, 'standard')
  assert.equal(inferred.selectionSource, 'default')

  const explicit = resolveOpenAICompatibleModelRuntimeConfig({
    openAiCompatibilityProfile: 'deepseek',
    openAiBaseUrl: 'https://fixture.invalid/v1',
    model: 'fixture-model'
  })
  assert.equal(explicit.profile.id, 'deepseek')
  assert.equal(explicit.selectionSource, 'explicit')
})

test('DeepSeek recovery hint accepts only the exact legacy messages signature', async () => {
  const fixture = await readFile(
    new URL('deepseek-invalid-legacy-context.json', FIXTURES),
    'utf8'
  )
  const classification = deepSeekCompatibilityProfile.classifyError({
    status: 400,
    statusText: 'Invalid Format',
    body: fixture,
    truncated: false,
    providerCode: 'invalid_request_error'
  })
  assert.equal(classification?.profileCode, 'deepseek_invalid_legacy_context')
  const known = new ModelProviderError({
    code: classification!.code,
    stage: 'model.response',
    retryable: classification!.retryable,
    userMessage: classification!.userMessage,
    statusCode: 400,
    profileCode: classification!.profileCode
  })
  assert.equal(
    deepSeekCompatibilityProfile.recoveryHint(known),
    'drop_optional_context_once'
  )

  const missingReasoning = deepSeekCompatibilityProfile.classifyError({
    status: 400,
    statusText: 'Invalid Format',
    body: JSON.stringify({
      error: {
        message: 'Missing reasoning_content field in assistant message',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'invalid_request_error'
      }
    }),
    truncated: false,
    providerCode: 'invalid_request_error'
  })
  assert.equal(missingReasoning?.profileCode, undefined)
})

test('DeepSeek profile owns only the confirmed 402 422 and 503 overrides', () => {
  const cases = [
    [402, 'provider_invalid_request', false, 'deepseek_balance_insufficient'],
    [422, 'provider_invalid_request', false, 'deepseek_invalid_parameters'],
    [503, 'provider_unavailable', true, 'deepseek_overloaded']
  ] as const
  for (const [status, code, retryable, profileCode] of cases) {
    const classification = deepSeekCompatibilityProfile.classifyError({
      status,
      statusText: 'fixture error',
      body: '{}',
      truncated: false
    })
    assert.deepEqual(classification, {
      code,
      retryable,
      userMessage: status === 402
        ? 'AI 服务余额不足，请联系机器人主人。'
        : status === 422
          ? '请求参数不受支持，请联系机器人主人。'
          : 'AI 服务繁忙，请稍后重试。',
      profileCode
    })
    if (status === 422) {
      assert.equal(deepSeekCompatibilityProfile.recoveryHint(new ModelProviderError({
        code: classification!.code,
        stage: 'model.response',
        retryable: classification!.retryable,
        userMessage: classification!.userMessage,
        statusCode: status,
        profileCode: classification!.profileCode
      })), 'none')
    }
  }
  assert.equal(deepSeekCompatibilityProfile.classifyError({
    status: 400,
    statusText: 'Invalid Format',
    body: '{}',
    truncated: false
  }), undefined)
})
