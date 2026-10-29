import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeCanonicalMemoryRecordV1,
  decodeCanonicalMemoryRevisionV1,
  encodeCanonicalMemoryRecordV1,
  parseCanonicalMemoryRecordV1
} from '../../src/agent/memory/memory-canonical-wire.js'
import { encodeMemoryRecordV1, encodeMemoryRevisionV1 } from '../../src/agent/memory/memory-codec.js'
import {
  encodeMemoryRecordV2,
  encodeMemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-codec.js'
import {
  MEMORY_RETENTION_POLICY_REF_V1,
  createMemoryConsentEvidenceV1,
  createMemoryProposalV2,
  createMemoryRecordV2,
  createMemoryRevisionV2,
  type MemoryRecordV2,
  type MemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const TIMES = Object.freeze({
  proposed: '2026-07-22T00:00:00.000Z',
  approved: '2026-07-22T00:01:00.000Z',
  valid: '2027-07-22T00:00:00.000Z',
  purge: '2027-08-21T00:00:00.000Z'
})
const IDS = Object.freeze({
  actor: `actor:${'a'.repeat(64)}`,
  proposal: `proposal:${'c'.repeat(64)}`,
  memory: `memory:${'d'.repeat(64)}`,
  evidence: `evidence:${'e'.repeat(64)}`
})

function recordV2 (): MemoryRecordV2 {
  const proposal = createMemoryProposalV2({
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
    observedAt: FIXTURE_TIMES.observedAt,
    proposedAt: TIMES.proposed,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: deepFreezeFixture({ state: 'none', relatedMemoryIds: [], note: null }),
    suggestedRetention: deepFreezeFixture({
      validUntil: TIMES.valid, purgeAt: TIMES.purge
    }),
    retentionPolicyRef: MEMORY_RETENTION_POLICY_REF_V1,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const evidence = createMemoryConsentEvidenceV1({
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

function revisionV2 (record: MemoryRecordV2): MemoryRevisionV2 {
  return createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: record.consent.approvedByActorRef,
    changedAt: record.updatedAt,
    reason: null,
    evidence: deepFreezeFixture({
      kind: 'consent', evidenceId: record.consent.evidenceId, evidenceHash: record.consent.evidenceHash
    }),
    previousRevisionHash: null
  })
}

test('both canonical record schemas round trip through the shared wire', () => {
  const v1 = memoryRecordFixture()
  const v2 = recordV2()
  assert.equal(parseCanonicalMemoryRecordV1(v1).schemaVersion, 1)
  assert.equal(parseCanonicalMemoryRecordV1(v2).schemaVersion, 2)
  for (const record of [v1, v2]) {
    const wire = encodeCanonicalMemoryRecordV1(record)
    const decoded = decodeCanonicalMemoryRecordV1(wire)
    assert.deepEqual(decoded, record)
    assert.equal(Object.isFrozen(decoded), true)
  }
  assert.equal(encodeCanonicalMemoryRecordV1(v1), encodeMemoryRecordV1(v1))
  assert.equal(encodeCanonicalMemoryRecordV1(v2), encodeMemoryRecordV2(v2))
})

test('both canonical revision schemas decode through the shared wire', () => {
  const v1 = memoryRevisionFixture()
  const v2 = revisionV2(recordV2())
  assert.equal(decodeCanonicalMemoryRevisionV1(encodeMemoryRevisionV1(v1)).schemaVersion, 1)
  assert.equal(decodeCanonicalMemoryRevisionV1(encodeMemoryRevisionV2(v2)).schemaVersion, 2)
  assert.deepEqual(decodeCanonicalMemoryRevisionV1(encodeMemoryRevisionV1(v1)), v1)
  assert.deepEqual(decodeCanonicalMemoryRevisionV1(encodeMemoryRevisionV2(v2)), v2)
})

test('decoding needs wire text, and a V2 failure falls back silently to V1', () => {
  // The already-parsed record object is not wire text, even though it is a valid canonical record.
  const v2 = recordV2()
  for (const wire of [v2, revisionV2(v2), 7, null, undefined, {}, [], Buffer.from('{}')]) {
    assert.throws(() => decodeCanonicalMemoryRecordV1(wire), TypeError)
    assert.throws(() => decodeCanonicalMemoryRevisionV1(wire), TypeError)
  }
  const v1 = memoryRecordFixture()
  assert.equal(decodeCanonicalMemoryRecordV1(encodeMemoryRecordV1(v1)).schemaVersion, 1)
  assert.equal(decodeCanonicalMemoryRevisionV1(encodeMemoryRevisionV1(memoryRevisionFixture())).schemaVersion, 1)
})

test('neither schema accepts tampered, truncated or foreign values', () => {
  const v2 = recordV2()
  const tampered = JSON.parse(encodeCanonicalMemoryRecordV1(v2)) as Record<string, unknown>
  tampered.text = '被改写的正文'
  for (const wire of [JSON.stringify(tampered), '{}', 'not json',
    encodeCanonicalMemoryRecordV1(v2).slice(0, 40)]) {
    assert.throws(() => decodeCanonicalMemoryRecordV1(wire))
  }
  for (const value of [{ schemaVersion: 3, text: 'x' }, { ...v2, schemaVersion: 7 }]) {
    assert.throws(() => encodeCanonicalMemoryRecordV1(value), TypeError)
    assert.throws(() => parseCanonicalMemoryRecordV1(value), TypeError)
  }
})
