import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../agent/memory/memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1
} from '../agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryCorrectionBundleV1,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryLifecycleCommandV1,
  type MemoryLifecycleCommandV1
} from '../agent/memory/memory-lifecycle-command.js'
import type { MemoryRevisionV2 } from '../agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryLifecyclePortV1,
  type MemoryLifecycleAuthorizationEnvelopeV1
} from '../agent/memory/memory-lifecycle-port.js'
import {
  consumeMemoryExportDeliveryHandleV1,
  createMemoryExportCommandV1,
  createMemoryExportPortV1,
  MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
  memoryExportStableResultHashV1,
  type MemoryExportAuthorizationEnvelopeV1,
  type MemoryExportCommandOperationV1,
  type MemoryExportCommandV1
} from '../agent/memory/memory-export-port.js'
import {
  createMemoryMaintenanceCommandV1,
  createMemoryMaintenancePortV1
} from '../agent/memory/memory-maintenance-port.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../agent/memory/memory-namespace.js'
import {
  createMemorySourceV1,
  createQqIdentitySnapshotV1
} from '../agent/memory/memory-domain.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from '../agent/memory/memory-resource-limits.js'
import {
  openSqliteMemoryDatabaseV2,
  type SqliteMemoryDatabaseV1
} from '../agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryExportAdapterV1,
  MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1
} from '../agent/memory/sqlite-memory-export.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from '../agent/memory/sqlite-memory-lifecycle-mutation.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  createSqliteMemoryMaintenanceAdapterV1
} from '../agent/memory/sqlite-memory-maintenance.js'

const FIXED_NOW = '2026-07-25T08:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1_000
const ACTOR_REF = `actor:${'c'.repeat(64)}`
const BOT_INSTANCE_ID = 'groupmate-phase7c-resource'
const ACCOUNT_ID = '7100000001'
const SUBJECT_USER_ID = '7100000002'
const GROUP_ID = '7100000003'
const MESSAGE_ID = 'message:phase7c-resource'
const RESOURCE_REF = 'resource:phase7c-resource'
const RECORD_TEXT = '阶段七丙正文哨兵'
const SOURCE_TEXT = '阶段七丙来源正文哨兵'
const NICKNAME = '阶段七丙昵称哨兵'
const GROUP_CARD = '阶段七丙群名片哨兵'
const GROUP_TITLE = '阶段七丙头衔哨兵'
const GROUP_NAME = '阶段七丙群名哨兵'

export const PHASE_7C_MEMORY_RESOURCE_SCENARIOS = Object.freeze([
  'lifecycleMutation',
  'streamingExport',
  'deletionCleanup'
] as const)

export type Phase7cMemoryResourceScenarioName =
  typeof PHASE_7C_MEMORY_RESOURCE_SCENARIOS[number]

export const PHASE_7C_MEMORY_RESOURCE_OUTCOMES = Object.freeze({
  lifecycleMutation: 'lifecycle_mutation_verified',
  streamingExport: 'streaming_export_verified',
  deletionCleanup: 'deletion_cleanup_verified'
} as const)

export const PHASE_7C_MEMORY_EXPECTED_RESIDUAL_CARRIERS = Object.freeze({
  lifecycleMutation: 15,
  streamingExport: 7,
  deletionCleanup: 0
} as const)

export const PHASE_7C_NAMESPACE_LIFECYCLE_LOGICAL_LIMIT_BYTES =
  MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace +
  MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace *
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes +
  MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace *
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditReservationWireBytes +
  MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace *
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointWireBytes +
  MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobBytesPerNamespace

export const PHASE_7C_MEMORY_SENSITIVE_SENTINELS = Object.freeze([
  RECORD_TEXT,
  SOURCE_TEXT,
  BOT_INSTANCE_ID,
  ACCOUNT_ID,
  SUBJECT_USER_ID,
  GROUP_ID,
  MESSAGE_ID,
  RESOURCE_REF,
  NICKNAME,
  GROUP_CARD,
  GROUP_TITLE,
  GROUP_NAME
])

