import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeDeletionMutationReceiptV1,
  decodeDeletionStatusV1,
  decodeMemoryConsentEvidenceV1,
  decodeMemoryLifecycleAuditV1,
  decodeMemoryProposalV2,
  decodeMemoryRecordV2,
  decodeMemoryRevisionEvidenceV1,
  decodeMemoryRevisionV2,
  decodeMemoryV1ToV2AggregateManifestV1,
  encodeDeletionMutationReceiptV1,
  encodeDeletionStatusV1,
  encodeMemoryConsentEvidenceV1,
  encodeMemoryLifecycleAuditV1,
  encodeMemoryProposalV2,
  encodeMemoryRecordV2,
  encodeMemoryRevisionEvidenceV1,
  encodeMemoryRevisionV2,
  encodeMemoryV1ToV2AggregateManifestV1
} from '../../src/agent/memory/memory-lifecycle-codec.js'
import {
  MEMORY_DELETION_EXCLUSIONS_HASH_V1,
  MEMORY_RETENTION_POLICY_REF_V1,
  createDeletionMutationReceiptV1,
  createDeletionStatusV1,
  createMemoryConsentEvidenceV1,
  createMemoryLifecycleAuditV1,
  createMemoryProposalV2,
  createMemoryRecordV2,
  createMemoryRevisionEvidenceV1,
  createMemoryRevisionV2,
  createMemoryV1ToV2AggregateManifestV1,
  type MemoryConsentEvidenceV1,
  type MemoryProposalV2,
  type MemoryRecordV2,
  type MemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  deepFreezeFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)
const IDS = Object.freeze({
  actor: `actor:${HASH_A}`,
  proposal: `proposal:${HASH_C}`,
  memory: `memory:${HASH_D}`,
  evidence: `evidence:${HASH_E}`,
  revisionEvidence: `evidence:${HASH_A}`
})
const TIMES = Object.freeze({
  proposed: '2026-07-22T00:00:00.000Z',
  approved: '2026-07-22T00:01:00.000Z',
  changed: '2026-07-23T00:00:00.000Z',
  valid: '2027-07-22T00:00:00.000Z',
  purge: '2027-08-21T00:00:00.000Z'
})

function mutable<T> (value: T): T {
  return structuredClone(value)
}

function mutableRecord (value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>
}

function assertDeepFrozen (value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, seen)
    }
  }
}

