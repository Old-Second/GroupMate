import {
  parseMemoryAccessContextV1,
  type MemoryAccessContextV1
} from './memory-access-gate.js'
import {
  createMemoryNamespaceV1,
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryGroupLifecycleIdV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryCanonicalTextWithinLimits
} from './memory-resource-limits.js'
import {
  MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2,
  type MemoryRetrievalSubjectReasonV2
} from './memory-retrieval.js'

export type SceneParticipantGroupRoleV1 = 'owner' | 'admin' | 'member' | 'unknown'
export type SceneParticipantRoleEvidenceV1 =
  | 'current_event'
  | 'member_refresh'
  | 'member_cache'
  | 'unknown'

export interface SceneParticipantIdentityV1 {
  readonly schemaVersion: 1
  readonly userId: string
  readonly nickname: string | null
  readonly groupCard: string | null
  readonly groupCardSource: 'explicit' | 'nickname_fallback' | 'unknown'
  readonly groupTitle: string | null
  readonly groupRole: SceneParticipantGroupRoleV1
  readonly roleStatus: 'event' | 'verified' | 'cached' | 'unknown'
  readonly displayName: string
}

export type SceneParticipantSceneV1 =
  | Readonly<{ readonly kind: 'private' }>
  | Readonly<{
      readonly kind: 'group'
      readonly groupId: string
      readonly groupLifecycleId: string
      readonly groupName: string | null
    }>

export interface SceneParticipantMembershipV1 {
  readonly state: 'verified_present' | 'candidate' | 'absent' | 'unknown'
  readonly source: 'current_event' | 'member_refresh' | 'member_cache' | 'unavailable'
  readonly observedAt: string
  readonly validUntil: string | null
}

export interface SceneParticipantV1 {
  readonly schemaVersion: 1
  readonly identity: SceneParticipantIdentityV1
  readonly scene: SceneParticipantSceneV1
  readonly membership: SceneParticipantMembershipV1
}

export interface PersonalMemorySubjectV1 {
  readonly participant: SceneParticipantV1
  readonly reason: MemoryRetrievalSubjectReasonV2
}

export interface PersonalMemoryAccessScopeV1 {
  readonly context: MemoryAccessContextV1
  readonly namespaces: readonly MemoryNamespaceV1[]
  readonly subjects: readonly PersonalMemorySubjectV1[]
}

const GROUP_ROLES = Object.freeze([
  'owner', 'admin', 'member', 'unknown'
] as const satisfies readonly SceneParticipantGroupRoleV1[])
const ROLE_EVIDENCE = Object.freeze([
  'current_event', 'member_refresh', 'member_cache', 'unknown'
] as const satisfies readonly SceneParticipantRoleEvidenceV1[])
const GROUP_CARD_SOURCES = Object.freeze([
  'explicit', 'nickname_fallback', 'unknown'
] as const)
const ROLE_STATUSES = Object.freeze([
  'event', 'verified', 'cached', 'unknown'
] as const)
const MEMBERSHIP_STATES = Object.freeze([
  'verified_present', 'candidate', 'absent', 'unknown'
] as const)
const MEMBERSHIP_SOURCES = Object.freeze([
  'current_event', 'member_refresh', 'member_cache', 'unavailable'
] as const)
const REFERENCE_REASONS = Object.freeze([
  'quoted_actor', 'mentioned_actor', 'explicit_target'
] as const satisfies readonly Exclude<MemoryRetrievalSubjectReasonV2, 'current_actor'>[])
const IDENTITY_TEXT_UTF8_BYTES = 1_024
const IDENTITY_TEXT_CODE_POINTS = 256

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return invalidMemoryValue()
  }
  return value as T
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function plusMembershipWindow (observedAt: string): string {
  const milliseconds = Date.parse(observedAt) + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return invalidMemoryValue()
  }
}

function normalizedIdentityText (value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return invalidMemoryValue()
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) return null
  if (!memoryCanonicalTextWithinLimits(
    normalized,
    IDENTITY_TEXT_UTF8_BYTES,
    IDENTITY_TEXT_CODE_POINTS
  )) return invalidMemoryValue()
  return normalized
}

