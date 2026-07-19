import type { RedisSessionClient } from '../../src/agent/session/redis-session-store.js'
import {
  RUN_STORE_LUA_MARKER,
  RUN_STORE_MIGRATION_LUA_MARKER,
  RUN_STORE_METADATA_KEY,
  type RedisRunClient
} from '../../src/agent/run/redis-run-store.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import {
  CONTEXT_ARTIFACT_METADATA_KEY,
  CONTEXT_ARTIFACT_STORE_LUA_MARKER
} from '../../src/agent/context/redis-context-artifact-store.js'
import { CONTEXT_ARTIFACT_RESOURCE_LIMITS } from '../../src/agent/context/context-resource-limits.js'
import {
  TRACE_BYTES_KEY,
  TRACE_FAILURE_INDEX_KEY,
  TRACE_GENERATION_KEY,
  TRACE_STORE_LUA_MARKER,
  TRACE_STORE_LIMITS,
  TRACE_SUCCESS_INDEX_KEY
} from '../../src/runtime/observability/redis-trace-store.js'
import {
  MEMORY_HOT_CACHE_COUNTER_FIELDS,
  MEMORY_HOT_CACHE_KEYS,
  MEMORY_HOT_CACHE_LUA_MARKER,
  MEMORY_HOT_CACHE_SCRIPT_VERSION,
  MEMORY_HOT_CACHE_STATIC_BYTES,
  memoryHotCacheHeadFieldV1,
  memoryHotCacheHeadValueV1,
  memoryHotCacheIndexEntryBytesV1,
  memoryHotCacheMetadataEntryBytesV1,
  memoryHotCacheRecordEntryBytesV1
} from '../../src/agent/memory/redis-memory-hot-cache.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'

interface FakeRedisEntry {
  readonly value: string
  readonly expiresAtMs?: number
}

export class FakeRedis implements RedisSessionClient, RedisRunClient {
  infoCalls = 0
  readonly getCalls: string[] = []
  readonly scanCalls: Array<{ cursor: number; MATCH: string; COUNT: number }> = []
  readonly setCalls: Array<{ key: string; options?: { EX?: number; NX?: boolean; XX?: boolean } }> = []
  readonly evalCalls: Array<{ marker: string; operation: string; argumentBytes: number[] }> = []
  private readonly entries = new Map<string, FakeRedisEntry>()
  private readonly sortedSets = new Map<string, Map<string, number>>()
  private readonly traceLengths = new Map<string, number>()
  private readonly memoryHotRecords = new Map<string, string>()
  private readonly memoryHotExpires = new Map<string, number>()
  private readonly memoryHotLru = new Map<string, number>()
  private readonly memoryHotMetadata = new Map<string, string>()
  private memoryHotScriptVersion: string | null = null
  private memoryHotEvalHook?: (operation: string) => boolean
  private memoryHotEvalFailure = false
  private genericExpirySweepVisits = 0
  private readonly pendingGetFailures = new Set<string>()
  private artifactEvalHook?: (operation: string) => boolean
  private artifactTtlComputationHook?: () => void
  private redisServerInfo = '# Server\r\nredis_version:7.2.4\r\n'
  private readonly now: () => number

  constructor (now: () => number = () => Date.now()) {
    this.now = now
  }

  async info (section?: string): Promise<string> {
    this.infoCalls += 1
    if (section !== undefined && section !== 'server') {
      throw new TypeError('fake Redis INFO section is invalid')
    }
    return this.redisServerInfo
  }

  setServerInfoForTest (value: string): void {
    this.redisServerInfo = value
  }

  async get (key: string): Promise<string | null> {
    this.getCalls.push(key)
    if (this.pendingGetFailures.delete(key)) throw new Error('fake redis get failure')
    this.purgeExpired(key)
    return this.entries.get(key)?.value ?? null
  }

  failNextGet (key: string): void {
    this.pendingGetFailures.add(key)
  }

