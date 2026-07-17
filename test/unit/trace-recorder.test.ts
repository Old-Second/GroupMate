import assert from 'node:assert/strict'
import test from 'node:test'
import type { TraceCandidateV1 } from '../../src/agent/run/run-trace.js'
import type { PresentationObservationV1 } from '../../src/runtime/observability/observation-event.js'
import type {
  TraceLookupResult,
  TraceStore,
  TraceWriteReceiptV1
} from '../../src/runtime/observability/trace-store.js'
import { TraceRecorder } from '../../src/runtime/observability/trace-recorder.js'
import {
  traceCandidateFixture,
  tracePresentationFixture,
  traceRunRef
} from '../helpers/trace-fixture.js'

class RecordingStore implements TraceStore {
  readonly engine: TraceCandidateV1[] = []
  readonly presentations: PresentationObservationV1[] = []

  async upsertEngine (candidate: TraceCandidateV1): Promise<TraceWriteReceiptV1> {
    this.engine.push(candidate)
    return { schemaVersion: 1, kind: 'stored' }
  }

  async appendPresentation (
    observation: PresentationObservationV1
  ): Promise<TraceWriteReceiptV1> {
    this.presentations.push(observation)
    return { schemaVersion: 1, kind: 'stored' }
  }

  async load (): Promise<TraceLookupResult> { return { kind: 'not_retained' } }
  async listRecent () { return [] }
  async usage () { return { schemaVersion: 1 as const, records: 0, bytes: 0 } }
  async clear () {
    return {
      schemaVersion: 1 as const,
      removedRecords: 0,
      removedBytes: 0,
      remainingRecords: 0,
      remainingBytes: 0
    }
  }

  async advanceGenerationAndClear () {
    return { schemaVersion: 1 as const, generation: 1, clear: await this.clear() }
  }
}

function snapshotEvent (candidate: TraceCandidateV1) {
  return Object.freeze({
    schemaVersion: 1 as const,
    type: 'terminal_snapshot' as const,
    value: candidate.terminal
  })
}

function presentationEvent (value: PresentationObservationV1) {
  return Object.freeze({ schemaVersion: 1 as const, type: 'presentation' as const, value })
}

test('recorder retains failures and sampled successes only after terminal fact arrives', async () => {
  const store = new RecordingStore()
  const recorder = new TraceRecorder({ store })
  const failed = traceCandidateFixture({ status: 'failed' })
  const sampled = traceCandidateFixture({
    runRef: traceRunRef(true, 120_000),
    sampledSuccess: true
  })
  recorder.stageCommittedTraceCandidate(failed)
  recorder.stageCommittedTraceCandidate(sampled)
  assert.equal(store.engine.length, 0)

  await recorder.observe(snapshotEvent(failed), new AbortController().signal)
  await recorder.observe(snapshotEvent(sampled), new AbortController().signal)
  assert.deepEqual(store.engine.map(item => item.runRef), [failed.runRef, sampled.runRef])
  assert.deepEqual(recorder.snapshot(), {
    schemaVersion: 1,
    currentLevel: 'basic',
    committedCandidateWait: 0,
    presentationWait: 0
  })
})

test('sampled-out success waits for presentation and anomaly ordering is equivalent', async () => {
  for (const presentationFirst of [false, true]) {
    const store = new RecordingStore()
    const recorder = new TraceRecorder({ store })
    const candidate = traceCandidateFixture({
      runRef: traceRunRef(false, presentationFirst ? 140_000 : 160_000)
    })
    const anomaly = tracePresentationFixture(candidate, { anomaly: true })
    recorder.stageCommittedTraceCandidate(candidate)
    if (presentationFirst) {
      await recorder.observe(presentationEvent(anomaly), new AbortController().signal)
      await recorder.observe(snapshotEvent(candidate), new AbortController().signal)
    } else {
      await recorder.observe(snapshotEvent(candidate), new AbortController().signal)
      await recorder.observe(presentationEvent(anomaly), new AbortController().signal)
    }
    assert.equal(store.engine.length, 1)
    assert.equal(store.presentations.length, 1)
    assert.equal(recorder.snapshot().committedCandidateWait, 0)
    assert.equal(recorder.snapshot().presentationWait, 0)
  }
})

test('recorder enforces independent cap two and off clears both waits synchronously', async () => {
  const failures: string[] = []
  const recorder = new TraceRecorder({
    store: new RecordingStore(),
    onSinkFailure: failure => failures.push(`${failure.sink}/${failure.code}`)
  })
  const first = traceCandidateFixture({ runRef: traceRunRef(false, 180_000) })
  const second = traceCandidateFixture({ runRef: traceRunRef(false, 200_000) })
  const third = traceCandidateFixture({ runRef: traceRunRef(false, 220_000) })
  recorder.stageCommittedTraceCandidate(first)
  recorder.stageCommittedTraceCandidate(second)
  recorder.stageCommittedTraceCandidate(third)
  assert.equal(recorder.snapshot().committedCandidateWait, 2)
  assert.deepEqual(failures, ['trace/overflow'])
  await recorder.observe(snapshotEvent(second), new AbortController().signal)
  assert.equal(recorder.snapshot().presentationWait, 1)
  recorder.setCurrentLevel('off')
  assert.equal(recorder.snapshot().committedCandidateWait, 0)
  assert.equal(recorder.snapshot().presentationWait, 0)
})
