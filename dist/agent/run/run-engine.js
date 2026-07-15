import { performance } from 'node:perf_hooks';
import { AgentError, serializeAgentError } from '../contracts/error.js';
import { ModelProviderError, modelProtocolError } from '../model/model-adapter.js';
import { canonicalSessionKey } from '../session/conversation-scope.js';
import { completedPreparedCall } from '../tools/prepared-capability.js';
import { parseToolResult } from '../tools/tool-result.js';
import { decideApprovalInterruption, displayApprovalInterruption, isApprovalActorEligible, parseApprovalInterruption } from './interruption.js';
import { createInitialRunCheckpoint, nextRunCheckpoint, recoverExecutingRunCheckpoint } from './run-checkpoint.js';
import { createRunEvent } from './run-events.js';
import { isTerminalRunStatus } from './run-state.js';
import { RunStoreConflictError } from './run-store.js';
import { applyToolPreflight, cancelToolExecutionLedger, completeToolExecutionLedger, createToolExecutionLedger, failRecoveredToolExecutionLedger, failToolExecutionLedger, resetToolExecutionLedgerForRecovery, resolveToolApproval, toolLedgerHasIndeterminate, toolLedgerHasUnresolvedNonRead, toolLedgerHasVisibleOutput, toolLedgerModelMessages, toolLedgerRequiresToolDisabledFinalResponse } from './tool-ledger.js';
class ModelAttemptFailure extends Error {
    agentError;
    counters;
    messages;
    estimatedInputTokens;
    recoveryUsed;
    constructor(agentError, state) {
        super('model attempt failed', { cause: agentError });
        this.name = 'ModelAttemptFailure';
        this.agentError = agentError;
        this.counters = state.counters;
        this.messages = state.messages;
        this.estimatedInputTokens = state.estimatedInputTokens;
        this.recoveryUsed = state.recoveryUsed;
    }
}
class RunAbortedError extends Error {
    constructor() {
        super('run was aborted');
        this.name = 'RunAbortedError';
    }
}
const EMPTY_PAYLOAD = Object.freeze({});
function internalError(cause) {
    return new AgentError({
        code: 'internal_error',
        stage: 'run.engine',
        retryable: false,
        userMessage: '处理请求时出现异常，请稍后重试。',
        cause
    });
}
function checkpointConflict(cause) {
    return new AgentError({
        code: 'checkpoint_conflict',
        stage: 'run.checkpoint',
        retryable: false,
        userMessage: '任务状态已发生变化，请重新发起。',
        cause
    });
}
function toolOutcomeUnknown() {
    return new AgentError({
        code: 'tool_outcome_unknown',
        stage: 'tool.execute',
        retryable: false,
        userMessage: '操作结果暂时无法确认，请先核实后再试。'
    });
}
function boundedCancellationReason(reason) {
    const normalized = typeof reason === 'string' ? reason.trim() : '';
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
        ? normalized
        : 'user_cancelled';
}
function isAbortError(error) {
    return error instanceof RunAbortedError ||
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError');
}
function estimatedTokensFor(value) {
    return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4));
}
function terminalResult(checkpoint) {
    if (checkpoint.status === 'completed') {
        return Object.freeze({
            kind: 'completed',
            runId: checkpoint.runId,
            output: checkpoint.output,
            visibleOutput: checkpoint.visibleOutput
        });
    }
    if (checkpoint.status === 'failed' && checkpoint.error !== null) {
        return Object.freeze({
            kind: 'failed',
            runId: checkpoint.runId,
            error: checkpoint.error
        });
    }
    if (checkpoint.status === 'cancelled' && checkpoint.cancellationReason !== null) {
        return Object.freeze({
            kind: 'cancelled',
            runId: checkpoint.runId,
            reason: checkpoint.cancellationReason
        });
    }
    if (checkpoint.status === 'waiting_approval' && checkpoint.interruption !== null) {
        return Object.freeze({
            kind: 'paused',
            runId: checkpoint.runId,
            interruption: checkpoint.interruption
        });
    }
    throw new TypeError('run checkpoint does not contain a terminal result');
}
function modelTools(snapshot) {
    return Object.freeze(snapshot.modelTools.map(tool => Object.freeze({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
    })));
}
function failedToolResult(message = '工具调用已超过本次任务的资源上限。') {
    return parseToolResult({
        status: 'failed',
        effect: 'none',
        errorCode: 'tool_execution_failed',
        userMessage: message,
        retryable: false
    });
}
function approvalUnavailableResult() {
    return parseToolResult({
        status: 'denied',
        effect: 'none',
        reasonCode: 'approval_unavailable',
        userMessage: '当前没有另一名合格审批者，操作未执行。',
        retryable: false
    });
}
function approvalRejectedResult() {
    return parseToolResult({
        status: 'denied',
        effect: 'none',
        reasonCode: 'approval_invalid',
        userMessage: '用户已拒绝本次操作，操作未执行。',
        retryable: false
    });
}
function approvalExpiredResult() {
    return parseToolResult({
        status: 'denied',
        effect: 'none',
        reasonCode: 'approval_invalid',
        userMessage: '本次操作审批已过期，操作未执行。',
        retryable: false
    });
}
function authorizationChangedResult() {
    return parseToolResult({
        status: 'denied',
        effect: 'none',
        reasonCode: 'approval_invalid',
        userMessage: '当前权限、目标或工具配置已变化，操作未执行。',
        retryable: false
    });
}
function completedBatchFromLedger(ledger) {
    return Object.freeze({
        schemaVersion: 1,
        calls: Object.freeze(ledger.calls.map(call => {
            if (call.result === null)
                throw new TypeError('failed tool ledger result is missing');
            return completedPreparedCall(call.callId, call.toolName, call.result);
        }))
    });
}
function actorRole(context) {
    if (context.facts.actor.isBotMaster)
        return 'bot_master';
    if (context.facts.actorGroupRole === 'owner')
        return 'group_owner';
    if (context.facts.actorGroupRole === 'admin')
        return 'group_admin';
    return 'member';
}
function targetLabel(capability) {
    switch (capability.target.kind) {
        case 'none': return 'current_context';
        case 'private': return `private:${capability.target.userId}`;
        case 'group': return `group:${capability.target.groupId}`;
        case 'member': return `member:${capability.target.groupId}:${capability.target.userId}`;
        case 'message': return `message:${capability.target.groupId}:${capability.target.messageId}`;
    }
}
function boundedKeyParameter(key, value) {
    if (value === null || typeof value === 'object')
        return null;
    if (typeof value === 'string' && /(?:text|message|content|prompt)/i.test(key)) {
        return `${key}=<${[...value].length} chars>`;
    }
    const rendered = `${key}=${String(value)}`;
    return [...rendered].slice(0, 128).join('');
}
function approvalKeyParameters(capability) {
    return Object.freeze(Object.entries(capability.canonicalArguments)
        .map(([key, value]) => boundedKeyParameter(key, value))
        .filter((value) => value !== null)
        .slice(0, 8));
}
function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function sameAddress(left, right) {
    try {
        return canonicalSessionKey(left) === canonicalSessionKey(right);
    }
    catch {
        return false;
    }
}
function asAgentError(error) {
    if (error instanceof AgentError)
        return error;
    if (error instanceof RunStoreConflictError)
        return checkpointConflict(error);
    return internalError(error);
}
export class RunEngine {
    #adapter;
    #profile;
    #scheduler;
    #store;
    #budget;
    #now;
    #generateId;
    #observer;
    #runtimeBindings = new Map();
    #controllers = new Map();
    #startedToolCalls = new Map();
    constructor(options) {
        this.#adapter = options.adapter;
        this.#profile = options.profile;
        this.#scheduler = options.scheduler;
        this.#store = options.store;
        this.#budget = options.budget;
        this.#now = options.now ?? (() => new Date());
        this.#generateId = options.generateId ?? (() => crypto.randomUUID());
        this.#observer = options.observer;
    }
    async pendingApproval(runId, approvalId) {
        const checkpoint = await this.#store.load(runId);
        if (checkpoint?.status !== 'waiting_approval' ||
            checkpoint.interruption?.approvalId !== approvalId)
            return null;
        return parseApprovalInterruption(checkpoint.interruption);
    }
    async displayApproval(input) {
        const checkpoint = await this.#store.load(input.runId);
        if (checkpoint?.status !== 'waiting_approval' ||
            checkpoint.interruption?.approvalId !== input.approvalId)
            return null;
        let interruption;
        try {
            interruption = displayApprovalInterruption(checkpoint.interruption, {
                messageId: input.messageId,
                displayedAt: input.displayedAt,
                ttlSeconds: input.ttlSeconds
            });
        }
        catch {
            return null;
        }
        const next = this.#next(checkpoint, 'waiting_approval', { interruption }, [{
                type: 'approval.requested',
                payload: {
                    approvalId: interruption.approvalId,
                    callId: interruption.callId,
                    ttlSeconds: input.ttlSeconds
                }
            }]);
        try {
            const stored = await this.#store.compareAndSet(checkpoint, next);
            this.#notifyNewEvents(checkpoint, stored);
            return stored.interruption;
        }
        catch (error) {
            if (error instanceof RunStoreConflictError)
                return null;
            throw error;
        }
    }
    async decideApproval(input, runtime, options = {}) {
        if (runtime !== undefined)
            this.#runtimeBindings.set(input.runId, runtime);
        const checkpoint = await this.#store.load(input.runId);
        if (checkpoint === null || checkpoint.status !== 'waiting_approval' ||
            checkpoint.interruption === null)
            return null;
        const interruption = checkpoint.interruption;
        if (interruption.approvalId !== input.approvalId ||
            interruption.approvalMessageId === undefined || interruption.displayedAt === undefined ||
            interruption.expiresAt === undefined || interruption.decision !== undefined ||
            checkpoint.preparedBatch === null || !sameAddress(input.sessionAddress, interruption.approvalAddress))
            return null;
        let decidedAtMs;
        try {
            decidedAtMs = new Date(input.decidedAt).getTime();
            if (new Date(input.decidedAt).toISOString() !== input.decidedAt)
                return null;
        }
        catch {
            return null;
        }
        const expiresAtMs = new Date(interruption.expiresAt).getTime();
        const displayedAtMs = new Date(interruption.displayedAt).getTime();
        if (decidedAtMs < displayedAtMs ||
            (input.kind === 'expired' && decidedAtMs < expiresAtMs))
            return null;
        const kind = decidedAtMs >= expiresAtMs
            ? 'expired'
            : input.kind;
        if (kind !== 'expired' && (input.actor === undefined ||
            !isApprovalActorEligible(interruption, input.actor)))
            return null;
        const decision = Object.freeze({
            kind,
            decidedAt: input.decidedAt,
            ...(kind === 'expired' ? {} : { actor: input.actor })
        });
        let decided;
        try {
            decided = decideApprovalInterruption(interruption, decision);
        }
        catch {
            return null;
        }
        const ledger = checkpoint.toolLedgers.at(-1);
        const batch = checkpoint.preparedBatch;
        if (ledger === undefined || ledger.step !== checkpoint.step)
            return null;
        const index = batch.calls.findIndex(call => (call.kind === 'approval_required' && call.capability.callId === interruption.callId));
        if (index < 0)
            return null;
        const pendingCall = batch.calls[index];
        if (pendingCall.kind !== 'approval_required' ||
            pendingCall.capability.argumentHash !== interruption.argumentHash ||
            checkpoint.toolSnapshot.fingerprint !== interruption.toolFingerprint)
            return null;
        const controller = this.#controllers.get(input.runId) ?? new AbortController();
        this.#controllers.set(input.runId, controller);
        const detach = this.#linkExternalSignal(options.signal, controller);
        let preparedBatch = batch;
        let resolvedLedger = ledger;
        let preparationContext;
        try {
            if (kind === 'approved') {
                let prepared;
                try {
                    prepared = await this.#revalidateApprovedCapability(checkpoint, pendingCall.capability, interruption, decision.actor, controller.signal);
                }
                catch {
                    prepared = null;
                }
                if (prepared === null) {
                    const result = authorizationChangedResult();
                    preparedBatch = this.#replacePreparedCall(preparedBatch, index, completedPreparedCall(pendingCall.capability.callId, pendingCall.capability.toolName, result));
                    resolvedLedger = resolveToolApproval(resolvedLedger, interruption.callId, {
                        kind: 'denied', result
                    });
                }
                else {
                    preparedBatch = this.#replacePreparedCall(preparedBatch, index, Object.freeze({ kind: 'ready', capability: prepared.capability }));
                    resolvedLedger = resolveToolApproval(resolvedLedger, interruption.callId, {
                        kind: 'approved', capability: prepared.capability
                    });
                    preparationContext = prepared.context;
                }
            }
            else {
                const result = kind === 'rejected'
                    ? approvalRejectedResult()
                    : approvalExpiredResult();
                preparedBatch = this.#replacePreparedCall(preparedBatch, index, completedPreparedCall(pendingCall.capability.callId, pendingCall.capability.toolName, result));
                resolvedLedger = resolveToolApproval(resolvedLedger, interruption.callId, {
                    kind, result
                });
            }
            const activated = await this.#activateNextApproval(checkpoint, preparedBatch, resolvedLedger, preparationContext, controller.signal);
            preparedBatch = activated.batch;
            resolvedLedger = activated.ledger;
            const nextInterruption = activated.interruption;
            const paused = nextInterruption !== null;
            const waitMs = Math.max(0, decidedAtMs - new Date(interruption.createdAt).getTime());
            const deadlineAt = new Date(new Date(checkpoint.deadlineAt).getTime() + waitMs).toISOString();
            const history = Object.freeze([...checkpoint.approvalHistory, decided]);
            const resolutionEvents = [
                {
                    type: kind === 'expired' ? 'approval.expired' : 'approval.decided',
                    payload: {
                        approvalId: interruption.approvalId,
                        callId: interruption.callId,
                        decision: kind
                    }
                },
                {
                    type: 'approval.resolved',
                    payload: {
                        approvalId: interruption.approvalId,
                        callId: interruption.callId,
                        decision: kind
                    }
                }
            ];
            if (paused && nextInterruption !== null) {
                resolutionEvents.push({
                    type: 'approval.required',
                    payload: {
                        approvalId: nextInterruption.approvalId,
                        callId: nextInterruption.callId
                    }
                }, { type: 'run.paused', payload: { reason: 'approval_required' } });
            }
            else {
                resolutionEvents.push({ type: 'run.resumed', payload: { reason: 'approval_resolved' } }, ...this.#toolExecutionEvents(resolvedLedger));
            }
            const next = this.#next(checkpoint, paused ? 'waiting_approval' : 'executing_tools', {
                toolLedgers: this.#replaceLastLedger(checkpoint, resolvedLedger),
                preparedBatch,
                interruption: nextInterruption,
                approvalHistory: history,
                deadlineAt
            }, resolutionEvents);
            let stored;
            try {
                stored = await this.#store.compareAndSet(checkpoint, next);
            }
            catch (error) {
                if (error instanceof RunStoreConflictError)
                    return null;
                throw error;
            }
            this.#notifyNewEvents(checkpoint, stored);
            if (stored.status === 'waiting_approval')
                return terminalResult(stored);
            const timer = this.#deadlineTimer(stored, controller);
            try {
                return await this.#drive(stored, controller);
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                const latest = await this.#store.load(input.runId).catch(() => null);
                if (latest === null || isTerminalRunStatus(latest.status)) {
                    this.#cleanupRun(input.runId, controller);
                }
            }
        }
        finally {
            detach();
        }
    }
    async start(input, options = {}) {
        const createdAt = this.#timestamp();
        const event = createRunEvent({
            eventId: this.#generateId(),
            runId: input.runId,
            sessionId: input.sessionId,
            sequence: 0,
            occurredAt: createdAt,
            type: 'run.created',
            payload: EMPTY_PAYLOAD
        });
        const model = Object.freeze({
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
        });
        const checkpoint = createInitialRunCheckpoint({
            profileId: this.#profile.id,
            profileVersion: this.#profile.version,
            runId: input.runId,
            sessionId: input.sessionId,
            sessionAddress: input.sessionAddress,
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
        });
        let stored;
        try {
            stored = await this.#store.create(checkpoint);
        }
        catch (error) {
            return Object.freeze({
                kind: 'failed',
                runId: input.runId,
                error: serializeAgentError(asAgentError(error))
            });
        }
        this.#notify(event);
        this.#runtimeBindings.set(input.runId, input.runtime);
        const controller = new AbortController();
        this.#controllers.set(input.runId, controller);
        const detach = this.#linkExternalSignal(options.signal, controller);
        const timer = this.#deadlineTimer(stored, controller);
        try {
            if (this.#deadlineExpired(stored)) {
                return await this.cancel(input.runId, 'deadline_exceeded');
            }
            return await this.#drive(stored, controller);
        }
        finally {
            detach();
            if (timer !== undefined)
                clearTimeout(timer);
            const latest = await this.#store.load(input.runId).catch(() => null);
            if (latest === null || isTerminalRunStatus(latest.status)) {
                this.#cleanupRun(input.runId, controller);
            }
        }
    }
    async resume(runId, runtime, options = {}) {
        if (runtime !== undefined)
            this.#runtimeBindings.set(runId, runtime);
        let checkpoint;
        try {
            checkpoint = await this.#store.load(runId);
        }
        catch (error) {
            this.#runtimeBindings.delete(runId);
            return Object.freeze({
                kind: 'failed',
                runId,
                error: serializeAgentError(asAgentError(error))
            });
        }
        if (checkpoint === null) {
            this.#runtimeBindings.delete(runId);
            return Object.freeze({
                kind: 'failed',
                runId,
                error: serializeAgentError(new AgentError({
                    code: 'checkpoint_invalid',
                    stage: 'run.resume',
                    retryable: false,
                    userMessage: '任务状态不存在或已失效。'
                }))
            });
        }
        if (isTerminalRunStatus(checkpoint.status) || checkpoint.status === 'waiting_approval') {
            return terminalResult(checkpoint);
        }
        const controller = this.#controllers.get(runId) ?? new AbortController();
        this.#controllers.set(runId, controller);
        const detach = this.#linkExternalSignal(options.signal, controller);
        const timer = this.#deadlineTimer(checkpoint, controller);
        try {
            let resumable = checkpoint;
            try {
                this.#assertRecoveredCompatibility(resumable);
                if (resumable.status === 'executing_tools') {
                    resumable = await this.#recoverExecutingTools(resumable);
                    if (isTerminalRunStatus(resumable.status))
                        return terminalResult(resumable);
                }
            }
            catch (error) {
                const failed = await this.#fail(resumable, asAgentError(error));
                return terminalResult(failed);
            }
            return await this.#drive(resumable, controller);
        }
        finally {
            detach();
            if (timer !== undefined)
                clearTimeout(timer);
            const latest = await this.#store.load(runId).catch(() => null);
            if (latest === null || isTerminalRunStatus(latest.status)) {
                this.#cleanupRun(runId, controller);
            }
        }
    }
    async cancel(runId, reason = 'user_cancelled') {
        const cancellationReason = boundedCancellationReason(reason);
        this.#controllers.get(runId)?.abort(cancellationReason);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const checkpoint = await this.#store.load(runId);
            if (checkpoint === null) {
                return Object.freeze({ kind: 'cancelled', runId, reason: cancellationReason });
            }
            if (isTerminalRunStatus(checkpoint.status))
                return terminalResult(checkpoint);
            const started = this.#startedToolCalls.get(runId) ?? new Set();
            const ledgers = checkpoint.toolLedgers.map((ledger, index, all) => (index === all.length - 1
                ? cancelToolExecutionLedger(ledger, started)
                : ledger));
            const next = this.#next(checkpoint, 'cancelled', {
                toolLedgers: Object.freeze(ledgers),
                preparedBatch: null,
                interruption: null,
                modelTurn: null,
                cancellationReason
            }, [{ type: 'run.cancelled', payload: { reason: cancellationReason } }]);
            try {
                const stored = await this.#store.compareAndSet(checkpoint, next);
                this.#notifyNewEvents(checkpoint, stored);
                return terminalResult(stored);
            }
            catch (error) {
                if (!(error instanceof RunStoreConflictError))
                    throw error;
            }
        }
        return Object.freeze({
            kind: 'failed',
            runId,
            error: serializeAgentError(checkpointConflict())
        });
    }
    #assertRecoveredCompatibility(checkpoint) {
        if (checkpoint.profileId !== this.#profile.id ||
            checkpoint.profileVersion !== this.#profile.version) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'run.profile',
                retryable: false,
                userMessage: '任务模型兼容配置已变化，请重新发起。'
            });
        }
        const runtime = this.#runtime(checkpoint.runId);
        this.#assertSnapshot(checkpoint, runtime.snapshot);
    }
    async #recoverExecutingTools(checkpoint) {
        const ledger = checkpoint.toolLedgers.at(-1);
        if (ledger === undefined || ledger.step !== checkpoint.step ||
            checkpoint.preparedBatch === null) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'run.recovery',
                retryable: false,
                userMessage: '任务工具状态不完整，请重新发起。'
            });
        }
        if (toolLedgerHasUnresolvedNonRead(ledger)) {
            const failedLedger = failRecoveredToolExecutionLedger(ledger);
            return await this.#fail(checkpoint, toolOutcomeUnknown(), ledger.calls
                .filter(call => call.status !== 'succeeded' && call.status !== 'failed' &&
                call.status !== 'denied' && call.status !== 'rejected' &&
                call.status !== 'expired' && call.status !== 'cancelled' &&
                call.status !== 'indeterminate')
                .map(call => ({
                type: 'tool.failed',
                payload: {
                    callId: call.callId,
                    toolName: call.toolName,
                    reason: 'recovery_outcome_unknown'
                }
            })), {
                toolLedgers: this.#replaceLastLedger(checkpoint, failedLedger),
                preparedBatch: null
            });
        }
        const remainingToolCalls = checkpoint.budgetCounters.toolCalls - ledger.calls.length;
        if (remainingToolCalls < 0) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'run.recovery',
                retryable: false,
                userMessage: '任务工具预算状态不完整，请重新发起。'
            });
        }
        const resetLedger = resetToolExecutionLedgerForRecovery(ledger);
        const occurredAt = this.#timestamp();
        const event = createRunEvent({
            eventId: this.#generateId(),
            runId: checkpoint.runId,
            sessionId: checkpoint.sessionId,
            sequence: checkpoint.nextEventSequence,
            occurredAt,
            type: 'run.resumed',
            payload: { reason: 'read_only_recovery' }
        });
        const next = recoverExecutingRunCheckpoint(checkpoint, {
            toolLedgers: this.#replaceLastLedger(checkpoint, resetLedger),
            preparedBatch: null,
            budgetCounters: Object.freeze({
                ...checkpoint.budgetCounters,
                toolCalls: remainingToolCalls
            })
        }, [event], occurredAt);
        try {
            const stored = await this.#store.compareAndSet(checkpoint, next);
            this.#notifyNewEvents(checkpoint, stored);
            return stored;
        }
        catch (error) {
            if (error instanceof RunStoreConflictError)
                throw checkpointConflict(error);
            throw error;
        }
    }
    async #drive(initial, controller) {
        let checkpoint = initial;
        while (!isTerminalRunStatus(checkpoint.status)) {
            if (checkpoint.status === 'waiting_approval')
                return terminalResult(checkpoint);
            if (controller.signal.aborted) {
                return await this.cancel(checkpoint.runId, this.#signalCancellationReason(controller.signal));
            }
            if (this.#deadlineExpired(checkpoint)) {
                return await this.cancel(checkpoint.runId, 'deadline_exceeded');
            }
            try {
                checkpoint = await this.#advance(checkpoint, controller.signal);
            }
            catch (error) {
                if (isAbortError(error) || controller.signal.aborted) {
                    return await this.cancel(checkpoint.runId, this.#signalCancellationReason(controller.signal));
                }
                checkpoint = await this.#fail(checkpoint, asAgentError(error));
            }
        }
        return terminalResult(checkpoint);
    }
    async #advance(checkpoint, signal) {
        this.#assertNotAborted(signal);
        switch (checkpoint.status) {
            case 'created': return await this.#prepare(checkpoint, signal);
            case 'preparing': return await this.#reserveNormalTurn(checkpoint);
            case 'calling_model': return checkpoint.visibleOutput
                ? await this.#completeVisibleOutput(checkpoint)
                : checkpoint.modelTurn === null
                    ? await this.#beginCorrection(checkpoint)
                    : await this.#callModel(checkpoint, signal, false);
            case 'evaluating_tools': return await this.#preflightTools(checkpoint, signal);
            case 'executing_tools': return await this.#executeTools(checkpoint, signal);
            case 'correcting': return await this.#callModel(checkpoint, signal, true);
            default: throw new TypeError(`run state ${checkpoint.status} cannot be advanced`);
        }
    }
    async #prepare(checkpoint, signal) {
        const runtime = this.#runtime(checkpoint.runId);
        const context = await this.#raceAbort(runtime.prepareContext(signal), signal);
        if (!Number.isSafeInteger(context.estimatedInputTokens) ||
            context.estimatedInputTokens < 0 || !Array.isArray(context.messages)) {
            throw new TypeError('prepared run context is invalid');
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
        ]);
    }
    async #reserveNormalTurn(checkpoint) {
        const reservation = this.#reserveModelTurn(checkpoint, 'normal');
        return await this.#commit(checkpoint, 'calling_model', {
            budgetCounters: reservation.counters,
            modelTurn: reservation.turn
        }, [{
                type: 'model.started',
                payload: { kind: 'normal', turn: reservation.counters.modelTurns }
            }]);
    }
    async #beginCorrection(checkpoint) {
        let counters = this.#budget.recordCorrection(checkpoint.budgetCounters);
        const maxOutputTokens = this.#availableOutputTokens(checkpoint, counters);
        counters = this.#budget.reserveModelTurn(counters, {
            kind: 'correction',
            estimatedInputTokens: checkpoint.estimatedInputTokens,
            maxOutputTokens
        });
        return await this.#commit(checkpoint, 'correcting', {
            budgetCounters: counters,
            modelTurn: Object.freeze({ kind: 'correction', maxOutputTokens })
        }, [{
                type: 'model.started',
                payload: { kind: 'correction', turn: counters.modelTurns }
            }]);
    }
    #reserveModelTurn(checkpoint, kind) {
        const maxOutputTokens = this.#availableOutputTokens(checkpoint, checkpoint.budgetCounters);
        const counters = this.#budget.reserveModelTurn(checkpoint.budgetCounters, {
            kind,
            estimatedInputTokens: checkpoint.estimatedInputTokens,
            maxOutputTokens
        });
        return Object.freeze({
            counters,
            turn: Object.freeze({ kind, maxOutputTokens })
        });
    }
    #availableOutputTokens(checkpoint, counters) {
        const remaining = checkpoint.budgetLimits.maxEstimatedTokens -
            counters.estimatedTokens - checkpoint.estimatedInputTokens;
        return Math.min(checkpoint.model.maxOutputTokens, Math.max(1, remaining));
    }
    async #callModel(checkpoint, signal, correction) {
        const reserved = checkpoint.modelTurn;
        if (reserved === null || reserved.kind !== (correction ? 'correction' : 'normal')) {
            throw new TypeError('reserved model turn does not match run state');
        }
        let attempted;
        try {
            attempted = await this.#attemptModel(checkpoint, reserved, signal, correction);
        }
        catch (error) {
            if (!(error instanceof ModelAttemptFailure))
                throw error;
            return await this.#fail(checkpoint, error.agentError, [], {
                budgetCounters: error.counters,
                messages: error.messages,
                estimatedInputTokens: error.estimatedInputTokens,
                recoveryUsed: error.recoveryUsed,
                modelTurn: null
            });
        }
        return await this.#evaluateModelTurn(checkpoint, attempted, correction);
    }
    async #attemptModel(checkpoint, reserved, signal, correction) {
        const runtime = this.#runtime(checkpoint.runId);
        this.#assertSnapshot(checkpoint, runtime.snapshot);
        let counters = checkpoint.budgetCounters;
        let messages = checkpoint.messages;
        let estimatedInputTokens = checkpoint.estimatedInputTokens;
        let recoveryUsed = checkpoint.recoveryUsed;
        try {
            while (true) {
                const request = Object.freeze({
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
                });
                const startedAt = performance.now();
                let turn;
                try {
                    const timeoutMs = this.#providerTimeout(checkpoint, counters);
                    turn = await this.#providerCall(request, signal, timeoutMs);
                }
                catch (error) {
                    if (isAbortError(error) || signal.aborted)
                        throw new RunAbortedError();
                    const activeRuntimeMs = Math.max(0, Math.ceil(performance.now() - startedAt));
                    counters = this.#budget.recordUsage(counters, { activeRuntimeMs });
                    if (error instanceof ModelProviderError) {
                        const recoveryHint = this.#profile.recoveryHint(error);
                        const recoveryAllowed = reserved.kind === 'normal' &&
                            checkpoint.budgetCounters.modelTurns === 1 &&
                            checkpoint.step === 0 &&
                            checkpoint.toolLedgers.length === 0 &&
                            counters.recoveryAttempts < checkpoint.budgetLimits.maxRecoveryAttempts;
                        if (recoveryHint === 'drop_optional_context_once' && recoveryAllowed &&
                            !recoveryUsed && runtime.recoverContext !== undefined) {
                            const recovered = await this.#raceAbort(runtime.recoverContext(checkpoint, error, signal), signal);
                            if (recovered !== undefined) {
                                if (!Number.isSafeInteger(recovered.estimatedInputTokens) ||
                                    recovered.estimatedInputTokens < 0 || !Array.isArray(recovered.messages)) {
                                    throw new TypeError('recovered run context is invalid');
                                }
                                counters = this.#budget.recordRecovery(counters);
                                recoveryUsed = true;
                                messages = Object.freeze([...recovered.messages]);
                                estimatedInputTokens = recovered.estimatedInputTokens;
                                continue;
                            }
                        }
                        if (error.retryable &&
                            counters.providerRetries < checkpoint.budgetLimits.maxProviderRetries) {
                            counters = this.#budget.recordProviderRetry(counters);
                            continue;
                        }
                        throw error;
                    }
                    throw internalError(error);
                }
                const activeRuntimeMs = Math.max(0, Math.ceil(performance.now() - startedAt));
                counters = this.#budget.recordUsage(counters, {
                    activeRuntimeMs,
                    providerReportedTokens: turn.usage?.totalTokens ?? 0
                });
                return Object.freeze({
                    turn,
                    counters,
                    messages,
                    estimatedInputTokens,
                    recoveryUsed
                });
            }
        }
        catch (error) {
            if (isAbortError(error) || signal.aborted)
                throw new RunAbortedError();
            throw new ModelAttemptFailure(asAgentError(error), {
                counters,
                messages,
                estimatedInputTokens,
                recoveryUsed
            });
        }
    }
    async #evaluateModelTurn(checkpoint, attempted, correction) {
        const { turn } = attempted;
        const completedEvent = {
            type: 'model.completed',
            payload: {
                kind: correction ? 'correction' : 'normal',
                finishReason: turn.finishReason,
                toolCallCount: turn.toolCalls.length
            }
        };
        if (turn.refusal !== undefined && turn.refusal.length > 0) {
            return await this.#fail(checkpoint, modelProtocolError('provider_refusal'), [completedEvent], {
                budgetCounters: attempted.counters,
                messages: attempted.messages,
                estimatedInputTokens: attempted.estimatedInputTokens,
                recoveryUsed: attempted.recoveryUsed,
                modelTurn: null
            }, { reason: 'provider_refusal' });
        }
        if (turn.toolCalls.length > 0) {
            if (correction || turn.finishReason !== 'tool_calls') {
                return await this.#fail(checkpoint, modelProtocolError(correction ? 'correction_contains_tool_calls' : 'tool_calls_finish_reason_missing'), [completedEvent], {
                    budgetCounters: attempted.counters,
                    messages: attempted.messages,
                    estimatedInputTokens: attempted.estimatedInputTokens,
                    recoveryUsed: attempted.recoveryUsed,
                    modelTurn: null
                });
            }
            let ledger;
            try {
                ledger = createToolExecutionLedger(checkpoint.step, turn.toolCalls);
            }
            catch {
                return await this.#fail(checkpoint, modelProtocolError('invalid_tool_call_identity'), [completedEvent], {
                    budgetCounters: attempted.counters,
                    messages: attempted.messages,
                    estimatedInputTokens: attempted.estimatedInputTokens,
                    recoveryUsed: attempted.recoveryUsed,
                    modelTurn: null
                });
            }
            const sortedCalls = [...turn.toolCalls].sort((left, right) => left.index - right.index);
            const assistant = Object.freeze({
                role: 'assistant',
                content: turn.text.length === 0 ? null : turn.text,
                toolCalls: Object.freeze(sortedCalls.map(call => Object.freeze({
                    callId: call.callId,
                    name: call.name,
                    arguments: call.arguments
                }))),
                ...(turn.providerState === undefined ? {} : { providerState: turn.providerState })
            });
            const messages = Object.freeze([...attempted.messages, assistant]);
            const estimatedInputTokens = attempted.estimatedInputTokens + estimatedTokensFor(assistant);
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
            ]);
        }
        const text = turn.text.normalize('NFC').trim();
        if (turn.finishReason === 'stop' && text.length > 0) {
            const output = this.#assistantMessage(checkpoint, text);
            return await this.#commit(checkpoint, 'completed', {
                messages: attempted.messages,
                estimatedInputTokens: attempted.estimatedInputTokens,
                budgetCounters: attempted.counters,
                recoveryUsed: attempted.recoveryUsed,
                modelTurn: null,
                output,
                visibleOutput: false
            }, [completedEvent, { type: 'run.completed', payload: { visibleOutput: false } }]);
        }
        if (correction) {
            return await this.#fail(checkpoint, modelProtocolError('invalid_correction_response'), [completedEvent], {
                budgetCounters: attempted.counters,
                messages: attempted.messages,
                estimatedInputTokens: attempted.estimatedInputTokens,
                recoveryUsed: attempted.recoveryUsed,
                modelTurn: null
            });
        }
        let counters;
        let maxOutputTokens;
        try {
            counters = this.#budget.recordCorrection(attempted.counters);
            maxOutputTokens = this.#availableOutputTokens(checkpoint, counters);
            counters = this.#budget.reserveModelTurn(counters, {
                kind: 'correction',
                estimatedInputTokens: attempted.estimatedInputTokens,
                maxOutputTokens
            });
        }
        catch (error) {
            return await this.#fail(checkpoint, asAgentError(error), [completedEvent], {
                budgetCounters: attempted.counters,
                messages: attempted.messages,
                estimatedInputTokens: attempted.estimatedInputTokens,
                recoveryUsed: attempted.recoveryUsed,
                modelTurn: null
            });
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
        ]);
    }
    async #preflightTools(checkpoint, signal) {
        const ledger = checkpoint.toolLedgers.at(-1);
        if (ledger === undefined || ledger.step !== checkpoint.step) {
            throw new TypeError('planned tool ledger is missing');
        }
        let counters;
        try {
            counters = this.#budget.reserveToolBatch(checkpoint.budgetCounters, ledger.calls.length);
        }
        catch (error) {
            if (!(error instanceof AgentError) || error.code !== 'run_budget_exceeded')
                throw error;
            const failedLedger = failToolExecutionLedger(ledger, failedToolResult());
            return await this.#commit(checkpoint, 'executing_tools', {
                toolLedgers: this.#replaceLastLedger(checkpoint, failedLedger),
                preparedBatch: completedBatchFromLedger(failedLedger),
                forceCorrection: true
            }, ledger.calls.map(call => ({
                type: 'tool.failed',
                payload: { callId: call.callId, toolName: call.toolName, reason: 'tool_budget_exceeded' }
            })));
        }
        const runtime = this.#runtime(checkpoint.runId);
        this.#assertSnapshot(checkpoint, runtime.snapshot);
        const preparationContext = await this.#raceAbort(runtime.prepareToolContext(checkpoint, signal), signal);
        const calls = Object.freeze(ledger.calls.map(call => Object.freeze({
            runId: checkpoint.runId,
            callId: call.callId,
            snapshotId: checkpoint.toolSnapshot.id,
            requestedName: call.toolName,
            arguments: call.arguments
        })));
        const preflight = await this.#raceAbort(this.#scheduler.preflight(calls, {
            snapshot: runtime.snapshot,
            context: preparationContext,
            remainingToolCalls: checkpoint.budgetLimits.maxToolCalls -
                checkpoint.budgetCounters.toolCalls
        }), signal);
        if (preflight.kind === 'failed') {
            const failedLedger = failToolExecutionLedger(ledger, failedToolResult());
            return await this.#commit(checkpoint, 'executing_tools', {
                toolLedgers: this.#replaceLastLedger(checkpoint, failedLedger),
                preparedBatch: completedBatchFromLedger(failedLedger),
                budgetCounters: counters,
                forceCorrection: true
            }, ledger.calls.map(call => ({
                type: 'tool.failed',
                payload: { callId: call.callId, toolName: call.toolName, reason: preflight.code }
            })));
        }
        let preparedLedger = applyToolPreflight(ledger, preflight.batch);
        let preparedBatch = preflight.batch;
        if (preflight.kind === 'approval_required') {
            const activated = await this.#activateNextApproval(checkpoint, preparedBatch, preparedLedger, preparationContext, signal);
            preparedBatch = activated.batch;
            preparedLedger = activated.ledger;
            if (activated.interruption !== null) {
                return await this.#commit(checkpoint, 'waiting_approval', {
                    toolLedgers: this.#replaceLastLedger(checkpoint, preparedLedger),
                    preparedBatch,
                    budgetCounters: counters,
                    interruption: activated.interruption
                }, [
                    {
                        type: 'approval.required',
                        payload: {
                            approvalId: activated.interruption.approvalId,
                            callId: activated.interruption.callId
                        }
                    },
                    { type: 'run.paused', payload: { reason: 'approval_required' } }
                ]);
            }
        }
        return await this.#commit(checkpoint, 'executing_tools', {
            toolLedgers: this.#replaceLastLedger(checkpoint, preparedLedger),
            preparedBatch,
            budgetCounters: counters
        }, this.#toolExecutionEvents(preparedLedger));
    }
    async #executeTools(checkpoint, signal) {
        const batch = checkpoint.preparedBatch;
        const ledger = checkpoint.toolLedgers.at(-1);
        if (batch === null || ledger === undefined) {
            throw new TypeError('prepared tool execution state is missing');
        }
        const runtime = this.#runtime(checkpoint.runId);
        this.#assertSnapshot(checkpoint, runtime.snapshot);
        this.#startedToolCalls.set(checkpoint.runId, new Set());
        const execution = await this.#raceAbort(this.#scheduler.execute(batch, {
            snapshot: runtime.snapshot,
            contextFor: async (capability) => {
                const context = await runtime.contextFor(capability, checkpoint, signal);
                this.#assertNotAborted(signal);
                const approved = checkpoint.approvalHistory.find(item => (item.callId === capability.callId && item.step === checkpoint.step &&
                    item.decision?.kind === 'approved'));
                this.#markToolStarted(checkpoint.runId, capability.callId);
                return approved?.decision === undefined
                    ? context
                    : Object.freeze({ ...context, approval: approved.decision });
            },
            signal
        }), signal);
        const completedLedger = completeToolExecutionLedger(ledger, execution.results);
        const forceCorrection = checkpoint.forceCorrection ||
            toolLedgerRequiresToolDisabledFinalResponse(completedLedger);
        const toolMessages = toolLedgerModelMessages(completedLedger);
        const messages = Object.freeze([...checkpoint.messages, ...toolMessages]);
        const estimatedInputTokens = checkpoint.estimatedInputTokens +
            toolMessages.reduce((total, message) => total + estimatedTokensFor(message), 0);
        const events = completedLedger.calls.map(call => ({
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
        }));
        const common = {
            messages,
            estimatedInputTokens,
            toolLedgers: this.#replaceLastLedger(checkpoint, completedLedger),
            preparedBatch: null,
            interruption: null,
            modelTurn: null,
            forceCorrection
        };
        if (toolLedgerHasVisibleOutput(completedLedger)) {
            const readyToComplete = await this.#commit(checkpoint, 'calling_model', {
                ...common,
                output: null,
                visibleOutput: true,
                step: checkpoint.step + 1
            }, events);
            if (isTerminalRunStatus(readyToComplete.status))
                return readyToComplete;
            const completed = await this.#completeVisibleOutput(readyToComplete);
            this.#startedToolCalls.delete(checkpoint.runId);
            return completed;
        }
        if (toolLedgerHasIndeterminate(completedLedger)) {
            const failed = await this.#fail(checkpoint, toolOutcomeUnknown(), events, common);
            this.#startedToolCalls.delete(checkpoint.runId);
            return failed;
        }
        const normalLimit = checkpoint.budgetLimits.maxModelTurns -
            checkpoint.budgetLimits.maxCorrectionTurns;
        if (!forceCorrection && checkpoint.budgetCounters.modelTurns < normalLimit) {
            const reservationCheckpoint = Object.freeze({
                ...checkpoint,
                messages,
                estimatedInputTokens
            });
            const reservation = this.#reserveModelTurn(reservationCheckpoint, 'normal');
            const next = await this.#commit(checkpoint, 'calling_model', {
                ...common,
                step: checkpoint.step + 1,
                budgetCounters: reservation.counters,
                modelTurn: reservation.turn
            }, [...events, {
                    type: 'model.started',
                    payload: { kind: 'normal', turn: reservation.counters.modelTurns }
                }]);
            this.#startedToolCalls.delete(checkpoint.runId);
            return next;
        }
        const next = await this.#commit(checkpoint, 'calling_model', {
            ...common,
            step: checkpoint.step + 1
        }, events);
        this.#startedToolCalls.delete(checkpoint.runId);
        return next;
    }
    async #completeVisibleOutput(checkpoint) {
        if (checkpoint.status !== 'calling_model' || !checkpoint.visibleOutput ||
            checkpoint.output !== null || checkpoint.modelTurn !== null) {
            throw new TypeError('visible-output completion state is invalid');
        }
        return await this.#commit(checkpoint, 'completed', {}, [{
                type: 'run.completed',
                payload: { visibleOutput: true }
            }]);
    }
    async #providerCall(request, runSignal, timeoutMs) {
        this.#assertNotAborted(runSignal);
        const controller = new AbortController();
        let timedOut = false;
        const abort = () => controller.abort();
        runSignal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        timer.unref?.();
        try {
            const abortPromise = new Promise((_resolve, reject) => {
                controller.signal.addEventListener('abort', () => {
                    reject(timedOut
                        ? new ModelProviderError({
                            code: 'provider_timeout',
                            stage: 'model.response',
                            retryable: true,
                            userMessage: 'AI 服务响应超时，请稍后重试。'
                        })
                        : new RunAbortedError());
                }, { once: true });
            });
            return await Promise.race([
                this.#adapter.complete(request, controller.signal),
                abortPromise
            ]);
        }
        finally {
            clearTimeout(timer);
            runSignal.removeEventListener('abort', abort);
        }
    }
    #providerTimeout(checkpoint, counters) {
        const deadlineRemaining = new Date(checkpoint.deadlineAt).getTime() - this.#now().getTime();
        const activeRemaining = this.#budget.remainingActiveMs(counters);
        const timeout = Math.min(checkpoint.budgetLimits.providerTimeoutMs, deadlineRemaining, activeRemaining);
        if (timeout <= 0)
            throw new RunAbortedError();
        return Math.max(1, Math.floor(timeout));
    }
    async #raceAbort(promise, signal) {
        this.#assertNotAborted(signal);
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(new RunAbortedError());
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([promise, aborted]);
        }
        finally {
            if (onAbort !== undefined)
                signal.removeEventListener('abort', onAbort);
        }
    }
    async #commit(checkpoint, status, changes, drafts) {
        const next = this.#next(checkpoint, status, changes, drafts);
        try {
            const stored = await this.#store.compareAndSet(checkpoint, next);
            this.#notifyNewEvents(checkpoint, stored);
            return stored;
        }
        catch (error) {
            if (error instanceof RunStoreConflictError) {
                const latest = await this.#store.load(checkpoint.runId);
                if (latest !== null && isTerminalRunStatus(latest.status))
                    return latest;
                throw checkpointConflict(error);
            }
            throw error;
        }
    }
    #next(checkpoint, status, changes, drafts) {
        const occurredAt = this.#timestamp();
        const events = drafts.map((draft, offset) => createRunEvent({
            eventId: this.#generateId(),
            runId: checkpoint.runId,
            sessionId: checkpoint.sessionId,
            sequence: checkpoint.nextEventSequence + offset,
            occurredAt,
            type: draft.type,
            payload: draft.payload ?? EMPTY_PAYLOAD
        }));
        return nextRunCheckpoint(checkpoint, status, changes, events, occurredAt);
    }
    async #fail(checkpoint, error, prefixEvents = [], changes = {}, detailOverride) {
        if (isTerminalRunStatus(checkpoint.status))
            return checkpoint;
        this.#controllers.get(checkpoint.runId)?.abort('fatal_error');
        const serialized = detailOverride === undefined
            ? serializeAgentError(error)
            : Object.freeze({
                ...serializeAgentError(error),
                details: Object.freeze({ ...error.details, ...detailOverride })
            });
        return await this.#commit(checkpoint, 'failed', {
            ...changes,
            modelTurn: null,
            preparedBatch: null,
            interruption: null,
            error: serialized
        }, [...prefixEvents, {
                type: 'run.failed',
                payload: { code: serialized.code, stage: serialized.stage }
            }]);
    }
    #assistantMessage(checkpoint, text) {
        const createdAt = this.#timestamp();
        return Object.freeze({
            id: this.#generateId(),
            role: 'assistant',
            parts: Object.freeze([{ type: 'text', text }]),
            createdAt,
            provenance: Object.freeze({
                source: 'model',
                trust: 'untrusted',
                sensitivity: 'group',
                sourceId: checkpoint.runId,
                createdAt
            })
        });
    }
    async #revalidateApprovedCapability(checkpoint, capability, interruption, approver, signal) {
        const runtime = this.#runtime(checkpoint.runId);
        this.#assertSnapshot(checkpoint, runtime.snapshot);
        const context = await this.#raceAbort(runtime.prepareToolContext(checkpoint, signal), signal);
        const currentRole = actorRole(context);
        if (context.profile !== interruption.approverPolicy.profile ||
            context.facts.botId !== checkpoint.sessionAddress.botId ||
            context.facts.actor.userId !== interruption.requester.userId ||
            currentRole !== interruption.requester.role ||
            !sameAddress({
                botId: context.facts.botId,
                scope: context.facts.scope
            }, checkpoint.sessionAddress))
            return null;
        const currentControl = runtime.approvalControlContext === undefined
            ? Object.freeze({
                eligibleApprovers: Object.freeze([interruption.requester])
            })
            : await this.#raceAbort(runtime.approvalControlContext(checkpoint, context, signal), signal);
        if (!Array.isArray(currentControl.eligibleApprovers) ||
            !currentControl.eligibleApprovers.some(actor => (actor.userId === approver.userId && actor.role === approver.role)))
            return null;
        const call = Object.freeze({
            runId: checkpoint.runId,
            callId: capability.callId,
            snapshotId: checkpoint.toolSnapshot.id,
            requestedName: capability.toolName,
            arguments: capability.canonicalArguments
        });
        const preflight = await this.#raceAbort(this.#scheduler.preflight([call], {
            snapshot: runtime.snapshot,
            context,
            remainingToolCalls: 1
        }), signal);
        if (preflight.kind === 'failed' || preflight.batch.calls.length !== 1)
            return null;
        const prepared = preflight.batch.calls[0];
        if (prepared.kind === 'completed' || !sameJson(prepared.capability, capability))
            return null;
        return Object.freeze({ capability: prepared.capability, context });
    }
    async #activateNextApproval(checkpoint, inputBatch, inputLedger, inputContext, signal) {
        let batch = inputBatch;
        let ledger = inputLedger;
        let context = inputContext;
        while (true) {
            const index = batch.calls.findIndex(call => call.kind === 'approval_required');
            if (index < 0)
                return Object.freeze({ batch, ledger, interruption: null });
            const call = batch.calls[index];
            if (call.kind !== 'approval_required') {
                throw new TypeError('approval batch call is invalid');
            }
            if (context === undefined) {
                const runtime = this.#runtime(checkpoint.runId);
                this.#assertSnapshot(checkpoint, runtime.snapshot);
                context = await this.#raceAbort(runtime.prepareToolContext(checkpoint, signal), signal);
            }
            const interruption = await this.#approvalInterruption(checkpoint, call.capability, context, signal);
            if (interruption !== null) {
                return Object.freeze({ batch, ledger, interruption });
            }
            const result = approvalUnavailableResult();
            batch = this.#replacePreparedCall(batch, index, completedPreparedCall(call.capability.callId, call.capability.toolName, result));
            ledger = resolveToolApproval(ledger, call.capability.callId, {
                kind: 'denied', result
            });
        }
    }
    async #approvalInterruption(checkpoint, capability, context, signal) {
        const createdAt = this.#timestamp();
        const role = actorRole(context);
        const profile = context.profile;
        const allowedRoles = Object.freeze([
            'bot_master', 'group_owner', 'group_admin'
        ]);
        const requester = Object.freeze({
            userId: context.facts.actor.userId,
            role
        });
        const runtime = this.#runtime(checkpoint.runId);
        const control = runtime.approvalControlContext === undefined
            ? Object.freeze({ eligibleApprovers: Object.freeze([requester]) })
            : await this.#raceAbort(runtime.approvalControlContext(checkpoint, context, signal), signal);
        if (!Array.isArray(control.eligibleApprovers) ||
            control.eligibleApprovers.length > 32) {
            throw new TypeError('approval control context is invalid');
        }
        const seen = new Set();
        let eligible = control.eligibleApprovers.map(actor => {
            if (typeof actor.userId !== 'string' || actor.userId.length === 0 ||
                actor.userId.length > 128 ||
                !['bot_master', 'group_owner', 'group_admin', 'member'].includes(actor.role)) {
                throw new TypeError('approval control actor is invalid');
            }
            return Object.freeze({ userId: actor.userId, role: actor.role });
        }).filter(actor => {
            if (!allowedRoles.includes(actor.role) || seen.has(actor.userId))
                return false;
            seen.add(actor.userId);
            return profile !== 'strict' || actor.userId !== requester.userId;
        });
        if (eligible.length === 0)
            return null;
        let approvalAddress;
        if (checkpoint.sessionAddress.scope.kind === 'private') {
            const selected = eligible.find(actor => (actor.userId === requester.userId && profile !== 'strict')) ?? eligible.find(actor => actor.role === 'bot_master');
            if (selected === undefined)
                return null;
            eligible = [selected];
            approvalAddress = Object.freeze({
                botId: checkpoint.sessionAddress.botId,
                scope: Object.freeze({ kind: 'private', userId: selected.userId })
            });
        }
        else {
            approvalAddress = Object.freeze({
                botId: checkpoint.sessionAddress.botId,
                scope: Object.freeze({
                    kind: 'group',
                    groupId: checkpoint.sessionAddress.scope.groupId
                })
            });
        }
        return parseApprovalInterruption({
            schemaVersion: 1,
            approvalId: this.#generateId(),
            runId: checkpoint.runId,
            step: checkpoint.step,
            callId: capability.callId,
            toolFingerprint: checkpoint.toolSnapshot.fingerprint,
            argumentHash: capability.argumentHash,
            action: capability.toolName,
            target: targetLabel(capability),
            keyParameters: approvalKeyParameters(capability),
            requester,
            approverPolicy: Object.freeze({
                profile,
                allowedRoles,
                eligibleActorIds: Object.freeze(eligible.map(actor => actor.userId)),
                requireDifferentActor: profile === 'strict'
            }),
            approvalAddress,
            createdAt
        });
    }
    #replacePreparedCall(batch, index, replacement) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= batch.calls.length) {
            throw new TypeError('prepared tool call index is invalid');
        }
        return Object.freeze({
            schemaVersion: 1,
            calls: Object.freeze(batch.calls.map((call, position) => (position === index ? replacement : call)))
        });
    }
    #toolExecutionEvents(ledger) {
        return ledger.calls.flatMap(call => {
            const requested = {
                type: 'tool.requested',
                payload: { callId: call.callId, toolName: call.toolName }
            };
            if (call.status === 'ready') {
                return [requested, {
                        type: 'tool.started',
                        payload: { callId: call.callId, toolName: call.toolName }
                    }];
            }
            if (call.status === 'succeeded') {
                return [requested, {
                        type: 'tool.completed',
                        payload: { callId: call.callId, toolName: call.toolName, status: call.status }
                    }];
            }
            if (call.status === 'denied' || call.status === 'rejected' ||
                call.status === 'expired') {
                return [requested, {
                        type: 'tool.denied',
                        payload: { callId: call.callId, toolName: call.toolName, status: call.status }
                    }];
            }
            return [requested, {
                    type: 'tool.failed',
                    payload: { callId: call.callId, toolName: call.toolName, status: call.status }
                }];
        });
    }
    #replaceLastLedger(checkpoint, ledger) {
        if (checkpoint.toolLedgers.length === 0) {
            throw new TypeError('tool ledger replacement target is missing');
        }
        return Object.freeze([
            ...checkpoint.toolLedgers.slice(0, -1),
            ledger
        ]);
    }
    #markToolStarted(runId, callId) {
        const started = this.#startedToolCalls.get(runId) ?? new Set();
        started.add(callId);
        this.#startedToolCalls.set(runId, started);
    }
    #assertSnapshot(checkpoint, snapshot) {
        if (snapshot.id !== checkpoint.toolSnapshot.id ||
            snapshot.fingerprint !== checkpoint.toolSnapshot.fingerprint) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'run.snapshot',
                retryable: false,
                userMessage: '任务工具配置已变化，请重新发起。'
            });
        }
    }
    #runtime(runId) {
        const runtime = this.#runtimeBindings.get(runId);
        if (runtime === undefined) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'run.runtime',
                retryable: false,
                userMessage: '任务运行环境不可用，请重新发起。'
            });
        }
        return runtime;
    }
    #timestamp() {
        return this.#now().toISOString();
    }
    #deadlineExpired(checkpoint) {
        return this.#now().getTime() >= new Date(checkpoint.deadlineAt).getTime();
    }
    #deadlineTimer(checkpoint, controller) {
        const remaining = new Date(checkpoint.deadlineAt).getTime() - this.#now().getTime();
        if (remaining <= 0)
            return undefined;
        const timer = setTimeout(() => {
            void this.cancel(checkpoint.runId, 'deadline_exceeded').catch(() => undefined);
        }, remaining);
        timer.unref?.();
        return timer;
    }
    #linkExternalSignal(signal, controller) {
        if (signal === undefined)
            return () => undefined;
        const abort = () => controller.abort(boundedCancellationReason(typeof signal.reason === 'string' ? signal.reason : 'user_cancelled'));
        if (signal.aborted)
            abort();
        else
            signal.addEventListener('abort', abort, { once: true });
        return () => signal.removeEventListener('abort', abort);
    }
    #assertNotAborted(signal) {
        if (signal.aborted)
            throw new RunAbortedError();
    }
    #signalCancellationReason(signal) {
        return boundedCancellationReason(typeof signal.reason === 'string' ? signal.reason : 'user_cancelled');
    }
    #cleanupRun(runId, controller) {
        this.#runtimeBindings.delete(runId);
        this.#startedToolCalls.delete(runId);
        if (this.#controllers.get(runId) === controller) {
            this.#controllers.delete(runId);
        }
    }
    #notifyNewEvents(previous, next) {
        for (const event of next.events.slice(previous.events.length))
            this.#notify(event);
    }
    #notify(event) {
        if (this.#observer === undefined)
            return;
        try {
            const result = this.#observer(event);
            if (result instanceof Promise)
                void result.catch(() => undefined);
        }
        catch {
            // Observers are deliberately outside the persisted control plane.
        }
    }
}
