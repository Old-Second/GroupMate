import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { serializeAgentError, AgentError } from '../../src/agent/contracts/error.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  parseRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  DURATION_BUCKET_BOUNDS_MS,
  createRunTerminalSnapshot,
  parseDurationBucketCounts,
  parseCompletionObservation,
  parseRunTerminalSnapshot,
  parseRunTraceMetricSummary,
  terminalObservationId
} from '../../src/agent/run/run-observation.js'

const timestamp = '2026-07-16T00:00:00.000Z'
const runRef = '1'.repeat(32)
const requestRef = '2'.repeat(32)
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const emptyFingerprint = createHash('sha256').update('[]').digest('hex')

function initial (): RunCheckpoint {
  return createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId: 'run-private-id',
    sessionId: 'session-private-id',
    sessionAddress: Object.freeze({
      botId: 'bot-private-id',
      scope: Object.freeze({ kind: 'group', groupId: 'group-private-id' })
    }),
    runRef,
    requestRef,
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      }),
      sessionAddress: Object.freeze({
        botId: 'bot-private-id',
        scope: Object.freeze({ kind: 'group', groupId: 'group-private-id' })
      }),
      actorId: 'actor-private-id',
      requestMessageId: 'message-private-id'
    }),
    observationPolicy: Object.freeze({
      schemaVersion: 1,
      levelAtStart: 'basic',
      sampledSuccess: false
    }),
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    toolSnapshot: Object.freeze({
      id: 'snapshot-1',
      fingerprint: emptyFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-16T00:04:00.000Z',
    createdAt: timestamp,
    event: createRunEvent({
      eventId: 'event-0',
      runId: 'run-private-id',
      sessionId: 'session-private-id',
      sequence: 0,
      occurredAt: timestamp,
      type: 'run.created',
      payload: Object.freeze({})
    })
  })
}

function completed (text: string): RunCheckpoint {
  const source = terminalSource()
  const output = Object.freeze({
    id: 'assistant-message-private-id',
    role: 'assistant' as const,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt: timestamp,
    provenance: Object.freeze({
      source: 'model' as const,
      trust: 'untrusted' as const,
      sensitivity: 'group' as const,
      sourceId: source.runId,
      createdAt: timestamp
    })
  })
  return nextRunCheckpoint(source, 'completed', {
    output,
    completion: Object.freeze({ kind: 'reply_text', text }),
    observationCounters: Object.freeze({
      ...source.observationCounters,
      providerAttempts: 1,
      modelTurns: 1,
      providerInputTokens: 7,
      providerOutputTokens: 3,
      providerTotalTokens: 10,
      providerActiveDurationMs: 5,
      engineActiveDurationMs: 13
    })
  }, [], timestamp)
}

function failed (): RunCheckpoint {
  const source = terminalSource()
  return nextRunCheckpoint(source, 'failed', {
    error: serializeAgentError(new AgentError({
      code: 'provider_unavailable',
      stage: 'model.response',
      retryable: true,
      userMessage: 'safe'
    })),
    observationCounters: Object.freeze({
      ...source.observationCounters,
      providerAttempts: 1,
      modelTurns: 0,
      providerInputTokens: 'unavailable',
      providerOutputTokens: 'unavailable',
      providerTotalTokens: 'unavailable',
      providerActiveDurationMs: 4,
      engineActiveDurationMs: 9
    })
  }, [], timestamp)
}

function cancelled (reason = 'user_cancelled'): RunCheckpoint {
  const source = terminalSource()
  return nextRunCheckpoint(source, 'cancelled', {
    cancellationReason: reason,
    observationCounters: Object.freeze({
      ...source.observationCounters,
      modelTurns: 'unavailable',
      toolAttempts: 'unavailable',
      engineActiveDurationMs: 'unavailable'
    })
  }, [], timestamp)
}

function terminalSource (): RunCheckpoint {
  const created = initial()
  const preparing = nextRunCheckpoint(created, 'preparing', {}, [], timestamp)
  return nextRunCheckpoint(preparing, 'calling_model', {}, [], timestamp)
}

