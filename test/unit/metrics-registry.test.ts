import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DURATION_BUCKET_BOUNDS_MS,
  terminalObservationId,
  type DurationBucketCountsV1,
  type RunTerminalSnapshotV2,
  type RunTraceMetricSummaryV1
} from '../../src/agent/run/run-observation.js'
import type { TraceCandidateV1 } from '../../src/agent/run/run-trace.js'
import {
  METRIC_LABEL_NAMES_V1,
  MetricsRegistry,
  parseMetricsSnapshot,
  type MetricLabelV1,
  type MetricsSnapshotV1
} from '../../src/runtime/observability/metrics-registry.js'
import type {
  ObservationEventV1,
  PresentationObservationV1,
  PresentationReducerInputV1
} from '../../src/runtime/observability/observation-event.js'

const STARTED_AT = '2026-07-16T00:00:00.000Z'
const FINISHED_AT = '2026-07-16T00:00:01.000Z'
const RUN_REF = 'a'.repeat(32)
const TERMINAL_ID = terminalObservationId(RUN_REF, 4)

type ForbiddenMetricLabel = Extract<
MetricLabelV1['name'],
'runRef' | 'runId' | 'sessionId' | 'model' | 'toolName' | 'content'
>
const FORBIDDEN_METRIC_LABELS_EXCLUDED: ForbiddenMetricLabel extends never
  ? true
  : false = true

function emptyDuration (
  overrides: Partial<DurationBucketCountsV1> = {}
): DurationBucketCountsV1 {
  return {
    count: 0,
    sumMs: 0,
    unavailableCount: 0,
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
    inf: 0,
    ...overrides
  }
}

function measured20UnavailableOne (): DurationBucketCountsV1 {
  return emptyDuration({
    count: 1,
    sumMs: 20,
    unavailableCount: 1,
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
  })
}

function measured5 (): DurationBucketCountsV1 {
  return emptyDuration({
    count: 1,
    sumMs: 5,
    le10: 1,
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
  })
}

function metricSummary (): RunTraceMetricSummaryV1 {
  return {
    schemaVersion: 1,
    providerRequests: [{
      outcome: 'failed',
      attemptKind: 'retry',
      count: 2,
      duration: measured20UnavailableOne()
    }],
    toolExecutions: [{
      outcome: 'succeeded',
      count: 1,
      duration: measured5()
    }],
    approvals: [{ decision: 'requested', count: 1 }]
  }
}

function terminalSnapshot (
  runRef = RUN_REF,
  revision = 4
): RunTerminalSnapshotV2 {
  return {
    schemaVersion: 2,
    observationId: terminalObservationId(runRef, revision),
    runRef,
    revision,
    status: 'completed',
    finishedAt: FINISHED_AT,
    completion: { kind: 'reply_text', lengthBucket: '1_40' },
    errorCode: null,
    cancellationReason: null,
    counters: {
      schemaVersion: 1,
      providerAttempts: 2,
      modelTurns: 2,
      toolAttempts: 1,
      providerRetries: 1,
      recoveryAttempts: 0,
      correctionTurns: 0,
      toolCalls: 1,
      approvalRequests: 1,
      toolDenied: 0,
      toolExpired: 0,
      toolIndeterminate: 0,
      estimatedTokens: 17,
      providerInputTokens: 7,
      providerOutputTokens: 3,
      providerTotalTokens: 10,
      providerActiveDurationMs: 20,
      engineActiveDurationMs: 30
    },
    engineDurationMs: 30
  }
}

function terminalEvent (
  runRef = RUN_REF,
  revision = 4
): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'terminal_snapshot',
    value: terminalSnapshot(runRef, revision)
  }
}

function commitEvent (
  runRef = RUN_REF,
  revision = 4
): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'terminal_commit',
    value: {
      schemaVersion: 1,
      observationId: terminalObservationId(runRef, revision),
      runRef,
      revision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 100,
      eventBytesDeleted: 200,
      tombstoneBytes: 300
    }
  }
}

