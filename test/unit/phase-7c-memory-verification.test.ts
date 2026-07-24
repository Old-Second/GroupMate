import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS
} from '../../src/agent/memory/memory-resource-limits.js'
import {
  MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1
} from '../../src/agent/memory/memory-export-port.js'
import {
  MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1,
  MEMORY_EXPORT_LEASE_TTL_MS_V1
} from '../../src/agent/memory/sqlite-memory-export.js'
import {
  PHASE_7C_MEMORY_RESOURCE_OUTCOMES,
  PHASE_7C_MEMORY_RESOURCE_SCENARIOS,
  PHASE_7C_MEMORY_SENSITIVE_SENTINELS,
  PHASE_7C_MEMORY_EXPECTED_RESIDUAL_CARRIERS,
  runPhase7cMemoryResourceScenario,
  validatePhase7cMemoryResourceSample,
  type Phase7cMemoryResourceSample,
  type Phase7cMemoryResourceScenarioName
} from '../../src/verification/phase-7c-memory-scenario.js'
import {
  PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS,
  PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  PHASE_7C_MEMORY_RESOURCE_SAMPLES,
  PHASE_7C_MEMORY_RSS_LIMIT_BYTES,
  auditPhase7cLifecycleSurfaces,
  buildPhase7cMemoryResourceReport,
  parsePhase7cMemoryChildObservation,
  phase7cDeletionReceiptSurfaceIsBodyFree,
  phase7cLifecycleAuditSurfaceIsBodyFree,
  phase7cLifecycleCommandLedgerIsBodyFree,
  phase7cLifecycleCommandWireIsHashOnly,
  verifyPhase7cMemory,
  type Phase7cLifecycleSurfaceAudit
} from '../../src/verification/phase-7c-memory-report.js'
import type { Phase7SecurityAuditResult } from '../../src/verification/phase-7-security-audit.js'
import type { Phase7bMemoryWiringAudit } from '../../src/verification/phase-7b-memory-report.js'

const PROJECT_ROOT = process.cwd()
const MIB = 1_024 * 1_024

function sample (
  scenario: Phase7cMemoryResourceScenarioName,
  seed: number,
  overrides: Partial<Phase7cMemoryResourceSample> = {}
): Phase7cMemoryResourceSample {
  const baseline = 100 * MIB + seed
  const artifactBytes = scenario === 'streamingExport' ? 1_024 + seed : 0
  return {
    scenario,
    baselineRssBytes: baseline,
    retainedRssBytes: baseline + 4 * MIB + seed,
    peakRssBytes: baseline + 6 * MIB + seed,
    wallTimeMs: 10 + seed,
    userCpuMicros: 20 + seed,
    systemCpuMicros: 5 + seed,
    sqliteMainFileBytes: 128 * 1_024,
    sqliteWalFileBytes: 64 * 1_024,
    sqliteShmFileBytes: 32 * 1_024,
    peakCanonicalLogicalBytes: 8 * 1_024,
    peakOutboxRecords: 4,
    peakOutboxLogicalBytes: 2 * 1_024,
    peakLifecycleAuditRecords: 2,
    peakLifecycleCommandRecords: 4,
    peakDeletionCheckpointRecords: scenario === 'deletionCleanup' ? 1 : 0,
    peakExportJobRecords: scenario === 'streamingExport' ? 1 : 0,
    peakLifecycleLogicalBytes: 8 * 1_024,
    generatedArtifactBytes: artifactBytes,
    deliveredArtifactBytes: artifactBytes,
    derivedLeakCount: 0,
    residualCarrierRecords: PHASE_7C_MEMORY_EXPECTED_RESIDUAL_CARRIERS[scenario],
    residualArtifactFiles: 0,
    redisEvalCalls: 0,
    sqliteClosed: true,
    directoryRemoved: true,
    timerResourceDelta: 0,
    outcome: PHASE_7C_MEMORY_RESOURCE_OUTCOMES[scenario],
    ...overrides
  }
}