test('terminalObservationId hashes only the stable v2 run reference and revision tuple', () => {
  const expected = createHash('sha256')
    .update(`groupmate:terminal:v2\0${runRef}\0${0}`, 'utf8')
    .digest('hex')

  assert.equal(terminalObservationId(runRef, 0), expected)
  assert.equal(terminalObservationId(runRef, 0), expected)
  assert.match(expected, /^[a-f0-9]{64}$/)
  assert.notEqual(terminalObservationId(runRef, 1), expected)
  assert.notEqual(terminalObservationId('3'.repeat(32), 0), expected)
  assert.throws(() => terminalObservationId('raw-run-id', 0), /run reference/i)
  assert.throws(() => terminalObservationId(runRef, -1), /revision/i)
  assert.throws(() => terminalObservationId(runRef, Number.MAX_SAFE_INTEGER + 1), /revision/i)
})

test('parseCompletionObservation accepts only the bounded body-free completion projection', () => {
  for (const value of [
    { kind: 'reply_text', lengthBucket: '1_40' },
    { kind: 'reply_text', lengthBucket: '41_200' },
    { kind: 'reply_text', lengthBucket: '201_1000' },
    { kind: 'reply_text', lengthBucket: '1001_4000' },
    { kind: 'reply_text', lengthBucket: 'over_4000' },
    { kind: 'already_visible', source: 'tool_output' },
    { kind: 'allowed_silence', reason: 'proactive_empty_directive' },
    { kind: 'none' }
  ]) {
    const parsed = parseCompletionObservation(value)
    assert.deepEqual(parsed, value)
    assert.equal(Object.isFrozen(parsed), true)
  }

  const hostile = [
    { kind: 'reply_text', lengthBucket: '1_40', text: 'private body' },
    { kind: 'reply_text', lengthBucket: '1_40', reasoning: 'private reasoning' },
    { kind: 'reply_text', lengthBucket: '1_40', route: { actorId: 'private' } },
    { kind: 'reply_text', lengthBucket: '1_40', messageId: 'private' },
    { kind: 'already_visible', source: 'tool_output', toolResult: 'private' },
    { kind: 'allowed_silence', reason: 'proactive_empty_directive', extra: true },
    { kind: 'none', reason: 'private' },
    { kind: 'reply_text', lengthBucket: '0_40' },
    { kind: 'already_visible', source: 'message_output' },
    { kind: 'allowed_silence', reason: 'model_empty' }
  ]
  for (const value of hostile) {
    assert.throws(() => parseCompletionObservation(value), /completion observation/i)
  }
})

test('createRunTerminalSnapshot projects exact safe terminal fields and text length buckets', () => {
  const cases = [
    ['x'.repeat(40), '1_40'],
    ['x'.repeat(41), '41_200'],
    ['x'.repeat(201), '201_1000'],
    ['x'.repeat(1001), '1001_4000'],
    ['x'.repeat(4001), 'over_4000']
  ] as const
  for (const [text, lengthBucket] of cases) {
    const checkpoint = completed(text)
    const snapshot = createRunTerminalSnapshot(checkpoint)
    assert.equal(snapshot.schemaVersion, 2)
    assert.equal(snapshot.observationId, terminalObservationId(runRef, checkpoint.revision))
    assert.equal(snapshot.runRef, runRef)
    assert.equal(snapshot.revision, checkpoint.revision)
    assert.equal(snapshot.status, 'completed')
    assert.equal(snapshot.finishedAt, timestamp)
    assert.deepEqual(snapshot.completion, { kind: 'reply_text', lengthBucket })
    assert.equal(snapshot.errorCode, null)
    assert.equal(snapshot.cancellationReason, null)
    assert.equal(snapshot.engineDurationMs, 13)
    assert.equal(snapshot.engineDurationMs, snapshot.counters.engineActiveDurationMs)
    assert.equal(Object.hasOwn(checkpoint, 'traceMetricSummary'), false)
    assert.equal(Object.hasOwn(snapshot, 'traceMetricSummary'), false)
    const encoded = JSON.stringify(snapshot)
    assert.equal(encoded.includes(text), false)
    assert.equal(encoded.includes('run-private-id'), false)
    assert.equal(encoded.includes('assistant-message-private-id'), false)
    assert.equal(encoded.includes('actor-private-id'), false)
  }

  assert.deepEqual(createRunTerminalSnapshot(failed()).completion, { kind: 'none' })
  assert.equal(createRunTerminalSnapshot(failed()).errorCode, 'provider_unavailable')
  assert.deepEqual(createRunTerminalSnapshot(cancelled()).completion, { kind: 'none' })
  assert.equal(createRunTerminalSnapshot(cancelled()).cancellationReason, 'user_cancelled')
  assert.equal(createRunTerminalSnapshot(cancelled()).engineDurationMs, 'unavailable')
  const privateCancellation = createRunTerminalSnapshot(cancelled('message-private-id'))
  assert.equal(privateCancellation.cancellationReason, 'other')
  assert.equal(JSON.stringify(privateCancellation).includes('message-private-id'), false)
  assert.throws(() => createRunTerminalSnapshot(initial()), /terminal checkpoint/i)
})

