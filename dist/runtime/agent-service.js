import { randomUUID } from 'node:crypto';
import { AgentError, serializeAgentError } from '../agent/contracts/error.js';
import { isTerminalRunStatus } from '../agent/run/run-state.js';
import { parseAgentSessionState } from '../agent/session/agent-session-state.js';
import { createAgentRunLog } from './safe-chat-logging.js';
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
function failedEnvelope(runId, error) {
    return Object.freeze({
        kind: 'failed',
        runId,
        error: serializeAgentError(asAgentError(error))
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
function terminalEnvelope(result) {
    if (result.kind !== 'completed')
        return result;
    return Object.freeze({
        ...result,
        text: result.output === null ? null : messageText(result.output)
    });
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
    #runStore;
    #admission;
    #contextEngine;
    #progressPresenter;
    #createRuntime;
    #recoverRuntime;
    #now;
    #generateId;
    #onRunLog;
    #onObserverFailure;
    #engine;
    #pending = new Map();
    #observerFailureReported = false;
    constructor(options) {
        this.#sessions = options.sessions;
        this.#runStore = options.runStore;
        this.#admission = options.admission;
        this.#contextEngine = options.contextEngine;
        this.#progressPresenter = options.progressPresenter;
        this.#createRuntime = options.createRuntime;
        this.#recoverRuntime = options.recoverRuntime;
        this.#now = options.now ?? (() => new Date());
        this.#generateId = options.generateId ?? randomUUID;
        this.#onRunLog = options.onRunLog;
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
        let pending = this.#pending.get(runId);
        if (pending === undefined) {
            try {
                pending = await this.#recoverPending(runId, options.signal);
            }
            catch (error) {
                return failedEnvelope(runId, error);
            }
        }
        if (pending === null)
            return terminalEnvelope(await this.#engine.resume(runId, undefined, options));
        try {
            const result = await this.#engine.resume(runId, pending.binding, options);
            return await this.#finish(pending, result);
        }
        catch (error) {
            return await this.#abortPending(pending, failedEnvelope(runId, error));
        }
    }
    async pendingApproval(runId, approvalId) {
        return await this.#engine.pendingApproval(runId, approvalId);
    }
    async displayApproval(input) {
        return await this.#engine.displayApproval(input);
    }
    async decideApproval(input, options = {}) {
        let pending = this.#pending.get(input.runId);
        if (pending === undefined) {
            try {
                pending = await this.#recoverPending(input.runId, options.signal);
            }
            catch {
                return null;
            }
        }
        const result = await this.#engine.decideApproval(input, pending?.binding, options);
        if (result === null)
            return null;
        return pending === null ? terminalEnvelope(result) : await this.#finish(pending, result);
    }
    async #start(request, ephemeral, options) {
        const runId = this.#generateId();
        let lease;
        try {
            lease = await this.#admission.acquire(request.sessionAddress, options.signal);
            const timestamp = this.#now().toISOString();
            const session = ephemeral
                ? null
                : await this.#sessions.get(request.sessionAddress, { signal: options.signal }) ??
                    freshSession(request, this.#generateId(), timestamp);
            const runtime = await this.#createRuntime(request);
            const sessionId = session?.sessionId ?? this.#generateId();
            const binding = this.#bindingFor(runId, request, session, runtime);
            const pending = Object.freeze({
                runId,
                request,
                session,
                binding,
                lease,
                ephemeral
            });
            this.#pending.set(runId, pending);
            this.#progressPresenter.attach(runId, runtime.progress ?? (async () => undefined));
            const result = await this.#engine.start({
                runId,
                sessionId,
                sessionAddress: request.sessionAddress,
                deadlineAt: request.deadlineAt,
                model: request.model,
                runtime: binding
            }, options);
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
            return failedEnvelope(runId, error);
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
                messages: Object.freeze(snapshot.items.map(modelMessageFor)),
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
        const checkpoint = await this.#runStore.load(runId);
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
        const lease = await this.#admission.recover(checkpoint, signal);
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
                ephemeral: true
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
        await this.#progressPresenter.drain(pending.runId);
        if (result.kind === 'paused')
            return result;
        let envelope = terminalEnvelope(result);
        try {
            if (!pending.ephemeral && pending.session !== null && pending.request !== null &&
                result.kind === 'completed') {
                const next = appendTerminalTurn(pending.session, pending.request, result, this.#now().toISOString());
                await this.#sessions.save(next, {
                    signal: undefined,
                    ...(pending.request.sessionTtlSeconds === undefined
                        ? {}
                        : { ttlSeconds: pending.request.sessionTtlSeconds })
                });
            }
            this.#recordRun(result);
        }
        catch (error) {
            envelope = failedEnvelope(pending.runId, error);
        }
        finally {
            this.#pending.delete(pending.runId);
            this.#progressPresenter.detach(pending.runId);
            await pending.lease.release().catch(() => undefined);
        }
        return envelope;
    }
    async #abortPending(pending, envelope) {
        this.#pending.delete(pending.runId);
        await this.#engine.cancel(pending.runId, 'service_failure').catch(() => undefined);
        await this.#progressPresenter.drain(pending.runId);
        this.#progressPresenter.detach(pending.runId);
        await pending.lease.release().catch(() => undefined);
        return envelope;
    }
    #recordRun(result) {
        if (this.#onRunLog === undefined)
            return;
        void this.#runStore.load(result.runId).then(checkpoint => {
            const counters = checkpoint?.budgetCounters;
            try {
                this.#onRunLog?.(createAgentRunLog({
                    runId: result.runId,
                    fromStatus: 'active',
                    toStatus: result.kind,
                    modelTurns: counters?.modelTurns,
                    toolCalls: counters?.toolCalls,
                    usedActiveRuntimeMs: counters?.usedActiveRuntimeMs,
                    providerAttempts: counters === undefined
                        ? undefined
                        : counters.modelTurns + counters.providerRetries,
                    recoveryAttempts: counters?.recoveryAttempts,
                    correctionAttempts: counters?.correctionTurns,
                    errorCode: result.kind === 'failed' ? result.error.code : undefined
                }));
            }
            catch {
                this.#reportObserverFailure();
            }
        }).catch(() => this.#reportObserverFailure());
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
