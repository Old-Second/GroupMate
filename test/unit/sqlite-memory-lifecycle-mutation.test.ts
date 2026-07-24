import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1,
  issueMemoryPolicyCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryConflictChangeBundleV1,
  buildMemoryCorrectionBundleV1,
  buildMemoryCorrectionProposalApprovalBundleV1,
  buildMemoryCorrectionProposalDraftV2,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryLifecycleCommandV1,
  type MemoryLifecycleCommandV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  MEMORY_RETENTION_POLICY_REF_V1,
  createMemoryV1ToV2AggregateManifestV1,
  memoryProposalDeadlineV2
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import { encodeMemoryV1ToV2AggregateManifestV1 } from '../../src/agent/memory/memory-lifecycle-codec.js'
import {
  MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
  createMemoryLifecyclePortV1,
  type MemoryLifecycleAuthorizationEnvelopeV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import { createMemoryLifecycleResultV1 } from '../../src/agent/memory/memory-lifecycle-result.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  openSqliteMemoryDatabaseV2
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-mutation.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  FIXTURE_IDS,
  groupSceneFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-24T08:00:00.000Z'
const PLUS_1 = '2026-07-24T08:00:01.000Z'
const PLUS_2 = '2026-07-24T08:00:02.000Z'
const PLUS_3 = '2026-07-24T08:00:03.000Z'
const PLUS_4 = '2026-07-24T08:00:04.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const POLICY_REF = 'policy:owner-default-v1'

function commandRef (suffix: string): string {
  return `command:${suffix.repeat(64).slice(0, 64)}`
}

function groupNamespace (): MemoryNamespaceV1 {
  return createMemoryNamespaceV1({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scope: {
      kind: 'group',
      groupId: FIXTURE_IDS.groupId,
      groupLifecycleId: FIXTURE_IDS.groupLifecycleId
    }
  })
}

function harness (t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-mutation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const store = openSqliteMemoryDatabaseV2({
    location,
    now: () => currentNow,
    manifests: []
  })
  t.after(store.close)
  const mutationAdapter = createSqliteMemoryLifecycleMutationAdapterV1({
    database: store.database,
    now: () => currentNow
  })
  const directAdapter = createSqliteMemoryLifecycleProposalAdapterV1({
    database: store.database,
    now: () => currentNow
  })
  return {
    location,
    store,
    mutation: createMemoryLifecyclePortV1({ now: () => currentNow, execute: mutationAdapter.execute }),
    direct: createMemoryLifecyclePortV1({ now: () => currentNow, execute: directAdapter.execute }),
    setNow: (value: string) => { currentNow = value }
  }
}

function authorityContext (
  namespace: MemoryNamespaceV1,
  now: string,
  role: 'personal_subject' | 'personal_bot_master' | 'group_member' | 'group_admin',
  actions: readonly string[]
) {
  const actorUserId = namespace.scope.kind === 'personal'
    ? role === 'personal_bot_master'
      ? FIXTURE_IDS.secondUserId
      : namespace.scope.subjectUserId
    : FIXTURE_IDS.subjectUserId
  const scene = namespace.scope.kind === 'personal'
    ? { kind: 'private' as const, peerUserId: namespace.scope.subjectUserId }
    : {
        kind: 'group' as const,
        groupId: namespace.scope.groupId,
        groupLifecycleId: namespace.scope.groupLifecycleId,
        trustedMemberUserIds: [actorUserId],
        observedAt: now
      }
  const context = {
    schemaVersion: 1 as const,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq' as const,
    accountId: namespace.accountId,
    scene
  }
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    context,
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
      generation: 1,
      actorRef: ACTOR_REF,
      actorUserId,
      role,
      roleObservedAt: namespace.scope.kind === 'group' ? now : null,
      actions
    },
    now
  )
  return { access, actor, actorUserId, sceneRef: access.sceneRef }
}

function actorEnvelope (
  command: MemoryLifecycleCommandV1,
  namespace: MemoryNamespaceV1,
  now: string,
  actions: readonly string[],
  role: 'personal_subject' | 'personal_bot_master' | 'group_member' | 'group_admin' =
    'personal_subject'
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const auth = authorityContext(namespace, now, role, actions)
  return Object.freeze({
    schemaVersion: 1,
    command,
    access: auth.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: auth.actor })
  })
}

function policyEnvelope (
  command: MemoryLifecycleCommandV1,
  namespace: MemoryNamespaceV1,
  now: string
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const auth = authorityContext(namespace, now, 'personal_subject', ['approve'])
  const policy = issueMemoryPolicyCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      sceneRef: auth.sceneRef,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      generation: 1,
      policyRef: POLICY_REF,
      policyGeneration: 1,
      createdByActorRef: ACTOR_REF,
      createdByUserId: auth.actorUserId,
      consent: 'owner_policy',
      allowedKinds: ['preference'],
      allowedSensitivities: ['personal'],
      allowedSourceKinds: ['current_message'],
      allowedRetentionPolicyRefs: [MEMORY_RETENTION_POLICY_REF_V1]
    },
    now
  )
  return Object.freeze({
    schemaVersion: 1,
    command,
    access: auth.access,
    authority: Object.freeze({ kind: 'policy' as const, capability: policy })
  })
}

function maintenanceEnvelope (
  command: MemoryLifecycleCommandV1,
  namespace: MemoryNamespaceV1,
  now: string
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const auth = authorityContext(namespace, now, 'personal_subject', ['propose_create'])
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
    schemaVersion: 1,
    command,
    access: auth.access,
    authority: Object.freeze({ kind: 'maintenance' as const, capability: maintenance })
  })
}

function pendingProposal (
  ref = commandRef('1'),
  now = NOW,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture()
  const proposal = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.create',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: now,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null,
    ...overrides
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
      occurredAt: now,
      newValidUntil: null,
      newPurgeAt: null,
      material: proposal
    })
  })
}

function approvalCommand (
  proposal: ReturnType<typeof pendingProposal>['proposal'],
  ref: string,
  now: string
) {
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: ref,
    operation: 'proposal.approve',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: 1,
    proposal,
    approvedByActorRef: ACTOR_REF,
    freshNow: now,
    evidenceSource: proposal.consentRequirement === 'explicit' ? proposal.sources[0] : null,
    reason: null
  })
  const command = createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'proposal.approve',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: proposal.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: proposal.consentTargetHash,
    occurredAt: now,
    newValidUntil: null,
    newPurgeAt: null,
    material: bundle.consentEvidence
  })
  return Object.freeze({ bundle, command })
}

