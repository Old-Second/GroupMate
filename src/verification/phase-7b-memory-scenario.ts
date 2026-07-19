import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../agent/memory/memory-access-gate.js'
import {
  decodeMemoryOutboxEventV1,
  encodeMemoryRecordV1
} from '../agent/memory/memory-codec.js'
import {
  createMemoryRecordV1,
  createMemoryRevisionV1,
  createMemorySourceV1,
  createQqIdentitySnapshotV1,
  type MemoryRecordV1
} from '../agent/memory/memory-domain.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from '../agent/memory/memory-resource-limits.js'
import {
  MEMORY_HOT_CACHE_KEYS,
  MEMORY_HOT_CACHE_LUA_SCRIPT,
  MEMORY_HOT_CACHE_STATIC_BYTES,
  RedisMemoryHotCache,
  memoryHotCacheHeadFieldV1,
  memoryHotCacheHeadValueV1,
  memoryHotCacheIndexEntryBytesV1,
  memoryHotCacheMetadataEntryBytesV1,
  memoryHotCacheNamespaceFieldV1,
  memoryHotCacheRecordEntryBytesV1,
  memoryHotCacheRecordFieldV1,
  type RedisMemoryHotCacheClient
} from '../agent/memory/redis-memory-hot-cache.js'
import {
  openSqliteMemoryDatabaseV1,
  type SqliteMemoryDatabaseV1
} from '../agent/memory/sqlite-memory-database.js'
import { createSqliteMemoryRepositoryV1 } from '../agent/memory/sqlite-memory-repository.js'
const FIXED_NOW = '2026-07-20T00:02:00.000Z'
const OBSERVED_AT = '2026-07-20T00:00:00.000Z'
const CONFIRMED_AT = '2026-07-20T00:01:00.000Z'
const VALID_UNTIL = '2027-07-20T00:01:00.000Z'
const PURGE_AT = '2027-08-19T00:01:00.000Z'
const BOT_INSTANCE_ID = 'groupmate-phase7b-fixture'
const ACCOUNT_ID = '7000000001'
const SUBJECT_USER_ID = '7000000002'
const GROUP_ID = '7000000003'
const GROUP_LIFECYCLE_ID = 'phase7b-group-generation-1'
const NICKNAME = '阶段七乙昵称哨兵'
const GROUP_CARD = '阶段七乙群名片哨兵'
const GROUP_TITLE = '阶段七乙头衔哨兵'
const GROUP_NAME = '阶段七乙群名哨兵'
const RECORD_TEXT = '阶段七乙正文哨兵'
const SOURCE_TEXT = '阶段七乙来源正文哨兵'
const ACTOR_REF = `actor:${'7'.repeat(64)}`

export const PHASE_7B_MEMORY_SQLITE_SHM_LIMIT_BYTES = 64 * 1_024

export const PHASE_7B_MEMORY_RESOURCE_SCENARIOS = Object.freeze([
  'fixtureLifecycle'
] as const)

export type Phase7bMemoryResourceScenarioName =
  typeof PHASE_7B_MEMORY_RESOURCE_SCENARIOS[number]

export const PHASE_7B_MEMORY_RESOURCE_OUTCOMES = Object.freeze({
  fixtureLifecycle: 'memory_data_layer_verified'
} as const)

export interface Phase7bMemoryResourceSample {
  readonly scenario: Phase7bMemoryResourceScenarioName
  readonly baselineRssBytes: number
  readonly retainedRssBytes: number
  readonly peakRssBytes: number
  readonly wallTimeMs: number
  readonly userCpuMicros: number
  readonly systemCpuMicros: number
  readonly sqlitePageSizeBytes: number
  readonly sqlitePageCacheBytes: number
  readonly sqliteMainFileBytes: number
  readonly sqliteWalFileBytes: number
  readonly sqliteShmFileBytes: number
  readonly canonicalActiveRecords: number
  readonly canonicalRevisionRecords: number
  readonly canonicalLogicalBytes: number
  readonly outboxRecords: number
  readonly outboxLogicalBytes: number
  readonly redisRecords: number
  readonly redisGenerations: number
  readonly redisRecordEntryBytes: number
  readonly redisExpiryIndexBytes: number
  readonly redisLruIndexBytes: number
  readonly redisDynamicMetadataBytes: number
  readonly redisStaticBytes: number
  readonly redisLogicalBytes: number
  readonly contentLeakCount: number
  readonly identityLeakCount: number
  readonly sqliteClosed: boolean
  readonly redisReleased: boolean
  readonly timerResourceDelta: number
  readonly outcome: 'memory_data_layer_verified'
}

