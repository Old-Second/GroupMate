import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEXT_ARTIFACT_BYTES, MAX_CONTEXT_ARTIFACT_CONTENT_BYTES, MAX_CONTEXT_ARTIFACT_REFS } from '../agent/context/context-artifact.js';
import { MAX_CONTEXT_PLANNER_INPUT_BYTES } from '../agent/context/context-planner.js';
import { CONTEXT_ARTIFACT_RESOURCE_LIMITS } from '../agent/context/context-resource-limits.js';
import { RUN_ADMISSION_LIMITS } from '../agent/run/run-admission.js';
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js';
import { PHASE_7_RESOURCE_SCENARIOS, validatePhase7ResourceSample } from './phase-7-resource-scenario.js';
const MIB = 1_024 * 1_024;
export const PHASE_7_RESOURCE_SAMPLES = 5;
export const PHASE_7_RESOURCE_THRESHOLDS = Object.freeze({
    idleRetainedDeltaBytes: 20 * MIB,
    dualPeakDeltaBytes: 50 * MIB,
    cacheUsagePeakDeltaBytes: 40 * MIB,
    plannerCompactionPeakDeltaBytes: 45 * MIB,
    artifactRedisPeakDeltaBytes: 45 * MIB,
    crashRecoveryPeakDeltaBytes: 45 * MIB,
    catastrophicMaximumMultiplier: 2
});
export const PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS = Object.freeze({
    requestBytes: 512 * 1_024,
    sseLineBytes: 64 * 1_024,
    providerResponseBytes: 1_024 * 1_024,
    toolArgumentsBytes: 32 * 1_024,
    toolResultBytes: 64 * 1_024,
    providerStateBytes: 128 * 1_024,
    sanitizedErrorBodyBytes: 16 * 1_024,
    providerProtocolChainBytes: 192 * 1_024,
    checkpointBytes: 256 * 1_024,
    eventCount: 96,
    eventBytes: 128 * 1_024,
    namespaceBytes: 8 * 1_024 * 1_024,
    tombstoneBytes: 4 * 1_024,
    checkpointKeys: 16,
    eventKeys: 16,
    tombstoneKeys: 128,
    referenceKeys: 144,
    indexAdmissionKeys: 64
});
export const PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS = Object.freeze({
    artifactBytes: 16 * 1_024,
    contentBytes: 8 * 1_024,
    sourceRefs: 32,
    namespaceKeys: 128,
    namespaceBytes: 2 * 1_024 * 1_024,
    minimumRemainingLifetimeMs: 1,
    maximumExpiryHorizonMs: 86_400_000,
    reconcileScanCount: 128,
    maxReconcileScanCalls: 2_048,
    maxReconcileDataKeys: 129,
    maxMetadataCasAttempts: 4,
    metadataBytes: 64
});
export const PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS = Object.freeze({
    activeRuns: 2,
    queuedRuns: 3
});
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function median(values) {
    if (values.length === 0)
        throw new TypeError('statistics require at least one value');
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}
function statistics(values) {
    if (values.some(value => !Number.isSafeInteger(value))) {
        throw new TypeError('resource statistics require safe integers');
    }
    const center = median(values);
    return Object.freeze({
        median: center,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        mad: median(values.map(value => Math.abs(value - center)))
    });
}
function sameRecord(actual, expected) {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    return actualKeys.length === expectedKeys.length &&
        expectedKeys.every(key => actual[key] === expected[key]);
}
function withinMemoryStop(stats, medianLimit) {
    return stats.median <= medianLimit &&
        stats.maximum <= medianLimit * PHASE_7_RESOURCE_THRESHOLDS.catastrophicMaximumMultiplier;
}
function validateInput(value) {
    const input = record(value, 'Phase 7 resource samples');
    if (Object.keys(input).length !== PHASE_7_RESOURCE_SCENARIOS.length ||
        PHASE_7_RESOURCE_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
        throw new TypeError('Phase 7 resource scenarios are incomplete');
    }
    const processIds = new Set();
    const result = Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => {
        const values = input[scenario];
        if (!Array.isArray(values) || values.length !== PHASE_7_RESOURCE_SAMPLES) {
            throw new TypeError('Phase 7 resource report requires five fresh processes per scenario');
        }
        const entries = values.map((value, index) => {
            const entry = record(value, `Phase 7 process sample ${scenario}:${index}`);
            if (Object.keys(entry).length !== 2 ||
                !Object.hasOwn(entry, 'processId') || !Object.hasOwn(entry, 'sample') ||
                !Number.isSafeInteger(entry.processId) || Number(entry.processId) <= 0) {
                throw new TypeError('Phase 7 process sample is invalid');
            }
            const processId = Number(entry.processId);
            if (processIds.has(processId)) {
                throw new TypeError('Phase 7 process samples must use unique fresh processes');
            }
            processIds.add(processId);
            return Object.freeze({
                processId,
                sample: validatePhase7ResourceSample(entry.sample, scenario)
            });
        });
        return [scenario, Object.freeze(entries)];
    }));
    if (processIds.size !== PHASE_7_RESOURCE_SCENARIOS.length * PHASE_7_RESOURCE_SAMPLES) {
        throw new TypeError('Phase 7 resource report requires 30 unique processes');
    }
    return Object.freeze(result);
}
function scenarioReport(entries) {
    const samples = entries.map(entry => entry.sample);
    const baselines = samples.map(sample => sample.baselineRssBytes);
    const retained = samples.map(sample => sample.retainedRssBytes);
    const peaks = samples.map(sample => sample.peakRssBytes);
    return Object.freeze({
        processIds: Object.freeze(entries.map(entry => entry.processId)),
        samples: Object.freeze(samples),
        outcome: samples[0]?.outcome,
        rss: Object.freeze({
            baseline: statistics(baselines),
            retained: Object.freeze({
                absolute: statistics(retained),
                delta: statistics(retained.map((value, index) => value - baselines[index]))
            }),
            peak: Object.freeze({
                absolute: statistics(peaks),
                delta: statistics(peaks.map((value, index) => value - baselines[index]))
            })
        }),
        wallTimeMs: statistics(samples.map(sample => sample.wallTimeMs)),
        userCpuMicros: statistics(samples.map(sample => sample.userCpuMicros)),
        systemCpuMicros: statistics(samples.map(sample => sample.systemCpuMicros)),
        operations: statistics(samples.map(sample => sample.operations)),
        artifactStore: Object.freeze({
            records: statistics(samples.map(sample => sample.artifactStoreRecords)),
            bytes: statistics(samples.map(sample => sample.artifactStoreBytes))
        })
    });
}
export function buildPhase7ResourceReport(value) {
    const input = validateInput(value);
    const scenarios = Object.freeze(Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => [
        scenario,
        scenarioReport(input[scenario])
    ])));
    const processIds = Object.freeze(PHASE_7_RESOURCE_SCENARIOS.flatMap(scenario => (input[scenario].map(entry => entry.processId))));
    const thresholds = PHASE_7_RESOURCE_THRESHOLDS;
    const limitContracts = Object.freeze({
        plannerInputBytes: MAX_CONTEXT_PLANNER_INPUT_BYTES,
        admission: RUN_ADMISSION_LIMITS,
        runStore: RUN_RESOURCE_LIMITS,
        contextArtifacts: CONTEXT_ARTIFACT_RESOURCE_LIMITS
    });
    const gates = Object.freeze({
        idleRetained: withinMemoryStop(scenarios.idle.rss.retained.delta, thresholds.idleRetainedDeltaBytes),
        dualPeak: withinMemoryStop(scenarios.dual.rss.peak.delta, thresholds.dualPeakDeltaBytes),
        cacheUsagePeak: withinMemoryStop(scenarios.cacheUsage.rss.peak.delta, thresholds.cacheUsagePeakDeltaBytes),
        plannerCompactionPeak: withinMemoryStop(scenarios.plannerCompaction.rss.peak.delta, thresholds.plannerCompactionPeakDeltaBytes),
        artifactRedisPeak: withinMemoryStop(scenarios.artifactRedis.rss.peak.delta, thresholds.artifactRedisPeakDeltaBytes),
        crashRecoveryPeak: withinMemoryStop(scenarios.crashRecovery.rss.peak.delta, thresholds.crashRecoveryPeakDeltaBytes),
        admissionLimits: sameRecord(RUN_ADMISSION_LIMITS, PHASE_7_EXPECTED_RUN_ADMISSION_LIMITS),
        runStoreLimits: sameRecord(RUN_RESOURCE_LIMITS, PHASE_7_EXPECTED_RUN_RESOURCE_LIMITS),
        contextArtifactLimits: sameRecord(CONTEXT_ARTIFACT_RESOURCE_LIMITS, PHASE_7_EXPECTED_CONTEXT_ARTIFACT_RESOURCE_LIMITS) && MAX_CONTEXT_ARTIFACT_BYTES === 16 * 1_024 &&
            MAX_CONTEXT_ARTIFACT_CONTENT_BYTES === 8 * 1_024 && MAX_CONTEXT_ARTIFACT_REFS === 32,
        plannerInputLimit: MAX_CONTEXT_PLANNER_INPUT_BYTES === RUN_RESOURCE_LIMITS.requestBytes &&
            RUN_RESOURCE_LIMITS.requestBytes === 512 * 1_024 &&
            RUN_RESOURCE_LIMITS.checkpointBytes === 256 * 1_024,
        artifactNamespaceUsage: scenarios.artifactRedis.artifactStore.records.maximum > 0 &&
            scenarios.artifactRedis.artifactStore.records.maximum <=
                CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys &&
            scenarios.artifactRedis.artifactStore.bytes.maximum > 0 &&
            scenarios.artifactRedis.artifactStore.bytes.maximum <=
                CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes
    });
    return Object.freeze({
        schemaVersion: 1,
        samplesPerScenario: PHASE_7_RESOURCE_SAMPLES,
        totalProcessCount: processIds.length,
        processIds,
        scenarios,
        thresholds,
        limitContracts,
        gates,
        passed: Object.values(gates).every(Boolean)
    });
}
function runFreshScenario(scenario) {
    const script = fileURLToPath(new URL('../../scripts/phase-7-resource-scenario.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--expose-gc', script, scenario], {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 2 * MIB,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error !== undefined)
        throw result.error;
    if (result.status !== 0 || !Number.isSafeInteger(result.pid) || Number(result.pid) <= 0) {
        const detail = result.stderr.trim().slice(0, 1_000);
        throw new Error(`Phase 7 resource child failed for ${scenario}${detail === '' ? '' : `: ${detail}`}`);
    }
    let value;
    try {
        value = JSON.parse(result.stdout.trim());
    }
    catch {
        throw new TypeError(`Phase 7 resource child returned invalid JSON for ${scenario}`);
    }
    return Object.freeze({
        processId: Number(result.pid),
        sample: validatePhase7ResourceSample(value, scenario)
    });
}
export async function main() {
    const samples = Object.fromEntries(PHASE_7_RESOURCE_SCENARIOS.map(scenario => [
        scenario,
        Object.freeze(Array.from({ length: PHASE_7_RESOURCE_SAMPLES }, () => runFreshScenario(scenario)))
    ]));
    const report = buildPhase7ResourceReport(samples);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed)
        process.exitCode = 1;
}