function reportInput () {
  let processId = 50_000
  return Object.fromEntries(PHASE_7C_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Array.from({ length: PHASE_7C_MEMORY_RESOURCE_SAMPLES }, (_, index) => ({
      processId: processId++,
      sample: sample(scenario, [5, 1, 4, 2, 3][index] as number)
    }))
  ])) as Record<Phase7cMemoryResourceScenarioName, Array<{
    processId: number
    sample: Phase7cMemoryResourceSample
  }>>
}

function passingProductionAudit (): Phase7bMemoryWiringAudit {
  return {
    schemaVersion: 1,
    productionNoopStore: true,
    productionDependenciesClosed: true,
    memoryStoreSeamExact: true,
    runtimeMemoryImports: 0,
    runtimeMemoryQueries: 0,
    runtimeMemoryProposals: 0,
    runtimeContextSourceImports: 0,
    reachableGraphComplete: true,
    reachableMemoryModules: 0,
    reachableContextSourceModules: 0,
    forbiddenMemoryToolFactories: 0,
    forbiddenMemoryToolNames: 0,
    productionToolNamesExact: true,
    guobaMemoryEnableFields: 0,
    configMemoryEnableFields: 0,
    memoryTelemetryEdges: 0,
    coldImport: { passed: true, timerCalls: 0, redisEvalCalls: 0, createdFiles: 0 },
    passed: true
  }
}

function passingSecurityAudit (): Phase7SecurityAuditResult {
  return {
    forbiddenFields: [],
    unsafeLoggerCalls: [],
    forbiddenTraceRedisCommands: [],
    dynamicMetricDefinitions: [],
    sourceDistMismatches: [],
    forbiddenProductionEdges: [],
    forbiddenRedactedBodyFields: [],
    forbiddenProviderIsolationLeaks: [],
    forbiddenContextArtifactLeaks: [],
    invalidContentJournalBoundaries: [],
    forbiddenPhase7Edges: [],
    passed: true
  }
}

function passingLifecycleAudit (): Phase7cLifecycleSurfaceAudit {
  return {
    lifecycleAuditBodyFree: true,
    deletionReceiptBodyFree: true,
    lifecycleCommandWireHashOnly: true,
    lifecycleCommandLedgerBodyFree: true,
    outboxBodyFree: true,
    passed: true
  }
}

test('Phase 7C verification freezes lifecycle and export resource contracts', () => {
  assert.deepEqual(
    PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS
  )
  assert.deepEqual(PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS, {
    maximumWireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
    maximumChunkBytes: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
    artifactCapacityBytes: MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1,
    leaseTtlMs: MEMORY_EXPORT_LEASE_TTL_MS_V1
  })
  assert.deepEqual(PHASE_7C_MEMORY_RESOURCE_SCENARIOS, [
    'lifecycleMutation',
    'streamingExport',
    'deletionCleanup'
  ])
})

test('Phase 7C resource report requires fifteen unique fresh processes', () => {
  const input = reportInput()
  const report = buildPhase7cMemoryResourceReport(input)
  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.totalProcessCount, 15)
  assert.equal(new Set(report.processIds).size, 15)
  assert.equal(report.scenarios.lifecycleMutation.rss.peakDelta.median, 6 * MIB + 3)
  assert.equal(report.scenarios.lifecycleMutation.rss.peakDelta.mad, 1)
  assert.equal(report.passed, true)

  const duplicate = reportInput()
  duplicate.streamingExport[0]!.processId = duplicate.lifecycleMutation[0]!.processId
  assert.throws(() => buildPhase7cMemoryResourceReport(duplicate), /fresh|unique/i)
  const incomplete = reportInput()
  incomplete.deletionCleanup.pop()
  assert.throws(() => buildPhase7cMemoryResourceReport(incomplete), /five/i)
})

