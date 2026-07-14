import type { AgentEvent } from '../contracts/event.js'
import { parseAgentEvent } from '../contracts/event.js'
import type { AgentMessage } from '../contracts/content.js'
import type { SerializedAgentError } from '../contracts/error.js'
import type { ModelMessage, ModelReasoningOptions } from '../model/model-adapter.js'
import { parseJsonValue } from '../model/json-value.js'
import type { ApprovalInterruption } from './interruption.js'
import type { RunBudgetCounters, RunBudgetLimits } from './run-budget.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import { assertRunTransition, type RunStatus } from './run-state.js'
import type { PreparedToolBatch } from './tool-scheduler.js'
import type { ToolExecutionLedger } from './tool-ledger.js'
import type { ToolSnapshotManifestEntry } from '../tools/tool-registry.js'

export interface RunModelConfig {
  readonly model: string
  readonly streaming: boolean
  readonly maxOutputTokens: number
  readonly reasoning: ModelReasoningOptions
  readonly temperature?: number
  readonly topP?: number
}

export interface RunToolSnapshotReference {
  readonly id: string
  readonly fingerprint: string
  readonly manifest: readonly ToolSnapshotManifestEntry[]
}

export interface ReservedModelTurn {
  readonly kind: 'normal' | 'correction'
  readonly maxOutputTokens: number
}

export interface RunCheckpoint {
  readonly schemaVersion: 1
  readonly kernelVersion: 1
  readonly profileId: string
  readonly profileVersion: number
  readonly runId: string
  readonly sessionId: string
  readonly revision: number
  readonly status: RunStatus
  readonly step: number
  readonly model: RunModelConfig
  readonly messages: readonly ModelMessage[]
  readonly estimatedInputTokens: number
  readonly modelTurn: ReservedModelTurn | null
  readonly toolSnapshot: RunToolSnapshotReference
  readonly toolLedgers: readonly ToolExecutionLedger[]
  readonly preparedBatch: PreparedToolBatch | null
  readonly interruption: ApprovalInterruption | null
  readonly budgetLimits: RunBudgetLimits
  readonly budgetCounters: RunBudgetCounters
  readonly recoveryUsed: boolean
  readonly forceCorrection: boolean
  readonly output: AgentMessage | null
  readonly visibleOutput: boolean
  readonly error: SerializedAgentError | null
  readonly cancellationReason: string | null
  readonly events: readonly AgentEvent[]
  readonly nextEventSequence: number
  readonly deadlineAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateRunCheckpointInput {
  readonly profileId: string
  readonly profileVersion: number
  readonly runId: string
  readonly sessionId: string
  readonly model: RunModelConfig
  readonly toolSnapshot: RunToolSnapshotReference
  readonly budgetLimits: RunBudgetLimits
  readonly budgetCounters: RunBudgetCounters
  readonly deadlineAt: string
  readonly createdAt: string
  readonly event: AgentEvent
}

export type RunCheckpointChanges = Partial<Pick<RunCheckpoint,
  | 'step'
  | 'messages'
  | 'estimatedInputTokens'
  | 'modelTurn'
  | 'toolLedgers'
  | 'preparedBatch'
  | 'interruption'
  | 'budgetCounters'
  | 'recoveryUsed'
  | 'forceCorrection'
  | 'output'
  | 'visibleOutput'
  | 'error'
  | 'cancellationReason'
>>

const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PROFILE = /^[a-z][a-z0-9_.-]{0,63}$/

function timestamp (value: string, label: string): void {
  if (typeof value !== 'string' || value.length > 64 || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`)
  }
}

function nonNegative (value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`)
}

function freezeCheckpoint (value: RunCheckpoint): RunCheckpoint {
  const parsed = parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.checkpointBytes,
    maxDepth: 32,
    maxNodes: 8_192
  })
  return parsed as unknown as RunCheckpoint
}

function validateEvents (
  events: readonly AgentEvent[],
  startSequence: number,
  runId: string,
  sessionId: string
): void {
  for (const [offset, rawEvent] of events.entries()) {
    const event = parseAgentEvent(rawEvent)
    if (event.runId !== runId || event.sessionId !== sessionId ||
      event.sequence !== startSequence + offset) {
      throw new TypeError('run event sequence is invalid')
    }
  }
}

export function createInitialRunCheckpoint (
  input: CreateRunCheckpointInput
): RunCheckpoint {
  if (!PROFILE.test(input.profileId) || !Number.isSafeInteger(input.profileVersion) ||
    input.profileVersion <= 0 || !CODE.test(input.runId) || !CODE.test(input.sessionId) ||
    input.event.sequence !== 0 || input.event.runId !== input.runId ||
    input.event.sessionId !== input.sessionId) {
    throw new TypeError('initial run checkpoint identity is invalid')
  }
  timestamp(input.deadlineAt, 'run deadline')
  timestamp(input.createdAt, 'run creation time')
  validateEvents([input.event], 0, input.runId, input.sessionId)
  return freezeCheckpoint({
    schemaVersion: 1,
    kernelVersion: 1,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    runId: input.runId,
    sessionId: input.sessionId,
    revision: 0,
    status: 'created',
    step: 0,
    model: input.model,
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    modelTurn: null,
    toolSnapshot: input.toolSnapshot,
    toolLedgers: Object.freeze([]),
    preparedBatch: null,
    interruption: null,
    budgetLimits: input.budgetLimits,
    budgetCounters: input.budgetCounters,
    recoveryUsed: false,
    forceCorrection: false,
    output: null,
    visibleOutput: false,
    error: null,
    cancellationReason: null,
    events: Object.freeze([input.event]),
    nextEventSequence: 1,
    deadlineAt: input.deadlineAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  })
}

export function nextRunCheckpoint (
  checkpoint: RunCheckpoint,
  status: RunStatus,
  changes: RunCheckpointChanges,
  events: readonly AgentEvent[],
  updatedAt: string
): RunCheckpoint {
  assertRunTransition(checkpoint.status, status)
  timestamp(updatedAt, 'run update time')
  validateEvents(
    events,
    checkpoint.nextEventSequence,
    checkpoint.runId,
    checkpoint.sessionId
  )
  const nextSequence = checkpoint.nextEventSequence + events.length
  nonNegative(nextSequence, 'next event sequence')
  return freezeCheckpoint({
    ...checkpoint,
    ...changes,
    revision: checkpoint.revision + 1,
    status,
    events: Object.freeze([...checkpoint.events, ...events]),
    nextEventSequence: nextSequence,
    updatedAt
  })
}
