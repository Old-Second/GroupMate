import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  createMemoryOutboxEventV1,
  createMemoryProposalV1,
  createMemoryRecordV1,
  createMemoryRevisionV1,
  createMemorySourceV1,
  createMemoryTombstoneV1,
  createQqIdentitySnapshotV1,
  parseMemoryOutboxEventV1,
  parseMemoryProposalV1,
  parseMemoryRecordV1,
  parseMemoryRevisionV1,
  parseMemorySourceV1,
  parseMemoryTombstoneV1,
  parseQqIdentitySnapshotV1,
  parseQqSceneSnapshotV1,
  type MemoryOutboxEventV1,
  type MemoryProposalV1,
  type MemoryRecordV1,
  type MemoryRevisionV1,
  type MemorySourceV1,
  type MemoryTombstoneV1,
  type QqIdentitySnapshotV1,
  type QqSceneSnapshotV1
} from '../../src/agent/memory/memory-domain.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  groupSceneFixture,
  memoryOutboxEventFixture,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memorySourceFixture,
  memoryTombstoneFixture,
  omitFixtureKeys,
  privateSceneFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

type HasNoOpenIndex<T> = string extends keyof T
  ? false
  : symbol extends keyof T
    ? false
    : true
type AssertTrue<T extends true> = T
type ExactMemoryRootTypes = [
  AssertTrue<HasNoOpenIndex<QqIdentitySnapshotV1>>,
  AssertTrue<HasNoOpenIndex<QqSceneSnapshotV1>>,
  AssertTrue<HasNoOpenIndex<MemorySourceV1>>,
  AssertTrue<HasNoOpenIndex<MemoryProposalV1>>,
  AssertTrue<HasNoOpenIndex<MemoryRecordV1>>,
  AssertTrue<HasNoOpenIndex<MemoryRevisionV1>>,
  AssertTrue<HasNoOpenIndex<MemoryTombstoneV1>>,
  AssertTrue<HasNoOpenIndex<MemoryOutboxEventV1>>
]
const exactMemoryRootTypes: ExactMemoryRootTypes = [
  true, true, true, true, true, true, true, true
]

function mutableCopy<T> (value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertDeepFrozen (value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, seen)
    }
  }
}

function privateIdentityFixture (): QqIdentitySnapshotV1 {
  return qqIdentityFixture({
    groupCard: null,
    groupTitle: null,
    groupRole: 'unknown',
    displayName: '爱丽丝'
  })
}

function decisionFixture (): Readonly<Record<string, unknown>> {
  return deepFreezeFixture({
    decidedAt: FIXTURE_TIMES.confirmedAt,
    decidedByActorRef: FIXTURE_IDS.actorRef,
    reason: null
  })
}

test('memory provenance identity derives a trimmed display name with blank card fallback', () => {
  const input = {
    userId: FIXTURE_IDS.subjectUserId,
    nickname: '  爱丽丝  ',
    groupCard: '   ',
    groupTitle: null,
    groupRole: 'member' as const
  }
  const created = createQqIdentitySnapshotV1(input)
  assert.deepEqual(created, {
    ...input,
    displayName: '爱丽丝'
  })
  assert.equal(Object.isFrozen(input), false)
  assertDeepFrozen(created)

  assert.equal(createQqIdentitySnapshotV1({
    ...input,
    nickname: null,
    groupCard: ''
  }).displayName, FIXTURE_IDS.subjectUserId)
  assert.equal(createQqIdentitySnapshotV1({
    ...input,
    groupCard: '  群友甲  '
  }).displayName, '群友甲')
  assert.equal(createQqIdentitySnapshotV1({
    ...input,
    nickname: '爱丽丝',
    groupCard: '\u200b\u2060'
  }).displayName, '爱丽丝')
  assert.equal(createQqIdentitySnapshotV1({
    ...input,
    nickname: '\u2060',
    groupCard: '\u0000\u200b'
  }).displayName, FIXTURE_IDS.subjectUserId)

  assert.deepEqual(parseQqIdentitySnapshotV1(mutableCopy(qqIdentityFixture())), qqIdentityFixture())
  assert.throws(() => parseQqIdentitySnapshotV1({
    ...mutableCopy(qqIdentityFixture()), displayName: '伪造昵称'
  }), TypeError)
})