test('Phase 7C resource samples fail closed on leaks, residue and excess RSS', () => {
  const valid = sample('streamingExport', 1)
  assert.equal(validatePhase7cMemoryResourceSample(valid, 'streamingExport'), valid)
  for (const overrides of [
    { derivedLeakCount: 1 },
    { residualArtifactFiles: 1 },
    { redisEvalCalls: 1 },
    { timerResourceDelta: 1 },
    { sqliteClosed: false },
    { directoryRemoved: false },
    { deliveredArtifactBytes: valid.deliveredArtifactBytes + 1 }
  ] satisfies Array<Partial<Phase7cMemoryResourceSample>>) {
    assert.throws(() => validatePhase7cMemoryResourceSample({ ...valid, ...overrides }))
  }
  assert.throws(() => validatePhase7cMemoryResourceSample(sample(
    'deletionCleanup',
    1,
    { residualCarrierRecords: 1 }
  )))

  const overRss = reportInput()
  overRss.lifecycleMutation[0]!.sample = sample('lifecycleMutation', 0, {
    baselineRssBytes: 100 * MIB,
    retainedRssBytes: 100 * MIB + 4 * MIB,
    peakRssBytes: 100 * MIB + PHASE_7C_MEMORY_RSS_LIMIT_BYTES + 1
  })
  const report = buildPhase7cMemoryResourceReport(overRss)
  assert.equal(report.gates.everySampleRss, false)
  assert.equal(report.passed, false)
})

test('Phase 7C child observation is body-free and maps failures to one error', () => {
  const current = sample('lifecycleMutation', 1)
  assert.deepEqual(parsePhase7cMemoryChildObservation({
    failed: false,
    status: 0,
    processId: 51_001,
    stdout: JSON.stringify(current)
  }, 'lifecycleMutation'), { processId: 51_001, sample: current })
  const safeFailure = (value: unknown): void => {
    assert.throws(() => parsePhase7cMemoryChildObservation(
      value,
      'lifecycleMutation'
    ), error => error instanceof TypeError &&
      error.message === 'Phase 7C memory resource child failed')
  }
  safeFailure({
    failed: false,
    status: 0,
    processId: 51_001,
    stdout: `${JSON.stringify(current)}${PHASE_7C_MEMORY_SENSITIVE_SENTINELS[0]}`
  })
  safeFailure({ failed: true, status: null, processId: null, stdout: '' })
  safeFailure({ failed: false, status: 1, processId: 51_001, stdout: JSON.stringify(current) })
})

test('Phase 7C lifecycle operational surfaces reject body-bearing drift', async () => {
  const [domain, command, migration] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/agent/memory/memory-lifecycle-domain.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/agent/memory/memory-lifecycle-command.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/agent/memory/sqlite-memory-migrations.ts'), 'utf8')
  ])
  assert.equal(phase7cLifecycleAuditSurfaceIsBodyFree(domain), true)
  assert.equal(phase7cDeletionReceiptSurfaceIsBodyFree(domain), true)
  assert.equal(phase7cLifecycleCommandWireIsHashOnly(command), true)
  assert.equal(phase7cLifecycleCommandLedgerIsBodyFree(migration), true)
  assert.equal(phase7cLifecycleAuditSurfaceIsBodyFree(domain.replace(
    '  readonly expiresAt: string\n}\n\nexport interface DeletionMutationReceiptV1',
    '  readonly body: MemoryRecordV2\n  readonly expiresAt: string\n}\n\nexport interface DeletionMutationReceiptV1'
  )), false)
  assert.equal(phase7cLifecycleAuditSurfaceIsBodyFree(domain.replace(
    '  readonly expiresAt: string\n}\n\nexport interface DeletionMutationReceiptV1',
    '  readonly expiresAt: MemoryRecordV2\n}\n\nexport interface DeletionMutationReceiptV1'
  )), false)
  assert.equal(phase7cDeletionReceiptSurfaceIsBodyFree(domain.replace(
    '  readonly receiptHash: string\n}\n\nexport interface DeletionStatusV1',
    '  readonly source: MemorySourceV1\n  readonly receiptHash: string\n}\n\nexport interface DeletionStatusV1'
  )), false)
  assert.equal(phase7cLifecycleCommandWireIsHashOnly(command.replace(
    '  readonly materialHash: string | null',
    '  readonly material: MemoryLifecycleCommandMaterialV1\n  readonly materialHash: string | null'
  )), false)
  assert.equal(phase7cLifecycleCommandLedgerIsBodyFree(migration.replace(
    '  result_wire TEXT NOT NULL',
    '  material_wire TEXT NOT NULL,\n  result_wire TEXT NOT NULL'
  )), false)
  assert.equal((await auditPhase7cLifecycleSurfaces(PROJECT_ROOT)).passed, true)
})