test('parseRunTerminalSnapshot enforces exact keys, terminal matrix and identical engine duration', () => {
  const numeric = createRunTerminalSnapshot(completed('safe'))
  const unavailable = createRunTerminalSnapshot(cancelled())
  assert.deepEqual(parseRunTerminalSnapshot(numeric), numeric)
  assert.deepEqual(parseRunTerminalSnapshot(unavailable), unavailable)
  assert.equal(Object.isFrozen(parseRunTerminalSnapshot(numeric)), true)

  const hostile: unknown[] = [
    { ...numeric, engineDurationMs: 12 },
    { ...unavailable, engineDurationMs: 0 },
    { ...numeric, engineDurationMs: 'not_attempted' },
    {
      ...numeric,
      counters: { ...numeric.counters, engineActiveDurationMs: 'not_attempted' },
      engineDurationMs: 'not_attempted'
    },
    { ...numeric, observationId: terminalObservationId(runRef, numeric.revision + 1) },
    { ...numeric, runRef: '3'.repeat(32) },
    { ...numeric, status: 'completed', completion: { kind: 'none' } },
    { ...numeric, status: 'failed', errorCode: null, completion: { kind: 'none' } },
    { ...numeric, status: 'cancelled', cancellationReason: null, completion: { kind: 'none' } },
    { ...unavailable, cancellationReason: 'message-private-id' },
    { ...numeric, privateBody: 'secret' }
  ]
  for (const value of hostile) {
    assert.throws(() => parseRunTerminalSnapshot(value), /terminal snapshot|observation|engine duration/i)
  }
})

