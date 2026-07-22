import {
  deriveMemoryConsentEvidenceIdV1,
  deriveMemoryPlannedMemoryIdV2,
  deriveMemoryProposalIdV2,
  deriveMemoryRevisionEvidenceIdV1
} from './memory-lifecycle-builder.js'
import {
  assertMemoryCreateApprovalResultBindingV2,
  assertMemoryRevisionEvidenceBindingV1,
  parseMemoryConsentEvidenceV1,
  parseMemoryProposalV2,
  parseMemoryRecordV2,
  parseMemoryRevisionEvidenceV1,
  parseMemoryRevisionV2,
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleHashV1,
  parseMemoryLifecycleInstantV1,
  parseMemoryLifecyclePositiveIntegerV1,
  type MemoryConsentEvidenceV1,
  type MemoryProposalV2,
  type MemoryRecordV2,
  type MemoryRevisionEvidenceV1,
  type MemoryRevisionV2
} from './memory-lifecycle-domain.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

export const MEMORY_LIFECYCLE_COMMAND_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-command.v1'
export const MEMORY_LIFECYCLE_COMMAND_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-command-ref.v1'
export const MEMORY_LIFECYCLE_COMMAND_MATERIAL_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-command-material.v1'

export const MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1 = Object.freeze([
  'proposal.create',
  'proposal.createAndApprove',
  'proposal.approve',
  'proposal.reject',
  'proposal.withdraw',
  'proposal.expire',
  'record.correct',
  'record.renew',
  'record.changeConflict',
  'record.forget',
  'namespace.delete'
] as const)

export type MemoryLifecycleCommandOperationV1 =
  typeof MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1[number]

export type MemoryLifecycleCommandMaterialKindV1 =
  | 'none'
  | 'proposal_v2'
  | 'proposal_approval_v1'
  | 'consent_evidence_v1'
  | 'revision_change_v1'

export interface MemoryProposalApprovalMaterialV1 {
  readonly schemaVersion: 1
  readonly kind: 'proposal_approval_v1'
  readonly proposal: MemoryProposalV2
  readonly consentEvidence: MemoryConsentEvidenceV1
  readonly record: MemoryRecordV2
  readonly revision: MemoryRevisionV2
}

export interface MemoryRevisionChangeMaterialV1 {
  readonly schemaVersion: 1
  readonly kind: 'revision_change_v1'
  readonly evidence: MemoryRevisionEvidenceV1
  readonly revision: MemoryRevisionV2
}

export type MemoryLifecycleCommandMaterialV1 =
  | null
  | MemoryProposalV2
  | MemoryProposalApprovalMaterialV1
  | MemoryConsentEvidenceV1
  | MemoryRevisionChangeMaterialV1

export interface MemoryLifecycleCommandWireV1 {
  readonly schemaVersion: 1
  readonly commandRef: string
  readonly operation: MemoryLifecycleCommandOperationV1
  readonly initiatedByActorRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly expectedNamespaceGeneration: number
  readonly aggregateRef: string | null
  readonly expectedRevision: number | null
  readonly expectedAggregateHash: string | null
  readonly occurredAt: string
  readonly newValidUntil: string | null
  readonly newPurgeAt: string | null
  readonly materialKind: MemoryLifecycleCommandMaterialKindV1
  readonly materialHash: string | null
}

export interface MemoryLifecycleCommandV1 {
  readonly wire: string
  readonly material: MemoryLifecycleCommandMaterialV1
}

const COMMAND_REF = /^command:[0-9a-f]{64}$/
const PROPOSAL_REF = /^proposal:[0-9a-f]{64}$/
const MEMORY_REF = /^memory:[0-9a-f]{64}$/
const RECORD_OPERATIONS = new Set<MemoryLifecycleCommandOperationV1>([
  'record.correct', 'record.renew', 'record.changeConflict', 'record.forget'
])
const PROPOSAL_DECISION_OPERATIONS = new Set<MemoryLifecycleCommandOperationV1>([
  'proposal.approve', 'proposal.reject', 'proposal.withdraw', 'proposal.expire'
])
const PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1_000

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function parseCommandRef (value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_REF.test(value)) return invalidMemoryValue()
  return value
}

