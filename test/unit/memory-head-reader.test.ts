import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryHeadSourcePortV1,
  createMemoryReadThroughV1,
  type MemoryHeadSourceRequestV1,
  type MemoryHeadSourceResultV1
} from '../../src/agent/memory/memory-head-reader.js'
import { createMemoryHotCachePortV1 } from '../../src/agent/memory/memory-hot-cache.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memoryRecordFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

function head (revision = 1) {
  const record = memoryRecordFixture({ revision })
  return deepFreezeFixture({
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: record.revision,
    contentHash: record.contentHash
  })
}

function capability () {
  const namespace = personalMemoryNamespaceFixture()
  return issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    deepFreezeFixture({
      schemaVersion: 1,
      botInstanceId: FIXTURE_IDS.botInstanceId,
      adapter: 'qq',
      accountId: FIXTURE_IDS.accountId,
      scene: deepFreezeFixture({
        kind: 'private',
        peerUserId: FIXTURE_IDS.subjectUserId
      })
    }),
    [namespace],
    FIXTURE_TIMES.observedAt
  )
}

function readRequest (accessCapability: unknown = capability ()) {
  const record = memoryRecordFixture()
  return deepFreezeFixture({
    schemaVersion: 1,
    capability: accessCapability,
    namespaceRef: record.namespaceRef,
    memoryId: record.memoryId
  })
}

test('canonical head source accepts only the three exact body-safe operations', async () => {
  const record = memoryRecordFixture()
  const seen: MemoryHeadSourceRequestV1[] = []
  const source = createMemoryHeadSourcePortV1({
    execute: async request => {
      seen.push(request)
      if (request.operation === 'namespace.get') {
        return { status: 'found', namespaceGeneration: 1 }
      }
      if (request.operation === 'head.get') return { status: 'found', head: head() }
      return { status: 'found', record }
    }
  })

  assert.deepEqual(await source.execute({
    schemaVersion: 1,
    operation: 'namespace.get',
    namespaceRef: record.namespaceRef
  }), { status: 'found', namespaceGeneration: 1 })
  assert.deepEqual(await source.execute({
    schemaVersion: 1,
    operation: 'head.get',
    namespaceRef: record.namespaceRef,
    memoryId: record.memoryId
  }), { status: 'found', head: head() })
  assert.deepEqual(await source.execute({
    schemaVersion: 1,
    operation: 'record.getExact',
    head: head()
  }), { status: 'found', record })
  assert.deepEqual(seen.map(value => value.operation), [
    'namespace.get', 'head.get', 'record.getExact'
  ])
  assert.equal(seen.every(Object.isFrozen), true)
})

test('canonical head source rejects hostile requests and options without invoking accessors', async t => {
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'schemaVersion', {
    enumerable: true,
    get () {
      getterCalls += 1
      return 1
    }
  })
  assert.throws(() => createMemoryHeadSourcePortV1(new Proxy({
    execute: async () => ({ status: 'not_found' })
  }, {})), TypeError)
  const source = createMemoryHeadSourcePortV1({
    execute: async () => ({ status: 'not_found' })
  })
  for (const [index, request] of [
    null,
    hostile,
    new Proxy({ schemaVersion: 1, operation: 'namespace.get', namespaceRef: head().namespaceRef }, {}),
    { schemaVersion: 1, operation: 'namespace.get', namespaceRef: head().namespaceRef, extra: true },
    { schemaVersion: 1, operation: 'head.get', namespaceRef: head().namespaceRef },
    { schemaVersion: 1, operation: 'record.getExact', head: { ...head(), extra: true } }
  ].entries()) {
    await t.test(String(index), async () => {
      await assert.rejects(source.execute(request), TypeError)
    })
  }
  assert.equal(getterCalls, 0)
})

test('canonical head source validates operation-specific results and hides adapter failures', async () => {
  const request = {
    schemaVersion: 1,
    operation: 'head.get',
    namespaceRef: head().namespaceRef,
    memoryId: head().memoryId
  }
  const malformedValues: readonly unknown[] = [
    { status: 'found', namespaceGeneration: 1 },
    { status: 'found', head: { ...head(), contentHash: 'bad' } },
    { status: 'absent' },
    { status: 'expired', head: head(), extra: memoryRecordFixture().text },
    new Proxy({ status: 'not_found' }, {})
  ]
  for (const value of malformedValues) {
    const source = createMemoryHeadSourcePortV1({ execute: async () => value })
    assert.deepEqual(await source.execute(request), {
      status: 'corrupt',
      category: 'adapter_contract'
    })
  }
  const throwing = createMemoryHeadSourcePortV1({
    execute: async () => { throw new Error(memoryRecordFixture().text) }
  })
  assert.deepEqual(await throwing.execute(request), {
    status: 'unavailable',
    category: 'io',
    retryable: true
  })
})

