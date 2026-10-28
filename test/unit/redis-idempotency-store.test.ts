import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  IdempotencyRecord,
  StoredToolOutcome
} from '../../src/agent/tools/idempotency-store.js'
import { RedisIdempotencyStore } from '../../src/runtime/tools/redis-idempotency-store.js'
import type { RedisToolClient } from '../../src/runtime/tools/redis-tool-client.js'

const namespace = 'GROUPMATE:TOOL:IDEMPOTENCY:v1:'
const botIdHash = 'b1a2c3'

interface SetCall {
  readonly key: string
  readonly value: string
  readonly options: { EX: number; NX?: boolean; XX?: boolean }
}

class RecordingRedis implements RedisToolClient {
  readonly entries = new Map<string, string>()
  readonly setCalls: SetCall[] = []
  readonly getCalls: string[] = []
  failNextSet: Error | null = null
  onGet?: (key: string) => void
  onSet?: (key: string) => void

  async get (key: string): Promise<string | null> {
    this.getCalls.push(key)
    this.onGet?.(key)
    return this.entries.get(key) ?? null
  }

  async getDel (key: string): Promise<string | null> {
    const value = this.entries.get(key) ?? null
    this.entries.delete(key)
    return value
  }

  async set (
    key: string,
    value: string,
    options: { EX: number; NX?: boolean; XX?: boolean }
  ): Promise<unknown> {
    this.setCalls.push({ key, value, options })
    this.onSet?.(key)
    const failure = this.failNextSet
    if (failure !== null) {
      this.failNextSet = null
      throw failure
    }
    if (options.NX === true && this.entries.has(key)) return null
    if (options.XX === true && !this.entries.has(key)) return null
    this.entries.set(key, value)
    return 'OK'
  }

  async del (key: string): Promise<number> {
    return this.entries.delete(key) ? 1 : 0
  }
}

function record (overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return Object.freeze({
    schemaVersion: 1,
    key: 'key-1',
    toolName: 'jinyan',
    toolVersion: 1,
    runIdHash: 'run-hash',
    callIdHash: 'call-hash',
    startedAt: '2026-10-28T00:00:00.000Z',
    ...overrides
  }) as IdempotencyRecord
}

function store (client: RedisToolClient, hash = botIdHash): RedisIdempotencyStore {
  return new RedisIdempotencyStore({ client, botIdHash: hash })
}

test('reservation writes one namespaced NX record and reports acquired', async () => {
  const client = new RecordingRedis()
  const reservation = await store(client).reserve(record(), 300)

  assert.deepEqual(reservation, { kind: 'acquired' })
  assert.equal(client.setCalls.length, 1)
  assert.equal(client.setCalls[0]?.key, `${namespace}${botIdHash}:key-1`)
  assert.deepEqual(client.setCalls[0]?.options, { EX: 300, NX: true })
  assert.deepEqual(JSON.parse(client.setCalls[0]?.value ?? 'null'), {
    schemaVersion: 1,
    state: 'running',
    toolName: 'jinyan',
    toolVersion: 1,
    runIdHash: 'run-hash',
    callIdHash: 'call-hash',
    startedAt: '2026-10-28T00:00:00.000Z'
  })
  assert.equal(Object.isFrozen(reservation), true)
})

test('each bot namespace keeps the same tool key independent', async () => {
  const client = new RecordingRedis()
  assert.deepEqual(await store(client, 'bot-a').reserve(record(), 300), { kind: 'acquired' })
  assert.deepEqual(await store(client, 'bot-b').reserve(record(), 300), { kind: 'acquired' })
  assert.deepEqual([...client.entries.keys()], [
    `${namespace}bot-a:key-1`, `${namespace}bot-b:key-1`
  ])
})

test('a held reservation is reported as running and never acquired twice', async () => {
  const client = new RecordingRedis()
  const first = store(client)
  assert.deepEqual(await first.reserve(record(), 300), { kind: 'acquired' })

  const second = await store(client).reserve(record(), 300)

  assert.deepEqual(second, { kind: 'running' })
  assert.equal(client.setCalls.length, 2)
})

