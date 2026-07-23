import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1,
  type MemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  buildMemoryConflictChangeBundleV1,
  buildMemoryCorrectionBundleV1,
  buildMemoryCorrectionProposalDraftV2,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryLifecycleCommandV1,
  decodeMemoryLifecycleCommandWireV1,
  memoryLifecycleCommandHashV1,
  memoryLifecycleCommandRefHashV1,
  type MemoryLifecycleCommandOperationV1,
  type MemoryLifecycleCommandV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import { createDeletionMutationReceiptV1 } from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1,
  issueMemoryPolicyCapabilityV1,
  type MemoryLifecycleActorActionV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
  createMemoryLifecyclePortV1,
  type MemoryLifecycleAuthorizationEnvelopeV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import {
  createMemoryLifecycleResultV1,
  createMemoryLifecycleStableResultV1,
  memoryLifecycleResolveRefV1,
  memoryLifecycleStableResultHashV1
} from '../../src/agent/memory/memory-lifecycle-result.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-22T08:00:00.000Z'
const LATER = '2026-07-22T08:00:30.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const BOT_MASTER_ACTOR_REF = `actor:${'f'.repeat(64)}`
const OTHER_ACTOR_REF = `actor:${'b'.repeat(64)}`
const POLICY_REF = 'policy:owner-memory-v1'
const RESULT_HASH = 'c'.repeat(64)
const RECEIPT_HASH = 'd'.repeat(64)
const EXPECTED_HASH = 'e'.repeat(64)
const namespace = personalMemoryNamespaceFixture()
const namespaceRef = memoryNamespaceRefV1(namespace)

function commandRef (digit: string): string {
  return `command:${digit.repeat(64)}`
}

function proposalDraft (
  commandReference: string,
  operation: 'proposal.create' | 'proposal.createAndApprove' = 'proposal.create',
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return buildMemoryProposalDraftV2({
    commandRef: commandReference,
    operation,
    namespaceRef,
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: operation === 'proposal.createAndApprove'
      ? { kind: 'user', actorRef: ACTOR_REF }
      : { kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat' },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: [memorySourceFixture()],
    observedAt: '2026-07-22T07:59:00.000Z',
    proposedAt: operation === 'proposal.createAndApprove' ? NOW : '2026-07-22T07:59:30.000Z',
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

const createProposal = proposalDraft(commandRef('1'))
const createCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('1'),
  operation: 'proposal.create',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: null,
  expectedRevision: null,
  expectedAggregateHash: null,
  occurredAt: '2026-07-22T07:59:30.000Z',
  newValidUntil: null,
  newPurgeAt: null,
  material: createProposal
})

const directProposal = proposalDraft(commandRef('2'), 'proposal.createAndApprove')
const directBundle = buildMemoryProposalApprovalBundleV1({
  commandRef: commandRef('2'),
  operation: 'proposal.createAndApprove',
  namespaceRef,
  namespaceGeneration: 1,
  proposal: directProposal,
  approvedByActorRef: ACTOR_REF,
  freshNow: NOW,
  evidenceSource: directProposal.sources[0],
  reason: null
})
const directCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('2'),
  operation: 'proposal.createAndApprove',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: null,
  expectedRevision: null,
  expectedAggregateHash: null,
  occurredAt: NOW,
  newValidUntil: null,
  newPurgeAt: null,
  material: directBundle
})

const approvalBundle = buildMemoryProposalApprovalBundleV1({
  commandRef: commandRef('3'),
  operation: 'proposal.approve',
  namespaceRef,
  namespaceGeneration: 1,
  proposal: createProposal,
  approvedByActorRef: ACTOR_REF,
  freshNow: NOW,
  evidenceSource: createProposal.sources[0],
  reason: null
})
const approveCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('3'),
  operation: 'proposal.approve',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: createProposal.proposalId,
  expectedRevision: 1,
  expectedAggregateHash: createProposal.consentTargetHash,
  occurredAt: NOW,
  newValidUntil: null,
  newPurgeAt: null,
  material: approvalBundle.consentEvidence
})