function requestEvent (requestRef = 'b'.repeat(32)): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'request',
    value: {
      schemaVersion: 1,
      runRef: 'unavailable',
      requestRef,
      requestKind: 'ordinary_chat',
      outcome: 'rejected_admission',
      admissionRejectionReason: 'queue_full',
      queueDurationMs: 9,
      sessionLoadDurationMs: 'not_attempted',
      sessionSaveDurationMs: 'not_attempted',
      requestDurationMs: 11,
      terminalObservationId: 'not_attempted'
    }
  }
}

function reducer (): PresentationReducerInputV1 {
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
  id = 'c'.repeat(64),
  overrides: Partial<PresentationObservationV1> = {}
): PresentationObservationV1 {
  return {
    schemaVersion: 1,
    presentationObservationId: id,
    runRef: RUN_REF,
    terminalObservationId: TERMINAL_ID,
    profile: 'ordinary',
    outcome: 'partial',
    postprocessAnomaly: false,
    deliveries: [{
      schemaVersion: 1,
      media: 'text',
      attempt: 1,
      outcome: 'sent',
      code: null
    }, {
      schemaVersion: 1,
      media: 'picture',
      attempt: 1,
      outcome: 'failed_definite',
      code: 'host_rejected'
    }],
    totalDurationMs: 12,
    reducerInput: reducer(),
    ...overrides
  }
}

function presentationEvent (
  id = 'c'.repeat(64),
  overrides: Partial<PresentationObservationV1> = {}
): ObservationEventV1 {
  return {
    schemaVersion: 1,
    type: 'presentation',
    value: presentationValue(id, overrides)
  }
}

function candidate (
  runRef = RUN_REF,
  revision = 4,
  summary = metricSummary()
): TraceCandidateV1 {
  const terminal = terminalSnapshot(runRef, revision)
  return {
    schemaVersion: 1,
    runRef,
    observationId: terminal.observationId,
    terminal,
    policy: {
      schemaVersion: 1,
      levelAtStart: 'basic',
      sampledSuccess: true
    },
    metricSummary: summary,
    events: [{
      type: 'run_state',
      sequence: 0,
      occurredAt: STARTED_AT,
      durationMs: null,
      state: 'completed',
      errorCode: null
    }],
    omittedEventCount: 0,
    presentation: { kind: 'unavailable' },
    expiresAt: '2026-07-16T00:10:00.000Z',
    serializedBytes: 1024
  }
}

function labels (point: { readonly labels: readonly MetricLabelV1[] }): string {
  return point.labels.map(label => `${label.name}=${label.value}`).join(',')
}

function counter (
  snapshot: MetricsSnapshotV1,
  name: string,
  expectedLabels: string
): number {
  const point = snapshot.counters.find(value => (
    value.name === name && labels(value) === expectedLabels
  ))
  assert.ok(point !== undefined, `${name}{${expectedLabels}} counter is missing`)
  return point.value
}

function gauge (
  snapshot: MetricsSnapshotV1,
  name: string,
  expectedLabels: string
): number | 'unavailable' | 'not_attempted' {
  const point = snapshot.gauges.find(value => (
    value.name === name && labels(value) === expectedLabels
  ))
  assert.ok(point !== undefined, `${name}{${expectedLabels}} gauge is missing`)
  return point.value
}

function histogram (
  snapshot: MetricsSnapshotV1,
  name: string,
  expectedLabels: string
) {
  const point = snapshot.histograms.find(value => (
    value.name === name && labels(value) === expectedLabels
  ))
  assert.ok(point !== undefined, `${name}{${expectedLabels}} histogram is missing`)
  return point
}

function deferred<T> (): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve
  })
  return { promise, resolve }
}

