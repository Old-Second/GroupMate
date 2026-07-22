import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_LIFECYCLE_AUDIT_RETENTION_DAYS_V1,
  MEMORY_LIFECYCLE_DAY_MS,
  MEMORY_DELETION_EXCLUSIONS_HASH_V1,
  MEMORY_RETENTION_POLICY_REF_V1,
  addMemoryLifecycleDaysV1,
  assertMemoryConsentEvidenceForProposalV1,
  assertMemoryCreateApprovalResultBindingV2,
  assertMemoryRecordApprovalBindingV2,
  assertMemoryRevisionEvidenceBindingV1,
  createDeletionMutationReceiptV1,
  createDeletionStatusV1,
  createMemoryConsentEvidenceV1,
  createMemoryLifecycleAuditV1,
  createMemoryProposalV2,
  createMemoryRecordV2,
  createMemoryRevisionEvidenceV1,
  createMemoryRevisionV2,
  createMemoryV1ToV2AggregateManifestV1,
  isMemoryProposalFullWirePurgeEligibleV2,
  memoryLifecycleDomainHashV1,
  parseDeletionMutationReceiptV1,
  parseDeletionStatusV1,
  parseMemoryConsentEvidenceV1,
  parseMemoryLifecycleAuditV1,
  parseMemoryProposalV2,
  parseMemoryRecordV2,
  parseMemoryRevisionEvidenceV1,
  parseMemoryRevisionV2,
  parseMemoryV1ToV2AggregateManifestV1,
  requireMemoryV1ToV2AggregateManifestV1,
  type MemoryConsentEvidenceV1,
  type MemoryProposalV2,
  type MemoryRecordV2,
  type MemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
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
  actor2: `actor:${HASH_B}`,
  proposal: `proposal:${HASH_C}`,
  memory: `memory:${HASH_D}`,
  evidence: `evidence:${HASH_E}`,
  evidence2: `evidence:${HASH_A}`
})
const TIMES = Object.freeze({
  proposed: '2026-07-22T00:00:00.000Z',
  approved: '2026-07-22T00:01:00.000Z',
  valid: '2027-07-22T00:00:00.000Z',
  purge: '2027-08-21T00:00:00.000Z'
})

function mutable<T> (value: T): T {
  return structuredClone(value)
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

function proposalDraft (
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    proposalId: IDS.proposal,
    namespace: personalMemoryNamespaceFixture(),
    namespaceGeneration: 1,
    initiatedByActorRef: IDS.actor,
    proposedBy: deepFreezeFixture({
      kind: 'model', runRef: `run:${HASH_A}`, modelProfile: 'deepseek-chat'
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
    consentPolicyGeneration: null,
    ...overrides
  }
}

function consentEvidence (
  proposal: MemoryProposalV2,
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryConsentEvidenceV1 {
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
    policyGeneration: null,
    ...overrides
  })
}

function recordFromProposal (
  proposal: MemoryProposalV2,
  evidence: MemoryConsentEvidenceV1,
  overrides: Readonly<Record<string, unknown>> = {}
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
    deletionState: 'active',
    ...overrides
  })
}

function createdRevision (
  record: MemoryRecordV2,
  evidence: MemoryConsentEvidenceV1
): MemoryRevisionV2 {
  return createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: evidence.approvedByActorRef,
    changedAt: record.updatedAt,
    reason: null,
    evidence: deepFreezeFixture({
      kind: 'consent', evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash
    }),
    previousRevisionHash: null
  })
}

test('lifecycle domain hash vector and canonical proposal are stable and deeply frozen', () => {
  assert.equal(
    memoryLifecycleDomainHashV1('groupmate.test.v1', 'fixed-preimage'),
    '4d30cf3a28e759ecc25984e942b03ce3f45cec17ee479381a43711920ae67794'
  )
  const proposal = createMemoryProposalV2(proposalDraft())
  assert.equal(proposal.state, 'pending')
  assert.equal(proposal.revision, 1)
  assertDeepFrozen(proposal)
  assert.deepEqual(parseMemoryProposalV2(mutable(proposal)), proposal)

  for (const field of ['plannedMemoryId', 'text', 'confidence'] as const) {
    const changed = proposalDraft({
      [field]: field === 'confidence'
        ? 0.8
        : field === 'plannedMemoryId'
          ? `memory:${HASH_E}`
          : '喜欢美式咖啡'
    })
    const next = createMemoryProposalV2(changed)
    assert.notEqual(next.consentTargetHash, proposal.consentTargetHash, field)
  }
  const shifted = createMemoryProposalV2(proposalDraft({
    proposedAt: '2026-07-23T00:00:00.000Z',
    suggestedRetention: {
      validUntil: '2027-07-23T00:00:00.000Z',
      purgeAt: '2027-08-22T00:00:00.000Z'
    }
  }))
  assert.notEqual(shifted.consentTargetHash, proposal.consentTargetHash, 'proposedAt')
})

