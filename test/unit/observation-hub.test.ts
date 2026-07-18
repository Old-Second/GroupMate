import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import {
  MAX_PRESENTATION_DELIVERY_OBSERVATIONS,
  createPresentationObservationId,
  createProgressPresentationReducerInput,
  parseObservationEvent,
  parsePresentationObservation,
  type ObservationEventV1,
  type PresentationObservationV1,
  type PresentationReducerInputV1
} from '../../src/runtime/observability/observation-event.js'
import {
  ObservationHub,
  observationPriorityFor,
  type ObservationSubscriber,
  type SafeSinkFailureV1
} from '../../src/runtime/observability/observation-hub.js'
import { terminalObservationId } from '../../src/agent/run/run-observation.js'

const RUN_REF = 'a'.repeat(32)
const TERMINAL_ID = terminalObservationId(RUN_REF, 4)

function requestEvent (requestRefDigit = 'b'): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'request',
    value: {
      schemaVersion: 1,
      runRef: 'unavailable',
      requestRef: requestRefDigit.repeat(32),
      requestKind: 'ordinary_chat',
      outcome: 'failed_request_validation',
      admissionRejectionReason: 'not_applicable',
      queueDurationMs: 'not_attempted',
      sessionLoadDurationMs: 'not_attempted',
      sessionSaveDurationMs: 'not_attempted',
      requestDurationMs: 4,
      terminalObservationId: 'not_attempted'
    }
  }
}

function terminalSnapshotEvent (
  status: 'completed' | 'failed' | 'cancelled' = 'completed'
): ObservationEventV1 {
  const failed = status === 'failed'
  const cancelled = status === 'cancelled'
  return {
    schemaVersion: 1,
    type: 'terminal_snapshot',
    value: {
      schemaVersion: 2,
      observationId: TERMINAL_ID,
      runRef: RUN_REF,
      revision: 4,
      status,
      finishedAt: '2026-07-16T00:00:00.000Z',
      completion: status === 'completed'
        ? { kind: 'reply_text', lengthBucket: '1_40' }
        : { kind: 'none' },
      errorCode: failed ? 'provider_unavailable' : null,
      cancellationReason: cancelled ? 'user_cancelled' : null,
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
        providerActiveDurationMs: 20,
        engineActiveDurationMs: 30
      },
      engineDurationMs: 30
    }
  }
}

function terminalCommitEvent (): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'terminal_commit',
    value: {
      schemaVersion: 1,
      observationId: TERMINAL_ID,
      runRef: RUN_REF,
      revision: 4,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 100,
      eventBytesDeleted: 200,
      tombstoneBytes: 300
    }
  }
}

function ordinaryReducer (): PresentationReducerInputV1 {
  return {
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
    quotePolicy: 'current_request',
    selectedMode: 'text',
    fallbackReason: 'none',
    configEnumVersion: 1
  }
}

function presentationValue (
  overrides: Partial<PresentationObservationV1> = {}
): PresentationObservationV1 {
  return {
    schemaVersion: 1,
    presentationObservationId: 'c'.repeat(64),
    runRef: RUN_REF,
    terminalObservationId: TERMINAL_ID,
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
    totalDurationMs: 12,
    reducerInput: ordinaryReducer(),
    ...overrides
  }
}

function presentationEvent (
  overrides: Partial<PresentationObservationV1> = {}
): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'presentation',
    value: presentationValue(overrides)
  }
}

function dataWithExtra (value: object): Record<string, unknown> {
  return { ...value, secret: 'must be rejected' }
}

test('four observation facts parse exactly and reject merged or raw event shapes', () => {
  const facts = [
    requestEvent(),
    terminalSnapshotEvent(),
    terminalCommitEvent(),
    presentationEvent()
  ]
  for (const fact of facts) {
    const parsed = parseObservationEvent(fact)
    assert.deepEqual(parsed, fact)
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.value), true)
    assert.throws(() => parseObservationEvent(dataWithExtra(fact)), TypeError)
    assert.throws(() => parseObservationEvent({
      ...fact,
      value: dataWithExtra(fact.value)
    }), TypeError)
  }

  assert.throws(() => parseObservationEvent({
    schemaVersion: 1,
    type: 'terminal',
    value: {
      snapshot: terminalSnapshotEvent().value,
      receipt: terminalCommitEvent().value
    }
  }), TypeError)
  assert.throws(() => parseObservationEvent({
    schemaVersion: 1,
    type: 'progress',
    value: { type: 'tool.started', payload: { text: 'private' } }
  }), TypeError)
  assert.throws(() => parseObservationEvent({
    schemaVersion: 1,
    type: 'tool_audit',
    value: { toolName: 'sendMessage' }
  }), TypeError)
})

