import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createContextArtifactV1,
  decodeContextArtifactV1,
  encodeContextArtifactV1,
  MAX_CONTEXT_ARTIFACT_BYTES,
  MAX_CONTEXT_ARTIFACT_CONTENT_BYTES,
  MAX_CONTEXT_ARTIFACT_REFS,
  type ContextArtifactDraftV1,
  type ContextArtifactV1
} from '../../src/agent/context/context-artifact.js'
import {
  type ContextArtifactStoreResult,
  type ContextArtifactStore
} from '../../src/agent/context/context-artifact-store.js'
import {
  CONTEXT_ARTIFACT_RESOURCE_LIMITS,
  contextArtifactNamespaceUsageWithinLimits
} from '../../src/agent/context/context-resource-limits.js'
import { CONTEXT_TOKEN_ESTIMATOR_VERSION } from '../../src/agent/context/context-token-estimator.js'
import {
  CONTEXT_ARTIFACT_METADATA_KEY,
  CONTEXT_ARTIFACT_STORE_LUA_MARKER,
  CONTEXT_ARTIFACT_STORE_LUA_SCRIPT,
  CONTEXT_ARTIFACT_STORE_NAMESPACE,
  RedisContextArtifactStore,
  redisContextArtifactKey
} from '../../src/agent/context/redis-context-artifact-store.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const NOW = Date.parse('2026-07-19T00:00:00.000Z')

class ReconcileConflictRedis extends FakeRedis {
  reconcileConflicts = 0

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (script.startsWith(CONTEXT_ARTIFACT_STORE_LUA_MARKER) && options.arguments[0] === 'reconcile') {
      this.reconcileConflicts += 1
      return 'conflict'
    }
    return await super.eval(script, options)
  }
}

class ReconcileIncompleteRedis extends FakeRedis {
  override async scan (_cursor: number, _options: { MATCH: string; COUNT: number }): Promise<{
    cursor: number
    keys: string[]
  }> {
    return { cursor: 1, keys: [] }
  }
}

class InvalidArtifactLuaRedis extends FakeRedis {
  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (script.startsWith(CONTEXT_ARTIFACT_STORE_LUA_MARKER) && options.arguments[0] === 'put') {
      return 'unexpected_reply'
    }
    return await super.eval(script, options)
  }
}

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

