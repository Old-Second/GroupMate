import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit,
  memoryCanonicalTextWithinLimits,
  memoryCountWithinLimit,
  memoryFixedDurationMatches,
  memorySourceExcerptWithinLimits,
  memoryTextWithinLimits,
  memoryWireBytesWithinLimit
} from '../../src/agent/memory/memory-resource-limits.js'
import {
  MEMORY_NAMESPACE_HASH_DOMAIN,
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  parseRunScopedContextRefV1,
  type MemoryNamespaceRefV1,
  type RunScopedContextRefV1
} from '../../src/agent/memory/memory-namespace.js'

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

function personalNamespaceInput () {
  return deepFreeze({
    schemaVersion: 1 as const,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq' as const,
    accountId: '10000001',
    scope: {
      kind: 'personal' as const,
      subjectUserId: '20000002'
    }
  })
}

function groupNamespaceInput () {
  return deepFreeze({
    schemaVersion: 1 as const,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq' as const,
    accountId: '10000001',
    scope: {
      kind: 'group' as const,
      groupId: '30000003',
      groupLifecycleId: 'qq-group-30000003-generation-1'
    }
  })
}

test('memory resource limits lock approved boundaries and reject +1', () => {
  assert.deepEqual(MEMORY_RESOURCE_LIMITS, {
    recordWireBytes: 16 * 1_024,
    textUtf8Bytes: 4 * 1_024,
    textCodePoints: 2_000,
    sources: 8,
    sourceExcerptUtf8Bytes: 1_024,
    sourceResourceRefs: 4,
    proposalWireBytes: 24 * 1_024,
    revisionWireBytes: 24 * 1_024,
    tombstoneWireBytes: 4 * 1_024,
    outboxEventWireBytes: 4 * 1_024,
    conflictRefs: 16,
    supersedesRefs: 16,
    listPageRecords: 64,
    listPageWireBytes: 512 * 1_024,
    operationBatchRecords: 32,
    namespaceActiveRecords: 4_096,
    namespacePendingProposals: 256,
    memoryRetainedRevisions: 32,
    namespaceCanonicalLogicalBytes: 64 * 1_024 * 1_024,
    deploymentNamespaces: 4_096,
    deploymentActiveRecords: 32_768,
    deploymentCanonicalLogicalBytes: 256 * 1_024 * 1_024,
    unackedOutboxRecords: 4_096,
    unackedOutboxLogicalBytes: 16 * 1_024 * 1_024,
    sqlitePageCacheBytes: 2 * 1_024 * 1_024,
    sqliteWalJournalLimitBytes: 32 * 1_024 * 1_024,
    sqliteMainFileBytes: 512 * 1_024 * 1_024,
    redisHotRecords: 2_048,
    redisHotLogicalBytes: 16 * 1_024 * 1_024,
    redisHotAbsoluteTtlMs: 24 * 60 * 60 * 1_000,
    tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    identifierCodePoints: 128,
    qqIdDigits: 32,
    opaqueIdAsciiBytes: 128,
    identityTextCodePoints: 256,
    identityTextUtf8Bytes: 1_024,
    reasonTextCodePoints: 512,
    reasonTextUtf8Bytes: 2 * 1_024,
    resourceRefAsciiBytes: 256,
    trustedMemberSnapshotMaxAgeMs: 60_000,
    trustedMemberSnapshotFutureSkewMs: 5_000,
    accessNamespaces: 64,
    trustedMemberUserIds: 4_096
  })
  assert.equal(Object.isFrozen(MEMORY_RESOURCE_LIMITS), true)

  assert.equal(memoryTextWithinLimits('😀'.repeat(1_024)), true)
  assert.equal(memoryTextWithinLimits(`${'😀'.repeat(1_024)}a`), false)
  assert.equal(memoryTextWithinLimits('a'.repeat(2_000)), true)
  assert.equal(memoryTextWithinLimits('a'.repeat(2_001)), false)
  assert.equal(memoryTextWithinLimits('e\u0301'), false)

  assert.equal(memorySourceExcerptWithinLimits('a'.repeat(1_024)), true)
  assert.equal(memorySourceExcerptWithinLimits('a'.repeat(1_025)), false)
  assert.equal(memorySourceExcerptWithinLimits('e\u0301'), false)

  for (const limit of [
    MEMORY_RESOURCE_LIMITS.recordWireBytes,
    MEMORY_RESOURCE_LIMITS.proposalWireBytes,
    MEMORY_RESOURCE_LIMITS.revisionWireBytes,
    MEMORY_RESOURCE_LIMITS.tombstoneWireBytes,
    MEMORY_RESOURCE_LIMITS.outboxEventWireBytes,
    MEMORY_RESOURCE_LIMITS.listPageWireBytes,
    MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes,
    MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes,
    MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes,
    MEMORY_RESOURCE_LIMITS.sqlitePageCacheBytes,
    MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes,
    MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes,
    MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
  ]) {
    assert.equal(memoryWireBytesWithinLimit(limit, limit), true)
    assert.equal(memoryWireBytesWithinLimit(limit + 1, limit), false)
  }
  for (const limit of [
    MEMORY_RESOURCE_LIMITS.sources,
    MEMORY_RESOURCE_LIMITS.sourceResourceRefs,
    MEMORY_RESOURCE_LIMITS.conflictRefs,
    MEMORY_RESOURCE_LIMITS.supersedesRefs,
    MEMORY_RESOURCE_LIMITS.listPageRecords,
    MEMORY_RESOURCE_LIMITS.operationBatchRecords,
    MEMORY_RESOURCE_LIMITS.namespaceActiveRecords,
    MEMORY_RESOURCE_LIMITS.namespacePendingProposals,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions,
    MEMORY_RESOURCE_LIMITS.deploymentNamespaces,
    MEMORY_RESOURCE_LIMITS.deploymentActiveRecords,
    MEMORY_RESOURCE_LIMITS.unackedOutboxRecords,
    MEMORY_RESOURCE_LIMITS.redisHotRecords,
    MEMORY_RESOURCE_LIMITS.accessNamespaces,
    MEMORY_RESOURCE_LIMITS.trustedMemberUserIds
  ]) {
    assert.equal(memoryCountWithinLimit(limit, limit), true)
    assert.equal(memoryCountWithinLimit(limit + 1, limit), false)
  }
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs,
    MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs
  ), true)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs + 1,
    MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs
  ), false)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs,
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
  ), true)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs + 1,
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
  ), false)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs,
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs
  ), true)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs + 1,
    MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs
  ), false)

  assert.equal(memoryAsciiWithinLimit(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes),
    MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes
  ), true)
  assert.equal(memoryAsciiWithinLimit(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes + 1),
    MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes
  ), false)
  assert.equal(memoryAsciiWithinLimit(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.resourceRefAsciiBytes),
    MEMORY_RESOURCE_LIMITS.resourceRefAsciiBytes
  ), true)
  assert.equal(memoryAsciiWithinLimit(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.resourceRefAsciiBytes + 1),
    MEMORY_RESOURCE_LIMITS.resourceRefAsciiBytes
  ), false)
  assert.equal(memoryCanonicalTextWithinLimits(
    '😀'.repeat(MEMORY_RESOURCE_LIMITS.identityTextCodePoints),
    MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.identityTextCodePoints
  ), true)
  assert.equal(memoryCanonicalTextWithinLimits(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.identityTextCodePoints + 1),
    MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.identityTextCodePoints
  ), false)
  assert.equal(memoryCanonicalTextWithinLimits(
    '😀'.repeat(MEMORY_RESOURCE_LIMITS.reasonTextCodePoints),
    MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.reasonTextCodePoints
  ), true)
  assert.equal(memoryCanonicalTextWithinLimits(
    'a'.repeat(MEMORY_RESOURCE_LIMITS.reasonTextCodePoints + 1),
    MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.reasonTextCodePoints
  ), false)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs,
    MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs
  ), true)
  assert.equal(memoryFixedDurationMatches(
    MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs + 1,
    MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs
  ), false)
})

