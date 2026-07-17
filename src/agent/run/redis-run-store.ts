import { createHash } from 'node:crypto'
import { AgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import type { AgentEvent } from '../contracts/event.js'
import { canonicalSessionKey } from '../session/conversation-scope.js'
import {
  RunCheckpointCodec,
  type EncodedRunCheckpoint,
  type LoadedRunCheckpoint,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpoint
} from './run-checkpoint.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import { isTerminalRunStatus } from './run-state.js'
import {
  checkpointWithAppendedEvents,
  createRunTombstoneV2,
  normalizeRunTombstone,
  parseTerminalCommitReceipt,
  parseRunTombstone,
  RunReferenceConflictError,
  RunStoreConflictError,
  validateTerminalCommitInput,
  type NormalizedRunTombstoneV1,
  type RunStore,
  type RunStoreObservationUsageV1,
  type RunTombstoneV2,
  type TerminalCommitReceiptV1
} from './run-store.js'
import type { RunTerminalSnapshotV2 } from './run-observation.js'
import { RUN_REF_PATTERN } from './run-reference.js'

export interface RedisRunClient {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean }
  ): Promise<string | null>
  del(key: string | readonly string[]): Promise<number>
  ttl(key: string): Promise<number>
  scan(cursor: number, options: {
    MATCH: string
    COUNT: number
  }): Promise<{ cursor: number; keys: string[] }>
  eval(script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown>
}

export interface RedisRunStoreOptions {
  readonly client: RedisRunClient
  readonly activeTtlSeconds?: number
}

export interface RedisRunKeys {
  readonly checkpoint: string
  readonly events: string
  readonly tombstone: string
}

export const RUN_STORE_NAMESPACE = 'GROUPMATE:RUN:v1:'
export const RUN_STORE_LUA_MARKER = '-- GROUPMATE_RUN_STORE_V1'
export const RUN_STORE_METADATA_KEY = `${RUN_STORE_NAMESPACE}approval-index:namespace-budget`

