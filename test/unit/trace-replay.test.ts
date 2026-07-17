import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StoredRunTraceEventV1 } from '../../src/agent/run/run-trace.js'
import { replayTrace } from '../../src/runtime/observability/trace-replay.js'
import {
  mergeTracePresentation,
  parseStoredTraceRecord,
  type StoredTraceRecordV1
} from '../../src/runtime/observability/trace-record.js'
import {
  traceCandidateFixture,
  tracePresentationFixture
} from '../helpers/trace-fixture.js'

function recordWithEvents (
  record: StoredTraceRecordV1,
  events: readonly unknown[]
): unknown {
  let serializedBytes = 0
  for (let index = 0; index < 16; index += 1) {
    const value = {
      schemaVersion: 1,
      runRef: record.runRef,
      observationId: record.observationId,
      terminal: record.terminal,
      policy: record.policy,
      metricSummary: record.metricSummary,
      events,
      omittedEventCount: record.omittedEventCount,
      presentation: record.presentation,
      expiresAt: record.expiresAt,
      serializedBytes
    }
    const next = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (next === serializedBytes) return value
    serializedBytes = next
  }
  throw new Error('fixture serialized byte fixed point was not found')
}

function recordWithOptionalEvent (): StoredTraceRecordV1 {
  const candidate = parseStoredTraceRecord(traceCandidateFixture())
  const created = candidate.events[0]
  const terminal = candidate.events[1]
  assert.ok(created !== undefined)
  assert.ok(terminal !== undefined && terminal.type === 'run_state')
  return parseStoredTraceRecord(recordWithEvents(candidate, [
    created,
    { type: 'future.safe_event', optional: true, sequence: 1 },
    { ...terminal, sequence: 2 }
  ]))
}

test('pure replay returns only deterministic safe phases and metric summary', () => {
  const candidate = traceCandidateFixture({ status: 'failed' })
  const result = replayTrace(candidate)

  assert.equal(result.kind, 'replayed')
  if (result.kind !== 'replayed') return
  assert.equal(result.report.runRef, candidate.runRef)
  assert.equal(result.report.outcome, 'failed')
  assert.deepEqual(result.report.phases, ['run_state', 'run_state'])
  assert.equal(result.report.omittedEventCount, 0)
  assert.equal(result.report.unsupportedEventCount, 0)
  assert.deepEqual(result.report.metricSummary, candidate.metricSummary)
  assert.deepEqual(result.report.presentation, { kind: 'unavailable' })
})

test('pure replay reduces an observed presentation without invoking external ports', () => {
  const candidate = traceCandidateFixture()
  const observed = mergeTracePresentation({
    candidate,
    presentation: tracePresentationFixture(candidate, { anomaly: true })
  })

  const result = replayTrace(observed)
  assert.deepEqual(result.kind === 'replayed' ? result.report.presentation : result, {
    kind: 'reduced',
    selectedMode: 'text',
    fallbackReason: 'delivery_definite_failure'
  })
})

test('same-major unknown optional events are safely skipped and counted', () => {
  const stored = recordWithOptionalEvent()
  const result = replayTrace(stored)

  assert.equal(result.kind, 'replayed')
  if (result.kind !== 'replayed') return
  assert.deepEqual(result.report.phases, [
    'run_state',
    'unsupported_event',
    'run_state'
  ])
  assert.equal(result.report.unsupportedEventCount, 1)
})

test('unknown optional envelopes still obey canonical bytes order and terminal-last rules', () => {
  const stored = recordWithOptionalEvent()
  const optional = stored.events[1]
  const terminal = stored.events[2]
  assert.ok(optional !== undefined && terminal !== undefined)

  assert.equal(replayTrace({ ...stored, events: [stored.events[0], terminal, optional] }).kind,
    'invalid_trace')
  assert.equal(replayTrace({ ...stored, events: [stored.events[0], optional] }).kind,
    'invalid_trace')
  assert.equal(replayTrace({ ...stored, serializedBytes: stored.serializedBytes + 1 }).kind,
    'invalid_trace')
})

test('unknown mandatory, array, oversize, known-name and extra-key events are invalid', () => {
  const candidate = parseStoredTraceRecord(traceCandidateFixture())
  const invalidEvents: readonly unknown[] = [
    { type: 'future_event', sequence: 1 },
    ['future_event', true, 1],
    { type: `f${'x'.repeat(64)}`, optional: true, sequence: 1 },
    { type: 'run_state', optional: true, sequence: 1 },
    { type: 'future_event', optional: true, sequence: 1, extra: false }
  ]

  for (const invalid of invalidEvents) {
    assert.equal(replayTrace({
      ...candidate,
      events: [candidate.events[0], invalid, candidate.events[1]]
    }).kind, 'invalid_trace')
  }
})

test('replay rejects accessors without invoking them', () => {
  const candidate = parseStoredTraceRecord(traceCandidateFixture())
  let reads = 0
  const event = { type: 'future_event', optional: true, sequence: 1 }
  Object.defineProperty(event, 'extra', {
    enumerable: true,
    get () {
      reads += 1
      return 'secret'
    }
  })
  const schemaAccessor = Object.create(null) as Record<string, unknown>
  Object.defineProperty(schemaAccessor, 'schemaVersion', {
    enumerable: true,
    get () {
      reads += 1
      return 1
    }
  })

  assert.equal(replayTrace({
    ...candidate,
    events: [candidate.events[0], event, candidate.events[1]]
  }).kind, 'invalid_trace')
  assert.equal(replayTrace(schemaAccessor).kind, 'invalid_trace')
  assert.equal(reads, 0)
})

test('unknown major is unsupported while malformed v1 and non-records are invalid', () => {
  let toJsonCalls = 0
  const future = Object.create(null) as Record<string, unknown>
  Object.defineProperties(future, {
    schemaVersion: { enumerable: true, value: 2 },
    toJSON: {
      enumerable: true,
      get () {
        toJsonCalls += 1
        return () => ({ schemaVersion: 1 })
      }
    }
  })

  assert.deepEqual(replayTrace(future), { kind: 'unsupported_version' })
  assert.deepEqual(replayTrace({ schemaVersion: 1 }), { kind: 'invalid_trace' })
  assert.deepEqual(replayTrace([]), { kind: 'invalid_trace' })
  assert.deepEqual(replayTrace(null), { kind: 'invalid_trace' })
  assert.equal(toJsonCalls, 0)
})

test('stored replay accepts the exact optional-event reader model', () => {
  const events: readonly StoredRunTraceEventV1[] = recordWithOptionalEvent().events
  assert.equal(events[1]?.type, 'future.safe_event')
  assert.equal(replayTrace(recordWithOptionalEvent()).kind, 'replayed')
})
