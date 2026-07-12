import type { RedisSessionClient } from '../../src/agent/session/redis-session-store.js'

interface FakeRedisEntry {
  readonly value: string
  readonly expiresAtMs?: number
}

export class FakeRedis implements RedisSessionClient {
  readonly scanCalls: Array<{ cursor: number; MATCH: string; COUNT: number }> = []
  readonly setCalls: Array<{ key: string; options?: { EX?: number } }> = []
  private readonly entries = new Map<string, FakeRedisEntry>()
  private readonly now: () => number

  constructor (now: () => number = () => Date.now()) {
    this.now = now
  }

  async get (key: string): Promise<string | null> {
    this.purgeExpired(key)
    return this.entries.get(key)?.value ?? null
  }

  async set (key: string, value: string, options?: { EX?: number }): Promise<string> {
    this.setCalls.push({ key, options })
    this.entries.set(key, {
      value,
      ...(options?.EX === undefined ? {} : { expiresAtMs: this.now() + options.EX * 1000 })
    })
    return 'OK'
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