export const RUN_STORE_LUA_SCRIPT = `${RUN_STORE_LUA_MARKER}
local operation = ARGV[1]

if operation == 'load' then
  return { redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false }
end

if operation == 'reconcile' then
  local current = redis.call('GET', KEYS[1]) or ''
  if current ~= ARGV[2] then return 'conflict' end
  redis.call('SET', KEYS[1], ARGV[3])
  return 'ok'
end

local metadataKey = KEYS[#KEYS]

if operation == 'tombstone_delete_corrupt' then
  local value = redis.call('GET', KEYS[1])
  if not value then
    redis.call('DEL', metadataKey)
    return 'missing'
  end
  if value ~= ARGV[2] then
    redis.call('DEL', metadataKey)
    return 'conflict'
  end
  redis.call('DEL', KEYS[1])
  redis.call('DEL', metadataKey)
  return 'ok'
end

local metadata = redis.call('GET', metadataKey)
if not metadata then return 'reconcile' end
local bytes, checkpoints, events, tombstones, indexes, references, tombstoneBytes = string.match(
  metadata,
  '^(%d+)|(%d+)|(%d+)|(%d+)|(%d+)|(%d+)|(%d+)$'
)
if not bytes or not tombstoneBytes then return 'reconcile' end
local current = {
  bytes = tonumber(bytes),
  checkpoints = tonumber(checkpoints),
  events = tonumber(events),
  tombstones = tonumber(tombstones),
  indexes = tonumber(indexes),
  references = tonumber(references),
  tombstoneBytes = tonumber(tombstoneBytes)
}

local function exceeds(value)
  return value.bytes > ${RUN_RESOURCE_LIMITS.namespaceBytes} or
    value.checkpoints > ${RUN_RESOURCE_LIMITS.checkpointKeys} or
    value.events > ${RUN_RESOURCE_LIMITS.eventKeys} or
    value.tombstones > ${RUN_RESOURCE_LIMITS.tombstoneKeys} or
    value.indexes > ${RUN_RESOURCE_LIMITS.indexAdmissionKeys} or
    value.references > ${RUN_RESOURCE_LIMITS.referenceKeys}
end

local function invalid(value)
  return value.bytes < 0 or value.checkpoints < 0 or value.events < 0 or
    value.tombstones < 0 or value.indexes < 0 or value.references < 0 or
    value.tombstoneBytes < 0
end

local function save(value)
  redis.call('SET', metadataKey, table.concat({
    value.bytes,
    value.checkpoints,
    value.events,
    value.tombstones,
    value.indexes,
    value.references,
    value.tombstoneBytes
  }, '|'))
end

if operation == 'create' then
  if redis.call('EXISTS', KEYS[1], KEYS[2], KEYS[3]) > 0 then return 'conflict' end
  if redis.call('EXISTS', KEYS[4]) > 0 then return 'reference_conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]) + string.len(ARGV[3]) +
      string.len(KEYS[4]) + string.len(ARGV[5]),
    checkpoints = current.checkpoints + 1,
    events = current.events + 1,
    tombstones = current.tombstones,
    indexes = current.indexes,
    references = current.references + 1,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
  redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
  redis.call('SET', KEYS[4], ARGV[5], 'EX', tonumber(ARGV[4]))
  save(projected)
  return 'ok'
end

if operation == 'upgrade' then
  local oldCheckpoint = redis.call('GET', KEYS[1])
  local oldEvents = redis.call('GET', KEYS[2])
  if oldCheckpoint ~= ARGV[2] or oldEvents ~= ARGV[3] or
    redis.call('EXISTS', KEYS[3]) > 0 then return 'conflict' end
  if redis.call('EXISTS', KEYS[4]) > 0 then return 'reference_conflict' end
  local projected = {
    bytes = current.bytes - string.len(oldCheckpoint) - string.len(oldEvents) +
      string.len(ARGV[4]) + string.len(ARGV[5]) + string.len(KEYS[4]) +
      string.len(ARGV[7]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes,
    references = current.references + 1,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[4], 'EX', tonumber(ARGV[6]))
  redis.call('SET', KEYS[2], ARGV[5], 'EX', tonumber(ARGV[6]))
  redis.call('SET', KEYS[4], ARGV[7], 'EX', tonumber(ARGV[6]))
  save(projected)
  return 'ok'
end

if operation == 'cas' then
  local oldCheckpoint = redis.call('GET', KEYS[1])
  local oldEvents = redis.call('GET', KEYS[2])
  local reference = redis.call('GET', KEYS[4])
  if oldCheckpoint ~= ARGV[2] or oldEvents ~= ARGV[3] or
    reference ~= ARGV[7] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(oldCheckpoint) - string.len(oldEvents) +
      string.len(ARGV[4]) + string.len(ARGV[5]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[4], 'EX', tonumber(ARGV[6]))
  redis.call('SET', KEYS[2], ARGV[5], 'EX', tonumber(ARGV[6]))
  redis.call('SET', KEYS[4], ARGV[7], 'EX', tonumber(ARGV[6]))
  save(projected)
  return 'ok'
end

if operation == 'commit_terminal' then
  local oldCheckpoint = redis.call('GET', KEYS[1])
  local oldEvents = redis.call('GET', KEYS[2])
  local reference = redis.call('GET', KEYS[4])
  if oldCheckpoint ~= ARGV[2] or oldEvents ~= ARGV[3] or
    redis.call('EXISTS', KEYS[3]) > 0 or reference ~= ARGV[6] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(oldCheckpoint) - string.len(oldEvents) + string.len(ARGV[4]),
    checkpoints = current.checkpoints - 1,
    events = current.events - 1,
    tombstones = current.tombstones + 1,
    indexes = current.indexes,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes + string.len(ARGV[4])
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  local deleted = redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('SET', KEYS[3], ARGV[4], 'EX', tonumber(ARGV[5]))
  redis.call('SET', KEYS[4], ARGV[6], 'EX', tonumber(ARGV[5]))
  save(projected)
  return {
    'ok',
    deleted,
    1,
    string.len(oldCheckpoint),
    string.len(oldEvents),
    string.len(ARGV[4])
  }
end

if operation == 'admission_acquire' then
  if redis.call('EXISTS', KEYS[1]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes + 1,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
  save(projected)
  return 'ok'
end

if operation == 'admission_recover' then
  local claim = redis.call('GET', KEYS[1]) or ''
  if claim ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(claim) + string.len(ARGV[3]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if claim == '' then projected.indexes = projected.indexes + 1 end
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))
  save(projected)
  return 'ok'
end

if operation == 'admission_release' then
  local claim = redis.call('GET', KEYS[1])
  if claim ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(claim),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes - 1,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  redis.call('DEL', KEYS[1])
  save(projected)
  return 'ok'
end

if operation == 'approval_index_create' then
  if redis.call('EXISTS', KEYS[1]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes + 1,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
  save(projected)
  return 'ok'
end

if operation == 'approval_index_delete' then
  local value = redis.call('GET', KEYS[1])
  if value ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(value),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes - 1,
    references = current.references,
    tombstoneBytes = current.tombstoneBytes
  }
  if invalid(projected) then return 'reconcile' end
  redis.call('DEL', KEYS[1])
  save(projected)
  return 'ok'
end

return 'invalid_operation'
`

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACTIVE_TTL_SECONDS = 600
const APPROVAL_WAIT_TTL_SECONDS = 600
const TOMBSTONE_TTL_SECONDS = 86_400
const NAMESPACE_SCAN_COUNT = 128

