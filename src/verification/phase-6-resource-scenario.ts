import { createHash } from 'node:crypto'
import type { SessionAddress } from '../agent/contracts/identity.js'
import { AgentError, serializeAgentError } from '../agent/contracts/error.js'
import type { AgentEventType } from '../agent/contracts/event.js'
import {
  ModelProviderError,
  type ModelRequest,
  type ModelTurn
} from '../agent/model/model-adapter.js'
import { parseModelCapabilitySnapshot } from '../agent/model/model-capability.js'
import { createDefaultRunBudget } from '../agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type RunCheckpoint
} from '../agent/run/run-checkpoint.js'
import { createRunEvent } from '../agent/run/run-events.js'
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js'
import {
  RUN_STORE_LUA_MARKER,
  RUN_STORE_METADATA_KEY,
  RUN_STORE_NAMESPACE,
  type RedisRunClient
} from '../agent/run/redis-run-store.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot,
  type ObservationCount
} from '../agent/run/run-observation.js'
import {
  createTraceCandidate,
  type TraceCandidateV1
} from '../agent/run/run-trace.js'
import type { RedisSessionClient } from '../agent/session/redis-session-store.js'
import type { ToolResource } from '../tools/visible-tool-support.js'
import type { YunzaiMessageEvent } from '../runtime/agent-service-bridge.js'
import {
  createProductionYunzaiAgent,
  type ProductionModelPort,
  type ProductionYunzaiAgent,
  type ProductionYunzaiAgentOptions
} from '../runtime/production-yunzai-agent.js'
import type { PresentationSettings } from '../runtime/presentation/presentation-settings.js'
import type { OutboundPart } from '../runtime/presentation/yunzai-outbound-port.js'
import {
  TRACE_BYTES_KEY,
  TRACE_FAILURE_INDEX_KEY,
  TRACE_GENERATION_KEY,
  TRACE_KEY_PREFIX,
  TRACE_STORE_LUA_MARKER,
  TRACE_STORE_LIMITS,
  TRACE_SUCCESS_INDEX_KEY
} from '../runtime/observability/redis-trace-store.js'
import type { BymPolicySnapshot } from '../runtime/yunzai-bym-controller.js'
import type { RedisToolClient } from '../runtime/tools/redis-tool-client.js'

const FIXTURE_MODEL_CAPABILITY = parseModelCapabilitySnapshot({
  schemaVersion: 1,
  source: 'safe_default',
  contextWindowTokens: 32_768,
  maxOutputTokens: 8_192,
  promptCaching: 'unknown',
  usageExtensions: [],
  priceCatalogVersion: null
})

export const PHASE_6_RESOURCE_SCENARIOS = Object.freeze([
  'idle',
  'singleTextRun',
  'dualTextRun',
  'alreadyVisible',
  'checkpointResume',
  'traceBasic',
  'traceDiagnostic',
  'pictureSuccess',
  'pictureFailure'
] as const)

export type Phase6ResourceScenarioName = typeof PHASE_6_RESOURCE_SCENARIOS[number]

export type Phase6ResourceOutcome =
  | 'idle'
  | 'completed'
  | 'visible_output'
  | 'resumed'
  | 'trace_retained'
  | 'picture_success'
  | 'picture_failure'

export const PHASE_6_RESOURCE_OUTCOMES: Readonly<Record<
Phase6ResourceScenarioName,
Phase6ResourceOutcome
>> = Object.freeze({
  idle: 'idle',
  singleTextRun: 'completed',
  dualTextRun: 'completed',
  alreadyVisible: 'visible_output',
  checkpointResume: 'resumed',
  traceBasic: 'trace_retained',
  traceDiagnostic: 'trace_retained',
  pictureSuccess: 'picture_success',
  pictureFailure: 'picture_failure'
})

export const PHASE_6_REDIS_RESOURCE_KINDS = Object.freeze([
  'run_checkpoint',
  'run_event',
  'run_tombstone',
  'run_reference',
  'run_index',
  'run_metadata',
  'trace_record',
  'trace_success_index',
  'trace_failure_index',
  'trace_metadata'
] as const)

export type Phase6RedisResourceKind = typeof PHASE_6_REDIS_RESOURCE_KINDS[number]

export interface Phase6RedisResourceUsage {
  readonly kind: Phase6RedisResourceKind
  readonly records: ObservationCount
  readonly bytes: ObservationCount
}

export interface Phase6ResourceSample {
  readonly scenario: Phase6ResourceScenarioName
  readonly baselineRssBytes: number
  readonly retainedRssBytes: number
  readonly peakRssBytes: number
  readonly wallTimeMs: number
  readonly userCpuMicros: number
  readonly systemCpuMicros: number
  readonly redisResources: readonly Phase6RedisResourceUsage[]
  readonly outcome: Phase6ResourceOutcome
  readonly activePages: number
  readonly borrowedBrowserHandles: number
  readonly newChromiumProcesses: number
}

export interface Phase6ResourceScenarioOptions {
  readonly settleMs?: number
  readonly gc?: () => void
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly resourceUsage?: () => NodeJS.ResourceUsage
}

interface RedisEntry {
  readonly value: string
  readonly expiresAtMs?: number
}

interface RunUsage {
  bytes: number
  checkpoints: number
  events: number
  tombstones: number
  indexes: number
  references: number
  tombstoneBytes: number
}

type ResourceRedisClient = RedisRunClient & RedisSessionClient & RedisToolClient

function utf8Bytes (value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : Buffer.byteLength(value, 'utf8')
}

