import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1,
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1,
  issueMemoryPolicyCapabilityV1,
  memoryLifecycleActorCapabilityAllowsV1,
  memoryMaintenanceCapabilityAllowsV1,
  memoryPolicyCapabilityAllowsV1,
  parseMemoryLifecycleActorAuthorityContextV1,
  parseMemoryMaintenanceAuthorityContextV1,
  parseMemoryPolicyAuthorityContextV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'

const NOW = '2026-07-22T08:00:00.000Z'
const SCENE_REF = 'a'.repeat(64)
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const MASTER_REF = `actor:${'c'.repeat(64)}`
const OTHER_ACTOR_REF = `actor:${'d'.repeat(64)}`
const DELETION_REF = `deletion:${'e'.repeat(64)}`

test('lifecycle resource constants lock the normative command and control-plane bounds', () => {
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes, 4 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes, 4 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandMaterialWireBytes, 64 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace, 8_192)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace, 8 * 1_024 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs, 365 * 24 * 60 * 60 * 1_000)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes, 16 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationRevisionBindings, 32)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace, 32)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionReceiptWireBytes, 4 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionStatusWireBytes, 4 * 1_024)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace, 64)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportTerminalTtlMs, 30 * 60 * 1_000)
  assert.equal(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditTtlMs, 365 * 24 * 60 * 60 * 1_000)
})

function namespace (scope: MemoryNamespaceV1['scope']): MemoryNamespaceV1 {
  return parseMemoryNamespaceV1({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10001',
    scope
  })
}

function actorContext (overrides: Record<string, unknown> = {}) {
  const value = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  return {
    schemaVersion: 1,
    botInstanceId: value.botInstanceId,
    adapter: 'qq',
    accountId: value.accountId,
    sceneRef: SCENE_REF,
    namespace: value,
    namespaceRef: memoryNamespaceRefV1(value),
    generation: 4,
    actorRef: ACTOR_REF,
    actorUserId: '20002',
    role: 'group_admin',
    roleObservedAt: '2026-07-22T07:59:30.000Z',
    actions: ['propose_create', 'list_safe', 'inspect_full', 'approve', 'forget'],
    ...overrides
  }
}

test('one branded authority root issues exact actor authority and rejects forgery', () => {
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const context = parseMemoryLifecycleActorAuthorityContextV1(actorContext())
  const capability = issueMemoryLifecycleActorCapabilityV1(root, context, NOW)
  const exact = {
    botInstanceId: context.botInstanceId,
    accountId: context.accountId,
    sceneRef: context.sceneRef,
    namespaceRef: context.namespaceRef,
    generation: context.generation,
    actorRef: context.actorRef,
    action: 'approve' as const,
    requiredAuthority: 'ordinary' as const
  }

  assert.equal(memoryLifecycleActorCapabilityAllowsV1(capability, exact, NOW), true)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(capability, {
    ...exact,
    generation: 5
  }, NOW), false)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(capability, {
    ...exact,
    actorRef: OTHER_ACTOR_REF
  }, NOW), false)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(capability, {
    ...exact,
    requiredAuthority: 'elevated'
  }, NOW), false)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1({ ...capability }, exact, NOW), false)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(new Proxy(capability, {}), exact, NOW), false)
})