test('metric contract fixes fourteen instruments, labels and shared buckets', async () => {
  assert.equal(FORBIDDEN_METRIC_LABELS_EXCLUDED, true)
  assert.deepEqual(DURATION_BUCKET_BOUNDS_MS, [
    10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
    30000, 60000, 120000, 'inf'
  ])
  assert.deepEqual(METRIC_LABEL_NAMES_V1, {
    'groupmate.agent.runs': ['outcome', 'completion_kind', 'error_code'],
    'groupmate.agent.duration': ['stage'],
    'groupmate.agent.provider_requests': ['outcome', 'attempt_kind'],
    'groupmate.agent.tokens': ['direction', 'source'],
    'groupmate.agent.tool_executions': ['outcome'],
    'groupmate.agent.tool_duration': ['outcome'],
    'groupmate.agent.approvals': ['decision'],
    'groupmate.agent.admission': ['state'],
    'groupmate.agent.admission_rejections': ['reason'],
    'groupmate.presentation.deliveries': ['media', 'outcome'],
    'groupmate.observation.failures': ['sink'],
    'groupmate.observation.store_records': ['kind'],
    'groupmate.observation.store_bytes': ['kind'],
    'groupmate.process.rss': []
  })

  const registry = new MetricsRegistry({
    admission: { activeCount: 2, queuedCount: 3 },
    runStoreUsage: async () => ({
      schemaVersion: 1,
      tombstoneRecords: 4,
      tombstoneBytes: 500
    }),
    traceStoreUsage: async () => ({ records: 6, bytes: 700 }),
    now: () => new Date(STARTED_AT),
    rss: () => 800
  })
  const snapshot = await registry.snapshot()
  assert.equal(Object.keys(METRIC_LABEL_NAMES_V1).length, 14)
  assert.equal(gauge(snapshot, 'groupmate.agent.admission', 'state=active'), 2)
  assert.equal(gauge(snapshot, 'groupmate.agent.admission', 'state=queued'), 3)
  assert.equal(gauge(snapshot, 'groupmate.observation.store_records', 'kind=tombstone'), 4)
  assert.equal(gauge(snapshot, 'groupmate.observation.store_records', 'kind=trace'), 6)
  assert.equal(gauge(snapshot, 'groupmate.observation.store_bytes', 'kind=tombstone'), 500)
  assert.equal(gauge(snapshot, 'groupmate.observation.store_bytes', 'kind=trace'), 700)
  assert.equal(gauge(snapshot, 'groupmate.process.rss', ''), 800)
  assert.deepEqual(parseMetricsSnapshot(snapshot), snapshot)
  assert.equal(Object.isFrozen(parseMetricsSnapshot(snapshot)), true)
})