test('completed outcomes are replayed from the stored record', async () => {
  for (const outcome of [
    { status: 'success', effect: 'background', completedAt: '2026-10-28T00:00:01.000Z' },
    { status: 'success', effect: 'visible', completedAt: '2026-10-28T00:00:01.000Z' },
    { status: 'success', effect: 'none', completedAt: '2026-10-28T00:00:01.000Z' },
    {
      status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
      completedAt: '2026-10-28T00:00:01.000Z'
    }
  ] as readonly StoredToolOutcome[]) {
    const client = new RecordingRedis()
    const subject = store(client)
    await subject.reserve(record(), 300)
    await subject.complete('key-1', outcome, 300)

    const replay = await store(client).reserve(record(), 300)

    assert.deepEqual(replay, { kind: 'completed', outcome })
    assert.equal(Object.isFrozen((replay as { outcome: StoredToolOutcome }).outcome), true)
  }
})

test('an indeterminate record keeps the outcome unknown instead of replaying a side effect', async () => {
  const client = new RecordingRedis()
  const subject = store(client)
  await subject.reserve(record(), 300)
  await subject.markIndeterminate('key-1', 300)

  assert.deepEqual(JSON.parse(client.entries.get(`${namespace}${botIdHash}:key-1`) ?? 'null').state, 'indeterminate')
  assert.deepEqual(await store(client).reserve(record(), 300), { kind: 'indeterminate' })
})

test('unreadable stored state degrades to indeterminate rather than a new reservation', async () => {
  const key = `${namespace}${botIdHash}:key-1`
  const oversized = JSON.stringify({
    schemaVersion: 1, state: 'indeterminate', updatedAt: 'x'.repeat(9 * 1024)
  })
  for (const stored of [
    'not json',
    '[]',
    'null',
    JSON.stringify({ schemaVersion: 2, state: 'running' }),
    JSON.stringify({ schemaVersion: 1, state: 'unknown_state' }),
    JSON.stringify({ schemaVersion: 1, state: 'running', toolName: 'jinyan' }),
    JSON.stringify({
      schemaVersion: 1, state: 'running', toolName: 'jinyan', toolVersion: 1,
      runIdHash: 'run-hash', callIdHash: 'call-hash', startedAt: 'not-a-date'
    }),
    JSON.stringify({ schemaVersion: 1, state: 'completed', outcome: { status: 'success' } }),
    JSON.stringify({
      schemaVersion: 1,
      state: 'completed',
      outcome: {
        status: 'success', effect: 'background',
        completedAt: '2026-10-28T00:00:01.000Z', extra: true
      }
    }),
    JSON.stringify({
      schemaVersion: 1,
      state: 'completed',
      outcome: {
        status: 'failed', effect: 'none', errorCode: 'not a code',
        completedAt: '2026-10-28T00:00:01.000Z'
      }
    }),
    JSON.stringify({
      schemaVersion: 1,
      state: 'completed',
      outcome: {
        status: 'failed', effect: 'none', errorCode: 'unmapped_error_code',
        completedAt: '2026-10-28T00:00:01.000Z'
      }
    }),
    JSON.stringify({ schemaVersion: 1, state: 'indeterminate' }),
    oversized
  ]) {
    const client = new RecordingRedis()
    client.entries.set(key, stored)

    assert.deepEqual(
      await store(client).reserve(record(), 300),
      { kind: 'indeterminate' },
      stored.slice(0, 80)
    )
    assert.equal(client.entries.get(key), stored)
  }
})

test('a reservation that expires between NX and GET is retried exactly once', async () => {
  const client = new RecordingRedis()
  const key = `${namespace}${botIdHash}:key-1`
  client.entries.set(key, JSON.stringify({ schemaVersion: 1, state: 'running' }))
  client.onGet = () => client.entries.delete(key)

  assert.deepEqual(await store(client).reserve(record(), 300), { kind: 'acquired' })
  assert.equal(client.setCalls.length, 2)
  assert.deepEqual(client.setCalls[1]?.options, { EX: 300, NX: true })
})

test('a reservation taken by another worker during the retry stays indeterminate', async () => {
  const client = new RecordingRedis()
  const key = `${namespace}${botIdHash}:key-1`
  client.entries.set(key, JSON.stringify({ schemaVersion: 1, state: 'running' }))
  client.onGet = () => client.entries.delete(key)
  client.onSet = () => client.entries.set(key, 'taken by another worker')

  const reservation = await store(client).reserve(record(), 300)

  assert.deepEqual(reservation, { kind: 'indeterminate' })
  assert.equal(client.setCalls.length, 2)
  assert.equal(client.entries.get(key), 'taken by another worker')
})

