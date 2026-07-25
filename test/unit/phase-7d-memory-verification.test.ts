import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PHASE_7D_MEMORY_RESOURCE_OUTCOMES,
  PHASE_7D_MEMORY_RESOURCE_SCENARIOS,
  PHASE_7D_MEMORY_RESOURCE_SENSITIVE_SENTINELS,
  type Phase7dMemoryResourceSample,
  type Phase7dMemoryResourceScenarioName
} from '../../src/verification/phase-7d-memory-scenario.js'
import {
  PHASE_7D_MEMORY_RESOURCE_SAMPLES,
  PHASE_7D_MEMORY_RSS_LIMIT_BYTES,
  auditPhase7dContextSurfaces,
  buildPhase7dMemoryResourceReport,
  parsePhase7dMemoryChildObservation,
  verifyPhase7dMemory
} from '../../src/verification/phase-7d-memory-report.js'
import type { Phase7SecurityAuditResult } from '../../src/verification/phase-7-security-audit.js'
import type { Phase7bMemoryWiringAudit } from '../../src/verification/phase-7b-memory-report.js'

const MIB = 1_024 * 1_024

function sample (
  scenario: Phase7dMemoryResourceScenarioName,
  seed: number,
  overrides: Partial<Phase7dMemoryResourceSample> = {}
): Phase7dMemoryResourceSample {
  const baseline = 100 * MIB + seed
  return {
    scenario,
    baselineRssBytes: baseline,
    retainedRssBytes: baseline + 4 * MIB + seed,
    peakRssBytes: baseline + 8 * MIB + seed,
    wallTimeMs: 20 + seed,
    maximumOperationLatencyMicros: 2_000 + seed,
    canonicalFileBytes: 128 * 1_024,
    lexicalFileBytes: 128 * 1_024,
    extractionFileBytes: 128 * 1_024,
    lexicalRecords: scenario === 'retrievalCorpus' ? 8 : 0,
    queueRecords: scenario === 'candidateShadow' ? 1 : 0,
    semanticEgressCalls: 0,
    expectedRelevant: scenario === 'retrievalCorpus' ? 5 : 0,
    observedRelevant: scenario === 'retrievalCorpus' ? 5 : 0,
    leakageCount: 0,
    candidateExpectedAdmitted: scenario === 'candidateShadow' ? 3 : 0,
    candidateObservedAdmitted: scenario === 'candidateShadow' ? 3 : 0,
    credentialRejected: scenario === 'candidateShadow' ? 3 : 0,
    lowValueRejected: scenario === 'candidateShadow' ? 1 : 0,
    deletionResidualCanonical: 0,
    deletionResidualFts: 0,
    deletionResidualCache: 0,
    deletionResidualQueue: 0,
    deletionResidualContext: 0,
    sqliteClosed: true,
    directoryRemoved: true,
    timerResourceDelta: 0,
    outcome: PHASE_7D_MEMORY_RESOURCE_OUTCOMES[scenario],
    ...overrides
  }
}

function sampleInput () {
  let processId = 70_000
  return Object.fromEntries(PHASE_7D_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
    scenario,
    Array.from({ length: PHASE_7D_MEMORY_RESOURCE_SAMPLES }, (_, index) => ({
      processId: processId++,
      sample: sample(scenario, index + 1)
    }))
  ]))
}

