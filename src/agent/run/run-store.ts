import {
  AgentError,
  isAgentErrorCode,
  type AgentErrorCode
} from '../contracts/error.js'
import type { AgentEvent } from '../contracts/event.js'
import { parseJsonValue } from '../model/json-value.js'
import {
  appendRunCheckpointEvents,
  type LoadedRunCheckpoint,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpointV3,
  type RunCheckpointV4,
  type RunCheckpointV5,
  type RunCheckpointV6,
  type RunCheckpoint
} from './run-checkpoint.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import {
  createRunTerminalSnapshot,
  parseRunTerminalSnapshot,
  terminalObservationId,
  type CompletionObservation,
  type ObservationCount,
  type RunObservationCountersV1,
  type RunTerminalSnapshotV2
} from './run-observation.js'
import { RUN_REF_PATTERN } from './run-reference.js'
import { isTerminalRunStatus, type TerminalRunStatus } from './run-state.js'

export interface TerminalCommitReceiptV1 {
  readonly schemaVersion: 1
  readonly observationId: string
  readonly runRef: string
  readonly revision: number
  readonly deletedKeyCount: number
  readonly createdKeyCount: number
  readonly checkpointBytesDeleted: ObservationCount
  readonly eventBytesDeleted: ObservationCount
  readonly tombstoneBytes: number
}

export interface RunTombstoneV1 {
  readonly schemaVersion: 1
  readonly runId: string
  readonly sessionId: string
  readonly revision: number
  readonly status: TerminalRunStatus
  readonly finishedAt: string
  readonly visibleOutput: boolean
  readonly errorCode: AgentErrorCode | null
  readonly cancellationReason: string | null
  readonly providerRetries: number
  readonly recoveryAttempts: number
  readonly correctionTurns: number
}

export interface RunTombstoneV2 {
  readonly schemaVersion: 2
  readonly observationId: string
  readonly runRef: string
  readonly revision: number
  readonly status: TerminalRunStatus
  readonly finishedAt: string
  readonly completion: CompletionObservation
  readonly errorCode: AgentErrorCode | null
  readonly cancellationReason: string | null
  readonly counters: RunObservationCountersV1
  readonly engineDurationMs: ObservationCount
}

export type LoadedRunTombstone = RunTombstoneV1 | RunTombstoneV2

export interface NormalizedRunTombstoneV1 {
  readonly schemaVersion: 1
  readonly sourceSchemaVersion: 1 | 2
  readonly observationId: string | 'unavailable'
  readonly runRef: string | 'unavailable'
  readonly revision: number
  readonly status: TerminalRunStatus
  readonly finishedAt: string
  readonly completion: CompletionObservation | 'unavailable'
  readonly errorCode: AgentErrorCode | null
  readonly cancellationReason: string | null
  readonly counters: RunObservationCountersV1
  readonly engineDurationMs: ObservationCount
}

export interface RunStoreObservationUsageV1 {
  readonly schemaVersion: 1
  readonly tombstoneRecords: ObservationCount
  readonly tombstoneBytes: ObservationCount
}

export interface RunStore {
  create(checkpoint: RunCheckpoint): Promise<RunCheckpoint>
  load(runId: string): Promise<LoadedRunCheckpoint | null>
  upgrade(
    expected: RunCheckpointV1 | RunCheckpointV2 | RunCheckpointV3 | RunCheckpointV4 | RunCheckpointV5,
    next: RunCheckpointV6
  ): Promise<RunCheckpointV6>
  compareAndSet(
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint>
  commitTerminal(
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: RunTerminalSnapshotV2
  ): Promise<TerminalCommitReceiptV1>
  appendEvents(
    expected: RunCheckpoint,
    events: readonly AgentEvent[]
  ): Promise<RunCheckpoint>
  loadTombstone(runId: string): Promise<NormalizedRunTombstoneV1 | null>
  observationUsage(): Promise<RunStoreObservationUsageV1>
}

export class RunStoreConflictError extends AgentError {
  readonly code: 'checkpoint_conflict'

