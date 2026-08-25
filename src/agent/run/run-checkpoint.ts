import { createHash } from 'node:crypto'
import { parseAgentMessage, type AgentMessage } from '../contracts/content.js'
import {
  completionFromTerminalOutput,
  parseCompletionDisposition,
  type CompletionDisposition
} from '../contracts/completion.js'
import { isAgentErrorCode, type SerializedAgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import {
  parsePresentationRoute,
  type CheckpointRequestKind,
  type PresentationRouteV1
} from '../contracts/interaction.js'
import type { AgentEvent } from '../contracts/event.js'
import { parseAgentEvent } from '../contracts/event.js'
import type { ModelMessage, ModelReasoningOptions } from '../model/model-adapter.js'
import { publicModelImageUrl, MAX_MODEL_IMAGE_URLS } from '../model/model-adapter.js'
import {
  modelCapabilityStableHash,
  parseModelCapabilitySnapshot,
  type ModelCapabilitySnapshotV1
} from '../model/model-capability.js'
import {
  parseModelPriceSnapshot,
  type ModelPriceSnapshotV1
} from '../model/model-price-catalog.js'
import { parseJsonValue, type JsonObject } from '../model/json-value.js'
import { parseExactToolArgumentsText } from '../model/tool-arguments-text.js'
import { parseProviderTurnState } from './provider-state.js'
import { parseApprovalInterruption, type ApprovalInterruption } from './interruption.js'
import type {
  LegacyRunBudgetLimitsV1,
  RunBudgetCounters,
  RunBudgetLimits
} from './run-budget.js'
import {
  contextWireHash,
  parseContextPlanV1,
  parseLegacyContextPlanV1,
  type ContextPlanV1,
  type LegacyContextPlanV1
} from '../context/context-plan.js'
import {
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  estimateModelMessagesTokens,
  serializedModelMessagesBytes
} from '../context/context-token-estimator.js'
import {
  ADAPTIVE_CONTEXT_LOOP_POLICY,
  parseRunModelLoopPolicyV1,
  type RunModelLoopPolicyV1
} from './run-loop-policy.js'
import {
  createToolWireSnapshotV1,
  parseToolWireSnapshotV1,
  type ToolWireSnapshotV1
} from './model-turn-capacity.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import {
  assertRunTransition,
  isTerminalRunStatus,
  parseRunStatus,
  type RunStatus
} from './run-state.js'
import type { PreparedToolBatch } from './tool-scheduler.js'
import type { ToolExecutionLedger } from './tool-ledger.js'
import type { ToolSnapshotManifestEntry } from '../tools/tool-registry.js'
import { canonicalSessionKey, parseCanonicalSessionKey } from '../session/conversation-scope.js'
import { parseSerializablePreparedCapability } from '../tools/prepared-capability.js'
import { parseToolResult } from '../tools/tool-result.js'
import { RUN_REF_PATTERN } from './run-reference.js'
import {
  createFrozenObservationPolicy,
  createInitialRunObservationCounters,
  parseFrozenObservationPolicy,
  parseRunObservationCounters,
  type EngineActivityObservationV1,
  type FrozenObservationPolicyV1,
  type ProviderDispatchObservationV1,
  type RunObservationCountersV1
} from './run-observation.js'
import {
  parseRunReasoningSegments,
  type RunReasoningSegment
} from './run-reasoning-segment.js'
import {
  parseFrozenProviderGenerationV1,
  type FrozenProviderGenerationV1
} from './provider-generation.js'
import {
  createInitialRunUsageSummary,
  parseRunUsageSummary,
  type RunUsageSummaryV1
} from './run-usage.js'

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