function emptyRunUsage (): RunUsage {
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

/**
 * This fake executes only the two checked production Lua protocols. Direct
 * GET/SET support is shared by the real session and tool idempotency adapters.
 */
class Phase6ResourceRedis implements ResourceRedisClient {
  readonly #entries = new Map<string, RedisEntry>()
  readonly #sortedSets = new Map<string, Map<string, number>>()
  readonly #traceLengths = new Map<string, number>()
  readonly #now: () => number

  constructor (now: () => number) {
    this.#now = now
  }

  async get (key: string): Promise<string | null> {
    this.#purge(key)
    return this.#entries.get(key)?.value ?? null
  }

  async set (
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean }
  ): Promise<string | null> {
    this.#purge(key)
    if (options?.NX === true && this.#entries.has(key)) return null
    if (options?.XX === true && !this.#entries.has(key)) return null
    this.#entries.set(key, {
      value,
      ...(options?.EX === undefined
        ? {}
        : { expiresAtMs: this.#now() + options.EX * 1_000 })
    })
    return 'OK'
  }

  async getDel (key: string): Promise<string | null> {
    const value = await this.get(key)
    this.#entries.delete(key)
    return value
  }

  async del (key: string | readonly string[]): Promise<number> {
    const keys = typeof key === 'string' ? [key] : key
    let removed = 0
    for (const item of keys) {
      this.#purge(item)
      if (this.#entries.delete(item)) removed += 1
    }
    return removed
  }

  async ttl (key: string): Promise<number> {
    this.#purge(key)
    const entry = this.#entries.get(key)
    if (entry === undefined) return -2
    if (entry.expiresAtMs === undefined) return -1
    return Math.floor((entry.expiresAtMs - this.#now()) / 1_000)
  }

  async scan (cursor: number, options: {
    MATCH: string
    COUNT: number
  }): Promise<{ cursor: number; keys: string[] }> {
    this.#purgeAll()
    const prefix = options.MATCH.endsWith('*')
      ? options.MATCH.slice(0, -1)
      : options.MATCH
    const keys = [...this.#entries.keys()]
      .filter(key => options.MATCH.endsWith('*') ? key.startsWith(prefix) : key === prefix)
      .sort()
    const page = keys.slice(cursor, cursor + options.COUNT)
    return {
      cursor: cursor + options.COUNT >= keys.length ? 0 : cursor + options.COUNT,
      keys: page
    }
  }

  async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    this.#purgeAll()
    const marker = script.split('\n', 1)[0]
    const operation = options.arguments[0] ?? ''
    if (marker === TRACE_STORE_LUA_MARKER) {
      return this.#evalTrace(operation, options.keys, options.arguments)
    }
    if (marker !== RUN_STORE_LUA_MARKER) throw new TypeError('unsupported Lua protocol')
    return this.#evalRun(operation, options.keys, options.arguments)
  }

  resourceUsage (): readonly Phase6RedisResourceUsage[] {
    this.#purgeAll()
    const valueKind = (
      kind: Phase6RedisResourceKind,
      predicate: (key: string) => boolean,
      includeKey = false
    ): Phase6RedisResourceUsage => {
      const values = [...this.#entries.entries()].filter(([key]) => predicate(key))
      return Object.freeze({
        kind,
        records: values.length,
        bytes: values.reduce((total, [key, entry]) => (
          total + utf8Bytes(entry.value) + (includeKey ? utf8Bytes(key) : 0)
        ), 0)
      })
    }
    const indexKind = (
      kind: Phase6RedisResourceKind,
      key: string
    ): Phase6RedisResourceUsage => {
      const members = [...(this.#sortedSets.get(key)?.keys() ?? [])]
      return Object.freeze({
        kind,
        records: members.length,
        bytes: members.reduce((total, member) => total + utf8Bytes(member), 0)
      })
    }
    const runMetadataExists = this.#entries.has(RUN_STORE_METADATA_KEY)
    const traceMetadataKeys = [TRACE_BYTES_KEY, TRACE_GENERATION_KEY]
      .filter(key => this.#entries.has(key))
    return Object.freeze([
      valueKind('run_checkpoint', key => key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`)),
      valueKind('run_event', key => key.startsWith(`${RUN_STORE_NAMESPACE}events:`)),
      valueKind('run_tombstone', key => key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`)),
      valueKind('run_reference', key => key.startsWith(`${RUN_STORE_NAMESPACE}reference:`), true),
      valueKind('run_index', key => key.startsWith(RUN_STORE_NAMESPACE) &&
        key !== RUN_STORE_METADATA_KEY &&
        !key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`) &&
        !key.startsWith(`${RUN_STORE_NAMESPACE}events:`) &&
        !key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`) &&
        !key.startsWith(`${RUN_STORE_NAMESPACE}reference:`)),
      Object.freeze({
        kind: 'run_metadata',
        records: runMetadataExists ? 1 : 0,
        // The RunStore 8 MiB metadata value is an accounting source, not part
        // of the value-payload budget it records.
        bytes: 0
      }),
      valueKind('trace_record', key => key.startsWith(TRACE_KEY_PREFIX), true),
      indexKind('trace_success_index', TRACE_SUCCESS_INDEX_KEY),
      indexKind('trace_failure_index', TRACE_FAILURE_INDEX_KEY),
      Object.freeze({
        kind: 'trace_metadata',
        records: traceMetadataKeys.length,
        bytes: this.#traceMetadataPayloadBytes()
      })
    ])
  }

  #evalRun (operation: string, keys: readonly string[], args: readonly string[]): unknown {
    const [checkpointKey, eventKey, tombstoneKey, referenceKey] = keys
    if (operation === 'load') {
      return [
        checkpointKey === undefined ? false : this.#value(checkpointKey) ?? false,
        eventKey === undefined ? false : this.#value(eventKey) ?? false
      ]
    }
    if (operation === 'reconcile') {
      const metadataKey = keys[0]
      if (metadataKey !== RUN_STORE_METADATA_KEY ||
        (this.#value(metadataKey) ?? '') !== args[1] || args[2] === undefined) {
        return 'conflict'
      }
      this.#entries.set(metadataKey, { value: args[2] })
      return 'ok'
    }
    const metadataKey = keys.at(-1)
    if (operation === 'tombstone_delete_corrupt') {
      const key = keys[0]
      const current = this.#value(key)
      if (current === null) {
        if (metadataKey !== undefined) this.#entries.delete(metadataKey)
        return 'missing'
      }
      if (current !== args[1]) {
        if (metadataKey !== undefined) this.#entries.delete(metadataKey)
        return 'conflict'
      }
      if (key !== undefined) this.#entries.delete(key)
      if (metadataKey !== undefined) this.#entries.delete(metadataKey)
      return 'ok'
    }
    const usage = this.#parseRunUsage(this.#value(metadataKey))
    if (metadataKey !== RUN_STORE_METADATA_KEY || usage === null) return 'reconcile'

    if (operation === 'create') {
      if ([checkpointKey, eventKey, tombstoneKey].some(key => (
        key !== undefined && this.#entries.has(key)
      ))) return 'conflict'
      if (referenceKey !== undefined && this.#entries.has(referenceKey)) {
        return 'reference_conflict'
      }
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes + utf8Bytes(args[1]) + utf8Bytes(args[2]) +
          utf8Bytes(referenceKey) + utf8Bytes(args[4]),
        checkpoints: usage.checkpoints + 1,
        events: usage.events + 1,
        references: usage.references + 1
      }
      if (this.#runBudgetExceeded(projected)) return 'budget'
      this.#setDirect(checkpointKey, args[1], Number(args[3]))
      this.#setDirect(eventKey, args[2], Number(args[3]))
      this.#setDirect(referenceKey, args[4], Number(args[3]))
      this.#saveRunUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'upgrade' || operation === 'cas') {
      const expectedCheckpoint = args[1]
      const expectedEvents = args[2]
      const replacementCheckpoint = args[3]
      const replacementEvents = args[4]
      const ttlSeconds = Number(args[5])
      const referenceValue = args[6]
      if (this.#value(checkpointKey) !== expectedCheckpoint ||
        this.#value(eventKey) !== expectedEvents ||
        (operation === 'upgrade'
          ? tombstoneKey !== undefined && this.#entries.has(tombstoneKey)
          : this.#value(referenceKey) !== referenceValue)) return 'conflict'
      if (operation === 'upgrade' && referenceKey !== undefined && this.#entries.has(referenceKey)) {
        return 'reference_conflict'
      }
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes - utf8Bytes(expectedCheckpoint) - utf8Bytes(expectedEvents) +
          utf8Bytes(replacementCheckpoint) + utf8Bytes(replacementEvents) +
          (operation === 'upgrade' ? utf8Bytes(referenceKey) + utf8Bytes(referenceValue) : 0),
        references: usage.references + (operation === 'upgrade' ? 1 : 0)
      }
      if (this.#runBudgetExceeded(projected)) return 'budget'
      this.#setDirect(checkpointKey, replacementCheckpoint, ttlSeconds)
      this.#setDirect(eventKey, replacementEvents, ttlSeconds)
      this.#setDirect(referenceKey, referenceValue, ttlSeconds)
      this.#saveRunUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'commit_terminal') {
      const oldCheckpoint = this.#value(checkpointKey)
      const oldEvents = this.#value(eventKey)
      if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
        tombstoneKey === undefined || this.#entries.has(tombstoneKey) ||
        this.#value(referenceKey) !== args[5]) return 'conflict'
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes - utf8Bytes(oldCheckpoint) - utf8Bytes(oldEvents) + utf8Bytes(args[3]),
        checkpoints: usage.checkpoints - 1,
        events: usage.events - 1,
        tombstones: usage.tombstones + 1,
        tombstoneBytes: usage.tombstoneBytes + utf8Bytes(args[3])
      }
      if (this.#runBudgetExceeded(projected)) return 'budget'
      let deleted = 0
      if (checkpointKey !== undefined && this.#entries.delete(checkpointKey)) deleted += 1
      if (eventKey !== undefined && this.#entries.delete(eventKey)) deleted += 1
      this.#setDirect(tombstoneKey, args[3], Number(args[4]))
      this.#setDirect(referenceKey, args[5], Number(args[4]))
      this.#saveRunUsage(metadataKey, projected)
      return [
        'ok', deleted, 1, utf8Bytes(oldCheckpoint), utf8Bytes(oldEvents), utf8Bytes(args[3])
      ]
    }

    if (operation === 'admission_acquire' || operation === 'approval_index_create') {
      const key = keys[0]
      if (key === undefined || this.#entries.has(key)) return 'conflict'
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes + utf8Bytes(args[1]),
        indexes: usage.indexes + 1
      }
      if (this.#runBudgetExceeded(projected)) return 'budget'
      this.#setDirect(key, args[1], Number(args[2]))
      this.#saveRunUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'admission_recover') {
      const key = keys[0]
      const current = this.#value(key) ?? ''
      if (key === undefined || current !== args[1]) return 'conflict'
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes - utf8Bytes(current) + utf8Bytes(args[2]),
        indexes: usage.indexes + (current === '' ? 1 : 0)
      }
      if (this.#runBudgetExceeded(projected)) return 'budget'
      this.#setDirect(key, args[2], Number(args[3]))
      this.#saveRunUsage(metadataKey, projected)
      return 'ok'
    }

    if (operation === 'admission_release' || operation === 'approval_index_delete') {
      const key = keys[0]
      const current = this.#value(key)
      if (key === undefined || current !== args[1]) return 'conflict'
      const projected: RunUsage = {
        ...usage,
        bytes: usage.bytes - utf8Bytes(current),
        indexes: usage.indexes - 1
      }
      this.#entries.delete(key)
      this.#saveRunUsage(metadataKey, projected)
      return 'ok'
    }
    return 'invalid_operation'
  }

  #evalTrace (operation: string, keys: readonly string[], args: readonly string[]): unknown {
    const traceKey = keys[0]
    if (keys[1] !== TRACE_SUCCESS_INDEX_KEY || keys[2] !== TRACE_FAILURE_INDEX_KEY ||
      keys[3] !== TRACE_BYTES_KEY || keys[4] !== TRACE_GENERATION_KEY) {
      throw new TypeError('invalid trace protocol keys')
    }
    if (operation === 'upsert' || operation === 'append') {
      const generation = Number(this.#value(TRACE_GENERATION_KEY) ?? '0')
      if (Number(args[1]) !== generation) return ['stale_generation', String(generation)]
      this.#cleanupTrace(Number(args[2]))
      if (traceKey === undefined) throw new TypeError('trace key is invalid')
      if (operation === 'upsert') {
        const raw = args[3]
        const expiresAtMs = Number(args[4])
        if (raw === undefined) throw new TypeError('trace value is invalid')
        const existing = this.#value(traceKey)
        if (existing !== null) return [existing === raw ? 'unchanged' : 'conflict', String(generation)]
        const length = utf8Bytes(raw) + 2 * utf8Bytes(traceKey)
        if (!this.#ensureTraceCapacity(traceKey, 0, length, 1)) {
          return ['capacity', String(generation)]
        }
        this.#entries.set(traceKey, { value: raw, expiresAtMs })
        this.#traceLengths.set(traceKey, length)
        this.#zadd(args[5] === 'failure' ? TRACE_FAILURE_INDEX_KEY : TRACE_SUCCESS_INDEX_KEY,
          traceKey, expiresAtMs)
        this.#saveTraceBytes()
        return ['stored', String(generation)]
      }
      const expected = args[3]
      const replacement = args[4]
      if (expected === undefined || replacement === undefined) {
        throw new TypeError('trace append value is invalid')
      }
      const current = this.#value(traceKey)
      if (current === null) return ['not_found', String(generation)]
      if (current !== expected) return ['conflict', String(generation)]
      if (current === replacement) return ['unchanged', String(generation)]
      const oldLength = this.#traceLengths.get(traceKey) ??
        utf8Bytes(current) + 2 * utf8Bytes(traceKey)
      const newLength = utf8Bytes(replacement) + 2 * utf8Bytes(traceKey)
      const delta = newLength - oldLength
      if (delta > 0 && !this.#ensureTraceCapacity(
        traceKey,
        oldLength,
        newLength,
        0,
        traceKey
      )) {
        return ['capacity', String(generation)]
      }
      this.#entries.set(traceKey, { value: replacement, expiresAtMs: Number(args[5]) })
      this.#traceLengths.set(traceKey, newLength)
      if (args[6] === 'failure') {
        this.#zrem(TRACE_SUCCESS_INDEX_KEY, traceKey)
        this.#zadd(TRACE_FAILURE_INDEX_KEY, traceKey, Number(args[5]))
      }
      this.#saveTraceBytes()
      return ['stored', String(generation)]
    }
    if (operation === 'delete_corrupt') {
      if (traceKey !== undefined && this.#value(traceKey) === args[1]) this.#removeTrace(traceKey)
      this.#saveTraceBytes()
      return 'ok'
    }
    if (operation === 'missing_state') {
      if (traceKey === undefined) throw new TypeError('trace key is invalid')
      const score = this.#sortedSets.get(TRACE_SUCCESS_INDEX_KEY)?.get(traceKey) ??
        this.#sortedSets.get(TRACE_FAILURE_INDEX_KEY)?.get(traceKey)
      if (score !== undefined && score <= Number(args[1])) {
        this.#removeTrace(traceKey)
        this.#saveTraceBytes()
        return 'expired'
      }
      return 'not_retained'
    }
    if (operation === 'list') {
      this.#cleanupTrace(Number(args[1]))
      const limit = Number(args[2])
      return [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]
        .flatMap(index => this.#zrange(index, true).slice(0, limit))
        .flatMap(key => {
          const raw = this.#value(key)
          return raw === null ? [] : [key, raw]
        })
    }
    if (operation === 'usage') {
      this.#cleanupTrace(Number(args[1]))
      const usage = this.#traceUsage()
      return [usage.records, usage.bytes]
    }
    if (operation === 'clear') return this.#clearTrace(Number(args[1]))
    if (operation === 'advance_clear') {
      const generation = Number(this.#value(TRACE_GENERATION_KEY) ?? '0') + 1
      this.#entries.set(TRACE_GENERATION_KEY, { value: String(generation) })
      return [generation, ...this.#clearTrace(Number(args[1]))]
    }
    return 'invalid_operation'
  }

  #parseRunUsage (raw: string | null): RunUsage | null {
    if (raw === null || !/^\d+\|\d+\|\d+\|\d+\|\d+\|\d+\|\d+$/.test(raw)) return null
    const values = raw.split('|').map(Number)
    if (values.length !== 7 || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
      return null
    }
    return {
      bytes: values[0] as number,
      checkpoints: values[1] as number,
      events: values[2] as number,
      tombstones: values[3] as number,
      indexes: values[4] as number,
      references: values[5] as number,
      tombstoneBytes: values[6] as number
    }
  }

  #saveRunUsage (key: string | undefined, usage: RunUsage): void {
    if (key !== RUN_STORE_METADATA_KEY) throw new TypeError('run metadata key is invalid')
    this.#entries.set(key, { value: [
      usage.bytes,
      usage.checkpoints,
      usage.events,
      usage.tombstones,
      usage.indexes,
      usage.references,
      usage.tombstoneBytes
    ].join('|') })
  }

  #runBudgetExceeded (usage: RunUsage): boolean {
    if (Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) return true
    return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
      usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
      usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
      usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
      usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys ||
      usage.references > RUN_RESOURCE_LIMITS.referenceKeys
  }

  #value (key: string | undefined): string | null {
    return key === undefined ? null : this.#entries.get(key)?.value ?? null
  }

  #setDirect (key: string | undefined, value: string | undefined, ttlSeconds: number): void {
    if (key === undefined || value === undefined || !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds <= 0) throw new TypeError('invalid Lua SET arguments')
    this.#entries.set(key, { value, expiresAtMs: this.#now() + ttlSeconds * 1_000 })
  }

  #traceUsage (): { records: number; bytes: number } {
    const keys = new Set([
      ...this.#zrange(TRACE_SUCCESS_INDEX_KEY),
      ...this.#zrange(TRACE_FAILURE_INDEX_KEY)
    ])
    return {
      records: keys.size,
      bytes: this.#traceNamespaceBytes()
    }
  }

  #ensureTraceCapacity (
    key: string,
    oldLength: number,
    newLength: number,
    addedRecords: number,
    skip?: string
  ): boolean {
    let usage = this.#traceUsage()
    let guard = TRACE_STORE_LIMITS.maxRecords
    while ((usage.records + addedRecords > TRACE_STORE_LIMITS.maxRecords ||
      this.#projectedTraceBytes(key, oldLength, newLength) > TRACE_STORE_LIMITS.maxBytes) &&
      guard > 0) {
      let victim: string | undefined
      for (const index of [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]) {
        victim = this.#zrange(index).slice(0, 2).find(key => key !== skip)
        if (victim !== undefined) break
      }
      if (victim === undefined) return false
      this.#removeTrace(victim)
      usage = this.#traceUsage()
      guard -= 1
    }
    return usage.records + addedRecords <= TRACE_STORE_LIMITS.maxRecords &&
      this.#projectedTraceBytes(key, oldLength, newLength) <= TRACE_STORE_LIMITS.maxBytes
  }

  #projectedTraceBytes (key: string, oldLength: number, newLength: number): number {
    const dataBytes = Math.max(0, this.#traceDataBytes() - oldLength + newLength)
    let metadataBytes = this.#traceEntryMetadataBytes()
    if (oldLength > 0) metadataBytes -= utf8Bytes(key) + utf8Bytes(String(oldLength))
    if (newLength > 0) metadataBytes += utf8Bytes(key) + utf8Bytes(String(newLength))
    return dataBytes + Math.max(0, metadataBytes) + this.#traceCounterMetadataBytes(dataBytes) +
      this.#traceGenerationMetadataBytes()
  }

  #traceNamespaceBytes (): number {
    const dataBytes = this.#traceDataBytes()
    return dataBytes + this.#traceMetadataPayloadBytes()
  }

  #traceMetadataPayloadBytes (): number {
    const dataBytes = this.#traceDataBytes()
    return this.#traceEntryMetadataBytes() + this.#traceCounterMetadataBytes(dataBytes) +
      this.#traceGenerationMetadataBytes()
  }

  #traceDataBytes (): number {
    return [...this.#traceLengths.values()].reduce((total, value) => total + value, 0)
  }

  #traceEntryMetadataBytes (): number {
    return [...this.#traceLengths.entries()].reduce((total, [key, length]) => (
      total + utf8Bytes(key) + utf8Bytes(String(length))
    ), 0)
  }

  #traceCounterMetadataBytes (dataBytes: number): number {
    return dataBytes === 0 ? 0 : utf8Bytes('__total') + utf8Bytes(String(dataBytes))
  }

  #traceGenerationMetadataBytes (): number {
    return utf8Bytes(this.#entries.get(TRACE_GENERATION_KEY)?.value)
  }

  #cleanupTrace (nowMs: number): void {
    let remaining = TRACE_STORE_LIMITS.cleanupBatchRecords
    for (const index of [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]) {
      for (const key of this.#zrange(index)) {
        if (remaining <= 0) break
        const score = this.#sortedSets.get(index)?.get(key)
        if (score === undefined || score > nowMs) break
        this.#removeTrace(key)
        remaining -= 1
      }
    }
    this.#saveTraceBytes()
  }

  #clearTrace (limit: number): [number, number, number, number] {
    const before = this.#traceUsage()
    const keys = [
      ...this.#zrange(TRACE_SUCCESS_INDEX_KEY),
      ...this.#zrange(TRACE_FAILURE_INDEX_KEY)
    ].slice(0, limit)
    for (const key of keys) this.#removeTrace(key)
    const after = this.#traceUsage()
    this.#saveTraceBytes()
    return [keys.length, before.bytes - after.bytes, after.records, after.bytes]
  }

  #saveTraceBytes (): void {
    const bytes = this.#traceDataBytes()
    if (bytes === 0) this.#entries.delete(TRACE_BYTES_KEY)
    else this.#entries.set(TRACE_BYTES_KEY, { value: String(bytes) })
  }

  #removeTrace (key: string): void {
    this.#entries.delete(key)
    this.#traceLengths.delete(key)
    this.#zrem(TRACE_SUCCESS_INDEX_KEY, key)
    this.#zrem(TRACE_FAILURE_INDEX_KEY, key)
  }

  #zadd (index: string, member: string, score: number): void {
    const values = this.#sortedSets.get(index) ?? new Map<string, number>()
    values.set(member, score)
    this.#sortedSets.set(index, values)
  }

  #zrem (index: string, member: string): void {
    this.#sortedSets.get(index)?.delete(member)
  }

  #zrange (index: string, reverse = false): string[] {
    return [...(this.#sortedSets.get(index)?.entries() ?? [])]
      .sort((left, right) => {
        const score = left[1] - right[1]
        if (score !== 0) return reverse ? -score : score
        const lexical = left[0].localeCompare(right[0])
        return reverse ? -lexical : lexical
      })
      .map(([member]) => member)
  }

  #purge (key: string): void {
    const expiry = this.#entries.get(key)?.expiresAtMs
    if (expiry !== undefined && expiry <= this.#now()) this.#entries.delete(key)
  }

  #purgeAll (): void {
    for (const key of this.#entries.keys()) this.#purge(key)
  }
}