test('observation parsing rejects hostile accessors without invoking them', () => {
  let calls = 0
  const hostile = Object.create(null)
  Object.defineProperty(hostile, 'schemaVersion', { value: 1, enumerable: true })
  Object.defineProperty(hostile, 'type', { value: 'request', enumerable: true })
  Object.defineProperty(hostile, 'value', {
    enumerable: true,
    get () {
      calls += 1
      throw new Error('secret getter')
    }
  })
  Object.defineProperty(hostile, 'toJSON', {
    enumerable: false,
    get () {
      calls += 1
      throw new Error('secret toJSON')
    }
  })

  assert.throws(() => parseObservationEvent(hostile), TypeError)
  assert.equal(calls, 0)

  let arrayReads = 0
  const deliveries = new Proxy(presentationValue().deliveries as unknown[], {
    get (target, key, receiver) {
      arrayReads += 1
      return Reflect.get(target, key, receiver)
    }
  })
  assert.deepEqual(parsePresentationObservation(presentationValue({
    deliveries: deliveries as never
  })), presentationValue())
  assert.equal(arrayReads, 0)
})

test('presentation parser enforces identity, stage and outer-to-reducer matrices', () => {
  assert.deepEqual(parsePresentationObservation(presentationValue()), presentationValue())
  assert.throws(() => parsePresentationObservation(presentationValue({
    presentationObservationId: TERMINAL_ID.slice(0, 63) + 'g'
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    runRef: 'unavailable',
    terminalObservationId: TERMINAL_ID
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    terminalObservationId: 'not_attempted'
  })), TypeError)
  assert.deepEqual(parsePresentationObservation(presentationValue({
    terminalObservationId: 'unavailable'
  })).terminalObservationId, 'unavailable')
  assert.deepEqual(parsePresentationObservation(presentationValue({
    runRef: 'unavailable',
    terminalObservationId: 'not_attempted'
  })).runRef, 'unavailable')

  const crossed: Array<Partial<PresentationObservationV1>> = [
    { profile: 'proactive' },
    { reducerInput: { ...ordinaryReducer(), profile: 'proactive' } },
    {
      reducerInput: {
        ...ordinaryReducer(),
        requestKind: 'proactive_chat'
      }
    },
    {
      profile: 'recovered_legacy_plain_text',
      reducerInput: {
        ...ordinaryReducer(),
        profile: 'recovered_legacy_plain_text',
        requestKind: 'ordinary_chat'
      }
    }
  ]
  for (const value of crossed) {
    assert.throws(() => parsePresentationObservation(presentationValue(value)), TypeError)
  }
})

test('progress reducer derives the bounded code-point bucket before text is discarded', () => {
  const forty = createProgressPresentationReducerInput({
    requestKind: 'ordinary_chat',
    text: `${'甲'.repeat(39)}😀`
  })
  const fortyOne = createProgressPresentationReducerInput({
    requestKind: 'recovered_legacy_plain_text',
    text: `${'甲'.repeat(40)}😀`
  })
  assert.equal(forty.textLengthBucket, '1_40')
  assert.equal(fortyOne.textLengthBucket, '41_200')
  assert.equal(JSON.stringify(forty).includes('甲'), false)
  assert.throws(() => createProgressPresentationReducerInput({
    requestKind: 'ordinary_chat',
    text: ''
  }), TypeError)
  assert.throws(() => createProgressPresentationReducerInput({
    requestKind: 'ordinary_chat',
    text: '甲'.repeat(201)
  }), TypeError)

  const progress = presentationValue({
    presentationObservationId: 'd'.repeat(64),
    terminalObservationId: 'not_attempted',
    profile: 'progress',
    reducerInput: forty
  })
  assert.deepEqual(parsePresentationObservation(progress), progress)
  for (const reducerInput of [
    { ...forty, textLengthBucket: 'none' },
    { ...forty, hasReasoning: true },
    { ...forty, hasCitation: true },
    { ...forty, buttonsEligible: true },
    { ...forty, ttsEligibility: 'eligible' },
    { ...forty, pictureEligibility: 'eligible' },
    { ...forty, quotePolicy: 'current_request' },
    { ...forty, selectedMode: 'picture' },
    { ...forty, fallbackReason: 'render_failed' }
  ]) {
    assert.throws(() => parsePresentationObservation({
      ...progress,
      reducerInput
    }), TypeError)
  }
})

