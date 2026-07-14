import { randomUUID } from 'node:crypto'
import { AgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import type { AbortOptions, ListOptions, SaveOptions } from '../contracts/storage.js'
import { agentSessionCodec } from './agent-session-codec.js'
import type { AgentSessionState } from './agent-session-state.js'
import {
  canonicalSessionKey,
  legacySessionKey,
  parseCanonicalSessionKey,
  parseLegacySessionKey,
  serializeConversationScope
} from './conversation-scope.js'
import { LegacySessionProjector } from './legacy-session-projector.js'
import {
  legacySessionCodec,
  type LegacyConversationState
} from './legacy-session-codec.js'
import type { RedisSessionClient } from './redis-session-store.js'
import type { SessionRecord, SessionSummary } from './session-record.js'
import type { SessionStore } from './session-store.js'

export const AGENT_SESSION_NAMESPACE = 'GROUPMATE:SESSION:v2:'
const V1_NAMESPACE = 'GROUPMATE:SESSION:v1:'
const LEGACY_PATTERN = 'CHATGPT:CONVERSATIONS:*'

export interface AgentSessionProjectionFailureEvent {
  readonly event: 'session.projection_failed'
  readonly source: 'v1' | 'legacy'
  readonly scopeKind: SessionAddress['scope']['kind']
}

export interface RedisAgentSessionStoreOptions {
  readonly redis: RedisSessionClient
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly scanCount?: number
  readonly projector?: LegacySessionProjector
  readonly onProjectionFailure?: (event: AgentSessionProjectionFailureEvent) => void
}

function cancelled (): AgentError {
  return new AgentError({
    code: 'cancelled', stage: 'agent.session', retryable: false,
    userMessage: '操作已取消。'
  })
}

function assertNotAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelled()
}

function storageError (stage: string, operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'storage_unavailable', stage, retryable: true,
    userMessage: '会话存储暂时不可用，请稍后重试。',
    details: { operation }, cause
  })
}

function invalidData (stage: string, operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'storage_invalid_data', stage, retryable: false,
    userMessage: '会话数据无法读取，请重新开始对话。',
    details: { operation }, cause
  })
}

export function agentSessionKey (address: SessionAddress): string {
  const v1 = canonicalSessionKey(address)
  if (!v1.startsWith(V1_NAMESPACE)) throw new TypeError('agent session address is invalid')
  return `${AGENT_SESSION_NAMESPACE}${v1.slice(V1_NAMESPACE.length)}`
}

export function parseAgentSessionKey (key: string): SessionAddress | null {
  if (!key.startsWith(AGENT_SESSION_NAMESPACE)) return null
  return parseCanonicalSessionKey(`${V1_NAMESPACE}${key.slice(AGENT_SESSION_NAMESPACE.length)}`)
}

