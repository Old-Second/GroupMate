import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  buildMemoryConflictChangeBundleV1,
  buildMemoryCorrectionBundleV1,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1,
  deriveMemoryConsentEvidenceIdV1,
  deriveMemoryPlannedMemoryIdV2,
  deriveMemoryProposalIdV2,
  deriveMemoryRevisionEvidenceIdV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  assertMemoryCreateApprovalResultBindingV2,
  createMemoryConsentEvidenceV1,
  createMemoryProposalV2,
  createMemoryRecordV2,
  createMemoryRevisionV2,
  parseMemoryProposalV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  MEMORY_LIFECYCLE_COMMAND_HASH_DOMAIN_V1,
  MEMORY_LIFECYCLE_COMMAND_MATERIAL_HASH_DOMAIN_V1,
  createMemoryLifecycleCommandV1,
  decodeMemoryLifecycleCommandWireV1,
  encodeMemoryLifecycleCommandWireV1,
  memoryLifecycleCommandHashV1,
  memoryLifecycleCommandMaterialHashV1,
  memoryLifecycleCommandRefHashV1,
  memoryLifecycleCommandWireIsBodyFreeV1,
  parseMemoryLifecycleCommandV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const COMMAND_REF = `command:${'c'.repeat(64)}`
const MEMORY_ID = `memory:${'e'.repeat(64)}`
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const EXPECTED_HASH = 'f'.repeat(64)
const OCCURRED_AT = '2026-07-22T00:00:00.000Z'
const APPROVED_AT = '2026-07-22T00:01:00.000Z'
const CHANGED_AT = '2026-07-23T00:00:00.000Z'

function commandRef (digit: string): string {
  return `command:${digit.repeat(64)}`
}

function domainHash (domain: string, preimage: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(preimage, 'utf8')
    .digest('hex')
}

function proposalFixture (
  overrides: Readonly<Record<string, unknown>> = {},
  operation: 'proposal.create' | 'proposal.createAndApprove' = 'proposal.create',
  commandRef = COMMAND_REF
) {
  const namespace = personalMemoryNamespaceFixture()
  return buildMemoryProposalDraftV2(deepFreezeFixture({
    commandRef,
    operation,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: operation === 'proposal.createAndApprove'
      ? { kind: 'user', actorRef: ACTOR_REF }
      : {
          kind: 'model',
          runRef: FIXTURE_IDS.runRef,
          modelProfile: 'deepseek-chat'
        },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: [memorySourceFixture()],
    observedAt: FIXTURE_TIMES.observedAt,
    proposedAt: operation === 'proposal.createAndApprove' ? APPROVED_AT : OCCURRED_AT,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null,
    ...overrides
  }))
}

function createProposalCommand (material = proposalFixture()) {
  return createMemoryLifecycleCommandV1({
    commandRef: COMMAND_REF,
    operation: 'proposal.create',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: material.namespaceRef,
    expectedNamespaceGeneration: material.namespaceGeneration,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: OCCURRED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material
  })
}

function proposalApprovalBundle (
  approvalCommandRef: string,
  operation: 'proposal.approve' | 'proposal.createAndApprove',
  proposal = proposalFixture(
    {},
    operation === 'proposal.createAndApprove' ? operation : 'proposal.create',
    operation === 'proposal.createAndApprove' ? approvalCommandRef : commandRef('1')
  )
) {
  return buildMemoryProposalApprovalBundleV1({
    commandRef: approvalCommandRef,
    operation,
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    proposal,
    approvedByActorRef: ACTOR_REF,
    freshNow: APPROVED_AT,
    evidenceSource: memorySourceFixture(),
    reason: null
  })
}

function rebuildProposal (
  proposal: ReturnType<typeof proposalFixture>,
  overrides: Readonly<Record<string, unknown>>
) {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    namespaceRef: _namespaceRef,
    state: _state,
    consentTargetHash: _consentTargetHash,
    decision: _decision,
    ...draft
  } = structuredClone(proposal)
  return createMemoryProposalV2({ ...draft, ...overrides })
}

