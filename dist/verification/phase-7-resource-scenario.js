import { createContextArtifactV1, encodeContextArtifactV1 } from '../agent/context/context-artifact.js';
import { planModelTurn } from '../agent/context/context-planner.js';
import { CONTEXT_TOKEN_ESTIMATOR_VERSION } from '../agent/context/context-token-estimator.js';
import { createContextSpanV1 } from '../agent/context/context-span.js';
import { CONTEXT_ARTIFACT_RESOURCE_LIMITS } from '../agent/context/context-resource-limits.js';
import { CONTEXT_ARTIFACT_METADATA_KEY, RedisContextArtifactStore } from '../agent/context/redis-context-artifact-store.js';
import { compactConsumedToolSpan } from '../agent/context/tool-digest-compactor.js';
import { deepSeekCompatibilityProfile } from '../agent/model/deepseek-compatibility-profile.js';
import { normalizeMaxRssBytes, runPhase6ResourceScenario } from './phase-6-resource-scenario.js';
const HASH = '7'.repeat(64);
const NAMESPACE_REF = 'namespace:phase-7-resource';
const FIXED_NOW_MS = Date.parse('2026-07-19T00:00:00.000Z');
export const PHASE_7_RESOURCE_SCENARIOS = Object.freeze([
    'idle',
    'dual',
    'cacheUsage',
    'plannerCompaction',
    'artifactRedis',
    'crashRecovery'
]);
export const PHASE_7_RESOURCE_OUTCOMES = Object.freeze({
    idle: 'idle',
    dual: 'completed',
    cacheUsage: 'cache_usage_decoded',
    plannerCompaction: 'artifact_compacted',
    artifactRedis: 'artifact_round_trip',
    crashRecovery: 'recovered'
});
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}
function safeNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`Phase 7 ${label} must be a non-negative safe integer`);
    }
    return Number(value);
}
function exactRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Phase 7 resource sample must be an object');
    }
    return value;
}
export function validatePhase7ResourceSample(value, expectedScenario) {
    const sample = exactRecord(value);
    const keys = [
        'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes', 'wallTimeMs',
        'userCpuMicros', 'systemCpuMicros', 'operations', 'artifactStoreRecords',
        'artifactStoreBytes', 'outcome'
    ];
    if (Object.keys(sample).length !== keys.length || keys.some(key => !Object.hasOwn(sample, key)) ||
        typeof sample.scenario !== 'string' ||
        !PHASE_7_RESOURCE_SCENARIOS.includes(sample.scenario)) {
        throw new TypeError('Phase 7 resource sample shape is invalid');
    }
    const scenario = sample.scenario;
    if (expectedScenario !== undefined && scenario !== expectedScenario) {
        throw new TypeError('Phase 7 resource sample scenario does not match');
    }
    if (sample.outcome !== PHASE_7_RESOURCE_OUTCOMES[scenario]) {
        throw new TypeError('Phase 7 resource sample outcome does not match');
    }
    const baselineRssBytes = safeNonNegativeInteger(sample.baselineRssBytes, 'baseline RSS');
    const retainedRssBytes = safeNonNegativeInteger(sample.retainedRssBytes, 'retained RSS');
    const peakRssBytes = safeNonNegativeInteger(sample.peakRssBytes, 'peak RSS');
    if (baselineRssBytes === 0 || retainedRssBytes === 0 ||
        peakRssBytes < baselineRssBytes || peakRssBytes < retainedRssBytes) {
        throw new TypeError('Phase 7 resource sample RSS values are invalid');
    }
    safeNonNegativeInteger(sample.wallTimeMs, 'wall time');
    safeNonNegativeInteger(sample.userCpuMicros, 'user CPU');
    safeNonNegativeInteger(sample.systemCpuMicros, 'system CPU');
    safeNonNegativeInteger(sample.operations, 'operation count');
    const artifactStoreRecords = safeNonNegativeInteger(sample.artifactStoreRecords, 'artifact record count');
    const artifactStoreBytes = safeNonNegativeInteger(sample.artifactStoreBytes, 'artifact bytes');
    if (artifactStoreRecords > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys ||
        artifactStoreBytes > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes) {
        throw new TypeError('Phase 7 resource sample artifact namespace exceeds its hard limit');
    }
    return Object.freeze(value);
}
function settleDelay(value) {
    const current = value ?? 25;
    if (!Number.isSafeInteger(current) || current < 0 || current > 1_000) {
        throw new TypeError('Phase 7 resource settle time is invalid');
    }
    return current;
}
function mandatorySpan(spanId, semanticOrder, source, content, originGeneration = 0) {
    return createContextSpanV1(deepFreeze({
        spanId,
        namespaceRef: NAMESPACE_REF,
        kind: 'message',
        source,
        trust: source === 'system_instruction' ? 'trusted' : 'untrusted',
        requirement: 'mandatory',
        priority: 'critical',
        semanticOrder,
        originGeneration,
        provenance: {
            kind: 'run',
            ref: `ref:${spanId}`,
            revision: 1,
            contentHash: HASH
        },
        supersedes: null,
        messages: [{
                role: source === 'system_instruction' ? 'system' : 'user',
                content
            }],
        sourceRefs: [{ ref: `ref:${spanId}`, contentHash: HASH }],
        toolProtocol: null
    }));
}
function consumedToolSpan() {
    const callId = 'call:phase-7-resource';
    return createContextSpanV1(deepFreeze({
        spanId: 'span:phase-7-resource:consumed-tool',
        namespaceRef: NAMESPACE_REF,
        kind: 'tool_protocol',
        source: 'tool_chain',
        trust: 'untrusted',
        requirement: 'optional',
        priority: 'normal',
        semanticOrder: 30,
        originGeneration: 1,
        provenance: {
            kind: 'tool_ledger',
            ref: 'ref:phase-7-resource:tool-ledger',
            revision: 1,
            contentHash: HASH
        },
        supersedes: null,
        messages: [
            {
                role: 'assistant',
                content: null,
                toolCalls: [{ callId, name: 'resource_fixture', arguments: { value: 7 } }]
            },
            { role: 'tool', content: 'x'.repeat(4_800), toolCallId: callId }
        ],
        sourceRefs: [{ ref: 'ref:phase-7-resource:tool-source', contentHash: HASH }],
        toolProtocol: { phase: 'consumed', step: 1, callIds: [callId] }
    }));
}
function plannerInput(spans, overrides = {}) {
    return deepFreeze({
        schemaVersion: 1,
        namespaceRef: NAMESPACE_REF,
        generation: 1,
        transition: 'normal',
        previousPlan: null,
        estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
        capabilityHash: HASH,
        artifactPolicy: 'enabled',
        budget: {
            schemaVersion: 1,
            maxInputTokens: 100_000,
            maxSerializedMessageBytes: 5_800,
            maxMessages: 128,
            estimatedToolTokens: 0,
            reservedOutputTokens: 0
        },
        spans,
        artifacts: deepFreeze([]),
        ...overrides
    });
}
async function cacheUsageWorkload() {
    const usage = deepFreeze({
        prompt_tokens: 1_024,
        completion_tokens: 64,
        total_tokens: 1_088,
        prompt_cache_hit_tokens: 896,
        prompt_cache_miss_tokens: 128
    });
    for (let index = 0; index < 256; index += 1) {
        const decoded = deepSeekCompatibilityProfile.decodeUsageExtensions(usage, {
            inputTokens: 1_024,
            outputTokens: 64,
            totalTokens: 1_088
        });
        if (decoded.inputCache?.hitTokens !== 896 || decoded.inputCache.missTokens !== 128) {
            throw new Error('Phase 7 cache usage workload produced an invalid result');
        }
    }
    return Object.freeze({ operations: 256, artifactStoreRecords: 0, artifactStoreBytes: 0 });
}
async function plannerCompactionWorkload() {
    const system = mandatorySpan('span:phase-7-resource:system', 10, 'system_instruction', 'system');
    const current = mandatorySpan('span:phase-7-resource:current', 20, 'current_request', 'current');
    const consumed = consumedToolSpan();
    const spans = deepFreeze([system, current, consumed]);
    const planned = planModelTurn(plannerInput(spans));
    if (planned.status !== 'requires_artifacts' || planned.compactionRequests.length !== 1) {
        throw new Error('Phase 7 planner did not request deterministic compaction');
    }
    const request = planned.compactionRequests[0];
    const evidence = deepFreeze({
        schemaVersion: 1,
        step: 1,
        calls: [{
                callId: 'call:phase-7-resource',
                terminalStatus: 'succeeded',
                result: {
                    status: 'success',
                    effect: 'none',
                    content: [{ type: 'text', text: 'x'.repeat(4_800) }],
                    retryable: false
                }
            }]
    });
    const compacted = compactConsumedToolSpan(request, consumed, evidence);
    if (compacted.status !== 'ready') {
        throw new Error('Phase 7 deterministic compaction failed');
    }
    const replanned = planModelTurn(plannerInput(spans, {
        artifacts: deepFreeze([compacted.artifact])
    }));
    if (replanned.status !== 'ready' ||
        !replanned.plan.artifactRefs.includes(compacted.artifact.artifactId)) {
        throw new Error('Phase 7 planner did not consume its compacted artifact');
    }
    return Object.freeze({
        operations: 3,
        artifactStoreRecords: 0,
        artifactStoreBytes: utf8Bytes(encodeContextArtifactV1(compacted.artifact))
    });
}
class Phase7ArtifactRedis {
    #entries = new Map();
    #now;
    constructor(now) {
        this.#now = now;
    }
    usage() {
        this.#purgeExpired();
        const entries = [...this.#entries.entries()].filter(([key]) => key !== CONTEXT_ARTIFACT_METADATA_KEY);
        return Object.freeze({
            records: entries.length,
            bytes: entries.reduce((total, [, entry]) => total + utf8Bytes(entry.value), 0)
        });
    }
    async get(key) {
        this.#purgeExpired();
        return this.#entries.get(key)?.value ?? null;
    }
    async scan(cursor, options) {
        this.#purgeExpired();
        const prefix = options.MATCH.endsWith('*') ? options.MATCH.slice(0, -1) : options.MATCH;
        const keys = [...this.#entries.keys()]
            .filter(key => options.MATCH.endsWith('*') ? key.startsWith(prefix) : key === prefix)
            .sort();
        const page = keys.slice(cursor, cursor + options.COUNT);
        return {
            cursor: cursor + options.COUNT >= keys.length ? 0 : cursor + options.COUNT,
            keys: page
        };
    }
    async eval(_script, options) {
        this.#purgeExpired();
        const operation = options.arguments[0];
        if (operation === 'validate_expiry') {
            return this.#validExpiry(options.arguments[2]) ? 'ok' : 'invalid_expiry';
        }
        if (operation === 'metadata_snapshot') {
            const current = this.#entries.get(options.keys[0])?.value;
            if (current === undefined)
                return 'missing';
            return utf8Bytes(current) > CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes
                ? 'oversized'
                : ['exact', current];
        }
        if (operation === 'reconcile') {
            const key = options.keys[0];
            const current = this.#entries.get(key)?.value;
            const expectedKind = options.arguments[1];
            const expected = options.arguments[2];
            if ((expectedKind === 'missing' && current !== undefined) ||
                (expectedKind === 'exact' && current !== expected) ||
                (expectedKind === 'oversized' &&
                    (current === undefined || utf8Bytes(current) <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes))) {
                return 'conflict';
            }
            this.#entries.set(key, { value: options.arguments[3] });
            return 'ok';
        }
        if (operation === 'read') {
            const current = this.#entries.get(options.keys[0])?.value;
            if (current === undefined)
                return 'missing';
            return utf8Bytes(current) > CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes
                ? 'too_large'
                : ['exact', current];
        }
        if (operation === 'put' || operation === 'touch') {
            const key = options.keys[0];
            const metadataKey = options.keys[1];
            const encoded = options.arguments[1];
            const expiresAtMs = Number(options.arguments[2]);
            if (!this.#validExpiry(String(expiresAtMs)))
                return 'invalid_expiry';
            const existing = this.#entries.get(key);
            if (existing !== undefined && existing.value !== encoded)
                return 'corrupt';
            const metadata = this.#parseMetadata(this.#entries.get(metadataKey)?.value);
            if (metadata === null)
                return 'reconcile';
            if (operation === 'touch') {
                if (existing === undefined)
                    return 'missing';
                existing.expiresAtMs = Math.max(existing.expiresAtMs ?? 0, expiresAtMs);
                return 'ok';
            }
            if (existing !== undefined) {
                existing.expiresAtMs = Math.max(existing.expiresAtMs ?? 0, expiresAtMs);
                return 'existing';
            }
            const projectedRecords = metadata.records + 1;
            const projectedBytes = metadata.bytes + utf8Bytes(encoded);
            if (projectedRecords > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys ||
                projectedBytes > CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes)
                return 'capacity';
            this.#entries.set(key, { value: encoded, expiresAtMs });
            this.#entries.set(metadataKey, { value: `1|${projectedRecords}|${projectedBytes}` });
            return 'stored';
        }
        throw new TypeError('Phase 7 artifact Redis received an unsupported operation');
    }
    #validExpiry(value) {
        const expiresAtMs = Number(value);
        return Number.isSafeInteger(expiresAtMs) && expiresAtMs > this.#now() &&
            expiresAtMs <= this.#now() + CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs;
    }
    #parseMetadata(value) {
        const match = /^1\|(\d+)\|(\d+)$/.exec(value ?? '');
        if (match === null)
            return null;
        const records = Number(match[1]);
        const bytes = Number(match[2]);
        return Number.isSafeInteger(records) && Number.isSafeInteger(bytes)
            ? Object.freeze({ records, bytes })
            : null;
    }
    #purgeExpired() {
        for (const [key, entry] of this.#entries) {
            if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= this.#now()) {
                this.#entries.delete(key);
            }
        }
    }
}
async function artifactRedisWorkload() {
    const redis = new Phase7ArtifactRedis(() => FIXED_NOW_MS);
    const store = new RedisContextArtifactStore({ client: redis });
    const artifact = createContextArtifactV1(deepFreeze({
        namespaceRef: NAMESPACE_REF,
        generation: 1,
        kind: 'conversation_summary',
        sourceSpanIds: ['span:phase-7-resource:artifact-source'],
        sourceRefs: [{ ref: 'span:phase-7-resource:artifact-source', contentHash: HASH }],
        content: 'artifact-resource-content'.repeat(160),
        generator: { kind: 'deterministic', version: 'phase-7-resource-v1' },
        estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
    }));
    const firstExpiry = FIXED_NOW_MS + 30_000;
    const secondExpiry = FIXED_NOW_MS + 60_000;
    const stored = await store.putIfAbsent(artifact, firstExpiry);
    const loaded = await store.get(artifact.artifactId);
    const touched = await store.touchAtLeast(artifact, secondExpiry);
    if (stored.status !== 'ready' || loaded.status !== 'ready' || touched.status !== 'ready' ||
        encodeContextArtifactV1(stored.artifact) !== encodeContextArtifactV1(artifact) ||
        encodeContextArtifactV1(loaded.artifact) !== encodeContextArtifactV1(artifact) ||
        encodeContextArtifactV1(touched.artifact) !== encodeContextArtifactV1(artifact)) {
        throw new Error('Phase 7 artifact Redis workload did not preserve immutable content');
    }
    const usage = redis.usage();
    return Object.freeze({
        operations: 3,
        artifactStoreRecords: usage.records,
        artifactStoreBytes: usage.bytes
    });
}
async function measuredWorkload(scenario, workload, options) {
    const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage());
    const collect = options.gc ?? globalThis.gc;
    collect?.();
    const baselineRssBytes = memoryUsage().rss;
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const result = await workload();
    const observations = [baselineRssBytes, memoryUsage().rss];
    collect?.();
    const wait = settleDelay(options.settleMs);
    if (wait > 0)
        await new Promise(resolve => setTimeout(resolve, wait));
    const retainedRssBytes = memoryUsage().rss;
    observations.push(retainedRssBytes);
    const cpu = process.cpuUsage(cpuStart);
    const peakRssBytes = Math.max(...observations, normalizeMaxRssBytes(resourceUsage().maxRSS, retainedRssBytes));
    return validatePhase7ResourceSample(Object.freeze({
        scenario,
        baselineRssBytes,
        retainedRssBytes,
        peakRssBytes,
        wallTimeMs: Math.max(0, Math.trunc(performance.now() - wallStart)),
        userCpuMicros: safeNonNegativeInteger(cpu.user, 'user CPU'),
        systemCpuMicros: safeNonNegativeInteger(cpu.system, 'system CPU'),
        operations: result.operations,
        artifactStoreRecords: result.artifactStoreRecords,
        artifactStoreBytes: result.artifactStoreBytes,
        outcome: PHASE_7_RESOURCE_OUTCOMES[scenario]
    }), scenario);
}
export async function runPhase7ResourceScenario(scenario, options = {}) {
    if (!PHASE_7_RESOURCE_SCENARIOS.includes(scenario)) {
        throw new TypeError(`unknown Phase 7 resource scenario: ${String(scenario)}`);
    }
    if (scenario === 'idle' || scenario === 'dual' || scenario === 'crashRecovery') {
        const phase6Scenario = scenario === 'idle'
            ? 'idle'
            : scenario === 'dual'
                ? 'dualTextRun'
                : 'checkpointResume';
        const base = await runPhase6ResourceScenario(phase6Scenario, options);
        return validatePhase7ResourceSample(Object.freeze({
            scenario,
            baselineRssBytes: base.baselineRssBytes,
            retainedRssBytes: base.retainedRssBytes,
            peakRssBytes: base.peakRssBytes,
            wallTimeMs: base.wallTimeMs,
            userCpuMicros: base.userCpuMicros,
            systemCpuMicros: base.systemCpuMicros,
            operations: scenario === 'idle' ? 0 : 2,
            artifactStoreRecords: 0,
            artifactStoreBytes: 0,
            outcome: PHASE_7_RESOURCE_OUTCOMES[scenario]
        }), scenario);
    }
    if (scenario === 'cacheUsage') {
        return await measuredWorkload(scenario, cacheUsageWorkload, options);
    }
    if (scenario === 'plannerCompaction') {
        return await measuredWorkload(scenario, plannerCompactionWorkload, options);
    }
    if (scenario === 'artifactRedis') {
        return await measuredWorkload(scenario, artifactRedisWorkload, options);
    }
    throw new TypeError(`unknown Phase 7 resource scenario: ${String(scenario)}`);
}
export async function main() {
    const scenario = process.argv[2];
    const sample = await runPhase7ResourceScenario(scenario);
    process.stdout.write(JSON.stringify(sample));
}
