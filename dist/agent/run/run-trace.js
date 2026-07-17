import { isAgentErrorCode } from '../contracts/error.js';
import { parseAgentEvent, parseProviderAttemptEventPayload, parseToolAttemptEventPayload } from '../contracts/event.js';
import { parseRunCheckpoint } from './run-checkpoint.js';
import { DURATION_BUCKET_BOUNDS_MS, parseFrozenObservationPolicy, parseRunTerminalSnapshot, parseRunTraceMetricSummary } from './run-observation.js';
import { RUN_REF_PATTERN } from './run-reference.js';
export const MAX_TRACE_RECORD_BYTES = 32 * 1_024;
const TRACE_TTL_MS = 24 * 60 * 60 * 1_000;
const OBSERVATION_ID_PATTERN = /^[0-9a-f]{64}$/;
const OPTIONAL_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const PROVIDER_OUTCOMES = new Set([
    'succeeded', 'failed', 'cancelled', 'unknown'
]);
const ATTEMPT_KINDS = new Set([
    'primary', 'retry', 'recovery', 'correction'
]);
const TOOL_OUTCOMES = new Set([
    'succeeded', 'failed', 'denied', 'indeterminate'
]);
const APPROVAL_DECISIONS = new Set([
    'requested', 'approved', 'denied', 'expired'
]);
const RUN_STATES = new Set([
    'created', 'paused', 'resumed', 'completed', 'failed', 'cancelled'
]);
const KNOWN_TRACE_EVENT_TYPES = new Set([
    'provider_request', 'tool_execution', 'approval', 'run_state', 'trace_truncated'
]);
function isUnknownOptionalTraceEvent(event) {
    return Object.hasOwn(event, 'optional');
}
export function internalExactTraceData(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    let ownKeys;
    try {
        ownKeys = Reflect.ownKeys(value);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (ownKeys.length !== keys.length || ownKeys.some(key => (typeof key !== 'string' || !keys.includes(key)))) {
        throw new TypeError(`${label} keys are invalid`);
    }
    return Object.fromEntries(keys.map(key => {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} field is invalid`);
        }
        return [key, descriptor.value];
    }));
}
export function internalExactTraceArray(value, maximum, label) {
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
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) {
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
function timestamp(value, label) {
    if (typeof value !== 'string' || value.length > 64) {
        throw new TypeError(`${label} is invalid`);
    }
    try {
        if (new Date(value).toISOString() !== value)
            throw new TypeError(`${label} is invalid`);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function traceDuration(value) {
    return value === null ? null : nonNegativeInteger(value, 'trace duration');
}
function parseProviderTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'sequence', 'occurredAt', 'durationMs', 'outcome', 'attemptKind', 'errorCode'
    ], 'provider trace event');
    if (input.type !== 'provider_request' || typeof input.outcome !== 'string' ||
        !PROVIDER_OUTCOMES.has(input.outcome) ||
        typeof input.attemptKind !== 'string' ||
        !ATTEMPT_KINDS.has(input.attemptKind) ||
        (input.errorCode !== null && !isAgentErrorCode(input.errorCode))) {
        throw new TypeError('provider trace event fields are invalid');
    }
    const outcome = input.outcome;
    if ((outcome === 'succeeded' && input.errorCode !== null) ||
        (outcome !== 'succeeded' && input.errorCode === null)) {
        throw new TypeError('provider trace event outcome is invalid');
    }
    return Object.freeze({
        type: 'provider_request',
        sequence: nonNegativeInteger(input.sequence, 'trace sequence'),
        occurredAt: timestamp(input.occurredAt, 'trace timestamp'),
        durationMs: traceDuration(input.durationMs),
        outcome,
        attemptKind: input.attemptKind,
        errorCode: input.errorCode
    });
}
function parseToolTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'sequence', 'occurredAt', 'durationMs', 'outcome', 'resultCode'
    ], 'tool trace event');
    if (input.type !== 'tool_execution' || typeof input.outcome !== 'string' ||
        !TOOL_OUTCOMES.has(input.outcome)) {
        throw new TypeError('tool trace event fields are invalid');
    }
    const durationMs = traceDuration(input.durationMs);
    const parsed = parseToolAttemptEventPayload({
        observationSchemaVersion: 1,
        ordinal: 1,
        outcome: input.outcome,
        durationMs: durationMs ?? 0,
        resultCode: input.resultCode
    });
    return Object.freeze({
        type: 'tool_execution',
        sequence: nonNegativeInteger(input.sequence, 'trace sequence'),
        occurredAt: timestamp(input.occurredAt, 'trace timestamp'),
        durationMs,
        outcome: parsed.outcome,
        resultCode: parsed.resultCode
    });
}
function parseApprovalTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'sequence', 'occurredAt', 'durationMs', 'decision'
    ], 'approval trace event');
    if (input.type !== 'approval' || typeof input.decision !== 'string' ||
        !APPROVAL_DECISIONS.has(input.decision)) {
        throw new TypeError('approval trace event fields are invalid');
    }
    return Object.freeze({
        type: 'approval',
        sequence: nonNegativeInteger(input.sequence, 'trace sequence'),
        occurredAt: timestamp(input.occurredAt, 'trace timestamp'),
        durationMs: traceDuration(input.durationMs),
        decision: input.decision
    });
}
function parseRunStateTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'sequence', 'occurredAt', 'durationMs', 'state', 'errorCode'
    ], 'run state trace event');
    if (input.type !== 'run_state' || typeof input.state !== 'string' ||
        !RUN_STATES.has(input.state) ||
        (input.errorCode !== null && !isAgentErrorCode(input.errorCode))) {
        throw new TypeError('run state trace event fields are invalid');
    }
    const state = input.state;
    if ((state === 'failed' && input.errorCode === null) ||
        (state !== 'failed' && input.errorCode !== null)) {
        throw new TypeError('run state trace error is invalid');
    }
    return Object.freeze({
        type: 'run_state',
        sequence: nonNegativeInteger(input.sequence, 'trace sequence'),
        occurredAt: timestamp(input.occurredAt, 'trace timestamp'),
        durationMs: traceDuration(input.durationMs),
        state,
        errorCode: input.errorCode
    });
}
function parseTruncatedTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'sequence', 'omittedCount'
    ], 'trace truncated event');
    if (input.type !== 'trace_truncated') {
        throw new TypeError('trace truncated event fields are invalid');
    }
    const omittedCount = nonNegativeInteger(input.omittedCount, 'trace omitted count');
    if (omittedCount === 0)
        throw new TypeError('trace omitted count is invalid');
    return Object.freeze({
        type: 'trace_truncated',
        sequence: nonNegativeInteger(input.sequence, 'trace sequence'),
        omittedCount
    });
}
function parseUnknownOptionalTraceEvent(value) {
    const input = internalExactTraceData(value, [
        'type', 'optional', 'sequence'
    ], 'optional trace event');
    if (typeof input.type !== 'string' || !OPTIONAL_EVENT_TYPE_PATTERN.test(input.type) ||
        KNOWN_TRACE_EVENT_TYPES.has(input.type) || input.optional !== true) {
        throw new TypeError('optional trace event fields are invalid');
    }
    return Object.freeze({
        type: input.type,
        optional: true,
        sequence: nonNegativeInteger(input.sequence, 'trace sequence')
    });
}
export function internalParseTraceEvent(value, allowUnknownOptional) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('trace event is invalid');
    }
    let descriptor;
    try {
        descriptor = Object.getOwnPropertyDescriptor(value, 'type');
    }
    catch {
        throw new TypeError('trace event is invalid');
    }
    if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('trace event type is invalid');
    }
    switch (descriptor.value) {
        case 'provider_request': return parseProviderTraceEvent(value);
        case 'tool_execution': return parseToolTraceEvent(value);
        case 'approval': return parseApprovalTraceEvent(value);
        case 'run_state': return parseRunStateTraceEvent(value);
        case 'trace_truncated': return parseTruncatedTraceEvent(value);
        default:
            if (allowUnknownOptional)
                return parseUnknownOptionalTraceEvent(value);
            throw new TypeError('trace event type is invalid');
    }
}
function terminalState(snapshot) {
    return snapshot.status;
}
export function internalValidateTraceEvents(events, omittedEventCount, terminal) {
    if (events.length < 2)
        throw new TypeError('trace events are incomplete');
    let previous = -1;
    let marker = null;
    const source = [];
    for (const event of events) {
        if (event.sequence <= previous)
            throw new TypeError('trace event order is invalid');
        previous = event.sequence;
        if (!isUnknownOptionalTraceEvent(event) && event.type === 'trace_truncated') {
            if (marker !== null)
                throw new TypeError('trace marker is duplicated');
            marker = event;
        }
        else {
            source.push(event);
        }
    }
    if (source[0] === undefined || isUnknownOptionalTraceEvent(source[0]) ||
        source[0].type !== 'run_state' || source[0].state !== 'created' ||
        source[0].sequence !== 0) {
        throw new TypeError('trace created event is invalid');
    }
    const terminals = source.filter((event) => (!isUnknownOptionalTraceEvent(event) && event.type === 'run_state' &&
        (event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled')));
    const last = source.at(-1);
    if (terminals.length !== 1 || last !== terminals[0] ||
        terminals[0]?.state !== terminalState(terminal)) {
        throw new TypeError('trace terminal event is invalid');
    }
    if (marker !== null && marker.sequence >= terminals[0].sequence) {
        throw new TypeError('trace marker position is invalid');
    }
    if (omittedEventCount === 0) {
        if (marker !== null)
            throw new TypeError('trace marker is unexpected');
    }
    else if (marker === null || marker.omittedCount !== omittedEventCount) {
        throw new TypeError('trace marker count is invalid');
    }
}
function isRequiredTraceEvent(event, index, lastIndex) {
    if (index === 0 || index === lastIndex)
        return true;
    if (isUnknownOptionalTraceEvent(event))
        return false;
    if (event.type === 'provider_request')
        return event.outcome !== 'succeeded';
    if (event.type === 'tool_execution')
        return event.outcome !== 'succeeded';
    if (event.type === 'approval') {
        return event.decision === 'denied' || event.decision === 'expired';
    }
    if (event.type === 'run_state') {
        return event.state === 'failed' || event.state === 'cancelled';
    }
    return false;
}
export function internalFinalizeSerialized(build) {
    let serializedBytes = 0;
    for (let index = 0; index < 16; index += 1) {
        const current = build(serializedBytes);
        const next = Buffer.byteLength(JSON.stringify(current), 'utf8');
        if (next === serializedBytes)
            return current;
        serializedBytes = next;
    }
    throw new TypeError('trace serialized byte fixed point is invalid');
}
export function internalSelectTraceEvents(input) {
    const existingOmittedCount = nonNegativeInteger(input.existingOmittedCount, 'existing trace omitted count');
    if (input.events.length < 2)
        throw new TypeError('trace source events are incomplete');
    for (let index = 1; index < input.events.length; index += 1) {
        if ((input.events[index - 1]?.sequence ?? -1) >= (input.events[index]?.sequence ?? -1)) {
            throw new TypeError('trace source event order is invalid');
        }
    }
    const compose = (selected) => {
        const retained = input.events.filter((_event, index) => selected.has(index));
        const omitted = input.events.filter((_event, index) => !selected.has(index));
        const omittedEventCount = existingOmittedCount + omitted.length;
        let events = [...retained];
        if (omittedEventCount > 0) {
            const markerSequence = Math.min(input.existingMarkerSequence ?? Number.POSITIVE_INFINITY, ...omitted.map(event => event.sequence));
            if (!Number.isSafeInteger(markerSequence) || markerSequence < 0) {
                throw new TypeError('trace marker sequence is invalid');
            }
            events.push(Object.freeze({
                type: 'trace_truncated',
                sequence: markerSequence,
                omittedCount: omittedEventCount
            }));
            events = events.sort((left, right) => left.sequence - right.sequence);
        }
        return Object.freeze({
            events: Object.freeze(events),
            omittedEventCount
        });
    };
    const all = new Set(input.events.map((_event, index) => index));
    const full = compose(all);
    if (input.build(full.events, full.omittedEventCount).serializedBytes <= MAX_TRACE_RECORD_BYTES) {
        return full;
    }
    const selected = new Set();
    const lastIndex = input.events.length - 1;
    input.events.forEach((event, index) => {
        if (isRequiredTraceEvent(event, index, lastIndex))
            selected.add(index);
    });
    let current = compose(selected);
    if (input.build(current.events, current.omittedEventCount).serializedBytes > MAX_TRACE_RECORD_BYTES) {
        throw new TypeError('trace required core exceeds capacity');
    }
    const optional = input.events.map((_event, index) => index)
        .filter(index => !selected.has(index))
        .reverse();
    for (const index of optional) {
        const tentative = new Set(selected);
        tentative.add(index);
        const next = compose(tentative);
        if (input.build(next.events, next.omittedEventCount).serializedBytes > MAX_TRACE_RECORD_BYTES) {
            break;
        }
        selected.add(index);
        current = next;
    }
    return current;
}
function projectRunState(event, snapshot) {
    const state = event.type === 'run.created'
        ? 'created'
        : event.type === 'run.paused'
            ? 'paused'
            : event.type === 'run.resumed'
                ? 'resumed'
                : event.type === 'run.completed'
                    ? 'completed'
                    : event.type === 'run.failed'
                        ? 'failed'
                        : event.type === 'run.cancelled'
                            ? 'cancelled'
                            : null;
    if (state === null)
        return null;
    return Object.freeze({
        type: 'run_state',
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        durationMs: null,
        state,
        errorCode: state === 'failed' ? snapshot.errorCode : null
    });
}
function projectAgentEvent(event, snapshot) {
    const runState = projectRunState(event, snapshot);
    if (runState !== null)
        return runState;
    if (event.type === 'model.attempted') {
        const payload = parseProviderAttemptEventPayload(event.payload);
        return Object.freeze({
            type: 'provider_request',
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            durationMs: payload.durationMs,
            outcome: payload.outcome,
            attemptKind: payload.attemptKind,
            errorCode: payload.errorCode
        });
    }
    if (event.type === 'tool.attempted') {
        const payload = parseToolAttemptEventPayload(event.payload);
        return Object.freeze({
            type: 'tool_execution',
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            durationMs: payload.durationMs,
            outcome: payload.outcome,
            resultCode: payload.resultCode
        });
    }
    if (event.type === 'approval.requested') {
        return Object.freeze({
            type: 'approval',
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            durationMs: null,
            decision: 'requested'
        });
    }
    if (event.type === 'approval.expired' || event.type === 'approval.decided') {
        const rawDecision = event.type === 'approval.expired'
            ? 'expired'
            : event.payload.decision;
        const decision = rawDecision === 'approved'
            ? 'approved'
            : rawDecision === 'rejected'
                ? 'denied'
                : rawDecision === 'expired'
                    ? 'expired'
                    : null;
        if (decision === null)
            throw new TypeError('approval trace decision is invalid');
        return Object.freeze({
            type: 'approval',
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            durationMs: null,
            decision
        });
    }
    return null;
}
function projectEvents(checkpoint, snapshot) {
    const projected = [];
    let previous = -1;
    checkpoint.events.forEach((rawEvent, index) => {
        const event = parseAgentEvent(rawEvent);
        if (event.sequence <= previous || (index === 0 && (event.sequence !== 0 || event.type !== 'run.created'))) {
            throw new TypeError('source event order is invalid');
        }
        previous = event.sequence;
        const safe = projectAgentEvent(event, snapshot);
        if (safe !== null)
            projected.push(safe);
    });
    internalValidateTraceEvents(projected, 0, snapshot);
    return Object.freeze(projected);
}
const DURATION_KEYS = Object.freeze([
    'le10', 'le25', 'le50', 'le100', 'le250', 'le500', 'le1000',
    'le2500', 'le5000', 'le10000', 'le30000', 'le60000', 'le120000', 'inf'
]);
function durationSummary(durations) {
    const measured = durations.filter((value) => value !== null);
    const counts = Object.fromEntries(DURATION_BUCKET_BOUNDS_MS.map((bound, index) => [
        DURATION_KEYS[index],
        bound === 'inf' ? measured.length : measured.filter(value => value <= bound).length
    ]));
    return Object.freeze({
        count: measured.length,
        sumMs: measured.reduce((total, value) => total + value, 0),
        unavailableCount: durations.length - measured.length,
        ...counts
    });
}
function metricSummary(events) {
    const providers = new Map();
    const tools = new Map();
    const approvals = new Map();
    for (const event of events) {
        if (event.type === 'provider_request') {
            const key = `${event.outcome}\0${event.attemptKind}`;
            const rows = providers.get(key) ?? [];
            rows.push(event);
            providers.set(key, rows);
        }
        else if (event.type === 'tool_execution') {
            const rows = tools.get(event.outcome) ?? [];
            rows.push(event);
            tools.set(event.outcome, rows);
        }
        else if (event.type === 'approval') {
            approvals.set(event.decision, (approvals.get(event.decision) ?? 0) + 1);
        }
    }
    return parseRunTraceMetricSummary({
        schemaVersion: 1,
        providerRequests: [...providers.values()].map(rows => ({
            outcome: rows[0]?.outcome,
            attemptKind: rows[0]?.attemptKind,
            count: rows.length,
            duration: durationSummary(rows.map(row => row.durationMs))
        })).sort((left, right) => {
            const leftKey = `${left.outcome}\0${left.attemptKind}`;
            const rightKey = `${right.outcome}\0${right.attemptKind}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
        toolExecutions: [...tools.entries()].map(([outcome, rows]) => ({
            outcome,
            count: rows.length,
            duration: durationSummary(rows.map(row => row.durationMs))
        })).sort((left, right) => (left.outcome < right.outcome ? -1 : left.outcome > right.outcome ? 1 : 0)),
        approvals: [...approvals.entries()].map(([decision, count]) => ({
            decision,
            count
        })).sort((left, right) => (left.decision < right.decision ? -1 : left.decision > right.decision ? 1 : 0))
    });
}
function traceExpiry(terminal) {
    return new Date(new Date(terminal.finishedAt).getTime() + TRACE_TTL_MS).toISOString();
}
function buildCandidate(input, serializedBytes) {
    return Object.freeze({
        schemaVersion: 1,
        runRef: input.runRef,
        observationId: input.observationId,
        terminal: input.terminal,
        policy: input.policy,
        metricSummary: input.metricSummary,
        events: Object.freeze([...input.events]),
        omittedEventCount: input.omittedEventCount,
        presentation: Object.freeze({ kind: 'unavailable' }),
        expiresAt: input.expiresAt,
        serializedBytes
    });
}
export function createTraceCandidate(input) {
    const checkpoint = parseRunCheckpoint(input.checkpoint);
    const terminal = parseRunTerminalSnapshot(input.snapshot);
    if (checkpoint.status !== terminal.status || checkpoint.runRef !== terminal.runRef ||
        checkpoint.revision !== terminal.revision) {
        throw new TypeError('trace terminal correlation is invalid');
    }
    const policy = parseFrozenObservationPolicy(checkpoint.observationPolicy);
    const sourceEvents = projectEvents(checkpoint, terminal);
    const summary = metricSummary(sourceEvents);
    const core = Object.freeze({
        runRef: terminal.runRef,
        observationId: terminal.observationId,
        terminal,
        policy,
        metricSummary: summary,
        expiresAt: traceExpiry(terminal)
    });
    const selected = internalSelectTraceEvents({
        events: sourceEvents,
        existingOmittedCount: 0,
        existingMarkerSequence: null,
        build: (events, omittedEventCount) => internalFinalizeSerialized(bytes => buildCandidate({
            ...core,
            events: events,
            omittedEventCount
        }, bytes))
    });
    const candidate = internalFinalizeSerialized(bytes => buildCandidate({
        ...core,
        events: selected.events,
        omittedEventCount: selected.omittedEventCount
    }, bytes));
    return parseTraceCandidate(candidate);
}
export function parseTraceCandidate(value) {
    const input = internalExactTraceData(value, [
        'schemaVersion', 'runRef', 'observationId', 'terminal', 'policy',
        'metricSummary', 'events', 'omittedEventCount', 'presentation',
        'expiresAt', 'serializedBytes'
    ], 'trace candidate');
    if (input.schemaVersion !== 1 || typeof input.runRef !== 'string' ||
        !RUN_REF_PATTERN.test(input.runRef) || typeof input.observationId !== 'string' ||
        !OBSERVATION_ID_PATTERN.test(input.observationId)) {
        throw new TypeError('trace candidate fields are invalid');
    }
    const terminal = parseRunTerminalSnapshot(input.terminal);
    if (input.runRef !== terminal.runRef || input.observationId !== terminal.observationId) {
        throw new TypeError('trace candidate correlation is invalid');
    }
    const policy = parseFrozenObservationPolicy(input.policy);
    const summary = parseRunTraceMetricSummary(input.metricSummary);
    const events = Object.freeze(internalExactTraceArray(input.events, 512, 'trace candidate events').map(event => internalParseTraceEvent(event, false)));
    const omittedEventCount = nonNegativeInteger(input.omittedEventCount, 'trace omitted count');
    internalValidateTraceEvents(events, omittedEventCount, terminal);
    const presentation = internalExactTraceData(input.presentation, ['kind'], 'trace candidate presentation');
    if (presentation.kind !== 'unavailable') {
        throw new TypeError('trace candidate presentation is invalid');
    }
    const expiresAt = timestamp(input.expiresAt, 'trace expiry');
    if (expiresAt !== traceExpiry(terminal))
        throw new TypeError('trace expiry is invalid');
    const serializedBytes = nonNegativeInteger(input.serializedBytes, 'trace serialized bytes');
    const canonical = internalFinalizeSerialized(bytes => buildCandidate({
        runRef: input.runRef,
        observationId: input.observationId,
        terminal,
        policy,
        metricSummary: summary,
        events,
        omittedEventCount,
        expiresAt
    }, bytes));
    if (serializedBytes !== canonical.serializedBytes ||
        canonical.serializedBytes > MAX_TRACE_RECORD_BYTES) {
        throw new TypeError('trace serialized bytes are invalid');
    }
    return canonical;
}
