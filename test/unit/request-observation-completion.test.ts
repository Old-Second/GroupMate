import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PresentationResult } from '../../src/runtime/presentation/presentation-result.js'
import {
  beginRequestObservation,
  createRequestObservationDraft,
  type RequestObservationV1
} from '../../src/runtime/request-observation.js'
import {
  createPresentationCompletionCoordinator,
  RequestObservationAlreadyCompletedError
} from '../../src/runtime/request-observation-completion.js'
import type {
  FinalChatReplyEnvelope,
  PausedChatReplyEnvelope
} from '../../src/runtime/agent-service.js'

const requestRef = '1'.repeat(32)

function finalEnvelope (
  startedAtMonotonicMs: number | 'unavailable' = 10
): Extract<FinalChatReplyEnvelope, { readonly kind: 'failed' }> {
  const context = beginRequestObservation({
    requestRef,
    requestKind: 'ordinary_chat',
    startedAtMonotonicMs
  })
  return Object.freeze({
    kind: 'failed',
    runId: 'request-validation-failure',
    runRef: 'unavailable',
    error: Object.freeze({
      code: 'invalid_request',
      stage: 'request.validation',
      retryable: false,
      userMessage: '请求格式不正确，请联系机器人主人',
      details: Object.freeze({})
    }),
    terminal: null,
    requestObservationDraft: createRequestObservationDraft({
      context,
      runRef: 'unavailable',
      outcome: 'failed_request_validation',
      admissionRejectionReason: 'not_applicable',
      queueDurationMs: 'not_attempted',
      sessionLoadDurationMs: 'not_attempted',
      sessionSaveDurationMs: 'not_attempted',
      terminalObservationId: 'not_attempted'
    }),
    sessionPersistence: 'not_attempted'
  })
}

function presentationResult (): PresentationResult {
  return Object.freeze({
    schemaVersion: 1,
    outcome: 'failed',
    deliveries: Object.freeze([])
  })
}

test('completion coordinator publishes one finalized observation after terminal presentation', async () => {
  const events: string[] = []
  const published: RequestObservationV1[] = []
  const envelope = finalEnvelope()
  const expected = presentationResult()
  const coordinator = createPresentationCompletionCoordinator({
    publisher: {
      async publish (observation) {
        events.push('publish')
        published.push(observation)
      }
    },
    monotonicNow: () => {
      events.push('finish')
      return 37
    }
  })

  const result = await coordinator.complete({
    envelope,
    async present (projection) {
      events.push('present')
      assert.equal(projection.result.kind, 'failed')
      assert.equal(projection.sessionPersistence, 'not_attempted')
      return expected
    }
  })

  assert.equal(result, expected)
  assert.deepEqual(events, ['present', 'finish', 'publish'])
  assert.equal(published.length, 1)
  assert.deepEqual(Reflect.ownKeys(published[0] ?? {}), [
    'schemaVersion',
    'runRef',
    'requestRef',
    'requestKind',
    'outcome',
    'admissionRejectionReason',
    'queueDurationMs',
    'sessionLoadDurationMs',
    'sessionSaveDurationMs',
    'requestDurationMs',
    'terminalObservationId'
  ])
  assert.equal(published[0]?.requestDurationMs, 27)

  await assert.rejects(
    coordinator.complete({
      envelope,
      present: async () => {
        events.push('unexpected_second_present')
        return expected
      }
    }),
    RequestObservationAlreadyCompletedError
  )
  assert.deepEqual(events, ['present', 'finish', 'publish'])
})

