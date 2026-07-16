import { randomUUID } from 'node:crypto';
import { AgentError, serializeAgentError } from '../agent/contracts/error.js';
import { RunAdmissionRejectionError } from '../agent/run/run-admission.js';
import { RunReferenceConflictError } from '../agent/run/run-store.js';
import { createFrozenObservationPolicy } from '../agent/run/run-observation.js';
import { createRunRef } from '../agent/run/run-reference.js';
import { isTerminalRunStatus } from '../agent/run/run-state.js';
import { parseAgentSessionState } from '../agent/session/agent-session-state.js';
import { activateRequestObservation, beginRequestObservation, createRequestObservationDraft } from './request-observation.js';
function isApprovalRecoveryDeferred(value) {
    return 'kind' in value && value.kind === 'approval_deferred';
}
const EMPTY_ITEMS = Object.freeze([]);
function internalError(cause) {
    return new AgentError({
        code: 'internal_error',
        stage: 'agent.service',
        retryable: false,
        userMessage: '处理请求时出现异常，请稍后重试。',
        cause
    });
}
function asAgentError(error) {
    return error instanceof AgentError ? error : internalError(error);
}
function failedRunResult(runId, error, runRef = 'unavailable') {
    return Object.freeze({
        kind: 'failed',
        runId,
        runRef,
        error: serializeAgentError(asAgentError(error)),
        terminal: null
    });
}
function cancellationReason(value, fallback = 'user_cancelled') {
    if (typeof value !== 'string')
        return fallback;
    const normalized = value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
        ? normalized
        : fallback;
}
function safeObservationLevel(read) {
    if (read === undefined)
        return 'basic';
    try {
        const value = read();
        return value === 'off' || value === 'diagnostic' || value === 'basic'
            ? value
            : 'basic';
    }
    catch {
        return 'basic';
    }
}
function freezeRequest(draft, runRef) {
    return Object.freeze({
        ...draft,
        schemaVersion: 2,
        runRef
    });
}
function cancelledRunResult(runId, reason = 'user_cancelled', runRef = 'unavailable') {
    return Object.freeze({
        kind: 'cancelled',
        runId,
        runRef,
        reason: cancellationReason(reason),
        terminal: null
    });
}
function readMonotonic(clock) {
    try {
        const value = clock();
        return value === 'unavailable' ||
            (Number.isSafeInteger(value) && Number(value) >= 0)
            ? value
            : 'unavailable';
    }
    catch {
        return 'unavailable';
    }
}
function elapsed(started, finished) {
    return started === 'unavailable' || finished === 'unavailable' || finished < started
        ? 'unavailable'
        : finished - started;
}
function linkedAbortSignal(callerSignal, lifecycleSignal) {
    const controller = new AbortController();
    const sources = callerSignal === undefined
        ? [lifecycleSignal]
        : [callerSignal, lifecycleSignal];
    const listeners = new Map();
    for (const source of sources) {
        const forward = () => {
            controller.abort(cancellationReason(source.reason));
        };
        if (source.aborted) {
            forward();
            break;
        }
        listeners.set(source, forward);
        source.addEventListener('abort', forward, { once: true });
    }
    return Object.freeze({
        signal: controller.signal,
        dispose: () => {
            for (const [source, listener] of listeners) {
                source.removeEventListener('abort', listener);
            }
            listeners.clear();
        }
    });
}
function contentPartText(part) {
    switch (part.type) {
        case 'text': return part.text;
        case 'resource_ref': return `[${part.resourceType}: ${part.resourceId}]`;
        case 'mention': return `@${part.displayName ?? part.userId}`;
        case 'tool_call': return `[工具调用: ${part.name}]`;
        case 'tool_result': return `[工具结果: ${part.status}] ${part.content}`;
    }
}
function messageText(message) {
    const text = message.parts.map(contentPartText).filter(value => value.length > 0).join('\n');
    return text.length === 0 ? '[空消息]' : text;
}
function modelMessageFor(item) {
    if (item.modelMessage !== undefined)
        return item.modelMessage;
    const content = messageText(item.message);
    if (item.message.role === 'system')
        return Object.freeze({ role: 'system', content });
    if (item.message.role === 'user')
        return Object.freeze({ role: 'user', content });
    if (item.message.role === 'assistant')
        return Object.freeze({ role: 'assistant', content });
    throw new AgentError({
        code: 'invalid_session',
        stage: 'context.session',
        retryable: false,
        userMessage: '会话历史格式不兼容，请重新开始对话。'
    });
}
function currentRunItemOrder(items) {
    const runtimeFacts = items.filter(item => item.source === 'runtime_fact');
    if (runtimeFacts.length === 0)
        return items;
    const ordered = items.filter(item => item.source !== 'runtime_fact');
    const currentIndex = ordered.findIndex(item => item.source === 'current_request');
    if (currentIndex < 0)
        return Object.freeze([...ordered, ...runtimeFacts]);
    return Object.freeze([
        ...ordered.slice(0, currentIndex),
        ...runtimeFacts,
        ...ordered.slice(currentIndex)
    ]);
}
function mergeableTextRole(message) {
    if (message.role === 'tool')
        return null;
    if (message.role !== 'assistant')
        return message.role;
    return typeof message.content === 'string' && message.toolCalls === undefined &&
        message.providerState === undefined
        ? 'assistant'
        : null;
}
function coalesceModelMessages(messages) {
    const result = [];
    for (const message of messages) {
        const role = mergeableTextRole(message);
        const previous = result.at(-1);
        if (role !== null && previous !== undefined &&
            mergeableTextRole(previous) === role) {
            result[result.length - 1] = Object.freeze({
                role,
                content: `${previous.content ?? ''}\n\n${message.content ?? ''}`
            });
        }
        else {
            result.push(message);
        }
    }
    return Object.freeze(result);
}
function systemItem(runId, instruction, index, createdAt) {
    const id = `system:${runId}:${index}`;
    return Object.freeze({
        id,
        source: 'system_instruction',
        message: Object.freeze({
            id,
            role: 'system',
            parts: Object.freeze([{ type: 'text', text: instruction }]),
            createdAt,
            provenance: Object.freeze({
                source: 'system_instruction',
                trust: 'trusted',
                sensitivity: 'sensitive',
                sourceId: id,
                createdAt
            })
        })
    });
}
function protocolMessageItem(span, modelMessage, index) {
    const id = `protocol:${span.id}:${index}`;
    return Object.freeze({
        id,
        source: 'session_history',
        protocolSpanId: span.id,
        modelMessage,
        message: Object.freeze({
            id,
            role: modelMessage.role === 'tool'
                ? 'tool'
                : modelMessage.role === 'assistant'
                    ? 'assistant'
                    : modelMessage.role === 'system'
                        ? 'system'
                        : 'user',
            parts: Object.freeze([{ type: 'text', text: '[provider protocol]' }]),
            createdAt: span.createdAt,
            provenance: Object.freeze({
                source: 'provider_protocol',
                trust: 'trusted',
                sensitivity: 'sensitive',
                sourceId: span.id,
                createdAt: span.createdAt
            })
        })
    });
}
function sessionItems(items) {
    return Object.freeze(items.flatMap(item => {
        if (item.kind === 'message') {
            return [Object.freeze({
                    id: `session:${item.message.id}`,
                    source: 'session_history',
                    message: item.message
                })];
        }
        return item.messages.map((message, index) => protocolMessageItem(item, message, index));
    }));
}
function atomicGroups(items) {
    const groups = [];
    const positions = new Map();
    for (const item of items) {
        const key = item.protocolSpanId ?? item.atomicGroupId ?? `item:${item.id}`;
        const position = positions.get(key);
        if (position === undefined) {
            positions.set(key, groups.length);
            groups.push([item]);
        }
        else {
            groups[position] = Object.freeze([...(groups[position] ?? []), item]);
        }
    }
    return Object.freeze(groups);
}
function encodedContextBytes(items) {
    return Buffer.byteLength(JSON.stringify(items.map(item => ({
        id: item.id,
        source: item.source,
        atomicGroupId: item.atomicGroupId,
        protocolSpanId: item.protocolSpanId,
        role: item.message.role,
        parts: item.message.parts,
        modelMessage: item.modelMessage
    }))), 'utf8');
}
function boundedOptionalContext(mandatory, runtimeFacts, history, groupContext, budget) {
    const historyGroups = [...atomicGroups(history)];
    const groupGroups = [...atomicGroups(groupContext)];
    const current = () => Object.freeze([
        ...mandatory,
        ...runtimeFacts,
        ...historyGroups.flat(),
        ...groupGroups.flat()
    ]);
    while ((current().length > budget.maxItems || encodedContextBytes(current()) > budget.maxBytes) &&
        (groupGroups.length > 0 || historyGroups.length > 0)) {
        if (groupGroups.length > 0)
            groupGroups.shift();
        else
            historyGroups.shift();
    }
    return Object.freeze({
        runtimeFacts: Object.freeze([...runtimeFacts]),
        sessionHistory: Object.freeze(historyGroups.flat()),
        groupContext: Object.freeze(groupGroups.flat())
    });
}
function freshSession(request, sessionId, timestamp) {
    return Object.freeze({
        schemaVersion: 1,
        sessionId,
        botId: request.sessionAddress.botId,
        scope: Object.freeze({ ...request.sessionAddress.scope }),
        startedBy: Object.freeze({
            userId: request.actor.userId,
            ...(request.actor.displayName === undefined
                ? {}
                : { displayName: request.actor.displayName })
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
        turnCount: 0,
        state: Object.freeze({ schemaVersion: 1, messages: Object.freeze([]) })
    });
}
function finalEnvelope(result, requestObservationDraft, sessionPersistence) {
    if (result.kind !== 'completed') {
        return Object.freeze({
            ...result,
            requestObservationDraft,
            sessionPersistence
        });
    }
    const text = result.completion.kind === 'reply_text'
        ? result.completion.text
        : null;
    return Object.freeze({
        ...result,
        visibleOutput: result.completion.kind === 'already_visible',
        text,
        requestObservationDraft,
        sessionPersistence
    });
}
function preCreateEnvelope(result, context, outcome, admissionRejectionReason, queueDurationMs, sessionLoadDurationMs) {
    const normalized = result.kind === 'failed'
        ? Object.freeze({ ...result, runRef: 'unavailable', terminal: null })
        : Object.freeze({ ...result, runRef: 'unavailable', terminal: null });
    return finalEnvelope(normalized, createRequestObservationDraft({
        context,
        runRef: 'unavailable',
        outcome,
        admissionRejectionReason,
        queueDurationMs,
        sessionLoadDurationMs,
        sessionSaveDurationMs: 'not_attempted',
        terminalObservationId: 'not_attempted'
    }), 'not_attempted');
}
function activeFinalEnvelope(result, context, sessionPersistence, sessionSaveDurationMs) {
    const terminalObservationId = result.terminal?.snapshot.observationId ?? 'unavailable';
    const failedSessionSave = sessionPersistence === 'failed';
    const requestObservationDraft = failedSessionSave
        ? createRequestObservationDraft({
            context,
            outcome: 'failed_session_save',
            admissionRejectionReason: 'not_applicable',
            sessionSaveDurationMs: sessionSaveDurationMs === 'not_attempted'
                ? 'unavailable'
                : sessionSaveDurationMs,
            terminalObservationId: terminalObservationId === 'unavailable'
                ? (() => { throw new TypeError('failed session save terminal fact is unavailable'); })()
                : terminalObservationId
        })
        : createRequestObservationDraft({
            context,
            outcome: 'completed',
            admissionRejectionReason: 'not_applicable',
            sessionSaveDurationMs,
            terminalObservationId
        });
    return finalEnvelope(result, requestObservationDraft, sessionPersistence);
}
function appendTerminalTurn(record, request, result, updatedAt) {
    const existing = [...record.state.messages];
    const appended = [];
    const ids = new Set(existing.map(item => (item.kind === 'message' ? item.message.id : item.id)));
    if (!ids.has(request.message.id)) {
        appended.push(Object.freeze({ kind: 'message', message: request.message }));
        ids.add(request.message.id);
    }
    if (result.output !== null && !ids.has(result.output.id)) {
        appended.push(Object.freeze({ kind: 'message', message: result.output }));
    }
    const messages = [...existing, ...appended].slice(-128);
    let state;
    while (state === undefined) {
        try {
            state = parseAgentSessionState({
                schemaVersion: 1,
                messages,
                ...(record.state.migratedFrom === undefined
                    ? {}
                    : { migratedFrom: record.state.migratedFrom })
            });
        }
        catch (error) {
            if (messages.length <= appended.length)
                throw error;
            messages.shift();
        }
    }
    return Object.freeze({
        ...record,
        updatedAt,
        turnCount: record.turnCount + 1,
        state
    });
}
export class AgentService {
    conversations;
    #sessions;
    #admission;
    #contextEngine;
    #progressPresenter;
    #createRuntime;
    #recoverRuntime;
    #now;
    #generateId;
    #createRunRef;
    #observationLevel;
    #monotonicNow;
    #onTerminalSnapshot;
    #onTerminalCommitReceipt;
    #onObserverFailure;
    #engine;
    #pending = new Map();
    #lifecycleController = new AbortController();
    #shutdownReason = 'process_shutdown';
    #shutdownPromise;
    #observerFailureReported = false;
    constructor(options) {
        this.#sessions = options.sessions;
        this.#admission = options.admission;
        this.#contextEngine = options.contextEngine;
        this.#progressPresenter = options.progressPresenter;
        this.#createRuntime = options.createRuntime;
        this.#recoverRuntime = options.recoverRuntime;
        this.#now = options.now ?? (() => new Date());
        this.#generateId = options.generateId ?? randomUUID;
        this.#createRunRef = options.createRunRef ?? createRunRef;
        this.#observationLevel = options.observationLevel;
        this.#monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()));
        this.#onTerminalSnapshot = options.onTerminalSnapshot;
        this.#onTerminalCommitReceipt = options.onTerminalCommitReceipt;
        this.#onObserverFailure = options.onObserverFailure;
        this.#engine = options.createEngine(event => {
            try {
                this.#progressPresenter.handle(event);
            }
            catch {
                this.#reportObserverFailure();
            }
        });
        this.conversations = Object.freeze({
            get: (address, storageOptions) => (this.#sessions.get(address, storageOptions)),
            list: (query, storageOptions) => (this.#sessions.list(query, storageOptions)),
            delete: (address, storageOptions) => (this.#sessions.delete(address, storageOptions)),
            deleteAll: (query, storageOptions) => (this.#sessions.deleteAll(query, storageOptions)),
            fork: (source, target, startedBy, storageOptions) => this.#sessions.fork(source, target, startedBy, storageOptions)
        });
    }
    async handle(request, options = {}) {
        return await this.#start(request, false, options);
    }
    async handleEphemeral(request, options = {}) {
        return await this.#start(request, true, options);
    }
    async resume(runId, options = {}) {
        const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal);
        let pending = this.#pending.get(runId);
        try {
            if (pending === undefined) {
                pending = await this.#recoverPending(runId, linked.signal);
            }
            if (pending === null || isApprovalRecoveryDeferred(pending))
                return pending;
            if (linked.signal.aborted) {
                return await this.cancel(runId, linked.signal.reason);
            }
            const result = await this.#engine.resume(runId, pending.binding, {
                ...options,
                signal: linked.signal
            });
            return await this.#finish(pending, result);
        }
        catch (error) {
            if (linked.signal.aborted) {
                return await this.cancel(runId, linked.signal.reason);
            }
            if (pending === undefined)
                throw error;
            if (pending === null || isApprovalRecoveryDeferred(pending))
                return pending;
            return await this.#abortPending(pending, error);
        }
        finally {
            linked.dispose();
        }
    }
    async cancel(runId, reason = 'user_cancelled') {
        const pending = this.#pending.get(runId);
        if (pending === undefined)
            return null;
        try {
            const result = await this.#engine.cancel(runId, reason);
            return await this.#finish(pending, result);
        }
        catch (error) {
            this.#pending.delete(runId);
            await this.#progressPresenter.drain(runId).catch(() => undefined);
            this.#progressPresenter.detach(runId);
            await pending.lease.release().catch(() => undefined);
            return activeFinalEnvelope(failedRunResult(runId, error, pending.request?.runRef ?? pending.requestObservationContext.runRef), pending.requestObservationContext, 'not_attempted', 'not_attempted');
        }
    }
    shutdown(reason = 'process_shutdown') {
        if (this.#shutdownPromise !== undefined)
            return this.#shutdownPromise;
        this.#shutdownReason = cancellationReason(reason, 'process_shutdown');
        this.#lifecycleController.abort(this.#shutdownReason);
        const runIds = Object.freeze([...this.#pending.keys()]);
        this.#shutdownPromise = Promise.all(runIds.map(async (runId) => await this.cancel(runId, this.#shutdownReason))).then(() => runIds.length);
        return this.#shutdownPromise;
    }
    async pendingApproval(runId, approvalId) {
        return await this.#engine.pendingApproval(runId, approvalId);
    }
    async displayApproval(input) {
        return await this.#engine.displayApproval(input);
    }
    async decideApproval(input, options = {}) {
        const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal);
        let pending = this.#pending.get(input.runId);
        try {
            if (pending === undefined) {
                pending = await this.#recoverPending(input.runId, linked.signal);
            }
            if (pending === null || isApprovalRecoveryDeferred(pending))
                return pending;
            if (linked.signal.aborted) {
                return await this.cancel(input.runId, linked.signal.reason);
            }
            const result = await this.#engine.decideApproval(input, pending.binding, { ...options, signal: linked.signal });
            if (result === null)
                return null;
            return await this.#finish(pending, result);
        }
        finally {
            linked.dispose();
        }
    }
    async #start(draft, ephemeral, options) {
        const runId = this.#generateId();
        const startedAtMonotonicMs = options.requestObservationContext?.startedAtMonotonicMs ??
            readMonotonic(this.#monotonicNow);
        const requestObservationContext = beginRequestObservation({
            requestRef: draft.requestRef,
            requestKind: draft.requestKind,
            startedAtMonotonicMs
        });
        if (draft.requestKind !== (ephemeral ? 'proactive_chat' : 'ordinary_chat') ||
            (options.requestObservationContext !== undefined &&
                (options.requestObservationContext.requestRef !== draft.requestRef ||
                    options.requestObservationContext.requestKind !== draft.requestKind))) {
            return preCreateEnvelope(failedRunResult(runId, new AgentError({
                code: 'invalid_request',
                stage: 'agent.service.observation',
                retryable: false,
                userMessage: '请求格式不正确，请联系机器人主人。'
            })), requestObservationContext, 'failed_request_validation', 'not_applicable', 'not_attempted', 'not_attempted');
        }
        const levelAtStart = safeObservationLevel(this.#observationLevel);
        let runRef = this.#createRunRef();
        let request = freezeRequest(draft, runRef);
        const linked = linkedAbortSignal(options.signal, this.#lifecycleController.signal);
        let lease;
        const queueStarted = readMonotonic(this.#monotonicNow);
        let queueDurationMs = 'unavailable';
        let sessionLoadDurationMs = 'not_attempted';
        try {
            try {
                lease = await this.#admission.acquire(request.sessionAddress, linked.signal);
                queueDurationMs = elapsed(queueStarted, readMonotonic(this.#monotonicNow));
            }
            catch (error) {
                queueDurationMs = elapsed(queueStarted, readMonotonic(this.#monotonicNow));
                const reason = error instanceof RunAdmissionRejectionError
                    ? error.rejectionReason
                    : 'unavailable';
                const result = error instanceof RunAdmissionRejectionError &&
                    error.rejectionReason === 'queue_aborted'
                    ? cancelledRunResult(runId, linked.signal.reason ?? this.#shutdownReason, 'unavailable')
                    : failedRunResult(runId, error);
                return preCreateEnvelope(result, requestObservationContext, 'rejected_admission', reason, queueDurationMs, 'not_attempted');
            }
            const timestamp = this.#now().toISOString();
            let session;
            if (ephemeral) {
                session = null;
            }
            else {
                const sessionLoadStarted = readMonotonic(this.#monotonicNow);
                try {
                    session = await this.#sessions.get(request.sessionAddress, { signal: linked.signal }) ?? freshSession(request, this.#generateId(), timestamp);
                    sessionLoadDurationMs = elapsed(sessionLoadStarted, readMonotonic(this.#monotonicNow));
                }
                catch (error) {
                    sessionLoadDurationMs = elapsed(sessionLoadStarted, readMonotonic(this.#monotonicNow));
                    await lease.release().catch(() => undefined);
                    lease = undefined;
                    const result = linked.signal.aborted
                        ? cancelledRunResult(runId, linked.signal.reason ?? this.#shutdownReason)
                        : failedRunResult(runId, error);
                    return preCreateEnvelope(result, requestObservationContext, 'failed_session_load', 'not_applicable', queueDurationMs, sessionLoadDurationMs);
                }
            }
            if (linked.signal.aborted)
                throw new Error('run start was cancelled');
            const runtime = await this.#createRuntime(request);
            if (linked.signal.aborted)
                throw new Error('run start was cancelled');
            const sessionId = session?.sessionId ?? this.#generateId();
            let binding = this.#bindingFor(runId, request, session, runtime);
            this.#progressPresenter.attach(runId, runtime.progress ?? (async () => undefined));
            let result;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const observationPolicy = createFrozenObservationPolicy({
                    levelAtStart,
                    runRef
                });
                try {
                    result = await this.#engine.start({
                        runId,
                        runRef,
                        requestRef: request.requestRef,
                        requestKind: request.requestKind,
                        presentationRoute: request.presentationRoute,
                        observationPolicy,
                        sessionId,
                        sessionAddress: request.sessionAddress,
                        deadlineAt: request.deadlineAt,
                        model: request.model,
                        runtime: binding
                    }, { signal: linked.signal });
                    break;
                }
                catch (error) {
                    if (!(error instanceof RunReferenceConflictError) || attempt !== 0)
                        throw error;
                    runRef = this.#createRunRef();
                    request = freezeRequest(draft, runRef);
                    binding = this.#bindingFor(runId, request, session, runtime);
                }
            }
            if (result === undefined)
                throw new RunReferenceConflictError();
            if (result.runRef === 'unavailable') {
                await lease.release().catch(() => undefined);
                lease = undefined;
                this.#progressPresenter.detach(runId);
                if (result.kind === 'paused' || result.kind === 'completed') {
                    throw new TypeError('run result lacks a claimed reference');
                }
                return preCreateEnvelope(result, requestObservationContext, 'failed_run_create', 'not_applicable', queueDurationMs, sessionLoadDurationMs);
            }
            const activeContext = activateRequestObservation({
                context: requestObservationContext,
                runRef: result.runRef,
                queueDurationMs,
                sessionLoadDurationMs
            });
            const pending = Object.freeze({
                runId,
                request,
                session,
                binding,
                lease,
                ephemeral,
                requestObservationContext: activeContext
            });
            this.#pending.set(runId, pending);
            return await this.#finish(pending, result);
        }
        catch (error) {
            if (this.#pending.has(runId)) {
                await this.#engine.cancel(runId, 'service_failure').catch(() => undefined);
            }
            if (lease !== undefined) {
                await lease.release().catch(() => undefined);
            }
            this.#pending.delete(runId);
            this.#progressPresenter.detach(runId);
            const result = linked.signal.aborted
                ? cancelledRunResult(runId, linked.signal.reason ?? this.#shutdownReason)
                : failedRunResult(runId, error);
            return preCreateEnvelope(result, requestObservationContext, 'failed_run_create', 'not_applicable', queueDurationMs, sessionLoadDurationMs);
        }
        finally {
            linked.dispose();
        }
    }
    #bindingFor(runId, request, session, runtime) {
        const prepare = async (dropOptional, signal) => {
            const systemInstructions = Object.freeze(request.systemInstructions.map((value, index) => (systemItem(runId, value, index, request.createdAt))));
            const currentRequest = Object.freeze({
                id: `current:${request.message.id}`,
                source: 'current_request',
                message: request.message
            });
            const runtimeFacts = Object.freeze([...(runtime.runtimeFacts ?? EMPTY_ITEMS)]);
            const history = dropOptional || session === null
                ? EMPTY_ITEMS
                : sessionItems(session.state.messages);
            const groupContext = dropOptional
                ? EMPTY_ITEMS
                : Object.freeze([...(runtime.groupContext ?? EMPTY_ITEMS)]);
            const bounded = boundedOptionalContext(Object.freeze([...systemInstructions, currentRequest]), runtimeFacts, history, groupContext, request.contextBudget);
            const snapshot = await this.#contextEngine.prepare({
                systemInstructions,
                runtimeFacts: bounded.runtimeFacts,
                sessionHistory: bounded.sessionHistory,
                groupContext: bounded.groupContext,
                currentRequest,
                toolMessages: EMPTY_ITEMS
            }, request.contextBudget, signal);
            return Object.freeze({
                messages: coalesceModelMessages(currentRunItemOrder(snapshot.items).map(modelMessageFor)),
                estimatedInputTokens: snapshot.estimatedInputTokens
            });
        };
        return Object.freeze({
            snapshot: runtime.binding.snapshot,
            prepareContext: async (signal) => await prepare(false, signal),
            recoverContext: async (_checkpoint, _error, signal) => await prepare(true, signal),
            prepareToolContext: runtime.binding.prepareToolContext,
            contextFor: runtime.binding.contextFor,
            ...(runtime.binding.approvalControlContext === undefined
                ? {}
                : { approvalControlContext: runtime.binding.approvalControlContext })
        });
    }
    async #recoverPending(runId, signal) {
        const checkpoint = await this.#engine.loadCheckpoint(runId);
        if (checkpoint === null)
            return null;
        if (isTerminalRunStatus(checkpoint.status))
            return null;
        if (this.#recoverRuntime === undefined) {
            throw new AgentError({
                code: 'checkpoint_invalid',
                stage: 'agent.service.recovery',
                retryable: false,
                userMessage: '任务运行环境已失效，请重新发起。'
            });
        }
        let lease;
        try {
            lease = await this.#admission.recover(checkpoint, signal);
        }
        catch (error) {
            const reason = error instanceof RunAdmissionRejectionError
                ? error.rejectionReason
                : 'unavailable';
            return Object.freeze({
                kind: 'approval_deferred',
                reason,
                retryable: true,
                runRef: checkpoint.runRef,
                requestRef: checkpoint.requestRef
            });
        }
        try {
            const runtime = await this.#recoverRuntime(checkpoint);
            const binding = Object.freeze({
                snapshot: runtime.binding.snapshot,
                prepareContext: async () => Object.freeze({
                    messages: checkpoint.messages,
                    estimatedInputTokens: checkpoint.estimatedInputTokens
                }),
                recoverContext: async () => undefined,
                prepareToolContext: runtime.binding.prepareToolContext,
                contextFor: runtime.binding.contextFor,
                ...(runtime.binding.approvalControlContext === undefined
                    ? {}
                    : { approvalControlContext: runtime.binding.approvalControlContext })
            });
            const pending = Object.freeze({
                runId,
                request: null,
                session: null,
                binding,
                lease,
                // A restarted process cannot recreate the canonical QQ message without
                // inventing provenance, so recovery must not mutate chat history.
                ephemeral: true,
                requestObservationContext: activateRequestObservation({
                    context: beginRequestObservation({
                        requestRef: checkpoint.requestRef,
                        requestKind: checkpoint.requestKind,
                        startedAtMonotonicMs: 'unavailable'
                    }),
                    runRef: checkpoint.runRef,
                    queueDurationMs: 'unavailable',
                    sessionLoadDurationMs: checkpoint.requestKind === 'proactive_chat'
                        ? 'not_attempted'
                        : 'unavailable'
                })
            });
            this.#pending.set(runId, pending);
            this.#progressPresenter.attach(runId, runtime.progress ?? (async () => undefined), checkpoint.events);
            return pending;
        }
        catch (error) {
            await lease.release().catch(() => undefined);
            throw error;
        }
    }
    async #finish(pending, result) {
        if (result.kind === 'paused') {
            await this.#progressPresenter.drain(pending.runId);
            return Object.freeze({
                ...result,
                requestObservationContext: pending.requestObservationContext
            });
        }
        if (result.terminal !== null) {
            try {
                this.#onTerminalSnapshot?.(result.terminal.snapshot);
            }
            catch {
                this.#reportObserverFailure();
            }
            try {
                this.#onTerminalCommitReceipt?.(result.terminal.receipt);
            }
            catch {
                this.#reportObserverFailure();
            }
        }
        await this.#progressPresenter.drain(pending.runId);
        let sessionPersistence = 'not_attempted';
        let sessionSaveDurationMs = 'not_attempted';
        try {
            if (!pending.ephemeral && pending.session !== null && pending.request !== null &&
                result.kind === 'completed') {
                const sessionSaveStarted = readMonotonic(this.#monotonicNow);
                try {
                    const next = appendTerminalTurn(pending.session, pending.request, result, this.#now().toISOString());
                    await this.#sessions.save(next, {
                        signal: undefined,
                        ...(pending.request.sessionTtlSeconds === undefined
                            ? {}
                            : { ttlSeconds: pending.request.sessionTtlSeconds })
                    });
                    sessionPersistence = 'saved';
                }
                catch {
                    sessionPersistence = 'failed';
                    this.#reportObserverFailure();
                }
                finally {
                    sessionSaveDurationMs = elapsed(sessionSaveStarted, readMonotonic(this.#monotonicNow));
                }
            }
        }
        finally {
            this.#pending.delete(pending.runId);
            this.#progressPresenter.detach(pending.runId);
            await pending.lease.release().catch(() => undefined);
        }
        return activeFinalEnvelope(result, pending.requestObservationContext, sessionPersistence, sessionSaveDurationMs);
    }
    async #abortPending(pending, error) {
        let cancelled = null;
        try {
            cancelled = await this.#engine.cancel(pending.runId, 'service_failure');
        }
        catch {
            // A terminal-null safe failure below is the only valid fallback.
        }
        if (cancelled !== null && cancelled.kind !== 'paused' && cancelled.terminal !== null) {
            return await this.#finish(pending, cancelled);
        }
        this.#pending.delete(pending.runId);
        await this.#progressPresenter.drain(pending.runId);
        this.#progressPresenter.detach(pending.runId);
        await pending.lease.release().catch(() => undefined);
        return activeFinalEnvelope(failedRunResult(pending.runId, error, pending.request?.runRef ?? pending.requestObservationContext.runRef), pending.requestObservationContext, 'not_attempted', 'not_attempted');
    }
    #reportObserverFailure() {
        if (this.#observerFailureReported)
            return;
        this.#observerFailureReported = true;
        try {
            this.#onObserverFailure?.(Object.freeze({ event: 'agent.observer_failed' }));
        }
        catch {
            // Observability remains outside the run control plane.
        }
    }
}