export interface Phase7bMemoryResourceScenarioOptions {
  readonly settleMs?: number
  readonly gc?: () => void
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly resourceUsage?: () => NodeJS.ResourceUsage
  readonly cpuUsage?: typeof process.cpuUsage
  readonly monotonicNow?: () => number
  readonly activeResourcesInfo?: () => readonly string[]
}

export interface Phase7bMemoryOutboxLeakSentinels {
  readonly content: readonly string[]
  readonly identity: readonly string[]
}

export interface Phase7bMemoryOutboxLeakCounts {
  readonly contentLeakCount: number
  readonly identityLeakCount: number
}

interface RedisAccounting {
  readonly recordCount: number
  readonly generationCount: number
  readonly recordEntryBytes: number
  readonly expiryIndexBytes: number
  readonly lruIndexBytes: number
  readonly dynamicMetadataBytes: number
  readonly staticBytes: number
  readonly totalLogicalBytes: number
}

interface FixtureResult {
  readonly sqlitePageSizeBytes: number
  readonly sqlitePageCacheBytes: number
  readonly sqliteMainFileBytes: number
  readonly sqliteWalFileBytes: number
  readonly sqliteShmFileBytes: number
  readonly canonicalActiveRecords: number
  readonly canonicalRevisionRecords: number
  readonly canonicalLogicalBytes: number
  readonly outboxRecords: number
  readonly outboxLogicalBytes: number
  readonly redisRecords: number
  readonly redisGenerations: number
  readonly redisRecordEntryBytes: number
  readonly redisExpiryIndexBytes: number
  readonly redisLruIndexBytes: number
  readonly redisDynamicMetadataBytes: number
  readonly redisStaticBytes: number
  readonly redisLogicalBytes: number
  readonly contentLeakCount: number
  readonly identityLeakCount: number
  readonly sqliteClosed: boolean
  readonly redisReleased: boolean
}

const SAMPLE_KEYS = Object.freeze([
  'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes', 'wallTimeMs',
  'userCpuMicros', 'systemCpuMicros', 'sqlitePageSizeBytes', 'sqlitePageCacheBytes',
  'sqliteMainFileBytes', 'sqliteWalFileBytes', 'sqliteShmFileBytes',
  'canonicalActiveRecords', 'canonicalRevisionRecords', 'canonicalLogicalBytes',
  'outboxRecords', 'outboxLogicalBytes', 'redisRecords', 'redisGenerations',
  'redisRecordEntryBytes', 'redisExpiryIndexBytes', 'redisLruIndexBytes',
  'redisDynamicMetadataBytes', 'redisStaticBytes', 'redisLogicalBytes',
  'contentLeakCount', 'identityLeakCount', 'sqliteClosed', 'redisReleased',
  'timerResourceDelta', 'outcome'
] as const)

function fail (): never {
  throw new TypeError('Phase 7B memory resource verification failed')
}

function limitExceeded (): never {
  throw new TypeError('Phase 7B memory resource limit exceeded')
}

function leakDetected (): never {
  throw new TypeError('Phase 7B memory leak detected')
}

function lifecycleFailed (): never {
  throw new TypeError('Phase 7B memory resource not closed or released')
}

function exactRecord (value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const result = value as Record<string, unknown>
  const keys = Object.keys(result)
  if (keys.length !== SAMPLE_KEYS.length || SAMPLE_KEYS.some(key => !Object.hasOwn(result, key))) {
    return fail()
  }
  return result
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return fail()
  return value
}

function positiveInteger (value: unknown): number {
  const result = nonnegativeInteger(value)
  if (result === 0) return fail()
  return result
}

function boundedNonnegativeInteger (value: unknown, maximum: number): number {
  const result = nonnegativeInteger(value)
  if (result > maximum) return limitExceeded()
  return result
}

function boundedPositiveInteger (value: unknown, maximum: number): number {
  const result = positiveInteger(value)
  if (result > maximum) return limitExceeded()
  return result
}

