import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateRequestObservation,
  beginRequestObservation,
  createRequestObservationDraft,
  finalizeRequestObservation,
  parseRequestObservation
} from '../../src/runtime/request-observation.js'

const requestRef = 'a'.repeat(32)
const runRef = 'b'.repeat(32)
const terminalObservationId = 'c'.repeat(64)

function validObservation (overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    runRef: 'unavailable',
    requestRef,
    requestKind: 'ordinary_chat',
    outcome: 'failed_request_validation',
    admissionRejectionReason: 'not_applicable',
    queueDurationMs: 'not_attempted',
    sessionLoadDurationMs: 'not_attempted',
    sessionSaveDurationMs: 'not_attempted',
    requestDurationMs: 7,
    terminalObservationId: 'not_attempted',
    ...overrides
  }
}

test('request observation parser enforces exact pre-create stage semantics', () => {
  const observation = validObservation()

  assert.deepEqual(parseRequestObservation(observation), observation)
  assert.throws(() => parseRequestObservation({
    ...observation,
    queueDurationMs: 0
  }), TypeError)
  assert.throws(() => parseRequestObservation({
    ...observation,
    prompt: 'must never be observable'
  }), TypeError)
})

test('request observation parser accepts only the six exact stage matrices', () => {
  const valid = [
    validObservation(),
    validObservation({
      requestKind: 'proactive_chat'
    }),
    validObservation({
      outcome: 'rejected_admission',
      admissionRejectionReason: 'queue_full',
      queueDurationMs: 'unavailable'
    }),
    validObservation({
      outcome: 'failed_session_load',
      queueDurationMs: 1,
      sessionLoadDurationMs: 'unavailable'
    }),
    validObservation({
      outcome: 'failed_run_create',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2
    }),
    validObservation({
      requestKind: 'proactive_chat',
      outcome: 'failed_run_create',
      queueDurationMs: 1
    }),
    validObservation({
      runRef,
      outcome: 'completed',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2,
      sessionSaveDurationMs: 3,
      terminalObservationId
    }),
    validObservation({
      runRef,
      requestKind: 'proactive_chat',
      outcome: 'completed',
      queueDurationMs: 1,
      terminalObservationId: 'unavailable'
    }),
    validObservation({
      runRef,
      outcome: 'failed_session_save',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2,
      sessionSaveDurationMs: 'unavailable',
      terminalObservationId
    }),
    validObservation({
      runRef,
      requestKind: 'legacy_unknown',
      outcome: 'completed',
      queueDurationMs: 'unavailable',
      sessionLoadDurationMs: 'unavailable',
      requestDurationMs: 'unavailable',
      terminalObservationId
    })
  ]
  for (const value of valid) assert.deepEqual(parseRequestObservation(value), value)

  const invalid = [
    validObservation({ requestRef: 'A'.repeat(32) }),
    validObservation({ requestRef: 'a'.repeat(31) }),
    validObservation({ requestDurationMs: 'not_attempted' }),
    validObservation({ requestDurationMs: -1 }),
    validObservation({ requestDurationMs: 0.5 }),
    validObservation({ requestDurationMs: Number.POSITIVE_INFINITY }),
    validObservation({ requestDurationMs: Number.MAX_SAFE_INTEGER + 1 }),
    validObservation({ admissionRejectionReason: 'queue_full' }),
    validObservation({ outcome: 'rejected_admission' }),
    validObservation({
      outcome: 'rejected_admission',
      admissionRejectionReason: 'unavailable',
      queueDurationMs: 'not_attempted'
    }),
    validObservation({
      outcome: 'failed_session_load',
      requestKind: 'proactive_chat',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2
    }),
    validObservation({
      runRef,
      outcome: 'completed',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2,
      terminalObservationId: 'not_attempted'
    }),
    validObservation({
      runRef,
      outcome: 'failed_session_save',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2,
      sessionSaveDurationMs: 3,
      terminalObservationId: 'unavailable'
    }),
    validObservation({
      runRef,
      outcome: 'completed',
      queueDurationMs: 1,
      sessionLoadDurationMs: 2,
      terminalObservationId: 'C'.repeat(64)
    }),
    validObservation({
      runRef,
      requestKind: 'legacy_unknown',
      outcome: 'completed',
      queueDurationMs: 0,
      sessionLoadDurationMs: 'unavailable',
      requestDurationMs: 'unavailable',
      terminalObservationId
    })
  ]
  for (const value of invalid) assert.throws(() => parseRequestObservation(value), TypeError)
})

test('active request contexts freeze claimed identity and entered stages', () => {
  const ordinary = activateRequestObservation({
    context: beginRequestObservation({
      requestRef,
      requestKind: 'ordinary_chat',
      startedAtMonotonicMs: 10
    }),
    runRef,
    queueDurationMs: 2,
    sessionLoadDurationMs: 3
  })
  const draft = createRequestObservationDraft({
    context: ordinary,
    outcome: 'completed',
    admissionRejectionReason: 'not_applicable',
    sessionSaveDurationMs: 'not_attempted',
    terminalObservationId
  })

  assert.equal(draft.runRef, runRef)
  assert.equal(draft.queueDurationMs, 2)
  assert.equal(draft.sessionLoadDurationMs, 3)
  assert.equal(Object.hasOwn(ordinary, 'outcome'), false)
  assert.equal(Object.hasOwn(ordinary, 'terminalObservationId'), false)

  assert.throws(() => activateRequestObservation({
    context: beginRequestObservation({
      requestRef,
      requestKind: 'proactive_chat',
      startedAtMonotonicMs: 10
    }),
    runRef,
    queueDurationMs: 2,
    sessionLoadDurationMs: 0
  }), TypeError)
})

test('request observation draft finalizes monotonic duration without leaking start time', () => {
  const context = beginRequestObservation({
    requestRef,
    requestKind: 'ordinary_chat',
    startedAtMonotonicMs: 10
  })
  const draft = createRequestObservationDraft({
    context,
    runRef: 'unavailable',
    outcome: 'failed_request_validation',
    admissionRejectionReason: 'not_applicable',
    queueDurationMs: 'not_attempted',
    sessionLoadDurationMs: 'not_attempted',
    sessionSaveDurationMs: 'not_attempted',
    terminalObservationId: 'not_attempted'
  })
  const observation = finalizeRequestObservation({
    draft,
    finishedAtMonotonicMs: 17
  })

  assert.equal(observation.requestDurationMs, 7)
  assert.equal(Object.hasOwn(observation, 'startedAtMonotonicMs'), false)

  assert.equal(finalizeRequestObservation({
    draft,
    finishedAtMonotonicMs: 9
  }).requestDurationMs, 'unavailable')
})
