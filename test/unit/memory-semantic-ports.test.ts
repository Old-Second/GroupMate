import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryEmbedderPortV1,
  createMemoryRerankerPortV1,
  createMemoryVectorIndexPortV1
} from '../../src/agent/memory/memory-semantic-ports.js'
import {
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NAMESPACE_REF = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
const MODEL_VERSION = 'fixture-embedding-v1'
const MEMORY_ID = `memory:${'1'.repeat(64)}`
const REVISION_HASH = '2'.repeat(64)

test('semantic ports freeze bounded model-versioned embedding vector and rerank contracts', async () => {
  const embedder = createMemoryEmbedderPortV1({
    embed: async request => ({
      status: 'completed',
      modelVersion: request.modelVersion,
      dimensions: request.dimensions,
      vectors: request.texts.map((_, index) => [index + 0.25, index + 0.75])
    })
  })
  assert.deepEqual(await embedder.embed({
    purpose: 'query',
    modelVersion: MODEL_VERSION,
    dimensions: 2,
    texts: ['火锅']
  }), {
    status: 'completed',
    modelVersion: MODEL_VERSION,
    dimensions: 2,
    vectors: [[0.25, 0.75]]
  })

  const vectorIndex = createMemoryVectorIndexPortV1({
    search: async request => ({
      status: 'completed',
      state: 'fresh',
      modelVersion: request.modelVersion,
      dimensions: request.dimensions,
      watermark: '17',
      hits: [{
        namespaceRef: NAMESPACE_REF,
        namespaceGeneration: 1,
        memoryId: MEMORY_ID,
        memoryRevision: 1,
        revisionHash: REVISION_HASH,
        vectorRank: 1,
        distance: 0.125
      }]
    })
  })
  const vectorResult = await vectorIndex.search({
    namespaceRefs: [NAMESPACE_REF],
    modelVersion: MODEL_VERSION,
    dimensions: 2,
    queryVector: [0.25, 0.75],
    maxHits: 4
  })
  assert.equal(vectorResult.status, 'completed')
  if (vectorResult.status !== 'completed') assert.fail('expected vector result')
  assert.equal(vectorResult.hits[0]?.memoryId, MEMORY_ID)
  assert.ok(Object.isFrozen(vectorResult.hits[0]))

  const reranker = createMemoryRerankerPortV1({
    rerank: async request => ({
      status: 'completed',
      modelVersion: request.modelVersion,
      rankedCandidateIds: [...request.candidates].reverse().map(item => item.candidateId)
    })
  })
  assert.deepEqual(await reranker.rerank({
    modelVersion: 'fixture-reranker-v1',
    queryText: '喜欢什么',
    candidates: [
      { candidateId: MEMORY_ID, text: '喜欢火锅' },
      { candidateId: `memory:${'3'.repeat(64)}`, text: '喜欢寿司' }
    ]
  }), {
    status: 'completed',
    modelVersion: 'fixture-reranker-v1',
    rankedCandidateIds: [`memory:${'3'.repeat(64)}`, MEMORY_ID]
  })
})

test('semantic ports fail closed on model dimension payload drift without retaining text', async () => {
  let vectorCalls = 0
  const embedder = createMemoryEmbedderPortV1({
    embed: async () => ({
      status: 'completed',
      modelVersion: 'wrong-version',
      dimensions: 2,
      vectors: [[0, 1]]
    })
  })
  assert.deepEqual(await embedder.embed({
    purpose: 'query', modelVersion: MODEL_VERSION, dimensions: 2, texts: ['secret text']
  }), { status: 'unavailable' })

  const vectorIndex = createMemoryVectorIndexPortV1({
    search: async () => {
      vectorCalls += 1
      return {
        status: 'completed',
        state: 'fresh',
        modelVersion: MODEL_VERSION,
        dimensions: 2,
        watermark: null,
        hits: [{
          namespaceRef: NAMESPACE_REF,
          namespaceGeneration: 1,
          memoryId: MEMORY_ID,
          memoryRevision: 1,
          revisionHash: REVISION_HASH,
          vectorRank: 1,
          distance: Number.NaN,
          text: 'must never be accepted'
        }]
      }
    }
  })
  assert.deepEqual(await vectorIndex.search({
    namespaceRefs: [NAMESPACE_REF],
    modelVersion: MODEL_VERSION,
    dimensions: 2,
    queryVector: [0, 1],
    maxHits: 1
  }), { status: 'unavailable' })
  assert.equal(vectorCalls, 1)

  const reranker = createMemoryRerankerPortV1({
    rerank: async () => ({
      status: 'completed',
      modelVersion: 'wrong-version',
      rankedCandidateIds: [MEMORY_ID]
    })
  })
  assert.deepEqual(await reranker.rerank({
    modelVersion: 'fixture-reranker-v1',
    queryText: 'query',
    candidates: [{ candidateId: MEMORY_ID, text: 'value' }]
  }), { status: 'unavailable' })

  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await vectorIndex.search({
    namespaceRefs: [NAMESPACE_REF],
    modelVersion: MODEL_VERSION,
    dimensions: 2,
    queryVector: [0, 1],
    maxHits: 1
  }, controller.signal), { status: 'aborted' })
  assert.equal(vectorCalls, 1)
})