interface RunNamespaceUsage {
  bytes: number
  checkpoints: number
  events: number
  tombstones: number
  indexes: number
  references: number
  tombstoneBytes: number
}

function digest (value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function checkedRunId (runId: string): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw new TypeError('run ID is invalid')
  }
  return runId
}

export function redisRunKeys (runId: string): RedisRunKeys {
  const id = digest(checkedRunId(runId))
  return Object.freeze({
    checkpoint: `${RUN_STORE_NAMESPACE}checkpoint:${id}`,
    events: `${RUN_STORE_NAMESPACE}events:${id}`,
    tombstone: `${RUN_STORE_NAMESPACE}tombstone:${id}`
  })
}

export function redisRunReferenceKey (runRef: string): string {
  if (typeof runRef !== 'string' || !RUN_REF_PATTERN.test(runRef)) {
    throw new TypeError('run reference is invalid')
  }
  return `${RUN_STORE_NAMESPACE}reference:${runRef}`
}

export function redisAdmissionKey (address: SessionAddress): string {
  return `${RUN_STORE_NAMESPACE}admission:${digest(canonicalSessionKey(address))}`
}

function storageUnavailable (operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'storage_unavailable',
    stage: 'run.store',
    retryable: true,
    userMessage: '任务状态暂时无法保存，请稍后重试。',
    details: { operation },
    cause
  })
}

function checkpointInvalid (operation: string, cause: unknown): AgentError {
  return new AgentError({
    code: 'checkpoint_invalid',
    stage: 'run.checkpoint',
    retryable: false,
    userMessage: '任务状态已损坏或不兼容，请重新发起。',
    details: { operation },
    cause
  })
}

function runBudgetExceeded (operation: string): AgentError {
  return new AgentError({
    code: 'run_budget_exceeded',
    stage: 'run.store',
    retryable: false,
    userMessage: '当前任务队列已达到资源上限，请稍后重试。',
    details: { operation }
  })
}

function emptyNamespaceUsage (): RunNamespaceUsage {
  return {
    bytes: 0,
    checkpoints: 0,
    events: 0,
    tombstones: 0,
    indexes: 0,
    references: 0,
    tombstoneBytes: 0
  }
}

function encodeNamespaceUsage (usage: RunNamespaceUsage): string {
  return [
    usage.bytes,
    usage.checkpoints,
    usage.events,
    usage.tombstones,
    usage.indexes,
    usage.references,
    usage.tombstoneBytes
  ].join('|')
}

function namespaceLimitExceeded (usage: RunNamespaceUsage): boolean {
  return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
    usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
    usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
    usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
    usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys ||
    usage.references > RUN_RESOURCE_LIMITS.referenceKeys
}

