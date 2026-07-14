import { performance } from 'node:perf_hooks'
import type { AgentMessage } from '../contracts/content.js'
import {
  AgentError,
  serializeAgentError,
  type SerializedAgentError
} from '../contracts/error.js'
import type { AgentEvent, AgentEventType } from '../contracts/event.js'
import type { RunAdvanceResult } from '../contracts/result.js'
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelTurn
} from '../model/model-adapter.js'
import { ModelProviderError, modelProtocolError } from '../model/model-adapter.js'
import type { JsonObject } from '../model/json-value.js'
import type { OpenAICompatibleProfile } from '../model/openai-compatible-profile.js'
import type { ToolExecutionContext, ToolPreparationContext } from '../tools/tool-context.js'
import type { ToolCall } from '../tools/tool-call.js'
import { completedPreparedCall } from '../tools/prepared-capability.js'
import type { SerializablePreparedCapability } from '../tools/prepared-capability.js'
import type { ToolSnapshot } from '../tools/tool-registry.js'
import { parseToolResult, type ToolResult } from '../tools/tool-result.js'
import type { ApprovalActorRole, ApprovalInterruption } from './interruption.js'
import type { RunBudget, RunBudgetCounters } from './run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type ReservedModelTurn,
  type RunCheckpoint,
  type RunCheckpointChanges,
  type RunModelConfig
} from './run-checkpoint.js'
import { createRunEvent } from './run-events.js'
import { isTerminalRunStatus, type RunStatus } from './run-state.js'
import { RunStoreConflictError, type RunStore } from './run-store.js'
import {
  applyToolPreflight,
  cancelToolExecutionLedger,
  completeToolExecutionLedger,
  createToolExecutionLedger,
  failToolExecutionLedger,
  toolLedgerHasIndeterminate,
  toolLedgerHasVisibleOutput,
  toolLedgerModelMessages,
  type ToolExecutionLedger
} from './tool-ledger.js'
import {
  type PreparedToolBatch,
  type ToolScheduler
} from './tool-scheduler.js'

export interface PreparedRunContext {
  readonly messages: readonly ModelMessage[]
  readonly estimatedInputTokens: number
}

export interface RunRuntimeBinding {
  readonly snapshot: ToolSnapshot
  prepareContext(signal: AbortSignal): Promise<PreparedRunContext>
  prepareToolContext(
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<ToolPreparationContext>
  contextFor(
    capability: SerializablePreparedCapability,
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<ToolExecutionContext>
  recoverContext?(
    checkpoint: RunCheckpoint,
    error: ModelProviderError,
    signal: AbortSignal
  ): Promise<PreparedRunContext | undefined>
}

export interface StartRunInput {
  readonly runId: string
  readonly sessionId: string
  readonly deadlineAt: string
  readonly model: RunModelConfig
  readonly runtime: RunRuntimeBinding
}

export interface RunControlOptions {
  readonly signal?: AbortSignal
}

export interface RunEngineOptions {
  readonly adapter: ModelAdapter
  readonly profile: OpenAICompatibleProfile
  readonly scheduler: ToolScheduler
  readonly store: RunStore
  readonly budget: RunBudget
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly observer?: (event: AgentEvent) => void | Promise<void>
}

interface EventDraft {
  readonly type: AgentEventType
  readonly payload?: AgentEvent['payload']
}

interface ModelAttemptResult {
  readonly turn: ModelTurn
  readonly counters: RunBudgetCounters
  readonly messages: readonly ModelMessage[]
  readonly estimatedInputTokens: number
  readonly recoveryUsed: boolean
}

class ModelAttemptFailure extends Error {
  readonly agentError: AgentError
  readonly counters: RunBudgetCounters
  readonly messages: readonly ModelMessage[]
  readonly estimatedInputTokens: number
  readonly recoveryUsed: boolean

  constructor (
    agentError: AgentError,
    state: Omit<ModelAttemptResult, 'turn'>
  ) {
    super('model attempt failed', { cause: agentError })
    this.name = 'ModelAttemptFailure'
    this.agentError = agentError
    this.counters = state.counters
    this.messages = state.messages
    this.estimatedInputTokens = state.estimatedInputTokens
    this.recoveryUsed = state.recoveryUsed
  }
}

class RunAbortedError extends Error {
  constructor () {
    super('run was aborted')
    this.name = 'RunAbortedError'
  }
}

const EMPTY_PAYLOAD = Object.freeze({})

function internalError (cause?: unknown): AgentError {
  return new AgentError({
    code: 'internal_error',
    stage: 'run.engine',
    retryable: false,
    userMessage: '处理请求时出现异常，请稍后重试。',
    cause
  })
}

function checkpointConflict (cause?: unknown): AgentError {
  return new AgentError({
    code: 'checkpoint_conflict',
    stage: 'run.checkpoint',
    retryable: false,
    userMessage: '任务状态已发生变化，请重新发起。',
    cause
  })
}

function toolOutcomeUnknown (): AgentError {
  return new AgentError({
    code: 'tool_outcome_unknown',
    stage: 'tool.execute',
    retryable: false,
    userMessage: '操作结果暂时无法确认，请先核实后再试。'
  })
}

function boundedCancellationReason (reason: string): string {
  const normalized = typeof reason === 'string' ? reason.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : 'user_cancelled'
}

function isAbortError (error: unknown): boolean {
  return error instanceof RunAbortedError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
}

function estimatedTokensFor (value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4))
}