const policyProposal = proposalDraft(commandRef('4'), 'proposal.create', {
  proposedBy: { kind: 'system_policy', policyRef: POLICY_REF },
  consentRequirement: 'owner_policy',
  consentPolicyRef: POLICY_REF,
  consentPolicyGeneration: 1
})
const policyApprovalBundle = buildMemoryProposalApprovalBundleV1({
  commandRef: commandRef('5'),
  operation: 'proposal.approve',
  namespaceRef,
  namespaceGeneration: 1,
  proposal: policyProposal,
  approvedByActorRef: ACTOR_REF,
  freshNow: NOW,
  evidenceSource: null,
  reason: null
})
const policyApproveCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('5'),
  operation: 'proposal.approve',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: policyProposal.proposalId,
  expectedRevision: 1,
  expectedAggregateHash: policyProposal.consentTargetHash,
  occurredAt: NOW,
  newValidUntil: null,
  newPurgeAt: null,
  material: policyApprovalBundle.consentEvidence
})

function proposalDecisionCommand (
  operation: 'proposal.reject' | 'proposal.withdraw' | 'proposal.expire',
  digit: string
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef(digit),
    operation,
    initiatedByActorRef: operation === 'proposal.expire'
      ? MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
      : ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: createProposal.proposalId,
    expectedRevision: 1,
    expectedAggregateHash: createProposal.consentTargetHash,
    occurredAt: NOW,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

const rejectCommand = proposalDecisionCommand('proposal.reject', '6')
const withdrawCommand = proposalDecisionCommand('proposal.withdraw', '7')
const expireCommand = proposalDecisionCommand('proposal.expire', '8')

const correction = buildMemoryCorrectionBundleV1({
  commandRef: commandRef('9'),
  operation: 'record.correct',
  namespaceRef,
  namespaceGeneration: 1,
  beforeRevision: directBundle.revision,
  changedByActorRef: ACTOR_REF,
  freshNow: LATER,
  text: '改为无糖拿铁',
  confidence: 0.95,
  validity: directBundle.record.validity,
  conflict: directBundle.record.conflict,
  supersedes: directBundle.record.supersedes,
  evidenceKind: 'explicit',
  evidenceSource: memorySourceFixture({ sourceKind: 'manual_correction', messageId: null }),
  policyRef: null,
  policyGeneration: null,
  reason: null
})
const renewal = buildMemoryRenewalBundleV1({
  commandRef: commandRef('a'),
  operation: 'record.renew',
  namespaceRef,
  namespaceGeneration: 1,
  beforeRevision: directBundle.revision,
  changedByActorRef: ACTOR_REF,
  freshNow: LATER,
  newValidUntil: '2028-07-22T08:00:00.000Z',
  evidenceKind: 'explicit',
  evidenceSource: memorySourceFixture(),
  policyRef: null,
  policyGeneration: null,
  reason: null
})
const conflictChange = buildMemoryConflictChangeBundleV1({
  commandRef: commandRef('b'),
  operation: 'record.changeConflict',
  namespaceRef,
  namespaceGeneration: 1,
  beforeRevision: directBundle.revision,
  changedByActorRef: ACTOR_REF,
  freshNow: LATER,
  validity: { state: 'uncertain', validFrom: null },
  conflict: {
    state: 'possible',
    relatedMemoryIds: [`memory:${'1'.repeat(64)}`],
    note: '存在冲突'
  },
  evidenceKind: 'explicit',
  evidenceSource: memorySourceFixture(),
  policyRef: null,
  policyGeneration: null,
  reason: null
})

function recordChangeCommand (
  operation: 'record.correct' | 'record.renew' | 'record.changeConflict',
  digit: string,
  material: typeof correction
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandRef(digit),
    operation,
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: directBundle.record.memoryId,
    expectedRevision: 1,
    expectedAggregateHash: directBundle.revision.revisionHash,
    occurredAt: LATER,
    newValidUntil: operation === 'record.renew' ? renewal.revision.record.retention.validUntil : null,
    newPurgeAt: operation === 'record.renew' ? renewal.revision.record.retention.purgeAt : null,
    material
  })
}

const correctCommand = recordChangeCommand('record.correct', '9', correction)
const renewCommand = recordChangeCommand('record.renew', 'a', renewal)
const changeConflictCommand = recordChangeCommand('record.changeConflict', 'b', conflictChange)

const correctionProposal = buildMemoryCorrectionProposalDraftV2({
  commandRef: commandRef('c'),
  operation: 'proposal.create',
  namespaceRef,
  namespaceGeneration: 1,
  initiatedByActorRef: ACTOR_REF,
  namespace,
  beforeRevision: directBundle.revision,
  proposedBy: { kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat' },
  text: '纠正为无糖摩卡',
  sources: [memorySourceFixture({ sourceKind: 'manual_correction', messageId: null })],
  observedAt: LATER,
  proposedAt: LATER,
  confidence: 0.9,
  conflict: directBundle.record.conflict,
  consentRequirement: 'explicit',
  consentPolicyRef: null,
  consentPolicyGeneration: null
})
const correctionProposalCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('c'),
  operation: 'proposal.create',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: null,
  expectedRevision: null,
  expectedAggregateHash: null,
  occurredAt: LATER,
  newValidUntil: null,
  newPurgeAt: null,
  material: correctionProposal
})

const forgetCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('d'),
  operation: 'record.forget',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: directBundle.record.memoryId,
  expectedRevision: 1,
  expectedAggregateHash: directBundle.revision.revisionHash,
  occurredAt: LATER,
  newValidUntil: null,
  newPurgeAt: null,
  material: null
})
const deleteCommand = createMemoryLifecycleCommandV1({
  commandRef: commandRef('e'),
  operation: 'namespace.delete',
  initiatedByActorRef: ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: null,
  expectedRevision: null,
  expectedAggregateHash: null,
  occurredAt: LATER,
  newValidUntil: null,
  newPurgeAt: null,
  material: null
})

function forgetTargetCommand (
  commandReference: string,
  initiatedByActorRef: string,
  expectedRevision: number | null,
  expectedAggregateHash: string | null
): MemoryLifecycleCommandV1 {
  return createMemoryLifecycleCommandV1({
    commandRef: commandReference,
    operation: 'record.forget',
    initiatedByActorRef,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: directBundle.record.memoryId,
    expectedRevision,
    expectedAggregateHash,
    occurredAt: LATER,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
}

const subjectOpaqueForgetCommand = forgetTargetCommand(
  `command:${'01'.repeat(32)}`,
  ACTOR_REF,
  null,
  null
)
const botMasterExactForgetCommand = forgetTargetCommand(
  `command:${'02'.repeat(32)}`,
  BOT_MASTER_ACTOR_REF,
  1,
  directBundle.revision.revisionHash
)
const botMasterOpaqueForgetCommand = forgetTargetCommand(
  `command:${'03'.repeat(32)}`,
  BOT_MASTER_ACTOR_REF,
  null,
  null
)
const botMasterDeleteCommand = createMemoryLifecycleCommandV1({
  commandRef: `command:${'04'.repeat(32)}`,
  operation: 'namespace.delete',
  initiatedByActorRef: BOT_MASTER_ACTOR_REF,
  namespaceRef,
  expectedNamespaceGeneration: 1,
  aggregateRef: null,
  expectedRevision: null,
  expectedAggregateHash: null,
  occurredAt: LATER,
  newValidUntil: null,
  newPurgeAt: null,
  material: null
})

const accessIssuer = createMemoryAccessCapabilityIssuerV1(() => true)
const authorityRoot = createMemoryLifecycleAuthorityRootV1(() => true)

function accessCapability (
  targetNamespace: MemoryNamespaceV1 = namespace,
  now = NOW
): MemoryAccessCapabilityV1 {
  return issueMemoryAccessCapabilityV1(accessIssuer, {
    schemaVersion: 1,
    botInstanceId: targetNamespace.botInstanceId,
    adapter: 'qq',
    accountId: targetNamespace.accountId,
    scene: {
      kind: 'private',
      peerUserId: targetNamespace.scope.kind === 'personal'
        ? targetNamespace.scope.subjectUserId
        : FIXTURE_IDS.subjectUserId
    }
  }, [targetNamespace], now)
}

function actorCapability (
  access: MemoryAccessCapabilityV1,
  actions: readonly MemoryLifecycleActorActionV1[],
  overrides: Readonly<Record<string, unknown>> = {},
  now = NOW
) {
  return issueMemoryLifecycleActorCapabilityV1(authorityRoot, {
    schemaVersion: 1,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq',
    accountId: namespace.accountId,
    sceneRef: access.sceneRef,
    namespace,
    namespaceRef,
    generation: 1,
    actorRef: ACTOR_REF,
    actorUserId: FIXTURE_IDS.subjectUserId,
    role: 'personal_subject',
    roleObservedAt: null,
    actions,
    ...overrides
  }, now)
}

function botMasterCapability (
  access: MemoryAccessCapabilityV1,
  actions: readonly MemoryLifecycleActorActionV1[]
) {
  return actorCapability(access, actions, {
    actorRef: BOT_MASTER_ACTOR_REF,
    actorUserId: '90001',
    role: 'personal_bot_master'
  })
}

function policyCapability (
  access: MemoryAccessCapabilityV1,
  overrides: Readonly<Record<string, unknown>> = {},
  now = NOW
) {
  return issueMemoryPolicyCapabilityV1(authorityRoot, {
    schemaVersion: 1,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq',
    accountId: namespace.accountId,
    sceneRef: access.sceneRef,
    namespace,
    namespaceRef,
    generation: 1,
    policyRef: POLICY_REF,
    policyGeneration: 1,
    createdByActorRef: ACTOR_REF,
    createdByUserId: FIXTURE_IDS.subjectUserId,
    consent: 'owner_policy',
    allowedKinds: ['preference'],
    allowedSensitivities: ['personal'],
    allowedSourceKinds: ['current_message'],
    allowedRetentionPolicyRefs: ['retention:memory-lifecycle-v1'],
    ...overrides
  }, now)
}

function maintenanceCapability (now = NOW) {
  return issueMemoryMaintenanceCapabilityV1(authorityRoot, {
    schemaVersion: 1,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq',
    accountId: namespace.accountId,
    namespace,
    namespaceRef,
    currentGeneration: 1,
    targetGeneration: 1,
    deletionRef: null,
    operation: 'proposal.expireDue',
    limit: 1
  }, now)
}

function envelope (
  command: MemoryLifecycleCommandV1,
  access: MemoryAccessCapabilityV1,
  authority: MemoryLifecycleAuthorizationEnvelopeV1['authority']
): MemoryLifecycleAuthorizationEnvelopeV1 {
  return { schemaVersion: 1, command, access, authority }
}

function commandHash (command: MemoryLifecycleCommandV1): string {
  return memoryLifecycleCommandHashV1(command.wire)
}

function terminalResult (command: MemoryLifecycleCommandV1) {
  const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
  const status = wire.operation === 'proposal.create' ||
    wire.operation === 'proposal.createAndApprove'
    ? 'proposal_expired'
    : 'not_found'
  return createMemoryLifecycleStableResultV1({
    schemaVersion: 1,
    operation: wire.operation,
    commandHash: commandHash(command),
    status
  })
}

test('lifecycle port maps every operation to exact actor or maintenance authority', async () => {
  const access = accessCapability()
  const cases: readonly [MemoryLifecycleCommandV1, readonly MemoryLifecycleActorActionV1[]][] = [
    [createCommand, ['propose_create']],
    [correctionProposalCommand, ['propose_correction']],
    [directCommand, ['propose_create', 'approve']],
    [approveCommand, ['approve']],
    [rejectCommand, ['reject']],
    [withdrawCommand, ['withdraw_own_proposal']],
    [correctCommand, ['correct']],
    [renewCommand, ['renew']],
    [changeConflictCommand, ['change_conflict']],
    [forgetCommand, ['forget']],
    [deleteCommand, ['delete_namespace']]
  ]
  let dispatches = 0
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })

  for (const [command, actions] of cases) {
    const result = await port.execute(envelope(command, access, {
      kind: 'actor',
      capability: actorCapability(access, actions)
    }))
    assert.equal(result.operation, decodeMemoryLifecycleCommandWireV1(command.wire).operation)
    assert.notEqual(result.status, 'denied')
  }

  const expired = await port.execute(envelope(expireCommand, access, {
    kind: 'maintenance',
    capability: maintenanceCapability()
  }))
  assert.equal(expired.status, 'not_found')
  assert.equal(dispatches, cases.length + 1)
  assert.equal(createProposal.proposedBy.kind, 'model')
  assert.equal(createProposal.state, 'pending')
})

