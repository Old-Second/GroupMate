import { createHash } from 'node:crypto'
import { parseAgentMessage, type AgentMessage } from '../contracts/content.js'
import { isAgentErrorCode, type SerializedAgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import type { AgentEvent } from '../contracts/event.js'
import { parseAgentEvent } from '../contracts/event.js'
import type { ModelMessage, ModelReasoningOptions } from '../model/model-adapter.js'
import { parseJsonValue } from '../model/json-value.js'
import { parseProviderTurnState } from './provider-state.js'
import { parseApprovalInterruption, type ApprovalInterruption } from './interruption.js'
import type { RunBudgetCounters, RunBudgetLimits } from './run-budget.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import { assertRunTransition, parseRunStatus, type RunStatus } from './run-state.js'
import type { PreparedToolBatch } from './tool-scheduler.js'
import type { ToolExecutionLedger } from './tool-ledger.js'
import type { ToolSnapshotManifestEntry } from '../tools/tool-registry.js'
import { canonicalSessionKey, parseCanonicalSessionKey } from '../session/conversation-scope.js'
import { parseSerializablePreparedCapability } from '../tools/prepared-capability.js'
import { parseToolResult } from '../tools/tool-result.js'

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
  readonly sessionAddress: SessionAddress
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
  readonly approvalHistory: readonly ApprovalInterruption[]
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
  readonly sessionAddress: SessionAddress
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
  | 'approvalHistory'
  | 'budgetCounters'
  | 'recoveryUsed'
  | 'forceCorrection'
  | 'output'
  | 'visibleOutput'
  | 'error'
  | 'cancellationReason'
  | 'deadlineAt'
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

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactKeys (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Object.keys(value)
  const unknown = keys.find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new TypeError(`unknown ${label} key: ${unknown}`)
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new TypeError(`${label} key is missing: ${missing}`)
}

function boundedString (value: unknown, label: string, maxLength = 262_144): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function finiteNumber (value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function jsonBytes (value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

const CHECKPOINT_KEYS = Object.freeze([
  'schemaVersion', 'kernelVersion', 'profileId', 'profileVersion', 'runId',
  'sessionId', 'sessionAddress', 'revision', 'status', 'step', 'model',
  'messages', 'estimatedInputTokens', 'modelTurn', 'toolSnapshot',
  'toolLedgers', 'preparedBatch', 'interruption', 'approvalHistory', 'budgetLimits',
  'budgetCounters', 'recoveryUsed', 'forceCorrection', 'output',
  'visibleOutput', 'error', 'cancellationReason', 'events',
  'nextEventSequence', 'deadlineAt', 'createdAt', 'updatedAt'
])
const MODEL_KEYS = Object.freeze([
  'model', 'streaming', 'maxOutputTokens', 'reasoning', 'temperature', 'topP'
])
const MODEL_REQUIRED_KEYS = Object.freeze([
  'model', 'streaming', 'maxOutputTokens', 'reasoning'
])
const BUDGET_LIMIT_KEYS = Object.freeze([
  'activeRuntimeMs', 'providerTimeoutMs', 'maxModelTurns', 'maxToolCalls',
  'maxEstimatedTokens', 'maxProgressEvents', 'maxProviderRetries',
  'maxRecoveryAttempts', 'maxCorrectionTurns'
])
const BUDGET_COUNTER_KEYS = Object.freeze([
  'modelTurns', 'toolCalls', 'estimatedTokens', 'providerReportedTokens',
  'progressEvents', 'providerRetries', 'recoveryAttempts', 'correctionTurns',
  'usedActiveRuntimeMs'
])
const TOOL_LEDGER_STATUSES = Object.freeze([
  'planned', 'validating', 'ready', 'waiting_approval', 'running', 'denied',
  'rejected', 'expired', 'succeeded', 'failed', 'cancelled', 'indeterminate'
])
const TERMINAL_TOOL_LEDGER_STATUSES = new Set([
  'denied', 'rejected', 'expired', 'succeeded', 'failed', 'cancelled', 'indeterminate'
])

function validateSessionAddress (value: unknown): void {
  const input = record(value, 'session address')
  exactKeys(input, ['botId', 'scope'], ['botId', 'scope'], 'session address')
  const scope = record(input.scope, 'conversation scope')
  if (scope.kind === 'private') {
    exactKeys(scope, ['kind', 'userId'], ['kind', 'userId'], 'conversation scope')
  } else if (scope.kind === 'group') {
    exactKeys(scope, ['kind', 'groupId'], ['kind', 'groupId'], 'conversation scope')
  } else if (scope.kind === 'group_user') {
    exactKeys(
      scope,
      ['kind', 'groupId', 'userId'],
      ['kind', 'groupId', 'userId'],
      'conversation scope'
    )
  } else {
    throw new TypeError('conversation scope is invalid')
  }
  const address = input as unknown as SessionAddress
  const canonical = canonicalSessionKey(address)
  const parsed = parseCanonicalSessionKey(canonical)
  if (parsed === null || canonicalSessionKey(parsed) !== canonical) {
    throw new TypeError('session address is invalid')
  }
}

function validateModelConfig (value: unknown): void {
  const model = record(value, 'run model')
  exactKeys(model, MODEL_KEYS, MODEL_REQUIRED_KEYS, 'run model')
  boundedString(model.model, 'run model name', 512)
  if (typeof model.streaming !== 'boolean') throw new TypeError('run model streaming is invalid')
  if (!Number.isSafeInteger(model.maxOutputTokens) || Number(model.maxOutputTokens) <= 0) {
    throw new TypeError('run model output limit is invalid')
  }
  const reasoning = record(model.reasoning, 'run reasoning options')
  exactKeys(reasoning, ['enabled', 'effort'], ['enabled'], 'run reasoning options')
  if (typeof reasoning.enabled !== 'boolean' ||
    (reasoning.effort !== undefined &&
      !['low', 'medium', 'high', 'max'].includes(String(reasoning.effort)))) {
    throw new TypeError('run reasoning options are invalid')
  }
  if (model.temperature !== undefined) finiteNumber(model.temperature, 'run model temperature')
  if (model.topP !== undefined) finiteNumber(model.topP, 'run model top P')
}

function validateModelMessages (
  value: unknown,
  profileId: string,
  profileVersion: number
): void {
  if (!Array.isArray(value)) throw new TypeError('run model messages are invalid')
  for (const raw of value) {
    const message = record(raw, 'run model message')
    if (['system', 'developer', 'user'].includes(String(message.role))) {
      exactKeys(message, ['role', 'content'], ['role', 'content'], 'model message')
      boundedString(message.content, 'model message content')
      continue
    }
    if (message.role === 'tool') {
      exactKeys(message, ['role', 'content', 'toolCallId'], ['role', 'content', 'toolCallId'], 'model message')
      boundedString(message.content, 'tool message content')
      if (!CODE.test(boundedString(message.toolCallId, 'tool message call ID', 128))) {
        throw new TypeError('tool message call ID is invalid')
      }
      continue
    }
    if (message.role !== 'assistant') throw new TypeError('model message role is invalid')
    exactKeys(
      message,
      ['role', 'content', 'toolCalls', 'providerState'],
      ['role', 'content'],
      'model message'
    )
    if (message.content !== null && typeof message.content !== 'string') {
      throw new TypeError('assistant message content is invalid')
    }
    if (message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls) || message.toolCalls.length > 64) {
        throw new TypeError('assistant tool calls are invalid')
      }
      const ids = new Set<string>()
      for (const rawCall of message.toolCalls) {
        const call = record(rawCall, 'assistant tool call')
        exactKeys(call, ['callId', 'name', 'arguments'], ['callId', 'name', 'arguments'], 'assistant tool call')
        if (!CODE.test(String(call.callId)) || !CODE.test(String(call.name)) || ids.has(String(call.callId))) {
          throw new TypeError('assistant tool call identity is invalid')
        }
        const argumentsValue = parseJsonValue(call.arguments, {
          maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
          maxDepth: 8,
          maxNodes: 512
        })
        if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
          throw new TypeError('assistant tool call arguments are invalid')
        }
        ids.add(String(call.callId))
      }
    }
    if (message.providerState !== undefined) {
      const state = parseProviderTurnState(message.providerState)
      if (state.profileId !== profileId || state.profileVersion !== profileVersion) {
        throw new TypeError('assistant provider state profile is invalid')
      }
    }
  }
}