function proposalDecisionCommand (
  proposal: ReturnType<typeof pendingProposal>['proposal'],
  operation: 'proposal.reject' | 'proposal.withdraw' | 'proposal.expire',
  ref: string,
  occurredAt: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation,
    initiatedByActorRef: operation === 'proposal.expire'
      ? MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
      : ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: proposal.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: proposal.consentTargetHash,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

function mutationPort (
  database: ReturnType<typeof openSqliteMemoryDatabaseV2>['database'],
  now: () => string
) {
  return createMemoryLifecyclePortV1({
    now,
    execute: createSqliteMemoryLifecycleMutationAdapterV1({ database, now }).execute
  })
}

function directFixture (now = NOW, ref = commandRef('d')) {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture()
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
    text: '喜欢无糖咖啡',
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: now,
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
    freshNow: now,
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
      occurredAt: now,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

async function seedDirect (target: ReturnType<typeof harness>, fixture = directFixture()) {
  return target.direct.execute(actorEnvelope(
    fixture.command,
    fixture.namespace,
    fixture.bundle.proposal.proposedAt,
    ['propose_create', 'approve']
  ))
}

function forgetCommand (
  fixture: ReturnType<typeof directFixture>,
  ref: string,
  occurredAt: string,
  exact = true,
  expectedHash = fixture.bundle.revision.revisionHash
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: exact ? fixture.bundle.revision.revision : null,
    expectedAggregateHash: exact ? expectedHash : null,
    occurredAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

function deleteNamespaceCommand (
  namespace: MemoryNamespaceV1,
  ref: string,
  occurredAt: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: ref,
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

test('SQLite lifecycle proposal create is atomic, restart-safe and idempotent', async t => {
  const target = harness(t)
  const fixture = pendingProposal()
  const envelope = actorEnvelope(fixture.command, fixture.namespace, NOW, ['propose_create'])
  const stored = await target.mutation.execute(envelope)
  assert.equal(stored.status, 'stored', JSON.stringify(stored))
  assert.deepEqual(await target.mutation.execute(envelope), stored)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespaces,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending,
      (SELECT count(*) FROM lifecycle_commands) AS commands,
      (SELECT count(*) FROM outbox) AS outbox
  `).get()! }, { namespaces: 1, pending: 1, commands: 1, outbox: 1 })

  const collision = pendingProposal(commandRef('1'), NOW, { text: '喜欢低因咖啡' })
  const conflict = await target.mutation.execute(actorEnvelope(
    collision.command,
    collision.namespace,
    NOW,
    ['propose_create']
  ))
  assert.deepEqual(conflict.status === 'conflict' ? conflict.category : null, 'idempotency')
})

test('SQLite lifecycle explicit and owner-policy approvals bind canonical pending proposals', async t => {
  for (const policy of [false, true]) {
    const target = harness(t)
    const fixture = pendingProposal(commandRef(policy ? '2' : '3'), NOW, policy
      ? {
          proposedBy: { kind: 'system_policy', policyRef: POLICY_REF },
          consentRequirement: 'owner_policy',
          consentPolicyRef: POLICY_REF,
          consentPolicyGeneration: 1
        }
      : {})
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    target.setNow(PLUS_1)
    const approval = approvalCommand(fixture.proposal, commandRef(policy ? '4' : '5'), PLUS_1)
    const envelope = policy
      ? policyEnvelope(approval.command, fixture.namespace, PLUS_1)
      : actorEnvelope(approval.command, fixture.namespace, PLUS_1, ['approve'])
    const result = await target.mutation.execute(envelope)
    assert.equal(result.status, 'stored', JSON.stringify(result))
    assert.equal(result.status === 'stored' ? result.resultRef : null, fixture.proposal.proposalId)
    assert.equal(result.status === 'stored' ? result.resultRevision : null, 2)
    assert.deepEqual({ ...target.store.database.prepare(`
      SELECT
        (SELECT count(*) FROM proposals WHERE state = 'approved') AS approved,
        (SELECT count(*) FROM consent_evidence) AS evidence,
        (SELECT count(*) FROM revisions) AS revisions,
        (SELECT count(*) FROM heads) AS heads,
        (SELECT count(*) FROM outbox) AS outbox
    `).get()! }, { approved: 1, evidence: 1, revisions: 1, heads: 1, outbox: 3 })
  }
})

test('SQLite lifecycle proposal reject withdraw and due expiry use locked canonical deadlines', async t => {
  const cases = [
    ['proposal.reject', 'reject', commandRef('6'), commandRef('9'), PLUS_1, 'rejected'],
    ['proposal.withdraw', 'withdraw_own_proposal', commandRef('7'), commandRef('a'), PLUS_1, 'withdrawn'],
    ['proposal.expire', null, commandRef('8'), commandRef('b'), null, 'expired']
  ] as const
  for (const [operation, action, ref, createRef, requestedAt, expectedState] of cases) {
    const target = harness(t)
    const fixture = pendingProposal(createRef)
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    const at = requestedAt ?? memoryProposalDeadlineV2(fixture.proposal)
    target.setNow(at)
    const command = createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation,
      initiatedByActorRef: operation === 'proposal.expire'
        ? MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
        : ACTOR_REF,
      namespaceRef: fixture.proposal.namespaceRef,
      expectedNamespaceGeneration: 1,
      aggregateRef: fixture.proposal.proposalId,
      expectedRevision: 1,
      expectedAggregateHash: fixture.proposal.consentTargetHash,
      occurredAt: at,
      newValidUntil: null,
      newPurgeAt: null,
      material: null
    })
    const envelope = operation === 'proposal.expire'
      ? maintenanceEnvelope(command, fixture.namespace, at)
      : actorEnvelope(command, fixture.namespace, at, [action!])
    const result = await target.mutation.execute(envelope)
    assert.equal(result.status, 'stored', JSON.stringify(result))
    assert.equal(target.store.database.prepare(`
      SELECT state FROM proposals WHERE proposal_id = ?
    `).get(fixture.proposal.proposalId)?.state, expectedState)
  }
})

test('SQLite lifecycle record correction renewal and conflict changes enforce revision CAS', async t => {
  const target = harness(t)
  const fixture = directFixture()
  assert.equal((await seedDirect(target, fixture)).status, 'stored')

  target.setNow(PLUS_1)
  const correction = buildMemoryCorrectionBundleV1({
    commandRef: commandRef('9'),
    operation: 'record.correct',
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: fixture.bundle.revision,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_1,
    text: '喜欢低因咖啡',
    confidence: 0.95,
    validity: fixture.bundle.record.validity,
    conflict: fixture.bundle.record.conflict,
    supersedes: fixture.bundle.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({ sourceKind: 'manual_correction', messageId: null }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  const correctionCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('9'),
    operation: 'record.correct',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: 1,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: PLUS_1,
    newValidUntil: null,
    newPurgeAt: null,
    material: correction
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    correctionCommand,
    fixture.namespace,
    PLUS_1,
    ['correct']
  ))).status, 'stored')

  target.setNow(PLUS_2)
  const newValidUntil = '2027-07-24T08:00:02.000Z'
  const renewal = buildMemoryRenewalBundleV1({
    commandRef: commandRef('a'),
    operation: 'record.renew',
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: correction.revision,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_2,
    newValidUntil,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({ sourceKind: 'manual_correction', messageId: null }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  const renewalCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('a'),
    operation: 'record.renew',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: 2,
    expectedAggregateHash: correction.revision.revisionHash,
    occurredAt: PLUS_2,
    newValidUntil: renewal.revision.record.retention.validUntil,
    newPurgeAt: renewal.revision.record.retention.purgeAt,
    material: renewal
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    renewalCommand,
    fixture.namespace,
    PLUS_2,
    ['renew']
  ))).status, 'stored')

  target.setNow(PLUS_3)
  const conflict = buildMemoryConflictChangeBundleV1({
    commandRef: commandRef('b'),
    operation: 'record.changeConflict',
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: renewal.revision,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_3,
    validity: { state: 'uncertain', validFrom: null },
    conflict: {
      state: 'possible',
      relatedMemoryIds: [`memory:${'e'.repeat(64)}`],
      note: '偏好可能变化'
    },
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({ sourceKind: 'manual_correction', messageId: null }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  const conflictCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('b'),
    operation: 'record.changeConflict',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: 3,
    expectedAggregateHash: renewal.revision.revisionHash,
    occurredAt: PLUS_3,
    newValidUntil: null,
    newPurgeAt: null,
    material: conflict
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    conflictCommand,
    fixture.namespace,
    PLUS_3,
    ['change_conflict']
  ))).status, 'stored')
  assert.equal(target.store.database.prepare(`SELECT current_revision FROM heads`).get()
    ?.current_revision, 4)
  assert.equal(target.store.database.prepare(`SELECT count(*) AS count FROM revision_evidence`).get()
    ?.count, 3)

  target.setNow(PLUS_4)
  const exactReplay = await target.mutation.execute(actorEnvelope(
    correctionCommand,
    fixture.namespace,
    PLUS_4,
    ['correct']
  ))
  assert.equal(exactReplay.status, 'stored')
  const staleCorrection = buildMemoryCorrectionBundleV1({
    commandRef: commandRef('0'),
    operation: 'record.correct',
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: fixture.bundle.revision,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_4,
    text: '过时写入不能覆盖当前事实',
    confidence: 0.94,
    validity: fixture.bundle.record.validity,
    conflict: fixture.bundle.record.conflict,
    supersedes: fixture.bundle.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({ sourceKind: 'manual_correction', messageId: null }),
    policyRef: null,
    policyGeneration: null,
    reason: null
  })
  const staleCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('0'),
    operation: 'record.correct',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: 1,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: PLUS_4,
    newValidUntil: null,
    newPurgeAt: null,
    material: staleCorrection
  })
  const stale = await target.mutation.execute(actorEnvelope(
    staleCommand,
    fixture.namespace,
    PLUS_4,
    ['correct']
  ))
  assert.deepEqual(stale.status === 'conflict' ? stale.category : null, 'revision')
  assert.equal(target.store.database.prepare(`SELECT count(*) AS count FROM revisions`).get()?.count, 4)
})

test('SQLite lifecycle correction proposal approval atomically binds the current head', async t => {
  const target = harness(t)
  const direct = directFixture()
  assert.equal((await seedDirect(target, direct)).status, 'stored')
  target.setNow(PLUS_1)
  const proposal = buildMemoryCorrectionProposalDraftV2({
    commandRef: commandRef('c'),
    operation: 'proposal.create',
    namespaceRef: direct.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace: direct.namespace,
    beforeRevision: direct.bundle.revision,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    text: '喜欢低因咖啡',
    sources: [memorySourceFixture()],
    observedAt: NOW,
    proposedAt: PLUS_1,
    confidence: 0.96,
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const create = createMemoryLifecycleCommandV1({
    commandRef: commandRef('c'),
    operation: 'proposal.create',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: PLUS_1,
    newValidUntil: null,
    newPurgeAt: null,
    material: proposal
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    create,
    direct.namespace,
    PLUS_1,
    ['propose_correction']
  ))).status, 'stored')
  target.setNow(PLUS_2)
  const bundle = buildMemoryCorrectionProposalApprovalBundleV1({
    commandRef: commandRef('e'),
    operation: 'proposal.approve',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: 1,
    proposal,
    beforeRevision: direct.bundle.revision,
    approvedByActorRef: ACTOR_REF,
    freshNow: PLUS_2,
    evidenceSource: proposal.sources[0],
    reason: null
  })
  const approve = createMemoryLifecycleCommandV1({
    commandRef: commandRef('e'),
    operation: 'proposal.approve',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: proposal.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: proposal.consentTargetHash,
    occurredAt: PLUS_2,
    newValidUntil: null,
    newPurgeAt: null,
    material: bundle.consentEvidence
  })
  const result = await target.mutation.execute(actorEnvelope(
    approve,
    direct.namespace,
    PLUS_2,
    ['approve']
  ))
  assert.equal(result.status, 'stored', JSON.stringify(result))
  assert.equal(result.status === 'stored' ? result.resultRef : null, proposal.proposalId)
  assert.equal(result.status === 'stored' ? result.resultRevision : null, 2)
  assert.equal(target.store.database.prepare(`SELECT current_revision FROM heads`).get()
    ?.current_revision, 2)
  assert.equal(target.store.database.prepare(`SELECT count(*) AS count FROM revision_evidence`).get()
    ?.count, 1)
})

test('SQLite lifecycle group admission accepts group-scoped canonical proposals', async t => {
  const target = harness(t)
  const namespace = groupNamespace()
  const source = memorySourceFixture({
    scene: groupSceneFixture({
      groupId: FIXTURE_IDS.groupId,
      groupLifecycleId: FIXTURE_IDS.groupLifecycleId
    })
  })
  const proposal = buildMemoryProposalDraftV2({
    commandRef: commandRef('f'),
    operation: 'proposal.create',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'group_rule',
    text: '群内禁止刷屏',
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: NOW,
    confidence: 0.9,
    sensitivity: 'group',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const command = createMemoryLifecycleCommandV1({
    commandRef: commandRef('f'),
    operation: 'proposal.create',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: NOW,
    newValidUntil: null,
    newPurgeAt: null,
    material: proposal
  })
  const result = await target.mutation.execute(actorEnvelope(
    command,
    namespace,
    NOW,
    ['propose_create'],
    'group_member'
  ))
  assert.equal(result.status, 'stored', JSON.stringify(result))
  assert.equal(target.store.database.prepare(`SELECT count(*) AS count FROM namespaces`).get()?.count, 1)
})

test('SQLite lifecycle freezes proposal deadlines at T-1ms T and T+1ms', async t => {
  const deadline = memoryProposalDeadlineV2(pendingProposal().proposal)
  const deadlineMs = Date.parse(deadline)
  const before = new Date(deadlineMs - 1).toISOString()
  const after = new Date(deadlineMs + 1).toISOString()

  for (const [currentNow, expected] of [
    [before, 'stored'],
    [deadline, 'proposal_expired'],
    [after, 'proposal_expired']
  ] as const) {
    const target = harness(t)
    const fixture = pendingProposal(commandRef('1'))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    const approval = approvalCommand(fixture.proposal, commandRef('2'), before)
    target.setNow(currentNow)
    assert.equal((await target.mutation.execute(actorEnvelope(
      approval.command,
      fixture.namespace,
      currentNow,
      ['approve']
    ))).status, expected)
  }

  for (const [currentNow, expected] of [
    [before, 'denied'],
    [deadline, 'stored'],
    [after, 'stored']
  ] as const) {
    const target = harness(t)
    const fixture = pendingProposal(commandRef('3'))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    const expire = proposalDecisionCommand(
      fixture.proposal,
      'proposal.expire',
      commandRef('4'),
      currentNow
    )
    target.setNow(currentNow)
    const result = await target.mutation.execute(maintenanceEnvelope(
      expire,
      fixture.namespace,
      currentNow
    ))
    assert.equal(result.status, expected)
    if (expected === 'denied') {
      assert.deepEqual(result.status === 'denied' ? result.category : null, 'authority')
    }
  }
})

test('SQLite lifecycle exact replay survives reopen and rechecks locked authority', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-mutation-restart-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  const fixture = pendingProposal(commandRef('5'))
  const approval = approvalCommand(fixture.proposal, commandRef('6'), PLUS_1)
  let storedApproval: Awaited<ReturnType<ReturnType<typeof mutationPort>['execute']>>

  const firstStore = openSqliteMemoryDatabaseV2({ location, now: () => NOW, manifests: [] })
  try {
    let currentNow = NOW
    const port = mutationPort(firstStore.database, () => currentNow)
    assert.equal((await port.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    currentNow = PLUS_1
    storedApproval = await port.execute(actorEnvelope(
      approval.command,
      fixture.namespace,
      PLUS_1,
      ['approve']
    ))
    assert.equal(storedApproval.status, 'stored')
  } finally {
    firstStore.close()
  }

  const secondStore = openSqliteMemoryDatabaseV2({ location, now: () => PLUS_2, manifests: [] })
  try {
    const port = mutationPort(secondStore.database, () => PLUS_2)
    const replay = await port.execute(actorEnvelope(
      approval.command,
      fixture.namespace,
      PLUS_2,
      ['approve']
    ))
    assert.deepEqual(replay, storedApproval)
    const adapter = createSqliteMemoryLifecycleMutationAdapterV1({
      database: secondStore.database,
      now: () => PLUS_2
    })
    const denied = createMemoryLifecycleResultV1(await adapter.execute(actorEnvelope(
      approval.command,
      fixture.namespace,
      PLUS_2,
      ['reject']
    )))
    assert.deepEqual(denied.status === 'denied' ? denied.category : null, 'authority')
    assert.deepEqual({ ...secondStore.database.prepare(`
      SELECT
        (SELECT count(*) FROM proposals) AS proposals,
        (SELECT count(*) FROM heads) AS heads,
        (SELECT count(*) FROM lifecycle_commands) AS commands,
        (SELECT count(*) FROM outbox) AS outbox
    `).get()! }, { proposals: 1, heads: 1, commands: 2, outbox: 3 })
  } finally {
    secondStore.close()
  }
})

test('two SQLite handles linearize competing proposal decisions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-mutation-race-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const firstStore = openSqliteMemoryDatabaseV2({ location, now: () => currentNow, manifests: [] })
  const secondStore = openSqliteMemoryDatabaseV2({ location, now: () => currentNow, manifests: [] })
  try {
    const first = mutationPort(firstStore.database, () => currentNow)
    const second = mutationPort(secondStore.database, () => currentNow)
    const fixture = pendingProposal(commandRef('7'))
    assert.equal((await first.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
    currentNow = PLUS_1
    const approval = approvalCommand(fixture.proposal, commandRef('8'), PLUS_1)
    const rejection = proposalDecisionCommand(
      fixture.proposal,
      'proposal.reject',
      commandRef('9'),
      PLUS_1
    )
    const results = await Promise.all([
      first.execute(actorEnvelope(approval.command, fixture.namespace, PLUS_1, ['approve'])),
      second.execute(actorEnvelope(rejection, fixture.namespace, PLUS_1, ['reject']))
    ])
    assert.deepEqual(results.map(result => result.status).sort(), ['already_decided', 'stored'])
    const state = String(firstStore.database.prepare(`SELECT state FROM proposals`).get()?.state)
    assert.ok(state === 'approved' || state === 'rejected')
    assert.equal(firstStore.database.prepare(`SELECT count(*) AS count FROM heads`).get()?.count,
      state === 'approved' ? 1 : 0)
    assert.equal(firstStore.database.prepare(`SELECT count(*) AS count FROM lifecycle_commands`).get()
      ?.count, 3)
  } finally {
    secondStore.close()
    firstStore.close()
  }
})

test('SQLite lifecycle reports a contended write lock as retryable busy without dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-mutation-busy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  const firstStore = openSqliteMemoryDatabaseV2({ location, now: () => NOW, manifests: [] })
  const secondStore = openSqliteMemoryDatabaseV2({ location, now: () => NOW, manifests: [] })
  try {
    const second = mutationPort(secondStore.database, () => NOW)
    const fixture = pendingProposal(commandRef('a'))
    secondStore.database.exec('PRAGMA busy_timeout = 1')
    firstStore.database.exec('BEGIN IMMEDIATE')
    const busy = await second.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))
    assert.deepEqual(busy.status === 'unavailable'
      ? { category: busy.category, retryable: busy.retryable }
      : null, { category: 'busy', retryable: true })
    assert.deepEqual({ ...secondStore.database.prepare(`
      SELECT
        (SELECT count(*) FROM namespaces) AS namespaces,
        (SELECT count(*) FROM proposals) AS proposals,
        (SELECT count(*) FROM lifecycle_commands) AS commands,
        (SELECT count(*) FROM outbox) AS outbox
    `).get()! }, { namespaces: 0, proposals: 0, commands: 0, outbox: 0 })
    firstStore.database.exec('ROLLBACK')
    assert.equal((await second.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))).status, 'stored')
  } finally {
    try {
      firstStore.database.exec('ROLLBACK')
    } catch {}
    secondStore.close()
    firstStore.close()
  }
})

test('SQLite lifecycle rolls every approval carrier back on a late ledger failure', async t => {
  const target = harness(t)
  const fixture = pendingProposal(commandRef('a'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.command,
    fixture.namespace,
    NOW,
    ['propose_create']
  ))).status, 'stored')
  const baseline = {
    state: { ...target.store.database.prepare(`
      SELECT revision, state FROM proposals
    `).get()! },
    usage: { ...target.store.database.prepare(`SELECT * FROM usage`).get()! },
    namespaceUsage: { ...target.store.database.prepare(`
      SELECT * FROM lifecycle_namespace_usage
    `).get()! },
    global: { ...target.store.database.prepare(`SELECT * FROM global_usage`).get()! },
    deployment: { ...target.store.database.prepare(`
      SELECT * FROM lifecycle_deployment_state
    `).get()! }
  }
  target.store.database.exec(`
    CREATE TEMP TRIGGER fail_lifecycle_approval_ledger
    BEFORE INSERT ON lifecycle_commands
    WHEN NEW.operation = 'proposal.approve'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `)
  target.setNow(PLUS_1)
  const approval = approvalCommand(fixture.proposal, commandRef('b'), PLUS_1)
  const failed = await target.mutation.execute(actorEnvelope(
    approval.command,
    fixture.namespace,
    PLUS_1,
    ['approve']
  ))
  assert.deepEqual(failed.status === 'corrupt' ? failed.category : null, 'canonical_data')
  assert.deepEqual({ ...target.store.database.prepare(`SELECT revision, state FROM proposals`).get()! },
    baseline.state)
  assert.deepEqual({ ...target.store.database.prepare(`SELECT * FROM usage`).get()! }, baseline.usage)
  assert.deepEqual({ ...target.store.database.prepare(`SELECT * FROM lifecycle_namespace_usage`).get()! },
    baseline.namespaceUsage)
  assert.deepEqual({ ...target.store.database.prepare(`SELECT * FROM global_usage`).get()! }, baseline.global)
  assert.deepEqual({ ...target.store.database.prepare(`SELECT * FROM lifecycle_deployment_state`).get()! },
    baseline.deployment)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM consent_evidence) AS evidence,
      (SELECT count(*) FROM revision_evidence) AS revision_evidence,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM lifecycle_commands) AS commands
  `).get()! }, { evidence: 0, revision_evidence: 0, revisions: 0, heads: 0, outbox: 1, commands: 1 })
  target.store.database.exec('DROP TRIGGER fail_lifecycle_approval_ledger')
  assert.equal((await target.mutation.execute(actorEnvelope(
    approval.command,
    fixture.namespace,
    PLUS_1,
    ['approve']
  ))).status, 'stored')
})

test('SQLite lifecycle capacity rejection rolls back canonical writes and trusted time', async t => {
  const target = harness(t)
  const first = pendingProposal(commandRef('c'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    first.command,
    first.namespace,
    NOW,
    ['propose_create']
  ))).status, 'stored')
  target.store.database.prepare(`UPDATE usage SET pending_proposal_records = 240`).run()
  target.store.database.prepare(`
    UPDATE global_usage SET pending_proposal_records = 240
  `).run()
  const second = pendingProposal(commandRef('d'))
  target.setNow(PLUS_1)
  const result = await target.mutation.execute(actorEnvelope(
    second.command,
    second.namespace,
    PLUS_1,
    ['propose_create']
  ))
  assert.deepEqual(result.status === 'capacity' ? result.category : null, 'pending_proposals')
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM lifecycle_commands) AS commands,
      (SELECT content_epoch FROM namespaces) AS content_epoch,
      (SELECT trusted_time_high_water_ms FROM lifecycle_deployment_state WHERE singleton = 1)
        AS trusted_time
  `).get()! }, {
    proposals: 1,
    outbox: 1,
    commands: 1,
    content_epoch: 1,
    trusted_time: Date.parse(NOW)
  })
})

test('SQLite lifecycle rejects conservative usage undercounts without partial writes', async t => {
  const target = harness(t)
  const first = pendingProposal(commandRef('e'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    first.command,
    first.namespace,
    NOW,
    ['propose_create']
  ))).status, 'stored')
  const usage = { ...target.store.database.prepare(`
    SELECT pending_proposal_records, canonical_logical_bytes FROM usage
  `).get()! }
  const global = { ...target.store.database.prepare(`
    SELECT pending_proposal_records, canonical_logical_bytes FROM global_usage WHERE singleton = 1
  `).get()! }
  const lifecycle = { ...target.store.database.prepare(`
    SELECT lifecycle_command_records, lifecycle_command_logical_bytes
    FROM lifecycle_namespace_usage
  `).get()! }

  const execute = async (suffix: string) => {
    const fixture = pendingProposal(commandRef(suffix))
    const result = await target.mutation.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create']
    ))
    assert.deepEqual(result.status === 'corrupt' ? result.category : null, 'canonical_data')
    assert.deepEqual({ ...target.store.database.prepare(`
      SELECT
        (SELECT count(*) FROM proposals) AS proposals,
        (SELECT count(*) FROM outbox) AS outbox,
        (SELECT count(*) FROM lifecycle_commands) AS commands
    `).get()! }, { proposals: 1, outbox: 1, commands: 1 })
  }

  target.store.database.prepare(`UPDATE usage SET pending_proposal_records = 0`).run()
  target.store.database.prepare(`UPDATE global_usage SET pending_proposal_records = 0`).run()
  await execute('1')
  target.store.database.prepare(`UPDATE usage SET pending_proposal_records = ?`)
    .run(usage.pending_proposal_records as number)
  target.store.database.prepare(`UPDATE global_usage SET pending_proposal_records = ?`)
    .run(global.pending_proposal_records as number)

  target.store.database.prepare(`UPDATE usage SET canonical_logical_bytes = 0`).run()
  target.store.database.prepare(`UPDATE global_usage SET canonical_logical_bytes = 0`).run()
  await execute('2')
  target.store.database.prepare(`UPDATE usage SET canonical_logical_bytes = ?`)
    .run(usage.canonical_logical_bytes as number)
  target.store.database.prepare(`UPDATE global_usage SET canonical_logical_bytes = ?`)
    .run(global.canonical_logical_bytes as number)

  target.store.database.prepare(`
    UPDATE lifecycle_namespace_usage
    SET lifecycle_command_records = 0, lifecycle_command_logical_bytes = 0
  `).run()
  await execute('3')
  assert.notEqual(lifecycle.lifecycle_command_records, 0)
})

test('SQLite lifecycle forget atomically removes body carriers and freezes its receipt', async t => {
  const target = harness(t)
  const fixture = directFixture(NOW, commandRef('1'))
  assert.equal((await seedDirect(target, fixture)).status, 'stored')
  target.setNow(PLUS_1)
  const command = forgetCommand(fixture, commandRef('2'), PLUS_1)
  const envelope = actorEnvelope(command, fixture.namespace, PLUS_1, ['forget'])
  const forgotten = await target.mutation.execute(envelope)
  assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))
  if (forgotten.status !== 'deletion_pending') throw new TypeError('unexpected forget result')
  assert.equal(forgotten.receipt.operation, 'forget')
  assert.equal(forgotten.receipt.namespaceRef, fixture.bundle.record.namespaceRef)
  assert.equal(forgotten.receipt.generationBefore, 1)
  assert.equal(forgotten.receipt.generationAfter, 1)
  assert.equal(forgotten.receipt.memoryId, fixture.bundle.record.memoryId)
  assert.equal(forgotten.receipt.deletedRevision, 1)
  assert.equal(forgotten.receipt.committedAt, PLUS_1)
  assert.deepEqual(await target.mutation.execute(envelope), forgotten)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM consent_evidence) AS consent_evidence,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS revision_payloads,
      (SELECT count(*) FROM revision_evidence) AS revision_evidence,
      (SELECT count(*) FROM tombstones) AS tombstones,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM lifecycle_commands) AS commands
  `).get()! }, {
    proposals: 0,
    consent_evidence: 0,
    heads: 0,
    revisions: 0,
    revision_payloads: 0,
    revision_evidence: 0,
    tombstones: 1,
    outbox: 1,
    commands: 2
  })
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT active_memory_records, retained_revision_records, tombstone_records,
      pending_outbox_records FROM usage WHERE namespace_generation = 1
  `).get()! }, {
    active_memory_records: 0,
    retained_revision_records: 0,
    tombstone_records: 1,
    pending_outbox_records: 1
  })
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT active_memory_records, retained_revision_records, tombstone_records,
      pending_outbox_records FROM global_usage WHERE singleton = 1
  `).get()! }, {
    active_memory_records: 0,
    retained_revision_records: 0,
    tombstone_records: 1,
    pending_outbox_records: 1
  })
  const tombstone = target.store.database.prepare(`
    SELECT tombstone_id, receipt_hash FROM tombstones
  `).get()!
  assert.equal(tombstone.tombstone_id, forgotten.receipt.tombstoneId)
  assert.equal(tombstone.receipt_hash, forgotten.receipt.tombstoneReceiptHash)

  const collision = forgetCommand(fixture, commandRef('2'), PLUS_1, true, 'f'.repeat(64))
  const collided = await target.mutation.execute(actorEnvelope(
    collision,
    fixture.namespace,
    PLUS_1,
    ['forget']
  ))
  assert.deepEqual(collided.status === 'conflict' ? collided.category : null, 'idempotency')
})