test('safe deliveries keep exact attempt facts and enforce the twelve item bound', () => {
  const definiteThenUnknown = [
    {
      schemaVersion: 1 as const,
      media: 'picture' as const,
      attempt: 1 as const,
      outcome: 'failed_definite' as const,
      code: 'host_rejected' as const
    },
    {
      schemaVersion: 1 as const,
      media: 'text' as const,
      attempt: 2 as const,
      outcome: 'outcome_unknown' as const,
      code: 'host_timeout_after_dispatch' as const
    }
  ]
  assert.deepEqual(parsePresentationObservation(presentationValue({
    outcome: 'unknown',
    deliveries: definiteThenUnknown
  })).deliveries, definiteThenUnknown)

  const max = Array.from({ length: MAX_PRESENTATION_DELIVERY_OBSERVATIONS }, (_, index) => ({
    schemaVersion: 1 as const,
    media: 'text' as const,
    attempt: (index % 2 === 0 ? 1 : 2) as 1 | 2,
    outcome: 'sent' as const,
    code: null
  }))
  assert.equal(parsePresentationObservation(presentationValue({ deliveries: max })).deliveries.length, 12)
  assert.throws(() => parsePresentationObservation(presentationValue({
    deliveries: [...max, max[0]]
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    deliveries: [{ ...max[0], messageId: 'private-id' }] as never
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    deliveries: [{ ...max[0], receipt: { messageId: 'private-id' } }] as never
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    outcome: 'complete',
    deliveries: [definiteThenUnknown[0]]
  })), TypeError)
  assert.throws(() => parsePresentationObservation(presentationValue({
    outcome: 'skipped'
  })), TypeError)
})

test('presentation parser accepts only the exact pre-dispatch TTS synthesis partial shape', () => {
  const sentText = presentationValue().deliveries[0]
  const sentForward = {
    schemaVersion: 1 as const,
    media: 'forward' as const,
    attempt: 1 as const,
    outcome: 'sent' as const,
    code: null
  }
  const synthesisFailureReducer: PresentationReducerInputV1 = {
    ...ordinaryReducer(),
    ttsEligibility: 'eligible',
    selectedMode: 'text',
    fallbackReason: 'synthesis_failed'
  }
  const traditionalPartial = presentationValue({
    outcome: 'partial',
    deliveries: [
      sentText,
      {
        schemaVersion: 1,
        media: 'text',
        attempt: 2,
        outcome: 'failed_definite',
        code: 'host_rejected'
      }
    ]
  })
  assert.deepEqual(parsePresentationObservation(traditionalPartial), traditionalPartial)
  const partial = presentationValue({
    outcome: 'partial',
    deliveries: [sentForward, sentText],
    reducerInput: synthesisFailureReducer
  })
  assert.deepEqual(parsePresentationObservation(partial), partial)
  const fullAuxiliaryShape = presentationValue({
    outcome: 'partial',
    deliveries: [sentForward, sentText, sentForward, sentText, sentText],
    reducerInput: synthesisFailureReducer
  })
  assert.deepEqual(parsePresentationObservation(fullAuxiliaryShape), fullAuxiliaryShape)

  for (const invalid of [
    {
      ...partial,
      reducerInput: { ...synthesisFailureReducer, ttsEligibility: 'disabled' as const }
    },
    {
      ...partial,
      reducerInput: { ...synthesisFailureReducer, selectedMode: 'tts' as const }
    },
    {
      ...partial,
      reducerInput: { ...synthesisFailureReducer, fallbackReason: 'none' as const }
    },
    {
      ...partial,
      profile: 'proactive' as const,
      reducerInput: {
        ...synthesisFailureReducer,
        requestKind: 'proactive_chat' as const,
        profile: 'proactive' as const
      }
    },
    {
      ...partial,
      deliveries: [sentForward]
    },
    {
      ...partial,
      deliveries: [sentForward, sentForward, sentText]
    },
    {
      ...partial,
      deliveries: [sentText, sentText, sentForward]
    },
    {
      ...partial,
      deliveries: [sentText, sentForward, sentForward]
    },
    {
      ...partial,
      deliveries: [sentText, sentText, sentText, sentText]
    },
    {
      ...partial,
      deliveries: [
        sentText,
        { ...sentText, media: 'voice' as const }
      ]
    },
    {
      ...partial,
      deliveries: [
        sentText,
        { ...sentText, media: 'picture' as const }
      ]
    }
  ]) {
    assert.throws(() => parsePresentationObservation(invalid), TypeError)
  }
})

