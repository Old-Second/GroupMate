import { randomUUID } from 'node:crypto'
import { AgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import type { AbortOptions, ListOptions, SaveOptions } from '../contracts/storage.js'
import {
  canonicalSessionKey,
  legacySessionKey,
  parseCanonicalSessionKey,
  parseLegacySessionKey,
  serializeConversationScope
} from './conversation-scope.js'
import type { SessionCodec, SessionRecord, SessionSummary } from './session-record.js'
import type { SessionStore } from './session-store.js'

export interface RedisSessionClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>
  del(key: string | readonly string[]): Promise<number>
  ttl(key: string): Promise<number>
  scan(cursor: number, options: {
    MATCH: string
    COUNT: number
  }): Promise<{ cursor: number; keys: string[] }>
}

export interface RedisSessionStoreOptions<TState> {
  readonly client: RedisSessionClient
  readonly codec: SessionCodec<TState>
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly scanCount?: number
}

const canonicalNamespace = 'GROUPMATE:SESSION:v1:'
const legacyPattern = 'CHATGPT:CONVERSATIONS:*'

function cancelledError (): AgentError {
  return new AgentError({
    code: 'cancelled',
    stage: 'session',
    retryable: false,
    userMessage: '操作已取消。'
  })
}

function assertNotAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelledError()
}

function storageUnavailable (stage: string, operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'storage_unavailable',
    stage,
    retryable: true,
    userMessage: '会话存储暂时不可用，请稍后重试。',
    details: { operation },
    cause
  })
}

function invalidData (stage: string, operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'storage_invalid_data',
    stage,
    retryable: false,
    userMessage: '会话数据无法读取，请重新开始对话。',
    details: { operation },
    cause
  })
}

function summary<TState> (
  record: SessionRecord<TState>,
  source: SessionSummary['source']
): SessionSummary {
  return {
    address: { botId: record.botId, scope: record.scope },
    sessionId: record.sessionId,
    startedBy: record.startedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turnCount: record.turnCount,
    source
  }
}

export class RedisSessionStore<TState> implements SessionStore<TState> {
  private readonly client: RedisSessionClient
  private readonly codec: SessionCodec<TState>
  private readonly now: () => Date
  private readonly generateId: () => string
  private readonly scanCount: number

  constructor (options: RedisSessionStoreOptions<TState>) {
    this.client = options.client
    this.codec = options.codec
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? randomUUID
    const scanCount = options.scanCount ?? 100
    if (!Number.isSafeInteger(scanCount) || scanCount <= 0 || scanCount > 1000) {
      throw new TypeError('scan count must be a safe integer between 1 and 1000')
    }
    this.scanCount = scanCount
  }

  async get (address: SessionAddress, options: AbortOptions = {}): Promise<SessionRecord<TState> | null> {
    assertNotAborted(options.signal)
    const canonicalKey = canonicalSessionKey(address)
    const canonicalRaw = await this.read(canonicalKey, 'session.read', 'get_canonical')
    assertNotAborted(options.signal)
    if (canonicalRaw !== null) return this.decodeCanonical(canonicalRaw, address)

    const oldKey = legacySessionKey(address.scope)
    const legacyRaw = await this.read(oldKey, 'session.read', 'get_legacy')
    assertNotAborted(options.signal)
    if (legacyRaw === null) return null

    const ttl = await this.readTtl(oldKey)
    assertNotAborted(options.signal)
    if (ttl === 0 || ttl === -2) return null
    if (ttl < -2) throw invalidData('session.migrate', 'legacy_ttl', new TypeError('invalid TTL'))

    const migrated = this.decodeLegacy(legacyRaw, address)
    const encoded = this.encode(migrated)
    await this.write(canonicalKey, encoded, ttl > 0 ? { EX: ttl } : undefined, 'session.migrate')
    assertNotAborted(options.signal)
    await this.remove(oldKey, 'session.migrate', 'delete_legacy')
    return migrated
  }

  async save (record: SessionRecord<TState>, options: SaveOptions = {}): Promise<void> {
    assertNotAborted(options.signal)
    const ttlSeconds = this.validateTtl(options.ttlSeconds)
    const address = { botId: record.botId, scope: record.scope }
    const encoded = this.encode(record)
    await this.write(
      canonicalSessionKey(address),
      encoded,
      ttlSeconds === undefined ? undefined : { EX: ttlSeconds },
      'session.save'
    )
    assertNotAborted(options.signal)
    await this.remove(legacySessionKey(record.scope), 'session.save', 'delete_legacy')
  }

  async delete (address: SessionAddress, options: AbortOptions = {}): Promise<boolean> {
    assertNotAborted(options.signal)
    const deleted = await this.remove(
      [canonicalSessionKey(address), legacySessionKey(address.scope)],
      'session.delete',
      'delete_both'
    )
    return deleted > 0
  }