export function normalizePhase7bMaxRssBytes (
  rawMaxRss: number,
  currentRssBytes: number
): number {
  if (!Number.isSafeInteger(rawMaxRss) || rawMaxRss <= 0 ||
    !Number.isSafeInteger(currentRssBytes) || currentRssBytes <= 0) return fail()
  const normalized = rawMaxRss >= currentRssBytes ? rawMaxRss : rawMaxRss * 1_024
  if (!Number.isSafeInteger(normalized) || normalized <= 0) return fail()
  return normalized
}

export function validatePhase7bMemoryResourceSample (
  value: unknown,
  expectedScenario?: Phase7bMemoryResourceScenarioName
): Phase7bMemoryResourceSample {
  const sample = exactRecord(value)
  if (sample.scenario !== 'fixtureLifecycle' ||
    (expectedScenario !== undefined && sample.scenario !== expectedScenario) ||
    sample.outcome !== PHASE_7B_MEMORY_RESOURCE_OUTCOMES.fixtureLifecycle) return fail()
  const baseline = positiveInteger(sample.baselineRssBytes)
  const retained = positiveInteger(sample.retainedRssBytes)
  const peak = positiveInteger(sample.peakRssBytes)
  if (peak < baseline || peak < retained) return fail()
  nonnegativeInteger(sample.wallTimeMs)
  nonnegativeInteger(sample.userCpuMicros)
  nonnegativeInteger(sample.systemCpuMicros)
  if (positiveInteger(sample.sqlitePageSizeBytes) !== 4 * 1_024 ||
    positiveInteger(sample.sqlitePageCacheBytes) !== MEMORY_RESOURCE_LIMITS.sqlitePageCacheBytes) {
    return fail()
  }
  boundedPositiveInteger(sample.sqliteMainFileBytes, MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes)
  boundedNonnegativeInteger(
    sample.sqliteWalFileBytes,
    MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes
  )
  boundedNonnegativeInteger(sample.sqliteShmFileBytes, PHASE_7B_MEMORY_SQLITE_SHM_LIMIT_BYTES)
  boundedPositiveInteger(sample.canonicalActiveRecords, MEMORY_RESOURCE_LIMITS.namespaceActiveRecords)
  boundedPositiveInteger(
    sample.canonicalRevisionRecords,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
  )
  boundedPositiveInteger(
    sample.canonicalLogicalBytes,
    MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes
  )
  boundedPositiveInteger(sample.outboxRecords, MEMORY_RESOURCE_LIMITS.unackedOutboxRecords)
  boundedPositiveInteger(sample.outboxLogicalBytes, MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes)
  boundedPositiveInteger(sample.redisRecords, MEMORY_RESOURCE_LIMITS.redisHotRecords)
  boundedPositiveInteger(sample.redisGenerations, MEMORY_RESOURCE_LIMITS.deploymentNamespaces)
  boundedNonnegativeInteger(sample.redisRecordEntryBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes)
  boundedNonnegativeInteger(sample.redisExpiryIndexBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes)
  boundedNonnegativeInteger(sample.redisLruIndexBytes, MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes)
  boundedNonnegativeInteger(
    sample.redisDynamicMetadataBytes,
    MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
  )
  if (positiveInteger(sample.redisStaticBytes) !== MEMORY_HOT_CACHE_STATIC_BYTES) return fail()
  const redisLogicalBytes = boundedPositiveInteger(
    sample.redisLogicalBytes,
    MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
  )
  if (redisLogicalBytes !== Number(sample.redisRecordEntryBytes) +
    Number(sample.redisExpiryIndexBytes) + Number(sample.redisLruIndexBytes) +
    Number(sample.redisDynamicMetadataBytes) + Number(sample.redisStaticBytes)) {
    return limitExceeded()
  }
  if (nonnegativeInteger(sample.contentLeakCount) !== 0 ||
    nonnegativeInteger(sample.identityLeakCount) !== 0) return leakDetected()
  if (sample.sqliteClosed !== true || sample.redisReleased !== true) return lifecycleFailed()
  if (nonnegativeInteger(sample.timerResourceDelta) !== 0) return lifecycleFailed()
  return Object.freeze(value as Phase7bMemoryResourceSample)
}

function fixedCounter (value: number): string {
  return String(value).padStart(16, '0')
}

function exactStrings (actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function uniqueFrozenStrings (values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)])
}

