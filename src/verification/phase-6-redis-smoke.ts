import { createConnection, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { RedisRunClient } from '../agent/run/redis-run-store.js'
import { TRACE_RETENTION_MS } from '../agent/run/run-trace.js'
import {
  RedisTraceStore,
  TRACE_KEY_PREFIX,
  TRACE_STORE_LIMITS
} from '../runtime/observability/redis-trace-store.js'
import { createPhase6SmallTraceCandidate } from './phase-6-resource-scenario.js'

const REDIS_TIMEOUT_MS = 5_000
const REDIS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const TRACE_TTL_SECONDS = TRACE_RETENTION_MS / 1_000

export interface Phase6RedisConnection {
  readonly client: RedisRunClient
  readonly close: () => Promise<void>
}

export type Phase6RedisClientFactory = (url: string) => Promise<Phase6RedisConnection>

export interface Phase6RedisSmokeOptions {
  readonly redisUrl?: string
  readonly now?: () => number
  readonly clientFactory?: Phase6RedisClientFactory
}

export type Phase6RedisSmokeResult =
  | Readonly<{
    schemaVersion: 1
    kind: 'skipped'
    reason: 'redis_url_not_configured'
  }>
  | Readonly<{
    schemaVersion: 1
    kind: 'passed'
    records: 2
    bytes: number
    idempotent: true
    ttlBounded: true
  }>

interface ParsedRedisUrl {
  readonly secure: boolean
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly database: number
}

class IncompleteRespError extends Error {}

function decodeComponent (value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new TypeError('Redis credentials are malformed')
  }
}

function parseRedisUrl (value: string): ParsedRedisUrl {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Redis URL is invalid')
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new TypeError('Redis URL protocol is unsupported')
  }
  if (url.hostname === '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('Redis URL is invalid')
  }
  const port = url.port === '' ? (url.protocol === 'rediss:' ? 6380 : 6379) : Number(url.port)
  const databaseText = url.pathname.replace(/^\//, '')
  const database = databaseText === '' ? 0 : Number(databaseText)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 ||
    !Number.isSafeInteger(database) || database < 0) {
    throw new TypeError('Redis URL address is invalid')
  }
  const username = decodeComponent(url.username)
  const password = decodeComponent(url.password)
  if (username !== '' && password === '') {
    throw new TypeError('Redis username requires a password')
  }
  return Object.freeze({
    secure: url.protocol === 'rediss:',
    host: url.hostname,
    port,
    username,
    password,
    database
  })
}

function encodeCommand (parts: readonly string[]): Buffer {
  const chunks = [`*${parts.length}\r\n`]
  for (const part of parts) {
    chunks.push(`$${Buffer.byteLength(part, 'utf8')}\r\n`, part, '\r\n')
  }
  return Buffer.from(chunks.join(''), 'utf8')
}

function lineEnd (buffer: Buffer, offset: number): number {
  const end = buffer.indexOf('\r\n', offset)
  if (end < 0) throw new IncompleteRespError()
  return end
}

function parseResp (buffer: Buffer, offset = 0): Readonly<{ value: unknown; offset: number }> {
  if (offset >= buffer.length) throw new IncompleteRespError()
  const marker = String.fromCharCode(buffer[offset] as number)
  const end = lineEnd(buffer, offset + 1)
  const header = buffer.subarray(offset + 1, end).toString('utf8')
  const bodyOffset = end + 2
  if (marker === '+' || marker === '-' || marker === ':') {
    if (marker === '-') throw new Error('Redis command was rejected')
    if (marker === ':') {
      const value = Number(header)
      if (!Number.isSafeInteger(value)) throw new TypeError('Redis integer response is invalid')
      return Object.freeze({ value, offset: bodyOffset })
    }
    return Object.freeze({ value: header, offset: bodyOffset })
  }
  if (marker === '$') {
    const length = Number(header)
    if (!Number.isSafeInteger(length) || length < -1) {
      throw new TypeError('Redis bulk response is invalid')
    }
    if (length === -1) return Object.freeze({ value: null, offset: bodyOffset })
    const next = bodyOffset + length
    if (next + 2 > buffer.length) throw new IncompleteRespError()
    if (buffer[next] !== 13 || buffer[next + 1] !== 10) {
      throw new TypeError('Redis bulk response terminator is invalid')
    }
    return Object.freeze({
      value: buffer.subarray(bodyOffset, next).toString('utf8'),
      offset: next + 2
    })
  }
  if (marker === '*') {
    const length = Number(header)
    if (!Number.isSafeInteger(length) || length < -1) {
      throw new TypeError('Redis array response is invalid')
    }
    if (length === -1) return Object.freeze({ value: null, offset: bodyOffset })
    const values: unknown[] = []
    let next = bodyOffset
    for (let index = 0; index < length; index += 1) {
      const parsed = parseResp(buffer, next)
      values.push(parsed.value)
      next = parsed.offset
    }
    return Object.freeze({ value: values, offset: next })
  }
  throw new TypeError('Redis response marker is unsupported')
}