test('memory provenance scene and identity combinations are exact', () => {
  assert.deepEqual(parseQqSceneSnapshotV1(mutableCopy(groupSceneFixture())), groupSceneFixture())
  assert.deepEqual(parseQqSceneSnapshotV1(mutableCopy(privateSceneFixture())), privateSceneFixture())

  for (const invalid of [
    { ...mutableCopy(privateSceneFixture()), groupId: FIXTURE_IDS.groupId },
    { ...mutableCopy(privateSceneFixture()), groupLifecycleId: FIXTURE_IDS.groupLifecycleId },
    { ...mutableCopy(groupSceneFixture()), groupLifecycleId: null },
    { ...mutableCopy(groupSceneFixture()), kind: 'channel' },
    { ...mutableCopy(groupSceneFixture()), extra: true }
  ]) assert.throws(() => parseQqSceneSnapshotV1(invalid), TypeError)

  assert.throws(() => parseMemorySourceV1(memorySourceFixture({
    actor: qqIdentityFixture({
      groupCard: '不应存在', groupTitle: null,
      groupRole: 'unknown', displayName: '不应存在'
    }),
    scene: privateSceneFixture()
  })), TypeError)
  assert.throws(() => parseMemorySourceV1(memorySourceFixture({
    actor: qqIdentityFixture({
      groupCard: null, groupTitle: null,
      groupRole: 'member', displayName: '爱丽丝'
    }),
    scene: privateSceneFixture()
  })), TypeError)
})

test('memory source create normalizes line endings and NFC before deriving hashes', () => {
  const canonical = memorySourceFixture({
    normalizedText: 'Café\n周末'
  })
  const draft = mutableCopy(omitFixtureKeys(canonical, [
    'schemaVersion', 'sourceId', 'contentHash'
  ])) as Record<string, unknown>
  draft.normalizedText = 'Café\r\n周末'

  assert.deepEqual(createMemorySourceV1(draft), canonical)
  assert.equal(Object.isFrozen(draft), false)
  assertDeepFrozen(createMemorySourceV1(draft))
  assert.throws(() => parseMemorySourceV1({
    ...mutableCopy(canonical), normalizedText: 'Café\r\n周末'
  }), TypeError)
  assert.throws(() => parseMemorySourceV1({
    ...mutableCopy(canonical), contentHash: 'f'.repeat(64)
  }), TypeError)
  assert.throws(() => parseMemorySourceV1({
    ...mutableCopy(canonical), sourceId: 'f'.repeat(64)
  }), TypeError)
})