function terminalResult (checkpoint: RunCheckpoint): RunAdvanceResult {
  if (checkpoint.status === 'completed') {
    return Object.freeze({
      kind: 'completed',
      runId: checkpoint.runId,
      output: checkpoint.output,
      visibleOutput: checkpoint.visibleOutput
    })
  }
  if (checkpoint.status === 'failed' && checkpoint.error !== null) {
    return Object.freeze({
      kind: 'failed',
      runId: checkpoint.runId,
      error: checkpoint.error
    })
  }
  if (checkpoint.status === 'cancelled' && checkpoint.cancellationReason !== null) {
    return Object.freeze({
      kind: 'cancelled',
      runId: checkpoint.runId,
      reason: checkpoint.cancellationReason
    })
  }
  if (checkpoint.status === 'waiting_approval' && checkpoint.interruption !== null) {
    return Object.freeze({
      kind: 'paused',
      runId: checkpoint.runId,
      interruption: checkpoint.interruption
    })
  }
  throw new TypeError('run checkpoint does not contain a terminal result')
}

function modelTools (snapshot: ToolSnapshot): ModelRequest['tools'] {
  return Object.freeze(snapshot.modelTools.map(tool => Object.freeze({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as unknown as JsonObject
  })))
}

function failedToolResult (message = '工具调用已超过本次任务的资源上限。'): ToolResult {
  return parseToolResult({
    status: 'failed',
    effect: 'none',
    errorCode: 'tool_execution_failed',
    userMessage: message,
    retryable: false
  })
}

function completedBatchFromLedger (ledger: ToolExecutionLedger): PreparedToolBatch {
  return Object.freeze({
    schemaVersion: 1,
    calls: Object.freeze(ledger.calls.map(call => {
      if (call.result === null) throw new TypeError('failed tool ledger result is missing')
      return completedPreparedCall(call.callId, call.toolName, call.result)
    }))
  })
}

function actorRole (context: ToolPreparationContext): ApprovalActorRole {
  if (context.facts.actor.isBotMaster) return 'bot_master'
  if (context.facts.actorGroupRole === 'owner') return 'group_owner'
  if (context.facts.actorGroupRole === 'admin') return 'group_admin'
  return 'member'
}

function targetLabel (capability: SerializablePreparedCapability): string {
  switch (capability.target.kind) {
    case 'none': return 'current_context'
    case 'private': return 'private_user'
    case 'group': return 'group'
    case 'member': return 'group_member'
    case 'message': return 'group_message'
  }
}

function asAgentError (error: unknown): AgentError {
  if (error instanceof AgentError) return error
  if (error instanceof RunStoreConflictError) return checkpointConflict(error)
  return internalError(error)
}

export class RunEngine {
  readonly #adapter: ModelAdapter
  readonly #profile: OpenAICompatibleProfile
  readonly #scheduler: ToolScheduler
  readonly #store: RunStore
  readonly #budget: RunBudget
  readonly #now: () => Date
  readonly #generateId: () => string
  readonly #observer?: (event: AgentEvent) => void | Promise<void>
  readonly #runtimeBindings = new Map<string, RunRuntimeBinding>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #startedToolCalls = new Map<string, Set<string>>()

  constructor (options: RunEngineOptions) {
    this.#adapter = options.adapter
    this.#profile = options.profile
    this.#scheduler = options.scheduler
    this.#store = options.store
    this.#budget = options.budget
    this.#now = options.now ?? (() => new Date())
    this.#generateId = options.generateId ?? (() => crypto.randomUUID())
    this.#observer = options.observer
  }

  async start (
    input: StartRunInput,
    options: RunControlOptions = {}
  ): Promise<RunAdvanceResult> {
    const createdAt = this.#timestamp()
    const event = createRunEvent({
      eventId: this.#generateId(),
      runId: input.runId,
      sessionId: input.sessionId,
      sequence: 0,
      occurredAt: createdAt,
      type: 'run.created',
      payload: EMPTY_PAYLOAD
    })
    const model: RunModelConfig = Object.freeze({
      model: input.model.model,
      streaming: input.model.streaming,
      maxOutputTokens: input.model.maxOutputTokens,
      reasoning: Object.freeze({
        enabled: input.model.reasoning.enabled,
        ...(input.model.reasoning.effort === undefined
          ? {}
          : { effort: input.model.reasoning.effort })
      }),
      ...(input.model.temperature === undefined ? {} : { temperature: input.model.temperature }),
      ...(input.model.topP === undefined ? {} : { topP: input.model.topP })
    })
    const checkpoint = createInitialRunCheckpoint({
      profileId: this.#profile.id,
      profileVersion: this.#profile.version,
      runId: input.runId,
      sessionId: input.sessionId,
      model,
      toolSnapshot: Object.freeze({
        id: input.runtime.snapshot.id,
        fingerprint: input.runtime.snapshot.fingerprint,
        manifest: input.runtime.snapshot.manifest
      }),
      budgetLimits: this.#budget.limits,
      budgetCounters: this.#budget.initialCounters,
      deadlineAt: input.deadlineAt,
      createdAt,
      event
    })

    let stored: RunCheckpoint
    try {
      stored = await this.#store.create(checkpoint)
    } catch (error) {
      return Object.freeze({
        kind: 'failed',
        runId: input.runId,
        error: serializeAgentError(asAgentError(error))
      })
    }
    this.#notify(event)
    this.#runtimeBindings.set(input.runId, input.runtime)
    const controller = new AbortController()
    this.#controllers.set(input.runId, controller)
    const detach = this.#linkExternalSignal(options.signal, controller)
    const timer = this.#deadlineTimer(stored, controller)
    try {
      if (this.#deadlineExpired(stored)) {
        return await this.cancel(input.runId, 'deadline_exceeded')
      }
      return await this.#drive(stored, controller)
    } finally {
      detach()
      if (timer !== undefined) clearTimeout(timer)
      const latest = await this.#store.load(input.runId).catch(() => null)
      if (latest !== null && isTerminalRunStatus(latest.status)) {
        this.#runtimeBindings.delete(input.runId)
        this.#startedToolCalls.delete(input.runId)
        if (this.#controllers.get(input.runId) === controller) {
          this.#controllers.delete(input.runId)
        }
      }
    }
  }

