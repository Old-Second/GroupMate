import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1,
  memoryAccessCapabilityAllowsV1
} from '../../src/agent/memory/memory-access-gate.js'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import {
  buildPersonalMemoryAccessScopeV1,
  createSceneParticipantIdentityV1,
  createSceneParticipantV1,
  parseSceneParticipantIdentityV1,
  parseSceneParticipantV1,
  sceneParticipantCanAuthorizeMemoryV1,
  selectPersonalMemorySubjectsV1
} from '../../src/agent/memory/scene-participant.js'

const NOW = '2026-07-25T01:00:00.000Z'
const BOT_ID = 'groupmate-test'
const ACCOUNT_ID = '10000'
const GROUP_ID = '20000'
const GROUP_LIFECYCLE_ID = 'group-generation-1'

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function groupScene (groupId = GROUP_ID, lifecycle = GROUP_LIFECYCLE_ID) {
  return deepFreeze({
    kind: 'group' as const,
    groupId,
    groupLifecycleId: lifecycle,
    groupName: '记忆测试群'
  })
}

function groupParticipant (
  userId: string,
  options: {
    readonly observedAt?: string
    readonly source?: 'current_event' | 'member_refresh' | 'member_cache'
    readonly scene?: ReturnType<typeof groupScene>
    readonly card?: string | null
    readonly nickname?: string | null
    readonly role?: 'owner' | 'admin' | 'member' | 'unknown'
  } = {}
) {
  const source = options.source ?? 'member_refresh'
  return createSceneParticipantV1({
    identity: {
      userId,
      nickname: options.nickname ?? `QQ-${userId}`,
      groupCard: options.card ?? `群-${userId}`,
      groupTitle: '活跃成员',
      groupRole: options.role ?? 'member',
      roleEvidence: source
    },
    scene: options.scene ?? groupScene(),
    membership: {
      state: source === 'member_cache' ? 'candidate' : 'verified_present',
      source,
      observedAt: options.observedAt ?? NOW
    }
  })
}

test('scene identity preserves all QQ aliases and blank card falls back to nickname', () => {
  const identity = createSceneParticipantIdentityV1({
    userId: '70001',
    nickname: '  QQ 昵称  ',
    groupCard: '   ',
    groupTitle: '  群称号  ',
    groupRole: 'admin',
    roleEvidence: 'current_event'
  })
  assert.deepEqual(identity, {
    schemaVersion: 1,
    userId: '70001',
    nickname: 'QQ 昵称',
    groupCard: null,
    groupCardSource: 'unknown',
    groupTitle: '群称号',
    groupRole: 'admin',
    roleStatus: 'event',
    displayName: 'QQ 昵称'
  })
  assert.deepEqual(parseSceneParticipantIdentityV1(identity), identity)
  assert.equal(Object.isFrozen(identity), true)

  const fallback = createSceneParticipantIdentityV1({
    userId: '70001',
    nickname: '同名',
    groupCard: '同名',
    groupTitle: null,
    groupRole: 'member',
    roleEvidence: 'member_refresh'
  })
  assert.equal(fallback.groupCardSource, 'nickname_fallback')
  assert.equal(fallback.roleStatus, 'verified')

  const unknown = createSceneParticipantIdentityV1({
    userId: '70001',
    nickname: null,
    groupCard: null,
    groupTitle: null,
    groupRole: 'owner',
    roleEvidence: 'unknown'
  })
  assert.equal(unknown.groupRole, 'unknown')
  assert.equal(unknown.roleStatus, 'unknown')
  assert.equal(unknown.displayName, '70001')
})

test('participant proof distinguishes current event, refreshed member and untrusted cache', () => {
  const current = groupParticipant('70001', { source: 'current_event' })
  const refreshed = groupParticipant('70002', { source: 'member_refresh' })
  const cached = groupParticipant('70003', { source: 'member_cache' })

  assert.equal(sceneParticipantCanAuthorizeMemoryV1(current, NOW), true)
  assert.equal(sceneParticipantCanAuthorizeMemoryV1(refreshed, NOW), true)
  assert.equal(sceneParticipantCanAuthorizeMemoryV1(cached, NOW), false)
  assert.equal(sceneParticipantCanAuthorizeMemoryV1(
    refreshed,
    '2026-07-25T01:01:00.000Z'
  ), true)
  assert.equal(sceneParticipantCanAuthorizeMemoryV1(
    refreshed,
    '2026-07-25T01:01:00.001Z'
  ), false)
  assert.deepEqual(parseSceneParticipantV1(current), current)
})

