import type { RedisSessionClient } from '../../src/agent/session/redis-session-store.js'
import {
  RUN_STORE_LUA_MARKER,
  RUN_STORE_METADATA_KEY,
  type RedisRunClient
} from '../../src/agent/run/redis-run-store.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'

interface FakeRedisEntry {
  readonly value: string
  readonly expiresAtMs?: number
}

export class FakeRedis implements RedisSessionClient, RedisRunClient {
  readonly scanCalls: Array<{ cursor: number; MATCH: string; COUNT: number }> = []
  readonly setCalls: Array<{ key: string; options?: { EX?: number; NX?: boolean; XX?: boolean } }> = []
  readonly evalCalls: Array<{ marker: string; operation: string }> = []
  private readonly entries = new Map<string, FakeRedisEntry>()
  private readonly now: () => number

  constructor (now: () => number = () => Date.now()) {
    this.now = now
  }

  async get (key: string): Promise<string | null> {
    this.purgeExpired(key)
    return this.entries.get(key)?.value ?? null
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
    this.evalCalls.push({ marker, operation })
    if (marker !== RUN_STORE_LUA_MARKER) {
      throw new TypeError('unsupported Lua script')
    }
    const [checkpointKey, eventKey, tombstoneKey] = options.keys
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
    const usage = this.parseRunNamespaceUsage(this.entryValue(metadataKey))
    if (metadataKey !== RUN_STORE_METADATA_KEY || usage === null) return 'reconcile'

    if (operation === 'create') {
      if ([checkpointKey, eventKey, tombstoneKey]
        .some(key => key !== undefined && this.entries.has(key))) return 'conflict'
      const projected = {
        ...usage,
        bytes: usage.bytes + this.bytes(args[1]) + this.bytes(args[2]),
        checkpoints: usage.checkpoints + 1,
        events: usage.events + 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.setDirect(checkpointKey, args[1], Number(args[3]))
      this.setDirect(eventKey, args[2], Number(args[3]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'cas') {
      const oldCheckpoint = this.entryValue(checkpointKey)
      const oldEvents = this.entryValue(eventKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2]) return 'conflict'
      const terminal = args[6] === '1'
      const projected = {
        bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents),
        checkpoints: usage.checkpoints - 1,
        events: usage.events - 1,
        tombstones: usage.tombstones,
        indexes: usage.indexes
      }
      if (terminal) {
        if (tombstoneKey === undefined || this.entries.has(tombstoneKey)) return 'conflict'
        projected.bytes += this.bytes(args[7])
        projected.tombstones += 1
      } else {
        projected.bytes += this.bytes(args[3]) + this.bytes(args[4])
        projected.checkpoints += 1
        projected.events += 1
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      if (terminal) {
        this.entries.delete(checkpointKey)
        this.entries.delete(eventKey)
        this.setDirect(tombstoneKey, args[7], Number(args[8]))
      } else {
        this.setDirect(checkpointKey, args[3], Number(args[5]))
        this.setDirect(eventKey, args[4], Number(args[5]))
      }
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'finish') {
      const oldCheckpoint = this.entryValue(checkpointKey)
      const oldEvents = this.entryValue(eventKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
        tombstoneKey === undefined || this.entries.has(tombstoneKey)) return 'conflict'
      const projected = {
        bytes: usage.bytes - this.bytes(oldCheckpoint) - this.bytes(oldEvents) + this.bytes(args[3]),
        checkpoints: usage.checkpoints - 1,
        events: usage.events - 1,
        tombstones: usage.tombstones + 1,
        indexes: usage.indexes
      }
      if (this.invalidRunUsage(projected)) return 'reconcile'
      if (this.exceedsRunLimits(projected)) return 'budget'
      this.entries.delete(checkpointKey)
      this.entries.delete(eventKey)
      this.setDirect(tombstoneKey, args[3], Number(args[4]))
      this.saveRunNamespaceUsage(metadataKey, projected)
      return 'ok'
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

  private entryValue (key: string | undefined): string | null {
    return key === undefined ? null : this.entries.get(key)?.value ?? null
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
  } | null {
    if (raw === null || !/^\d+\|\d+\|\d+\|\d+\|\d+$/.test(raw)) return null
    const [bytes, checkpoints, events, tombstones, indexes] = raw
      .split('|')
      .map(value => Number(value))
    if ([bytes, checkpoints, events, tombstones, indexes]
      .some(value => !Number.isSafeInteger(value))) return null
    return { bytes, checkpoints, events, tombstones, indexes }
  }

  private saveRunNamespaceUsage (
    key: string | undefined,
    usage: { bytes: number; checkpoints: number; events: number; tombstones: number; indexes: number }
  ): void {
    if (key !== RUN_STORE_METADATA_KEY) throw new TypeError('invalid run metadata key')
    this.entries.set(key, {
      value: [usage.bytes, usage.checkpoints, usage.events, usage.tombstones, usage.indexes].join('|')
    })
  }

  private invalidRunUsage (usage: {
    bytes: number
    checkpoints: number
    events: number
    tombstones: number
    indexes: number
  }): boolean {
    return Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)
  }

  private exceedsRunLimits (usage: {
    bytes: number
    checkpoints: number
    events: number
    tombstones: number
    indexes: number
  }): boolean {
    return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
      usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
      usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
      usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
      usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys
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
