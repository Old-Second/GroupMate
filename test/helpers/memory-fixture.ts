import { createHash } from 'node:crypto'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import type {
  MemoryOutboxEventV1,
  MemoryProposalV1,
  MemoryRecordV1,
  MemoryRevisionV1,
  MemorySourceV1,
  MemoryTombstoneV1,
  QqIdentitySnapshotV1,
  QqSceneSnapshotV1
} from '../../src/agent/memory/memory-domain.js'

export const FIXTURE_TIMES = Object.freeze({
  observedAt: '2026-07-19T00:00:00.000Z',
  proposedAt: '2026-07-19T00:01:00.000Z',
  confirmedAt: '2026-07-19T00:02:00.000Z',
  updatedAt: '2026-07-19T00:02:00.000Z',
  validUntil: '2027-07-19T00:02:00.000Z',
  purgeAt: '2027-08-18T00:02:00.000Z',
  deletedAt: '2026-07-20T00:02:00.000Z',
  tombstoneExpiresAt: '2026-08-19T00:02:00.000Z'
})

export const FIXTURE_IDS = Object.freeze({
  botInstanceId: 'groupmate-primary',
  accountId: '10000001',
  subjectUserId: '20000002',
  secondUserId: '20000003',
  groupId: '30000003',
  groupLifecycleId: 'qq-group-30000003-generation-1',
  messageId: 'message-40000004',
  quotedMessageId: 'message-40000005',
  proposalId: 'proposal:fixture-1',
  memoryId: 'memory:fixture-1',
  relatedMemoryId: 'memory:fixture-related',
  actorRef: `actor:${'a'.repeat(64)}`,
  policyRef: `policy:${'b'.repeat(64)}`,
  runRef: `run:${'c'.repeat(64)}`,
  tombstoneId: 'tombstone:fixture-1',
  eventId: 'event:fixture-1'
})

export const MEMORY_HASH_DOMAINS = Object.freeze({
  sourceContent: 'groupmate.memory.source-content.v1',
  sourceId: 'groupmate.memory.source-id.v1',
  recordContent: 'groupmate.memory.record-content.v1',
  revision: 'groupmate.memory.revision.v1',
  tombstoneReceipt: 'groupmate.memory.tombstone-receipt.v1',
  outboxPayload: 'groupmate.memory.outbox-payload.v1'
})

export function deepFreezeFixture<T> (value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      deepFreezeFixture(descriptor.value, seen)
    }
  }
  return Object.freeze(value)
}

export function assertableDomainHash (domain: string, preimage: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0')
    .update(preimage, 'utf8')
    .digest('hex')
}

export function personalMemoryNamespaceFixture (): MemoryNamespaceV1 {
  return createMemoryNamespaceV1(deepFreezeFixture({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq' as const,
    accountId: FIXTURE_IDS.accountId,
    scope: deepFreezeFixture({
      kind: 'personal' as const,
      subjectUserId: FIXTURE_IDS.subjectUserId
    })
  }))
}

export function qqIdentityFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): QqIdentitySnapshotV1 {
  return deepFreezeFixture({
    userId: FIXTURE_IDS.subjectUserId,
    nickname: '爱丽丝',
    groupCard: '群友甲',
    groupTitle: '活跃成员',
    groupRole: 'member',
    displayName: '群友甲',
    ...overrides
  }) as unknown as QqIdentitySnapshotV1
}

export function groupSceneFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): QqSceneSnapshotV1 {
  return deepFreezeFixture({
    kind: 'group',
    groupId: FIXTURE_IDS.groupId,
    groupLifecycleId: FIXTURE_IDS.groupLifecycleId,
    groupName: 'GroupMate 测试群',
    ...overrides
  }) as unknown as QqSceneSnapshotV1
}

export function privateSceneFixture (): QqSceneSnapshotV1 {
  return deepFreezeFixture({
    kind: 'private',
    groupId: null,
    groupLifecycleId: null,
    groupName: null
  }) as unknown as QqSceneSnapshotV1
}

function identityJson (identity: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    userId: identity.userId,
    nickname: identity.nickname,
    groupCard: identity.groupCard,
    groupTitle: identity.groupTitle,
    groupRole: identity.groupRole,
    displayName: identity.displayName
  })
}

function sceneJson (scene: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    kind: scene.kind,
    groupId: scene.groupId,
    groupLifecycleId: scene.groupLifecycleId,
    groupName: scene.groupName
  })
}