async function auditNamespace (client: RedisRunClient): Promise<RunNamespaceUsage> {
  const usage = emptyNamespaceUsage()
  const seen = new Set<string>()
  let cursor = 0
  try {
    do {
      const page = await client.scan(cursor, {
        MATCH: `${RUN_STORE_NAMESPACE}*`,
        COUNT: NAMESPACE_SCAN_COUNT
      })
      if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
        !Array.isArray(page.keys)) {
        throw new TypeError('invalid namespace scan result')
      }
      for (const key of page.keys) {
        if (key === RUN_STORE_METADATA_KEY || seen.has(key)) continue
        seen.add(key)
        const raw = await client.get(key)
        if (raw === null) continue
        usage.bytes += Buffer.byteLength(raw, 'utf8')
        if (key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`)) usage.checkpoints += 1
        else if (key.startsWith(`${RUN_STORE_NAMESPACE}events:`)) usage.events += 1
        else if (key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`)) {
          usage.tombstones += 1
          usage.tombstoneBytes += Buffer.byteLength(raw, 'utf8')
        }
        else if (key.startsWith(`${RUN_STORE_NAMESPACE}reference:`)) {
          usage.bytes += Buffer.byteLength(key, 'utf8')
          usage.references += 1
        }
        else usage.indexes += 1
        if (namespaceLimitExceeded(usage)) throw runBudgetExceeded('namespace_reconcile')
      }
      cursor = page.cursor
    } while (cursor !== 0)
    return usage
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw storageUnavailable('namespace_reconcile', error)
  }
}

async function evaluate (
  client: RedisRunClient,
  operation: string,
  keys: readonly string[],
  args: readonly string[]
): Promise<unknown> {
  try {
    return await client.eval(RUN_STORE_LUA_SCRIPT, {
      keys: [...keys],
      arguments: [operation, ...args]
    })
  } catch (error) {
    throw storageUnavailable(operation, error)
  }
}

async function reconcileNamespace (client: RedisRunClient): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let expected: string | null
    try {
      expected = await client.get(RUN_STORE_METADATA_KEY)
    } catch (error) {
      throw storageUnavailable('namespace_metadata', error)
    }
    const usage = await auditNamespace(client)
    const result = await evaluate(client, 'reconcile', [RUN_STORE_METADATA_KEY], [
      expected ?? '',
      encodeNamespaceUsage(usage)
    ])
    if (result === 'ok') return
    if (result !== 'conflict') {
      throw storageUnavailable('namespace_reconcile', new TypeError('unexpected Lua result'))
    }
  }
  throw new RunStoreConflictError()
}

async function mutate (
  client: RedisRunClient,
  operation: string,
  keys: readonly string[],
  args: readonly string[]
): Promise<unknown> {
  let reconciled = false
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await evaluate(client, operation, [...keys, RUN_STORE_METADATA_KEY], args)
    if (result === 'reconcile' || (result === 'budget' && !reconciled)) {
      await reconcileNamespace(client)
      reconciled = true
      continue
    }
    return result
  }
  throw new RunStoreConflictError()
}

function requireMutationSuccess (result: unknown, operation: string): void {
  if (result === 'ok') return
  if (result === 'reference_conflict') throw new RunReferenceConflictError()
  if (result === 'conflict') throw new RunStoreConflictError()
  if (result === 'budget') throw runBudgetExceeded(operation)
  throw storageUnavailable(operation, new TypeError('unexpected Lua result'))
}

function encodeTombstone (value: RunTombstoneV2): string {
  const parsed = parseRunTombstone(value)
  if (parsed.schemaVersion !== 2) {
    throw checkpointInvalid('encode_tombstone', new TypeError('v2 tombstone is required'))
  }
  const raw = JSON.stringify(parsed)
  if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
    throw checkpointInvalid('encode_tombstone', new TypeError('tombstone byte limit exceeded'))
  }
  return raw
}

export async function acquireAdmissionClaim (
  client: RedisRunClient,
  key: string,
  leaseId: string,
  ttlSeconds: number
): Promise<boolean> {
  const result = await mutate(client, 'admission_acquire', [key], [
    leaseId,
    String(ttlSeconds)
  ])
  if (result === 'conflict') return false
  requireMutationSuccess(result, 'admission_acquire')
  return true
}