test('completion coordinator does not finalize paused and preserves unavailable restart duration', async () => {
  let presentCalls = 0
  let publishCalls = 0
  const coordinator = createPresentationCompletionCoordinator({
    publisher: {
      publish () { publishCalls++ }
    },
    monotonicNow: () => 100
  })
  const paused = Object.freeze({
    kind: 'paused',
    runId: 'paused-run',
    runRef: '2'.repeat(32),
    interruption: Object.freeze({}),
    requestObservationContext: Object.freeze({})
  }) as unknown as PausedChatReplyEnvelope

  await assert.rejects(coordinator.complete({
    envelope: paused as unknown as FinalChatReplyEnvelope,
    present: async () => {
      presentCalls++
      return presentationResult()
    }
  }))
  assert.equal(presentCalls, 0)
  assert.equal(publishCalls, 0)

  let observation: RequestObservationV1 | undefined
  const unavailableCoordinator = createPresentationCompletionCoordinator({
    publisher: { publish: value => { observation = value } },
    monotonicNow: () => 100
  })
  await unavailableCoordinator.complete({
    envelope: finalEnvelope('unavailable'),
    present: async () => presentationResult()
  })
  assert.equal(observation?.requestDurationMs, 'unavailable')
})

test('completion coordinator isolates publisher failure and strips presentation-local facts', async () => {
  const failureCodes: string[] = []
  let published: RequestObservationV1 | undefined
  const expected = presentationResult()
  const coordinator = createPresentationCompletionCoordinator({
    publisher: {
      publish (observation) {
        published = observation
        throw new Error('publisher is unavailable')
      }
    },
    monotonicNow: () => 20,
    onPublishFailure: code => { failureCodes.push(code) }
  })

  const result = await coordinator.complete({
    envelope: finalEnvelope(),
    present: async () => expected
  })

  assert.equal(result, expected)
  assert.deepEqual(failureCodes, ['request_observation_publish_failed'])
  assert.equal(Object.hasOwn(published ?? {}, 'deliveries'), false)
  assert.equal(Object.hasOwn(published ?? {}, 'sessionPersistence'), false)
  assert.equal(Object.hasOwn(published ?? {}, 'presentation'), false)
})

test('completion coordinator preserves session persistence outcome without changing terminal result', async () => {
  const envelope = finalEnvelope()
  const presentation = presentationResult()
  let projectionResult: unknown
  let projectionPersistence: unknown
  let publishCalls = 0
  const coordinator = createPresentationCompletionCoordinator({
    publisher: { publish: () => { publishCalls++ } },
    monotonicNow: () => 25
  })

  await assert.rejects(coordinator.complete({
    envelope,
    async present (projection) {
      projectionResult = projection.result
      projectionPersistence = projection.sessionPersistence
      throw new Error('unexpected presenter failure')
    }
  }), /unexpected presenter failure/)

  const projected = projectionResult as Extract<
  FinalChatReplyEnvelope,
  { readonly kind: 'failed' }
  >
  assert.deepEqual(Reflect.ownKeys(projected), [
    'kind', 'runId', 'runRef', 'error', 'terminal'
  ])
  assert.equal(projected.kind, 'failed')
  assert.equal(projected.error, envelope.error)
  assert.equal(projected.terminal, envelope.terminal)
  assert.equal(projectionPersistence, 'not_attempted')
  assert.equal(publishCalls, 1)

  const successfulCoordinator = createPresentationCompletionCoordinator({
    publisher: { publish: () => undefined },
    monotonicNow: () => 25
  })
  assert.equal(await successfulCoordinator.complete({
    envelope: finalEnvelope(),
    present: async () => presentation
  }), presentation)
})

test('completion coordinator finalizes an invalid claimed envelope exactly once', async () => {
  const invalidEnvelope = Object.freeze({
    ...finalEnvelope(),
    sessionPersistence: 'saved'
  }) as unknown as FinalChatReplyEnvelope
  let presentCalls = 0
  let publishCalls = 0
  const coordinator = createPresentationCompletionCoordinator({
    publisher: { publish: () => { publishCalls++ } },
    monotonicNow: () => 30
  })

  await assert.rejects(coordinator.complete({
    envelope: invalidEnvelope,
    present: async () => {
      presentCalls++
      return presentationResult()
    }
  }), /session persistence is invalid/)
  assert.equal(presentCalls, 0)
  assert.equal(publishCalls, 1)

  await assert.rejects(coordinator.complete({
    envelope: invalidEnvelope,
    present: async () => presentationResult()
  }), RequestObservationAlreadyCompletedError)
  assert.equal(publishCalls, 1)
})
