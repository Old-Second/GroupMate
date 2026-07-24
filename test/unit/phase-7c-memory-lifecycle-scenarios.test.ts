import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1,
  type MemoryMaintenanceOperationV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryCorrectionBundleV1,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryLifecycleCommandV1,
  type MemoryLifecycleCommandV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  memoryProposalDeadlineV2,
  type MemoryProposalV2,
  type MemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryLifecyclePortV1,
  MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
  type MemoryLifecycleAuthorizationEnvelopeV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import {
  createMemoryControlRepositoryPortV1
} from '../../src/agent/memory/memory-control-repository.js'
import {
  consumeMemoryExportDeliveryHandleV1,
  createMemoryExportCommandV1,
  createMemoryExportPortV1,
  memoryExportStableResultHashV1,
  type MemoryExportAuthorizationEnvelopeV1,
  type MemoryExportCommandOperationV1,
  type MemoryExportCommandV1
} from '../../src/agent/memory/memory-export-port.js'
import {
  createMemoryHotProjectorV1
} from '../../src/agent/memory/memory-hot-projector.js'
import {
  createMemoryMaintenanceCommandV1,
  createMemoryMaintenancePortV1
} from '../../src/agent/memory/memory-maintenance-port.js'
import {
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { RedisMemoryHotCache } from '../../src/agent/memory/redis-memory-hot-cache.js'
import {
  openSqliteMemoryDatabaseV2,
  type SqliteMemoryDatabaseV1
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryControlRepositoryV1
} from '../../src/agent/memory/sqlite-memory-control-repository.js'
import {
  createSqliteMemoryExportAdapterV1
} from '../../src/agent/memory/sqlite-memory-export.js'
import {
  createSqliteMemoryHeadSourceV1
} from '../../src/agent/memory/sqlite-memory-head-reader.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-mutation.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  createSqliteMemoryMaintenanceAdapterV1
} from '../../src/agent/memory/sqlite-memory-maintenance.js'
import { createSqliteMemoryOutboxV1 } from '../../src/agent/memory/sqlite-memory-outbox.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T08:00:00.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const DAY_MS = 24 * 60 * 60 * 1_000

type ExportConsumer = Parameters<
typeof createSqliteMemoryExportAdapterV1
>[0]['consumeArtifact']

function commandRef (suffix: string): string {
  return `command:${createHash('sha256').update(suffix, 'utf8').digest('hex')}`
}

function plusMilliseconds (instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString()
}

function actorAuthority (
  namespace: MemoryNamespaceV1,
  now: string,
  generation: number,
  actions: readonly string[]
) {
  if (namespace.scope.kind !== 'personal') throw new TypeError('personal namespace required')
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      scene: { kind: 'private', peerUserId: namespace.scope.subjectUserId }
    },
    [namespace],
    now
  )
  const actor = issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      sceneRef: access.sceneRef,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      generation,
      actorRef: ACTOR_REF,
      actorUserId: namespace.scope.subjectUserId,
      role: 'personal_subject',
      roleObservedAt: null,
      actions
    },
    now
  )
  return Object.freeze({ access, actor })
}

function actorEnvelope (
  namespace: MemoryNamespaceV1,
  command: MemoryLifecycleCommandV1,
  now: string,
  actions: readonly string[],
  generation = 1
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const authority = actorAuthority(namespace, now, generation, actions)
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: authority.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: authority.actor })
  })
}

function lifecycleMaintenanceEnvelope (
  namespace: MemoryNamespaceV1,
  command: MemoryLifecycleCommandV1,
  now: string
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const actor = actorAuthority(namespace, now, 1, ['list_safe'])
  const maintenance = issueMemoryMaintenanceCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      currentGeneration: 1,
      targetGeneration: 1,
      deletionRef: null,
      operation: 'proposal.expireDue',
      limit: 1
    },
    now
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: actor.access,
    authority: Object.freeze({ kind: 'maintenance' as const, capability: maintenance })
  })
}