function artifact (marker = 'one'): ContextArtifactV1 {
  const sourceId = `span:source:${marker}`
  return createContextArtifactV1(deepFreeze({
    namespaceRef: 'namespace:fixture',
    generation: 7,
    kind: 'tool_digest' as const,
    sourceSpanIds: Object.freeze([sourceId]),
    sourceRefs: Object.freeze([{ ref: sourceId, contentHash: 'a'.repeat(64) }]),
    content: `digest:${marker}`,
    generator: Object.freeze({ kind: 'deterministic' as const, version: 'fixture-v1' }),
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
}

function artifactDraft (
  marker: string,
  content = `digest:${marker}`
): ContextArtifactDraftV1 {
  const sourceId = `span:wire:${marker}`
  return deepFreeze({
    namespaceRef: `namespace:wire:${marker}`,
    generation: 7,
    kind: 'tool_digest' as const,
    sourceSpanIds: [sourceId],
    sourceRefs: [{ ref: sourceId, contentHash: 'c'.repeat(64) }],
    content,
    generator: { kind: 'deterministic' as const, version: 'wire-boundary-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })
}

function artifactWithWireBytes (targetBytes: number, marker: string): ContextArtifactV1 {
  const fixedAscii = (value: string): string => `${value}${'x'.repeat(128)}`.slice(0, 128)
  const sourceIds = Array.from({ length: MAX_CONTEXT_ARTIFACT_REFS }, (_, index) => (
    fixedAscii(`source:${marker}:${index}:`)
  ))
  const contentBytes = 4_491 + targetBytes - MAX_CONTEXT_ARTIFACT_BYTES
  const contentPrefix = `wire:${marker}:`
  assert.equal(contentBytes > contentPrefix.length, true)
  return createContextArtifactV1(deepFreeze({
    namespaceRef: fixedAscii(`namespace:${marker}:`),
    generation: 7,
    kind: 'tool_digest' as const,
    sourceSpanIds: sourceIds,
    sourceRefs: sourceIds.map(ref => ({ ref, contentHash: 'c'.repeat(64) })),
    content: `${contentPrefix}${'c'.repeat(contentBytes - contentPrefix.length)}`,
    generator: { kind: 'deterministic' as const, version: fixedAscii('wire-boundary-v1:') },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
}

function store (redis: FakeRedis): ContextArtifactStore {
  return new RedisContextArtifactStore({ client: redis })
}

function readyArtifact (result: ContextArtifactStoreResult): ContextArtifactV1 {
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('expected ready artifact')
  return result.artifact
}

test('artifact codec has one strict canonical 16 KiB wire representation', () => {
  const source = artifact('codec')
  const encoded = encodeContextArtifactV1(source)
  assert.deepEqual(decodeContextArtifactV1(encoded), source)
  assert.notEqual(decodeContextArtifactV1(encoded), source)
  assert.throws(() => decodeContextArtifactV1(` ${encoded}`), TypeError)
  assert.throws(() => decodeContextArtifactV1(`${encoded} `), TypeError)
  assert.throws(() => decodeContextArtifactV1('x'.repeat(MAX_CONTEXT_ARTIFACT_BYTES + 1)), TypeError)
  assert.throws(() => decodeContextArtifactV1('{"__proto__":{"polluted":true}}'), TypeError)
})

test('artifact content and canonical wire enforce exact 8 KiB and 16 KiB boundaries', () => {
  const exactContent = 'c'.repeat(MAX_CONTEXT_ARTIFACT_CONTENT_BYTES)
  const contentArtifact = createContextArtifactV1(artifactDraft('content-exact', exactContent))
  assert.equal(Buffer.byteLength(contentArtifact.content, 'utf8'), MAX_CONTEXT_ARTIFACT_CONTENT_BYTES)
  assert.throws(() => createContextArtifactV1(artifactDraft('content-over', `${exactContent}x`)), TypeError)

  const exactWire = artifactWithWireBytes(MAX_CONTEXT_ARTIFACT_BYTES, 'wire-exact')
  const encoded = encodeContextArtifactV1(exactWire)
  assert.equal(Buffer.byteLength(encoded, 'utf8'), MAX_CONTEXT_ARTIFACT_BYTES)
  assert.deepEqual(decodeContextArtifactV1(encoded), exactWire)
  assert.throws(() => artifactWithWireBytes(MAX_CONTEXT_ARTIFACT_BYTES + 1, 'wire-over'), TypeError)
})

test('Redis artifact store uses an isolated accountable namespace and round-trips strict bytes', async () => {
  const redis = new FakeRedis(() => NOW)
  const repository = store(redis)
  const source = artifact('round-trip')
  const stored = await repository.putIfAbsent(source, NOW + 600_000)

  assert.deepEqual(readyArtifact(stored), source)
  assert.notEqual(readyArtifact(stored), source)
  assert.deepEqual(readyArtifact(await repository.get(source.artifactId)), source)
  assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 600)
  assert.equal(CONTEXT_ARTIFACT_STORE_NAMESPACE, 'GROUPMATE:CONTEXT_ARTIFACT:v1:')
  assert.equal(CONTEXT_ARTIFACT_METADATA_KEY, `${CONTEXT_ARTIFACT_STORE_NAMESPACE}namespace-budget`)
  const metadata = await redis.get(CONTEXT_ARTIFACT_METADATA_KEY)
  assert.match(metadata ?? '', /^1\|1\|\d+$/)
  assert.doesNotMatch(metadata ?? '', /digest|round-trip/)
  assert.equal(redis.evalCalls.every(call => call.marker === CONTEXT_ARTIFACT_STORE_LUA_MARKER), true)
  assert.doesNotMatch(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, /redis\.call\(['"](?:KEYS|WATCH|MULTI)['"]\)/)
})

test('putIfAbsent converges concurrent writers and verifies winner bytes before returning', async () => {
  const redis = new FakeRedis(() => NOW)
  const first = store(redis)
  const second = store(redis)
  const source = artifact('concurrent')
  const [left, right] = await Promise.all([
    first.putIfAbsent(source, NOW + 600_000),
    second.putIfAbsent(source, NOW + 900_000)
  ])
  assert.deepEqual(readyArtifact(left), source)
  assert.deepEqual(readyArtifact(right), source)
  assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 900)
  assert.equal(redis.evalCalls.filter(call => call.operation === 'put').length >= 2, true)

  const corruptRedis = new FakeRedis(() => NOW)
  const corruptStore = store(corruptRedis)
  readyArtifact(await corruptStore.putIfAbsent(artifact('corrupt-init'), NOW + 600_000))
  corruptRedis.afterNextArtifactEval(operation => {
    if (operation !== 'put') return false
    const raw = JSON.stringify(source)
    corruptRedis.seedArtifactForTest(
      redisContextArtifactKey(source.artifactId), ` ${raw}`, NOW + 600_000
    )
    return true
  })
  assert.deepEqual(await corruptStore.putIfAbsent(source, NOW + 600_000), {
    status: 'unavailable', code: 'artifact_corrupt'
  })
})

test('get and put fail closed on wrong key, hash, codec or noncanonical existing bytes', async () => {
  let now = NOW
  const redis = new FakeRedis(() => now)
  const repository = store(redis)
  const source = artifact('SECRET_BODY')
  const other = artifact('other')
  redis.seedArtifactForTest(redisContextArtifactKey(source.artifactId), JSON.stringify(other), now + 600_000)
  const wrongKey = await repository.get(source.artifactId)
  assert.deepEqual(wrongKey, { status: 'unavailable', code: 'artifact_corrupt' })
  assert.doesNotMatch(JSON.stringify(wrongKey), /SECRET_BODY|digest:other/)

  redis.seedArtifactForTest(redisContextArtifactKey(source.artifactId), JSON.stringify({
    ...source,
    tokenEstimate: source.tokenEstimate + 1
  }), now + 600_000)
  const corrupt = await repository.putIfAbsent(source, now + 600_000)
  assert.deepEqual(corrupt, { status: 'unavailable', code: 'artifact_corrupt' })
  assert.doesNotMatch(JSON.stringify(corrupt), /SECRET_BODY/)

  await redis.del(redisContextArtifactKey(source.artifactId))
  assert.deepEqual(await repository.get(source.artifactId), { status: 'missing' })
  redis.seedArtifactForTest(redisContextArtifactKey(source.artifactId), JSON.stringify(source), now + 1_000)
  now += 2_000
  assert.deepEqual(await repository.get(source.artifactId), { status: 'missing' })
})

test('oversized artifact values are rejected by bounded Lua read without body transport', async () => {
  const source = artifact('oversized-raw')
  const key = redisContextArtifactKey(source.artifactId)
  const secretRaw = `SECRET_OVERSIZED_ARTIFACT:${'x'.repeat(MAX_CONTEXT_ARTIFACT_BYTES + 1)}`
  const redis = new FakeRedis(() => NOW)
  redis.seedArtifactForTest(key, secretRaw, NOW + 600_000)
  const repository = store(redis)

  const direct = await repository.get(source.artifactId)
  assert.deepEqual(direct, { status: 'unavailable', code: 'artifact_corrupt' })
  assert.equal(redis.getCalls.includes(key), false)
  assert.doesNotMatch(JSON.stringify(direct), /SECRET_OVERSIZED_ARTIFACT/)

  const missing = artifact('oversized-raw-reconcile')
  const reconciled = await repository.get(missing.artifactId)
  assert.deepEqual(reconciled, { status: 'unavailable', code: 'artifact_corrupt' })
  assert.equal(redis.getCalls.includes(key), false)
  assert.equal(redis.evalCalls.some(call => call.operation === 'read'), true)
})

test('Redis failures are typed and never expose values or backend error text', async () => {
  const redis = new FakeRedis(() => NOW)
  const repository = store(redis)
  const key = redisContextArtifactKey(artifact('failure').artifactId)
  redis.failNextGet(key)
  const result = await repository.get(artifact('failure').artifactId)
  assert.deepEqual(result, { status: 'unavailable', code: 'redis_unavailable' })
  assert.doesNotMatch(JSON.stringify(result), /SECRET_BODY|redis failed/)
})

test('metadata and bounded reconcile failures keep distinct body-free store codes', async () => {
  const source = artifact('SECRET_RECONCILE_BODY')
  const conflictRedis = new ReconcileConflictRedis(() => NOW)
  assert.deepEqual(await store(conflictRedis).putIfAbsent(source, NOW + 600_000), {
    status: 'unavailable', code: 'reconcile_conflict'
  })
  assert.equal(conflictRedis.reconcileConflicts, CONTEXT_ARTIFACT_RESOURCE_LIMITS.maxMetadataCasAttempts)

  const incompleteRedis = new ReconcileIncompleteRedis(() => NOW)
  assert.deepEqual(await store(incompleteRedis).putIfAbsent(source, NOW + 600_000), {
    status: 'unavailable', code: 'reconcile_incomplete'
  })

  const invalidLuaRedis = new InvalidArtifactLuaRedis(() => NOW)
  const invalid = await store(invalidLuaRedis).putIfAbsent(source, NOW + 600_000)
  assert.deepEqual(invalid, { status: 'unavailable', code: 'metadata_corrupt' })
  assert.doesNotMatch(JSON.stringify(invalid), /SECRET_RECONCILE_BODY/)
})

test('bounded reconcile repairs missing, stale and corrupt body-free metadata', async () => {
  let now = NOW
  const redis = new FakeRedis(() => now)
  const first = artifact('existing')
  redis.seedArtifactForTest(redisContextArtifactKey(first.artifactId), JSON.stringify(first), now + 600_000)
  await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, 'SECRET_METADATA_BODY')
  const repository = store(redis)
  const second = artifact('new')
  assert.deepEqual(readyArtifact(await repository.putIfAbsent(second, now + 600_000)), second)
  const metadata = await redis.get(CONTEXT_ARTIFACT_METADATA_KEY)
  assert.match(metadata ?? '', /^1\|2\|\d+$/)
  assert.doesNotMatch(metadata ?? '', /SECRET|digest|existing|new/)
  assert.equal(redis.scanCalls.length <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.maxReconcileScanCalls, true)
  assert.equal(redis.scanCalls.every(call => (
    call.MATCH === `${CONTEXT_ARTIFACT_STORE_NAMESPACE}*` &&
    call.COUNT === CONTEXT_ARTIFACT_RESOURCE_LIMITS.reconcileScanCount
  )), true)

  now += 601_000
  assert.deepEqual(await repository.get(first.artifactId), { status: 'missing' })
  const third = artifact('after-expiry')
  assert.deepEqual(readyArtifact(await repository.putIfAbsent(third, now + 600_000)), third)
  assert.match(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY) ?? '', /^1\|1\|\d+$/)
})

test('all missing reads share one bounded reconcile wave per store', async () => {
  const redis = new FakeRedis(() => NOW)
  const repository = store(redis)
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    repository.get(artifact(`singleflight-missing-${index}`).artifactId)
  )))
  assert.equal(results.every(result => result.status === 'missing'), true)
  assert.equal(redis.scanCalls.length, 1)
  assert.equal(redis.evalCalls.filter(call => call.operation === 'metadata_snapshot').length, 1)
  assert.equal(redis.evalCalls.filter(call => call.operation === 'reconcile').length, 1)
})

test('existing put and touch repair deleted, oversized and invalid metadata after initialization', async () => {
  for (const operation of ['put', 'touch'] as const) {
    for (const corruption of ['deleted', 'oversized', 'invalid'] as const) {
      const redis = new FakeRedis(() => NOW)
      const repository = store(redis)
      const source = artifact(`metadata-drift-${operation}-${corruption}`)
      readyArtifact(await repository.putIfAbsent(source, NOW + 600_000))
      if (corruption === 'deleted') await redis.del(CONTEXT_ARTIFACT_METADATA_KEY)
      else if (corruption === 'oversized') {
        await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, `SECRET_OVERSIZED_METADATA:${'x'.repeat(128)}`)
      } else await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, 'invalid')

      const result = operation === 'put'
        ? await repository.putIfAbsent(source, NOW + 700_000)
        : await repository.touchAtLeast(source, NOW + 700_000)
      assert.deepEqual(readyArtifact(result), source)
      assert.match(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY) ?? '', /^1\|1\|\d+$/)
      assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 700)
    }
  }
})

test('TTL is validated and can only be extended, never shortened', async () => {
  let now = NOW
  const redis = new FakeRedis(() => now)
  const repository = store(redis)
  const source = artifact('ttl')
  await assert.rejects(
    repository.putIfAbsent(source, now + CONTEXT_ARTIFACT_RESOURCE_LIMITS.minimumRemainingLifetimeMs - 1),
    TypeError
  )
  assert.equal(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY), null)
  assert.equal(await redis.get(redisContextArtifactKey(source.artifactId)), null)
  await assert.rejects(
    repository.putIfAbsent(source, now + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs + 1),
    TypeError
  )
  assert.equal(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY), null)
  await repository.putIfAbsent(source, now + 600_000)
  assert.deepEqual(readyArtifact(await repository.touchAtLeast(source, now + 300_000)), source)
  assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 600)
  now += 100_000
  assert.deepEqual(readyArtifact(await repository.touchAtLeast(source, now + 900_000)), source)
  assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 900)
  assert.deepEqual(await repository.touchAtLeast(artifact('missing'), now + 600_000), { status: 'missing' })
})