function parseAggregateRef (
  value: unknown,
  operation: MemoryLifecycleCommandOperationV1
): string | null {
  if (operation === 'proposal.create' || operation === 'proposal.createAndApprove' ||
    operation === 'namespace.delete') {
    if (value !== null) return invalidMemoryValue()
    return null
  }
  const pattern = PROPOSAL_DECISION_OPERATIONS.has(operation) ? PROPOSAL_REF : MEMORY_REF
  if (typeof value !== 'string' || !pattern.test(value)) return invalidMemoryValue()
  return value
}

function parseNullablePositiveInteger (value: unknown): number | null {
  return value === null
    ? null
    : parseMemoryLifecyclePositiveIntegerV1(
      value,
      MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
    )
}

function parseNullableHash (value: unknown): string | null {
  return value === null ? null : parseMemoryLifecycleHashV1(value)
}

function parseNullableInstant (value: unknown): string | null {
  return value === null ? null : parseMemoryLifecycleInstantV1(value)
}

function parseExpectedState (
  operation: MemoryLifecycleCommandOperationV1,
  revisionValue: unknown,
  hashValue: unknown
): { readonly revision: number | null; readonly hash: string | null } {
  const revision = parseNullablePositiveInteger(revisionValue)
  const hash = parseNullableHash(hashValue)
  if (operation === 'proposal.create' || operation === 'proposal.createAndApprove' ||
    operation === 'namespace.delete') {
    if (revision !== null || hash !== null) return invalidMemoryValue()
  } else if (PROPOSAL_DECISION_OPERATIONS.has(operation)) {
    if (revision !== 1 || hash === null) return invalidMemoryValue()
  } else if (operation === 'record.forget') {
    if ((revision === null) !== (hash === null)) return invalidMemoryValue()
  } else if (revision === null || hash === null) {
    return invalidMemoryValue()
  }
  return Object.freeze({ revision, hash })
}

function parseRenewalDates (
  operation: MemoryLifecycleCommandOperationV1,
  validUntilValue: unknown,
  purgeAtValue: unknown
): { readonly validUntil: string | null; readonly purgeAt: string | null } {
  const validUntil = parseNullableInstant(validUntilValue)
  const purgeAt = parseNullableInstant(purgeAtValue)
  if (operation !== 'record.renew') {
    if (validUntil !== null || purgeAt !== null) return invalidMemoryValue()
  } else if (validUntil === null || purgeAt === null ||
    Date.parse(purgeAt) - Date.parse(validUntil) !== PURGE_GRACE_MS) {
    return invalidMemoryValue()
  }
  return Object.freeze({ validUntil, purgeAt })
}

function expectedMaterialKind (
  operation: MemoryLifecycleCommandOperationV1
): MemoryLifecycleCommandMaterialKindV1 {
  if (operation === 'proposal.create') return 'proposal_v2'
  if (operation === 'proposal.createAndApprove') return 'proposal_approval_v1'
  if (operation === 'proposal.approve') return 'consent_evidence_v1'
  if (operation === 'record.correct' || operation === 'record.renew' ||
    operation === 'record.changeConflict') {
    return 'revision_change_v1'
  }
  return 'none'
}

function assertDirectSaveProposalMaterial (
  proposal: MemoryProposalV2,
  consentEvidence?: MemoryConsentEvidenceV1
): void {
  if (proposal.proposedBy.kind !== 'user' ||
    proposal.proposedBy.actorRef !== proposal.initiatedByActorRef ||
    proposal.consentRequirement !== 'explicit' ||
    proposal.sources.length !== 1 ||
    proposal.sources[0]?.sourceKind !== 'current_message') return invalidMemoryValue()
  if (consentEvidence !== undefined && (
    consentEvidence.evidenceKind !== 'explicit' ||
    consentEvidence.source === null ||
    JSON.stringify(proposal.sources[0]) !== JSON.stringify(consentEvidence.source) ||
    proposal.proposedAt !== consentEvidence.approvedAt
  )) return invalidMemoryValue()
}