function pendingProposal (
  tag: string,
  proposedAt: string,
  text = `待确认记忆 ${tag}`
) {
  const namespace = personalMemoryNamespaceFixture()
  const ref = commandRef(`scenario-proposal-${tag}`)
  const source = memorySourceFixture({
    observedAt: proposedAt,
    normalizedText: text
  })
  const proposal = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.create',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: {
      kind: 'model',
      runRef: FIXTURE_IDS.runRef,
      modelProfile: 'deepseek-chat'
    },
    intent: { kind: 'create' },
    kind: 'preference',
    text,
    sources: [source],
    observedAt: source.observedAt,
    proposedAt,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  return Object.freeze({
    namespace,
    proposal,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'proposal.create',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: proposal.namespaceRef,
      expectedNamespaceGeneration: 1,
      aggregateRef: null,
      expectedRevision: null,
      expectedAggregateHash: null,
      occurredAt: proposedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: proposal
    })
  })
}

function proposalApproval (
  proposal: MemoryProposalV2,
  tag: string,
  approvedAt: string
) {
  const ref = commandRef(`scenario-approve-${tag}`)
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: ref,
    operation: 'proposal.approve',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    proposal,
    approvedByActorRef: ACTOR_REF,
    freshNow: approvedAt,
    evidenceSource: proposal.sources[0],
    reason: null
  })
  return Object.freeze({
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'proposal.approve',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: proposal.namespaceRef,
      expectedNamespaceGeneration: proposal.namespaceGeneration,
      aggregateRef: proposal.proposalId,
      expectedRevision: proposal.revision,
      expectedAggregateHash: proposal.consentTargetHash,
      occurredAt: approvedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle.consentEvidence
    })
  })
}