test('TTL extension is derived from Redis TIME without a Node clock dependency', async () => {
  const redisNow = NOW
  const redis = new FakeRedis(() => redisNow)
  const source = artifact('clock-skew')
  redis.seedArtifactForTest(
    redisContextArtifactKey(source.artifactId),
    encodeContextArtifactV1(source),
    redisNow + 600_000
  )

  assert.match(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, /redis\.call\('TIME'\)/)
  assert.doesNotMatch(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, /nowMs\s*=\s*tonumber\(ARGV\[4\]\)/)
  assert.deepEqual(
    readyArtifact(await store(redis).touchAtLeast(source, redisNow + 700_000)),
    source
  )
  assert.equal(await redis.ttl(redisContextArtifactKey(source.artifactId)), 700)
})

test('TTL comparison refreshes Redis TIME after PTTL and never shortens an existing expiry', async () => {
  let redisNow = NOW
  const redis = new FakeRedis(() => redisNow)
  const source = artifact('ttl-time-race')
  const encoded = encodeContextArtifactV1(source)
  const key = redisContextArtifactKey(source.artifactId)
  redis.seedArtifactForTest(key, encoded, NOW + 1_000)
  await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, `1|1|${Buffer.byteLength(encoded, 'utf8')}`)
  redis.advanceTimeDuringNextArtifactTtl(() => { redisNow += 100 })

  assert.deepEqual(
    readyArtifact(await store(redis).touchAtLeast(source, NOW + 950)),
    source
  )
  assert.equal((redis.artifactExpiryForTest(key) ?? 0) >= NOW + 1_000, true)
  const extendBlock = /local function extendAtLeast\(\)([\s\S]*?)end\n\nif operation/.exec(
    CONTEXT_ARTIFACT_STORE_LUA_SCRIPT
  )?.[1] ?? ''
  assert.match(extendBlock, /redis\.call\('TIME'\)/)
})