export function buildPhase7bMemoryOutboxLeakSentinels<
  TRecord extends Readonly<{
    text: string
    contentHash: string
    consent: Readonly<{ approvedByActorRef: string }>
    sources: readonly Readonly<{
      normalizedText: string
      sourceId: string
      contentHash: string
      messageId: string | null
      resourceRefs: readonly string[]
    }>[]
  }>,
  TRevision extends Readonly<{
    changedByActorRef: string
    revisionHash: string
  }>
> (
  record: TRecord,
  revision: TRevision
): Phase7bMemoryOutboxLeakSentinels {
  const content = uniqueFrozenStrings([
    record.text,
    ...record.sources.flatMap(source => [
      source.normalizedText,
      source.sourceId,
      source.contentHash
    ]),
    record.contentHash,
    revision.revisionHash
  ])
  const identity = uniqueFrozenStrings([
    record.consent.approvedByActorRef,
    revision.changedByActorRef,
    ...record.sources.flatMap(source => [
      ...(source.messageId === null ? [] : [source.messageId]),
      ...source.resourceRefs
    ])
  ])
  return Object.freeze({ content, identity })
}

export function countPhase7bMemoryOutboxLeaks (
  wires: readonly string[],
  sentinels: Phase7bMemoryOutboxLeakSentinels
): Phase7bMemoryOutboxLeakCounts {
  if (!Array.isArray(wires) || wires.length > MEMORY_RESOURCE_LIMITS.operationBatchRecords ||
    !Array.isArray(sentinels.content) || !Array.isArray(sentinels.identity) ||
    [...wires, ...sentinels.content, ...sentinels.identity].some(value => (
      typeof value !== 'string' || value === ''
    ))) return fail()
  const count = (values: readonly string[]): number => values.reduce(
    (total, sentinel) => total + wires.filter(wire => wire.includes(sentinel)).length,
    0
  )
  return Object.freeze({
    contentLeakCount: count(sentinels.content),
    identityLeakCount: count(sentinels.identity)
  })
}

class ScenarioRedisClient implements RedisMemoryHotCacheClient {
  #put: readonly string[] | null
  #peek: readonly string[] | null
  #confirm: readonly string[] | null
  #usage: RedisAccounting | null
  #wire: string | null
  #operationIndex = 0
  #stored = false
  #released = false