function sessionSummary<TState> (
  value: SessionRecord<TState>,
  source: SessionSummary['source']
): SessionSummary {
  return Object.freeze({
    address: Object.freeze({
      botId: value.botId,
      scope: Object.freeze({ ...value.scope })
    }),
    sessionId: value.sessionId,
    startedBy: Object.freeze({ ...value.startedBy }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    turnCount: value.turnCount,
    source
  })
}

function defaultStarter (address: SessionAddress): SessionRecord<unknown>['startedBy'] {
  if (address.scope.kind === 'private' || address.scope.kind === 'group_user') {
    return Object.freeze({ userId: address.scope.userId })
  }
  return Object.freeze({ userId: 'unknown' })
}

export class RedisAgentSessionStore implements SessionStore<AgentSessionState> {
  readonly #redis: RedisSessionClient
  readonly #now: () => Date
  readonly #generateId: () => string
  readonly #scanCount: number
  readonly #projector: LegacySessionProjector
  readonly #onProjectionFailure?: RedisAgentSessionStoreOptions['onProjectionFailure']

  constructor (options: RedisAgentSessionStoreOptions) {
    this.#redis = options.redis
    this.#now = options.now ?? (() => new Date())
    this.#generateId = options.generateId ?? randomUUID
    this.#scanCount = options.scanCount ?? 100
    this.#projector = options.projector ?? new LegacySessionProjector()
    this.#onProjectionFailure = options.onProjectionFailure
    if (!Number.isSafeInteger(this.#scanCount) || this.#scanCount <= 0 ||
      this.#scanCount > 1_000) {
      throw new TypeError('agent session scan count is invalid')
    }
  }

  async get (
    address: SessionAddress,
    options: AbortOptions = {}
  ): Promise<SessionRecord<AgentSessionState> | null> {
    assertNotAborted(options.signal)
    const v2Key = agentSessionKey(address)
    const v2 = await this.#read(v2Key, 'agent.session.read', 'get_v2')
    assertNotAborted(options.signal)
    if (v2 !== null) return this.#decodeV2(v2, address)

    const sources: readonly Readonly<{
      kind: 'v1' | 'legacy'
      key: string
      decode(raw: string): SessionRecord<LegacyConversationState>
    }>[] = Object.freeze([
      Object.freeze({
        kind: 'v1' as const,
        key: canonicalSessionKey(address),
        decode: (raw: string) => legacySessionCodec.decodeCanonical(raw, address)
      }),
      Object.freeze({
        kind: 'legacy' as const,
        key: legacySessionKey(address.scope),
        decode: (raw: string) => legacySessionCodec.decodeLegacy(raw, {
          address,
          now: this.#now(),
          sessionId: this.#generateId()
        })
      })
    ])
    for (const source of sources) {
      const raw = await this.#read(source.key, 'agent.session.read', `get_${source.kind}`)
      assertNotAborted(options.signal)
      if (raw === null) continue
      const ttl = await this.#ttl(source.key, `ttl_${source.kind}`)
      assertNotAborted(options.signal)
      if (ttl === 0 || ttl === -2) continue
      if (ttl < -2) throw invalidData(
        'agent.session.migrate', `ttl_${source.kind}`, new TypeError('invalid TTL')
      )
      let projected: SessionRecord<AgentSessionState>
      try {
        projected = this.#projector.project(source.decode(raw), this.#now().toISOString())
      } catch {
        projected = this.#fresh(address)
        this.#projectionFailed(source.kind, address)
      }
      await this.#writeV2(projected, ttl > 0 ? ttl : undefined, 'agent.session.migrate')
      return projected
    }
    return null
  }

  async save (
    value: SessionRecord<AgentSessionState>,
    options: SaveOptions = {}
  ): Promise<void> {
    assertNotAborted(options.signal)
    const ttlSeconds = this.#validTtl(options.ttlSeconds)
    await this.#writeV2(value, ttlSeconds, 'agent.session.save')
  }

  async delete (address: SessionAddress, options: AbortOptions = {}): Promise<boolean> {
    assertNotAborted(options.signal)
    try {
      return await this.#redis.del([
        agentSessionKey(address),
        canonicalSessionKey(address),
        legacySessionKey(address.scope)
      ]) > 0
    } catch (error) {
      throw storageError('agent.session.delete', 'delete_all_versions', error)
    }
  }

  async * list (
    query: { readonly botId: string },
    options: ListOptions = {}
  ): AsyncIterable<SessionSummary> {
    assertNotAborted(options.signal)
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new TypeError('agent session list limit is invalid')
    }
    const seen = new Set<string>()
    let yielded = 0
    const encodedBot = encodeURIComponent(query.botId)

    for await (const key of this.#scan(
      `${AGENT_SESSION_NAMESPACE}${encodedBot}:*`, options.signal
    )) {
      if (yielded >= limit) return
      const address = parseAgentSessionKey(key)
      if (address === null || address.botId !== query.botId) continue
      const raw = await this.#read(key, 'agent.session.list', 'get_v2')
      if (raw === null) continue
      try {
        const value = this.#decodeV2(raw, address)
        const scope = serializeConversationScope(address.scope)
        if (seen.has(scope)) continue
        seen.add(scope)
        yielded += 1
        yield sessionSummary(value, 'canonical')
      } catch {
        // One corrupt entry cannot break a bounded list.
      }
    }

    for await (const key of this.#scan(`${V1_NAMESPACE}${encodedBot}:*`, options.signal)) {
      if (yielded >= limit) return
      const address = parseCanonicalSessionKey(key)
      if (address === null || address.botId !== query.botId) continue
      const scope = serializeConversationScope(address.scope)
      if (seen.has(scope)) continue
      const raw = await this.#read(key, 'agent.session.list', 'get_v1')
      if (raw === null) continue
      try {
        const value = legacySessionCodec.decodeCanonical(raw, address)
        seen.add(scope)
        yielded += 1
        yield sessionSummary(value, 'legacy')
      } catch {
        // Preserve malformed legacy input for manual recovery.
      }
    }

    for await (const key of this.#scan(LEGACY_PATTERN, options.signal)) {
      if (yielded >= limit) return
      const scope = parseLegacySessionKey(key)
      if (scope === null) continue
      const scopeKey = serializeConversationScope(scope)
      if (seen.has(scopeKey)) continue
      const raw = await this.#read(key, 'agent.session.list', 'get_legacy')
      if (raw === null) continue
      const address: SessionAddress = { botId: query.botId, scope }
      try {
        const value = legacySessionCodec.decodeLegacy(raw, {
          address, now: this.#now(), sessionId: this.#generateId()
        })
        seen.add(scopeKey)
        yielded += 1
        yield sessionSummary(value, 'legacy')
      } catch {
        // Preserve malformed legacy input for manual recovery.
      }
    }
  }

  async deleteAll (
    query: { readonly botId: string },
    options: AbortOptions = {}
  ): Promise<number> {
    const encodedBot = encodeURIComponent(query.botId)
    let deleted = 0
    for (const pattern of [
      `${AGENT_SESSION_NAMESPACE}${encodedBot}:*`,
      `${V1_NAMESPACE}${encodedBot}:*`,
      LEGACY_PATTERN
    ]) {
      deleted += await this.#deletePattern(pattern, options.signal)
    }
    return deleted
  }

  async fork (
    source: SessionAddress,
    target: SessionAddress,
    startedBy: SessionRecord<AgentSessionState>['startedBy'],
    options: SaveOptions = {}
  ): Promise<SessionRecord<AgentSessionState>> {
    assertNotAborted(options.signal)
    const sourceRecord = await this.get(source, options)
    if (sourceRecord === null) {
      throw new AgentError({
        code: 'invalid_session', stage: 'agent.session.fork', retryable: false,
        userMessage: '源会话不存在，无法加入。'
      })
    }
    const now = this.#now().toISOString()
    const draft: SessionRecord<AgentSessionState> = {
      schemaVersion: 1,
      sessionId: this.#generateId(),
      botId: target.botId,
      scope: target.scope,
      startedBy,
      createdAt: now,
      updatedAt: now,
      turnCount: sourceRecord.turnCount,
      state: sourceRecord.state
    }
    const forked = agentSessionCodec.decodeCanonical(agentSessionCodec.encode(draft), target)
    await this.save(forked, options)
    return forked
  }

  #fresh (address: SessionAddress): SessionRecord<AgentSessionState> {
    const now = this.#now().toISOString()
    return agentSessionCodec.decodeCanonical(agentSessionCodec.encode({
      schemaVersion: 1,
      sessionId: this.#generateId(),
      botId: address.botId,
      scope: address.scope,
      startedBy: defaultStarter(address),
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      state: { schemaVersion: 1, messages: [] }
    }), address)
  }

  #projectionFailed (source: 'v1' | 'legacy', address: SessionAddress): void {
    try {
      this.#onProjectionFailure?.(Object.freeze({
        event: 'session.projection_failed',
        source,
        scopeKind: address.scope.kind
      }))
    } catch {
      // Diagnostics are outside the session data plane.
    }
  }

  #decodeV2 (raw: string, address: SessionAddress): SessionRecord<AgentSessionState> {
    try {
      return agentSessionCodec.decodeCanonical(raw, address)
    } catch (error) {
      throw invalidData('agent.session.read', 'decode_v2', error)
    }
  }

  async #read (key: string, stage: string, operation: string): Promise<string | null> {
    try {
      return await this.#redis.get(key)
    } catch (error) {
      throw storageError(stage, operation, error)
    }
  }

  async #ttl (key: string, operation: string): Promise<number> {
    try {
      return await this.#redis.ttl(key)
    } catch (error) {
      throw storageError('agent.session.migrate', operation, error)
    }
  }

  async #writeV2 (
    value: SessionRecord<AgentSessionState>,
    ttlSeconds: number | undefined,
    stage: string
  ): Promise<void> {
    let encoded: string
    try {
      encoded = agentSessionCodec.encode(value)
    } catch (error) {
      throw invalidData(stage, 'encode_v2', error)
    }
    try {
      await this.#redis.set(
        agentSessionKey({ botId: value.botId, scope: value.scope }),
        encoded,
        ttlSeconds === undefined ? undefined : { EX: ttlSeconds }
      )
    } catch (error) {
      throw storageError(stage, 'set_v2', error)
    }
  }

  async * #scan (pattern: string, signal?: AbortSignal): AsyncIterable<string> {
    let cursor = 0
    do {
      assertNotAborted(signal)
      let page: { cursor: number; keys: string[] }
      try {
        page = await this.#redis.scan(cursor, { MATCH: pattern, COUNT: this.#scanCount })
      } catch (error) {
        throw storageError('agent.session.scan', 'scan', error)
      }
      if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.keys)) {
        throw storageError('agent.session.scan', 'scan', new TypeError('invalid scan page'))
      }
      for (const key of page.keys) {
        assertNotAborted(signal)
        yield key
      }
      cursor = page.cursor
    } while (cursor !== 0)
  }

  async #deletePattern (pattern: string, signal?: AbortSignal): Promise<number> {
    let deleted = 0
    while (true) {
      const keys: string[] = []
      for await (const key of this.#scan(pattern, signal)) {
        keys.push(key)
        if (keys.length >= this.#scanCount) break
      }
      if (keys.length === 0) return deleted
      try {
        deleted += await this.#redis.del(keys)
      } catch (error) {
        throw storageError('agent.session.delete_all', 'delete_page', error)
      }
    }
  }

  #validTtl (value?: number): number | undefined {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('agent session TTL is invalid')
    }
    return value
  }
}
