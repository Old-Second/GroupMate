import { AgentError } from '../contracts/error.js'
import {
  ADAPTIVE_CONTEXT_LOOP_POLICY,
  parseRunModelLoopPolicyV1,
  type RunModelLoopPolicyV1
} from './run-loop-policy.js'

export interface LegacyRunBudgetLimitsV1 {
  readonly activeRuntimeMs: 240_000
  readonly providerTimeoutMs: number
  readonly maxModelTurns: 6
  readonly maxToolCalls: 8
  readonly maxEstimatedTokens: 49_152 | 196_608
  readonly maxProgressEvents: 5
  readonly maxProviderRetries: 1
  readonly maxRecoveryAttempts: 1
  readonly maxCorrectionTurns: 1
}

export interface RunBudgetLimitsV2 {
  readonly schemaVersion: 2
  readonly activeRuntimeMs: 240_000
  readonly providerTimeoutMs: number
  readonly maxToolCalls: 8
  readonly maxProgressEvents: 5
  readonly maxProviderRetries: 1
  readonly maxRecoveryAttempts: 1
  readonly maxCorrectionTurns: 1
}

export type RunBudgetLimits = RunBudgetLimitsV2

export interface RunBudgetCounters {
  readonly modelTurns: number
  readonly toolCalls: number
  readonly estimatedTokens: number
  readonly providerReportedTokens: number
  readonly progressEvents: number
  readonly providerRetries: number
  readonly recoveryAttempts: number
  readonly correctionTurns: number
  readonly usedActiveRuntimeMs: number
}

export interface ModelTurnReservation {
  readonly kind: 'normal' | 'correction'
  readonly estimatedInputTokens: number
  readonly maxOutputTokens?: number
}

export interface RunUsageRecord {
  readonly activeRuntimeMs?: number
  readonly estimatedTokens?: number
  readonly providerReportedTokens?: number
  readonly progressEvents?: number
}

export interface RunBudget {
  readonly limits: RunBudgetLimits
  readonly initialCounters: RunBudgetCounters
  readonly loopPolicy: RunModelLoopPolicyV1
  withLimits(limits: RunBudgetLimits, loopPolicy?: RunModelLoopPolicyV1): RunBudget
  reserveModelTurn(counters: RunBudgetCounters, input: ModelTurnReservation): RunBudgetCounters
  reserveToolBatch(counters: RunBudgetCounters, count: number): RunBudgetCounters
  recordProviderRetry(counters: RunBudgetCounters): RunBudgetCounters
  recordRecovery(counters: RunBudgetCounters): RunBudgetCounters
  recordCorrection(counters: RunBudgetCounters): RunBudgetCounters
  recordUsage(counters: RunBudgetCounters, usage: RunUsageRecord): RunBudgetCounters
  remainingActiveMs(counters: RunBudgetCounters): number
}

export interface DefaultRunBudgetInput {
  readonly providerTimeoutMs: number
  readonly outputTokens: number
}

const ACTIVE_RUNTIME_MS = 240_000
const MAX_PROVIDER_TIMEOUT_MS = 120_000
const MAX_MODEL_TURNS = 6
const MAX_TOOL_CALLS = 8
const MAX_ESTIMATED_TOKENS = 196_608
const MAX_PROGRESS_EVENTS = 5
const MAX_PROVIDER_RETRIES = 1
const MAX_RECOVERY_ATTEMPTS = 1
const MAX_CORRECTION_TURNS = 1

const INITIAL_COUNTERS: RunBudgetCounters = Object.freeze({
  modelTurns: 0,
  toolCalls: 0,
  estimatedTokens: 0,
  providerReportedTokens: 0,
  progressEvents: 0,
  providerRetries: 0,
  recoveryAttempts: 0,
  correctionTurns: 0,
  usedActiveRuntimeMs: 0
})

export function boundedMonotonicDurationMs (
  startedAt: number,
  finishedAt: number,
  maximumMs = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 0) {
    throw new TypeError('observation duration limit must be a non-negative safe integer')
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
    finishedAt <= startedAt) return 0
  const duration = Math.ceil(finishedAt - startedAt)
  if (!Number.isSafeInteger(duration)) return maximumMs
  return Math.min(duration, maximumMs)
}

function assertNonNegativeInteger (value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
}