export interface Phase7cMemoryResourceSample {
  readonly scenario: Phase7cMemoryResourceScenarioName
  readonly baselineRssBytes: number
  readonly retainedRssBytes: number
  readonly peakRssBytes: number
  readonly wallTimeMs: number
  readonly userCpuMicros: number
  readonly systemCpuMicros: number
  readonly sqliteMainFileBytes: number
  readonly sqliteWalFileBytes: number
  readonly sqliteShmFileBytes: number
  readonly peakCanonicalLogicalBytes: number
  readonly peakOutboxRecords: number
  readonly peakOutboxLogicalBytes: number
  readonly peakLifecycleAuditRecords: number
  readonly peakLifecycleCommandRecords: number
  readonly peakDeletionCheckpointRecords: number
  readonly peakExportJobRecords: number
  readonly peakLifecycleLogicalBytes: number
  readonly generatedArtifactBytes: number
  readonly deliveredArtifactBytes: number
  readonly derivedLeakCount: number
  readonly residualCarrierRecords: number
  readonly residualArtifactFiles: number
  readonly redisEvalCalls: number
  readonly sqliteClosed: boolean
  readonly directoryRemoved: boolean
  readonly timerResourceDelta: number
  readonly outcome: typeof PHASE_7C_MEMORY_RESOURCE_OUTCOMES[Phase7cMemoryResourceScenarioName]
}

export interface Phase7cMemoryResourceScenarioOptions {
  readonly scenario?: Phase7cMemoryResourceScenarioName
  readonly settleMs?: number
  readonly gc?: () => void
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly resourceUsage?: () => NodeJS.ResourceUsage
  readonly cpuUsage?: typeof process.cpuUsage
  readonly monotonicNow?: () => number
  readonly activeResourcesInfo?: () => readonly string[]
}

interface ScenarioMetrics {
  readonly sqliteMainFileBytes: number
  readonly sqliteWalFileBytes: number
  readonly sqliteShmFileBytes: number
  readonly peakCanonicalLogicalBytes: number
  readonly peakOutboxRecords: number
  readonly peakOutboxLogicalBytes: number
  readonly peakLifecycleAuditRecords: number
  readonly peakLifecycleCommandRecords: number
  readonly peakDeletionCheckpointRecords: number
  readonly peakExportJobRecords: number
  readonly peakLifecycleLogicalBytes: number
  readonly generatedArtifactBytes: number
  readonly deliveredArtifactBytes: number
  readonly derivedLeakCount: number
  readonly residualCarrierRecords: number
  readonly residualArtifactFiles: number
  readonly redisEvalCalls: number
  readonly sqliteClosed: boolean
  readonly directoryRemoved: boolean
}

interface UsageSnapshot {
  readonly canonicalLogicalBytes: number
  readonly outboxRecords: number
  readonly outboxLogicalBytes: number
  readonly lifecycleAuditRecords: number
  readonly lifecycleCommandRecords: number
  readonly deletionCheckpointRecords: number
  readonly exportJobRecords: number
  readonly lifecycleLogicalBytes: number
}

const SAMPLE_KEYS = Object.freeze([
  'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes', 'wallTimeMs',
  'userCpuMicros', 'systemCpuMicros', 'sqliteMainFileBytes', 'sqliteWalFileBytes',
  'sqliteShmFileBytes', 'peakCanonicalLogicalBytes', 'peakOutboxRecords',
  'peakOutboxLogicalBytes', 'peakLifecycleAuditRecords', 'peakLifecycleCommandRecords',
  'peakDeletionCheckpointRecords', 'peakExportJobRecords', 'peakLifecycleLogicalBytes',
  'generatedArtifactBytes', 'deliveredArtifactBytes', 'derivedLeakCount',
  'residualCarrierRecords', 'residualArtifactFiles', 'redisEvalCalls', 'sqliteClosed',
  'directoryRemoved', 'timerResourceDelta', 'outcome'
] as const)

