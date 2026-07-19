import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { AgentEvent } from '../../src/agent/contracts/event.js'
import {
  CONTEXT_ARTIFACT_SAFE_PREFIX,
  createContextArtifactV1,
  encodeContextArtifactV1,
  type ContextArtifactV1
} from '../../src/agent/context/context-artifact.js'
import {
  contextWireHash,
  createContextPlanV1
} from '../../src/agent/context/context-plan.js'
import {
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  estimateModelMessagesTokens,
  serializedModelMessagesBytes
} from '../../src/agent/context/context-token-estimator.js'
import { redisContextArtifactKey } from '../../src/agent/context/redis-context-artifact-store.js'
import { modelCapabilityStableHash } from '../../src/agent/model/model-capability.js'
import {
  createDefaultRunBudget,
  createLegacyRunBudgetLimits
} from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  RunCheckpointCodec,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpointV3,
  type RunCheckpointV4,
  type RunCheckpointV5,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import {
  upgradeRunCheckpointV1,
  upgradeRunCheckpointV2,
  upgradeRunCheckpointV3,
  upgradeRunCheckpointV4,
  upgradeRunCheckpointV5
} from '../../src/agent/run/run-checkpoint-migration.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot
} from '../../src/agent/run/run-observation.js'
import { RunReferenceConflictError } from '../../src/agent/run/run-store.js'
import { FIXTURE_MODEL_CAPABILITY } from '../helpers/trace-fixture.js'
import {
  RedisRunStore,
  RUN_STORE_LUA_MARKER,
  RUN_STORE_MIGRATION_LUA_MARKER,
  RUN_STORE_LUA_SCRIPT,
  RUN_STORE_METADATA_KEY,
  preflightRedisRunMigration,
  redisRunReferenceKey,
  redisRunKeys
} from '../../src/agent/run/redis-run-store.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const timestamp = '2026-07-14T00:00:00.000Z'
const deadlineAt = '2026-07-14T00:04:00.000Z'
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const legacyBudgetLimits = createLegacyRunBudgetLimits(budget.limits)
const emptyManifestFingerprint = createHash('sha256').update('[]').digest('hex')

test('RedisRunStore migration preflight records a Redis 6+ KEEPTTL capability', async () => {
  const redis = new FakeRedis()
  redis.setServerInfoForTest('# Server\r\nredis_version:6.0.0\r\n')

  assert.deepEqual(await preflightRedisRunMigration(redis), {
    schemaVersion: 1,
    redisVersion: '6.0.0',
    keepTtlSupported: true
  })
  assert.equal(redis.infoCalls, 1)
})

class RepairRaceRedis extends FakeRedis {
  #beforeCorruptRepair?: () => Promise<void>

  beforeCorruptRepair (callback: () => Promise<void>): void {
    this.#beforeCorruptRepair = callback
  }

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (options.arguments[0] === 'tombstone_delete_corrupt') {
      const callback = this.#beforeCorruptRepair
      this.#beforeCorruptRepair = undefined
      await callback?.()
    }
    return await super.eval(script, options)
  }
}

class RunArtifactRaceRedis extends FakeRedis {
  #beforeRunArtifactCommit?: () => void

  beforeRunArtifactCommit (callback: () => void): void {
    this.#beforeRunArtifactCommit = callback
  }

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    const marker = script.split('\n', 1)[0] ?? ''
    if (marker === RUN_STORE_MIGRATION_LUA_MARKER ||
      (marker === RUN_STORE_LUA_MARKER && options.arguments[0] === 'cas')) {
      const callback = this.#beforeRunArtifactCommit
      this.#beforeRunArtifactCommit = undefined
      callback?.()
    }
    return await super.eval(script, options)
  }
}

function event (
  runId: string,
  sequence: number,
  type: AgentEvent['type'] = 'run.created',
  payload: AgentEvent['payload'] = Object.freeze({})
): AgentEvent {
  return createRunEvent({
    eventId: `event-${sequence}`,
    runId,
    sessionId: 'session-1',
    sequence,
    occurredAt: timestamp,
    type,
    payload
  })
}

function checkpoint (runId = 'run-1'): RunCheckpoint {
  const runRef = createHash('md5').update(`run:${runId}`).digest('hex')
  const requestRef = createHash('md5').update(`request:${runId}`).digest('hex')
  const sessionAddress = Object.freeze({
    botId: 'bot-private-value',
    scope: Object.freeze({
      kind: 'group_user' as const,
      groupId: 'group-private-value',
      userId: 'user-private-value'
    })
  })
  return createInitialRunCheckpoint({
    profileId: 'standard', profileVersion: 1, runId,
    sessionId: 'session-1',
    sessionAddress,
    runRef,
    requestRef,
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      }),
      sessionAddress,
      actorId: 'user-private-value'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic',
      runRef
    }),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'snapshot-1', fingerprint: emptyManifestFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt,
    createdAt: timestamp,
    event: event(runId, 0)
  })
}

function legacyCheckpoint (source: RunCheckpoint): RunCheckpointV1 {
  const {
    schemaVersion: _schemaVersion,
    runRef: _runRef,
    requestRef: _requestRef,
    requestKind: _requestKind,
    presentationRoute: _presentationRoute,
    completion: _completion,
    observationCounters: _observationCounters,
    providerDispatch: _providerDispatch,
    engineActivity: _engineActivity,
    observationPolicy: _observationPolicy,
    reasoningSegments: _reasoningSegments,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    ...state
  } = source
  return Object.freeze({
    ...state,
    schemaVersion: 1,
    budgetLimits: legacyBudgetLimits,
    visibleOutput: false
  })
}