const CREATED_AT = '2026-07-17T00:00:00.000Z'
const CREATED_AT_MS = Date.parse(CREATED_AT)
const EMPTY_FINGERPRINT = createHash('sha256').update('[]').digest('hex')

function traceEvent (
  runId: string,
  sessionId: string,
  sequence: number,
  type: AgentEventType,
  occurredAt: string
) {
  return createRunEvent({
    eventId: `phase6-resource-event-${sequence}`,
    runId,
    sessionId,
    sequence,
    occurredAt,
    type,
    payload: Object.freeze({})
  })
}

export function createPhase6SmallTraceCandidate (
  seed: number,
  status: 'completed' | 'failed' = 'completed',
  finishedAtMs = CREATED_AT_MS
): TraceCandidateV1 {
  if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0) {
    throw new TypeError('trace fixture time is invalid')
  }
  const finishedAt = new Date(finishedAtMs).toISOString()
  const deadlineAt = new Date(finishedAtMs + 4 * 60 * 1_000).toISOString()
  const runRef = createHash('sha256').update(`phase6-resource-trace:${seed}`).digest('hex').slice(0, 32)
  const runId = `phase6-resource-run-${seed}`
  const sessionId = `phase6-resource-session-${seed}`
  const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 64 })
  const policy = createFrozenObservationPolicy({ levelAtStart: 'diagnostic', runRef })
  const initial = createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId,
    sessionId,
    sessionAddress: Object.freeze({
      botId: 'phase6-resource-bot',
      scope: Object.freeze({ kind: 'private' as const, userId: `phase6-resource-user-${seed}` })
    }),
    runRef,
    requestRef: createHash('sha256').update(`phase6-resource-request:${seed}`).digest('hex').slice(0, 32),
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat' as const,
      profile: 'ordinary' as const,
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary' as const,
        forcePicture: false
      }),
      sessionAddress: Object.freeze({
        botId: 'phase6-resource-bot',
        scope: Object.freeze({ kind: 'private' as const, userId: `phase6-resource-user-${seed}` })
      }),
      actorId: `phase6-resource-user-${seed}`
    }),
    observationPolicy: policy,
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 64,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'phase6-resource-snapshot', fingerprint: EMPTY_FINGERPRINT, manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt,
    createdAt: finishedAt,
    event: traceEvent(runId, sessionId, 0, 'run.created', finishedAt)
  })
  const preparing = nextRunCheckpoint(initial, 'preparing', {}, [], finishedAt)
  const calling = nextRunCheckpoint(preparing, 'calling_model', {}, [], finishedAt)
  let terminal: RunCheckpoint
  if (status === 'completed') {
    const output = Object.freeze({
      id: `phase6-resource-output-${seed}`,
      role: 'assistant' as const,
      parts: Object.freeze([{ type: 'text' as const, text: 'fixture' }]),
      createdAt: finishedAt,
      provenance: Object.freeze({
        source: 'model' as const,
        trust: 'untrusted' as const,
        sensitivity: 'group' as const,
        sourceId: runId,
        createdAt: finishedAt
      })
    })
    terminal = nextRunCheckpoint(calling, 'completed', {
      output,
      completion: Object.freeze({ kind: 'reply_text', text: 'fixture' })
    }, [traceEvent(
      runId,
      sessionId,
      calling.nextEventSequence,
      'run.completed',
      finishedAt
    )], finishedAt)
  } else {
    terminal = nextRunCheckpoint(calling, 'failed', {
      error: serializeAgentError(new AgentError({
        code: 'provider_unavailable',
        stage: 'model.response',
        retryable: false,
        userMessage: 'fixture'
      }))
    }, [traceEvent(
      runId,
      sessionId,
      calling.nextEventSequence,
      'run.failed',
      finishedAt
    )], finishedAt)
  }
  return createTraceCandidate({ checkpoint: terminal, snapshot: createRunTerminalSnapshot(terminal) })
}