function validateToolSnapshot (value: unknown): void {
  const snapshot = record(value, 'run tool snapshot')
  exactKeys(snapshot, ['id', 'fingerprint', 'manifest'], ['id', 'fingerprint', 'manifest'], 'tool snapshot')
  if (!CODE.test(String(snapshot.id)) || !/^[a-f0-9]{64}$/.test(String(snapshot.fingerprint)) ||
    !Array.isArray(snapshot.manifest) || snapshot.manifest.length > 128) {
    throw new TypeError('run tool snapshot is invalid')
  }
  const names = new Set<string>()
  for (const rawEntry of snapshot.manifest) {
    const entry = record(rawEntry, 'tool snapshot manifest entry')
    exactKeys(
      entry,
      ['name', 'version', 'schemaHash', 'policyHash', 'schedulingHash'],
      ['name', 'version', 'schemaHash', 'policyHash', 'schedulingHash'],
      'tool snapshot manifest entry'
    )
    if (!CODE.test(String(entry.name)) || entry.version !== 1 || names.has(String(entry.name)) ||
      ![entry.schemaHash, entry.policyHash, entry.schedulingHash]
        .every(hash => /^[a-f0-9]{64}$/.test(String(hash)))) {
      throw new TypeError('tool snapshot manifest entry is invalid')
    }
    names.add(String(entry.name))
  }
  const expected = createHash('sha256').update(JSON.stringify(snapshot.manifest)).digest('hex')
  if (snapshot.fingerprint !== expected) throw new TypeError('tool snapshot fingerprint is invalid')
}