test('approve accepts exactly explicit actor or matching owner policy and policy cannot mutate records', async () => {
  const access = accessCapability()
  let dispatches = 0
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })
  const explicit = await port.execute(envelope(approveCommand, access, {
    kind: 'actor', capability: actorCapability(access, ['approve'])
  }))
  const policy = await port.execute(envelope(policyApproveCommand, access, {
    kind: 'policy', capability: policyCapability(access)
  }))
  assert.equal(explicit.status, 'not_found')
  assert.equal(policy.status, 'not_found')

  const explicitViaPolicy = await port.execute(envelope(approveCommand, access, {
    kind: 'policy', capability: policyCapability(access)
  }))
  const policyViaActor = await port.execute(envelope(policyApproveCommand, access, {
    kind: 'actor', capability: actorCapability(access, ['approve'])
  }))
  const policyCorrection = await port.execute(envelope(correctCommand, access, {
    kind: 'policy', capability: policyCapability(access)
  }))
  assert.deepEqual(
    [explicitViaPolicy, policyViaActor, policyCorrection].map(result => [result.status, 'category' in result ? result.category : null]),
    [['denied', 'authority'], ['denied', 'authority'], ['denied', 'authority']]
  )
  assert.equal(dispatches, 2)
})

test('policy outer advisory binds identity and passes exact scope validation to the locked adapter', async () => {
  const access = accessCapability()
  const capability = policyCapability(access, {
    allowedKinds: ['profile_fact'],
    allowedSensitivities: ['sensitive'],
    allowedSourceKinds: ['quoted_message'],
    allowedRetentionPolicyRefs: ['retention:other-v1']
  })
  const dispatched: {
    authority?: MemoryLifecycleAuthorizationEnvelopeV1['authority']
    material?: MemoryLifecycleCommandV1['material']
    wire?: string
  } = {}
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatched.authority = request.authority
      dispatched.material = request.command.material
      dispatched.wire = request.command.wire
      return terminalResult(request.command)
    }
  })

  const result = await port.execute(envelope(policyApproveCommand, access, {
    kind: 'policy',
    capability
  }))

  assert.equal(result.status, 'not_found')
  assert.equal(dispatched.authority?.kind, 'policy')
  if (dispatched.authority?.kind !== 'policy') throw new TypeError('policy dispatch missing')
  assert.strictEqual(dispatched.authority.capability, capability)
  assert.deepEqual(dispatched.material, policyApprovalBundle.consentEvidence)
  assert.notEqual(dispatched.wire, undefined)
  for (const forbidden of [
    POLICY_REF,
    'owner_policy',
    'evidenceKind',
    'allowedKinds',
    'allowedSensitivities',
    'allowedSourceKinds',
    'allowedRetentionPolicyRefs'
  ]) assert.equal((dispatched.wire as string).includes(forbidden), false, forbidden)
  assert.equal(policyProposal.kind, 'preference')
  assert.deepEqual(capability.allowedKinds, ['profile_fact'])
})