function forgedDirectApprovalMaterial (
  options: {
    readonly proposalOverrides?: Readonly<Record<string, unknown>>
    readonly evidenceSource?: unknown
    readonly approvedAt?: string
  } = {}
) {
  const directCommandRef = commandRef('2')
  const approvedAt = options.approvedAt ?? APPROVED_AT
  const pending = rebuildProposal(proposalFixture(
    {},
    'proposal.createAndApprove',
    directCommandRef
  ), options.proposalOverrides ?? {})
  const reference = {
    commandRef: directCommandRef,
    operation: 'proposal.createAndApprove' as const,
    namespaceRef: pending.namespaceRef,
    namespaceGeneration: pending.namespaceGeneration
  }
  const consentEvidence = createMemoryConsentEvidenceV1({
    evidenceId: deriveMemoryConsentEvidenceIdV1({
      ...reference,
      proposalId: pending.proposalId,
      consentTargetHash: pending.consentTargetHash
    }),
    evidenceKind: pending.consentRequirement,
    namespaceRef: pending.namespaceRef,
    namespaceGeneration: pending.namespaceGeneration,
    proposalId: pending.proposalId,
    proposalRevision: pending.revision,
    consentTargetHash: pending.consentTargetHash,
    approvedByActorRef: ACTOR_REF,
    approvedAt,
    source: Object.hasOwn(options, 'evidenceSource')
      ? options.evidenceSource
      : pending.consentRequirement === 'explicit'
        ? pending.sources[0]
        : null,
    policyRef: pending.consentPolicyRef,
    policyGeneration: pending.consentPolicyGeneration
  })
  const record = createMemoryRecordV2({
    memoryId: pending.plannedMemoryId,
    revision: 1,
    namespace: pending.namespace,
    namespaceGeneration: pending.namespaceGeneration,
    kind: pending.kind,
    text: pending.text,
    sources: pending.sources,
    createdAt: pending.proposedAt,
    observedAt: pending.observedAt,
    confirmedAt: approvedAt,
    updatedAt: approvedAt,
    validity: { state: 'current', validFrom: pending.observedAt },
    confidence: pending.confidence,
    consent: {
      state: consentEvidence.evidenceKind,
      approvedByActorRef: consentEvidence.approvedByActorRef,
      approvedAt: consentEvidence.approvedAt,
      consentTargetHash: consentEvidence.consentTargetHash,
      evidenceId: consentEvidence.evidenceId,
      evidenceHash: consentEvidence.evidenceHash,
      policyRef: consentEvidence.policyRef,
      policyGeneration: consentEvidence.policyGeneration
    },
    sensitivity: pending.sensitivity,
    conflict: pending.conflict,
    supersedes: [],
    retention: pending.suggestedRetention,
    retentionPolicyRef: pending.retentionPolicyRef,
    deletionState: 'active'
  })
  const revision = createMemoryRevisionV2({
    memoryId: record.memoryId,
    revision: record.revision,
    operation: 'created',
    record,
    changedByActorRef: ACTOR_REF,
    changedAt: approvedAt,
    reason: null,
    evidence: {
      kind: 'consent',
      evidenceId: consentEvidence.evidenceId,
      evidenceHash: consentEvidence.evidenceHash
    },
    previousRevisionHash: null
  })
  const proposal = parseMemoryProposalV2({
    ...pending,
    revision: 2,
    state: 'approved',
    decision: {
      decidedAt: approvedAt,
      decidedByActorRef: ACTOR_REF,
      reason: null,
      consentEvidenceId: consentEvidence.evidenceId,
      consentEvidenceHash: consentEvidence.evidenceHash,
      resultingMemoryId: record.memoryId,
      resultingMemoryRevision: record.revision,
      resultingRevisionHash: revision.revisionHash
    }
  })
  const material = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'proposal_approval_v1' as const,
    proposal,
    consentEvidence,
    record,
    revision
  })
  assert.doesNotThrow(() => assertMemoryCreateApprovalResultBindingV2(
    proposal,
    consentEvidence,
    record,
    revision
  ))
  return { directCommandRef, material }
}

function directApprovalWire (
  directCommandRef: string,
  material: ReturnType<typeof forgedDirectApprovalMaterial>['material'],
  occurredAt = APPROVED_AT
): string {
  return encodeMemoryLifecycleCommandWireV1({
    schemaVersion: 1,
    commandRef: directCommandRef,
    operation: 'proposal.createAndApprove',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: material.proposal.namespaceRef,
    expectedNamespaceGeneration: material.proposal.namespaceGeneration,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    materialKind: material.kind,
    materialHash: memoryLifecycleCommandMaterialHashV1(
      'proposal.createAndApprove',
      material.kind,
      JSON.stringify(material)
    )
  })
}

