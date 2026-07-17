import { AGENT_ERROR_CODES } from '../../agent/contracts/error.js';
import { DURATION_BUCKET_BOUNDS_MS, parseRunTerminalSnapshot, parseRunTraceMetricSummary } from '../../agent/run/run-observation.js';
import { parseObservationEvent } from './observation-event.js';
import { parseSafeSinkFailure } from './observation-hub.js';
export const METRIC_LABEL_NAMES_V1 = Object.freeze({
    'groupmate.agent.runs': Object.freeze(['outcome', 'completion_kind', 'error_code']),
    'groupmate.agent.duration': Object.freeze(['stage']),
    'groupmate.agent.provider_requests': Object.freeze(['outcome', 'attempt_kind']),
    'groupmate.agent.tokens': Object.freeze(['direction', 'source']),
    'groupmate.agent.tool_executions': Object.freeze(['outcome']),
    'groupmate.agent.tool_duration': Object.freeze(['outcome']),
    'groupmate.agent.approvals': Object.freeze(['decision']),
    'groupmate.agent.admission': Object.freeze(['state']),
    'groupmate.agent.admission_rejections': Object.freeze(['reason']),
    'groupmate.presentation.deliveries': Object.freeze(['media', 'outcome']),
    'groupmate.observation.failures': Object.freeze(['sink']),
    'groupmate.observation.store_records': Object.freeze(['kind']),
    'groupmate.observation.store_bytes': Object.freeze(['kind']),
    'groupmate.process.rss': Object.freeze([])
});
const SNAPSHOT_KEYS = Object.freeze([
    'schemaVersion', 'startedAt', 'counters', 'gauges', 'histograms'
]);
const COUNTER_POINT_KEYS = Object.freeze(['name', 'labels', 'value']);
const GAUGE_POINT_KEYS = Object.freeze(['name', 'labels', 'value']);
const HISTOGRAM_POINT_KEYS = Object.freeze([
    'name', 'labels', 'count', 'sumMs', 'unavailableCount', 'buckets'
]);
const LABEL_KEYS = Object.freeze(['name', 'value']);
const BUCKET_KEYS = Object.freeze(['upperBoundMs', 'cumulativeCount']);
const COUNTER_NAMES = new Set([
    'groupmate.agent.runs',
    'groupmate.agent.provider_requests',
    'groupmate.agent.tokens',
    'groupmate.agent.tool_executions',
    'groupmate.agent.approvals',
    'groupmate.agent.admission_rejections',
    'groupmate.presentation.deliveries',
    'groupmate.observation.failures'
]);
const GAUGE_NAMES = new Set([
    'groupmate.agent.admission',
    'groupmate.observation.store_records',
    'groupmate.observation.store_bytes',
    'groupmate.process.rss'
]);
const HISTOGRAM_NAMES = new Set([
    'groupmate.agent.duration',
    'groupmate.agent.tool_duration'
]);
const RUN_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const COMPLETION_KINDS = new Set(['reply_text', 'already_visible', 'allowed_silence', 'none']);
const PROVIDER_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const ATTEMPT_KINDS = new Set(['primary', 'retry', 'recovery', 'correction']);
const TOKEN_DIRECTIONS = new Set(['input', 'output', 'total']);
const TOKEN_SOURCES = new Set(['provider', 'estimated']);
const TOOL_OUTCOMES = new Set(['succeeded', 'failed', 'denied', 'indeterminate']);
const APPROVAL_DECISIONS = new Set(['requested', 'approved', 'denied', 'expired']);
const ADMISSION_STATES = new Set(['active', 'queued']);
const ADMISSION_REJECTIONS = new Set([
    'queue_full', 'queue_aborted', 'not_applicable', 'unavailable'
]);
const DELIVERY_MEDIA = new Set(['text', 'picture', 'voice', 'forward']);
const DELIVERY_OUTCOMES = new Set(['sent', 'failed_definite', 'outcome_unknown']);
const SINK_NAMES = new Set(['metrics', 'trace', 'log']);
const STORE_KINDS = new Set(['trace', 'tombstone']);
const DURATION_STAGES = new Set([
    'queue', 'session_load', 'session_save', 'request', 'engine', 'provider',
    'presentation'
]);
const OBSERVATION_LEVELS = new Set(['off', 'basic', 'diagnostic']);
const LRU_CAPACITY = 256;
function exactData(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const input = value;
    let actual;
    try {
        actual = Reflect.ownKeys(input);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (actual.length !== keys.length || actual.some(key => (typeof key !== 'string' || !keys.includes(key)))) {
        throw new TypeError(`${label} keys are invalid`);
    }
    const output = {};
    for (const key of keys) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(input, key);
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError(`${label} field is invalid`);
        }
        output[key] = descriptor.value;
    }
    return output;
}
function exactArray(value, maximum, label) {
    if (!Array.isArray(value))
        throw new TypeError(`${label} is invalid`);
    let keys;
    let lengthDescriptor;
    try {
        keys = Reflect.ownKeys(value);
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum ||
        keys.length !== Number(length) + 1 || !keys.includes('length')) {
        throw new TypeError(`${label} is invalid`);
    }
    return Object.freeze(Array.from({ length: Number(length) }, (_, index) => {
        const key = String(index);
        if (!keys.includes(key))
            throw new TypeError(`${label} is sparse`);
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError(`${label} item is invalid`);
        }
        return descriptor.value;
    }));
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
function parseGaugeValue(value, label) {
    if (value === 'unavailable')
        return value;
    if (value === 'not_attempted')
        throw new TypeError(`${label} is invalid`);
    return nonNegativeInteger(value, label);
}
function canonicalTimestamp(value, label) {
    if (typeof value !== 'string')
        throw new TypeError(`${label} is invalid`);
    try {
        if (new Date(value).toISOString() !== value)
            throw new TypeError(`${label} is invalid`);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function externalDomain(value, domain, label) {
    if (typeof value !== 'string')
        throw new TypeError(`${label} is invalid`);
    return domain.has(value) ? value : 'other';
}
function internalDomain(value, domain, label) {
    if (typeof value !== 'string' || !domain.has(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function parseLabelValue(instrument, name, value) {
    if (instrument === 'groupmate.agent.runs') {
        if (name === 'outcome')
            return externalDomain(value, RUN_OUTCOMES, 'run outcome');
        if (name === 'completion_kind') {
            return externalDomain(value, COMPLETION_KINDS, 'completion kind');
        }
        if (name === 'error_code') {
            return externalDomain(value, new Set([...AGENT_ERROR_CODES, 'none']), 'error code');
        }
    }
    if (instrument === 'groupmate.agent.duration' && name === 'stage') {
        return internalDomain(value, DURATION_STAGES, 'duration stage');
    }
    if (instrument === 'groupmate.agent.provider_requests') {
        if (name === 'outcome') {
            return externalDomain(value, PROVIDER_OUTCOMES, 'provider outcome');
        }
        if (name === 'attempt_kind') {
            return externalDomain(value, ATTEMPT_KINDS, 'provider attempt kind');
        }
    }
    if (instrument === 'groupmate.agent.tokens') {
        if (name === 'direction') {
            return internalDomain(value, TOKEN_DIRECTIONS, 'token direction');
        }
        if (name === 'source')
            return internalDomain(value, TOKEN_SOURCES, 'token source');
    }
    if ((instrument === 'groupmate.agent.tool_executions' ||
        instrument === 'groupmate.agent.tool_duration') && name === 'outcome') {
        return externalDomain(value, TOOL_OUTCOMES, 'tool outcome');
    }
    if (instrument === 'groupmate.agent.approvals' && name === 'decision') {
        return externalDomain(value, APPROVAL_DECISIONS, 'approval decision');
    }
    if (instrument === 'groupmate.agent.admission' && name === 'state') {
        return internalDomain(value, ADMISSION_STATES, 'admission state');
    }
    if (instrument === 'groupmate.agent.admission_rejections' && name === 'reason') {
        return externalDomain(value, ADMISSION_REJECTIONS, 'admission rejection');
    }
    if (instrument === 'groupmate.presentation.deliveries') {
        if (name === 'media')
            return externalDomain(value, DELIVERY_MEDIA, 'delivery media');
        if (name === 'outcome') {
            return externalDomain(value, DELIVERY_OUTCOMES, 'delivery outcome');
        }
    }
    if (instrument === 'groupmate.observation.failures' && name === 'sink') {
        return internalDomain(value, SINK_NAMES, 'observation sink');
    }
    if ((instrument === 'groupmate.observation.store_records' ||
        instrument === 'groupmate.observation.store_bytes') && name === 'kind') {
        return internalDomain(value, STORE_KINDS, 'observation store kind');
    }
    throw new TypeError('metric label combination is invalid');
}
function parseLabels(instrument, value) {
    const expected = METRIC_LABEL_NAMES_V1[instrument];
    const values = exactArray(value, expected.length, 'metric labels');
    if (values.length !== expected.length)
        throw new TypeError('metric label count is invalid');
    return Object.freeze(values.map((value, index) => {
        const label = exactData(value, LABEL_KEYS, 'metric label');
        const expectedName = expected[index];
        if (label.name !== expectedName)
            throw new TypeError('metric label order is invalid');
        return Object.freeze({
            name: expectedName,
            value: parseLabelValue(instrument, expectedName, label.value)
        });
    }));
}
function metricIdentity(point) {
    return `${point.name}\0${point.labels.map(label => `${label.name}\0${label.value}`).join('\0')}`;
}
function parseCounterPoint(value) {
    const input = exactData(value, COUNTER_POINT_KEYS, 'metric counter point');
    if (typeof input.name !== 'string' ||
        !COUNTER_NAMES.has(input.name)) {
        throw new TypeError('metric counter name is invalid');
    }
    const name = input.name;
    return Object.freeze({
        name,
        labels: parseLabels(name, input.labels),
        value: nonNegativeInteger(input.value, 'metric counter value')
    });
}
function parseGaugePoint(value) {
    const input = exactData(value, GAUGE_POINT_KEYS, 'metric gauge point');
    if (typeof input.name !== 'string' || !GAUGE_NAMES.has(input.name)) {
        throw new TypeError('metric gauge name is invalid');
    }
    const name = input.name;
    return Object.freeze({
        name,
        labels: parseLabels(name, input.labels),
        value: parseGaugeValue(input.value, 'metric gauge value')
    });
}
function parseHistogramPoint(value) {
    const input = exactData(value, HISTOGRAM_POINT_KEYS, 'metric histogram point');
    if (typeof input.name !== 'string' ||
        !HISTOGRAM_NAMES.has(input.name)) {
        throw new TypeError('metric histogram name is invalid');
    }
    const name = input.name;
    const count = nonNegativeInteger(input.count, 'metric histogram count');
    const sumMs = nonNegativeInteger(input.sumMs, 'metric histogram sum');
    const unavailableCount = nonNegativeInteger(input.unavailableCount, 'metric histogram unavailable count');
    if (count === 0 && sumMs !== 0) {
        throw new TypeError('metric histogram sum requires a measured sample');
    }
    let previous = 0;
    const buckets = Object.freeze(exactArray(input.buckets, DURATION_BUCKET_BOUNDS_MS.length, 'metric histogram buckets').map((value, index) => {
        const bucket = exactData(value, BUCKET_KEYS, 'metric histogram bucket');
        if (bucket.upperBoundMs !== DURATION_BUCKET_BOUNDS_MS[index]) {
            throw new TypeError('metric histogram bucket boundary is invalid');
        }
        const cumulativeCount = nonNegativeInteger(bucket.cumulativeCount, 'metric histogram bucket count');
        if (cumulativeCount < previous || cumulativeCount > count) {
            throw new TypeError('metric histogram buckets are invalid');
        }
        previous = cumulativeCount;
        return Object.freeze({
            upperBoundMs: DURATION_BUCKET_BOUNDS_MS[index],
            cumulativeCount
        });
    }));
    if (buckets.length !== DURATION_BUCKET_BOUNDS_MS.length || previous !== count) {
        throw new TypeError('metric histogram infinity bucket is invalid');
    }
    return Object.freeze({
        name,
        labels: parseLabels(name, input.labels),
        count,
        sumMs,
        unavailableCount,
        buckets
    });
}
function parsePointArray(value, maximum, label, parse) {
    const seen = new Set();
    return Object.freeze(exactArray(value, maximum, label).map(value => {
        const point = parse(value);
        const identity = metricIdentity(point);
        if (seen.has(identity))
            throw new TypeError(`${label} contains duplicate point`);
        seen.add(identity);
        return point;
    }));
}
export function parseMetricsSnapshot(value) {
    const input = exactData(value, SNAPSHOT_KEYS, 'metrics snapshot');
    if (input.schemaVersion !== 1)
        throw new TypeError('metrics snapshot schema is invalid');
    const counters = parsePointArray(input.counters, 512, 'metric counters', parseCounterPoint);
    const gauges = parsePointArray(input.gauges, 16, 'metric gauges', parseGaugePoint);
    const histograms = parsePointArray(input.histograms, 64, 'metric histograms', parseHistogramPoint);
    return Object.freeze({
        schemaVersion: 1,
        startedAt: canonicalTimestamp(input.startedAt, 'metrics start timestamp'),
        counters,
        gauges,
        histograms
    });
}
function labelsFor(name, values) {
    const names = METRIC_LABEL_NAMES_V1[name];
    if (names.length !== values.length)
        throw new TypeError('metric label count is invalid');
    return Object.freeze(names.map((labelName, index) => Object.freeze({
        name: labelName,
        value: values[index]
    })));
}
function checkedAdd(left, right, label) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new RangeError(`${label} exceeded safe integer range`);
    }
    return result;
}
function safeObservationCount(value) {
    if (value === 'unavailable')
        return value;
    return Number.isSafeInteger(value) && Number(value) >= 0
        ? Number(value)
        : 'unavailable';
}
class ObservationLru {
    #values = new Set();
    accept(identity) {
        if (this.#values.delete(identity)) {
            this.#values.add(identity);
            return false;
        }
        this.#values.add(identity);
        if (this.#values.size > LRU_CAPACITY) {
            const oldest = this.#values.values().next().value;
            if (oldest !== undefined)
                this.#values.delete(oldest);
        }
        return true;
    }
    clear() {
        this.#values.clear();
    }
}
export class MetricsRegistry {
    name = 'metrics';
    #admission;
    #runStoreUsage;
    #traceStoreUsage;
    #now;
    #rss;
    #counters = new Map();
    #histograms = new Map();
    #requestIds = new ObservationLru();
    #terminalSnapshotIds = new ObservationLru();
    #terminalCommitIds = new ObservationLru();
    #presentationIds = new ObservationLru();
    #candidateIds = new ObservationLru();
    #currentLevel = 'basic';
    #generation = 0;
    #startedAt;
    constructor(options) {
        if (options.admission === null || typeof options.admission !== 'object' ||
            typeof options.runStoreUsage !== 'function' ||
            typeof options.traceStoreUsage !== 'function') {
            throw new TypeError('metrics registry sources are invalid');
        }
        this.#admission = options.admission;
        this.#runStoreUsage = options.runStoreUsage;
        this.#traceStoreUsage = options.traceStoreUsage;
        this.#now = options.now ?? (() => new Date());
        this.#rss = options.rss ?? (() => process.memoryUsage().rss);
        this.#startedAt = this.#safeNow();
    }
    observeCommittedTraceCandidate(candidate) {
        if (this.#currentLevel === 'off')
            return;
        if (candidate === null || typeof candidate !== 'object') {
            throw new TypeError('trace candidate is invalid');
        }
        const terminal = parseRunTerminalSnapshot(candidate.terminal);
        if (candidate.runRef !== terminal.runRef ||
            candidate.observationId !== terminal.observationId)
            return;
        const summary = parseRunTraceMetricSummary(candidate.metricSummary);
        if (!this.#candidateIds.accept(candidate.observationId))
            return;
        this.#observeMetricSummary(summary);
    }
    observe(value) {
        if (this.#currentLevel === 'off')
            return;
        const event = parseObservationEvent(value);
        if (event.type === 'request') {
            if (!this.#requestIds.accept(event.value.requestRef))
                return;
            if (event.value.admissionRejectionReason !== 'not_applicable') {
                this.#addCounter('groupmate.agent.admission_rejections', [
                    event.value.admissionRejectionReason
                ], 1);
            }
            this.#recordDuration('groupmate.agent.duration', ['queue'], event.value.queueDurationMs);
            this.#recordDuration('groupmate.agent.duration', ['session_load'], event.value.sessionLoadDurationMs);
            this.#recordDuration('groupmate.agent.duration', ['session_save'], event.value.sessionSaveDurationMs);
            this.#recordDuration('groupmate.agent.duration', ['request'], event.value.requestDurationMs);
            return;
        }
        if (event.type === 'terminal_snapshot') {
            if (!this.#terminalSnapshotIds.accept(event.value.observationId))
                return;
            const completionKind = event.value.completion.kind;
            this.#addCounter('groupmate.agent.runs', [
                event.value.status,
                completionKind,
                event.value.errorCode ?? 'none'
            ], 1);
            this.#recordDuration('groupmate.agent.duration', ['engine'], event.value.engineDurationMs);
            this.#recordToken('input', 'provider', event.value.counters.providerInputTokens);
            this.#recordToken('output', 'provider', event.value.counters.providerOutputTokens);
            this.#recordToken('total', 'provider', event.value.counters.providerTotalTokens);
            this.#recordToken('total', 'estimated', event.value.counters.estimatedTokens);
            return;
        }
        if (event.type === 'terminal_commit') {
            this.#terminalCommitIds.accept(event.value.observationId);
            return;
        }
        if (!this.#presentationIds.accept(event.value.presentationObservationId))
            return;
        for (const delivery of event.value.deliveries) {
            this.#addCounter('groupmate.presentation.deliveries', [
                delivery.media,
                delivery.outcome
            ], 1);
        }
        this.#recordDuration('groupmate.agent.duration', ['presentation'], event.value.totalDurationMs);
    }
    recordSinkFailure(value) {
        if (this.#currentLevel === 'off')
            return;
        const failure = parseSafeSinkFailure(value);
        this.#addCounter('groupmate.observation.failures', [failure.sink], 1);
    }
    setCurrentLevel(level) {
        if (typeof level !== 'string' || !OBSERVATION_LEVELS.has(level)) {
            throw new TypeError('metrics observation level is invalid');
        }
        if (level === 'off' && this.#currentLevel !== 'off')
            this.#clearFacts();
        this.#currentLevel = level;
    }
    async snapshot() {
        const generation = this.#generation;
        const startedEnabled = this.#currentLevel !== 'off';
        const gauges = [
            this.#gauge('groupmate.agent.admission', ['active'], this.#admissionValue('activeCount')),
            this.#gauge('groupmate.agent.admission', ['queued'], this.#admissionValue('queuedCount'))
        ];
        if (startedEnabled) {
            const [trace, tombstone] = await Promise.all([
                this.#readTraceUsage(),
                this.#readRunUsage()
            ]);
            if (generation === this.#generation && this.#currentLevel !== 'off') {
                gauges.push(this.#gauge('groupmate.observation.store_records', ['trace'], trace.records), this.#gauge('groupmate.observation.store_records', ['tombstone'], tombstone.tombstoneRecords), this.#gauge('groupmate.observation.store_bytes', ['trace'], trace.bytes), this.#gauge('groupmate.observation.store_bytes', ['tombstone'], tombstone.tombstoneBytes));
            }
        }
        gauges.push(this.#gauge('groupmate.process.rss', [], this.#rssValue()));
        const includeFacts = startedEnabled && generation === this.#generation &&
            this.#currentLevel !== 'off';
        return parseMetricsSnapshot({
            schemaVersion: 1,
            startedAt: this.#startedAt,
            counters: includeFacts
                ? [...this.#counters.values()].map(point => ({
                    name: point.name,
                    labels: point.labels,
                    value: point.value
                }))
                : [],
            gauges,
            histograms: includeFacts
                ? [...this.#histograms.values()].map(point => ({
                    name: point.name,
                    labels: point.labels,
                    count: point.count,
                    sumMs: point.sumMs,
                    unavailableCount: point.unavailableCount,
                    buckets: DURATION_BUCKET_BOUNDS_MS.map((upperBoundMs, index) => ({
                        upperBoundMs,
                        cumulativeCount: point.buckets[index]
                    }))
                }))
                : []
        });
    }
    reset() {
        this.#clearFacts();
    }
    #observeMetricSummary(summary) {
        for (const row of summary.providerRequests) {
            this.#addCounter('groupmate.agent.provider_requests', [
                row.outcome,
                row.attemptKind
            ], row.count);
            this.#addDurationSummary('groupmate.agent.duration', ['provider'], row.duration);
        }
        for (const row of summary.toolExecutions) {
            this.#addCounter('groupmate.agent.tool_executions', [row.outcome], row.count);
            this.#addDurationSummary('groupmate.agent.tool_duration', [row.outcome], row.duration);
        }
        for (const row of summary.approvals) {
            this.#addCounter('groupmate.agent.approvals', [row.decision], row.count);
        }
    }
    #addCounter(name, values, amount) {
        const labels = labelsFor(name, values);
        const identity = metricIdentity({ name, labels });
        const current = this.#counters.get(identity);
        if (current === undefined) {
            this.#counters.set(identity, {
                name,
                labels,
                value: nonNegativeInteger(amount, 'metric counter increment')
            });
            return;
        }
        current.value = checkedAdd(current.value, amount, 'metric counter');
    }
    #histogram(name, values) {
        const labels = labelsFor(name, values);
        const identity = metricIdentity({ name, labels });
        const current = this.#histograms.get(identity);
        if (current !== undefined)
            return current;
        const created = {
            name,
            labels,
            count: 0,
            sumMs: 0,
            unavailableCount: 0,
            buckets: Array(DURATION_BUCKET_BOUNDS_MS.length).fill(0)
        };
        this.#histograms.set(identity, created);
        return created;
    }
    #recordDuration(name, values, value) {
        if (value === 'not_attempted')
            return;
        const point = this.#histogram(name, values);
        if (value === 'unavailable') {
            point.unavailableCount = checkedAdd(point.unavailableCount, 1, 'metric duration unavailable count');
            return;
        }
        const duration = nonNegativeInteger(value, 'metric duration');
        point.count = checkedAdd(point.count, 1, 'metric duration count');
        point.sumMs = checkedAdd(point.sumMs, duration, 'metric duration sum');
        DURATION_BUCKET_BOUNDS_MS.forEach((bound, index) => {
            if (bound === 'inf' || duration <= bound) {
                point.buckets[index] = checkedAdd(point.buckets[index] ?? 0, 1, 'metric duration bucket');
            }
        });
    }
    #addDurationSummary(name, values, duration) {
        const point = this.#histogram(name, values);
        point.count = checkedAdd(point.count, duration.count, 'metric duration count');
        point.sumMs = checkedAdd(point.sumMs, duration.sumMs, 'metric duration sum');
        point.unavailableCount = checkedAdd(point.unavailableCount, duration.unavailableCount, 'metric duration unavailable count');
        const counts = [
            duration.le10,
            duration.le25,
            duration.le50,
            duration.le100,
            duration.le250,
            duration.le500,
            duration.le1000,
            duration.le2500,
            duration.le5000,
            duration.le10000,
            duration.le30000,
            duration.le60000,
            duration.le120000,
            duration.inf
        ];
        counts.forEach((count, index) => {
            point.buckets[index] = checkedAdd(point.buckets[index] ?? 0, count, 'metric duration bucket');
        });
    }
    #recordToken(direction, source, value) {
        if (typeof value === 'number') {
            this.#addCounter('groupmate.agent.tokens', [direction, source], value);
        }
    }
    #gauge(name, values, value) {
        return Object.freeze({ name, labels: labelsFor(name, values), value });
    }
    #admissionValue(key) {
        try {
            return safeObservationCount(this.#admission[key]);
        }
        catch {
            return 'unavailable';
        }
    }
    #rssValue() {
        try {
            return safeObservationCount(this.#rss());
        }
        catch {
            return 'unavailable';
        }
    }
    async #readRunUsage() {
        try {
            const value = await this.#runStoreUsage();
            if (value.schemaVersion !== 1)
                throw new TypeError('run store usage is invalid');
            return Object.freeze({
                schemaVersion: 1,
                tombstoneRecords: safeObservationCount(value.tombstoneRecords),
                tombstoneBytes: safeObservationCount(value.tombstoneBytes)
            });
        }
        catch {
            return Object.freeze({
                schemaVersion: 1,
                tombstoneRecords: 'unavailable',
                tombstoneBytes: 'unavailable'
            });
        }
    }
    async #readTraceUsage() {
        try {
            const value = await this.#traceStoreUsage();
            return Object.freeze({
                records: safeObservationCount(value.records),
                bytes: safeObservationCount(value.bytes)
            });
        }
        catch {
            return Object.freeze({ records: 'unavailable', bytes: 'unavailable' });
        }
    }
    #clearFacts() {
        this.#generation += 1;
        this.#counters.clear();
        this.#histograms.clear();
        this.#requestIds.clear();
        this.#terminalSnapshotIds.clear();
        this.#terminalCommitIds.clear();
        this.#presentationIds.clear();
        this.#candidateIds.clear();
        this.#startedAt = this.#safeNow();
    }
    #safeNow() {
        try {
            return this.#now().toISOString();
        }
        catch {
            return new Date(0).toISOString();
        }
    }
}