test('proposal parser enforces withdrawn state, typed approval result and exact retention', () => {
  const proposal = createMemoryProposalV2(proposalDraft())
  const rejectedDecision = {
    decidedAt: TIMES.approved,
    decidedByActorRef: IDS.actor,
    reason: '不保存',
    consentEvidenceId: null,
    consentEvidenceHash: null,
    resultingMemoryId: null,
    resultingMemoryRevision: null,
    resultingRevisionHash: null
  }
  for (const state of ['rejected', 'withdrawn'] as const) {
    assert.doesNotThrow(() => parseMemoryProposalV2({
      ...mutable(proposal), state, revision: 2, decision: rejectedDecision
    }))
  }
  const before = '2026-07-28T23:59:59.999Z'
  const cutoff = '2026-07-29T00:00:00.000Z'
  const approvalDecision = {
    ...rejectedDecision,
    reason: null,
    consentEvidenceId: IDS.evidence,
    consentEvidenceHash: HASH_A,
    resultingMemoryId: IDS.memory,
    resultingMemoryRevision: 1,
    resultingRevisionHash: HASH_B
  }
  assert.doesNotThrow(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'approved', revision: 2,
    decision: { ...approvalDecision, decidedAt: before }
  }))
  assert.throws(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'approved', revision: 2,
    decision: { ...approvalDecision, decidedAt: cutoff }
  }), TypeError)
  assert.doesNotThrow(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'expired', revision: 2,
    decision: { ...rejectedDecision, decidedAt: '2026-07-29T00:00:00.000Z' }
  }))
  assert.doesNotThrow(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'approved', revision: 2,
    decision: {
      ...rejectedDecision,
      consentEvidenceId: IDS.evidence,
      consentEvidenceHash: HASH_A,
      resultingMemoryId: IDS.memory,
      resultingMemoryRevision: 1,
      resultingRevisionHash: HASH_B
    }
  }))
  assert.throws(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'rejected', revision: 2,
    decision: { ...rejectedDecision, consentEvidenceId: IDS.evidence }
  }), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    suggestedRetention: { validUntil: TIMES.valid, purgeAt: '2027-08-20T00:00:00.000Z' }
  })), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    suggestedRetention: {
      validUntil: '2031-07-22T00:00:00.000Z',
      purgeAt: '2031-08-21T00:00:00.000Z'
    }
  })), TypeError)
})

test('proposal decisions and explicit consent use the strict deadline and retention cutoff', () => {
  const proposal = createMemoryProposalV2(proposalDraft())
  const baseDecision = {
    decidedByActorRef: IDS.actor,
    reason: null,
    consentEvidenceId: null,
    consentEvidenceHash: null,
    resultingMemoryId: null,
    resultingMemoryRevision: null,
    resultingRevisionHash: null
  }
  const before = '2026-07-28T23:59:59.999Z'
  const cutoff = '2026-07-29T00:00:00.000Z'
  for (const state of ['rejected', 'withdrawn'] as const) {
    assert.doesNotThrow(() => parseMemoryProposalV2({
      ...mutable(proposal), state, revision: 2,
      decision: { ...baseDecision, decidedAt: before }
    }))
    assert.throws(() => parseMemoryProposalV2({
      ...mutable(proposal), state, revision: 2,
      decision: { ...baseDecision, decidedAt: cutoff }
    }), TypeError)
  }
  assert.throws(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'expired', revision: 2,
    decision: { ...baseDecision, decidedAt: before }
  }), TypeError)
  assert.doesNotThrow(() => parseMemoryProposalV2({
    ...mutable(proposal), state: 'expired', revision: 2,
    decision: { ...baseDecision, decidedAt: cutoff }
  }))

  const beforeEvidence = consentEvidence(proposal, { approvedAt: before })
  assert.doesNotThrow(() => assertMemoryConsentEvidenceForProposalV1(
    proposal,
    beforeEvidence
  ))
  const cutoffEvidence = consentEvidence(proposal, { approvedAt: cutoff })
  assert.throws(() => assertMemoryConsentEvidenceForProposalV1(
    proposal,
    cutoffEvidence
  ), TypeError)

  const oneDayProposal = createMemoryProposalV2(proposalDraft({
    suggestedRetention: {
      validUntil: '2026-07-23T00:00:00.000Z',
      purgeAt: '2026-08-22T00:00:00.000Z'
    }
  }))
  assert.throws(() => parseMemoryProposalV2({
    ...mutable(oneDayProposal), state: 'rejected', revision: 2,
    decision: { ...baseDecision, decidedAt: '2026-07-23T00:00:00.000Z' }
  }), TypeError)
})