class RespRedisClient implements RedisRunClient {
  readonly #options: ParsedRedisUrl

  constructor (options: ParsedRedisUrl) {
    this.#options = options
  }

  async get (key: string): Promise<string | null> {
    const result = await this.#command(['GET', key])
    if (result !== null && typeof result !== 'string') throw new TypeError('Redis GET result is invalid')
    return result
  }

  async set (
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean }
  ): Promise<string | null> {
    const parts = ['SET', key, value]
    if (options?.EX !== undefined) parts.push('EX', String(options.EX))
    if (options?.NX === true) parts.push('NX')
    const result = await this.#command(parts)
    if (result !== null && result !== 'OK') throw new TypeError('Redis SET result is invalid')
    return result
  }

  async del (key: string | readonly string[]): Promise<number> {
    const keys = typeof key === 'string' ? [key] : key
    const result = await this.#command(['DEL', ...keys])
    if (!Number.isSafeInteger(result) || Number(result) < 0) {
      throw new TypeError('Redis DEL result is invalid')
    }
    return Number(result)
  }

  async ttl (key: string): Promise<number> {
    const result = await this.#command(['TTL', key])
    if (!Number.isSafeInteger(result)) throw new TypeError('Redis TTL result is invalid')
    return Number(result)
  }

  async scan (cursor: number, options: {
    MATCH: string
    COUNT: number
  }): Promise<{ cursor: number; keys: string[] }> {
    const result = await this.#command([
      'SCAN', String(cursor), 'MATCH', options.MATCH, 'COUNT', String(options.COUNT)
    ])
    if (!Array.isArray(result) || result.length !== 2 ||
      typeof result[0] !== 'string' || !Array.isArray(result[1]) ||
      result[1].some(value => typeof value !== 'string')) {
      throw new TypeError('Redis SCAN result is invalid')
    }
    const next = Number(result[0])
    if (!Number.isSafeInteger(next) || next < 0) throw new TypeError('Redis SCAN cursor is invalid')
    return { cursor: next, keys: result[1] as string[] }
  }

  async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    return await this.#command([
      'EVAL', script, String(options.keys.length), ...options.keys, ...options.arguments
    ])
  }

  async #command (parts: readonly string[]): Promise<unknown> {
    const prelude: readonly (readonly string[])[] = Object.freeze([
      ...(this.#options.password === ''
        ? []
        : [[
            'AUTH',
            ...(this.#options.username === '' ? [] : [this.#options.username]),
            this.#options.password
          ]]),
      ...(this.#options.database === 0 ? [] : [['SELECT', String(this.#options.database)]])
    ])
    const commands = [...prelude, parts]
    const payload = Buffer.concat(commands.map(encodeCommand))
    return await new Promise<unknown>((resolve, reject) => {
      let socket: Socket | TLSSocket
      let settled = false
      let response = Buffer.alloc(0)
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const receive = (chunk: Buffer): void => {
        response = Buffer.concat([response, chunk])
        if (response.length > REDIS_MAX_RESPONSE_BYTES) {
          finish(new Error('Redis response exceeded the smoke limit'))
          return
        }
        try {
          let offset = 0
          const replies: unknown[] = []
          for (let index = 0; index < commands.length; index += 1) {
            const parsed = parseResp(response, offset)
            replies.push(parsed.value)
            offset = parsed.offset
          }
          for (const reply of replies.slice(0, -1)) {
            if (reply !== 'OK') throw new Error('Redis connection setup failed')
          }
          finish(undefined, replies.at(-1))
        } catch (error) {
          if (!(error instanceof IncompleteRespError)) {
            finish(error instanceof Error ? error : new Error('Redis response parsing failed'))
          }
        }
      }
      const connected = (): void => {
        socket.setTimeout(REDIS_TIMEOUT_MS)
        socket.on('data', receive)
        socket.write(payload)
      }
      socket = this.#options.secure
        ? connectTls({
            host: this.#options.host,
            port: this.#options.port,
            servername: this.#options.host
          }, connected)
        : createConnection({ host: this.#options.host, port: this.#options.port }, connected)
      socket.once('timeout', () => finish(new Error('Redis smoke timed out')))
      socket.once('error', () => finish(new Error('Redis smoke connection failed')))
      socket.once('end', () => {
        if (!settled) finish(new Error('Redis smoke connection ended early'))
      })
    })
  }
}

export async function createPhase6RedisClient (url: string): Promise<Phase6RedisConnection> {
  return Object.freeze({
    client: new RespRedisClient(parseRedisUrl(url)),
    close: async () => undefined
  })
}

function positiveDelta (after: number, before: number): number {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < before) {
    throw new TypeError('Redis usage delta is invalid')
  }
  return after - before
}

export async function runPhase6RedisSmoke (
  options: Phase6RedisSmokeOptions = {}
): Promise<Phase6RedisSmokeResult> {
  const redisUrl = options.redisUrl?.trim()
  if (redisUrl === undefined || redisUrl === '') {
    return Object.freeze({
      schemaVersion: 1,
      kind: 'skipped',
      reason: 'redis_url_not_configured'
    })
  }
  const now = options.now ?? Date.now
  const connection = await (options.clientFactory ?? createPhase6RedisClient)(redisUrl)
  try {
    const traceStore = new RedisTraceStore({ client: connection.client, now })
    const before = await traceStore.usage()
    const smokeNowMs = Math.trunc(now())
    if (!Number.isSafeInteger(smokeNowMs) || smokeNowMs < 0) {
      throw new TypeError('Redis smoke clock is invalid')
    }
    const baseSeed = (smokeNowMs % 900_000_000) + (process.pid % 10_000)
    const candidates = Object.freeze([
      createPhase6SmallTraceCandidate(baseSeed, 'completed', smokeNowMs),
      createPhase6SmallTraceCandidate(baseSeed + 1, 'failed', smokeNowMs)
    ])
    const initial = await Promise.all(candidates.map(async candidate => (
      await traceStore.upsertEngine(candidate)
    )))
    if (initial.some(receipt => receipt.kind !== 'stored')) {
      throw new Error('Redis smoke could not store fresh trace records')
    }
    const repeated = await Promise.all(candidates.map(async candidate => (
      await traceStore.upsertEngine(candidate)
    )))
    const idempotent = repeated.every(receipt => receipt.kind === 'unchanged')
    const loaded = await Promise.all(candidates.map(async candidate => (
      await traceStore.load(candidate.runRef)
    )))
    if (!idempotent || loaded.some(result => result.kind !== 'found')) {
      throw new Error('Redis smoke idempotency check failed')
    }
    const after = await traceStore.usage()
    const records = positiveDelta(after.records, before.records)
    const bytes = positiveDelta(after.bytes, before.bytes)
    if (records !== 2 || bytes <= 0 || bytes > TRACE_STORE_LIMITS.maxBytes) {
      throw new Error('Redis smoke usage check failed')
    }
    const ttls = await Promise.all(candidates.map(async candidate => (
      await connection.client.ttl(`${TRACE_KEY_PREFIX}${candidate.runRef}`)
    )))
    const ttlBounded = ttls.every(ttl => ttl > 0 && ttl <= TRACE_TTL_SECONDS)
    if (!ttlBounded) throw new Error('Redis smoke TTL check failed')
    return Object.freeze({
      schemaVersion: 1,
      kind: 'passed',
      records: 2,
      bytes,
      idempotent: true,
      ttlBounded: true
    })
  } finally {
    await connection.close()
  }
}

export async function main (): Promise<void> {
  try {
    const result = await runPhase6RedisSmoke({
      redisUrl: process.env.GROUPMATE_REDIS_URL
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stdout.write('{"schemaVersion":1,"kind":"failed","reason":"redis_smoke_failed"}\n')
    process.exitCode = 1
  }
}