test('memory source matrix binds source kind to scene and message identity', () => {
  const privateActor = privateIdentityFixture()
  const accepted = [
    memorySourceFixture(),
    memorySourceFixture({ sourceKind: 'quoted_message', messageId: FIXTURE_IDS.quotedMessageId }),
    memorySourceFixture({ sourceKind: 'group_history' }),
    memorySourceFixture({
      sourceKind: 'current_message', actor: privateActor, scene: privateSceneFixture()
    }),
    memorySourceFixture({
      sourceKind: 'private_history', actor: privateActor, scene: privateSceneFixture()
    }),
    memorySourceFixture({ sourceKind: 'manual_user_input', messageId: null }),
    memorySourceFixture({
      sourceKind: 'manual_user_input', messageId: FIXTURE_IDS.messageId
    }),
    memorySourceFixture({
      sourceKind: 'manual_correction', messageId: null,
      actor: privateActor, scene: privateSceneFixture()
    })
  ]
  for (const source of accepted) {
    assert.deepEqual(parseMemorySourceV1(mutableCopy(source)), source)
  }

  const rejected = [
    memorySourceFixture({
      sourceKind: 'group_history', actor: privateActor, scene: privateSceneFixture()
    }),
    memorySourceFixture({ sourceKind: 'private_history' }),
    memorySourceFixture({ sourceKind: 'current_message', messageId: null }),
    memorySourceFixture({ sourceKind: 'quoted_message', messageId: null }),
    memorySourceFixture({ sourceKind: 'model' }),
    memorySourceFixture({ normalizedText: '   \n  ' }),
    memorySourceFixture({ actor: qqIdentityFixture({ userId: '020000002' }) }),
    memorySourceFixture({ messageId: 'm'.repeat(MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes + 1) }),
    memorySourceFixture({
      resourceRefs: Array.from({ length: MEMORY_RESOURCE_LIMITS.sourceResourceRefs + 1 }, (_, index) => `resource:image:${index}`)
    }),
    memorySourceFixture({ resourceRefs: ['resource:image:1', 'resource:image:1'] }),
    memorySourceFixture({ resourceRefs: ['data:image/png;base64,AAAA'] }),
    deepFreezeFixture({ ...memorySourceFixture(), role: 'system' }),
    deepFreezeFixture({ ...memorySourceFixture(), messages: [{ role: 'tool', content: 'x' }] })
  ]
  for (const source of rejected) assert.throws(() => parseMemorySourceV1(mutableCopy(source)), TypeError)
})

test('memory proposal create exposes only a pending candidate without approved consent', () => {
  const canonical = memoryProposalFixture()
  const draft = mutableCopy(omitFixtureKeys(canonical, [
    'schemaVersion', 'revision', 'namespaceRef', 'state', 'decision'
  ]))
  const created = createMemoryProposalV1(draft)
  assert.deepEqual(created, canonical)
  assertDeepFrozen(created)
  assert.throws(() => parseMemoryProposalV1({
    ...mutableCopy(canonical), namespaceRef: 'f'.repeat(64)
  }), TypeError)

  for (const forbidden of ['consent', 'approvedByActorRef', 'approvedAt', 'policyCapability', 'finalNamespace']) {
    assert.throws(() => parseMemoryProposalV1({
      ...mutableCopy(canonical), [forbidden]: 'forbidden'
    }), TypeError)
  }
})

test('stored memory proposal state and decision matrix is exact', () => {
  for (const proposal of [
    memoryProposalFixture(),
    memoryProposalFixture({ state: 'approved', revision: 2, decision: decisionFixture() }),
    memoryProposalFixture({ state: 'rejected', revision: 2, decision: decisionFixture() }),
    memoryProposalFixture({ state: 'expired', revision: 2, decision: decisionFixture() })
  ]) assert.doesNotThrow(() => parseMemoryProposalV1(mutableCopy(proposal)))

  for (const proposal of [
    memoryProposalFixture({ state: 'pending', decision: decisionFixture() }),
    memoryProposalFixture({ state: 'approved', revision: 2, decision: null }),
    memoryProposalFixture({ state: 'rejected', revision: 2, decision: null }),
    memoryProposalFixture({ state: 'expired', revision: 2, decision: null }),
    memoryProposalFixture({
      state: 'approved',
      revision: 2,
      decision: {
        ...decisionFixture(),
        decidedAt: FIXTURE_TIMES.observedAt
      }
    }),
    memoryProposalFixture({ revision: 0 }),
    memoryProposalFixture({ revision: 1.5 })
  ]) assert.throws(() => parseMemoryProposalV1(mutableCopy(proposal)), TypeError)
})

