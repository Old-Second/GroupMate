import { createHash } from 'node:crypto'
import {
  parseMemorySourceV1,
  type MemoryConflictV1,
  type MemoryKindV1,
  type MemoryProposerV1,
  type MemoryRetentionV1,
  type MemorySensitivityV1,
  type MemorySourceV1,
  type MemoryValidityV1
} from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit,
  memoryCanonicalTextWithinLimits,
  memoryTextWithinLimits
} from './memory-resource-limits.js'

export const MEMORY_LIFECYCLE_DAY_MS = 86_400_000
export const MEMORY_PROPOSAL_DEADLINE_DAYS_V2 = 7
export const MEMORY_RETENTION_PURGE_GRACE_DAYS_V2 = 30
export const MEMORY_LIFECYCLE_AUDIT_RETENTION_DAYS_V1 = 365
export const MEMORY_RETENTION_POLICY_REF_V1 = 'retention:memory-lifecycle-v1'
export const MEMORY_INITIAL_RETENTION_MIN_DAYS_V2 = 1
export const MEMORY_INITIAL_RETENTION_MAX_DAYS_V2 = 1_825

export const MEMORY_CONSENT_TARGET_HASH_DOMAIN_V2 = 'groupmate.memory.consent-target.v2'
export const MEMORY_CONSENT_EVIDENCE_HASH_DOMAIN_V1 =
  'groupmate.memory.consent-evidence.v1'
export const MEMORY_REVISION_EVIDENCE_HASH_DOMAIN_V1 =
  'groupmate.memory.revision-evidence.v1'
export const MEMORY_RECORD_CONTENT_HASH_DOMAIN_V2 = 'groupmate.memory.record-content.v2'
export const MEMORY_REVISION_HASH_DOMAIN_V2 = 'groupmate.memory.revision.v2'
export const MEMORY_V1_TO_V2_MANIFEST_ID_DOMAIN_V1 =
  'groupmate.memory.v1-to-v2-manifest-id.v1'
export const MEMORY_V1_TO_V2_MANIFEST_HASH_DOMAIN_V1 =
  'groupmate.memory.v1-to-v2-manifest.v1'
export const MEMORY_LIFECYCLE_AUDIT_ID_DOMAIN_V1 =
  'groupmate.memory.lifecycle-audit-id.v1'
export const MEMORY_LIFECYCLE_AUDIT_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-audit.v1'
export const MEMORY_DELETION_REF_DOMAIN_V1 = 'groupmate.memory.deletion-ref.v1'
export const MEMORY_DELETION_TOMBSTONE_ID_DOMAIN_V1 =
  'groupmate.memory.deletion-tombstone-id.v1'
export const MEMORY_DELETION_RECEIPT_HASH_DOMAIN_V1 =
  'groupmate.memory.deletion-receipt.v1'

const MEMORY_KINDS = Object.freeze([
  'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
  'task_fact', 'other'
] as const satisfies readonly MemoryKindV1[])
const MEMORY_SENSITIVITIES = Object.freeze([
  'public', 'group', 'personal', 'sensitive'
] as const satisfies readonly MemorySensitivityV1[])
const GROUP_MEMORY_KINDS = new Set<MemoryKindV1>([
  'group_rule', 'group_culture', 'task_fact', 'other'
])
const PROPOSAL_STATES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired', 'withdrawn'
] as const)
const LEGACY_PROPOSAL_STATES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired'
] as const)
const LEGACY_STANDALONE_PROPOSAL_STATES = Object.freeze([
  'pending', 'rejected', 'expired'
] as const)
const CONSENT_STATES = Object.freeze([
  'explicit', 'owner_policy', 'group_policy'
] as const)
const REVISION_OPERATIONS = Object.freeze([
  'created', 'corrected', 'retention_changed', 'conflict_changed'
] as const)
const REVISION_EVIDENCE_OPERATIONS = Object.freeze([
  'corrected', 'retention_changed', 'conflict_changed'
] as const)
const CARRIER_KINDS = Object.freeze([
  'proposal', 'head', 'revision', 'revision_payload', 'content_outbox'
] as const)

type MemoryConsentStateV2 = typeof CONSENT_STATES[number]
type MemoryProposalStateV2 = typeof PROPOSAL_STATES[number]
type MemoryRevisionOperationV2 = typeof REVISION_OPERATIONS[number]
type MemoryRevisionEvidenceOperationV1 = typeof REVISION_EVIDENCE_OPERATIONS[number]

export type MemoryProposalIntentV2 =
  | { readonly kind: 'create' }
  | {
      readonly kind: 'correction'
      readonly targetMemoryId: string
      readonly targetRevision: number
      readonly targetRevisionHash: string
    }

export interface MemoryProposalDecisionV2 {
  readonly decidedAt: string
  readonly decidedByActorRef: string
  readonly reason: string | null
  readonly consentEvidenceId: string | null
  readonly consentEvidenceHash: string | null
  readonly resultingMemoryId: string | null
  readonly resultingMemoryRevision: number | null
  readonly resultingRevisionHash: string | null
}

export interface MemoryProposalV2 {
  readonly schemaVersion: 2
  readonly proposalId: string
  readonly revision: number
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly state: MemoryProposalStateV2
  readonly initiatedByActorRef: string
  readonly proposedBy: MemoryProposerV1
  readonly plannedMemoryId: string
  readonly intent: MemoryProposalIntentV2
  readonly kind: MemoryKindV1
  readonly text: string
  readonly sources: readonly MemorySourceV1[]
  readonly observedAt: string
  readonly proposedAt: string
  readonly confidence: number
  readonly sensitivity: MemorySensitivityV1
  readonly conflict: MemoryConflictV1
  readonly suggestedRetention: MemoryRetentionV1
  readonly retentionPolicyRef: typeof MEMORY_RETENTION_POLICY_REF_V1
  readonly consentRequirement: MemoryConsentStateV2
  readonly consentPolicyRef: string | null
  readonly consentPolicyGeneration: number | null
  readonly consentTargetHash: string
  readonly decision: MemoryProposalDecisionV2 | null
}

export interface MemoryConsentEvidenceV1 {
  readonly schemaVersion: 1
  readonly evidenceId: string
  readonly evidenceKind: MemoryConsentStateV2
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly proposalId: string
  readonly proposalRevision: 1
  readonly consentTargetHash: string
  readonly approvedByActorRef: string
  readonly approvedAt: string
  readonly source: MemorySourceV1 | null
  readonly policyRef: string | null
  readonly policyGeneration: number | null
  readonly evidenceHash: string
}

export interface ApprovedMemoryConsentV2 {
  readonly state: MemoryConsentStateV2
  readonly approvedByActorRef: string
  readonly approvedAt: string
  readonly consentTargetHash: string
  readonly evidenceId: string
  readonly evidenceHash: string
  readonly policyRef: string | null
  readonly policyGeneration: number | null
}

export interface MemoryRecordV2 {
  readonly schemaVersion: 2
  readonly memoryId: string
  readonly revision: number
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly kind: MemoryKindV1
  readonly text: string
  readonly sources: readonly MemorySourceV1[]
  readonly createdAt: string
  readonly observedAt: string
  readonly confirmedAt: string
  readonly updatedAt: string
  readonly validity: MemoryValidityV1
  readonly confidence: number
  readonly consent: ApprovedMemoryConsentV2
  readonly sensitivity: MemorySensitivityV1
  readonly conflict: MemoryConflictV1
  readonly supersedes: readonly string[]
  readonly retention: MemoryRetentionV1
  readonly retentionPolicyRef: typeof MEMORY_RETENTION_POLICY_REF_V1
  readonly deletionState: 'active'
  readonly contentHash: string
}

export interface MemoryRevisionEvidenceV1 {
  readonly schemaVersion: 1
  readonly evidenceId: string
  readonly evidenceKind: MemoryConsentStateV2
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly revision: number
  readonly operation: MemoryRevisionEvidenceOperationV1
  readonly baseRevisionHash: string
  readonly revisionTargetHash: string
  readonly changedByActorRef: string
  readonly changedAt: string
  readonly source: MemorySourceV1 | null
  readonly policyRef: string | null
  readonly policyGeneration: number | null
  readonly evidenceHash: string
}

export interface MemoryRevisionEvidenceRefV1 {
  readonly kind: 'consent' | 'revision'
  readonly evidenceId: string
  readonly evidenceHash: string
}

export interface MemoryRevisionV2 {
  readonly schemaVersion: 2
  readonly memoryId: string
  readonly revision: number
  readonly operation: MemoryRevisionOperationV2
  readonly record: MemoryRecordV2
  readonly changedByActorRef: string
  readonly changedAt: string
  readonly reason: string | null
  readonly evidence: MemoryRevisionEvidenceRefV1
  readonly previousRevisionHash: string | null
  readonly revisionHash: string
}

export interface MemoryCreateApprovalResultV2 {
  readonly proposal: MemoryProposalV2
  readonly consentEvidence: MemoryConsentEvidenceV1
  readonly record: MemoryRecordV2
  readonly revision: MemoryRevisionV2
}

export interface MemoryV1ToV2RevisionEvidenceBindingV1 {
  readonly revision: number
  readonly evidenceId: string
  readonly evidenceHash: string
}

export interface MemoryV1ToV2LegacyRevisionWireV1 {
  readonly revision: number
  readonly legacyWireHash: string
}

export type MemoryV1ToV2AggregateV1 =
  | {
      readonly kind: 'proposal'
      readonly aggregateId: string
      readonly proposalState: typeof LEGACY_STANDALONE_PROPOSAL_STATES[number]
      readonly proposalRevision: 1 | 2
      readonly legacyProposalWireHashes: readonly string[]
      readonly legacyRevisionWires: readonly MemoryV1ToV2LegacyRevisionWireV1[]
    }
  | {
      readonly kind: 'memory'
      readonly aggregateId: string
      readonly proposalState: 'approved'
      readonly proposalRevision: 2
      readonly currentRevision: number
      readonly legacyProposalWireHashes: readonly string[]
      readonly legacyRevisionWires: readonly MemoryV1ToV2LegacyRevisionWireV1[]
    }

export interface MemoryV1ToV2AggregateManifestV1 {
  readonly schemaVersion: 1
  readonly manifestId: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly aggregate: MemoryV1ToV2AggregateV1
  readonly initiatedByActorRef: string
  readonly plannedMemoryId: string
  readonly intent: MemoryProposalIntentV2
  readonly consentEvidenceId: string | null
  readonly consentEvidenceHash: string | null
  readonly revisionEvidenceBindings: readonly MemoryV1ToV2RevisionEvidenceBindingV1[]
  readonly manifestHash: string
}