test('actor role snapshot and capability both have an absolute sixty second window', () => {
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const capability = issueMemoryLifecycleActorCapabilityV1(root, actorContext(), NOW)
  const request = {
    botInstanceId: 'groupmate-primary',
    accountId: '10001',
    sceneRef: SCENE_REF,
    namespaceRef: capability.namespaceRef,
    generation: 4,
    actorRef: ACTOR_REF,
    action: 'approve' as const,
    requiredAuthority: 'ordinary' as const
  }

  assert.equal(capability.validUntil, '2026-07-22T08:00:30.000Z')
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(capability, request, capability.validUntil), true)
  assert.equal(memoryLifecycleActorCapabilityAllowsV1(
    capability,
    request,
    '2026-07-22T08:00:30.001Z'
  ), false)
  assert.throws(() => issueMemoryLifecycleActorCapabilityV1(root, actorContext({
    roleObservedAt: '2026-07-22T07:58:59.999Z'
  }), NOW), TypeError)
  assert.throws(() => issueMemoryLifecycleActorCapabilityV1(root, actorContext({
    roleObservedAt: '2026-07-22T08:00:05.001Z'
  }), NOW), TypeError)
  assert.throws(() => issueMemoryLifecycleActorCapabilityV1(
    root,
    actorContext({ roleObservedAt: '+275760-09-12T23:59:30.001Z' }),
    '+275760-09-12T23:59:59.999Z'
  ), TypeError)
  assert.throws(() => issueMemoryLifecycleActorCapabilityV1(
    root,
    actorContext({ roleObservedAt: '1969-12-31T23:59:59.999Z' }),
    '1969-12-31T23:59:59.999Z'
  ), TypeError)
})

test('strict authority parsers reject proxy, symbols, accessors and impossible role actions', () => {
  const withSymbol = actorContext()
  Object.defineProperty(withSymbol, Symbol('claim'), { value: true, enumerable: true })
  const withAccessor = actorContext()
  Object.defineProperty(withAccessor, 'isMaster', { get: () => true, enumerable: true })

  for (const value of [
    new Proxy(actorContext(), {}),
    withSymbol,
    withAccessor,
    actorContext({ isMaster: true }),
    actorContext({ role: 'group_member', actions: ['approve'] }),
    actorContext({ actions: ['approve', 'approve'] })
  ]) assert.throws(() => parseMemoryLifecycleActorAuthorityContextV1(value), TypeError)
})

test('the fixed role matrix permits only bounded action subsets for every role', () => {
  const personal = namespace({ kind: 'personal', subjectUserId: '20002' })
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const all = [
    'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe',
    'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict',
    'forget', 'export', 'delete_namespace', 'resolve_deletion', 'claim_export'
  ]
  const fixtures = [
    { namespace: personal, actorRef: ACTOR_REF, actorUserId: '20002', role: 'personal_subject', actions: all },
    { namespace: personal, actorRef: MASTER_REF, actorUserId: '90001', role: 'personal_bot_master', actions: [
      'forget', 'delete_namespace', 'resolve_deletion'
    ] },
    { namespace: group, actorRef: ACTOR_REF, actorUserId: '20002', role: 'group_member', actions: [
      'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe'
    ] },
    { namespace: group, actorRef: ACTOR_REF, actorUserId: '20002', role: 'group_admin', actions: [
      'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe',
      'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict', 'forget'
    ] },
    { namespace: group, actorRef: ACTOR_REF, actorUserId: '20002', role: 'group_owner', actions: all },
    { namespace: group, actorRef: ACTOR_REF, actorUserId: '20002', role: 'group_bot_master', actions: all }
  ]
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => parseMemoryLifecycleActorAuthorityContextV1({
      schemaVersion: 1,
      botInstanceId: fixture.namespace.botInstanceId,
      adapter: 'qq',
      accountId: fixture.namespace.accountId,
      sceneRef: SCENE_REF,
      namespace: fixture.namespace,
      namespaceRef: memoryNamespaceRefV1(fixture.namespace),
      generation: 1,
      actorRef: fixture.actorRef,
      actorUserId: fixture.actorUserId,
      role: fixture.role,
      roleObservedAt: fixture.namespace.scope.kind === 'group' ? NOW : null,
      actions: fixture.actions
    }))
    for (const action of MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1) {
      const parse = () => parseMemoryLifecycleActorAuthorityContextV1({
        schemaVersion: 1,
        botInstanceId: fixture.namespace.botInstanceId,
        adapter: 'qq',
        accountId: fixture.namespace.accountId,
        sceneRef: SCENE_REF,
        namespace: fixture.namespace,
        namespaceRef: memoryNamespaceRefV1(fixture.namespace),
        generation: 1,
        actorRef: fixture.actorRef,
        actorUserId: fixture.actorUserId,
        role: fixture.role,
        roleObservedAt: fixture.namespace.scope.kind === 'group' ? NOW : null,
        actions: [action]
      })
      if (fixture.actions.includes(action)) assert.doesNotThrow(parse)
      else assert.throws(parse, TypeError)
    }
  }
  assert.throws(() => parseMemoryLifecycleActorAuthorityContextV1({
    ...actorContext(),
    role: 'model',
    actions: ['propose_create']
  }), TypeError)
})

