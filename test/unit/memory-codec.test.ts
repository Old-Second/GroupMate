import assert from 'node:assert/strict'
import { types as utilTypes } from 'node:util'
import { test } from 'node:test'
import {
  MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN,
  MEMORY_RECORD_CONTENT_HASH_DOMAIN,
  MEMORY_REVISION_HASH_DOMAIN,
  MEMORY_SOURCE_CONTENT_HASH_DOMAIN,
  MEMORY_SOURCE_ID_HASH_DOMAIN,
  MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN,
  decodeMemoryOutboxEventV1,
  decodeMemoryProposalV1,
  decodeMemoryRecordV1,
  decodeMemoryRevisionV1,
  decodeMemorySourceV1,
  decodeMemoryTombstoneV1,
  encodeMemoryOutboxEventV1,
  encodeMemoryProposalV1,
  encodeMemoryRecordV1,
  encodeMemoryRevisionV1,
  encodeMemorySourceV1,
  encodeMemoryTombstoneV1
} from '../../src/agent/memory/memory-codec.js'
import {
  parseMemoryOutboxEventV1,
  parseMemoryProposalV1,
  parseMemoryRecordV1,
  parseMemoryRevisionV1,
  parseMemorySourceV1
} from '../../src/agent/memory/memory-domain.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  MEMORY_HASH_DOMAINS,
  assertableDomainHash,
  memoryOutboxEventFixture,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memorySourceFixture,
  memoryTombstoneFixture
} from '../helpers/memory-fixture.js'

/*
 * Expected Task 3 public surface:
 *
 * memory-domain.ts:
 *   create/parseQqIdentitySnapshotV1, parseQqSceneSnapshotV1,
 *   create/parseMemorySourceV1, create/parseMemoryProposalV1,
 *   create/parseMemoryRecordV1, create/parseMemoryRevisionV1,
 *   create/parseMemoryTombstoneV1, create/parseMemoryOutboxEventV1.
 *
 * memory-codec.ts:
 *   the six fixed domain constants below and matching
 *   encode/decodeMemory<Type>V1 functions for every canonical root.
 */

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

test('memory hash domains and independent SHA-256 vectors are fixed', () => {
  assert.equal(MEMORY_SOURCE_CONTENT_HASH_DOMAIN, MEMORY_HASH_DOMAINS.sourceContent)
  assert.equal(MEMORY_SOURCE_ID_HASH_DOMAIN, MEMORY_HASH_DOMAINS.sourceId)
  assert.equal(MEMORY_RECORD_CONTENT_HASH_DOMAIN, MEMORY_HASH_DOMAINS.recordContent)
  assert.equal(MEMORY_REVISION_HASH_DOMAIN, MEMORY_HASH_DOMAINS.revision)
  assert.equal(MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN, MEMORY_HASH_DOMAINS.tombstoneReceipt)
  assert.equal(MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN, MEMORY_HASH_DOMAINS.outboxPayload)

  assert.deepEqual([
    assertableDomainHash(MEMORY_SOURCE_CONTENT_HASH_DOMAIN, 'fixture'),
    assertableDomainHash(MEMORY_SOURCE_ID_HASH_DOMAIN, 'fixture'),
    assertableDomainHash(MEMORY_RECORD_CONTENT_HASH_DOMAIN, 'fixture'),
    assertableDomainHash(MEMORY_REVISION_HASH_DOMAIN, 'fixture'),
    assertableDomainHash(MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN, 'fixture'),
    assertableDomainHash(MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN, 'fixture')
  ], [
    '4100edaa178aaa8251b3c321dea528f1e6f3c97f74d5683fb233db3eab45dd83',
    '498584266a117679acc253d792d36c7cec781fa309058932312b116060cf5e24',
    '9668910a7db17fb4683b30f9c050d4c40ce3167e9e469c044ed601035af3b6a2',
    '268a066cc8e67613ada0f8bd9ec245ea9a9f2875b0c72bb771806107e0a951c5',
    'aa5da7d943890ff4f1ddc7a1dd60f2057b73395b43f7697eee6cdc7265d4182c',
    '4c0018bcd21840761ea236df4e3133e52434e242d5b17db715a56d80dc3199bb'
  ])
  assert.deepEqual({
    sourceContent: memorySourceFixture().contentHash,
    sourceId: memorySourceFixture().sourceId,
    recordContent: memoryRecordFixture().contentHash,
    revision: memoryRevisionFixture().revisionHash,
    tombstone: memoryTombstoneFixture().receiptHash,
    outbox: memoryOutboxEventFixture().payloadHash
  }, {
    sourceContent: 'e1eba604b5a88f5f91fdbe26c183a2216686ebbdfe14e5da8283fe5971b3b5db',
    sourceId: '6a29ff9b211d2aa320aebc96b98ace6fa766af05fe686cb03dc81957bb3697c6',
    recordContent: '151d88b99dab3e4b01ca93b246d860ecc7fe4a73a332d1430334ed256f0dd1db',
    revision: '7ada62792f830f712a99ae5e0d2b0bb97362324773cf1adb7c9536859a7907ac',
    tombstone: 'a421f82d11d54bc918b313e30777e53a2cecd181525b98da0fab88c42a3529a7',
    outbox: 'd990fc3cf16434b164caf8ee3d91bb89bc9a28e38d9b804d907d8376e318d54b'
  })
})

