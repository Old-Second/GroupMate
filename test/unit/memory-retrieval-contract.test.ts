import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2,
  NoopMemoryRetrieverV2,
  parseMemoryRetrievalRequestV2,
  parseMemoryRetrievalResultV2,
  retrieveMemoryV2,
  type MemoryRetrievalAdapterV2,
  type MemoryRetrievalRequestV2
} from '../../src/agent/memory/memory-retrieval.js'

const NOW = '2026-07-25T00:00:00.000Z'
const DEADLINE = '2026-07-25T00:00:00.150Z'
const BOT_ID = 'groupmate-test'
const ACCOUNT_ID = '10000'
const USER_ID = '70001'
const OTHER_USER_ID = '70002'
const MEMORY_ID = `memory:${'1'.repeat(64)}`
const REVISION_HASH = '2'.repeat(64)
const SOURCE_ID = `source:${'3'.repeat(64)}`

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function namespace (userId = USER_ID) {
  return createMemoryNamespaceV1({
    botInstanceId: BOT_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    scope: { kind: 'personal', subjectUserId: userId }
  })
}

function capability (...userIds: readonly string[]) {
  const issuer = createMemoryAccessCapabilityIssuerV1(() => true)
  return issueMemoryAccessCapabilityV1(
    issuer,
    {
      schemaVersion: 1,
      botInstanceId: BOT_ID,
      adapter: 'qq',
      accountId: ACCOUNT_ID,
      scene: { kind: 'private', peerUserId: USER_ID }
    },
    userIds.map(namespace),
    NOW
  )
}

function requestDraft (): MemoryRetrievalRequestV2 {
  const namespaceRef = memoryNamespaceRefV1(namespace())
  return deepFreeze({
    schemaVersion: 2,
    capability: capability(USER_ID),
    subjects: [{ namespaceRef, reason: 'current_actor' }],
    query: {
      text: '我上次说喜欢什么咖啡？',
      languageHint: 'zh-CN'
    },
    limits: {
      maxCandidates: 6,
      maxTokens: 1_200,
      maxBytes: 32 * 1_024
    },
    requestedAt: NOW,
    deadlineAt: DEADLINE
  })
}

function completedResult () {
  const namespaceRef = memoryNamespaceRefV1(namespace())
  return deepFreeze({
    schemaVersion: 2,
    status: 'completed',
    mode: 'lexical',
    candidates: [{
      schemaVersion: 2,
      memoryId: MEMORY_ID,
      revision: 2,
      revisionHash: REVISION_HASH,
      namespaceRef,
      kind: 'preference',
      text: '用户喜欢喝不加糖的拿铁。',
      createdAt: '2026-07-01T00:00:00.000Z',
      observedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      validUntil: '2027-07-20T00:00:00.000Z',
      confidence: 0.95,
      sensitivity: 'personal',
      conflict: 'none',
      consent: 'explicit',
      estimatedTokens: 20,
      sources: [{
        schemaVersion: 1,
        sourceId: SOURCE_ID,
        sourceKind: 'current_message',
        messageId: 'message-1',
        actor: {
          userId: USER_ID,
          displayName: '测试用户'
        },
        scene: {
          kind: 'private'
        },
        observedAt: '2026-07-01T00:00:00.000Z'
      }],
      ranking: {
        exactMatch: false,
        lexicalRank: 1,
        vectorRank: null,
        rerankRank: null,
        fusedRank: 1
      }
    }],
    index: {
      lexical: 'fresh',
      vector: 'disabled',
      watermark: '42'
    }
  })
}

function invocation (signal?: AbortSignal) {
  return {
    ...(signal === undefined ? {} : { signal }),
    now: () => new Date(NOW)
  }
}

test('V2 retrieval request requires an issued capability for every exact namespace', () => {
  const parsed = parseMemoryRetrievalRequestV2(requestDraft())
  assert.deepEqual(parsed, requestDraft())
  assert.notEqual(parsed, requestDraft())
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.subjects), true)
  assert.equal(Object.isFrozen(parsed.query), true)
  assert.equal(Object.isFrozen(parsed.limits), true)

  const otherNamespaceRef = memoryNamespaceRefV1(namespace(OTHER_USER_ID))
  assert.throws(() => parseMemoryRetrievalRequestV2(deepFreeze({
    ...requestDraft(),
    subjects: [{ namespaceRef: otherNamespaceRef, reason: 'mentioned_actor' }]
  })), TypeError)
  assert.throws(() => parseMemoryRetrievalRequestV2(deepFreeze({
    ...requestDraft(),
    capability: deepFreeze({ ...requestDraft().capability })
  })), TypeError)
  assert.throws(() => parseMemoryRetrievalRequestV2(deepFreeze({
    ...requestDraft(),
    subjects: [
      requestDraft().subjects[0],
      requestDraft().subjects[0]
    ]
  })), TypeError)
})

test('V2 retrieval request freezes query, subject and deadline resource limits', () => {
  assert.equal(MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects, 4)
  assert.equal(MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates, 12)
  assert.equal(MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxTokens, 2_400)
  assert.equal(MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxBytes, 64 * 1_024)
  assert.equal(MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxDurationMs, 500)

  for (const invalid of [
    { query: { text: '', languageHint: 'zh-CN' } },
    { query: { text: 'x'.repeat(4_097), languageHint: null } },
    { query: { text: 'ok', languageHint: 'not a locale!' } },
    { limits: { maxCandidates: 13, maxTokens: 1_200, maxBytes: 32 * 1_024 } },
    { limits: { maxCandidates: 6, maxTokens: 2_401, maxBytes: 32 * 1_024 } },
    { limits: { maxCandidates: 6, maxTokens: 1_200, maxBytes: 64 * 1_024 + 1 } },
    { deadlineAt: '2026-07-25T00:00:00.501Z' },
    { deadlineAt: NOW }
  ]) {
    assert.throws(() => parseMemoryRetrievalRequestV2(deepFreeze({
      ...requestDraft(),
      ...invalid
    })), TypeError)
  }
})

