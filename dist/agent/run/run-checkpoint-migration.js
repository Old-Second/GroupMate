import { completionFromTerminalOutput } from '../contracts/completion.js';
import { parseRunCheckpoint } from './run-checkpoint.js';
import { parseModelCapabilitySnapshot } from '../model/model-capability.js';
import { createUnavailableRunUsageSummary } from './run-usage.js';
import { isDeepStrictEqual } from 'node:util';
import { legacyFixedLoopPolicy } from './run-loop-policy.js';
import { isTerminalRunStatus } from './run-state.js';
function migratedBudget(checkpoint) {
    const limits = checkpoint.budgetLimits;
    return Object.freeze({
        budgetLimits: Object.freeze({
            schemaVersion: 2,
            activeRuntimeMs: limits.activeRuntimeMs,
            providerTimeoutMs: limits.providerTimeoutMs,
            maxToolCalls: limits.maxToolCalls,
            maxProgressEvents: limits.maxProgressEvents,
            maxProviderRetries: limits.maxProviderRetries,
            maxRecoveryAttempts: limits.maxRecoveryAttempts,
            maxCorrectionTurns: limits.maxCorrectionTurns
        }),
        modelLoopPolicy: legacyFixedLoopPolicy(limits.maxEstimatedTokens),
        contextPlan: null,
        contextArtifactRefs: Object.freeze([]),
        toolWireSnapshot: null
    });
}
function assertMigratable(checkpoint) {
    if (isTerminalRunStatus(checkpoint.status)) {
        throw new TypeError('terminal active checkpoint cannot be migrated');
    }
}
export function upgradeCompletionFromRunCheckpointV1(checkpoint) {
    if (checkpoint.status !== 'completed')
        return null;
    return completionFromTerminalOutput({
        requestKind: 'legacy_unknown',
        output: checkpoint.output,
        visibleToolOutput: checkpoint.visibleOutput ? 'confirmed' : 'none'
    });
}
function legacyApprovalCounters(checkpoint) {
    const approvals = new Map();
    for (const interruption of checkpoint.approvalHistory) {
        approvals.set(interruption.approvalId, interruption);
    }
    if (checkpoint.interruption !== null) {
        approvals.set(checkpoint.interruption.approvalId, checkpoint.interruption);
    }
    let denied = 0;
    let expired = 0;
    for (const interruption of approvals.values()) {
        if (interruption?.decision?.kind === 'rejected')
            denied += 1;
        if (interruption?.decision?.kind === 'expired')
            expired += 1;
    }
    const indeterminate = checkpoint.toolLedgers.reduce((total, ledger) => (total + ledger.calls.filter(call => call.status === 'indeterminate').length), 0);
    return Object.freeze({
        approvalRequests: approvals.size,
        toolDenied: denied,
        toolExpired: expired,
        toolIndeterminate: indeterminate
    });
}
function legacyObservationCounters(checkpoint) {
    return Object.freeze({
        schemaVersion: 1,
        providerAttempts: 'unavailable',
        modelTurns: checkpoint.budgetCounters.modelTurns,
        toolAttempts: 'unavailable',
        providerRetries: checkpoint.budgetCounters.providerRetries,
        recoveryAttempts: checkpoint.budgetCounters.recoveryAttempts,
        correctionTurns: checkpoint.budgetCounters.correctionTurns,
        toolCalls: checkpoint.budgetCounters.toolCalls,
        ...legacyApprovalCounters(checkpoint),
        estimatedTokens: checkpoint.budgetCounters.estimatedTokens,
        providerInputTokens: 'unavailable',
        providerOutputTokens: 'unavailable',
        providerTotalTokens: 'unavailable',
        providerActiveDurationMs: checkpoint.budgetCounters.usedActiveRuntimeMs,
        engineActiveDurationMs: 'unavailable'
    });
}
export function upgradeRunCheckpointV1(checkpoint, input) {
    assertMigratable(checkpoint);
    const { schemaVersion: _schemaVersion, visibleOutput: _visibleOutput, budgetLimits: _budgetLimits, ...state } = checkpoint;
    return parseRunCheckpoint({
        ...state,
        ...migratedBudget(checkpoint),
        schemaVersion: 5,
        revision: checkpoint.revision + 1,
        runRef: input.runRef,
        requestRef: input.requestRef,
        requestKind: 'legacy_unknown',
        presentationRoute: null,
        completion: upgradeCompletionFromRunCheckpointV1(checkpoint),
        observationCounters: legacyObservationCounters(checkpoint),
        providerDispatch: Object.freeze({ state: 'idle' }),
        engineActivity: Object.freeze({ state: 'idle' }),
        observationPolicy: Object.freeze({
            schemaVersion: 1,
            levelAtStart: 'off',
            sampledSuccess: false
        }),
        reasoningSegments: Object.freeze([]),
        modelCapability: legacyModelCapability(),
        modelPrice: null,
        usage: createUnavailableRunUsageSummary()
    });
}
export function upgradeRunCheckpointV2(checkpoint) {
    assertMigratable(checkpoint);
    const { schemaVersion: _schemaVersion, budgetLimits: _budgetLimits, ...state } = checkpoint;
    return parseRunCheckpoint({
        ...state,
        ...migratedBudget(checkpoint),
        schemaVersion: 5,
        revision: checkpoint.revision + 1,
        reasoningSegments: Object.freeze([]),
        modelCapability: legacyModelCapability(),
        modelPrice: null,
        usage: createUnavailableRunUsageSummary()
    });
}
function legacyModelCapability() {
    return parseModelCapabilitySnapshot({
        schemaVersion: 1,
        source: 'safe_default',
        contextWindowTokens: 32_768,
        maxOutputTokens: 8_192,
        promptCaching: 'unknown',
        usageExtensions: [],
        priceCatalogVersion: null
    });
}
export function upgradeRunCheckpointV3(checkpoint) {
    assertMigratable(checkpoint);
    const { schemaVersion: _schemaVersion, budgetLimits: _budgetLimits, ...state } = checkpoint;
    return parseRunCheckpoint({
        ...state,
        ...migratedBudget(checkpoint),
        schemaVersion: 5,
        revision: checkpoint.revision + 1,
        modelCapability: legacyModelCapability(),
        modelPrice: null,
        usage: createUnavailableRunUsageSummary()
    });
}
export function upgradeRunCheckpointV4(checkpoint) {
    assertMigratable(checkpoint);
    const { schemaVersion: _schemaVersion, budgetLimits: _budgetLimits, ...state } = checkpoint;
    return parseRunCheckpoint({
        ...state,
        ...migratedBudget(checkpoint),
        schemaVersion: 5,
        revision: checkpoint.revision + 1
    });
}
export function validateExactRunCheckpointMigration(expected, next) {
    const canonical = expected.schemaVersion === 1
        ? upgradeRunCheckpointV1(expected, {
            runRef: next.runRef,
            requestRef: next.requestRef
        })
        : expected.schemaVersion === 2
            ? upgradeRunCheckpointV2(expected)
            : expected.schemaVersion === 3
                ? upgradeRunCheckpointV3(expected)
                : upgradeRunCheckpointV4(expected);
    const parsedNext = parseRunCheckpoint(next);
    if (!isDeepStrictEqual(canonical, parsedNext)) {
        throw new TypeError('run checkpoint migration is not canonical');
    }
    return canonical;
}