test('memory proposal proposer unions, confidence and source cardinality are exact', () => {
  const acceptedProposers = [
    { kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat' },
    { kind: 'user', actorRef: FIXTURE_IDS.actorRef },
    { kind: 'system_policy', policyRef: FIXTURE_IDS.policyRef }
  ]
  for (const proposedBy of acceptedProposers) {
    assert.doesNotThrow(() => parseMemoryProposalV1(memoryProposalFixture({ proposedBy })))
  }
  assert.doesNotThrow(() => parseMemoryProposalV1(memoryProposalFixture({ sources: [
    memorySourceFixture({ sourceKind: 'quoted_message', messageId: FIXTURE_IDS.quotedMessageId }),
    memorySourceFixture({ sourceKind: 'quoted_message', messageId: 'message-40000006' })
  ] })))
  for (const invalid of [
    memoryProposalFixture({ proposalId: '非 ASCII 提案' }),
    memoryProposalFixture({ proposedBy: { kind: 'user', actorRef: FIXTURE_IDS.subjectUserId } }),
    memoryProposalFixture({ proposedBy: { ...acceptedProposers[0], actorRef: FIXTURE_IDS.actorRef } }),
    memoryProposalFixture({ proposedBy: { kind: 'assistant', runRef: FIXTURE_IDS.runRef } }),
    memoryProposalFixture({ text: '   \n  ' }),
    memoryProposalFixture({ confidence: -0 }),
    memoryProposalFixture({ confidence: -0.001 }),
    memoryProposalFixture({ confidence: 1.001 }),
    memoryProposalFixture({ confidence: Number.NaN }),
    memoryProposalFixture({ confidence: Number.POSITIVE_INFINITY }),
    memoryProposalFixture({ sources: [] }),
    memoryProposalFixture({
      sources: Array.from({ length: MEMORY_RESOURCE_LIMITS.sources + 1 }, () => memorySourceFixture())
    })
  ]) assert.throws(() => parseMemoryProposalV1(invalid), TypeError)
  for (const confidence of [0, 1]) {
    assert.doesNotThrow(() => parseMemoryProposalV1(memoryProposalFixture({ confidence })))
  }
})

test('memory kind, sensitivity and validity discriminants are exact', () => {
  for (const invalid of [
    memoryProposalFixture({ kind: 'system_instruction' }),
    memoryProposalFixture({ sensitivity: 'private' }),
    memoryRecordFixture({ kind: 'assistant_message' }),
    memoryRecordFixture({ sensitivity: 'secret' }),
    memoryRecordFixture({ validity: { state: 'expired', validFrom: null } })
  ]) {
    const parse = Object.hasOwn(invalid, 'proposalId')
      ? parseMemoryProposalV1
      : parseMemoryRecordV1
    assert.throws(() => parse(invalid), TypeError)
  }
  for (const validity of [
    { state: 'current', validFrom: FIXTURE_TIMES.observedAt },
    { state: 'uncertain', validFrom: null },
    { state: 'superseded', validFrom: FIXTURE_TIMES.observedAt }
  ]) assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({ validity })))
  assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({ retention: {
    validUntil: FIXTURE_TIMES.validUntil, purgeAt: FIXTURE_TIMES.validUntil
  } })))
  for (const retention of [
    { validUntil: FIXTURE_TIMES.validUntil, purgeAt: '2027-07-18T00:02:00.000Z' },
    { validUntil: FIXTURE_TIMES.validUntil },
    { purgeAt: FIXTURE_TIMES.purgeAt }
  ]) assert.throws(() => parseMemoryRecordV1(memoryRecordFixture({ retention })), TypeError)
})

test('memory record create recomputes namespace and content hashes and freezes provenance', () => {
  const canonical = memoryRecordFixture()
  const draft = mutableCopy(omitFixtureKeys(canonical, ['schemaVersion', 'contentHash']))
  const created = createMemoryRecordV1(draft)
  assert.deepEqual(created, canonical)
  assertDeepFrozen(created)
  assert.throws(() => parseMemoryRecordV1({
    ...mutableCopy(canonical), namespaceRef: 'f'.repeat(64)
  }), TypeError)
  assert.throws(() => parseMemoryRecordV1({
    ...mutableCopy(canonical), contentHash: 'f'.repeat(64)
  }), TypeError)
  assert.throws(() => createMemoryRecordV1({
    ...draft,
    namespaceRef: 'f'.repeat(64)
  }), TypeError)
})

