import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import {
  PHASE_5_MEMORY_SCENARIOS,
  runPhase5MemoryScenario
} from '../../src/verification/phase-5-memory-scenario.js'
import {
  buildPhase5MemoryReport,
  validatePhase5MemorySample
} from '../../src/verification/phase-5-memory-report.js'

test('Phase 5 keeps every wire, protocol, checkpoint and namespace limit explicit', () => {
  assert.deepEqual(RUN_RESOURCE_LIMITS, {
    requestBytes: 512 * 1_024,
    sseLineBytes: 64 * 1_024,
    providerResponseBytes: 1_024 * 1_024,
    toolArgumentsBytes: 32 * 1_024,
    toolResultBytes: 64 * 1_024,
    providerStateBytes: 128 * 1_024,
    sanitizedErrorBodyBytes: 16 * 1_024,
    providerProtocolChainBytes: 192 * 1_024,
    checkpointBytes: 256 * 1_024,
    eventCount: 96,
    eventBytes: 128 * 1_024,
    namespaceBytes: 8 * 1_024 * 1_024,
    tombstoneBytes: 4 * 1_024,
    checkpointKeys: 16,
    eventKeys: 16,
    tombstoneKeys: 128,
    indexAdmissionKeys: 64
  })
})

test('Phase 5 fixture memory scenarios have fixed bounded request shapes', async () => {
  assert.deepEqual(PHASE_5_MEMORY_SCENARIOS, [
    'idle', 'singleRun', 'dualRun', 'checkpointRecovery'
  ])
  const samples = []
  for (const scenario of PHASE_5_MEMORY_SCENARIOS) {
    const sample = await runPhase5MemoryScenario(scenario, { settleMs: 0 })
    samples.push(validatePhase5MemorySample(sample, scenario))
  }
  assert.deepEqual(samples.map(sample => sample.requestCount), [0, 1, 2, 1])
  assert.deepEqual(samples.map(sample => sample.maxConcurrentRequests), [0, 1, 2, 1])
})

test('Phase 5 memory report uses five-sample medians and fixed thresholds', () => {
  const samples = Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map((scenario, scenarioIndex) => [
    scenario,
    [5, 1, 4, 2, 3].map((multiplier, sampleIndex) => ({
      scenario,
      requestCount: [0, 1, 2, 1][scenarioIndex],
      maxConcurrentRequests: [0, 1, 2, 1][scenarioIndex],
      baselineRssBytes: 100 * 1024 * 1024 + sampleIndex,
      retainedRssBytes: (100 + (scenarioIndex === 0 ? 10 : 12)) * 1024 * 1024 + multiplier,
      observedPeakRssBytes: (100 + (scenarioIndex === 2 ? 40 : 15)) * 1024 * 1024 + multiplier
    }))
  ]))
  const report = buildPhase5MemoryReport(samples)
  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.thresholds.idleRetainedDeltaBytes, 20 * 1024 * 1024)
  assert.equal(report.thresholds.dualRunPeakDeltaBytes, 50 * 1024 * 1024)
  assert.equal(report.medians.idle.retainedRssBytes, 110 * 1024 * 1024 + 3)
  assert.equal(report.passed, true)

  const failed = buildPhase5MemoryReport({
    ...samples,
    dualRun: samples.dualRun.map(sample => ({
      ...sample,
      observedPeakRssBytes: sample.baselineRssBytes + 51 * 1024 * 1024
    }))
  })
  assert.equal(failed.gates.dualRunPeak, false)
  assert.equal(failed.passed, false)
})

test('Phase 5 memory report rejects wrong scenario counts and malformed samples', () => {
  assert.throws(() => validatePhase5MemorySample({
    scenario: 'idle', requestCount: 1, maxConcurrentRequests: 0,
    baselineRssBytes: 1, retainedRssBytes: 1, observedPeakRssBytes: 1
  }, 'idle'), /request count/i)
  assert.throws(() => buildPhase5MemoryReport({
    idle: [], singleRun: [], dualRun: [], checkpointRecovery: []
  }), /five samples/i)
})