function fail (): never {
  throw new TypeError('Phase 7C memory resource verification failed')
}

function exactRecord (value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length !== SAMPLE_KEYS.length || SAMPLE_KEYS.some(key => !Object.hasOwn(input, key))) {
    return fail()
  }
  return input
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return fail()
  return value
}

function positiveInteger (value: unknown): number {
  const result = nonnegativeInteger(value)
  if (result === 0) return fail()
  return result
}

function bounded (value: unknown, maximum: number): number {
  const result = nonnegativeInteger(value)
  if (result > maximum) return fail()
  return result
}

function scenarioName (value: unknown): Phase7cMemoryResourceScenarioName {
  if (typeof value !== 'string' ||
    !PHASE_7C_MEMORY_RESOURCE_SCENARIOS.includes(value as Phase7cMemoryResourceScenarioName)) {
    return fail()
  }
  return value as Phase7cMemoryResourceScenarioName
}

export function validatePhase7cMemoryResourceSample (
  value: unknown,
  expectedScenario?: Phase7cMemoryResourceScenarioName
): Phase7cMemoryResourceSample {
  const input = exactRecord(value)
  const scenario = scenarioName(input.scenario)
  if (expectedScenario !== undefined && scenario !== expectedScenario) return fail()
  if (input.outcome !== PHASE_7C_MEMORY_RESOURCE_OUTCOMES[scenario]) return fail()
  const baseline = positiveInteger(input.baselineRssBytes)
  const retained = positiveInteger(input.retainedRssBytes)
  const peak = positiveInteger(input.peakRssBytes)
  if (peak < baseline || peak < retained) return fail()
  nonnegativeInteger(input.wallTimeMs)
  nonnegativeInteger(input.userCpuMicros)
  nonnegativeInteger(input.systemCpuMicros)
  bounded(input.sqliteMainFileBytes, MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes)
  bounded(input.sqliteWalFileBytes, MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes)
  bounded(input.sqliteShmFileBytes, 64 * 1_024)
  bounded(input.peakCanonicalLogicalBytes, MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes)
  bounded(input.peakOutboxRecords, MEMORY_RESOURCE_LIMITS.unackedOutboxRecords)
  bounded(input.peakOutboxLogicalBytes, MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes)
  bounded(
    input.peakLifecycleAuditRecords,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace
  )
  bounded(
    input.peakLifecycleCommandRecords,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace
  )
  bounded(
    input.peakDeletionCheckpointRecords,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace
  )
  bounded(
    input.peakExportJobRecords,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace
  )
  bounded(
    input.peakLifecycleLogicalBytes,
    PHASE_7C_NAMESPACE_LIFECYCLE_LOGICAL_LIMIT_BYTES
  )
  bounded(input.generatedArtifactBytes, MEMORY_EXPORT_MAX_WIRE_BYTES_V1)
  bounded(input.deliveredArtifactBytes, MEMORY_EXPORT_MAX_WIRE_BYTES_V1)
  if (input.generatedArtifactBytes !== input.deliveredArtifactBytes &&
    scenario === 'streamingExport') return fail()
  if (scenario !== 'streamingExport' && (
    input.generatedArtifactBytes !== 0 || input.deliveredArtifactBytes !== 0
  )) return fail()
  if (input.derivedLeakCount !== 0 || input.redisEvalCalls !== 0 ||
    input.residualArtifactFiles !== 0 || input.sqliteClosed !== true ||
    input.directoryRemoved !== true || input.timerResourceDelta !== 0) return fail()
  if (input.residualCarrierRecords !==
    PHASE_7C_MEMORY_EXPECTED_RESIDUAL_CARRIERS[scenario]) return fail()
  nonnegativeInteger(input.residualCarrierRecords)
  return Object.freeze(value as Phase7cMemoryResourceSample)
}

function commandRef (suffix: string): string {
  return `command:${createHash('sha256').update(suffix, 'utf8').digest('hex')}`
}

function plusMilliseconds (instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString()
}

