import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MemoryCanonicalRehydratorV1 } from '../../src/agent/memory/memory-canonical-rehydrator.js'
import {
  createHybridMemoryRetrieverV2
} from '../../src/agent/memory/memory-hybrid-retriever.js'
import {
  createMemoryEmbedderPortV1,
  createMemoryRerankerPortV1,
  createMemoryVectorIndexPortV1
} from '../../src/agent/memory/memory-semantic-ports.js'
import type {
  MemoryRetrievalAdapterV2,
  MemoryRetrievalCandidateV2,
  MemoryRetrievalRequestV2
} from '../../src/agent/memory/memory-retrieval.js'
import { retrieveMemoryV2 } from '../../src/agent/memory/memory-retrieval.js'
import type { MemoryRecordV1, MemoryRevisionV1 } from '../../src/agent/memory/memory-domain.js'
import {
  deepFreezeFixture,
  memoryRecordFixture,
  memoryRevisionFixture
} from '../helpers/memory-fixture.js'
import {
  createSqliteMemoryRepositoryHarnessV1
} from '../helpers/sqlite-memory-repository-fixture.js'

const NOW = '2026-07-25T00:00:00.000Z'
const DEADLINE = '2026-07-25T00:00:00.150Z'
const EMBEDDING_MODEL = 'fixture-embedding-v1'

function revision (digit: string, text: string): MemoryRevisionV1 {
  const memoryId = `memory:${digit.repeat(64)}`
  const record = memoryRecordFixture({ memoryId, text })
  return memoryRevisionFixture({ memoryId, record, changedAt: record.updatedAt })
}

function candidate (item: MemoryRevisionV1, lexicalRank: number): MemoryRetrievalCandidateV2 {
  const record = item.record as MemoryRecordV1
  const sources = record.sources.map(source => deepFreezeFixture({
    schemaVersion: 1,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    messageId: source.messageId,
    actor: {
      userId: source.actor.userId,
      displayName: source.actor.displayName
    },
    scene: source.scene.kind === 'private'
      ? { kind: 'private' }
      : {
          kind: 'group',
          groupId: source.scene.groupId,
          groupLifecycleId: source.scene.groupLifecycleId,
          groupName: source.scene.groupName
        },
    observedAt: source.observedAt
  }))
  return deepFreezeFixture({
    schemaVersion: 2,
    memoryId: record.memoryId,
    revision: record.revision,
    revisionHash: item.revisionHash,
    namespaceRef: record.namespaceRef,
    kind: record.kind,
    text: record.text,
    createdAt: record.createdAt,
    observedAt: record.observedAt,
    updatedAt: record.updatedAt,
    validUntil: record.retention.validUntil,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    conflict: record.conflict.state,
    consent: record.consent.state,
    estimatedTokens: Math.max(1, Math.ceil(Buffer.byteLength(record.text, 'utf8') / 3)),
    sources,
    ranking: {
      exactMatch: false,
      lexicalRank,
      vectorRank: null,
      rerankRank: null,
      fusedRank: lexicalRank
    }
  }) as MemoryRetrievalCandidateV2
}

function request (
  harness: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>,
  limits = { maxCandidates: 12, maxTokens: 2_400, maxBytes: 64 * 1_024 }
): MemoryRetrievalRequestV2 {
  return deepFreezeFixture({
    schemaVersion: 2,
    capability: harness.capability,
    subjects: [{ namespaceRef: harness.namespaceRef, reason: 'current_actor' }],
    query: { text: '晚饭吃什么', languageHint: 'zh-CN' },
    limits,
    requestedAt: NOW,
    deadlineAt: DEADLINE
  }) as MemoryRetrievalRequestV2
}

function lexicalAdapter (
  candidates: readonly MemoryRetrievalCandidateV2[],
  calls: { value: number }
): MemoryRetrievalAdapterV2 {
  return Object.freeze({
    retrieve: async () => {
      calls.value += 1
      return deepFreezeFixture({
        schemaVersion: 2,
        status: 'completed',
        mode: 'lexical',
        candidates,
        index: { lexical: 'fresh', vector: 'disabled', watermark: '9' }
      })
    }
  })
}

function canonicalFor (
  values: readonly MemoryRevisionV1[],
  stale = new Set<string>()
): MemoryCanonicalRehydratorV1 {
  const records = new Map(values.map(value => [value.record?.memoryId, value]))
  return Object.freeze({
    rehydrate: async (value: unknown) => {
      const identity = (value as { identity: { memoryId: string } }).identity
      if (stale.has(identity.memoryId)) return Object.freeze({ status: 'stale' as const })
      const item = records.get(identity.memoryId)
      return item?.record === null || item?.record === undefined
        ? Object.freeze({ status: 'stale' as const })
        : Object.freeze({
            status: 'found' as const,
            record: item.record,
            revisionHash: item.revisionHash
          })
    }
  })
}