function groupCardSource (
  groupCard: string | null,
  nickname: string | null
): SceneParticipantIdentityV1['groupCardSource'] {
  if (groupCard === null) return 'unknown'
  return nickname !== null && groupCard === nickname ? 'nickname_fallback' : 'explicit'
}

function roleProjection (
  role: SceneParticipantGroupRoleV1,
  evidence: SceneParticipantRoleEvidenceV1
): Readonly<Pick<SceneParticipantIdentityV1, 'groupRole' | 'roleStatus'>> {
  if (role === 'unknown' || evidence === 'unknown') {
    return Object.freeze({ groupRole: 'unknown' as const, roleStatus: 'unknown' as const })
  }
  const roleStatus = evidence === 'current_event'
    ? 'event' as const
    : evidence === 'member_refresh'
      ? 'verified' as const
      : 'cached' as const
  return Object.freeze({ groupRole: role, roleStatus })
}

function createIdentityFields (value: unknown): SceneParticipantIdentityV1 {
  const input = inspectMemoryRecord(value, [
    'userId', 'nickname', 'groupCard', 'groupTitle', 'groupRole', 'roleEvidence'
  ])
  const userId = parseMemoryQqIdV1(input.userId)
  const nickname = normalizedIdentityText(input.nickname)
  const groupCard = normalizedIdentityText(input.groupCard)
  const groupTitle = normalizedIdentityText(input.groupTitle)
  const role = roleProjection(
    enumValue(input.groupRole, GROUP_ROLES),
    enumValue(input.roleEvidence, ROLE_EVIDENCE)
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    userId,
    nickname,
    groupCard,
    groupCardSource: groupCardSource(groupCard, nickname),
    groupTitle,
    groupRole: role.groupRole,
    roleStatus: role.roleStatus,
    displayName: groupCard ?? nickname ?? userId
  })
}

export function createSceneParticipantIdentityV1 (value: unknown): SceneParticipantIdentityV1 {
  return createIdentityFields(value)
}

export function parseSceneParticipantIdentityV1 (value: unknown): SceneParticipantIdentityV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'userId', 'nickname', 'groupCard', 'groupCardSource',
    'groupTitle', 'groupRole', 'roleStatus', 'displayName'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const userId = parseMemoryQqIdV1(input.userId)
  const nickname = normalizedIdentityText(input.nickname)
  const groupCard = normalizedIdentityText(input.groupCard)
  const groupTitle = normalizedIdentityText(input.groupTitle)
  const cardSource = enumValue(input.groupCardSource, GROUP_CARD_SOURCES)
  const groupRole = enumValue(input.groupRole, GROUP_ROLES)
  const roleStatus = enumValue(input.roleStatus, ROLE_STATUSES)
  const displayName = normalizedIdentityText(input.displayName)
  if (cardSource !== groupCardSource(groupCard, nickname) || displayName === null ||
    displayName !== (groupCard ?? nickname ?? userId) ||
    ((groupRole === 'unknown') !== (roleStatus === 'unknown'))) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    userId,
    nickname,
    groupCard,
    groupCardSource: cardSource,
    groupTitle,
    groupRole,
    roleStatus,
    displayName
  })
}

function parseScene (value: unknown): SceneParticipantSceneV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['groupId', 'groupLifecycleId', 'groupName']
  )
  if (discriminator.kind === 'private') {
    inspectMemoryRecord(value, ['kind'])
    return Object.freeze({ kind: 'private' as const })
  }
  if (discriminator.kind !== 'group') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, [
    'kind', 'groupId', 'groupLifecycleId', 'groupName'
  ])
  return Object.freeze({
    kind: 'group' as const,
    groupId: parseMemoryQqIdV1(input.groupId),
    groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId),
    groupName: normalizedIdentityText(input.groupName)
  })
}

function membershipMatrix (
  state: SceneParticipantMembershipV1['state'],
  source: SceneParticipantMembershipV1['source']
): boolean {
  if (state === 'verified_present') {
    return source === 'current_event' || source === 'member_refresh'
  }
  if (state === 'candidate') return source === 'member_cache'
  if (state === 'absent') return source === 'member_refresh'
  return source === 'unavailable'
}

