import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  PHASE_6_REDIS_RESOURCE_KINDS,
  PHASE_6_RESOURCE_OUTCOMES,
  PHASE_6_RESOURCE_SCENARIOS,
  normalizeMaxRssBytes,
  runPhase6ResourceScenario,
  validatePhase6ResourceSample,
  type Phase6ResourceSample,
  type Phase6ResourceScenarioName
} from '../../src/verification/phase-6-resource-scenario.js'
import {
  PHASE_5_BASELINE_COMMIT,
  PHASE_5_DUAL_PEAK_DELTA_BYTES,
  PHASE_5_IDLE_RETAINED_DELTA_BYTES,
  PHASE_6_RESOURCE_SAMPLES,
  buildPhase6ResourceReport
} from '../../src/verification/phase-6-resource-report.js'
import {
  runPhase6RedisSmoke
} from '../../src/verification/phase-6-redis-smoke.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const root = process.cwd()

function resources (traceBytes = 1_024) {
  return PHASE_6_REDIS_RESOURCE_KINDS.map(kind => Object.freeze({
    kind,
    records: kind === 'trace_metadata' ? 2 : 1,
    bytes: kind.startsWith('trace_') ? traceBytes : 512
  }))
}

function sample (
  scenario: Phase6ResourceScenarioName,
  seed: number,
  overrides: Partial<Phase6ResourceSample> = {}
): Phase6ResourceSample {
  const baseline = 100 * 1024 * 1024 + seed
  return {
    scenario,
    baselineRssBytes: baseline,
    retainedRssBytes: baseline + 4 * 1024 * 1024 + seed,
    peakRssBytes: baseline + 6 * 1024 * 1024 + seed,
    wallTimeMs: 10 + seed,
    userCpuMicros: 20 + seed,
    systemCpuMicros: 5 + seed,
    redisResources: resources(),
    outcome: PHASE_6_RESOURCE_OUTCOMES[scenario],
    activePages: 0,
    borrowedBrowserHandles: 0,
    newChromiumProcesses: 0,
    ...overrides
  }
}

function reportInput () {
  let pid = 10_000
  return Object.fromEntries(PHASE_6_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Array.from({ length: PHASE_6_RESOURCE_SAMPLES }, (_, index) => ({
      processId: pid++,
      sample: sample(scenario, [5, 1, 4, 2, 3][index] as number)
    }))
  ]))
}

test('Phase 6 resource contracts freeze nine scenarios, ten Redis kinds and fixed outcomes', () => {
  assert.deepEqual(PHASE_6_RESOURCE_SCENARIOS, [
    'idle',
    'singleTextRun',
    'dualTextRun',
    'alreadyVisible',
    'checkpointResume',
    'traceBasic',
    'traceDiagnostic',
    'pictureSuccess',
    'pictureFailure'
  ])
  assert.deepEqual(PHASE_6_REDIS_RESOURCE_KINDS, [
    'run_checkpoint',
    'run_event',
    'run_tombstone',
    'run_reference',
    'run_index',
    'run_metadata',
    'trace_record',
    'trace_success_index',
    'trace_failure_index',
    'trace_metadata'
  ])
  assert.deepEqual(PHASE_6_RESOURCE_OUTCOMES, {
    idle: 'idle',
    singleTextRun: 'completed',
    dualTextRun: 'completed',
    alreadyVisible: 'visible_output',
    checkpointResume: 'resumed',
    traceBasic: 'trace_retained',
    traceDiagnostic: 'trace_retained',
    pictureSuccess: 'picture_success',
    pictureFailure: 'picture_failure'
  })
})