export interface MemoryV1ToV2ManifestExpectationV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly aggregateKind: MemoryV1ToV2AggregateV1['kind']
  readonly aggregateId: string
  readonly proposalState: typeof LEGACY_PROPOSAL_STATES[number]
  readonly proposalRevision: 1 | 2
  readonly currentRevision: number | null
  readonly legacyProposalWireHashes: readonly string[]
  readonly legacyRevisionWires: readonly MemoryV1ToV2LegacyRevisionWireV1[]
}

export interface MemoryLifecycleAuditV1 {
  readonly schemaVersion: 1
  readonly auditId: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly operation:
    | 'proposal_pruned'
    | 'export_prepared'
    | 'export_completed'
    | 'export_failed'
  readonly commandRefHash: string
  readonly aggregateKind: 'proposal' | 'record' | 'namespace' | 'export'
  readonly aggregateRefHash: string
  readonly authorizedByActorRefHash: string
  readonly executedByActorRefHash: string
  readonly sourceCommittedAt: string
  readonly recordedAt: string
  readonly outcome:
    | 'pruned'
    | 'prepared'
    | 'completed'
    | 'snapshot_changed'
    | 'failed_aborted'
    | 'failed_corrupt'
    | 'failed_capacity'
    | 'failed_unavailable'
  readonly repositoryReceiptHash: string | null
  readonly priorRevision: number | null
  readonly nextRevision: number | null
  readonly exclusionsHash: string | null
  readonly receiptHash: string
  readonly expiresAt: string
}

export interface DeletionMutationReceiptV1 {
  readonly schemaVersion: 1
  readonly deletionRef: string
  readonly commandRefHash: string
  readonly operation: 'forget' | 'delete_namespace'
  readonly repositoryReceiptHash: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generationBefore: number
  readonly generationAfter: number
  readonly deletingGeneration: number
  readonly memoryId: string | null
  readonly deletedRevision: number | null
  readonly committedAt: string
  readonly tombstoneId: string
  readonly tombstoneReceiptHash: string
  readonly tombstoneExpiresAt: string
  readonly exclusionsHash: string
  readonly receiptHash: string
}

export interface DeletionStatusV1 {
  readonly schemaVersion: 1
  readonly deletionRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly deletingGeneration: number
  readonly observedCurrentGeneration: number
  readonly remainingCarrierKinds: readonly typeof CARRIER_KINDS[number][]
  readonly canonicalBodies: 'verified_absent' | 'scrub_pending' | 'unverified'
  readonly payloadDeletion: 'secure_delete_on' | 'unverified'
  readonly walCheckpoint: 'truncated' | 'deferred' | 'unverified'
  readonly derivedCleanup: 'queued' | 'applied' | 'unverified'
  readonly stage: 'logical_committed' | 'verification_pending' | 'canonical_complete'
  readonly observedAt: string
}

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

export function memoryLifecycleDomainHashV1 (domain: string, preimage: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(preimage, 'utf8')
    .digest('hex')
}

export const MEMORY_DELETION_EXCLUSIONS_HASH_DOMAIN_V1 =
  'groupmate.memory.deletion-exclusions.v1'
export const MEMORY_DELETION_EXCLUSIONS_V1 = Object.freeze([
  'qq_server_history',
  'groupmate_content_journal',
  'independent_backups_and_snapshots',
  'provider_logs',
  'delivered_export_artifacts'
] as const)
export const MEMORY_DELETION_EXCLUSIONS_HASH_V1 = memoryLifecycleDomainHashV1(
  MEMORY_DELETION_EXCLUSIONS_HASH_DOMAIN_V1,
  JSON.stringify(MEMORY_DELETION_EXCLUSIONS_V1)
)

export function parseMemoryLifecycleHashV1 (value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

export function parseMemoryLifecycleInstantV1 (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 ||
    new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

export function parseMemoryLifecyclePositiveIntegerV1 (
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

export function parseMemoryLifecycleNonNegativeIntegerV1 (
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

export function parseMemoryLifecycleOpaqueIdV1 (value: unknown, prefix = ''): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length) {
    return invalidMemoryValue()
  }
  return value
}

export function parseMemoryLifecycleHashedRefV1 (value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value !== `${prefix}${value.slice(prefix.length)}` ||
    !value.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(value.slice(prefix.length)) ||
    !memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes)) {
    return invalidMemoryValue()
  }
  return value
}

export function addMemoryLifecycleDaysV1 (instant: unknown, days: unknown): string {
  const canonical = parseMemoryLifecycleInstantV1(instant)
  const parsedDays = parseMemoryLifecyclePositiveIntegerV1(days)
  const result = Date.parse(canonical) + (parsedDays * MEMORY_LIFECYCLE_DAY_MS)
  if (!Number.isSafeInteger(result) || !Number.isFinite(result) ||
    Math.abs(result) > 8_640_000_000_000_000) return invalidMemoryValue()
  return new Date(result).toISOString()
}

function parseCanonicalText (value: unknown): string {
  if (typeof value !== 'string' || value.includes('\r') || !memoryTextWithinLimits(value) ||
    !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)) return invalidMemoryValue()
  return value
}

function parseReason (value: unknown): string | null {
  if (value === null) return null
  if (!memoryCanonicalTextWithinLimits(
    value,
    MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.reasonTextCodePoints
  ) || typeof value !== 'string' || value.includes('\r') ||
    !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)) return invalidMemoryValue()
  return value
}

function parseConfidence (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
    value < 0 || value > 1) return invalidMemoryValue()
  return value
}

function parseSources (value: unknown): readonly MemorySourceV1[] {
  const sources = inspectMemoryArray(value, MEMORY_RESOURCE_LIMITS.sources)
    .map(parseMemorySourceV1)
  if (sources.length === 0 || new Set(sources.map(source => source.sourceId)).size !== sources.length) {
    return invalidMemoryValue()
  }
  return Object.freeze(sources)
}

function validateSourceObservationTimes (
  sources: readonly MemorySourceV1[],
  maximumObservedAt: string
): void {
  const maximumMs = Date.parse(maximumObservedAt)
  for (const source of sources) {
    const observedMs = Date.parse(source.observedAt)
    if (!Number.isSafeInteger(observedMs) || observedMs < 0 || observedMs > maximumMs) {
      return invalidMemoryValue()
    }
  }
}

function parseProposer (value: unknown): MemoryProposerV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['runRef', 'modelProfile', 'actorRef', 'policyRef']
  )
  if (discriminator.kind === 'model') {
    const input = inspectMemoryRecord(value, ['kind', 'runRef', 'modelProfile'])
    return Object.freeze({
      kind: 'model' as const,
      runRef: parseMemoryLifecycleOpaqueIdV1(input.runRef, 'run:'),
      modelProfile: parseMemoryLifecycleOpaqueIdV1(input.modelProfile)
    })
  }
  if (discriminator.kind === 'user') {
    const input = inspectMemoryRecord(value, ['kind', 'actorRef'])
    return Object.freeze({
      kind: 'user' as const,
      actorRef: parseMemoryLifecycleHashedRefV1(input.actorRef, 'actor:')
    })
  }
  if (discriminator.kind === 'system_policy') {
    const input = inspectMemoryRecord(value, ['kind', 'policyRef'])
    return Object.freeze({
      kind: 'system_policy' as const,
      policyRef: parseMemoryLifecycleOpaqueIdV1(input.policyRef, 'policy:')
    })
  }
  return invalidMemoryValue()
}

export function parseMemoryProposalIntentV2 (value: unknown): MemoryProposalIntentV2 {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['targetMemoryId', 'targetRevision', 'targetRevisionHash']
  )
  if (discriminator.kind === 'create') {
    inspectMemoryRecord(value, ['kind'])
    return Object.freeze({ kind: 'create' as const })
  }
  if (discriminator.kind === 'correction') {
    const input = inspectMemoryRecord(value, [
      'kind', 'targetMemoryId', 'targetRevision', 'targetRevisionHash'
    ])
    return Object.freeze({
      kind: 'correction' as const,
      targetMemoryId: parseMemoryLifecycleHashedRefV1(input.targetMemoryId, 'memory:'),
      targetRevision: parseMemoryLifecyclePositiveIntegerV1(
        input.targetRevision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      ),
      targetRevisionHash: parseMemoryLifecycleHashV1(input.targetRevisionHash)
    })
  }
  return invalidMemoryValue()
}

function parseConflict (value: unknown, ownMemoryId: string | null = null): MemoryConflictV1 {
  const input = inspectMemoryRecord(value, ['state', 'relatedMemoryIds', 'note'])
  const state = enumValue(input.state, ['none', 'possible', 'confirmed'] as const)
  const relatedMemoryIds = inspectMemoryArray(
    input.relatedMemoryIds,
    MEMORY_RESOURCE_LIMITS.conflictRefs
  ).map(item => parseMemoryLifecycleHashedRefV1(item, 'memory:'))
  if (new Set(relatedMemoryIds).size !== relatedMemoryIds.length ||
    (ownMemoryId !== null && relatedMemoryIds.includes(ownMemoryId))) return invalidMemoryValue()
  const note = parseReason(input.note)
  if ((state === 'none' && (relatedMemoryIds.length !== 0 || note !== null)) ||
    (state !== 'none' && (relatedMemoryIds.length === 0 || note === null))) {
    return invalidMemoryValue()
  }
  return Object.freeze({ state, relatedMemoryIds: Object.freeze(relatedMemoryIds), note })
}

function parseRetentionPolicyRef (value: unknown): typeof MEMORY_RETENTION_POLICY_REF_V1 {
  if (value !== MEMORY_RETENTION_POLICY_REF_V1) return invalidMemoryValue()
  return MEMORY_RETENTION_POLICY_REF_V1
}

function parseRetentionWithGrace (value: unknown): MemoryRetentionV1 {
  const input = inspectMemoryRecord(value, ['validUntil', 'purgeAt'])
  const validUntil = parseMemoryLifecycleInstantV1(input.validUntil)
  const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt)
  if (addMemoryLifecycleDaysV1(
    validUntil,
    MEMORY_RETENTION_PURGE_GRACE_DAYS_V2
  ) !== purgeAt) return invalidMemoryValue()
  return Object.freeze({ validUntil, purgeAt })
}

function parseInitialRetention (
  value: unknown,
  proposedAt: string
): MemoryRetentionV1 {
  const retention = parseRetentionWithGrace(value)
  const duration = Date.parse(retention.validUntil) - Date.parse(proposedAt)
  if (!Number.isSafeInteger(duration) || duration < MEMORY_LIFECYCLE_DAY_MS ||
    duration % MEMORY_LIFECYCLE_DAY_MS !== 0 ||
    duration > MEMORY_INITIAL_RETENTION_MAX_DAYS_V2 * MEMORY_LIFECYCLE_DAY_MS) {
    return invalidMemoryValue()
  }
  return retention
}