test('hybrid retriever RRF-fuses lexical and canonical vector hits with optional reranking', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const shared = revision('1', '喜欢火锅')
  const vectorOnly = revision('2', '经常吃寿司')
  const lexicalCalls = { value: 0 }
  let embeddingCalls = 0
  let vectorCalls = 0
  let rerankCalls = 0
  const retriever = createHybridMemoryRetrieverV2({
    lexical: lexicalAdapter([candidate(shared, 1)], lexicalCalls),
    canonical: canonicalFor([shared, vectorOnly]),
    embedder: createMemoryEmbedderPortV1({
      embed: async request => {
        embeddingCalls += 1
        return {
          status: 'completed',
          modelVersion: request.modelVersion,
          dimensions: request.dimensions,
          vectors: [[0.25, 0.75]]
        }
      }
    }),
    vectorIndex: createMemoryVectorIndexPortV1({
      search: async request => {
        vectorCalls += 1
        return {
          status: 'completed',
          state: 'fresh',
          modelVersion: request.modelVersion,
          dimensions: request.dimensions,
          watermark: '9',
          hits: [shared, vectorOnly].map((item, index) => ({
            namespaceRef: harness.namespaceRef,
            namespaceGeneration: 1,
            memoryId: item.memoryId,
            memoryRevision: item.revision,
            revisionHash: item.revisionHash,
            vectorRank: index + 1,
            distance: index / 10
          }))
        }
      }
    }),
    reranker: createMemoryRerankerPortV1({
      rerank: async request => {
        rerankCalls += 1
        return {
          status: 'completed',
          modelVersion: request.modelVersion,
          rankedCandidateIds: request.candidates.map(item => item.candidateId).reverse()
        }
      }
    }),
    semantic: {
      enabled: true,
      embeddingModelVersion: EMBEDDING_MODEL,
      embeddingDimensions: 2,
      rerankModelVersion: 'fixture-reranker-v1'
    },
    now: () => NOW
  })
  try {
    const result = await retrieveMemoryV2(retriever, request(harness), {
      now: () => new Date(NOW)
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected hybrid retrieval')
    assert.equal(result.mode, 'hybrid')
    assert.equal(result.index.vector, 'fresh')
    assert.equal(result.index.watermark, '9')
    assert.deepEqual(result.candidates.map(value => value.memoryId), [
      shared.memoryId,
      vectorOnly.memoryId
    ])
    assert.deepEqual(result.candidates.map(value => value.ranking.fusedRank), [1, 2])
    assert.equal(result.candidates[0]?.ranking.lexicalRank, 1)
    assert.equal(result.candidates[0]?.ranking.vectorRank, 1)
    assert.equal(result.candidates[1]?.ranking.rerankRank, 1)
    assert.deepEqual(
      { lexical: lexicalCalls.value, embeddingCalls, vectorCalls, rerankCalls },
      { lexical: 1, embeddingCalls: 1, vectorCalls: 1, rerankCalls: 1 }
    )
  } finally {
    harness.close()
  }
})

test('hybrid retriever keeps egress off and falls back to lexical on vector outage', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const lexical = revision('3', '喜欢面条')
  const lexicalCalls = { value: 0 }
  let egressCalls = 0
  const embedder = createMemoryEmbedderPortV1({
    embed: async () => {
      egressCalls += 1
      return { status: 'unavailable' }
    }
  })
  const vectorIndex = createMemoryVectorIndexPortV1({
    search: async () => {
      egressCalls += 1
      return { status: 'unavailable' }
    }
  })
  try {
    const disabled = createHybridMemoryRetrieverV2({
      lexical: lexicalAdapter([candidate(lexical, 1)], lexicalCalls),
      canonical: canonicalFor([lexical]),
      semantic: { enabled: false },
      now: () => NOW
    })
    const disabledResult = await retrieveMemoryV2(disabled, request(harness), {
      now: () => new Date(NOW)
    })
    assert.equal(disabledResult.status, 'completed')
    if (disabledResult.status !== 'completed') assert.fail('expected lexical retrieval')
    assert.equal(disabledResult.index.vector, 'disabled')
    assert.equal(egressCalls, 0)

    const unavailable = createHybridMemoryRetrieverV2({
      lexical: lexicalAdapter([candidate(lexical, 1)], lexicalCalls),
      canonical: canonicalFor([lexical]),
      embedder,
      vectorIndex,
      semantic: {
        enabled: true,
        embeddingModelVersion: EMBEDDING_MODEL,
        embeddingDimensions: 2,
        rerankModelVersion: null
      },
      now: () => NOW
    })
    const unavailableResults = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      unavailableResults.push(await retrieveMemoryV2(unavailable, request(harness), {
        now: () => new Date(NOW)
      }))
    }
    const unavailableResult = unavailableResults[0]
    assert.equal(unavailableResult.status, 'completed')
    if (unavailableResult.status !== 'completed') assert.fail('expected lexical fallback')
    assert.equal(unavailableResult.mode, 'lexical')
    assert.equal(unavailableResult.index.vector, 'unavailable')
    assert.deepEqual(unavailableResult.candidates.map(value => value.memoryId), [lexical.memoryId])
    assert.ok(unavailableResults.every(result => result.status === 'completed'))
    assert.equal(egressCalls, 3)
  } finally {
    harness.close()
  }
})

