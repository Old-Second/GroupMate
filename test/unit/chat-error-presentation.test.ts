import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getChatErrorPresentation,
  readChatErrorMetadata
} from '../../src/runtime/chat-error-presentation.js'
import { AgentError, type AgentErrorCode } from '../../src/agent/contracts/error.js'

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

const stableRunErrorCases = [
  ['provider_authentication', 'provider_auth_failed', 'AI 服务鉴权失败，请联系机器人主人'],
  ['provider_invalid_request', 'provider_invalid_format', '请求格式不正确，请联系机器人主人'],
  ['provider_rate_limited', 'provider_rate_limited', 'AI 服务请求过多，请稍后重试'],
  ['provider_unavailable', 'provider_overloaded', 'AI 服务繁忙，请稍后重试'],
  ['provider_timeout', 'provider_timeout', 'AI 服务响应超时，请稍后重试'],
  ['provider_protocol_error', 'provider_protocol_error', 'AI 服务响应格式异常，请稍后重试'],
  ['run_budget_exceeded', 'run_budget_exceeded', '任务执行已达到资源上限，请稍后重试'],
  ['checkpoint_conflict', 'checkpoint_conflict', '任务状态已更新，请重试'],
  ['checkpoint_invalid', 'checkpoint_invalid', '任务状态无法恢复，请重新发起'],
  ['approval_expired', 'approval_expired', '本次操作审批已过期，请重新发起'],
  ['authorization_changed', 'authorization_changed', '当前权限或目标状态已变化，操作未执行'],
  ['tool_outcome_unknown', 'tool_outcome_unknown', '操作结果暂时无法确认，请勿重复提交'],
  ['cancelled', 'cancelled', '任务已取消'],
  ['internal_error', 'internal_error', '处理请求时出现异常，请稍后重试']
] as const satisfies readonly (readonly [AgentErrorCode, string, string])[]

for (const [errorCode, presentationCode, message] of stableRunErrorCases) {
  test(`maps stable run error ${errorCode} through the fixed presentation whitelist`, () => {
    const presentation = getChatErrorPresentation(new AgentError({
      code: errorCode,
      stage: 'run.advance',
      retryable: false,
      userMessage: 'secret endpoint https://private.example sk-fixture',
      details: { operation: 'safe' },
      cause: new Error('private provider body')
    }))

    assert.deepEqual(presentation, {
      code: presentationCode,
      message,
      statusCode: null,
      resetConversation: false
    })
    assert.doesNotMatch(
      JSON.stringify(presentation),
      /private\.example|sk-fixture|provider body|secret endpoint/
    )
  })
}

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
