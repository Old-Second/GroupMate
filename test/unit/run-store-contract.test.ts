import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot
} from '../../src/agent/run/run-observation.js'
import {
  createRunTombstoneV2,
  normalizeRunTombstone,
  parseRunTombstone,
  parseTerminalCommitReceipt,
  type RunTombstoneV2
} from '../../src/agent/run/run-store.js'
import {
  RedisRunStore,
  redisRunKeys
} from '../../src/agent/run/redis-run-store.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'
import { registerRunStoreContract } from '../helpers/run-store-contract.js'
import { FIXTURE_MODEL_CAPABILITY } from '../helpers/trace-fixture.js'

const timestamp = '2026-07-16T00:00:00.000Z'
const finishedAt = '2026-07-16T00:00:01.000Z'
const budget = createDefaultRunBudget({
  providerTimeoutMs: 120_000,
  outputTokens: 256
})
const emptyManifestFingerprint = createHash('sha256').update('[]').digest('hex')

registerRunStoreContract({
  name: 'in-memory',
  create: () => {
    const store = new InMemoryRunStore()
    return {
      store,
      readRawTombstone: async runId => store.readRawTombstone(runId),
      seedRawTombstone: async (runId, raw) => store.seedRawTombstone(runId, raw)
    }
  }
})

test('in-memory observation usage counts raw UTF-8 tombstone bytes', async () => {
  const store = new InMemoryRunStore()
  const first = '{"value":"观察-🧪"}'
  const second = '{"value":"记录-🌏"}'
  store.seedRawTombstone('usage-first', first)
  store.seedRawTombstone('usage-second', second)
  assert.deepEqual(await store.observationUsage(), {
    schemaVersion: 1,
    tombstoneRecords: 2,
    tombstoneBytes: Buffer.byteLength(first, 'utf8') + Buffer.byteLength(second, 'utf8')
  })
})

registerRunStoreContract({
  name: 'fake-redis',
  create: () => {
    const redis = new FakeRedis(() => Date.parse(timestamp))
    const store = new RedisRunStore({ client: redis, activeTtlSeconds: 300 })
    return {
      store,
      readRawTombstone: async runId => await redis.get(redisRunKeys(runId).tombstone),
      seedRawTombstone: async (runId, raw) => {
        await redis.set(redisRunKeys(runId).tombstone, raw, { EX: 86_400 })
      }
    }
  }
})

function terminalCheckpoint (): RunCheckpoint {
  const runRef = '1'.repeat(32)
  const sessionAddress = Object.freeze({
    botId: 'bot-private-value',
    scope: Object.freeze({ kind: 'group' as const, groupId: 'group-private-value' })
  })
  const initial = createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId: 'raw-run-private-value',
    sessionId: 'session-private-value',
    sessionAddress,
    runRef,
    requestRef: '2'.repeat(32),
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
      actorId: 'actor-private-value'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic',
      runRef
    }),
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'snapshot-private-value',
      fingerprint: emptyManifestFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-16T00:04:00.000Z',
    createdAt: timestamp,
    event: createRunEvent({
      eventId: 'event-private-value',
      runId: 'raw-run-private-value',
      sessionId: 'session-private-value',
      sequence: 0,
      occurredAt: timestamp,
      type: 'run.created',
      payload: Object.freeze({})
    })
  })
  const preparing = nextRunCheckpoint(initial, 'preparing', {}, [], timestamp)
  const calling = nextRunCheckpoint(preparing, 'calling_model', {}, [], timestamp)
  return nextRunCheckpoint(calling, 'cancelled', {
    cancellationReason: 'user_cancelled',
    observationCounters: Object.freeze({
      ...calling.observationCounters,
      engineActiveDurationMs: 13
    })
  }, [], finishedAt)
}

