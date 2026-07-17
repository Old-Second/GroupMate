import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentEvent, AgentEventType } from '../../src/agent/contracts/event.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot
} from '../../src/agent/run/run-observation.js'
import {
  MAX_TRACE_RECORD_BYTES,
  createTraceCandidate,
  internalSelectTraceEvents,
  parseTraceCandidate,
  type RunTraceEventV1
} from '../../src/agent/run/run-trace.js'
import {
  mergeStoredTracePresentation,
  mergeTracePresentation,
  parseStoredTraceRecord,
  parseTraceRecord
} from '../../src/runtime/observability/trace-record.js'
import {
  parsePresentationObservation,
  type PresentationObservationV1
} from '../../src/runtime/observability/observation-event.js'

const timestamp = '2026-07-16T00:00:00.000Z'
const runRef = '1'.repeat(32)
const requestRef = '2'.repeat(32)
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const emptyFingerprint = createHash('sha256').update('[]').digest('hex')

function event (
  sequence: number,
  type: AgentEventType,
  payload: AgentEvent['payload'] = Object.freeze({})
): AgentEvent {
  return createRunEvent({
    eventId: `private-event-${sequence}`,
    runId: 'private-run-id',
    sessionId: 'private-session-id',
    sequence,
    occurredAt: timestamp,
    type,
    payload
  })
}

function initial (): RunCheckpoint {
  return createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId: 'private-run-id',
    sessionId: 'private-session-id',
    sessionAddress: Object.freeze({
      botId: 'private-bot-id',
      scope: Object.freeze({ kind: 'group', groupId: 'private-group-id' })
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
        botId: 'private-bot-id',
        scope: Object.freeze({ kind: 'group', groupId: 'private-group-id' })
      }),
      actorId: 'private-actor-id'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic',
      runRef
    }),
    model: Object.freeze({
      model: 'private-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    toolSnapshot: Object.freeze({
      id: 'private-snapshot-id',
      fingerprint: emptyFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-16T00:04:00.000Z',
    createdAt: timestamp,
    event: event(0, 'run.created')
  })
}

function completed (events: readonly AgentEvent[]): RunCheckpoint {
  const preparing = nextRunCheckpoint(initial(), 'preparing', {}, [], timestamp)
  const source = nextRunCheckpoint(preparing, 'calling_model', {}, events, timestamp)
  const output = Object.freeze({
    id: 'private-assistant-id',
    role: 'assistant' as const,
    parts: Object.freeze([{ type: 'text' as const, text: 'safe' }]),
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
    completion: Object.freeze({ kind: 'reply_text', text: 'safe' })
  }, [event(source.nextEventSequence, 'run.completed')], timestamp)
}

function providerPayload (
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
  attemptKind: 'primary' | 'retry' | 'recovery' | 'correction',
  durationMs: number,
  errorCode: 'provider_unavailable' | null
): AgentEvent['payload'] {
  return Object.freeze({
    observationSchemaVersion: 1,
    attemptKind,
    outcome,
    durationMs,
    errorCode
  })
}

