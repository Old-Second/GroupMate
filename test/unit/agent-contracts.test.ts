import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentMessage } from '../../src/agent/contracts/content.js'
import { AgentError, serializeAgentError } from '../../src/agent/contracts/error.js'
import { parseAgentEvent } from '../../src/agent/contracts/event.js'
import { parseAgentRequest } from '../../src/agent/contracts/request.js'
import { parseAgentResult } from '../../src/agent/contracts/result.js'

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
    schemaVersion: 1,
    requestId: 'request-1',
    createdAt: '2026-07-13T00:00:00.000Z',
    session: { botId: '10000', scope: { kind: 'private', userId: '7' } },
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
  assert.throws(() => parseAgentRequest({ ...request, apiKey: 'secret' }))
  assert.throws(() => parseAgentRequest({ ...request, baseURL: 'https://provider.invalid' }))
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