test('approved memory consent and conflict matrices are exact', () => {
  const source = memorySourceFixture()
  const accepted = [
    memoryRecordFixture(),
    memoryRecordFixture({
      consent: {
        state: 'owner_policy', approvedByActorRef: FIXTURE_IDS.actorRef,
        evidenceSourceId: null, policyRef: FIXTURE_IDS.policyRef,
        approvedAt: FIXTURE_TIMES.confirmedAt
      }
    }),
    memoryRecordFixture({
      consent: {
        state: 'group_policy', approvedByActorRef: FIXTURE_IDS.actorRef,
        evidenceSourceId: null, policyRef: FIXTURE_IDS.policyRef,
        approvedAt: FIXTURE_TIMES.confirmedAt
      }
    }),
    memoryRecordFixture({
      sources: [source],
      conflict: {
        state: 'possible', relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId], note: '待确认'
      }
    }),
    memoryRecordFixture({
      sources: [source],
      conflict: {
        state: 'confirmed', relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId], note: '已确认冲突'
      }
    })
  ]
  for (const record of accepted) assert.doesNotThrow(() => parseMemoryRecordV1(mutableCopy(record)))

  const rejected = [
    memoryRecordFixture({ consent: {
      state: 'explicit', approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: null, policyRef: null, approvedAt: FIXTURE_TIMES.confirmedAt
    } }),
    memoryRecordFixture({ consent: {
      state: 'explicit', approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: 'f'.repeat(64), policyRef: null, approvedAt: FIXTURE_TIMES.confirmedAt
    } }),
    memoryRecordFixture({ consent: {
      state: 'explicit', approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: source.sourceId, policyRef: FIXTURE_IDS.policyRef,
      approvedAt: FIXTURE_TIMES.confirmedAt
    } }),
    memoryRecordFixture({ consent: {
      state: 'owner_policy', approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: null, policyRef: null, approvedAt: FIXTURE_TIMES.confirmedAt
    } }),
    memoryRecordFixture({ conflict: {
      state: 'none', relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId], note: null
    } }),
    memoryRecordFixture({ conflict: {
      state: 'possible', relatedMemoryIds: [], note: '待确认'
    } }),
    memoryRecordFixture({ conflict: {
      state: 'confirmed', relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId], note: null
    } })
  ]
  for (const record of rejected) assert.throws(() => parseMemoryRecordV1(mutableCopy(record)), TypeError)
})