  constructor () {
    super({
      code: 'checkpoint_conflict',
      stage: 'run.checkpoint',
      retryable: false,
      userMessage: '任务状态已发生变化，请重新发起。'
    })
    this.name = 'RunStoreConflictError'
    this.code = 'checkpoint_conflict'
  }
}

export class RunReferenceConflictError extends RunStoreConflictError {
  constructor () {
    super()
    this.name = 'RunReferenceConflictError'
  }
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOMBSTONE_V1_KEYS = Object.freeze([
  'schemaVersion', 'runId', 'sessionId', 'revision', 'status', 'finishedAt',
  'visibleOutput', 'errorCode', 'cancellationReason', 'providerRetries',
  'recoveryAttempts', 'correctionTurns'
])
const TOMBSTONE_V2_KEYS = Object.freeze([
  'schemaVersion', 'observationId', 'runRef', 'revision', 'status',
  'finishedAt', 'completion', 'errorCode', 'cancellationReason', 'counters',
  'engineDurationMs'
])
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'observationId', 'runRef', 'revision', 'deletedKeyCount',
  'createdKeyCount', 'checkpointBytesDeleted', 'eventBytesDeleted',
  'tombstoneBytes'
])

function record (value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run tombstone is invalid')
  }
  return value as Record<string, unknown>
}

function nonNegative (value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function exactKeys (
  input: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const unknown = Object.keys(input).find(key => !keys.includes(key))
  const missing = keys.find(key => !Object.hasOwn(input, key))
  if (unknown !== undefined) throw new TypeError(`${label} contains unknown key: ${unknown}`)
  if (missing !== undefined) throw new TypeError(`${label} key is missing: ${missing}`)
}

function parseRunTombstoneV1 (input: Record<string, unknown>): RunTombstoneV1 {
  exactKeys(input, TOMBSTONE_V1_KEYS, 'run tombstone')
  if (input.schemaVersion !== 1 ||
    typeof input.runId !== 'string' || !CODE.test(input.runId) ||
    typeof input.sessionId !== 'string' || !CODE.test(input.sessionId) ||
    !nonNegative(input.revision) || typeof input.status !== 'string' ||
    !isTerminalRunStatus(input.status as TerminalRunStatus) ||
    typeof input.finishedAt !== 'string' ||
    typeof input.visibleOutput !== 'boolean' ||
    (input.errorCode !== null && !isAgentErrorCode(input.errorCode)) ||
    (input.cancellationReason !== null &&
      (typeof input.cancellationReason !== 'string' || !CODE.test(input.cancellationReason))) ||
    !nonNegative(input.providerRetries) || !nonNegative(input.recoveryAttempts) ||
    !nonNegative(input.correctionTurns)) {
    throw new TypeError('run tombstone is invalid')
  }
  try {
    if (new Date(input.finishedAt).toISOString() !== input.finishedAt) {
      throw new TypeError('run tombstone timestamp is invalid')
    }
  } catch {
    throw new TypeError('run tombstone timestamp is invalid')
  }
  return Object.freeze(input as unknown as RunTombstoneV1)
}

export function parseRunTombstone (value: unknown): LoadedRunTombstone {
  const input = record(parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.tombstoneBytes,
    maxDepth: 6,
    maxNodes: 96
  }))
  if (input.schemaVersion === 1) return parseRunTombstoneV1(input)
  if (input.schemaVersion !== 2) throw new TypeError('run tombstone schema version is invalid')
  exactKeys(input, TOMBSTONE_V2_KEYS, 'run tombstone')
  return parseRunTerminalSnapshot(input) as RunTombstoneV2
}

export function createRunTombstoneV2 (
  snapshot: RunTerminalSnapshotV2
): RunTombstoneV2 {
  return parseRunTombstone(snapshot) as RunTombstoneV2
}

function unavailableCounters (legacy: RunTombstoneV1): RunObservationCountersV1 {
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: 'unavailable',
    modelTurns: 'unavailable',
    toolAttempts: 'unavailable',
    providerRetries: legacy.providerRetries,
    recoveryAttempts: legacy.recoveryAttempts,
    correctionTurns: legacy.correctionTurns,
    toolCalls: 'unavailable',
    approvalRequests: 'unavailable',
    toolDenied: 'unavailable',
    toolExpired: 'unavailable',
    toolIndeterminate: 'unavailable',
    estimatedTokens: 'unavailable',
    providerInputTokens: 'unavailable',
    providerOutputTokens: 'unavailable',
    providerTotalTokens: 'unavailable',
    providerActiveDurationMs: 'unavailable',
    engineActiveDurationMs: 'unavailable'
  })
}