export async function releaseAdmissionClaim (
  client: RedisRunClient,
  key: string,
  leaseId: string
): Promise<void> {
  const result = await mutate(client, 'admission_release', [key], [leaseId])
  if (result === 'conflict') return
  requireMutationSuccess(result, 'admission_release')
}

export async function recoverAdmissionClaim (
  client: RedisRunClient,
  key: string,
  leaseId: string,
  ttlSeconds: number
): Promise<void> {
  let expected: string | null
  try {
    expected = await client.get(key)
  } catch (error) {
    throw storageUnavailable('admission_recover', error)
  }
  const result = await mutate(client, 'admission_recover', [key], [
    expected ?? '',
    leaseId,
    String(ttlSeconds)
  ])
  requireMutationSuccess(result, 'admission_recover')
}

export async function createApprovalRunIndex (
  client: RedisRunClient,
  key: string,
  value: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!key.startsWith(`${RUN_STORE_NAMESPACE}approval-index:`) ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    throw new TypeError('approval run index is invalid')
  }
  const result = await mutate(client, 'approval_index_create', [key], [
    value,
    String(ttlSeconds)
  ])
  if (result === 'conflict') return false
  requireMutationSuccess(result, 'approval_index_create')
  return true
}

export async function deleteApprovalRunIndex (
  client: RedisRunClient,
  key: string,
  value: string
): Promise<void> {
  if (!key.startsWith(`${RUN_STORE_NAMESPACE}approval-index:`) ||
    Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new TypeError('approval run index is invalid')
  }
  const result = await mutate(client, 'approval_index_delete', [key], [value])
  if (result === 'conflict') return
  requireMutationSuccess(result, 'approval_index_delete')
}

export class RedisRunStore implements RunStore {
  readonly #client: RedisRunClient
  readonly #codec = new RunCheckpointCodec()
  readonly #activeTtlSeconds: number

  constructor (options: RedisRunStoreOptions) {
    this.#client = options.client
    this.#activeTtlSeconds = options.activeTtlSeconds ?? ACTIVE_TTL_SECONDS
    if (!Number.isSafeInteger(this.#activeTtlSeconds) ||
      this.#activeTtlSeconds < 300 || this.#activeTtlSeconds > 86_400) {
      throw new TypeError('active run TTL is invalid')
    }
  }

  async create (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    if (checkpoint.revision !== 0 || checkpoint.status !== 'created') {
      throw new RunStoreConflictError()
    }
    const encoded = this.#encode(checkpoint, 'create')
    const keys = redisRunKeys(checkpoint.runId)
    const referenceKey = redisRunReferenceKey(checkpoint.runRef)
    const result = await mutate(this.#client, 'create', [
      keys.checkpoint, keys.events, keys.tombstone, referenceKey
    ], [
      encoded.checkpoint,
      encoded.events,
      String(this.#activeTtlSeconds),
      checkpoint.runId
    ])
    requireMutationSuccess(result, 'create')
    return checkpoint
  }

  async load (runId: string): Promise<LoadedRunCheckpoint | null> {
    const keys = redisRunKeys(runId)
    const result = await evaluate(this.#client, 'load', [
      keys.checkpoint, keys.events
    ], [])
    if (!Array.isArray(result) || result.length !== 2) {
      throw storageUnavailable('load', new TypeError('unexpected Lua result'))
    }
    const checkpointRaw = result[0] === false || result[0] === null
      ? null
      : result[0]
    const eventsRaw = result[1] === false || result[1] === null
      ? null
      : result[1]
    if (checkpointRaw === null && eventsRaw === null) return null
    if (typeof checkpointRaw !== 'string' || typeof eventsRaw !== 'string') {
      throw checkpointInvalid('load', new TypeError('split checkpoint is incomplete'))
    }
    try {
      const decoded = this.#codec.decode(checkpointRaw, eventsRaw)
      if (decoded.runId !== runId) throw new TypeError('run ID does not match its key')
      return decoded
    } catch (error) {
      throw checkpointInvalid('load', error)
    }
  }