test('lifecycle command keeps canonical wire body-free and binds exact proposal material', () => {
  const command = createProposalCommand()
  const parsedWire = decodeMemoryLifecycleCommandWireV1(command.wire)

  assert.equal(Buffer.byteLength(command.wire, 'utf8') <=
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes, true)
  assert.equal(parsedWire.materialKind, 'proposal_v2')
  assert.match(parsedWire.materialHash ?? '', /^[0-9a-f]{64}$/)
  assert.equal(parsedWire.namespaceRef, memoryNamespaceRefV1(personalMemoryNamespaceFixture()))
  for (const forbidden of [
    '喜欢无糖咖啡', FIXTURE_IDS.subjectUserId, FIXTURE_IDS.accountId,
    'deepseek-chat', 'nickname', 'groupCard', 'capability', 'namespace"'
  ]) assert.equal(command.wire.includes(forbidden), false, forbidden)
  assert.equal(memoryLifecycleCommandWireIsBodyFreeV1(command.wire), true)
  assert.deepEqual(parseMemoryLifecycleCommandV1(command), command)

  const changed = proposalFixture({ text: '改写后的正文' })
  assert.throws(() => parseMemoryLifecycleCommandV1({
    wire: command.wire,
    material: changed
  }), TypeError)
})

test('lifecycle material and command hashes use independent operation-aware domains', () => {
  const command = createProposalCommand()
  const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
  const canonicalMaterial = JSON.stringify(command.material)
  const expectedMaterialHash = domainHash(
    `${MEMORY_LIFECYCLE_COMMAND_MATERIAL_HASH_DOMAIN_V1}.proposal.create.proposal_v2`,
    canonicalMaterial
  )
  assert.equal(wire.materialHash, expectedMaterialHash)
  assert.equal(
    memoryLifecycleCommandMaterialHashV1(
      'proposal.create',
      'proposal_v2',
      canonicalMaterial
    ),
    expectedMaterialHash
  )
  assert.notEqual(
    memoryLifecycleCommandMaterialHashV1(
      'proposal.createAndApprove',
      'proposal_v2',
      canonicalMaterial
    ),
    expectedMaterialHash
  )
  assert.equal(
    memoryLifecycleCommandHashV1(command.wire),
    domainHash(MEMORY_LIFECYCLE_COMMAND_HASH_DOMAIN_V1, command.wire)
  )
  assert.notEqual(memoryLifecycleCommandRefHashV1(COMMAND_REF), memoryLifecycleCommandHashV1(command.wire))
})

test('lifecycle command wire rejects noncanonical bytes, extra fields and active objects', () => {
  const command = createProposalCommand()
  const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
  assert.equal(encodeMemoryLifecycleCommandWireV1(wire), command.wire)
  assert.throws(() => decodeMemoryLifecycleCommandWireV1(` ${command.wire}`), TypeError)
  assert.throws(() => decodeMemoryLifecycleCommandWireV1(
    `${command.wire.slice(0, -1)},"capability":true}`
  ), TypeError)
  assert.throws(() => decodeMemoryLifecycleCommandWireV1(
    `${' '.repeat(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes + 1)}{}`
  ), TypeError)
  assert.throws(() => createMemoryLifecycleCommandV1(new Proxy({}, {})), TypeError)

  let getterRead = false
  const getter = Object.defineProperty({}, 'commandRef', {
    enumerable: true,
    get () {
      getterRead = true
      return COMMAND_REF
    }
  })
  assert.throws(() => createMemoryLifecycleCommandV1(getter), TypeError)
  assert.equal(getterRead, false)
})