const settings: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: true,
  enableRobotAt: false,
  enableMarkdown: false,
  enableSuggestedResponses: false,
  forwardReasoning: false,
  forwardToolDetails: false,
  blockWords: Object.freeze([]),
  promptBlockWords: Object.freeze([]),
  tts: Object.freeze({
    enabled: false,
    mode: 'vits-uma-genshin-honkai',
    activeVoice: 'fixture',
    alsoSendText: false,
    autoFallbackThreshold: 299,
    filter: null,
    azureEmotionEnabled: false
  }),
  picture: Object.freeze({
    userEnabled: false,
    autoEnabled: false,
    autoThreshold: 1_200,
    deviceScaleFactor: 1,
    closeBrowserAfterRender: true,
    showQRCode: false,
    live2d: null
  })
})

const pictureSettings: PresentationSettings = Object.freeze({
  ...settings,
  picture: Object.freeze({ ...settings.picture, userEnabled: true })
})

const disabledBymPolicy: BymPolicySnapshot = Object.freeze({
  enabled: false,
  assistantLabel: 'GroupMate',
  recognizeLeadingAlias: true,
  ratePercent: 0,
  disabledGroupIds: Object.freeze([]),
  thinkingMode: 'default',
  reasoningEffort: 'default',
  preset: '',
  retaliationWords: Object.freeze([]),
  retaliationBlacklistActorIds: Object.freeze([]),
  retaliationPrompt: '',
  retaliationRecallEnabled: false,
  retaliationRecallSeconds: 100
})

