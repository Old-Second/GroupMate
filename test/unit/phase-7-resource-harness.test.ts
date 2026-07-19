import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  PHASE_7_RESOURCE_OUTCOMES,
  PHASE_7_RESOURCE_SCENARIOS,
  runPhase7ResourceScenario,
  validatePhase7ResourceSample,
  type Phase7ResourceSample,
  type Phase7ResourceScenarioName
} from '../../src/verification/phase-7-resource-scenario.js'
import {
  PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS,
  PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS,
  PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS,
  PHASE_7_RESOURCE_SAMPLES,
  PHASE_7_RESOURCE_THRESHOLDS,
  buildPhase7ResourceReport
} from '../../src/verification/phase-7-resource-report.js'

const root = process.cwd()
const MIB = 1_024 * 1_024

function sample (
  scenario: Phase7ResourceScenarioName,
  seed: number,
  overrides: Partial<Phase7ResourceSample> = {}
): Phase7ResourceSample {
  const baseline = 100 * MIB + seed
  return {
    scenario,
    baselineRssBytes: baseline,
    retainedRssBytes: baseline + 4 * MIB + seed,
    peakRssBytes: baseline + 6 * MIB + seed,
    wallTimeMs: 10 + seed,
    userCpuMicros: 20 + seed,
    systemCpuMicros: 5 + seed,
    operations: scenario === 'idle' ? 0 : 3,
    artifactStoreRecords: scenario === 'artifactRedis' ? 1 : 0,
    artifactStoreBytes: scenario === 'artifactRedis' ? 4_096 : 0,
    outcome: PHASE_7_RESOURCE_OUTCOMES[scenario],
    ...overrides
  }
}

function reportInput () {
  let processId = 20_000
  return Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Array.from({ length: PHASE_7_RESOURCE_SAMPLES }, (_, index) => ({
      processId: processId++,
      sample: sample(scenario, [5, 1, 4, 2, 3][index] as number)
    }))
  ])) as Record<Phase7ResourceScenarioName, Array<{
    processId: number
    sample: Phase7ResourceSample
  }>>
}

test('Phase 7 resource contract freezes six exact scenarios and outcomes', () => {
  assert.deepEqual(PHASE_7_RESOURCE_SCENARIOS, [
    'idle',
    'dual',
    'cacheUsage',
    'plannerCompaction',
    'artifactRedis',
    'crashRecovery'
  ])
  assert.deepEqual(PHASE_7_RESOURCE_OUTCOMES, {
    idle: 'idle',
    dual: 'completed',
    cacheUsage: 'cache_usage_decoded',
    plannerCompaction: 'artifact_compacted',
    artifactRedis: 'artifact_round_trip',
    crashRecovery: 'recovered'
  })
})

test('Phase 7 sample parser is exact and fails closed above artifact namespace limits', () => {
  const valid = sample('artifactRedis', 1)
  assert.equal(validatePhase7ResourceSample(valid, 'artifactRedis'), valid)
  assert.throws(() => validatePhase7ResourceSample({ ...valid, extra: true }, 'artifactRedis'))
  assert.throws(() => validatePhase7ResourceSample({ ...valid, outcome: 'completed' }, 'artifactRedis'))
  assert.throws(() => validatePhase7ResourceSample({
    ...valid,
    artifactStoreRecords: 129
  }, 'artifactRedis'), /hard limit/i)
  assert.throws(() => validatePhase7ResourceSample({
    ...valid,
    artifactStoreBytes: 2 * MIB + 1
  }, 'artifactRedis'), /hard limit/i)
})

test('Phase 7 report requires 30 fresh processes and computes five-sample medians', () => {
  const input = reportInput()
  const report = buildPhase7ResourceReport(input)

  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.totalProcessCount, 30)
  assert.equal(new Set(report.processIds).size, 30)
  assert.equal(report.scenarios.idle.rss.peak.delta.median, 6 * MIB + 3)
  assert.equal(report.scenarios.idle.rss.peak.delta.minimum, 6 * MIB + 1)
  assert.equal(report.scenarios.idle.rss.peak.delta.maximum, 6 * MIB + 5)
  assert.equal(report.scenarios.idle.rss.peak.delta.mad, 1)
  assert.equal(report.passed, true)

  const duplicate = reportInput()
  duplicate.dual[0] = {
    ...duplicate.dual[0],
    processId: duplicate.idle[0]?.processId as number
  }
  assert.throws(() => buildPhase7ResourceReport(duplicate), /fresh processes/i)
  assert.throws(() => buildPhase7ResourceReport({
    ...input,
    idle: input.idle.slice(0, 4)
  }), /five/i)
})