export function normalizeRunTombstone (
  value: LoadedRunTombstone
): NormalizedRunTombstoneV1 {
  const parsed = parseRunTombstone(value)
  if (parsed.schemaVersion === 1) {
    return Object.freeze({
      schemaVersion: 1,
      sourceSchemaVersion: 1,
      observationId: 'unavailable',
      runRef: 'unavailable',
      revision: parsed.revision,
      status: parsed.status,
      finishedAt: parsed.finishedAt,
      completion: 'unavailable',
      errorCode: parsed.errorCode,
      cancellationReason: parsed.cancellationReason,
      counters: unavailableCounters(parsed),
      engineDurationMs: 'unavailable'
    })
  }
  if (parsed.engineDurationMs !== parsed.counters.engineActiveDurationMs) {
    throw new TypeError('run tombstone engine duration is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceSchemaVersion: 2,
    observationId: parsed.observationId,
    runRef: parsed.runRef,
    revision: parsed.revision,
    status: parsed.status,
    finishedAt: parsed.finishedAt,
    completion: parsed.completion,
    errorCode: parsed.errorCode,
    cancellationReason: parsed.cancellationReason,
    counters: parsed.counters,
    engineDurationMs: parsed.engineDurationMs
  })
}

export function parseTerminalCommitReceipt (
  value: unknown
): TerminalCommitReceiptV1 {
  const input = record(parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.tombstoneBytes,
    maxDepth: 2,
    maxNodes: 16
  }))
  exactKeys(input, RECEIPT_KEYS, 'terminal commit receipt')
  if (input.schemaVersion !== 1 ||
    typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef) ||
    !nonNegative(input.revision) ||
    input.observationId !== terminalObservationId(input.runRef, Number(input.revision)) ||
    input.deletedKeyCount !== 2 || input.createdKeyCount !== 1 ||
    !nonNegative(input.checkpointBytesDeleted) ||
    !nonNegative(input.eventBytesDeleted) ||
    !nonNegative(input.tombstoneBytes) || Number(input.tombstoneBytes) < 1 ||
    Number(input.tombstoneBytes) > RUN_RESOURCE_LIMITS.tombstoneBytes) {
    throw new TypeError('terminal commit receipt is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    observationId: input.observationId as string,
    runRef: input.runRef,
    revision: Number(input.revision),
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: Number(input.checkpointBytesDeleted),
    eventBytesDeleted: Number(input.eventBytesDeleted),
    tombstoneBytes: Number(input.tombstoneBytes)
  })
}

export function validateTerminalCommitInput (
  expected: RunCheckpoint,
  next: RunCheckpoint,
  snapshot: RunTerminalSnapshotV2
): Readonly<{
    snapshot: RunTerminalSnapshotV2
    tombstone: RunTombstoneV2
}> {
  if (next.runId !== expected.runId || next.sessionId !== expected.sessionId ||
    next.revision !== expected.revision + 1 || next.runRef !== expected.runRef ||
    next.requestRef !== expected.requestRef || isTerminalRunStatus(expected.status) ||
    !isTerminalRunStatus(next.status)) {
    throw new RunStoreConflictError()
  }
  const canonical = createRunTerminalSnapshot(next)
  const supplied = parseRunTerminalSnapshot(snapshot)
  if (JSON.stringify(canonical) !== JSON.stringify(supplied)) {
    throw new TypeError('terminal snapshot does not match its checkpoint')
  }
  return Object.freeze({
    snapshot: canonical,
    tombstone: createRunTombstoneV2(canonical)
  })
}

export function checkpointWithAppendedEvents (
  expected: RunCheckpoint,
  events: readonly AgentEvent[]
): RunCheckpoint {
  return appendRunCheckpointEvents(expected, events)
}