function checkpointV2 (source: RunCheckpoint): RunCheckpointV2 {
  const {
    schemaVersion: _schemaVersion,
    reasoningSegments: _reasoningSegments,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 2, budgetLimits: legacyBudgetLimits })
}

function checkpointV3 (source: RunCheckpoint): RunCheckpointV3 {
  const {
    schemaVersion: _schemaVersion,
    modelCapability: _modelCapability,
    modelPrice: _modelPrice,
    usage: _usage,
    budgetLimits: _budgetLimits,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 3, budgetLimits: legacyBudgetLimits })
}

function checkpointV4 (source: RunCheckpoint): RunCheckpointV4 {
  const {
    schemaVersion: _schemaVersion,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    budgetLimits: _budgetLimits,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 4, budgetLimits: legacyBudgetLimits })
}

function checkpointV5 (source: RunCheckpoint): RunCheckpointV5 {
  const {
    schemaVersion: _schemaVersion,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 5 })
}

function preparing (
  source: RunCheckpoint,
  marker: string
): RunCheckpoint {
  return nextRunCheckpoint(source, 'preparing', {
    messages: Object.freeze([{ role: 'user' as const, content: marker }]),
    estimatedInputTokens: 4
  }, [event(source.runId, source.nextEventSequence, 'run.started', { marker })], timestamp)
}

