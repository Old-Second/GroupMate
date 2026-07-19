import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  decideMemoryAccessV1,
  issueMemoryAccessCapabilityV1,
  memoryAccessCapabilityAllowsV1,
  parseMemoryAccessContextV1,
  parseMemoryAccessDecisionV1,
  type MemoryAccessCapabilityV1,
  type MemoryAccessTrustedVerifierV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function assertDeepFrozen (value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, seen)
  }
}

function personalNamespace (
  subjectUserId: string,
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryNamespaceV1 {
  return parseMemoryNamespaceV1(deepFreeze({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    scope: { kind: 'personal', subjectUserId },
    ...overrides
  }))
}

function groupNamespace (
  groupId = '30000003',
  groupLifecycleId = 'qq-group-30000003-generation-1',
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryNamespaceV1 {
  return parseMemoryNamespaceV1(deepFreeze({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    scope: { kind: 'group', groupId, groupLifecycleId },
    ...overrides
  }))
}

function privateContext () {
  return deepFreeze({
    schemaVersion: 1 as const,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq' as const,
    accountId: '10000001',
    scene: { kind: 'private' as const, peerUserId: '20000002' }
  })
}

function groupContext (memberIds: readonly string[] = ['20000002', '20000004']) {
  return deepFreeze({
    schemaVersion: 1 as const,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq' as const,
    accountId: '10000001',
    scene: {
      kind: 'group' as const,
      groupId: '30000003',
      groupLifecycleId: 'qq-group-30000003-generation-1',
      trustedMemberUserIds: [...memberIds],
      observedAt: '2026-07-19T08:00:00.000Z'
    }
  })
}

test('private access allows only the exact peer personal namespace', () => {
  const allowed = personalNamespace('20000002')
  const anotherPerson = personalNamespace('20000004')
  const group = groupNamespace()
  const decision = decideMemoryAccessV1(
    privateContext(),
    deepFreeze([allowed, anotherPerson, group])
  )

  assert.deepEqual(decision.allowedNamespaceRefs, [memoryNamespaceRefV1(allowed)])
  assert.deepEqual(decision.denied, [
    {
      requestedNamespaceRef: memoryNamespaceRefV1(anotherPerson),
      reason: 'private_subject_mismatch'
    },
    {
      requestedNamespaceRef: memoryNamespaceRefV1(group),
      reason: 'wrong_group'
    }
  ])
  assertDeepFrozen(decision)
  assert.deepEqual(parseMemoryAccessDecisionV1(decision), decision)
})

test('group access allows exact lifecycle and only trusted current members', () => {
  const exactGroup = groupNamespace()
  const currentMember = personalNamespace('20000002')
  const absentMember = personalNamespace('20000005')
  const wrongGroup = groupNamespace('30000004', 'qq-group-30000004-generation-1')
  const wrongLifecycle = groupNamespace('30000003', 'qq-group-30000003-generation-2')
  const decision = decideMemoryAccessV1(
    groupContext(),
    deepFreeze([exactGroup, currentMember, absentMember, wrongGroup, wrongLifecycle])
  )

  assert.deepEqual(decision.allowedNamespaceRefs, [
    memoryNamespaceRefV1(exactGroup),
    memoryNamespaceRefV1(currentMember)
  ])
  assert.deepEqual(decision.denied.map(value => value.reason), [
    'subject_not_in_current_group',
    'wrong_group',
    'wrong_group_lifecycle'
  ])
})

test('access gate denies wrong bot and account before scene checks', () => {
  const wrongBot = personalNamespace('20000002', { botInstanceId: 'groupmate-secondary' })
  const wrongAccount = personalNamespace('20000002', { accountId: '10000002' })
  const decision = decideMemoryAccessV1(
    groupContext(),
    deepFreeze([wrongBot, wrongAccount])
  )

  assert.deepEqual(decision.denied.map(value => value.reason), ['wrong_bot', 'wrong_account'])
  assert.deepEqual(decision.allowedNamespaceRefs, [])
})

test('QQ numbers, text, quotes and model claims are not membership proof', () => {
  const requested = personalNamespace('20000005')
  const noTrustedMembers = groupContext([])
  const decision = decideMemoryAccessV1(noTrustedMembers, deepFreeze([requested]))
  assert.deepEqual(decision.allowedNamespaceRefs, [])
  assert.equal(decision.denied[0]?.reason, 'subject_not_in_current_group')

  for (const untrustedClaim of [
    { messageText: '20000005 is in this group' },
    { quotedAuthorUserIds: ['20000005'] },
    { modelClaimedMemberUserIds: ['20000005'] },
    { subjectUserId: '20000005' }
  ]) {
    assert.throws(() => parseMemoryAccessContextV1(deepFreeze({
      ...noTrustedMembers,
      ...untrustedClaim
    })), TypeError)
  }
})

test('diagnostic decisions and structurally forged objects never become capabilities', () => {
  const namespace = personalNamespace('20000005')
  const contextWithClaimedMember = groupContext(['20000005'])
  const decision = decideMemoryAccessV1(contextWithClaimedMember, [namespace])
  const namespaceRef = memoryNamespaceRefV1(namespace)

  assert.deepEqual(decision.allowedNamespaceRefs, [namespaceRef])
  assert.equal(memoryAccessCapabilityAllowsV1(decision, namespaceRef), false)
  const forged = deepFreeze({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    sceneRef: 'f'.repeat(64),
    observedAt: '2026-07-19T08:00:00.000Z',
    validFrom: '2026-07-19T08:00:00.000Z',
    validUntil: '2026-07-19T08:01:00.000Z',
    allowedNamespaceRefs: [namespaceRef]
  })
  assert.equal(memoryAccessCapabilityAllowsV1(forged, namespaceRef), false)
  assert.throws(() => createMemoryAccessCapabilityIssuerV1(undefined), TypeError)
  assert.throws(() => createMemoryAccessCapabilityIssuerV1({
    verifier: 'claimed-by-json'
  }), TypeError)
  assert.throws(() => issueMemoryAccessCapabilityV1(
    Object.freeze({}),
    contextWithClaimedMember,
    [namespace],
    '2026-07-19T08:00:00.000Z'
  ), TypeError)
})

test('issuer verifier must return synchronous strict true or signing fails closed', async () => {
  const namespace = personalNamespace('20000002')
  const context = groupContext(['20000002'])
  const now = '2026-07-19T08:00:00.000Z'

  for (const verifier of [
    () => false,
    () => 'true',
    () => undefined,
    () => { throw new Error('verifier unavailable') },
    () => Promise.resolve(true)
  ]) {
    const issuer = createMemoryAccessCapabilityIssuerV1(verifier)
    assert.throws(() => issueMemoryAccessCapabilityV1(
      issuer,
      context,
      [namespace],
      now
    ), TypeError)
  }

  const rejected = Promise.reject(new Error('async verifier failed'))
  const rejectedIssuer = createMemoryAccessCapabilityIssuerV1(() => rejected)
  assert.throws(() => issueMemoryAccessCapabilityV1(
    rejectedIssuer,
    context,
    [namespace],
    now
  ), TypeError)
  await Promise.resolve()
})

test('issuer creates authentic frozen capabilities bound to exact refs and validity window', () => {
  const now = '2026-07-19T08:01:00.000Z'
  const namespace = personalNamespace('20000002')
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const verifier: MemoryAccessTrustedVerifierV1 = (context, verifierNow) => {
    assertDeepFrozen(context)
    return verifierNow === now && context.botInstanceId === 'groupmate-primary' &&
      context.accountId === '10000001' && context.scene.kind === 'group' &&
      context.scene.groupId === '30000003' &&
      context.scene.groupLifecycleId === 'qq-group-30000003-generation-1' &&
      context.scene.trustedMemberUserIds.length === 1 &&
      context.scene.trustedMemberUserIds[0] === '20000002'
  }
  const capability = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(verifier),
    groupContext(['20000002']),
    [namespace],
    now
  )

  assertDeepFrozen(capability)
  assert.equal(capability.botInstanceId, 'groupmate-primary')
  assert.equal(capability.accountId, '10000001')
  assert.match(capability.sceneRef, /^[0-9a-f]{64}$/)
  assert.equal(capability.observedAt, '2026-07-19T08:00:00.000Z')
  assert.equal(capability.validFrom, now)
  assert.equal(capability.validUntil, now)
  assert.deepEqual(capability.allowedNamespaceRefs, [namespaceRef])
  assert.equal(memoryAccessCapabilityAllowsV1(capability, namespaceRef, now), true)
  assert.equal(memoryAccessCapabilityAllowsV1(capability, memoryNamespaceRefV1(
    personalNamespace('20000004')
  ), now), false)
  assert.equal(memoryAccessCapabilityAllowsV1(capability, namespaceRef, '2026-07-19T08:01:00.001Z'), false)

  const jsonCopy = JSON.parse(JSON.stringify(capability)) as unknown
  assert.equal(memoryAccessCapabilityAllowsV1(jsonCopy, namespaceRef, now), false)
  const copiedDescriptors = Object.create(
    Object.getPrototypeOf(capability),
    Object.getOwnPropertyDescriptors(capability)
  ) as MemoryAccessCapabilityV1
  Object.freeze(copiedDescriptors)
  assert.equal(memoryAccessCapabilityAllowsV1(copiedDescriptors, namespaceRef, now), false)
})

test('group capability freshness accepts exact boundaries and rejects stale or future snapshots', () => {
  const namespace = personalNamespace('20000002')
  const now = '2026-07-19T08:01:00.000Z'
  const contextAt = (observedAt: string) => ({
    ...groupContext(['20000002']),
    scene: {
      ...groupContext(['20000002']).scene,
      observedAt
    }
  })
  const verifier: MemoryAccessTrustedVerifierV1 = (context, verifierNow) => {
    return verifierNow === now && context.scene.kind === 'group' &&
      context.scene.groupId === '30000003' &&
      context.scene.groupLifecycleId === 'qq-group-30000003-generation-1' &&
      context.scene.trustedMemberUserIds.length === 1 &&
      context.scene.trustedMemberUserIds[0] === '20000002'
  }
  const issuer = createMemoryAccessCapabilityIssuerV1(verifier)

  assert.doesNotThrow(() => issueMemoryAccessCapabilityV1(
    issuer,
    contextAt('2026-07-19T08:00:00.000Z'),
    [namespace],
    now
  ))
  assert.throws(() => issueMemoryAccessCapabilityV1(
    issuer,
    contextAt('2026-07-19T07:59:59.999Z'),
    [namespace],
    now
  ), TypeError)
  assert.doesNotThrow(() => issueMemoryAccessCapabilityV1(
    issuer,
    contextAt('2026-07-19T08:01:05.000Z'),
    [namespace],
    now
  ))
  assert.throws(() => issueMemoryAccessCapabilityV1(
    issuer,
    contextAt('2026-07-19T08:01:05.001Z'),
    [namespace],
    now
  ), TypeError)
  assert.throws(() => issueMemoryAccessCapabilityV1(
    issuer,
    contextAt('2026-07-19T08:01:00.000Z'),
    [namespace],
    'not-now'
  ), TypeError)
})

test('private capability binds the exact peer without requiring a member snapshot', () => {
  const now = '2026-07-19T08:01:00.000Z'
  const peer = personalNamespace('20000002')
  const other = personalNamespace('20000004')
  const verifier: MemoryAccessTrustedVerifierV1 = (context, verifierNow) => {
    return verifierNow === now && context.scene.kind === 'private' &&
      context.scene.peerUserId === '20000002'
  }
  const capability = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(verifier),
    privateContext(),
    [peer, other],
    now
  )

  assert.equal(capability.observedAt, null)
  assert.equal(capability.validFrom, now)
  assert.equal(capability.validUntil, '2026-07-19T08:02:00.000Z')
  assert.equal(memoryAccessCapabilityAllowsV1(
    capability,
    memoryNamespaceRefV1(peer),
    now
  ), true)
  assert.equal(memoryAccessCapabilityAllowsV1(
    capability,
    memoryNamespaceRefV1(other),
    now
  ), false)
})