test('presentation IDs require exactly 32 random bytes and stay independent from terminal IDs', () => {
  const first = createPresentationObservationId(size => {
    assert.equal(size, 32)
    return Buffer.alloc(size, 0x11)
  })
  const second = createPresentationObservationId(size => Buffer.alloc(size, 0x12))
  assert.equal(first, '11'.repeat(32))
  assert.equal(second, '12'.repeat(32))
  assert.notEqual(first, second)
  assert.notEqual(first, TERMINAL_ID)
  assert.throws(() => createPresentationObservationId(() => randomBytes(31)), TypeError)
})

test('priority is derived only from parsed fact contents', () => {
  assert.equal(observationPriorityFor(parseObservationEvent(requestEvent())), 'normal')
  assert.equal(observationPriorityFor(parseObservationEvent(terminalCommitEvent())), 'normal')
  assert.equal(observationPriorityFor(parseObservationEvent(terminalSnapshotEvent())), 'normal_success')
  assert.equal(observationPriorityFor(parseObservationEvent(terminalSnapshotEvent('failed'))), 'reserved')
  assert.equal(observationPriorityFor(parseObservationEvent(terminalSnapshotEvent('cancelled'))), 'reserved')
  assert.equal(observationPriorityFor(parseObservationEvent(presentationEvent())), 'normal_success')
  assert.equal(observationPriorityFor(parseObservationEvent(presentationEvent({
    postprocessAnomaly: true
  }))), 'reserved')
  assert.equal(observationPriorityFor(parseObservationEvent(presentationEvent({
    outcome: 'partial',
    deliveries: [
      ...presentationValue().deliveries,
      {
        schemaVersion: 1,
        media: 'text',
        attempt: 2,
        outcome: 'failed_definite',
        code: 'host_rejected'
      }
    ]
  }))), 'reserved')
  assert.equal(observationPriorityFor(parseObservationEvent(presentationEvent({
    terminalObservationId: 'not_attempted',
    profile: 'progress',
    reducerInput: createProgressPresentationReducerInput({
      requestKind: 'ordinary_chat',
      text: '正在执行任务步骤'
    })
  }))), 'progress_delivery')
})

function deferred (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: () => void
} {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = () => onReject(new Error('late private error'))
  })
  return { promise, resolve, reject }
}

async function turn (): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

test('Hub fixes subscriber set and isolates failures in canonical sink order', async () => {
  assert.throws(() => new ObservationHub({
    subscribers: [{ name: 'unknown', observe () {} } as unknown as ObservationSubscriber]
  }), TypeError)
  assert.throws(() => new ObservationHub({
    subscribers: [
      { name: 'metrics', observe () {} },
      { name: 'metrics', observe () {} }
    ]
  }), TypeError)
  assert.throws(() => new ObservationHub({
    subscribers: [
      { name: 'metrics', observe () {} },
      { name: 'trace', observe () {} },
      { name: 'log', observe () {} },
      { name: 'metrics', observe () {} }
    ]
  }), TypeError)

  const calls: string[] = []
  const failures: SafeSinkFailureV1[] = []
  const hub = new ObservationHub({
    subscribers: [
      { name: 'log', observe () { calls.push('log') } },
      { name: 'metrics', observe () { calls.push('metrics'); throw new Error('private') } },
      { name: 'trace', observe () { calls.push('trace') } }
    ],
    onSinkFailure: failure => { failures.push(failure) },
    now: () => Date.parse('2026-07-16T00:00:00.000Z')
  })
  assert.equal(hub.publish(requestEvent()), 'accepted')
  await hub.drain()
  assert.deepEqual(calls, ['metrics', 'trace', 'log'])
  assert.deepEqual(failures.map(failure => [failure.sink, failure.code]), [
    ['metrics', 'rejected']
  ])
  assert.deepEqual(hub.snapshot().sinks, [
    { name: 'metrics', accepted: 1, dropped: 0, failed: 1, quarantined: 0 },
    { name: 'trace', accepted: 1, dropped: 0, failed: 0, quarantined: 0 },
    { name: 'log', accepted: 1, dropped: 0, failed: 0, quarantined: 0 }
  ])

  let originalCalls = 0
  let replacementCalls = 0
  const mutable = {
    name: 'log' as const,
    observe () { originalCalls += 1 }
  }
  const frozenHub = new ObservationHub({ subscribers: [mutable] })
  Object.defineProperty(mutable, 'name', { value: 'metrics' })
  mutable.observe = () => { replacementCalls += 1 }
  frozenHub.publish(requestEvent())
  await frozenHub.drain()
  assert.equal(originalCalls, 1)
  assert.equal(replacementCalls, 0)
  assert.equal(frozenHub.snapshot().sinks[0].name, 'log')

  let startCalls = 0
  const startHub = new ObservationHub({
    subscribers: [{ name: 'metrics', observe () { startCalls += 1 } }]
  })
  startHub.publish(requestEvent())
  assert.equal(startCalls, 0)
  assert.equal(startHub.snapshot().sinks[0].accepted, 0)
  await turn()
  assert.equal(startCalls, 1)
  assert.equal(startHub.snapshot().sinks[0].accepted, 1)
  await startHub.drain()
})