function parseValidity (value: unknown): MemoryValidityV1 {
  const input = inspectMemoryRecord(value, ['state', 'validFrom'])
  const state = enumValue(input.state, ['current', 'uncertain', 'superseded'] as const)
  const validFrom = input.validFrom === null
    ? null
    : parseMemoryLifecycleInstantV1(input.validFrom)
  if ((state === 'uncertain' && validFrom !== null) ||
    (state !== 'uncertain' && validFrom === null)) return invalidMemoryValue()
  return Object.freeze({ state, validFrom })
}

function parseConsentPolicyBinding (value: {
  readonly requirement: MemoryConsentStateV2
  readonly policyRef: unknown
  readonly policyGeneration: unknown
}): { readonly policyRef: string | null; readonly policyGeneration: number | null } {
  if (value.requirement === 'explicit') {
    if (value.policyRef !== null || value.policyGeneration !== null) return invalidMemoryValue()
    return Object.freeze({ policyRef: null, policyGeneration: null })
  }
  if (value.policyRef === null || value.policyGeneration === null) return invalidMemoryValue()
  return Object.freeze({
    policyRef: parseMemoryLifecycleOpaqueIdV1(value.policyRef, 'policy:'),
    policyGeneration: parseMemoryLifecyclePositiveIntegerV1(value.policyGeneration)
  })
}

function validateNamespaceContent (
  namespace: MemoryNamespaceV1,
  consent: MemoryConsentStateV2,
  kind: MemoryKindV1,
  sensitivity: MemorySensitivityV1,
  sources: readonly MemorySourceV1[]
): void {
  if ((namespace.scope.kind === 'personal' && consent === 'group_policy') ||
    (namespace.scope.kind === 'group' && consent === 'owner_policy')) return invalidMemoryValue()
  if (namespace.scope.kind !== 'group') return
  if (!GROUP_MEMORY_KINDS.has(kind) || !['public', 'group'].includes(sensitivity)) {
    return invalidMemoryValue()
  }
  for (const source of sources) {
    if (source.sourceKind === 'private_history' || source.scene.kind !== 'group' ||
      source.scene.groupId !== namespace.scope.groupId ||
      source.scene.groupLifecycleId !== namespace.scope.groupLifecycleId) {
      return invalidMemoryValue()
    }
  }
}

function parseUniqueHashedRefs (
  value: unknown,
  maximum: number,
  prefix: string
): readonly string[] {
  const refs = inspectMemoryArray(value, maximum)
    .map(item => parseMemoryLifecycleHashedRefV1(item, prefix))
  if (new Set(refs).size !== refs.length) return invalidMemoryValue()
  return Object.freeze(refs)
}

function parseUniqueHashes (value: unknown, maximum: number): readonly string[] {
  const hashes = inspectMemoryArray(value, maximum).map(parseMemoryLifecycleHashV1)
  if (new Set(hashes).size !== hashes.length) return invalidMemoryValue()
  return Object.freeze(hashes)
}

interface MemoryProposalConsentTargetV2 {
  readonly proposalId: string
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly initiatedByActorRef: string
  readonly proposedBy: MemoryProposerV1
  readonly plannedMemoryId: string
  readonly intent: MemoryProposalIntentV2
  readonly kind: MemoryKindV1
  readonly text: string
  readonly sources: readonly MemorySourceV1[]
  readonly observedAt: string
  readonly proposedAt: string
  readonly confidence: number
  readonly sensitivity: MemorySensitivityV1
  readonly conflict: MemoryConflictV1
  readonly suggestedRetention: MemoryRetentionV1
  readonly retentionPolicyRef: typeof MEMORY_RETENTION_POLICY_REF_V1
  readonly consentRequirement: MemoryConsentStateV2
  readonly consentPolicyRef: string | null
  readonly consentPolicyGeneration: number | null
}

function proposalConsentTargetPreimageV2 (value: MemoryProposalConsentTargetV2): string {
  return JSON.stringify({
    schemaVersion: 2,
    proposalId: value.proposalId,
    namespace: value.namespace,
    namespaceRef: value.namespaceRef,
    namespaceGeneration: value.namespaceGeneration,
    initiatedByActorRef: value.initiatedByActorRef,
    proposedBy: value.proposedBy,
    plannedMemoryId: value.plannedMemoryId,
    intent: value.intent,
    kind: value.kind,
    text: value.text,
    sources: value.sources,
    observedAt: value.observedAt,
    proposedAt: value.proposedAt,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    conflict: value.conflict,
    suggestedRetention: value.suggestedRetention,
    retentionPolicyRef: value.retentionPolicyRef,
    consentRequirement: value.consentRequirement,
    consentPolicyRef: value.consentPolicyRef,
    consentPolicyGeneration: value.consentPolicyGeneration
  })
}

export function memoryProposalConsentTargetHashV2 (
  value: MemoryProposalConsentTargetV2
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_CONSENT_TARGET_HASH_DOMAIN_V2,
    proposalConsentTargetPreimageV2(value)
  )
}

function parseProposalDecision (
  value: unknown,
  state: MemoryProposalStateV2,
  plannedMemoryId: string,
  intent: MemoryProposalIntentV2,
  decisionCutoff: string
): MemoryProposalDecisionV2 | null {
  if (value === null) return null
  const input = inspectMemoryRecord(value, [
    'decidedAt', 'decidedByActorRef', 'reason', 'consentEvidenceId',
    'consentEvidenceHash', 'resultingMemoryId', 'resultingMemoryRevision',
    'resultingRevisionHash'
  ])
  const evidenceId = input.consentEvidenceId === null
    ? null
    : parseMemoryLifecycleHashedRefV1(input.consentEvidenceId, 'evidence:')
  const evidenceHash = input.consentEvidenceHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.consentEvidenceHash)
  const resultingMemoryId = input.resultingMemoryId === null
    ? null
    : parseMemoryLifecycleHashedRefV1(input.resultingMemoryId, 'memory:')
  const resultingMemoryRevision = input.resultingMemoryRevision === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(
        input.resultingMemoryRevision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      )
  const resultingRevisionHash = input.resultingRevisionHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.resultingRevisionHash)
  const approvalValuesPresent = evidenceId !== null && evidenceHash !== null &&
    resultingMemoryId !== null && resultingMemoryRevision !== null &&
    resultingRevisionHash !== null
  const anyApprovalValuePresent = evidenceId !== null || evidenceHash !== null ||
    resultingMemoryId !== null || resultingMemoryRevision !== null ||
    resultingRevisionHash !== null
  if ((state === 'approved' && !approvalValuesPresent) ||
    (state !== 'approved' && anyApprovalValuePresent)) return invalidMemoryValue()
  if (state === 'approved') {
    const expectedRevision = intent.kind === 'create' ? 1 : intent.targetRevision + 1
    if (!Number.isSafeInteger(expectedRevision) || resultingMemoryId !== plannedMemoryId ||
      resultingMemoryRevision !== expectedRevision) return invalidMemoryValue()
  }
  const decidedAt = parseMemoryLifecycleInstantV1(input.decidedAt)
  const atOrAfterCutoff = Date.parse(decidedAt) >= Date.parse(decisionCutoff)
  if ((state === 'expired') !== atOrAfterCutoff) return invalidMemoryValue()
  return Object.freeze({
    decidedAt,
    decidedByActorRef: parseMemoryLifecycleHashedRefV1(
      input.decidedByActorRef,
      'actor:'
    ),
    reason: parseReason(input.reason),
    consentEvidenceId: evidenceId,
    consentEvidenceHash: evidenceHash,
    resultingMemoryId,
    resultingMemoryRevision,
    resultingRevisionHash
  })
}

function parseProposalFields (value: unknown, create: boolean): MemoryProposalV2 {
  const mutableKeys = [
    'proposalId', 'namespace', 'namespaceGeneration', 'initiatedByActorRef', 'proposedBy',
    'plannedMemoryId', 'intent', 'kind', 'text', 'sources', 'observedAt', 'proposedAt',
    'confidence', 'sensitivity', 'conflict', 'suggestedRetention', 'retentionPolicyRef',
    'consentRequirement', 'consentPolicyRef', 'consentPolicyGeneration'
  ]
  const storedKeys = [
    'schemaVersion', 'proposalId', 'revision', 'namespace', 'namespaceRef',
    'namespaceGeneration', 'state', 'initiatedByActorRef', 'proposedBy',
    'plannedMemoryId', 'intent', 'kind', 'text', 'sources', 'observedAt', 'proposedAt',
    'confidence', 'sensitivity', 'conflict', 'suggestedRetention', 'retentionPolicyRef',
    'consentRequirement', 'consentPolicyRef', 'consentPolicyGeneration',
    'consentTargetHash', 'decision'
  ]
  const input = inspectMemoryRecord(value, create ? mutableKeys : storedKeys)
  if (!create && input.schemaVersion !== 2) return invalidMemoryValue()
  const proposalId = parseMemoryLifecycleHashedRefV1(input.proposalId, 'proposal:')
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const namespaceRef = memoryNamespaceRefV1(namespace)
  if (!create && parseMemoryNamespaceRefV1(input.namespaceRef) !== namespaceRef) {
    return invalidMemoryValue()
  }
  const namespaceGeneration = parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration)
  const state = create ? 'pending' as const : enumValue(input.state, PROPOSAL_STATES)
  const revision = create ? 1 : parseMemoryLifecyclePositiveIntegerV1(input.revision, 2)
  if ((state === 'pending' && revision !== 1) || (state !== 'pending' && revision !== 2)) {
    return invalidMemoryValue()
  }
  const initiatedByActorRef = parseMemoryLifecycleHashedRefV1(
    input.initiatedByActorRef,
    'actor:'
  )
  const proposedBy = parseProposer(input.proposedBy)
  const plannedMemoryId = parseMemoryLifecycleHashedRefV1(input.plannedMemoryId, 'memory:')
  const intent = parseMemoryProposalIntentV2(input.intent)
  if (intent.kind === 'correction' && plannedMemoryId !== intent.targetMemoryId) {
    return invalidMemoryValue()
  }
  const kind = enumValue(input.kind, MEMORY_KINDS)
  const text = parseCanonicalText(input.text)
  const sources = parseSources(input.sources)
  const observedAt = parseMemoryLifecycleInstantV1(input.observedAt)
  const proposedAt = parseMemoryLifecycleInstantV1(input.proposedAt)
  if (Date.parse(observedAt) > Date.parse(proposedAt)) return invalidMemoryValue()
  validateSourceObservationTimes(sources, proposedAt)
  const proposalDeadline = addMemoryLifecycleDaysV1(
    proposedAt,
    MEMORY_PROPOSAL_DEADLINE_DAYS_V2
  )
  const confidence = parseConfidence(input.confidence)
  const sensitivity = enumValue(input.sensitivity, MEMORY_SENSITIVITIES)
  const conflict = parseConflict(
    input.conflict,
    intent.kind === 'correction' ? intent.targetMemoryId : plannedMemoryId
  )
  const suggestedRetention = intent.kind === 'create'
    ? parseInitialRetention(input.suggestedRetention, proposedAt)
    : parseRetentionWithGrace(input.suggestedRetention)
  if (intent.kind === 'correction' &&
    Date.parse(suggestedRetention.validUntil) <= Date.parse(proposedAt)) {
    return invalidMemoryValue()
  }
  const decisionCutoff = Date.parse(proposalDeadline) < Date.parse(suggestedRetention.validUntil)
    ? proposalDeadline
    : suggestedRetention.validUntil
  const retentionPolicyRef = parseRetentionPolicyRef(input.retentionPolicyRef)
  const consentRequirement = enumValue(input.consentRequirement, CONSENT_STATES)
  const policyBinding = parseConsentPolicyBinding({
    requirement: consentRequirement,
    policyRef: input.consentPolicyRef,
    policyGeneration: input.consentPolicyGeneration
  })
  validateNamespaceContent(namespace, consentRequirement, kind, sensitivity, sources)
  const target = Object.freeze({
    proposalId,
    namespace,
    namespaceRef,
    namespaceGeneration,
    initiatedByActorRef,
    proposedBy,
    plannedMemoryId,
    intent,
    kind,
    text,
    sources,
    observedAt,
    proposedAt,
    confidence,
    sensitivity,
    conflict,
    suggestedRetention,
    retentionPolicyRef,
    consentRequirement,
    consentPolicyRef: policyBinding.policyRef,
    consentPolicyGeneration: policyBinding.policyGeneration
  })
  const consentTargetHash = memoryProposalConsentTargetHashV2(target)
  if (!create && parseMemoryLifecycleHashV1(input.consentTargetHash) !== consentTargetHash) {
    return invalidMemoryValue()
  }
  const decision = create
    ? null
    : parseProposalDecision(input.decision, state, plannedMemoryId, intent, decisionCutoff)
  if ((state === 'pending') !== (decision === null) ||
    (decision !== null && Date.parse(decision.decidedAt) < Date.parse(proposedAt))) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    proposalId,
    revision,
    namespace,
    namespaceRef,
    namespaceGeneration,
    state,
    initiatedByActorRef,
    proposedBy,
    plannedMemoryId,
    intent,
    kind,
    text,
    sources,
    observedAt,
    proposedAt,
    confidence,
    sensitivity,
    conflict,
    suggestedRetention,
    retentionPolicyRef,
    consentRequirement,
    consentPolicyRef: policyBinding.policyRef,
    consentPolicyGeneration: policyBinding.policyGeneration,
    consentTargetHash,
    decision
  })
}