  seedArtifactForTest (key: string, value: string, expiresAtMs?: number): void {
    this.entries.set(key, {
      value,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs })
    })
  }

  afterNextArtifactEval (callback: (operation: string) => boolean): void {
    this.artifactEvalHook = callback
  }

  advanceTimeDuringNextArtifactTtl (callback: () => void): void {
    this.artifactTtlComputationHook = callback
  }

  artifactExpiryForTest (key: string): number | null {
    return this.entries.get(key)?.expiresAtMs ?? null
  }

  memoryHotSnapshotForTest (): Readonly<{
    topLevelKeys: readonly string[]
    records: readonly (readonly [string, string])[]
    expires: readonly (readonly [string, number])[]
    lru: readonly (readonly [string, number])[]
    metadata: readonly (readonly [string, string])[]
    scriptVersion: string | null
  }> {
    const sorted = <T>(value: Map<string, T>): readonly (readonly [string, T])[] => (
      Object.freeze([...value.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(entry => Object.freeze(entry)))
    )
    const hasState = this.memoryHotScriptVersion !== null || this.memoryHotRecords.size > 0 ||
      this.memoryHotExpires.size > 0 || this.memoryHotLru.size > 0 ||
      this.memoryHotMetadata.size > 0
    return Object.freeze({
      topLevelKeys: hasState ? MEMORY_HOT_CACHE_KEYS : Object.freeze([]),
      records: sorted(this.memoryHotRecords),
      expires: sorted(this.memoryHotExpires),
      lru: sorted(this.memoryHotLru),
      metadata: sorted(this.memoryHotMetadata),
      scriptVersion: this.memoryHotScriptVersion
    })
  }

  memoryHotExpiryForTest (field: string): number | null {
    return this.memoryHotExpires.get(field) ?? null
  }

  memoryHotLruForTest (field: string): number | null {
    return this.memoryHotLru.get(field) ?? null
  }

  corruptMemoryHotRecordForTest (field: string, wire: string): void {
    const current = this.memoryHotRecords.get(field)
    if (current === undefined) throw new TypeError('memory hot record is missing')
    const state = this.parseMemoryHotState()
    if (state === null) throw new TypeError('memory hot metadata is invalid')
    state.recordEntryBytes += this.bytes(wire) - this.bytes(current)
    this.memoryHotRecords.set(field, wire)
    this.saveMemoryHotState(state)
  }

  replaceMemoryHotRecordForTest (field: string, wire: string, revision: number): void {
    this.corruptMemoryHotRecordForTest(field, wire)
    this.memoryHotMetadata.set(
      memoryHotCacheHeadFieldV1(field),
      memoryHotCacheHeadValueV1(revision, field)
    )
  }

  afterNextMemoryHotEval (callback: (operation: string) => boolean): void {
    this.memoryHotEvalHook = callback
  }

  failNextMemoryHotEval (): void {
    this.memoryHotEvalFailure = true
  }

  corruptMemoryHotMetadataForTest (field: string, value: string | null): void {
    if (value === null) this.memoryHotMetadata.delete(field)
    else this.memoryHotMetadata.set(field, value)
  }

  setMemoryHotScriptVersionForTest (value: string | null): void {
    this.memoryHotScriptVersion = value
  }

  seedMemoryHotEntriesForTest (input: {
    readonly count: number
    readonly wireBytes: number | readonly number[]
    readonly expiresAtMs: number | readonly number[]
    readonly lruMs: number | readonly number[]
    readonly allowOverLimit?: boolean
  }): void {
    if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 2_048) {
      throw new TypeError('memory hot seed count is invalid')
    }
    this.memoryHotRecords.clear()
    this.memoryHotExpires.clear()
    this.memoryHotLru.clear()
    this.memoryHotMetadata.clear()
    this.memoryHotScriptVersion = null
    if (!this.initializeMemoryHot()) throw new TypeError('memory hot seed initialization failed')
    const generationField = `g:${'a'.repeat(64)}`
    const generationValue = '0000000000000001'
    this.memoryHotMetadata.set(generationField, generationValue)
    const state = {
      recordCount: 0,
      generationCount: 1,
      recordEntryBytes: 0,
      expiryIndexBytes: 0,
      lruIndexBytes: 0,
      dynamicMetadataBytes: memoryHotCacheMetadataEntryBytesV1(
        generationField,
        generationValue
      )
    }
    const selected = (
      value: number | readonly number[],
      index: number
    ): number => typeof value === 'number' ? value : value[index] ?? Number.NaN
    for (let index = 0; index < input.count; index += 1) {
      const field = index.toString(16).padStart(64, '0')
      const wireLength = selected(input.wireBytes, index)
      const expiry = selected(input.expiresAtMs, index)
      const lru = selected(input.lruMs, index)
      if (!Number.isSafeInteger(wireLength) || wireLength < 0 ||
        !Number.isSafeInteger(expiry) || !Number.isSafeInteger(lru)) {
        throw new TypeError('memory hot seed entry is invalid')
      }
      const wire = 'x'.repeat(wireLength)
      const headField = memoryHotCacheHeadFieldV1(field)
      const headValue = memoryHotCacheHeadValueV1(1, field)
      this.memoryHotRecords.set(field, wire)
      this.memoryHotExpires.set(field, expiry)
      this.memoryHotLru.set(field, lru)
      this.memoryHotMetadata.set(headField, headValue)
      state.recordCount += 1
      state.recordEntryBytes += memoryHotCacheRecordEntryBytesV1(field, wire)
      state.expiryIndexBytes += memoryHotCacheIndexEntryBytesV1(field)
      state.lruIndexBytes += memoryHotCacheIndexEntryBytesV1(field)
      state.dynamicMetadataBytes += memoryHotCacheMetadataEntryBytesV1(headField, headValue)
    }
    if (input.allowOverLimit !== true &&
      this.memoryHotTotalBytes(state) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) {
      throw new TypeError('memory hot seed exceeds logical bytes')
    }
    this.saveMemoryHotState(state)
  }

  seedUnrelatedKeysForTest (count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('unrelated key count is invalid')
    for (let index = 0; index < count; index += 1) {
      this.entries.set(`UNRELATED:${index}`, { value: 'x' })
    }
  }

  genericExpirySweepVisitsForTest (): number {
    return this.genericExpirySweepVisits
  }

  seedTraceForTest (input: {
    readonly key: string
    readonly value: string
    readonly expiresAtMs: number
    readonly index: 'success' | 'failure'
    readonly logicalBytes: number
  }): void {
    this.entries.set(input.key, {
      value: input.value,
      expiresAtMs: input.expiresAtMs
    })
    this.traceLengths.set(input.key, input.logicalBytes)
    this.zadd(
      input.index === 'success' ? TRACE_SUCCESS_INDEX_KEY : TRACE_FAILURE_INDEX_KEY,
      input.key,
      input.expiresAtMs
    )
    this.saveTraceBytes()
  }

  async set (key: string, value: string, options?: { EX?: number; NX?: boolean; XX?: boolean }): Promise<string | null> {
    this.purgeExpired(key)
    this.setCalls.push({ key, options })
    if (options?.NX === true && this.entries.has(key)) return null
    if (options?.XX === true && !this.entries.has(key)) return null
    this.entries.set(key, {
      value,
      ...(options?.EX === undefined ? {} : { expiresAtMs: this.now() + options.EX * 1000 })
    })
    return 'OK'
  }

  async getDel (key: string): Promise<string | null> {
    this.purgeExpired(key)
    const value = this.entries.get(key)?.value ?? null
    this.entries.delete(key)
    return value
  }

  async del (key: string | readonly string[]): Promise<number> {
    const keys = typeof key === 'string' ? [key] : key
    let deleted = 0
    for (const value of keys) {
      this.purgeExpired(value)
      if (this.entries.delete(value)) deleted += 1
    }
    return deleted
  }

  async ttl (key: string): Promise<number> {
    this.purgeExpired(key)
    const entry = this.entries.get(key)
    if (entry === undefined) return -2
    if (entry.expiresAtMs === undefined) return -1
    return Math.floor((entry.expiresAtMs - this.now()) / 1000)
  }

  async scan (cursor: number, options: { MATCH: string; COUNT: number }): Promise<{
    cursor: number
    keys: string[]
  }> {
    this.purgeAllExpired()
    this.scanCalls.push({ cursor, ...options })
    const prefix = options.MATCH.endsWith('*')
      ? options.MATCH.slice(0, -1)
      : options.MATCH
    const keys = [...this.entries.keys()]
      .filter(key => options.MATCH.endsWith('*') ? key.startsWith(prefix) : key === prefix)
      .sort()
    const page = keys.slice(cursor, cursor + options.COUNT)
    const nextCursor = cursor + options.COUNT >= keys.length ? 0 : cursor + options.COUNT
    return { cursor: nextCursor, keys: page }
  }

  async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    const marker = script.split('\n', 1)[0] ?? ''
    const operation = options.arguments[0] ?? ''
    this.evalCalls.push({
      marker,
      operation,
      argumentBytes: options.arguments.map(value => this.bytes(value))
    })
    if (marker === MEMORY_HOT_CACHE_LUA_MARKER) {
      if (this.memoryHotEvalFailure) {
        this.memoryHotEvalFailure = false
        throw new Error('fake memory hot eval failure')
      }
      const result = this.evalMemoryHot(operation, options.keys, options.arguments)
      const hook = this.memoryHotEvalHook
      if (hook?.(operation) === true) this.memoryHotEvalHook = undefined
      return result
    }
    this.purgeAllExpired()
    if (marker === CONTEXT_ARTIFACT_STORE_LUA_MARKER) {
      const result = this.evalArtifact(operation, options.keys, options.arguments)
      const hook = this.artifactEvalHook
      if (hook?.(operation) === true) this.artifactEvalHook = undefined
      return result
    }
    if (marker === TRACE_STORE_LUA_MARKER) {
      return this.evalTrace(operation, options.keys, options.arguments)
    }
    if (marker === RUN_STORE_MIGRATION_LUA_MARKER) {
      return this.evalRunMigration(options.keys, options.arguments)
    }
    if (marker !== RUN_STORE_LUA_MARKER) {
      throw new TypeError('unsupported Lua script')
    }
    const [checkpointKey, eventKey, tombstoneKey, referenceKey] = options.keys
    const args = options.arguments
    if (operation === 'load') {
      return [
        checkpointKey === undefined ? false : this.entries.get(checkpointKey)?.value ?? false,
        eventKey === undefined ? false : this.entries.get(eventKey)?.value ?? false
      ]
    }
    if (operation === 'reconcile') {
      const metadataKey = options.keys[0]
      if (metadataKey !== RUN_STORE_METADATA_KEY ||
        (this.entryValue(metadataKey) ?? '') !== args[1] || args[2] === undefined) {
        return 'conflict'
      }
      this.entries.set(metadataKey, { value: args[2] })
      return 'ok'
    }
    const metadataKey = options.keys.at(-1)

    if (operation === 'tombstone_delete_corrupt') {
      const key = options.keys[0]
      const value = this.entryValue(key)
      if (value === null) {
        if (metadataKey !== undefined) this.entries.delete(metadataKey)
        return 'missing'
      }
      if (value !== args[1]) {
        if (metadataKey !== undefined) this.entries.delete(metadataKey)
        return 'conflict'
      }
      if (key !== undefined) this.entries.delete(key)
      if (metadataKey !== undefined) this.entries.delete(metadataKey)
      return 'ok'
    }

    const usage = this.parseRunNamespaceUsage(this.entryValue(metadataKey))
    if (metadataKey !== RUN_STORE_METADATA_KEY || usage === null) return 'reconcile'

    if (operation === 'create') {
      if ([checkpointKey, eventKey, tombstoneKey]
        .some(key => key !== undefined && this.entries.has(key))) return 'conflict'
      if (referenceKey !== undefined && this.entries.has(referenceKey)) {
        return 'reference_conflict'
      }
      const projected = {
        ...usage,
        bytes: usage.bytes + this.bytes(args[1]) + this.bytes(args[2]) +
          this.bytes(referenceKey) + this.bytes(args[4]),
        checkpoints: usage.checkpoints + 1,
        events: usage.events + 1,
        references: usage.references + 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(checkpointKey, args[1], Number(args[3]))
      this.setDirect(eventKey, args[2], Number(args[3]))
      this.setDirect(referenceKey, args[4], Number(args[3]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'upgrade') {
      const oldCheckpoint = this.entryValue(checkpointKey)
      const oldEvents = this.entryValue(eventKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
        (tombstoneKey !== undefined && this.entries.has(tombstoneKey))) return 'conflict'
      if (referenceKey !== undefined && this.entries.has(referenceKey)) {
        return 'reference_conflict'
      }
      const projected = {
        ...usage,
        bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents) +
          this.bytes(args[3]) + this.bytes(args[4]) + this.bytes(referenceKey) +
          this.bytes(args[6]),
        references: usage.references + 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(checkpointKey, args[3], Number(args[5]))
      this.setDirect(eventKey, args[4], Number(args[5]))
      this.setDirect(referenceKey, args[6], Number(args[5]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'cas') {
      const oldCheckpoint = this.entryValue(checkpointKey)
      const oldEvents = this.entryValue(eventKey)
      const reference = this.entryValue(referenceKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
        reference !== args[6]) return 'conflict'
      const artifactKeys = options.keys.slice(4, -1)
      if (artifactKeys.some((key, index) => {
        const entry = this.entries.get(key)
        return entry === undefined || entry.expiresAtMs === undefined ||
          entry.expiresAtMs <= this.now() || args[8 + index * 2] !== '1' ||
          entry.value !== args[7 + index * 2]
      })) return 'artifact_missing'
      const projected = {
        bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents) +
          this.bytes(args[3]) + this.bytes(args[4]),
        checkpoints: usage.checkpoints,
        events: usage.events,
        tombstones: usage.tombstones,
        indexes: usage.indexes,
        references: usage.references,
        tombstoneBytes: usage.tombstoneBytes
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(checkpointKey, args[3], Number(args[5]))
      this.setDirect(eventKey, args[4], Number(args[5]))
      this.setDirect(referenceKey, args[6], Number(args[5]))
      for (const key of artifactKeys) {
        const entry = this.entries.get(key)
        if (entry === undefined) throw new TypeError('context artifact disappeared during CAS')
        this.entries.set(key, {
          value: entry.value,
          expiresAtMs: this.now() + Number(args[5]) * 1_000
        })
      }
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'commit_terminal') {
      const oldCheckpoint = this.entryValue(checkpointKey)
      const oldEvents = this.entryValue(eventKey)
      const reference = this.entryValue(referenceKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
        tombstoneKey === undefined || this.entries.has(tombstoneKey) ||
        reference !== args[5]) return 'conflict'
      const projected = {
        bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents) + this.bytes(args[3]),
        checkpoints: usage.checkpoints - 1,
        events: usage.events - 1,
        tombstones: usage.tombstones + 1,
        indexes: usage.indexes,
        references: usage.references,
        tombstoneBytes: usage.tombstoneBytes + this.bytes(args[3])
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      let deleted = 0
      if (checkpointKey !== undefined && this.entries.delete(checkpointKey)) deleted += 1
      if (eventKey !== undefined && this.entries.delete(eventKey)) deleted += 1
      this.setDirect(tombstoneKey, args[3], Number(args[4]))
      this.setDirect(referenceKey, args[5], Number(args[4]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return [
        'ok',
        deleted,
        1,
        this.bytes(oldCheckpoint),
        this.bytes(oldEvents),
        this.bytes(args[3])
      ]
    }

    if (operation === 'admission_acquire') {
      const admissionKey = options.keys[0]
      if (admissionKey === undefined || this.entries.has(admissionKey)) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes + this.bytes(args[1]),
        indexes: usage.indexes + 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(admissionKey, args[1], Number(args[2]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'admission_recover') {
      const admissionKey = options.keys[0]
      const claim = this.entryValue(admissionKey) ?? ''
      if (admissionKey === undefined || claim !== args[1]) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes - this.bytes(claim) + this.bytes(args[2]),
        indexes: usage.indexes + (claim.length === 0 ? 1 : 0)
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(admissionKey, args[2], Number(args[3]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'admission_release') {
      const admissionKey = options.keys[0]
      const claim = this.entryValue(admissionKey)
      if (admissionKey === undefined || claim !== args[1]) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes - this.bytes(claim),
        indexes: usage.indexes - 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      this.entries.delete(admissionKey)
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'approval_index_create') {
      const indexKey = options.keys[0]
      if (indexKey === undefined || this.entries.has(indexKey)) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes + this.bytes(args[1]),
        indexes: usage.indexes + 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(indexKey, args[1], Number(args[2]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'approval_index_delete') {
      const indexKey = options.keys[0]
      const value = this.entryValue(indexKey)
      if (indexKey === undefined || value !== args[1]) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes - this.bytes(value),
        indexes: usage.indexes - 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      this.entries.delete(indexKey)
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    return 'invalid_operation'
  }

  private evalMemoryHot (
    operation: string,
    keys: readonly string[],
    args: readonly string[]
  ): unknown {
    if (keys.length !== MEMORY_HOT_CACHE_KEYS.length ||
      keys.some((key, index) => key !== MEMORY_HOT_CACHE_KEYS[index])) {
      throw new TypeError('invalid memory hot keys')
    }
    if (operation === 'put') {
      if (!this.initializeMemoryHot()) return 'version'
      const state = this.parseMemoryHotState()
      if (state === null) return 'metadata'
      const field = args[1]
      const generationField = args[2]
      const headField = args[3]
      const generationRaw = args[4]
      const revisionRaw = args[5]
      const wire = args[6]
      const validUntilMs = Number(args[7])
      if (field === undefined || generationField === undefined || headField === undefined ||
        generationRaw === undefined || revisionRaw === undefined || wire === undefined ||
        !/^\d{16}$/.test(generationRaw) || !/^\d{16}$/.test(revisionRaw) ||
        !Number.isSafeInteger(validUntilMs)) return 'metadata'
      const generation = Number(generationRaw)
      const revision = Number(revisionRaw)
      const currentTime = this.now()
      if (validUntilMs <= currentTime) return 'expired'
      let removed = this.cleanupExpiredMemoryHot(state, currentTime, 32)
      if (removed < 0) return 'metadata'
      const fenceRaw = this.memoryHotMetadata.get(generationField)
      if (fenceRaw !== undefined) {
        if (!this.validMemoryHotFixed(fenceRaw)) return 'metadata'
        const fence = Number(fenceRaw)
        if (fence > generation) return 'stale'
        if (fence < generation) this.memoryHotMetadata.set(generationField, generationRaw)
      } else {
        if (state.generationCount >= MEMORY_RESOURCE_LIMITS.deploymentNamespaces) return 'capacity'
        const generationBytes = memoryHotCacheMetadataEntryBytesV1(
          generationField,
          generationRaw
        )
        while (this.memoryHotTotalBytes(state) + generationBytes >
          MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes && removed < 32) {
          const evicted = this.evictOldestMemoryHot(state, field)
          if (evicted < 0) return 'metadata'
          if (evicted === 0) break
          removed += evicted
        }
        if (this.memoryHotTotalBytes(state) + generationBytes >
          MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) return 'capacity'
        this.memoryHotMetadata.set(generationField, generationRaw)
        state.generationCount += 1
        state.dynamicMetadataBytes += generationBytes
        this.saveMemoryHotState(state)
      }
      const expectedHead = `${revisionRaw}|${field}`
      const existing = this.memoryHotRecords.get(field)
      const existingHead = this.memoryHotMetadata.get(headField)
      if (existing !== undefined) {
        if (!this.validMemoryHotHead(existingHead, field) ||
          !this.memoryHotExpires.has(field) || !this.memoryHotLru.has(field)) return 'metadata'
        const existingRevision = Number(existingHead.slice(0, 16))
        if (existingRevision > revision) return 'stale'
        if (existingRevision === revision) {
          if (existing !== wire) return 'conflict'
          this.memoryHotLru.set(field, currentTime)
          this.saveMemoryHotState(state)
          return 'unchanged'
        }
        const projectedRecordBytes = state.recordEntryBytes - this.bytes(existing) + this.bytes(wire)
        const projectedMetadataBytes = state.dynamicMetadataBytes - this.bytes(existingHead) +
          this.bytes(expectedHead)
        let nextRecordBytes = projectedRecordBytes
        let nextMetadataBytes = projectedMetadataBytes
        while (this.memoryHotTotalBytes({
          ...state,
          recordEntryBytes: nextRecordBytes,
          dynamicMetadataBytes: nextMetadataBytes
        }) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes && removed < 32) {
          const evicted = this.evictOldestMemoryHot(state, field)
          if (evicted < 0) return 'metadata'
          if (evicted === 0) break
          removed += evicted
          nextRecordBytes = state.recordEntryBytes - this.bytes(existing) + this.bytes(wire)
          nextMetadataBytes = state.dynamicMetadataBytes - this.bytes(existingHead) +
            this.bytes(expectedHead)
        }
        if (this.memoryHotTotalBytes({
          ...state,
          recordEntryBytes: nextRecordBytes,
          dynamicMetadataBytes: nextMetadataBytes
        }) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) return 'capacity'
        this.memoryHotRecords.set(field, wire)
        this.memoryHotMetadata.set(headField, expectedHead)
        this.memoryHotExpires.set(field, currentTime + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs)
        this.memoryHotLru.set(field, currentTime)
        state.recordEntryBytes = nextRecordBytes
        state.dynamicMetadataBytes = nextMetadataBytes
        this.saveMemoryHotState(state)
        return 'stored'
      }
      if (existingHead !== undefined || this.memoryHotExpires.has(field) ||
        this.memoryHotLru.has(field)) return 'metadata'
      const projected = {
        ...state,
        recordCount: state.recordCount + 1,
        recordEntryBytes: state.recordEntryBytes + memoryHotCacheRecordEntryBytesV1(field, wire),
        expiryIndexBytes: state.expiryIndexBytes + memoryHotCacheIndexEntryBytesV1(field),
        lruIndexBytes: state.lruIndexBytes + memoryHotCacheIndexEntryBytesV1(field),
        dynamicMetadataBytes: state.dynamicMetadataBytes +
          memoryHotCacheMetadataEntryBytesV1(headField, expectedHead)
      }
      while ((projected.recordCount > MEMORY_RESOURCE_LIMITS.redisHotRecords ||
        this.memoryHotTotalBytes(projected) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) &&
        removed < 32) {
        const evicted = this.evictOldestMemoryHot(state, field)
        if (evicted < 0) return 'metadata'
        if (evicted === 0) break
        removed += evicted
        projected.recordCount = state.recordCount + 1
        projected.recordEntryBytes = state.recordEntryBytes +
          memoryHotCacheRecordEntryBytesV1(field, wire)
        projected.expiryIndexBytes = state.expiryIndexBytes +
          memoryHotCacheIndexEntryBytesV1(field)
        projected.lruIndexBytes = state.lruIndexBytes + memoryHotCacheIndexEntryBytesV1(field)
        projected.dynamicMetadataBytes = state.dynamicMetadataBytes +
          memoryHotCacheMetadataEntryBytesV1(headField, expectedHead)
      }
      if (projected.recordCount > MEMORY_RESOURCE_LIMITS.redisHotRecords ||
        this.memoryHotTotalBytes(projected) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) {
        return 'capacity'
      }
      this.memoryHotRecords.set(field, wire)
      this.memoryHotExpires.set(field, currentTime + MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs)
      this.memoryHotLru.set(field, currentTime)
      this.memoryHotMetadata.set(headField, expectedHead)
      this.saveMemoryHotState(projected)
      return 'stored'
    }

    if (operation === 'namespace_invalidate' && !this.initializeMemoryHot()) return 'version'
    if (this.memoryHotScriptVersion === null && this.memoryHotEmpty()) return 'missing'
    const state = this.parseMemoryHotState()
    if (state === null) return 'metadata'

    if (operation === 'usage') {
      const fixed = (value: number): string => String(value).padStart(16, '0')
      return [
        'usage',
        fixed(state.recordCount),
        fixed(state.generationCount),
        fixed(state.recordEntryBytes),
        fixed(state.expiryIndexBytes),
        fixed(state.lruIndexBytes),
        fixed(state.dynamicMetadataBytes),
        fixed(MEMORY_HOT_CACHE_STATIC_BYTES),
        fixed(this.memoryHotTotalBytes(state))
      ]
    }

    if (operation === 'record_invalidate') {
      const field = args[1]
      const generationField = args[2]
      const headField = args[3]
      const generationRaw = args[4]
      const deletedRevisionRaw = args[5]
      if (field === undefined || generationField === undefined || headField === undefined ||
        generationRaw === undefined || deletedRevisionRaw === undefined) return 'metadata'
      const fenceRaw = this.memoryHotMetadata.get(generationField)
      if (fenceRaw !== undefined && !this.validMemoryHotFixed(fenceRaw)) return 'metadata'
      if (fenceRaw !== generationRaw) return 'unchanged'
      const wire = this.memoryHotRecords.get(field)
      if (wire === undefined) {
        return this.memoryHotMetadata.has(headField) || this.memoryHotExpires.has(field) ||
          this.memoryHotLru.has(field) ? 'metadata' : 'unchanged'
      }
      const headValue = this.memoryHotMetadata.get(headField)
      if (!this.validMemoryHotHead(headValue, field)) {
        return 'metadata'
      }
      if (headValue.slice(0, 16) > deletedRevisionRaw) return 'unchanged'
      return this.removeMemoryHotRecord(state, field, wire, headField, headValue)
        ? 'invalidated'
        : 'metadata'
    }

    if (operation === 'namespace_invalidate') {
      const generationField = args[1]
      const deletedRaw = args[2]
      const nextRaw = args[3]
      if (generationField === undefined || deletedRaw === undefined || nextRaw === undefined) {
        return 'metadata'
      }
      const fenceRaw = this.memoryHotMetadata.get(generationField)
      if (fenceRaw !== undefined && !this.validMemoryHotFixed(fenceRaw)) return 'metadata'
      if (fenceRaw !== undefined && fenceRaw >= nextRaw) return 'unchanged'
      if (fenceRaw === undefined) {
        if (state.generationCount >= MEMORY_RESOURCE_LIMITS.deploymentNamespaces) return 'capacity'
        const generationBytes = memoryHotCacheMetadataEntryBytesV1(generationField, nextRaw)
        let removed = this.cleanupExpiredMemoryHot(state, this.now(), 32)
        if (removed < 0) return 'metadata'
        while (this.memoryHotTotalBytes(state) + generationBytes >
          MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes && removed < 32) {
          const evicted = this.evictOldestMemoryHot(state, '')
          if (evicted < 0) return 'metadata'
          if (evicted === 0) break
          removed += evicted
        }
        if (this.memoryHotTotalBytes(state) + generationBytes >
          MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) return 'capacity'
        state.generationCount += 1
        state.dynamicMetadataBytes += generationBytes
      } else if (fenceRaw > deletedRaw) {
        return 'unchanged'
      }
      this.memoryHotMetadata.set(generationField, nextRaw)
      this.saveMemoryHotState(state)
      return 'invalidated'
    }

    if (operation === 'peek') {
      const field = args[1]
      const generationField = args[2]
      const headField = args[3]
      const generationRaw = args[4]
      const expectedHead = args[5]
      if (field === undefined || generationField === undefined || headField === undefined ||
        generationRaw === undefined || expectedHead === undefined) return 'metadata'
      const fenceRaw = this.memoryHotMetadata.get(generationField)
      if (fenceRaw === undefined) return 'missing'
      if (!this.validMemoryHotFixed(fenceRaw) ||
        !this.validMemoryHotHead(expectedHead, field)) return 'metadata'
      if (fenceRaw > generationRaw) return 'stale'
      if (fenceRaw < generationRaw) return 'missing'
      const wire = this.memoryHotRecords.get(field)
      if (wire === undefined) {
        if (this.memoryHotMetadata.has(headField) || this.memoryHotExpires.has(field) ||
          this.memoryHotLru.has(field)) return 'metadata'
        return 'missing'
      }
      const headValue = this.memoryHotMetadata.get(headField)
      if (!this.validMemoryHotHead(headValue, field) ||
        !this.memoryHotLru.has(field)) return 'metadata'
      if (headValue !== expectedHead) {
        return headValue.slice(0, 16) > expectedHead.slice(0, 16) ? 'stale' : 'mismatch'
      }
      const expiry = this.memoryHotExpires.get(field)
      if (expiry === undefined) return 'metadata'
      if (expiry <= this.now()) {
        return this.removeMemoryHotRecord(state, field, wire, headField, headValue)
          ? 'expired'
          : 'metadata'
      }
      if (this.bytes(wire) > MEMORY_RESOURCE_LIMITS.recordWireBytes) {
        return this.removeMemoryHotRecord(state, field, wire, headField, headValue)
          ? 'corrupt'
          : 'metadata'
      }
      return ['candidate', wire]
    }

    if (operation === 'confirm_hit') {
      const field = args[1]
      const generationField = args[2]
      const headField = args[3]
      const generationRaw = args[4]
      const expectedHead = args[5]
      const wire = args[6]
      const validUntilMs = Number(args[7])
      if (field === undefined || generationField === undefined || headField === undefined ||
        generationRaw === undefined || expectedHead === undefined || wire === undefined) {
        return 'metadata'
      }
      const fenceRaw = this.memoryHotMetadata.get(generationField)
      const headValue = this.memoryHotMetadata.get(headField)
      if (!this.validMemoryHotFixed(fenceRaw) ||
        !this.validMemoryHotHead(headValue, field) ||
        !this.validMemoryHotHead(expectedHead, field)) return 'metadata'
      if (fenceRaw !== generationRaw) return 'stale'
      if (headValue !== expectedHead ||
        this.memoryHotRecords.get(field) !== wire) return 'mismatch'
      const expiry = this.memoryHotExpires.get(field)
      if (expiry === undefined || !this.memoryHotLru.has(field)) return 'metadata'
      const currentTime = this.now()
      if (expiry <= currentTime || !Number.isSafeInteger(validUntilMs) ||
        validUntilMs <= currentTime) {
        return this.removeMemoryHotRecord(state, field, wire, headField, expectedHead)
          ? 'expired'
          : 'metadata'
      }
      this.memoryHotLru.set(field, currentTime)
      return 'hit'
    }

    if (operation === 'delete_corrupt') {
      const field = args[1]
      const headField = args[2]
      const wire = args[3]
      if (field === undefined || headField === undefined || wire === undefined) return 'metadata'
      if (this.memoryHotRecords.get(field) !== wire) return 'unchanged'
      const headValue = this.memoryHotMetadata.get(headField)
      if (!this.validMemoryHotHead(headValue, field)) return 'metadata'
      return this.removeMemoryHotRecord(state, field, wire, headField, headValue)
        ? 'invalidated'
        : 'metadata'
    }
    return 'invalid_operation'
  }

  private initializeMemoryHot (): boolean {
    if (this.memoryHotScriptVersion !== null) {
      return this.memoryHotScriptVersion === MEMORY_HOT_CACHE_SCRIPT_VERSION
    }
    if (!this.memoryHotEmpty()) return false
    this.memoryHotScriptVersion = MEMORY_HOT_CACHE_SCRIPT_VERSION
    for (const field of Object.values(MEMORY_HOT_CACHE_COUNTER_FIELDS)) {
      this.memoryHotMetadata.set(field, '0000000000000000')
    }
    return true
  }

  private memoryHotEmpty (): boolean {
    return this.memoryHotRecords.size === 0 && this.memoryHotExpires.size === 0 &&
      this.memoryHotLru.size === 0 && this.memoryHotMetadata.size === 0
  }

  private parseMemoryHotState (): {
    recordCount: number
    generationCount: number
    recordEntryBytes: number
    expiryIndexBytes: number
    lruIndexBytes: number
    dynamicMetadataBytes: number
  } | null {
    if (this.memoryHotScriptVersion !== MEMORY_HOT_CACHE_SCRIPT_VERSION) return null
    const value = (field: string): number | null => {
      const raw = this.memoryHotMetadata.get(field)
      if (raw === undefined || !/^\d{16}$/.test(raw)) return null
      const parsed = Number(raw)
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
    }
    const recordCount = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.recordCount)
    const generationCount = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.generationCount)
    const recordEntryBytes = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.recordEntryBytes)
    const expiryIndexBytes = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.expiryIndexBytes)
    const lruIndexBytes = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.lruIndexBytes)
    const dynamicMetadataBytes = value(MEMORY_HOT_CACHE_COUNTER_FIELDS.dynamicMetadataBytes)
    if (recordCount === null || generationCount === null || recordEntryBytes === null ||
      expiryIndexBytes === null || lruIndexBytes === null || dynamicMetadataBytes === null) {
      return null
    }
    const state = {
      recordCount,
      generationCount,
      recordEntryBytes,
      expiryIndexBytes,
      lruIndexBytes,
      dynamicMetadataBytes
    }
    if (recordCount > MEMORY_RESOURCE_LIMITS.redisHotRecords ||
      generationCount > MEMORY_RESOURCE_LIMITS.deploymentNamespaces ||
      expiryIndexBytes !== recordCount * 80 ||
      lruIndexBytes !== recordCount * 80 ||
      dynamicMetadataBytes !== recordCount * 147 + generationCount * 82 ||
      recordEntryBytes < recordCount * 64 ||
      recordEntryBytes > recordCount * (64 + MEMORY_RESOURCE_LIMITS.recordWireBytes) ||
      this.memoryHotRecords.size !== recordCount || this.memoryHotExpires.size !== recordCount ||
      this.memoryHotLru.size !== recordCount ||
      this.memoryHotMetadata.size !== 6 + recordCount + generationCount ||
      this.memoryHotTotalBytes(state) > MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes) return null
    return state
  }

  private saveMemoryHotState (state: {
    recordCount: number
    generationCount: number
    recordEntryBytes: number
    expiryIndexBytes: number
    lruIndexBytes: number
    dynamicMetadataBytes: number
  }): void {
    const fixed = (value: number): string => String(value).padStart(16, '0')
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.recordCount,
      fixed(state.recordCount)
    )
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.generationCount,
      fixed(state.generationCount)
    )
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.recordEntryBytes,
      fixed(state.recordEntryBytes)
    )
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.expiryIndexBytes,
      fixed(state.expiryIndexBytes)
    )
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.lruIndexBytes,
      fixed(state.lruIndexBytes)
    )
    this.memoryHotMetadata.set(
      MEMORY_HOT_CACHE_COUNTER_FIELDS.dynamicMetadataBytes,
      fixed(state.dynamicMetadataBytes)
    )
  }

  private memoryHotTotalBytes (state: {
    recordEntryBytes: number
    expiryIndexBytes: number
    lruIndexBytes: number
    dynamicMetadataBytes: number
  }): number {
    return MEMORY_HOT_CACHE_STATIC_BYTES + state.recordEntryBytes + state.expiryIndexBytes +
      state.lruIndexBytes + state.dynamicMetadataBytes
  }

  private validMemoryHotFixed (value: string | undefined): value is string {
    return value !== undefined && /^\d{16}$/.test(value)
  }

  private validMemoryHotHead (value: string | undefined, field: string): value is string {
    return value !== undefined && /^[0-9]{16}\|[0-9a-f]{64}$/.test(value) &&
      value.slice(17) === field
  }

  private removeMemoryHotRecord (
    state: {
      recordCount: number
      generationCount: number
      recordEntryBytes: number
      expiryIndexBytes: number
      lruIndexBytes: number
      dynamicMetadataBytes: number
    },
    field: string,
    wire: string,
    headField: string,
    headValue: string
  ): boolean {
    if (this.memoryHotRecords.get(field) !== wire ||
      this.memoryHotMetadata.get(headField) !== headValue ||
      !this.memoryHotExpires.has(field) || !this.memoryHotLru.has(field)) return false
    const projected = {
      ...state,
      recordCount: state.recordCount - 1,
      recordEntryBytes: state.recordEntryBytes - memoryHotCacheRecordEntryBytesV1(field, wire),
      expiryIndexBytes: state.expiryIndexBytes - memoryHotCacheIndexEntryBytesV1(field),
      lruIndexBytes: state.lruIndexBytes - memoryHotCacheIndexEntryBytesV1(field),
      dynamicMetadataBytes: state.dynamicMetadataBytes -
        memoryHotCacheMetadataEntryBytesV1(headField, headValue)
    }
    if (Object.values(projected).some(value => !Number.isSafeInteger(value) || value < 0)) {
      return false
    }
    this.memoryHotRecords.delete(field)
    this.memoryHotExpires.delete(field)
    this.memoryHotLru.delete(field)
    this.memoryHotMetadata.delete(headField)
    this.saveMemoryHotState(projected)
    Object.assign(state, projected)
    return true
  }

  private cleanupExpiredMemoryHot (
    state: {
      recordCount: number
      generationCount: number
      recordEntryBytes: number
      expiryIndexBytes: number
      lruIndexBytes: number
      dynamicMetadataBytes: number
    },
    currentTime: number,
    limit: number
  ): number {
    const victims = [...this.memoryHotExpires.entries()]
      .filter(([, score]) => score <= currentTime)
      .sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1))
      .slice(0, limit)
    for (const [field] of victims) {
      if (!this.removeMemoryHotVictim(state, field)) return -1
    }
    return victims.length
  }

  private evictOldestMemoryHot (
    state: {
      recordCount: number
      generationCount: number
      recordEntryBytes: number
      expiryIndexBytes: number
      lruIndexBytes: number
      dynamicMetadataBytes: number
    },
    skipField: string
  ): number {
    const field = [...this.memoryHotLru.entries()]
      .filter(([candidate]) => candidate !== skipField)
      .sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1))[0]?.[0]
    if (field === undefined) return 0
    return this.removeMemoryHotVictim(state, field) ? 1 : -1
  }

  private removeMemoryHotVictim (
    state: {
      recordCount: number
      generationCount: number
      recordEntryBytes: number
      expiryIndexBytes: number
      lruIndexBytes: number
      dynamicMetadataBytes: number
    },
    field: string
  ): boolean {
    if (!/^[0-9a-f]{64}$/.test(field)) return false
    const wire = this.memoryHotRecords.get(field)
    const headField = memoryHotCacheHeadFieldV1(field)
    const headValue = this.memoryHotMetadata.get(headField)
    if (wire === undefined || !this.validMemoryHotHead(headValue, field)) return false
    return this.removeMemoryHotRecord(state, field, wire, headField, headValue)
  }

  private evalRunMigration (keys: string[], args: string[]): string {
    const [checkpointKey, eventKey, tombstoneKey, referenceKey, metadataKey] = keys
    if ([checkpointKey, eventKey, tombstoneKey, referenceKey, metadataKey]
      .some(key => key === undefined)) return 'conflict'
    const oldCheckpoint = this.entryValue(checkpointKey)
    const oldEvents = this.entryValue(eventKey)
    if (oldCheckpoint !== args[0] || oldEvents !== args[1] ||
      this.entryValue(tombstoneKey) !== null) return 'conflict'
    const checkpointEntry = this.entries.get(checkpointKey as string)
    const eventEntry = this.entries.get(eventKey as string)
    if (checkpointEntry?.expiresAtMs === undefined || eventEntry?.expiresAtMs === undefined) return 'ttl'
    const artifactKeys = keys.slice(5)
    if (artifactKeys.some((key, index) => {
      const entry = this.entries.get(key)
      return entry === undefined || entry.expiresAtMs === undefined ||
        entry.expiresAtMs <= this.now() || args[7 + index * 2] !== '1' ||
        entry.value !== args[6 + index * 2]
    })) return 'artifact_missing'
    const isV1 = args[5] === '1'
    const referenceValue = this.entryValue(referenceKey)
    const reference = this.entries.get(referenceKey as string)
    if (isV1 ? referenceValue !== null :
      referenceValue !== args[4] || reference?.expiresAtMs === undefined) {
      return isV1 ? 'reference_conflict' : 'conflict'
    }
    const usage = this.parseRunNamespaceUsage(this.entryValue(metadataKey))
    if (usage === null) return 'reconcile'
    const projected = {
      ...usage,
      bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents) +
        this.bytes(args[2]) + this.bytes(args[3]) +
        (isV1 ? this.bytes(referenceKey) + this.bytes(args[4]) : 0),
      references: usage.references + (isV1 ? 1 : 0)
    }
    if (this.invalidRunUsage(projected)) return 'reconcile'
    if (this.exceedsRunLimits(projected)) return 'budget'
    this.entries.set(checkpointKey as string, {
      value: args[2] as string,
      expiresAtMs: checkpointEntry.expiresAtMs
    })
    this.entries.set(eventKey as string, {
      value: args[3] as string,
      expiresAtMs: eventEntry.expiresAtMs
    })
    if (isV1) {
      this.entries.set(referenceKey as string, {
        value: args[4] as string,
        expiresAtMs: Math.max(checkpointEntry.expiresAtMs, eventEntry.expiresAtMs)
      })
    }
    for (const key of artifactKeys) {
      const entry = this.entries.get(key)
      if (entry === undefined) throw new TypeError('context artifact disappeared during migration')
      this.entries.set(key, {
        value: entry.value,
        expiresAtMs: Math.max(checkpointEntry.expiresAtMs, eventEntry.expiresAtMs)
      })
    }
    this.saveRunNamespaceUsage(metadataKey, projected)
    return 'ok'
  }

  private evalTrace (
    operation: string,
    keys: readonly string[],
    args: readonly string[]
  ): unknown {
    const [traceKey] = keys
    if (keys[1] !== TRACE_SUCCESS_INDEX_KEY || keys[2] !== TRACE_FAILURE_INDEX_KEY ||
      keys[3] !== TRACE_BYTES_KEY || keys[4] !== TRACE_GENERATION_KEY) {
      throw new TypeError('invalid trace keys')
    }
    if (operation === 'upsert' || operation === 'append') {
      const expectedGeneration = Number(args[1])
      const generation = Number(this.entryValue(TRACE_GENERATION_KEY) ?? '0')
      if (expectedGeneration !== generation) return ['stale_generation', String(generation)]
      this.cleanupTrace(Number(args[2]))
      if (traceKey === undefined) throw new TypeError('trace key is invalid')
      if (operation === 'upsert') {
        const raw = args[3]
        const expiresAtMs = Number(args[4])
        const index = args[5] === 'failure'
          ? TRACE_FAILURE_INDEX_KEY
          : TRACE_SUCCESS_INDEX_KEY
        if (raw === undefined) throw new TypeError('trace value is invalid')
        const existing = this.entryValue(traceKey)
        if (existing !== null) {
          return [existing === raw ? 'unchanged' : 'conflict', String(generation)]
        }
        const length = this.bytes(raw) + 2 * this.bytes(traceKey)
        if (!this.ensureTraceCapacity(traceKey, 0, length, 1)) {
          return ['capacity', String(generation)]
        }
        this.entries.set(traceKey, { value: raw, expiresAtMs })
        this.traceLengths.set(traceKey, length)
        this.zadd(index, traceKey, expiresAtMs)
        this.saveTraceBytes()
        return ['stored', String(generation)]
      }
      const expected = args[3]
      const replacement = args[4]
      const expiresAtMs = Number(args[5])
      if (expected === undefined || replacement === undefined) {
        throw new TypeError('trace append value is invalid')
      }
      const existing = this.entryValue(traceKey)
      if (existing === null) return ['not_found', String(generation)]
      if (existing !== expected) return ['conflict', String(generation)]
      if (existing === replacement) return ['unchanged', String(generation)]
      const oldLength = this.traceLengths.get(traceKey) ??
        this.bytes(existing) + 2 * this.bytes(traceKey)
      const newLength = this.bytes(replacement) + 2 * this.bytes(traceKey)
      const delta = newLength - oldLength
      if (delta > 0 && !this.ensureTraceCapacity(
        traceKey,
        oldLength,
        newLength,
        0,
        traceKey
      )) {
        return ['capacity', String(generation)]
      }
      this.entries.set(traceKey, { value: replacement, expiresAtMs })
      this.traceLengths.set(traceKey, newLength)
      if (args[6] === 'failure') {
        this.zrem(TRACE_SUCCESS_INDEX_KEY, traceKey)
        this.zadd(TRACE_FAILURE_INDEX_KEY, traceKey, expiresAtMs)
      }
      this.saveTraceBytes()
      return ['stored', String(generation)]
    }
    if (operation === 'delete_corrupt') {
      if (traceKey !== undefined && this.entryValue(traceKey) === args[1]) {
        this.removeTrace(traceKey)
        this.saveTraceBytes()
      }
      return 'ok'
    }
    if (operation === 'missing_state') {
      if (traceKey === undefined) throw new TypeError('trace key is invalid')
      const score = this.sortedSets.get(TRACE_SUCCESS_INDEX_KEY)?.get(traceKey) ??
        this.sortedSets.get(TRACE_FAILURE_INDEX_KEY)?.get(traceKey)
      if (score !== undefined && score <= Number(args[1])) {
        this.removeTrace(traceKey)
        this.saveTraceBytes()
        return 'expired'
      }
      return 'not_retained'
    }
    if (operation === 'list') {
      this.cleanupTrace(Number(args[1]))
      const limit = Number(args[2])
      return [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]
        .flatMap(index => this.zrange(index, true).slice(0, limit))
        .flatMap(key => {
          const raw = this.entryValue(key)
          return raw === null ? [] : [key, raw]
        })
    }
    if (operation === 'usage') {
      this.cleanupTrace(Number(args[1]))
      const usage = this.traceUsage()
      return [usage.records, usage.bytes]
    }
    if (operation === 'clear') return this.clearTrace(Number(args[1]))
    if (operation === 'advance_clear') {
      const generation = Number(this.entryValue(TRACE_GENERATION_KEY) ?? '0') + 1
      this.entries.set(TRACE_GENERATION_KEY, { value: String(generation) })
      return [generation, ...this.clearTrace(Number(args[1]))]
    }
    return 'invalid_operation'
  }

  private cleanupTrace (nowMs: number): void {
    let remaining = TRACE_STORE_LIMITS.cleanupBatchRecords
    for (const index of [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]) {
      for (const key of this.zrange(index)) {
        if (remaining <= 0) break
        const score = this.sortedSets.get(index)?.get(key)
        if (score === undefined || score > nowMs) break
        this.removeTrace(key)
        remaining -= 1
      }
    }
    this.saveTraceBytes()
  }

  private ensureTraceCapacity (
    key: string,
    oldLength: number,
    newLength: number,
    addedRecords: number,
    skip?: string
  ): boolean {
    let usage = this.traceUsage()
    let guard = TRACE_STORE_LIMITS.maxRecords
    while ((usage.records + addedRecords > TRACE_STORE_LIMITS.maxRecords ||
      this.projectedTraceBytes(key, oldLength, newLength) > TRACE_STORE_LIMITS.maxBytes) &&
      guard > 0) {
      let victim: string | undefined
      for (const index of [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]) {
        victim = this.zrange(index).slice(0, 2).find(key => key !== skip)
        if (victim !== undefined) break
      }
      if (victim === undefined) return false
      this.removeTrace(victim)
      usage = this.traceUsage()
      guard -= 1
    }
    return usage.records + addedRecords <= TRACE_STORE_LIMITS.maxRecords &&
      this.projectedTraceBytes(key, oldLength, newLength) <= TRACE_STORE_LIMITS.maxBytes
  }

  private clearTrace (limit: number): [number, number, number, number] {
    const before = this.traceUsage()
    const keys = [
      ...this.zrange(TRACE_SUCCESS_INDEX_KEY),
      ...this.zrange(TRACE_FAILURE_INDEX_KEY)
    ].slice(0, limit)
    for (const key of keys) this.removeTrace(key)
    const after = this.traceUsage()
    this.saveTraceBytes()
    return [keys.length, before.bytes - after.bytes, after.records, after.bytes]
  }

  private traceUsage (): { records: number; bytes: number } {
    const keys = new Set([
      ...this.zrange(TRACE_SUCCESS_INDEX_KEY),
      ...this.zrange(TRACE_FAILURE_INDEX_KEY)
    ])
    return {
      records: keys.size,
      bytes: this.traceNamespaceBytes()
    }
  }

  private projectedTraceBytes (key: string, oldLength: number, newLength: number): number {
    const dataBytes = Math.max(0, this.traceDataBytes() - oldLength + newLength)
    let metadataBytes = this.traceEntryMetadataBytes()
    if (oldLength > 0) metadataBytes -= this.bytes(key) + this.bytes(String(oldLength))
    if (newLength > 0) metadataBytes += this.bytes(key) + this.bytes(String(newLength))
    return dataBytes + Math.max(0, metadataBytes) + this.traceCounterMetadataBytes(dataBytes) +
      this.traceGenerationMetadataBytes()
  }

  private traceNamespaceBytes (): number {
    const dataBytes = this.traceDataBytes()
    return dataBytes + this.traceEntryMetadataBytes() +
      this.traceCounterMetadataBytes(dataBytes) + this.traceGenerationMetadataBytes()
  }

  private traceDataBytes (): number {
    return [...this.traceLengths.values()].reduce((total, value) => total + value, 0)
  }

  private traceEntryMetadataBytes (): number {
    return [...this.traceLengths.entries()].reduce((total, [key, length]) => (
      total + this.bytes(key) + this.bytes(String(length))
    ), 0)
  }

  private traceCounterMetadataBytes (dataBytes: number): number {
    return dataBytes === 0 ? 0 : this.bytes('__total') + this.bytes(String(dataBytes))
  }

  private traceGenerationMetadataBytes (): number {
    return this.bytes(this.entries.get(TRACE_GENERATION_KEY)?.value ?? '')
  }

  private saveTraceBytes (): void {
    const bytes = this.traceDataBytes()
    if (bytes === 0) this.entries.delete(TRACE_BYTES_KEY)
    else this.entries.set(TRACE_BYTES_KEY, { value: String(bytes) })
  }

  private removeTrace (key: string): void {
    this.entries.delete(key)
    this.traceLengths.delete(key)
    this.zrem(TRACE_SUCCESS_INDEX_KEY, key)
    this.zrem(TRACE_FAILURE_INDEX_KEY, key)
  }

  private zadd (index: string, member: string, score: number): void {
    const set = this.sortedSets.get(index) ?? new Map<string, number>()
    set.set(member, score)
    this.sortedSets.set(index, set)
  }

  private zrem (index: string, member: string): void {
    this.sortedSets.get(index)?.delete(member)
  }

  private zrange (index: string, reverse = false): string[] {
    return [...(this.sortedSets.get(index)?.entries() ?? [])]
      .sort((left, right) => {
        const score = left[1] - right[1]
        if (score !== 0) return reverse ? -score : score
        const lexical = left[0].localeCompare(right[0])
        return reverse ? -lexical : lexical
      })
      .map(([member]) => member)
  }

  private entryValue (key: string | undefined): string | null {
    if (key === undefined) return null
    this.purgeExpired(key)
    return this.entries.get(key)?.value ?? null
  }

  private evalArtifact (operation: string, keys: string[], args: string[]): unknown {
    if (operation === 'read') {
      const key = keys[0]
      if (key !== undefined && this.pendingGetFailures.delete(key)) {
        throw new Error('fake redis read failure')
      }
      const current = key === undefined ? undefined : this.entries.get(key)
      if (current === undefined) return 'missing'
      if (this.bytes(current.value) > CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes) return 'too_large'
      return ['exact', current.value]
    }
    if (operation === 'metadata_snapshot') {
      const metadataKey = keys[0]
      if (metadataKey !== CONTEXT_ARTIFACT_METADATA_KEY) return 'invalid_snapshot'
      const current = this.entries.get(metadataKey)
      if (current === undefined) return 'missing'
      if (this.bytes(current.value) > CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes) return 'oversized'
      return ['exact', current.value]
    }
    if (operation === 'reconcile') {
      const metadataKey = keys[0]
      const expectedKind = args[1]
      const expectedRaw = args[2]
      const nextMetadata = args[3]
      if (metadataKey !== CONTEXT_ARTIFACT_METADATA_KEY || nextMetadata === undefined) return 'conflict'
      const current = this.entries.get(metadataKey)
      const currentBytes = this.bytes(current?.value)
      if ((expectedKind === 'missing' && current !== undefined) ||
        (expectedKind === 'exact' && (
          currentBytes > CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes || current?.value !== expectedRaw
        )) ||
        (expectedKind === 'oversized' && currentBytes <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes) ||
        (expectedKind !== 'missing' && expectedKind !== 'exact' && expectedKind !== 'oversized')) {
        return 'conflict'
      }
      this.entries.set(metadataKey, { value: nextMetadata })
      return 'ok'
    }
    const minimumExpiresAtMs = Number(args[2])
    const redisNowMs = this.now()
    if (!Number.isSafeInteger(minimumExpiresAtMs) || minimumExpiresAtMs <= redisNowMs ||
      minimumExpiresAtMs > redisNowMs + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs) {
      return 'invalid_expiry'
    }
    if (operation === 'validate_expiry') return 'ok'
    const artifactKey = keys[0]
    const metadataKey = keys[1]
    const expected = args[1]
    if (artifactKey === undefined || metadataKey !== CONTEXT_ARTIFACT_METADATA_KEY ||
      expected === undefined || !Number.isSafeInteger(minimumExpiresAtMs)) {
      return 'invalid_operation'
    }
    const existing = this.entries.get(artifactKey)
    if (existing !== undefined &&
      this.bytes(existing.value) > CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes) return 'corrupt'
    const metadata = this.entryValue(metadataKey)
    const metadataMatch = /^1\|(\d+)\|(\d+)$/.exec(metadata ?? '')
    const metadataCount = Number(metadataMatch?.[1])
    const metadataValueBytes = Number(metadataMatch?.[2])
    const metadataValid = metadata !== null &&
      this.bytes(metadata) <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes &&
      metadataMatch !== null &&
      Number.isSafeInteger(metadataCount) &&
      Number.isSafeInteger(metadataValueBytes) &&
      metadataCount <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys &&
      metadataValueBytes <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes
    if (operation === 'touch') {
      if (existing === undefined) return 'missing'
      if (existing.value !== expected) return 'corrupt'
      if (existing.expiresAtMs === undefined) return 'corrupt_ttl'
      if (!metadataValid || metadataCount < 1 || metadataValueBytes < this.bytes(expected)) return 'reconcile'
      const ttl = existing.expiresAtMs - this.now()
      const horizonBoundMs = redisNowMs + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs
      if (redisNowMs + ttl > horizonBoundMs) return 'corrupt_ttl'
      const hook = this.artifactTtlComputationHook
      this.artifactTtlComputationHook = undefined
      hook?.()
      const upperExistingExpiryMs = this.now() + ttl
      this.entries.set(artifactKey, {
        value: existing.value,
        expiresAtMs: Math.min(Math.max(upperExistingExpiryMs, minimumExpiresAtMs), horizonBoundMs)
      })
      return 'ok'
    }
    if (operation !== 'put') return 'invalid_operation'
    if (existing !== undefined) {
      if (existing.value !== expected) return 'corrupt'
      if (existing.expiresAtMs === undefined) return 'corrupt_ttl'
      if (!metadataValid || metadataCount < 1 || metadataValueBytes < this.bytes(expected)) return 'reconcile'
      const ttl = existing.expiresAtMs - this.now()
      const horizonBoundMs = redisNowMs + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs
      if (redisNowMs + ttl > horizonBoundMs) return 'corrupt_ttl'
      const hook = this.artifactTtlComputationHook
      this.artifactTtlComputationHook = undefined
      hook?.()
      const upperExistingExpiryMs = this.now() + ttl
      this.entries.set(artifactKey, {
        value: existing.value,
        expiresAtMs: Math.min(Math.max(upperExistingExpiryMs, minimumExpiresAtMs), horizonBoundMs)
      })
      return 'existing'
    }
    if (!metadataValid) return 'reconcile'
    const count = metadataCount
    const valueBytes = metadataValueBytes
    const projectedCount = count + 1
    const projectedBytes = valueBytes + this.bytes(expected)
    if (projectedCount > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys ||
      projectedBytes > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes) return 'capacity'
    this.entries.set(artifactKey, { value: expected, expiresAtMs: minimumExpiresAtMs })
    this.entries.set(metadataKey, { value: `1|${projectedCount}|${projectedBytes}` })
    return 'stored'
  }

  private bytes (value: string | null | undefined): number {
    return value === null || value === undefined
      ? 0
      : Buffer.byteLength(value, 'utf8')
  }

  private setDirect (key: string | undefined, value: string | undefined, ttlSeconds: number): void {
    if (key === undefined || value === undefined || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError('invalid Lua SET arguments')
    }
    this.entries.set(key, {
      value,
      expiresAtMs: this.now() + ttlSeconds * 1_000
    })
  }

  private parseRunNamespaceUsage (raw: string | null): {
    bytes: number
    checkpoints: number
    events: number
    tombstones: number
    indexes: number
    references: number
    tombstoneBytes: number
  } | null {
    if (raw === null || !/^\d+\|\d+\|\d+\|\d+\|\d+\|\d+\|\d+$/.test(raw)) return null
    const [bytes, checkpoints, events, tombstones, indexes, references, tombstoneBytes] = raw
      .split('|')
      .map(value => Number(value))
    if ([bytes, checkpoints, events, tombstones, indexes, references, tombstoneBytes]
      .some(value => !Number.isSafeInteger(value))) return null
    return {
      bytes,
      checkpoints,
      events,
      tombstones,
      indexes,
      references,
      tombstoneBytes
    }
  }

  private saveRunNamespaceUsage (
    key: string | undefined,
    usage: {
      bytes: number
      checkpoints: number
      events: number
      tombstones: number
      indexes: number
      references: number
      tombstoneBytes: number
    }
  ): void {
    if (key !== RUN_STORE_METADATA_KEY) throw new TypeError('invalid run metadata key')
    this.entries.set(key, {
      value: [
        usage.bytes,
        usage.checkpoints,
        usage.events,
        usage.tombstones,
        usage.indexes,
        usage.references,
        usage.tombstoneBytes
      ].join('|')
    })
  }

  private invalidRunUsage (usage: {
    bytes: number
    checkpoints: number
    events: number
    tombstones: number
    indexes: number
    references: number
    tombstoneBytes: number
  }): boolean {
    return Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)
  }

  private exceedsRunLimits (usage: {
    bytes: number
    checkpoints: number
    events: number
    tombstones: number
    indexes: number
    references: number
    tombstoneBytes: number
  }): boolean {
    return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
      usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
      usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
      usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
      usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys ||
      usage.references > RUN_RESOURCE_LIMITS.referenceKeys
  }

  private purgeExpired (key: string): void {
    const entry = this.entries.get(key)
    if (entry?.expiresAtMs !== undefined && entry.expiresAtMs <= this.now()) {
      this.entries.delete(key)
    }
  }

  private purgeAllExpired (): void {
    for (const key of this.entries.keys()) {
      this.genericExpirySweepVisits += 1
      this.purgeExpired(key)
    }
  }
}