test('proposal parser fails closed on namespace consent, group admission and correction self-conflict', () => {
  const groupNamespace = createMemoryNamespaceV1({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scope: {
      kind: 'group', groupId: FIXTURE_IDS.groupId,
      groupLifecycleId: FIXTURE_IDS.groupLifecycleId
    }
  })
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    namespace: groupNamespace,
    kind: 'preference',
    sensitivity: 'group'
  })), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    namespace: groupNamespace,
    kind: 'group_rule',
    sensitivity: 'group',
    consentRequirement: 'owner_policy',
    consentPolicyRef: `policy:${HASH_A}`,
    consentPolicyGeneration: 1
  })), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    intent: {
      kind: 'correction', targetMemoryId: IDS.memory,
      targetRevision: 1, targetRevisionHash: HASH_A
    },
    conflict: {
      state: 'confirmed', relatedMemoryIds: [IDS.memory], note: '自引用'
    }
  })), TypeError)

  assert.throws(() => createMemoryProposalV2(proposalDraft({
    sources: [memorySourceFixture({ observedAt: '1969-12-31T23:59:59.999Z' })]
  })), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    sources: [memorySourceFixture({ observedAt: '2026-07-22T00:00:00.001Z' })]
  })), TypeError)
  assert.throws(() => createMemoryProposalV2(proposalDraft({
    intent: {
      kind: 'correction', targetMemoryId: IDS.memory,
      targetRevision: 33, targetRevisionHash: HASH_A
    }
  })), TypeError)
  const atHistoryLimit = createMemoryProposalV2(proposalDraft({
    intent: {
      kind: 'correction', targetMemoryId: IDS.memory,
      targetRevision: 32, targetRevisionHash: HASH_A
    }
  }))
  assert.doesNotThrow(() => createMemoryProposalV2(proposalDraft({
    intent: {
      kind: 'correction', targetMemoryId: IDS.memory,
      targetRevision: 1, targetRevisionHash: HASH_A
    },
    suggestedRetention: {
      validUntil: '2026-07-23T00:00:00.001Z',
      purgeAt: '2026-08-22T00:00:00.001Z'
    }
  })))
  assert.throws(() => parseMemoryProposalV2({
    ...mutable(atHistoryLimit), state: 'approved', revision: 2,
    decision: {
      decidedAt: TIMES.approved,
      decidedByActorRef: IDS.actor,
      reason: null,
      consentEvidenceId: IDS.evidence,
      consentEvidenceHash: HASH_A,
      resultingMemoryId: IDS.memory,
      resultingMemoryRevision: 33,
      resultingRevisionHash: HASH_B
    }
  }), TypeError)
})

