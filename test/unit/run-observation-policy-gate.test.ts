import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrozenObservationPolicy } from '../../src/agent/run/run-observation.js'
import {
  RunObservationPolicyGate,
  RunObservationPolicyMismatchError
} from '../../src/runtime/observability/run-observation-policy-gate.js'
import {
  traceCandidateFixture,
  tracePresentationFixture,
  traceRunRef
} from '../helpers/trace-fixture.js'

function snapshotEvent (candidate: ReturnType<typeof traceCandidateFixture>) {
  return Object.freeze({
    schemaVersion: 1 as const,
    type: 'terminal_snapshot' as const,
    value: candidate.terminal
  })
}

function presentationEvent (candidate: ReturnType<typeof traceCandidateFixture>) {
  return Object.freeze({
    schemaVersion: 1 as const,
    type: 'presentation' as const,
    value: tracePresentationFixture(candidate)
  })
}

test('gate validates deterministic policy and fails closed after a mismatch', () => {
  const runRef = traceRunRef(false, 100)
  const policy = createFrozenObservationPolicy({ levelAtStart: 'basic', runRef })
  const candidate = traceCandidateFixture({ runRef })
  const gate = new RunObservationPolicyGate()

  gate.register(runRef, policy)
  assert.equal(gate.allow(snapshotEvent(candidate)), true)
  assert.equal(gate.allowCommittedCandidate(candidate), true)

  assert.throws(() => gate.register(runRef, Object.freeze({
    ...policy,
    levelAtStart: 'diagnostic'
  })), RunObservationPolicyMismatchError)
  assert.equal(gate.allow(snapshotEvent(candidate)), false)
  assert.equal(gate.allowCommittedCandidate(candidate), false)
  assert.equal(gate.snapshot().missingDrops, 2)
})

test('gate applies the stricter start/current level without losing a valid entry', () => {
  const diagnosticRunRef = traceRunRef(false, 200)
  const diagnostic = traceCandidateFixture({
    runRef: diagnosticRunRef,
    level: 'diagnostic'
  })
  const basicRunRef = traceRunRef(false, 300)
  const basic = traceCandidateFixture({ runRef: basicRunRef, level: 'basic' })
  const offRunRef = traceRunRef(false, 400)
  const off = traceCandidateFixture({ runRef: offRunRef, level: 'off' })
  const gate = new RunObservationPolicyGate()
  gate.register(diagnosticRunRef, diagnostic.policy)
  gate.register(basicRunRef, basic.policy)
  gate.register(offRunRef, off.policy)

  assert.equal(gate.allow(snapshotEvent(diagnostic)), true)
  assert.equal(gate.allow(snapshotEvent(basic)), true)
  assert.equal(gate.allow(snapshotEvent(off)), false)
  gate.setCurrentLevel('off')
  assert.equal(gate.allow(snapshotEvent(diagnostic)), false)
  gate.setCurrentLevel('basic')
  assert.equal(gate.allow(snapshotEvent(diagnostic)), true)
  gate.setCurrentLevel('diagnostic')
  assert.equal(gate.allow(snapshotEvent(basic)), true)
  assert.equal(gate.allow(snapshotEvent(off)), false)
})

test('gate uses lazy TTL, access-order capacity, and byte-equal candidate policy', () => {
  let now = 0
  const gate = new RunObservationPolicyGate({ now: () => now })
  const firstRef = traceRunRef(false, 500)
  const first = traceCandidateFixture({ runRef: firstRef })
  gate.register(firstRef, first.policy)
  now = 599_999
  gate.register(firstRef, first.policy)
  now = 600_001
  assert.equal(gate.allow(snapshotEvent(first)), true)

  for (let index = 0; index < 32; index += 1) {
    const runRef = traceRunRef(false, 1_000 + index * 10_000)
    gate.register(runRef, createFrozenObservationPolicy({ levelAtStart: 'basic', runRef }))
  }
  assert.equal(gate.allow(snapshotEvent(first)), false)
  assert.equal(gate.snapshot().entries, 32)
  assert.equal(gate.snapshot().evictions, 1)

  const latestRef = traceRunRef(false, 301_000)
  const latest = traceCandidateFixture({ runRef: latestRef })
  gate.register(latestRef, latest.policy)
  const forged = Object.freeze({
    ...latest,
    policy: Object.freeze({ ...latest.policy, sampledSuccess: !latest.policy.sampledSuccess })
  })
  assert.equal(gate.allowCommittedCandidate(forged), false)

  now += 600_001
  assert.equal(gate.allow(presentationEvent(latest)), false)
})
