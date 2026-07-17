import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PHASE_6_REDIS_RESOURCE_KINDS,
  PHASE_6_RESOURCE_SCENARIOS,
  validatePhase6ResourceSample,
  type Phase6RedisResourceKind,
  type Phase6ResourceSample,
  type Phase6ResourceScenarioName
} from './phase-6-resource-scenario.js'

export const PHASE_6_RESOURCE_SAMPLES = 5
export const PHASE_5_BASELINE_COMMIT = '2b59cad1d944b6835dda541c04616b3673077802'
export const PHASE_5_IDLE_RETAINED_DELTA_BYTES = 6_930_432
export const PHASE_5_DUAL_PEAK_DELTA_BYTES = 22_675_456

const MIB = 1024 * 1024

export const PHASE_6_RESOURCE_THRESHOLDS = Object.freeze({
  idleRetainedDeltaBytes: 20 * MIB,
  singleTextPeakDeltaBytes: 40 * MIB,
  dualTextPeakDeltaBytes: 50 * MIB,
  checkpointResumePeakDeltaBytes: 45 * MIB,
  traceDiagnosticPeakDeltaBytes: 8 * MIB,
  runStoreBytes: 8 * MIB,
  traceStoreBytes: 2 * MIB,
  combinedStoreBytes: 10 * MIB
})

export interface Phase6ProcessSample {
  readonly processId: number
  readonly sample: Phase6ResourceSample
}

export interface Phase6NumericStats {
  readonly median: number
  readonly minimum: number
  readonly maximum: number
  readonly mad: number
}

export type Phase6ObservedStats = Phase6NumericStats | 'unavailable' | 'not_attempted'

export interface Phase6ScenarioReport {
  readonly processIds: readonly number[]
  readonly samples: readonly Phase6ResourceSample[]
  readonly outcome: Phase6ResourceSample['outcome']
  readonly rss: Readonly<{
    baseline: Phase6NumericStats
    retained: Readonly<{ absolute: Phase6NumericStats; delta: Phase6NumericStats }>
    peak: Readonly<{ absolute: Phase6NumericStats; delta: Phase6NumericStats }>
  }>
  readonly wallTimeMs: Phase6NumericStats
  readonly userCpuMicros: Phase6NumericStats
  readonly systemCpuMicros: Phase6NumericStats
  readonly redisResources: Readonly<Record<Phase6RedisResourceKind, Readonly<{
    records: Phase6ObservedStats
    bytes: Phase6ObservedStats
  }>>>
  readonly rendererResources: Readonly<{
    activePages: Phase6NumericStats
    borrowedBrowserHandles: Phase6NumericStats
    newChromiumProcesses: Phase6NumericStats
  }>
}

export interface Phase6ResourceReport {
  readonly schemaVersion: 1
  readonly samplesPerScenario: 5
  readonly totalProcessCount: 45
  readonly processIds: readonly number[]
  readonly scenarios: Readonly<Record<Phase6ResourceScenarioName, Phase6ScenarioReport>>
  readonly phase5Evidence: Readonly<{
    commit: typeof PHASE_5_BASELINE_COMMIT
    idleRetainedDeltaBytes: typeof PHASE_5_IDLE_RETAINED_DELTA_BYTES
    dualPeakDeltaBytes: typeof PHASE_5_DUAL_PEAK_DELTA_BYTES
  }>
  readonly comparisonToPhase5: Readonly<{
    idleRetainedDeltaBytes: number
    dualPeakDeltaBytes: number
  }>
  readonly resourceHighWaterMarks: Readonly<{
    runStoreBytes: number | 'unavailable' | 'not_attempted'
    traceStoreBytes: number | 'unavailable' | 'not_attempted'
    combinedStoreBytes: number | 'unavailable' | 'not_attempted'
  }>
  readonly thresholds: typeof PHASE_6_RESOURCE_THRESHOLDS
  readonly gates: Readonly<{
    idleRetained: boolean
    singleTextPeak: boolean
    dualTextPeak: boolean
    checkpointResumePeak: boolean
    traceDiagnosticPeak: boolean
    runStoreBytes: boolean
    traceStoreBytes: boolean
    combinedStoreBytes: boolean
    pictureResources: boolean
  }>
  readonly passed: boolean
}