test('wrong access and exact actor or policy bindings deny with zero dispatch', async () => {
  const access = accessCapability()
  let dispatches = 0
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })
  const otherNamespace = createMemoryNamespaceV1({
    botInstanceId: 'groupmate-secondary',
    adapter: 'qq',
    accountId: '10000002',
    scope: { kind: 'personal', subjectUserId: '20000003' }
  })
  const wrongAccess = await port.execute(envelope(createCommand, accessCapability(otherNamespace), {
    kind: 'actor', capability: actorCapability(access, ['propose_create'])
  }))
  assert.deepEqual(wrongAccess, {
    schemaVersion: 1,
    operation: 'proposal.create',
    commandHash: commandHash(createCommand),
    status: 'denied',
    category: 'access'
  })

  const wrongActorCases = [
    actorCapability(access, ['propose_create'], { actorRef: OTHER_ACTOR_REF }),
    actorCapability(access, ['propose_create'], { sceneRef: 'f'.repeat(64) }),
    actorCapability(access, ['propose_create'], { generation: 2 }),
    actorCapability(access, ['list_safe'])
  ]
  for (const capability of wrongActorCases) {
    const result = await port.execute(envelope(createCommand, access, {
      kind: 'actor', capability
    }))
    assert.equal(result.status, 'denied')
    if (result.status === 'denied') assert.equal(result.category, 'authority')
  }

  const wrongBotNamespace = createMemoryNamespaceV1({
    botInstanceId: 'groupmate-secondary',
    adapter: 'qq',
    accountId: namespace.accountId,
    scope: { kind: 'personal', subjectUserId: FIXTURE_IDS.subjectUserId }
  })
  const wrongBot = actorCapability(access, ['propose_create'], {
    botInstanceId: wrongBotNamespace.botInstanceId,
    namespace: wrongBotNamespace,
    namespaceRef: memoryNamespaceRefV1(wrongBotNamespace)
  })
  const wrongAccountNamespace = createMemoryNamespaceV1({
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq',
    accountId: '10000002',
    scope: { kind: 'personal', subjectUserId: FIXTURE_IDS.subjectUserId }
  })
  const wrongAccount = actorCapability(access, ['propose_create'], {
    accountId: wrongAccountNamespace.accountId,
    namespace: wrongAccountNamespace,
    namespaceRef: memoryNamespaceRefV1(wrongAccountNamespace)
  })
  for (const capability of [wrongBot, wrongAccount]) {
    const result = await port.execute(envelope(createCommand, access, {
      kind: 'actor', capability
    }))
    assert.equal(result.status, 'denied')
  }

  const wrongPolicy = await port.execute(envelope(policyApproveCommand, access, {
    kind: 'policy',
    capability: policyCapability(access, { policyRef: 'policy:other-owner-policy' })
  }))
  assert.equal(wrongPolicy.status, 'denied')

  const freshAccess = accessCapability(namespace, '2026-07-22T08:01:00.001Z')
  const expiredActor = actorCapability(access, ['propose_create'])
  const expired = createMemoryLifecyclePortV1({
    now: () => '2026-07-22T08:01:00.001Z',
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })
  const expiredResult = await expired.execute(envelope(createCommand, freshAccess, {
    kind: 'actor', capability: expiredActor
  }))
  assert.equal(expiredResult.status, 'denied')
  if (expiredResult.status === 'denied') assert.equal(expiredResult.category, 'authority')
  assert.equal(dispatches, 0)
})