  async upgrade (
    expected: RunCheckpointV1,
    next: RunCheckpointV2
  ): Promise<RunCheckpointV2> {
    if (expected.schemaVersion !== 1 || next.schemaVersion !== 2 ||
      next.runId !== expected.runId || next.sessionId !== expected.sessionId ||
      next.revision !== expected.revision + 1) {
      throw new RunStoreConflictError()
    }
    const expectedEncoded = this.#encodeLoaded(expected, 'upgrade_expected')
    const nextEncoded = this.#encode(next, 'upgrade_next')
    const keys = redisRunKeys(expected.runId)
    const referenceKey = redisRunReferenceKey(next.runRef)
    const activeTtlSeconds = next.status === 'waiting_approval'
      ? Math.max(this.#activeTtlSeconds, APPROVAL_WAIT_TTL_SECONDS)
      : this.#activeTtlSeconds
    const result = await mutate(this.#client, 'upgrade', [
      keys.checkpoint, keys.events, keys.tombstone, referenceKey
    ], [
      expectedEncoded.checkpoint,
      expectedEncoded.events,
      nextEncoded.checkpoint,
      nextEncoded.events,
      String(activeTtlSeconds),
      next.runId
    ])
    requireMutationSuccess(result, 'upgrade')
    return next
  }