export function createMemoryProposalV2 (value: unknown): MemoryProposalV2 {
  return parseProposalFields(value, true)
}

export function parseMemoryProposalV2 (value: unknown): MemoryProposalV2 {
  return parseProposalFields(value, false)
}

export function memoryProposalDeadlineV2 (proposal: MemoryProposalV2): string {
  return addMemoryLifecycleDaysV1(
    parseMemoryProposalV2(proposal).proposedAt,
    MEMORY_PROPOSAL_DEADLINE_DAYS_V2
  )
}

export function memoryProposalFullWirePurgeAtV2 (proposalValue: unknown): string | null {
  const proposal = parseMemoryProposalV2(proposalValue)
  if (proposal.state === 'pending') return null
  if (proposal.state === 'expired') {
    return addMemoryLifecycleDaysV1(
      proposal.proposedAt,
      MEMORY_PROPOSAL_DEADLINE_DAYS_V2 + MEMORY_RETENTION_PURGE_GRACE_DAYS_V2
    )
  }
  return addMemoryLifecycleDaysV1(
    proposal.decision!.decidedAt,
    MEMORY_RETENTION_PURGE_GRACE_DAYS_V2
  )
}

export function isMemoryProposalFullWirePurgeEligibleV2 (
  proposalValue: unknown,
  freshNowValue: unknown
): boolean {
  const purgeAt = memoryProposalFullWirePurgeAtV2(proposalValue)
  if (purgeAt === null) return false
  return Date.parse(parseMemoryLifecycleInstantV1(freshNowValue)) >= Date.parse(purgeAt)
}

function assertCanonicalWireLimit<T> (value: T, maximumBytes: number): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) {
    return invalidMemoryValue()
  }
  return value
}

function consentEvidencePreimageV1 (
  value: Omit<MemoryConsentEvidenceV1, 'evidenceHash'>
): string {
  return JSON.stringify(value)
}

export function memoryConsentEvidenceHashV1 (
  value: Omit<MemoryConsentEvidenceV1, 'evidenceHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_CONSENT_EVIDENCE_HASH_DOMAIN_V1,
    consentEvidencePreimageV1(value)
  )
}

function parseConsentEvidenceFields (
  value: unknown,
  create: boolean
): MemoryConsentEvidenceV1 {
  const baseKeys = [
    'evidenceId', 'evidenceKind', 'namespaceRef', 'namespaceGeneration', 'proposalId',
    'proposalRevision', 'consentTargetHash', 'approvedByActorRef', 'approvedAt',
    'source', 'policyRef', 'policyGeneration'
  ]
  const input = inspectMemoryRecord(
    value,
    create ? baseKeys : ['schemaVersion', ...baseKeys, 'evidenceHash']
  )
  if (!create && input.schemaVersion !== 1) return invalidMemoryValue()
  const evidenceKind = enumValue(input.evidenceKind, CONSENT_STATES)
  const policyBinding = parseConsentPolicyBinding({
    requirement: evidenceKind,
    policyRef: input.policyRef,
    policyGeneration: input.policyGeneration
  })
  const approvedAt = parseMemoryLifecycleInstantV1(input.approvedAt)
  let source: MemorySourceV1 | null
  if (evidenceKind === 'explicit') {
    if (input.source === null) return invalidMemoryValue()
    source = parseMemorySourceV1(input.source)
    if (source.sourceKind !== 'current_message' || source.messageId === null ||
      Date.parse(source.observedAt) > Date.parse(approvedAt)) return invalidMemoryValue()
    validateSourceObservationTimes([source], approvedAt)
  } else {
    if (input.source !== null) return invalidMemoryValue()
    source = null
  }
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    evidenceId: parseMemoryLifecycleHashedRefV1(input.evidenceId, 'evidence:'),
    evidenceKind,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
    proposalId: parseMemoryLifecycleHashedRefV1(input.proposalId, 'proposal:'),
    proposalRevision: (() => {
      if (input.proposalRevision !== 1) return invalidMemoryValue()
      return 1 as const
    })(),
    consentTargetHash: parseMemoryLifecycleHashV1(input.consentTargetHash),
    approvedByActorRef: parseMemoryLifecycleHashedRefV1(
      input.approvedByActorRef,
      'actor:'
    ),
    approvedAt,
    source,
    policyRef: policyBinding.policyRef,
    policyGeneration: policyBinding.policyGeneration
  })
  const evidenceHash = memoryConsentEvidenceHashV1(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.evidenceHash) !== evidenceHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    evidenceHash
  }), MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes)
}

export function createMemoryConsentEvidenceV1 (value: unknown): MemoryConsentEvidenceV1 {
  return parseConsentEvidenceFields(value, true)
}

export function parseMemoryConsentEvidenceV1 (value: unknown): MemoryConsentEvidenceV1 {
  return parseConsentEvidenceFields(value, false)
}

export function assertMemoryConsentEvidenceForProposalV1 (
  proposalValue: unknown,
  evidenceValue: unknown
): MemoryConsentEvidenceV1 {
  const proposal = parseMemoryProposalV2(proposalValue)
  const evidence = parseMemoryConsentEvidenceV1(evidenceValue)
  const proposalDeadline = memoryProposalDeadlineV2(proposal)
  const approvalCutoff = Date.parse(proposalDeadline) <
    Date.parse(proposal.suggestedRetention.validUntil)
    ? proposalDeadline
    : proposal.suggestedRetention.validUntil
  if (proposal.state !== 'pending' || proposal.revision !== 1 ||
    evidence.namespaceRef !== proposal.namespaceRef ||
    evidence.namespaceGeneration !== proposal.namespaceGeneration ||
    evidence.proposalId !== proposal.proposalId ||
    evidence.consentTargetHash !== proposal.consentTargetHash ||
    evidence.evidenceKind !== proposal.consentRequirement ||
    evidence.policyRef !== proposal.consentPolicyRef ||
    evidence.policyGeneration !== proposal.consentPolicyGeneration ||
    Date.parse(evidence.approvedAt) < Date.parse(proposal.proposedAt) ||
    Date.parse(evidence.approvedAt) >= Date.parse(approvalCutoff)) {
    return invalidMemoryValue()
  }
  return evidence
}

function parseApprovedConsent (value: unknown): ApprovedMemoryConsentV2 {
  const input = inspectMemoryRecord(value, [
    'state', 'approvedByActorRef', 'approvedAt', 'consentTargetHash', 'evidenceId',
    'evidenceHash', 'policyRef', 'policyGeneration'
  ])
  const state = enumValue(input.state, CONSENT_STATES)
  const policyBinding = parseConsentPolicyBinding({
    requirement: state,
    policyRef: input.policyRef,
    policyGeneration: input.policyGeneration
  })
  return Object.freeze({
    state,
    approvedByActorRef: parseMemoryLifecycleHashedRefV1(
      input.approvedByActorRef,
      'actor:'
    ),
    approvedAt: parseMemoryLifecycleInstantV1(input.approvedAt),
    consentTargetHash: parseMemoryLifecycleHashV1(input.consentTargetHash),
    evidenceId: parseMemoryLifecycleHashedRefV1(input.evidenceId, 'evidence:'),
    evidenceHash: parseMemoryLifecycleHashV1(input.evidenceHash),
    policyRef: policyBinding.policyRef,
    policyGeneration: policyBinding.policyGeneration
  })
}

function recordContentPreimageV2 (
  value: Omit<MemoryRecordV2, 'contentHash'>
): string {
  return JSON.stringify(value)
}

export function memoryRecordContentHashV2 (
  value: Omit<MemoryRecordV2, 'contentHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_RECORD_CONTENT_HASH_DOMAIN_V2,
    recordContentPreimageV2(value)
  )
}