function validateToolLedgers (value: unknown, snapshotId: string): void {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('tool ledgers are invalid')
  for (const rawLedger of value) {
    const ledger = record(rawLedger, 'tool ledger')
    exactKeys(ledger, ['schemaVersion', 'step', 'calls'], ['schemaVersion', 'step', 'calls'], 'tool ledger')
    if (ledger.schemaVersion !== 1 || !Number.isSafeInteger(ledger.step) || Number(ledger.step) < 0 ||
      !Array.isArray(ledger.calls) || ledger.calls.length === 0 || ledger.calls.length > 64) {
      throw new TypeError('tool ledger is invalid')
    }
    const ids = new Set<string>()
    for (const [index, rawCall] of ledger.calls.entries()) {
      const call = record(rawCall, 'tool ledger call')
      exactKeys(call, [
        'occurrenceId', 'step', 'index', 'callId', 'toolName', 'arguments',
        'status', 'capability', 'result'
      ], [
        'occurrenceId', 'step', 'index', 'callId', 'toolName', 'arguments',
        'status', 'capability', 'result'
      ], 'tool ledger call')
      if (call.step !== ledger.step || call.index !== index ||
        call.occurrenceId !== `${ledger.step}:${index}` || !CODE.test(String(call.callId)) ||
        !CODE.test(String(call.toolName)) || ids.has(String(call.callId)) ||
        !TOOL_LEDGER_STATUSES.includes(String(call.status))) {
        throw new TypeError('tool ledger call identity is invalid')
      }
      const args = parseJsonValue(call.arguments, {
        maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
        maxDepth: 8,
        maxNodes: 512
      })
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('tool ledger arguments are invalid')
      }
      if (call.capability !== null) {
        const capability = parseSerializablePreparedCapability(call.capability)
        if (capability.callId !== call.callId || capability.toolName !== call.toolName ||
          capability.snapshotId !== snapshotId) {
          throw new TypeError('tool ledger capability is invalid')
        }
      }
      if (call.result !== null) parseToolResult(call.result)
      const terminal = TERMINAL_TOOL_LEDGER_STATUSES.has(String(call.status))
      if ((terminal && call.result === null) || (!terminal && call.result !== null) ||
        (['ready', 'waiting_approval', 'running'].includes(String(call.status)) &&
          call.capability === null)) {
        throw new TypeError('tool ledger call state is invalid')
      }
      ids.add(String(call.callId))
    }
  }
}