test('canonical head source preserves proven absent and expired metadata', async () => {
  const record = memoryRecordFixture()
  for (const expected of [
    { status: 'absent', namespaceGeneration: 2 },
    { status: 'expired', head: head() }
  ] as const) {
    const source = createMemoryHeadSourcePortV1({ execute: async () => expected })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: record.namespaceRef,
      memoryId: record.memoryId
    }), expected)
  }
})

test('canonical head source overrides a late adapter success after caller abort', async () => {
  let release: (() => void) | undefined
  const source = createMemoryHeadSourcePortV1({
    execute: async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { status: 'found', head: head() }
    }
  })
  const controller = new AbortController()
  const pending = source.execute({
    schemaVersion: 1,
    operation: 'head.get',
    namespaceRef: head().namespaceRef,
    memoryId: head().memoryId
  }, controller.signal)
  while (release === undefined) await Promise.resolve()
  controller.abort()
  release()
  assert.deepEqual(await pending, { status: 'aborted' })
})

test('canonical head source overrides a late adapter rejection after caller abort', async () => {
  let rejectAdapter: ((reason: Error) => void) | undefined
  const source = createMemoryHeadSourcePortV1({
    execute: async () => await new Promise((resolve, reject) => {
      rejectAdapter = reject
    })
  })
  const controller = new AbortController()
  const pending = source.execute({
    schemaVersion: 1,
    operation: 'head.get',
    namespaceRef: head().namespaceRef,
    memoryId: head().memoryId
  }, controller.signal)
  while (rejectAdapter === undefined) await Promise.resolve()
  controller.abort()
  rejectAdapter(new Error(memoryRecordFixture().text))
  assert.deepEqual(await pending, { status: 'aborted' })
})

test('read-through denies an unissued capability before canonical or cache access', async () => {
  let sourceCalls = 0
  let cacheCalls = 0
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source: createMemoryHeadSourcePortV1({
      execute: async () => {
        sourceCalls += 1
        return { status: 'not_found' }
      }
    }),
    cache: createMemoryHotCachePortV1({
      execute: async () => {
        cacheCalls += 1
        return { status: 'unavailable' }
      }
    })
  })

  assert.deepEqual(await service.execute(readRequest({})), { status: 'denied' })
  assert.equal(sourceCalls, 0)
  assert.equal(cacheCalls, 0)
})

test('read-through returns a hot hit only after a stable canonical recheck', async () => {
  const record = memoryRecordFixture()
  let sourceCalls = 0
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source: createMemoryHeadSourcePortV1({
      execute: async request => {
        assert.equal(request.operation, 'head.get')
        sourceCalls += 1
        return { status: 'found', head: head() }
      }
    }),
    cache: createMemoryHotCachePortV1({
      execute: async request => {
        assert.equal(request.operation, 'record.get')
        return { status: 'hit', record }
      }
    })
  })

  assert.deepEqual(await service.execute(readRequest()), {
    status: 'found',
    source: 'hot',
    record
  })
  assert.equal(sourceCalls, 2)
})

test('read-through revalidates capability freshness before releasing a record', async () => {
  const record = memoryRecordFixture()
  const times = [
    FIXTURE_TIMES.observedAt,
    new Date(Date.parse(FIXTURE_TIMES.observedAt) + 60_001).toISOString()
  ]
  const service = createMemoryReadThroughV1({
    now: () => times.shift() ?? times[0]!,
    source: createMemoryHeadSourcePortV1({
      execute: async () => ({ status: 'found', head: head() })
    }),
    cache: createMemoryHotCachePortV1({
      execute: async () => ({ status: 'hit', record })
    })
  })

  assert.deepEqual(await service.execute(readRequest()), { status: 'denied' })
})

test('read-through revalidates capability before a changed-head replan', async () => {
  const times = [
    FIXTURE_TIMES.observedAt,
    new Date(Date.parse(FIXTURE_TIMES.observedAt) + 60_001).toISOString()
  ]
  let sourceCalls = 0
  const service = createMemoryReadThroughV1({
    now: () => times.shift() ?? FIXTURE_TIMES.observedAt,
    source: createMemoryHeadSourcePortV1({
      execute: async request => {
        sourceCalls += 1
        return request.operation === 'head.get'
          ? { status: 'found', head: head() }
          : { status: 'stale' }
      }
    }),
    cache: createMemoryHotCachePortV1({
      execute: async request => request.operation === 'record.get'
        ? { status: 'miss', reason: 'not_found' }
        : { status: 'unavailable' }
    })
  })

  assert.deepEqual(await service.execute(readRequest()), { status: 'denied' })
  assert.equal(sourceCalls, 2)
})