  constructor (record: MemoryRecordV1) {
    const wire = encodeMemoryRecordV1(record)
    const field = memoryHotCacheRecordFieldV1({
      namespaceRef: record.namespaceRef,
      namespaceGeneration: record.namespaceGeneration,
      memoryId: record.memoryId
    })
    const generationField = memoryHotCacheNamespaceFieldV1(record.namespaceRef)
    const headField = memoryHotCacheHeadFieldV1(field)
    const generation = fixedCounter(record.namespaceGeneration)
    const headValue = memoryHotCacheHeadValueV1(record.revision, field)
    const validUntil = String(Date.parse(record.retention.validUntil))
    const recordEntryBytes = memoryHotCacheRecordEntryBytesV1(field, wire)
    const expiryIndexBytes = memoryHotCacheIndexEntryBytesV1(field)
    const lruIndexBytes = memoryHotCacheIndexEntryBytesV1(field)
    const dynamicMetadataBytes = memoryHotCacheMetadataEntryBytesV1(
      generationField,
      generation
    ) + memoryHotCacheMetadataEntryBytesV1(headField, headValue)
    this.#wire = wire
    this.#put = Object.freeze([
      'put', field, generationField, headField, generation,
      fixedCounter(record.revision), wire, validUntil
    ])
    this.#peek = Object.freeze([
      'peek', field, generationField, headField, generation, headValue
    ])
    this.#confirm = Object.freeze([
      'confirm_hit', field, generationField, headField, generation, headValue, wire, validUntil
    ])
    this.#usage = Object.freeze({
      recordCount: 1,
      generationCount: 1,
      recordEntryBytes,
      expiryIndexBytes,
      lruIndexBytes,
      dynamicMetadataBytes,
      staticBytes: MEMORY_HOT_CACHE_STATIC_BYTES,
      totalLogicalBytes: MEMORY_HOT_CACHE_STATIC_BYTES + recordEntryBytes +
        expiryIndexBytes + lruIndexBytes + dynamicMetadataBytes
    })
  }

  async eval (
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown> {
    if (this.#released || script !== MEMORY_HOT_CACHE_LUA_SCRIPT ||
      !exactStrings(options.keys, MEMORY_HOT_CACHE_KEYS)) return fail()
    const expected = [this.#put, this.#peek, this.#confirm, ['usage']][this.#operationIndex]
    if (expected === undefined || expected === null ||
      !exactStrings(options.arguments, expected)) return fail()
    this.#operationIndex += 1
    if (options.arguments[0] === 'put') {
      this.#stored = true
      return 'stored'
    }
    if (!this.#stored) return fail()
    if (options.arguments[0] === 'peek') {
      if (this.#wire === null) return fail()
      return Object.freeze(['candidate', this.#wire])
    }
    if (options.arguments[0] === 'confirm_hit') return 'hit'
    if (this.#usage === null) return fail()
    return Object.freeze([
      'usage',
      fixedCounter(this.#usage.recordCount),
      fixedCounter(this.#usage.generationCount),
      fixedCounter(this.#usage.recordEntryBytes),
      fixedCounter(this.#usage.expiryIndexBytes),
      fixedCounter(this.#usage.lruIndexBytes),
      fixedCounter(this.#usage.dynamicMetadataBytes),
      fixedCounter(this.#usage.staticBytes),
      fixedCounter(this.#usage.totalLogicalBytes)
    ])
  }

  release (): void {
    this.#stored = false
    this.#operationIndex = 0
    this.#put = null
    this.#peek = null
    this.#confirm = null
    this.#usage = null
    this.#wire = null
    this.#released = true
  }

  isReleased (): boolean {
    return this.#released && this.#put === null && this.#peek === null &&
      this.#confirm === null && this.#usage === null && this.#wire === null
  }
}

function fixtureRecord (): Readonly<{
  record: MemoryRecordV1
  namespace: ReturnType<typeof createMemoryNamespaceV1>
  identitySentinels: readonly string[]
}> {
  const namespace = createMemoryNamespaceV1({
    botInstanceId: BOT_INSTANCE_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    scope: { kind: 'personal', subjectUserId: SUBJECT_USER_ID }
  })
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const actor = createQqIdentitySnapshotV1({
    userId: SUBJECT_USER_ID,
    nickname: NICKNAME,
    groupCard: GROUP_CARD,
    groupTitle: GROUP_TITLE,
    groupRole: 'member'
  })
  const source = createMemorySourceV1({
    sourceKind: 'current_message',
    messageId: 'message:phase7b-fixture',
    actor,
    scene: {
      kind: 'group',
      groupId: GROUP_ID,
      groupLifecycleId: GROUP_LIFECYCLE_ID,
      groupName: GROUP_NAME
    },
    observedAt: OBSERVED_AT,
    normalizedText: SOURCE_TEXT,
    resourceRefs: ['resource:phase7b-fixture']
  })
  const record = createMemoryRecordV1({
    memoryId: 'memory:phase7b-fixture',
    revision: 1,
    namespace,
    namespaceRef,
    namespaceGeneration: 1,
    kind: 'preference',
    text: RECORD_TEXT,
    sources: [source],
    createdAt: CONFIRMED_AT,
    observedAt: OBSERVED_AT,
    confirmedAt: CONFIRMED_AT,
    updatedAt: CONFIRMED_AT,
    validity: { state: 'current', validFrom: OBSERVED_AT },
    confidence: 0.9,
    consent: {
      state: 'explicit',
      approvedByActorRef: ACTOR_REF,
      evidenceSourceId: source.sourceId,
      policyRef: null,
      approvedAt: CONFIRMED_AT
    },
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    supersedes: [],
    retention: { validUntil: VALID_UNTIL, purgeAt: PURGE_AT },
    deletionState: 'active'
  })
  return Object.freeze({
    record,
    namespace,
    identitySentinels: Object.freeze([
      BOT_INSTANCE_ID,
      ACCOUNT_ID,
      SUBJECT_USER_ID,
      GROUP_ID,
      GROUP_LIFECYCLE_ID,
      NICKNAME,
      GROUP_CARD,
      GROUP_TITLE,
      GROUP_NAME
    ])
  })
}

function pragmaInteger (store: SqliteMemoryDatabaseV1, name: 'page_size' | 'cache_size'): number {
  const row = store.database.prepare(`PRAGMA ${name}`).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail()
  return value
}

function fileBytes (location: string): number {
  try {
    const bytes = statSync(location).size
    return nonnegativeInteger(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    return fail()
  }
}

function timeoutCount (resources: readonly string[]): number {
  return resources.filter(resource => resource === 'Timeout').length
}

function settleDelay (value: number | undefined): number {
  const result = value ?? 25
  if (!Number.isSafeInteger(result) || result < 0 || result > 1_000) return fail()
  return result
}

async function runFixture (): Promise<FixtureResult> {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-phase7b-memory-'))
  const location = path.join(directory, 'memory.sqlite')
  let store: SqliteMemoryDatabaseV1 | undefined
  let client: ScenarioRedisClient | undefined
  let sqliteClosed = false
  let redisReleased = false
  let directoryRemoved = false
  let measured: Omit<FixtureResult, 'sqliteClosed' | 'redisReleased'> | undefined
  try {
    const fixture = fixtureRecord()
    store = openSqliteMemoryDatabaseV1({ location, now: () => FIXED_NOW })
    const repository = createSqliteMemoryRepositoryV1({
      database: store.database,
      now: () => FIXED_NOW
    })
    const capability = issueMemoryAccessCapabilityV1(
      createMemoryAccessCapabilityIssuerV1(() => true),
      {
        schemaVersion: 1,
        botInstanceId: BOT_INSTANCE_ID,
        adapter: 'qq',
        accountId: ACCOUNT_ID,
        scene: { kind: 'private', peerUserId: SUBJECT_USER_ID }
      },
      [fixture.namespace],
      FIXED_NOW
    )
    const revision = createMemoryRevisionV1({
      memoryId: fixture.record.memoryId,
      revision: 1,
      operation: 'created',
      record: fixture.record,
      changedByActorRef: ACTOR_REF,
      changedAt: fixture.record.updatedAt,
      reason: null,
      previousRevisionHash: null
    })
    const dynamicLeakSentinels = buildPhase7bMemoryOutboxLeakSentinels(
      fixture.record,
      revision
    )
    const created = await repository.execute({
      schemaVersion: 1,
      operation: 'record.create',
      capability,
      namespaceRef: fixture.record.namespaceRef,
      expectedNamespaceGeneration: 1,
      initialRevision: revision
    })
    if (created.status !== 'stored') return fail()
    const usage = await repository.execute({
      schemaVersion: 1,
      operation: 'usage.get',
      capability,
      namespaceRef: fixture.record.namespaceRef
    })
    if (usage.status !== 'usage') return fail()
    const outboxRows = store.database.prepare(`
      SELECT event_wire, logical_bytes FROM outbox ORDER BY sequence ASC
    `).all()
    if (outboxRows.length !== usage.value.pendingOutboxRecords) return fail()
    const wires = outboxRows.map(row => {
      if (typeof row.event_wire !== 'string' || typeof row.logical_bytes !== 'number' ||
        row.logical_bytes !== Buffer.byteLength(row.event_wire, 'utf8')) return fail()
      decodeMemoryOutboxEventV1(row.event_wire)
      return row.event_wire
    })
    if (outboxRows.reduce((bytes, row) => bytes + Number(row.logical_bytes), 0) !==
      usage.value.outboxLogicalBytes) return fail()
    const leakCounts = countPhase7bMemoryOutboxLeaks(wires, {
      content: dynamicLeakSentinels.content,
      identity: uniqueFrozenStrings([
        ...fixture.identitySentinels,
        ...dynamicLeakSentinels.identity
      ])
    })

    client = new ScenarioRedisClient(fixture.record)
    const cache = new RedisMemoryHotCache({ client })
    if ((await cache.execute({
      schemaVersion: 1,
      operation: 'record.put',
      record: fixture.record
    })).status !== 'stored') return fail()
    const cacheRead = await cache.execute({
      schemaVersion: 1,
      operation: 'record.get',
      head: {
        namespaceRef: fixture.record.namespaceRef,
        namespaceGeneration: fixture.record.namespaceGeneration,
        memoryId: fixture.record.memoryId,
        revision: fixture.record.revision,
        contentHash: fixture.record.contentHash
      }
    })
    if (cacheRead.status !== 'hit' || cacheRead.record.contentHash !== fixture.record.contentHash) {
      return fail()
    }
    const cacheUsage = await cache.execute({ schemaVersion: 1, operation: 'usage.get' })
    if (cacheUsage.status !== 'usage') return fail()

    const pageSize = pragmaInteger(store, 'page_size')
    const cacheSize = pragmaInteger(store, 'cache_size')
    if (cacheSize >= 0) return fail()
    measured = Object.freeze({
      sqlitePageSizeBytes: pageSize,
      sqlitePageCacheBytes: Math.abs(cacheSize) * 1_024,
      sqliteMainFileBytes: fileBytes(location),
      sqliteWalFileBytes: fileBytes(`${location}-wal`),
      sqliteShmFileBytes: fileBytes(`${location}-shm`),
      canonicalActiveRecords: usage.value.activeMemoryRecords,
      canonicalRevisionRecords: usage.value.retainedRevisionRecords,
      canonicalLogicalBytes: usage.value.canonicalLogicalBytes,
      outboxRecords: usage.value.pendingOutboxRecords,
      outboxLogicalBytes: usage.value.outboxLogicalBytes,
      redisRecords: cacheUsage.value.recordCount,
      redisGenerations: cacheUsage.value.generationCount,
      redisRecordEntryBytes: cacheUsage.value.recordEntryBytes,
      redisExpiryIndexBytes: cacheUsage.value.expiryIndexBytes,
      redisLruIndexBytes: cacheUsage.value.lruIndexBytes,
      redisDynamicMetadataBytes: cacheUsage.value.dynamicMetadataBytes,
      redisStaticBytes: cacheUsage.value.staticBytes,
      redisLogicalBytes: cacheUsage.value.totalLogicalBytes,
      contentLeakCount: leakCounts.contentLeakCount,
      identityLeakCount: leakCounts.identityLeakCount
    })
  } finally {
    try {
      if (store !== undefined) {
        try { store.close() } catch {}
        try { store.close() } catch {}
        try {
          store.database.prepare('SELECT 1')
        } catch {
          sqliteClosed = true
        }
      }
    } finally {
      try {
        if (client !== undefined) {
          try { client.release() } catch {}
          try { client.release() } catch {}
          try {
            await client.eval(MEMORY_HOT_CACHE_LUA_SCRIPT, {
              keys: [...MEMORY_HOT_CACHE_KEYS],
              arguments: ['usage']
            })
          } catch {
            try { redisReleased = client.isReleased() } catch {}
          }
        }
      } finally {
        try {
          rmSync(directory, { recursive: true, force: true })
          directoryRemoved = !existsSync(directory)
        } catch {}
      }
    }
  }
  if (measured === undefined || !sqliteClosed || !redisReleased || !directoryRemoved) return fail()
  return Object.freeze({ ...measured, sqliteClosed, redisReleased })
}

export async function runPhase7bMemoryResourceScenario (
  options: Phase7bMemoryResourceScenarioOptions = {}
): Promise<Phase7bMemoryResourceSample> {
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage())
  const cpuUsage = options.cpuUsage ?? process.cpuUsage.bind(process)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const activeResourcesInfo = options.activeResourcesInfo ?? (() => process.getActiveResourcesInfo())
  const collect = options.gc ?? (globalThis as typeof globalThis & { gc?: () => void }).gc
  const timerBaseline = timeoutCount(activeResourcesInfo())
  collect?.()
  const baselineRssBytes = positiveInteger(memoryUsage().rss)
  const observations = [baselineRssBytes]
  const cpuStart = cpuUsage()
  const wallStart = monotonicNow()
  const result = await runFixture()
  observations.push(positiveInteger(memoryUsage().rss))
  collect?.()
  const wait = settleDelay(options.settleMs)
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  const retainedRssBytes = positiveInteger(memoryUsage().rss)
  observations.push(retainedRssBytes)
  const cpu = cpuUsage(cpuStart)
  const timerResourceDelta = timeoutCount(activeResourcesInfo()) - timerBaseline
  const peakRssBytes = Math.max(
    ...observations,
    normalizePhase7bMaxRssBytes(resourceUsage().maxRSS, retainedRssBytes)
  )
  return validatePhase7bMemoryResourceSample(Object.freeze({
    scenario: 'fixtureLifecycle' as const,
    baselineRssBytes,
    retainedRssBytes,
    peakRssBytes,
    wallTimeMs: nonnegativeInteger(Math.trunc(monotonicNow() - wallStart)),
    userCpuMicros: nonnegativeInteger(cpu.user),
    systemCpuMicros: nonnegativeInteger(cpu.system),
    ...result,
    timerResourceDelta,
    outcome: PHASE_7B_MEMORY_RESOURCE_OUTCOMES.fixtureLifecycle
  }), 'fixtureLifecycle')
}