function passingProductionAudit (): Phase7bMemoryWiringAudit {
  return {
    schemaVersion: 1,
    productionMemoryDefaultOff: true,
    productionDependenciesClosed: true,
    memoryRecallSeamExact: true,
    runtimeMemoryImports: 1,
    runtimeMemoryQueries: 0,
    runtimeMemoryProposals: 0,
    runtimeContextSourceImports: 0,
    reachableGraphComplete: true,
    reachableMemoryModules: 0,
    reachableContextSourceModules: 0,
    forbiddenMemoryToolFactories: 0,
    forbiddenMemoryToolNames: 0,
    productionToolNamesExact: true,
    guobaMemoryControlFieldsExact: true,
    configMemoryDefaultsOff: true,
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

test('Phase 7D resource report requires fifteen unique fresh processes', () => {
  assert.deepEqual(PHASE_7D_MEMORY_RESOURCE_SCENARIOS, [
    'retrievalCorpus', 'candidateShadow', 'deletionCleanup'
  ])
  const report = buildPhase7dMemoryResourceReport(sampleInput())
  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.totalProcessCount, 15)
  assert.equal(new Set(report.processIds).size, 15)
  assert.equal(report.gates.everySampleRss, true)
  assert.equal(report.gates.semanticEgressZero, true)
  assert.equal(report.gates.deletionNoResurrection, true)
  assert.equal(report.passed, true)

  const duplicate = sampleInput()
  duplicate.candidateShadow[0]!.processId = duplicate.retrievalCorpus[0]!.processId
  assert.throws(() => buildPhase7dMemoryResourceReport(duplicate), /fresh|unique/i)
  const incomplete = sampleInput()
  incomplete.deletionCleanup.pop()
  assert.throws(() => buildPhase7dMemoryResourceReport(incomplete), /five/i)
})

test('Phase 7D resource gates fail closed on leakage, egress, resurrection and excess RSS', () => {
  const cases: Array<Partial<Phase7dMemoryResourceSample>> = [
    { leakageCount: 1 },
    { semanticEgressCalls: 1 },
    { deletionResidualCanonical: 1 },
    { deletionResidualFts: 1 },
    { deletionResidualCache: 1 },
    { deletionResidualQueue: 1 },
    { deletionResidualContext: 1 },
    { sqliteClosed: false },
    { directoryRemoved: false },
    { timerResourceDelta: 1 }
  ]
  for (const overrides of cases) {
    const input = sampleInput()
    input.deletionCleanup[0]!.sample = sample('deletionCleanup', 1, overrides)
    assert.equal(buildPhase7dMemoryResourceReport(input).passed, false)
  }
  const rss = sampleInput()
  rss.retrievalCorpus[0]!.sample = sample('retrievalCorpus', 1, {
    peakRssBytes: 100 * MIB + 1 + PHASE_7D_MEMORY_RSS_LIMIT_BYTES + 1
  })
  assert.equal(buildPhase7dMemoryResourceReport(rss).passed, false)
})

test('Phase 7D child parser is body-free and maps malformed output to one error', () => {
  const current = sample('retrievalCorpus', 1)
  assert.deepEqual(parsePhase7dMemoryChildObservation({
    failed: false,
    status: 0,
    processId: 71_001,
    stdout: JSON.stringify(current)
  }, 'retrievalCorpus'), { processId: 71_001, sample: current })
  for (const value of [
    {
      failed: false,
      status: 0,
      processId: 71_001,
      stdout: `${JSON.stringify(current)}${PHASE_7D_MEMORY_RESOURCE_SENSITIVE_SENTINELS[0]}`
    },
    { failed: true, status: null, processId: null, stdout: '' },
    { failed: false, status: 1, processId: 71_001, stdout: JSON.stringify(current) }
  ]) {
    assert.throws(
      () => parsePhase7dMemoryChildObservation(value, 'retrievalCorpus'),
      error => error instanceof TypeError &&
        error.message === 'Phase 7D memory resource child failed'
    )
  }
})

test('Phase 7D source audit locks cache order, mandatory context and regression inventory', async () => {
  assert.deepEqual(await auditPhase7dContextSurfaces(process.cwd()), {
    cacheFriendlyOrder: true,
    mandatoryContextProtected: true,
    memoryUntrusted: true,
    presentationRegressionTestsPresent: true,
    passed: true
  })
})

test('Phase 7D verification combines resource, production, context and security gates', async () => {
  const report = await verifyPhase7dMemory(process.cwd(), {
    samples: sampleInput(),
    productionAudit: async () => passingProductionAudit(),
    securityAudit: async () => passingSecurityAudit(),
    contextAudit: async () => ({
      cacheFriendlyOrder: true,
      mandatoryContextProtected: true,
      memoryUntrusted: true,
      presentationRegressionTestsPresent: true,
      passed: true
    })
  })
  assert.equal(report.resources.passed, true)
  assert.equal(report.production.passed, true)
  assert.equal(report.context.passed, true)
  assert.equal(report.security.findingCount, 0)
  assert.equal(report.passed, true)

  const failed = await verifyPhase7dMemory(process.cwd(), {
    samples: sampleInput(),
    productionAudit: async () => passingProductionAudit(),
    securityAudit: async () => passingSecurityAudit(),
    contextAudit: async () => ({
      cacheFriendlyOrder: false,
      mandatoryContextProtected: true,
      memoryUntrusted: true,
      presentationRegressionTestsPresent: true,
      passed: false
    })
  })
  assert.equal(failed.passed, false)
})