function parseRecordFields (value: unknown, create: boolean): MemoryRecordV2 {
  const baseKeys = [
    'memoryId', 'revision', 'namespace', 'namespaceGeneration', 'kind', 'text', 'sources',
    'createdAt', 'observedAt', 'confirmedAt', 'updatedAt', 'validity', 'confidence',
    'consent', 'sensitivity', 'conflict', 'supersedes', 'retention',
    'retentionPolicyRef', 'deletionState'
  ]
  const input = inspectMemoryRecord(
    value,
    create
      ? baseKeys
      : ['schemaVersion', 'memoryId', 'revision', 'namespace', 'namespaceRef',
          ...baseKeys.slice(3), 'contentHash']
  )
  if (!create && input.schemaVersion !== 2) return invalidMemoryValue()
  const memoryId = parseMemoryLifecycleHashedRefV1(input.memoryId, 'memory:')
  const revision = parseMemoryLifecyclePositiveIntegerV1(
    input.revision,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
  )
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const namespaceRef = memoryNamespaceRefV1(namespace)
  if (!create && parseMemoryNamespaceRefV1(input.namespaceRef) !== namespaceRef) {
    return invalidMemoryValue()
  }
  const namespaceGeneration = parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration)
  const kind = enumValue(input.kind, MEMORY_KINDS)
  const text = parseCanonicalText(input.text)
  const sources = parseSources(input.sources)
  const createdAt = parseMemoryLifecycleInstantV1(input.createdAt)
  const observedAt = parseMemoryLifecycleInstantV1(input.observedAt)
  const confirmedAt = parseMemoryLifecycleInstantV1(input.confirmedAt)
  const updatedAt = parseMemoryLifecycleInstantV1(input.updatedAt)
  if (Date.parse(observedAt) > Date.parse(createdAt) ||
    Date.parse(createdAt) > Date.parse(confirmedAt) ||
    Date.parse(confirmedAt) > Date.parse(updatedAt)) return invalidMemoryValue()
  validateSourceObservationTimes(sources, createdAt)
  const validity = parseValidity(input.validity)
  if (validity.validFrom !== null && Date.parse(validity.validFrom) > Date.parse(updatedAt)) {
    return invalidMemoryValue()
  }
  const confidence = parseConfidence(input.confidence)
  const consent = parseApprovedConsent(input.consent)
  if (consent.approvedAt !== confirmedAt) return invalidMemoryValue()
  const sensitivity = enumValue(input.sensitivity, MEMORY_SENSITIVITIES)
  const conflict = parseConflict(input.conflict, memoryId)
  const supersedes = parseUniqueHashedRefs(
    input.supersedes,
    MEMORY_RESOURCE_LIMITS.supersedesRefs,
    'memory:'
  )
  if (supersedes.includes(memoryId)) return invalidMemoryValue()
  const retention = parseRetentionWithGrace(input.retention)
  if (Date.parse(retention.validUntil) <= Date.parse(confirmedAt)) return invalidMemoryValue()
  const retentionPolicyRef = parseRetentionPolicyRef(input.retentionPolicyRef)
  if (input.deletionState !== 'active') return invalidMemoryValue()
  validateNamespaceContent(namespace, consent.state, kind, sensitivity, sources)
  const withoutHash = Object.freeze({
    schemaVersion: 2 as const,
    memoryId,
    revision,
    namespace,
    namespaceRef,
    namespaceGeneration,
    kind,
    text,
    sources,
    createdAt,
    observedAt,
    confirmedAt,
    updatedAt,
    validity,
    confidence,
    consent,
    sensitivity,
    conflict,
    supersedes,
    retention,
    retentionPolicyRef,
    deletionState: 'active' as const
  })
  const contentHash = memoryRecordContentHashV2(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.contentHash) !== contentHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    contentHash
  }), MEMORY_RESOURCE_LIMITS.recordWireBytes)
}

export function createMemoryRecordV2 (value: unknown): MemoryRecordV2 {
  return parseRecordFields(value, true)
}

export function parseMemoryRecordV2 (value: unknown): MemoryRecordV2 {
  return parseRecordFields(value, false)
}

export function assertMemoryRecordApprovalBindingV2 (
  proposalValue: unknown,
  evidenceValue: unknown,
  recordValue: unknown
): MemoryRecordV2 {
  const proposal = parseMemoryProposalV2(proposalValue)
  const evidence = assertMemoryConsentEvidenceForProposalV1(proposal, evidenceValue)
  const record = parseMemoryRecordV2(recordValue)
  if (proposal.intent.kind !== 'create' || record.revision !== 1 ||
    record.memoryId !== proposal.plannedMemoryId ||
    record.namespaceRef !== proposal.namespaceRef ||
    record.namespaceGeneration !== proposal.namespaceGeneration ||
    record.kind !== proposal.kind || record.text !== proposal.text ||
    JSON.stringify(record.sources) !== JSON.stringify(proposal.sources) ||
    record.observedAt !== proposal.observedAt || record.createdAt !== proposal.proposedAt ||
    record.confirmedAt !== evidence.approvedAt || record.updatedAt !== evidence.approvedAt ||
    record.confidence !== proposal.confidence || record.sensitivity !== proposal.sensitivity ||
    JSON.stringify(record.conflict) !== JSON.stringify(proposal.conflict) ||
    JSON.stringify(record.retention) !== JSON.stringify(proposal.suggestedRetention) ||
    record.retentionPolicyRef !== proposal.retentionPolicyRef ||
    record.consent.state !== proposal.consentRequirement ||
    record.consent.approvedByActorRef !== evidence.approvedByActorRef ||
    record.consent.approvedAt !== evidence.approvedAt ||
    record.consent.consentTargetHash !== proposal.consentTargetHash ||
    record.consent.evidenceId !== evidence.evidenceId ||
    record.consent.evidenceHash !== evidence.evidenceHash ||
    record.consent.policyRef !== evidence.policyRef ||
    record.consent.policyGeneration !== evidence.policyGeneration ||
    record.validity.state !== 'current' || record.validity.validFrom !== proposal.observedAt ||
    record.supersedes.length !== 0) return invalidMemoryValue()
  return record
}

function revisionEvidencePreimageV1 (
  value: Omit<MemoryRevisionEvidenceV1, 'evidenceHash'>
): string {
  return JSON.stringify(value)
}

export function memoryRevisionEvidenceHashV1 (
  value: Omit<MemoryRevisionEvidenceV1, 'evidenceHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_REVISION_EVIDENCE_HASH_DOMAIN_V1,
    revisionEvidencePreimageV1(value)
  )
}

function parseRevisionEvidenceFields (
  value: unknown,
  create: boolean
): MemoryRevisionEvidenceV1 {
  const baseKeys = [
    'evidenceId', 'evidenceKind', 'namespaceRef', 'namespaceGeneration', 'memoryId',
    'revision', 'operation', 'baseRevisionHash', 'revisionTargetHash',
    'changedByActorRef', 'changedAt', 'source', 'policyRef', 'policyGeneration'
  ]
  const input = inspectMemoryRecord(
    value,
    create ? baseKeys : ['schemaVersion', ...baseKeys, 'evidenceHash']
  )
  if (!create && input.schemaVersion !== 1) return invalidMemoryValue()
  const evidenceKind = enumValue(input.evidenceKind, CONSENT_STATES)
  const policyBinding = parseConsentPolicyBinding({
    requirement: evidenceKind,
    policyRef: input.policyRef,
    policyGeneration: input.policyGeneration
  })
  const changedAt = parseMemoryLifecycleInstantV1(input.changedAt)
  let source: MemorySourceV1 | null
  if (evidenceKind === 'explicit') {
    if (input.source === null) return invalidMemoryValue()
    source = parseMemorySourceV1(input.source)
    if (!['current_message', 'manual_correction'].includes(source.sourceKind) ||
      Date.parse(source.observedAt) > Date.parse(changedAt)) return invalidMemoryValue()
    validateSourceObservationTimes([source], changedAt)
  } else {
    if (input.source !== null) return invalidMemoryValue()
    source = null
  }
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    evidenceId: parseMemoryLifecycleHashedRefV1(input.evidenceId, 'evidence:'),
    evidenceKind,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
    memoryId: parseMemoryLifecycleHashedRefV1(input.memoryId, 'memory:'),
    revision: parseMemoryLifecyclePositiveIntegerV1(
      input.revision,
      MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
    ),
    operation: enumValue(input.operation, REVISION_EVIDENCE_OPERATIONS),
    baseRevisionHash: parseMemoryLifecycleHashV1(input.baseRevisionHash),
    revisionTargetHash: parseMemoryLifecycleHashV1(input.revisionTargetHash),
    changedByActorRef: parseMemoryLifecycleHashedRefV1(input.changedByActorRef, 'actor:'),
    changedAt,
    source,
    policyRef: policyBinding.policyRef,
    policyGeneration: policyBinding.policyGeneration
  })
  if (withoutHash.revision < 2 || withoutHash.baseRevisionHash === withoutHash.revisionTargetHash) {
    return invalidMemoryValue()
  }
  const evidenceHash = memoryRevisionEvidenceHashV1(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.evidenceHash) !== evidenceHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    evidenceHash
  }), MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes)
}

export function createMemoryRevisionEvidenceV1 (value: unknown): MemoryRevisionEvidenceV1 {
  return parseRevisionEvidenceFields(value, true)
}

export function parseMemoryRevisionEvidenceV1 (value: unknown): MemoryRevisionEvidenceV1 {
  return parseRevisionEvidenceFields(value, false)
}

function parseRevisionEvidenceRef (
  value: unknown,
  operation: MemoryRevisionOperationV2
): MemoryRevisionEvidenceRefV1 {
  const input = inspectMemoryRecord(value, ['kind', 'evidenceId', 'evidenceHash'])
  const kind = enumValue(input.kind, ['consent', 'revision'] as const)
  if ((operation === 'created') !== (kind === 'consent')) return invalidMemoryValue()
  return Object.freeze({
    kind,
    evidenceId: parseMemoryLifecycleHashedRefV1(input.evidenceId, 'evidence:'),
    evidenceHash: parseMemoryLifecycleHashV1(input.evidenceHash)
  })
}

function revisionPreimageV2 (value: Omit<MemoryRevisionV2, 'revisionHash'>): string {
  return JSON.stringify(value)
}

export function memoryRevisionHashV2 (
  value: Omit<MemoryRevisionV2, 'revisionHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_REVISION_HASH_DOMAIN_V2,
    revisionPreimageV2(value)
  )
}