interface HostFixture {
  readonly bot: Readonly<Record<string, unknown>>
  readonly group: Readonly<Record<string, unknown>>
  readonly visibleMessages: unknown[]
}

function hostFixture (): HostFixture {
  const visibleMessages: unknown[] = []
  const members = new Map<unknown, Readonly<Record<string, unknown>>>([
    ['phase6-resource-bot', Object.freeze({
      user_id: 'phase6-resource-bot', role: 'owner', nickname: 'GroupMate'
    })],
    ['7', Object.freeze({ user_id: '7', role: 'owner', nickname: 'owner' })],
    ['8', Object.freeze({ user_id: '8', role: 'member', nickname: 'member' })]
  ])
  const group = Object.freeze({
    getMemberMap: async () => members,
    sendMsg: async (message: unknown) => {
      visibleMessages.push(message)
      return Object.freeze({ message_id: `visible-${visibleMessages.length}` })
    },
    recallMsg: async () => true,
    muteMember: async () => undefined,
    kickMember: async () => undefined,
    setCard: async () => undefined,
    setTitle: async () => undefined
  })
  const friend = Object.freeze({
    sendMsg: async (message: unknown) => {
      visibleMessages.push(message)
      return Object.freeze({ message_id: `visible-${visibleMessages.length}` })
    },
    recallMsg: async () => true
  })
  const bot = Object.freeze({
    uin: 'phase6-resource-bot',
    pickGroup: () => group,
    pickFriend: () => friend,
    getFriendList: async () => Object.freeze(['7'])
  })
  return { bot, group, visibleMessages }
}