test('builder output round-trips through every material-bearing command operation', () => {
  const directCommandRef = commandRef('2')
  const direct = proposalApprovalBundle(
    directCommandRef,
    'proposal.createAndApprove'
  )
  const directCommand = createMemoryLifecycleCommandV1({
    commandRef: directCommandRef,
    operation: 'proposal.createAndApprove',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: direct.proposal.namespaceRef,
    expectedNamespaceGeneration: direct.proposal.namespaceGeneration,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: APPROVED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material: direct
  })
  assert.deepEqual(parseMemoryLifecycleCommandV1(directCommand), directCommand)
  const splitReason = structuredClone(direct) as unknown as {
    proposal: { decision: { reason: string | null } }
  }
  splitReason.proposal.decision.reason = '与 revision 不一致'
  assert.throws(() => createMemoryLifecycleCommandV1({
    commandRef: directCommandRef,
    operation: 'proposal.createAndApprove',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: direct.proposal.namespaceRef,
    expectedNamespaceGeneration: direct.proposal.namespaceGeneration,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: APPROVED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material: splitReason
  }), TypeError)
  assert.throws(() => createMemoryLifecycleCommandV1({
    commandRef: directCommandRef,
    operation: 'proposal.createAndApprove',
    initiatedByActorRef: `actor:${'b'.repeat(64)}`,
    namespaceRef: direct.proposal.namespaceRef,
    expectedNamespaceGeneration: direct.proposal.namespaceGeneration,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: APPROVED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material: direct
  }), TypeError)
  const directReference = {
    commandRef: directCommandRef,
    namespaceRef: direct.proposal.namespaceRef,
    namespaceGeneration: direct.proposal.namespaceGeneration,
    operation: 'proposal.createAndApprove' as const
  }
  assert.equal(direct.proposal.proposalId, deriveMemoryProposalIdV2(directReference))
  assert.equal(direct.proposal.plannedMemoryId, deriveMemoryPlannedMemoryIdV2({
    ...directReference,
    proposalId: direct.proposal.proposalId,
    intent: direct.proposal.intent
  }))
  assert.equal(direct.consentEvidence.evidenceId, deriveMemoryConsentEvidenceIdV1({
    ...directReference,
    proposalId: direct.proposal.proposalId,
    consentTargetHash: direct.proposal.consentTargetHash
  }))

  const pending = proposalFixture({}, 'proposal.create', commandRef('1'))
  const approveCommandRef = commandRef('3')
  const approved = proposalApprovalBundle(
    approveCommandRef,
    'proposal.approve',
    pending
  )
  const approveCommand = createMemoryLifecycleCommandV1({
    commandRef: approveCommandRef,
    operation: 'proposal.approve',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: pending.namespaceRef,
    expectedNamespaceGeneration: pending.namespaceGeneration,
    aggregateRef: pending.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: pending.consentTargetHash,
    occurredAt: APPROVED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material: approved.consentEvidence
  })
  assert.deepEqual(parseMemoryLifecycleCommandV1(approveCommand), approveCommand)

  const before = direct.revision
  const correctionCommandRef = commandRef('4')
  const correction = buildMemoryCorrectionBundleV1({
    commandRef: correctionCommandRef,
    operation: 'record.correct',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: before.record.namespaceGeneration,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: CHANGED_AT,
    text: '喜欢无糖拿铁',
    confidence: 0.95,
    validity: before.record.validity,
    conflict: before.record.conflict,
    supersedes: before.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      normalizedText: '更正为无糖拿铁'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: '用户更正'
  })
  const renewalCommandRef = commandRef('5')
  const renewal = buildMemoryRenewalBundleV1({
    commandRef: renewalCommandRef,
    operation: 'record.renew',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: before.record.namespaceGeneration,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: CHANGED_AT,
    newValidUntil: '2028-07-22T00:00:00.000Z',
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture(),
    policyRef: null,
    policyGeneration: null,
    reason: '用户续期'
  })
  const conflictCommandRef = commandRef('6')
  const conflict = buildMemoryConflictChangeBundleV1({
    commandRef: conflictCommandRef,
    operation: 'record.changeConflict',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: before.record.namespaceGeneration,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: CHANGED_AT,
    validity: { state: 'uncertain', validFrom: null },
    conflict: {
      state: 'possible',
      relatedMemoryIds: [`memory:${'b'.repeat(64)}`],
      note: '存在冲突说法'
    },
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture(),
    policyRef: null,
    policyGeneration: null,
    reason: '标记冲突'
  })
  const changes = [
    {
      commandRef: correctionCommandRef,
      operation: 'record.correct' as const,
      material: correction,
      newValidUntil: null,
      newPurgeAt: null
    },
    {
      commandRef: renewalCommandRef,
      operation: 'record.renew' as const,
      material: renewal,
      newValidUntil: renewal.revision.record.retention.validUntil,
      newPurgeAt: renewal.revision.record.retention.purgeAt
    },
    {
      commandRef: conflictCommandRef,
      operation: 'record.changeConflict' as const,
      material: conflict,
      newValidUntil: null,
      newPurgeAt: null
    }
  ]
  for (const change of changes) {
    const command = createMemoryLifecycleCommandV1({
      commandRef: change.commandRef,
      operation: change.operation,
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: before.record.namespaceRef,
      expectedNamespaceGeneration: before.record.namespaceGeneration,
      aggregateRef: before.memoryId,
      expectedRevision: before.revision,
      expectedAggregateHash: before.revisionHash,
      occurredAt: CHANGED_AT,
      newValidUntil: change.newValidUntil,
      newPurgeAt: change.newPurgeAt,
      material: change.material
    })
    assert.deepEqual(parseMemoryLifecycleCommandV1(command), command)
    assert.equal(change.material.evidence.evidenceId, deriveMemoryRevisionEvidenceIdV1({
      commandRef: change.commandRef,
      namespaceRef: before.record.namespaceRef,
      namespaceGeneration: before.record.namespaceGeneration,
      operation: change.operation,
      memoryId: change.material.evidence.memoryId,
      revision: change.material.evidence.revision,
      baseRevisionHash: change.material.evidence.baseRevisionHash,
      revisionTargetHash: change.material.evidence.revisionTargetHash
    }))
  }
})