function parseRevisionFields (value: unknown, create: boolean): MemoryRevisionV2 {
  const baseKeys = [
    'memoryId', 'revision', 'operation', 'record', 'changedByActorRef', 'changedAt',
    'reason', 'evidence', 'previousRevisionHash'
  ]
  const input = inspectMemoryRecord(
    value,
    create ? baseKeys : ['schemaVersion', ...baseKeys, 'revisionHash']
  )
  if (!create && input.schemaVersion !== 2) return invalidMemoryValue()
  const memoryId = parseMemoryLifecycleHashedRefV1(input.memoryId, 'memory:')
  const revision = parseMemoryLifecyclePositiveIntegerV1(
    input.revision,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
  )
  const operation = enumValue(input.operation, REVISION_OPERATIONS)
  if ((operation === 'created' && revision !== 1) ||
    (operation !== 'created' && revision < 2)) return invalidMemoryValue()
  const record = parseMemoryRecordV2(input.record)
  if (record.memoryId !== memoryId || record.revision !== revision) return invalidMemoryValue()
  const changedAt = parseMemoryLifecycleInstantV1(input.changedAt)
  if (changedAt !== record.updatedAt) return invalidMemoryValue()
  const previousRevisionHash = input.previousRevisionHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.previousRevisionHash)
  if ((operation === 'created') !== (previousRevisionHash === null)) return invalidMemoryValue()
  const withoutHash = Object.freeze({
    schemaVersion: 2 as const,
    memoryId,
    revision,
    operation,
    record,
    changedByActorRef: parseMemoryLifecycleHashedRefV1(
      input.changedByActorRef,
      'actor:'
    ),
    changedAt,
    reason: parseReason(input.reason),
    evidence: parseRevisionEvidenceRef(input.evidence, operation),
    previousRevisionHash
  })
  if (operation === 'created' && (
    withoutHash.changedByActorRef !== record.consent.approvedByActorRef ||
    withoutHash.changedAt !== record.consent.approvedAt ||
    withoutHash.evidence.evidenceId !== record.consent.evidenceId ||
    withoutHash.evidence.evidenceHash !== record.consent.evidenceHash
  )) return invalidMemoryValue()
  const revisionHash = memoryRevisionHashV2(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.revisionHash) !== revisionHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    revisionHash
  }), MEMORY_RESOURCE_LIMITS.revisionWireBytes)
}

export function createMemoryRevisionV2 (value: unknown): MemoryRevisionV2 {
  return parseRevisionFields(value, true)
}

export function parseMemoryRevisionV2 (value: unknown): MemoryRevisionV2 {
  return parseRevisionFields(value, false)
}

export function assertMemoryCreateApprovalResultBindingV2 (
  approvedProposalValue: unknown,
  evidenceValue: unknown,
  recordValue: unknown,
  revisionValue: unknown
): MemoryCreateApprovalResultV2 {
  const proposal = parseMemoryProposalV2(approvedProposalValue)
  if (proposal.state !== 'approved' || proposal.revision !== 2 ||
    proposal.intent.kind !== 'create' || proposal.decision === null) {
    return invalidMemoryValue()
  }
  const pending = parseMemoryProposalV2({
    ...proposal,
    revision: 1,
    state: 'pending',
    decision: null
  })
  const consentEvidence = assertMemoryConsentEvidenceForProposalV1(pending, evidenceValue)
  const record = assertMemoryRecordApprovalBindingV2(pending, consentEvidence, recordValue)
  const revision = parseMemoryRevisionV2(revisionValue)
  const decision = proposal.decision
  if (revision.operation !== 'created' || revision.revision !== 1 ||
    revision.memoryId !== record.memoryId ||
    JSON.stringify(revision.record) !== JSON.stringify(record) ||
    revision.changedByActorRef !== consentEvidence.approvedByActorRef ||
    revision.changedAt !== consentEvidence.approvedAt ||
    revision.evidence.kind !== 'consent' ||
    revision.evidence.evidenceId !== consentEvidence.evidenceId ||
    revision.evidence.evidenceHash !== consentEvidence.evidenceHash ||
    decision.decidedAt !== consentEvidence.approvedAt ||
    decision.decidedByActorRef !== consentEvidence.approvedByActorRef ||
    decision.consentEvidenceId !== consentEvidence.evidenceId ||
    decision.consentEvidenceHash !== consentEvidence.evidenceHash ||
    decision.resultingMemoryId !== record.memoryId ||
    decision.resultingMemoryRevision !== 1 ||
    decision.resultingRevisionHash !== revision.revisionHash ||
    decision.reason !== revision.reason) return invalidMemoryValue()
  return Object.freeze({ proposal, consentEvidence, record, revision })
}

export function assertMemoryRevisionEvidenceBindingV1 (
  evidenceValue: unknown,
  revisionValue: unknown
): MemoryRevisionEvidenceV1 {
  const evidence = parseMemoryRevisionEvidenceV1(evidenceValue)
  const revision = parseMemoryRevisionV2(revisionValue)
  if (revision.operation === 'created' || evidence.memoryId !== revision.memoryId ||
    evidence.revision !== revision.revision || evidence.operation !== revision.operation ||
    evidence.changedByActorRef !== revision.changedByActorRef ||
    evidence.changedAt !== revision.changedAt ||
    evidence.baseRevisionHash !== revision.previousRevisionHash ||
    evidence.revisionTargetHash !== revision.record.contentHash ||
    evidence.evidenceId !== revision.evidence.evidenceId ||
    evidence.evidenceHash !== revision.evidence.evidenceHash) return invalidMemoryValue()
  return evidence
}

function parseMigrationRevisionBindings (
  value: unknown
): readonly MemoryV1ToV2RevisionEvidenceBindingV1[] {
  const bindings = inspectMemoryArray(
    value,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationRevisionBindings
  ).map(item => {
    const input = inspectMemoryRecord(item, ['revision', 'evidenceId', 'evidenceHash'])
    return Object.freeze({
      revision: parseMemoryLifecyclePositiveIntegerV1(
        input.revision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      ),
      evidenceId: parseMemoryLifecycleHashedRefV1(input.evidenceId, 'evidence:'),
      evidenceHash: parseMemoryLifecycleHashV1(input.evidenceHash)
    })
  })
  if (new Set(bindings.map(binding => binding.revision)).size !== bindings.length ||
    new Set(bindings.map(binding => binding.evidenceId)).size !== bindings.length) {
    return invalidMemoryValue()
  }
  return Object.freeze(bindings)
}

function parseLegacyRevisionWires (
  value: unknown
): readonly MemoryV1ToV2LegacyRevisionWireV1[] {
  const wires = inspectMemoryArray(
    value,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
  ).map(item => {
    const input = inspectMemoryRecord(item, ['revision', 'legacyWireHash'])
    return Object.freeze({
      revision: parseMemoryLifecyclePositiveIntegerV1(
        input.revision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      ),
      legacyWireHash: parseMemoryLifecycleHashV1(input.legacyWireHash)
    })
  })
  if (new Set(wires.map(wire => wire.revision)).size !== wires.length ||
    new Set(wires.map(wire => wire.legacyWireHash)).size !== wires.length ||
    wires.some((wire, index) => wire.revision !== index + 1)) {
    return invalidMemoryValue()
  }
  return Object.freeze(wires)
}

function parseMigrationAggregate (value: unknown): MemoryV1ToV2AggregateV1 {
  const discriminator = inspectMemoryRecord(value, ['kind'], [
    'aggregateId', 'proposalState', 'proposalRevision', 'currentRevision',
    'legacyProposalWireHashes', 'legacyRevisionWires'
  ])
  if (discriminator.kind === 'proposal') {
    const input = inspectMemoryRecord(value, [
      'kind', 'aggregateId', 'proposalState', 'proposalRevision',
      'legacyProposalWireHashes', 'legacyRevisionWires'
    ])
    const proposalState = enumValue(input.proposalState, LEGACY_STANDALONE_PROPOSAL_STATES)
    const proposalRevision = parseMemoryLifecyclePositiveIntegerV1(input.proposalRevision, 2)
    if ((proposalState === 'pending' && proposalRevision !== 1) ||
      (proposalState !== 'pending' && proposalRevision !== 2)) return invalidMemoryValue()
    const proposalHashes = parseUniqueHashes(input.legacyProposalWireHashes, 2)
    const revisionWires = parseLegacyRevisionWires(input.legacyRevisionWires)
    if (proposalHashes.length !== proposalRevision || revisionWires.length !== 0) {
      return invalidMemoryValue()
    }
    return Object.freeze({
      kind: 'proposal' as const,
      aggregateId: parseMemoryLifecycleHashedRefV1(input.aggregateId, 'proposal:'),
      proposalState,
      proposalRevision: proposalRevision as 1 | 2,
      legacyProposalWireHashes: proposalHashes,
      legacyRevisionWires: revisionWires
    })
  }
  if (discriminator.kind === 'memory') {
    const input = inspectMemoryRecord(value, [
      'kind', 'aggregateId', 'proposalState', 'proposalRevision', 'currentRevision',
      'legacyProposalWireHashes', 'legacyRevisionWires'
    ])
    if (input.proposalState !== 'approved' || input.proposalRevision !== 2) {
      return invalidMemoryValue()
    }
    const currentRevision = parseMemoryLifecyclePositiveIntegerV1(
      input.currentRevision,
      MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
    )
    const proposalHashes = parseUniqueHashes(input.legacyProposalWireHashes, 2)
    const revisionWires = parseLegacyRevisionWires(input.legacyRevisionWires)
    if (proposalHashes.length !== 2 || revisionWires.length !== currentRevision) {
      return invalidMemoryValue()
    }
    return Object.freeze({
      kind: 'memory' as const,
      aggregateId: parseMemoryLifecycleHashedRefV1(input.aggregateId, 'memory:'),
      proposalState: 'approved' as const,
      proposalRevision: 2 as const,
      currentRevision,
      legacyProposalWireHashes: proposalHashes,
      legacyRevisionWires: revisionWires
    })
  }
  return invalidMemoryValue()
}

function migrationManifestIdV1 (value: {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly aggregate: MemoryV1ToV2AggregateV1
}): string {
  return `manifest:${memoryLifecycleDomainHashV1(
    MEMORY_V1_TO_V2_MANIFEST_ID_DOMAIN_V1,
    JSON.stringify({
      namespaceRef: value.namespaceRef,
      namespaceGeneration: value.namespaceGeneration,
      aggregate: value.aggregate
    })
  )}`
}

function migrationManifestHashV1 (
  value: Omit<MemoryV1ToV2AggregateManifestV1, 'manifestHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_V1_TO_V2_MANIFEST_HASH_DOMAIN_V1,
    JSON.stringify(value)
  )
}