function proposalFixture (): MemoryProposalV2 {
  return createMemoryProposalV2({
    proposalId: IDS.proposal,
    namespace: personalMemoryNamespaceFixture(),
    namespaceGeneration: 1,
    initiatedByActorRef: IDS.actor,
    proposedBy: deepFreezeFixture({
      kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat'
    }),
    plannedMemoryId: IDS.memory,
    intent: deepFreezeFixture({ kind: 'create' }),
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: deepFreezeFixture([memorySourceFixture()]),
    observedAt: '2026-07-19T00:00:00.000Z',
    proposedAt: TIMES.proposed,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: deepFreezeFixture({ state: 'none', relatedMemoryIds: [], note: null }),
    suggestedRetention: deepFreezeFixture({
      validUntil: TIMES.valid,
      purgeAt: TIMES.purge
    }),
    retentionPolicyRef: MEMORY_RETENTION_POLICY_REF_V1,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
}

function consentFixture (proposal: MemoryProposalV2): MemoryConsentEvidenceV1 {
  return createMemoryConsentEvidenceV1({
    evidenceId: IDS.evidence,
    evidenceKind: 'explicit',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    proposalId: proposal.proposalId,
    proposalRevision: 1,
    consentTargetHash: proposal.consentTargetHash,
    approvedByActorRef: IDS.actor,
    approvedAt: TIMES.approved,
    source: memorySourceFixture(),
    policyRef: null,
    policyGeneration: null
  })
}

function recordFixture (
  proposal: MemoryProposalV2,
  evidence: MemoryConsentEvidenceV1
): MemoryRecordV2 {
  return createMemoryRecordV2({
    memoryId: proposal.plannedMemoryId,
    revision: 1,
    namespace: proposal.namespace,
    namespaceGeneration: proposal.namespaceGeneration,
    kind: proposal.kind,
    text: proposal.text,
    sources: proposal.sources,
    createdAt: proposal.proposedAt,
    observedAt: proposal.observedAt,
    confirmedAt: evidence.approvedAt,
    updatedAt: evidence.approvedAt,
    validity: deepFreezeFixture({ state: 'current', validFrom: proposal.observedAt }),
    confidence: proposal.confidence,
    consent: deepFreezeFixture({
      state: evidence.evidenceKind,
      approvedByActorRef: evidence.approvedByActorRef,
      approvedAt: evidence.approvedAt,
      consentTargetHash: evidence.consentTargetHash,
      evidenceId: evidence.evidenceId,
      evidenceHash: evidence.evidenceHash,
      policyRef: evidence.policyRef,
      policyGeneration: evidence.policyGeneration
    }),
    sensitivity: proposal.sensitivity,
    conflict: proposal.conflict,
    supersedes: deepFreezeFixture([]),
    retention: proposal.suggestedRetention,
    retentionPolicyRef: proposal.retentionPolicyRef,
    deletionState: 'active'
  })
}

function createdRevisionFixture (
  record: MemoryRecordV2,
  evidence: MemoryConsentEvidenceV1
): MemoryRevisionV2 {
  return createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: evidence.approvedByActorRef,
    changedAt: evidence.approvedAt,
    reason: null,
    evidence: deepFreezeFixture({
      kind: 'consent', evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash
    }),
    previousRevisionHash: null
  })
}

function revisedRecordFixture (record: MemoryRecordV2): MemoryRecordV2 {
  const {
    schemaVersion: _schemaVersion,
    namespaceRef: _namespaceRef,
    contentHash: _contentHash,
    ...draft
  } = mutable(record)
  return createMemoryRecordV2({
    ...draft,
    revision: 2,
    text: '喜欢无糖拿铁',
    updatedAt: TIMES.changed
  })
}