test('consent evidence, record and revision bind without consuming content source slots', () => {
  const sources = Array.from({ length: 8 }, (_, index) => memorySourceFixture({
    messageId: `message-${index + 1}`,
    normalizedText: `第 ${index + 1} 条内容来源`
  }))
  const proposal = createMemoryProposalV2(proposalDraft({ sources }))
  const evidence = consentEvidence(proposal)
  assertDeepFrozen(evidence)
  assert.deepEqual(parseMemoryConsentEvidenceV1(mutable(evidence)), evidence)
  assert.deepEqual(assertMemoryConsentEvidenceForProposalV1(proposal, evidence), evidence)
  const record = recordFromProposal(proposal, evidence)
  assert.equal(record.sources.length, 8)
  assert.deepEqual(parseMemoryRecordV2(mutable(record)), record)
  assert.deepEqual(assertMemoryRecordApprovalBindingV2(proposal, evidence, record), record)
  const revision1 = createdRevision(record, evidence)
  assert.deepEqual(parseMemoryRevisionV2(mutable(revision1)), revision1)
  const approved = parseMemoryProposalV2({
    ...mutable(proposal),
    state: 'approved',
    revision: 2,
    decision: {
      decidedAt: evidence.approvedAt,
      decidedByActorRef: evidence.approvedByActorRef,
      reason: null,
      consentEvidenceId: evidence.evidenceId,
      consentEvidenceHash: evidence.evidenceHash,
      resultingMemoryId: record.memoryId,
      resultingMemoryRevision: 1,
      resultingRevisionHash: revision1.revisionHash
    }
  })
  assert.deepEqual(
    assertMemoryCreateApprovalResultBindingV2(approved, evidence, record, revision1).revision,
    revision1
  )
  assert.throws(() => createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: IDS.actor2,
    changedAt: record.updatedAt,
    reason: null,
    evidence: {
      kind: 'consent', evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash
    },
    previousRevisionHash: null
  }), TypeError)
  assert.throws(() => createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: evidence.approvedByActorRef,
    changedAt: record.updatedAt,
    reason: null,
    evidence: {
      kind: 'consent', evidenceId: IDS.evidence2, evidenceHash: evidence.evidenceHash
    },
    previousRevisionHash: null
  }), TypeError)
  const supersedingRecord = recordFromProposal(proposal, evidence, {
    supersedes: [`memory:${HASH_E}`]
  })
  assert.throws(() => assertMemoryRecordApprovalBindingV2(
    proposal,
    evidence,
    supersedingRecord
  ), TypeError)
  const reasonedRevision = createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: evidence.approvedByActorRef,
    changedAt: record.updatedAt,
    reason: '由明确指令保存',
    evidence: {
      kind: 'consent', evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash
    },
    previousRevisionHash: null
  })
  assert.throws(() => assertMemoryCreateApprovalResultBindingV2(
    approved,
    evidence,
    record,
    reasonedRevision
  ), TypeError)

  const {
    schemaVersion: _recordSchemaVersion,
    namespaceRef: _recordNamespaceRef,
    contentHash: _recordContentHash,
    ...record2Draft
  } = mutable(record)
  const record2 = createMemoryRecordV2({
    ...record2Draft,
    revision: 2,
    text: '喜欢无糖拿铁',
    updatedAt: '2026-07-23T00:00:00.000Z'
  })
  const revisionEvidence = createMemoryRevisionEvidenceV1({
    evidenceId: IDS.evidence2,
    evidenceKind: 'explicit',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: 2,
    operation: 'corrected',
    baseRevisionHash: revision1.revisionHash,
    revisionTargetHash: record2.contentHash,
    changedByActorRef: IDS.actor,
    changedAt: record2.updatedAt,
    source: memorySourceFixture({
      sourceKind: 'manual_correction', messageId: null,
      normalizedText: '更正为无糖拿铁'
    }),
    policyRef: null,
    policyGeneration: null
  })
  const revision2 = createMemoryRevisionV2({
    memoryId: record2.memoryId,
    revision: 2,
    operation: 'corrected',
    record: record2,
    changedByActorRef: IDS.actor,
    changedAt: record2.updatedAt,
    reason: '用户更正',
    evidence: {
      kind: 'revision',
      evidenceId: revisionEvidence.evidenceId,
      evidenceHash: revisionEvidence.evidenceHash
    },
    previousRevisionHash: revision1.revisionHash
  })
  assert.deepEqual(parseMemoryRevisionEvidenceV1(mutable(revisionEvidence)), revisionEvidence)
  assert.deepEqual(assertMemoryRevisionEvidenceBindingV1(revisionEvidence, revision2), revisionEvidence)
  assert.throws(() => createMemoryRevisionEvidenceV1({
    evidenceId: `evidence:${HASH_D}`,
    evidenceKind: 'explicit',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: 2,
    operation: 'corrected',
    baseRevisionHash: revision1.revisionHash,
    revisionTargetHash: record2.contentHash,
    changedByActorRef: IDS.actor,
    changedAt: record2.updatedAt,
    source: memorySourceFixture({ observedAt: '2026-07-23T00:00:00.001Z' }),
    policyRef: null,
    policyGeneration: null
  }), TypeError)
  assert.throws(() => assertMemoryRecordApprovalBindingV2(
    proposal,
    evidence,
    record2
  ), TypeError)
  const correction = createMemoryProposalV2(proposalDraft({
    intent: {
      kind: 'correction', targetMemoryId: IDS.memory,
      targetRevision: 1, targetRevisionHash: revision1.revisionHash
    }
  }))
  assert.throws(() => assertMemoryRecordApprovalBindingV2(
    correction,
    consentEvidence(correction),
    recordFromProposal(correction, consentEvidence(correction))
  ), TypeError)
})