test('read-through falls back to canonical and best-effort refills without trusting Redis', async () => {
  const record = memoryRecordFixture()
  const cacheOperations: string[] = []
  for (const cacheGet of [
    { status: 'miss', reason: 'corrupt' },
    { status: 'unavailable' }
  ] as const) {
    const source = createMemoryHeadSourcePortV1({
      execute: async request => request.operation === 'record.getExact'
        ? { status: 'found', record }
        : { status: 'found', head: head() }
    })
    const cache = createMemoryHotCachePortV1({
      execute: async request => {
        cacheOperations.push(request.operation)
        if (request.operation === 'record.get') return cacheGet
        return { status: 'skipped', reason: 'capacity' }
      }
    })
    const service = createMemoryReadThroughV1({
      now: () => FIXTURE_TIMES.observedAt,
      source,
      cache
    })
    assert.deepEqual(await service.execute(readRequest()), {
      status: 'found',
      source: 'canonical',
      record
    })
  }
  assert.deepEqual(cacheOperations, [
    'record.get', 'record.put', 'record.get', 'record.put'
  ])
})

test('read-through replans once on a changed head and then returns the new exact record', async () => {
  const first = memoryRecordFixture()
  const second = memoryRecordFixture({ revision: 2 })
  const firstHead = head(1)
  const secondHead = head(2)
  const heads = [firstHead, secondHead, secondHead]
  const source = createMemoryHeadSourcePortV1({
    execute: async request => {
      if (request.operation === 'head.get') {
        const value = heads.shift()
        assert.ok(value)
        return { status: 'found', head: value }
      }
      if (request.operation !== 'record.getExact') return { status: 'not_found' }
      return request.head.revision === 1
        ? { status: 'stale' }
        : { status: 'found', record: second }
    }
  })
  const cache = createMemoryHotCachePortV1({
    execute: async request => request.operation === 'record.get'
      ? { status: 'miss', reason: 'not_found' }
      : { status: 'stored' }
  })
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source,
    cache
  })

  assert.deepEqual(await service.execute(readRequest()), {
    status: 'found',
    source: 'canonical',
    record: second
  })
  assert.notDeepEqual(first.contentHash, second.contentHash)
})

test('read-through returns conflict after a second canonical head change', async () => {
  const records = [1, 2].map(revision => memoryRecordFixture({ revision }))
  const heads = [head(1), head(2), head(2), head(3)]
  let getIndex = 0
  const source = createMemoryHeadSourcePortV1({
    execute: async request => {
      assert.equal(request.operation, 'head.get')
      const value = heads.shift()
      assert.ok(value)
      return { status: 'found', head: value }
    }
  })
  const cache = createMemoryHotCachePortV1({
    execute: async request => {
      assert.equal(request.operation, 'record.get')
      const record = records[getIndex++]
      assert.ok(record)
      return { status: 'hit', record }
    }
  })
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source,
    cache
  })

  assert.deepEqual(await service.execute(readRequest()), { status: 'conflict' })
})

test('read-through preserves canonical terminal states and explicit abort', async () => {
  const canonicalResults: readonly MemoryHeadSourceResultV1[] = [
    { status: 'not_found' },
    { status: 'absent', namespaceGeneration: 1 },
    { status: 'expired', head: head() },
    { status: 'corrupt', category: 'canonical_data' },
    { status: 'unavailable', category: 'busy', retryable: true }
  ]
  for (const canonical of canonicalResults) {
    const service = createMemoryReadThroughV1({
      now: () => FIXTURE_TIMES.observedAt,
      source: createMemoryHeadSourcePortV1({ execute: async () => canonical }),
      cache: createMemoryHotCachePortV1({ execute: async () => ({ status: 'unavailable' }) })
    })
    const result = await service.execute(readRequest())
    if (canonical.status === 'not_found' || canonical.status === 'absent' ||
      canonical.status === 'expired') {
      assert.deepEqual(result, { status: 'not_found' })
    } else {
      assert.deepEqual(result, canonical)
    }
  }

  const controller = new AbortController()
  controller.abort()
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source: createMemoryHeadSourcePortV1({ execute: async () => ({ status: 'not_found' }) }),
    cache: createMemoryHotCachePortV1({ execute: async () => ({ status: 'unavailable' }) })
  })
  assert.deepEqual(await service.execute(readRequest(), controller.signal), { status: 'aborted' })
})

test('read-through rejects hostile requests and exact option violations', async () => {
  const source = createMemoryHeadSourcePortV1({ execute: async () => ({ status: 'not_found' }) })
  const cache = createMemoryHotCachePortV1({ execute: async () => ({ status: 'unavailable' }) })
  assert.throws(() => createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source,
    cache,
    extra: true
  } as never), TypeError)
  const service = createMemoryReadThroughV1({
    now: () => FIXTURE_TIMES.observedAt,
    source,
    cache
  })
  await assert.rejects(service.execute({ ...readRequest(), extra: true }), TypeError)
  await assert.rejects(service.execute(new Proxy(readRequest(), {})), TypeError)
})
