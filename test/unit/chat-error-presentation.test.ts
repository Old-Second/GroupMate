import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getChatErrorPresentation,
  readChatErrorMetadata
} from '../../src/runtime/chat-error-presentation.js'

const deepSeekStatusCases = [
  [400, 'provider_invalid_format', '请求格式不正确，请联系机器人主人'],
  [401, 'provider_auth_failed', 'AI 服务鉴权失败，请联系机器人主人'],
  [402, 'provider_balance_insufficient', 'AI 服务余额不足，请联系机器人主人'],
  [422, 'provider_invalid_parameters', '请求参数不受支持，请联系机器人主人'],
  [429, 'provider_rate_limited', 'AI 服务请求过多，请稍后重试'],
  [500, 'provider_server_error', 'AI 服务暂时异常，请稍后重试'],
  [503, 'provider_overloaded', 'AI 服务繁忙，请稍后重试']
] as const

for (const [statusCode, code, message] of deepSeekStatusCases) {
  test(`maps DeepSeek HTTP ${statusCode} to a fixed user message`, () => {
    assert.deepEqual(getChatErrorPresentation({ statusCode }), {
      code,
      message,
      statusCode,
      resetConversation: false
    })
  })
}

test('classifies local configuration, timeout and connection failures', () => {
  assert.equal(
    getChatErrorPresentation(new Error('OpenAI missing required apiKey')).code,
    'provider_config_missing'
  )
  assert.equal(
    getChatErrorPresentation({ name: 'TimeoutError' }).code,
    'provider_timeout'
  )
  assert.equal(
    getChatErrorPresentation({ code: 'ETIMEDOUT' }).code,
    'provider_timeout'
  )
  assert.equal(
    getChatErrorPresentation({ code: 'ECONNREFUSED' }).code,
    'provider_connection_failed'
  )
})

test('keeps the legacy conversation reset behavior without exposing its error', () => {
  assert.deepEqual(
    getChatErrorPresentation('Error: {"detail":"Conversation not found"}'),
    {
      code: 'conversation_not_found',
      message: '当前对话异常，已经清除，请重试',
      statusCode: null,
      resetConversation: true
    }
  )
})

test('uses the fixed unknown fallback for unlisted provider failures', () => {
  assert.deepEqual(getChatErrorPresentation({
    status: 502,
    message: 'secret prompt https://private.example sk-fixture'
  }), {
    code: 'provider_unknown_error',
    message: '处理请求时出现异常，请稍后重试',
    statusCode: 502,
    resetConversation: false
  })
})

test('does not invoke hostile error accessors or serialization hooks', () => {
  let accessorCalls = 0
  let serializationCalls = 0
  const hostile = Object.create(null)
  for (const key of ['statusCode', 'status', 'name', 'code', 'message']) {
    Object.defineProperty(hostile, key, {
      get () {
        accessorCalls += 1
        throw new Error(`hostile ${key}`)
      }
    })
  }
  Object.defineProperty(hostile, 'toString', {
    value () {
      serializationCalls += 1
      return 'sk-fixture https://private.example secret prompt'
    }
  })
  Object.defineProperty(hostile, 'toJSON', {
    value () {
      serializationCalls += 1
      return 'sk-fixture https://private.example secret prompt'
    }
  })

  const presentation = getChatErrorPresentation(hostile)
  const metadata = readChatErrorMetadata(hostile)

  assert.deepEqual(presentation, {
    code: 'provider_unknown_error',
    message: '处理请求时出现异常，请稍后重试',
    statusCode: null,
    resetConversation: false
  })
  assert.deepEqual(metadata, {
    name: 'unknown',
    code: 'unknown',
    statusCode: null
  })
  assert.equal(accessorCalls, 0)
  assert.equal(serializationCalls, 0)
  assert.doesNotMatch(
    JSON.stringify({ presentation, metadata }),
    /sk-fixture|private\.example|secret prompt/
  )
})