test('SQLite lifecycle forget makes migrated legacy wire carriers unreachable', async t => {
  const target = harness(t)
  const fixture = directFixture(NOW, commandRef('0'))
  assert.equal((await seedDirect(target, fixture)).status, 'stored')
  const manifest = createMemoryV1ToV2AggregateManifestV1({
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'memory',
      aggregateId: fixture.bundle.record.memoryId,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 1,
      legacyProposalWireHashes: ['1'.repeat(64), '2'.repeat(64)],
      legacyRevisionWires: [{ revision: 1, legacyWireHash: '3'.repeat(64) }]
    },
    initiatedByActorRef: ACTOR_REF,
    plannedMemoryId: fixture.bundle.record.memoryId,
    intent: { kind: 'create' },
    consentEvidenceId: fixture.bundle.consentEvidence.evidenceId,
    consentEvidenceHash: fixture.bundle.consentEvidence.evidenceHash,
    revisionEvidenceBindings: []
  })
  const manifestWire = encodeMemoryV1ToV2AggregateManifestV1(manifest)
  const manifestBytes = Buffer.byteLength(manifestWire, 'utf8')
  target.store.database.prepare(`
    INSERT INTO memory_v1_to_v2_manifests(
      namespace_ref, namespace_generation, manifest_id, aggregate_kind, aggregate_id,
      manifest_hash, manifest_wire, manifest_wire_bytes, applied_at_ms
    ) VALUES (?, 1, ?, 'memory', ?, ?, ?, ?, ?)
  `).run(
    fixture.bundle.record.namespaceRef,
    manifest.manifestId,
    fixture.bundle.record.memoryId,
    manifest.manifestHash,
    manifestWire,
    manifestBytes,
    Date.parse(NOW)
  )
  target.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(manifestBytes, fixture.bundle.record.namespaceRef)
  target.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE singleton = 1
  `).run(manifestBytes)
  target.setNow(PLUS_1)

  const forgotten = await target.mutation.execute(actorEnvelope(
    forgetCommand(fixture, commandRef('1'), PLUS_1),
    fixture.namespace,
    PLUS_1,
    ['forget']
  ))
  assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM memory_v1_to_v2_manifests) AS manifests,
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM consent_evidence) AS consent_evidence,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS revision_payloads,
      (SELECT count(*) FROM revision_evidence) AS revision_evidence,
      (SELECT count(*) FROM outbox WHERE event_kind IN (
        'proposal_changed', 'record_upserted'
      )) AS content_outbox
  `).get()! }, {
    manifests: 0,
    proposals: 0,
    consent_evidence: 0,
    heads: 0,
    revisions: 0,
    revision_payloads: 0,
    revision_evidence: 0,
    content_outbox: 0
  })
  const usage = target.store.database.prepare(`
    SELECT canonical_logical_bytes FROM usage
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).get(fixture.bundle.record.namespaceRef)!
  const global = target.store.database.prepare(`
    SELECT canonical_logical_bytes FROM global_usage WHERE singleton = 1
  `).get()!
  assert.equal(usage.canonical_logical_bytes, global.canonical_logical_bytes)
})

test('SQLite lifecycle forget separates exact subject and opaque bot-master authority', async t => {
  const subjectTarget = harness(t)
  const subjectFixture = directFixture(NOW, commandRef('3'))
  assert.equal((await seedDirect(subjectTarget, subjectFixture)).status, 'stored')
  subjectTarget.setNow(PLUS_1)
  const opaqueSubject = await subjectTarget.mutation.execute(actorEnvelope(
    forgetCommand(subjectFixture, commandRef('4'), PLUS_1, false),
    subjectFixture.namespace,
    PLUS_1,
    ['forget']
  ))
  assert.deepEqual(opaqueSubject.status === 'denied' ? opaqueSubject.category : null, 'authority')

  const masterTarget = harness(t)
  const masterFixture = directFixture(NOW, commandRef('5'))
  assert.equal((await seedDirect(masterTarget, masterFixture)).status, 'stored')
  masterTarget.setNow(PLUS_1)
  const exactMaster = await masterTarget.mutation.execute(actorEnvelope(
    forgetCommand(masterFixture, commandRef('6'), PLUS_1),
    masterFixture.namespace,
    PLUS_1,
    ['forget'],
    'personal_bot_master'
  ))
  assert.deepEqual(exactMaster.status === 'denied' ? exactMaster.category : null, 'authority')
  const opaqueCommand = forgetCommand(masterFixture, commandRef('7'), PLUS_1, false)
  const opaqueMaster = await masterTarget.mutation.execute(actorEnvelope(
    opaqueCommand,
    masterFixture.namespace,
    PLUS_1,
    ['forget'],
    'personal_bot_master'
  ))
  assert.equal(opaqueMaster.status, 'deletion_pending', JSON.stringify(opaqueMaster))
})

test('SQLite lifecycle namespace delete advances generation and leaves old bodies scrub-pending', async t => {
  const target = harness(t)
  const fixture = directFixture(NOW, commandRef('8'))
  assert.equal((await seedDirect(target, fixture)).status, 'stored')
  target.setNow(PLUS_1)
  const command = deleteNamespaceCommand(fixture.namespace, commandRef('9'), PLUS_1)
  const envelope = actorEnvelope(command, fixture.namespace, PLUS_1, ['delete_namespace'])
  const deleted = await target.mutation.execute(envelope)
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
  if (deleted.status !== 'deletion_pending') throw new TypeError('unexpected namespace delete result')
  assert.equal(deleted.receipt.operation, 'delete_namespace')
  assert.equal(deleted.receipt.generationBefore, 1)
  assert.equal(deleted.receipt.generationAfter, 2)
  assert.equal(deleted.receipt.deletingGeneration, 1)
  assert.equal(deleted.receipt.memoryId, null)
  assert.equal(deleted.receipt.deletedRevision, null)
  assert.deepEqual(await target.mutation.execute(envelope), deleted)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT namespace_generation FROM namespaces) AS generation,
      (SELECT count(*) FROM proposals WHERE namespace_generation = 1) AS old_proposals,
      (SELECT count(*) FROM revisions WHERE namespace_generation = 1) AS old_revisions,
      (SELECT count(*) FROM revision_payloads WHERE namespace_generation = 1) AS old_payloads,
      (SELECT count(*) FROM heads WHERE namespace_generation = 1) AS old_heads,
      (SELECT count(*) FROM tombstones WHERE namespace_generation = 2) AS tombstones,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS checkpoints,
      (SELECT count(*) FROM outbox WHERE namespace_generation = 2
        AND event_kind = 'namespace_deleted') AS delete_events
  `).get()! }, {
    generation: 2,
    old_proposals: 1,
    old_revisions: 1,
    old_payloads: 1,
    old_heads: 1,
    tombstones: 1,
    checkpoints: 1,
    delete_events: 1
  })
  const checkpoint = target.store.database.prepare(`
    SELECT deletion_ref, deleting_generation, observed_current_generation,
      canonical_bodies, payload_deletion, wal_checkpoint, derived_cleanup, stage
    FROM namespace_deletion_checkpoints
  `).get()!
  assert.deepEqual({ ...checkpoint }, {
    deletion_ref: deleted.receipt.deletionRef,
    deleting_generation: 1,
    observed_current_generation: 2,
    canonical_bodies: 'scrub_pending',
    payload_deletion: 'unverified',
    wal_checkpoint: 'unverified',
    derived_cleanup: 'queued',
    stage: 'logical_committed'
  })
  const collision = deleteNamespaceCommand(fixture.namespace, commandRef('9'), NOW)
  const collided = await target.mutation.execute(actorEnvelope(
    collision,
    fixture.namespace,
    PLUS_1,
    ['delete_namespace']
  ))
  assert.deepEqual(collided.status === 'conflict' ? collided.category : null, 'idempotency')
})