function validatePreparedBatch (value: unknown, snapshotId: string): void {
  if (value === null) return
  const batch = record(value, 'prepared tool batch')
  exactKeys(batch, ['schemaVersion', 'calls'], ['schemaVersion', 'calls'], 'prepared tool batch')
  if (batch.schemaVersion !== 1 || !Array.isArray(batch.calls) || batch.calls.length > 64) {
    throw new TypeError('prepared tool batch is invalid')
  }
  for (const rawCall of batch.calls) {
    const call = record(rawCall, 'prepared tool call')
    if (call.kind === 'ready') {
      exactKeys(call, ['kind', 'capability'], ['kind', 'capability'], 'prepared tool call')
      if (parseSerializablePreparedCapability(call.capability).snapshotId !== snapshotId) {
        throw new TypeError('prepared tool snapshot is invalid')
      }
    } else if (call.kind === 'approval_required') {
      exactKeys(call, ['kind', 'capability', 'summaryCode'], ['kind', 'capability', 'summaryCode'], 'prepared tool call')
      if (parseSerializablePreparedCapability(call.capability).snapshotId !== snapshotId ||
        !CODE.test(String(call.summaryCode))) {
        throw new TypeError('prepared approval call is invalid')
      }
    } else if (call.kind === 'completed') {
      exactKeys(call, ['kind', 'callId', 'toolName', 'result'], ['kind', 'callId', 'toolName', 'result'], 'prepared tool call')
      if (!CODE.test(String(call.callId)) || !CODE.test(String(call.toolName))) {
        throw new TypeError('completed prepared call identity is invalid')
      }
      parseToolResult(call.result)
    } else {
      throw new TypeError('prepared tool call kind is invalid')
    }
  }
}

function validateBudgets (limitsValue: unknown, countersValue: unknown): void {
  const limits = record(limitsValue, 'run budget limits')
  exactKeys(limits, BUDGET_LIMIT_KEYS, BUDGET_LIMIT_KEYS, 'run budget limits')
  const fixed: Readonly<Record<string, number>> = Object.freeze({
    activeRuntimeMs: 240_000,
    maxModelTurns: 6,
    maxToolCalls: 8,
    maxEstimatedTokens: 49_152,
    maxProgressEvents: 5,
    maxProviderRetries: 1,
    maxRecoveryAttempts: 1,
    maxCorrectionTurns: 1
  })
  for (const [key, expected] of Object.entries(fixed)) {
    if (limits[key] !== expected) throw new TypeError('run budget limits are incompatible')
  }
  if (!Number.isSafeInteger(limits.providerTimeoutMs) || Number(limits.providerTimeoutMs) <= 0 ||
    Number(limits.providerTimeoutMs) > 120_000) {
    throw new TypeError('run provider timeout is invalid')
  }
  const counters = record(countersValue, 'run budget counters')
  exactKeys(counters, BUDGET_COUNTER_KEYS, BUDGET_COUNTER_KEYS, 'run budget counters')
  for (const key of BUDGET_COUNTER_KEYS) nonNegative(Number(counters[key]), `run budget counter ${key}`)
  if (Number(counters.modelTurns) > 6 || Number(counters.toolCalls) > 8 ||
    Number(counters.estimatedTokens) > 49_152 || Number(counters.progressEvents) > 5 ||
    Number(counters.providerRetries) > 1 || Number(counters.recoveryAttempts) > 1 ||
    Number(counters.correctionTurns) > 1 || Number(counters.usedActiveRuntimeMs) > 240_000) {
    throw new TypeError('run budget counters exceed their limits')
  }
}

