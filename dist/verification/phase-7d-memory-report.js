import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_DERIVATIVE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS } from '../agent/memory/memory-resource-limits.js';
import { auditPhase7SecurityBoundaries } from './phase-7-security-audit.js';
import { auditPhase7bMemoryWiring } from './phase-7b-memory-report.js';
import { PHASE_7D_MEMORY_RESOURCE_SCENARIOS, PHASE_7D_MEMORY_RESOURCE_SENSITIVE_SENTINELS, runPhase7dMemoryResourceScenario, validatePhase7dMemoryResourceSample } from './phase-7d-memory-scenario.js';
const MIB = 1_024 * 1_024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1_024;
const RESOURCE_CHILD_TIMEOUT_MS = 30_000;
const RESOURCE_SAMPLE_ARGUMENT = '--sample';
const EXTRACTION_SQLITE_FILE_LIMIT_BYTES = 64 * MIB;
const PHASE_7D_OPERATION_LATENCY_LIMIT_MICROS = 250_000;
const PHASE_7D_SCENARIO_WALL_TIME_LIMIT_MS = 5_000;
export const PHASE_7D_MEMORY_RESOURCE_SAMPLES = 5;
export const PHASE_7D_MEMORY_RSS_LIMIT_BYTES = 32 * MIB;
function safeProjectRoot(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Phase 7D memory verification project root is invalid');
    }
    return path.resolve(value);
}
function exactRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function median(values) {
    if (values.length === 0)
        throw new TypeError('statistics require values');
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}
function statistics(values) {
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError('Phase 7D memory statistics require nonnegative safe integers');
    }
    const center = median(values);
    return Object.freeze({
        median: center,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        mad: median(values.map(value => Math.abs(value - center)))
    });
}
function validateResourceInput(value) {
    const input = exactRecord(value, 'Phase 7D memory resource samples');
    if (!sameStrings(Object.keys(input).sort(), [...PHASE_7D_MEMORY_RESOURCE_SCENARIOS].sort())) {
        throw new TypeError('Phase 7D memory resource scenarios are incomplete');
    }
    const processIds = new Set();
    const entries = Object.fromEntries(PHASE_7D_MEMORY_RESOURCE_SCENARIOS.map(scenario => {
        const values = input[scenario];
        if (!Array.isArray(values) || values.length !== PHASE_7D_MEMORY_RESOURCE_SAMPLES) {
            throw new TypeError('Phase 7D memory report requires five fresh processes per scenario');
        }
        const samples = values.map((value, index) => {
            const entry = exactRecord(value, `Phase 7D memory sample ${scenario}:${index}`);
            if (!sameStrings(Object.keys(entry).sort(), ['processId', 'sample']) ||
                !Number.isSafeInteger(entry.processId) || Number(entry.processId) <= 0) {
                throw new TypeError('Phase 7D memory process sample is invalid');
            }
            const processId = Number(entry.processId);
            if (processIds.has(processId)) {
                throw new TypeError('Phase 7D memory samples require unique fresh processes');
            }
            processIds.add(processId);
            return Object.freeze({
                processId,
                sample: validatePhase7dMemoryResourceSample(entry.sample, scenario)
            });
        });
        return [scenario, Object.freeze(samples)];
    }));
    if (processIds.size !== PHASE_7D_MEMORY_RESOURCE_SCENARIOS.length *
        PHASE_7D_MEMORY_RESOURCE_SAMPLES) {
        throw new TypeError('Phase 7D memory samples require fifteen fresh processes');
    }
    return Object.freeze(entries);
}
function scenarioReport(entries) {
    const samples = entries.map(value => value.sample);
    return Object.freeze({
        processIds: Object.freeze(entries.map(value => value.processId)),
        rss: Object.freeze({
            baseline: statistics(samples.map(value => value.baselineRssBytes)),
            retainedDelta: statistics(samples.map(value => (value.retainedRssBytes - value.baselineRssBytes))),
            peakDelta: statistics(samples.map(value => value.peakRssBytes - value.baselineRssBytes))
        }),
        wallTimeMs: statistics(samples.map(value => value.wallTimeMs)),
        maximumOperationLatencyMicros: statistics(samples.map(value => value.maximumOperationLatencyMicros)),
        diskBytes: Object.freeze({
            canonical: statistics(samples.map(value => value.canonicalFileBytes)),
            lexical: statistics(samples.map(value => value.lexicalFileBytes)),
            extraction: statistics(samples.map(value => value.extractionFileBytes))
        })
    });
}
export function buildPhase7dMemoryResourceReport(value) {
    const input = validateResourceInput(value);
    const scenarios = Object.freeze(Object.fromEntries(PHASE_7D_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
        scenario,
        scenarioReport(input[scenario])
    ])));
    const samples = PHASE_7D_MEMORY_RESOURCE_SCENARIOS.flatMap(scenario => input[scenario].map(value => value.sample));
    const processIds = Object.freeze(PHASE_7D_MEMORY_RESOURCE_SCENARIOS.flatMap(scenario => input[scenario].map(value => value.processId)));
    const retrievalSamples = input.retrievalCorpus.map(value => value.sample);
    const candidateSamples = input.candidateShadow.map(value => value.sample);
    const deletionSamples = input.deletionCleanup.map(value => value.sample);
    const gates = Object.freeze({
        everySampleRss: samples.every(sample => sample.retainedRssBytes - sample.baselineRssBytes <= PHASE_7D_MEMORY_RSS_LIMIT_BYTES &&
            sample.peakRssBytes - sample.baselineRssBytes <= PHASE_7D_MEMORY_RSS_LIMIT_BYTES),
        everySampleLatency: samples.every(sample => sample.wallTimeMs <= PHASE_7D_SCENARIO_WALL_TIME_LIMIT_MS &&
            sample.maximumOperationLatencyMicros <= PHASE_7D_OPERATION_LATENCY_LIMIT_MICROS),
        everySampleDisk: samples.every(sample => sample.canonicalFileBytes <= MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes &&
            sample.lexicalFileBytes <= MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalSqliteMainFileBytes &&
            sample.extractionFileBytes <= EXTRACTION_SQLITE_FILE_LIMIT_BYTES),
        cleanupComplete: samples.every(sample => sample.sqliteClosed && sample.directoryRemoved && sample.timerResourceDelta === 0),
        retrievalRecallExact: retrievalSamples.every(sample => sample.expectedRelevant === 5 && sample.observedRelevant === sample.expectedRelevant),
        leakageZero: samples.every(sample => sample.leakageCount === 0),
        candidatePrecisionExact: candidateSamples.every(sample => sample.candidateExpectedAdmitted === 3 &&
            sample.candidateObservedAdmitted === sample.candidateExpectedAdmitted),
        credentialAndLowValueRejected: candidateSamples.every(sample => sample.credentialRejected === 3 && sample.lowValueRejected === 1),
        semanticEgressZero: samples.every(sample => sample.semanticEgressCalls === 0),
        deletionNoResurrection: deletionSamples.every(sample => sample.deletionResidualCanonical === 0 && sample.deletionResidualFts === 0 &&
            sample.deletionResidualCache === 0 && sample.deletionResidualQueue === 0 &&
            sample.deletionResidualContext === 0 && sample.lexicalRecords === 0 &&
            sample.queueRecords === 0)
    });
    return Object.freeze({
        schemaVersion: 1,
        samplesPerScenario: PHASE_7D_MEMORY_RESOURCE_SAMPLES,
        totalProcessCount: processIds.length,
        processIds,
        scenarios,
        thresholds: Object.freeze({
            rssDeltaBytes: PHASE_7D_MEMORY_RSS_LIMIT_BYTES,
            operationLatencyMicros: PHASE_7D_OPERATION_LATENCY_LIMIT_MICROS,
            wallTimeMs: PHASE_7D_SCENARIO_WALL_TIME_LIMIT_MS,
            canonicalFileBytes: MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes,
            lexicalFileBytes: MEMORY_DERIVATIVE_RESOURCE_LIMITS.lexicalSqliteMainFileBytes,
            extractionFileBytes: EXTRACTION_SQLITE_FILE_LIMIT_BYTES
        }),
        gates,
        passed: Object.values(gates).every(Boolean)
    });
}
async function boundedSource(root, relativePath) {
    try {
        const source = await readFile(path.join(root, relativePath), 'utf8');
        return Buffer.byteLength(source, 'utf8') <= 2 * MIB ? source : null;
    }
    catch {
        return null;
    }
}
function matchCount(source, expression) {
    return [...source.matchAll(expression)].length;
}
export async function auditPhase7dContextSurfaces(projectRootValue) {
    const root = safeProjectRoot(projectRootValue);
    const [engine, packageSource, ...regressionSources] = await Promise.all([
        boundedSource(root, 'src/agent/context/context-engine.ts'),
        boundedSource(root, 'package.json'),
        boundedSource(root, 'test/unit/context-engine.test.ts'),
        boundedSource(root, 'test/unit/context-planner.test.ts'),
        boundedSource(root, 'test/unit/run-context-planner.test.ts'),
        boundedSource(root, 'test/unit/run-engine.test.ts'),
        boundedSource(root, 'test/unit/run-usage.test.ts'),
        boundedSource(root, 'test/unit/model-cost.test.ts'),
        boundedSource(root, 'test/unit/presentation-trace.test.ts')
    ]);
    const contextSource = engine ?? '';
    const cacheFriendlyOrder = matchCount(contextSource, /\.\.\.input\.systemInstructions,\s*\.\.\.input\.runtimeFacts,\s*\.\.\.input\.sessionHistory,\s*\.\.\.input\.groupContext,\s*\.\.\.input\.memoryContext,\s*input\.currentRequest,\s*\.\.\.input\.toolMessages/g) >= 2;
    const mandatoryContextProtected = /return source === 'system_instruction' \|\| source === 'current_request'/.test(contextSource) && /const mandatoryGroups = groups\.filter\(group => group\.mandatory\)/.test(contextSource) &&
        /if \(mandatoryTokens > availableInputTokens\)/.test(contextSource);
    const memoryUntrusted = /first\.source === 'memory'\s*\? 'untrusted' as const/.test(contextSource) && /strictSource === 'system_instruction' \|\| strictSource === 'current_request'/.test(contextSource);
    let verifyScript = '';
    try {
        const packageValue = packageSource === null
            ? null
            : JSON.parse(packageSource);
        const value = packageValue?.scripts?.['verify:phase7d'];
        verifyScript = typeof value === 'string' ? value : '';
    }
    catch { }
    const requiredRegressionNames = [
        'context-engine.test.js',
        'context-planner.test.js',
        'run-context-planner.test.js',
        'run-engine.test.js',
        'run-usage.test.js',
        'model-cost.test.js',
        'presentation-trace.test.js'
    ];
    const presentationRegressionTestsPresent = regressionSources.every(value => value !== null) &&
        requiredRegressionNames.every(value => verifyScript.includes(value));
    const result = Object.freeze({
        cacheFriendlyOrder,
        mandatoryContextProtected,
        memoryUntrusted,
        presentationRegressionTestsPresent,
        passed: false
    });
    return Object.freeze({
        ...result,
        passed: result.cacheFriendlyOrder && result.mandatoryContextProtected &&
            result.memoryUntrusted && result.presentationRegressionTestsPresent
    });
}
export function parsePhase7dMemoryChildObservation(value, scenario) {
    const fail = () => {
        throw new TypeError('Phase 7D memory resource child failed');
    };
    try {
        const input = exactRecord(value, 'Phase 7D memory child observation');
        if (!sameStrings(Object.keys(input).sort(), ['failed', 'processId', 'status', 'stdout']) ||
            input.failed !== false || input.status !== 0 ||
            !Number.isSafeInteger(input.processId) || Number(input.processId) <= 0 ||
            typeof input.stdout !== 'string' || input.stdout.trim() === '' ||
            Buffer.byteLength(input.stdout, 'utf8') > MAX_CHILD_OUTPUT_BYTES ||
            PHASE_7D_MEMORY_RESOURCE_SENSITIVE_SENTINELS.some(sentinel => input.stdout.includes(sentinel)))
            return fail();
        return Object.freeze({
            processId: Number(input.processId),
            sample: validatePhase7dMemoryResourceSample(JSON.parse(input.stdout.trim()), scenario)
        });
    }
    catch {
        return fail();
    }
}
function runFreshMemorySample(root, scenario) {
    const result = spawnSync(process.execPath, [
        '--expose-gc',
        path.join(root, 'scripts', 'verify-phase-7d.mjs'),
        RESOURCE_SAMPLE_ARGUMENT,
        scenario
    ], {
        cwd: root,
        encoding: 'utf8',
        timeout: RESOURCE_CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return parsePhase7dMemoryChildObservation({
        failed: result.error !== undefined,
        status: result.status,
        processId: Number.isSafeInteger(result.pid) ? Number(result.pid) : null,
        stdout: typeof result.stdout === 'string' ? result.stdout : ''
    }, scenario);
}
function findingCount(value) {
    return Object.entries(value).reduce((total, [key, current]) => (key === 'passed' || !Array.isArray(current) ? total : total + current.length), 0);
}
export async function verifyPhase7dMemory(projectRootValue, options = {}) {
    const root = safeProjectRoot(projectRootValue);
    const samples = options.samples ?? Object.freeze(Object.fromEntries(PHASE_7D_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
        scenario,
        Object.freeze(Array.from({ length: PHASE_7D_MEMORY_RESOURCE_SAMPLES }, () => runFreshMemorySample(root, scenario)))
    ])));
    const resources = buildPhase7dMemoryResourceReport(samples);
    const [production, context] = await Promise.all([
        (options.productionAudit ?? auditPhase7bMemoryWiring)(root),
        (options.contextAudit ?? auditPhase7dContextSurfaces)(root)
    ]);
    let phase7 = null;
    try {
        phase7 = await (options.securityAudit ?? auditPhase7SecurityBoundaries)(root);
    }
    catch {
        phase7 = null;
    }
    const security = Object.freeze({
        passed: phase7?.passed === true,
        findingCount: phase7 === null ? 1 : findingCount(phase7)
    });
    return Object.freeze({
        schemaVersion: 1,
        resources,
        production,
        context,
        security,
        passed: resources.passed && production.passed && context.passed &&
            security.passed && security.findingCount === 0
    });
}
export async function main() {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 2 && arguments_[0] === RESOURCE_SAMPLE_ARGUMENT) {
        const scenario = arguments_[1];
        if (!PHASE_7D_MEMORY_RESOURCE_SCENARIOS.includes(scenario))
            throw new TypeError('Phase 7D memory verification arguments are invalid');
        const sample = await runPhase7dMemoryResourceScenario({
            scenario: scenario
        });
        process.stdout.write(JSON.stringify(sample));
        return;
    }
    if (arguments_.length !== 0) {
        throw new TypeError('Phase 7D memory verification arguments are invalid');
    }
    const verification = await verifyPhase7dMemory(process.cwd());
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    if (!verification.passed)
        process.exitCode = 1;
}