test('SQLite lifecycle namespace deletion uses reserve capacity and rolls late failures back', async t => {
  const reserveTarget = harness(t)
  const reserveFixture = directFixture(NOW, commandRef('a'))
  assert.equal((await seedDirect(reserveTarget, reserveFixture)).status, 'stored')
  reserveTarget.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = ? WHERE namespace_generation = 1
  `).run(62 * 1_024 * 1_024 + 1)
  reserveTarget.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = ? WHERE singleton = 1
  `).run(62 * 1_024 * 1_024 + 1)
  reserveTarget.setNow(PLUS_1)
  const reserved = await reserveTarget.mutation.execute(actorEnvelope(
    deleteNamespaceCommand(reserveFixture.namespace, commandRef('b'), PLUS_1),
    reserveFixture.namespace,
    PLUS_1,
    ['delete_namespace']
  ))
  assert.equal(reserved.status, 'deletion_pending', JSON.stringify(reserved))

  const rollbackTarget = harness(t)
  const rollbackFixture = directFixture(NOW, commandRef('c'))
  assert.equal((await seedDirect(rollbackTarget, rollbackFixture)).status, 'stored')
  const baseline = {
    namespace: { ...rollbackTarget.store.database.prepare(`SELECT * FROM namespaces`).get()! },
    usage: rollbackTarget.store.database.prepare(`
      SELECT namespace_generation, active_memory_records, retained_revision_records,
        tombstone_records, canonical_logical_bytes, pending_outbox_records,
        lifecycle_command_records, deletion_checkpoint_records
      FROM usage ORDER BY namespace_generation
    `).all().map(row => ({ ...row })),
    global: { ...rollbackTarget.store.database.prepare(`SELECT * FROM global_usage`).get()! }
  }
  rollbackTarget.store.database.exec(`
    CREATE TEMP TRIGGER fail_namespace_deletion_checkpoint
    BEFORE INSERT ON namespace_deletion_checkpoints
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `)
  rollbackTarget.setNow(PLUS_1)
  const command = deleteNamespaceCommand(rollbackFixture.namespace, commandRef('d'), PLUS_1)
  const failed = await rollbackTarget.mutation.execute(actorEnvelope(
    command,
    rollbackFixture.namespace,
    PLUS_1,
    ['delete_namespace']
  ))
  assert.deepEqual(failed.status === 'corrupt' ? failed.category : null, 'canonical_data')
  assert.deepEqual({ ...rollbackTarget.store.database.prepare(`SELECT * FROM namespaces`).get()! },
    baseline.namespace)
  assert.deepEqual(rollbackTarget.store.database.prepare(`
    SELECT namespace_generation, active_memory_records, retained_revision_records,
      tombstone_records, canonical_logical_bytes, pending_outbox_records,
      lifecycle_command_records, deletion_checkpoint_records
    FROM usage ORDER BY namespace_generation
  `).all().map(row => ({ ...row })), baseline.usage)
  assert.deepEqual({ ...rollbackTarget.store.database.prepare(`SELECT * FROM global_usage`).get()! },
    baseline.global)
  assert.deepEqual({ ...rollbackTarget.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM tombstones) AS tombstones,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS checkpoints,
      (SELECT count(*) FROM lifecycle_commands) AS commands,
      (SELECT count(*) FROM outbox) AS outbox
  `).get()! }, { tombstones: 0, checkpoints: 0, commands: 1, outbox: 2 })
  rollbackTarget.store.database.exec('DROP TRIGGER fail_namespace_deletion_checkpoint')
  assert.equal((await rollbackTarget.mutation.execute(actorEnvelope(
    command,
    rollbackFixture.namespace,
    PLUS_1,
    ['delete_namespace']
  ))).status, 'deletion_pending')
})

test('SQLite lifecycle namespace deletion reports BUSY with zero partial writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-delete-busy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const firstStore = openSqliteMemoryDatabaseV2({ location, now: () => currentNow, manifests: [] })
  const secondStore = openSqliteMemoryDatabaseV2({ location, now: () => currentNow, manifests: [] })
  try {
    const fixture = directFixture(NOW, commandRef('e'))
    const direct = createMemoryLifecyclePortV1({
      now: () => currentNow,
      execute: createSqliteMemoryLifecycleProposalAdapterV1({
        database: firstStore.database,
        now: () => currentNow
      }).execute
    })
    assert.equal((await direct.execute(actorEnvelope(
      fixture.command,
      fixture.namespace,
      NOW,
      ['propose_create', 'approve']
    ))).status, 'stored')
    currentNow = PLUS_1
    secondStore.database.exec('PRAGMA busy_timeout = 1')
    firstStore.database.exec('BEGIN IMMEDIATE')
    const port = mutationPort(secondStore.database, () => currentNow)
    const result = await port.execute(actorEnvelope(
      deleteNamespaceCommand(fixture.namespace, commandRef('f'), PLUS_1),
      fixture.namespace,
      PLUS_1,
      ['delete_namespace']
    ))
    assert.deepEqual(result.status === 'unavailable'
      ? { category: result.category, retryable: result.retryable }
      : null, { category: 'busy', retryable: true })
    assert.deepEqual({ ...secondStore.database.prepare(`
      SELECT
        (SELECT namespace_generation FROM namespaces) AS generation,
        (SELECT count(*) FROM tombstones) AS tombstones,
        (SELECT count(*) FROM namespace_deletion_checkpoints) AS checkpoints,
        (SELECT count(*) FROM lifecycle_commands) AS commands,
        (SELECT count(*) FROM outbox) AS outbox
    `).get()! }, { generation: 1, tombstones: 0, checkpoints: 0, commands: 1, outbox: 2 })
  } finally {
    try {
      firstStore.database.exec('ROLLBACK')
    } catch {}
    secondStore.close()
    firstStore.close()
  }
})