test('sample parser is exact, preserves unknown sentinels and normalizes maxRSS bytes', () => {
  const valid = sample('idle', 1, {
    redisResources: resources().map((item, index) => index === 0
      ? { ...item, records: 'unavailable', bytes: 'unavailable' }
      : item)
  })
  const parsed = validatePhase6ResourceSample(valid, 'idle')
  assert.equal(parsed.redisResources[0]?.records, 'unavailable')
  assert.equal(parsed.redisResources[0]?.bytes, 'unavailable')
  assert.equal(normalizeMaxRssBytes(150_000_000, 100_000_000), 150_000_000)
  assert.equal(normalizeMaxRssBytes(150_000, 100_000_000), 153_600_000)

  assert.throws(() => validatePhase6ResourceSample({ ...valid, extra: true }, 'idle'))
  assert.throws(() => validatePhase6ResourceSample({ ...valid, outcome: 'completed' }, 'idle'))
  assert.throws(() => validatePhase6ResourceSample({
    ...valid,
    redisResources: valid.redisResources.slice(1)
  }, 'idle'))
})

test('report requires exactly 45 unique fresh processes and computes median min max MAD', () => {
  const input = reportInput()
  const report = buildPhase6ResourceReport(input)

  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.totalProcessCount, 45)
  assert.equal(new Set(report.processIds).size, 45)
  assert.equal(report.scenarios.idle.rss.peak.delta.median, 6 * 1024 * 1024 + 3)
  assert.equal(report.scenarios.idle.rss.peak.delta.minimum, 6 * 1024 * 1024 + 1)
  assert.equal(report.scenarios.idle.rss.peak.delta.maximum, 6 * 1024 * 1024 + 5)
  assert.equal(report.scenarios.idle.rss.peak.delta.mad, 1)
  assert.equal(report.passed, true)

  const duplicate = reportInput()
  duplicate.dualTextRun[0] = {
    ...duplicate.dualTextRun[0],
    processId: duplicate.idle[0]?.processId as number
  }
  assert.throws(() => buildPhase6ResourceReport(duplicate), /process/i)
  assert.throws(() => buildPhase6ResourceReport({
    ...input,
    idle: input.idle.slice(0, 4)
  }), /five/i)
})

test('report keeps Phase 5 evidence separate and enforces every resource threshold', () => {
  const report = buildPhase6ResourceReport(reportInput())

  assert.equal(PHASE_5_BASELINE_COMMIT, '2b59cad1d944b6835dda541c04616b3673077802')
  assert.equal(PHASE_5_IDLE_RETAINED_DELTA_BYTES, 6_930_432)
  assert.equal(PHASE_5_DUAL_PEAK_DELTA_BYTES, 22_675_456)
  assert.deepEqual(report.phase5Evidence, {
    commit: PHASE_5_BASELINE_COMMIT,
    idleRetainedDeltaBytes: 6_930_432,
    dualPeakDeltaBytes: 22_675_456
  })
  assert.equal(
    report.comparisonToPhase5.idleRetainedDeltaBytes,
    report.scenarios.idle.rss.retained.delta.median - 6_930_432
  )
  assert.equal(
    report.comparisonToPhase5.dualPeakDeltaBytes,
    report.scenarios.dualTextRun.rss.peak.delta.median - 22_675_456
  )
  assert.equal(report.thresholds.runStoreBytes, 8 * 1024 * 1024)
  assert.equal(report.thresholds.traceStoreBytes, 16 * 1024 * 1024)
  assert.equal(report.thresholds.combinedStoreBytes, 24 * 1024 * 1024)

  const tooLarge = reportInput()
  tooLarge.traceDiagnostic = tooLarge.traceDiagnostic.map((entry, index) => ({
    ...entry,
    sample: sample('traceDiagnostic', index, {
      peakRssBytes: 200 * 1024 * 1024,
      baselineRssBytes: 100 * 1024 * 1024
    })
  }))
  const failed = buildPhase6ResourceReport(tooLarge)
  assert.equal(failed.gates.traceDiagnosticPeak, false)
  assert.equal(failed.passed, false)
})

test('idle scenario constructs the production graph and emits every bounded resource kind', async () => {
  const current = await runPhase6ResourceScenario('idle', { settleMs: 0 })

  assert.equal(validatePhase6ResourceSample(current, 'idle'), current)
  assert.equal(current.redisResources.length, 10)
  assert.deepEqual(current.redisResources.map(item => item.kind), PHASE_6_REDIS_RESOURCE_KINDS)
  assert.equal(current.outcome, 'idle')
  assert.ok(current.baselineRssBytes > 0)
  assert.ok(current.peakRssBytes >= current.baselineRssBytes)
})