function codecFixtures () {
  const proposal = proposalFixture()
  const consent = consentFixture(proposal)
  const record = recordFixture(proposal, consent)
  const createdRevision = createdRevisionFixture(record, consent)
  const revisedRecord = revisedRecordFixture(record)
  const revisionEvidence = createMemoryRevisionEvidenceV1({
    evidenceId: IDS.revisionEvidence,
    evidenceKind: 'explicit',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: 2,
    operation: 'corrected',
    baseRevisionHash: createdRevision.revisionHash,
    revisionTargetHash: revisedRecord.contentHash,
    changedByActorRef: IDS.actor,
    changedAt: TIMES.changed,
    source: memorySourceFixture({
      sourceKind: 'manual_correction', messageId: null,
      normalizedText: '更正为无糖拿铁'
    }),
    policyRef: null,
    policyGeneration: null
  })
  const revision = createMemoryRevisionV2({
    memoryId: revisedRecord.memoryId,
    revision: 2,
    operation: 'corrected',
    record: revisedRecord,
    changedByActorRef: IDS.actor,
    changedAt: TIMES.changed,
    reason: '用户更正',
    evidence: deepFreezeFixture({
      kind: 'revision',
      evidenceId: revisionEvidence.evidenceId,
      evidenceHash: revisionEvidence.evidenceHash
    }),
    previousRevisionHash: createdRevision.revisionHash
  })
  const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  const audit = createMemoryLifecycleAuditV1({
    namespaceRef,
    namespaceGeneration: 1,
    operation: 'proposal_pruned',
    commandRefHash: HASH_A,
    aggregateKind: 'proposal',
    aggregateRefHash: HASH_B,
    authorizedByActorRefHash: HASH_C,
    executedByActorRefHash: HASH_D,
    sourceCommittedAt: TIMES.approved,
    recordedAt: TIMES.approved,
    outcome: 'pruned',
    repositoryReceiptHash: HASH_E,
    priorRevision: 2,
    nextRevision: null,
    exclusionsHash: null
  })
  const deletionReceipt = createDeletionMutationReceiptV1({
    commandRefHash: HASH_A,
    operation: 'forget',
    repositoryReceiptHash: HASH_B,
    namespaceRef,
    generationBefore: 1,
    generationAfter: 1,
    deletingGeneration: 1,
    memoryId: IDS.memory,
    deletedRevision: 2,
    committedAt: TIMES.approved,
    tombstoneReceiptHash: HASH_C
  })
  assert.equal(deletionReceipt.exclusionsHash, MEMORY_DELETION_EXCLUSIONS_HASH_V1)
  const deletionStatus = createDeletionStatusV1({
    deletionRef: deletionReceipt.deletionRef,
    namespaceRef,
    deletingGeneration: 1,
    observedCurrentGeneration: 1,
    remainingCarrierKinds: [],
    canonicalBodies: 'verified_absent',
    payloadDeletion: 'secure_delete_on',
    walCheckpoint: 'truncated',
    derivedCleanup: 'queued',
    stage: 'canonical_complete',
    observedAt: TIMES.approved
  })
  const manifest = createMemoryV1ToV2AggregateManifestV1({
    namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'memory',
      aggregateId: IDS.memory,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 2,
      legacyProposalWireHashes: [HASH_A, HASH_B],
      legacyRevisionWires: [
        { revision: 1, legacyWireHash: HASH_C },
        { revision: 2, legacyWireHash: HASH_D }
      ]
    },
    initiatedByActorRef: IDS.actor,
    plannedMemoryId: IDS.memory,
    intent: { kind: 'create' },
    consentEvidenceId: IDS.evidence,
    consentEvidenceHash: HASH_A,
    revisionEvidenceBindings: [
      { revision: 2, evidenceId: IDS.revisionEvidence, evidenceHash: HASH_B }
    ]
  })
  return Object.freeze({
    proposal,
    consent,
    record,
    revisionEvidence,
    revision,
    audit,
    deletionReceipt,
    deletionStatus,
    manifest
  })
}

test('lifecycle codecs round-trip all canonical roots with exact compact bytes', () => {
  const fixture = codecFixtures()
  const cases: readonly {
    readonly value: unknown
    readonly encode: () => string
    readonly decode: (raw: unknown) => unknown
    readonly limit: number
  }[] = [
    {
      value: fixture.proposal,
      encode: () => encodeMemoryProposalV2(fixture.proposal),
      decode: decodeMemoryProposalV2,
      limit: MEMORY_RESOURCE_LIMITS.proposalWireBytes
    },
    {
      value: fixture.consent,
      encode: () => encodeMemoryConsentEvidenceV1(fixture.consent),
      decode: decodeMemoryConsentEvidenceV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes
    },
    {
      value: fixture.record,
      encode: () => encodeMemoryRecordV2(fixture.record),
      decode: decodeMemoryRecordV2,
      limit: MEMORY_RESOURCE_LIMITS.recordWireBytes
    },
    {
      value: fixture.revisionEvidence,
      encode: () => encodeMemoryRevisionEvidenceV1(fixture.revisionEvidence),
      decode: decodeMemoryRevisionEvidenceV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes
    },
    {
      value: fixture.revision,
      encode: () => encodeMemoryRevisionV2(fixture.revision),
      decode: decodeMemoryRevisionV2,
      limit: MEMORY_RESOURCE_LIMITS.revisionWireBytes
    },
    {
      value: fixture.audit,
      encode: () => encodeMemoryLifecycleAuditV1(fixture.audit),
      decode: decodeMemoryLifecycleAuditV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes
    },
    {
      value: fixture.deletionReceipt,
      encode: () => encodeDeletionMutationReceiptV1(fixture.deletionReceipt),
      decode: decodeDeletionMutationReceiptV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionReceiptWireBytes
    },
    {
      value: fixture.deletionStatus,
      encode: () => encodeDeletionStatusV1(fixture.deletionStatus),
      decode: decodeDeletionStatusV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionStatusWireBytes
    },
    {
      value: fixture.manifest,
      encode: () => encodeMemoryV1ToV2AggregateManifestV1(fixture.manifest),
      decode: decodeMemoryV1ToV2AggregateManifestV1,
      limit: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes
    }
  ]

  for (const entry of cases) {
    const wire = entry.encode()
    assert.equal(wire, JSON.stringify(entry.value))
    assert.equal(wire.includes('\n'), false)
    assert.equal(Buffer.byteLength(wire, 'utf8') <= entry.limit, true)
    const decoded = entry.decode(wire)
    assert.deepEqual(decoded, entry.value)
    assertDeepFrozen(decoded)
    assert.throws(() => entry.decode(` ${wire}`), TypeError)
    assert.throws(() => entry.decode(' '.repeat(entry.limit + 1)), TypeError)
  }
})