test('fresh Redis TIME upper bound is clamped to the initial 24-hour horizon', async () => {
  let redisNow = NOW
  const redis = new FakeRedis(() => redisNow)
  const source = artifact('ttl-horizon-clamp')
  const encoded = encodeContextArtifactV1(source)
  const key = redisContextArtifactKey(source.artifactId)
  const horizon = NOW + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs
  redis.seedArtifactForTest(key, encoded, horizon)
  await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, `1|1|${Buffer.byteLength(encoded, 'utf8')}`)
  redis.advanceTimeDuringNextArtifactTtl(() => { redisNow += 100 })

  assert.deepEqual(readyArtifact(await store(redis).touchAtLeast(source, horizon)), source)
  assert.equal(redis.artifactExpiryForTest(key), horizon)

  const illegalRedis = new FakeRedis(() => NOW)
  illegalRedis.seedArtifactForTest(key, encoded, horizon + 1_000)
  await illegalRedis.set(
    CONTEXT_ARTIFACT_METADATA_KEY,
    `1|1|${Buffer.byteLength(encoded, 'utf8')}`
  )
  assert.deepEqual(await store(illegalRedis).touchAtLeast(source, NOW + 600_000), {
    status: 'unavailable', code: 'artifact_corrupt'
  })
})

test('Redis TIME rejects skewed past and over-horizon puts without metadata ghosts', async () => {
  const source = artifact('invalid-skewed-expiry')
  for (const minimumExpiresAtMs of [
    NOW,
    NOW + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs + 1
  ] as const) {
    const redis = new FakeRedis(() => NOW)
    await assert.rejects(
      store(redis).putIfAbsent(source, minimumExpiresAtMs),
      TypeError
    )
    assert.equal(await redis.get(redisContextArtifactKey(source.artifactId)), null)
    assert.equal(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY), null)

    const touchRedis = new FakeRedis(() => NOW)
    touchRedis.seedArtifactForTest(
      redisContextArtifactKey(source.artifactId), encodeContextArtifactV1(source), NOW + 600_000
    )
    await assert.rejects(
      store(touchRedis).touchAtLeast(source, minimumExpiresAtMs),
      TypeError
    )
    assert.equal(await touchRedis.ttl(redisContextArtifactKey(source.artifactId)), 600)
    assert.equal(await touchRedis.get(CONTEXT_ARTIFACT_METADATA_KEY), null)
  }
  assert.match(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, /invalid_expiry/)
})