test('command parser rejects canonical material built for a different command identity', () => {
  const proposal = proposalFixture({}, 'proposal.create', commandRef('1'))
  assert.throws(() => createProposalCommand(proposal), TypeError)

  const matchingProposal = proposalFixture()
  assert.throws(() => createProposalCommand(rebuildProposal(matchingProposal, {
    plannedMemoryId: MEMORY_ID
  })), TypeError)
  assert.throws(() => createProposalCommand(rebuildProposal(matchingProposal, {
    proposalId: `proposal:${'d'.repeat(64)}`
  })), TypeError)

  const pending = proposalFixture({}, 'proposal.create', commandRef('1'))
  const approvalForAnotherCommand = proposalApprovalBundle(
    commandRef('2'),
    'proposal.approve',
    pending
  )
  assert.throws(() => createMemoryLifecycleCommandV1({
    commandRef: commandRef('3'),
    operation: 'proposal.approve',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: pending.namespaceRef,
    expectedNamespaceGeneration: pending.namespaceGeneration,
    aggregateRef: pending.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: pending.consentTargetHash,
    occurredAt: APPROVED_AT,
    newValidUntil: null,
    newPurgeAt: null,
    material: approvalForAnotherCommand.consentEvidence
  }), TypeError)
})

test('command parser rejects self-consistent direct saves that violate atomic consent', () => {
  assert.equal(proposalFixture().proposedBy.kind, 'model')
  const currentSource = memorySourceFixture()
  const historySource = memorySourceFixture({ sourceKind: 'group_history' })
  const secondSource = memorySourceFixture({
    messageId: 'message-second',
    normalizedText: '另一条当前消息'
  })
  const groupNamespace = createMemoryNamespaceV1({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scope: {
      kind: 'group',
      groupId: FIXTURE_IDS.groupId,
      groupLifecycleId: FIXTURE_IDS.groupLifecycleId
    }
  })
  const groupReference = {
    commandRef: commandRef('2'),
    operation: 'proposal.createAndApprove' as const,
    namespaceRef: memoryNamespaceRefV1(groupNamespace),
    namespaceGeneration: 1
  }
  const groupProposalId = deriveMemoryProposalIdV2(groupReference)
  const invalidCases = [
    { proposalOverrides: {
      proposedBy: {
        kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat'
      }
    } },
    { proposalOverrides: {
      proposedBy: { kind: 'user', actorRef: `actor:${'b'.repeat(64)}` }
    } },
    { proposalOverrides: { proposedAt: '2026-07-21T00:01:00.000Z' } },
    { proposalOverrides: { sources: [historySource] }, evidenceSource: currentSource },
    { proposalOverrides: { sources: [currentSource, secondSource] } },
    { evidenceSource: secondSource },
    { proposalOverrides: {
      consentRequirement: 'owner_policy',
      consentPolicyRef: 'policy:owner-memory',
      consentPolicyGeneration: 1
    } },
    { proposalOverrides: {
      proposalId: groupProposalId,
      namespace: groupNamespace,
      plannedMemoryId: deriveMemoryPlannedMemoryIdV2({
        ...groupReference,
        proposalId: groupProposalId,
        intent: { kind: 'create' }
      }),
      kind: 'group_rule',
      sensitivity: 'group',
      consentRequirement: 'group_policy',
      consentPolicyRef: 'policy:group-memory',
      consentPolicyGeneration: 1
    } }
  ] as const
  for (const options of invalidCases) {
    const { directCommandRef, material } = forgedDirectApprovalMaterial(options)
    const wire = directApprovalWire(directCommandRef, material)
    assert.throws(() => parseMemoryLifecycleCommandV1({ wire, material }), TypeError)
  }

  const valid = forgedDirectApprovalMaterial()
  assert.throws(() => parseMemoryLifecycleCommandV1({
    wire: directApprovalWire(valid.directCommandRef, valid.material, CHANGED_AT),
    material: valid.material
  }), TypeError)
})