function parseMigrationManifestFields (
  value: unknown,
  create: boolean
): MemoryV1ToV2AggregateManifestV1 {
  const baseKeys = [
    'namespaceRef', 'namespaceGeneration', 'aggregate', 'initiatedByActorRef',
    'plannedMemoryId', 'intent', 'consentEvidenceId', 'consentEvidenceHash',
    'revisionEvidenceBindings'
  ]
  const input = inspectMemoryRecord(
    value,
    create ? baseKeys : ['schemaVersion', 'manifestId', ...baseKeys, 'manifestHash']
  )
  if (!create && input.schemaVersion !== 1) return invalidMemoryValue()
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration)
  const aggregate = parseMigrationAggregate(input.aggregate)
  const initiatedByActorRef = parseMemoryLifecycleHashedRefV1(
    input.initiatedByActorRef,
    'actor:'
  )
  const plannedMemoryId = parseMemoryLifecycleHashedRefV1(input.plannedMemoryId, 'memory:')
  const intent = parseMemoryProposalIntentV2(input.intent)
  if (intent.kind === 'correction' && plannedMemoryId !== intent.targetMemoryId) {
    return invalidMemoryValue()
  }
  if (aggregate.kind === 'memory' && aggregate.aggregateId !== plannedMemoryId) {
    return invalidMemoryValue()
  }
  const consentEvidenceId = input.consentEvidenceId === null
    ? null
    : parseMemoryLifecycleHashedRefV1(input.consentEvidenceId, 'evidence:')
  const consentEvidenceHash = input.consentEvidenceHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.consentEvidenceHash)
  if ((consentEvidenceId === null) !== (consentEvidenceHash === null)) {
    return invalidMemoryValue()
  }
  const requiresConsent = aggregate.kind === 'memory'
  if (requiresConsent !== (consentEvidenceId !== null)) return invalidMemoryValue()
  const revisionEvidenceBindings = parseMigrationRevisionBindings(
    input.revisionEvidenceBindings
  )
  if (aggregate.kind === 'proposal') {
    if (revisionEvidenceBindings.length !== 0) return invalidMemoryValue()
  } else {
    const expectedRevisions = Array.from(
      { length: Math.max(0, aggregate.currentRevision - 1) },
      (_, index) => index + 2
    )
    if (revisionEvidenceBindings.length !== expectedRevisions.length ||
      revisionEvidenceBindings.some((binding, index) =>
        binding.revision !== expectedRevisions[index])) return invalidMemoryValue()
  }
  const idInput = Object.freeze({ namespaceRef, namespaceGeneration, aggregate })
  const manifestId = migrationManifestIdV1(idInput)
  if (!create && parseMemoryLifecycleHashedRefV1(input.manifestId, 'manifest:') !== manifestId) {
    return invalidMemoryValue()
  }
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    manifestId,
    namespaceRef,
    namespaceGeneration,
    aggregate,
    initiatedByActorRef,
    plannedMemoryId,
    intent,
    consentEvidenceId,
    consentEvidenceHash,
    revisionEvidenceBindings
  })
  const manifestHash = migrationManifestHashV1(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.manifestHash) !== manifestHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    manifestHash
  }), MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes)
}

export function createMemoryV1ToV2AggregateManifestV1 (
  value: unknown
): MemoryV1ToV2AggregateManifestV1 {
  return parseMigrationManifestFields(value, true)
}

export function parseMemoryV1ToV2AggregateManifestV1 (
  value: unknown
): MemoryV1ToV2AggregateManifestV1 {
  return parseMigrationManifestFields(value, false)
}

function parseManifestExpectation (
  value: unknown
): MemoryV1ToV2ManifestExpectationV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef', 'namespaceGeneration', 'aggregateKind', 'aggregateId',
    'proposalState', 'proposalRevision', 'currentRevision',
    'legacyProposalWireHashes', 'legacyRevisionWires'
  ])
  const aggregateKind = enumValue(input.aggregateKind, ['proposal', 'memory'] as const)
  const proposalState = enumValue(input.proposalState, LEGACY_PROPOSAL_STATES)
  const proposalRevision = parseMemoryLifecyclePositiveIntegerV1(input.proposalRevision, 2)
  const currentRevision = input.currentRevision === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(
        input.currentRevision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      )
  if ((proposalState === 'pending' && proposalRevision !== 1) ||
    (proposalState !== 'pending' && proposalRevision !== 2) ||
    (aggregateKind === 'proposal' && currentRevision !== null) ||
    (aggregateKind === 'proposal' && proposalState === 'approved') ||
    (aggregateKind === 'memory' && (
      proposalState !== 'approved' || proposalRevision !== 2 || currentRevision === null
    ))) return invalidMemoryValue()
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
    aggregateKind,
    aggregateId: parseMemoryLifecycleHashedRefV1(
      input.aggregateId,
      aggregateKind === 'proposal' ? 'proposal:' : 'memory:'
    ),
    proposalState,
    proposalRevision: proposalRevision as 1 | 2,
    currentRevision,
    legacyProposalWireHashes: parseUniqueHashes(input.legacyProposalWireHashes, 2),
    legacyRevisionWires: parseLegacyRevisionWires(input.legacyRevisionWires)
  })
}

export function requireMemoryV1ToV2AggregateManifestV1 (
  legacyAggregateCountValue: unknown,
  manifestValue: unknown,
  expectationValue: unknown
): MemoryV1ToV2AggregateManifestV1 | null {
  const legacyAggregateCount = parseMemoryLifecycleNonNegativeIntegerV1(
    legacyAggregateCountValue,
    1
  )
  if (legacyAggregateCount === 0) {
    if (manifestValue !== null || expectationValue !== null) return invalidMemoryValue()
    return null
  }
  if (manifestValue === null || expectationValue === null) return invalidMemoryValue()
  const manifest = parseMemoryV1ToV2AggregateManifestV1(manifestValue)
  const expectation = parseManifestExpectation(expectationValue)
  if (manifest.namespaceRef !== expectation.namespaceRef ||
    manifest.namespaceGeneration !== expectation.namespaceGeneration ||
    manifest.aggregate.kind !== expectation.aggregateKind ||
    manifest.aggregate.aggregateId !== expectation.aggregateId ||
    manifest.aggregate.proposalState !== expectation.proposalState ||
    manifest.aggregate.proposalRevision !== expectation.proposalRevision ||
    (manifest.aggregate.kind === 'memory'
      ? manifest.aggregate.currentRevision
      : null) !== expectation.currentRevision ||
    JSON.stringify(manifest.aggregate.legacyProposalWireHashes) !==
      JSON.stringify(expectation.legacyProposalWireHashes) ||
    JSON.stringify(manifest.aggregate.legacyRevisionWires) !==
      JSON.stringify(expectation.legacyRevisionWires)) return invalidMemoryValue()
  return manifest
}

function auditIdV1 (value: {
  readonly commandRefHash: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly operation: MemoryLifecycleAuditV1['operation']
  readonly aggregateRefHash: string
}): string {
  return `audit:${memoryLifecycleDomainHashV1(
    MEMORY_LIFECYCLE_AUDIT_ID_DOMAIN_V1,
    `${value.commandRefHash}\0${value.namespaceRef}\0${value.namespaceGeneration}\0` +
      `${value.operation}\0${value.aggregateRefHash}`
  )}`
}

function auditReceiptHashV1 (
  value: Omit<MemoryLifecycleAuditV1, 'receiptHash' | 'expiresAt'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_LIFECYCLE_AUDIT_HASH_DOMAIN_V1,
    JSON.stringify(value)
  )
}

function parseAuditFields (value: unknown, create: boolean): MemoryLifecycleAuditV1 {
  const baseKeys = [
    'namespaceRef', 'namespaceGeneration', 'operation', 'commandRefHash',
    'aggregateKind', 'aggregateRefHash', 'authorizedByActorRefHash',
    'executedByActorRefHash', 'sourceCommittedAt', 'recordedAt', 'outcome',
    'repositoryReceiptHash', 'priorRevision', 'nextRevision', 'exclusionsHash'
  ]
  const input = inspectMemoryRecord(
    value,
    create ? baseKeys : ['schemaVersion', 'auditId', ...baseKeys, 'receiptHash', 'expiresAt']
  )
  if (!create && input.schemaVersion !== 1) return invalidMemoryValue()
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration)
  const operation = enumValue(input.operation, [
    'proposal_pruned', 'export_prepared', 'export_completed', 'export_failed'
  ] as const)
  const commandRefHash = parseMemoryLifecycleHashV1(input.commandRefHash)
  const aggregateKind = enumValue(
    input.aggregateKind,
    ['proposal', 'record', 'namespace', 'export'] as const
  )
  const aggregateRefHash = parseMemoryLifecycleHashV1(input.aggregateRefHash)
  const sourceCommittedAt = parseMemoryLifecycleInstantV1(input.sourceCommittedAt)
  const recordedAt = parseMemoryLifecycleInstantV1(input.recordedAt)
  if (sourceCommittedAt !== recordedAt) return invalidMemoryValue()
  const outcome = enumValue(input.outcome, [
    'pruned', 'prepared', 'completed', 'snapshot_changed', 'failed_aborted',
    'failed_corrupt', 'failed_capacity', 'failed_unavailable'
  ] as const)
  const validOutcome = operation === 'proposal_pruned'
    ? aggregateKind === 'proposal' && outcome === 'pruned'
    : operation === 'export_prepared'
      ? aggregateKind === 'export' && outcome === 'prepared'
      : operation === 'export_completed'
        ? aggregateKind === 'export' && outcome === 'completed'
        : aggregateKind === 'export' && [
            'snapshot_changed', 'failed_aborted', 'failed_corrupt',
            'failed_capacity', 'failed_unavailable'
          ].includes(outcome)
  if (!validOutcome) return invalidMemoryValue()
  const repositoryReceiptHash = input.repositoryReceiptHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.repositoryReceiptHash)
  const priorRevision = input.priorRevision === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(input.priorRevision)
  const nextRevision = input.nextRevision === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(input.nextRevision)
  const exclusionsHash = input.exclusionsHash === null
    ? null
    : parseMemoryLifecycleHashV1(input.exclusionsHash)
  if ((operation === 'proposal_pruned' && (priorRevision === null || nextRevision !== null ||
    exclusionsHash !== null)) ||
    (operation !== 'proposal_pruned' && (priorRevision !== null || nextRevision !== null))) {
    return invalidMemoryValue()
  }
  const auditId = auditIdV1({
    commandRefHash,
    namespaceRef,
    namespaceGeneration,
    operation,
    aggregateRefHash
  })
  if (!create && parseMemoryLifecycleHashedRefV1(input.auditId, 'audit:') !== auditId) {
    return invalidMemoryValue()
  }
  const expiresAt = addMemoryLifecycleDaysV1(
    recordedAt,
    MEMORY_LIFECYCLE_AUDIT_RETENTION_DAYS_V1
  )
  if (!create && parseMemoryLifecycleInstantV1(input.expiresAt) !== expiresAt) {
    return invalidMemoryValue()
  }
  const hashInput = Object.freeze({
    schemaVersion: 1 as const,
    auditId,
    namespaceRef,
    namespaceGeneration,
    operation,
    commandRefHash,
    aggregateKind,
    aggregateRefHash,
    authorizedByActorRefHash: parseMemoryLifecycleHashV1(input.authorizedByActorRefHash),
    executedByActorRefHash: parseMemoryLifecycleHashV1(input.executedByActorRefHash),
    sourceCommittedAt,
    recordedAt,
    outcome,
    repositoryReceiptHash,
    priorRevision,
    nextRevision,
    exclusionsHash
  })
  const receiptHash = auditReceiptHashV1(hashInput)
  if (!create && parseMemoryLifecycleHashV1(input.receiptHash) !== receiptHash) {
    return invalidMemoryValue()
  }
  const result = Object.freeze({
    schemaVersion: hashInput.schemaVersion,
    auditId: hashInput.auditId,
    namespaceRef: hashInput.namespaceRef,
    namespaceGeneration: hashInput.namespaceGeneration,
    operation: hashInput.operation,
    commandRefHash: hashInput.commandRefHash,
    aggregateKind: hashInput.aggregateKind,
    aggregateRefHash: hashInput.aggregateRefHash,
    authorizedByActorRefHash: hashInput.authorizedByActorRefHash,
    executedByActorRefHash: hashInput.executedByActorRefHash,
    sourceCommittedAt: hashInput.sourceCommittedAt,
    recordedAt: hashInput.recordedAt,
    outcome: hashInput.outcome,
    repositoryReceiptHash: hashInput.repositoryReceiptHash,
    priorRevision: hashInput.priorRevision,
    nextRevision: hashInput.nextRevision,
    exclusionsHash: hashInput.exclusionsHash,
    receiptHash,
    expiresAt
  })
  return assertCanonicalWireLimit(
    result,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes
  )
}