test('forget target mode is exact for subjects and opaque for personal bot masters', async () => {
  const access = accessCapability()
  let dispatches = 0
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })

  const subjectOpaque = await port.execute(envelope(subjectOpaqueForgetCommand, access, {
    kind: 'actor', capability: actorCapability(access, ['forget'])
  }))
  const masterExact = await port.execute(envelope(botMasterExactForgetCommand, access, {
    kind: 'actor', capability: botMasterCapability(access, ['forget'])
  }))
  for (const result of [subjectOpaque, masterExact]) {
    assert.equal(result.status, 'denied')
    if (result.status === 'denied') assert.equal(result.category, 'authority')
  }
  assert.equal(dispatches, 0)

  const masterOpaque = await port.execute(envelope(botMasterOpaqueForgetCommand, access, {
    kind: 'actor', capability: botMasterCapability(access, ['forget'])
  }))
  assert.equal(masterOpaque.status, 'opaque_not_applied')
  assert.equal(dispatches, 1)
})

test('delete-only results hide target existence but retain idempotency misuse', async () => {
  const access = accessCapability()
  const commands = [botMasterOpaqueForgetCommand, botMasterDeleteCommand]
  const statuses = [
    { status: 'not_found' as const, expectedStatus: 'opaque_not_applied' as const },
    { status: 'conflict' as const, category: 'revision' as const, expectedStatus: 'opaque_not_applied' as const },
    { status: 'conflict' as const, category: 'generation' as const, expectedStatus: 'opaque_not_applied' as const },
    { status: 'conflict' as const, category: 'idempotency' as const, expectedStatus: 'conflict' as const }
  ]
  let dispatches = 0

  for (const command of commands) {
    const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
    const authority = {
      kind: 'actor' as const,
      capability: botMasterCapability(access, [
        wire.operation === 'record.forget' ? 'forget' : 'delete_namespace'
      ])
    }
    for (const fixture of statuses) {
      const category = 'category' in fixture ? fixture.category : null
      const adapterResult = createMemoryLifecycleResultV1({
        schemaVersion: 1,
        operation: wire.operation,
        commandHash: commandHash(command),
        status: fixture.status,
        ...(category === null ? {} : { category })
      })
      const port = createMemoryLifecyclePortV1({
        now: () => NOW,
        execute: async () => {
          dispatches += 1
          return adapterResult
        }
      })
      const result = await port.execute(envelope(command, access, authority))
      assert.equal(result.status, fixture.expectedStatus, `${wire.operation}/${category ?? 'none'}`)
      if (category === 'idempotency') {
        assert.equal(result.status === 'conflict' ? result.category : null, 'idempotency')
      } else {
        assert.deepEqual(result, {
          schemaVersion: 1,
          operation: wire.operation,
          commandHash: commandHash(command),
          status: 'opaque_not_applied'
        })
      }
    }
  }
  assert.equal(dispatches, commands.length * statuses.length)
})