test('registry consumes only the fixed source for every counter and duration', async () => {
  const registry = new MetricsRegistry({
    admission: { activeCount: 0, queuedCount: 0 },
    runStoreUsage: async () => ({
      schemaVersion: 1,
      tombstoneRecords: 'unavailable',
      tombstoneBytes: 'unavailable'
    }),
    traceStoreUsage: async () => ({ records: 'unavailable', bytes: 'unavailable' }),
    now: () => new Date(STARTED_AT),
    rss: () => 99
  })

  registry.observe(requestEvent())
  registry.observe(requestEvent())
  registry.observe(terminalEvent())
  registry.observe(terminalEvent())
  registry.observe(commitEvent())
  registry.observe(commitEvent())
  registry.observeCommittedTraceCandidate(candidate())
  registry.observeCommittedTraceCandidate(candidate())
  registry.observe(presentationEvent())
  registry.observe(presentationEvent())
  registry.recordSinkFailure({
    schemaVersion: 1,
    sink: 'trace',
    code: 'timeout',
    occurredAt: FINISHED_AT
  })

  const snapshot = await registry.snapshot()
  assert.equal(counter(
    snapshot,
    'groupmate.agent.admission_rejections',
    'reason=queue_full'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.runs',
    'outcome=completed,completion_kind=reply_text,error_code=none'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.provider_requests',
    'outcome=failed,attempt_kind=retry'
  ), 2)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.tool_executions',
    'outcome=succeeded'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.approvals',
    'decision=requested'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.presentation.deliveries',
    'media=text,outcome=sent'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.presentation.deliveries',
    'media=picture,outcome=failed_definite'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.observation.failures',
    'sink=trace'
  ), 1)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.tokens',
    'direction=input,source=provider'
  ), 7)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.tokens',
    'direction=output,source=provider'
  ), 3)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.tokens',
    'direction=total,source=provider'
  ), 10)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.tokens',
    'direction=total,source=estimated'
  ), 17)

  assert.deepEqual(histogram(
    snapshot,
    'groupmate.agent.duration',
    'stage=queue'
  ), {
    name: 'groupmate.agent.duration',
    labels: [{ name: 'stage', value: 'queue' }],
    count: 1,
    sumMs: 9,
    unavailableCount: 0,
    buckets: DURATION_BUCKET_BOUNDS_MS.map(upperBoundMs => ({
      upperBoundMs,
      cumulativeCount: 1
    }))
  })
  assert.equal(histogram(
    snapshot,
    'groupmate.agent.duration',
    'stage=request'
  ).sumMs, 11)
  assert.equal(snapshot.histograms.some(point => (
    point.name === 'groupmate.agent.duration' && labels(point) === 'stage=session_load'
  )), false)
  assert.equal(histogram(
    snapshot,
    'groupmate.agent.duration',
    'stage=engine'
  ).sumMs, 30)
  const provider = histogram(
    snapshot,
    'groupmate.agent.duration',
    'stage=provider'
  )
  assert.equal(provider.count, 1)
  assert.equal(provider.sumMs, 20)
  assert.equal(provider.unavailableCount, 1)
  assert.deepEqual(histogram(
    snapshot,
    'groupmate.agent.tool_duration',
    'outcome=succeeded'
  ).buckets, DURATION_BUCKET_BOUNDS_MS.map(upperBoundMs => ({
    upperBoundMs,
    cumulativeCount: 1
  })))
  assert.equal(histogram(
    snapshot,
    'groupmate.agent.duration',
    'stage=presentation'
  ).sumMs, 12)
  assert.equal(gauge(
    snapshot,
    'groupmate.observation.store_records',
    'kind=trace'
  ), 'unavailable')
})

test('an invalid candidate cannot poison committed-candidate deduplication', async () => {
  const registry = new MetricsRegistry({
    admission: { activeCount: 0, queuedCount: 0 },
    runStoreUsage: async () => ({
      schemaVersion: 1,
      tombstoneRecords: 0,
      tombstoneBytes: 0
    }),
    traceStoreUsage: async () => ({ records: 0, bytes: 0 }),
    now: () => new Date(STARTED_AT),
    rss: () => 1
  })
  const valid = candidate()
  assert.throws(() => registry.observeCommittedTraceCandidate({
    ...valid,
    metricSummary: { ...valid.metricSummary, secret: 'private' } as never
  }), TypeError)

  registry.observeCommittedTraceCandidate(valid)
  const snapshot = await registry.snapshot()
  assert.equal(counter(
    snapshot,
    'groupmate.agent.provider_requests',
    'outcome=failed,attempt_kind=retry'
  ), 2)
})