export function createMemoryLifecycleAuditV1 (value: unknown): MemoryLifecycleAuditV1 {
  return parseAuditFields(value, true)
}

export function parseMemoryLifecycleAuditV1 (value: unknown): MemoryLifecycleAuditV1 {
  return parseAuditFields(value, false)
}

function deletionRefV1 (value: {
  readonly commandRefHash: string
  readonly operation: DeletionMutationReceiptV1['operation']
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly deletingGeneration: number
  readonly memoryId: string | null
}): string {
  return `deletion:${memoryLifecycleDomainHashV1(
    MEMORY_DELETION_REF_DOMAIN_V1,
    JSON.stringify(value)
  )}`
}

function deletionTombstoneIdV1 (deletionRef: string): string {
  return `tombstone:${memoryLifecycleDomainHashV1(
    MEMORY_DELETION_TOMBSTONE_ID_DOMAIN_V1,
    deletionRef
  )}`
}

function deletionReceiptHashV1 (
  value: Omit<DeletionMutationReceiptV1, 'receiptHash'>
): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_DELETION_RECEIPT_HASH_DOMAIN_V1,
    JSON.stringify(value)
  )
}

function parseDeletionReceiptFields (
  value: unknown,
  create: boolean
): DeletionMutationReceiptV1 {
  const baseKeys = [
    'commandRefHash', 'operation', 'repositoryReceiptHash', 'namespaceRef',
    'generationBefore', 'generationAfter', 'deletingGeneration', 'memoryId',
    'deletedRevision', 'committedAt', 'tombstoneReceiptHash'
  ]
  const input = inspectMemoryRecord(
    value,
    create
      ? baseKeys
      : [
          'schemaVersion', 'deletionRef', 'commandRefHash', 'operation',
          'repositoryReceiptHash', 'namespaceRef', 'generationBefore', 'generationAfter',
          'deletingGeneration', 'memoryId', 'deletedRevision', 'committedAt', 'tombstoneId',
          'tombstoneReceiptHash', 'tombstoneExpiresAt', 'exclusionsHash', 'receiptHash'
        ]
  )
  if (!create && input.schemaVersion !== 1) return invalidMemoryValue()
  const commandRefHash = parseMemoryLifecycleHashV1(input.commandRefHash)
  const operation = enumValue(input.operation, ['forget', 'delete_namespace'] as const)
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const generationBefore = parseMemoryLifecyclePositiveIntegerV1(input.generationBefore)
  const generationAfter = parseMemoryLifecyclePositiveIntegerV1(input.generationAfter)
  const deletingGeneration = parseMemoryLifecyclePositiveIntegerV1(input.deletingGeneration)
  const memoryId = input.memoryId === null
    ? null
    : parseMemoryLifecycleHashedRefV1(input.memoryId, 'memory:')
  const deletedRevision = input.deletedRevision === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(
        input.deletedRevision,
        MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
      )
  if (operation === 'forget') {
    if (generationAfter !== generationBefore || deletingGeneration !== generationBefore ||
      memoryId === null || deletedRevision === null) return invalidMemoryValue()
  } else if (generationAfter !== generationBefore + 1 ||
    deletingGeneration !== generationBefore || memoryId !== null || deletedRevision !== null) {
    return invalidMemoryValue()
  }
  const committedAt = parseMemoryLifecycleInstantV1(input.committedAt)
  const tombstoneExpiresAt = addMemoryLifecycleDaysV1(
    committedAt,
    MEMORY_RETENTION_PURGE_GRACE_DAYS_V2
  )
  if (!create && parseMemoryLifecycleInstantV1(input.tombstoneExpiresAt) !== tombstoneExpiresAt) {
    return invalidMemoryValue()
  }
  if (!create && parseMemoryLifecycleHashV1(input.exclusionsHash) !==
    MEMORY_DELETION_EXCLUSIONS_HASH_V1) return invalidMemoryValue()
  const deletionRef = deletionRefV1({
    commandRefHash,
    operation,
    namespaceRef,
    deletingGeneration,
    memoryId
  })
  const tombstoneId = deletionTombstoneIdV1(deletionRef)
  if (!create && (parseMemoryLifecycleHashedRefV1(input.deletionRef, 'deletion:') !== deletionRef ||
    parseMemoryLifecycleHashedRefV1(input.tombstoneId, 'tombstone:') !== tombstoneId)) {
    return invalidMemoryValue()
  }
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    deletionRef,
    commandRefHash,
    operation,
    repositoryReceiptHash: parseMemoryLifecycleHashV1(input.repositoryReceiptHash),
    namespaceRef,
    generationBefore,
    generationAfter,
    deletingGeneration,
    memoryId,
    deletedRevision,
    committedAt,
    tombstoneId,
    tombstoneReceiptHash: parseMemoryLifecycleHashV1(input.tombstoneReceiptHash),
    tombstoneExpiresAt,
    exclusionsHash: MEMORY_DELETION_EXCLUSIONS_HASH_V1
  })
  const receiptHash = deletionReceiptHashV1(withoutHash)
  if (!create && parseMemoryLifecycleHashV1(input.receiptHash) !== receiptHash) {
    return invalidMemoryValue()
  }
  return assertCanonicalWireLimit(Object.freeze({
    ...withoutHash,
    receiptHash
  }), MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionReceiptWireBytes)
}

export function createDeletionMutationReceiptV1 (
  value: unknown
): DeletionMutationReceiptV1 {
  return parseDeletionReceiptFields(value, true)
}

export function parseDeletionMutationReceiptV1 (
  value: unknown
): DeletionMutationReceiptV1 {
  return parseDeletionReceiptFields(value, false)
}

export function parseDeletionStatusV1 (value: unknown): DeletionStatusV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'deletionRef', 'namespaceRef', 'deletingGeneration',
    'observedCurrentGeneration', 'remainingCarrierKinds', 'canonicalBodies',
    'payloadDeletion', 'walCheckpoint', 'derivedCleanup', 'stage', 'observedAt'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const remainingCarrierKinds = inspectMemoryArray(
    input.remainingCarrierKinds,
    CARRIER_KINDS.length
  ).map(item => enumValue(item, CARRIER_KINDS))
  if (new Set(remainingCarrierKinds).size !== remainingCarrierKinds.length ||
    remainingCarrierKinds.some((kind, index) => CARRIER_KINDS.indexOf(kind) <=
      (index === 0 ? -1 : CARRIER_KINDS.indexOf(remainingCarrierKinds[index - 1]!)))) {
    return invalidMemoryValue()
  }
  const canonicalBodies = enumValue(
    input.canonicalBodies,
    ['verified_absent', 'scrub_pending', 'unverified'] as const
  )
  const payloadDeletion = enumValue(
    input.payloadDeletion,
    ['secure_delete_on', 'unverified'] as const
  )
  const walCheckpoint = enumValue(
    input.walCheckpoint,
    ['truncated', 'deferred', 'unverified'] as const
  )
  const derivedCleanup = enumValue(
    input.derivedCleanup,
    ['queued', 'applied', 'unverified'] as const
  )
  const stage = enumValue(
    input.stage,
    ['logical_committed', 'verification_pending', 'canonical_complete'] as const
  )
  if ((canonicalBodies === 'verified_absent') !== (remainingCarrierKinds.length === 0) ||
    (stage === 'canonical_complete' && (
      canonicalBodies !== 'verified_absent' || payloadDeletion !== 'secure_delete_on' ||
      walCheckpoint !== 'truncated' || derivedCleanup === 'unverified'
    )) || (stage === 'logical_committed' && canonicalBodies === 'verified_absent' &&
      payloadDeletion === 'secure_delete_on' && walCheckpoint === 'truncated' &&
      derivedCleanup !== 'unverified')) return invalidMemoryValue()
  const result = Object.freeze({
    schemaVersion: 1 as const,
    deletionRef: parseMemoryLifecycleHashedRefV1(input.deletionRef, 'deletion:'),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    deletingGeneration: parseMemoryLifecyclePositiveIntegerV1(input.deletingGeneration),
    observedCurrentGeneration: parseMemoryLifecyclePositiveIntegerV1(
      input.observedCurrentGeneration
    ),
    remainingCarrierKinds: Object.freeze(remainingCarrierKinds),
    canonicalBodies,
    payloadDeletion,
    walCheckpoint,
    derivedCleanup,
    stage,
    observedAt: parseMemoryLifecycleInstantV1(input.observedAt)
  })
  if (result.observedCurrentGeneration < result.deletingGeneration) return invalidMemoryValue()
  return assertCanonicalWireLimit(
    result,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionStatusWireBytes
  )
}

export function createDeletionStatusV1 (value: unknown): DeletionStatusV1 {
  const input = inspectMemoryRecord(value, [
    'deletionRef', 'namespaceRef', 'deletingGeneration', 'observedCurrentGeneration',
    'remainingCarrierKinds', 'canonicalBodies', 'payloadDeletion', 'walCheckpoint',
    'derivedCleanup', 'stage', 'observedAt'
  ])
  return parseDeletionStatusV1({ schemaVersion: 1, ...input })
}