test('normal lane has two workers, four pending slots and strict priority eviction', async () => {
  const blockers = [deferred(), deferred()]
  const started: string[] = []
  let call = 0
  const hub = new ObservationHub({
    subscribers: [{
      name: 'metrics',
      observe (event) {
        call += 1
        started.push(event.type === 'request'
          ? `request-${event.value.requestRef[0]}`
          : event.type === 'presentation'
            ? `presentation-${event.value.presentationObservationId[0]}`
            : 'unexpected')
        if (call <= 2) return blockers[call - 1].promise
      }
    }]
  })

  assert.equal(hub.publish(requestEvent('1')), 'accepted')
  assert.equal(hub.publish(requestEvent('2')), 'accepted')
  await turn()
  assert.equal(hub.publish(presentationEvent({
    presentationObservationId: '5'.repeat(64)
  })), 'accepted')
  assert.equal(hub.publish(presentationEvent({
    presentationObservationId: '6'.repeat(64)
  })), 'accepted')
  assert.equal(hub.publish(presentationEvent({
    presentationObservationId: '7'.repeat(64),
    terminalObservationId: 'not_attempted',
    profile: 'progress',
    reducerInput: createProgressPresentationReducerInput({
      requestKind: 'ordinary_chat', text: '正在执行'
    })
  })), 'accepted')
  assert.equal(hub.publish(requestEvent('3')), 'accepted')
  assert.equal(hub.snapshot().normalPending, 4)
  assert.equal(hub.publish(requestEvent('4')), 'accepted')
  assert.equal(hub.snapshot().normalPending, 4)

  blockers.forEach(item => item.resolve())
  await hub.drain()
  assert.deepEqual(started, [
    'request-1',
    'request-2',
    'request-3',
    'request-4',
    'presentation-7',
    'presentation-6'
  ])
  assert.equal(started.includes('presentation-5'), false)
  assert.equal(hub.snapshot().sinks[0].dropped, 1)
})

test('reserved lane is independent and drops immediately while occupied', async () => {
  const blocker = deferred()
  const hub = new ObservationHub({
    subscribers: [{
      name: 'metrics',
      observe () { return blocker.promise }
    }]
  })
  assert.equal(hub.publish(terminalSnapshotEvent('failed')), 'accepted')
  await turn()
  assert.equal(hub.publish(terminalSnapshotEvent('cancelled')), 'dropped')
  assert.equal(hub.snapshot().reservedInFlight, 1)
  blocker.resolve()
  await hub.drain()
  assert.equal(hub.snapshot().sinks[0].dropped, 1)
})

test('timeouts quarantine at most three calls per sink without blocking other sinks', async () => {
  const hanging = [deferred(), deferred(), deferred()]
  let metricsCalls = 0
  let traceCalls = 0
  const failures: SafeSinkFailureV1[] = []
  const hub = new ObservationHub({
    subscribers: [
      {
        name: 'metrics',
        observe () {
          const item = hanging[metricsCalls]
          metricsCalls += 1
          return item.promise
        }
      },
      { name: 'trace', observe () { traceCalls += 1 } }
    ],
    onSinkFailure: failure => { failures.push(failure) }
  })
  hub.publish(requestEvent())
  hub.publish(requestEvent())
  hub.publish(terminalSnapshotEvent('failed'))
  await Promise.race([
    hub.drain(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drain hung')), 1_500))
  ])
  assert.equal(metricsCalls, 3)
  assert.equal(traceCalls, 3)
  assert.equal(hub.snapshot().sinks[0].quarantined, 3)
  assert.equal(failures.filter(failure => failure.code === 'timeout').length, 3)

  hub.publish(requestEvent())
  await hub.drain()
  assert.equal(metricsCalls, 3)
  assert.equal(traceCalls, 4)
  assert.equal(hub.snapshot().sinks[0].dropped, 1)

  hanging[0].resolve()
  hanging[1].reject()
  hanging[2].resolve()
  await turn()
  await turn()
  assert.equal(hub.snapshot().sinks[0].quarantined, 0)
  assert.equal(failures.filter(failure => failure.code === 'rejected').length, 0)
})
