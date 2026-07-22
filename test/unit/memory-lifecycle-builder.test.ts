import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_CONSENT_EVIDENCE_ID_HASH_DOMAIN_V1,
  MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2,
  MEMORY_PLANNED_MEMORY_ID_HASH_DOMAIN_V2,
  MEMORY_PROPOSAL_ID_HASH_DOMAIN_V2,
  MEMORY_REVISION_EVIDENCE_ID_HASH_DOMAIN_V1,
  assertMemoryCorrectionProposalApprovalBundleV1,
  assertMemoryProposalApprovalBundleV1,
  assertMemoryRevisionChangeBundleV1,
  buildMemoryConflictChangeBundleV1,
  buildMemoryCorrectionBundleV1,
  buildMemoryCorrectionProposalDraftV2,
  buildMemoryCorrectionProposalApprovalBundleV1,
  buildMemoryInitialRetentionV2,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDecisionV2,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1,
  buildMemoryRenewalRetentionV2,
  deriveMemoryConsentEvidenceIdV1,
  deriveMemoryPlannedMemoryIdV2,
  deriveMemoryProposalIdV2,
  deriveMemoryRevisionEvidenceIdV1,
  projectMemoryProposalLifecycleV2,
  projectMemoryRecordLifecycleV2,
  requireMemoryV1ToV2ManifestInventoryV1,
  type MemoryLifecycleBuilderOperationV1,
  type MemoryLifecycleDeterministicReferenceInputV1,
  type MemoryProposalApprovalBundleV1,
  type MemoryRevisionChangeBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryProposalV2,
  createMemoryRevisionV2,
  createMemoryV1ToV2AggregateManifestV1,
  parseMemoryProposalV2,
  type MemoryProposalV2,
  type MemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  deepFreezeFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const BASE = '2026-07-22T00:00:00.000Z'
const PLUS_1_DAY = '2026-07-23T00:00:00.000Z'
const PLUS_7_DAYS = '2026-07-29T00:00:00.000Z'
const PLUS_90_DAYS = '2026-10-20T00:00:00.000Z'
const PLUS_180_DAYS = '2027-01-18T00:00:00.000Z'
const PLUS_365_DAYS = '2027-07-22T00:00:00.000Z'
const PLUS_1825_DAYS = '2031-07-21T00:00:00.000Z'
const ACTOR = `actor:${'1'.repeat(64)}`
const ACTOR_2 = `actor:${'2'.repeat(64)}`
const RELATED_MEMORY = `memory:${'9'.repeat(64)}`
const COMMANDS = Object.freeze({
  create: `command:${'1'.repeat(64)}`,
  createAndApprove: `command:${'2'.repeat(64)}`,
  approve: `command:${'3'.repeat(64)}`,
  correct: `command:${'4'.repeat(64)}`,
  renew: `command:${'5'.repeat(64)}`,
  conflict: `command:${'6'.repeat(64)}`,
  reject: `command:${'7'.repeat(64)}`,
  withdraw: `command:${'8'.repeat(64)}`,
  expire: `command:${'9'.repeat(64)}`,
  correctionProposal: `command:${'a'.repeat(64)}`,
  correctionApprove: `command:${'b'.repeat(64)}`
})

function mutable<T> (value: T): T {
  return structuredClone(value)
}

function reference (
  operation: MemoryLifecycleBuilderOperationV1,
  commandRef: string
): MemoryLifecycleDeterministicReferenceInputV1 {
  return {
    commandRef,
    namespaceRef: memoryNamespaceRefV1(personalMemoryNamespaceFixture()),
    namespaceGeneration: 1,
    operation
  }
}

function proposalDraft (
  operation: 'proposal.create' | 'proposal.createAndApprove' = 'proposal.create',
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryProposalV2 {
  const commandRef = operation === 'proposal.create'
    ? COMMANDS.create
    : COMMANDS.createAndApprove
  return buildMemoryProposalDraftV2({
    ...reference(operation, commandRef),
    initiatedByActorRef: ACTOR,
    namespace: personalMemoryNamespaceFixture(),
    proposedBy: operation === 'proposal.createAndApprove'
      ? { kind: 'user', actorRef: ACTOR }
      : {
          kind: 'model',
          runRef: FIXTURE_IDS.runRef,
          modelProfile: 'deepseek-chat'
        },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: [memorySourceFixture()],
    observedAt: '2026-07-19T00:00:00.000Z',
    proposedAt: operation === 'proposal.createAndApprove' ? PLUS_1_DAY : BASE,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null,
    ...overrides
  })
}

function rebuildProposal (
  proposal: MemoryProposalV2,
  overrides: Readonly<Record<string, unknown>>
): MemoryProposalV2 {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    namespaceRef: _namespaceRef,
    state: _state,
    consentTargetHash: _consentTargetHash,
    decision: _decision,
    ...draft
  } = mutable(proposal)
  return createMemoryProposalV2({ ...draft, ...overrides })
}