function proposalDecision (
  proposal: MemoryProposalV2,
  operation: 'proposal.reject' | 'proposal.expire',
  tag: string,
  occurredAt: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef(`scenario-${operation}-${tag}`),
    operation,
    initiatedByActorRef: operation === 'proposal.expire'
      ? MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
      : ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: proposal.namespaceGeneration,
    aggregateRef: proposal.proposalId,
    expectedRevision: proposal.revision,
    expectedAggregateHash: proposal.consentTargetHash,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

function directMemory (tag: string, proposedAt = NOW) {
  const namespace = personalMemoryNamespaceFixture()
  const ref = commandRef(`scenario-direct-${tag}`)
  const source = memorySourceFixture({ observedAt: proposedAt })
  const proposal = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text: `直接保存记忆 ${tag}`,
    sources: [source],
    observedAt: source.observedAt,
    proposedAt,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: 1,
    proposal,
    approvedByActorRef: ACTOR_REF,
    freshNow: proposedAt,
    evidenceSource: source,
    reason: null
  })
  return Object.freeze({
    namespace,
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'proposal.createAndApprove',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: proposal.namespaceRef,
      expectedNamespaceGeneration: 1,
      aggregateRef: null,
      expectedRevision: null,
      expectedAggregateHash: null,
      occurredAt: proposedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

function correction (
  beforeRevision: MemoryRevisionV2,
  tag: string,
  changedAt: string
) {
  const ref = commandRef(`scenario-correct-${tag}`)
  const bundle = buildMemoryCorrectionBundleV1({
    commandRef: ref,
    operation: 'record.correct',
    namespaceRef: beforeRevision.record.namespaceRef,
    namespaceGeneration: beforeRevision.record.namespaceGeneration,
    beforeRevision,
    changedByActorRef: ACTOR_REF,
    freshNow: changedAt,
    text: `更正后的记忆 ${tag}`,
    confidence: 0.95,
    validity: beforeRevision.record.validity,
    conflict: beforeRevision.record.conflict,
    supersedes: beforeRevision.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      observedAt: changedAt,
      normalizedText: `更正后的记忆 ${tag}`
    }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  return Object.freeze({
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'record.correct',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: beforeRevision.record.namespaceRef,
      expectedNamespaceGeneration: beforeRevision.record.namespaceGeneration,
      aggregateRef: beforeRevision.record.memoryId,
      expectedRevision: beforeRevision.revision,
      expectedAggregateHash: beforeRevision.revisionHash,
      occurredAt: changedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

function renewal (
  beforeRevision: MemoryRevisionV2,
  tag: string,
  changedAt: string,
  newValidUntil: string
) {
  const ref = commandRef(`scenario-renew-${tag}`)
  const bundle = buildMemoryRenewalBundleV1({
    commandRef: ref,
    operation: 'record.renew',
    namespaceRef: beforeRevision.record.namespaceRef,
    namespaceGeneration: beforeRevision.record.namespaceGeneration,
    beforeRevision,
    changedByActorRef: ACTOR_REF,
    freshNow: changedAt,
    newValidUntil,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      observedAt: changedAt,
      normalizedText: `续期记忆 ${tag}`
    }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  return Object.freeze({
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'record.renew',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: beforeRevision.record.namespaceRef,
      expectedNamespaceGeneration: beforeRevision.record.namespaceGeneration,
      aggregateRef: beforeRevision.record.memoryId,
      expectedRevision: beforeRevision.revision,
      expectedAggregateHash: beforeRevision.revisionHash,
      occurredAt: changedAt,
      newValidUntil: bundle.revision.record.retention.validUntil,
      newPurgeAt: bundle.revision.record.retention.purgeAt,
      material: bundle
    })
  })
}

function recordForget (
  revision: MemoryRevisionV2,
  tag: string,
  occurredAt: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef(`scenario-forget-${tag}`),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: revision.record.namespaceRef,
    expectedNamespaceGeneration: revision.record.namespaceGeneration,
    aggregateRef: revision.record.memoryId,
    expectedRevision: revision.revision,
    expectedAggregateHash: revision.revisionHash,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

function namespaceDelete (
  namespace: MemoryNamespaceV1,
  tag: string,
  occurredAt: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef(`scenario-delete-${tag}`),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

function controlRequest (
  namespace: MemoryNamespaceV1,
  now: string,
  operation: string,
  generation = 1,
  actions: readonly string[] = ['inspect_full']
) {
  const authority = actorAuthority(namespace, now, generation, actions)
  return {
    schemaVersion: 1 as const,
    operation,
    botInstanceId: namespace.botInstanceId,
    accountId: namespace.accountId,
    sceneRef: authority.access.sceneRef,
    namespaceRef: memoryNamespaceRefV1(namespace),
    generation,
    actorRef: ACTOR_REF,
    access: authority.access,
    actor: authority.actor
  }
}

function maintenanceEnvelope (
  namespace: MemoryNamespaceV1,
  now: string,
  operation: MemoryMaintenanceOperationV1,
  tag: string,
  currentGeneration = 1,
  targetGeneration = currentGeneration,
  deletionRef: string | null = null,
  limit = 32
) {
  const command = createMemoryMaintenanceCommandV1({
    commandRef: commandRef(`scenario-maintenance-${operation}-${tag}`),
    operation,
    namespaceRef: memoryNamespaceRefV1(namespace),
    currentGeneration,
    targetGeneration,
    deletionRef,
    limit,
    occurredAt: now
  })
  const actor = actorAuthority(namespace, now, currentGeneration, ['list_safe'])
  const maintenance = issueMemoryMaintenanceCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      currentGeneration,
      targetGeneration,
      deletionRef,
      operation,
      limit
    },
    now
  )
  return Object.freeze({ schemaVersion: 1 as const, command, access: actor.access, maintenance })
}

function exportCommand (
  operation: MemoryExportCommandOperationV1,
  namespace: MemoryNamespaceV1,
  now: string,
  tag: string,
  values: {
    readonly exportId?: string
    readonly expectedManifestHash?: string
  } = {}
): MemoryExportCommandV1 {
  return createMemoryExportCommandV1({
    commandRef: commandRef(`scenario-export-${operation}-${tag}`),
    operation,
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace),
    expectedNamespaceGeneration: 1,
    exportId: values.exportId ?? null,
    expectedManifestHash: values.expectedManifestHash ?? null,
    retryOfExportId: null,
    expectedSnapshotSha256: null,
    occurredAt: now
  })
}

function exportEnvelope (
  namespace: MemoryNamespaceV1,
  command: MemoryExportCommandV1,
  now: string
): MemoryExportAuthorizationEnvelopeV1 {
  const authority = actorAuthority(namespace, now, 1, ['export', 'claim_export'])
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: authority.access,
    actor: authority.actor
  })
}

function lifecyclePorts (database: DatabaseSync, now: () => string) {
  return Object.freeze({
    mutation: createMemoryLifecyclePortV1({
      now,
      execute: createSqliteMemoryLifecycleMutationAdapterV1({ database, now }).execute
    }),
    direct: createMemoryLifecyclePortV1({
      now,
      execute: createSqliteMemoryLifecycleProposalAdapterV1({ database, now }).execute
    }),
    control: createMemoryControlRepositoryPortV1({
      now,
      execute: createSqliteMemoryControlRepositoryV1({ database, now }).execute
    }),
    maintenance: createMemoryMaintenancePortV1({
      now,
      execute: createSqliteMemoryMaintenanceAdapterV1({ database, now }).execute
    })
  })
}

function projectorFor (
  database: DatabaseSync,
  now: () => string,
  cache: RedisMemoryHotCache,
  ownerId: string
) {
  return createMemoryHotProjectorV1({
    ownerId,
    now,
    outbox: createSqliteMemoryOutboxV1({ database, now }),
    source: createSqliteMemoryHeadSourceV1({ database, now }),
    cache: Object.freeze({
      execute: async (request: unknown, signal?: AbortSignal) =>
        await cache.execute(request, signal)
    })
  })
}

async function drainProjector (
  projector: ReturnType<typeof createMemoryHotProjectorV1>
): Promise<number> {
  let acknowledged = 0
  for (let batch = 0; batch < 16; batch += 1) {
    const result = await projector.projectBatch()
    if (result.status === 'empty') return acknowledged
    assert.equal(result.status, 'completed', JSON.stringify(result))
    if (result.status !== 'completed') assert.fail('projector must complete every scenario batch')
    acknowledged += result.acked
  }
  return assert.fail('projector did not drain within the bounded scenario')
}

function exportPort (
  database: DatabaseSync,
  now: () => string,
  artifactDirectory: string,
  ownerId: string,
  consumer: ExportConsumer
) {
  const adapter = createSqliteMemoryExportAdapterV1({
    database,
    now,
    artifactDirectory,
    leaseOwnerId: ownerId,
    consumeArtifact: consumer
  })
  const port = createMemoryExportPortV1({
    now,
    execute: adapter.execute,
    cleanupPartial: adapter.cleanupPartial,
    finalizeGenerate: adapter.finalizeGenerate
  })
  return Object.freeze({ adapter, port })
}

function openPair (t: TestContext, prefix: string, now: () => string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  const first = openSqliteMemoryDatabaseV2({ location, now, manifests: [] })
  const second = openSqliteMemoryDatabaseV2({ location, now, manifests: [] })
  t.after(() => {
    second.close()
    first.close()
  })
  return Object.freeze({ first, second })
}

test('Phase 7C full offline lifecycle survives restart and explicitly drains projector state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-phase7c-scenario-'))
  const location = join(directory, 'memory.sqlite')
  const artifactDirectory = join(directory, 'exports')
  let currentNow = NOW
  const now = () => currentNow
  const redis = new FakeRedis(() => Date.parse(currentNow))
  const cache = new RedisMemoryHotCache({ client: redis })
  let store: SqliteMemoryDatabaseV1 | null = openSqliteMemoryDatabaseV2({
    location,
    now,
    manifests: []
  })
  const deliveredChunks: Buffer[] = []
  const consumer: ExportConsumer = async source => {
    await source.streamInto({
      maximumWireBytes: 80 * 1_024 * 1_024,
      maximumChunkBytes: 64 * 1_024,
      write: async chunk => { deliveredChunks.push(Buffer.from(chunk)) },
      commit: async () => undefined,
      abort: async () => undefined
    })
  }

  try {
    let ports = lifecyclePorts(store.database, now)
    const approved = pendingProposal('approved', NOW, '喜欢无糖咖啡')
    const rejected = pendingProposal('rejected', plusMilliseconds(NOW, 1_000), '不应保存临时偏好')
    const expiring = pendingProposal('expired', plusMilliseconds(NOW, 2_000), '待超时偏好')

    assert.equal((await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      approved.command,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    currentNow = plusMilliseconds(NOW, 1_000)
    const approval = proposalApproval(approved.proposal, 'approved', currentNow)
    const approvedResult = await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      approval.command,
      currentNow,
      ['approve']
    ))
    assert.equal(approvedResult.status, 'stored', JSON.stringify(approvedResult))

    assert.equal((await ports.mutation.execute(actorEnvelope(
      rejected.namespace,
      rejected.command,
      currentNow,
      ['propose_create']
    ))).status, 'stored')
    currentNow = plusMilliseconds(NOW, 2_000)
    assert.equal((await ports.mutation.execute(actorEnvelope(
      rejected.namespace,
      proposalDecision(rejected.proposal, 'proposal.reject', 'rejected', currentNow),
      currentNow,
      ['reject']
    ))).status, 'stored')

    assert.equal((await ports.mutation.execute(actorEnvelope(
      expiring.namespace,
      expiring.command,
      currentNow,
      ['propose_create']
    ))).status, 'stored')
    currentNow = memoryProposalDeadlineV2(expiring.proposal)
    assert.equal((await ports.mutation.execute(lifecycleMaintenanceEnvelope(
      expiring.namespace,
      proposalDecision(expiring.proposal, 'proposal.expire', 'expired', currentNow),
      currentNow
    ))).status, 'stored')

    currentNow = plusMilliseconds(currentNow, 1_000)
    const corrected = correction(approval.bundle.revision, 'full', currentNow)
    const correctedResult = await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      corrected.command,
      currentNow,
      ['correct']
    ))
    assert.equal(correctedResult.status, 'stored', JSON.stringify(correctedResult))

    currentNow = plusMilliseconds(currentNow, 1_000)
    const renewed = renewal(
      corrected.bundle.revision,
      'full',
      currentNow,
      plusMilliseconds(corrected.bundle.revision.record.retention.validUntil, 30 * DAY_MS)
    )
    const renewedResult = await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      renewed.command,
      currentNow,
      ['renew']
    ))
    assert.equal(renewedResult.status, 'stored', JSON.stringify(renewedResult))

    const proposals = await ports.control.execute({
      ...controlRequest(approved.namespace, currentNow, 'proposal.list'),
      states: ['approved', 'rejected', 'expired'],
      cursor: null,
      cursorAnchor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(proposals.status, 'page', JSON.stringify(proposals))
    if (proposals.status === 'page' && proposals.operation === 'proposal.list') {
      assert.deepEqual(
        proposals.records.map(record => record.state).sort(),
        ['approved', 'expired', 'rejected']
      )
    }
    const records = await ports.control.execute({
      ...controlRequest(approved.namespace, currentNow, 'record.inspectList'),
      cursor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(records.status, 'page', JSON.stringify(records))
    if (records.status === 'page' && records.operation === 'record.inspectList') {
      assert.deepEqual(records.records.map(record =>
        record.lifecycleState === 'purge_due' ? record.revision : record.record.revision
      ), [3])
    }
    const history = await ports.control.execute({
      ...controlRequest(approved.namespace, currentNow, 'revision.list'),
      memoryId: renewed.bundle.revision.record.memoryId,
      cursor: null,
      cursorAnchor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    })
    assert.equal(history.status, 'page', JSON.stringify(history))
    if (history.status === 'page' && history.operation === 'revision.list') {
      assert.deepEqual(history.records.map(revision => revision.revision), [1, 2, 3])
    }

    const source = createSqliteMemoryHeadSourceV1({ database: store.database, now })
    const currentHead = {
      namespaceRef: renewed.bundle.revision.record.namespaceRef,
      namespaceGeneration: renewed.bundle.revision.record.namespaceGeneration,
      memoryId: renewed.bundle.revision.record.memoryId,
      revision: renewed.bundle.revision.record.revision,
      contentHash: renewed.bundle.revision.record.contentHash
    }
    assert.equal((await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: currentHead
    })).status, 'found')
    const projector = projectorFor(
      store.database,
      now,
      cache,
      'phase7c-scenario-projector-before-restart'
    )
    assert.equal(await drainProjector(projector) > 0, true)
    const cached = await cache.execute({
      schemaVersion: 1,
      operation: 'record.get',
      head: currentHead
    })
    assert.equal(cached.status, 'hit', JSON.stringify(cached))

    const firstExport = exportPort(
      store.database,
      now,
      artifactDirectory,
      'phase7c-export-before-restart',
      consumer
    )
    const prepareCommand = exportCommand(
      'export.prepare', approved.namespace, currentNow, 'full-prepare'
    )
    const prepared = await firstExport.port.execute(exportEnvelope(
      approved.namespace,
      prepareCommand,
      currentNow
    ))
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
    if (prepared.status !== 'prepared') return assert.fail('export prepare must succeed')
    const generateCommand = exportCommand(
      'export.generate',
      approved.namespace,
      currentNow,
      'full-generate',
      {
        exportId: prepared.exportId,
        expectedManifestHash: memoryExportStableResultHashV1(prepared)
      }
    )
    const deliverable = await firstExport.port.execute(exportEnvelope(
      approved.namespace,
      generateCommand,
      currentNow
    ))
    assert.equal(deliverable.status, 'deliverable', JSON.stringify(deliverable))
    if (deliverable.status !== 'deliverable') return assert.fail('export generate must succeed')
    const claimCommand = exportCommand(
      'export.claimDelivery',
      approved.namespace,
      currentNow,
      'full-claim',
      {
        exportId: deliverable.exportId,
        expectedManifestHash: memoryExportStableResultHashV1(deliverable)
      }
    )
    const claimed = await firstExport.port.execute(exportEnvelope(
      approved.namespace,
      claimCommand,
      currentNow
    ))
    assert.equal(claimed.status, 'delivery_claimed', JSON.stringify(claimed))
    if (claimed.status !== 'delivery_claimed') return assert.fail('export claim must succeed')
    assert.deepEqual(
      await firstExport.adapter.persistentDelivery.redeemOnce(
        consumeMemoryExportDeliveryHandleV1(claimed.handle)
      ),
      { status: 'delivered' }
    )
    assert.match(Buffer.concat(deliveredChunks).toString('utf8'), /"type":"record_revision"/)

    store.close()
    store = openSqliteMemoryDatabaseV2({ location, now, manifests: [] })
    ports = lifecyclePorts(store.database, now)
    assert.deepEqual(await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      approval.command,
      currentNow,
      ['approve']
    )), approvedResult)
    assert.deepEqual(await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      corrected.command,
      currentNow,
      ['correct']
    )), correctedResult)
    assert.deepEqual(await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      renewed.command,
      currentNow,
      ['renew']
    )), renewedResult)

    const restartedExport = exportPort(
      store.database,
      now,
      artifactDirectory,
      'phase7c-export-after-restart',
      consumer
    )
    assert.deepEqual(await restartedExport.port.execute(exportEnvelope(
      approved.namespace,
      generateCommand,
      currentNow
    )), deliverable)
    const replayClaim = await restartedExport.port.execute(exportEnvelope(
      approved.namespace,
      claimCommand,
      currentNow
    ))
    assert.equal(replayClaim.status, 'delivery_claimed', JSON.stringify(replayClaim))
    if (replayClaim.status !== 'delivery_claimed') return assert.fail('claim replay must succeed')
    assert.deepEqual(
      await restartedExport.adapter.persistentDelivery.redeemOnce(
        consumeMemoryExportDeliveryHandleV1(replayClaim.handle)
      ),
      { status: 'already_consumed' }
    )

    currentNow = plusMilliseconds(currentNow, 1_000)
    const forgetCommand = recordForget(renewed.bundle.revision, 'full', currentNow)
    const forgotten = await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      forgetCommand,
      currentNow,
      ['forget']
    ))
    assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))
    assert.equal(await drainProjector(projectorFor(
      store.database,
      now,
      cache,
      'phase7c-scenario-projector-after-forget'
    )) > 0, true)
    assert.notEqual((await cache.execute({
      schemaVersion: 1,
      operation: 'record.get',
      head: currentHead
    })).status, 'hit')

    currentNow = plusMilliseconds(currentNow, 1_000)
    const deleteCommand = namespaceDelete(approved.namespace, 'full', currentNow)
    const deleted = await ports.mutation.execute(actorEnvelope(
      approved.namespace,
      deleteCommand,
      currentNow,
      ['delete_namespace']
    ))
    assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
    if (deleted.status !== 'deletion_pending') return assert.fail('namespace delete must succeed')
    assert.equal(await drainProjector(projectorFor(
      store.database,
      now,
      cache,
      'phase7c-scenario-projector-after-delete'
    )) > 0, true)

    currentNow = plusMilliseconds(currentNow, 1_000)
    const scrubbed = await ports.maintenance.execute(maintenanceEnvelope(
      approved.namespace,
      currentNow,
      'namespace.scrubDeleted',
      'full-scrub',
      2,
      1,
      deleted.receipt.deletionRef
    ))
    assert.equal(scrubbed.status, 'completed', JSON.stringify(scrubbed))
    currentNow = plusMilliseconds(currentNow, 1_000)
    const verified = await ports.maintenance.execute(maintenanceEnvelope(
      approved.namespace,
      currentNow,
      'namespace.verifyScrubbed',
      'full-verify',
      2,
      1,
      deleted.receipt.deletionRef
    ))
    assert.equal(verified.status, 'completed', JSON.stringify(verified))
    currentNow = plusMilliseconds(currentNow, 1_000)
    const checkpointed = await ports.maintenance.execute(maintenanceEnvelope(
      approved.namespace,
      currentNow,
      'deletion.checkpoint',
      'full-checkpoint',
      2
    ))
    assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
    if (checkpointed.status === 'completed') assert.equal(checkpointed.processed, 2)

    assert.deepEqual({ ...store.database.prepare(`
      SELECT
        (SELECT count(*) FROM proposals WHERE namespace_generation = 1) AS proposals,
        (SELECT count(*) FROM heads WHERE namespace_generation = 1) AS heads,
        (SELECT count(*) FROM revisions WHERE namespace_generation = 1) AS revisions,
        (SELECT count(*) FROM revision_payloads WHERE namespace_generation = 1) AS payloads,
        (SELECT count(*) FROM outbox) AS outbox,
        (SELECT count(*) FROM namespace_deletion_checkpoints
          WHERE stage != 'canonical_complete') AS incomplete_checkpoints
    `).get()! }, {
      proposals: 0,
      heads: 0,
      revisions: 0,
      payloads: 0,
      outbox: 0,
      incomplete_checkpoints: 0
    })
    assert.deepEqual(existsSync(artifactDirectory) ? readdirSync(artifactDirectory) : [], [])
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(existsSync(directory), false)
})