function parseProposalApprovalMaterial (value: unknown): MemoryProposalApprovalMaterialV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'kind', 'proposal', 'consentEvidence', 'record', 'revision'
  ])
  if (input.schemaVersion !== 1 || input.kind !== 'proposal_approval_v1') {
    return invalidMemoryValue()
  }
  const proposal = parseMemoryProposalV2(input.proposal)
  assertDirectSaveProposalMaterial(proposal)
  const consentEvidence = parseMemoryConsentEvidenceV1(input.consentEvidence)
  const record = parseMemoryRecordV2(input.record)
  const revision = parseMemoryRevisionV2(input.revision)
  const bound = assertMemoryCreateApprovalResultBindingV2(
    proposal,
    consentEvidence,
    record,
    revision
  )
  assertDirectSaveProposalMaterial(bound.proposal, bound.consentEvidence)
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'proposal_approval_v1' as const,
    proposal: bound.proposal,
    consentEvidence: bound.consentEvidence,
    record: bound.record,
    revision: bound.revision
  })
}

function parseRevisionChangeMaterial (value: unknown): MemoryRevisionChangeMaterialV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'kind', 'evidence', 'revision'
  ])
  if (input.schemaVersion !== 1 || input.kind !== 'revision_change_v1') {
    return invalidMemoryValue()
  }
  const evidence = parseMemoryRevisionEvidenceV1(input.evidence)
  const revision = parseMemoryRevisionV2(input.revision)
  assertMemoryRevisionEvidenceBindingV1(evidence, revision)
  if (revision.operation === 'created' || revision.evidence.kind !== 'revision' ||
    revision.record.namespaceRef !== evidence.namespaceRef ||
    revision.record.namespaceGeneration !== evidence.namespaceGeneration ||
    revision.memoryId !== evidence.memoryId || revision.revision !== evidence.revision ||
    revision.operation !== evidence.operation ||
    revision.changedByActorRef !== evidence.changedByActorRef ||
    revision.changedAt !== evidence.changedAt ||
    revision.evidence.evidenceId !== evidence.evidenceId ||
    revision.evidence.evidenceHash !== evidence.evidenceHash) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'revision_change_v1' as const,
    evidence,
    revision
  })
}

function parseMaterial (
  operation: MemoryLifecycleCommandOperationV1,
  value: unknown
): {
    readonly kind: MemoryLifecycleCommandMaterialKindV1
    readonly value: MemoryLifecycleCommandMaterialV1
    readonly canonical: string | null
  } {
  const kind = expectedMaterialKind(operation)
  let material: MemoryLifecycleCommandMaterialV1
  if (kind === 'none') {
    if (value !== null) return invalidMemoryValue()
    material = null
  } else if (kind === 'proposal_v2') {
    const proposal = parseMemoryProposalV2(value)
    if (proposal.state !== 'pending' || proposal.revision !== 1 || proposal.decision !== null) {
      return invalidMemoryValue()
    }
    material = proposal
  } else if (kind === 'proposal_approval_v1') {
    material = parseProposalApprovalMaterial(value)
  } else if (kind === 'consent_evidence_v1') {
    material = parseMemoryConsentEvidenceV1(value)
  } else {
    material = parseRevisionChangeMaterial(value)
    const expectedOperation = operation === 'record.correct'
      ? 'corrected'
      : operation === 'record.renew'
        ? 'retention_changed'
        : 'conflict_changed'
    if (material.revision.operation !== expectedOperation) return invalidMemoryValue()
  }
  return Object.freeze({
    kind,
    value: material,
    canonical: material === null ? null : JSON.stringify(material)
  })
}