test('malformed and hostile envelopes fail closed without reading getters or dispatching', async () => {
  const access = accessCapability()
  const valid = envelope(createCommand, access, {
    kind: 'actor', capability: actorCapability(access, ['propose_create'])
  })
  let dispatches = 0
  let getterReads = 0
  const port = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })
  const getter = { ...valid }
  Object.defineProperty(getter, 'authority', {
    get: () => {
      getterReads += 1
      return valid.authority
    },
    enumerable: true
  })
  const symbol = { ...valid }
  Object.defineProperty(symbol, Symbol('claim'), { value: true, enumerable: true })
  const sparse: unknown[] = []
  sparse.length = 2
  sparse[1] = valid.authority
  for (const hostile of [
    new Proxy(valid, {}),
    getter,
    symbol,
    { ...valid, authority: sparse },
    { ...valid, authority: { kind: 'actor', capability: new Proxy(valid.authority.capability, {}) } }
  ]) {
    await assert.rejects(port.execute(hostile), TypeError)
  }
  assert.equal(getterReads, 0)
  assert.equal(dispatches, 0)
})

test('abort semantics distinguish zero dispatch, known commit and unknown post-dispatch outcome', async () => {
  const access = accessCapability()
  const authority = { kind: 'actor' as const, capability: actorCapability(access, ['propose_create']) }
  const preAbort = new AbortController()
  preAbort.abort()
  let dispatches = 0
  let nowCalls = 0
  const prePort = createMemoryLifecyclePortV1({
    now: () => {
      nowCalls += 1
      throw new Error('hostile clock must not run')
    },
    execute: async request => {
      dispatches += 1
      return terminalResult(request.command)
    }
  })
  const preResult = await prePort.execute(envelope(createCommand, access, authority), preAbort.signal)
  assert.equal(preResult.status, 'aborted')
  assert.equal(dispatches, 0)
  assert.equal(nowCalls, 0)

  const committedController = new AbortController()
  const committedResult = createMemoryLifecycleStableResultV1({
    schemaVersion: 1,
    operation: 'proposal.create',
    commandHash: commandHash(createCommand),
    status: 'stored',
    resultRef: createProposal.proposalId,
    resultRevision: 1,
    resultHash: RESULT_HASH,
    receiptHash: RECEIPT_HASH
  })
  const committedPort = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async () => {
      committedController.abort()
      return committedResult
    }
  })
  const late = await committedPort.execute(
    envelope(createCommand, access, authority),
    committedController.signal
  )
  assert.equal(late.status, 'committed_after_abort')
  if (late.status !== 'committed_after_abort') throw new TypeError('unexpected late result')
  assert.equal(late.resolveRef, memoryLifecycleResolveRefV1(commandHash(createCommand)))
  assert.equal(late.committedResultHash, memoryLifecycleStableResultHashV1(committedResult))

  const deleteOnlyController = new AbortController()
  const committedNotFound = createMemoryLifecycleStableResultV1({
    schemaVersion: 1,
    operation: 'record.forget',
    commandHash: commandHash(botMasterOpaqueForgetCommand),
    status: 'not_found'
  })
  const deleteOnlyPort = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async () => {
      deleteOnlyController.abort()
      return committedNotFound
    }
  })
  const deleteOnlyLate = await deleteOnlyPort.execute(envelope(
    botMasterOpaqueForgetCommand,
    access,
    {
      kind: 'actor',
      capability: botMasterCapability(access, ['forget'])
    }
  ), deleteOnlyController.signal)
  assert.equal(deleteOnlyLate.status, 'committed_after_abort')
  if (deleteOnlyLate.status !== 'committed_after_abort') {
    throw new TypeError('unexpected delete-only late result')
  }
  assert.equal(
    deleteOnlyLate.committedResultHash,
    memoryLifecycleStableResultHashV1(createMemoryLifecycleStableResultV1({
      schemaVersion: 1,
      operation: 'record.forget',
      commandHash: commandHash(botMasterOpaqueForgetCommand),
      status: 'opaque_not_applied'
    }))
  )

  const deletionController = new AbortController()
  const deletionReceipt = createDeletionMutationReceiptV1({
    commandRefHash: memoryLifecycleCommandRefHashV1(
      decodeMemoryLifecycleCommandWireV1(botMasterDeleteCommand.wire).commandRef
    ),
    operation: 'delete_namespace',
    repositoryReceiptHash: '1'.repeat(64),
    namespaceRef,
    generationBefore: 1,
    generationAfter: 2,
    deletingGeneration: 1,
    memoryId: null,
    deletedRevision: null,
    committedAt: LATER,
    tombstoneReceiptHash: '2'.repeat(64)
  })
  const deletionStableResult = createMemoryLifecycleStableResultV1({
    schemaVersion: 1,
    operation: 'namespace.delete',
    commandHash: commandHash(botMasterDeleteCommand),
    status: 'deletion_pending',
    receipt: deletionReceipt
  })
  const deletionPort = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: async () => {
      deletionController.abort()
      return deletionStableResult
    }
  })
  const deletionLate = await deletionPort.execute(envelope(
    botMasterDeleteCommand,
    access,
    {
      kind: 'actor',
      capability: botMasterCapability(access, ['delete_namespace'])
    }
  ), deletionController.signal)
  assert.equal(deletionLate.status, 'committed_after_abort')
  if (deletionLate.status !== 'committed_after_abort') {
    throw new TypeError('unexpected deletion late result')
  }
  assert.deepEqual(deletionLate.receipt, deletionReceipt)
  assert.equal(
    deletionLate.committedResultHash,
    memoryLifecycleStableResultHashV1(deletionStableResult)
  )

  for (const behavior of ['throw', 'invalid'] as const) {
    const controller = new AbortController()
    const port = createMemoryLifecyclePortV1({
      now: () => NOW,
      execute: async () => {
        controller.abort()
        if (behavior === 'throw') throw new Error('secret database path /tmp/memory.db')
        return { status: 'stored', text: 'secret' }
      }
    })
    const result = await port.execute(envelope(createCommand, access, authority), controller.signal)
    assert.deepEqual(result, {
      schemaVersion: 1,
      operation: 'proposal.create',
      commandHash: commandHash(createCommand),
      status: 'resolve_required',
      category: 'outcome_unknown',
      resolveRef: memoryLifecycleResolveRefV1(commandHash(createCommand))
    })
  }
})

