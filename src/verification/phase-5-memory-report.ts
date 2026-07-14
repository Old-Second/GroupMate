import {
  PHASE_5_MEMORY_SCENARIOS,
  type Phase5MemoryScenarioName,
  type Phase5MemorySample
} from './phase-5-memory-scenario.js'

export const PHASE_5_MEMORY_SAMPLES = 5
export const PHASE_5_IDLE_RETAINED_LIMIT_BYTES = 20 * 1024 * 1024
export const PHASE_5_DUAL_RUN_PEAK_LIMIT_BYTES = 50 * 1024 * 1024

const EXPECTED_REQUESTS: Readonly<Record<Phase5MemoryScenarioName, number>> = Object.freeze({
  idle: 0,
  singleRun: 1,
  dualRun: 2,
  checkpointRecovery: 1
})

const EXPECTED_CONCURRENCY: Readonly<Record<Phase5MemoryScenarioName, number>> = Object.freeze({
  idle: 0,
  singleRun: 1,
  dualRun: 2,
  checkpointRecovery: 1
})

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function positiveInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return Number(value)
}

export function validatePhase5MemorySample (
  value: unknown,
  expectedScenario: Phase5MemoryScenarioName
): Phase5MemorySample {
  const sample = record(value, 'memory sample')
  const keys = Object.keys(sample)
  const expectedKeys = [
    'scenario', 'requestCount', 'maxConcurrentRequests', 'baselineRssBytes',
    'retainedRssBytes', 'observedPeakRssBytes'
  ]
  if (keys.length !== expectedKeys.length ||
    expectedKeys.some(key => !Object.hasOwn(sample, key)) ||
    sample.scenario !== expectedScenario) {
    throw new TypeError('memory sample scenario is invalid')
  }
  if (sample.requestCount !== EXPECTED_REQUESTS[expectedScenario]) {
    throw new TypeError('memory sample request count is invalid')
  }
  if (sample.maxConcurrentRequests !== EXPECTED_CONCURRENCY[expectedScenario]) {
    throw new TypeError('memory sample concurrency is invalid')
  }
  const baselineRssBytes = positiveInteger(sample.baselineRssBytes, 'baseline RSS')
  const retainedRssBytes = positiveInteger(sample.retainedRssBytes, 'retained RSS')
  const observedPeakRssBytes = positiveInteger(sample.observedPeakRssBytes, 'peak RSS')
  if (observedPeakRssBytes < baselineRssBytes || observedPeakRssBytes < retainedRssBytes) {
    throw new TypeError('memory sample peak RSS is invalid')
  }
  return Object.freeze({
    scenario: expectedScenario,
    requestCount: EXPECTED_REQUESTS[expectedScenario],
    maxConcurrentRequests: EXPECTED_CONCURRENCY[expectedScenario],
    baselineRssBytes,
    retainedRssBytes,
    observedPeakRssBytes
  })
}

function median (values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function medianSample (
  scenario: Phase5MemoryScenarioName,
  samples: readonly Phase5MemorySample[]
): Phase5MemorySample {
  return Object.freeze({
    scenario,
    requestCount: EXPECTED_REQUESTS[scenario],
    maxConcurrentRequests: EXPECTED_CONCURRENCY[scenario],
    baselineRssBytes: median(samples.map(sample => sample.baselineRssBytes)),
    retainedRssBytes: median(samples.map(sample => sample.retainedRssBytes)),
    observedPeakRssBytes: median(samples.map(sample => sample.observedPeakRssBytes))
  })
}

export interface Phase5MemoryReport {
  readonly samplesPerScenario: 5
  readonly samples: Readonly<Record<Phase5MemoryScenarioName, readonly Phase5MemorySample[]>>
  readonly medians: Readonly<Record<Phase5MemoryScenarioName, Phase5MemorySample>>
  readonly deltas: Readonly<{
    idleRetainedBytes: number
    dualRunPeakBytes: number
  }>
  readonly thresholds: Readonly<{
    idleRetainedDeltaBytes: number
    dualRunPeakDeltaBytes: number
  }>
  readonly gates: Readonly<{
    idleRetained: boolean
    dualRunPeak: boolean
  }>
  readonly passed: boolean
}

export function buildPhase5MemoryReport (value: unknown): Phase5MemoryReport {
  const input = record(value, 'memory samples')
  if (Object.keys(input).length !== PHASE_5_MEMORY_SCENARIOS.length ||
    PHASE_5_MEMORY_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
    throw new TypeError('memory sample scenarios are incomplete')
  }
  const samples = Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map(scenario => {
    const values = input[scenario]
    if (!Array.isArray(values) || values.length !== PHASE_5_MEMORY_SAMPLES) {
      throw new TypeError('memory report requires five samples per scenario')
    }
    return [scenario, Object.freeze(values.map(sample => (
      validatePhase5MemorySample(sample, scenario)
    )))]
  })) as unknown as Readonly<Record<Phase5MemoryScenarioName, readonly Phase5MemorySample[]>>
  const medians = Object.freeze(Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map(scenario => [
    scenario,
    medianSample(scenario, samples[scenario])
  ]))) as unknown as Readonly<Record<Phase5MemoryScenarioName, Phase5MemorySample>>
  const deltas = Object.freeze({
    idleRetainedBytes: medians.idle.retainedRssBytes - medians.idle.baselineRssBytes,
    dualRunPeakBytes: medians.dualRun.observedPeakRssBytes -
      medians.dualRun.baselineRssBytes
  })
  const thresholds = Object.freeze({
    idleRetainedDeltaBytes: PHASE_5_IDLE_RETAINED_LIMIT_BYTES,
    dualRunPeakDeltaBytes: PHASE_5_DUAL_RUN_PEAK_LIMIT_BYTES
  })
  const gates = Object.freeze({
    idleRetained: deltas.idleRetainedBytes <= thresholds.idleRetainedDeltaBytes,
    dualRunPeak: deltas.dualRunPeakBytes <= thresholds.dualRunPeakDeltaBytes
  })
  return Object.freeze({
    samplesPerScenario: PHASE_5_MEMORY_SAMPLES,
    samples,
    medians,
    deltas,
    thresholds,
    gates,
    passed: gates.idleRetained && gates.dualRunPeak
  })
}