test('memory codecs emit fixed-order compact canonical JSON and round-trip deeply frozen values', () => {
  const cases = [
    {
      value: memorySourceFixture(),
      encode: () => encodeMemorySourceV1(memorySourceFixture()),
      decode: decodeMemorySourceV1,
      keys: [
        'schemaVersion', 'sourceId', 'sourceKind', 'messageId', 'actor', 'scene',
        'observedAt', 'normalizedText', 'contentHash', 'resourceRefs'
      ]
    },
    {
      value: memoryProposalFixture(),
      encode: () => encodeMemoryProposalV1(memoryProposalFixture()),
      decode: decodeMemoryProposalV1,
      keys: [
        'schemaVersion', 'proposalId', 'revision', 'namespace', 'namespaceRef', 'state',
        'proposedBy', 'kind', 'text', 'sources', 'observedAt', 'proposedAt', 'confidence',
        'sensitivity', 'conflict', 'suggestedRetention', 'consentRequirement', 'decision'
      ]
    },
    {
      value: memoryRecordFixture(),
      encode: () => encodeMemoryRecordV1(memoryRecordFixture()),
      decode: decodeMemoryRecordV1,
      keys: [
        'schemaVersion', 'memoryId', 'revision', 'namespace', 'namespaceRef',
        'namespaceGeneration', 'kind', 'text', 'sources', 'createdAt', 'observedAt',
        'confirmedAt', 'updatedAt', 'validity', 'confidence', 'consent', 'sensitivity',
        'conflict', 'supersedes', 'retention', 'deletionState', 'contentHash'
      ]
    },
    {
      value: memoryRevisionFixture(),
      encode: () => encodeMemoryRevisionV1(memoryRevisionFixture()),
      decode: decodeMemoryRevisionV1,
      keys: [
        'schemaVersion', 'memoryId', 'revision', 'operation', 'record',
        'changedByActorRef', 'changedAt', 'reason', 'previousRevisionHash', 'revisionHash'
      ]
    },
    {
      value: memoryTombstoneFixture(),
      encode: () => encodeMemoryTombstoneV1(memoryTombstoneFixture()),
      decode: decodeMemoryTombstoneV1,
      keys: [
        'schemaVersion', 'tombstoneId', 'namespaceRef', 'namespaceGeneration', 'memoryId',
        'deletedRevision', 'deletionKind', 'deletedAt', 'deletedByActorRef', 'reasonCode',
        'receiptHash', 'expiresAt'
      ]
    },
    {
      value: memoryOutboxEventFixture(),
      encode: () => encodeMemoryOutboxEventV1(memoryOutboxEventFixture()),
      decode: decodeMemoryOutboxEventV1,
      keys: [
        'schemaVersion', 'eventId', 'sequence', 'namespaceRef', 'namespaceGeneration',
        'aggregate', 'aggregateId', 'revision', 'eventKind', 'occurredAt', 'payloadHash'
      ]
    }
  ] as const

  for (const entry of cases) {
    const wire = entry.encode()
    assert.equal(wire, JSON.stringify(entry.value))
    assert.equal(wire.includes('\n'), false)
    assert.equal(wire.includes(': '), false)
    assert.deepEqual(Object.keys(JSON.parse(wire) as object), entry.keys)
    const decoded = entry.decode(wire)
    assert.deepEqual(decoded, entry.value)
    assertDeepFrozen(decoded)
  }
})

test('memory decode rejects semantically equal but byte-noncanonical JSON', () => {
  const source = memorySourceFixture()
  const canonical = encodeMemorySourceV1(source)
  const parsed = JSON.parse(canonical) as Record<string, unknown>
  const reordered = JSON.stringify({
    sourceId: parsed.sourceId,
    schemaVersion: parsed.schemaVersion,
    ...Object.fromEntries(Object.entries(parsed).filter(([key]) => (
      key !== 'sourceId' && key !== 'schemaVersion'
    )))
  })
  const duplicate = canonical.replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,')
  const escapedUnicode = canonical.replace('喜欢', '\\u559c\\u6b22')

  for (const raw of [
    ` ${canonical}`,
    `${canonical}\n`,
    JSON.stringify(source, null, 2),
    reordered,
    duplicate,
    escapedUnicode
  ]) assert.throws(() => decodeMemorySourceV1(raw), TypeError)

  const proposal = encodeMemoryProposalV1(memoryProposalFixture())
  assert.throws(() => decodeMemoryProposalV1(proposal.replace('"confidence":0.9', '"confidence":9e-1')), TypeError)
})