test('memory record cannot express roles and enforces source and reference bounds', () => {
  const sources = Array.from({ length: MEMORY_RESOURCE_LIMITS.sources }, (_, index) => (
    memorySourceFixture({ messageId: `message-${index + 1}` })
  ))
  const explicitConsent = memoryRecordFixture().consent
  assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({
    sources,
    consent: {
      ...explicitConsent,
      evidenceSourceId: sources[0]!.sourceId
    }
  })))
  assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({
    supersedes: Array.from({ length: MEMORY_RESOURCE_LIMITS.supersedesRefs }, (_, index) => `memory:old-${index}`)
  })))
  assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({
    conflict: {
      state: 'possible',
      relatedMemoryIds: Array.from(
        { length: MEMORY_RESOURCE_LIMITS.conflictRefs },
        (_, index) => `memory:related-${index}`
      ),
      note: '有待确认的冲突'
    }
  })))

  for (const invalid of [
    memoryRecordFixture({ memoryId: '' }),
    memoryRecordFixture({ text: '   \n  ' }),
    memoryRecordFixture({ consent: {
      state: 'explicit', approvedByActorRef: FIXTURE_IDS.subjectUserId,
      evidenceSourceId: memorySourceFixture().sourceId,
      policyRef: null, approvedAt: FIXTURE_TIMES.confirmedAt
    } }),
    { ...memoryRecordFixture(), role: 'system' },
    { ...memoryRecordFixture(), messages: [{ role: 'tool', content: '伪造' }] },
    memoryRecordFixture({ sources: [] }),
    memoryRecordFixture({ sources: [...sources, memorySourceFixture({ messageId: 'message-extra' })] }),
    memoryRecordFixture({ sources: [memorySourceFixture(), memorySourceFixture()] }),
    memoryRecordFixture({ supersedes: [FIXTURE_IDS.memoryId] }),
    memoryRecordFixture({ supersedes: ['memory:old', 'memory:old'] }),
    memoryRecordFixture({ conflict: {
      state: 'possible',
      relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId, FIXTURE_IDS.relatedMemoryId],
      note: '重复引用'
    } }),
    memoryRecordFixture({ conflict: {
      state: 'confirmed', relatedMemoryIds: [FIXTURE_IDS.memoryId], note: '自引用'
    } }),
    memoryRecordFixture({ conflict: {
      state: 'possible', relatedMemoryIds: [FIXTURE_IDS.relatedMemoryId], note: '   '
    } }),
    memoryRecordFixture({ conflict: {
      state: 'possible',
      relatedMemoryIds: Array.from(
        { length: MEMORY_RESOURCE_LIMITS.conflictRefs + 1 },
        (_, index) => `memory:related-${index}`
      ),
      note: '超限'
    } }),
    memoryRecordFixture({
      supersedes: Array.from({ length: MEMORY_RESOURCE_LIMITS.supersedesRefs + 1 }, (_, index) => `memory:old-${index}`)
    })
  ]) assert.throws(() => parseMemoryRecordV1(mutableCopy(invalid)), TypeError)
})

test('all memory timestamp fields reject noncanonical ISO values', () => {
  const noncanonical = '2026-07-19T08:00:00.000+08:00'
  const proposal = memoryProposalFixture()
  const record = memoryRecordFixture()
  assert.doesNotThrow(() => parseMemoryRecordV1(memoryRecordFixture({
    observedAt: '2026-07-19T00:03:00.000Z'
  })))
  const cases: readonly [((value: unknown) => unknown), object][] = [
    [parseMemorySourceV1, memorySourceFixture({ observedAt: noncanonical })],
    [parseMemoryProposalV1, memoryProposalFixture({ observedAt: noncanonical })],
    [parseMemoryProposalV1, memoryProposalFixture({ proposedAt: noncanonical })],
    [parseMemoryProposalV1, memoryProposalFixture({
      suggestedRetention: { ...proposal.suggestedRetention, validUntil: noncanonical }
    })],
    [parseMemoryProposalV1, memoryProposalFixture({
      suggestedRetention: { ...proposal.suggestedRetention, purgeAt: noncanonical }
    })],
    [parseMemoryProposalV1, memoryProposalFixture({
      state: 'approved', revision: 2,
      decision: { ...decisionFixture(), decidedAt: noncanonical }
    })],
    [parseMemoryRecordV1, memoryRecordFixture({ createdAt: noncanonical })],
    [parseMemoryRecordV1, memoryRecordFixture({ observedAt: noncanonical })],
    [parseMemoryRecordV1, memoryRecordFixture({ confirmedAt: noncanonical })],
    [parseMemoryRecordV1, memoryRecordFixture({ updatedAt: noncanonical })],
    [parseMemoryRecordV1, memoryRecordFixture({
      validity: { ...record.validity, validFrom: noncanonical }
    })],
    [parseMemoryRecordV1, memoryRecordFixture({
      consent: { ...record.consent, approvedAt: noncanonical }
    })],
    [parseMemoryRecordV1, memoryRecordFixture({
      retention: { ...record.retention, validUntil: noncanonical }
    })],
    [parseMemoryRecordV1, memoryRecordFixture({
      retention: { ...record.retention, purgeAt: noncanonical }
    })],
    [parseMemoryRecordV1, memoryRecordFixture({ createdAt: '2026-07-19T00:03:00.000Z' })],
    [parseMemoryRecordV1, memoryRecordFixture({ confirmedAt: '2026-07-19T00:03:00.000Z' })],
    [parseMemoryRecordV1, memoryRecordFixture({
      consent: {
        ...record.consent,
        approvedAt: '2026-07-19T00:03:00.000Z'
      }
    })],
    [parseMemoryRevisionV1, memoryRevisionFixture({ changedAt: noncanonical })],
    [parseMemoryTombstoneV1, memoryTombstoneFixture({ deletedAt: noncanonical })],
    [parseMemoryTombstoneV1, memoryTombstoneFixture({ expiresAt: noncanonical })],
    [parseMemoryOutboxEventV1, memoryOutboxEventFixture({ occurredAt: noncanonical })]
  ]
  for (const [parse, value] of cases) assert.throws(() => parse(value), TypeError)
})