function validateSerializedError (value: unknown): void {
  const error = record(value, 'serialized run error')
  exactKeys(error, ['code', 'stage', 'retryable', 'userMessage', 'details'], ['code', 'stage', 'retryable', 'userMessage', 'details'], 'serialized run error')
  if (!isAgentErrorCode(error.code) || typeof error.stage !== 'string' ||
    typeof error.retryable !== 'boolean' || typeof error.userMessage !== 'string') {
    throw new TypeError('serialized run error is invalid')
  }
  const details = record(error.details, 'serialized run error details')
  for (const detail of Object.values(details)) {
    if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
      throw new TypeError('serialized run error details are invalid')
    }
  }
}

function splitCheckpoint (
  checkpoint: RunCheckpoint
): { readonly state: Omit<RunCheckpoint, 'events'>; readonly events: readonly AgentEvent[] } {
  const { events, ...state } = checkpoint
  return Object.freeze({ state, events })
}

export function parseRunCheckpoint (value: unknown): RunCheckpoint {
  const parsedJson = parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.checkpointBytes + RUN_RESOURCE_LIMITS.eventBytes,
    maxDepth: 32,
    maxNodes: 32_768
  })
  const unparsed = record(parsedJson, 'run checkpoint')
  exactKeys(unparsed, CHECKPOINT_KEYS, CHECKPOINT_KEYS, 'checkpoint')
  if (!Array.isArray(unparsed.events)) throw new TypeError('run checkpoint events are invalid')
  if (unparsed.events.length > RUN_RESOURCE_LIMITS.eventCount) {
    throw new TypeError('run event count limit exceeded')
  }
  const parsed = unparsed as unknown as RunCheckpoint
  const split = splitCheckpoint(parsed)
  if (jsonBytes(split.state) > RUN_RESOURCE_LIMITS.checkpointBytes) {
    throw new TypeError('run checkpoint byte limit exceeded')
  }
  if (jsonBytes(split.events) > RUN_RESOURCE_LIMITS.eventBytes) {
    throw new TypeError('run event byte limit exceeded')
  }
  if (parsed.schemaVersion !== 1 || parsed.kernelVersion !== 1 ||
    !PROFILE.test(parsed.profileId) || !Number.isSafeInteger(parsed.profileVersion) ||
    parsed.profileVersion <= 0 || !CODE.test(parsed.runId) || !CODE.test(parsed.sessionId)) {
    throw new TypeError('run checkpoint identity is invalid')
  }
  validateSessionAddress(parsed.sessionAddress)
  nonNegative(parsed.revision, 'run revision')
  nonNegative(parsed.step, 'run step')
  parseRunStatus(parsed.status)
  validateModelConfig(parsed.model)
  validateModelMessages(parsed.messages, parsed.profileId, parsed.profileVersion)
  nonNegative(parsed.estimatedInputTokens, 'run estimated input tokens')
  if (parsed.modelTurn !== null) {
    const turn = record(parsed.modelTurn, 'reserved model turn')
    exactKeys(turn, ['kind', 'maxOutputTokens'], ['kind', 'maxOutputTokens'], 'reserved model turn')
    if (!['normal', 'correction'].includes(String(turn.kind)) ||
      !Number.isSafeInteger(turn.maxOutputTokens) || Number(turn.maxOutputTokens) <= 0) {
      throw new TypeError('reserved model turn is invalid')
    }
  }
  validateToolSnapshot(parsed.toolSnapshot)
  validateToolLedgers(parsed.toolLedgers, parsed.toolSnapshot.id)
  validatePreparedBatch(parsed.preparedBatch, parsed.toolSnapshot.id)
  if (parsed.interruption !== null) {
    const interruption = parseApprovalInterruption(parsed.interruption)
    if (interruption.runId !== parsed.runId || interruption.step !== parsed.step ||
      interruption.approvalAddress.botId !== parsed.sessionAddress.botId ||
      interruption.decision !== undefined) {
      throw new TypeError('run interruption identity is invalid')
    }
  }
  if (!Array.isArray(parsed.approvalHistory) || parsed.approvalHistory.length > 8) {
    throw new TypeError('run approval history is invalid')
  }
  const approvalIds = new Set<string>()
  for (const rawInterruption of parsed.approvalHistory) {
    const interruption = parseApprovalInterruption(rawInterruption)
    if (interruption.runId !== parsed.runId || interruption.step > parsed.step ||
      interruption.approvalAddress.botId !== parsed.sessionAddress.botId ||
      interruption.decision === undefined || approvalIds.has(interruption.approvalId)) {
      throw new TypeError('run approval history is invalid')
    }
    approvalIds.add(interruption.approvalId)
  }
  if (parsed.interruption !== null && approvalIds.has(parsed.interruption.approvalId)) {
    throw new TypeError('active run approval is already in history')
  }
  validateBudgets(parsed.budgetLimits, parsed.budgetCounters)
  if (typeof parsed.recoveryUsed !== 'boolean' || typeof parsed.forceCorrection !== 'boolean' ||
    typeof parsed.visibleOutput !== 'boolean') {
    throw new TypeError('run checkpoint flags are invalid')
  }
  if (parsed.output !== null) parseAgentMessage(parsed.output)
  if (parsed.error !== null) validateSerializedError(parsed.error)
  if (parsed.cancellationReason !== null &&
    (typeof parsed.cancellationReason !== 'string' || !CODE.test(parsed.cancellationReason))) {
    throw new TypeError('run cancellation reason is invalid')
  }
  validateEvents(parsed.events, 0, parsed.runId, parsed.sessionId)
  if (parsed.nextEventSequence !== parsed.events.length) {
    throw new TypeError('run next event sequence is invalid')
  }
  timestamp(parsed.deadlineAt, 'run deadline')
  timestamp(parsed.createdAt, 'run creation time')
  timestamp(parsed.updatedAt, 'run update time')
  if (parsed.status === 'completed' &&
    ((parsed.output === null && !parsed.visibleOutput) || parsed.error !== null ||
      parsed.cancellationReason !== null)) {
    throw new TypeError('completed run checkpoint is invalid')
  }
  if (parsed.status === 'failed' && (parsed.error === null || parsed.cancellationReason !== null)) {
    throw new TypeError('failed run checkpoint is invalid')
  }
  if (parsed.status === 'cancelled' && parsed.cancellationReason === null) {
    throw new TypeError('cancelled run checkpoint is invalid')
  }
  if ((parsed.status === 'waiting_approval') !== (parsed.interruption !== null) ||
    (parsed.status === 'waiting_approval' && parsed.preparedBatch === null)) {
    throw new TypeError('run approval checkpoint state is invalid')
  }
  return parsed
}