  async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    if (next.runId !== expected.runId || next.sessionId !== expected.sessionId ||
      next.revision !== expected.revision + 1 || next.runRef !== expected.runRef ||
      next.requestRef !== expected.requestRef || isTerminalRunStatus(expected.status) ||
      isTerminalRunStatus(next.status)) {
      throw new RunStoreConflictError()
    }
    const expectedEncoded = this.#encode(expected, 'compare_expected')
    const nextEncoded = this.#encode(next, 'compare_next')
    const keys = redisRunKeys(expected.runId)
    const referenceKey = redisRunReferenceKey(expected.runRef)
    const activeTtlSeconds = next.status === 'waiting_approval'
      ? Math.max(this.#activeTtlSeconds, APPROVAL_WAIT_TTL_SECONDS)
      : this.#activeTtlSeconds
    const result = await mutate(this.#client, 'cas', [
      keys.checkpoint, keys.events, keys.tombstone, referenceKey
    ], [
      expectedEncoded.checkpoint,
      expectedEncoded.events,
      nextEncoded.checkpoint,
      nextEncoded.events,
      String(activeTtlSeconds),
      expected.runId
    ])
    requireMutationSuccess(result, 'compare_and_set')
    return next
  }

  async appendEvents (
    expected: RunCheckpoint,
    events: readonly AgentEvent[]
  ): Promise<RunCheckpoint> {
    if (events.length === 0) return expected
    return await this.compareAndSet(
      expected,
      checkpointWithAppendedEvents(expected, events)
    )
  }

  async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: RunTerminalSnapshotV2
  ): Promise<TerminalCommitReceiptV1> {
    const validated = validateTerminalCommitInput(expected, next, snapshot)
    const encoded = this.#encode(expected, 'commit_terminal_expected')
    const tombstone = encodeTombstone(createRunTombstoneV2(validated.snapshot))
    const keys = redisRunKeys(expected.runId)
    const referenceKey = redisRunReferenceKey(expected.runRef)
    const result = await mutate(this.#client, 'commit_terminal', [
      keys.checkpoint, keys.events, keys.tombstone, referenceKey
    ], [
      encoded.checkpoint,
      encoded.events,
      tombstone,
      String(TOMBSTONE_TTL_SECONDS),
      expected.runId
    ])
    if (!Array.isArray(result) || result.length !== 6 || result[0] !== 'ok') {
      requireMutationSuccess(result, 'commit_terminal')
      throw storageUnavailable(
        'commit_terminal',
        new TypeError('unexpected terminal commit receipt')
      )
    }
    const numbers = result.slice(1).map(value => Number(value))
    if (numbers.some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw storageUnavailable(
        'commit_terminal',
        new TypeError('invalid terminal commit receipt')
      )
    }
    return parseTerminalCommitReceipt({
      schemaVersion: 1,
      observationId: validated.snapshot.observationId,
      runRef: validated.snapshot.runRef,
      revision: validated.snapshot.revision,
      deletedKeyCount: numbers[0],
      createdKeyCount: numbers[1],
      checkpointBytesDeleted: numbers[2],
      eventBytesDeleted: numbers[3],
      tombstoneBytes: numbers[4]
    })
  }

  async loadTombstone (runId: string): Promise<NormalizedRunTombstoneV1 | null> {
    const key = redisRunKeys(runId).tombstone
    let raw: string | null
    try {
      raw = await this.#client.get(key)
    } catch (error) {
      throw storageUnavailable('load_tombstone', error)
    }
    if (raw === null) return null
    if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
      await this.#repairCorruptTombstone(key, raw)
      throw checkpointInvalid('load_tombstone', new TypeError('tombstone byte limit exceeded'))
    }
    try {
      const decoded = parseRunTombstone(JSON.parse(raw) as unknown)
      if (decoded.schemaVersion === 1 && decoded.runId !== runId) {
        throw new TypeError('run ID does not match its tombstone key')
      }
      return normalizeRunTombstone(decoded)
    } catch (error) {
      await this.#repairCorruptTombstone(key, raw)
      throw checkpointInvalid('load_tombstone', error)
    }
  }

  async observationUsage (): Promise<RunStoreObservationUsageV1> {
    let raw: string | null
    try {
      raw = await this.#client.get(RUN_STORE_METADATA_KEY)
    } catch {
      return Object.freeze({
        schemaVersion: 1,
        tombstoneRecords: 'unavailable',
        tombstoneBytes: 'unavailable'
      })
    }
    if (raw === null || !/^\d+\|\d+\|\d+\|\d+\|\d+\|\d+\|\d+$/.test(raw)) {
      return Object.freeze({
        schemaVersion: 1,
        tombstoneRecords: 'unavailable',
        tombstoneBytes: 'unavailable'
      })
    }
    const values = raw.split('|').map(value => Number(value))
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
      return Object.freeze({
        schemaVersion: 1,
        tombstoneRecords: 'unavailable',
        tombstoneBytes: 'unavailable'
      })
    }
    return Object.freeze({
      schemaVersion: 1,
      tombstoneRecords: values[3] ?? 'unavailable',
      tombstoneBytes: values[6] ?? 'unavailable'
    })
  }

  async #repairCorruptTombstone (key: string, raw: string): Promise<void> {
    try {
      const result = await mutate(
        this.#client,
        'tombstone_delete_corrupt',
        [key],
        [raw]
      )
      if (result !== 'ok' && result !== 'missing' && result !== 'conflict') {
        requireMutationSuccess(result, 'tombstone_delete_corrupt')
      }
      if (result === 'ok' || result === 'missing' || result === 'conflict') {
        await reconcileNamespace(this.#client)
      }
    } catch {
      // Corrupt reads remain fail-closed even when best-effort bounded repair is unavailable.
    }
  }

  #encode (checkpoint: RunCheckpoint, operation: string): EncodedRunCheckpoint {
    try {
      return this.#codec.encode(checkpoint)
    } catch (error) {
      throw checkpointInvalid(operation, error)
    }
  }

  #encodeLoaded (
    checkpoint: LoadedRunCheckpoint,
    operation: string
  ): EncodedRunCheckpoint {
    if (checkpoint.schemaVersion === 2) return this.#encode(checkpoint, operation)
    try {
      const { events, ...state } = checkpoint
      const encoded = Object.freeze({
        checkpoint: JSON.stringify(state),
        events: JSON.stringify({
          schemaVersion: 1,
          revision: checkpoint.revision,
          events
        })
      })
      if (Buffer.byteLength(encoded.checkpoint, 'utf8') > RUN_RESOURCE_LIMITS.checkpointBytes ||
        Buffer.byteLength(encoded.events, 'utf8') > RUN_RESOURCE_LIMITS.eventBytes) {
        throw new TypeError('legacy checkpoint byte limit exceeded')
      }
      return encoded
    } catch (error) {
      throw checkpointInvalid(operation, error)
    }
  }
}