function artifactFor (
  source: Readonly<{ readonly runRef: string }>,
  suffix = '1'
): ContextArtifactV1 {
  return createContextArtifactV1(Object.freeze({
    namespaceRef: source.runRef,
    generation: 1,
    kind: 'tool_digest' as const,
    sourceSpanIds: Object.freeze([`tool-protocol-${suffix}`]),
    sourceRefs: Object.freeze([Object.freeze({
      ref: `tool-call-${suffix}`,
      contentHash: createHash('sha256').update(`tool-call-${suffix}`).digest('hex')
    })]),
    content: suffix === '1' ? 'compact tool result' : `compact tool result ${suffix}`,
    generator: Object.freeze({ kind: 'deterministic' as const, version: 'test-v1' }),
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
}

function invalidArtifactPayloads (artifact: ContextArtifactV1): readonly string[] {
  const encoded = encodeContextArtifactV1(artifact)
  const wrongId = JSON.parse(encoded) as Record<string, unknown>
  wrongId.artifactId = `artifact:${'f'.repeat(64)}`
  const wrongContentHash = JSON.parse(encoded) as Record<string, unknown>
  wrongContentHash.contentHash = 'f'.repeat(64)
  return Object.freeze([
    '{',
    ` ${encoded}`,
    JSON.stringify(wrongId),
    JSON.stringify(wrongContentHash)
  ])
}

function preparingWithArtifact (
  source: RunCheckpoint
): RunCheckpoint {
  return preparingWithArtifacts(source, Object.freeze([artifactFor(source)]))
}

function preparingWithArtifacts (
  source: RunCheckpoint,
  artifacts: readonly ContextArtifactV1[]
): RunCheckpoint {
  const messages = Object.freeze(artifacts.map(artifact => Object.freeze({
      role: 'user' as const,
      content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}${artifact.content}`
    })))
  const estimatedInputTokens = estimateModelMessagesTokens(messages)
  const contextPlan = createContextPlanV1(Object.freeze({
    namespaceRef: source.runRef,
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: modelCapabilityStableHash(source.modelCapability),
    mode: 'compacting' as const,
    included: Object.freeze(artifacts.map((artifact, index) => Object.freeze({
      spanId: artifact.artifactId,
      representation: 'artifact' as const,
      wireStart: index,
      wireCount: 1,
      wireHash: contextWireHash(Object.freeze([messages[index] as typeof messages[number]])),
      contentHash: artifact.contentHash
    }))),
    omitted: Object.freeze([]),
    artifactRefs: Object.freeze(artifacts.map(artifact => artifact.artifactId)),
    prefixMessageCount: 0,
    estimatedInputTokens,
    estimatedToolTokens: 0,
    reservedOutputTokens: source.model.maxOutputTokens,
    serializedMessageBytes: serializedModelMessagesBytes(messages),
    messageCount: messages.length
  }))
  return nextRunCheckpoint(source, 'preparing', {
    messages,
    estimatedInputTokens,
    contextPlan,
    contextArtifactRefs: Object.freeze(artifacts.map(artifact => artifact.artifactId))
  }, [event(source.runId, source.nextEventSequence, 'run.started', {
    marker: 'artifact'
  })], timestamp)
}

test('RedisRunStore round-trips split checkpoint state and event stream under hashed keys', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpoint()

  assert.deepEqual(await store.create(source), source)
  assert.deepEqual(await store.load(source.runId), source)

  const keys = redisRunKeys(source.runId)
  assert.equal(keys.checkpoint.includes(source.runId), false)
  assert.equal(keys.events.includes(source.runId), false)
  assert.equal(keys.tombstone.includes(source.runId), false)
  assert.equal(await redis.ttl(keys.checkpoint), 300)
  assert.equal(await redis.ttl(keys.events), 300)
  const referenceKey = redisRunReferenceKey(source.runRef)
  assert.equal(await redis.ttl(referenceKey), 300)
  const metadata = await redis.get(RUN_STORE_METADATA_KEY)
  const namespaceBytes = Number(metadata?.split('|')[0])
  const expectedBytes = [
    await redis.get(keys.checkpoint),
    await redis.get(keys.events),
    referenceKey,
    source.runId
  ].reduce((total, value) => total + Buffer.byteLength(value ?? '', 'utf8'), 0)
  assert.equal(namespaceBytes, expectedBytes)
  assert.equal(redis.evalCalls.every(call => call.marker === RUN_STORE_LUA_MARKER), true)
  assert.equal(redis.evalCalls.some(call => call.operation === 'create'), true)
  assert.doesNotMatch(RUN_STORE_LUA_SCRIPT, /redis\.call\(['"](?:KEYS|WATCH|MULTI)['"]\)/)
})

test('RedisRunStore claims runRef atomically and upgrades one exact v1 checkpoint', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const first = checkpoint('run-reference-first')
  const collision = Object.freeze({
    ...checkpoint('run-reference-second'),
    runRef: first.runRef
  })
  await store.create(first)
  await assert.rejects(store.create(collision), error => (
    error instanceof RunReferenceConflictError
  ))

  const v2 = checkpoint('run-legacy-upgrade')
  const legacy = legacyCheckpoint(v2)
  const keys = redisRunKeys(legacy.runId)
  const { events, ...state } = legacy
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 1,
    revision: legacy.revision,
    events
  }), { EX: 400 })
  const checkpointExpiry = redis.artifactExpiryForTest(keys.checkpoint)
  const eventExpiry = redis.artifactExpiryForTest(keys.events)
  const loaded = await store.load(legacy.runId)
  assert.equal(loaded?.schemaVersion, 1)
  if (loaded?.schemaVersion !== 1) throw new TypeError('legacy fixture was not loaded')
  const upgraded = upgradeRunCheckpointV1(loaded, {
    runRef: v2.runRef,
    requestRef: v2.requestRef
  })
  assert.deepEqual(await store.upgrade(loaded, upgraded), upgraded)
  assert.equal((await store.load(legacy.runId))?.schemaVersion, 6)
  assert.equal(await redis.get(redisRunReferenceKey(upgraded.runRef)), upgraded.runId)
  assert.equal(redis.artifactExpiryForTest(keys.checkpoint), checkpointExpiry)
  assert.equal(redis.artifactExpiryForTest(keys.events), eventExpiry)
  assert.equal(
    redis.artifactExpiryForTest(redisRunReferenceKey(upgraded.runRef)),
    eventExpiry
  )
})

test('RedisRunStore upgrades v2 through CAS without duplicating its runRef', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpointV2(checkpoint('run-v2-upgrade'))
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 2,
    revision: source.revision,
    events
  }), { EX: 300 })
  await redis.set(referenceKey, source.runId, { EX: 300 })

  const loaded = await store.load(source.runId)
  assert.equal(loaded?.schemaVersion, 2)
  if (loaded?.schemaVersion !== 2) throw new TypeError('v2 fixture was not loaded')
  const upgraded = upgradeRunCheckpointV2(loaded)

  await assert.rejects(store.upgrade(loaded, Object.freeze({
    ...upgraded,
    requestRef: 'f'.repeat(32)
  })), error => error instanceof AgentError && error.code === 'checkpoint_conflict')
  assert.deepEqual(await store.upgrade(loaded, upgraded), upgraded)
  assert.deepEqual(await store.load(source.runId), upgraded)
  assert.equal(await redis.get(referenceKey), source.runId)
  assert.equal((await redis.get(RUN_STORE_METADATA_KEY))?.split('|')[5], '1')
  assert.equal(redis.evalCalls.some(call => call.marker === RUN_STORE_MIGRATION_LUA_MARKER), true)
})

test('RedisRunStore upgrades one exact v3 through CAS and leaves conflicts untouched', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpointV3(checkpoint('run-v3-upgrade'))
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 3,
    revision: source.revision,
    events
  }), { EX: 300 })
  await redis.set(referenceKey, source.runId, { EX: 300 })

  const loaded = await store.load(source.runId)
  assert.equal(loaded?.schemaVersion, 3)
  if (loaded?.schemaVersion !== 3) throw new TypeError('v3 fixture was not loaded')
  const upgraded = upgradeRunCheckpointV3(loaded)
  for (const tampered of [
    Object.freeze({ ...upgraded, requestRef: 'f'.repeat(32) }),
    Object.freeze({
      ...upgraded,
      messages: Object.freeze([{ role: 'user' as const, content: 'tampered' }])
    }),
    Object.freeze({
      ...upgraded,
      budgetCounters: Object.freeze({
        ...upgraded.budgetCounters,
        estimatedTokens: upgraded.budgetCounters.estimatedTokens + 1
      })
    }),
    Object.freeze({ ...upgraded, status: 'preparing' as const }),
    Object.freeze({
      ...upgraded,
      toolLedgers: Object.freeze([{ schemaVersion: 1, step: 0, calls: Object.freeze([]) }])
    })
  ]) {
    await assert.rejects(store.upgrade(loaded, tampered as typeof upgraded), error => (
      error instanceof AgentError && error.code === 'checkpoint_conflict'
    ))
    assert.deepEqual(await store.load(source.runId), source)
  }
  assert.deepEqual(await store.upgrade(loaded, upgraded), upgraded)
  assert.deepEqual(await store.load(source.runId), upgraded)
  assert.equal(await redis.get(referenceKey), source.runId)
})

test('RedisRunStore migrates v4 with separate absolute TTLs and never rewrites its reference', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpointV4(checkpoint('run-v4-upgrade'))
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 4, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  redis.seedArtifactForTest(
    RUN_STORE_METADATA_KEY,
    '0|9999999|9999999|9999999|9999999|9999999|9999999'
  )
  const expiries = [keys.checkpoint, keys.events, referenceKey]
    .map(key => redis.artifactExpiryForTest(key))
  const loaded = await store.load(source.runId)
  if (loaded?.schemaVersion !== 4) throw new TypeError('v4 fixture was not loaded')
  const upgraded = upgradeRunCheckpointV4(loaded)
  const checkpointBeforeJump = await redis.get(keys.checkpoint)
  await assert.rejects(store.upgrade(loaded, Object.freeze({
    ...upgraded,
    revision: upgraded.revision + 1
  })), error => error instanceof AgentError && error.code === 'checkpoint_conflict')
  assert.equal(await redis.get(keys.checkpoint), checkpointBeforeJump)
  const settled = await Promise.allSettled([
    store.upgrade(loaded, upgraded),
    store.upgrade(loaded, upgraded)
  ])
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1)
  assert.deepEqual([keys.checkpoint, keys.events, referenceKey]
    .map(key => redis.artifactExpiryForTest(key)), expiries)
  assert.equal(await redis.get(referenceKey), source.runId)
})

test('RedisRunStore migrates v5 to v6 while preserving absolute TTLs and its reference', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpointV5(checkpoint('run-v5-upgrade'))
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 5, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  const expiries = [keys.checkpoint, keys.events, referenceKey]
    .map(key => redis.artifactExpiryForTest(key))

  const loaded = await store.load(source.runId)
  if (loaded?.schemaVersion !== 5) throw new TypeError('v5 fixture was not loaded')
  const upgraded = upgradeRunCheckpointV5(loaded)

  assert.deepEqual(await store.upgrade(loaded, upgraded), upgraded)
  assert.deepEqual(await store.load(source.runId), upgraded)
  assert.deepEqual([keys.checkpoint, keys.events, referenceKey]
    .map(key => redis.artifactExpiryForTest(key)), expiries)
  assert.equal(await redis.get(referenceKey), source.runId)
})

test('RedisRunStore rejects Redis below 6 before any migration mutation', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  redis.setServerInfoForTest('# Server\r\nredis_version:5.0.14\r\n')
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const source = checkpointV5(checkpoint('run-v5-unsupported-redis'))
  const upgraded = upgradeRunCheckpointV5(source)
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 5, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ])

  await assert.rejects(store.upgrade(source, upgraded), error => (
    error instanceof AgentError && error.code === 'storage_unavailable' &&
    error.details?.operation === 'migration_preflight'
  ))
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ]), before)
  assert.equal(redis.evalCalls.some(call => call.marker === RUN_STORE_MIGRATION_LUA_MARKER), false)
})

test('RedisRunStore migration atomically retains every referenced context artifact', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const planned = preparingWithArtifact(checkpoint('run-v5-artifact-upgrade'))
  const source = checkpointV5(planned)
  const upgraded = upgradeRunCheckpointV5(source)
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const artifactKey = redisContextArtifactKey(source.contextArtifactRefs[0] as string)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 5, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  redis.seedArtifactForTest(
    artifactKey,
    encodeContextArtifactV1(artifactFor(source)),
    now + 30_000
  )

  assert.deepEqual(await store.upgrade(source, upgraded), upgraded)
  assert.equal(await redis.ttl(artifactKey), 400)
})

test('RedisRunStore migration rejects an artifact replaced after exact preflight without mutating legacy state', async () => {
  const now = Date.parse(timestamp)
  const redis = new RunArtifactRaceRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const planned = preparingWithArtifact(checkpoint('run-v5-artifact-race'))
  const source = checkpointV5(planned)
  const upgraded = upgradeRunCheckpointV5(source)
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const artifactKey = redisContextArtifactKey(source.contextArtifactRefs[0] as string)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 5, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  redis.seedArtifactForTest(
    artifactKey,
    encodeContextArtifactV1(artifactFor(source)),
    now + 30_000
  )
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ])
  redis.beforeRunArtifactCommit(() => {
    redis.seedArtifactForTest(artifactKey, '{"corrupt":true}', now + 30_000)
  })

  await assert.rejects(store.upgrade(source, upgraded), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ]), before)
})

test('RedisRunStore migration rejects a missing context artifact without changing legacy state', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const planned = preparingWithArtifact(checkpoint('run-v5-artifact-missing'))
  const source = checkpointV5(planned)
  const upgraded = upgradeRunCheckpointV5(source)
  const keys = redisRunKeys(source.runId)
  const referenceKey = redisRunReferenceKey(source.runRef)
  const { events, ...state } = source
  await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
  await redis.set(keys.events, JSON.stringify({
    schemaVersion: 5, revision: source.revision, events
  }), { EX: 400 })
  await redis.set(referenceKey, source.runId, { EX: 350 })
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey)
  ])

  await assert.rejects(store.upgrade(source, upgraded), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey)
  ]), before)
})

test('RedisRunStore migration rejects noncanonical and hash-invalid artifacts without writes', async () => {
  const now = Date.parse(timestamp)
  for (let index = 0; index < 4; index += 1) {
    const redis = new FakeRedis(() => now)
    const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
    const planned = preparingWithArtifact(checkpoint(`run-v5-invalid-artifact-${index}`))
    const source = checkpointV5(planned)
    const payload = invalidArtifactPayloads(artifactFor(source))[index] as string
    const upgraded = upgradeRunCheckpointV5(source)
    const keys = redisRunKeys(source.runId)
    const referenceKey = redisRunReferenceKey(source.runRef)
    const artifactKey = redisContextArtifactKey(source.contextArtifactRefs[0] as string)
    const { events, ...state } = source
    await redis.set(keys.checkpoint, JSON.stringify(state), { EX: 300 })
    await redis.set(keys.events, JSON.stringify({
      schemaVersion: 5, revision: source.revision, events
    }), { EX: 400 })
    await redis.set(referenceKey, source.runId, { EX: 350 })
    redis.seedArtifactForTest(artifactKey, payload, now + 30_000)
    const before = await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
      redis.get(RUN_STORE_METADATA_KEY), redis.ttl(artifactKey)
    ])

    await assert.rejects(store.upgrade(source, upgraded), error => (
      error instanceof AgentError && error.code === 'checkpoint_invalid'
    ))
    assert.deepEqual(await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
      redis.get(RUN_STORE_METADATA_KEY), redis.ttl(artifactKey)
    ]), before)
  }
})

test('RedisRunStore migration failures leave every surviving legacy key unchanged', async () => {
  for (const failure of [
    'checkpoint_persistent', 'checkpoint_expired', 'event_expired', 'missing',
    'reference_wrong', 'reference_missing', 'reference_expired',
    'reference_persistent', 'tombstone'
  ] as const) {
    let now = Date.parse(timestamp)
    const redis = new FakeRedis(() => now)
    const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
    const source = checkpointV4(checkpoint(`run-v4-failure-${failure}`))
    const upgraded = upgradeRunCheckpointV4(source)
    const keys = redisRunKeys(source.runId)
    const referenceKey = redisRunReferenceKey(source.runRef)
    const { events, ...state } = source
    const checkpointRaw = JSON.stringify(state)
    const eventRaw = JSON.stringify({
      schemaVersion: 4, revision: source.revision, events
    })
    if (failure !== 'missing') {
      await redis.set(
        keys.checkpoint,
        checkpointRaw,
        failure === 'checkpoint_persistent'
          ? undefined
          : { EX: failure === 'checkpoint_expired' ? 100 : 300 }
      )
    }
    await redis.set(keys.events, eventRaw, { EX: failure === 'event_expired' ? 100 : 400 })
    if (failure !== 'reference_missing') {
      await redis.set(
        referenceKey,
        failure === 'reference_wrong' ? 'wrong-run' : source.runId,
        failure === 'reference_persistent'
          ? undefined
          : { EX: failure === 'reference_expired' ? 100 : 350 }
      )
    }
    if (failure === 'tombstone') await redis.set(keys.tombstone, 'terminal', { EX: 300 })
    if (failure === 'checkpoint_expired' || failure === 'event_expired' ||
      failure === 'reference_expired') now += 150_000
    const before = await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(keys.tombstone),
      redis.get(referenceKey), redis.get(RUN_STORE_METADATA_KEY)
    ])

    await assert.rejects(store.upgrade(source, upgraded), AgentError)

    assert.deepEqual(await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(keys.tombstone),
      redis.get(referenceKey), redis.get(RUN_STORE_METADATA_KEY)
    ]), before)
  }
})

test('RedisRunStore create is NX and exactly one revision CAS wins', async () => {
  let nowMs = Date.parse(timestamp)
  const redis = new FakeRedis(() => nowMs)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint())
  await assert.rejects(store.create(created), error => (
    error instanceof AgentError && error.code === 'checkpoint_conflict'
  ))

  nowMs += 10_000
  const [first, second] = await Promise.allSettled([
    store.compareAndSet(created, preparing(created, 'first')),
    store.compareAndSet(created, preparing(created, 'second'))
  ])
  assert.deepEqual([first.status, second.status].sort(), ['fulfilled', 'rejected'])
  assert.equal((await store.load(created.runId))?.revision, 1)
  assert.equal(await redis.ttl(redisRunReferenceKey(created.runRef)), 300)
  const rejected = first.status === 'rejected' ? first.reason : second.status === 'rejected' ? second.reason : null
  assert.equal(rejected instanceof AgentError && rejected.code, 'checkpoint_conflict')
})

test('RedisRunStore CAS atomically retains referenced context artifacts with the active TTL', async () => {
  let now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint('run-artifact-cas'))
  const next = preparingWithArtifact(created)
  const artifactKey = redisContextArtifactKey(next.contextArtifactRefs[0] as string)
  redis.seedArtifactForTest(
    artifactKey,
    encodeContextArtifactV1(artifactFor(created)),
    now + 30_000
  )
  now += 10_000

  assert.deepEqual(await store.compareAndSet(created, next), next)
  assert.equal(await redis.ttl(artifactKey), 300)
})

test('RedisRunStore stale CAS conflict does not extend a referenced artifact TTL', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint('run-artifact-conflict'))
  const staleNext = preparingWithArtifact(created)
  const artifactKey = redisContextArtifactKey(staleNext.contextArtifactRefs[0] as string)
  redis.seedArtifactForTest(
    artifactKey,
    encodeContextArtifactV1(artifactFor(created)),
    now + 30_000
  )
  await store.compareAndSet(created, preparing(created, 'winner'))
  const expiryBefore = redis.artifactExpiryForTest(artifactKey)

  await assert.rejects(store.compareAndSet(created, staleNext), error => (
    error instanceof AgentError && error.code === 'checkpoint_conflict'
  ))
  assert.equal(redis.artifactExpiryForTest(artifactKey), expiryBefore)
})

test('RedisRunStore CAS rejects an artifact replaced after exact preflight without committing the checkpoint', async () => {
  const now = Date.parse(timestamp)
  const redis = new RunArtifactRaceRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint('run-artifact-race'))
  const next = preparingWithArtifact(created)
  const keys = redisRunKeys(created.runId)
  const referenceKey = redisRunReferenceKey(created.runRef)
  const artifactKey = redisContextArtifactKey(next.contextArtifactRefs[0] as string)
  redis.seedArtifactForTest(
    artifactKey,
    encodeContextArtifactV1(artifactFor(created)),
    now + 30_000
  )
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ])
  redis.beforeRunArtifactCommit(() => {
    redis.seedArtifactForTest(artifactKey, '{"corrupt":true}', now + 30_000)
  })

  await assert.rejects(store.compareAndSet(created, next), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY)
  ]), before)
  assert.deepEqual(await store.load(created.runId), created)
})

test('RedisRunStore CAS rejects a missing context artifact without changing the checkpoint', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint('run-artifact-missing'))
  const next = preparingWithArtifact(created)
  const keys = redisRunKeys(created.runId)
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events),
    redis.get(redisRunReferenceKey(created.runRef))
  ])

  await assert.rejects(store.compareAndSet(created, next), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.deepEqual(await store.load(created.runId), created)
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events),
    redis.get(redisRunReferenceKey(created.runRef))
  ]), before)
})

test('RedisRunStore CAS rejects noncanonical and hash-invalid artifacts without writes', async () => {
  const now = Date.parse(timestamp)
  for (let index = 0; index < 4; index += 1) {
    const redis = new FakeRedis(() => now)
    const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
    const created = await store.create(checkpoint(`run-invalid-artifact-${index}`))
    const next = preparingWithArtifact(created)
    const payload = invalidArtifactPayloads(artifactFor(created))[index] as string
    const keys = redisRunKeys(created.runId)
    const referenceKey = redisRunReferenceKey(created.runRef)
    const artifactKey = redisContextArtifactKey(next.contextArtifactRefs[0] as string)
    redis.seedArtifactForTest(artifactKey, payload, now + 30_000)
    const before = await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
      redis.get(RUN_STORE_METADATA_KEY), redis.ttl(artifactKey)
    ])

    await assert.rejects(store.compareAndSet(created, next), error => (
      error instanceof AgentError && error.code === 'checkpoint_invalid'
    ))
    assert.deepEqual(await Promise.all([
      redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
      redis.get(RUN_STORE_METADATA_KEY), redis.ttl(artifactKey)
    ]), before)
    assert.deepEqual(await store.load(created.runId), created)
  }
})

test('RedisRunStore CAS rejects a multi-artifact batch atomically when one value is corrupt', async () => {
  const now = Date.parse(timestamp)
  const redis = new FakeRedis(() => now)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint('run-artifact-batch-corrupt'))
  const artifacts = Object.freeze([artifactFor(created, '1'), artifactFor(created, '2')])
  const next = preparingWithArtifacts(created, artifacts)
  const keys = redisRunKeys(created.runId)
  const referenceKey = redisRunReferenceKey(created.runRef)
  const artifactKeys = artifacts.map(artifact => redisContextArtifactKey(artifact.artifactId))
  redis.seedArtifactForTest(
    artifactKeys[0] as string,
    encodeContextArtifactV1(artifacts[0] as ContextArtifactV1),
    now + 30_000
  )
  redis.seedArtifactForTest(artifactKeys[1] as string, '{"corrupt":true}', now + 30_000)
  const before = await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY),
    ...artifactKeys.map(async key => await redis.ttl(key))
  ])

  await assert.rejects(store.compareAndSet(created, next), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.deepEqual(await Promise.all([
    redis.get(keys.checkpoint), redis.get(keys.events), redis.get(referenceKey),
    redis.get(RUN_STORE_METADATA_KEY),
    ...artifactKeys.map(async key => await redis.ttl(key))
  ]), before)
  assert.deepEqual(await store.load(created.runId), created)
})

test('RedisRunStore atomically replaces terminal state with one bounded 24-hour tombstone', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const created = await store.create(checkpoint())
  const cancelled = nextRunCheckpoint(created, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(created.runId, 1, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)

  const snapshot = createRunTerminalSnapshot(cancelled)
  const receipt = await store.commitTerminal(created, cancelled, snapshot)
  assert.deepEqual({
    observationId: receipt.observationId,
    runRef: receipt.runRef,
    revision: receipt.revision,
    deletedKeyCount: receipt.deletedKeyCount,
    createdKeyCount: receipt.createdKeyCount
  }, {
    observationId: snapshot.observationId,
    runRef: snapshot.runRef,
    revision: snapshot.revision,
    deletedKeyCount: 2,
    createdKeyCount: 1
  })
  assert.equal(await store.load(created.runId), null)
  const tombstone = await store.loadTombstone(created.runId)
  assert.equal(tombstone?.status, 'cancelled')
  assert.equal(tombstone?.revision, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(tombstone), 'utf8') <= 4 * 1_024)
  const keys = redisRunKeys(created.runId)
  assert.equal(await redis.ttl(keys.checkpoint), -2)
  assert.equal(await redis.ttl(keys.events), -2)
  assert.equal(await redis.ttl(keys.tombstone), 86_400)
  assert.equal(await redis.ttl(redisRunReferenceKey(created.runRef)), 86_400)
  const raw = await redis.get(keys.tombstone)
  assert.deepEqual(await store.observationUsage(), {
    schemaVersion: 1,
    tombstoneRecords: 1,
    tombstoneBytes: Buffer.byteLength(raw ?? '', 'utf8')
  })
  assert.equal((await redis.get(RUN_STORE_METADATA_KEY))?.split('|').length, 7)
})

test('RedisRunStore observation usage is metadata-only and upgrades old metadata through bounded reconcile', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  await redis.set(
    'GROUPMATE:RUN:v1:tombstone:legacy-multibyte',
    '{"value":"观察-🧪"}',
    { EX: 300 }
  )
  await redis.set(RUN_STORE_METADATA_KEY, '0|0|0|0|0|0')
  const store = new RedisRunStore({ client: redis })
  const before = redis.scanCalls.length
  assert.deepEqual(await store.observationUsage(), {
    schemaVersion: 1,
    tombstoneRecords: 'unavailable',
    tombstoneBytes: 'unavailable'
  })
  assert.equal(redis.scanCalls.length, before)

  await store.create(checkpoint('metadata-upgrade'))
  assert.ok(redis.scanCalls.length > before)
  const scansAfterUpgrade = redis.scanCalls.length
  const usage = await store.observationUsage()
  assert.equal(usage.tombstoneRecords, 1)
  assert.equal(
    usage.tombstoneBytes,
    Buffer.byteLength('{"value":"观察-🧪"}', 'utf8')
  )
  assert.equal(redis.scanCalls.length, scansAfterUpgrade)
  assert.equal((await redis.get(RUN_STORE_METADATA_KEY))?.split('|').length, 7)
})

test('RedisRunStore reports unavailable metadata reads and atomically repairs corrupt tombstones', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const created = await store.create(checkpoint('corrupt-usage'))
  const cancelled = nextRunCheckpoint(created, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(created.runId, 1, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)
  await store.commitTerminal(created, cancelled, createRunTerminalSnapshot(cancelled))
  const retained = await store.create(checkpoint('retained-usage'))
  const retainedCancelled = nextRunCheckpoint(retained, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(retained.runId, 1, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)
  await store.commitTerminal(
    retained,
    retainedCancelled,
    createRunTerminalSnapshot(retainedCancelled)
  )
  const key = redisRunKeys(created.runId).tombstone
  const raw = await redis.get(key)
  const retainedRaw = await redis.get(redisRunKeys(retained.runId).tombstone)
  assert.notEqual(raw, null)
  assert.notEqual(retainedRaw, null)
  const corrupt = '坏'.repeat(
    Math.floor(RUN_RESOURCE_LIMITS.namespaceBytes / Buffer.byteLength('坏', 'utf8')) + 1
  )
  assert.ok(Buffer.byteLength(corrupt, 'utf8') > RUN_RESOURCE_LIMITS.namespaceBytes)
  assert.notEqual(
    Buffer.byteLength(corrupt, 'utf8'),
    Buffer.byteLength(raw ?? '', 'utf8')
  )
  await redis.set(key, corrupt, { EX: 86_400 })

  await assert.rejects(store.loadTombstone(created.runId), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
  assert.equal((await redis.get(key)) === null, true)
  assert.deepEqual(await store.observationUsage(), {
    schemaVersion: 1,
    tombstoneRecords: 1,
    tombstoneBytes: Buffer.byteLength(retainedRaw ?? '', 'utf8')
  })

  redis.failNextGet(RUN_STORE_METADATA_KEY)
  assert.deepEqual(await store.observationUsage(), {
    schemaVersion: 1,
    tombstoneRecords: 'unavailable',
    tombstoneBytes: 'unavailable'
  })
})

test('RedisRunStore invalidates stale metadata when corrupt repair loses a target race', async t => {
  async function createCorruptTombstone (
    redis: RepairRaceRedis,
    runId: string
  ): Promise<{ store: RedisRunStore; key: string; validRaw: string }> {
    const store = new RedisRunStore({ client: redis })
    const created = await store.create(checkpoint(runId))
    const cancelled = nextRunCheckpoint(created, 'cancelled', {
      cancellationReason: 'user_cancelled'
    }, [event(created.runId, 1, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)
    await store.commitTerminal(created, cancelled, createRunTerminalSnapshot(cancelled))
    const key = redisRunKeys(created.runId).tombstone
    const validRaw = await redis.get(key)
    assert.notEqual(validRaw, null)
    await redis.set(key, '{corrupt', { EX: 86_400 })
    return { store, key, validRaw: validRaw ?? '' }
  }

  await t.test('a replacement remains while usage is rebuilt from its actual bytes', async () => {
    const redis = new RepairRaceRedis(() => Date.parse(timestamp))
    const { store, key, validRaw } = await createCorruptTombstone(redis, 'repair-race-replace')
    const replacement = ` ${validRaw}`
    redis.beforeCorruptRepair(async () => {
      await redis.set(key, replacement, { EX: 86_400 })
    })

    await assert.rejects(store.loadTombstone('repair-race-replace'), error => (
      error instanceof AgentError && error.code === 'checkpoint_invalid'
    ))
    assert.equal(await redis.get(key), replacement)
    assert.deepEqual(await store.observationUsage(), {
      schemaVersion: 1,
      tombstoneRecords: 1,
      tombstoneBytes: Buffer.byteLength(replacement, 'utf8')
    })
  })

  await t.test('a missing target removes its ghost usage', async () => {
    const redis = new RepairRaceRedis(() => Date.parse(timestamp))
    const { store, key } = await createCorruptTombstone(redis, 'repair-race-missing')
    redis.beforeCorruptRepair(async () => {
      await redis.del(key)
    })

    await assert.rejects(store.loadTombstone('repair-race-missing'), error => (
      error instanceof AgentError && error.code === 'checkpoint_invalid'
    ))
    assert.equal((await redis.get(key)) === null, true)
    assert.deepEqual(await store.observationUsage(), {
      schemaVersion: 1,
      tombstoneRecords: 0,
      tombstoneBytes: 0
    })
  })
})

test('RedisRunStore appends immutable events and uses the only terminal commit port', async () => {
  let nowMs = Date.parse(timestamp)
  const redis = new FakeRedis(() => nowMs)
  const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
  const created = await store.create(checkpoint())
  const progress = event(created.runId, 1, 'run.progress', { text: '阶段已开始' })

  nowMs += 10_000
  const appended = await store.appendEvents(created, [progress])

  assert.equal(appended.revision, 1)
  assert.deepEqual(appended.events.at(-1), progress)
  assert.equal(await redis.ttl(redisRunReferenceKey(created.runRef)), 300)
  const cancelled = nextRunCheckpoint(appended, 'cancelled', {
    cancellationReason: 'user_cancelled'
  }, [event(created.runId, 2, 'run.cancelled', { reason: 'user_cancelled' })], timestamp)
  nowMs += 10_000
  const snapshot = createRunTerminalSnapshot(cancelled)
  const receipt = await store.commitTerminal(appended, cancelled, snapshot)
  assert.equal(receipt.observationId, snapshot.observationId)
  assert.equal(await store.load(created.runId), null)
  assert.equal((await store.loadTombstone(created.runId))?.status, 'cancelled')
  assert.equal(await redis.ttl(redisRunReferenceKey(created.runRef)), 86_400)
})

test('RunCheckpointCodec rejects non-JSON, unknown fields and every checkpoint/event boundary', () => {
  const codec = new RunCheckpointCodec()
  const source = checkpoint()
  assert.throws(() => codec.encode({
    ...source,
    apiKey: 'must-not-persist'
  } as unknown as RunCheckpoint), /unknown checkpoint key/)
  assert.throws(() => codec.encode({
    ...source,
    messages: Object.freeze([{ role: 'user', content: 'ok', runtime: () => undefined }])
  } as unknown as RunCheckpoint), /unsupported value|unknown model message key/)
  assert.throws(() => codec.encode({
    ...source,
    messages: Object.freeze([{ role: 'user', content: 'x'.repeat(257 * 1_024) }])
  } as unknown as RunCheckpoint), /checkpoint byte limit/)

  const tooManyEvents = Array.from({ length: 97 }, (_, index) => event(source.runId, index))
  assert.throws(() => codec.encode({
    ...source,
    events: Object.freeze(tooManyEvents),
    nextEventSequence: tooManyEvents.length
  } as RunCheckpoint), /event count limit/)

  const oversizedEvents = Array.from({ length: 90 }, (_, index) => (
    event(source.runId, index, 'run.progress', { text: 'x'.repeat(1_500) })
  ))
  assert.throws(() => codec.encode({
    ...source,
    events: Object.freeze(oversizedEvents),
    nextEventSequence: oversizedEvents.length
  } as RunCheckpoint), /event byte limit/)
})

test('RedisRunStore fails closed for malformed and incompatible persisted state', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  const source = await store.create(checkpoint())
  const keys = redisRunKeys(source.runId)
  await redis.set(keys.checkpoint, JSON.stringify({ schemaVersion: 2 }), { EX: 300 })

  await assert.rejects(store.load(source.runId), error => (
    error instanceof AgentError && error.code === 'checkpoint_invalid'
  ))
})

test('RedisRunStore enforces checkpoint key and namespace byte budgets before writes', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const store = new RedisRunStore({ client: redis })
  for (let index = 0; index < 16; index += 1) {
    await store.create(checkpoint(`run-${index}`))
  }
  await assert.rejects(store.create(checkpoint('run-over-key-limit')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))

  const largeRedis = new FakeRedis(() => Date.parse(timestamp))
  await largeRedis.set(
    'GROUPMATE:RUN:v1:approval-index:bounded-fixture',
    'x'.repeat(8 * 1_024 * 1_024)
  )
  const largeStore = new RedisRunStore({ client: largeRedis })
  await assert.rejects(largeStore.create(checkpoint('run-byte-limit')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))
  assert.equal(await largeRedis.get(redisRunKeys('run-byte-limit').checkpoint), null)
})

test('RedisRunStore reclaims expired tombstones before namespace admission', async () => {
  let nowMs = Date.parse(timestamp)
  const redis = new FakeRedis(() => nowMs)
  for (let index = 0; index < 129; index += 1) {
    await redis.set(
      `GROUPMATE:RUN:v1:tombstone:expired-${index}`,
      '{}',
      { EX: 1 }
    )
  }
  nowMs += 1_001
  const store = new RedisRunStore({ client: redis })

  await store.create(checkpoint('run-after-reclaim'))

  assert.notEqual(await redis.get(redisRunKeys('run-after-reclaim').checkpoint), null)
})

test('RedisRunStore counts orphan references during bounded namespace reconcile', async () => {
  const redis = new FakeRedis(() => Date.parse(timestamp))
  for (let index = 0; index < 145; index += 1) {
    await redis.set(
      redisRunReferenceKey(index.toString(16).padStart(32, '0')),
      `orphan-run-${index}`,
      { EX: 300 }
    )
  }
  const store = new RedisRunStore({ client: redis })
  await assert.rejects(store.create(checkpoint('run-reference-over-limit')), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))
})
