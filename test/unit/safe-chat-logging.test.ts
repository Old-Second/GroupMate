import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { terminalObservationId } from '../../src/agent/run/run-observation.js'
import {
  SafeObservationFailureLogLimiter,
  createObservationSinkFailureLog,
  createPresentationObservationLog,
  createRequestObservationLog
} from '../../src/runtime/observability/safe-observation-logging.js'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimePath = path.join(projectRoot, 'dist', 'runtime', 'safe-chat-logging.js')

test('safe chat log summaries expose bounded metadata without message content', async () => {
  assert.equal(existsSync(runtimePath), true, 'compiled safe chat logging module must exist')

  const logging = await import(pathToFileURL(runtimePath).href)
  const {
    createChatRequestLog,
    createChatResponseLog,
    createChatErrorLog,
    createMessageInputLog,
    createAgentRunLog
  } = logging
  assert.equal(Object.hasOwn(logging, 'createToolExecutionLog'), false)
  assert.equal(typeof createChatErrorLog, 'function')
  const secretPrompt = 'secret prompt qq=123456 https://private.example/token'
  const secretResponse = 'secret response with private content'
  const request = createChatRequestLog({
    mode: 'api',
    stream: true,
    prompt: secretPrompt
  })
  const response = createChatResponseLog({
    mode: 'api',
    response: {
      text: secretResponse,
      thinking_text: 'private reasoning',
      toolCalls: [{ id: 'private-id', function: { arguments: '{"secret":true}' } }],
      conversationId: 'private-conversation-id'
    }
  })
  const error = createChatErrorLog({
    mode: 'api',
    category: 'provider_rate_limited',
    error: {
      name: 'ChatGPTError',
      code: 'rate_limit',
      statusCode: 429,
      message: 'secret provider response https://private.example',
      stack: 'private stack'
    }
  })
  const messageInput = createMessageInputLog({
    prompt: secretPrompt,
    imageUrls: ['https://private.example/image'],
    hasReply: true,
    replyResolved: true,
    currentSegmentCount: 2,
    replySegmentCount: 3,
    error: new Error('private input error')
  })
  const runRef = 'd'.repeat(32)
  const observationId = terminalObservationId(runRef, 4)
  const agentRun = createAgentRunLog({
    schemaVersion: 2,
    observationId,
    runRef,
    revision: 4,
    status: 'completed',
    finishedAt: '2026-07-16T00:00:00.000Z',
    completion: { kind: 'reply_text', lengthBucket: '1_40' },
    errorCode: null,
    cancellationReason: null,
    counters: {
      schemaVersion: 1,
      providerAttempts: 2,
      modelTurns: 2,
      toolAttempts: 3,
      providerRetries: 'unavailable',
      recoveryAttempts: 1,
      correctionTurns: 0,
      toolCalls: 3,
      approvalRequests: 1,
      toolDenied: 0,
      toolExpired: 0,
      toolIndeterminate: 0,
      estimatedTokens: 44,
      providerInputTokens: 'unavailable',
      providerOutputTokens: 4,
      providerTotalTokens: 'unavailable',
      providerActiveDurationMs: 400,
      engineActiveDurationMs: 450
    },
    engineDurationMs: 450,
    prompt: secretPrompt,
    route: { actorId: '123456' },
    error: new Error('private error')
  }, {
    schemaVersion: 1,
    observationId,
    runRef,
    revision: 4,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 120,
    eventBytesDeleted: 512,
    tombstoneBytes: 768,
    endpoint: 'https://private.example',
    content: secretPrompt
  })

  assert.deepEqual(request, {
    event: 'chat.request',
    mode: 'api',
    stream: true,
    promptCharacters: secretPrompt.length
  })
  assert.deepEqual(response, {
    event: 'chat.response',
    mode: 'api',
    textCharacters: secretResponse.length,
    hasThinking: true,
    toolCallCount: 1,
    failed: false
  })
  assert.deepEqual(error, {
    event: 'chat.error',
    mode: 'api',
    category: 'provider_rate_limited',
    error: 'ChatGPTError',
    code: 'rate_limit',
    statusCode: 429
  })
  assert.deepEqual(messageInput, {
    event: 'chat.input.context',
    hasReply: true,
    replyResolved: true,
    currentSegmentCount: 2,
    replySegmentCount: 3,
    imageCount: 1,
    promptCharacters: secretPrompt.length
  })
  assert.deepEqual(agentRun, {
    event: 'agent.run',
    observationId,
    runRef,
    revision: 4,
    status: 'completed',
    completion: { kind: 'reply_text', lengthBucket: '1_40' },
    errorCode: null,
    cancellationReason: null,
    providerAttempts: 2,
    modelTurns: 2,
    toolAttempts: 3,
    providerRetries: 'unavailable',
    recoveryAttempts: 1,
    correctionTurns: 0,
    toolCalls: 3,
    approvalRequests: 1,
    toolDenied: 0,
    toolExpired: 0,
    toolIndeterminate: 0,
    estimatedTokens: 44,
    providerInputTokens: 'unavailable',
    providerOutputTokens: 4,
    providerTotalTokens: 'unavailable',
    providerActiveDurationMs: 400,
    engineDurationMs: 450,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 120,
    eventBytesDeleted: 512,
    tombstoneBytes: 768
  })
  assert.match(agentRun.runRef, /^[a-f0-9]{32}$/)
  assert.match(agentRun.observationId, /^[a-f0-9]{64}$/)

  const serialized = JSON.stringify({ request, response, error, messageInput, agentRun })
  assert.doesNotMatch(serialized, /secret|private|123456|https:|conversation|arguments/)
})