function sourceIdPreimage (source: Readonly<Record<string, unknown>>): string {
  const resources = source.resourceRefs as readonly string[]
  return `{"schemaVersion":1,"sourceKind":${JSON.stringify(source.sourceKind)},"messageId":${JSON.stringify(source.messageId)},"actor":${identityJson(source.actor as Readonly<Record<string, unknown>>)},"scene":${sceneJson(source.scene as Readonly<Record<string, unknown>>)},"observedAt":${JSON.stringify(source.observedAt)},"normalizedText":${JSON.stringify(source.normalizedText)},"contentHash":${JSON.stringify(source.contentHash)},"resourceRefs":${JSON.stringify(resources)}}`
}

export function memorySourceFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemorySourceV1 {
  const input = {
    sourceKind: 'current_message',
    messageId: FIXTURE_IDS.messageId,
    actor: qqIdentityFixture(),
    scene: groupSceneFixture(),
    observedAt: FIXTURE_TIMES.observedAt,
    normalizedText: '喜欢无糖咖啡。\n周末常骑车。',
    resourceRefs: deepFreezeFixture(['resource:image:fixture-1']),
    ...overrides
  }
  const contentHash = assertableDomainHash(
    MEMORY_HASH_DOMAINS.sourceContent,
    String(input.normalizedText)
  )
  const sourceWithoutId = deepFreezeFixture({
    schemaVersion: 1,
    sourceKind: input.sourceKind,
    messageId: input.messageId,
    actor: input.actor,
    scene: input.scene,
    observedAt: input.observedAt,
    normalizedText: input.normalizedText,
    contentHash,
    resourceRefs: input.resourceRefs
  })
  return deepFreezeFixture({
    schemaVersion: 1,
    sourceId: assertableDomainHash(MEMORY_HASH_DOMAINS.sourceId, sourceIdPreimage(sourceWithoutId)),
    sourceKind: input.sourceKind,
    messageId: input.messageId,
    actor: input.actor,
    scene: input.scene,
    observedAt: input.observedAt,
    normalizedText: input.normalizedText,
    contentHash,
    resourceRefs: input.resourceRefs
  }) as unknown as MemorySourceV1
}

export function memoryProposalFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryProposalV1 {
  const namespace = personalMemoryNamespaceFixture()
  return deepFreezeFixture({
    schemaVersion: 1,
    proposalId: FIXTURE_IDS.proposalId,
    revision: 1,
    namespace,
    namespaceRef: memoryNamespaceRefV1(namespace),
    state: 'pending',
    proposedBy: deepFreezeFixture({
      kind: 'model',
      runRef: FIXTURE_IDS.runRef,
      modelProfile: 'deepseek-chat'
    }),
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: deepFreezeFixture([memorySourceFixture()]),
    observedAt: FIXTURE_TIMES.observedAt,
    proposedAt: FIXTURE_TIMES.proposedAt,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: deepFreezeFixture({ state: 'none', relatedMemoryIds: [], note: null }),
    suggestedRetention: deepFreezeFixture({
      validUntil: FIXTURE_TIMES.validUntil,
      purgeAt: FIXTURE_TIMES.purgeAt
    }),
    consentRequirement: 'explicit',
    decision: null,
    ...overrides
  }) as unknown as MemoryProposalV1
}

function recordContentPreimage (record: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    memoryId: record.memoryId,
    revision: record.revision,
    namespace: record.namespace,
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    kind: record.kind,
    text: record.text,
    sources: record.sources,
    createdAt: record.createdAt,
    observedAt: record.observedAt,
    confirmedAt: record.confirmedAt,
    updatedAt: record.updatedAt,
    validity: record.validity,
    confidence: record.confidence,
    consent: record.consent,
    sensitivity: record.sensitivity,
    conflict: record.conflict,
    supersedes: record.supersedes,
    retention: record.retention,
    deletionState: record.deletionState
  })
}

export function memoryRecordFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryRecordV1 {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture()
  const input = deepFreezeFixture({
    schemaVersion: 1,
    memoryId: FIXTURE_IDS.memoryId,
    revision: 1,
    namespace,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: deepFreezeFixture([source]),
    createdAt: FIXTURE_TIMES.confirmedAt,
    observedAt: FIXTURE_TIMES.observedAt,
    confirmedAt: FIXTURE_TIMES.confirmedAt,
    updatedAt: FIXTURE_TIMES.updatedAt,
    validity: deepFreezeFixture({ state: 'current', validFrom: FIXTURE_TIMES.observedAt }),
    confidence: 0.9,
    consent: deepFreezeFixture({
      state: 'explicit',
      approvedByActorRef: FIXTURE_IDS.actorRef,
      evidenceSourceId: source.sourceId,
      policyRef: null,
      approvedAt: FIXTURE_TIMES.confirmedAt
    }),
    sensitivity: 'personal',
    conflict: deepFreezeFixture({ state: 'none', relatedMemoryIds: [], note: null }),
    supersedes: deepFreezeFixture([]),
    retention: deepFreezeFixture({
      validUntil: FIXTURE_TIMES.validUntil,
      purgeAt: FIXTURE_TIMES.purgeAt
    }),
    deletionState: 'active',
    ...overrides
  })
  return deepFreezeFixture({
    ...input,
    contentHash: assertableDomainHash(
      MEMORY_HASH_DOMAINS.recordContent,
      recordContentPreimage(input)
    )
  }) as unknown as MemoryRecordV1
}