function groupEvent (
  actorId: string,
  marker: string,
  host: HostFixture,
  input: {
    readonly groupId?: string
    readonly picture?: boolean
    readonly owner?: boolean
    readonly sourceMessageId?: string
    readonly messageId?: string
    readonly message?: readonly Readonly<Record<string, unknown>>[]
    readonly rawMessage?: string
  } = {}
): YunzaiMessageEvent {
  const prefix = input.picture === true ? '#图片chat1 ' : '#chat1 '
  const msg = input.rawMessage ?? `${prefix}${marker}`
  return {
    isGroup: true,
    group_id: input.groupId ?? `group-${actorId}`,
    self_id: 'phase6-resource-bot',
    user_id: actorId,
    message_id: input.messageId ?? `message-${actorId}-${marker}`,
    msg,
    message: input.message ?? Object.freeze([{ type: 'text', text: msg }]),
    sender: Object.freeze({
      user_id: actorId,
      role: input.owner === true ? 'owner' : 'member',
      nickname: actorId
    }),
    bot: host.bot as never,
    group: host.group,
    ...(input.owner === true ? { isMaster: true, atme: true } : {}),
    ...(input.sourceMessageId === undefined
      ? {}
      : { source: Object.freeze({ message_id: input.sourceMessageId }) })
  } as unknown as YunzaiMessageEvent
}

function textTurn (text = 'fixture response'): ModelTurn {
  return Object.freeze({ text, toolCalls: Object.freeze([]), finishReason: 'stop' })
}

function toolTurn (
  callId: string,
  name: string,
  args: Readonly<Record<string, string | number>>
): ModelTurn {
  return Object.freeze({
    text: '',
    toolCalls: Object.freeze([Object.freeze({
      index: 0,
      callId,
      name,
      argumentsText: JSON.stringify(args),
      arguments: Object.freeze({ ...args })
    })]),
    finishReason: 'tool_calls'
  })
}

class ScenarioModel implements ProductionModelPort {
  readonly #scenario: Phase6ResourceScenarioName
  readonly #dualWaiters: Array<() => void> = []
  #dualArrived = 0

  constructor (scenario: Phase6ResourceScenarioName) {
    this.#scenario = scenario
  }

