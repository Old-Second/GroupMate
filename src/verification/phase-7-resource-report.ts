import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  MAX_CONTEXT_ARTIFACT_BYTES,
  MAX_CONTEXT_ARTIFACT_CONTENT_BYTES,
  MAX_CONTEXT_ARTIFACT_REFS
} from '../agent/context/context-artifact.js'
import { MAX_CONTEXT_PLANNER_INPUT_BYTES } from '../agent/context/context-planner.js'
import { CONTEXT_ARTIFACT_RESOURCE_LIMITS } from '../agent/context/context-resource-limits.js'
import { RUN_ADMISSION_LIMITS } from '../agent/run/run-admission.js'
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js'
import {
  PHASE_7_RESOURCE_SCENARIOS,
  validatePhase7ResourceSample,
  type Phase7ResourceSample,
  type Phase7ResourceScenarioName
} from './phase-7-resource-scenario.js'

const MIB = 1_024 * 1_024

export const PHASE_7_RESOURCE_SAMPLES = 5

export const PHASE_7_RESOURCE_THRESHOLDS = Object.freeze({
  idleRetainedDeltaBytes: 20 * MIB,
  dualPeakDeltaBytes: 50 * MIB,
  cacheUsagePeakDeltaBytes: 40 * MIB,
  plannerCompactionPeakDeltaBytes: 45 * MIB,
  artifactRedisPeakDeltaBytes: 45 * MIB,
  crashRecoveryPeakDeltaBytes: 45 * MIB,
  catastrophicMaximumMultiplier: 2
})

export const PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS = Object.freeze({
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
  referenceKeys: 144,
  indexAdmissionKeys: 64
})

export const PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS = Object.freeze({
  artifactBytes: 16 * 1_024,
  contentBytes: 8 * 1_024,
  sourceRefs: 32,
  namespaceKeys: 128,
  namespaceBytes: 2 * 1_024 * 1_024,
  minimumRemainingLifetimeMs: 1,
  maximumExpiryHorizonMs: 86_400_000,
  reconcileScanCount: 128,
  maxReconcileScanCalls: 2_048,
  maxReconcileDataKeys: 129,
  maxMetadataCasAttempts: 4,
  metadataBytes: 64
})

export const PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS = Object.freeze({
  activeRuns: 2,
  queuedRuns: 3
})

export interface Phase7ProcessSample {
  readonly processId: number
  readonly sample: Phase7ResourceSample
}

export interface Phase7NumericStats {
  readonly median: number
  readonly minimum: number
  readonly maximum: number
  readonly mad: number
}

export interface Phase7ScenarioReport {
  readonly processIds: readonly number[]
  readonly samples: readonly Phase7ResourceSample[]
  readonly outcome: Phase7ResourceSample['outcome']
  readonly rss: Readonly<{
    baseline: Phase7NumericStats
    retained: Readonly<{ absolute: Phase7NumericStats; delta: Phase7NumericStats }>
    peak: Readonly<{ absolute: Phase7NumericStats; delta: Phase7NumericStats }>
  }>
  readonly wallTimeMs: Phase7NumericStats
  readonly userCpuMicros: Phase7NumericStats
  readonly systemCpuMicros: Phase7NumericStats
  readonly operations: Phase7NumericStats
  readonly artifactStore: Readonly<{
    records: Phase7NumericStats
    bytes: Phase7NumericStats
  }>
}

export interface Phase7ResourceReport {
  readonly schemaVersion: 1
  readonly samplesPerScenario: 5
  readonly totalProcessCount: 30
  readonly processIds: readonly number[]
  readonly scenarios: Readonly<Record<Phase7ResourceScenarioName, Phase7ScenarioReport>>
  readonly thresholds: typeof PHASE_7_RESOURCE_THRESHOLDS
  readonly limitContracts: Readonly<{
    plannerInputBytes: number
    admission: typeof RUN_ADMISSION_LIMITS
    runStore: typeof RUN_RESOURCE_LIMITS
    contextArtifacts: typeof CONTEXT_ARTIFACT_RESOURCE_LIMITS
  }>
  readonly gates: Readonly<{
    idleRetained: boolean
    dualPeak: boolean
    cacheUsagePeak: boolean
    plannerCompactionPeak: boolean
    artifactRedisPeak: boolean
    crashRecoveryPeak: boolean
    admissionLimits: boolean
    runStoreLimits: boolean
    contextArtifactLimits: boolean
    plannerInputLimit: boolean
    artifactNamespaceUsage: boolean
  }>
  readonly passed: boolean
}

