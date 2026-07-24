import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryLexicalDatabaseV1 } from '../../src/agent/memory/sqlite-memory-lexical-database.js'
import {
  createSqliteMemoryLexicalIndexV1,
  MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1
} from '../../src/agent/memory/sqlite-memory-lexical-index.js'
import {
  FIXTURE_TIMES,
  memoryRecordFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T00:00:00.000Z'
const SECOND_NAMESPACE = 'f'.repeat(64)

function revision (memoryDigit: string, text: string) {
  const memoryId = `memory:${memoryDigit.repeat(64)}`
  const record = memoryRecordFixture({ memoryId, text })
  return memoryRevisionFixture({
    memoryId,
    record,
    changedAt: record.updatedAt
  })
}

test('SQLite lexical index projects bounded tokens and returns exact and BM25 evidence separately', async () => {
  const store = openSqliteMemoryLexicalDatabaseV1({ location: ':memory:', now: () => NOW })
  const index = createSqliteMemoryLexicalIndexV1({
    database: store.database,
    transliterator: Object.freeze({
      aliases: (text: string) => text.includes('火锅') ? ['huoguo', 'huo guo'] : []
    })
  })
  const exact = revision('1', '喜欢火锅')
  const broad = revision('2', '周末和群友一起吃火锅')
  try {
    index.replaceProjection({
      projectionGeneration: 1,
      sourceLastSequence: 42,
      updatedAt: NOW,
      documents: [
        { record: broad.record, revisionHash: broad.revisionHash },
        { record: exact.record, revisionHash: exact.revisionHash }
      ]
    })

    const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
    const result = await index.search({
      namespaceRefs: [namespaceRef],
      queryText: '喜欢火锅',
      maxHits: 12
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected completed lexical search')
    assert.equal(result.state, 'fresh')
    assert.equal(result.watermark, '42')
    assert.equal(result.hits.length, 2)
    assert.equal(result.hits[0]?.memoryId, exact.record.memoryId)
    assert.equal(result.hits[0]?.exactMatch, true)
    assert.deepEqual(result.hits.map(hit => hit.lexicalRank), [1, 2])
    assert.ok(result.hits.every(hit => Number.isFinite(hit.bm25)))

    const pinyin = await index.search({
      namespaceRefs: [namespaceRef],
      queryText: 'huoguo',
      maxHits: 12
    })
    assert.equal(pinyin.status, 'completed')
    if (pinyin.status !== 'completed') assert.fail('expected pinyin lexical search')
    assert.deepEqual(new Set(pinyin.hits.map(hit => hit.memoryId)), new Set([
      exact.record.memoryId,
      broad.record.memoryId
    ]))

    const isolated = await index.search({
      namespaceRefs: [SECOND_NAMESPACE as never],
      queryText: '火锅',
      maxHits: 12
    })
    assert.equal(isolated.status, 'completed')
    if (isolated.status !== 'completed') assert.fail('expected isolated search')
    assert.deepEqual(isolated.hits, [])

    assert.deepEqual({ ...store.database.prepare(`
      SELECT status, projection_generation, source_last_sequence,
        indexed_records
      FROM lexical_index_state WHERE singleton = 1
    `).get() }, {
      status: 'ready',
      projection_generation: 1,
      source_last_sequence: 42,
      indexed_records: 2
    })
  } finally {
    store.close()
  }
})

test('SQLite lexical index replacement is atomic and search is abort/failure safe', async () => {
  const store = openSqliteMemoryLexicalDatabaseV1({ location: ':memory:', now: () => NOW })
  const index = createSqliteMemoryLexicalIndexV1({ database: store.database })
  const item = revision('3', '🔥 火锅 TypeScript')
  const punctuation = revision('4', '!!!')
  const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  try {
    assert.equal(MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1, 32)
    index.replaceProjection({
      projectionGeneration: 1,
      sourceLastSequence: 1,
      updatedAt: FIXTURE_TIMES.updatedAt,
      documents: [{ record: item.record, revisionHash: item.revisionHash }]
    })
    assert.throws(() => index.replaceProjection({
      projectionGeneration: 2,
      sourceLastSequence: 2,
      updatedAt: NOW,
      documents: [
        { record: item.record, revisionHash: item.revisionHash },
        { record: item.record, revisionHash: item.revisionHash }
      ]
    }), TypeError)
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM lexical_documents')
      .get()?.count, 1)
    assert.throws(() => index.replaceProjection({
      projectionGeneration: 1,
      sourceLastSequence: 2,
      updatedAt: NOW,
      documents: []
    }), TypeError)
    index.replaceProjection({
      projectionGeneration: 2,
      sourceLastSequence: 2,
      updatedAt: NOW,
      documents: [
        { record: item.record, revisionHash: item.revisionHash },
        { record: punctuation.record, revisionHash: punctuation.revisionHash }
      ]
    })
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM lexical_documents')
      .get()?.count, 1)
    index.beginProjection({
      projectionGeneration: 3,
      sourceLastSequence: 0,
      updatedAt: NOW
    })
    index.applyProjectionBatch({
      projectionGeneration: 3,
      sourceLastSequence: 3,
      updatedAt: NOW,
      documents: [{ record: item.record, revisionHash: item.revisionHash }]
    })
    assert.equal(store.database.prepare(`
      SELECT status FROM lexical_index_state WHERE singleton = 1
    `).get()?.status, 'rebuilding')
    index.completeProjection({
      projectionGeneration: 3,
      sourceLastSequence: 3,
      updatedAt: NOW
    })
    assert.deepEqual({ ...store.database.prepare(`
      SELECT status, projection_generation, source_last_sequence, indexed_records
      FROM lexical_index_state WHERE singleton = 1
    `).get() }, {
      status: 'ready',
      projection_generation: 3,
      source_last_sequence: 3,
      indexed_records: 1
    })

    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await index.search({
      namespaceRefs: [namespaceRef], queryText: '🔥', maxHits: 1
    }, controller.signal), { status: 'aborted' })
  } finally {
    store.close()
  }

  assert.deepEqual(await index.search({
    namespaceRefs: [namespaceRef], queryText: '火锅', maxHits: 1
  }), { status: 'unavailable' })
})