test('ordinary adapter failures are fixed and forged results never cross the boundary', async () => {
  const access = accessCapability()
  const authority = { kind: 'actor' as const, capability: actorCapability(access, ['propose_create']) }
  for (const [adapterResult, expected] of [
    [new Error('secret /root/path'), {
      status: 'unavailable', category: 'io', retryable: true
    }],
    [{ status: 'stored', text: 'secret' }, {
      status: 'corrupt', category: 'adapter_contract'
    }],
    [createMemoryLifecycleStableResultV1({
      schemaVersion: 1,
      operation: 'proposal.create',
      commandHash: 'f'.repeat(64),
      status: 'proposal_expired'
    }), { status: 'corrupt', category: 'adapter_contract' }],
    [createMemoryLifecycleResultV1({
      schemaVersion: 1,
      operation: 'proposal.create',
      commandHash: commandHash(createCommand),
      status: 'committed_after_abort',
      resolveRef: memoryLifecycleResolveRefV1(commandHash(createCommand)),
      committedResultHash: RESULT_HASH
    }), { status: 'corrupt', category: 'adapter_contract' }],
    [createMemoryLifecycleResultV1({
      schemaVersion: 1,
      operation: 'proposal.create',
      commandHash: commandHash(createCommand),
      status: 'resolve_required',
      category: 'outcome_unknown',
      resolveRef: memoryLifecycleResolveRefV1(commandHash(createCommand))
    }), { status: 'corrupt', category: 'adapter_contract' }]
  ] as const) {
    const port = createMemoryLifecyclePortV1({
      now: () => NOW,
      execute: async () => {
        if (adapterResult instanceof Error) throw adapterResult
        return adapterResult
      }
    })
    const result = await port.execute(envelope(createCommand, access, authority))
    assert.equal(result.status, expected.status)
    if ('category' in expected) {
      assert.equal('category' in result ? result.category : null, expected.category)
    }
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(JSON.stringify(result).includes('/root/path'), false)
  }
})

test('adapter stored results are bound to exact aggregate and next revision', async () => {
  const access = accessCapability()
  const authority = { kind: 'actor' as const, capability: actorCapability(access, ['correct']) }
  for (const mutation of [
    { resultRef: `memory:${'9'.repeat(64)}` },
    { resultRevision: 3 }
  ]) {
    const port = createMemoryLifecyclePortV1({
      now: () => NOW,
      execute: async () => createMemoryLifecycleStableResultV1({
        schemaVersion: 1,
        operation: 'record.correct',
        commandHash: commandHash(correctCommand),
        status: 'stored',
        resultRef: directBundle.record.memoryId,
        resultRevision: 2,
        resultHash: RESULT_HASH,
        receiptHash: RECEIPT_HASH,
        ...mutation
      })
    })
    const result = await port.execute(envelope(correctCommand, access, authority))
    assert.equal(result.status, 'corrupt')
    if (result.status === 'corrupt') assert.equal(result.category, 'adapter_contract')
  }
})