type ResourceInput = Readonly<Record<
Phase7ResourceScenarioName,
readonly Phase7ProcessSample[]
>>

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function median (values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('statistics require at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function statistics (values: readonly number[]): Phase7NumericStats {
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new TypeError('resource statistics require safe integers')
  }
  const center = median(values)
  return Object.freeze({
    median: center,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mad: median(values.map(value => Math.abs(value - center)))
  })
}

function sameRecord (
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>
): boolean {
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every(key => actual[key] === expected[key])
}

function withinMemoryStop (
  stats: Phase7NumericStats,
  medianLimit: number
): boolean {
  return stats.median <= medianLimit &&
    stats.maximum <= medianLimit * PHASE_7_RESOURCE_THRESHOLDS.catastrophicMaximumMultiplier
}

function validateInput (value: unknown): ResourceInput {
  const input = record(value, 'Phase 7 resource samples')
  if (Object.keys(input).length !== PHASE_7_RESOURCE_SCENARIOS.length ||
    PHASE_7_RESOURCE_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
    throw new TypeError('Phase 7 resource scenarios are incomplete')
  }
  const processIds = new Set<number>()
  const result = Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => {
    const values = input[scenario]
    if (!Array.isArray(values) || values.length !== PHASE_7_RESOURCE_SAMPLES) {
      throw new TypeError('Phase 7 resource report requires five fresh processes per scenario')
    }
    const entries = values.map((value, index) => {
      const entry = record(value, `Phase 7 process sample ${scenario}:${index}`)
      if (Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, 'processId') || !Object.hasOwn(entry, 'sample') ||
        !Number.isSafeInteger(entry.processId) || Number(entry.processId) <= 0) {
        throw new TypeError('Phase 7 process sample is invalid')
      }
      const processId = Number(entry.processId)
      if (processIds.has(processId)) {
        throw new TypeError('Phase 7 process samples must use unique fresh processes')
      }
      processIds.add(processId)
      return Object.freeze({
        processId,
        sample: validatePhase7ResourceSample(entry.sample, scenario)
      })
    })
    return [scenario, Object.freeze(entries)]
  }))
  if (processIds.size !== PHASE_7_RESOURCE_SCENARIOS.length * PHASE_7_RESOURCE_SAMPLES) {
    throw new TypeError('Phase 7 resource report requires 30 unique processes')
  }
  return Object.freeze(result) as ResourceInput
}

function scenarioReport (
  entries: readonly Phase7ProcessSample[]
): Phase7ScenarioReport {
  const samples = entries.map(entry => entry.sample)
  const baselines = samples.map(sample => sample.baselineRssBytes)
  const retained = samples.map(sample => sample.retainedRssBytes)
  const peaks = samples.map(sample => sample.peakRssBytes)
  return Object.freeze({
    processIds: Object.freeze(entries.map(entry => entry.processId)),
    samples: Object.freeze(samples),
    outcome: samples[0]?.outcome as Phase7ResourceSample['outcome'],
    rss: Object.freeze({
      baseline: statistics(baselines),
      retained: Object.freeze({
        absolute: statistics(retained),
        delta: statistics(retained.map((value, index) => value - (baselines[index] as number)))
      }),
      peak: Object.freeze({
        absolute: statistics(peaks),
        delta: statistics(peaks.map((value, index) => value - (baselines[index] as number)))
      })
    }),
    wallTimeMs: statistics(samples.map(sample => sample.wallTimeMs)),
    userCpuMicros: statistics(samples.map(sample => sample.userCpuMicros)),
    systemCpuMicros: statistics(samples.map(sample => sample.systemCpuMicros)),
    operations: statistics(samples.map(sample => sample.operations)),
    artifactStore: Object.freeze({
      records: statistics(samples.map(sample => sample.artifactStoreRecords)),
      bytes: statistics(samples.map(sample => sample.artifactStoreBytes))
    })
  })
}