test('personal and group memory namespaces parse exactly and are deeply frozen', () => {
  const personal = parseMemoryNamespaceV1(personalNamespaceInput())
  const group = parseMemoryNamespaceV1(groupNamespaceInput())

  assert.notEqual(personal, personalNamespaceInput())
  assert.deepEqual(personal, personalNamespaceInput())
  assert.deepEqual(group, groupNamespaceInput())
  assertDeepFrozen(personal)
  assertDeepFrozen(group)

  const createdPersonal = createMemoryNamespaceV1(deepFreeze({
    botInstanceId: 'groupmate-primary',
    adapter: 'qq' as const,
    accountId: '10000001',
    scope: { kind: 'personal' as const, subjectUserId: '20000002' }
  }))
  assert.deepEqual(createdPersonal, personal)
})

test('namespace parser accepts plain mutable data and returns an isolated frozen copy', () => {
  const input = {
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001',
    scope: { kind: 'personal', subjectUserId: '20000002' }
  }
  const before = JSON.stringify(input)
  const parsed = parseMemoryNamespaceV1(input)

  assert.deepEqual(parsed, personalNamespaceInput())
  assert.equal(JSON.stringify(input), before)
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.scope), false)
  assert.notEqual(parsed, input)
  assert.notEqual(parsed.scope, input.scope)
  assertDeepFrozen(parsed)
})