test('safe chat error logging does not invoke hostile metadata accessors', async () => {
  const { createChatErrorLog } = await import(pathToFileURL(runtimePath).href)
  let accessorCalls = 0
  const hostile = Object.create(null)
  for (const key of ['statusCode', 'status', 'name', 'code']) {
    Object.defineProperty(hostile, key, {
      get () {
        accessorCalls += 1
        throw new Error(`hostile ${key}`)
      }
    })
  }

  assert.deepEqual(createChatErrorLog({
    mode: 'api',
    category: 'provider_unknown_error',
    error: hostile
  }), {
    event: 'chat.error',
    mode: 'api',
    category: 'provider_unknown_error',
    error: 'unknown',
    code: 'unknown',
    statusCode: null
  })
  assert.equal(accessorCalls, 0)
})

test('terminal pair logging rejects hostile fact accessors without invoking them', async () => {
  const { createAgentRunLog } = await import(pathToFileURL(runtimePath).href)
  const runRef = 'a'.repeat(32)
  const observationId = terminalObservationId(runRef, 1)
  const snapshot = {
    schemaVersion: 2,
    observationId,
    runRef,
    revision: 1,
    status: 'completed',
    finishedAt: '2026-07-16T00:00:00.000Z',
    completion: { kind: 'reply_text', lengthBucket: '1_40' },
    errorCode: null,
    cancellationReason: null,
    counters: {
      schemaVersion: 1,
      providerAttempts: 1,
      modelTurns: 1,
      toolAttempts: 0,
      providerRetries: 0,
      recoveryAttempts: 0,
      correctionTurns: 0,
      toolCalls: 0,
      approvalRequests: 0,
      toolDenied: 0,
      toolExpired: 0,
      toolIndeterminate: 0,
      estimatedTokens: 8,
      providerInputTokens: 'unavailable',
      providerOutputTokens: 'unavailable',
      providerTotalTokens: 'unavailable',
      providerActiveDurationMs: 4,
      engineActiveDurationMs: 5
    },
    engineDurationMs: 5
  }
  const receipt = {
    schemaVersion: 1,
    observationId,
    runRef,
    revision: 1,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 10,
    eventBytesDeleted: 20,
    tombstoneBytes: 30
  }
  let calls = 0
  Object.defineProperty(snapshot, 'runRef', {
    enumerable: true,
    get () {
      calls += 1
      throw new Error('private getter')
    }
  })
  Object.defineProperty(snapshot, 'toJSON', {
    get () {
      calls += 1
      throw new Error('private toJSON')
    }
  })

  assert.throws(() => createAgentRunLog(snapshot as never, receipt), TypeError)
  assert.equal(calls, 0)
})

test('active chat sources do not pass raw conversation values to loggers', () => {
  const checks = [
    {
      file: 'src/runtime/yunzai-chat-controller.ts',
      patterns: [
        /logger\.info\(`chatgpt prompt: \$\{prompt\}`\)/,
        /logger\.(?:info|mark)\(\{ previousConversation \}\)/,
        /logger\.mark\(\{ conversation \}\)/,
        /logger\.info\(chatMessage\)/,
        /logger\.mark\('思考过程', thinking\)/,
        /logger\.(?:error|warn)\(err\)/
      ]
    }
  ]
  const offenders: string[] = []

  for (const check of checks) {
    const source = readFileSync(path.join(projectRoot, check.file), 'utf8')
    for (const pattern of check.patterns) {
      if (pattern.test(source)) offenders.push(`${check.file}: ${pattern.source}`)
    }
  }

  assert.deepEqual(offenders, [])
})