  async complete (request: ModelRequest): Promise<ModelTurn> {
    if (this.#scenario === 'traceBasic') {
      throw new ModelProviderError({
        code: 'provider_unavailable',
        stage: 'fixture.provider',
        retryable: false,
        userMessage: 'fixture unavailable'
      })
    }
    if (this.#scenario === 'dualTextRun') {
      this.#dualArrived += 1
      if (this.#dualArrived < 2) {
        await new Promise<void>(resolve => { this.#dualWaiters.push(resolve) })
      } else {
        for (const resolve of this.#dualWaiters.splice(0)) resolve()
      }
    }
    if (this.#scenario === 'alreadyVisible') {
      return toolTurn('phase6-resource-dice', 'sendDice', { count: 1 })
    }
    return textTurn()
  }

  async generate (): Promise<readonly string[]> {
    return Object.freeze([])
  }
}

class ApprovalScenarioModel implements ProductionModelPort {
  async complete (request: ModelRequest): Promise<ModelTurn> {
    return request.messages.some(message => message.role === 'tool')
      ? textTurn('resumed fixture')
      : toolTurn('phase6-resource-approval', 'jinyan', { userId: '8', seconds: 60 })
  }

  async generate (): Promise<readonly string[]> {
    return Object.freeze([])
  }
}

interface GraphFixture {
  readonly graph: ProductionYunzaiAgent
  readonly dispatches: Array<Readonly<{
    target: SessionAddress
    part: OutboundPart
    messageId: string
  }>>
}

function graphFixture (input: {
  readonly scenario: Phase6ResourceScenarioName
  readonly redis: Phase6ResourceRedis
  readonly host: HostFixture
  readonly model: ProductionModelPort
  readonly observabilityLevel: 'basic' | 'diagnostic'
  readonly pictureCounters: { activePages: number; borrowedBrowserHandles: number }
}): GraphFixture {
  const dispatches: GraphFixture['dispatches'][number][] = []
  let monotonic = 0
  const botPicker = Object.freeze({ pick: async () => input.host.bot as never })
  const png: ToolResource = Object.freeze({
    kind: 'buffer',
    data: new Uint8Array([137, 80, 78, 71]),
    mimeType: 'image/png',
    byteLength: 4
  })
  const options: ProductionYunzaiAgentOptions = {
    bridge: {
      config: Object.freeze({
        openAiCompatibilityProfile: 'standard',
        model: 'fixture-model',
        toolPolicyProfile: input.scenario === 'checkpointResume' ? 'safe' : 'compatible',
        toolApprovalTtlSeconds: 120,
        observabilityLevel: input.observabilityLevel
      }),
      redis: input.redis,
      getMasterIds: async () => Object.freeze(['7']),
      getBotId: () => 'phase6-resource-bot',
      segment: () => Object.freeze({}),
      botPicker
    },
    botPicker,
    outboundHost: Object.freeze({
      async forTarget (target: SessionAddress) {
        return Object.freeze({
          async dispatch (part: OutboundPart) {
            const messageId = `delivery-${dispatches.length + 1}`
            dispatches.push(Object.freeze({ target, part, messageId }))
            return Object.freeze({ message_id: messageId })
          },
          async recall () { return true }
        })
      }
    }),
    presentationSettings: Object.freeze({
      load: async () => input.scenario === 'pictureSuccess' || input.scenario === 'pictureFailure'
        ? pictureSettings
        : settings
    }),
    pendingConfig: Object.freeze({
      getEnabled: async () => false,
      setEnabled: async () => undefined
    }),
    hooks: Object.freeze({
      forActiveEvent: () => Object.freeze({
        postprocess: async ({ text }: { readonly text: string }) => Object.freeze({ text }),
        convertText: async ({ text }: { readonly text: string }) => Object.freeze([
          { kind: 'text' as const, text }
        ]),
        notifyResponsePost: () => undefined
      })
    }),
    chatPolicy: Object.freeze({
      entryMode: () => 'prefix' as const,
      snapshot: async () => Object.freeze({
        toggleMode: 'prefix' as const,
        enablePrivateChat: true,
        whitelist: Object.freeze([]),
        blacklist: Object.freeze([]),
        imgOcr: false,
        groupMerge: false,
        enableGroupContext: false,
        thinkingMode: 'default' as const,
        reasoningEffort: 'default' as const,
        assistantLabel: 'GroupMate',
        promptPrefixOverride: '',
        actorCastApi: ''
      }),
      isMuted: async () => false,
      ocrText: async () => Object.freeze([]),
      appendAzureEmotionFeedback: async ({ prompt }: { readonly prompt: string }) => prompt,
      clearAzureEmotionFeedback: async () => undefined
    }),
    chatPreferences: Object.freeze({
      load: async () => Object.freeze({
        usePicture: false, useTTS: false, ttsRole: 'fixture',
        ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
      }),
      patch: async () => Object.freeze({
        usePicture: false, useTTS: false, ttsRole: 'fixture',
        ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
      })
    }),
    ttsAdministration: Object.freeze({
      getMode: () => 'vits-uma-genshin-honkai' as const,
      setMode: () => undefined,
      isConfigured: () => false,
      selectVoice: () => Object.freeze({ kind: 'unsupported' as const, message: 'unsupported' }),
      missingConfigurationMessage: () => 'missing'
    }),
    billing: Object.freeze({
      queryLastHundredDays: async () => Object.freeze({
        hardLimitUsd: 0, totalUsageUsd: 0, expiresAt: new Date(0)
      })
    }),
    bymPolicy: Object.freeze({ snapshot: () => disabledBymPolicy }),
    buttonPolicy: Object.freeze({
      snapshot: () => Object.freeze({ markdownEnabled: false, openAiConfigured: false })
    }),
    pictureRenderer: Object.freeze({
      render: async () => {
        input.pictureCounters.activePages += 1
        input.pictureCounters.borrowedBrowserHandles += 1
        try {
          return input.scenario === 'pictureFailure'
            ? Object.freeze({ kind: 'not_rendered' as const, code: 'render_failed' as const })
            : Object.freeze({ kind: 'rendered' as const, resource: png, source: 'local' as const })
        } finally {
          input.pictureCounters.activePages -= 1
          input.pictureCounters.borrowedBrowserHandles -= 1
        }
      }
    }),
    tts: Object.freeze({
      synthesize: async () => Object.freeze({
        kind: 'failed_definite' as const,
        code: 'synthesis_rejected' as const
      })
    }),
    modelFactory: () => input.model,
    random: () => 0.5,
    now: () => new Date(CREATED_AT),
    monotonicNow: () => { monotonic += 1; return monotonic }
  }
  return Object.freeze({ graph: createProductionYunzaiAgent(options), dispatches })
}

function exactRecord (value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function observationCount (value: unknown, label: string): ObservationCount {
  if (value === 'unavailable' || value === 'not_attempted') return value
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`)
  return Number(value)
}

function positiveInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} is invalid`)
  return Number(value)
}

function nonNegativeInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`)
  return Number(value)
}

export function validatePhase6ResourceSample (
  value: unknown,
  expectedScenario: Phase6ResourceScenarioName
): Phase6ResourceSample {
  const sample = exactRecord(value, [
    'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes',
    'wallTimeMs', 'userCpuMicros', 'systemCpuMicros', 'redisResources',
    'outcome', 'activePages', 'borrowedBrowserHandles', 'newChromiumProcesses'
  ], 'Phase 6 resource sample')
  if (sample.scenario !== expectedScenario ||
    sample.outcome !== PHASE_6_RESOURCE_OUTCOMES[expectedScenario]) {
    throw new TypeError('Phase 6 resource sample outcome is invalid')
  }
  const baseline = positiveInteger(sample.baselineRssBytes, 'baseline RSS')
  const retained = positiveInteger(sample.retainedRssBytes, 'retained RSS')
  const peak = positiveInteger(sample.peakRssBytes, 'peak RSS')
  if (peak < baseline || peak < retained) throw new TypeError('Phase 6 peak RSS is invalid')
  if (!Array.isArray(sample.redisResources) ||
    sample.redisResources.length !== PHASE_6_REDIS_RESOURCE_KINDS.length) {
    throw new TypeError('Phase 6 Redis resources are incomplete')
  }
  const resources = sample.redisResources.map((value, index) => {
    const item = exactRecord(value, ['kind', 'records', 'bytes'], 'Phase 6 Redis resource')
    if (item.kind !== PHASE_6_REDIS_RESOURCE_KINDS[index]) {
      throw new TypeError('Phase 6 Redis resource order is invalid')
    }
    observationCount(item.records, 'Redis records')
    observationCount(item.bytes, 'Redis bytes')
    return value
  })
  Object.freeze(resources)
  nonNegativeInteger(sample.wallTimeMs, 'wall time')
  nonNegativeInteger(sample.userCpuMicros, 'user CPU')
  nonNegativeInteger(sample.systemCpuMicros, 'system CPU')
  nonNegativeInteger(sample.activePages, 'active pages')
  nonNegativeInteger(sample.borrowedBrowserHandles, 'borrowed browser handles')
  nonNegativeInteger(sample.newChromiumProcesses, 'Chromium processes')
  return Object.freeze(value as Phase6ResourceSample)
}

export function normalizeMaxRssBytes (rawMaxRss: number, currentRssBytes: number): number {
  if (!Number.isSafeInteger(rawMaxRss) || rawMaxRss <= 0 ||
    !Number.isSafeInteger(currentRssBytes) || currentRssBytes <= 0) {
    throw new TypeError('maxRSS observation is invalid')
  }
  const normalized = rawMaxRss >= currentRssBytes ? rawMaxRss : rawMaxRss * 1_024
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('maxRSS normalization overflowed')
  }
  return normalized
}

function settleMs (value: number | undefined): number {
  const current = value ?? 25
  if (!Number.isSafeInteger(current) || current < 0 || current > 1_000) {
    throw new TypeError('resource scenario settle time is invalid')
  }
  return current
}

export async function runPhase6ResourceScenario (
  scenario: Phase6ResourceScenarioName,
  options: Phase6ResourceScenarioOptions = {}
): Promise<Phase6ResourceSample> {
  if (!PHASE_6_RESOURCE_SCENARIOS.includes(scenario)) {
    throw new TypeError(`unknown Phase 6 resource scenario: ${String(scenario)}`)
  }
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage())
  const collect = options.gc ?? (globalThis as typeof globalThis & { gc?: () => void }).gc
  const redis = new Phase6ResourceRedis(() => CREATED_AT_MS)
  const host = hostFixture()
  const pictureCounters = { activePages: 0, borrowedBrowserHandles: 0 }
  const model = scenario === 'checkpointResume'
    ? new ApprovalScenarioModel()
    : new ScenarioModel(scenario)
  const primary = graphFixture({
    scenario,
    redis,
    host,
    model,
    observabilityLevel: scenario === 'traceDiagnostic' ? 'diagnostic' : 'basic',
    pictureCounters
  })
  const graphs: ProductionYunzaiAgent[] = [primary.graph]
  collect?.()
  let baselineRssBytes = memoryUsage().rss
  const observations = [baselineRssBytes]
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()

  const runChat = async (
    actorId: string,
    marker: string,
    picture = false,
    graph = primary.graph
  ): Promise<void> => {
    const handled = await graph.chatController.chatgpt1(groupEvent(
      actorId,
      marker,
      host,
      { picture }
    ))
    if (!handled) throw new Error('resource chat scenario was not handled')
    observations.push(memoryUsage().rss)
  }

  try {
    if (scenario === 'singleTextRun') await runChat('single', 'single text')
    if (scenario === 'dualTextRun') {
      await Promise.all([
        runChat('dual-a', 'dual text a'),
        runChat('dual-b', 'dual text b')
      ])
    }
    if (scenario === 'alreadyVisible') {
      await runChat('visible', '骰子请求，请投掷 1 个骰子')
      const visibleDeliveries = primary.dispatches.filter(item => item.part.media === 'dice')
      if (visibleDeliveries.length !== 1 || host.visibleMessages.length !== 0) {
        throw new Error('visible tool output did not use the production outbound factory exactly once')
      }
    }
    if (scenario === 'checkpointResume') {
      const approvalEvent = groupEvent('7', '请禁言 QQ:8 60 秒', host, {
        groupId: 'resume-group',
        owner: true,
        messageId: 'resume-original',
        rawMessage: '#chat1 请禁言 QQ:8 60 秒',
        message: Object.freeze([
          Object.freeze({ type: 'text', text: '#chat1 请禁言 ' }),
          Object.freeze({ type: 'at', qq: '8', text: '@member' }),
          Object.freeze({ type: 'text', text: ' 60' })
        ])
      })
      if (!await primary.graph.chatController.chatgpt1(approvalEvent)) {
        throw new Error('approval pause was not handled')
      }
      const approvalDelivery = primary.dispatches.at(-1)
      if (approvalDelivery === undefined) throw new Error('approval delivery is missing')
      const recovery = graphFixture({
        scenario,
        redis,
        host,
        model: new ApprovalScenarioModel(),
        observabilityLevel: 'basic',
        pictureCounters
      })
      graphs.push(recovery.graph)
      const confirmation = groupEvent('7', 'confirmation', host, {
        groupId: 'resume-group',
        owner: true,
        rawMessage: '确认',
        messageId: 'resume-confirmation',
        sourceMessageId: approvalDelivery.messageId,
        message: Object.freeze([Object.freeze({ type: 'text', text: '确认' })])
      })
      if (!await recovery.graph.approvalController.confirmToolOperation(confirmation)) {
        throw new Error('checkpoint resume was not handled')
      }
      observations.push(memoryUsage().rss)
    }
    if (scenario === 'traceBasic') {
      await runChat('trace-basic', 'trace basic failure')
      await primary.graph.observability.hub.drain()
      if ((await primary.graph.observability.traceStore.usage()).records < 1) {
        throw new Error('basic trace was not retained')
      }
    }
    if (scenario === 'traceDiagnostic') {
      for (let index = 0; index < 64; index += 1) {
        await runChat(`trace-${index}`, `trace diagnostic ${index}`)
      }
      await primary.graph.observability.hub.drain()
      const recent = await primary.graph.observability.traceStore.listRecent(1)
      if ((await primary.graph.observability.traceStore.usage()).records !== 64 ||
        recent[0] === undefined) throw new Error('diagnostic trace capacity was not filled')
      collect?.()
      baselineRssBytes = memoryUsage().rss
      observations.splice(0, observations.length, baselineRssBytes)
      const replies: string[] = []
      await primary.graph.diagnosticsController.handleStatus(Object.freeze({
        authorized: true,
        commandArgument: '',
        replyText: async (text: string) => { replies.push(text) }
      }))
      observations.push(memoryUsage().rss)
      await primary.graph.diagnosticsController.handleInspect(Object.freeze({
        authorized: true,
        commandArgument: recent[0].runRef,
        replyText: async (text: string) => { replies.push(text) }
      }))
      observations.push(memoryUsage().rss)
      if (replies.length !== 2) throw new Error('diagnostic queries did not reply')
    }
    if (scenario === 'pictureSuccess' || scenario === 'pictureFailure') {
      for (let index = 0; index < 3; index += 1) {
        await runChat(`picture-${index}`, `picture ${index}`, true)
      }
    }

    await primary.graph.observability.hub.drain()
    collect?.()
    const wait = settleMs(options.settleMs)
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const retainedRssBytes = memoryUsage().rss
    observations.push(retainedRssBytes)
    const cpu = process.cpuUsage(cpuStart)
    const wallTimeMs = Math.max(0, Math.trunc(performance.now() - wallStart))
    const rawMaxRss = resourceUsage().maxRSS
    const peakRssBytes = Math.max(
      ...observations,
      normalizeMaxRssBytes(rawMaxRss, retainedRssBytes)
    )
    const sample: Phase6ResourceSample = Object.freeze({
      scenario,
      baselineRssBytes,
      retainedRssBytes,
      peakRssBytes,
      wallTimeMs,
      userCpuMicros: nonNegativeInteger(cpu.user, 'user CPU'),
      systemCpuMicros: nonNegativeInteger(cpu.system, 'system CPU'),
      redisResources: redis.resourceUsage(),
      outcome: PHASE_6_RESOURCE_OUTCOMES[scenario],
      activePages: pictureCounters.activePages,
      borrowedBrowserHandles: pictureCounters.borrowedBrowserHandles,
      newChromiumProcesses: 0
    })
    return validatePhase6ResourceSample(sample, scenario)
  } finally {
    for (const graph of graphs.reverse()) await graph.shutdown('phase6_resource_scenario')
  }
}

export async function main (): Promise<void> {
  const scenario = process.argv[2] as Phase6ResourceScenarioName | undefined
  const sample = await runPhase6ResourceScenario(scenario as Phase6ResourceScenarioName)
  process.stdout.write(JSON.stringify(sample))
}
