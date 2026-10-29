import { performance } from 'node:perf_hooks';
import { completedPreparedCall } from '../tools/prepared-capability.js';
import { parseToolResult } from '../tools/tool-result.js';
import { boundedMonotonicDurationMs } from './run-budget.js';
const MAX_TOOL_TIMEOUT_MS = 30_000;
class Semaphore {
    #limit;
    #active = 0;
    #waiters = [];
    constructor(limit) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) {
            throw new TypeError('tool concurrency limit is invalid');
        }
        this.#limit = limit;
    }
    async acquire(signal) {
        if (signal.aborted)
            throw new DOMException('operation was aborted', 'AbortError');
        if (this.#active < this.#limit) {
            this.#active += 1;
            return this.#release();
        }
        return await new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                signal,
                onAbort: () => {
                    const index = this.#waiters.indexOf(waiter);
                    if (index >= 0)
                        this.#waiters.splice(index, 1);
                    reject(new DOMException('operation was aborted', 'AbortError'));
                }
            };
            signal.addEventListener('abort', waiter.onAbort, { once: true });
            this.#waiters.push(waiter);
        });
    }
    #release() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            while (this.#waiters.length > 0) {
                const waiter = this.#waiters.shift();
                waiter.signal.removeEventListener('abort', waiter.onAbort);
                if (waiter.signal.aborted)
                    continue;
                waiter.resolve(this.#release());
                return;
            }
            this.#active -= 1;
        };
    }
}
function failedResult(code) {
    return parseToolResult({
        status: 'failed', effect: 'none', errorCode: code,
        userMessage: code === 'tool_cancelled' ? '工具执行已取消。' : '工具执行失败。',
        retryable: false
    });
}
function indeterminateResult() {
    return parseToolResult({
        status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
        userMessage: '操作结果暂时无法确认。', retryable: false
    });
}
function parallelEligible(capability) {
    return capability.executionClass === 'read_only' && capability.retrySafe &&
        capability.resourceKeys.length > 0;
}
function canonicalName(snapshot, call) {
    try {
        return snapshot.resolveCall(call).canonicalName;
    }
    catch {
        return null;
    }
}
function batchToolNames(snapshot, calls) {
    const names = new Set();
    for (const call of calls) {
        const name = canonicalName(snapshot, call);
        if (name !== null)
            names.add(name);
    }
    return names;
}
// 同一批里既有依赖工具又有消费它结果的工具时，消费方的参数必然是在看到结果之前猜的。
function pendingDependencies(snapshot, call, batchNames) {
    const name = canonicalName(snapshot, call);
    if (name === null)
        return [];
    let declared;
    try {
        declared = snapshot.resolve(name).definition.batchDependencies;
    }
    catch {
        return [];
    }
    if (declared === undefined)
        return [];
    return declared.filter(dependency => dependency !== name && batchNames.has(dependency));
}
function dependencyPendingResult(dependencies) {
    return parseToolResult({
        status: 'denied',
        effect: 'none',
        reasonCode: 'batch_dependency_pending',
        userMessage: '需要先单独调用' + dependencies.join('、') +
            '并拿到成功结果，下一轮再用结果里的参数调用本工具。',
        retryable: false
    });
}
function conflicts(keys, capability) {
    return capability.resourceKeys.some(key => keys.has(key));
}
function frozenBatch(calls) {
    return Object.freeze({ schemaVersion: 1, calls: Object.freeze([...calls]) });
}
function scheduled(capability, result, attemptObservations) {
    return Object.freeze({
        callId: capability.callId,
        toolName: capability.toolName,
        result: parseToolResult(result),
        attemptObservations
    });
}
function attemptObservation(result, ordinal, durationMs) {
    const projected = result.status === 'success'
        ? { outcome: 'succeeded', resultCode: null }
        : result.status === 'denied'
            ? { outcome: 'denied', resultCode: result.reasonCode }
            : result.status === 'failed'
                ? { outcome: 'failed', resultCode: result.errorCode }
                : {
                    outcome: 'indeterminate',
                    resultCode: 'tool_outcome_unknown'
                };
    return Object.freeze({
        schemaVersion: 1,
        ordinal,
        outcome: projected.outcome,
        durationMs,
        resultCode: projected.resultCode
    });
}
function frozenAttemptObservations(observations) {
    if (observations.length > 2)
        throw new TypeError('tool attempt observations are invalid');
    return Object.freeze([...observations]);
}
export class ToolScheduler {
    #runtime;
    #maxPerRunConcurrency;
    #global;
    #monotonicNow;
    constructor(options) {
        this.#runtime = options.runtime;
        this.#maxPerRunConcurrency = options.maxPerRunConcurrency ?? 2;
        this.#global = new Semaphore(options.maxGlobalConcurrency ?? 2);
        this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
        if (!Number.isSafeInteger(this.#maxPerRunConcurrency) ||
            this.#maxPerRunConcurrency < 1 || this.#maxPerRunConcurrency > 2) {
            throw new TypeError('tool concurrency limit is invalid');
        }
    }
    async preflight(calls, context) {
        if (!Array.isArray(calls) || calls.length === 0 || calls.length > context.remainingToolCalls) {
            return Object.freeze({ kind: 'failed', code: 'tool_budget_exceeded' });
        }
        const callIds = calls.map(call => call.callId);
        if (new Set(callIds).size !== callIds.length) {
            return Object.freeze({ kind: 'failed', code: 'duplicate_call_id' });
        }
        const batchNames = batchToolNames(context.snapshot, calls);
        const prepared = [];
        for (const call of calls) {
            const pending = pendingDependencies(context.snapshot, call, batchNames);
            if (pending.length > 0) {
                prepared.push(completedPreparedCall(call.callId, canonicalName(context.snapshot, call) ?? call.toolName, dependencyPendingResult(pending)));
                continue;
            }
            prepared.push(await this.#runtime.prepare(call, context.context, context.snapshot));
        }
        const batch = frozenBatch(prepared);
        return prepared.some(item => item.kind === 'approval_required')
            ? Object.freeze({ kind: 'approval_required', batch })
            : Object.freeze({ kind: 'ready', batch });
    }
    async execute(batch, context) {
        if (batch.schemaVersion !== 1 || !Array.isArray(batch.calls) ||
            batch.calls.some(call => call.kind === 'approval_required')) {
            throw new TypeError('prepared tool batch is not executable');
        }
        const results = new Array(batch.calls.length);
        const perRun = new Semaphore(this.#maxPerRunConcurrency);
        let group = [];
        let groupKeys = new Set();
        const run = async (capability) => {
            const observations = [];
            let releaseRun;
            let releaseGlobal;
            try {
                releaseRun = await perRun.acquire(context.signal);
                releaseGlobal = await this.#global.acquire(context.signal);
                let attempt = await this.#attempt(capability, context, 1);
                if (attempt.observation !== null)
                    observations.push(attempt.observation);
                if (parallelEligible(capability) && attempt.result.status === 'failed' &&
                    attempt.result.retryable &&
                    !context.signal.aborted) {
                    attempt = await this.#attempt(capability, context, 2);
                    if (attempt.observation !== null)
                        observations.push(attempt.observation);
                }
                return scheduled(capability, attempt.result, frozenAttemptObservations(observations));
            }
            catch {
                return scheduled(capability, capability.executionClass === 'read_only'
                    ? failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
                    : indeterminateResult(), frozenAttemptObservations(observations));
            }
            finally {
                releaseGlobal?.();
                releaseRun?.();
            }
        };
        const flush = async () => {
            const current = group;
            group = [];
            groupKeys = new Set();
            const completed = await Promise.all(current.map(async (item) => ({
                index: item.index,
                result: await run(item.capability)
            })));
            for (const item of completed)
                results[item.index] = item.result;
        };
        for (let index = 0; index < batch.calls.length; index += 1) {
            const item = batch.calls[index];
            if (item.kind === 'completed') {
                results[index] = Object.freeze({
                    callId: item.callId,
                    toolName: item.toolName,
                    result: parseToolResult(item.result),
                    attemptObservations: frozenAttemptObservations([])
                });
                continue;
            }
            const capability = item.capability;
            if (!parallelEligible(capability)) {
                await flush();
                results[index] = await run(capability);
                continue;
            }
            if (conflicts(groupKeys, capability))
                await flush();
            group.push({ index, capability });
            for (const key of capability.resourceKeys)
                groupKeys.add(key);
        }
        await flush();
        if (results.some(result => result === undefined)) {
            throw new TypeError('prepared tool batch is incomplete');
        }
        return Object.freeze({ results: Object.freeze(results) });
    }
    async #attempt(capability, context, ordinal) {
        if (context.signal.aborted) {
            return Object.freeze({ result: failedResult('tool_cancelled'), observation: null });
        }
        let fresh;
        try {
            fresh = await context.contextFor(capability);
        }
        catch {
            return Object.freeze({
                result: failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed'),
                observation: null
            });
        }
        if (context.signal.aborted) {
            return Object.freeze({ result: failedResult('tool_cancelled'), observation: null });
        }
        let timeoutMs;
        try {
            timeoutMs = context.snapshot.resolve(capability.toolName).definition.timeoutMs;
        }
        catch {
            timeoutMs = MAX_TOOL_TIMEOUT_MS;
        }
        const startedAt = this.#safeMonotonicNow();
        let result;
        try {
            result = parseToolResult(await this.#runtime.executePrepared(capability, fresh, context.snapshot, context.signal));
        }
        catch {
            result = capability.executionClass === 'read_only'
                ? failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
                : indeterminateResult();
        }
        const durationMs = boundedMonotonicDurationMs(startedAt, this.#safeMonotonicNow(), timeoutMs);
        return Object.freeze({
            result,
            observation: attemptObservation(result, ordinal, durationMs)
        });
    }
    #safeMonotonicNow() {
        try {
            return this.#monotonicNow();
        }
        catch {
            return Number.NaN;
        }
    }
}
