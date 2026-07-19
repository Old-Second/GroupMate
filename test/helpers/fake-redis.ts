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

interface FakeRedisEntry {
  readonly value: string
  readonly expiresAtMs?: number
}

export class FakeRedis implements RedisSessionClient, RedisRunClient {
  readonly getCalls: string[] = []
  readonly scanCalls: Array<{ cursor: number; MATCH: string; COUNT: number }> = []
  readonly setCalls: Array<{ key: string; options?: { EX?: number; NX?: boolean; XX?: boolean } }> = []
  readonly evalCalls: Array<{ marker: string; operation: string; argumentBytes: number[] }> = []
  private readonly entries = new Map<string, FakeRedisEntry>()
  private readonly sortedSets = new Map<string, Map<string, number>>()
  private readonly traceLengths = new Map<string, number>()
  private readonly pendingGetFailures = new Set<string>()
  private artifactEvalHook?: (operation: string) => boolean
  private artifactTtlComputationHook?: () => void
  private readonly now: () => number

  constructor (now: () => number = () => Date.now()) {
    this.now = now
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
    this.purgeAllExpired()
    const marker = script.split('\n', 1)[0] ?? ''
    const operation = options.arguments[0] ?? ''
    this.evalCalls.push({
      marker,
      operation,
      argumentBytes: options.arguments.map(value => this.bytes(value))
    })
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
    for (const key of this.entries.keys()) this.purgeExpired(key)
  }
}
