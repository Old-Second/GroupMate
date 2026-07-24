import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import { createLexicalMemoryRetrieverV2 } from '../../src/agent/memory/memory-lexical-retriever.js'
import { normalizeMemoryLexicalTextV1 } from '../../src/agent/memory/memory-lexical-normalizer.js'
import { retrieveMemoryV2 } from '../../src/agent/memory/memory-retrieval.js'
import { openSqliteMemoryLexicalDatabaseV1 } from '../../src/agent/memory/sqlite-memory-lexical-database.js'
import { createSqliteMemoryLexicalIndexV1 } from '../../src/agent/memory/sqlite-memory-lexical-index.js'
import { createSqliteMemoryCanonicalRehydratorV1 } from '../../src/agent/memory/sqlite-memory-canonical-rehydrator.js'
import {
  FIXTURE_IDS,
  deepFreezeFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memorySourceFixture,
  memoryTombstoneFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'
import {
  createSqliteMemoryRepositoryHarnessV1,
  recordCorrectRequestV1,
  recordCreateRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

const NOW = '2026-07-25T00:00:00.000Z'
const DEADLINE = '2026-07-25T00:00:00.150Z'
const PINYIN_TRANSLITERATOR = Object.freeze({
  aliases: (text: string) => text.includes('火锅') ? ['huoguo', 'huo guo'] : []
})

function revision (
  digit: string,
  text: string,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const memoryId = `memory:${digit.repeat(64)}`
  const record = memoryRecordFixture({ memoryId, text, ...overrides })
  return memoryRevisionFixture({ memoryId, record, changedAt: record.updatedAt })
}

function request (harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>, text: string, limits = {
  maxCandidates: 12,
  maxTokens: 2_400,
  maxBytes: 64 * 1_024
}) {
  return deepFreezeFixture({
    schemaVersion: 2,
    capability: harness.capability,
    subjects: [{ namespaceRef: harness.namespaceRef, reason: 'current_actor' }],
    query: { text, languageHint: 'zh-CN' },
    limits,
    requestedAt: NOW,
    deadlineAt: DEADLINE
  })
}

test('lexical retriever rehydrates canonical heads and filters stale, conflict and wrong-speaker hits', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const lexicalStore = openSqliteMemoryLexicalDatabaseV1({
    location: ':memory:', now: () => NOW
  })
  const index = createSqliteMemoryLexicalIndexV1({
    database: lexicalStore.database,
    transliterator: PINYIN_TRANSLITERATOR
  })
  const exact = revision('1', '喜欢火锅')
  const broad = revision('2', '周末和群友吃火锅', { confidence: 0.99 })
  const confirmedConflict = revision('3', '火锅店在群附近', {
    conflict: deepFreezeFixture({
      state: 'confirmed',
      relatedMemoryIds: [exact.record.memoryId],
      note: '待确认'
    })
  })
  const wrongSpeakerSource = memorySourceFixture({
    actor: qqIdentityFixture({
      userId: FIXTURE_IDS.secondUserId,
      nickname: '其他群友',
      groupCard: '其他群友',
      displayName: '其他群友'
    })
  })
  const wrongSpeaker = revision('4', '火锅要特辣', {
    sources: deepFreezeFixture([wrongSpeakerSource]),
    consent: deepFreezeFixture({
      ...memoryRecordFixture().consent,
      evidenceSourceId: wrongSpeakerSource.sourceId
    })
  })
  const stale = revision('5', '以前喜欢火锅')
  const staleCorrectionRecord = memoryRecordFixture({
    memoryId: stale.record.memoryId,
    revision: 2,
    text: '现在喜欢寿司',
    updatedAt: '2026-07-24T00:00:00.000Z'
  })
  const staleCorrection = memoryRevisionFixture({
    memoryId: stale.record.memoryId,
    revision: 2,
    operation: 'corrected',
    record: staleCorrectionRecord,
    changedAt: staleCorrectionRecord.updatedAt,
    reason: '用户更正',
    previousRevisionHash: stale.revisionHash
  })
  const deleted = revision('6', '已经删除的火锅偏好')
  const emoji = revision('7', '🔥 代表超辣火锅')
  const expired = revision('9', '已经过期的火锅偏好', {
    retention: deepFreezeFixture({
      validUntil: NOW,
      purgeAt: '2026-08-24T00:00:00.000Z'
    })
  })
  try {
    for (const item of [
      exact, broad, confirmedConflict, wrongSpeaker, stale, deleted, emoji, expired
    ]) {
      const result = await harness.repository.execute(recordCreateRequestV1(harness, item))
      assert.equal(result.status, 'stored')
    }
    const corrected = await harness.repository.execute(
      recordCorrectRequestV1(harness, staleCorrection)
    )
    assert.equal(corrected.status, 'stored')
    const forgotten = await harness.repository.execute({
      schemaVersion: 1,
      operation: 'record.forget',
      capability: harness.capability,
      namespaceRef: harness.namespaceRef,
      expectedRevision: 1,
      expectedNamespaceGeneration: 1,
      tombstone: memoryTombstoneFixture({
        memoryId: deleted.record.memoryId,
        deletedRevision: 1
      })
    })
    assert.equal(forgotten.status, 'stored')

    index.replaceProjection({
      projectionGeneration: 1,
      sourceLastSequence: 50,
      updatedAt: NOW,
      documents: [exact, broad, confirmedConflict, wrongSpeaker, stale, deleted, emoji]
        .map(item => ({ record: item.record, revisionHash: item.revisionHash }))
    })
    const retriever = createLexicalMemoryRetrieverV2({
      index,
      canonical: createSqliteMemoryCanonicalRehydratorV1({
        database: harness.store.database,
        now: () => NOW
      }),
      now: () => NOW,
      transliterator: PINYIN_TRANSLITERATOR
    })
    const result = await retrieveMemoryV2(retriever, request(harness, '喜欢火锅'), {
      now: () => new Date(NOW)
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected completed retrieval')
    assert.deepEqual(result.candidates.map(candidate => candidate.memoryId), [
      exact.record.memoryId,
      broad.record.memoryId,
      emoji.record.memoryId
    ])
    assert.equal(result.candidates[0]?.ranking.exactMatch, true)
    assert.deepEqual(result.candidates.map(candidate => candidate.ranking.fusedRank), [1, 2, 3])
    assert.ok(result.candidates.every(candidate => candidate.conflict === 'none'))
    assert.ok(result.candidates.every(candidate => (
      candidate.sources.every(source => source.actor.userId === FIXTURE_IDS.subjectUserId)
    )))
    assert.equal(result.index.watermark, '50')

    const pinyin = await retrieveMemoryV2(retriever, request(harness, 'huoguo'), {
      now: () => new Date(NOW)
    })
    assert.equal(pinyin.status, 'completed')
    if (pinyin.status !== 'completed') assert.fail('expected pinyin retrieval')
    assert.ok(pinyin.candidates.some(candidate => candidate.memoryId === exact.record.memoryId))

    const emojiResult = await retrieveMemoryV2(retriever, request(harness, '🔥'), {
      now: () => new Date(NOW)
    })
    assert.equal(emojiResult.status, 'completed')
    if (emojiResult.status !== 'completed') assert.fail('expected emoji retrieval')
    assert.equal(emojiResult.candidates[0]?.memoryId, emoji.record.memoryId)

    const budgeted = await retrieveMemoryV2(retriever, request(harness, '火锅', {
      maxCandidates: 1, maxTokens: 1, maxBytes: 1_024
    }), { now: () => new Date(NOW) })
    assert.equal(budgeted.status, 'completed')
    if (budgeted.status !== 'completed') assert.fail('expected budgeted retrieval')
    assert.deepEqual(budgeted.candidates, [])

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(retrieveMemoryV2(
      retriever,
      request(harness, '火锅'),
      { signal: controller.signal, now: () => new Date(NOW) }
    ), error => error instanceof DOMException && error.name === 'AbortError')

    const tamperedBody = normalizeMemoryLexicalTextV1('tampered').body
    lexicalStore.database.prepare(`
      UPDATE lexical_documents SET body = ?, body_bytes = ? WHERE memory_id = ?
    `).run(
      tamperedBody,
      Buffer.byteLength(tamperedBody, 'utf8'),
      exact.record.memoryId
    )
    const tampered = await retrieveMemoryV2(retriever, request(harness, 'tampered'), {
      now: () => new Date(NOW)
    })
    assert.equal(tampered.status, 'completed')
    if (tampered.status !== 'completed') assert.fail('expected tamper-safe retrieval')
    assert.deepEqual(tampered.candidates, [])
  } finally {
    lexicalStore.close()
    harness.close()
  }
})

test('lexical retriever never searches a different personal namespace and fails open on index loss', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const lexicalStore = openSqliteMemoryLexicalDatabaseV1({ location: ':memory:', now: () => NOW })
  const index = createSqliteMemoryLexicalIndexV1({ database: lexicalStore.database })
  const otherNamespace = createMemoryNamespaceV1({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scope: { kind: 'personal', subjectUserId: FIXTURE_IDS.secondUserId }
  })
  const otherSource = memorySourceFixture({
    actor: qqIdentityFixture({ userId: FIXTURE_IDS.secondUserId })
  })
  const baseConsent = memoryRecordFixture().consent
  const other = revision('8', '喜欢火锅', {
    namespace: otherNamespace,
    namespaceRef: memoryNamespaceRefV1(otherNamespace),
    sources: [otherSource],
    consent: {
      ...baseConsent,
      evidenceSourceId: otherSource.sourceId
    }
  })
  index.replaceProjection({
    projectionGeneration: 1,
    sourceLastSequence: 1,
    updatedAt: NOW,
    documents: [{ record: other.record, revisionHash: other.revisionHash }]
  })
  const retriever = createLexicalMemoryRetrieverV2({
    index,
    canonical: createSqliteMemoryCanonicalRehydratorV1({
      database: harness.store.database, now: () => NOW
    }),
    now: () => NOW
  })
  try {
    const isolated = await retrieveMemoryV2(retriever, request(harness, '火锅'), {
      now: () => new Date(NOW)
    })
    assert.equal(isolated.status, 'completed')
    if (isolated.status !== 'completed') assert.fail('expected isolated retrieval')
    assert.deepEqual(isolated.candidates, [])

    lexicalStore.close()
    assert.deepEqual(await retrieveMemoryV2(retriever, request(harness, '火锅'), {
      now: () => new Date(NOW)
    }), {
      schemaVersion: 2,
      status: 'unavailable',
      reason: 'index_unavailable'
    })
  } finally {
    harness.close()
  }
})