test('registry keeps independent 256-entry LRUs and reset clears them', async () => {
  const registry = new MetricsRegistry({
    admission: { activeCount: 0, queuedCount: 0 },
    runStoreUsage: async () => ({
      schemaVersion: 1,
      tombstoneRecords: 0,
      tombstoneBytes: 0
    }),
    traceStoreUsage: async () => ({ records: 0, bytes: 0 }),
    now: () => new Date(STARTED_AT),
    rss: () => 1
  })

  for (let index = 0; index < 257; index += 1) {
    const value = index.toString(16).padStart(32, '0')
    registry.observe(requestEvent(value))
  }
  registry.observe(requestEvent('0'.repeat(32)))

  for (let index = 0; index < 257; index += 1) {
    const value = index.toString(16).padStart(64, '0')
    registry.observe(presentationEvent(value))
  }
  registry.observe(presentationEvent('0'.repeat(64)))

  for (let index = 0; index < 257; index += 1) {
    const value = index.toString(16).padStart(32, '0')
    registry.observeCommittedTraceCandidate(candidate(value, 4))
  }
  registry.observeCommittedTraceCandidate(candidate('0'.repeat(32), 4))

  let snapshot = await registry.snapshot()
  assert.equal(counter(
    snapshot,
    'groupmate.agent.admission_rejections',
    'reason=queue_full'
  ), 258)
  assert.equal(counter(
    snapshot,
    'groupmate.presentation.deliveries',
    'media=text,outcome=sent'
  ), 258)
  assert.equal(counter(
    snapshot,
    'groupmate.agent.provider_requests',
    'outcome=failed,attempt_kind=retry'
  ), 516)

  registry.reset()
  registry.observe(requestEvent('0'.repeat(32)))
  snapshot = await registry.snapshot()
  assert.equal(counter(
    snapshot,
    'groupmate.agent.admission_rejections',
    'reason=queue_full'
  ), 1)
  assert.equal(snapshot.counters.some(point => (
    point.name === 'groupmate.agent.provider_requests'
  )), false)
})

test('off level collects no facts and snapshots only admission and RSS', async () => {
  let usageCalls = 0
  const admission = { activeCount: 7, queuedCount: 8 }
  const registry = new MetricsRegistry({
    admission,
    runStoreUsage: async () => {
      usageCalls += 1
      return { schemaVersion: 1, tombstoneRecords: 1, tombstoneBytes: 2 }
    },
    traceStoreUsage: async () => {
      usageCalls += 1
      return { records: 3, bytes: 4 }
    },
    now: () => new Date(STARTED_AT),
    rss: () => 9
  })

  registry.observe(requestEvent())
  registry.setCurrentLevel('off')
  registry.observe(requestEvent('d'.repeat(32)))
  registry.observeCommittedTraceCandidate(candidate())
  registry.recordSinkFailure({
    schemaVersion: 1,
    sink: 'metrics',
    code: 'overflow',
    occurredAt: FINISHED_AT
  })
  const snapshot = await registry.snapshot()
  assert.equal(usageCalls, 0)
  assert.deepEqual(snapshot.counters, [])
  assert.deepEqual(snapshot.histograms, [])
  assert.deepEqual(snapshot.gauges.map(point => [point.name, labels(point), point.value]), [
    ['groupmate.agent.admission', 'state=active', 7],
    ['groupmate.agent.admission', 'state=queued', 8],
    ['groupmate.process.rss', '', 9]
  ])
})

test('an in-flight usage snapshot cannot cross the synchronous off boundary', async () => {
  const runUsage = deferred<{
    schemaVersion: 1
    tombstoneRecords: number
    tombstoneBytes: number
  }>()
  const traceUsage = deferred<{ records: number; bytes: number }>()
  const registry = new MetricsRegistry({
    admission: { activeCount: 1, queuedCount: 2 },
    runStoreUsage: async () => await runUsage.promise,
    traceStoreUsage: async () => await traceUsage.promise,
    now: () => new Date(STARTED_AT),
    rss: () => 3
  })

  const pending = registry.snapshot()
  registry.setCurrentLevel('off')
  runUsage.resolve({ schemaVersion: 1, tombstoneRecords: 4, tombstoneBytes: 5 })
  traceUsage.resolve({ records: 6, bytes: 7 })

  const snapshot = await pending
  assert.deepEqual(snapshot.counters, [])
  assert.deepEqual(snapshot.histograms, [])
  assert.deepEqual(snapshot.gauges.map(point => [point.name, labels(point), point.value]), [
    ['groupmate.agent.admission', 'state=active', 1],
    ['groupmate.agent.admission', 'state=queued', 2],
    ['groupmate.process.rss', '', 3]
  ])
})