test('Phase 7 report locks memory stops and every RunStore and artifact hard limit', () => {
  const report = buildPhase7ResourceReport(reportInput())

  assert.deepEqual(PHASE_7_RESOURCE_THRESHOLDS, {
    idleRetainedDeltaBytes: 20 * MIB,
    dualPeakDeltaBytes: 50 * MIB,
    cacheUsagePeakDeltaBytes: 40 * MIB,
    plannerCompactionPeakDeltaBytes: 45 * MIB,
    artifactRedisPeakDeltaBytes: 45 * MIB,
    crashRecoveryPeakDeltaBytes: 45 * MIB,
    catastrophicMaximumMultiplier: 2
  })
  assert.equal(PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS.requestBytes, 512 * 1_024)
  assert.equal(PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS.checkpointBytes, 256 * 1_024)
  assert.equal(PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS.namespaceBytes, 8 * MIB)
  assert.deepEqual(PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS, {
    activeRuns: 2,
    queuedRuns: 3
  })
  assert.equal(PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes, 16 * 1_024)
  assert.equal(PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS.contentBytes, 8 * 1_024)
  assert.equal(PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS.sourceRefs, 32)
  assert.equal(PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys, 128)
  assert.equal(PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes, 2 * MIB)
  assert.equal(report.limitContracts.plannerInputBytes, 512 * 1_024)
  assert.equal(report.gates.admissionLimits, true)
  assert.equal(report.gates.runStoreLimits, true)
  assert.equal(report.gates.contextArtifactLimits, true)
  assert.equal(report.gates.plannerInputLimit, true)
  assert.equal(report.gates.artifactNamespaceUsage, true)

  const tooLarge = reportInput()
  tooLarge.cacheUsage = tooLarge.cacheUsage.map((entry, index) => ({
    ...entry,
    sample: sample('cacheUsage', index, {
      baselineRssBytes: 100 * MIB,
      retainedRssBytes: 110 * MIB,
      peakRssBytes: 141 * MIB
    })
  }))
  const failed = buildPhase7ResourceReport(tooLarge)
  assert.equal(failed.gates.cacheUsagePeak, false)
  assert.equal(failed.passed, false)

  const catastrophic = reportInput()
  catastrophic.cacheUsage[0] = {
    ...catastrophic.cacheUsage[0],
    sample: sample('cacheUsage', 0, {
      baselineRssBytes: 100 * MIB,
      retainedRssBytes: 110 * MIB,
      peakRssBytes: 181 * MIB
    })
  }
  const catastrophicFailure = buildPhase7ResourceReport(catastrophic)
  assert.equal(catastrophicFailure.scenarios.cacheUsage.rss.peak.delta.median < 40 * MIB, true)
  assert.equal(catastrophicFailure.gates.cacheUsagePeak, false)
  assert.equal(catastrophicFailure.passed, false)
})

test('Phase 7 focused workloads exercise cache, compaction, artifact Redis and crash recovery', async () => {
  for (const scenario of [
    'cacheUsage',
    'plannerCompaction',
    'artifactRedis',
    'crashRecovery'
  ] as const) {
    const current = await runPhase7ResourceScenario(scenario, { settleMs: 0 })
    assert.equal(validatePhase7ResourceSample(current, scenario), current)
    assert.equal(current.operations > 0, true)
    assert.equal(current.outcome, PHASE_7_RESOURCE_OUTCOMES[scenario])
  }
})

test('Phase 7 harness composes Phase 6 production idle, dual and checkpoint recovery graphs', async () => {
  const source = await readFile(path.join(
    root,
    'src/verification/phase-7-resource-scenario.ts'
  ), 'utf8')
  assert.match(source, /runPhase6ResourceScenario/)
  assert.match(source, /checkpointResume/)
  assert.match(source, /RedisContextArtifactStore/)
  assert.match(source, /deepSeekCompatibilityProfile\.decodeUsageExtensions/)
  assert.match(source, /compactConsumedToolSpan/)
  assert.doesNotMatch(source, /createProductionYunzaiAgent|class Phase6ResourceRedis|function crashRecoveryWorkload/)
})

test('Phase 7 resource scripts are static one-import one-main shells', async () => {
  const scripts = [
    ['phase-7-resource-scenario.mjs', 'phase-7-resource-scenario.js'],
    ['measure-phase-7-resources.mjs', 'phase-7-resource-report.js']
  ] as const
  for (const [script, target] of scripts) {
    const source = await readFile(path.join(root, 'scripts', script), 'utf8')
    assert.match(source, new RegExp(`^import \\{ main \\} from '../dist/verification/${target.replace('.', '\\.')}';?\\nawait main\\(\\);?\\n?$`))
    assert.doesNotMatch(source.split('\n').slice(1).join('\n'), /process\.|if\s*\(|spawn|redis|GROUPMATE/i)
  }
})