test('async, throwing and non-boolean trusted verifiers fail closed', async () => {
  for (const verifier of [
    () => Promise.resolve(true),
    () => { throw new Error('no facts') },
    () => 1
  ]) {
    const root = createMemoryLifecycleAuthorityRootV1(verifier as never)
    assert.throws(() => issueMemoryLifecycleActorCapabilityV1(root, actorContext(), NOW), TypeError)
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('policy authority is exact and enforces personal/owner and group/group pairing', () => {
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const personal = namespace({ kind: 'personal', subjectUserId: '20002' })
  const context = parseMemoryPolicyAuthorityContextV1({
    schemaVersion: 1,
    botInstanceId: personal.botInstanceId,
    adapter: 'qq',
    accountId: personal.accountId,
    sceneRef: SCENE_REF,
    namespace: personal,
    namespaceRef: memoryNamespaceRefV1(personal),
    generation: 2,
    policyRef: 'policy:personal-auto-memory-v1',
    policyGeneration: 3,
    createdByActorRef: ACTOR_REF,
    createdByUserId: '20002',
    consent: 'owner_policy',
    allowedKinds: ['profile_fact', 'preference'],
    allowedSensitivities: ['personal'],
    allowedSourceKinds: ['current_message'],
    allowedRetentionPolicyRefs: ['retention:memory-lifecycle-v1']
  })
  const capability = issueMemoryPolicyCapabilityV1(root, context, NOW)
  const exact = {
    botInstanceId: context.botInstanceId,
    accountId: context.accountId,
    sceneRef: context.sceneRef,
    namespaceRef: context.namespaceRef,
    generation: context.generation,
    policyRef: context.policyRef,
    policyGeneration: context.policyGeneration,
    consent: context.consent,
    kind: 'preference' as const,
    sensitivity: 'personal' as const,
    sourceKinds: ['current_message'] as const,
    retentionPolicyRef: 'retention:memory-lifecycle-v1'
  }
  assert.equal(memoryPolicyCapabilityAllowsV1(capability, exact, NOW), true)
  assert.equal(memoryPolicyCapabilityAllowsV1(capability, {
    ...exact,
    policyGeneration: 4
  }, NOW), false)
  for (const mutation of [
    { botInstanceId: 'groupmate-secondary' },
    { accountId: '10002' },
    { sceneRef: 'c'.repeat(64) },
    { namespaceRef: 'd'.repeat(64) },
    { consent: 'group_policy' },
    { kind: 'task_fact' },
    { sensitivity: 'sensitive' },
    { sourceKinds: ['quoted_message'] },
    { retentionPolicyRef: 'retention:other-v1' }
  ]) {
    assert.equal(memoryPolicyCapabilityAllowsV1(capability, {
      ...exact,
      ...mutation
    }, NOW), false)
  }
  assert.throws(() => parseMemoryPolicyAuthorityContextV1({
    ...context,
    consent: 'group_policy'
  }), TypeError)
  assert.equal(memoryPolicyCapabilityAllowsV1({ ...capability }, exact, NOW), false)
  assert.equal(memoryPolicyCapabilityAllowsV1(new Proxy(capability, {}), exact, NOW), false)
  assert.equal(memoryPolicyCapabilityAllowsV1(
    capability,
    exact,
    '2026-07-22T08:01:00.001Z'
  ), false)

  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const groupPolicy = {
    ...context,
    namespace: group,
    namespaceRef: memoryNamespaceRefV1(group),
    consent: 'group_policy',
    allowedKinds: ['group_rule'],
    allowedSensitivities: ['group'],
    allowedSourceKinds: ['group_history']
  }
  assert.doesNotThrow(() => parseMemoryPolicyAuthorityContextV1(groupPolicy))
  for (const mutation of [
    { allowedKinds: ['profile_fact'] },
    { allowedSensitivities: ['personal'] },
    { allowedSourceKinds: ['private_history'] }
  ]) {
    assert.throws(() => parseMemoryPolicyAuthorityContextV1({
      ...groupPolicy,
      ...mutation
    }), TypeError)
  }
})

test('maintenance authority is exact, bounded and never grants content reads', () => {
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const context = parseMemoryMaintenanceAuthorityContextV1({
    schemaVersion: 1,
    botInstanceId: group.botInstanceId,
    adapter: 'qq',
    accountId: group.accountId,
    namespace: group,
    namespaceRef: memoryNamespaceRefV1(group),
    currentGeneration: 5,
    targetGeneration: 3,
    deletionRef: DELETION_REF,
    operation: 'namespace.scrubDeleted',
    limit: 32
  })
  const capability = issueMemoryMaintenanceCapabilityV1(root, context, NOW)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(capability, context, NOW), true)
  assert.equal(memoryMaintenanceCapabilityAllowsV1({ ...capability }, context, NOW), false)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(new Proxy(capability, {}), context, NOW), false)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(
    capability,
    context,
    '2026-07-22T08:01:00.000Z'
  ), true)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(
    capability,
    context,
    '2026-07-22T08:01:00.001Z'
  ), false)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(capability, {
    ...context,
    limit: 31
  }, NOW), false)
  assert.equal(memoryMaintenanceCapabilityAllowsV1(capability, {
    ...context,
    operation: 'inspect'
  }, NOW), false)
  assert.throws(() => parseMemoryMaintenanceAuthorityContextV1({
    ...context,
    targetGeneration: 5
  }), TypeError)
  const otherGroup = namespace({
    kind: 'group',
    groupId: '30004',
    groupLifecycleId: 'group-30004-generation-1'
  })
  assert.throws(() => parseMemoryMaintenanceAuthorityContextV1({
    ...context,
    namespace: otherGroup
  }), TypeError)
  assert.throws(() => parseMemoryMaintenanceAuthorityContextV1({
    ...context,
    accountId: '10002'
  }), TypeError)
  for (const deletionRef of [
    'deletion:group-30003-generation-3',
    'deletion:30003',
    'deletion:remember this text',
    `deletion:${'E'.repeat(64)}`
  ]) {
    assert.throws(() => parseMemoryMaintenanceAuthorityContextV1({
      ...context,
      deletionRef
    }), TypeError)
  }

  for (const operation of [
    'proposal.expireDue',
    'proposal.purgeDecided',
    'record.purgeExpired',
    'tombstone.purgeExpired',
    'audit.purgeExpired',
    'command.purgeExpired',
    'export.releaseExpiredReservations'
  ]) {
    assert.doesNotThrow(() => parseMemoryMaintenanceAuthorityContextV1({
      ...context,
      currentGeneration: 5,
      targetGeneration: 5,
      deletionRef: null,
      operation
    }))
  }
  for (const operation of [
    'namespace.scrubDeleted', 'namespace.verifyScrubbed', 'deletion.checkpoint'
  ]) {
    assert.doesNotThrow(() => parseMemoryMaintenanceAuthorityContextV1({
      ...context,
      operation
    }))
  }
})
