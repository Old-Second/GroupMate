import { RUN_REF_PATTERN } from '../agent/run/run-reference.js';
const OBSERVATION_KEYS = Object.freeze([
    'schemaVersion',
    'runRef',
    'requestRef',
    'requestKind',
    'outcome',
    'admissionRejectionReason',
    'queueDurationMs',
    'sessionLoadDurationMs',
    'sessionSaveDurationMs',
    'requestDurationMs',
    'terminalObservationId'
]);
const CONTEXT_KEYS = Object.freeze([
    'schemaVersion', 'requestRef', 'requestKind', 'startedAtMonotonicMs'
]);
const ACTIVE_CONTEXT_KEYS = Object.freeze([
    ...CONTEXT_KEYS, 'runRef', 'queueDurationMs', 'sessionLoadDurationMs'
]);
const REQUEST_KINDS = new Set([
    'ordinary_chat', 'proactive_chat', 'legacy_unknown'
]);
const OUTCOMES = new Set([
    'rejected_admission',
    'failed_request_validation',
    'failed_session_load',
    'failed_run_create',
    'completed',
    'failed_session_save'
]);
const REJECTION_REASONS = new Set([
    'queue_full', 'queue_aborted', 'not_applicable', 'unavailable'
]);
const OBSERVATION_ID = /^[0-9a-f]{64}$/;
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function exactKeys(value, keys, label) {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => (typeof key !== 'string' || !keys.includes(key))) || keys.some(key => !Object.hasOwn(value, key))) {
        throw new TypeError(`${label} keys are invalid`);
    }
}
function reference(value, label) {
    if (typeof value !== 'string' || !RUN_REF_PATTERN.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function requestKind(value) {
    if (typeof value !== 'string' || !REQUEST_KINDS.has(value)) {
        throw new TypeError('request observation kind is invalid');
    }
    return value;
}
function monotonicPoint(value) {
    if (value === 'unavailable')
        return value;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError('request observation monotonic point is invalid');
    }
    return Number(value);
}
function count(value) {
    if (value === 'unavailable' || value === 'not_attempted')
        return value;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError('request observation duration is invalid');
    }
    return Number(value);
}
function entered(value) {
    return value === 'unavailable' || typeof value === 'number';
}
function notAttempted(value) {
    return value === 'not_attempted';
}
function parseContext(value, active) {
    const input = record(value, active ? 'active request observation context' : 'request observation context');
    exactKeys(input, active ? ACTIVE_CONTEXT_KEYS : CONTEXT_KEYS, 'request observation context');
    if (input.schemaVersion !== 1) {
        throw new TypeError('request observation context schema is invalid');
    }
    const base = {
        schemaVersion: 1,
        requestRef: reference(input.requestRef, 'request reference'),
        requestKind: requestKind(input.requestKind),
        startedAtMonotonicMs: monotonicPoint(input.startedAtMonotonicMs)
    };
    if (!active)
        return Object.freeze(base);
    const queueDurationMs = count(input.queueDurationMs);
    const sessionLoadDurationMs = count(input.sessionLoadDurationMs);
    if ((base.requestKind === 'ordinary_chat' &&
        (!entered(queueDurationMs) || !entered(sessionLoadDurationMs))) ||
        (base.requestKind === 'proactive_chat' &&
            (!entered(queueDurationMs) || !notAttempted(sessionLoadDurationMs))) ||
        (base.requestKind === 'legacy_unknown' &&
            (queueDurationMs !== 'unavailable' || sessionLoadDurationMs !== 'unavailable'))) {
        throw new TypeError('active request observation stage matrix is invalid');
    }
    return Object.freeze({
        ...base,
        runRef: reference(input.runRef, 'run reference'),
        queueDurationMs,
        sessionLoadDurationMs
    });
}
function validateStageMatrix(observation) {
    const { outcome, requestKind: kind, queueDurationMs: queue, sessionLoadDurationMs: load, sessionSaveDurationMs: save, requestDurationMs: request, admissionRejectionReason: reason, runRef, terminalObservationId: terminalId } = observation;
    const trusted = kind === 'ordinary_chat' || kind === 'proactive_chat';
    const preCreate = outcome === 'rejected_admission' ||
        outcome === 'failed_request_validation' || outcome === 'failed_session_load' ||
        outcome === 'failed_run_create';
    if (preCreate) {
        if (runRef !== 'unavailable' || terminalId !== 'not_attempted') {
            throw new TypeError('pre-create request observation identity is invalid');
        }
    }
    else if (runRef === 'unavailable' || terminalId === 'not_attempted') {
        throw new TypeError('created request observation identity is invalid');
    }
    if (terminalId !== 'unavailable' && terminalId !== 'not_attempted' &&
        (typeof terminalId !== 'string' || !OBSERVATION_ID.test(terminalId))) {
        throw new TypeError('terminal observation reference is invalid');
    }
    if (outcome === 'failed_session_save' && terminalId === 'unavailable') {
        throw new TypeError('failed session save terminal identity is invalid');
    }
    if (outcome === 'rejected_admission') {
        if (reason !== 'queue_full' && reason !== 'queue_aborted' && reason !== 'unavailable') {
            throw new TypeError('admission rejection reason is invalid');
        }
    }
    else if (reason !== 'not_applicable') {
        throw new TypeError('request observation rejection reason is invalid');
    }
    if (request === 'not_attempted') {
        throw new TypeError('request duration cannot be not attempted');
    }
    const valid = outcome === 'failed_request_validation'
        ? trusted && notAttempted(queue) && notAttempted(load) && notAttempted(save)
        : outcome === 'rejected_admission'
            ? trusted && entered(queue) && notAttempted(load) && notAttempted(save)
            : outcome === 'failed_session_load'
                ? kind === 'ordinary_chat' && entered(queue) && entered(load) && notAttempted(save)
                : outcome === 'failed_run_create'
                    ? kind === 'ordinary_chat'
                        ? entered(queue) && entered(load) && notAttempted(save)
                        : kind === 'proactive_chat' && entered(queue) && notAttempted(load) && notAttempted(save)
                    : outcome === 'failed_session_save'
                        ? kind === 'ordinary_chat' && entered(queue) && entered(load) && entered(save)
                        : kind === 'ordinary_chat'
                            ? entered(queue) && entered(load) &&
                                (entered(save) || notAttempted(save))
                            : kind === 'proactive_chat'
                                ? entered(queue) && notAttempted(load) && notAttempted(save)
                                : queue === 'unavailable' && load === 'unavailable' &&
                                    notAttempted(save) && request === 'unavailable';
    if (!valid)
        throw new TypeError('request observation stage matrix is invalid');
}
export function beginRequestObservation(input) {
    return parseContext({ schemaVersion: 1, ...input }, false);
}
export function activateRequestObservation(input) {
    const context = parseContext(input.context, false);
    return parseContext({
        ...context,
        runRef: input.runRef,
        queueDurationMs: input.queueDurationMs,
        sessionLoadDurationMs: input.sessionLoadDurationMs
    }, true);
}
export function createRequestObservationDraft(input) {
    const active = input.outcome === 'completed' || input.outcome === 'failed_session_save';
    const context = active
        ? parseContext(input.context, true)
        : parseContext(input.context, false);
    const draft = Object.freeze({
        schemaVersion: 1,
        runRef: active
            ? context.runRef
            : input.runRef,
        requestRef: context.requestRef,
        requestKind: context.requestKind,
        outcome: input.outcome,
        admissionRejectionReason: input.admissionRejectionReason,
        queueDurationMs: active
            ? context.queueDurationMs
            : input.queueDurationMs,
        sessionLoadDurationMs: active
            ? context.sessionLoadDurationMs
            : input.sessionLoadDurationMs,
        sessionSaveDurationMs: input.sessionSaveDurationMs,
        terminalObservationId: input.terminalObservationId,
        startedAtMonotonicMs: context.startedAtMonotonicMs
    });
    const provisionalRequestDuration = context.requestKind === 'legacy_unknown'
        ? 'unavailable'
        : context.startedAtMonotonicMs === 'unavailable'
            ? 'unavailable'
            : 0;
    validateStageMatrix({
        ...draft,
        requestDurationMs: provisionalRequestDuration
    });
    return draft;
}
export function finalizeRequestObservation(input) {
    const finished = monotonicPoint(input.finishedAtMonotonicMs);
    const started = monotonicPoint(input.draft.startedAtMonotonicMs);
    const requestDurationMs = started === 'unavailable' || finished === 'unavailable' ||
        finished < started
        ? 'unavailable'
        : finished - started;
    const { startedAtMonotonicMs: _, ...draft } = input.draft;
    return parseRequestObservation({ ...draft, requestDurationMs });
}
export function parseRequestObservation(value) {
    const input = record(value, 'request observation');
    exactKeys(input, OBSERVATION_KEYS, 'request observation');
    if (input.schemaVersion !== 1 || typeof input.outcome !== 'string' ||
        !OUTCOMES.has(input.outcome) ||
        typeof input.admissionRejectionReason !== 'string' ||
        !REJECTION_REASONS.has(input.admissionRejectionReason)) {
        throw new TypeError('request observation fields are invalid');
    }
    const runRef = input.runRef === 'unavailable'
        ? input.runRef
        : reference(input.runRef, 'run reference');
    const observation = Object.freeze({
        schemaVersion: 1,
        runRef,
        requestRef: reference(input.requestRef, 'request reference'),
        requestKind: requestKind(input.requestKind),
        outcome: input.outcome,
        admissionRejectionReason: input.admissionRejectionReason,
        queueDurationMs: count(input.queueDurationMs),
        sessionLoadDurationMs: count(input.sessionLoadDurationMs),
        sessionSaveDurationMs: count(input.sessionSaveDurationMs),
        requestDurationMs: count(input.requestDurationMs),
        terminalObservationId: input.terminalObservationId
    });
    validateStageMatrix(observation);
    return observation;
}
