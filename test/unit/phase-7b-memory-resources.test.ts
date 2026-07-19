import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  PHASE_7B_MEMORY_RESOURCE_OUTCOMES,
  PHASE_7B_MEMORY_RESOURCE_SCENARIOS,
  buildPhase7bMemoryOutboxLeakSentinels,
  countPhase7bMemoryOutboxLeaks,
  normalizePhase7bMaxRssBytes,
  runPhase7bMemoryResourceScenario,
  validatePhase7bMemoryResourceSample,
  type Phase7bMemoryResourceSample
} from '../../src/verification/phase-7b-memory-scenario.js'
import {
  PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS,
  PHASE_7B_MEMORY_RESOURCE_SAMPLES,
  PHASE_7B_MEMORY_RSS_LIMIT_BYTES,
  buildPhase7bMemoryResourceReport,
  parsePhase7bMemoryChildObservation
} from '../../src/verification/phase-7b-memory-report.js'

const MIB = 1_024 * 1_024

function sample (
  seed: number,
  overrides: Partial<Phase7bMemoryResourceSample> = {}
): Phase7bMemoryResourceSample {
  const baseline = 100 * MIB + seed
  return {
    scenario: 'fixtureLifecycle',
    baselineRssBytes: baseline,
    retainedRssBytes: baseline + 4 * MIB + seed,
    peakRssBytes: baseline + 6 * MIB + seed,
    wallTimeMs: 10 + seed,
    userCpuMicros: 20 + seed,
    systemCpuMicros: 5 + seed,
    sqlitePageSizeBytes: 4 * 1_024,
    sqlitePageCacheBytes: 2 * MIB,
    sqliteMainFileBytes: 128 * 1_024,
    sqliteWalFileBytes: 64 * 1_024,
    sqliteShmFileBytes: 32 * 1_024,
    canonicalActiveRecords: 1,
    canonicalRevisionRecords: 1,
    canonicalLogicalBytes: 4 * 1_024,
    outboxRecords: 1,
    outboxLogicalBytes: 1_024,
    redisRecords: 1,
    redisGenerations: 1,
    redisRecordEntryBytes: 2_048,
    redisExpiryIndexBytes: 80,
    redisLruIndexBytes: 80,
    redisDynamicMetadataBytes: 320,
    redisStaticBytes: 357,
    redisLogicalBytes: 2_885,
    contentLeakCount: 0,
    identityLeakCount: 0,
    sqliteClosed: true,
    redisReleased: true,
    timerResourceDelta: 0,
    outcome: 'memory_data_layer_verified',
    ...overrides
  }
}

function reportInput () {
  return {
    fixtureLifecycle: Array.from(
      { length: PHASE_7B_MEMORY_RESOURCE_SAMPLES },
      (_, index) => ({
        processId: 40_000 + index,
        sample: sample([5, 1, 4, 2, 3][index] as number)
      })
    )
  }
}

test('Phase 7B memory resource contract freezes the fixture lifecycle outcome', () => {
  assert.deepEqual(PHASE_7B_MEMORY_RESOURCE_SCENARIOS, ['fixtureLifecycle'])
  assert.deepEqual(PHASE_7B_MEMORY_RESOURCE_OUTCOMES, {
    fixtureLifecycle: 'memory_data_layer_verified'
  })
})

test('Phase 7B sample parser is exact and fails closed on unsafe resource values', () => {
  const valid = sample(1)
  assert.equal(validatePhase7bMemoryResourceSample(valid, 'fixtureLifecycle'), valid)
  assert.throws(() => validatePhase7bMemoryResourceSample({ ...valid, extra: true }))
  assert.throws(() => validatePhase7bMemoryResourceSample({
    ...valid,
    outcome: 'completed'
  }))
  assert.throws(() => validatePhase7bMemoryResourceSample({
    ...valid,
    redisLogicalBytes: MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes + 1
  }), /limit/i)
  assert.throws(() => validatePhase7bMemoryResourceSample({
    ...valid,
    contentLeakCount: 1
  }), /leak/i)
  assert.throws(() => validatePhase7bMemoryResourceSample({
    ...valid,
    sqliteClosed: false
  }), /closed|release/i)
  assert.throws(() => validatePhase7bMemoryResourceSample({
    ...valid,
    timerResourceDelta: -1
  }))
})

test('Phase 7B max RSS normalizer locks macOS bytes and Linux KiB units', () => {
  assert.equal(normalizePhase7bMaxRssBytes(96 * MIB, 64 * MIB), 96 * MIB)
  assert.equal(normalizePhase7bMaxRssBytes(96 * 1_024, 64 * MIB), 96 * MIB)
  for (const values of [
    [0, 64 * MIB],
    [1.5, 64 * MIB],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
    [96 * MIB, 0]
  ] as const) assert.throws(() => normalizePhase7bMaxRssBytes(values[0], values[1]))
})