test('tombstone v2 parser writes only the exact body-free snapshot projection', () => {
  const snapshot = createRunTerminalSnapshot(terminalCheckpoint())
  const tombstone = createRunTombstoneV2(snapshot)

  assert.deepEqual(tombstone, snapshot)
  assert.deepEqual(Object.keys(tombstone), [
    'schemaVersion',
    'observationId',
    'runRef',
    'revision',
    'status',
    'finishedAt',
    'completion',
    'errorCode',
    'cancellationReason',
    'counters',
    'engineDurationMs'
  ])
  assert.deepEqual(parseRunTombstone(tombstone), tombstone)
  const {
    schemaVersion: _snapshotSchemaVersion,
    ...normalizedSnapshot
  } = snapshot
  assert.deepEqual(normalizeRunTombstone(tombstone), {
    schemaVersion: 1,
    sourceSchemaVersion: 2,
    ...normalizedSnapshot
  })
  const raw = JSON.stringify(tombstone)
  assert.doesNotMatch(
    raw,
    /raw-run-private-value|session-private-value|group-private-value|actor-private-value|snapshot-private-value/
  )
})

test('tombstone v2 parser rejects body, route, identity, tool, Error and extra keys', () => {
  const tombstone = createRunTombstoneV2(
    createRunTerminalSnapshot(terminalCheckpoint())
  )
  const hostile = {
    output: 'private body',
    route: { groupId: 'private' },
    actorId: 'private',
    sessionId: 'private',
    runId: 'private',
    toolData: { arguments: 'private' },
    error: new Error('private'),
    presentation: { text: 'private' }
  }
  for (const [key, value] of Object.entries(hostile)) {
    assert.throws(
      () => parseRunTombstone({ ...tombstone, [key]: value }),
      key === 'error'
        ? /unknown.*error|plain objects/i
        : new RegExp(`unknown.*${key}`, 'i')
    )
  }

  const { runRef: _runRef, ...missing } = tombstone
  assert.throws(() => parseRunTombstone(missing), /missing.*runRef|runRef.*missing/i)
  assert.throws(() => parseRunTombstone({
    ...tombstone,
    counters: { ...tombstone.counters, secret: 'private' }
  }), /unknown.*secret/i)
})

test('v2 parse and normalization both reject contradictory engine durations', () => {
  const tombstone = createRunTombstoneV2(
    createRunTerminalSnapshot(terminalCheckpoint())
  )
  const contradictory = {
    ...tombstone,
    engineDurationMs: tombstone.engineDurationMs === 13 ? 14 : 13
  }
  assert.throws(() => parseRunTombstone(contradictory), /engine duration/i)
  assert.throws(
    () => normalizeRunTombstone(contradictory as RunTombstoneV2),
    /engine duration/i
  )

  const unavailable = {
    ...tombstone,
    counters: {
      ...tombstone.counters,
      engineActiveDurationMs: 'unavailable'
    },
    engineDurationMs: 13
  }
  assert.throws(() => parseRunTombstone(unavailable), /engine duration/i)
  assert.throws(
    () => normalizeRunTombstone(unavailable as RunTombstoneV2),
    /engine duration/i
  )
})

test('terminal receipt parser accepts only exact immutable byte and key deltas', () => {
  const snapshot = createRunTerminalSnapshot(terminalCheckpoint())
  const receipt = parseTerminalCommitReceipt({
    schemaVersion: 1,
    observationId: snapshot.observationId,
    runRef: snapshot.runRef,
    revision: snapshot.revision,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 123,
    eventBytesDeleted: 45,
    tombstoneBytes: 67
  })
  assert.equal(Object.isFrozen(receipt), true)
  assert.deepEqual(Object.keys(receipt), [
    'schemaVersion',
    'observationId',
    'runRef',
    'revision',
    'deletedKeyCount',
    'createdKeyCount',
    'checkpointBytesDeleted',
    'eventBytesDeleted',
    'tombstoneBytes'
  ])
  for (const invalid of [
    { ...receipt, extra: true },
    { ...receipt, schemaVersion: 2 },
    { ...receipt, observationId: 'private-run-id' },
    { ...receipt, runRef: 'private-run-id' },
    { ...receipt, revision: -1 },
    { ...receipt, deletedKeyCount: 1 },
    { ...receipt, createdKeyCount: 2 },
    { ...receipt, checkpointBytesDeleted: 'not_attempted' },
    { ...receipt, eventBytesDeleted: -1 },
    { ...receipt, tombstoneBytes: 4 * 1_024 + 1 }
  ]) {
    assert.throws(() => parseTerminalCommitReceipt(invalid), TypeError)
  }
})