test('memory decode recomputes every object-level derived hash or reference', () => {
  const tamperedSourceContent = mutableCopy(memorySourceFixture()) as unknown as Record<string, unknown>
  tamperedSourceContent.contentHash = 'f'.repeat(64)
  const tamperedSourceId = mutableCopy(memorySourceFixture()) as unknown as Record<string, unknown>
  tamperedSourceId.sourceId = 'f'.repeat(64)
  const tamperedProposal = mutableCopy(memoryProposalFixture()) as unknown as Record<string, unknown>
  tamperedProposal.namespaceRef = 'f'.repeat(64)
  const tamperedTombstone = mutableCopy(memoryTombstoneFixture()) as unknown as Record<string, unknown>
  tamperedTombstone.receiptHash = 'f'.repeat(64)

  for (const [decode, value] of [
    [decodeMemorySourceV1, tamperedSourceContent],
    [decodeMemorySourceV1, tamperedSourceId],
    [decodeMemoryProposalV1, tamperedProposal],
    [decodeMemoryTombstoneV1, tamperedTombstone]
  ] as const) assert.throws(() => decode(JSON.stringify(value)), TypeError)
})

test('memory decoders reject malformed JSON, unknown major versions and raw byte overflow', () => {
  const cases: readonly [((raw: string) => unknown), string, number][] = [
    [decodeMemorySourceV1, encodeMemorySourceV1(memorySourceFixture()), MEMORY_RESOURCE_LIMITS.proposalWireBytes],
    [decodeMemoryProposalV1, encodeMemoryProposalV1(memoryProposalFixture()), MEMORY_RESOURCE_LIMITS.proposalWireBytes],
    [decodeMemoryRecordV1, encodeMemoryRecordV1(memoryRecordFixture()), MEMORY_RESOURCE_LIMITS.recordWireBytes],
    [decodeMemoryRevisionV1, encodeMemoryRevisionV1(memoryRevisionFixture()), MEMORY_RESOURCE_LIMITS.revisionWireBytes],
    [decodeMemoryTombstoneV1, encodeMemoryTombstoneV1(memoryTombstoneFixture()), MEMORY_RESOURCE_LIMITS.tombstoneWireBytes],
    [decodeMemoryOutboxEventV1, encodeMemoryOutboxEventV1(memoryOutboxEventFixture()), MEMORY_RESOURCE_LIMITS.outboxEventWireBytes]
  ]
  for (const [decode, wire, limit] of cases) {
    assert.throws(() => decode('{'), TypeError)
    assert.throws(() => decode(' '.repeat(limit + 1)), TypeError)
    assert.throws(() => decode(wire.replace('"schemaVersion":1', '"schemaVersion":2')), TypeError)
  }
})

test('memory domain parsers reject accessors, proxies, hidden keys, symbols and sparse arrays without invoking code', () => {
  let traps = 0
  const source = mutableCopy(memorySourceFixture()) as unknown as Record<string | symbol, unknown>
  Object.defineProperty(source, 'normalizedText', {
    enumerable: true,
    get: () => {
      traps += 1
      throw new Error('fixture-secret')
    }
  })
  assert.throws(() => parseMemorySourceV1(source), TypeError)
  assert.equal(traps, 0)

  const proxy = new Proxy(mutableCopy(memoryRecordFixture()), {
    get: () => {
      traps += 1
      throw new Error('fixture-secret')
    },
    ownKeys: () => {
      traps += 1
      throw new Error('fixture-secret')
    }
  })
  assert.equal(utilTypes.isProxy(proxy), true)
  assert.throws(() => parseMemoryRecordV1(proxy), TypeError)
  assert.equal(traps, 0)

  const hidden = mutableCopy(memoryProposalFixture()) as unknown as Record<string, unknown>
  Object.defineProperty(hidden, 'hidden', { value: '秘密', enumerable: false })
  assert.throws(() => parseMemoryProposalV1(hidden), TypeError)

  const symbolic = mutableCopy(memoryRevisionFixture()) as unknown as Record<string | symbol, unknown>
  symbolic[Symbol('secret')] = true
  assert.throws(() => parseMemoryRevisionV1(symbolic), TypeError)

  const sparse: unknown[] = []
  sparse.length = 1
  const sparseRecord = mutableCopy(memoryRecordFixture()) as unknown as Record<string, unknown>
  sparseRecord.sources = sparse
  assert.throws(() => parseMemoryRecordV1(sparseRecord), TypeError)

  const cyclic = mutableCopy(memoryOutboxEventFixture()) as unknown as Record<string, unknown>
  cyclic.aggregateId = cyclic
  assert.throws(() => parseMemoryOutboxEventV1(cyclic), TypeError)
})