test('trace metric summary parser fixes cumulative buckets, row order and bounded domains', () => {
  const duration = {
    count: 1,
    sumMs: 20,
    unavailableCount: 1,
    le10: 0,
    le25: 1,
    le50: 1,
    le100: 1,
    le250: 1,
    le500: 1,
    le1000: 1,
    le2500: 1,
    le5000: 1,
    le10000: 1,
    le30000: 1,
    le60000: 1,
    le120000: 1,
    inf: 1
  }
  assert.deepEqual(DURATION_BUCKET_BOUNDS_MS, [
    10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
    30000, 60000, 120000, 'inf'
  ])
  assert.deepEqual(parseDurationBucketCounts(duration), duration)

  const summary = {
    schemaVersion: 1,
    providerRequests: [{
      outcome: 'failed',
      attemptKind: 'retry',
      count: 2,
      duration
    }, {
      outcome: 'succeeded',
      attemptKind: 'primary',
      count: 1,
      duration: {
        ...duration,
        unavailableCount: 0
      }
    }],
    toolExecutions: [{
      outcome: 'failed',
      count: 2,
      duration
    }],
    approvals: [{ decision: 'requested', count: 1 }]
  }
  assert.deepEqual(parseRunTraceMetricSummary(summary), summary)
  assert.equal(Object.isFrozen(parseRunTraceMetricSummary(summary)), true)

  const unavailableOnlyWithSum = {
    ...duration,
    count: 0,
    sumMs: 123,
    unavailableCount: 1,
    le10: 0,
    le25: 0,
    le50: 0,
    le100: 0,
    le250: 0,
    le500: 0,
    le1000: 0,
    le2500: 0,
    le5000: 0,
    le10000: 0,
    le30000: 0,
    le60000: 0,
    le120000: 0,
    inf: 0
  }
  assert.throws(() => parseDurationBucketCounts(unavailableOnlyWithSum), TypeError)
  assert.throws(() => parseRunTraceMetricSummary({
    ...summary,
    providerRequests: [{
      ...summary.providerRequests[0],
      count: 1,
      duration: unavailableOnlyWithSum
    }]
  }), TypeError)

  const invalid = [
    { ...summary, secret: true },
    { ...summary, providerRequests: [...summary.providerRequests].reverse() },
    { ...summary, providerRequests: [summary.providerRequests[0], summary.providerRequests[0]] },
    { ...summary, providerRequests: Array(17).fill(summary.providerRequests[0]) },
    { ...summary, toolExecutions: Array(5).fill(summary.toolExecutions[0]) },
    { ...summary, approvals: Array(5).fill(summary.approvals[0]) },
    {
      ...summary,
      providerRequests: [{ ...summary.providerRequests[0], count: 0 }]
    },
    {
      ...summary,
      providerRequests: [{
        ...summary.providerRequests[0],
        duration: { ...duration, unavailableCount: 0 }
      }]
    },
    {
      ...summary,
      providerRequests: [{ ...summary.providerRequests[0], outcome: 'other' }]
    },
    {
      ...summary,
      providerRequests: [{ ...summary.providerRequests[0], model: 'private-model' }]
    },
    {
      ...summary,
      toolExecutions: [{ ...summary.toolExecutions[0], toolName: 'private-tool' }]
    },
    {
      ...summary,
      toolExecutions: [{ ...summary.toolExecutions[0], outcome: 'unknown' }]
    },
    {
      ...summary,
      approvals: [{ decision: 'denied', count: 1 }, { decision: 'approved', count: 1 }]
    },
    { ...duration, inf: 0 },
    { ...duration, le10: 2 },
    { ...duration, sumMs: 'unavailable' }
  ]
  for (const value of invalid) {
    const parse = Object.hasOwn(value, 'schemaVersion')
      ? () => parseRunTraceMetricSummary(value)
      : () => parseDurationBucketCounts(value)
    assert.throws(parse, TypeError)
  }
})

test('trace metric summary parser rejects hostile arrays and accessors without invoking them', () => {
  const summary = {
    schemaVersion: 1,
    providerRequests: [] as unknown[],
    toolExecutions: [],
    approvals: []
  }
  Object.defineProperty(summary.providerRequests, 'secret', {
    value: 'private',
    enumerable: true
  })
  assert.throws(() => parseRunTraceMetricSummary(summary), TypeError)

  assert.throws(() => parseRunTraceMetricSummary({
    ...summary,
    providerRequests: new Array(1)
  }), TypeError)

  let getterCalls = 0
  const row = Object.create(null)
  Object.defineProperties(row, {
    outcome: {
      enumerable: true,
      get () {
        getterCalls += 1
        return 'failed'
      }
    },
    attemptKind: { value: 'retry', enumerable: true },
    count: { value: 1, enumerable: true },
    duration: {
      value: {
        count: 0,
        sumMs: 0,
        unavailableCount: 1,
        le10: 0,
        le25: 0,
        le50: 0,
        le100: 0,
        le250: 0,
        le500: 0,
        le1000: 0,
        le2500: 0,
        le5000: 0,
        le10000: 0,
        le30000: 0,
        le60000: 0,
        le120000: 0,
        inf: 0
      },
      enumerable: true
    }
  })
  assert.throws(() => parseRunTraceMetricSummary({
    schemaVersion: 1,
    providerRequests: [row],
    toolExecutions: [],
    approvals: []
  }), TypeError)
  assert.equal(getterCalls, 0)
})

test('checkpoint parser rejects every terminal next that still carries a reservation', () => {
  const terminal = completed('safe')
  for (const changes of [
    { providerDispatch: Object.freeze({ state: 'reserved' as const }) },
    { engineActivity: Object.freeze({ state: 'reserved' as const }) },
    {
      providerDispatch: Object.freeze({ state: 'reserved' as const }),
      engineActivity: Object.freeze({ state: 'reserved' as const })
    }
  ]) {
    assert.throws(() => parseRunCheckpoint({ ...terminal, ...changes }), /terminal.*reservation/i)
  }
})