test('memory revision hashes a complete immutable audit entry and enforces operation shape', () => {
  const first = memoryRevisionFixture()
  assert.deepEqual(
    createMemoryRevisionV1(mutableCopy(omitFixtureKeys(first, ['schemaVersion', 'revisionHash']))),
    first
  )
  assertDeepFrozen(parseMemoryRevisionV1(mutableCopy(first)))

  const secondRecord = memoryRecordFixture({
    revision: 2,
    text: '更喜欢浅烘咖啡',
    updatedAt: '2026-07-19T00:03:00.000Z'
  })
  const second = memoryRevisionFixture({
    revision: 2,
    operation: 'corrected',
    record: secondRecord,
    changedAt: '2026-07-19T00:03:00.000Z',
    reason: '用户更正',
    previousRevisionHash: first.revisionHash
  })
  assert.doesNotThrow(() => parseMemoryRevisionV1(second))

  for (const invalid of [
    memoryRevisionFixture({ revision: 2, operation: 'created', record: secondRecord }),
    memoryRevisionFixture({ revision: 1, operation: 'corrected', previousRevisionHash: null }),
    memoryRevisionFixture({ memoryId: 'memory:different' }),
    { ...first, revisionHash: 'f'.repeat(64) },
    { ...first, operation: 'corrected' },
    { ...first, reason: '被改写' }
  ]) assert.throws(() => parseMemoryRevisionV1(mutableCopy(invalid)), TypeError)
})

test('memory tombstone is body-free and has an exact deletion matrix', () => {
  const forgotten = memoryTombstoneFixture()
  assert.deepEqual(
    createMemoryTombstoneV1(mutableCopy(omitFixtureKeys(forgotten, ['schemaVersion', 'receiptHash']))),
    forgotten
  )
  assertDeepFrozen(parseMemoryTombstoneV1(mutableCopy(forgotten)))
  assert.throws(() => parseMemoryTombstoneV1({
    ...mutableCopy(forgotten), receiptHash: 'f'.repeat(64)
  }), TypeError)
  assert.doesNotThrow(() => parseMemoryTombstoneV1(memoryTombstoneFixture({
    deletionKind: 'namespace_deleted', memoryId: null, deletedRevision: null
  })))

  for (const invalid of [
    memoryTombstoneFixture({ deletionKind: 'memory_forgotten', memoryId: null }),
    memoryTombstoneFixture({ deletionKind: 'memory_forgotten', deletedRevision: null }),
    memoryTombstoneFixture({
      deletionKind: 'namespace_deleted', memoryId: FIXTURE_IDS.memoryId, deletedRevision: 1
    }),
    memoryTombstoneFixture({ expiresAt: '2026-08-19T00:02:00.001Z' }),
    memoryTombstoneFixture({ reasonCode: '用户要求删除这条记忆' })
  ]) assert.throws(() => parseMemoryTombstoneV1(mutableCopy(invalid)), TypeError)

  for (const key of ['text', 'sources', 'identity', 'nickname', 'groupName', 'reason', 'recordHash', 'revisionHash', 'payload']) {
    assert.throws(() => parseMemoryTombstoneV1({
      ...mutableCopy(forgotten), [key]: '不应出现的正文'
    }), TypeError)
  }
})

