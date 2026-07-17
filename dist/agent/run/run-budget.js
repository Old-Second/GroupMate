import { AgentError } from '../contracts/error.js';
import { MODEL_TURN_CAPACITY_LIMITS } from './model-turn-capacity.js';
const ACTIVE_RUNTIME_MS = 240_000;
const MAX_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_MODEL_TURNS = 6;
const MAX_TOOL_CALLS = 8;
const MAX_ESTIMATED_TOKENS = (MODEL_TURN_CAPACITY_LIMITS.contextWindowTokens * MAX_MODEL_TURNS);
const MAX_PROGRESS_EVENTS = 5;
const MAX_PROVIDER_RETRIES = 1;
const MAX_RECOVERY_ATTEMPTS = 1;
const MAX_CORRECTION_TURNS = 1;
const INITIAL_COUNTERS = Object.freeze({
    modelTurns: 0,
    toolCalls: 0,
    estimatedTokens: 0,
    providerReportedTokens: 0,
    progressEvents: 0,
    providerRetries: 0,
    recoveryAttempts: 0,
    correctionTurns: 0,
    usedActiveRuntimeMs: 0
});
export function boundedMonotonicDurationMs(startedAt, finishedAt, maximumMs = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maximumMs) || maximumMs < 0) {
        throw new TypeError('observation duration limit must be a non-negative safe integer');
    }
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
        finishedAt <= startedAt)
        return 0;
    const duration = Math.ceil(finishedAt - startedAt);
    if (!Number.isSafeInteger(duration))
        return maximumMs;
    return Math.min(duration, maximumMs);
}
function assertNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative integer`);
    }
}
function assertPositiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive integer`);
    }
}
function freezeCompatibleLimits(limits) {
    if (limits.activeRuntimeMs !== ACTIVE_RUNTIME_MS ||
        !Number.isSafeInteger(limits.providerTimeoutMs) || limits.providerTimeoutMs <= 0 ||
        limits.providerTimeoutMs > MAX_PROVIDER_TIMEOUT_MS ||
        limits.maxModelTurns !== MAX_MODEL_TURNS ||
        limits.maxToolCalls !== MAX_TOOL_CALLS ||
        (limits.maxEstimatedTokens !== 49_152 &&
            limits.maxEstimatedTokens !== MAX_ESTIMATED_TOKENS) ||
        limits.maxProgressEvents !== MAX_PROGRESS_EVENTS ||
        limits.maxProviderRetries !== MAX_PROVIDER_RETRIES ||
        limits.maxRecoveryAttempts !== MAX_RECOVERY_ATTEMPTS ||
        limits.maxCorrectionTurns !== MAX_CORRECTION_TURNS) {
        throw new TypeError('run budget limits are incompatible');
    }
    return Object.freeze({ ...limits });
}
function sameLimits(left, right) {
    return left.activeRuntimeMs === right.activeRuntimeMs &&
        left.providerTimeoutMs === right.providerTimeoutMs &&
        left.maxModelTurns === right.maxModelTurns &&
        left.maxToolCalls === right.maxToolCalls &&
        left.maxEstimatedTokens === right.maxEstimatedTokens &&
        left.maxProgressEvents === right.maxProgressEvents &&
        left.maxProviderRetries === right.maxProviderRetries &&
        left.maxRecoveryAttempts === right.maxRecoveryAttempts &&
        left.maxCorrectionTurns === right.maxCorrectionTurns;
}
function freezeCounters(counters, changes) {
    return Object.freeze({ ...counters, ...changes });
}
function budgetExceeded(limit, current, requested) {
    return new AgentError({
        code: 'run_budget_exceeded',
        stage: 'run.budget',
        retryable: false,
        userMessage: '任务执行已达到资源上限，请稍后重试。',
        details: { limit, current, requested }
    });
}
class DefaultRunBudget {
    limits;
    initialCounters = INITIAL_COUNTERS;
    #outputTokens;
    constructor(input, limits) {
        assertPositiveInteger(input.providerTimeoutMs, 'provider timeout');
        assertPositiveInteger(input.outputTokens, 'output token limit');
        this.#outputTokens = Math.min(input.outputTokens, MAX_ESTIMATED_TOKENS);
        this.limits = limits === undefined ? Object.freeze({
            activeRuntimeMs: ACTIVE_RUNTIME_MS,
            providerTimeoutMs: Math.min(input.providerTimeoutMs, MAX_PROVIDER_TIMEOUT_MS),
            maxModelTurns: MAX_MODEL_TURNS,
            maxToolCalls: MAX_TOOL_CALLS,
            maxEstimatedTokens: MAX_ESTIMATED_TOKENS,
            maxProgressEvents: MAX_PROGRESS_EVENTS,
            maxProviderRetries: MAX_PROVIDER_RETRIES,
            maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
            maxCorrectionTurns: MAX_CORRECTION_TURNS
        }) : freezeCompatibleLimits(limits);
    }
    withLimits(limits) {
        const compatible = freezeCompatibleLimits(limits);
        if (sameLimits(this.limits, compatible))
            return this;
        return new DefaultRunBudget({
            providerTimeoutMs: compatible.providerTimeoutMs,
            outputTokens: this.#outputTokens
        }, compatible);
    }
    reserveModelTurn(counters, input) {
        assertNonNegativeInteger(input.estimatedInputTokens, 'estimated input tokens');
        if (input.maxOutputTokens !== undefined) {
            assertPositiveInteger(input.maxOutputTokens, 'model output tokens');
        }
        const maxNormalTurns = this.limits.maxModelTurns - this.limits.maxCorrectionTurns;
        if (input.kind === 'normal' && counters.modelTurns >= maxNormalTurns) {
            throw budgetExceeded('model_turns', counters.modelTurns, 1);
        }
        if (input.kind === 'correction' && counters.correctionTurns < 1) {
            throw new TypeError('correction turn must be reserved before the model turn');
        }
        if (counters.modelTurns >= this.limits.maxModelTurns) {
            throw budgetExceeded('model_turns', counters.modelTurns, 1);
        }
        const outputTokens = input.maxOutputTokens ?? this.#outputTokens;
        const tokenReservation = input.estimatedInputTokens + outputTokens;
        if (counters.estimatedTokens + tokenReservation > this.limits.maxEstimatedTokens) {
            throw budgetExceeded('estimated_tokens', counters.estimatedTokens, tokenReservation);
        }
        return freezeCounters(counters, {
            modelTurns: counters.modelTurns + 1,
            estimatedTokens: counters.estimatedTokens + tokenReservation
        });
    }
    reserveToolBatch(counters, count) {
        assertPositiveInteger(count, 'tool batch count');
        if (counters.toolCalls + count > this.limits.maxToolCalls) {
            throw budgetExceeded('tool_calls', counters.toolCalls, count);
        }
        return freezeCounters(counters, { toolCalls: counters.toolCalls + count });
    }
    recordProviderRetry(counters) {
        return this.#increment(counters, 'providerRetries', this.limits.maxProviderRetries, 'provider_retries');
    }
    recordRecovery(counters) {
        return this.#increment(counters, 'recoveryAttempts', this.limits.maxRecoveryAttempts, 'recovery_attempts');
    }
    recordCorrection(counters) {
        return this.#increment(counters, 'correctionTurns', this.limits.maxCorrectionTurns, 'correction_turns');
    }
    recordUsage(counters, usage) {
        const activeRuntimeMs = usage.activeRuntimeMs ?? 0;
        const estimatedTokens = usage.estimatedTokens ?? 0;
        const providerReportedTokens = usage.providerReportedTokens ?? 0;
        const progressEvents = usage.progressEvents ?? 0;
        for (const [field, value] of Object.entries({
            activeRuntimeMs,
            estimatedTokens,
            providerReportedTokens,
            progressEvents
        })) {
            assertNonNegativeInteger(value, field);
        }
        if (counters.usedActiveRuntimeMs + activeRuntimeMs > this.limits.activeRuntimeMs) {
            throw budgetExceeded('active_runtime_ms', counters.usedActiveRuntimeMs, activeRuntimeMs);
        }
        if (counters.estimatedTokens + estimatedTokens > this.limits.maxEstimatedTokens) {
            throw budgetExceeded('estimated_tokens', counters.estimatedTokens, estimatedTokens);
        }
        if (counters.progressEvents + progressEvents > this.limits.maxProgressEvents) {
            throw budgetExceeded('progress_events', counters.progressEvents, progressEvents);
        }
        if (counters.providerReportedTokens + providerReportedTokens > Number.MAX_SAFE_INTEGER) {
            throw budgetExceeded('provider_reported_tokens', counters.providerReportedTokens, providerReportedTokens);
        }
        return freezeCounters(counters, {
            usedActiveRuntimeMs: counters.usedActiveRuntimeMs + activeRuntimeMs,
            estimatedTokens: counters.estimatedTokens + estimatedTokens,
            providerReportedTokens: counters.providerReportedTokens + providerReportedTokens,
            progressEvents: counters.progressEvents + progressEvents
        });
    }
    remainingActiveMs(counters) {
        return Math.max(0, this.limits.activeRuntimeMs - counters.usedActiveRuntimeMs);
    }
    #increment(counters, field, limit, limitName) {
        const current = counters[field];
        if (current >= limit)
            throw budgetExceeded(limitName, current, 1);
        return freezeCounters(counters, { [field]: current + 1 });
    }
}
export function createDefaultRunBudget(input) {
    return new DefaultRunBudget(input);
}