function fixtureNamespace (): MemoryNamespaceV1 {
  return createMemoryNamespaceV1({
    botInstanceId: BOT_INSTANCE_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    scope: { kind: 'personal', subjectUserId: SUBJECT_USER_ID }
  })
}

function fixtureSource (observedAt: string) {
  return createMemorySourceV1({
    sourceKind: 'current_message',
    messageId: MESSAGE_ID,
    actor: createQqIdentitySnapshotV1({
      userId: SUBJECT_USER_ID,
      nickname: NICKNAME,
      groupCard: GROUP_CARD,
      groupTitle: GROUP_TITLE,
      groupRole: 'member'
    }),
    scene: {
      kind: 'group',
      groupId: GROUP_ID,
      groupLifecycleId: 'phase7c-resource-generation-1',
      groupName: GROUP_NAME
    },
    observedAt,
    normalizedText: SOURCE_TEXT,
    resourceRefs: [RESOURCE_REF]
  })
}

function actorAuthority (
  namespace: MemoryNamespaceV1,
  now: string,
  generation: number,
  actions: readonly string[]
) {
  if (namespace.scope.kind !== 'personal') return fail()
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

function directMemory (scenario: Phase7cMemoryResourceScenarioName) {
  const namespace = fixtureNamespace()
  const ref = commandRef(`phase7c-resource-direct-${scenario}`)
  const source = fixtureSource(FIXED_NOW)
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
    text: RECORD_TEXT,
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: FIXED_NOW,
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
    freshNow: FIXED_NOW,
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
      occurredAt: FIXED_NOW,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

function correction (before: MemoryRevisionV2, changedAt: string) {
  const ref = commandRef('phase7c-resource-correct')
  const source = fixtureSource(changedAt)
  const bundle = buildMemoryCorrectionBundleV1({
    commandRef: ref,
    operation: 'record.correct',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: before.record.namespaceGeneration,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: changedAt,
    text: `${RECORD_TEXT}更正`,
    confidence: 0.95,
    validity: before.record.validity,
    conflict: before.record.conflict,
    supersedes: before.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: createMemorySourceV1({
      sourceKind: 'manual_correction',
      messageId: null,
      actor: source.actor,
      scene: source.scene,
      observedAt: changedAt,
      normalizedText: `${SOURCE_TEXT}更正`,
      resourceRefs: source.resourceRefs
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
      namespaceRef: before.record.namespaceRef,
      expectedNamespaceGeneration: before.record.namespaceGeneration,
      aggregateRef: before.record.memoryId,
      expectedRevision: before.revision,
      expectedAggregateHash: before.revisionHash,
      occurredAt: changedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

function renewal (before: MemoryRevisionV2, changedAt: string) {
  const ref = commandRef('phase7c-resource-renew')
  const source = fixtureSource(changedAt)
  const bundle = buildMemoryRenewalBundleV1({
    commandRef: ref,
    operation: 'record.renew',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: before.record.namespaceGeneration,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: changedAt,
    newValidUntil: plusMilliseconds(before.record.retention.validUntil, 30 * DAY_MS),
    evidenceKind: 'explicit',
    evidenceSource: createMemorySourceV1({
      sourceKind: 'manual_correction',
      messageId: null,
      actor: source.actor,
      scene: source.scene,
      observedAt: changedAt,
      normalizedText: `${SOURCE_TEXT}续期`,
      resourceRefs: source.resourceRefs
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
      namespaceRef: before.record.namespaceRef,
      expectedNamespaceGeneration: before.record.namespaceGeneration,
      aggregateRef: before.record.memoryId,
      expectedRevision: before.revision,
      expectedAggregateHash: before.revisionHash,
      occurredAt: changedAt,
      newValidUntil: bundle.revision.record.retention.validUntil,
      newPurgeAt: bundle.revision.record.retention.purgeAt,
      material: bundle
    })
  })
}

function recordForget (revision: MemoryRevisionV2, occurredAt: string): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef('phase7c-resource-forget'),
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

function namespaceDelete (namespace: MemoryNamespaceV1, occurredAt: string) {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef('phase7c-resource-delete'),
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

function exportCommand (
  operation: MemoryExportCommandOperationV1,
  namespace: MemoryNamespaceV1,
  now: string,
  values: { readonly exportId?: string; readonly expectedManifestHash?: string } = {}
): MemoryExportCommandV1 {
  return createMemoryExportCommandV1({
    commandRef: commandRef(`phase7c-resource-${operation}`),
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

function maintenanceEnvelope (
  namespace: MemoryNamespaceV1,
  now: string,
  operation: 'namespace.scrubDeleted' | 'namespace.verifyScrubbed' | 'deletion.checkpoint',
  currentGeneration: number,
  targetGeneration: number,
  deletionRef: string | null
) {
  const command = createMemoryMaintenanceCommandV1({
    commandRef: commandRef(`phase7c-resource-${operation}`),
    operation,
    namespaceRef: memoryNamespaceRefV1(namespace),
    currentGeneration,
    targetGeneration,
    deletionRef,
    limit: 32,
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
      limit: 32
    },
    now
  )
  return Object.freeze({ schemaVersion: 1 as const, command, access: actor.access, maintenance })
}

function rowNumber (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}

function usageSnapshot (database: DatabaseSync): UsageSnapshot {
  const row = database.prepare(`
    SELECT
      COALESCE((SELECT max(canonical_logical_bytes) FROM usage), 0) AS canonical_bytes,
      COALESCE((SELECT sum(pending_outbox_records) FROM usage), 0) AS outbox_records,
      COALESCE((SELECT sum(outbox_logical_bytes) FROM usage), 0) AS outbox_bytes,
      COALESCE((SELECT sum(lifecycle_audit_records) FROM lifecycle_namespace_usage), 0)
        AS audit_records,
      COALESCE((SELECT sum(lifecycle_command_records) FROM lifecycle_namespace_usage), 0)
        AS command_records,
      COALESCE((SELECT sum(deletion_checkpoint_records) FROM lifecycle_namespace_usage), 0)
        AS checkpoint_records,
      COALESCE((SELECT sum(export_job_records) FROM lifecycle_namespace_usage), 0)
        AS export_records,
      COALESCE((SELECT sum(
        lifecycle_audit_logical_bytes + lifecycle_audit_reserved_bytes +
        lifecycle_command_logical_bytes + deletion_checkpoint_logical_bytes +
        export_job_logical_bytes
      ) FROM lifecycle_namespace_usage), 0) AS lifecycle_bytes
  `).get() as Readonly<Record<string, SQLOutputValue>> | undefined
  if (row === undefined) return fail()
  return Object.freeze({
    canonicalLogicalBytes: rowNumber(row.canonical_bytes),
    outboxRecords: rowNumber(row.outbox_records),
    outboxLogicalBytes: rowNumber(row.outbox_bytes),
    lifecycleAuditRecords: rowNumber(row.audit_records),
    lifecycleCommandRecords: rowNumber(row.command_records),
    deletionCheckpointRecords: rowNumber(row.checkpoint_records),
    exportJobRecords: rowNumber(row.export_records),
    lifecycleLogicalBytes: rowNumber(row.lifecycle_bytes)
  })
}

function derivedLeakCount (database: DatabaseSync): number {
  const statements = [
    'SELECT event_wire AS wire FROM outbox',
    'SELECT audit_wire AS wire FROM lifecycle_audits',
    'SELECT result_wire AS wire FROM lifecycle_commands',
    'SELECT checkpoint_wire AS wire FROM namespace_deletion_checkpoints',
    'SELECT reservation_wire AS wire FROM export_audit_reservations',
    'SELECT manifest_wire AS wire FROM export_jobs WHERE manifest_wire IS NOT NULL'
  ]
  const wires = statements.flatMap(statement => (
    database.prepare(statement).all() as Array<Readonly<Record<string, SQLOutputValue>>>
  ).map(row => typeof row.wire === 'string' ? row.wire : fail()))
  return PHASE_7C_MEMORY_SENSITIVE_SENTINELS.reduce(
    (total, sentinel) => total + wires.filter(wire => wire.includes(sentinel)).length,
    0
  )
}

function residualCarrierRecords (database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals WHERE namespace_generation = 1) +
      (SELECT count(*) FROM heads WHERE namespace_generation = 1) +
      (SELECT count(*) FROM revisions WHERE namespace_generation = 1) +
      (SELECT count(*) FROM revision_payloads WHERE namespace_generation = 1) +
      (SELECT count(*) FROM consent_evidence WHERE namespace_generation = 1) +
      (SELECT count(*) FROM revision_evidence WHERE namespace_generation = 1) +
      (SELECT count(*) FROM outbox WHERE namespace_generation = 1) AS value
  `).get() as Readonly<Record<string, SQLOutputValue>> | undefined
  return row === undefined ? fail() : rowNumber(row.value)
}

function fileBytes (file: string): number {
  try {
    const value = statSync(file, { bigint: false }).size
    return Number.isSafeInteger(value) && value >= 0 ? value : fail()
  } catch {
    return 0
  }
}

function timeoutCount (resources: readonly string[]): number {
  return resources.filter(resource => resource === 'Timeout').length
}

async function executeScenario (
  scenario: Phase7cMemoryResourceScenarioName,
  observe: () => void
): Promise<ScenarioMetrics> {
  const directory = mkdtempSync(path.join(tmpdir(), `groupmate-phase7c-${scenario}-`))
  const location = path.join(directory, 'memory.sqlite')
  const artifactDirectory = path.join(directory, 'exports')
  let currentNow = FIXED_NOW
  const now = () => currentNow
  let store: SqliteMemoryDatabaseV1 | undefined
  let sqliteClosed = false
  let directoryRemoved = false
  let generatedArtifactBytes = 0
  let deliveredArtifactBytes = 0
  const snapshots: UsageSnapshot[] = []
  let leaks = 0
  let carriers = 0
  let artifactFiles = 0
  try {
    store = openSqliteMemoryDatabaseV2({ location, now, manifests: [] })
    const direct = createMemoryLifecyclePortV1({
      now,
      execute: createSqliteMemoryLifecycleProposalAdapterV1({
        database: store.database,
        now
      }).execute
    })
    const mutation = createMemoryLifecyclePortV1({
      now,
      execute: createSqliteMemoryLifecycleMutationAdapterV1({
        database: store.database,
        now
      }).execute
    })
    const capture = (): void => {
      if (store === undefined) return fail()
      snapshots.push(usageSnapshot(store.database))
      leaks = Math.max(leaks, derivedLeakCount(store.database))
      observe()
    }
    const fixture = directMemory(scenario)
    const seeded = await direct.execute(actorEnvelope(
      fixture.namespace,
      fixture.command,
      currentNow,
      ['propose_create', 'approve']
    ))
    if (seeded.status !== 'stored') return fail()
    capture()

    if (scenario === 'lifecycleMutation') {
      currentNow = plusMilliseconds(currentNow, 1_000)
      const corrected = correction(fixture.bundle.revision, currentNow)
      if ((await mutation.execute(actorEnvelope(
        fixture.namespace,
        corrected.command,
        currentNow,
        ['correct']
      ))).status !== 'stored') return fail()
      capture()
      currentNow = plusMilliseconds(currentNow, 1_000)
      const renewed = renewal(corrected.bundle.revision, currentNow)
      if ((await mutation.execute(actorEnvelope(
        fixture.namespace,
        renewed.command,
        currentNow,
        ['renew']
      ))).status !== 'stored') return fail()
      capture()
    } else if (scenario === 'streamingExport') {
      const adapter = createSqliteMemoryExportAdapterV1({
        database: store.database,
        now,
        artifactDirectory,
        leaseOwnerId: 'phase7c-resource-export-owner',
        artifactCapacityBytes: MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1,
        consumeArtifact: async source => {
          await source.streamInto({
            maximumWireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
            maximumChunkBytes: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
            write: async chunk => { deliveredArtifactBytes += chunk.byteLength },
            commit: async () => undefined,
            abort: async () => undefined
          })
        }
      })
      const port = createMemoryExportPortV1({
        now,
        execute: adapter.execute,
        cleanupPartial: adapter.cleanupPartial,
        finalizeGenerate: adapter.finalizeGenerate
      })
      const prepareCommand = exportCommand('export.prepare', fixture.namespace, currentNow)
      const prepared = await port.execute(exportEnvelope(
        fixture.namespace,
        prepareCommand,
        currentNow
      ))
      if (prepared.status !== 'prepared') return fail()
      const generateCommand = exportCommand('export.generate', fixture.namespace, currentNow, {
        exportId: prepared.exportId,
        expectedManifestHash: memoryExportStableResultHashV1(prepared)
      })
      const deliverable = await port.execute(exportEnvelope(
        fixture.namespace,
        generateCommand,
        currentNow
      ))
      if (deliverable.status !== 'deliverable') return fail()
      generatedArtifactBytes = deliverable.wireBytes
      capture()
      const claimCommand = exportCommand('export.claimDelivery', fixture.namespace, currentNow, {
        exportId: deliverable.exportId,
        expectedManifestHash: memoryExportStableResultHashV1(deliverable)
      })
      const claimed = await port.execute(exportEnvelope(
        fixture.namespace,
        claimCommand,
        currentNow
      ))
      if (claimed.status !== 'delivery_claimed') return fail()
      const redeemed = await adapter.persistentDelivery.redeemOnce(
        consumeMemoryExportDeliveryHandleV1(claimed.handle)
      )
      if (redeemed.status !== 'delivered') return fail()
      capture()
    } else {
      currentNow = plusMilliseconds(currentNow, 1_000)
      const forgotten = await mutation.execute(actorEnvelope(
        fixture.namespace,
        recordForget(fixture.bundle.revision, currentNow),
        currentNow,
        ['forget']
      ))
      if (forgotten.status !== 'deletion_pending') return fail()
      capture()
      currentNow = plusMilliseconds(currentNow, 1_000)
      const deleted = await mutation.execute(actorEnvelope(
        fixture.namespace,
        namespaceDelete(fixture.namespace, currentNow),
        currentNow,
        ['delete_namespace']
      ))
      if (deleted.status !== 'deletion_pending') return fail()
      capture()
      const maintenance = createMemoryMaintenancePortV1({
        now,
        execute: createSqliteMemoryMaintenanceAdapterV1({
          database: store.database,
          now
        }).execute
      })
      currentNow = plusMilliseconds(currentNow, 1_000)
      if ((await maintenance.execute(maintenanceEnvelope(
        fixture.namespace,
        currentNow,
        'namespace.scrubDeleted',
        2,
        1,
        deleted.receipt.deletionRef
      ))).status !== 'completed') return fail()
      currentNow = plusMilliseconds(currentNow, 1_000)
      if ((await maintenance.execute(maintenanceEnvelope(
        fixture.namespace,
        currentNow,
        'namespace.verifyScrubbed',
        2,
        1,
        deleted.receipt.deletionRef
      ))).status !== 'completed') return fail()
      currentNow = plusMilliseconds(currentNow, 1_000)
      if ((await maintenance.execute(maintenanceEnvelope(
        fixture.namespace,
        currentNow,
        'deletion.checkpoint',
        2,
        2,
        null
      ))).status !== 'completed') return fail()
      capture()
    }

    leaks = Math.max(leaks, derivedLeakCount(store.database))
    carriers = residualCarrierRecords(store.database)
    artifactFiles = existsSync(artifactDirectory) ? readdirSync(artifactDirectory).length : 0
    const mainBytes = fileBytes(location)
    const walBytes = fileBytes(`${location}-wal`)
    const shmBytes = fileBytes(`${location}-shm`)
    const closedDatabase = store.database
    store.close()
    try {
      closedDatabase.prepare('SELECT 1')
    } catch {
      sqliteClosed = true
    }
    if (!sqliteClosed) return fail()
    store = undefined
    rmSync(directory, { recursive: true, force: true })
    directoryRemoved = !existsSync(directory)
    const maximum = (key: keyof UsageSnapshot): number => Math.max(
      0,
      ...snapshots.map(snapshot => snapshot[key])
    )
    return Object.freeze({
      sqliteMainFileBytes: mainBytes,
      sqliteWalFileBytes: walBytes,
      sqliteShmFileBytes: shmBytes,
      peakCanonicalLogicalBytes: maximum('canonicalLogicalBytes'),
      peakOutboxRecords: maximum('outboxRecords'),
      peakOutboxLogicalBytes: maximum('outboxLogicalBytes'),
      peakLifecycleAuditRecords: maximum('lifecycleAuditRecords'),
      peakLifecycleCommandRecords: maximum('lifecycleCommandRecords'),
      peakDeletionCheckpointRecords: maximum('deletionCheckpointRecords'),
      peakExportJobRecords: maximum('exportJobRecords'),
      peakLifecycleLogicalBytes: maximum('lifecycleLogicalBytes'),
      generatedArtifactBytes,
      deliveredArtifactBytes,
      derivedLeakCount: leaks,
      residualCarrierRecords: carriers,
      residualArtifactFiles: artifactFiles,
      redisEvalCalls: 0,
      sqliteClosed,
      directoryRemoved
    })
  } finally {
    try { store?.close() } catch {}
    try { rmSync(directory, { recursive: true, force: true }) } catch {}
  }
}

export async function runPhase7cMemoryResourceScenario (
  options: Phase7cMemoryResourceScenarioOptions = {}
): Promise<Phase7cMemoryResourceSample> {
  const scenario = scenarioName(options.scenario ?? 'lifecycleMutation')
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage())
  const cpuUsage = options.cpuUsage ?? process.cpuUsage.bind(process)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const activeResourcesInfo = options.activeResourcesInfo ?? (() => process.getActiveResourcesInfo())
  const collect = options.gc ?? (globalThis as typeof globalThis & { gc?: () => void }).gc
  const timerBaseline = timeoutCount(activeResourcesInfo())
  collect?.()
  const baselineRssBytes = positiveInteger(memoryUsage().rss)
  const observations = [baselineRssBytes]
  const cpuStart = cpuUsage()
  const resourceStart = resourceUsage()
  const wallStart = monotonicNow()
  const measured = await executeScenario(scenario, () => {
    observations.push(positiveInteger(memoryUsage().rss))
  })
  observations.push(positiveInteger(memoryUsage().rss))
  collect?.()
  await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 25))
  collect?.()
  const retainedRssBytes = positiveInteger(memoryUsage().rss)
  observations.push(retainedRssBytes)
  const resourceEnd = resourceUsage()
  const cpu = cpuUsage(cpuStart)
  const wallTimeMs = Math.max(0, Math.ceil(monotonicNow() - wallStart))
  const timerResourceDelta = Math.max(0, timeoutCount(activeResourcesInfo()) - timerBaseline)
  const rawMaxRss = Math.max(resourceStart.maxRSS, resourceEnd.maxRSS)
  const normalizedMaxRss = rawMaxRss >= retainedRssBytes ? rawMaxRss : rawMaxRss * 1_024
  const peakRssBytes = positiveInteger(Math.max(...observations, normalizedMaxRss))
  return validatePhase7cMemoryResourceSample(Object.freeze({
    scenario,
    baselineRssBytes,
    retainedRssBytes,
    peakRssBytes,
    wallTimeMs,
    userCpuMicros: nonnegativeInteger(cpu.user),
    systemCpuMicros: nonnegativeInteger(cpu.system),
    ...measured,
    timerResourceDelta,
    outcome: PHASE_7C_MEMORY_RESOURCE_OUTCOMES[scenario]
  }), scenario)
}