function presentation (candidate: ReturnType<typeof createTraceCandidate>): PresentationObservationV1 {
  return parsePresentationObservation({
    schemaVersion: 1,
    presentationObservationId: 'a'.repeat(64),
    runRef: candidate.runRef,
    terminalObservationId: candidate.observationId,
    profile: 'ordinary',
    outcome: 'complete',
    postprocessAnomaly: false,
    deliveries: [],
    totalDurationMs: 12,
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
}

function maximumPresentation (
  candidate: ReturnType<typeof createTraceCandidate>
): PresentationObservationV1 {
  return parsePresentationObservation({
    schemaVersion: 1,
    presentationObservationId: 'f'.repeat(64),
    runRef: candidate.runRef,
    terminalObservationId: candidate.observationId,
    profile: 'recovered_legacy_plain_text',
    outcome: 'unknown',
    postprocessAnomaly: true,
    deliveries: Array.from({ length: 12 }, (_, index) => ({
      schemaVersion: 1,
      media: 'picture',
      attempt: index % 2 === 0 ? 1 : 2,
      outcome: 'outcome_unknown',
      code: 'host_exception_after_dispatch'
    })),
    totalDurationMs: Number.MAX_SAFE_INTEGER,
    reducerInput: {
      schemaVersion: 1,
      reducerVersion: 1,
      requestKind: 'recovered_legacy_plain_text',
      profile: 'recovered_legacy_plain_text',
      textLengthBucket: 'over_4000',
      hasReasoning: true,
      hasCitation: true,
      buttonsEligible: true,
      ttsEligibility: 'unsupported',
      pictureEligibility: 'unsupported',
      quotePolicy: 'citation_forward',
      selectedMode: 'picture',
      fallbackReason: 'delivery_definite_failure',
      configEnumVersion: 1
    }
  })
}

function fixedPointBytes<T extends Record<string, unknown>> (value: T): T {
  let serializedBytes = 0
  for (let index = 0; index < 8; index += 1) {
    const current = { ...value, serializedBytes }
    const next = Buffer.byteLength(JSON.stringify(current), 'utf8')
    if (next === serializedBytes) return current as T
    serializedBytes = next
  }
  throw new Error('serialized byte fixed point was not reached')
}

test('trace candidate projects safe attempts and aggregates metrics before truncation', () => {
  const checkpoint = completed([
    event(1, 'model.attempted', providerPayload('failed', 'primary', 20, 'provider_unavailable')),
    event(2, 'model.attempted', providerPayload('succeeded', 'retry', 5, null)),
    event(3, 'tool.attempted', Object.freeze({
      observationSchemaVersion: 1,
      ordinal: 1,
      outcome: 'failed',
      durationMs: 11,
      resultCode: 'tool_execution_failed'
    })),
    event(4, 'approval.requested', Object.freeze({
      approvalId: 'private-approval-id',
      callId: 'private-call-id',
      ttlSeconds: 60
    })),
    event(5, 'approval.decided', Object.freeze({
      approvalId: 'private-approval-id',
      callId: 'private-call-id',
      decision: 'rejected'
    }))
  ])
  const candidate = createTraceCandidate({
    checkpoint,
    snapshot: createRunTerminalSnapshot(checkpoint)
  })

  assert.equal(candidate.runRef, runRef)
  assert.equal(candidate.observationId, candidate.terminal.observationId)
  assert.deepEqual(candidate.presentation, { kind: 'unavailable' })
  assert.equal(candidate.expiresAt, '2026-07-17T00:00:00.000Z')
  assert.equal(candidate.serializedBytes, Buffer.byteLength(JSON.stringify(candidate), 'utf8'))
  assert.ok(candidate.serializedBytes <= 32 * 1_024)
  assert.deepEqual(candidate.metricSummary.providerRequests.map(row => (
    [row.outcome, row.attemptKind, row.count, row.duration.sumMs]
  )), [
    ['failed', 'primary', 1, 20],
    ['succeeded', 'retry', 1, 5]
  ])
  assert.deepEqual(candidate.metricSummary.toolExecutions.map(row => (
    [row.outcome, row.count, row.duration.sumMs]
  )), [['failed', 1, 11]])
  assert.deepEqual(candidate.metricSummary.approvals, [
    { decision: 'denied', count: 1 },
    { decision: 'requested', count: 1 }
  ])
  const encoded = JSON.stringify(candidate)
  for (const secret of [
    'private-run-id', 'private-session-id', 'private-model',
    'private-call-id', 'private-approval-id', 'toolName'
  ]) {
    assert.equal(encoded.includes(secret), false)
  }
  assert.deepEqual(parseTraceCandidate(JSON.parse(encoded)), candidate)
  assert.throws(() => parseTraceCandidate({ ...candidate, runRef: '3'.repeat(32) }), TypeError)
  assert.throws(() => parseTraceCandidate({ ...candidate, privateBody: 'secret' }), TypeError)
})

test('candidate keeps required failures and full metrics at the Phase 5 event limit', () => {
  const events: AgentEvent[] = []
  for (let sequence = 1; sequence <= 94; sequence += 1) {
    events.push(event(
      sequence,
      'model.attempted',
      providerPayload(
        sequence === 1 ? 'failed' : 'succeeded',
        sequence === 1 ? 'primary' : 'retry',
        sequence,
        sequence === 1 ? 'provider_unavailable' : null
      )
    ))
  }
  const checkpoint = completed(events)
  const candidate = createTraceCandidate({
    checkpoint,
    snapshot: createRunTerminalSnapshot(checkpoint)
  })

  assert.equal(candidate.omittedEventCount, 0)
  assert.equal(candidate.events.filter(value => value.type === 'trace_truncated').length, 0)
  assert.equal(candidate.events.some(value => (
    value.type === 'provider_request' && value.sequence === 1 && value.outcome === 'failed'
  )), true)
  assert.equal(candidate.metricSummary.providerRequests.reduce(
    (total, row) => total + row.count,
    0
  ), 94)
  assert.ok(candidate.serializedBytes <= 32 * 1_024)
})

test('maximum required Phase 5 core and twelve-delivery presentation stay intact under 32 KiB', () => {
  const events = Array.from({ length: 94 }, (_, offset) => event(
    offset + 1,
    'model.attempted',
    providerPayload(
      'failed',
      'correction',
      Math.floor(Number.MAX_SAFE_INTEGER / 94),
      'provider_unavailable'
    )
  ))
  const checkpoint = completed(events)
  const candidate = createTraceCandidate({
    checkpoint,
    snapshot: createRunTerminalSnapshot(checkpoint)
  })
  const observed = maximumPresentation(candidate)
  const record = mergeTracePresentation({ candidate, presentation: observed })

  assert.equal(candidate.events.length, 96)
  assert.equal(candidate.omittedEventCount, 0)
  assert.equal(record.events.length, 96)
  assert.equal(record.omittedEventCount, 0)
  assert.equal(record.presentation.kind === 'observed'
    ? record.presentation.value.deliveries.length
    : 0, 12)
  assert.equal(record.events.filter(value => (
    value.type === 'provider_request' && value.outcome === 'failed'
  )).length, 94)
  assert.equal(record.serializedBytes, Buffer.byteLength(JSON.stringify(record), 'utf8'))
  assert.ok(record.serializedBytes <= MAX_TRACE_RECORD_BYTES)
})

test('trace selection keeps failures plus the newest fitting suffix and one cumulative marker', () => {
  type SourceEvent = Exclude<RunTraceEventV1, { readonly type: 'trace_truncated' }>
  const created: SourceEvent = Object.freeze({
    type: 'run_state', sequence: 0, occurredAt: timestamp, durationMs: null,
    state: 'created', errorCode: null
  })
  const failedAttempt: SourceEvent = Object.freeze({
    type: 'provider_request', sequence: 1, occurredAt: timestamp, durationMs: 1,
    outcome: 'failed', attemptKind: 'primary', errorCode: 'provider_unavailable'
  })
  const succeeded = (sequence: number): SourceEvent => Object.freeze({
    type: 'provider_request', sequence, occurredAt: timestamp, durationMs: 1,
    outcome: 'succeeded', attemptKind: 'retry', errorCode: null
  })
  const terminal: SourceEvent = Object.freeze({
    type: 'run_state', sequence: 5, occurredAt: timestamp, durationMs: null,
    state: 'completed', errorCode: null
  })
  const selection = internalSelectTraceEvents({
    events: [created, failedAttempt, succeeded(2), succeeded(3), succeeded(4), terminal],
    existingOmittedCount: 0,
    existingMarkerSequence: null,
    build: events => ({
      serializedBytes: 29_000 + events.reduce((total, value) => (
        total + (value.type === 'trace_truncated' ? 50 : 700)
      ), 0)
    })
  })

  assert.deepEqual(selection.events.map(value => value.sequence), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(selection.events.find(value => value.type === 'trace_truncated'), {
    type: 'trace_truncated', sequence: 2, omittedCount: 1
  })
  assert.equal(selection.events.some(value => (
    value.type === 'provider_request' && value.sequence === 1 &&
    'outcome' in value && value.outcome === 'failed'
  )), true)
  assert.equal(selection.events.some(value => (
    value.type === 'provider_request' && value.sequence === 2
  )), false)

  const cumulative = internalSelectTraceEvents({
    events: [created, { ...terminal, sequence: 7 }],
    existingOmittedCount: 4,
    existingMarkerSequence: 2,
    build: events => ({
      serializedBytes: 31_000 + events.reduce((total, value) => (
        total + (value.type === 'trace_truncated' ? 50 : 700)
      ), 0)
    })
  })
  assert.deepEqual(cumulative.events, [
    created,
    { type: 'trace_truncated', sequence: 2, omittedCount: 4 },
    { ...terminal, sequence: 7 }
  ])
  assert.equal(cumulative.omittedEventCount, 4)

  assert.throws(() => internalSelectTraceEvents({
    events: [created, failedAttempt, terminal],
    existingOmittedCount: 0,
    existingMarkerSequence: null,
    build: events => ({ serializedBytes: 31_000 + events.length * 700 })
  }), /required core/i)
})

test('trace parsers reject corrupt order and records join only the committed presentation', () => {
  const checkpoint = completed([
    event(1, 'context.prepared', Object.freeze({ messageCount: 1, estimatedInputTokens: 1 })),
    event(2, 'model.attempted', providerPayload('succeeded', 'primary', 7, null))
  ])
  const candidate = createTraceCandidate({
    checkpoint,
    snapshot: createRunTerminalSnapshot(checkpoint)
  })
  const observed = presentation(candidate)
  const record = mergeTracePresentation({ candidate, presentation: observed })
  assert.deepEqual(record.presentation, { kind: 'observed', value: observed })
  assert.deepEqual(parseTraceRecord(JSON.parse(JSON.stringify(record))), record)
  assert.throws(() => mergeTracePresentation({
    candidate,
    presentation: { ...observed, terminalObservationId: 'b'.repeat(64) }
  }), TypeError)

  const malformed = {
    ...candidate,
    events: [candidate.events[1], candidate.events[0], ...candidate.events.slice(2)]
  }
  assert.throws(() => parseTraceCandidate(malformed), TypeError)
  assert.throws(() => parseTraceCandidate({
    ...candidate,
    events: [candidate.events[0], {
      ...candidate.events[1],
      sequence: candidate.events[0]?.sequence
    }, ...candidate.events.slice(2)]
  }), TypeError)

  const scrambled = Object.fromEntries(Object.entries({
    ...candidate,
    terminal: Object.fromEntries(Object.entries(candidate.terminal).reverse())
  }).reverse())
  assert.deepEqual(parseTraceCandidate(scrambled), candidate)
  const terminalSequence = candidate.events.at(-1)?.sequence ?? 0
  const trailingMarker = fixedPointBytes({
    ...candidate,
    events: [...candidate.events, {
      type: 'trace_truncated',
      sequence: terminalSequence + 1,
      omittedCount: 1
    }],
    omittedEventCount: 1
  } as unknown as Record<string, unknown>)
  assert.throws(() => parseTraceCandidate(trailingMarker), TypeError)

  const unknown = Object.freeze({ type: 'future.safe', optional: true, sequence: 1 })
  const storedInput = fixedPointBytes({
    ...candidate,
    events: [candidate.events[0], unknown, ...candidate.events.slice(1)]
  } as unknown as Record<string, unknown>)
  const stored = parseStoredTraceRecord(storedInput)
  assert.equal(stored.events.some(value => value.type === 'future.safe'), true)
  assert.throws(() => parseTraceRecord(storedInput), TypeError)
  const merged = mergeStoredTracePresentation({ record: stored, presentation: observed })
  assert.equal(merged.events.some(value => value.type === 'future.safe'), true)
  assert.ok(merged.serializedBytes <= 32 * 1_024)

  let getterCalls = 0
  const hostileUnknown = Object.create(null)
  Object.defineProperties(hostileUnknown, {
    type: { value: 'future.safe', enumerable: true },
    optional: { value: true, enumerable: true },
    sequence: { value: 1, enumerable: true },
    privateBody: {
      enumerable: true,
      get () {
        getterCalls += 1
        return 'must not be read'
      }
    }
  })
  assert.throws(() => parseStoredTraceRecord({
    ...candidate,
    events: [candidate.events[0], hostileUnknown, ...candidate.events.slice(1)]
  }), TypeError)
  assert.equal(getterCalls, 0)
  assert.throws(() => parseStoredTraceRecord({
    ...candidate,
    events: [candidate.events[0], {
      type: 'future.required', sequence: 1
    }, ...candidate.events.slice(1)]
  }), TypeError)
})