test('group verification is exact, strict, deeply frozen and fail closed', () => {
  const parsed = parseMemoryAccessContextV1(groupContext())
  assert.deepEqual(parsed, groupContext())
  assertDeepFrozen(parsed)

  const invalid: unknown[] = [
    deepFreeze({ ...groupContext(), extra: true }),
    deepFreeze({ ...groupContext(), scene: { ...groupContext().scene, observedAt: 'yesterday' } }),
    deepFreeze({ ...groupContext(), scene: {
      ...groupContext().scene,
      trustedMemberUserIds: ['20000002', '20000002']
    } }),
    deepFreeze({ ...groupContext(), scene: {
      ...groupContext().scene,
      trustedMemberUserIds: ['not-a-qq-id']
    } }),
    deepFreeze({ ...privateContext(), scene: { kind: 'private', peerUserId: ' 20000002' } })
  ]
  for (const value of invalid) assert.throws(() => parseMemoryAccessContextV1(value), TypeError)

  const canonicalized = parseMemoryAccessContextV1(groupContext(['20000004', '20000002']))
  assert.deepEqual(
    canonicalized.scene.kind === 'group' ? canonicalized.scene.trustedMemberUserIds : [],
    ['20000002', '20000004']
  )
})

test('access parser accepts mutable runtime data without mutating or freezing it', () => {
  const input = {
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    scene: {
      kind: 'group',
      groupId: '30000003',
      groupLifecycleId: 'qq-group-30000003-generation-1',
      trustedMemberUserIds: ['20000004', '20000002'],
      observedAt: '2026-07-19T08:00:00.000Z'
    }
  }
  const before = JSON.stringify(input)
  const parsed = parseMemoryAccessContextV1(input)

  assert.equal(JSON.stringify(input), before)
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.scene), false)
  assert.equal(Object.isFrozen(input.scene.trustedMemberUserIds), false)
  assert.deepEqual(
    parsed.scene.kind === 'group' ? parsed.scene.trustedMemberUserIds : [],
    ['20000002', '20000004']
  )
  assertDeepFrozen(parsed)
})