test('legacy manifest is exact, ordered, bounded and mandatory only for non-empty data', () => {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const manifest = createMemoryV1ToV2AggregateManifestV1({
    namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'memory',
      aggregateId: IDS.memory,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 3,
      legacyProposalWireHashes: [HASH_A, HASH_B],
      legacyRevisionWires: [
        { revision: 1, legacyWireHash: HASH_C },
        { revision: 2, legacyWireHash: HASH_D },
        { revision: 3, legacyWireHash: HASH_E }
      ]
    },
    initiatedByActorRef: IDS.actor,
    plannedMemoryId: IDS.memory,
    intent: { kind: 'create' },
    consentEvidenceId: IDS.evidence,
    consentEvidenceHash: HASH_A,
    revisionEvidenceBindings: [
      { revision: 2, evidenceId: IDS.evidence2, evidenceHash: HASH_B },
      { revision: 3, evidenceId: `evidence:${HASH_C}`, evidenceHash: HASH_C }
    ]
  })
  assertDeepFrozen(manifest)
  assert.deepEqual(parseMemoryV1ToV2AggregateManifestV1(mutable(manifest)), manifest)
  const expectation = {
    namespaceRef,
    namespaceGeneration: 1,
    aggregateKind: 'memory',
    aggregateId: IDS.memory,
    proposalState: 'approved',
    proposalRevision: 2,
    currentRevision: 3,
    legacyProposalWireHashes: [HASH_A, HASH_B],
    legacyRevisionWires: [
      { revision: 1, legacyWireHash: HASH_C },
      { revision: 2, legacyWireHash: HASH_D },
      { revision: 3, legacyWireHash: HASH_E }
    ]
  }
  assert.deepEqual(
    requireMemoryV1ToV2AggregateManifestV1(1, manifest, expectation),
    manifest
  )
  assert.equal(requireMemoryV1ToV2AggregateManifestV1(0, null, null), null)
  assert.throws(() => requireMemoryV1ToV2AggregateManifestV1(1, null, expectation), TypeError)
  const {
    schemaVersion: _manifestSchemaVersion,
    manifestId: _manifestId,
    manifestHash: _manifestHash,
    ...manifestDraft
  } = mutable(manifest)
  assert.throws(() => createMemoryV1ToV2AggregateManifestV1({
    ...manifestDraft,
    revisionEvidenceBindings: [
      { revision: 3, evidenceId: `evidence:${HASH_C}`, evidenceHash: HASH_C },
      { revision: 2, evidenceId: IDS.evidence2, evidenceHash: HASH_B }
    ]
  }), TypeError)
  assert.throws(() => requireMemoryV1ToV2AggregateManifestV1(1, manifest, {
    ...expectation,
    proposalState: 'rejected'
  }), TypeError)
  assert.throws(() => createMemoryV1ToV2AggregateManifestV1({
    ...manifestDraft,
    aggregate: {
      ...manifestDraft.aggregate as object,
      legacyRevisionWires: [
        { revision: 1, legacyWireHash: HASH_C },
        { revision: 3, legacyWireHash: HASH_E }
      ]
    }
  }), TypeError)
  assert.throws(() => createMemoryV1ToV2AggregateManifestV1({
    namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'proposal',
      aggregateId: IDS.proposal,
      proposalState: 'withdrawn',
      proposalRevision: 2,
      legacyProposalWireHashes: [HASH_A, HASH_B],
      legacyRevisionWires: []
    },
    initiatedByActorRef: IDS.actor,
    plannedMemoryId: IDS.memory,
    intent: { kind: 'create' },
    consentEvidenceId: null,
    consentEvidenceHash: null,
    revisionEvidenceBindings: []
  }), TypeError)
  assert.throws(() => createMemoryV1ToV2AggregateManifestV1({
    namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'proposal',
      aggregateId: IDS.proposal,
      proposalState: 'approved',
      proposalRevision: 2,
      legacyProposalWireHashes: [HASH_A, HASH_B],
      legacyRevisionWires: []
    },
    initiatedByActorRef: IDS.actor,
    plannedMemoryId: IDS.memory,
    intent: { kind: 'create' },
    consentEvidenceId: IDS.evidence,
    consentEvidenceHash: HASH_A,
    revisionEvidenceBindings: []
  }), TypeError)
})