export function memoryLifecycleCommandMaterialHashV1 (
  operation: MemoryLifecycleCommandOperationV1,
  materialKind: Exclude<MemoryLifecycleCommandMaterialKindV1, 'none'>,
  canonicalMaterial: string
): string {
  const parsedOperation = enumValue(operation, MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1)
  const parsedKind = enumValue(materialKind, [
    'proposal_v2', 'proposal_approval_v1', 'consent_evidence_v1', 'revision_change_v1'
  ] as const)
  if (typeof canonicalMaterial !== 'string' || canonicalMaterial.length === 0) {
    return invalidMemoryValue()
  }
  if (Buffer.byteLength(canonicalMaterial, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandMaterialWireBytes) {
    return invalidMemoryValue()
  }
  return memoryLifecycleDomainHashV1(
    `${MEMORY_LIFECYCLE_COMMAND_MATERIAL_HASH_DOMAIN_V1}.${parsedOperation}.${parsedKind}`,
    canonicalMaterial
  )
}

function parseWireObject (value: unknown): MemoryLifecycleCommandWireV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
    'expectedNamespaceGeneration', 'aggregateRef', 'expectedRevision',
    'expectedAggregateHash', 'occurredAt', 'newValidUntil', 'newPurgeAt',
    'materialKind', 'materialHash'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(input.operation, MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1)
  const expected = parseExpectedState(
    operation,
    input.expectedRevision,
    input.expectedAggregateHash
  )
  const renewal = parseRenewalDates(operation, input.newValidUntil, input.newPurgeAt)
  const materialKind = enumValue(input.materialKind, [
    'none', 'proposal_v2', 'proposal_approval_v1', 'consent_evidence_v1',
    'revision_change_v1'
  ] as const)
  const materialHash = parseNullableHash(input.materialHash)
  if (materialKind !== expectedMaterialKind(operation) ||
    (materialKind === 'none') !== (materialHash === null)) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    commandRef: parseCommandRef(input.commandRef),
    operation,
    initiatedByActorRef: (() => {
      if (typeof input.initiatedByActorRef !== 'string' ||
        !/^actor:[0-9a-f]{64}$/.test(input.initiatedByActorRef)) return invalidMemoryValue()
      return input.initiatedByActorRef
    })(),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    expectedNamespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(
      input.expectedNamespaceGeneration
    ),
    aggregateRef: parseAggregateRef(input.aggregateRef, operation),
    expectedRevision: expected.revision,
    expectedAggregateHash: expected.hash,
    occurredAt: parseMemoryLifecycleInstantV1(input.occurredAt),
    newValidUntil: renewal.validUntil,
    newPurgeAt: renewal.purgeAt,
    materialKind,
    materialHash
  })
}

export function encodeMemoryLifecycleCommandWireV1 (value: unknown): string {
  const wire = JSON.stringify(parseWireObject(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes) return invalidMemoryValue()
  return wire
}

export function decodeMemoryLifecycleCommandWireV1 (raw: unknown): MemoryLifecycleCommandWireV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes) return invalidMemoryValue()
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parseWireObject(value)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