test('Phase 7C approve-vs-expire race commits only the due expiry', async t => {
  let currentNow = NOW
  const now = () => currentNow
  const pair = openPair(t, 'groupmate-phase7c-approve-expire-', now)
  const first = lifecyclePorts(pair.first.database, now)
  const second = lifecyclePorts(pair.second.database, now)
  const fixture = pendingProposal('approve-expire-race', NOW)
  assert.equal((await first.mutation.execute(actorEnvelope(
    fixture.namespace,
    fixture.command,
    NOW,
    ['propose_create']
  ))).status, 'stored')
  const deadline = memoryProposalDeadlineV2(fixture.proposal)
  const approvalAt = plusMilliseconds(deadline, -1)
  const approval = proposalApproval(fixture.proposal, 'approve-expire-race', approvalAt)
  const expiry = proposalDecision(
    fixture.proposal,
    'proposal.expire',
    'approve-expire-race',
    deadline
  )
  currentNow = deadline
  const results = await Promise.all([
    first.mutation.execute(actorEnvelope(
      fixture.namespace,
      approval.command,
      deadline,
      ['approve']
    )),
    second.mutation.execute(lifecycleMaintenanceEnvelope(
      fixture.namespace,
      expiry,
      deadline
    ))
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['proposal_expired', 'stored'])
  assert.deepEqual({ ...pair.first.database.prepare(`
    SELECT state,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions
    FROM proposals
  `).get()! }, { state: 'expired', heads: 0, revisions: 0 })
})

test('Phase 7C correct-vs-renew race linearizes one revision CAS winner', async t => {
  let currentNow = NOW
  const now = () => currentNow
  const pair = openPair(t, 'groupmate-phase7c-correct-renew-', now)
  const first = lifecyclePorts(pair.first.database, now)
  const second = lifecyclePorts(pair.second.database, now)
  const fixture = directMemory('correct-renew-race')
  assert.equal((await first.direct.execute(actorEnvelope(
    fixture.namespace,
    fixture.command,
    NOW,
    ['propose_create', 'approve']
  ))).status, 'stored')
  currentNow = plusMilliseconds(NOW, 1_000)
  const corrected = correction(fixture.bundle.revision, 'correct-renew-race', currentNow)
  const renewed = renewal(
    fixture.bundle.revision,
    'correct-renew-race',
    currentNow,
    plusMilliseconds(fixture.bundle.record.retention.validUntil, 30 * DAY_MS)
  )
  const results = await Promise.all([
    first.mutation.execute(actorEnvelope(
      fixture.namespace,
      corrected.command,
      currentNow,
      ['correct']
    )),
    second.mutation.execute(actorEnvelope(
      fixture.namespace,
      renewed.command,
      currentNow,
      ['renew']
    ))
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['conflict', 'stored'])
  assert.equal(results.filter(result =>
    result.status === 'conflict' && result.category === 'revision'
  ).length, 1)
  assert.equal(pair.first.database.prepare('SELECT current_revision FROM heads').get()
    ?.current_revision, 2)
  assert.equal(pair.first.database.prepare('SELECT count(*) AS value FROM revisions').get()
    ?.value, 2)
})

test('Phase 7C renew-vs-purge race preserves purge as the only committed transition', async t => {
  let currentNow = NOW
  const now = () => currentNow
  const pair = openPair(t, 'groupmate-phase7c-renew-purge-', now)
  const first = lifecyclePorts(pair.first.database, now)
  const second = lifecyclePorts(pair.second.database, now)
  const fixture = directMemory('renew-purge-race')
  assert.equal((await first.direct.execute(actorEnvelope(
    fixture.namespace,
    fixture.command,
    NOW,
    ['propose_create', 'approve']
  ))).status, 'stored')
  const purgeAt = fixture.bundle.record.retention.purgeAt
  const renewalAt = plusMilliseconds(purgeAt, -1)
  const renewed = renewal(
    fixture.bundle.revision,
    'renew-purge-race',
    renewalAt,
    plusMilliseconds(purgeAt, 365 * DAY_MS)
  )
  currentNow = purgeAt
  const results = await Promise.all([
    first.mutation.execute(actorEnvelope(
      fixture.namespace,
      renewed.command,
      purgeAt,
      ['renew']
    )),
    second.maintenance.execute(maintenanceEnvelope(
      fixture.namespace,
      purgeAt,
      'record.purgeExpired',
      'renew-purge-race'
    ))
  ])
  assert.equal(results[0]?.status, 'record_purge_due')
  assert.equal(results[1]?.status, 'completed')
  if (results[1]?.status === 'completed') assert.equal(results[1].processed, 1)
  assert.deepEqual({ ...pair.first.database.prepare(`
    SELECT
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM tombstones) AS tombstones,
      (SELECT count(*) FROM outbox WHERE event_kind = 'record_forgotten') AS forgotten_events
  `).get()! }, { heads: 0, revisions: 0, tombstones: 1, forgotten_events: 1 })
})
