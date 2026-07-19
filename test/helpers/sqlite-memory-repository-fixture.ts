import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1,
  type MemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import type {
  MemoryProposalV1,
  MemoryRecordV1,
  MemoryRevisionV1
} from '../../src/agent/memory/memory-domain.js'
import {
  memoryNamespaceRefV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import type { MemoryRepositoryPortV1 } from '../../src/agent/memory/memory-repository.js'
import {
  openSqliteMemoryDatabaseV1,
  type SqliteMemoryDatabaseV1
} from '../../src/agent/memory/sqlite-memory-database.js'
import { createSqliteMemoryRepositoryV1 } from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from './memory-fixture.js'

export const SQLITE_MEMORY_NOW = FIXTURE_TIMES.observedAt

export interface SqliteMemoryRepositoryHarnessV1 {
  readonly store: SqliteMemoryDatabaseV1
  readonly repository: MemoryRepositoryPortV1
  readonly capability: MemoryAccessCapabilityV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly close: () => void
}

export function createSqliteMemoryRepositoryHarnessV1 (
  location = ':memory:',
  now: () => string = () => SQLITE_MEMORY_NOW,
  namespace: MemoryNamespaceV1 = personalMemoryNamespaceFixture()
): SqliteMemoryRepositoryHarnessV1 {
  const namespaceRef = memoryNamespaceRefV1(namespace)
  if (namespace.scope.kind !== 'personal') {
    throw new TypeError('test harness requires a personal namespace')
  }
  const context = deepFreezeFixture({
    schemaVersion: 1,
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scene: deepFreezeFixture({
      kind: 'private',
      peerUserId: namespace.scope.subjectUserId
    })
  })
  const capability = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    context,
    [namespace],
    now()
  )
  const store = openSqliteMemoryDatabaseV1({ location, now })
  const repository = createSqliteMemoryRepositoryV1({
    database: store.database,
    now
  })
  return Object.freeze({
    store,
    repository,
    capability,
    namespaceRef,
    close: store.close
  })
}

export function proposalCreateRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  proposal: MemoryProposalV1 = memoryProposalFixture()
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'proposal.create',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedNamespaceGeneration: 1,
    proposal
  })
}

export function approvedProposalV1 (): MemoryProposalV1 {
  return memoryProposalFixture({
    revision: 2,
    state: 'approved',
    decision: deepFreezeFixture({
      decidedAt: FIXTURE_TIMES.confirmedAt,
      decidedByActorRef: FIXTURE_IDS.actorRef,
      reason: null
    })
  })
}

export function rejectedProposalV1 (): MemoryProposalV1 {
  return memoryProposalFixture({
    revision: 2,
    state: 'rejected',
    decision: deepFreezeFixture({
      decidedAt: FIXTURE_TIMES.confirmedAt,
      decidedByActorRef: FIXTURE_IDS.actorRef,
      reason: '用户拒绝'
    })
  })
}

export function proposalDecideRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  nextProposal: MemoryProposalV1 = approvedProposalV1(),
  initialRevision: MemoryRevisionV1 | null = memoryRevisionFixture()
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'proposal.decide',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedRevision: 1,
    expectedNamespaceGeneration: 1,
    nextProposal,
    initialRevision
  })
}

export function recordCreateRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  initialRevision: MemoryRevisionV1 = memoryRevisionFixture()
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'record.create',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedNamespaceGeneration: 1,
    initialRevision
  })
}

export function correctedRevisionV1 (
  current: MemoryRevisionV1 = memoryRevisionFixture(),
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryRevisionV1 {
  const record = memoryRecordFixture({
    revision: current.revision + 1,
    text: '喜欢低因无糖咖啡',
    updatedAt: '2026-07-19T00:03:00.000Z',
    ...overrides
  })
  return memoryRevisionFixture({
    memoryId: record.memoryId,
    revision: record.revision,
    operation: 'corrected',
    record,
    changedAt: record.updatedAt,
    reason: '用户更正',
    previousRevisionHash: current.revisionHash
  })
}

export function recordCorrectRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  nextRevision: MemoryRevisionV1 = correctedRevisionV1()
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'record.correct',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    expectedRevision: nextRevision.revision - 1,
    expectedNamespaceGeneration: 1,
    nextRevision
  })
}

export function recordGetRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  memoryId: string = FIXTURE_IDS.memoryId
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'record.get',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    memoryId
  })
}

export function recordListRequestV1 (
  harness: SqliteMemoryRepositoryHarnessV1,
  cursor: string | null = null,
  limit = 16
) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'record.list',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef,
    cursor,
    limit,
    maxWireBytes: 64 * 1_024
  })
}

export function usageGetRequestV1 (harness: SqliteMemoryRepositoryHarnessV1) {
  return deepFreezeFixture({
    schemaVersion: 1,
    operation: 'usage.get',
    capability: harness.capability,
    namespaceRef: harness.namespaceRef
  })
}

export function distinctInitialRevisionV1 (
  suffix: string,
  updatedAt: string,
  namespace: MemoryNamespaceV1 = personalMemoryNamespaceFixture()
): MemoryRevisionV1 {
  const memoryId = `memory:${suffix}`
  const record: MemoryRecordV1 = memoryRecordFixture({
    memoryId,
    updatedAt,
    namespace,
    namespaceRef: memoryNamespaceRefV1(namespace)
  })
  return memoryRevisionFixture({
    memoryId,
    record,
    changedAt: updatedAt
  })
}