test('memory text and source budgets are enforced without truncation', () => {
  const recordAtCodePointLimit = memoryRecordFixture({ text: 'a'.repeat(2_000) })
  const recordAtByteLimit = memoryRecordFixture({ text: '😀'.repeat(1_024) })
  assert.equal(parseMemoryRecordV1(recordAtCodePointLimit).text, 'a'.repeat(2_000))
  assert.equal(parseMemoryRecordV1(recordAtByteLimit).text, '😀'.repeat(1_024))

  for (const invalid of [
    memoryRecordFixture({ text: 'a'.repeat(2_001) }),
    memoryRecordFixture({ text: `${'😀'.repeat(1_024)}a` }),
    memoryRecordFixture({ text: 'e\u0301' }),
    memoryRecordFixture({ text: '\ud800' }),
    memoryRecordFixture({ text: '\u200b\u2060' }),
    memorySourceFixture({ normalizedText: 'a'.repeat(1_025) }),
    memorySourceFixture({ normalizedText: 'e\u0301' }),
    memorySourceFixture({ normalizedText: '\udc00' }),
    memorySourceFixture({ normalizedText: '\u0000\u200b' })
  ]) {
    const parse = Object.hasOwn(invalid, 'memoryId') ? parseMemoryRecordV1 : parseMemorySourceV1
    assert.throws(() => parse(invalid), TypeError)
  }
  assert.throws(() => parseMemoryRevisionV1(memoryRevisionFixture({
    reason: '\u200b\u2060'
  })), TypeError)
})

test('record, proposal and revision codecs enforce canonical wire ceilings', () => {
  const baseSources = Array.from({ length: MEMORY_RESOURCE_LIMITS.sources }, (_, index) => (
    memorySourceFixture({
      messageId: `message-${index + 1}`,
      normalizedText: 's'.repeat(MEMORY_RESOURCE_LIMITS.sourceExcerptUtf8Bytes)
    })
  ))
  const oversizedRecord = memoryRecordFixture({
    text: '😀'.repeat(1_024),
    sources: baseSources
  })
  assert.throws(() => encodeMemoryRecordV1(oversizedRecord), TypeError)

  const baseRecordWire = encodeMemoryRecordV1(memoryRecordFixture())
  const baseProposalWire = encodeMemoryProposalV1(memoryProposalFixture())
  const baseRevisionWire = encodeMemoryRevisionV1(memoryRevisionFixture())
  assert.equal(Buffer.byteLength(baseRecordWire, 'utf8') <= MEMORY_RESOURCE_LIMITS.recordWireBytes, true)
  assert.equal(Buffer.byteLength(baseProposalWire, 'utf8') <= MEMORY_RESOURCE_LIMITS.proposalWireBytes, true)
  assert.equal(Buffer.byteLength(baseRevisionWire, 'utf8') <= MEMORY_RESOURCE_LIMITS.revisionWireBytes, true)
})

test('body-free tombstone and outbox wires never contain canonical memory content or QQ provenance', () => {
  const source = memorySourceFixture()
  const forbidden = [
    source.normalizedText,
    source.actor.userId,
    source.actor.nickname,
    source.scene.groupName,
    source.contentHash,
    memoryRecordFixture().contentHash,
    memoryRevisionFixture().revisionHash
  ].filter((value): value is string => typeof value === 'string')

  for (const wire of [
    encodeMemoryTombstoneV1(memoryTombstoneFixture()),
    encodeMemoryOutboxEventV1(memoryOutboxEventFixture())
  ]) {
    for (const secret of forbidden) assert.equal(wire.includes(secret), false)
  }
})

test('memory codec failures expose fixed categories without echoing content or QQ identifiers', () => {
  const secretText = '不应出现在错误里的内容'
  const invalid = {
    ...memoryRecordFixture({ text: secretText }),
    contentHash: 'f'.repeat(64)
  }
  let error: unknown
  try {
    parseMemoryRecordV1(invalid)
  } catch (cause) {
    error = cause
  }
  assert.ok(error instanceof TypeError)
  assert.equal(error.message.includes(secretText), false)
  assert.equal(error.message.includes(FIXTURE_IDS.subjectUserId), false)
  assert.equal(error.message.includes(FIXTURE_IDS.groupId), false)
})
