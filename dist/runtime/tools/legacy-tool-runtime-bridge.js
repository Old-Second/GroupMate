import { shouldFinalizeToolResult, toolResultForModel } from '../../agent/tools/tool-result.js';
export class ToolRuntimeConfigurationError extends Error {
    code;
    constructor(code) {
        const messages = {
            unknown_policy_profile: '工具权限策略配置无效。',
            runtime_not_found: '工具运行上下文已失效。',
            runtime_capacity_exceeded: '工具运行上下文容量已满。'
        };
        super(messages[code]);
        this.name = 'ToolRuntimeConfigurationError';
        this.code = code;
    }
}
function policyProfile(value) {
    if (value !== 'compatible' && value !== 'safe' && value !== 'strict') {
        throw new ToolRuntimeConfigurationError('unknown_policy_profile');
    }
    return value;
}
function stableFeedback(result) {
    const feedback = toolResultForModel(result).trim();
    return feedback === '' ? '工具执行完成。' : feedback;
}
function approvalFeedback(outcome) {
    return `操作需要确认。请在 ${outcome.expiresAt} 前发送“#确认 ${outcome.token}”，或发送“#拒绝 ${outcome.token}”。`;
}
export function createLegacyToolRuntimeBridge(options) {
    const maxActiveRuns = options.maxActiveRuns ?? 64;
    if (!Number.isSafeInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 256) {
        throw new TypeError('active tool run limit is invalid');
    }
    const runTtlMs = options.runTtlMs ?? 6 * 60 * 1_000;
    if (!Number.isSafeInteger(runTtlMs) || runTtlMs < 30_000 || runTtlMs > 15 * 60 * 1_000) {
        throw new TypeError('tool run TTL is invalid');
    }
    const runs = new Map();
    const expiryTimers = new Map();
    const removeRun = (snapshotId) => {
        const existed = runs.delete(snapshotId);
        const timer = expiryTimers.get(snapshotId);
        if (timer !== undefined)
            clearTimeout(timer);
        expiryTimers.delete(snapshotId);
        if (existed)
            options.onRunExpired?.(snapshotId);
    };
    return Object.freeze({
        async begin(input) {
            if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt, 'utf8') > 128 * 1024) {
                throw new TypeError('tool run input is invalid');
            }
            const captured = await options.capture(input);
            const profile = policyProfile(captured.profile);
            const runId = options.generateId();
            const snapshotId = options.generateId();
            const snapshot = captured.registry.createSnapshot({
                id: snapshotId,
                facts: captured.initialFacts,
                enabledTools: captured.enabledTools
            });
            if (runs.size >= maxActiveRuns) {
                const oldest = runs.keys().next().value;
                if (oldest === undefined)
                    throw new ToolRuntimeConfigurationError('runtime_capacity_exceeded');
                removeRun(oldest);
            }
            const run = Object.freeze({
                profile,
                approvalTtlSeconds: captured.approvalTtlSeconds,
                runId,
                snapshot,
                initialFacts: captured.initialFacts,
                intent: captured.intent,
                refreshFacts: captured.refreshFacts
            });
            runs.set(snapshotId, run);
            options.onRunCaptured?.(run);
            const timer = setTimeout(() => removeRun(snapshotId), runTtlMs);
            timer.unref?.();
            expiryTimers.set(snapshotId, timer);
            return Object.freeze({
                profile,
                runId,
                snapshotId,
                modelFunctions: Object.freeze(snapshot.modelTools.map(tool => tool.function)),
                promptAddition: captured.promptAddition ?? '',
                systemAddition: captured.systemAddition ?? ''
            });
        },
        async execute(input) {
            const run = runs.get(input.snapshotId);
            if (run === undefined)
                throw new ToolRuntimeConfigurationError('runtime_not_found');
            const outcome = await options.executor.execute({
                snapshot: run.snapshot,
                call: Object.freeze({
                    runId: run.runId,
                    callId: input.callId,
                    snapshotId: input.snapshotId,
                    requestedName: input.requestedName,
                    arguments: input.arguments
                }),
                profile: run.profile,
                initialFacts: run.initialFacts,
                intent: run.intent,
                refreshFacts: run.refreshFacts,
                ...(run.approvalTtlSeconds === undefined
                    ? {}
                    : { approvalTtlSeconds: run.approvalTtlSeconds }),
                ...(input.signal === undefined ? {} : { signal: input.signal })
            });
            if (outcome.kind === 'approval_required') {
                const feedback = approvalFeedback(outcome);
                return Object.freeze({
                    toolName: outcome.toolName,
                    modelFeedback: feedback,
                    result: null,
                    finalize: true,
                    approvalRequired: true,
                    presentation: Object.freeze({ kind: 'approval', text: feedback })
                });
            }
            return Object.freeze({
                toolName: outcome.toolName,
                modelFeedback: stableFeedback(outcome.result),
                result: outcome.result,
                finalize: outcome.finalize || shouldFinalizeToolResult(outcome.result),
                approvalRequired: false
            });
        },
        finish(snapshotId, finishOptions = {}) {
            if (finishOptions.retainForApproval !== true)
                removeRun(snapshotId);
        }
    });
}