function freezeCheckpoint (value: RunCheckpoint): RunCheckpoint {
  return parseRunCheckpoint(value)
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
    sessionAddress: input.sessionAddress,
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
    approvalHistory: Object.freeze([]),
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

const CHECKPOINT_STATE_KEYS = Object.freeze(
  CHECKPOINT_KEYS.filter(key => key !== 'events')
)
const EVENT_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'revision', 'events'
])

export interface EncodedRunCheckpoint {
  readonly checkpoint: string
  readonly events: string
}

interface RunEventEnvelope {
  readonly schemaVersion: 1
  readonly revision: number
  readonly events: readonly AgentEvent[]
}

function parseJsonText (raw: string, label: string, maxBytes: number): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new TypeError(`${label} byte limit exceeded`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new TypeError(`${label} encoding is invalid`, { cause: error })
  }
}

export class RunCheckpointCodec {
  encode (value: RunCheckpoint): EncodedRunCheckpoint {
    const parsed = parseRunCheckpoint(value)
    const split = splitCheckpoint(parsed)
    const envelope: RunEventEnvelope = Object.freeze({
      schemaVersion: 1,
      revision: parsed.revision,
      events: split.events
    })
    const checkpoint = JSON.stringify(split.state)
    const events = JSON.stringify(envelope)
    if (Buffer.byteLength(checkpoint, 'utf8') > RUN_RESOURCE_LIMITS.checkpointBytes) {
      throw new TypeError('run checkpoint byte limit exceeded')
    }
    if (Buffer.byteLength(events, 'utf8') > RUN_RESOURCE_LIMITS.eventBytes) {
      throw new TypeError('run event byte limit exceeded')
    }
    return Object.freeze({ checkpoint, events })
  }