  async * list (
    query: { readonly botId: string },
    options: ListOptions = {}
  ): AsyncIterable<SessionSummary> {
    assertNotAborted(options.signal)
    const limit = this.validateLimit(options.limit)
    const seen = new Set<string>()
    let yielded = 0
    const canonicalPattern = `${canonicalNamespace}${encodeURIComponent(query.botId)}:*`

    for await (const key of this.scan(canonicalPattern, options.signal)) {
      if (yielded >= limit) return
      const address = parseCanonicalSessionKey(key)
      if (address === null || address.botId !== query.botId) continue
      const raw = await this.read(key, 'session.list', 'get_canonical')
      if (raw === null) continue
      try {
        const record = this.codec.decodeCanonical(raw, address)
        const scopeId = serializeConversationScope(address.scope)
        if (seen.has(scopeId)) continue
        seen.add(scopeId)
        yielded += 1
        yield summary(record, 'canonical')
      } catch {
        // Corrupt entries are isolated so one session cannot break a bounded listing.
      }
    }

    for await (const key of this.scan(legacyPattern, options.signal)) {
      if (yielded >= limit) return
      const scope = parseLegacySessionKey(key)
      if (scope === null) continue
      const scopeId = serializeConversationScope(scope)
      if (seen.has(scopeId)) continue
      const raw = await this.read(key, 'session.list', 'get_legacy')
      if (raw === null) continue
      const address = { botId: query.botId, scope }
      try {
        const record = this.codec.decodeLegacy(raw, {
          address,
          now: this.now(),
          sessionId: this.generateId()
        })
        seen.add(scopeId)
        yielded += 1
        yield summary(record, 'legacy')
      } catch {
        // Corrupt legacy entries are skipped and remain available for manual recovery.
      }
    }
  }

  async deleteAll (
    query: { readonly botId: string },
    options: AbortOptions = {}
  ): Promise<number> {
    assertNotAborted(options.signal)
    const canonicalPattern = `${canonicalNamespace}${encodeURIComponent(query.botId)}:*`
    let deleted = await this.deletePattern(canonicalPattern, options.signal)
    deleted += await this.deletePattern(legacyPattern, options.signal)
    return deleted
  }

  async fork (
    source: SessionAddress,
    target: SessionAddress,
    startedBy: SessionRecord<TState>['startedBy'],
    options: SaveOptions = {}
  ): Promise<SessionRecord<TState>> {
    assertNotAborted(options.signal)
    const sourceRecord = await this.get(source, options)
    if (sourceRecord === null) {
      throw new AgentError({
        code: 'invalid_session',
        stage: 'session.fork',
        retryable: false,
        userMessage: '源会话不存在，无法加入。'
      })
    }
    const timestamp = this.now().toISOString()
    const draft: SessionRecord<TState> = {
      schemaVersion: 1,
      sessionId: this.generateId(),
      botId: target.botId,
      scope: target.scope,
      startedBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      turnCount: sourceRecord.turnCount,
      state: sourceRecord.state
    }
    const forked = this.decodeCanonical(this.encode(draft), target)
    await this.save(forked, options)
    return forked
  }

  private async * scan (pattern: string, signal?: AbortSignal): AsyncIterable<string> {
    let cursor = 0
    do {
      assertNotAborted(signal)
      let page: { cursor: number; keys: string[] }
      try {
        page = await this.client.scan(cursor, { MATCH: pattern, COUNT: this.scanCount })
      } catch (error) {
        throw storageUnavailable('session.scan', 'scan', error)
      }
      for (const key of page.keys) {
        assertNotAborted(signal)
        yield key
      }
      cursor = page.cursor
    } while (cursor !== 0)
  }

  private async deletePattern (pattern: string, signal?: AbortSignal): Promise<number> {
    let deleted = 0
    while (true) {
      assertNotAborted(signal)
      let page: { cursor: number; keys: string[] }
      try {
        page = await this.client.scan(0, { MATCH: pattern, COUNT: this.scanCount })
      } catch (error) {
        throw storageUnavailable('session.deleteAll', 'scan', error)
      }
      if (page.keys.length === 0) return deleted
      deleted += await this.remove(page.keys, 'session.deleteAll', 'delete_page')
    }
  }

  private async read (key: string, stage: string, operation: string): Promise<string | null> {
    try {
      return await this.client.get(key)
    } catch (error) {
      throw storageUnavailable(stage, operation, error)
    }
  }

  private async readTtl (key: string): Promise<number> {
    try {
      return await this.client.ttl(key)
    } catch (error) {
      throw storageUnavailable('session.migrate', 'ttl_legacy', error)
    }
  }

  private async write (
    key: string,
    value: string,
    options: { EX?: number } | undefined,
    stage: string
  ): Promise<void> {
    try {
      await this.client.set(key, value, options)
    } catch (error) {
      throw storageUnavailable(stage, 'set_canonical', error)
    }
  }

  private async remove (
    key: string | readonly string[],
    stage: string,
    operation: string
  ): Promise<number> {
    try {
      return await this.client.del(key)
    } catch (error) {
      throw storageUnavailable(stage, operation, error)
    }
  }

  private encode (record: SessionRecord<TState>): string {
    try {
      return this.codec.encode(record)
    } catch (error) {
      throw invalidData('session.write', 'encode', error)
    }
  }

  private decodeCanonical (raw: string, address: SessionAddress): SessionRecord<TState> {
    try {
      return this.codec.decodeCanonical(raw, address)
    } catch (error) {
      throw invalidData('session.read', 'decode_canonical', error)
    }
  }

  private decodeLegacy (raw: string, address: SessionAddress): SessionRecord<TState> {
    try {
      return this.codec.decodeLegacy(raw, {
        address,
        now: this.now(),
        sessionId: this.generateId()
      })
    } catch (error) {
      throw invalidData('session.read', 'decode_legacy', error)
    }
  }

  private validateTtl (ttlSeconds?: number): number | undefined {
    if (ttlSeconds === undefined) return undefined
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError('session TTL must be a positive safe integer')
    }
    return ttlSeconds
  }

  private validateLimit (limit?: number): number {
    if (limit === undefined) return 500
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('list limit must be positive')
    return Math.min(limit, 1000)
  }
}