function createMembershipFields (value: unknown): SceneParticipantMembershipV1 {
  const input = inspectMemoryRecord(value, ['state', 'source', 'observedAt'])
  const state = enumValue(input.state, MEMBERSHIP_STATES)
  const source = enumValue(input.source, MEMBERSHIP_SOURCES)
  if (!membershipMatrix(state, source)) return invalidMemoryValue()
  const observedAt = canonicalInstant(input.observedAt)
  return Object.freeze({
    state,
    source,
    observedAt,
    validUntil: state === 'verified_present' || state === 'absent'
      ? plusMembershipWindow(observedAt)
      : null
  })
}

function parseMembershipFields (value: unknown): SceneParticipantMembershipV1 {
  const input = inspectMemoryRecord(value, [
    'state', 'source', 'observedAt', 'validUntil'
  ])
  const state = enumValue(input.state, MEMBERSHIP_STATES)
  const source = enumValue(input.source, MEMBERSHIP_SOURCES)
  const observedAt = canonicalInstant(input.observedAt)
  const expectedValidUntil = state === 'verified_present' || state === 'absent'
    ? plusMembershipWindow(observedAt)
    : null
  if (!membershipMatrix(state, source) || input.validUntil !== expectedValidUntil) {
    return invalidMemoryValue()
  }
  return Object.freeze({ state, source, observedAt, validUntil: expectedValidUntil })
}

function assertSceneIdentityMatrix (
  scene: SceneParticipantSceneV1,
  identity: SceneParticipantIdentityV1,
  membership: SceneParticipantMembershipV1
): void {
  if (scene.kind === 'private' && (
    identity.groupCard !== null || identity.groupTitle !== null ||
    identity.groupRole !== 'unknown' || identity.roleStatus !== 'unknown' ||
    identity.groupCardSource !== 'unknown' ||
    membership.state !== 'verified_present' || membership.source !== 'current_event'
  )) return invalidMemoryValue()
}

export function createSceneParticipantV1 (value: unknown): SceneParticipantV1 {
  const input = inspectMemoryRecord(value, ['identity', 'scene', 'membership'])
  const identity = createIdentityFields(input.identity)
  const scene = parseScene(input.scene)
  const membership = createMembershipFields(input.membership)
  assertSceneIdentityMatrix(scene, identity, membership)
  return Object.freeze({ schemaVersion: 1 as const, identity, scene, membership })
}

export function parseSceneParticipantV1 (value: unknown): SceneParticipantV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'identity', 'scene', 'membership'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const identity = parseSceneParticipantIdentityV1(input.identity)
  const scene = parseScene(input.scene)
  const membership = parseMembershipFields(input.membership)
  assertSceneIdentityMatrix(scene, identity, membership)
  return Object.freeze({ schemaVersion: 1 as const, identity, scene, membership })
}

export function sceneParticipantCanAuthorizeMemoryV1 (
  value: unknown,
  nowValue: unknown
): boolean {
  try {
    const participant = parseSceneParticipantV1(value)
    const now = Date.parse(canonicalInstant(nowValue))
    const validUntil = participant.membership.validUntil
    return participant.membership.state === 'verified_present' &&
      (participant.membership.source === 'current_event' ||
        participant.membership.source === 'member_refresh') &&
      validUntil !== null &&
      now >= Date.parse(participant.membership.observedAt) &&
      now <= Date.parse(validUntil)
  } catch {
    return false
  }
}

function sameScene (
  left: SceneParticipantSceneV1,
  right: SceneParticipantSceneV1
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'private' || right.kind === 'private') return true
  return left.groupId === right.groupId &&
    left.groupLifecycleId === right.groupLifecycleId
}

function parseReference (value: unknown): {
  readonly reason: Exclude<MemoryRetrievalSubjectReasonV2, 'current_actor'>
  readonly participant: SceneParticipantV1
} {
  const input = inspectMemoryRecord(value, ['reason', 'participant'])
  return Object.freeze({
    reason: enumValue(input.reason, REFERENCE_REASONS),
    participant: parseSceneParticipantV1(input.participant)
  })
}

const REASON_PRIORITY = Object.freeze({
  quoted_actor: 0,
  mentioned_actor: 1,
  explicit_target: 2
} as const)