type ResourceInput = Readonly<Record<
Phase6ResourceScenarioName,
readonly Phase6ProcessSample[]
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
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function statistics (values: readonly number[]): Phase6NumericStats {
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

function observedStatistics (
  values: readonly (number | 'unavailable' | 'not_attempted')[]
): Phase6ObservedStats {
  if (values.some(value => value === 'unavailable')) return 'unavailable'
  if (values.some(value => value === 'not_attempted')) return 'not_attempted'
  return statistics(values as readonly number[])
}

function validateInput (value: unknown): ResourceInput {
  const input = record(value, 'Phase 6 resource samples')
  if (Object.keys(input).length !== PHASE_6_RESOURCE_SCENARIOS.length ||
    PHASE_6_RESOURCE_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
    throw new TypeError('Phase 6 resource scenarios are incomplete')
  }
  const processIds = new Set<number>()
  const result = Object.fromEntries(PHASE_6_RESOURCE_SCENARIOS.map(scenario => {
    const values = input[scenario]
    if (!Array.isArray(values) || values.length !== PHASE_6_RESOURCE_SAMPLES) {
      throw new TypeError('Phase 6 resource report requires five fresh processes per scenario')
    }
    const entries = values.map((value, index) => {
      const entry = record(value, `Phase 6 process sample ${scenario}:${index}`)
      if (Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, 'processId') || !Object.hasOwn(entry, 'sample') ||
        !Number.isSafeInteger(entry.processId) || Number(entry.processId) <= 0) {
        throw new TypeError('Phase 6 process sample is invalid')
      }
      const processId = Number(entry.processId)
      if (processIds.has(processId)) {
        throw new TypeError('Phase 6 process samples must use unique fresh processes')
      }
      processIds.add(processId)
      return Object.freeze({
        processId,
        sample: validatePhase6ResourceSample(entry.sample, scenario)
      })
    })
    return [scenario, Object.freeze(entries)]
  }))
  if (processIds.size !== PHASE_6_RESOURCE_SCENARIOS.length * PHASE_6_RESOURCE_SAMPLES) {
    throw new TypeError('Phase 6 resource report requires 45 unique processes')
  }
  return Object.freeze(result) as ResourceInput
}

function scenarioReport (
  scenario: Phase6ResourceScenarioName,
  entries: readonly Phase6ProcessSample[]
): Phase6ScenarioReport {
  const samples = entries.map(entry => entry.sample)
  const baselines = samples.map(sample => sample.baselineRssBytes)
  const retained = samples.map(sample => sample.retainedRssBytes)
  const peaks = samples.map(sample => sample.peakRssBytes)
  const redisResources = Object.fromEntries(PHASE_6_REDIS_RESOURCE_KINDS.map((kind, index) => [
    kind,
    Object.freeze({
      records: observedStatistics(samples.map(sample => {
        const current = sample.redisResources[index]
        if (current?.kind !== kind) throw new TypeError('Redis resource kind order drifted')
        return current.records
      })),
      bytes: observedStatistics(samples.map(sample => {
        const current = sample.redisResources[index]
        if (current?.kind !== kind) throw new TypeError('Redis resource kind order drifted')
        return current.bytes
      }))
    })
  ])) as Readonly<Record<Phase6RedisResourceKind, Readonly<{
    records: Phase6ObservedStats
    bytes: Phase6ObservedStats
  }>>>
  return Object.freeze({
    processIds: Object.freeze(entries.map(entry => entry.processId)),
    samples: Object.freeze(samples),
    outcome: samples[0]?.outcome as Phase6ResourceSample['outcome'],
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
    redisResources,
    rendererResources: Object.freeze({
      activePages: statistics(samples.map(sample => sample.activePages)),
      borrowedBrowserHandles: statistics(samples.map(sample => sample.borrowedBrowserHandles)),
      newChromiumProcesses: statistics(samples.map(sample => sample.newChromiumProcesses))
    })
  })
}

function resourceTotals (
  input: ResourceInput,
  start: number,
  end: number
): readonly (number | 'unavailable' | 'not_attempted')[] {
  return PHASE_6_RESOURCE_SCENARIOS.flatMap(scenario => input[scenario].map(entry => {
    const values = entry.sample.redisResources.slice(start, end).map(resource => resource.bytes)
    if (values.some(value => value === 'unavailable')) return 'unavailable' as const
    if (values.some(value => value === 'not_attempted')) return 'not_attempted' as const
    return (values as readonly number[]).reduce((total, value) => total + value, 0)
  }))
}

function highWaterMark (
  values: readonly (number | 'unavailable' | 'not_attempted')[]
): number | 'unavailable' | 'not_attempted' {
  if (values.some(value => value === 'unavailable')) return 'unavailable'
  if (values.some(value => value === 'not_attempted')) return 'not_attempted'
  return Math.max(...values as readonly number[])
}

function within (value: number | 'unavailable' | 'not_attempted', limit: number): boolean {
  return typeof value === 'number' && value <= limit
}

