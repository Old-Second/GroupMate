import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentMessage } from '../../src/agent/contracts/content.js'
import {
  AGENT_ERROR_CODES,
  AgentError,
  isAgentErrorCode,
  serializeAgentError
} from '../../src/agent/contracts/error.js'
import { parseAgentEvent } from '../../src/agent/contracts/event.js'
import { parseAgentRequest } from '../../src/agent/contracts/request.js'
import {
  parseAgentResult,
  parseRunAdvanceResult
} from '../../src/agent/contracts/result.js'
import {
  createInitialRunObservationCounters,
  terminalObservationId
} from '../../src/agent/run/run-observation.js'

const terminalRunRef = '22222222222222222222222222222222'
const terminalRevision = 3

function visibleTerminalFacts (runRef = terminalRunRef) {
  const observationId = terminalObservationId(runRef, terminalRevision)
  const counters = Object.freeze({
    ...createInitialRunObservationCounters(),
    engineActiveDurationMs: 0
  })
  return Object.freeze({
    snapshot: Object.freeze({
      schemaVersion: 2 as const,
      observationId,
      runRef,
      revision: terminalRevision,
      status: 'completed' as const,
      finishedAt: '2026-07-13T00:00:00.000Z',
      completion: Object.freeze({
        kind: 'already_visible' as const,
        source: 'tool_output' as const
      }),
      errorCode: null,
      cancellationReason: null,
      counters,
      engineDurationMs: 0
    }),
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      observationId,
      runRef,
      revision: terminalRevision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 100,
      eventBytesDeleted: 20,
      tombstoneBytes: 300
    })
  })
}

const userMessage = {
  id: 'message-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
  createdAt: '2026-07-13T00:00:00.000Z',
  provenance: {
    source: 'current_request',
    trust: 'untrusted',
    sensitivity: 'private',
    sourceId: 'qq-message-1',
    createdAt: '2026-07-13T00:00:00.000Z'
  },
  replyTo: {
    messageId: 'quoted-1',
    sender: { userId: '7', displayName: 'member' },
    parts: [{ type: 'resource_ref', resourceType: 'image', resourceId: 'image-1' }]
  }
} as const

test('message parser accepts one-level quoted multimodal content', () => {
  assert.deepEqual(parseAgentMessage(userMessage), userMessage)
})

test('message parser rejects nested quotes and inline base64 resources', () => {
  assert.throws(() => parseAgentMessage({
    ...userMessage,
    replyTo: { ...userMessage.replyTo, replyTo: userMessage.replyTo }
  }))
  assert.throws(() => parseAgentMessage({
    ...userMessage,
    parts: [{
      type: 'resource_ref',
      resourceType: 'image',
      resourceId: 'data:image/png;base64,AAAA'
    }]
  }))
})

test('request parser rejects provider credentials', () => {
  const request = {
    schemaVersion: 2,
    requestId: 'request-1',
    requestRef: '11111111111111111111111111111111',
    runRef: '22222222222222222222222222222222',
    requestKind: 'ordinary_chat',
    createdAt: '2026-07-13T00:00:00.000Z',
    session: { botId: '10000', scope: { kind: 'private', userId: '7' } },
    presentationRoute: {
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: {
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      },
      sessionAddress: { botId: '10000', scope: { kind: 'private', userId: '7' } },
      actorId: '7',
      requestMessageId: 'message-1'
    },
    actor: { userId: '7', role: 'member' },
    channel: { kind: 'private', botId: '10000', userId: '7' },
    message: userMessage,
    limits: { deadlineAt: '2026-07-13T00:01:00.000Z', maxModelTurns: 4, maxToolCalls: 8 },
    model: {
      model: 'deepseek-chat',
      streaming: true,
      capabilities: { tools: true, vision: false }
    }
  } as const

  assert.equal(parseAgentRequest(request).requestId, 'request-1')
  assert.equal(parseAgentRequest(request).runRef, '22222222222222222222222222222222')
  assert.throws(() => parseAgentRequest({
    ...request,
    presentationRoute: {
      ...request.presentationRoute,
      requestKind: 'proactive_chat'
    }
  }))
  assert.throws(() => parseAgentRequest({ ...request, apiKey: 'secret' }))
  assert.throws(() => parseAgentRequest({ ...request, baseURL: 'https://provider.invalid' }))
})

test('result parsers use one completion contract and freeze run references on every branch', () => {
  assert.deepEqual(parseAgentResult({
    status: 'completed',
    completion: { kind: 'reply_text', text: '  已完成  ' }
  }), {
    status: 'completed',
    completion: { kind: 'reply_text', text: '已完成' }
  })
  assert.throws(() => parseAgentResult({
    status: 'completed',
    output: userMessage
  }))

  const completed = {
    kind: 'completed',
    runId: 'run-1',
    runRef: terminalRunRef,
    completion: { kind: 'already_visible', source: 'tool_output' },
    output: null,
    terminal: visibleTerminalFacts()
  } as const
  assert.deepEqual(parseRunAdvanceResult(completed), completed)
  assert.throws(() => parseRunAdvanceResult({
    ...completed,
    terminal: visibleTerminalFacts('3'.repeat(32))
  }), /match/i)
  assert.deepEqual(parseRunAdvanceResult({
    kind: 'failed',
    runId: 'run-1',
    runRef: 'unavailable',
    error: serializeAgentError(new AgentError({
      code: 'internal_error',
      stage: 'fixture',
      retryable: false,
      userMessage: '失败。'
    })),
    terminal: null
  }).runRef, 'unavailable')
})

test('AgentError serializes only safe fields', () => {
  const error = new AgentError({
    code: 'storage_unavailable',
    stage: 'session.read',
    retryable: true,
    userMessage: '会话存储暂时不可用，请稍后重试。',
    details: { operation: 'get' },
    cause: new Error('redis://user:password@host private payload')
  })

  const serialized = JSON.stringify(serializeAgentError(error))
  assert.match(serialized, /storage_unavailable/)
  assert.doesNotMatch(serialized, /password|private payload|redis:\/\//)
})

test('legacy entry kind error survives allowlist and result parser round trips', () => {
  const error = serializeAgentError(new AgentError({
    code: 'legacy_entry_kind_unavailable',
    stage: 'run.completion',
    retryable: false,
    userMessage: '旧任务缺少可信入口信息，无法安全恢复回复。'
  }))

  assert.equal(isAgentErrorCode('legacy_entry_kind_unavailable'), true)
  assert.equal(AGENT_ERROR_CODES.includes('legacy_entry_kind_unavailable'), true)
  const parsed = parseAgentResult({ status: 'failed', error })
  assert.equal(parsed.status, 'failed')
  if (parsed.status === 'failed') {
    assert.equal(parsed.error.code, 'legacy_entry_kind_unavailable')
    assert.notEqual(parsed.error.code, 'internal_error')
  }
})

test('event parser accepts only stable events with primitive payloads', () => {
  const event = {
    eventVersion: 1,
    eventId: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    sequence: 0,
    occurredAt: '2026-07-13T00:00:00.000Z',
    type: 'run.started',
    payload: { modelTurns: 0, streaming: true }
  } as const

  assert.deepEqual(parseAgentEvent(event), event)
  assert.throws(() => parseAgentEvent({ ...event, payload: { nested: { secret: true } } }))
})

test('result parser rejects unsafe failed-result details', () => {
  assert.throws(() => parseAgentResult({
    status: 'failed',
    error: {
      code: 'storage_unavailable',
      stage: 'session.read',
      retryable: true,
      userMessage: '会话存储暂时不可用，请稍后重试。',
      details: { nested: { secret: true } }
    }
  }))
})