test('lifecycle command fixes renewal, forget and namespace deletion null matrices', () => {
  const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  const base = {
    commandRef: COMMAND_REF,
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    occurredAt: OCCURRED_AT,
    material: null
  }
  const renewalWire = encodeMemoryLifecycleCommandWireV1({
    schemaVersion: 1,
    commandRef: COMMAND_REF,
    operation: 'record.renew',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: MEMORY_ID,
    expectedRevision: 2,
    expectedAggregateHash: EXPECTED_HASH,
    occurredAt: OCCURRED_AT,
    newValidUntil: '2027-07-22T00:00:00.000Z',
    newPurgeAt: '2027-08-21T00:00:00.000Z',
    materialKind: 'revision_change_v1',
    materialHash: '1'.repeat(64)
  })
  assert.equal(decodeMemoryLifecycleCommandWireV1(renewalWire).materialKind, 'revision_change_v1')

  for (const invalid of [
    {
      ...base,
      operation: 'record.renew', aggregateRef: MEMORY_ID, expectedRevision: 2,
      expectedAggregateHash: EXPECTED_HASH, newValidUntil: '2027-07-22T00:00:00.000Z',
      newPurgeAt: '2027-08-20T00:00:00.000Z'
    },
    {
      ...base,
      operation: 'record.renew', aggregateRef: MEMORY_ID, expectedRevision: 2,
      expectedAggregateHash: EXPECTED_HASH, newValidUntil: '2027-07-22T00:00:00.000Z',
      newPurgeAt: '2027-08-21T00:00:00.000Z'
    },
    {
      ...base,
      operation: 'record.forget', aggregateRef: MEMORY_ID, expectedRevision: null,
      expectedAggregateHash: EXPECTED_HASH, newValidUntil: null, newPurgeAt: null
    },
    {
      ...base,
      operation: 'record.forget', aggregateRef: MEMORY_ID, expectedRevision: 33,
      expectedAggregateHash: EXPECTED_HASH, newValidUntil: null, newPurgeAt: null
    },
    {
      ...base,
      operation: 'namespace.delete', aggregateRef: MEMORY_ID, expectedRevision: null,
      expectedAggregateHash: null, newValidUntil: null, newPurgeAt: null
    }
  ]) assert.throws(() => createMemoryLifecycleCommandV1(invalid), TypeError)

  assert.doesNotThrow(() => createMemoryLifecycleCommandV1({
    ...base,
    operation: 'record.forget',
    aggregateRef: MEMORY_ID,
    expectedRevision: null,
    expectedAggregateHash: null,
    newValidUntil: null,
    newPurgeAt: null
  }))
  assert.doesNotThrow(() => createMemoryLifecycleCommandV1({
    ...base,
    operation: 'record.forget',
    aggregateRef: MEMORY_ID,
    expectedRevision: 32,
    expectedAggregateHash: EXPECTED_HASH,
    newValidUntil: null,
    newPurgeAt: null
  }))
  assert.doesNotThrow(() => createMemoryLifecycleCommandV1({
    ...base,
    operation: 'namespace.delete',
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    newValidUntil: null,
    newPurgeAt: null
  }))
})