export function buildPhase6ResourceReport (value: unknown): Phase6ResourceReport {
  const input = validateInput(value)
  const scenarios = Object.freeze(Object.fromEntries(PHASE_6_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    scenarioReport(scenario, input[scenario])
  ]))) as Readonly<Record<Phase6ResourceScenarioName, Phase6ScenarioReport>>
  const processIds = Object.freeze(PHASE_6_RESOURCE_SCENARIOS.flatMap(scenario => (
    input[scenario].map(entry => entry.processId)
  )))
  const runTotals = resourceTotals(input, 0, 6)
  const traceTotals = resourceTotals(input, 6, 10)
  const combinedTotals = runTotals.map((run, index) => {
    const trace = traceTotals[index]
    if (run === 'unavailable' || trace === 'unavailable') return 'unavailable' as const
    if (run === 'not_attempted' || trace === 'not_attempted') return 'not_attempted' as const
    return run + trace
  })
  const resourceHighWaterMarks = Object.freeze({
    runStoreBytes: highWaterMark(runTotals),
    traceStoreBytes: highWaterMark(traceTotals),
    combinedStoreBytes: highWaterMark(combinedTotals)
  })
  const pictureResources = ['pictureSuccess', 'pictureFailure'].every(scenario => {
    const report = scenarios[scenario as 'pictureSuccess' | 'pictureFailure']
    return report.rendererResources.activePages.maximum === 0 &&
      report.rendererResources.borrowedBrowserHandles.maximum === 0 &&
      report.rendererResources.newChromiumProcesses.maximum === 0
  })
  const thresholds = PHASE_6_RESOURCE_THRESHOLDS
  const gates = Object.freeze({
    idleRetained: scenarios.idle.rss.retained.delta.median <= thresholds.idleRetainedDeltaBytes,
    singleTextPeak: scenarios.singleTextRun.rss.peak.delta.median <=
      thresholds.singleTextPeakDeltaBytes,
    dualTextPeak: scenarios.dualTextRun.rss.peak.delta.median <= thresholds.dualTextPeakDeltaBytes,
    checkpointResumePeak: scenarios.checkpointResume.rss.peak.delta.median <=
      thresholds.checkpointResumePeakDeltaBytes,
    traceDiagnosticPeak: scenarios.traceDiagnostic.rss.peak.delta.median <=
      thresholds.traceDiagnosticPeakDeltaBytes,
    runStoreBytes: within(resourceHighWaterMarks.runStoreBytes, thresholds.runStoreBytes),
    traceStoreBytes: within(resourceHighWaterMarks.traceStoreBytes, thresholds.traceStoreBytes),
    combinedStoreBytes: within(resourceHighWaterMarks.combinedStoreBytes, thresholds.combinedStoreBytes),
    pictureResources
  })
  const phase5Evidence = Object.freeze({
    commit: PHASE_5_BASELINE_COMMIT,
    idleRetainedDeltaBytes: PHASE_5_IDLE_RETAINED_DELTA_BYTES,
    dualPeakDeltaBytes: PHASE_5_DUAL_PEAK_DELTA_BYTES
  })
  return Object.freeze({
    schemaVersion: 1,
    samplesPerScenario: PHASE_6_RESOURCE_SAMPLES,
    totalProcessCount: processIds.length as 45,
    processIds,
    scenarios,
    phase5Evidence,
    comparisonToPhase5: Object.freeze({
      idleRetainedDeltaBytes: scenarios.idle.rss.retained.delta.median -
        PHASE_5_IDLE_RETAINED_DELTA_BYTES,
      dualPeakDeltaBytes: scenarios.dualTextRun.rss.peak.delta.median -
        PHASE_5_DUAL_PEAK_DELTA_BYTES
    }),
    resourceHighWaterMarks,
    thresholds,
    gates,
    passed: Object.values(gates).every(Boolean)
  })
}

function runFreshScenario (scenario: Phase6ResourceScenarioName): Phase6ProcessSample {
  const script = fileURLToPath(new URL('../../scripts/phase-6-resource-scenario.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--expose-gc', script, scenario], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 * MIB,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 || !Number.isSafeInteger(result.pid) || Number(result.pid) <= 0) {
    const detail = result.stderr.trim().slice(0, 1_000)
    throw new Error(`Phase 6 resource child failed for ${scenario}${detail === '' ? '' : `: ${detail}`}`)
  }
  let value: unknown
  try {
    value = JSON.parse(result.stdout.trim()) as unknown
  } catch {
    throw new TypeError(`Phase 6 resource child returned invalid JSON for ${scenario}`)
  }
  return Object.freeze({
    processId: Number(result.pid),
    sample: validatePhase6ResourceSample(value, scenario)
  })
}

export async function main (): Promise<void> {
  const samples = Object.fromEntries(PHASE_6_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Object.freeze(Array.from(
      { length: PHASE_6_RESOURCE_SAMPLES },
      () => runFreshScenario(scenario)
    ))
  ]))
  const report = buildPhase6ResourceReport(samples)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}