test('lifecycle codecs reject reordered, duplicate and alternate JSON bytes', () => {
  const proposal = codecFixtures().proposal
  const canonical = encodeMemoryProposalV2(proposal)
  const parsed = JSON.parse(canonical) as Record<string, unknown>
  const reordered = JSON.stringify({
    proposalId: parsed.proposalId,
    schemaVersion: parsed.schemaVersion,
    ...Object.fromEntries(Object.entries(parsed).filter(([key]) => (
      key !== 'proposalId' && key !== 'schemaVersion'
    )))
  })
  const duplicate = canonical.replace('{"schemaVersion":2,',
    '{"schemaVersion":2,"schemaVersion":2,')
  const escapedUnicode = canonical.replace('喜欢', '\\u559c\\u6b22')
  const alternateNumber = canonical.replace('"confidence":0.9', '"confidence":9e-1')

  for (const raw of [reordered, duplicate, escapedUnicode, alternateNumber]) {
    assert.throws(() => decodeMemoryProposalV2(raw), TypeError)
  }
})

test('lifecycle codecs independently recompute every derived hash and reference', () => {
  const fixture = codecFixtures()
  const cases: readonly [
    (raw: unknown) => unknown,
    Record<string, unknown>,
    string
  ][] = [
    [decodeMemoryProposalV2, mutableRecord(fixture.proposal), 'consentTargetHash'],
    [decodeMemoryConsentEvidenceV1, mutableRecord(fixture.consent), 'evidenceHash'],
    [decodeMemoryRecordV2, mutableRecord(fixture.record), 'contentHash'],
    [decodeMemoryRevisionEvidenceV1, mutableRecord(fixture.revisionEvidence), 'evidenceHash'],
    [decodeMemoryRevisionV2, mutableRecord(fixture.revision), 'revisionHash'],
    [decodeMemoryLifecycleAuditV1, mutableRecord(fixture.audit), 'receiptHash'],
    [decodeDeletionMutationReceiptV1, mutableRecord(fixture.deletionReceipt), 'receiptHash'],
    [decodeMemoryV1ToV2AggregateManifestV1, mutableRecord(fixture.manifest), 'manifestHash']
  ]
  for (const [decode, value, field] of cases) {
    value[field] = HASH_E
    assert.throws(() => decode(JSON.stringify(value)), TypeError, field)
  }

  const invalidStatus = mutableRecord(fixture.deletionStatus)
  invalidStatus.remainingCarrierKinds = ['revision']
  assert.throws(() => decodeDeletionStatusV1(JSON.stringify(invalidStatus)), TypeError)
})
