import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  decideMemoryLifecycleActorPolicyV1,
  evaluateGroupMemoryAdmissionV1,
  memoryConsentMatchesNamespaceV1
} from '../../src/agent/memory/memory-lifecycle-policy.js'
import {
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  groupSceneFixture,
  memorySourceFixture,
  privateSceneFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-22T08:00:00.000Z'
const SCENE_REF = 'b'.repeat(64)
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const MASTER_REF = `actor:${'c'.repeat(64)}`
const OTHER_ACTOR_REF = `actor:${'d'.repeat(64)}`

function namespace (scope: MemoryNamespaceV1['scope']): MemoryNamespaceV1 {
  return parseMemoryNamespaceV1({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10001',
    scope
  })
}

function actorCapability (
  value: MemoryNamespaceV1,
  role: string,
  actions: readonly string[],
  actorRef = ACTOR_REF,
  actorUserId = '20002'
) {
  return issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: value.botInstanceId,
      adapter: 'qq',
      accountId: value.accountId,
      sceneRef: SCENE_REF,
      namespace: value,
      namespaceRef: memoryNamespaceRefV1(value),
      generation: 1,
      actorRef,
      actorUserId,
      role,
      roleObservedAt: value.scope.kind === 'group' ? NOW : null,
      actions
    },
    NOW
  )
}

function request (value: MemoryNamespaceV1, action: string, overrides = {}) {
  return {
    botInstanceId: value.botInstanceId,
    accountId: value.accountId,
    sceneRef: SCENE_REF,
    namespaceRef: memoryNamespaceRefV1(value),
    generation: 1,
    actorRef: ACTOR_REF,
    action,
    beforeRequirement: 'ordinary',
    afterRequirement: 'ordinary',
    initiatedByActorRef: null,
    targetMode: 'none',
    expectedRevision: null,
    ...overrides
  }
}

test('personal subject receives full control while non-subject master remains delete-only', () => {
  const personal = namespace({ kind: 'personal', subjectUserId: '20002' })
  const subject = actorCapability(personal, 'personal_subject', [
    'inspect_full', 'approve', 'forget', 'export', 'delete_namespace', 'resolve_deletion'
  ])
  assert.equal(decideMemoryLifecycleActorPolicyV1(
    subject,
    request(personal, 'approve'),
    NOW
  ).allowed, true)

  const master = actorCapability(
    personal,
    'personal_bot_master',
    ['forget', 'delete_namespace', 'resolve_deletion'],
    MASTER_REF,
    '90001'
  )
  assert.equal(decideMemoryLifecycleActorPolicyV1(master, request(personal, 'inspect_full', {
    actorRef: MASTER_REF
  }), NOW).allowed, false)
  assert.equal(decideMemoryLifecycleActorPolicyV1(master, request(personal, 'forget', {
    actorRef: MASTER_REF,
    beforeRequirement: 'none',
    afterRequirement: 'none',
    targetMode: 'opaque_delete_only'
  }), NOW).projection, 'delete_only')
})

test('group member may safe-list, withdraw own and propose correction but not inspect or mutate', () => {
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const member = actorCapability(group, 'group_member', [
    'propose_correction', 'withdraw_own_proposal', 'list_safe'
  ])
  assert.equal(decideMemoryLifecycleActorPolicyV1(member, request(group, 'list_safe', {
    beforeRequirement: 'none', afterRequirement: 'none'
  }), NOW).projection, 'safe')
  assert.equal(decideMemoryLifecycleActorPolicyV1(member, request(group, 'withdraw_own_proposal', {
    beforeRequirement: 'none',
    afterRequirement: 'none',
    initiatedByActorRef: ACTOR_REF
  }), NOW).allowed, true)
  assert.equal(decideMemoryLifecycleActorPolicyV1(member, request(group, 'withdraw_own_proposal', {
    beforeRequirement: 'none',
    afterRequirement: 'none',
    initiatedByActorRef: OTHER_ACTOR_REF
  }), NOW).allowed, false)
  assert.equal(decideMemoryLifecycleActorPolicyV1(member, request(group, 'inspect_full'), NOW).allowed, false)
})

test('admin ordinary permission is upgraded when either canonical side is elevated', () => {
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const admin = actorCapability(group, 'group_admin', ['correct'])
  assert.equal(decideMemoryLifecycleActorPolicyV1(admin, request(group, 'correct'), NOW).allowed, true)
  assert.equal(decideMemoryLifecycleActorPolicyV1(admin, request(group, 'correct', {
    beforeRequirement: 'none', afterRequirement: 'none'
  }), NOW).allowed, true)
  assert.equal(decideMemoryLifecycleActorPolicyV1(admin, request(group, 'correct', {
    afterRequirement: 'elevated'
  }), NOW).allowed, false)
  assert.equal(decideMemoryLifecycleActorPolicyV1(admin, request(group, 'correct', {
    beforeRequirement: 'elevated'
  }), NOW).allowed, false)
})