export interface RunCheckpointV1 {
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
  readonly budgetLimits: LegacyRunBudgetLimitsV1
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

export interface RunCheckpointV2 extends Omit<
  RunCheckpointV1,
  'schemaVersion' | 'visibleOutput'
> {
  readonly schemaVersion: 2
  readonly runRef: string
  readonly requestRef: string
  readonly requestKind: CheckpointRequestKind
  readonly presentationRoute: PresentationRouteV1 | null
  readonly completion: CompletionDisposition | null
  readonly observationCounters: RunObservationCountersV1
  readonly providerDispatch: ProviderDispatchObservationV1
  readonly engineActivity: EngineActivityObservationV1
  readonly observationPolicy: FrozenObservationPolicyV1
}

export interface RunCheckpointV3 extends Omit<RunCheckpointV2, 'schemaVersion'> {
  readonly schemaVersion: 3
  readonly reasoningSegments: readonly RunReasoningSegment[]
}

export interface RunCheckpointV4 extends Omit<RunCheckpointV3, 'schemaVersion'> {
  readonly schemaVersion: 4
  readonly modelCapability: ModelCapabilitySnapshotV1
  readonly modelPrice: ModelPriceSnapshotV1 | null
  readonly usage: RunUsageSummaryV1
}

export interface RunCheckpointV5 extends Omit<
  RunCheckpointV4,
  'schemaVersion' | 'budgetLimits'
> {
  readonly schemaVersion: 5
  readonly budgetLimits: RunBudgetLimits
  readonly modelLoopPolicy: RunModelLoopPolicyV1
  readonly contextPlan: ContextPlanV1 | LegacyContextPlanV1 | null
  readonly contextArtifactRefs: readonly string[]
  readonly toolWireSnapshot: ToolWireSnapshotV1 | null
}

export type RunContextRuntimeModeV1 = 'legacy_compatible' | 'generation_planner'

export interface RunCheckpointV6 extends Omit<
RunCheckpointV5,
'schemaVersion' | 'contextPlan'
> {
  readonly schemaVersion: 6
  readonly contextPlan: ContextPlanV1 | null
  readonly contextRuntimeMode: RunContextRuntimeModeV1
  readonly pendingContextMessages: readonly ModelMessage[]
  readonly providerGeneration: FrozenProviderGenerationV1 | null
}

export type LoadedRunCheckpoint =
  | RunCheckpointV1
  | RunCheckpointV2
  | RunCheckpointV3
  | RunCheckpointV4
  | RunCheckpointV5
  | RunCheckpointV6
export type RunCheckpoint = RunCheckpointV6

export interface CreateRunCheckpointInput {
  readonly profileId: string
  readonly profileVersion: number
  readonly runId: string
  readonly sessionId: string
  readonly sessionAddress: SessionAddress
  readonly runRef?: string
  readonly requestRef?: string
  readonly requestKind?: Exclude<CheckpointRequestKind, 'legacy_unknown'>
  readonly presentationRoute?: PresentationRouteV1
  readonly observationPolicy?: FrozenObservationPolicyV1
  readonly model: RunModelConfig
  readonly modelCapability: ModelCapabilitySnapshotV1
  readonly modelPrice: ModelPriceSnapshotV1 | null
  readonly toolSnapshot: RunToolSnapshotReference
  readonly budgetLimits: RunBudgetLimits
  readonly budgetCounters: RunBudgetCounters
  readonly modelLoopPolicy?: RunModelLoopPolicyV1
  readonly contextPlan?: ContextPlanV1 | null
  readonly contextArtifactRefs?: readonly string[]
  readonly toolWireSnapshot?: ToolWireSnapshotV1 | null
  readonly contextRuntimeMode?: RunContextRuntimeModeV1
  readonly deadlineAt: string
  readonly createdAt: string
  readonly event: AgentEvent
}

export type RunCheckpointChanges = Partial<Pick<RunCheckpoint,
  | 'step'
  | 'messages'
  | 'estimatedInputTokens'
  | 'contextPlan'
  | 'contextArtifactRefs'
  | 'pendingContextMessages'
  | 'providerGeneration'
  | 'modelTurn'
  | 'toolLedgers'
  | 'preparedBatch'
  | 'interruption'
  | 'approvalHistory'
  | 'budgetCounters'
  | 'recoveryUsed'
  | 'forceCorrection'
  | 'reasoningSegments'
  | 'usage'
  | 'output'
  | 'completion'
  | 'observationCounters'
  | 'providerDispatch'
  | 'engineActivity'
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

const CHECKPOINT_V1_KEYS = Object.freeze([
  'schemaVersion', 'kernelVersion', 'profileId', 'profileVersion', 'runId',
  'sessionId', 'sessionAddress', 'revision', 'status', 'step', 'model',
  'messages', 'estimatedInputTokens', 'modelTurn', 'toolSnapshot',
  'toolLedgers', 'preparedBatch', 'interruption', 'approvalHistory', 'budgetLimits',
  'budgetCounters', 'recoveryUsed', 'forceCorrection', 'output',
  'visibleOutput', 'error', 'cancellationReason', 'events',
  'nextEventSequence', 'deadlineAt', 'createdAt', 'updatedAt'
])
const CHECKPOINT_V2_KEYS = Object.freeze([
  'schemaVersion', 'kernelVersion', 'profileId', 'profileVersion', 'runId',
  'sessionId', 'sessionAddress', 'revision', 'status', 'step', 'model',
  'messages', 'estimatedInputTokens', 'modelTurn', 'toolSnapshot',
  'toolLedgers', 'preparedBatch', 'interruption', 'approvalHistory', 'budgetLimits',
  'budgetCounters', 'recoveryUsed', 'forceCorrection', 'output', 'error',
  'cancellationReason', 'events', 'nextEventSequence', 'deadlineAt', 'createdAt',
  'updatedAt', 'runRef', 'requestRef', 'requestKind', 'presentationRoute',
  'completion', 'observationCounters', 'providerDispatch', 'engineActivity',
  'observationPolicy'
])
const CHECKPOINT_V3_KEYS = Object.freeze([
  ...CHECKPOINT_V2_KEYS,
  'reasoningSegments'
])
const CHECKPOINT_V4_KEYS = Object.freeze([
  ...CHECKPOINT_V3_KEYS,
  'modelCapability', 'modelPrice', 'usage'
])
const CHECKPOINT_V5_KEYS = Object.freeze([
  ...CHECKPOINT_V4_KEYS,
  'modelLoopPolicy', 'contextPlan', 'contextArtifactRefs', 'toolWireSnapshot'
])
const CHECKPOINT_V6_KEYS = Object.freeze([
  ...CHECKPOINT_V5_KEYS,
  'contextRuntimeMode', 'pendingContextMessages', 'providerGeneration'
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
const BUDGET_LIMIT_V2_KEYS = Object.freeze([
  'schemaVersion', 'activeRuntimeMs', 'providerTimeoutMs', 'maxToolCalls',
  'maxProgressEvents', 'maxProviderRetries', 'maxRecoveryAttempts',
  'maxCorrectionTurns'
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
      exactKeys(
        message,
        message.role === 'user' ? ['role', 'content', 'imageUrls'] : ['role', 'content'],
        ['role', 'content'],
        'model message'
      )
      boundedString(message.content, 'model message content')
      if (message.role === 'user' && message.imageUrls !== undefined) {
        if (!Array.isArray(message.imageUrls) || message.imageUrls.length > MAX_MODEL_IMAGE_URLS) {
          throw new TypeError('model message image URLs are invalid')
        }
        let imageUrls: string[]
        try {
          imageUrls = message.imageUrls.map(publicModelImageUrl)
        } catch {
          throw new TypeError('model message image URLs are invalid')
        }
        if (imageUrls.length !== new Set(imageUrls).size) {
          throw new TypeError('model message image URLs are duplicated')
        }
      }
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
        exactKeys(
          call,
          ['callId', 'name', 'argumentsText', 'arguments'],
          ['callId', 'name', 'arguments'],
          'assistant tool call'
        )
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
        if (call.argumentsText !== undefined) {
          parseExactToolArgumentsText(call.argumentsText, argumentsValue as JsonObject)
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
        'occurrenceId', 'step', 'index', 'callId', 'toolName', 'argumentsText', 'arguments',
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
      if (call.argumentsText !== undefined) {
        parseExactToolArgumentsText(call.argumentsText, args as JsonObject)
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

function validateBudgets (
  limitsValue: unknown,
  countersValue: unknown,
  loopPolicyValue?: unknown
): void {
  const limits = record(limitsValue, 'run budget limits')
  const v2 = loopPolicyValue !== undefined
  exactKeys(
    limits,
    v2 ? BUDGET_LIMIT_V2_KEYS : BUDGET_LIMIT_KEYS,
    v2 ? BUDGET_LIMIT_V2_KEYS : BUDGET_LIMIT_KEYS,
    'run budget limits'
  )
  const fixed: Readonly<Record<string, number>> = Object.freeze({
    activeRuntimeMs: 240_000,
    maxToolCalls: 8,
    maxProgressEvents: 5,
    maxProviderRetries: 1,
    maxRecoveryAttempts: 1,
    maxCorrectionTurns: 1
  })
  if (v2 && limits.schemaVersion !== 2) {
    throw new TypeError('run budget limits are incompatible')
  }
  for (const [key, expected] of Object.entries(fixed)) {
    if (limits[key] !== expected) throw new TypeError('run budget limits are incompatible')
  }
  const loopPolicy = v2 ? parseRunModelLoopPolicyV1(loopPolicyValue) : null
  const maxEstimatedTokens: number | null = v2
    ? loopPolicy?.kind === 'legacy_fixed' ? loopPolicy.maxEstimatedTokens : null
    : typeof limits.maxEstimatedTokens === 'number' ? limits.maxEstimatedTokens : null
  if (!v2 && (limits.maxModelTurns !== 6 ||
    (maxEstimatedTokens !== 49_152 && maxEstimatedTokens !== 196_608))) {
    throw new TypeError('run budget limits are incompatible')
  }
  if (!Number.isSafeInteger(limits.providerTimeoutMs) || Number(limits.providerTimeoutMs) <= 0 ||
    Number(limits.providerTimeoutMs) > 120_000) {
    throw new TypeError('run provider timeout is invalid')
  }
  const counters = record(countersValue, 'run budget counters')
  exactKeys(counters, BUDGET_COUNTER_KEYS, BUDGET_COUNTER_KEYS, 'run budget counters')
  for (const key of BUDGET_COUNTER_KEYS) {
    const value = counters[key]
    if (typeof value !== 'number') throw new TypeError(`run budget counter ${key} is invalid`)
    nonNegative(value, `run budget counter ${key}`)
  }
  if ((loopPolicy?.kind === 'legacy_fixed' &&
      Number(counters.modelTurns) > loopPolicy.maxModelTurns) ||
    Number(counters.toolCalls) > 8 ||
    (maxEstimatedTokens !== null && Number(counters.estimatedTokens) > maxEstimatedTokens) ||
    Number(counters.progressEvents) > 5 ||
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

function splitCheckpoint<T extends LoadedRunCheckpoint> (
  checkpoint: T
): { readonly state: Omit<T, 'events'>; readonly events: readonly AgentEvent[] } {
  const { events, ...state } = checkpoint
  return Object.freeze({ state, events })
}

function validateObservationState (
  value: unknown,
  label: string
): void {
  const state = record(value, label)
  exactKeys(state, ['state'], ['state'], label)
  if (state.state !== 'idle' && state.state !== 'reserved') {
    throw new TypeError(`${label} is invalid`)
  }
}

function validateCheckpointV2OrLater (
  parsed: RunCheckpointV2 | RunCheckpointV3 | RunCheckpointV4 | RunCheckpointV5 | RunCheckpointV6
): void {
  if (!RUN_REF_PATTERN.test(parsed.runRef) || !RUN_REF_PATTERN.test(parsed.requestRef)) {
    throw new TypeError('run checkpoint reference is invalid')
  }
  if (parsed.requestKind === 'legacy_unknown') {
    if (parsed.presentationRoute !== null) {
      throw new TypeError('legacy checkpoint presentation route is invalid')
    }
  } else {
    if (parsed.presentationRoute === null) {
      throw new TypeError('trusted checkpoint presentation route is missing')
    }
    const route = parsePresentationRoute(parsed.presentationRoute)
    if (route.requestKind !== parsed.requestKind ||
      canonicalSessionKey(route.sessionAddress) !== canonicalSessionKey(parsed.sessionAddress)) {
      throw new TypeError('checkpoint presentation route matrix is invalid')
    }
  }
  parseRunObservationCounters(parsed.observationCounters)
  validateObservationState(parsed.providerDispatch, 'provider dispatch observation')
  validateObservationState(parsed.engineActivity, 'engine activity observation')
  if (isTerminalRunStatus(parsed.status) &&
    (parsed.providerDispatch.state !== 'idle' || parsed.engineActivity.state !== 'idle')) {
    throw new TypeError('terminal run checkpoint contains a reservation')
  }
  const observationPolicy = parseFrozenObservationPolicy(parsed.observationPolicy)
  const expectedObservationPolicy = createFrozenObservationPolicy({
    levelAtStart: observationPolicy.levelAtStart,
    runRef: parsed.runRef
  })
  if (expectedObservationPolicy.sampledSuccess !== observationPolicy.sampledSuccess) {
    throw new TypeError('run checkpoint observation policy sample is invalid')
  }

  if (parsed.status === 'completed') {
    if (parsed.completion === null || parsed.error !== null ||
      parsed.cancellationReason !== null) {
      throw new TypeError('completed run checkpoint is invalid')
    }
    const completion = parseCompletionDisposition(parsed.completion)
    const expected = completionFromTerminalOutput({
      requestKind: parsed.requestKind,
      output: parsed.output,
      visibleToolOutput: completion.kind === 'already_visible' ? 'confirmed' : 'none'
    })
    if (JSON.stringify(expected) !== JSON.stringify(completion)) {
      throw new TypeError('run completion does not match its output')
    }
  } else if (parsed.completion !== null || parsed.output !== null) {
    throw new TypeError('non-completed run terminal output is invalid')
  }
}

function validateContextPlanState (
  parsed: RunCheckpointV5 | RunCheckpointV6
): ContextPlanV1 | LegacyContextPlanV1 | null {
  const modelLoopPolicy = parseRunModelLoopPolicyV1(parsed.modelLoopPolicy)
  const toolWireSnapshot = parsed.toolWireSnapshot === null
    ? null
    : parseToolWireSnapshotV1(parsed.toolWireSnapshot)
  if ((modelLoopPolicy.kind === 'adaptive_context') !== (toolWireSnapshot !== null)) {
    throw new TypeError('run tool wire snapshot is inconsistent')
  }
  let plan: ContextPlanV1 | LegacyContextPlanV1 | null = null
  if (parsed.contextPlan !== null) {
    if (parsed.schemaVersion === 6) {
      plan = parseContextPlanV1(parsed.contextPlan)
    } else {
      try {
        plan = parseContextPlanV1(parsed.contextPlan)
      } catch {
        plan = parseLegacyContextPlanV1(parsed.contextPlan)
      }
    }
  }
  if (!Array.isArray(parsed.contextArtifactRefs) || parsed.contextArtifactRefs.length > 128 ||
    parsed.contextArtifactRefs.some(ref => typeof ref !== 'string') ||
    new Set(parsed.contextArtifactRefs).size !== parsed.contextArtifactRefs.length) {
    throw new TypeError('run context artifact references are invalid')
  }
  if (plan === null) {
    if (parsed.contextArtifactRefs.length !== 0) {
      throw new TypeError('run context plan references are inconsistent')
    }
  } else if (plan.namespaceRef !== parsed.runRef ||
    plan.messageCount !== parsed.messages.length ||
    plan.estimatedInputTokens !== parsed.estimatedInputTokens ||
    plan.estimatorVersion !== CONTEXT_TOKEN_ESTIMATOR_VERSION ||
    plan.estimatedInputTokens !== estimateModelMessagesTokens(parsed.messages) ||
    plan.serializedMessageBytes !== serializedModelMessagesBytes(parsed.messages) ||
    plan.capabilityHash !== modelCapabilityStableHash(parsed.modelCapability) ||
    plan.artifactRefs.length !== parsed.contextArtifactRefs.length ||
    plan.artifactRefs.some((ref, index) => ref !== parsed.contextArtifactRefs[index])) {
    throw new TypeError('run context plan is inconsistent')
  }
  const currentPlan = parsed.schemaVersion === 6
    ? plan as ContextPlanV1 | null
    : null
  if (currentPlan !== null && currentPlan.included.some(entry => (
    contextWireHash(Object.freeze(parsed.messages.slice(
      entry.wireStart,
      entry.wireStart + entry.wireCount
    ))) !== entry.wireHash
  ))) {
    throw new TypeError('run context plan wire is inconsistent')
  }
  return plan
}

function validatePendingContextMessages (
  value: unknown,
  profileId: string,
  profileVersion: number
): readonly ModelMessage[] {
  if (!Array.isArray(value)) throw new TypeError('pending context messages are invalid')
  validateModelMessages(value, profileId, profileVersion)
  const messages = value as readonly ModelMessage[]
  if (messages.length === 0) return Object.freeze([])
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') >
    RUN_RESOURCE_LIMITS.providerProtocolChainBytes) {
    throw new TypeError('pending context messages exceed their limit')
  }
  const assistant = messages[0]
  if (assistant?.role !== 'assistant' || assistant.toolCalls === undefined ||
    assistant.toolCalls.length === 0) {
    throw new TypeError('pending context protocol is invalid')
  }
  const results = messages.slice(1)
  if (results.length !== 0 && (results.length !== assistant.toolCalls.length ||
    results.some((message, index) => (
      message.role !== 'tool' || message.toolCallId !== assistant.toolCalls?.[index]?.callId
    )))) {
    throw new TypeError('pending context protocol is invalid')
  }
  return Object.freeze([...messages])
}

function parseLoadedRunCheckpoint (value: unknown): LoadedRunCheckpoint {
  const parsedJson = parseJsonValue(value, {
    maxBytes: RUN_RESOURCE_LIMITS.checkpointBytes + RUN_RESOURCE_LIMITS.eventBytes,
    maxDepth: 32,
    maxNodes: 32_768
  })
  const unparsed = record(parsedJson, 'run checkpoint')
  const checkpointKeys = unparsed.schemaVersion === 1
    ? CHECKPOINT_V1_KEYS
    : unparsed.schemaVersion === 2
      ? CHECKPOINT_V2_KEYS
      : unparsed.schemaVersion === 3
        ? CHECKPOINT_V3_KEYS
        : unparsed.schemaVersion === 4
          ? CHECKPOINT_V4_KEYS
          : unparsed.schemaVersion === 5
            ? CHECKPOINT_V5_KEYS
            : unparsed.schemaVersion === 6
              ? CHECKPOINT_V6_KEYS
          : undefined
  if (checkpointKeys === undefined) throw new TypeError('run checkpoint schema version is invalid')
  exactKeys(unparsed, checkpointKeys, checkpointKeys, 'checkpoint')
  if (!Array.isArray(unparsed.events)) throw new TypeError('run checkpoint events are invalid')
  if (unparsed.events.length > RUN_RESOURCE_LIMITS.eventCount) {
    throw new TypeError('run event count limit exceeded')
  }
  const parsed = unparsed as unknown as LoadedRunCheckpoint
  const reasoningSegments = parsed.schemaVersion === 3 || parsed.schemaVersion === 4 ||
    parsed.schemaVersion === 5 || parsed.schemaVersion === 6
    ? parseRunReasoningSegments(parsed.reasoningSegments)
    : undefined
  const split = splitCheckpoint(parsed)
  if (jsonBytes(split.state) > RUN_RESOURCE_LIMITS.checkpointBytes) {
    throw new TypeError('run checkpoint byte limit exceeded')
  }
  if (jsonBytes(split.events) > RUN_RESOURCE_LIMITS.eventBytes) {
    throw new TypeError('run event byte limit exceeded')
  }
  if (parsed.kernelVersion !== 1 ||
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
  validateBudgets(
    parsed.budgetLimits,
    parsed.budgetCounters,
    parsed.schemaVersion === 5 || parsed.schemaVersion === 6
      ? parsed.modelLoopPolicy
      : undefined
  )
  if (typeof parsed.recoveryUsed !== 'boolean' || typeof parsed.forceCorrection !== 'boolean' ||
    (parsed.schemaVersion === 1 && typeof parsed.visibleOutput !== 'boolean')) {
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
  if (parsed.schemaVersion === 1) {
    if (parsed.status === 'completed' &&
      ((parsed.output === null && !parsed.visibleOutput) || parsed.error !== null ||
        parsed.cancellationReason !== null)) {
      throw new TypeError('completed run checkpoint is invalid')
    }
  } else {
    validateCheckpointV2OrLater(parsed)
  }
  if (parsed.schemaVersion === 4 || parsed.schemaVersion === 5 || parsed.schemaVersion === 6) {
    const capability = parseModelCapabilitySnapshot(parsed.modelCapability)
    const price = parsed.modelPrice === null ? null : parseModelPriceSnapshot(parsed.modelPrice)
    parseRunUsageSummary(parsed.usage)
    if ((capability.priceCatalogVersion === null) !== (price === null) ||
      (price !== null && price.catalogVersion !== capability.priceCatalogVersion)) {
      throw new TypeError('run model price catalog is inconsistent')
    }
  }
  const contextPlan = parsed.schemaVersion === 5 || parsed.schemaVersion === 6
    ? validateContextPlanState(parsed)
    : null
  const currentContextPlan = parsed.schemaVersion === 6
    ? contextPlan as ContextPlanV1 | null
    : null
  let pendingContextMessages: readonly ModelMessage[] | undefined
  let providerGeneration: FrozenProviderGenerationV1 | null | undefined
  if (parsed.schemaVersion === 6) {
    if (parsed.contextRuntimeMode !== 'legacy_compatible' &&
      parsed.contextRuntimeMode !== 'generation_planner') {
      throw new TypeError('run context runtime mode is invalid')
    }
    pendingContextMessages = validatePendingContextMessages(
      parsed.pendingContextMessages,
      parsed.profileId,
      parsed.profileVersion
    )
    providerGeneration = parsed.providerGeneration === null
      ? null
      : parseFrozenProviderGenerationV1(parsed.providerGeneration)
    const modelTurnKind = parsed.modelTurn?.kind ?? null
    if ((parsed.status === 'correcting') !== (modelTurnKind === 'correction') ||
      (modelTurnKind === 'normal' && parsed.status !== 'calling_model') ||
      (modelTurnKind === null && parsed.status === 'correcting') ||
      (parsed.status !== 'calling_model' && parsed.status !== 'correcting' &&
        modelTurnKind !== null) ||
      (parsed.providerDispatch.state === 'reserved' && modelTurnKind === null)) {
      throw new TypeError('run provider dispatch state matrix is invalid')
    }
    if (parsed.contextRuntimeMode === 'legacy_compatible') {
      if (pendingContextMessages.length !== 0 || providerGeneration !== null) {
        throw new TypeError('legacy context runtime state is invalid')
      }
    } else {
      if (parsed.modelLoopPolicy.kind !== 'adaptive_context') {
        throw new TypeError('generation planner requires adaptive context')
      }
      if (providerGeneration !== null && (currentContextPlan === null ||
        providerGeneration.planHash !== currentContextPlan.planHash ||
        providerGeneration.generation !== currentContextPlan.generation ||
        (parsed.modelTurn?.kind === 'correction' && providerGeneration.kind !== 'correction') ||
        (parsed.modelTurn?.kind === 'normal' && providerGeneration.kind === 'correction'))) {
        throw new TypeError('provider generation does not match context plan')
      }
      if (parsed.modelTurn !== null && providerGeneration === null) {
        throw new TypeError('reserved model turn lacks provider generation')
      }
    }
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
  if (parsed.schemaVersion === 6) {
    return Object.freeze({
      ...parsed,
      reasoningSegments,
      modelCapability: parseModelCapabilitySnapshot(parsed.modelCapability),
      modelPrice: parsed.modelPrice === null
        ? null
        : parseModelPriceSnapshot(parsed.modelPrice),
      usage: parseRunUsageSummary(parsed.usage),
      modelLoopPolicy: parseRunModelLoopPolicyV1(parsed.modelLoopPolicy),
      toolWireSnapshot: parsed.toolWireSnapshot === null
        ? null
        : parseToolWireSnapshotV1(parsed.toolWireSnapshot),
      contextPlan: currentContextPlan,
      contextArtifactRefs: Object.freeze([...parsed.contextArtifactRefs]),
      pendingContextMessages: pendingContextMessages as readonly ModelMessage[],
      providerGeneration
    }) as RunCheckpointV6
  }
  if (parsed.schemaVersion === 5) {
    return Object.freeze({
      ...parsed,
      reasoningSegments,
      modelCapability: parseModelCapabilitySnapshot(parsed.modelCapability),
      modelPrice: parsed.modelPrice === null
        ? null
        : parseModelPriceSnapshot(parsed.modelPrice),
      usage: parseRunUsageSummary(parsed.usage),
      modelLoopPolicy: parseRunModelLoopPolicyV1(parsed.modelLoopPolicy),
      toolWireSnapshot: parsed.toolWireSnapshot === null
        ? null
        : parseToolWireSnapshotV1(parsed.toolWireSnapshot),
      contextPlan,
      contextArtifactRefs: Object.freeze([...parsed.contextArtifactRefs])
    }) as RunCheckpointV5
  }
  if (parsed.schemaVersion === 4) {
    return Object.freeze({
      ...parsed,
      reasoningSegments,
      modelCapability: parseModelCapabilitySnapshot(parsed.modelCapability),
      modelPrice: parsed.modelPrice === null
        ? null
        : parseModelPriceSnapshot(parsed.modelPrice),
      usage: parseRunUsageSummary(parsed.usage)
    }) as RunCheckpointV4
  }
  return parsed.schemaVersion === 3
    ? Object.freeze({ ...parsed, reasoningSegments }) as RunCheckpointV3
    : parsed
}

export function parseRunCheckpoint (value: unknown): RunCheckpoint {
  const parsed = parseLoadedRunCheckpoint(value)
  if (parsed.schemaVersion !== 6) {
    throw new TypeError('runtime run checkpoint must use schema version 6')
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
  const requestIdentityFields = [
    input.runRef,
    input.requestRef,
    input.requestKind,
    input.presentationRoute,
    input.observationPolicy
  ]
  const hasLegacyIdentity = requestIdentityFields.every(value => value === undefined)
  const hasCompleteIdentity = requestIdentityFields.every(value => value !== undefined)
  if (!hasLegacyIdentity && !hasCompleteIdentity) {
    throw new TypeError('initial run checkpoint request identity is invalid')
  }
  // Pre-v2 offline callers have no trustworthy entry intent. Preserve only the
  // all-missing tuple as an isolated legacy checkpoint; partial identity fails closed.
  const runRef = input.runRef ?? createHash('sha256')
    .update(`groupmate:legacy-run:v1:${input.runId}`, 'ascii')
    .digest('hex')
    .slice(0, 32)
  const requestRef = input.requestRef ?? createHash('sha256')
    .update(`groupmate:legacy-request:v1:${input.runId}`, 'ascii')
    .digest('hex')
    .slice(0, 32)
  const requestKind = input.requestKind ?? 'legacy_unknown'
  const presentationRoute = input.presentationRoute ?? null
  const observationPolicy = input.observationPolicy ?? Object.freeze({
    schemaVersion: 1 as const,
    levelAtStart: 'off' as const,
    sampledSuccess: false
  })
  const modelLoopPolicy = input.modelLoopPolicy ?? ADAPTIVE_CONTEXT_LOOP_POLICY
  const contextRuntimeMode = input.contextRuntimeMode ?? (
    modelLoopPolicy.kind === 'adaptive_context'
      ? 'generation_planner'
      : 'legacy_compatible'
  )
  if (contextRuntimeMode === 'generation_planner' &&
    modelLoopPolicy.kind !== 'adaptive_context') {
    throw new TypeError('generation planner requires adaptive context')
  }
  timestamp(input.deadlineAt, 'run deadline')
  timestamp(input.createdAt, 'run creation time')
  validateEvents([input.event], 0, input.runId, input.sessionId)
  return freezeCheckpoint({
    schemaVersion: 6,
    kernelVersion: 1,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    runId: input.runId,
    sessionId: input.sessionId,
    sessionAddress: input.sessionAddress,
    runRef,
    requestRef,
    requestKind,
    presentationRoute,
    revision: 0,
    status: 'created',
    step: 0,
    model: input.model,
    modelCapability: input.modelCapability,
    modelPrice: input.modelPrice,
    usage: createInitialRunUsageSummary(),
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    modelTurn: null,
    toolSnapshot: input.toolSnapshot,
    toolLedgers: Object.freeze([]),
    preparedBatch: null,
    interruption: null,
    approvalHistory: Object.freeze([]),
    budgetLimits: input.budgetLimits,
    modelLoopPolicy,
    contextPlan: input.contextPlan ?? null,
    contextArtifactRefs: Object.freeze([...(input.contextArtifactRefs ?? [])]),
    toolWireSnapshot: input.toolWireSnapshot === undefined
      ? createToolWireSnapshotV1(Object.freeze([]))
      : input.toolWireSnapshot,
    contextRuntimeMode,
    pendingContextMessages: Object.freeze([]),
    providerGeneration: null,
    budgetCounters: input.budgetCounters,
    recoveryUsed: false,
    forceCorrection: false,
    reasoningSegments: Object.freeze([]),
    output: null,
    completion: null,
    observationCounters: createInitialRunObservationCounters(),
    providerDispatch: Object.freeze({ state: 'idle' }),
    engineActivity: Object.freeze({ state: 'idle' }),
    observationPolicy,
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
  if (checkpoint.status !== status) assertRunTransition(checkpoint.status, status)
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

const CHECKPOINT_V1_STATE_KEYS = Object.freeze(
  CHECKPOINT_V1_KEYS.filter(key => key !== 'events')
)
const CHECKPOINT_V2_STATE_KEYS = Object.freeze(
  CHECKPOINT_V2_KEYS.filter(key => key !== 'events')
)
const CHECKPOINT_V3_STATE_KEYS = Object.freeze(
  CHECKPOINT_V3_KEYS.filter(key => key !== 'events')
)
const CHECKPOINT_V4_STATE_KEYS = Object.freeze(
  CHECKPOINT_V4_KEYS.filter(key => key !== 'events')
)
const CHECKPOINT_V5_STATE_KEYS = Object.freeze(
  CHECKPOINT_V5_KEYS.filter(key => key !== 'events')
)
const CHECKPOINT_V6_STATE_KEYS = Object.freeze(
  CHECKPOINT_V6_KEYS.filter(key => key !== 'events')
)
const EVENT_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'revision', 'events'
])

export interface EncodedRunCheckpoint {
  readonly checkpoint: string
  readonly events: string
}

interface RunEventEnvelope {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6
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
      schemaVersion: 6,
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

  decode (checkpointRaw: string, eventsRaw: string): LoadedRunCheckpoint {
    const state = record(
      parseJsonText(checkpointRaw, 'run checkpoint', RUN_RESOURCE_LIMITS.checkpointBytes),
      'run checkpoint state'
    )
    const checkpointKeys = state.schemaVersion === 1
      ? CHECKPOINT_V1_STATE_KEYS
      : state.schemaVersion === 2
        ? CHECKPOINT_V2_STATE_KEYS
        : state.schemaVersion === 3
          ? CHECKPOINT_V3_STATE_KEYS
          : state.schemaVersion === 4
            ? CHECKPOINT_V4_STATE_KEYS
            : state.schemaVersion === 5
              ? CHECKPOINT_V5_STATE_KEYS
              : state.schemaVersion === 6
                ? CHECKPOINT_V6_STATE_KEYS
            : undefined
    if (checkpointKeys === undefined) {
      throw new TypeError('run checkpoint schema version is invalid')
    }
    exactKeys(state, checkpointKeys, checkpointKeys, 'checkpoint')
    const envelope = record(
      parseJsonText(eventsRaw, 'run event', RUN_RESOURCE_LIMITS.eventBytes),
      'run event envelope'
    )
    exactKeys(envelope, EVENT_ENVELOPE_KEYS, EVENT_ENVELOPE_KEYS, 'event envelope')
    if (envelope.schemaVersion !== state.schemaVersion ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision !== state.revision || !Array.isArray(envelope.events)) {
      throw new TypeError('run event envelope is invalid')
    }
    return parseLoadedRunCheckpoint({
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