export function selectPersonalMemorySubjectsV1 (value: unknown): readonly PersonalMemorySubjectV1[] {
  const input = inspectMemoryRecord(value, ['scene', 'current', 'references', 'now'])
  const scene = parseScene(input.scene)
  const current = parseSceneParticipantV1(input.current)
  const now = canonicalInstant(input.now)
  const references = inspectMemoryArray(input.references, 16).map(parseReference)
  if (!sameScene(scene, current.scene) ||
    !sceneParticipantCanAuthorizeMemoryV1(current, now)) return invalidMemoryValue()
  const selected: PersonalMemorySubjectV1[] = [Object.freeze({
    participant: current,
    reason: 'current_actor' as const
  })]
  if (scene.kind === 'private') return Object.freeze(selected)

  const currentUserId = current.identity.userId
  const candidates = references
    .map((reference, index) => Object.freeze({ ...reference, index }))
    .filter(reference => (
      reference.participant.identity.userId !== currentUserId &&
      sameScene(scene, reference.participant.scene) &&
      sceneParticipantCanAuthorizeMemoryV1(reference.participant, now)
    ))
    .sort((left, right) => (
      REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason] ||
      left.index - right.index
    ))
  const seen = new Set([currentUserId])
  for (const candidate of candidates) {
    if (selected.length === MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects) break
    if (seen.has(candidate.participant.identity.userId)) continue
    seen.add(candidate.participant.identity.userId)
    selected.push(Object.freeze({
      participant: candidate.participant,
      reason: candidate.reason
    }))
  }
  return Object.freeze(selected)
}

function parseSelectedSubject (value: unknown): PersonalMemorySubjectV1 {
  const input = inspectMemoryRecord(value, ['participant', 'reason'])
  const reason = enumValue(input.reason, [
    'current_actor', ...REFERENCE_REASONS
  ] as const)
  return Object.freeze({
    participant: parseSceneParticipantV1(input.participant),
    reason
  })
}

export function buildPersonalMemoryAccessScopeV1 (value: unknown): PersonalMemoryAccessScopeV1 {
  const input = inspectMemoryRecord(value, [
    'botInstanceId', 'accountId', 'scene', 'subjects', 'now'
  ])
  const scene = parseScene(input.scene)
  const now = canonicalInstant(input.now)
  const subjects = inspectMemoryArray(
    input.subjects,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects
  ).map(parseSelectedSubject)
  if (subjects.length === 0 || subjects[0]?.reason !== 'current_actor' ||
    new Set(subjects.map(subject => subject.participant.identity.userId)).size !== subjects.length ||
    subjects.some(subject => !sameScene(scene, subject.participant.scene) ||
      !sceneParticipantCanAuthorizeMemoryV1(subject.participant, now))) {
    return invalidMemoryValue()
  }
  if (scene.kind === 'private' && subjects.length !== 1) return invalidMemoryValue()

  const namespaces = Object.freeze(subjects.map(subject => createMemoryNamespaceV1({
    botInstanceId: input.botInstanceId,
    adapter: 'qq',
    accountId: input.accountId,
    scope: {
      kind: 'personal',
      subjectUserId: subject.participant.identity.userId
    }
  })))
  const context = parseMemoryAccessContextV1({
    schemaVersion: 1,
    botInstanceId: namespaces[0]?.botInstanceId,
    adapter: 'qq',
    accountId: namespaces[0]?.accountId,
    scene: scene.kind === 'private'
      ? {
          kind: 'private',
          peerUserId: subjects[0]?.participant.identity.userId
        }
      : {
          kind: 'group',
          groupId: scene.groupId,
          groupLifecycleId: scene.groupLifecycleId,
          trustedMemberUserIds: subjects.map(subject => subject.participant.identity.userId),
          observedAt: subjects.reduce((oldest, subject) => (
            Date.parse(subject.participant.membership.observedAt) < Date.parse(oldest)
              ? subject.participant.membership.observedAt
              : oldest
          ), now)
        }
  })
  return Object.freeze({
    context,
    namespaces,
    subjects: Object.freeze(subjects)
  })
}