  async resume (
    runId: string,
    runtime?: RunRuntimeBinding,
    options: RunControlOptions = {}
  ): Promise<RunAdvanceResult> {
    if (runtime !== undefined) this.#runtimeBindings.set(runId, runtime)
    const checkpoint = await this.#store.load(runId)
    if (checkpoint === null) {
      return Object.freeze({
        kind: 'failed',
        runId,
        error: serializeAgentError(new AgentError({
          code: 'checkpoint_invalid',
          stage: 'run.resume',
          retryable: false,
          userMessage: '任务状态不存在或已失效。'
        }))
      })
    }
    if (isTerminalRunStatus(checkpoint.status) || checkpoint.status === 'waiting_approval') {
      return terminalResult(checkpoint)
    }
    const controller = this.#controllers.get(runId) ?? new AbortController()
    this.#controllers.set(runId, controller)
    const detach = this.#linkExternalSignal(options.signal, controller)
    const timer = this.#deadlineTimer(checkpoint, controller)
    try {
      return await this.#drive(checkpoint, controller)
    } finally {
      detach()
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async cancel (runId: string, reason = 'user_cancelled'): Promise<RunAdvanceResult> {
    const cancellationReason = boundedCancellationReason(reason)
    this.#controllers.get(runId)?.abort(cancellationReason)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const checkpoint = await this.#store.load(runId)
      if (checkpoint === null) {
        return Object.freeze({ kind: 'cancelled', runId, reason: cancellationReason })
      }
      if (isTerminalRunStatus(checkpoint.status)) return terminalResult(checkpoint)
      const started = this.#startedToolCalls.get(runId) ?? new Set<string>()
      const ledgers = checkpoint.toolLedgers.map((ledger, index, all) => (
        index === all.length - 1
          ? cancelToolExecutionLedger(ledger, started)
          : ledger
      ))
      const next = this.#next(checkpoint, 'cancelled', {
        toolLedgers: Object.freeze(ledgers),
        preparedBatch: null,
        interruption: null,
        modelTurn: null,
        cancellationReason
      }, [{ type: 'run.cancelled', payload: { reason: cancellationReason } }])
      try {
        const stored = await this.#store.compareAndSet(checkpoint, next)
        this.#notifyNewEvents(checkpoint, stored)
        return terminalResult(stored)
      } catch (error) {
        if (!(error instanceof RunStoreConflictError)) throw error
      }
    }
    return Object.freeze({
      kind: 'failed',
      runId,
      error: serializeAgentError(checkpointConflict())
    })
  }

  async #drive (
    initial: RunCheckpoint,
    controller: AbortController
  ): Promise<RunAdvanceResult> {
    let checkpoint = initial
    while (!isTerminalRunStatus(checkpoint.status)) {
      if (checkpoint.status === 'waiting_approval') return terminalResult(checkpoint)
      if (controller.signal.aborted) {
        return await this.cancel(
          checkpoint.runId,
          this.#signalCancellationReason(controller.signal)
        )
      }
      if (this.#deadlineExpired(checkpoint)) {
        return await this.cancel(checkpoint.runId, 'deadline_exceeded')
      }
      try {
        checkpoint = await this.#advance(checkpoint, controller.signal)
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return await this.cancel(
            checkpoint.runId,
            this.#signalCancellationReason(controller.signal)
          )
        }
        checkpoint = await this.#fail(checkpoint, asAgentError(error))
      }
    }
    return terminalResult(checkpoint)
  }

  async #advance (
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<RunCheckpoint> {
    this.#assertNotAborted(signal)
    switch (checkpoint.status) {
      case 'created': return await this.#prepare(checkpoint, signal)
      case 'preparing': return await this.#reserveNormalTurn(checkpoint)
      case 'calling_model': return checkpoint.visibleOutput
        ? await this.#completeVisibleOutput(checkpoint)
        : checkpoint.modelTurn === null
          ? await this.#beginCorrection(checkpoint)
          : await this.#callModel(checkpoint, signal, false)
      case 'evaluating_tools': return await this.#preflightTools(checkpoint, signal)
      case 'executing_tools': return await this.#executeTools(checkpoint, signal)
      case 'correcting': return await this.#callModel(checkpoint, signal, true)
      default: throw new TypeError(`run state ${checkpoint.status} cannot be advanced`)
    }
  }

  async #prepare (
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<RunCheckpoint> {
    const runtime = this.#runtime(checkpoint.runId)
    const context = await this.#raceAbort(runtime.prepareContext(signal), signal)
    if (!Number.isSafeInteger(context.estimatedInputTokens) ||
      context.estimatedInputTokens < 0 || !Array.isArray(context.messages)) {
      throw new TypeError('prepared run context is invalid')
    }
    return await this.#commit(checkpoint, 'preparing', {
      messages: Object.freeze([...context.messages]),
      estimatedInputTokens: context.estimatedInputTokens
    }, [
      { type: 'run.started' },
      {
        type: 'context.prepared',
        payload: {
          messageCount: context.messages.length,
          estimatedInputTokens: context.estimatedInputTokens
        }
      }
    ])
  }

  async #reserveNormalTurn (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    const reservation = this.#reserveModelTurn(checkpoint, 'normal')
    return await this.#commit(checkpoint, 'calling_model', {
      budgetCounters: reservation.counters,
      modelTurn: reservation.turn
    }, [{
      type: 'model.started',
      payload: { kind: 'normal', turn: reservation.counters.modelTurns }
    }])
  }

  async #beginCorrection (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    let counters = this.#budget.recordCorrection(checkpoint.budgetCounters)
    const maxOutputTokens = this.#availableOutputTokens(checkpoint, counters)
    counters = this.#budget.reserveModelTurn(counters, {
      kind: 'correction',
      estimatedInputTokens: checkpoint.estimatedInputTokens,
      maxOutputTokens
    })
    return await this.#commit(checkpoint, 'correcting', {
      budgetCounters: counters,
      modelTurn: Object.freeze({ kind: 'correction', maxOutputTokens })
    }, [{
      type: 'model.started',
      payload: { kind: 'correction', turn: counters.modelTurns }
    }])
  }

  #reserveModelTurn (
    checkpoint: RunCheckpoint,
    kind: 'normal' | 'correction'
  ): { readonly counters: RunBudgetCounters; readonly turn: ReservedModelTurn } {
    const maxOutputTokens = this.#availableOutputTokens(checkpoint, checkpoint.budgetCounters)
    const counters = this.#budget.reserveModelTurn(checkpoint.budgetCounters, {
      kind,
      estimatedInputTokens: checkpoint.estimatedInputTokens,
      maxOutputTokens
    })
    return Object.freeze({
      counters,
      turn: Object.freeze({ kind, maxOutputTokens })
    })
  }

  #availableOutputTokens (
    checkpoint: RunCheckpoint,
    counters: RunBudgetCounters
  ): number {
    const remaining = checkpoint.budgetLimits.maxEstimatedTokens -
      counters.estimatedTokens - checkpoint.estimatedInputTokens
    return Math.min(checkpoint.model.maxOutputTokens, Math.max(1, remaining))
  }

  async #callModel (
    checkpoint: RunCheckpoint,
    signal: AbortSignal,
    correction: boolean
  ): Promise<RunCheckpoint> {
    const reserved = checkpoint.modelTurn
    if (reserved === null || reserved.kind !== (correction ? 'correction' : 'normal')) {
      throw new TypeError('reserved model turn does not match run state')
    }
    let attempted: ModelAttemptResult
    try {
      attempted = await this.#attemptModel(checkpoint, reserved, signal, correction)
    } catch (error) {
      if (!(error instanceof ModelAttemptFailure)) throw error
      return await this.#fail(checkpoint, error.agentError, [], {
        budgetCounters: error.counters,
        messages: error.messages,
        estimatedInputTokens: error.estimatedInputTokens,
        recoveryUsed: error.recoveryUsed,
        modelTurn: null
      })
    }
    return await this.#evaluateModelTurn(checkpoint, attempted, correction)
  }

  async #attemptModel (
    checkpoint: RunCheckpoint,
    reserved: ReservedModelTurn,
    signal: AbortSignal,
    correction: boolean
  ): Promise<ModelAttemptResult> {
    const runtime = this.#runtime(checkpoint.runId)
    this.#assertSnapshot(checkpoint, runtime.snapshot)
    let counters = checkpoint.budgetCounters
    let messages = checkpoint.messages
    let estimatedInputTokens = checkpoint.estimatedInputTokens
    let recoveryUsed = checkpoint.recoveryUsed

    try {
      while (true) {
        const request: ModelRequest = Object.freeze({
          model: checkpoint.model.model,
          messages,
          tools: correction ? Object.freeze([]) : modelTools(runtime.snapshot),
          toolMode: correction ? 'disabled' : 'auto',
          streaming: checkpoint.model.streaming,
          maxOutputTokens: reserved.maxOutputTokens,
          reasoning: checkpoint.model.reasoning,
          ...(checkpoint.model.temperature === undefined
            ? {}
            : { temperature: checkpoint.model.temperature }),
          ...(checkpoint.model.topP === undefined ? {} : { topP: checkpoint.model.topP })
        })
        const startedAt = performance.now()
        let turn: ModelTurn
        try {
          const timeoutMs = this.#providerTimeout(checkpoint, counters)
          turn = await this.#providerCall(request, signal, timeoutMs)
        } catch (error) {
          if (isAbortError(error) || signal.aborted) throw new RunAbortedError()
          const activeRuntimeMs = Math.max(0, Math.ceil(performance.now() - startedAt))
          counters = this.#budget.recordUsage(counters, { activeRuntimeMs })
          if (error instanceof ModelProviderError) {
            const recoveryHint = this.#profile.recoveryHint(error)
            const recoveryAllowed = reserved.kind === 'normal' &&
              checkpoint.budgetCounters.modelTurns === 1 &&
              checkpoint.step === 0 &&
              checkpoint.toolLedgers.length === 0 &&
              counters.recoveryAttempts < checkpoint.budgetLimits.maxRecoveryAttempts
            if (recoveryHint === 'drop_optional_context_once' && recoveryAllowed &&
              !recoveryUsed && runtime.recoverContext !== undefined) {
              const recovered = await this.#raceAbort(
                runtime.recoverContext(checkpoint, error, signal),
                signal
              )
              if (recovered !== undefined) {
                if (!Number.isSafeInteger(recovered.estimatedInputTokens) ||
                  recovered.estimatedInputTokens < 0 || !Array.isArray(recovered.messages)) {
                  throw new TypeError('recovered run context is invalid')
                }
                counters = this.#budget.recordRecovery(counters)
                recoveryUsed = true
                messages = Object.freeze([...recovered.messages])
                estimatedInputTokens = recovered.estimatedInputTokens
                continue
              }
            }
            if (error.retryable &&
              counters.providerRetries < checkpoint.budgetLimits.maxProviderRetries) {
              counters = this.#budget.recordProviderRetry(counters)
              continue
            }
            throw error
          }
          throw internalError(error)
        }
        const activeRuntimeMs = Math.max(0, Math.ceil(performance.now() - startedAt))
        counters = this.#budget.recordUsage(counters, {
          activeRuntimeMs,
          providerReportedTokens: turn.usage?.totalTokens ?? 0
        })
        return Object.freeze({
          turn,
          counters,
          messages,
          estimatedInputTokens,
          recoveryUsed
        })
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw new RunAbortedError()
      throw new ModelAttemptFailure(asAgentError(error), {
        counters,
        messages,
        estimatedInputTokens,
        recoveryUsed
      })
    }
  }

  async #evaluateModelTurn (
    checkpoint: RunCheckpoint,
    attempted: ModelAttemptResult,
    correction: boolean
  ): Promise<RunCheckpoint> {
    const { turn } = attempted
    const completedEvent: EventDraft = {
      type: 'model.completed',
      payload: {
        kind: correction ? 'correction' : 'normal',
        finishReason: turn.finishReason,
        toolCallCount: turn.toolCalls.length
      }
    }
    if (turn.refusal !== undefined && turn.refusal.length > 0) {
      return await this.#fail(checkpoint, modelProtocolError('provider_refusal'), [completedEvent], {
        budgetCounters: attempted.counters,
        messages: attempted.messages,
        estimatedInputTokens: attempted.estimatedInputTokens,
        recoveryUsed: attempted.recoveryUsed,
        modelTurn: null
      }, { reason: 'provider_refusal' })
    }

    if (turn.toolCalls.length > 0) {
      if (correction || turn.finishReason !== 'tool_calls') {
        return await this.#fail(checkpoint, modelProtocolError(
          correction ? 'correction_contains_tool_calls' : 'tool_calls_finish_reason_missing'
        ), [completedEvent], {
          budgetCounters: attempted.counters,
          messages: attempted.messages,
          estimatedInputTokens: attempted.estimatedInputTokens,
          recoveryUsed: attempted.recoveryUsed,
          modelTurn: null
        })
      }
      let ledger: ToolExecutionLedger
      try {
        ledger = createToolExecutionLedger(checkpoint.step, turn.toolCalls)
      } catch {
        return await this.#fail(checkpoint, modelProtocolError('invalid_tool_call_identity'), [completedEvent], {
          budgetCounters: attempted.counters,
          messages: attempted.messages,
          estimatedInputTokens: attempted.estimatedInputTokens,
          recoveryUsed: attempted.recoveryUsed,
          modelTurn: null
        })
      }
      const sortedCalls = [...turn.toolCalls].sort((left, right) => left.index - right.index)
      const assistant: ModelMessage = Object.freeze({
        role: 'assistant',
        content: turn.text.length === 0 ? null : turn.text,
        toolCalls: Object.freeze(sortedCalls.map(call => Object.freeze({
          callId: call.callId,
          name: call.name,
          arguments: call.arguments
        }))),
        ...(turn.providerState === undefined ? {} : { providerState: turn.providerState })
      })
      const messages = Object.freeze([...attempted.messages, assistant])
      const estimatedInputTokens = attempted.estimatedInputTokens + estimatedTokensFor(assistant)
      return await this.#commit(checkpoint, 'evaluating_tools', {
        messages,
        estimatedInputTokens,
        budgetCounters: attempted.counters,
        recoveryUsed: attempted.recoveryUsed,
        modelTurn: null,
        toolLedgers: Object.freeze([...checkpoint.toolLedgers, ledger]),
        preparedBatch: null,
        interruption: null
      }, [
        completedEvent,
        {
          type: 'tool.batch_planned',
          payload: { step: checkpoint.step, callCount: ledger.calls.length }
        }
      ])
    }

    const text = turn.text.normalize('NFC').trim()
    if (turn.finishReason === 'stop' && text.length > 0) {
      const output = this.#assistantMessage(checkpoint, text)
      return await this.#commit(checkpoint, 'completed', {
        messages: attempted.messages,
        estimatedInputTokens: attempted.estimatedInputTokens,
        budgetCounters: attempted.counters,
        recoveryUsed: attempted.recoveryUsed,
        modelTurn: null,
        output,
        visibleOutput: false
      }, [completedEvent, { type: 'run.completed', payload: { visibleOutput: false } }])
    }

    if (correction) {
      return await this.#fail(checkpoint, modelProtocolError('invalid_correction_response'), [completedEvent], {
        budgetCounters: attempted.counters,
        messages: attempted.messages,
        estimatedInputTokens: attempted.estimatedInputTokens,
        recoveryUsed: attempted.recoveryUsed,
        modelTurn: null
      })
    }
    let counters: RunBudgetCounters
    let maxOutputTokens: number
    try {
      counters = this.#budget.recordCorrection(attempted.counters)
      maxOutputTokens = this.#availableOutputTokens(checkpoint, counters)
      counters = this.#budget.reserveModelTurn(counters, {
        kind: 'correction',
        estimatedInputTokens: attempted.estimatedInputTokens,
        maxOutputTokens
      })
    } catch (error) {
      return await this.#fail(checkpoint, asAgentError(error), [completedEvent], {
        budgetCounters: attempted.counters,
        messages: attempted.messages,
        estimatedInputTokens: attempted.estimatedInputTokens,
        recoveryUsed: attempted.recoveryUsed,
        modelTurn: null
      })
    }
    return await this.#commit(checkpoint, 'correcting', {
      messages: attempted.messages,
      estimatedInputTokens: attempted.estimatedInputTokens,
      budgetCounters: counters,
      recoveryUsed: attempted.recoveryUsed,
      modelTurn: Object.freeze({ kind: 'correction', maxOutputTokens })
    }, [
      completedEvent,
      { type: 'model.started', payload: { kind: 'correction', turn: counters.modelTurns } }
    ])
  }

  async #preflightTools (
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<RunCheckpoint> {
    const ledger = checkpoint.toolLedgers.at(-1)
    if (ledger === undefined || ledger.step !== checkpoint.step) {
      throw new TypeError('planned tool ledger is missing')
    }
    let counters: RunBudgetCounters
    try {
      counters = this.#budget.reserveToolBatch(
        checkpoint.budgetCounters,
        ledger.calls.length
      )
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'run_budget_exceeded') throw error
      const failedLedger = failToolExecutionLedger(ledger, failedToolResult())
      return await this.#commit(checkpoint, 'executing_tools', {
        toolLedgers: this.#replaceLastLedger(checkpoint, failedLedger),
        preparedBatch: completedBatchFromLedger(failedLedger),
        forceCorrection: true
      }, ledger.calls.map(call => ({
        type: 'tool.failed' as const,
        payload: { callId: call.callId, toolName: call.toolName, reason: 'tool_budget_exceeded' }
      })))
    }

    const runtime = this.#runtime(checkpoint.runId)
    this.#assertSnapshot(checkpoint, runtime.snapshot)
    const preparationContext = await this.#raceAbort(
      runtime.prepareToolContext(checkpoint, signal),
      signal
    )
    const calls: readonly ToolCall[] = Object.freeze(ledger.calls.map(call => Object.freeze({
      runId: checkpoint.runId,
      callId: call.callId,
      snapshotId: checkpoint.toolSnapshot.id,
      requestedName: call.toolName,
      arguments: call.arguments
    })))
    const preflight = await this.#raceAbort(this.#scheduler.preflight(calls, {
      snapshot: runtime.snapshot,
      context: preparationContext,
      remainingToolCalls: checkpoint.budgetLimits.maxToolCalls -
        checkpoint.budgetCounters.toolCalls
    }), signal)

    if (preflight.kind === 'failed') {
      const failedLedger = failToolExecutionLedger(ledger, failedToolResult())
      return await this.#commit(checkpoint, 'executing_tools', {
        toolLedgers: this.#replaceLastLedger(checkpoint, failedLedger),
        preparedBatch: completedBatchFromLedger(failedLedger),
        budgetCounters: counters,
        forceCorrection: true
      }, ledger.calls.map(call => ({
        type: 'tool.failed' as const,
        payload: { callId: call.callId, toolName: call.toolName, reason: preflight.code }
      })))
    }

    const preparedLedger = applyToolPreflight(ledger, preflight.batch)
    if (preflight.kind === 'approval_required') {
      const approval = preflight.batch.calls.find(call => call.kind === 'approval_required')
      if (approval === undefined || approval.kind !== 'approval_required') {
        throw new TypeError('approval batch does not contain an approval')
      }
      const interruption = this.#approvalInterruption(
        checkpoint,
        approval.capability,
        preparationContext
      )
      return await this.#commit(checkpoint, 'waiting_approval', {
        toolLedgers: this.#replaceLastLedger(checkpoint, preparedLedger),
        preparedBatch: preflight.batch,
        budgetCounters: counters,
        interruption
      }, [
        {
          type: 'approval.required',
          payload: { approvalId: interruption.approvalId, callId: interruption.callId }
        },
        { type: 'run.paused', payload: { reason: 'approval_required' } }
      ])
    }

    return await this.#commit(checkpoint, 'executing_tools', {
      toolLedgers: this.#replaceLastLedger(checkpoint, preparedLedger),
      preparedBatch: preflight.batch,
      budgetCounters: counters
    }, preparedLedger.calls.flatMap(call => {
      const requested: EventDraft = {
        type: 'tool.requested',
        payload: { callId: call.callId, toolName: call.toolName }
      }
      return call.capability === null
        ? [requested]
        : [requested, {
            type: 'tool.started' as const,
            payload: { callId: call.callId, toolName: call.toolName }
          }]
    }))
  }

  async #executeTools (
    checkpoint: RunCheckpoint,
    signal: AbortSignal
  ): Promise<RunCheckpoint> {
    const batch = checkpoint.preparedBatch
    const ledger = checkpoint.toolLedgers.at(-1)
    if (batch === null || ledger === undefined) {
      throw new TypeError('prepared tool execution state is missing')
    }
    const runtime = this.#runtime(checkpoint.runId)
    this.#assertSnapshot(checkpoint, runtime.snapshot)
    this.#startedToolCalls.set(checkpoint.runId, new Set<string>())
    const execution = await this.#raceAbort(this.#scheduler.execute(batch, {
      snapshot: runtime.snapshot,
      contextFor: async capability => {
        const context = await runtime.contextFor(capability, checkpoint, signal)
        this.#assertNotAborted(signal)
        this.#markToolStarted(checkpoint.runId, capability.callId)
        return context
      },
      signal
    }), signal)
    const completedLedger = completeToolExecutionLedger(ledger, execution.results)
    const toolMessages = toolLedgerModelMessages(completedLedger)
    const messages = Object.freeze([...checkpoint.messages, ...toolMessages])
    const estimatedInputTokens = checkpoint.estimatedInputTokens +
      toolMessages.reduce((total, message) => total + estimatedTokensFor(message), 0)
    const events: EventDraft[] = completedLedger.calls.map(call => ({
      type: call.result?.status === 'success'
        ? 'tool.completed'
        : call.result?.status === 'denied'
          ? 'tool.denied'
          : 'tool.failed',
      payload: {
        callId: call.callId,
        toolName: call.toolName,
        status: call.status
      }
    }))

    const common: RunCheckpointChanges = {
      messages,
      estimatedInputTokens,
      toolLedgers: this.#replaceLastLedger(checkpoint, completedLedger),
      preparedBatch: null,
      interruption: null,
      modelTurn: null
    }
    if (toolLedgerHasVisibleOutput(completedLedger)) {
      const readyToComplete = await this.#commit(checkpoint, 'calling_model', {
        ...common,
        output: null,
        visibleOutput: true,
        step: checkpoint.step + 1
      }, events)
      if (isTerminalRunStatus(readyToComplete.status)) return readyToComplete
      const completed = await this.#completeVisibleOutput(readyToComplete)
      this.#startedToolCalls.delete(checkpoint.runId)
      return completed
    }
    if (toolLedgerHasIndeterminate(completedLedger)) {
      const failed = await this.#fail(checkpoint, toolOutcomeUnknown(), events, common)
      this.#startedToolCalls.delete(checkpoint.runId)
      return failed
    }

    const normalLimit = checkpoint.budgetLimits.maxModelTurns -
      checkpoint.budgetLimits.maxCorrectionTurns
    if (!checkpoint.forceCorrection && checkpoint.budgetCounters.modelTurns < normalLimit) {
      const reservationCheckpoint = Object.freeze({
        ...checkpoint,
        messages,
        estimatedInputTokens
      }) as RunCheckpoint
      const reservation = this.#reserveModelTurn(reservationCheckpoint, 'normal')
      const next = await this.#commit(checkpoint, 'calling_model', {
        ...common,
        step: checkpoint.step + 1,
        budgetCounters: reservation.counters,
        modelTurn: reservation.turn
      }, [...events, {
        type: 'model.started',
        payload: { kind: 'normal', turn: reservation.counters.modelTurns }
      }])
      this.#startedToolCalls.delete(checkpoint.runId)
      return next
    }
    const next = await this.#commit(checkpoint, 'calling_model', {
      ...common,
      step: checkpoint.step + 1
    }, events)
    this.#startedToolCalls.delete(checkpoint.runId)
    return next
  }

  async #completeVisibleOutput (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    if (checkpoint.status !== 'calling_model' || !checkpoint.visibleOutput ||
      checkpoint.output !== null || checkpoint.modelTurn !== null) {
      throw new TypeError('visible-output completion state is invalid')
    }
    return await this.#commit(checkpoint, 'completed', {}, [{
      type: 'run.completed',
      payload: { visibleOutput: true }
    }])
  }

  async #providerCall (
    request: ModelRequest,
    runSignal: AbortSignal,
    timeoutMs: number
  ): Promise<ModelTurn> {
    this.#assertNotAborted(runSignal)
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort()
    runSignal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
    try {
      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(timedOut
            ? new ModelProviderError({
                code: 'provider_timeout',
                stage: 'model.response',
                retryable: true,
                userMessage: 'AI 服务响应超时，请稍后重试。'
              })
            : new RunAbortedError())
        }, { once: true })
      })
      return await Promise.race([
        this.#adapter.complete(request, controller.signal),
        abortPromise
      ])
    } finally {
      clearTimeout(timer)
      runSignal.removeEventListener('abort', abort)
    }
  }

  #providerTimeout (
    checkpoint: RunCheckpoint,
    counters: RunBudgetCounters
  ): number {
    const deadlineRemaining = new Date(checkpoint.deadlineAt).getTime() - this.#now().getTime()
    const activeRemaining = this.#budget.remainingActiveMs(counters)
    const timeout = Math.min(
      checkpoint.budgetLimits.providerTimeoutMs,
      deadlineRemaining,
      activeRemaining
    )
    if (timeout <= 0) throw new RunAbortedError()
    return Math.max(1, Math.floor(timeout))
  }

  async #raceAbort<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
    this.#assertNotAborted(signal)
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new RunAbortedError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  async #commit (
    checkpoint: RunCheckpoint,
    status: RunStatus,
    changes: RunCheckpointChanges,
    drafts: readonly EventDraft[]
  ): Promise<RunCheckpoint> {
    const next = this.#next(checkpoint, status, changes, drafts)
    try {
      const stored = await this.#store.compareAndSet(checkpoint, next)
      this.#notifyNewEvents(checkpoint, stored)
      return stored
    } catch (error) {
      if (error instanceof RunStoreConflictError) {
        const latest = await this.#store.load(checkpoint.runId)
        if (latest !== null && isTerminalRunStatus(latest.status)) return latest
        throw checkpointConflict(error)
      }
      throw error
    }
  }

  #next (
    checkpoint: RunCheckpoint,
    status: RunStatus,
    changes: RunCheckpointChanges,
    drafts: readonly EventDraft[]
  ): RunCheckpoint {
    const occurredAt = this.#timestamp()
    const events = drafts.map((draft, offset) => createRunEvent({
      eventId: this.#generateId(),
      runId: checkpoint.runId,
      sessionId: checkpoint.sessionId,
      sequence: checkpoint.nextEventSequence + offset,
      occurredAt,
      type: draft.type,
      payload: draft.payload ?? EMPTY_PAYLOAD
    }))
    return nextRunCheckpoint(checkpoint, status, changes, events, occurredAt)
  }

  async #fail (
    checkpoint: RunCheckpoint,
    error: AgentError,
    prefixEvents: readonly EventDraft[] = [],
    changes: RunCheckpointChanges = {},
    detailOverride?: Readonly<Record<string, string | number | boolean | null>>
  ): Promise<RunCheckpoint> {
    if (isTerminalRunStatus(checkpoint.status)) return checkpoint
    const serialized: SerializedAgentError = detailOverride === undefined
      ? serializeAgentError(error)
      : Object.freeze({
          ...serializeAgentError(error),
          details: Object.freeze({ ...error.details, ...detailOverride })
        })
    return await this.#commit(checkpoint, 'failed', {
      ...changes,
      modelTurn: null,
      preparedBatch: null,
      interruption: null,
      error: serialized
    }, [...prefixEvents, {
      type: 'run.failed',
      payload: { code: serialized.code, stage: serialized.stage }
    }])
  }

  #assistantMessage (checkpoint: RunCheckpoint, text: string): AgentMessage {
    const createdAt = this.#timestamp()
    return Object.freeze({
      id: this.#generateId(),
      role: 'assistant',
      parts: Object.freeze([{ type: 'text' as const, text }]),
      createdAt,
      provenance: Object.freeze({
        source: 'model',
        trust: 'untrusted',
        sensitivity: 'group',
        sourceId: checkpoint.runId,
        createdAt
      })
    })
  }

  #approvalInterruption (
    checkpoint: RunCheckpoint,
    capability: SerializablePreparedCapability,
    context: ToolPreparationContext
  ): ApprovalInterruption {
    const createdAt = this.#timestamp()
    const role = actorRole(context)
    const profile = context.profile
    const allowedRoles: readonly ApprovalActorRole[] = profile === 'strict'
      ? Object.freeze(['bot_master'])
      : Object.freeze(['bot_master', 'group_owner', 'group_admin'])
    return Object.freeze({
      schemaVersion: 1,
      approvalId: this.#generateId(),
      runId: checkpoint.runId,
      step: checkpoint.step,
      callId: capability.callId,
      toolFingerprint: checkpoint.toolSnapshot.fingerprint,
      argumentHash: capability.argumentHash,
      action: capability.toolName,
      target: targetLabel(capability),
      keyParameters: Object.freeze([]),
      requester: Object.freeze({
        userId: context.facts.actor.userId,
        role
      }),
      approverPolicy: Object.freeze({
        profile,
        allowedRoles,
        requireDifferentActor: false
      }),
      createdAt
    })
  }

  #replaceLastLedger (
    checkpoint: RunCheckpoint,
    ledger: ToolExecutionLedger
  ): readonly ToolExecutionLedger[] {
    if (checkpoint.toolLedgers.length === 0) {
      throw new TypeError('tool ledger replacement target is missing')
    }
    return Object.freeze([
      ...checkpoint.toolLedgers.slice(0, -1),
      ledger
    ])
  }

  #markToolStarted (runId: string, callId: string): void {
    const started = this.#startedToolCalls.get(runId) ?? new Set<string>()
    started.add(callId)
    this.#startedToolCalls.set(runId, started)
  }

  #assertSnapshot (checkpoint: RunCheckpoint, snapshot: ToolSnapshot): void {
    if (snapshot.id !== checkpoint.toolSnapshot.id ||
      snapshot.fingerprint !== checkpoint.toolSnapshot.fingerprint) {
      throw new AgentError({
        code: 'checkpoint_invalid',
        stage: 'run.snapshot',
        retryable: false,
        userMessage: '任务工具配置已变化，请重新发起。'
      })
    }
  }

  #runtime (runId: string): RunRuntimeBinding {
    const runtime = this.#runtimeBindings.get(runId)
    if (runtime === undefined) {
      throw new AgentError({
        code: 'checkpoint_invalid',
        stage: 'run.runtime',
        retryable: false,
        userMessage: '任务运行环境不可用，请重新发起。'
      })
    }
    return runtime
  }

  #timestamp (): string {
    return this.#now().toISOString()
  }

  #deadlineExpired (checkpoint: RunCheckpoint): boolean {
    return this.#now().getTime() >= new Date(checkpoint.deadlineAt).getTime()
  }

  #deadlineTimer (
    checkpoint: RunCheckpoint,
    controller: AbortController
  ): ReturnType<typeof setTimeout> | undefined {
    const remaining = new Date(checkpoint.deadlineAt).getTime() - this.#now().getTime()
    if (remaining <= 0) return undefined
    const timer = setTimeout(() => {
      void this.cancel(checkpoint.runId, 'deadline_exceeded').catch(() => undefined)
    }, remaining)
    timer.unref?.()
    return timer
  }

  #linkExternalSignal (
    signal: AbortSignal | undefined,
    controller: AbortController
  ): () => void {
    if (signal === undefined) return () => undefined
    const abort = (): void => controller.abort('user_cancelled')
    if (signal.aborted) controller.abort('user_cancelled')
    else signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  }

  #assertNotAborted (signal: AbortSignal): void {
    if (signal.aborted) throw new RunAbortedError()
  }

  #signalCancellationReason (signal: AbortSignal): string {
    return boundedCancellationReason(
      typeof signal.reason === 'string' ? signal.reason : 'user_cancelled'
    )
  }

  #notifyNewEvents (previous: RunCheckpoint, next: RunCheckpoint): void {
    for (const event of next.events.slice(previous.events.length)) this.#notify(event)
  }

  #notify (event: AgentEvent): void {
    if (this.#observer === undefined) return
    try {
      const result = this.#observer(event)
      if (result instanceof Promise) void result.catch(() => undefined)
    } catch {
      // Observers are deliberately outside the persisted control plane.
    }
  }
}