test('already-visible resource scenario follows the production outbound factory', async () => {
  const current = await runPhase6ResourceScenario('alreadyVisible', { settleMs: 0 })

  assert.equal(validatePhase6ResourceSample(current, 'alreadyVisible'), current)
  assert.equal(current.outcome, 'visible_output')
  assert.equal(current.activePages, 0)
  assert.equal(current.borrowedBrowserHandles, 0)
})

test('resource harness source owns the complete production path and no completion facade shortcut', async () => {
  const scenario = await readFile(path.join(
    root,
    'src/verification/phase-6-resource-scenario.ts'
  ), 'utf8')
  const report = await readFile(path.join(
    root,
    'src/verification/phase-6-resource-report.ts'
  ), 'utf8')

  for (const marker of [
    'createProductionYunzaiAgent',
    'chatController.chatgpt1',
    'RUN_STORE_LUA_MARKER',
    'TRACE_STORE_LUA_MARKER',
    'diagnosticsController.handleStatus',
    'diagnosticsController.handleInspect'
  ]) assert.match(scenario, new RegExp(marker.replace('.', '\\.')))
  assert.doesNotMatch(scenario, /createOpenAICompatibleCompletionFacade|phase-5-memory/)
  assert.match(report, /spawnSync\(/)
  assert.match(report, /PHASE_6_RESOURCE_SAMPLES/)
})

test('three resource scripts are static one-import one-main shells with matching dist paths', async () => {
  const scripts = [
    ['phase-6-resource-scenario.mjs', 'phase-6-resource-scenario.js'],
    ['measure-phase-6-resources.mjs', 'phase-6-resource-report.js'],
    ['smoke-phase-6-redis.mjs', 'phase-6-redis-smoke.js']
  ] as const
  for (const [script, target] of scripts) {
    const source = await readFile(path.join(root, 'scripts', script), 'utf8')
    assert.match(source, new RegExp(`^import \\{ main \\} from '../dist/verification/${target.replace('.', '\\.')}';?\\nawait main\\(\\);?\\n?$`))
    assert.doesNotMatch(source.split('\n').slice(1).join('\n'), /process\.|if\s*\(|spawn|redis|GROUPMATE/i)
  }
})

test('package exposes exact Phase 6 resource and optional Redis commands', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(
    packageJson.scripts['test:resources:phase6'],
    'pnpm run build && node scripts/measure-phase-6-resources.mjs'
  )
  assert.equal(
    packageJson.scripts['test:redis:phase6'],
    'pnpm run build && node scripts/smoke-phase-6-redis.mjs'
  )
})

test('Redis smoke is fixed skipped without a URL and exercises two records when injected', async () => {
  let factories = 0
  const skipped = await runPhase6RedisSmoke({
    redisUrl: undefined,
    clientFactory: async () => {
      factories += 1
      throw new Error('must not connect')
    }
  })
  assert.deepEqual(skipped, {
    schemaVersion: 1,
    kind: 'skipped',
    reason: 'redis_url_not_configured'
  })
  assert.equal(factories, 0)

  const redis = new FakeRedis(() => Date.parse('2026-07-17T00:00:00.000Z'))
  const passed = await runPhase6RedisSmoke({
    redisUrl: 'redis://fixture.invalid/0',
    now: () => Date.parse('2026-07-17T00:00:00.000Z'),
    clientFactory: async () => ({ client: redis, close: async () => undefined })
  })
  assert.equal(passed.kind, 'passed')
  if (passed.kind === 'passed') {
    assert.equal(passed.records, 2)
    assert.ok(passed.bytes > 0)
    assert.equal(passed.idempotent, true)
    assert.equal(passed.ttlBounded, true)
  }
  assert.equal(JSON.stringify(passed).includes('fixture.invalid'), false)
})
