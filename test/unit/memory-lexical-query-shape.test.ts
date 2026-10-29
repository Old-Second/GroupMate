import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import { normalizeMemoryLexicalTextV1 } from '../../src/agent/memory/memory-lexical-normalizer.js'
import {
  MEMORY_LEXICAL_QUERY_SHAPE_V1,
  memoryLexicalBoundedMatchV1
} from '../../src/agent/memory/memory-lexical-query-shape.js'
import { openSqliteMemoryLexicalDatabaseV1 } from '../../src/agent/memory/sqlite-memory-lexical-database.js'
import {
  createSqliteMemoryLexicalIndexV1,
  MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1
} from '../../src/agent/memory/sqlite-memory-lexical-index.js'
import {
  memoryRecordFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-10-29T00:00:00.000Z'

function document (index: number, text: string) {
  const memoryId = `memory:${index.toString(16).padStart(64, '0')}`
  const record = memoryRecordFixture({ memoryId, text })
  const revision = memoryRevisionFixture({ memoryId, record, changedAt: record.updatedAt })
  return { record: revision.record, revisionHash: revision.revisionHash }
}

test('词法 MATCH 保留全部 token，直到某个 token 覆盖接近全库', () => {
  const tokens = ['我', '的', '忌口', '香菜']
  const frequencies = new Map([['我', 60], ['的', 40], ['忌口', 2], ['香菜', 1]])
  assert.equal(
    memoryLexicalBoundedMatchV1(tokens, frequencies, 100),
    '"我" OR "的" OR "忌口" OR "香菜"')
})

test('词法 MATCH 剔除文档频次超阈值的 token，并保持原有 token 顺序', () => {
  const tokens = ['我', '的', '忌口', '香菜']
  const frequencies = new Map([['我', 4_000], ['的', 3_500], ['忌口', 12], ['香菜', 3]])
  assert.equal(memoryLexicalBoundedMatchV1(tokens, frequencies, 4_096), '"忌口" OR "香菜"')
})

test('词法 MATCH 在全部 token 都超阈值时保留最稀有的若干个', () => {
  const tokens = ['我', '的', '是', '什么', '吗']
  const frequencies = new Map([
    ['我', 4_000], ['的', 3_900], ['是', 3_800], ['什么', 3_700], ['吗', 3_600]])
  assert.equal(MEMORY_LEXICAL_QUERY_SHAPE_V1.retainedRarestTokens, 4)
  assert.equal(
    memoryLexicalBoundedMatchV1(tokens, frequencies, 4_096),
    '"的" OR "是" OR "什么" OR "吗"')
})

test('词法 MATCH 保留索引里不存在的 token，它们没有扫描代价', () => {
  const tokens = ['我', '黑咖啡']
  const frequencies = new Map([['我', 4_000]])
  assert.equal(memoryLexicalBoundedMatchV1(tokens, frequencies, 4_096), '"黑咖啡"')
})

test('大库词法检索剔除近全库 token，只返回有区分度的记录', async () => {
  const store = openSqliteMemoryLexicalDatabaseV1({ location: ':memory:', now: () => NOW })
  const index = createSqliteMemoryLexicalIndexV1({ database: store.database })
  try {
    const documents = [document(1, '我的忌口是香菜')]
    // 填充记录只通过「我」「是」与查询共词：这两个 token 覆盖全库，应被剔除。
    for (let serial = 2; serial <= 101; serial += 1) {
      documents.push(document(serial, `我是编号${serial.toString(36)}`))
    }
    index.beginProjection({ projectionGeneration: 1, sourceLastSequence: 0, updatedAt: NOW })
    for (let offset = 0; offset < documents.length;
      offset += MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1) {
      index.applyProjectionBatch({
        projectionGeneration: 1,
        sourceLastSequence: offset + 1,
        updatedAt: NOW,
        documents: documents.slice(offset, offset + MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1)
      })
    }
    index.completeProjection({
      projectionGeneration: 1, sourceLastSequence: documents.length, updatedAt: NOW })
    const result = await index.search({
      namespaceRefs: [memoryNamespaceRefV1(personalMemoryNamespaceFixture())],
      queryText: '我的忌口是什么',
      maxHits: 24
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected completed lexical search')
    assert.deepEqual(result.hits.map(hit => hit.memoryId), [documents[0]!.record.memoryId])
  } finally {
    store.close()
  }
})

test('小库词法检索不剔除任何 token，匹配集合与归一化查询一致', async () => {
  const store = openSqliteMemoryLexicalDatabaseV1({ location: ':memory:', now: () => NOW })
  const index = createSqliteMemoryLexicalIndexV1({ database: store.database })
  try {
    const documents = [document(1, '我的忌口是香菜'), document(2, '我是夜猫子')]
    index.replaceProjection({
      projectionGeneration: 1,
      sourceLastSequence: 2,
      updatedAt: NOW,
      documents
    })
    const result = await index.search({
      namespaceRefs: [memoryNamespaceRefV1(personalMemoryNamespaceFixture())],
      queryText: '我的忌口是什么',
      maxHits: 24
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected completed lexical search')
    assert.deepEqual(new Set(result.hits.map(hit => hit.memoryId)), new Set(
      documents.map(entry => entry.record.memoryId)))
    assert.equal(normalizeMemoryLexicalTextV1('我的忌口是什么').tokens.includes('我'), true)
  } finally {
    store.close()
  }
})