test('Phase 7C representative scenarios release SQLite and export artifacts', async () => {
  for (const scenario of PHASE_7C_MEMORY_RESOURCE_SCENARIOS) {
    const current = await runPhase7cMemoryResourceScenario({ scenario, settleMs: 0 })
    assert.equal(current.scenario, scenario)
    assert.equal(current.derivedLeakCount, 0)
    assert.equal(current.residualArtifactFiles, 0)
    assert.equal(current.redisEvalCalls, 0)
    assert.equal(current.sqliteClosed, true)
    assert.equal(current.directoryRemoved, true)
    assert.equal(current.timerResourceDelta, 0)
    if (scenario === 'streamingExport') {
      assert.equal(current.generatedArtifactBytes > 0, true)
      assert.equal(current.deliveredArtifactBytes, current.generatedArtifactBytes)
    }
    if (scenario === 'deletionCleanup') assert.equal(current.residualCarrierRecords, 0)
  }
})

test('Phase 7C verification composes resources, production-off and security gates', async () => {
  const options = {
    samples: reportInput(),
    productionAudit: async () => passingProductionAudit(),
    securityAudit: async () => passingSecurityAudit(),
    lifecycleAudit: async () => passingLifecycleAudit()
  }
  const report = await verifyPhase7cMemory(PROJECT_ROOT, options)
  assert.equal(report.passed, true)

  const failedProduction = await verifyPhase7cMemory(PROJECT_ROOT, {
    ...options,
    productionAudit: async () => ({ ...passingProductionAudit(), passed: false })
  })
  assert.equal(failedProduction.passed, false)
  const failedSecurity = await verifyPhase7cMemory(PROJECT_ROOT, {
    ...options,
    securityAudit: async () => ({
      ...passingSecurityAudit(),
      forbiddenPhase7Edges: ['fixture:memory_edge'],
      passed: false
    })
  })
  assert.equal(failedSecurity.security.phase7FindingCount, 1)
  assert.equal(failedSecurity.passed, false)
})

test('Phase 7C verification entry remains on temporary test output until Task 11', async () => {
  const script = await readFile(path.join(PROJECT_ROOT, 'scripts/verify-phase-7c.mjs'), 'utf8')
  assert.equal(script,
    "import { main } from '../.test-dist/src/verification/phase-7c-memory-report.js'\n" +
    'await main()\n')
  const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>
  }
  assert.equal(pkg.scripts?.['verify:phase7c'],
    'pnpm exec tsc -p tsconfig.test.json && node --test --test-concurrency=1 ' +
    '.test-dist/test/unit/*memory*.test.js && node scripts/verify-phase-7c.mjs')
  assert.equal(pkg.scripts?.['verify:phase7c']?.includes('pnpm run build'), false)
  const report = await readFile(path.join(
    PROJECT_ROOT,
    'src/verification/phase-7c-memory-report.ts'
  ), 'utf8')
  assert.match(report, /skipSourceDistCheck: true/)
})