function assertPositiveInteger (value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`)
  }
}

function freezeCompatibleLimits (limits: RunBudgetLimits): RunBudgetLimits {
  if (limits.schemaVersion !== 2 || limits.activeRuntimeMs !== ACTIVE_RUNTIME_MS ||
    !Number.isSafeInteger(limits.providerTimeoutMs) || limits.providerTimeoutMs <= 0 ||
    limits.providerTimeoutMs > MAX_PROVIDER_TIMEOUT_MS ||
    limits.maxToolCalls !== MAX_TOOL_CALLS ||
    limits.maxProgressEvents !== MAX_PROGRESS_EVENTS ||
    limits.maxProviderRetries !== MAX_PROVIDER_RETRIES ||
    limits.maxRecoveryAttempts !== MAX_RECOVERY_ATTEMPTS ||
    limits.maxCorrectionTurns !== MAX_CORRECTION_TURNS) {
    throw new TypeError('run budget limits are incompatible')
  }
  return Object.freeze({ ...limits })
}

function sameLimits (left: RunBudgetLimits, right: RunBudgetLimits): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.activeRuntimeMs === right.activeRuntimeMs &&
    left.providerTimeoutMs === right.providerTimeoutMs &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxProgressEvents === right.maxProgressEvents &&
    left.maxProviderRetries === right.maxProviderRetries &&
    left.maxRecoveryAttempts === right.maxRecoveryAttempts &&
    left.maxCorrectionTurns === right.maxCorrectionTurns
}

function freezeCounters (
  counters: RunBudgetCounters,
  changes: Partial<RunBudgetCounters>
): RunBudgetCounters {
  return Object.freeze({ ...counters, ...changes })
}

function budgetExceeded (
  limit: string,
  current: number,
  requested: number
): AgentError {
  return new AgentError({
    code: 'run_budget_exceeded',
    stage: 'run.budget',
    retryable: false,
    userMessage: '任务执行已达到资源上限，请稍后重试。',
    details: { limit, current, requested }
  })
}

class DefaultRunBudget implements RunBudget {
  readonly limits: RunBudgetLimits
  readonly loopPolicy: RunModelLoopPolicyV1
  readonly initialCounters = INITIAL_COUNTERS
  readonly #outputTokens: number

  constructor (
    input: DefaultRunBudgetInput,
    limits?: RunBudgetLimits,
    loopPolicy: RunModelLoopPolicyV1 = ADAPTIVE_CONTEXT_LOOP_POLICY
  ) {
    assertPositiveInteger(input.providerTimeoutMs, 'provider timeout')
    assertPositiveInteger(input.outputTokens, 'output token limit')
    this.#outputTokens = Math.min(input.outputTokens, MAX_ESTIMATED_TOKENS)
    this.loopPolicy = parseRunModelLoopPolicyV1(loopPolicy)
    this.limits = limits === undefined ? Object.freeze({
      schemaVersion: 2 as const,
      activeRuntimeMs: ACTIVE_RUNTIME_MS,
      providerTimeoutMs: Math.min(input.providerTimeoutMs, MAX_PROVIDER_TIMEOUT_MS),
      maxToolCalls: MAX_TOOL_CALLS,
      maxProgressEvents: MAX_PROGRESS_EVENTS,
      maxProviderRetries: MAX_PROVIDER_RETRIES,
      maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
      maxCorrectionTurns: MAX_CORRECTION_TURNS
    }) : freezeCompatibleLimits(limits)
  }

  withLimits (
    limits: RunBudgetLimits,
    loopPolicy: RunModelLoopPolicyV1 = this.loopPolicy
  ): RunBudget {
    const compatible = freezeCompatibleLimits(limits)
    const policy = parseRunModelLoopPolicyV1(loopPolicy)
    if (sameLimits(this.limits, compatible) &&
      JSON.stringify(this.loopPolicy) === JSON.stringify(policy)) return this
    return new DefaultRunBudget({
      providerTimeoutMs: compatible.providerTimeoutMs,
      outputTokens: this.#outputTokens
    }, compatible, policy)
  }

  reserveModelTurn (
    counters: RunBudgetCounters,
    input: ModelTurnReservation
  ): RunBudgetCounters {
    assertNonNegativeInteger(input.estimatedInputTokens, 'estimated input tokens')
    if (input.maxOutputTokens !== undefined) {
      assertPositiveInteger(input.maxOutputTokens, 'model output tokens')
    }
    if (!Number.isSafeInteger(counters.modelTurns) || counters.modelTurns < 0 ||
      counters.modelTurns === Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(counters.estimatedTokens) || counters.estimatedTokens < 0) {
      throw budgetExceeded('model_turns', counters.modelTurns, 1)
    }
    const fixed = this.loopPolicy.kind === 'legacy_fixed' ? this.loopPolicy : null
    const maxNormalTurns = fixed === null
      ? Number.MAX_SAFE_INTEGER
      : fixed.maxModelTurns - this.limits.maxCorrectionTurns
    if (input.kind === 'normal' && counters.modelTurns >= maxNormalTurns) {
      throw budgetExceeded('model_turns', counters.modelTurns, 1)
    }
    if (input.kind === 'correction' && counters.correctionTurns < 1) {
      throw new TypeError('correction turn must be reserved before the model turn')
    }
    if (fixed !== null && counters.modelTurns >= fixed.maxModelTurns) {
      throw budgetExceeded('model_turns', counters.modelTurns, 1)
    }

    const outputTokens = input.maxOutputTokens ?? this.#outputTokens
    if (input.estimatedInputTokens > Number.MAX_SAFE_INTEGER - outputTokens) {
      throw budgetExceeded('estimated_tokens', counters.estimatedTokens, input.estimatedInputTokens)
    }
    const tokenReservation = input.estimatedInputTokens + outputTokens
    if (tokenReservation > Number.MAX_SAFE_INTEGER - counters.estimatedTokens ||
      (fixed !== null && counters.estimatedTokens + tokenReservation > fixed.maxEstimatedTokens)) {
      throw budgetExceeded('estimated_tokens', counters.estimatedTokens, tokenReservation)
    }
    return freezeCounters(counters, {
      modelTurns: counters.modelTurns + 1,
      estimatedTokens: counters.estimatedTokens + tokenReservation
    })
  }

  reserveToolBatch (counters: RunBudgetCounters, count: number): RunBudgetCounters {
    assertPositiveInteger(count, 'tool batch count')
    if (counters.toolCalls + count > this.limits.maxToolCalls) {
      throw budgetExceeded('tool_calls', counters.toolCalls, count)
    }
    return freezeCounters(counters, { toolCalls: counters.toolCalls + count })
  }

  recordProviderRetry (counters: RunBudgetCounters): RunBudgetCounters {
    return this.#increment(
      counters,
      'providerRetries',
      this.limits.maxProviderRetries,
      'provider_retries'
    )
  }

  recordRecovery (counters: RunBudgetCounters): RunBudgetCounters {
    return this.#increment(
      counters,
      'recoveryAttempts',
      this.limits.maxRecoveryAttempts,
      'recovery_attempts'
    )
  }

  recordCorrection (counters: RunBudgetCounters): RunBudgetCounters {
    return this.#increment(
      counters,
      'correctionTurns',
      this.limits.maxCorrectionTurns,
      'correction_turns'
    )
  }

  recordUsage (counters: RunBudgetCounters, usage: RunUsageRecord): RunBudgetCounters {
    const activeRuntimeMs = usage.activeRuntimeMs ?? 0
    const estimatedTokens = usage.estimatedTokens ?? 0
    const providerReportedTokens = usage.providerReportedTokens ?? 0
    const progressEvents = usage.progressEvents ?? 0
    for (const [field, value] of Object.entries({
      activeRuntimeMs,
      estimatedTokens,
      providerReportedTokens,
      progressEvents
    })) {
      assertNonNegativeInteger(value, field)
    }
    if (counters.usedActiveRuntimeMs + activeRuntimeMs > this.limits.activeRuntimeMs) {
      throw budgetExceeded('active_runtime_ms', counters.usedActiveRuntimeMs, activeRuntimeMs)
    }
    if (estimatedTokens > Number.MAX_SAFE_INTEGER - counters.estimatedTokens ||
      (this.loopPolicy.kind === 'legacy_fixed' &&
        counters.estimatedTokens + estimatedTokens > this.loopPolicy.maxEstimatedTokens)) {
      throw budgetExceeded('estimated_tokens', counters.estimatedTokens, estimatedTokens)
    }
    if (counters.progressEvents + progressEvents > this.limits.maxProgressEvents) {
      throw budgetExceeded('progress_events', counters.progressEvents, progressEvents)
    }
    if (counters.providerReportedTokens + providerReportedTokens > Number.MAX_SAFE_INTEGER) {
      throw budgetExceeded(
        'provider_reported_tokens',
        counters.providerReportedTokens,
        providerReportedTokens
      )
    }
    return freezeCounters(counters, {
      usedActiveRuntimeMs: counters.usedActiveRuntimeMs + activeRuntimeMs,
      estimatedTokens: counters.estimatedTokens + estimatedTokens,
      providerReportedTokens: counters.providerReportedTokens + providerReportedTokens,
      progressEvents: counters.progressEvents + progressEvents
    })
  }

  remainingActiveMs (counters: RunBudgetCounters): number {
    return Math.max(0, this.limits.activeRuntimeMs - counters.usedActiveRuntimeMs)
  }

  #increment<K extends 'providerRetries' | 'recoveryAttempts' | 'correctionTurns'> (
    counters: RunBudgetCounters,
    field: K,
    limit: number,
    limitName: string
  ): RunBudgetCounters {
    const current = counters[field]
    if (current >= limit) throw budgetExceeded(limitName, current, 1)
    return freezeCounters(counters, { [field]: current + 1 })
  }
}

export function createDefaultRunBudget (input: DefaultRunBudgetInput): RunBudget {
  return new DefaultRunBudget(input)
}

export function createLegacyRunBudgetLimits (
  limits: RunBudgetLimits,
  maxEstimatedTokens: 49_152 | 196_608 = 196_608
): LegacyRunBudgetLimitsV1 {
  const parsed = freezeCompatibleLimits(limits)
  return Object.freeze({
    activeRuntimeMs: parsed.activeRuntimeMs,
    providerTimeoutMs: parsed.providerTimeoutMs,
    maxModelTurns: 6,
    maxToolCalls: parsed.maxToolCalls,
    maxEstimatedTokens,
    maxProgressEvents: parsed.maxProgressEvents,
    maxProviderRetries: parsed.maxProviderRetries,
    maxRecoveryAttempts: parsed.maxRecoveryAttempts,
    maxCorrectionTurns: parsed.maxCorrectionTurns
  })
}