test('body-free audit and deletion receipts enforce hashes, TTLs and status stages', () => {
  assert.equal(
    MEMORY_DELETION_EXCLUSIONS_HASH_V1,
    'ef27812b63ca3d4a28820b1e98d59b3b1727f538fc2301d857628170b4514d13'
  )
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
  assert.equal(
    Date.parse(audit.expiresAt) - Date.parse(audit.recordedAt),
    MEMORY_LIFECYCLE_AUDIT_RETENTION_DAYS_V1 * MEMORY_LIFECYCLE_DAY_MS
  )
  assert.deepEqual(parseMemoryLifecycleAuditV1(mutable(audit)), audit)
  assert.equal(JSON.stringify(audit).includes('无糖'), false)
  assert.throws(() => parseMemoryLifecycleAuditV1({
    ...mutable(audit), receiptHash: HASH_A
  }), TypeError)

  const receipt = createDeletionMutationReceiptV1({
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
  assert.equal(receipt.exclusionsHash, MEMORY_DELETION_EXCLUSIONS_HASH_V1)
  assert.deepEqual(parseDeletionMutationReceiptV1(mutable(receipt)), receipt)
  assert.throws(() => parseDeletionMutationReceiptV1({
    ...mutable(receipt), exclusionsHash: HASH_D
  }), TypeError)
  assert.throws(() => createDeletionMutationReceiptV1({
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
    tombstoneReceiptHash: HASH_C,
    exclusionsHash: HASH_D
  }), TypeError)
  const complete = createDeletionStatusV1({
    deletionRef: receipt.deletionRef,
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
  assert.deepEqual(parseDeletionStatusV1(mutable(complete)), complete)
  assert.throws(() => createDeletionStatusV1({
    ...mutable(complete),
    remainingCarrierKinds: ['revision'],
    canonicalBodies: 'verified_absent'
  }), TypeError)
})

test('date upper bound, proposal purge boundary and hostile objects fail closed', () => {
  assert.equal(
    addMemoryLifecycleDaysV1('+275755-08-16T00:00:00.000Z', 1_855),
    '+275760-09-13T00:00:00.000Z'
  )
  assert.throws(() => addMemoryLifecycleDaysV1('+275755-08-16T00:00:00.001Z', 1_855), TypeError)

  const pending = createMemoryProposalV2(proposalDraft())
  const expired = parseMemoryProposalV2({
    ...mutable(pending),
    revision: 2,
    state: 'expired',
    decision: {
      decidedAt: '2026-07-29T00:00:00.000Z',
      decidedByActorRef: IDS.actor,
      reason: null,
      consentEvidenceId: null,
      consentEvidenceHash: null,
      resultingMemoryId: null,
      resultingMemoryRevision: null,
      resultingRevisionHash: null
    }
  })
  assert.equal(isMemoryProposalFullWirePurgeEligibleV2(
    expired,
    '2026-08-27T23:59:59.999Z'
  ), false)
  assert.equal(isMemoryProposalFullWirePurgeEligibleV2(
    expired,
    '2026-08-28T00:00:00.000Z'
  ), true)
  assert.equal(isMemoryProposalFullWirePurgeEligibleV2(
    expired,
    '2026-08-28T00:00:00.001Z'
  ), true)

  assert.throws(() => parseMemoryProposalV2(new Proxy(mutable(pending), {})), TypeError)
  const getter = mutable(pending) as unknown as Record<string, unknown>
  Object.defineProperty(getter, 'text', { enumerable: true, get: () => '泄漏' })
  assert.throws(() => parseMemoryProposalV2(getter), TypeError)
  const symbol = mutable(pending) as unknown as Record<PropertyKey, unknown>
  symbol[Symbol('hidden')] = 'x'
  assert.throws(() => parseMemoryProposalV2(symbol), TypeError)
  const sparse = mutable(pending) as unknown as { sources: unknown[] }
  sparse.sources = new Array(1)
  assert.throws(() => parseMemoryProposalV2(sparse), TypeError)
})