test('Phase 7B report requires five unique fresh processes and computes exact statistics', () => {
  const input = reportInput()
  const report = buildPhase7bMemoryResourceReport(input)
  assert.equal(report.samplesPerScenario, 5)
  assert.equal(report.totalProcessCount, 5)
  assert.equal(new Set(report.processIds).size, 5)
  assert.equal(report.scenarios.fixtureLifecycle.rss.peak.delta.median, 6 * MIB + 3)
  assert.equal(report.scenarios.fixtureLifecycle.rss.peak.delta.minimum, 6 * MIB + 1)
  assert.equal(report.scenarios.fixtureLifecycle.rss.peak.delta.maximum, 6 * MIB + 5)
  assert.equal(report.scenarios.fixtureLifecycle.rss.peak.delta.mad, 1)
  assert.equal(report.passed, true)

  const duplicate = reportInput()
  duplicate.fixtureLifecycle[1] = {
    ...duplicate.fixtureLifecycle[1]!,
    processId: duplicate.fixtureLifecycle[0]!.processId
  }
  assert.throws(() => buildPhase7bMemoryResourceReport(duplicate), /fresh|unique|process/i)
  assert.throws(() => buildPhase7bMemoryResourceReport({
    fixtureLifecycle: input.fixtureLifecycle.slice(0, 4)
  }), /five/i)
})

test('Phase 7B child observation parser returns only a safe process sample', () => {
  const current = sample(1)
  const parsed = parsePhase7bMemoryChildObservation({
    failed: false,
    status: 0,
    processId: 41_001,
    stdout: JSON.stringify(current)
  })
  assert.deepEqual(parsed, { processId: 41_001, sample: current })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.sample), true)
})

test('Phase 7B child observation parser maps every failure to one fixed safe error', () => {
  const safeFailure = (callback: () => unknown): void => {
    assert.throws(callback, error => (
      error instanceof TypeError && error.message === 'Phase 7B memory resource child failed'
    ))
  }
  const valid = JSON.stringify(sample(1))
  for (const value of [
    { failed: true, status: null, processId: null, stdout: '' },
    { failed: true, status: 0, processId: 41_001, stdout: valid },
    { failed: false, status: 1, processId: 41_001, stdout: valid },
    { failed: false, status: null, processId: 41_001, stdout: valid },
    { failed: false, status: 0, processId: null, stdout: valid },
    { failed: false, status: 0, processId: 0, stdout: valid },
    { failed: false, status: 0, processId: -1, stdout: valid },
    { failed: false, status: 0, processId: 41_001, stdout: 'not-json' },
    {
      failed: false,
      status: 0,
      processId: 41_001,
      stdout: valid,
      stderr: 'must-not-cross-the-observation-boundary'
    }
  ]) safeFailure(() => parsePhase7bMemoryChildObservation(value))
})

test('Phase 7B outbox leak sentinels cover dynamic secrets but permit opaque event routing', () => {
  const sentinels = buildPhase7bMemoryOutboxLeakSentinels({
    text: 'record-text',
    contentHash: 'record-content-hash',
    consent: { approvedByActorRef: 'actor-ref' },
    sources: [{
      normalizedText: 'source-text',
      sourceId: 'source-id',
      contentHash: 'source-content-hash',
      messageId: 'message-id',
      resourceRefs: ['resource-ref']
    }],
    namespaceRef: 'allowed-namespace-ref'
  }, {
    changedByActorRef: 'actor-ref',
    revisionHash: 'revision-hash',
    payloadHash: 'allowed-event-payload-hash'
  })
  assert.deepEqual(sentinels.content, [
    'record-text',
    'source-text',
    'source-id',
    'source-content-hash',
    'record-content-hash',
    'revision-hash'
  ])
  assert.deepEqual(sentinels.identity, ['actor-ref', 'message-id', 'resource-ref'])
  assert.equal(Object.isFrozen(sentinels), true)
  assert.equal(Object.isFrozen(sentinels.content), true)
  assert.equal(Object.isFrozen(sentinels.identity), true)
  assert.equal(sentinels.content.includes('allowed-namespace-ref'), false)
  assert.equal(sentinels.content.includes('allowed-event-payload-hash'), false)
  assert.equal(sentinels.identity.includes('allowed-namespace-ref'), false)
  assert.equal(sentinels.identity.includes('allowed-event-payload-hash'), false)

  const allSensitiveWires = [...sentinels.content, ...sentinels.identity]
    .map(value => `wire:${value}`)
  assert.deepEqual(countPhase7bMemoryOutboxLeaks(allSensitiveWires, sentinels), {
    contentLeakCount: sentinels.content.length,
    identityLeakCount: sentinels.identity.length
  })
  assert.deepEqual(countPhase7bMemoryOutboxLeaks([
    'allowed-namespace-ref',
    'allowed-event-payload-hash'
  ], sentinels), {
    contentLeakCount: 0,
    identityLeakCount: 0
  })
  assert.throws(() => countPhase7bMemoryOutboxLeaks(['wire'], {
    content: [''],
    identity: []
  }))
})