test('namespace parser rejects getters and proxies without invoking their traps', () => {
  let getterCalls = 0
  const accessor = {
    schemaVersion: 1,
    botInstanceId: 'groupmate-primary',
    adapter: 'qq',
    accountId: '10000001'
  } as Record<string, unknown>
  Object.defineProperty(accessor, 'scope', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      throw new Error('must not leak')
    }
  })
  assert.throws(() => parseMemoryNamespaceV1(accessor), TypeError)
  assert.equal(getterCalls, 0)

  let proxyTraps = 0
  const proxy = new Proxy(personalNamespaceInput(), {
    ownKeys: () => {
      proxyTraps += 1
      throw new Error('must not leak')
    },
    get: () => {
      proxyTraps += 1
      throw new Error('must not leak')
    }
  })
  assert.throws(() => parseMemoryNamespaceV1(proxy), TypeError)
  assert.equal(proxyTraps, 0)
})

test('memory namespace refs are deterministic, domain-separated and fixed vectors', () => {
  const personal = parseMemoryNamespaceV1(personalNamespaceInput())
  const group = parseMemoryNamespaceV1(groupNamespaceInput())

  assert.equal(MEMORY_NAMESPACE_HASH_DOMAIN, 'groupmate.memory.namespace.v1')
  assert.equal(
    memoryNamespaceWireV1(personal),
    '{"schemaVersion":1,"botInstanceId":"groupmate-primary","adapter":"qq","accountId":"10000001","scope":{"kind":"personal","subjectUserId":"20000002"}}'
  )
  assert.equal(
    memoryNamespaceWireV1(group),
    '{"schemaVersion":1,"botInstanceId":"groupmate-primary","adapter":"qq","accountId":"10000001","scope":{"kind":"group","groupId":"30000003","groupLifecycleId":"qq-group-30000003-generation-1"}}'
  )
  assert.equal(
    memoryNamespaceRefV1(personal),
    '1b2236f11ae9f70db5da36ef8e6cbe21acadca03198857dbfda6d4bd200081a0'
  )
  assert.equal(
    memoryNamespaceRefV1(group),
    '1d560d8ae81fe7987828a867e420fdbd590843c554bb5527cd42e85919a4c6a0'
  )
  assert.match(memoryNamespaceRefV1(personal), /^[0-9a-f]{64}$/)
  assert.equal(parseMemoryNamespaceRefV1(memoryNamespaceRefV1(personal)), memoryNamespaceRefV1(personal))
})