function revisionPreimage (revision: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    memoryId: revision.memoryId,
    revision: revision.revision,
    operation: revision.operation,
    record: revision.record,
    changedByActorRef: revision.changedByActorRef,
    changedAt: revision.changedAt,
    reason: revision.reason,
    previousRevisionHash: revision.previousRevisionHash
  })
}

export function memoryRevisionFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryRevisionV1 {
  const record = memoryRecordFixture()
  const input = deepFreezeFixture({
    schemaVersion: 1,
    memoryId: FIXTURE_IDS.memoryId,
    revision: 1,
    operation: 'created',
    record,
    changedByActorRef: FIXTURE_IDS.actorRef,
    changedAt: FIXTURE_TIMES.updatedAt,
    reason: null,
    previousRevisionHash: null,
    ...overrides
  })
  return deepFreezeFixture({
    ...input,
    revisionHash: assertableDomainHash(
      MEMORY_HASH_DOMAINS.revision,
      revisionPreimage(input)
    )
  }) as unknown as MemoryRevisionV1
}

function tombstonePreimage (tombstone: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    tombstoneId: tombstone.tombstoneId,
    namespaceRef: tombstone.namespaceRef,
    namespaceGeneration: tombstone.namespaceGeneration,
    memoryId: tombstone.memoryId,
    deletedRevision: tombstone.deletedRevision,
    deletionKind: tombstone.deletionKind,
    deletedAt: tombstone.deletedAt,
    deletedByActorRef: tombstone.deletedByActorRef,
    reasonCode: tombstone.reasonCode,
    expiresAt: tombstone.expiresAt
  })
}

export function memoryTombstoneFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryTombstoneV1 {
  const namespace = personalMemoryNamespaceFixture()
  const input = deepFreezeFixture({
    schemaVersion: 1,
    tombstoneId: FIXTURE_IDS.tombstoneId,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    memoryId: FIXTURE_IDS.memoryId,
    deletedRevision: 1,
    deletionKind: 'memory_forgotten',
    deletedAt: FIXTURE_TIMES.deletedAt,
    deletedByActorRef: FIXTURE_IDS.actorRef,
    reasonCode: 'user_requested',
    expiresAt: FIXTURE_TIMES.tombstoneExpiresAt,
    ...overrides
  })
  const receiptHash = assertableDomainHash(
    MEMORY_HASH_DOMAINS.tombstoneReceipt,
    tombstonePreimage(input)
  )
  return deepFreezeFixture({
    schemaVersion: input.schemaVersion,
    tombstoneId: input.tombstoneId,
    namespaceRef: input.namespaceRef,
    namespaceGeneration: input.namespaceGeneration,
    memoryId: input.memoryId,
    deletedRevision: input.deletedRevision,
    deletionKind: input.deletionKind,
    deletedAt: input.deletedAt,
    deletedByActorRef: input.deletedByActorRef,
    reasonCode: input.reasonCode,
    receiptHash,
    expiresAt: input.expiresAt
  }) as unknown as MemoryTombstoneV1
}

function outboxPreimage (event: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    eventId: event.eventId,
    sequence: event.sequence,
    namespaceRef: event.namespaceRef,
    namespaceGeneration: event.namespaceGeneration,
    aggregate: event.aggregate,
    aggregateId: event.aggregateId,
    revision: event.revision,
    eventKind: event.eventKind,
    occurredAt: event.occurredAt
  })
}

export function memoryOutboxEventFixture (
  overrides: Readonly<Record<string, unknown>> = {}
): MemoryOutboxEventV1 {
  const namespace = personalMemoryNamespaceFixture()
  const input = deepFreezeFixture({
    schemaVersion: 1,
    eventId: FIXTURE_IDS.eventId,
    sequence: 1,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    aggregate: 'record',
    aggregateId: FIXTURE_IDS.memoryId,
    revision: 1,
    eventKind: 'record_upserted',
    occurredAt: FIXTURE_TIMES.confirmedAt,
    ...overrides
  })
  return deepFreezeFixture({
    ...input,
    payloadHash: assertableDomainHash(
      MEMORY_HASH_DOMAINS.outboxPayload,
      outboxPreimage(input)
    )
  }) as unknown as MemoryOutboxEventV1
}

export function omitFixtureKeys (
  value: object,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  return deepFreezeFixture(Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key))
  ))
}