test('Phase 7B report gates every sample rather than only its median', () => {
  const rssFailure = reportInput()
  rssFailure.fixtureLifecycle[0] = {
    ...rssFailure.fixtureLifecycle[0]!,
    sample: sample(0, {
      baselineRssBytes: 100 * MIB,
      retainedRssBytes: 100 * MIB + 4 * MIB,
      peakRssBytes: 100 * MIB + PHASE_7B_MEMORY_RSS_LIMIT_BYTES + 1
    })
  }
  const rssReport = buildPhase7bMemoryResourceReport(rssFailure)
  assert.equal(rssReport.scenarios.fixtureLifecycle.rss.peak.delta.median < 7 * MIB, true)
  assert.equal(rssReport.gates.everySampleRss, false)
  assert.equal(rssReport.passed, false)

  for (const overrides of [
    { sqliteWalFileBytes: MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes + 1 },
    { outboxRecords: MEMORY_RESOURCE_LIMITS.unackedOutboxRecords + 1 },
    { identityLeakCount: 1 },
    { redisReleased: false },
    { timerResourceDelta: 1 }
  ] satisfies Array<Partial<Phase7bMemoryResourceSample>>) {
    const failed = reportInput()
    failed.fixtureLifecycle[0] = {
      ...failed.fixtureLifecycle[0]!,
      sample: sample(0, overrides)
    }
    assert.throws(() => buildPhase7bMemoryResourceReport(failed))
  }
})

test('Phase 7B report compares runtime limits with an independently frozen contract', () => {
  assert.deepEqual(PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS, {
    recordWireBytes: 16 * 1_024,
    textUtf8Bytes: 4 * 1_024,
    textCodePoints: 2_000,
    sources: 8,
    sourceExcerptUtf8Bytes: 1_024,
    sourceResourceRefs: 4,
    proposalWireBytes: 24 * 1_024,
    revisionWireBytes: 24 * 1_024,
    tombstoneWireBytes: 4 * 1_024,
    outboxEventWireBytes: 4 * 1_024,
    conflictRefs: 16,
    supersedesRefs: 16,
    listPageRecords: 64,
    listPageWireBytes: 512 * 1_024,
    operationBatchRecords: 32,
    namespaceActiveRecords: 4_096,
    namespacePendingProposals: 256,
    memoryRetainedRevisions: 32,
    namespaceCanonicalLogicalBytes: 64 * MIB,
    deploymentNamespaces: 4_096,
    deploymentActiveRecords: 32_768,
    deploymentCanonicalLogicalBytes: 256 * MIB,
    unackedOutboxRecords: 4_096,
    unackedOutboxLogicalBytes: 16 * MIB,
    sqlitePageCacheBytes: 2 * MIB,
    sqliteWalJournalLimitBytes: 32 * MIB,
    sqliteMainFileBytes: 512 * MIB,
    redisHotRecords: 2_048,
    redisHotLogicalBytes: 16 * MIB,
    redisHotAbsoluteTtlMs: 24 * 60 * 60 * 1_000,
    tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    identifierCodePoints: 128,
    qqIdDigits: 32,
    opaqueIdAsciiBytes: 128,
    identityTextCodePoints: 256,
    identityTextUtf8Bytes: 1_024,
    reasonTextCodePoints: 512,
    reasonTextUtf8Bytes: 2 * 1_024,
    resourceRefAsciiBytes: 256,
    trustedMemberSnapshotMaxAgeMs: 60_000,
    trustedMemberSnapshotFutureSkewMs: 5_000,
    accessNamespaces: 64,
    trustedMemberUserIds: 4_096
  })
  const report = buildPhase7bMemoryResourceReport(reportInput())
  assert.equal(report.gates.memoryResourceLimits, true)
})

test('Phase 7B real fixture closes SQLite and releases its Redis client without timer leaks', async () => {
  const current = await runPhase7bMemoryResourceScenario({ settleMs: 0 })
  assert.equal(validatePhase7bMemoryResourceSample(current, 'fixtureLifecycle'), current)
  assert.equal(current.canonicalActiveRecords, 1)
  assert.equal(current.canonicalRevisionRecords, 1)
  assert.equal(current.outboxRecords > 0, true)
  assert.equal(current.redisRecords, 1)
  assert.equal(current.redisGenerations, 1)
  assert.equal(current.contentLeakCount, 0)
  assert.equal(current.identityLeakCount, 0)
  assert.equal(current.sqliteClosed, true)
  assert.equal(current.redisReleased, true)
  assert.equal(current.timerResourceDelta, 0)
})