test('actor policy decision fails closed for null, proxy and accessor inputs', () => {
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const member = actorCapability(group, 'group_member', ['list_safe'])
  const accessor = request(group, 'list_safe', {
    beforeRequirement: 'none',
    afterRequirement: 'none'
  })
  Object.defineProperty(accessor, 'isAdmin', { get: () => true, enumerable: true })

  for (const [capability, input, now] of [
    [null, request(group, 'list_safe', { beforeRequirement: 'none', afterRequirement: 'none' }), NOW],
    [new Proxy(member, {}), request(group, 'list_safe', { beforeRequirement: 'none', afterRequirement: 'none' }), NOW],
    [member, new Proxy(request(group, 'list_safe'), {}), NOW],
    [member, accessor, NOW],
    [member, request(group, 'list_safe'), new Proxy({}, {})]
  ] as const) {
    assert.doesNotThrow(() => decideMemoryLifecycleActorPolicyV1(capability, input, now))
    assert.equal(decideMemoryLifecycleActorPolicyV1(capability, input, now).allowed, false)
  }

  for (const initiatedByActorRef of [
    'actor:20002',
    `actor:${'G'.repeat(64)}`,
    'actor:remember this text'
  ]) {
    const decision = decideMemoryLifecycleActorPolicyV1(
      member,
      request(group, 'list_safe', {
        beforeRequirement: 'none',
        afterRequirement: 'none',
        initiatedByActorRef
      }),
      NOW
    )
    assert.deepEqual(decision, {
      allowed: false,
      projection: 'none',
      reason: 'invalid_request'
    })
  }
})

test('consent policy pairs only personal/owner and group/group', () => {
  const personal = namespace({ kind: 'personal', subjectUserId: '20002' })
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  assert.equal(memoryConsentMatchesNamespaceV1(personal, 'explicit'), true)
  assert.equal(memoryConsentMatchesNamespaceV1(personal, 'owner_policy'), true)
  assert.equal(memoryConsentMatchesNamespaceV1(personal, 'group_policy'), false)
  assert.equal(memoryConsentMatchesNamespaceV1(group, 'group_policy'), true)
  assert.equal(memoryConsentMatchesNamespaceV1(group, 'owner_policy'), false)
})

test('group source admission is exact to group lifecycle and hard-denies private content', () => {
  const group = namespace({
    kind: 'group',
    groupId: '30003',
    groupLifecycleId: 'group-30003-generation-1'
  })
  const admitted = {
    kind: 'group_rule',
    sensitivity: 'group',
    sources: [memorySourceFixture({
      sourceKind: 'group_history',
      scene: groupSceneFixture({
        groupId: '30003',
        groupLifecycleId: 'group-30003-generation-1'
      })
    })]
  }
  assert.deepEqual(evaluateGroupMemoryAdmissionV1(group, admitted), { allowed: true })
  for (const mutation of [
    { sensitivity: 'sensitive' },
    { kind: 'profile_fact' },
    { sources: [memorySourceFixture({
      sourceKind: 'private_history', scene: privateSceneFixture()
    })] },
    { sources: [memorySourceFixture({
      sourceKind: 'current_message', scene: privateSceneFixture()
    })] },
    { sources: [memorySourceFixture({
      sourceKind: 'group_history', scene: groupSceneFixture({
        groupId: '30004', groupLifecycleId: 'group-30004-generation-1'
      })
    })] },
    { sources: [memorySourceFixture({
      sourceKind: 'group_history', scene: groupSceneFixture({
        groupId: '30003', groupLifecycleId: 'group-30003-generation-0'
      })
    })] }
  ]) {
    assert.equal(evaluateGroupMemoryAdmissionV1(group, { ...admitted, ...mutation }).allowed, false)
  }

  const extra = { ...admitted, isMaster: true }
  const accessor = { ...admitted }
  Object.defineProperty(accessor, 'isAdmin', { get: () => true, enumerable: true })
  const proxiedSource = { ...admitted, sources: [new Proxy(admitted.sources[0]!, {})] }
  for (const malformed of [new Proxy(admitted, {}), extra, accessor, proxiedSource]) {
    assert.deepEqual(evaluateGroupMemoryAdmissionV1(group, malformed), {
      allowed: false,
      reason: 'invalid_admission'
    })
  }
})