export function buildPhase7ResourceReport (value: unknown): Phase7ResourceReport {
  const input = validateInput(value)
  const scenarios = Object.freeze(Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    scenarioReport(input[scenario])
  ]))) as Readonly<Record<Phase7ResourceScenarioName, Phase7ScenarioReport>>
  const processIds = Object.freeze(PHASE_7_RESOURCE_SCENARIOS.flatMap(scenario => (
    input[scenario].map(entry => entry.processId)
  )))
  const thresholds = PHASE_7_RESOURCE_THRESHOLDS
  const limitContracts = Object.freeze({
    plannerInputBytes: MAX_CONTEXT_PLANNER_INPUT_BYTES,
    admission: RUN_ADMISSION_LIMITS,
    runStore: RUN_RESOURCE_LIMITS,
    contextArtifacts: CONTEXT_ARTIFACT_RESOURCE_LIMITS
  })
  const gates = Object.freeze({
    idleRetained: withinMemoryStop(
      scenarios.idle.rss.retained.delta,
      thresholds.idleRetainedDeltaBytes
    ),
    dualPeak: withinMemoryStop(scenarios.dual.rss.peak.delta, thresholds.dualPeakDeltaBytes),
    cacheUsagePeak: withinMemoryStop(
      scenarios.cacheUsage.rss.peak.delta,
      thresholds.cacheUsagePeakDeltaBytes
    ),
    plannerCompactionPeak: withinMemoryStop(
      scenarios.plannerCompaction.rss.peak.delta,
      thresholds.plannerCompactionPeakDeltaBytes
    ),
    artifactRedisPeak: withinMemoryStop(
      scenarios.artifactRedis.rss.peak.delta,
      thresholds.artifactRedisPeakDeltaBytes
    ),
    crashRecoveryPeak: withinMemoryStop(
      scenarios.crashRecovery.rss.peak.delta,
      thresholds.crashRecoveryPeakDeltaBytes
    ),
    admissionLimits: sameRecord(
      RUN_ADMISSION_LIMITS,
      PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS
    ),
    runStoreLimits: sameRecord(RUN_RESOURCE_LIMITS, PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS),
    contextArtifactLimits: sameRecord(
      CONTEXT_ARTIFACT_RESOURCE_LIMITS,
      PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS
    ) && MAX_CONTEXT_ARTIFACT_BYTES === 16 * 1_024 &&
      MAX_CONTEXT_ARTIFACT_CONTENT_BYTES === 8 * 1_024 && MAX_CONTEXT_ARTIFACT_REFS === 32,
    plannerInputLimit: MAX_CONTEXT_PLANNER_INPUT_BYTES === RUN_RESOURCE_LIMITS.requestBytes &&
      RUN_RESOURCE_LIMITS.requestBytes === 512 * 1_024 &&
      RUN_RESOURCE_LIMITS.checkpointBytes === 256 * 1_024,
    artifactNamespaceUsage: scenarios.artifactRedis.artifactStore.records.maximum > 0 &&
      scenarios.artifactRedis.artifactStore.records.maximum <=
        CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys &&
      scenarios.artifactRedis.artifactStore.bytes.maximum > 0 &&
      scenarios.artifactRedis.artifactStore.bytes.maximum <=
        CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes
  })
  return Object.freeze({
    schemaVersion: 1,
    samplesPerScenario: PHASE_7_RESOURCE_SAMPLES,
    totalProcessCount: processIds.length as 30,
    processIds,
    scenarios,
    thresholds,
    limitContracts,
    gates,
    passed: Object.values(gates).every(Boolean)
  })
}

function runFreshScenario (scenario: Phase7ResourceScenarioName): Phase7ProcessSample {
  const script = fileURLToPath(new URL('../../scripts/phase-7-resource-scenario.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--expose-gc', script, scenario], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 * MIB,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 || !Number.isSafeInteger(result.pid) || Number(result.pid) <= 0) {
    const detail = result.stderr.trim().slice(0, 1_000)
    throw new Error(`Phase 7 resource child failed for ${scenario}${detail === '' ? '' : `: ${detail}`}`)
  }
  let value: unknown
  try {
    value = JSON.parse(result.stdout.trim()) as unknown
  } catch {
    throw new TypeError(`Phase 7 resource child returned invalid JSON for ${scenario}`)
  }
  return Object.freeze({
    processId: Number(result.pid),
    sample: validatePhase7ResourceSample(value, scenario)
  })
}

export async function main (): Promise<void> {
  const samples = Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Object.freeze(Array.from(
      { length: PHASE_7_RESOURCE_SAMPLES },
      () => runFreshScenario(scenario)
    ))
  ]))
  const report = buildPhase7ResourceReport(samples)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}