test('memory outbox is body-free and binds event kind to aggregate', () => {
  const recordUpserted = memoryOutboxEventFixture()
  assert.deepEqual(
    createMemoryOutboxEventV1(mutableCopy(omitFixtureKeys(recordUpserted, ['schemaVersion', 'payloadHash']))),
    recordUpserted
  )
  assertDeepFrozen(parseMemoryOutboxEventV1(mutableCopy(recordUpserted)))

  for (const accepted of [
    memoryOutboxEventFixture({
      aggregate: 'proposal', aggregateId: FIXTURE_IDS.proposalId,
      revision: 2, eventKind: 'proposal_changed'
    }),
    memoryOutboxEventFixture({ eventKind: 'record_forgotten' }),
    memoryOutboxEventFixture({
      aggregate: 'namespace',
      aggregateId: memoryOutboxEventFixture().namespaceRef,
      revision: 2,
      namespaceGeneration: 2,
      eventKind: 'namespace_deleted'
    })
  ]) assert.doesNotThrow(() => parseMemoryOutboxEventV1(accepted))

  for (const invalid of [
    memoryOutboxEventFixture({ aggregate: 'proposal' }),
    memoryOutboxEventFixture({ eventKind: 'proposal_changed' }),
    memoryOutboxEventFixture({ aggregate: 'namespace', eventKind: 'namespace_deleted' }),
    memoryOutboxEventFixture({
      aggregate: 'namespace',
      aggregateId: memoryOutboxEventFixture().namespaceRef,
      namespaceGeneration: 2,
      revision: 1,
      eventKind: 'namespace_deleted'
    }),
    memoryOutboxEventFixture({ sequence: 0 }),
    memoryOutboxEventFixture({ revision: 0 }),
    memoryOutboxEventFixture({ namespaceGeneration: 0 }),
    { ...recordUpserted, payloadHash: 'f'.repeat(64) }
  ]) assert.throws(() => parseMemoryOutboxEventV1(mutableCopy(invalid)), TypeError)

  for (const key of ['payload', 'text', 'sources', 'identity', 'error', 'reason']) {
    assert.throws(() => parseMemoryOutboxEventV1({
      ...mutableCopy(recordUpserted), [key]: '不应出现的正文'
    }), TypeError)
  }
})

test('all memory domain roots reject unknown major versions and exact extra keys', () => {
  const parsersAndValues: readonly [((value: unknown) => unknown), object][] = [
    [parseMemorySourceV1, memorySourceFixture()],
    [parseMemoryProposalV1, memoryProposalFixture()],
    [parseMemoryRecordV1, memoryRecordFixture()],
    [parseMemoryRevisionV1, memoryRevisionFixture()],
    [parseMemoryTombstoneV1, memoryTombstoneFixture()],
    [parseMemoryOutboxEventV1, memoryOutboxEventFixture()]
  ]
  for (const [parse, value] of parsersAndValues) {
    const mutable = mutableCopy(value) as Record<string, unknown>
    assert.throws(() => parse({ ...mutable, schemaVersion: 2 }), TypeError)
    assert.throws(() => parse({ ...mutable, extra: true }), TypeError)
    const { schemaVersion: _schemaVersion, ...missing } = mutable
    assert.throws(() => parse(missing), TypeError)
  }
})