test('resource limits preserve exact boundaries and reject the 129th namespace key', async () => {
  assert.deepEqual(CONTEXT_ARTIFACT_RESOURCE_LIMITS, {
    artifactBytes: MAX_CONTEXT_ARTIFACT_BYTES,
    contentBytes: MAX_CONTEXT_ARTIFACT_CONTENT_BYTES,
    sourceRefs: MAX_CONTEXT_ARTIFACT_REFS,
    namespaceKeys: 128,
    namespaceBytes: 2 * 1_024 * 1_024,
    minimumRemainingLifetimeMs: 1,
    maximumExpiryHorizonMs: 86_400_000,
    reconcileScanCount: 128,
    maxReconcileScanCalls: 256,
    maxReconcileDataKeys: 129,
    maxMetadataCasAttempts: 4,
    metadataBytes: 64
  })
  assert.equal(contextArtifactNamespaceUsageWithinLimits(128, 2 * 1_024 * 1_024), true)
  assert.equal(contextArtifactNamespaceUsageWithinLimits(129, 2 * 1_024 * 1_024), false)
  assert.equal(contextArtifactNamespaceUsageWithinLimits(128, 2 * 1_024 * 1_024 + 1), false)

  const redis = new FakeRedis(() => NOW)
  const repository = store(redis)
  for (let index = 0; index < 128; index += 1) {
    await repository.putIfAbsent(artifact(`key-${index}`), NOW + 600_000)
  }
  assert.deepEqual(await repository.putIfAbsent(artifact('key-128'), NOW + 600_000), {
    status: 'unavailable', code: 'namespace_capacity'
  })
  assert.match(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY) ?? '', /^1\|128\|\d+$/)
})