test('metrics parser exact-validates type, label order, domains and buckets', () => {
  const valid = {
    schemaVersion: 1,
    startedAt: STARTED_AT,
    counters: [{
      name: 'groupmate.agent.runs',
      labels: [
        { name: 'outcome', value: 'completed' },
        { name: 'completion_kind', value: 'reply_text' },
        { name: 'error_code', value: 'none' }
      ],
      value: 1
    }],
    gauges: [{
      name: 'groupmate.process.rss',
      labels: [],
      value: 123
    }],
    histograms: [{
      name: 'groupmate.agent.duration',
      labels: [{ name: 'stage', value: 'engine' }],
      count: 1,
      sumMs: 20,
      unavailableCount: 0,
      buckets: DURATION_BUCKET_BOUNDS_MS.map(upperBoundMs => ({
        upperBoundMs,
        cumulativeCount: upperBoundMs === 10 ? 0 : 1
      }))
    }]
  }
  assert.deepEqual(parseMetricsSnapshot(valid), valid)

  assert.throws(() => parseMetricsSnapshot({
    ...valid,
    histograms: [{
      ...valid.histograms[0],
      count: 0,
      sumMs: 123,
      unavailableCount: 1,
      buckets: valid.histograms[0].buckets.map(bucket => ({
        ...bucket,
        cumulativeCount: 0
      }))
    }]
  }), TypeError)

  const mapped = parseMetricsSnapshot({
    ...valid,
    counters: [{
      ...valid.counters[0],
      labels: [
        { name: 'outcome', value: 'future-outcome' },
        { name: 'completion_kind', value: 'future-completion' },
        { name: 'error_code', value: 'future-error' }
      ]
    }]
  })
  assert.deepEqual(mapped.counters[0]?.labels, [
    { name: 'outcome', value: 'other' },
    { name: 'completion_kind', value: 'other' },
    { name: 'error_code', value: 'other' }
  ])

  const invalid = [
    { ...valid, extra: true },
    {
      ...valid,
      counters: [{ ...valid.counters[0], name: 'groupmate.agent.duration' }]
    },
    {
      ...valid,
      counters: [{ ...valid.counters[0], labels: valid.counters[0].labels.slice(1) }]
    },
    {
      ...valid,
      counters: [{
        ...valid.counters[0],
        labels: [...valid.counters[0].labels].reverse()
      }]
    },
    {
      ...valid,
      counters: [{
        ...valid.counters[0],
        labels: [
          valid.counters[0].labels[0],
          valid.counters[0].labels[0],
          valid.counters[0].labels[2]
        ]
      }]
    },
    {
      ...valid,
      counters: [{
        ...valid.counters[0],
        labels: [
          { name: 'runRef', value: RUN_REF },
          ...valid.counters[0].labels.slice(1)
        ]
      }]
    },
    {
      ...valid,
      histograms: [{
        ...valid.histograms[0],
        labels: [{ name: 'stage', value: 'private-stage' }]
      }]
    },
    {
      ...valid,
      histograms: [{
        ...valid.histograms[0],
        buckets: valid.histograms[0].buckets.slice(1)
      }]
    },
    {
      ...valid,
      histograms: [{
        ...valid.histograms[0],
        buckets: valid.histograms[0].buckets.map((bucket, index) => (
          index === 0 ? { ...bucket, cumulativeCount: 2 } : bucket
        ))
      }]
    },
    {
      ...valid,
      gauges: [{
        name: 'groupmate.process.rss',
        labels: [],
        value: 'not_attempted'
      }]
    }
  ]
  for (const value of invalid) {
    assert.throws(() => parseMetricsSnapshot(value), TypeError)
  }
})