test('persistent namespace refs cannot be created from run-scoped plain refs', () => {
  const runScopedNamespaceRef = parseRunScopedContextRefV1('a'.repeat(32))
  const persistentRef = memoryNamespaceRefV1(parseMemoryNamespaceV1(personalNamespaceInput()))
  // @ts-expect-error A run-scoped context ref cannot be used as a persistent namespace ref.
  const wrongPersistentRef: MemoryNamespaceRefV1 = runScopedNamespaceRef
  // @ts-expect-error A persistent namespace ref cannot be used as a run-scoped context ref.
  const wrongRunRef: RunScopedContextRefV1 = persistentRef
  assert.equal(typeof wrongPersistentRef, 'string')
  assert.equal(typeof wrongRunRef, 'string')
  assert.throws(() => parseMemoryNamespaceRefV1(runScopedNamespaceRef), TypeError)
  assert.throws(() => parseRunScopedContextRefV1(persistentRef), TypeError)
  assert.throws(() => parseRunScopedContextRefV1('a'.repeat(31)), TypeError)
  assert.throws(() => parseRunScopedContextRefV1('A'.repeat(32)), TypeError)
  assert.throws(() => parseRunScopedContextRefV1('run ref with spaces'), TypeError)
})

test('memory text and excerpts reject lone surrogates but accept valid pairs', () => {
  assert.equal(memoryTextWithinLimits('\ud800'), false)
  assert.equal(memoryTextWithinLimits('\udc00'), false)
  assert.equal(memorySourceExcerptWithinLimits('\ud800'), false)
  assert.equal(memorySourceExcerptWithinLimits('\udc00'), false)
  assert.equal(memoryTextWithinLimits('\ud83d\ude00'), true)
  assert.equal(memorySourceExcerptWithinLimits('\ud83d\ude00'), true)
})

test('memory namespaces reject extra keys, invalid identifiers and non-canonical values', () => {
  const valid = personalNamespaceInput()
  assert.doesNotThrow(() => parseMemoryNamespaceV1(deepFreeze({
    ...valid,
    botInstanceId: 'a'.repeat(128),
    accountId: '1'.repeat(32),
    scope: { kind: 'personal', subjectUserId: '2'.repeat(32) }
  })))
  assert.doesNotThrow(() => parseMemoryNamespaceV1(deepFreeze({
    ...groupNamespaceInput(),
    scope: {
      kind: 'group',
      groupId: '3'.repeat(32),
      groupLifecycleId: 'a'.repeat(128)
    }
  })))
  const cases: unknown[] = [
    deepFreeze({ ...valid, extra: true }),
    deepFreeze({ ...valid, schemaVersion: 2 }),
    deepFreeze({ ...valid, adapter: 'openai' }),
    deepFreeze({ ...valid, botInstanceId: '' }),
    deepFreeze({ ...valid, botInstanceId: ' leading-space' }),
    deepFreeze({ ...valid, botInstanceId: 'a'.repeat(129) }),
    deepFreeze({ ...valid, accountId: 10000001 }),
    deepFreeze({ ...valid, accountId: '010000001' }),
    deepFreeze({ ...valid, accountId: '1'.repeat(33) }),
    deepFreeze({ ...valid, scope: { ...valid.scope, extra: true } }),
    deepFreeze({ ...valid, scope: { kind: 'personal', subjectUserId: 'not-a-qq-id' } }),
    deepFreeze({ ...groupNamespaceInput(), scope: {
      kind: 'group',
      groupId: '30000003',
      groupLifecycleId: 'a'.repeat(129)
    } }),
    deepFreeze({ ...groupNamespaceInput(), scope: {
      kind: 'group',
      groupId: '30000003',
      groupLifecycleId: 'e\u0301'
    } })
  ]

  for (const value of cases) assert.throws(() => parseMemoryNamespaceV1(value), TypeError)
  assert.throws(() => parseMemoryNamespaceRefV1('A'.repeat(64)), TypeError)
})