test('active chat and run summaries use only the safe logging boundary', () => {
  const chatSource = readFileSync(
    path.join(projectRoot, 'src', 'runtime', 'yunzai-chat-controller.ts'),
    'utf8'
  )
  const serviceSource = readFileSync(path.join(projectRoot, 'src', 'runtime', 'agent-service.ts'), 'utf8')
  const bridgeSource = readFileSync(path.join(projectRoot, 'src', 'runtime', 'agent-service-bridge.ts'), 'utf8')

  assert.match(chatSource, /createChatRequestLog\(/)
  assert.match(chatSource, /createChatResponseLog\(/)
  assert.match(chatSource, /createChatErrorLog\(/)
  assert.doesNotMatch(chatSource, /\bConfig\b|logger\./)
  assert.doesNotMatch(serviceSource, /#runStore\.load\(result\.runId\)/)
  assert.match(bridgeSource, /createAgentRunLog\(snapshot, receipt\)/)
  assert.doesNotMatch(
    `${chatSource}\n${serviceSource}\n${bridgeSource}`,
    /logger\.debug\(create(?:Chat|Agent)/
  )
})

test('observation logs project only fixed bounded fields', () => {
  const request = createRequestObservationLog({
    schemaVersion: 1,
    runRef: 'unavailable',
    requestRef: 'e'.repeat(32),
    requestKind: 'ordinary_chat',
    outcome: 'failed_request_validation',
    admissionRejectionReason: 'not_applicable',
    queueDurationMs: 'not_attempted',
    sessionLoadDurationMs: 'not_attempted',
    sessionSaveDurationMs: 'not_attempted',
    requestDurationMs: 8,
    terminalObservationId: 'not_attempted',
    prompt: 'private text',
    url: 'https://private.example'
  } as never)
  const presentation = createPresentationObservationLog({
    schemaVersion: 1,
    presentationObservationId: 'f'.repeat(64),
    runRef: 'a'.repeat(32),
    terminalObservationId: terminalObservationId('a'.repeat(32), 1),
    profile: 'ordinary',
    outcome: 'complete',
    postprocessAnomaly: false,
    deliveries: [{
      schemaVersion: 1,
      media: 'text',
      attempt: 1,
      outcome: 'sent',
      code: null
    }],
    totalDurationMs: 4,
    reducerInput: {
      schemaVersion: 1,
      reducerVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      textLengthBucket: '1_40',
      hasReasoning: false,
      hasCitation: false,
      buttonsEligible: false,
      ttsEligibility: 'disabled',
      pictureEligibility: 'disabled',
      quotePolicy: 'none',
      selectedMode: 'text',
      fallbackReason: 'none',
      configEnumVersion: 1
    }
  })

  assert.equal(request.event, 'observation.request')
  assert.equal(presentation.event, 'observation.presentation')
  const serialized = JSON.stringify({ request, presentation })
  assert.doesNotMatch(serialized, /private|https:|prompt|url/i)
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 4_096)
})

test('sink failure logs ignore hostile errors and are limited once per sink per minute', () => {
  let hostileCalls = 0
  const hostile = Object.create(null)
  for (const key of ['error', 'message', 'stack', 'cause', 'toJSON']) {
    Object.defineProperty(hostile, key, {
      get () {
        hostileCalls += 1
        throw new Error(`private ${key}`)
      }
    })
  }
  Object.defineProperties(hostile, {
    schemaVersion: { value: 1, enumerable: true },
    sink: { value: 'trace', enumerable: true },
    code: { value: 'timeout', enumerable: true },
    occurredAt: { value: '2026-07-16T00:00:00.000Z', enumerable: true }
  })
  const log = createObservationSinkFailureLog(hostile)
  assert.deepEqual(log, {
    event: 'observation.sink_failure',
    sink: 'trace',
    code: 'timeout',
    occurredAt: '2026-07-16T00:00:00.000Z'
  })
  assert.equal(hostileCalls, 0)
  assert.ok(Buffer.byteLength(JSON.stringify(log), 'utf8') < 4_096)

  let now = 1_000
  const limiter = new SafeObservationFailureLogLimiter({ now: () => now })
  assert.deepEqual(limiter.create(hostile), log)
  assert.equal(limiter.create(hostile), null)
  now += 59_999
  assert.equal(limiter.create(hostile), null)
  now += 1
  assert.deepEqual(limiter.create(hostile), log)
})