test('V2 completed result is detached, deeply frozen and carries bounded provenance', () => {
  const parsed = parseMemoryRetrievalResultV2(completedResult())
  assert.deepEqual(parsed, completedResult())
  assert.notEqual(parsed, completedResult())
  assert.equal(parsed.status, 'completed')
  if (parsed.status !== 'completed') assert.fail('expected completed result')
  assert.equal(Object.isFrozen(parsed.candidates), true)
  assert.equal(Object.isFrozen(parsed.candidates[0]?.sources), true)
  assert.equal(Object.isFrozen(parsed.candidates[0]?.ranking), true)
  assert.equal(parsed.candidates[0]?.sources[0]?.actor.displayName, '测试用户')

  assert.throws(() => parseMemoryRetrievalResultV2(deepFreeze({
    ...completedResult(),
    candidates: [{
      ...completedResult().candidates[0],
      text: 'x'.repeat(4_097)
    }]
  })), TypeError)
  assert.throws(() => parseMemoryRetrievalResultV2(deepFreeze({
    ...completedResult(),
    candidates: [{
      ...completedResult().candidates[0],
      revisionHash: 'not-a-hash'
    }]
  })), TypeError)
})

test('V2 retrieval result rejects proxies without invoking hostile traps', () => {
  let traps = 0
  const hostile = new Proxy(completedResult(), {
    get: () => { traps += 1; throw new Error('secret') },
    ownKeys: () => { traps += 1; throw new Error('secret') }
  })
  assert.throws(() => parseMemoryRetrievalResultV2(hostile), TypeError)
  assert.equal(traps, 0)
})

test('safe retrieval normalizes adapter failures and rejects scope or budget drift', async () => {
  const request = parseMemoryRetrievalRequestV2(requestDraft())
  const completed: MemoryRetrievalAdapterV2 = {
    retrieve: async () => completedResult()
  }
  assert.deepEqual(await retrieveMemoryV2(completed, request, invocation()), completedResult())

  const unavailable = await retrieveMemoryV2({
    retrieve: async () => { throw new Error('provider body must not escape') }
  }, request, invocation())
  assert.deepEqual(unavailable, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'adapter_unavailable'
  })

  const malformed = await retrieveMemoryV2({
    retrieve: async () => ({ ...completedResult(), unknown: 'secret' })
  }, request, invocation())
  assert.deepEqual(malformed, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'adapter_invalid'
  })

  const wrongNamespace = memoryNamespaceRefV1(namespace(OTHER_USER_ID))
  const drifted = await retrieveMemoryV2({
    retrieve: async () => deepFreeze({
      ...completedResult(),
      candidates: [{ ...completedResult().candidates[0], namespaceRef: wrongNamespace }]
    })
  }, request, invocation())
  assert.deepEqual(drifted, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'adapter_invalid'
  })

  const overBudget = await retrieveMemoryV2({
    retrieve: async () => deepFreeze({
      ...completedResult(),
      candidates: [{
        ...completedResult().candidates[0],
        estimatedTokens: request.limits.maxTokens + 1
      }]
    })
  }, request, invocation())
  assert.deepEqual(overBudget, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'adapter_invalid'
  })
})

test('safe retrieval propagates cancellation and Noop retriever is a frozen kill switch', async () => {
  const request = parseMemoryRetrievalRequestV2(requestDraft())
  const noop = new NoopMemoryRetrieverV2()
  assert.deepEqual(await retrieveMemoryV2(noop, request, invocation()), {
    schemaVersion: 2,
    status: 'completed',
    mode: 'none',
    candidates: [],
    index: { lexical: 'disabled', vector: 'disabled', watermark: null }
  })
  assert.equal('save' in noop, false)

  const controller = new AbortController()
  const adapter: MemoryRetrievalAdapterV2 = {
    retrieve: async (_request, signal) => await new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(
        new DOMException('operation aborted', 'AbortError')
      ), { once: true })
      setImmediate(() => resolve(completedResult()))
    })
  }
  const pending = retrieveMemoryV2(adapter, request, invocation(controller.signal))
  controller.abort()
  await assert.rejects(pending, (error: unknown) => (
    error instanceof DOMException && error.name === 'AbortError'
  ))

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(
    retrieveMemoryV2(noop, request, invocation(alreadyAborted.signal)),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  )
})

test('safe retrieval rechecks trusted time and capability before and after dispatch', async () => {
  const request = parseMemoryRetrievalRequestV2(requestDraft())
  let dispatches = 0
  const adapter: MemoryRetrievalAdapterV2 = {
    retrieve: async () => {
      dispatches += 1
      return completedResult()
    }
  }
  const expired = await retrieveMemoryV2(adapter, request, {
    now: () => new Date('2026-07-25T00:00:00.151Z')
  })
  assert.deepEqual(expired, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'deadline_exceeded'
  })
  assert.equal(dispatches, 0)

  const times = [NOW, '2026-07-25T00:00:00.151Z']
  const late = await retrieveMemoryV2(adapter, request, {
    now: () => new Date(times.shift() ?? DEADLINE)
  })
  assert.deepEqual(late, {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'deadline_exceeded'
  })
  assert.equal(dispatches, 1)

  const beforeCapability = await retrieveMemoryV2(adapter, request, {
    now: () => new Date('2026-07-24T23:59:59.999Z')
  })
  assert.deepEqual(beforeCapability, {
    schemaVersion: 2,
    status: 'denied',
    reason: 'capability_invalid'
  })
  assert.equal(dispatches, 1)
})