test('personal subject selection is stable, deduplicated and excludes stale or wrong-scene users', () => {
  const current = groupParticipant('70001', { source: 'current_event' })
  const quoted = groupParticipant('70002')
  const mentioned = groupParticipant('70003')
  const explicit = groupParticipant('70004')
  const fifth = groupParticipant('70005')
  const stale = groupParticipant('70006', {
    observedAt: '2026-07-25T00:58:59.999Z'
  })
  const cached = groupParticipant('70007', { source: 'member_cache' })
  const otherGroup = groupParticipant('70008', { scene: groupScene('20001') })

  const selected = selectPersonalMemorySubjectsV1({
    scene: groupScene(),
    current,
    references: [
      { reason: 'mentioned_actor', participant: mentioned },
      { reason: 'quoted_actor', participant: quoted },
      { reason: 'explicit_target', participant: explicit },
      { reason: 'mentioned_actor', participant: quoted },
      { reason: 'explicit_target', participant: fifth },
      { reason: 'mentioned_actor', participant: stale },
      { reason: 'mentioned_actor', participant: cached },
      { reason: 'mentioned_actor', participant: otherGroup }
    ],
    now: NOW
  })

  assert.deepEqual(selected.map(value => [value.participant.identity.userId, value.reason]), [
    ['70001', 'current_actor'],
    ['70002', 'quoted_actor'],
    ['70003', 'mentioned_actor'],
    ['70004', 'explicit_target']
  ])
  assert.equal(Object.isFrozen(selected), true)
})

test('private selection never admits another user even with a valid-looking proof', () => {
  const privateActor = createSceneParticipantV1({
    identity: {
      userId: '70001',
      nickname: '私聊用户',
      groupCard: null,
      groupTitle: null,
      groupRole: 'unknown',
      roleEvidence: 'unknown'
    },
    scene: { kind: 'private' },
    membership: {
      state: 'verified_present',
      source: 'current_event',
      observedAt: NOW
    }
  })
  const selected = selectPersonalMemorySubjectsV1({
    scene: { kind: 'private' },
    current: privateActor,
    references: [{ reason: 'quoted_actor', participant: groupParticipant('70002') }],
    now: NOW
  })
  assert.deepEqual(selected.map(value => value.participant.identity.userId), ['70001'])
})

test('selected participants build exact personal namespaces and a fresh access context', () => {
  const selected = selectPersonalMemorySubjectsV1({
    scene: groupScene(),
    current: groupParticipant('70001', { source: 'current_event' }),
    references: [{ reason: 'quoted_actor', participant: groupParticipant('70002') }],
    now: NOW
  })
  const scope = buildPersonalMemoryAccessScopeV1({
    botInstanceId: BOT_ID,
    accountId: ACCOUNT_ID,
    scene: groupScene(),
    subjects: selected,
    now: NOW
  })
  assert.deepEqual(scope.context.scene, {
    kind: 'group',
    groupId: GROUP_ID,
    groupLifecycleId: GROUP_LIFECYCLE_ID,
    trustedMemberUserIds: ['70001', '70002'],
    observedAt: NOW
  })
  assert.deepEqual(scope.namespaces.map(value => value.scope), [
    { kind: 'personal', subjectUserId: '70001' },
    { kind: 'personal', subjectUserId: '70002' }
  ])

  const issuer = createMemoryAccessCapabilityIssuerV1(() => true)
  const capability = issueMemoryAccessCapabilityV1(
    issuer,
    scope.context,
    scope.namespaces,
    NOW
  )
  assert.equal(scope.namespaces.every(value => memoryAccessCapabilityAllowsV1(
    capability,
    memoryNamespaceRefV1(value),
    NOW
  )), true)
})

test('scene participant parsers reject hostile objects without invoking traps', () => {
  let traps = 0
  const valid = groupParticipant('70001')
  const hostile = new Proxy(valid, {
    get: () => { traps += 1; throw new Error('identity secret') },
    ownKeys: () => { traps += 1; throw new Error('identity secret') }
  })
  assert.throws(() => parseSceneParticipantV1(hostile), TypeError)
  assert.equal(traps, 0)

  assert.throws(() => parseSceneParticipantIdentityV1(deepFreeze({
    ...valid.identity,
    displayName: '伪造显示名'
  })), TypeError)
})