test('completion and unknown marking require the live reservation', async () => {
  const client = new RecordingRedis()
  const subject = store(client)
  const outcome: StoredToolOutcome = {
    status: 'success', effect: 'background', completedAt: '2026-10-28T00:00:01.000Z'
  }

  await assert.rejects(
    async () => await subject.complete('key-1', outcome, 300),
    /idempotency reservation is missing/
  )
  await assert.rejects(
    async () => await subject.markIndeterminate('key-1', 300),
    /idempotency reservation is missing/
  )
  await subject.reserve(record(), 300)
  await subject.complete('key-1', outcome, 300)

  const completion = client.setCalls.at(-1)
  assert.deepEqual(completion?.options, { EX: 300, XX: true })
  assert.equal(completion?.key, `${namespace}${botIdHash}:key-1`)
})

test('invalid TTLs, records, keys and outcomes are rejected before any Redis call', async () => {
  const client = new RecordingRedis()
  const subject = store(client)
  const outcome: StoredToolOutcome = {
    status: 'success', effect: 'background', completedAt: '2026-10-28T00:00:01.000Z'
  }

  for (const ttl of [29, 86_401, 0, -1, 300.5, Number.NaN]) {
    await assert.rejects(async () => await subject.reserve(record(), ttl), /TTL is invalid/)
    await assert.rejects(async () => await subject.complete('key-1', outcome, ttl), /TTL is invalid/)
    await assert.rejects(async () => await subject.markIndeterminate('key-1', ttl), /TTL is invalid/)
  }
  for (const overrides of [
    { schemaVersion: 2 }, { toolVersion: 2 }, { key: '' }, { key: 'key with space' },
    { toolName: '' }, { runIdHash: '\u0000' },
    { startedAt: 'yesterday' }
  ] as readonly Partial<IdempotencyRecord>[]) {
    await assert.rejects(
      async () => await subject.reserve(record(overrides), 300),
      /idempotency (record|key hash) is invalid/,
      JSON.stringify(overrides)
    )
  }
  for (const invalid of [
    { status: 'success', effect: 'unknown', completedAt: '2026-10-28T00:00:01.000Z' },
    { status: 'success', completedAt: '2026-10-28T00:00:01.000Z' },
    { status: 'failed', effect: 'background', errorCode: 'tool_timeout', completedAt: '2026-10-28T00:00:01.000Z' },
    { status: 'failed', effect: 'none', errorCode: 'tool_timeout', completedAt: 'never' },
    { status: 'indeterminate', effect: 'possible', completedAt: '2026-10-28T00:00:01.000Z' }
  ]) {
    await assert.rejects(
      async () => await subject.complete('key-1', invalid as StoredToolOutcome, 300),
      /stored tool outcome is invalid/,
      JSON.stringify(invalid)
    )
  }
  assert.equal(client.setCalls.length, 0)
  assert.equal(client.getCalls.length, 0)
})

test('a separator inside a tool key is encoded and cannot reach another namespace', async () => {
  const client = new RecordingRedis()
  const forged = `${namespace}victim:key-1`
  await store(client).reserve(record({ key: forged }), 300)

  assert.deepEqual([...client.entries.keys()], [
    `${namespace}${botIdHash}:${encodeURIComponent(forged)}`
  ])
  assert.equal(client.entries.has(forged), false)
  assert.equal([...client.entries.keys()][0]?.includes('victim:'), false)
})

test('the bot namespace hash is validated when the store is constructed', () => {
  const client = new RecordingRedis()
  for (const hash of ['', ' ', 'hash with space', ':', 'a'.repeat(257)]) {
    assert.throws(() => store(client, hash), /bot namespace hash is invalid/, hash)
  }
  assert.doesNotThrow(() => store(client, 'a'.repeat(256)))
})

test('a Redis failure surfaces to the caller instead of a false reservation', async () => {
  const client = new RecordingRedis()
  const subject = store(client)
  client.failNextSet = new Error('redis unavailable')

  await assert.rejects(async () => await subject.reserve(record(), 300), /redis unavailable/)
  assert.equal(client.entries.size, 0)

  await subject.reserve(record(), 300)
  client.failNextSet = new Error('redis unavailable')
  await assert.rejects(
    async () => await subject.markIndeterminate('key-1', 300),
    /redis unavailable/
  )
})