  decode (checkpointRaw: string, eventsRaw: string): RunCheckpoint {
    const state = record(
      parseJsonText(checkpointRaw, 'run checkpoint', RUN_RESOURCE_LIMITS.checkpointBytes),
      'run checkpoint state'
    )
    exactKeys(state, CHECKPOINT_STATE_KEYS, CHECKPOINT_STATE_KEYS, 'checkpoint')
    const envelope = record(
      parseJsonText(eventsRaw, 'run event', RUN_RESOURCE_LIMITS.eventBytes),
      'run event envelope'
    )
    exactKeys(envelope, EVENT_ENVELOPE_KEYS, EVENT_ENVELOPE_KEYS, 'event envelope')
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) ||
      envelope.revision !== state.revision || !Array.isArray(envelope.events)) {
      throw new TypeError('run event envelope is invalid')
    }
    return parseRunCheckpoint({
      ...state,
      events: envelope.events
    })
  }
}

export function recoverExecutingRunCheckpoint (
  checkpoint: RunCheckpoint,
  changes: RunCheckpointChanges,
  events: readonly AgentEvent[],
  updatedAt: string
): RunCheckpoint {
  if (checkpoint.status !== 'executing_tools') {
    throw new TypeError('only an executing run can be recovered')
  }
  timestamp(updatedAt, 'run update time')
  validateEvents(
    events,
    checkpoint.nextEventSequence,
    checkpoint.runId,
    checkpoint.sessionId
  )
  return freezeCheckpoint({
    ...checkpoint,
    ...changes,
    revision: checkpoint.revision + 1,
    status: 'evaluating_tools',
    events: Object.freeze([...checkpoint.events, ...events]),
    nextEventSequence: checkpoint.nextEventSequence + events.length,
    updatedAt
  })
}

export function appendRunCheckpointEvents (
  checkpoint: RunCheckpoint,
  events: readonly AgentEvent[]
): RunCheckpoint {
  if (events.length === 0) return checkpoint
  validateEvents(
    events,
    checkpoint.nextEventSequence,
    checkpoint.runId,
    checkpoint.sessionId
  )
  const updatedAt = events.at(-1)?.occurredAt
  if (updatedAt === undefined) throw new TypeError('run event timestamp is missing')
  timestamp(updatedAt, 'run update time')
  return freezeCheckpoint({
    ...checkpoint,
    revision: checkpoint.revision + 1,
    events: Object.freeze([...checkpoint.events, ...events]),
    nextEventSequence: checkpoint.nextEventSequence + events.length,
    updatedAt
  })
}
