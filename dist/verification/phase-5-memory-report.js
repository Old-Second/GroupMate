import { PHASE_5_MEMORY_SCENARIOS } from './phase-5-memory-scenario.js';
export const PHASE_5_MEMORY_SAMPLES = 5;
export const PHASE_5_IDLE_RETAINED_LIMIT_BYTES = 20 * 1024 * 1024;
export const PHASE_5_DUAL_RUN_PEAK_LIMIT_BYTES = 50 * 1024 * 1024;
const EXPECTED_REQUESTS = Object.freeze({
    idle: 0,
    singleRun: 1,
    dualRun: 2,
    checkpointRecovery: 1
});
const EXPECTED_CONCURRENCY = Object.freeze({
    idle: 0,
    singleRun: 1,
    dualRun: 2,
    checkpointRecovery: 1
});
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return Number(value);
}
export function validatePhase5MemorySample(value, expectedScenario) {
    const sample = record(value, 'memory sample');
    const keys = Object.keys(sample);
    const expectedKeys = [
        'scenario', 'requestCount', 'maxConcurrentRequests', 'baselineRssBytes',
        'retainedRssBytes', 'observedPeakRssBytes'
    ];
    if (keys.length !== expectedKeys.length ||
        expectedKeys.some(key => !Object.hasOwn(sample, key)) ||
        sample.scenario !== expectedScenario) {
        throw new TypeError('memory sample scenario is invalid');
    }
    if (sample.requestCount !== EXPECTED_REQUESTS[expectedScenario]) {
        throw new TypeError('memory sample request count is invalid');
    }
    if (sample.maxConcurrentRequests !== EXPECTED_CONCURRENCY[expectedScenario]) {
        throw new TypeError('memory sample concurrency is invalid');
    }
    const baselineRssBytes = positiveInteger(sample.baselineRssBytes, 'baseline RSS');
    const retainedRssBytes = positiveInteger(sample.retainedRssBytes, 'retained RSS');
    const observedPeakRssBytes = positiveInteger(sample.observedPeakRssBytes, 'peak RSS');
    if (observedPeakRssBytes < baselineRssBytes || observedPeakRssBytes < retainedRssBytes) {
        throw new TypeError('memory sample peak RSS is invalid');
    }
    return Object.freeze({
        scenario: expectedScenario,
        requestCount: EXPECTED_REQUESTS[expectedScenario],
        maxConcurrentRequests: EXPECTED_CONCURRENCY[expectedScenario],
        baselineRssBytes,
        retainedRssBytes,
        observedPeakRssBytes
    });
}
function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}
function medianSample(scenario, samples) {
    return Object.freeze({
        scenario,
        requestCount: EXPECTED_REQUESTS[scenario],
        maxConcurrentRequests: EXPECTED_CONCURRENCY[scenario],
        baselineRssBytes: median(samples.map(sample => sample.baselineRssBytes)),
        retainedRssBytes: median(samples.map(sample => sample.retainedRssBytes)),
        observedPeakRssBytes: median(samples.map(sample => sample.observedPeakRssBytes))
    });
}
export function buildPhase5MemoryReport(value) {
    const input = record(value, 'memory samples');
    if (Object.keys(input).length !== PHASE_5_MEMORY_SCENARIOS.length ||
        PHASE_5_MEMORY_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
        throw new TypeError('memory sample scenarios are incomplete');
    }
    const samples = Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map(scenario => {
        const values = input[scenario];
        if (!Array.isArray(values) || values.length !== PHASE_5_MEMORY_SAMPLES) {
            throw new TypeError('memory report requires five samples per scenario');
        }
        return [scenario, Object.freeze(values.map(sample => (validatePhase5MemorySample(sample, scenario))))];
    }));
    const medians = Object.freeze(Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map(scenario => [
        scenario,
        medianSample(scenario, samples[scenario])
    ])));
    const deltas = Object.freeze({
        idleRetainedBytes: medians.idle.retainedRssBytes - medians.idle.baselineRssBytes,
        dualRunPeakBytes: medians.dualRun.observedPeakRssBytes -
            medians.dualRun.baselineRssBytes
    });
    const thresholds = Object.freeze({
        idleRetainedDeltaBytes: PHASE_5_IDLE_RETAINED_LIMIT_BYTES,
        dualRunPeakDeltaBytes: PHASE_5_DUAL_RUN_PEAK_LIMIT_BYTES
    });
    const gates = Object.freeze({
        idleRetained: deltas.idleRetainedBytes <= thresholds.idleRetainedDeltaBytes,
        dualRunPeak: deltas.dualRunPeakBytes <= thresholds.dualRunPeakDeltaBytes
    });
    return Object.freeze({
        samplesPerScenario: PHASE_5_MEMORY_SAMPLES,
        samples,
        medians,
        deltas,
        thresholds,
        gates,
        passed: gates.idleRetained && gates.dualRunPeak
    });
}