function bindWireAndMaterial (
  wire: MemoryLifecycleCommandWireV1,
  materialValue: unknown
): MemoryLifecycleCommandV1 {
  const material = parseMaterial(wire.operation, materialValue)
  if (wire.materialKind !== material.kind) return invalidMemoryValue()
  const materialHash = material.canonical === null
    ? null
    : memoryLifecycleCommandMaterialHashV1(
      wire.operation,
      material.kind as Exclude<MemoryLifecycleCommandMaterialKindV1, 'none'>,
      material.canonical
    )
  if (wire.materialHash !== materialHash) return invalidMemoryValue()
  if (material.value !== null) {
    let namespaceRef: MemoryNamespaceRefV1
    let namespaceGeneration: number
    if (material.kind === 'proposal_v2') {
      const proposal = material.value as MemoryProposalV2
      namespaceRef = proposal.namespaceRef
      namespaceGeneration = proposal.namespaceGeneration
    } else if (material.kind === 'proposal_approval_v1') {
      const approval = material.value as MemoryProposalApprovalMaterialV1
      namespaceRef = approval.proposal.namespaceRef
      namespaceGeneration = approval.proposal.namespaceGeneration
    } else if (material.kind === 'consent_evidence_v1') {
      const evidence = material.value as MemoryConsentEvidenceV1
      namespaceRef = evidence.namespaceRef
      namespaceGeneration = evidence.namespaceGeneration
    } else {
      const change = material.value as MemoryRevisionChangeMaterialV1
      namespaceRef = change.evidence.namespaceRef
      namespaceGeneration = change.evidence.namespaceGeneration
    }
    if (namespaceRef !== wire.namespaceRef ||
      namespaceGeneration !== wire.expectedNamespaceGeneration) return invalidMemoryValue()
  }
  if (material.kind === 'proposal_v2') {
    if ((material.value as MemoryProposalV2).initiatedByActorRef !== wire.initiatedByActorRef) {
      return invalidMemoryValue()
    }
  } else if (material.kind === 'proposal_approval_v1') {
    const approval = material.value as MemoryProposalApprovalMaterialV1
    if (approval.proposal.initiatedByActorRef !== wire.initiatedByActorRef ||
      approval.proposal.proposedBy.kind !== 'user' ||
      approval.proposal.proposedBy.actorRef !== wire.initiatedByActorRef ||
      approval.consentEvidence.approvedByActorRef !== wire.initiatedByActorRef ||
      approval.proposal.proposedAt !== wire.occurredAt ||
      approval.consentEvidence.approvedAt !== wire.occurredAt) {
      return invalidMemoryValue()
    }
  } else if (material.kind === 'consent_evidence_v1') {
    if ((material.value as MemoryConsentEvidenceV1).approvedByActorRef !==
      wire.initiatedByActorRef) return invalidMemoryValue()
  } else if (material.kind === 'revision_change_v1') {
    if ((material.value as MemoryRevisionChangeMaterialV1).evidence.changedByActorRef !==
      wire.initiatedByActorRef) return invalidMemoryValue()
  }
  const deterministicReference = Object.freeze({
    commandRef: wire.commandRef,
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    operation: wire.operation
  })
  if (material.kind === 'proposal_v2') {
    const proposal = material.value as MemoryProposalV2
    if (proposal.proposalId !== deriveMemoryProposalIdV2(deterministicReference) ||
      proposal.plannedMemoryId !== deriveMemoryPlannedMemoryIdV2({
        ...deterministicReference,
        proposalId: proposal.proposalId,
        intent: proposal.intent
      })) return invalidMemoryValue()
  } else if (material.kind === 'proposal_approval_v1') {
    const approval = material.value as MemoryProposalApprovalMaterialV1
    if (approval.proposal.proposalId !== deriveMemoryProposalIdV2(deterministicReference) ||
      approval.proposal.plannedMemoryId !== deriveMemoryPlannedMemoryIdV2({
        ...deterministicReference,
        proposalId: approval.proposal.proposalId,
        intent: approval.proposal.intent
      }) || approval.consentEvidence.evidenceId !== deriveMemoryConsentEvidenceIdV1({
        ...deterministicReference,
        proposalId: approval.proposal.proposalId,
        consentTargetHash: approval.proposal.consentTargetHash
      })) return invalidMemoryValue()
  } else if (material.kind === 'consent_evidence_v1') {
    const evidence = material.value as MemoryConsentEvidenceV1
    if (evidence.evidenceId !== deriveMemoryConsentEvidenceIdV1({
      ...deterministicReference,
      proposalId: evidence.proposalId,
      consentTargetHash: evidence.consentTargetHash
    })) return invalidMemoryValue()
  } else if (material.kind === 'revision_change_v1') {
    const change = material.value as MemoryRevisionChangeMaterialV1
    if (change.evidence.evidenceId !== deriveMemoryRevisionEvidenceIdV1({
      ...deterministicReference,
      memoryId: change.evidence.memoryId,
      revision: change.evidence.revision,
      baseRevisionHash: change.evidence.baseRevisionHash,
      revisionTargetHash: change.evidence.revisionTargetHash
    })) return invalidMemoryValue()
  }
  if (wire.operation === 'proposal.approve') {
    const evidence = material.value as MemoryConsentEvidenceV1
    if (evidence.proposalId !== wire.aggregateRef ||
      evidence.proposalRevision !== wire.expectedRevision ||
      evidence.consentTargetHash !== wire.expectedAggregateHash) return invalidMemoryValue()
  } else if (wire.operation === 'record.correct' || wire.operation === 'record.renew' ||
    wire.operation === 'record.changeConflict') {
    const change = material.value as MemoryRevisionChangeMaterialV1
    if (change.revision.memoryId !== wire.aggregateRef ||
      change.revision.revision !== (wire.expectedRevision as number) + 1 ||
      change.revision.previousRevisionHash !== wire.expectedAggregateHash) {
      return invalidMemoryValue()
    }
    if (wire.operation === 'record.renew' && (
      change.revision.record.retention.validUntil !== wire.newValidUntil ||
      change.revision.record.retention.purgeAt !== wire.newPurgeAt
    )) return invalidMemoryValue()
  }
  return Object.freeze({ wire: encodeMemoryLifecycleCommandWireV1(wire), material: material.value })
}