test('Lua and FakeRedis admit exactly 2 MiB of values and reject one byte over', async () => {
  const source = artifact('namespace-bytes')
  const encoded = encodeContextArtifactV1(source)
  const encodedBytes = Buffer.byteLength(encoded, 'utf8')
  const key = redisContextArtifactKey(source.artifactId)
  const args = ['put', encoded, String(NOW + 600_000)]

  const exact = new FakeRedis(() => NOW)
  await exact.set(
    CONTEXT_ARTIFACT_METADATA_KEY,
    `1|0|${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes - encodedBytes}`
  )
  assert.equal(await exact.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
    keys: [key, CONTEXT_ARTIFACT_METADATA_KEY], arguments: args
  }), 'stored')
  assert.equal(
    await exact.get(CONTEXT_ARTIFACT_METADATA_KEY),
    `1|1|${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes}`
  )

  const over = new FakeRedis(() => NOW)
  await over.set(
    CONTEXT_ARTIFACT_METADATA_KEY,
    `1|0|${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes - encodedBytes + 1}`
  )
  assert.equal(await over.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
    keys: [key, CONTEXT_ARTIFACT_METADATA_KEY], arguments: args
  }), 'capacity')
  assert.equal(await over.get(key), null)
})

test('128 strict 16 KiB artifacts fill the real store namespace to exactly 2 MiB', async () => {
  const redis = new FakeRedis(() => NOW)
  const repository = store(redis)
  for (let index = 0; index < CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys; index += 1) {
    const source = artifactWithWireBytes(MAX_CONTEXT_ARTIFACT_BYTES, `namespace-exact-${index}`)
    assert.equal(Buffer.byteLength(encodeContextArtifactV1(source), 'utf8'), MAX_CONTEXT_ARTIFACT_BYTES)
    const result = await repository.putIfAbsent(source, NOW + 600_000)
    assert.deepEqual(readyArtifact(result), source)
  }
  assert.equal(
    await redis.get(CONTEXT_ARTIFACT_METADATA_KEY),
    `1|128|${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes}`
  )
  assert.deepEqual(
    await repository.putIfAbsent(
      artifactWithWireBytes(MAX_CONTEXT_ARTIFACT_BYTES, 'namespace-over'), NOW + 600_000
    ),
    { status: 'unavailable', code: 'namespace_capacity' }
  )
})

