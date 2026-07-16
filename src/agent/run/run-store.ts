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
  type RunCheckpoint
} from './run-checkpoint.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import { isTerminalRunStatus, type TerminalRunStatus } from './run-state.js'

export interface RunTombstone {
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

export interface RunStore {
  create(checkpoint: RunCheckpoint): Promise<RunCheckpoint>
  load(runId: string): Promise<LoadedRunCheckpoint | null>
  upgrade(
    expected: RunCheckpointV1,
    next: RunCheckpointV2
  ): Promise<RunCheckpointV2>
  compareAndSet(
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint>
  appendEvents(
    expected: RunCheckpoint,
    events: readonly AgentEvent[]
  ): Promise<RunCheckpoint>
  finish(
    expected: RunCheckpoint,
    summary: RunTombstone
  ): Promise<RunTombstone>
  loadTombstone(runId: string): Promise<RunTombstone | null>
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
const TOMBSTONE_KEYS = Object.freeze([
  'schemaVersion', 'runId', 'sessionId', 'revision', 'status', 'finishedAt',
  'visibleOutput', 'errorCode', 'cancellationReason', 'providerRetries',
  'recoveryAttempts', 'correctionTurns'
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

export function parseRunTombstone (value: unknown): RunTombstone {
  const input = record(parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.tombstoneBytes,
    maxDepth: 4,
    maxNodes: 32
  }))
  const unknown = Object.keys(input).find(key => !TOMBSTONE_KEYS.includes(key))
  const missing = TOMBSTONE_KEYS.find(key => !Object.hasOwn(input, key))
  if (unknown !== undefined || missing !== undefined || input.schemaVersion !== 1 ||
    typeof input.runId !== 'string' || !CODE.test(input.runId) ||
    typeof input.sessionId !== 'string' || !CODE.test(input.sessionId) ||
    !nonNegative(input.revision) || typeof input.status !== 'string' ||
    !isTerminalRunStatus(input.status as TerminalRunStatus) ||
    typeof input.finishedAt !== 'string' ||
    new Date(input.finishedAt).toISOString() !== input.finishedAt ||
    typeof input.visibleOutput !== 'boolean' ||
    (input.errorCode !== null && !isAgentErrorCode(input.errorCode)) ||
    (input.cancellationReason !== null &&
      (typeof input.cancellationReason !== 'string' || !CODE.test(input.cancellationReason))) ||
    !nonNegative(input.providerRetries) || !nonNegative(input.recoveryAttempts) ||
    !nonNegative(input.correctionTurns)) {
    throw new TypeError('run tombstone is invalid')
  }
  const raw = JSON.stringify(input)
  if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
    throw new TypeError('run tombstone byte limit exceeded')
  }
  return Object.freeze(JSON.parse(raw) as RunTombstone)
}

export function createRunTombstone (checkpoint: RunCheckpoint): RunTombstone {
  if (!isTerminalRunStatus(checkpoint.status)) {
    throw new TypeError('terminal checkpoint is required')
  }
  return parseRunTombstone({
    schemaVersion: 1,
    runId: checkpoint.runId,
    sessionId: checkpoint.sessionId,
    revision: checkpoint.revision,
    status: checkpoint.status,
    finishedAt: checkpoint.updatedAt,
    visibleOutput: checkpoint.completion?.kind === 'already_visible',
    errorCode: checkpoint.error?.code ?? null,
    cancellationReason: checkpoint.cancellationReason,
    providerRetries: checkpoint.budgetCounters.providerRetries,
    recoveryAttempts: checkpoint.budgetCounters.recoveryAttempts,
    correctionTurns: checkpoint.budgetCounters.correctionTurns
  })
}

export function checkpointWithAppendedEvents (
  expected: RunCheckpoint,
  events: readonly AgentEvent[]
): RunCheckpoint {
  return appendRunCheckpointEvents(expected, events)
}