export function createMemoryLifecycleCommandV1 (value: unknown): MemoryLifecycleCommandV1 {
  const input = inspectMemoryRecord(value, [
    'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
    'expectedNamespaceGeneration', 'aggregateRef',
    'expectedRevision', 'expectedAggregateHash', 'occurredAt', 'newValidUntil', 'newPurgeAt',
    'material'
  ])
  const operation = enumValue(input.operation, MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1)
  const material = parseMaterial(operation, input.material)
  const materialHash = material.canonical === null
    ? null
    : memoryLifecycleCommandMaterialHashV1(
      operation,
      material.kind as Exclude<MemoryLifecycleCommandMaterialKindV1, 'none'>,
      material.canonical
    )
  const wire = parseWireObject(Object.freeze({
    schemaVersion: 1,
    commandRef: input.commandRef,
    operation,
    initiatedByActorRef: input.initiatedByActorRef,
    namespaceRef: input.namespaceRef,
    expectedNamespaceGeneration: input.expectedNamespaceGeneration,
    aggregateRef: input.aggregateRef,
    expectedRevision: input.expectedRevision,
    expectedAggregateHash: input.expectedAggregateHash,
    occurredAt: input.occurredAt,
    newValidUntil: input.newValidUntil,
    newPurgeAt: input.newPurgeAt,
    materialKind: material.kind,
    materialHash
  }))
  return bindWireAndMaterial(wire, material.value)
}

export function parseMemoryLifecycleCommandV1 (value: unknown): MemoryLifecycleCommandV1 {
  const input = inspectMemoryRecord(value, ['wire', 'material'])
  return bindWireAndMaterial(decodeMemoryLifecycleCommandWireV1(input.wire), input.material)
}

export function memoryLifecycleCommandHashV1 (wireValue: unknown): string {
  const wire = encodeMemoryLifecycleCommandWireV1(
    typeof wireValue === 'string' ? decodeMemoryLifecycleCommandWireV1(wireValue) : wireValue
  )
  return memoryLifecycleDomainHashV1(MEMORY_LIFECYCLE_COMMAND_HASH_DOMAIN_V1, wire)
}

export function memoryLifecycleCommandRefHashV1 (commandRefValue: unknown): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_LIFECYCLE_COMMAND_REF_HASH_DOMAIN_V1,
    parseCommandRef(commandRefValue)
  )
}

export function memoryLifecycleCommandWireIsBodyFreeV1 (wireValue: unknown): boolean {
  if (typeof wireValue !== 'string' ||
    !memoryAsciiWithinLimit(wireValue, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes)) {
    return false
  }
  try {
    decodeMemoryLifecycleCommandWireV1(wireValue)
    return true
  } catch {
    return false
  }
}