test('first mutation reconciles syntactically valid stale-low metadata before enforcing capacity', async () => {
  const redis = new FakeRedis(() => NOW)
  for (let index = 0; index < 128; index += 1) {
    const existing = artifact(`seed-${index}`)
    redis.seedArtifactForTest(
      redisContextArtifactKey(existing.artifactId),
      encodeContextArtifactV1(existing),
      NOW + 600_000
    )
  }
  await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, '1|0|0')
  const overflow = artifact('seed-overflow')
  assert.deepEqual(await store(redis).putIfAbsent(overflow, NOW + 600_000), {
    status: 'unavailable', code: 'namespace_capacity'
  })
  assert.equal(await redis.get(redisContextArtifactKey(overflow.artifactId)), null)
  assert.match(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY) ?? '', /^1\|128\|\d+$/)
})

test('oversized metadata is repaired through bounded snapshot and CAS without body transport', async () => {
  const redis = new FakeRedis(() => NOW)
  const secretMetadata = `SECRET_OVERSIZED_METADATA:${'x'.repeat(256 * 1_024)}`
  await redis.set(CONTEXT_ARTIFACT_METADATA_KEY, secretMetadata)
  const source = artifact('oversized-metadata')

  assert.deepEqual(
    readyArtifact(await store(redis).putIfAbsent(source, NOW + 600_000)),
    source
  )
  assert.equal(redis.getCalls.includes(CONTEXT_ARTIFACT_METADATA_KEY), false)
  assert.equal(redis.evalCalls.some(call => call.operation === 'metadata_snapshot'), true)
  assert.equal(redis.evalCalls
    .filter(call => call.operation === 'reconcile')
    .every(call => call.argumentBytes.every(bytes => bytes <= 64)), true)
  assert.doesNotMatch(JSON.stringify(redis.evalCalls), /SECRET_OVERSIZED_METADATA/)
  assert.match(await redis.get(CONTEXT_ARTIFACT_METADATA_KEY) ?? '', /^1\|1\|\d+$/)
  assert.match(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, /STRLEN/)
})