function approvalBundle (
  proposal: MemoryProposalV2,
  options: {
    readonly operation?: 'proposal.approve' | 'proposal.createAndApprove'
    readonly commandRef?: string
    readonly freshNow?: string
    readonly actor?: string
    readonly evidenceSource?: unknown
  } = {}
): MemoryProposalApprovalBundleV1 {
  const operation = options.operation ?? 'proposal.approve'
  const commandRef = options.commandRef ?? (operation === 'proposal.approve'
    ? COMMANDS.approve
    : COMMANDS.createAndApprove)
  return buildMemoryProposalApprovalBundleV1({
    ...reference(operation, commandRef),
    proposal,
    approvedByActorRef: options.actor ?? ACTOR,
    freshNow: options.freshNow ?? PLUS_1_DAY,
    evidenceSource: Object.hasOwn(options, 'evidenceSource')
      ? options.evidenceSource
      : operation === 'proposal.createAndApprove'
        ? proposal.sources[0]
        : memorySourceFixture({
            messageId: 'message-approval',
            normalizedText: '请记住我喜欢无糖咖啡'
          }),
    reason: null
  })
}

function correctionBundle (
  beforeRevision: MemoryRevisionV2,
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryRevisionChangeBundleV1 {
  return buildMemoryCorrectionBundleV1({
    ...reference('record.correct', COMMANDS.correct),
    beforeRevision,
    changedByActorRef: ACTOR,
    freshNow: '2026-07-24T00:00:00.000Z',
    text: '喜欢无糖拿铁',
    confidence: 0.95,
    validity: { state: 'current', validFrom: '2026-07-19T00:00:00.000Z' },
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    supersedes: [],
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      normalizedText: '更正为无糖拿铁'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: '用户更正',
    ...overrides
  })
}

function conflictBundle (
  beforeRevision: MemoryRevisionV2
): MemoryRevisionChangeBundleV1 {
  return buildMemoryConflictChangeBundleV1({
    ...reference('record.changeConflict', COMMANDS.conflict),
    beforeRevision,
    changedByActorRef: ACTOR,
    freshNow: '2026-07-25T00:00:00.000Z',
    validity: { state: 'uncertain', validFrom: null },
    conflict: {
      state: 'possible',
      relatedMemoryIds: [RELATED_MEMORY],
      note: '与既有偏好可能冲突'
    },
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      normalizedText: '这项偏好可能已经变化'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: '标记冲突'
  })
}

function correctionProposalDraft (
  beforeRevision: MemoryRevisionV2,
  commandRef = COMMANDS.correctionProposal,
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryProposalV2 {
  return buildMemoryCorrectionProposalDraftV2({
    ...reference('proposal.create', commandRef),
    initiatedByActorRef: ACTOR,
    namespace: beforeRevision.record.namespace,
    beforeRevision,
    proposedBy: {
      kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat'
    },
    text: '喜欢无糖拿铁',
    sources: [memorySourceFixture({
      messageId: 'message-correction-proposal',
      normalizedText: '我现在更喜欢无糖拿铁'
    })],
    observedAt: '2026-07-19T00:00:00.000Z',
    proposedAt: '2026-07-24T00:00:00.000Z',
    confidence: 0.96,
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null,
    ...overrides
  })
}

function recreatePendingProposal (
  proposal: MemoryProposalV2,
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryProposalV2 {
  return createMemoryProposalV2({
    proposalId: proposal.proposalId,
    namespace: proposal.namespace,
    namespaceGeneration: proposal.namespaceGeneration,
    initiatedByActorRef: proposal.initiatedByActorRef,
    proposedBy: proposal.proposedBy,
    plannedMemoryId: proposal.plannedMemoryId,
    intent: proposal.intent,
    kind: proposal.kind,
    text: proposal.text,
    sources: proposal.sources,
    observedAt: proposal.observedAt,
    proposedAt: proposal.proposedAt,
    confidence: proposal.confidence,
    sensitivity: proposal.sensitivity,
    conflict: proposal.conflict,
    suggestedRetention: proposal.suggestedRetention,
    retentionPolicyRef: proposal.retentionPolicyRef,
    consentRequirement: proposal.consentRequirement,
    consentPolicyRef: proposal.consentPolicyRef,
    consentPolicyGeneration: proposal.consentPolicyGeneration,
    ...overrides
  })
}

test('lifecycle deterministic references have fixed vectors and bind exact material', () => {
  const createReference = reference('proposal.create', COMMANDS.create)
  const proposalId = deriveMemoryProposalIdV2(createReference)
  const intent = deepFreezeFixture({ kind: 'create' as const })
  const memoryId = deriveMemoryPlannedMemoryIdV2({
    ...createReference,
    proposalId,
    intent
  })
  assert.equal(MEMORY_PROPOSAL_ID_HASH_DOMAIN_V2, 'groupmate.memory.proposal-id.v2')
  assert.equal(MEMORY_PLANNED_MEMORY_ID_HASH_DOMAIN_V2, 'groupmate.memory.planned-memory-id.v2')
  assert.equal(MEMORY_CONSENT_EVIDENCE_ID_HASH_DOMAIN_V1,
    'groupmate.memory.consent-evidence-id.v1')
  assert.equal(MEMORY_REVISION_EVIDENCE_ID_HASH_DOMAIN_V1,
    'groupmate.memory.revision-evidence-id.v1')
  assert.equal(
    proposalId,
    'proposal:793407db03623fe5c1846b19a0cf7061e613c4be7a1e2c30bc4a65f5f4cb63e8'
  )
  assert.equal(
    memoryId,
    'memory:41e58e0ca91b2112d2441018d57ca692b5c29913a7ae2068fc78887accee87e6'
  )

  const reordered = {
    operation: 'proposal.create',
    namespaceGeneration: 1,
    namespaceRef: createReference.namespaceRef,
    commandRef: COMMANDS.create
  }
  assert.equal(deriveMemoryProposalIdV2(reordered), proposalId)
  assert.notEqual(deriveMemoryProposalIdV2({
    ...createReference,
    namespaceRef: 'a'.repeat(64)
  }), proposalId)
  assert.notEqual(deriveMemoryProposalIdV2({
    ...createReference,
    namespaceGeneration: 2
  }), proposalId)
  const compositeReference = reference('proposal.createAndApprove', COMMANDS.create)
  assert.notEqual(deriveMemoryProposalIdV2(compositeReference), proposalId)
  assert.notEqual(memoryId, proposalId.replace('proposal:', 'memory:'))

  assert.throws(() => deriveMemoryPlannedMemoryIdV2({
    ...createReference,
    proposalId: `proposal:${'f'.repeat(64)}`,
    intent
  }), TypeError)
  const correctionIntent = {
    kind: 'correction' as const,
    targetMemoryId: RELATED_MEMORY,
    targetRevision: 3,
    targetRevisionHash: 'b'.repeat(64)
  }
  assert.equal(deriveMemoryPlannedMemoryIdV2({
    ...createReference,
    proposalId,
    intent: correctionIntent
  }), RELATED_MEMORY)

  const consentId = deriveMemoryConsentEvidenceIdV1({
    ...reference('proposal.approve', COMMANDS.approve),
    proposalId,
    consentTargetHash: 'c'.repeat(64)
  })
  assert.equal(
    consentId,
    'evidence:bebf27702ef29634706c41f1def3cc503b8da3e5ece83196632e5485860177b0'
  )
  assert.notEqual(deriveMemoryConsentEvidenceIdV1({
    ...reference('proposal.approve', COMMANDS.approve),
    proposalId,
    consentTargetHash: 'd'.repeat(64)
  }), consentId)
  const revisionId = deriveMemoryRevisionEvidenceIdV1({
    ...reference('record.correct', COMMANDS.correct),
    memoryId,
    revision: 2,
    baseRevisionHash: 'd'.repeat(64),
    revisionTargetHash: 'e'.repeat(64)
  })
  assert.equal(
    revisionId,
    'evidence:c1b9eaa74188d9385c0fd36d9634d8a2b6f287a5d4e66baf28a4fa67003130f8'
  )
  assert.notEqual(deriveMemoryRevisionEvidenceIdV1({
    ...reference('record.correct', COMMANDS.correct),
    memoryId,
    revision: 2,
    baseRevisionHash: 'd'.repeat(64),
    revisionTargetHash: 'f'.repeat(64)
  }), revisionId)
})

test('proposal builder canonicalizes object order but preserves source array order', () => {
  const firstSource = memorySourceFixture({
    messageId: 'message-first', normalizedText: '第一条来源'
  })
  const secondSource = memorySourceFixture({
    messageId: 'message-second', normalizedText: '第二条来源'
  })
  const first = proposalDraft('proposal.create', {
    proposedBy: {
      modelProfile: 'deepseek-chat',
      runRef: FIXTURE_IDS.runRef,
      kind: 'model'
    },
    conflict: { note: null, relatedMemoryIds: [], state: 'none' },
    sources: [firstSource, secondSource]
  })
  const same = proposalDraft('proposal.create', {
    proposedBy: {
      kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat'
    },
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    sources: [firstSource, secondSource]
  })
  const reversed = proposalDraft('proposal.create', {
    sources: [secondSource, firstSource]
  })
  assert.deepEqual(first, same)
  assert.equal(first.proposalId, reversed.proposalId)
  assert.equal(first.plannedMemoryId, reversed.plannedMemoryId)
  assert.notEqual(first.consentTargetHash, reversed.consentTargetHash)
})

test('direct save builder requires the initiating user, atomic time and current-message consent', () => {
  const ordinary = proposalDraft()
  assert.equal(ordinary.proposedBy.kind, 'model')

  const direct = proposalDraft('proposal.createAndApprove')
  assert.deepEqual(direct.proposedBy, { kind: 'user', actorRef: ACTOR })
  assert.equal(direct.proposedAt, PLUS_1_DAY)

  const invalidProposers = [
    { kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat' },
    { kind: 'user', actorRef: ACTOR_2 }
  ] as const
  for (const proposedBy of invalidProposers) {
    assert.throws(() => proposalDraft('proposal.createAndApprove', { proposedBy }), TypeError)

    const canonicalBypass = rebuildProposal(direct, { proposedBy })
    assert.throws(() => approvalBundle(canonicalBypass, {
      operation: 'proposal.createAndApprove',
      commandRef: COMMANDS.createAndApprove
    }), TypeError)
  }

  const currentSource = memorySourceFixture()
  const historySource = memorySourceFixture({ sourceKind: 'group_history' })
  const secondSource = memorySourceFixture({
    messageId: 'message-second',
    normalizedText: '另一条当前消息'
  })
  for (const sources of [[historySource], [currentSource, secondSource]]) {
    assert.throws(() => proposalDraft('proposal.createAndApprove', { sources }), TypeError)
    const canonicalBypass = rebuildProposal(direct, { sources })
    assert.throws(() => approvalBundle(canonicalBypass, {
      operation: 'proposal.createAndApprove',
      commandRef: COMMANDS.createAndApprove,
      evidenceSource: sources[0]
    }), TypeError)
  }

  const ownerPolicy = {
    consentRequirement: 'owner_policy',
    consentPolicyRef: 'policy:owner-memory',
    consentPolicyGeneration: 1
  } as const
  assert.throws(() => proposalDraft('proposal.createAndApprove', ownerPolicy), TypeError)
  assert.throws(() => approvalBundle(rebuildProposal(direct, ownerPolicy), {
    operation: 'proposal.createAndApprove',
    commandRef: COMMANDS.createAndApprove
  }), TypeError)

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
  assert.throws(() => proposalDraft('proposal.createAndApprove', {
    namespace: groupNamespace,
    namespaceRef: memoryNamespaceRefV1(groupNamespace),
    kind: 'group_rule',
    sensitivity: 'group',
    consentRequirement: 'group_policy',
    consentPolicyRef: 'policy:group-memory',
    consentPolicyGeneration: 1
  }), TypeError)

  assert.throws(() => approvalBundle(direct, {
    operation: 'proposal.createAndApprove',
    commandRef: COMMANDS.createAndApprove,
    evidenceSource: secondSource
  }), TypeError)
  assert.throws(() => approvalBundle(direct, {
    operation: 'proposal.createAndApprove',
    commandRef: COMMANDS.createAndApprove,
    freshNow: '2026-07-23T00:00:00.001Z'
  }), TypeError)
})

test('initial retention uses exact default/custom days and fails closed at Date bounds', () => {
  const expected = {
    profile_fact: PLUS_365_DAYS,
    preference: PLUS_365_DAYS,
    relationship: PLUS_365_DAYS,
    group_rule: PLUS_365_DAYS,
    group_culture: PLUS_365_DAYS,
    task_fact: PLUS_90_DAYS,
    other: PLUS_180_DAYS
  } as const
  for (const [kind, validUntil] of Object.entries(expected)) {
    const retention = buildMemoryInitialRetentionV2({
      proposedAt: BASE,
      kind,
      customTtlDays: null
    })
    assert.equal(MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2[
      kind as keyof typeof MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2
    ] > 0, true)
    assert.equal(retention.validUntil, validUntil)
    assert.equal(Date.parse(retention.purgeAt) - Date.parse(validUntil), 30 * 86_400_000)
  }
  assert.equal(buildMemoryInitialRetentionV2({
    proposedAt: BASE, kind: 'other', customTtlDays: 1
  }).validUntil, PLUS_1_DAY)
  assert.equal(buildMemoryInitialRetentionV2({
    proposedAt: BASE, kind: 'other', customTtlDays: 1_825
  }).validUntil, PLUS_1825_DAYS)
  for (const customTtlDays of [0, -1, 1.5, 1_826]) {
    assert.throws(() => buildMemoryInitialRetentionV2({
      proposedAt: BASE, kind: 'other', customTtlDays
    }), TypeError)
  }
  assert.deepEqual(buildMemoryInitialRetentionV2({
    proposedAt: '+275755-08-16T00:00:00.000Z',
    kind: 'other',
    customTtlDays: 1_825
  }), {
    validUntil: '+275760-08-14T00:00:00.000Z',
    purgeAt: '+275760-09-13T00:00:00.000Z'
  })
  for (const proposedAt of [
    '+275755-08-16T00:00:00.001Z',
    '1969-12-31T23:59:59.999Z'
  ]) {
    assert.throws(() => buildMemoryInitialRetentionV2({
      proposedAt, kind: 'other', customTtlDays: 1_825
    }), error => error instanceof TypeError && !(error instanceof RangeError))
  }
})

test('renewal retention enforces strict progress, fresh-now bounds and purge boundary', () => {
  const currentRetention = {
    validUntil: BASE,
    purgeAt: '2026-08-21T00:00:00.000Z'
  }
  assert.deepEqual(buildMemoryRenewalRetentionV2({
    currentRetention,
    freshNow: BASE,
    newValidUntil: PLUS_1_DAY
  }), {
    validUntil: PLUS_1_DAY,
    purgeAt: '2026-08-22T00:00:00.000Z'
  })
  assert.equal(buildMemoryRenewalRetentionV2({
    currentRetention,
    freshNow: BASE,
    newValidUntil: PLUS_1825_DAYS
  }).validUntil, PLUS_1825_DAYS)
  for (const candidate of [
    BASE,
    '2026-07-22T23:59:59.999Z',
    '2031-07-21T00:00:00.001Z'
  ]) {
    assert.throws(() => buildMemoryRenewalRetentionV2({
      currentRetention,
      freshNow: BASE,
      newValidUntil: candidate
    }), TypeError)
  }
  assert.doesNotThrow(() => buildMemoryRenewalRetentionV2({
    currentRetention,
    freshNow: '2026-08-20T23:59:59.999Z',
    newValidUntil: '2026-08-21T23:59:59.999Z'
  }))
  for (const freshNow of [
    '2026-08-21T00:00:00.000Z',
    '2026-08-21T00:00:00.001Z'
  ]) {
    assert.throws(() => buildMemoryRenewalRetentionV2({
      currentRetention,
      freshNow,
      newValidUntil: '2026-08-22T00:00:00.001Z'
    }), TypeError)
  }
})

test('proposal lifecycle uses T-1/T/T+1 for approval and full-wire readability', () => {
  const proposal = proposalDraft()
  for (const [freshNow, approveEligible, logicalState] of [
    ['2026-07-28T23:59:59.999Z', true, 'pending'],
    [PLUS_7_DAYS, false, 'expired_due'],
    ['2026-07-29T00:00:00.001Z', false, 'expired_due']
  ] as const) {
    const projection = projectMemoryProposalLifecycleV2(proposal, freshNow)
    assert.equal(projection.approveEligible, approveEligible)
    assert.equal(projection.logicalState, logicalState)
  }
  for (const [freshNow, readable] of [
    ['2026-08-27T23:59:59.999Z', true],
    ['2026-08-28T00:00:00.000Z', false],
    ['2026-08-28T00:00:00.001Z', false]
  ] as const) {
    assert.equal(projectMemoryProposalLifecycleV2(
      proposal,
      freshNow
    ).fullWireReadable, readable)
  }
  const oneDay = proposalDraft('proposal.create', { customTtlDays: 1 })
  assert.equal(projectMemoryProposalLifecycleV2(
    oneDay,
    '2026-07-22T23:59:59.999Z'
  ).approveEligible, true)
  assert.equal(projectMemoryProposalLifecycleV2(
    oneDay,
    PLUS_1_DAY
  ).approveEligible, false)
})

test('proposal decisions construct explicit after-images and normalize late rejection to expired', () => {
  const proposal = proposalDraft()
  const rejected = buildMemoryProposalDecisionV2({
    ...reference('proposal.reject', COMMANDS.reject),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: '2026-07-28T23:59:59.999Z',
    reason: '不保存'
  })
  assert.equal(rejected.state, 'rejected')
  assert.equal(rejected.revision, 2)
  assert.equal(rejected.text, proposal.text)
  assert.equal(rejected.consentTargetHash, proposal.consentTargetHash)
  const expired = buildMemoryProposalDecisionV2({
    ...reference('proposal.reject', COMMANDS.reject),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: PLUS_7_DAYS,
    reason: '已过期'
  })
  assert.equal(expired.state, 'expired')
  assert.throws(() => buildMemoryProposalDecisionV2({
    ...reference('proposal.expire', COMMANDS.expire),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: '2026-07-28T23:59:59.999Z',
    reason: null
  }), TypeError)
  assert.equal(buildMemoryProposalDecisionV2({
    ...reference('proposal.expire', COMMANDS.expire),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: PLUS_7_DAYS,
    reason: null
  }).state, 'expired')
  assert.equal(buildMemoryProposalDecisionV2({
    ...reference('proposal.withdraw', COMMANDS.withdraw),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: '2026-07-23T00:00:00.000Z',
    reason: null
  }).state, 'withdrawn')
  assert.throws(() => buildMemoryProposalDecisionV2({
    ...reference('proposal.reject', COMMANDS.reject),
    proposal,
    decidedByActorRef: ACTOR,
    freshNow: '2026-08-28T00:00:00.000Z',
    reason: null
  }), TypeError)
  for (const freshNow of [
    '2026-08-28T00:00:00.000Z',
    '2026-08-28T00:00:00.001Z'
  ]) {
    assert.equal(buildMemoryProposalDecisionV2({
      ...reference('proposal.expire', COMMANDS.expire),
      proposal,
      decidedByActorRef: ACTOR,
      freshNow,
      reason: null
    }).state, 'expired')
  }
})

test('approval bundle binds actor, time, evidence, hashes and record revision one', () => {
  const proposal = proposalDraft()
  const bundle = approvalBundle(proposal, {
    freshNow: '2026-07-28T23:59:59.999Z'
  })
  assert.equal(bundle.proposal.state, 'approved')
  assert.equal(bundle.consentEvidence.approvedByActorRef, ACTOR)
  assert.equal(bundle.revision.changedByActorRef, ACTOR)
  assert.equal(bundle.revision.changedAt, bundle.consentEvidence.approvedAt)
  assert.equal(bundle.record.confirmedAt, bundle.consentEvidence.approvedAt)
  assert.equal(bundle.record.consent.evidenceHash, bundle.consentEvidence.evidenceHash)
  assert.equal(bundle.proposal.decision?.resultingRevisionHash, bundle.revision.revisionHash)
  assert.deepEqual(assertMemoryProposalApprovalBundleV1(proposal, bundle), bundle)
  assert.equal(Buffer.byteLength(JSON.stringify(bundle), 'utf8') <=
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandMaterialWireBytes, true)
  assert.throws(() => approvalBundle(proposal, { freshNow: PLUS_7_DAYS }), TypeError)

  const compositeProposal = proposalDraft('proposal.createAndApprove')
  const composite = approvalBundle(compositeProposal, {
    operation: 'proposal.createAndApprove',
    commandRef: COMMANDS.createAndApprove
  })
  assert.equal(composite.proposal.state, 'approved')
  assert.equal(composite.proposal.proposalId, compositeProposal.proposalId)

  const tampered = mutable(bundle) as unknown as {
    revision: { changedByActorRef: string }
  }
  tampered.revision.changedByActorRef = ACTOR_2
  assert.throws(() => assertMemoryProposalApprovalBundleV1(proposal, tampered), TypeError)

  const splitRevision = createMemoryRevisionV2({
    memoryId: bundle.revision.memoryId,
    revision: bundle.revision.revision,
    operation: bundle.revision.operation,
    record: bundle.revision.record,
    changedByActorRef: bundle.revision.changedByActorRef,
    changedAt: bundle.revision.changedAt,
    reason: '与 proposal decision 不一致',
    evidence: bundle.revision.evidence,
    previousRevisionHash: bundle.revision.previousRevisionHash
  })
  const splitProposal = parseMemoryProposalV2({
    ...mutable(bundle.proposal),
    decision: {
      ...mutable(bundle.proposal.decision!),
      resultingRevisionHash: splitRevision.revisionHash
    }
  })
  assert.throws(() => assertMemoryProposalApprovalBundleV1(proposal, {
    ...bundle,
    proposal: splitProposal,
    revision: splitRevision
  }), TypeError)
})

test('record projection and correction/renew/conflict bundles enforce exact field deltas', () => {
  const initial = approvalBundle(proposalDraft())
  for (const [freshNow, state] of [
    ['2027-07-21T23:59:59.999Z', 'current'],
    [PLUS_365_DAYS, 'expired'],
    ['2027-07-22T00:00:00.001Z', 'expired'],
    ['2027-08-20T23:59:59.999Z', 'expired'],
    ['2027-08-21T00:00:00.000Z', 'purge_due'],
    ['2027-08-21T00:00:00.001Z', 'purge_due']
  ] as const) {
    assert.equal(projectMemoryRecordLifecycleV2(initial.record, freshNow).state, state)
  }

  const corrected = correctionBundle(initial.revision)
  assert.equal(corrected.revision.operation, 'corrected')
  assert.equal(corrected.revision.revision, 2)
  assert.equal(corrected.revision.previousRevisionHash, initial.revision.revisionHash)
  assert.equal(corrected.evidence.baseRevisionHash, initial.revision.revisionHash)
  assert.equal(corrected.evidence.revisionTargetHash, corrected.revision.record.contentHash)
  assert.deepEqual(corrected.revision.record.sources, initial.record.sources)
  assert.deepEqual(corrected.revision.record.retention, initial.record.retention)
  assert.deepEqual(
    assertMemoryRevisionChangeBundleV1(initial.revision, 'record.correct', corrected),
    corrected
  )
  assert.throws(() => correctionBundle(initial.revision, {
    text: initial.record.text,
    confidence: initial.record.confidence,
    validity: initial.record.validity,
    conflict: initial.record.conflict,
    supersedes: initial.record.supersedes
  }), TypeError)

  const changedConflict = conflictBundle(corrected.revision)
  assert.equal(changedConflict.revision.operation, 'conflict_changed')
  assert.equal(changedConflict.revision.record.text, corrected.revision.record.text)
  assert.deepEqual(changedConflict.revision.record.retention,
    corrected.revision.record.retention)
  assert.throws(() => buildMemoryConflictChangeBundleV1({
    ...reference('record.changeConflict', COMMANDS.conflict),
    beforeRevision: corrected.revision,
    changedByActorRef: ACTOR,
    freshNow: '2026-07-25T00:00:00.000Z',
    validity: corrected.revision.record.validity,
    conflict: corrected.revision.record.conflict,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction', messageId: null, normalizedText: '无变化'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  }), TypeError)

  const renewed = buildMemoryRenewalBundleV1({
    ...reference('record.renew', COMMANDS.renew),
    beforeRevision: initial.revision,
    changedByActorRef: ACTOR,
    freshNow: PLUS_365_DAYS,
    newValidUntil: '2027-07-23T00:00:00.000Z',
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      messageId: 'message-renew', normalizedText: '请再保留一年'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: '用户续期'
  })
  assert.equal(renewed.revision.operation, 'retention_changed')
  assert.equal(renewed.revision.record.text, initial.record.text)
  assert.equal(renewed.revision.record.retention.validUntil,
    '2027-07-23T00:00:00.000Z')
  assert.throws(() => correctionBundle(initial.revision, {
    freshNow: PLUS_365_DAYS
  }), TypeError)
  for (const freshNow of [
    '2027-08-20T23:59:59.999Z',
    '2027-08-21T00:00:00.000Z',
    '2027-08-21T00:00:00.001Z'
  ]) {
    const action = () => buildMemoryRenewalBundleV1({
      ...reference('record.renew', COMMANDS.renew),
      beforeRevision: initial.revision,
      changedByActorRef: ACTOR,
      freshNow,
      newValidUntil: freshNow === '2027-08-20T23:59:59.999Z'
        ? '2027-08-21T23:59:59.999Z'
        : '2027-08-22T00:00:00.001Z',
      evidenceKind: 'explicit',
      evidenceSource: memorySourceFixture({
        messageId: 'message-renew-boundary', normalizedText: '边界续期'
      }),
      policyRef: null,
      policyGeneration: null,
      reason: null
    })
    if (freshNow.endsWith('59:59.999Z')) assert.doesNotThrow(action)
    else assert.throws(action, TypeError)
  }
  assert.equal(Buffer.byteLength(JSON.stringify(corrected), 'utf8') <=
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandMaterialWireBytes, true)
})

test('correction proposal approval binds exact target and preserves immutable record history', () => {
  const initial = approvalBundle(proposalDraft())
  const pending = correctionProposalDraft(initial.revision)
  const correctionApprovalInput = {
    ...reference('proposal.approve', COMMANDS.correctionApprove),
    proposal: pending,
    beforeRevision: initial.revision,
    approvedByActorRef: ACTOR,
    freshNow: '2026-07-25T00:00:00.000Z',
    evidenceSource: memorySourceFixture({
      messageId: 'message-correction-approval',
      normalizedText: '确认更正为无糖拿铁'
    }),
    reason: '确认更正'
  }
  const bundle = buildMemoryCorrectionProposalApprovalBundleV1(
    correctionApprovalInput
  )
  assert.equal(bundle.proposal.state, 'approved')
  assert.equal(bundle.revision.operation, 'corrected')
  assert.equal(bundle.revision.revision, initial.revision.revision + 1)
  assert.equal(bundle.revision.previousRevisionHash, initial.revision.revisionHash)
  assert.equal(bundle.revisionEvidence.baseRevisionHash, initial.revision.revisionHash)
  assert.equal(bundle.revisionEvidence.revisionTargetHash, bundle.record.contentHash)
  assert.notEqual(bundle.consentEvidence.evidenceId, bundle.revisionEvidence.evidenceId)
  assert.deepEqual(bundle.record.sources, initial.record.sources)
  assert.deepEqual(bundle.record.retention, initial.record.retention)
  assert.deepEqual(bundle.record.consent, initial.record.consent)
  assert.equal(bundle.record.createdAt, initial.record.createdAt)
  assert.equal(bundle.record.observedAt, initial.record.observedAt)
  assert.equal(bundle.record.confirmedAt, initial.record.confirmedAt)
  assert.deepEqual(
    assertMemoryCorrectionProposalApprovalBundleV1(pending, initial.revision, bundle),
    bundle
  )
  assert.throws(() => buildMemoryCorrectionProposalApprovalBundleV1({
    ...correctionApprovalInput,
    validity: { state: 'uncertain', validFrom: null }
  }), TypeError)
  assert.throws(() => buildMemoryCorrectionProposalApprovalBundleV1({
    ...correctionApprovalInput,
    supersedes: [RELATED_MEMORY]
  }), TypeError)

  const wrongTarget = recreatePendingProposal(pending, {
    intent: {
      kind: 'correction',
      targetMemoryId: initial.record.memoryId,
      targetRevision: initial.revision.revision,
      targetRevisionHash: 'f'.repeat(64)
    }
  })
  assert.throws(() => buildMemoryCorrectionProposalApprovalBundleV1({
    ...reference('proposal.approve', COMMANDS.correctionApprove),
    proposal: wrongTarget,
    beforeRevision: initial.revision,
    approvedByActorRef: ACTOR,
    freshNow: '2026-07-25T00:00:00.000Z',
    evidenceSource: memorySourceFixture(),
    reason: null
  }), TypeError)

  const wrongRetention = recreatePendingProposal(pending, {
    suggestedRetention: {
      validUntil: '2026-07-26T00:00:00.000Z',
      purgeAt: '2026-08-25T00:00:00.000Z'
    }
  })
  assert.throws(() => buildMemoryCorrectionProposalApprovalBundleV1({
    ...correctionApprovalInput,
    proposal: wrongRetention
  }), TypeError)

  const noChange = correctionProposalDraft(
    initial.revision,
    `command:${'c'.repeat(64)}`,
    {
    text: initial.record.text,
    confidence: initial.record.confidence,
    conflict: initial.record.conflict
    }
  )
  assert.throws(() => buildMemoryCorrectionProposalApprovalBundleV1({
    ...reference('proposal.approve', `command:${'d'.repeat(64)}`),
    proposal: noChange,
    beforeRevision: initial.revision,
    approvedByActorRef: ACTOR,
    freshNow: '2026-07-25T00:00:00.000Z',
    evidenceSource: memorySourceFixture(),
    reason: null
  }), TypeError)
})

test('migration inventory requires exact ordered aggregate and evidence coverage', () => {
  const initial = approvalBundle(proposalDraft())
  const corrected = correctionBundle(initial.revision)
  const changedConflict = conflictBundle(corrected.revision)
  const proposalHashes = ['a'.repeat(64), 'b'.repeat(64)]
  const revisionHashes = ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]
  const revisionWires = revisionHashes.map((legacyWireHash, index) => ({
    revision: index + 1,
    legacyWireHash
  }))
  const manifest = createMemoryV1ToV2AggregateManifestV1({
    namespaceRef: initial.record.namespaceRef,
    namespaceGeneration: initial.record.namespaceGeneration,
    aggregate: {
      kind: 'memory',
      aggregateId: initial.record.memoryId,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 3,
      legacyProposalWireHashes: proposalHashes,
      legacyRevisionWires: revisionWires
    },
    initiatedByActorRef: ACTOR,
    plannedMemoryId: initial.record.memoryId,
    intent: { kind: 'create' },
    consentEvidenceId: initial.consentEvidence.evidenceId,
    consentEvidenceHash: initial.consentEvidence.evidenceHash,
    revisionEvidenceBindings: [
      {
        revision: 2,
        evidenceId: corrected.evidence.evidenceId,
        evidenceHash: corrected.evidence.evidenceHash
      },
      {
        revision: 3,
        evidenceId: changedConflict.evidence.evidenceId,
        evidenceHash: changedConflict.evidence.evidenceHash
      }
    ]
  })
  const expectation = {
    namespaceRef: initial.record.namespaceRef,
    namespaceGeneration: initial.record.namespaceGeneration,
    aggregateKind: 'memory',
    aggregateId: initial.record.memoryId,
    proposalState: 'approved',
    proposalRevision: 2,
    currentRevision: 3,
    legacyProposalWireHashes: proposalHashes,
    legacyRevisionWires: revisionWires
  }
  const inventory = {
    legacyAggregateCount: 1,
    manifest,
    expectation,
    consentEvidence: initial.consentEvidence,
    revisionEvidence: [corrected.evidence, changedConflict.evidence]
  }
  assert.deepEqual(requireMemoryV1ToV2ManifestInventoryV1(inventory), manifest)
  assert.equal(requireMemoryV1ToV2ManifestInventoryV1({
    legacyAggregateCount: 0,
    manifest: null,
    expectation: null,
    consentEvidence: null,
    revisionEvidence: []
  }), null)
  for (const invalid of [
    { ...inventory, manifest: null },
    { ...inventory, consentEvidence: null },
    { ...inventory, revisionEvidence: [corrected.evidence] },
    { ...inventory, revisionEvidence: [changedConflict.evidence, corrected.evidence] },
    { ...inventory, revisionEvidence: [corrected.evidence, corrected.evidence] },
    {
      ...inventory,
      expectation: {
        ...expectation,
        legacyRevisionWires: [...revisionWires].reverse()
      }
    },
    {
      legacyAggregateCount: 0,
      manifest: null,
      expectation,
      consentEvidence: null,
      revisionEvidence: []
    }
  ]) assert.throws(() => requireMemoryV1ToV2ManifestInventoryV1(invalid), TypeError)
})