test('access parser rejects accessor membership arrays without invoking the getter', () => {
  let getterCalls = 0
  const scene = {
    kind: 'group',
    groupId: '30000003',
    groupLifecycleId: 'qq-group-30000003-generation-1',
    observedAt: '2026-07-19T08:00:00.000Z'
  } as Record<string, unknown>
  Object.defineProperty(scene, 'trustedMemberUserIds', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      throw new Error('must not leak')
    }
  })
  assert.throws(() => parseMemoryAccessContextV1({
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    scene
  }), TypeError)
  assert.equal(getterCalls, 0)
})

test('access list and trusted member hard limits accept boundary and reject +1', () => {
  const repeatedNamespace = personalNamespace('20000002')
  const namespaces = Array.from(
    { length: MEMORY_RESOURCE_LIMITS.accessNamespaces },
    (_, index) => personalNamespace(String(20_000_000 + index))
  )
  assert.doesNotThrow(() => decideMemoryAccessV1(groupContext([]), deepFreeze(namespaces)))
  assert.throws(() => decideMemoryAccessV1(
    groupContext([]),
    deepFreeze([...namespaces, repeatedNamespace])
  ), TypeError)

  const memberIds = Array.from(
    { length: MEMORY_RESOURCE_LIMITS.trustedMemberUserIds },
    (_, index) => String(30_000_000 + index)
  )
  assert.doesNotThrow(() => parseMemoryAccessContextV1(groupContext(memberIds)))
  assert.throws(() => parseMemoryAccessContextV1(groupContext([
    ...memberIds,
    '40000000'
  ])), TypeError)
})