test('hybrid retriever cannot resurrect a stale or deleted canonical vector hit', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const lexical = revision('4', '喜欢米饭')
  const deleted = revision('5', '已经删除的偏好')
  const lexicalCalls = { value: 0 }
  const retriever = createHybridMemoryRetrieverV2({
    lexical: lexicalAdapter([candidate(lexical, 1)], lexicalCalls),
    canonical: canonicalFor([lexical, deleted], new Set([deleted.memoryId])),
    embedder: createMemoryEmbedderPortV1({
      embed: async request => ({
        status: 'completed',
        modelVersion: request.modelVersion,
        dimensions: request.dimensions,
        vectors: [[0, 1]]
      })
    }),
    vectorIndex: createMemoryVectorIndexPortV1({
      search: async request => ({
        status: 'completed',
        state: 'stale',
        modelVersion: request.modelVersion,
        dimensions: request.dimensions,
        watermark: '8',
        hits: [{
          namespaceRef: harness.namespaceRef,
          namespaceGeneration: 1,
          memoryId: deleted.memoryId,
          memoryRevision: deleted.revision,
          revisionHash: deleted.revisionHash,
          vectorRank: 1,
          distance: 0
        }]
      })
    }),
    semantic: {
      enabled: true,
      embeddingModelVersion: EMBEDDING_MODEL,
      embeddingDimensions: 2,
      rerankModelVersion: null
    },
    now: () => NOW
  })
  try {
    const result = await retrieveMemoryV2(retriever, request(harness), {
      now: () => new Date(NOW)
    })
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected lexical fallback')
    assert.deepEqual(result.candidates.map(value => value.memoryId), [lexical.memoryId])
    assert.ok(result.candidates.every(value => value.memoryId !== deleted.memoryId))
    assert.equal(result.index.vector, 'stale')
  } finally {
    harness.close()
  }
})

test('hybrid retriever applies final budgets after fusion instead of truncating over-fetch', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1(':memory:', () => NOW)
  const oversized = revision('6', '很长'.repeat(40))
  const fitting = revision('7', '短')
  const lexicalCalls = { value: 0 }
  const retriever = createHybridMemoryRetrieverV2({
    lexical: lexicalAdapter([], lexicalCalls),
    canonical: canonicalFor([oversized, fitting]),
    embedder: createMemoryEmbedderPortV1({
      embed: async request => ({
        status: 'completed',
        modelVersion: request.modelVersion,
        dimensions: request.dimensions,
        vectors: [[1, 0]]
      })
    }),
    vectorIndex: createMemoryVectorIndexPortV1({
      search: async request => ({
        status: 'completed',
        state: 'fresh',
        modelVersion: request.modelVersion,
        dimensions: request.dimensions,
        watermark: '9',
        hits: [oversized, fitting].map((item, index) => ({
          namespaceRef: harness.namespaceRef,
          namespaceGeneration: 1,
          memoryId: item.memoryId,
          memoryRevision: item.revision,
          revisionHash: item.revisionHash,
          vectorRank: index + 1,
          distance: index
        }))
      })
    }),
    semantic: {
      enabled: true,
      embeddingModelVersion: EMBEDDING_MODEL,
      embeddingDimensions: 2,
      rerankModelVersion: null
    },
    now: () => NOW
  })
  try {
    const result = await retrieveMemoryV2(
      retriever,
      request(harness, { maxCandidates: 1, maxTokens: 1, maxBytes: 4 * 1_024 }),
      { now: () => new Date(NOW) }
    )
    assert.equal(result.status, 'completed')
    if (result.status !== 'completed') assert.fail('expected budgeted hybrid retrieval')
    assert.deepEqual(result.candidates.map(value => value.memoryId), [fitting.memoryId])
    assert.equal(result.candidates[0]?.ranking.vectorRank, 2)
  } finally {
    harness.close()
  }
})
