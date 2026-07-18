import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { parseRunTerminalSnapshot } from '../../agent/run/run-observation.js';
import { parseTerminalCommitReceipt } from '../../agent/run/run-store.js';
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js';
import { parseRequestObservation } from '../request-observation.js';
export const MAX_PRESENTATION_DELIVERY_OBSERVATIONS = 12;
const OBSERVATION_ID_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_KEYS = Object.freeze(['schemaVersion', 'type', 'value']);
const REQUEST_KEYS = Object.freeze([
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
const SNAPSHOT_KEYS = Object.freeze([
    'schemaVersion',
    'observationId',
    'runRef',
    'revision',
    'status',
    'finishedAt',
    'completion',
    'errorCode',
    'cancellationReason',
    'counters',
    'engineDurationMs'
]);
const SNAPSHOT_COUNTER_KEYS = Object.freeze([
    'schemaVersion',
    'providerAttempts',
    'modelTurns',
    'toolAttempts',
    'providerRetries',
    'recoveryAttempts',
    'correctionTurns',
    'toolCalls',
    'approvalRequests',
    'toolDenied',
    'toolExpired',
    'toolIndeterminate',
    'estimatedTokens',
    'providerInputTokens',
    'providerOutputTokens',
    'providerTotalTokens',
    'providerActiveDurationMs',
    'engineActiveDurationMs'
]);
const RECEIPT_KEYS = Object.freeze([
    'schemaVersion',
    'observationId',
    'runRef',
    'revision',
    'deletedKeyCount',
    'createdKeyCount',
    'checkpointBytesDeleted',
    'eventBytesDeleted',
    'tombstoneBytes'
]);
const PRESENTATION_KEYS = Object.freeze([
    'schemaVersion',
    'presentationObservationId',
    'runRef',
    'terminalObservationId',
    'profile',
    'outcome',
    'postprocessAnomaly',
    'deliveries',
    'totalDurationMs',
    'reducerInput'
]);
const REDUCER_KEYS = Object.freeze([
    'schemaVersion',
    'reducerVersion',
    'requestKind',
    'profile',
    'textLengthBucket',
    'hasReasoning',
    'hasCitation',
    'buttonsEligible',
    'ttsEligibility',
    'pictureEligibility',
    'quotePolicy',
    'selectedMode',
    'fallbackReason',
    'configEnumVersion'
]);
const DELIVERY_KEYS = Object.freeze([
    'schemaVersion', 'media', 'attempt', 'outcome', 'code'
]);
const PRESENTATION_PROFILES = new Set([
    'ordinary', 'proactive', 'recovered_legacy_plain_text', 'progress'
]);
const PRESENTATION_OUTCOMES = new Set([
    'complete', 'partial', 'failed', 'unknown', 'skipped'
]);
const REQUEST_KINDS = new Set([
    'ordinary_chat', 'proactive_chat', 'recovered_legacy_plain_text'
]);
const TEXT_LENGTH_BUCKETS = new Set([
    'none', '1_40', '41_200', '201_1000', '1001_4000', 'over_4000'
]);
const ELIGIBILITY = new Set([
    'eligible', 'disabled', 'unsupported'
]);
const QUOTE_POLICIES = new Set([
    'none', 'current_request', 'citation_forward'
]);
const SELECTED_MODES = new Set([
    'text', 'picture', 'tts', 'forward', 'silent'
]);
const FALLBACK_REASONS = new Set([
    'none',
    'profile_restricted',
    'postprocess_empty',
    'media_disabled',
    'media_unsupported',
    'content_too_large',
    'render_failed',
    'synthesis_failed',
    'delivery_definite_failure',
    'delivery_unknown'
]);
const DELIVERY_MEDIA = new Set([
    'text', 'picture', 'voice', 'forward'
]);
const DELIVERY_OUTCOMES = new Set([
    'sent', 'failed_definite', 'outcome_unknown'
]);
const DELIVERY_ERROR_CODES = new Set([
    'invalid_target',
    'invalid_part',
    'aborted_before_dispatch',
    'host_rejected',
    'host_exception_after_dispatch',
    'host_timeout_after_dispatch',
    'host_abort_after_dispatch',
    'unknown_host_result'
]);
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function exactData(value, keys, label) {
    const input = record(value, label);
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
            throw new TypeError(`${label} property is invalid`);
        }
        output[key] = descriptor.value;
    }
    return output;
}
function exactDataArray(value, maxLength, label) {
    let array;
    try {
        if (!Array.isArray(value))
            throw new TypeError(`${label} is invalid`);
        array = value;
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    let actual;
    let lengthDescriptor;
    try {
        actual = Reflect.ownKeys(array);
        lengthDescriptor = Object.getOwnPropertyDescriptor(array, 'length');
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maxLength) {
        throw new TypeError(`${label} length is invalid`);
    }
    const length = Number(lengthDescriptor.value);
    const expected = Object.freeze([
        ...Array.from({ length }, (_, index) => String(index)),
        'length'
    ]);
    if (actual.length !== expected.length || actual.some(key => (typeof key !== 'string' || !expected.includes(key)))) {
        throw new TypeError(`${label} keys are invalid`);
    }
    const output = [];
    for (let index = 0; index < length; index += 1) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(array, String(index));
        }
        catch {
            throw new TypeError(`${label} is invalid`);
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError(`${label} item is invalid`);
        }
        output.push(descriptor.value);
    }
    return Object.freeze(output);
}
function safeCompletion(value) {
    const base = exactDataByDiscriminator(value, 'kind', [
        ['reply_text', ['kind', 'lengthBucket']],
        ['already_visible', ['kind', 'source']],
        ['allowed_silence', ['kind', 'reason']],
        ['none', ['kind']]
    ], 'completion observation');
    return base;
}
function exactDataByDiscriminator(value, discriminator, variants, label) {
    const input = record(value, label);
    let descriptor;
    try {
        descriptor = Object.getOwnPropertyDescriptor(input, discriminator);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} discriminator is invalid`);
    }
    const variant = variants.find(([kind]) => descriptor?.value === kind);
    if (variant === undefined)
        throw new TypeError(`${label} discriminator is invalid`);
    return exactData(value, variant[1], label);
}
function safeRequest(value) {
    return parseRequestObservation(exactData(value, REQUEST_KEYS, 'request observation'));
}
function safeSnapshot(value) {
    const input = exactData(value, SNAPSHOT_KEYS, 'run terminal snapshot');
    return parseRunTerminalSnapshot({
        ...input,
        completion: safeCompletion(input.completion),
        counters: exactData(input.counters, SNAPSHOT_COUNTER_KEYS, 'run observation counters')
    });
}
function safeReceipt(value) {
    return parseTerminalCommitReceipt(exactData(value, RECEIPT_KEYS, 'terminal commit receipt'));
}
function parseObservationCount(value) {
    if (value === 'unavailable')
        return value;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError('presentation duration is invalid');
    }
    return Number(value);
}
function parseReducerInput(value) {
    const input = exactData(value, REDUCER_KEYS, 'presentation reducer input');
    if (input.schemaVersion !== 1 || input.reducerVersion !== 1 ||
        input.configEnumVersion !== 1 ||
        typeof input.requestKind !== 'string' ||
        !REQUEST_KINDS.has(input.requestKind) ||
        typeof input.profile !== 'string' ||
        !PRESENTATION_PROFILES.has(input.profile) ||
        typeof input.textLengthBucket !== 'string' ||
        !TEXT_LENGTH_BUCKETS.has(input.textLengthBucket) ||
        typeof input.hasReasoning !== 'boolean' ||
        typeof input.hasCitation !== 'boolean' ||
        typeof input.buttonsEligible !== 'boolean' ||
        typeof input.ttsEligibility !== 'string' ||
        !ELIGIBILITY.has(input.ttsEligibility) ||
        typeof input.pictureEligibility !== 'string' ||
        !ELIGIBILITY.has(input.pictureEligibility) ||
        typeof input.quotePolicy !== 'string' ||
        !QUOTE_POLICIES.has(input.quotePolicy) ||
        typeof input.selectedMode !== 'string' ||
        !SELECTED_MODES.has(input.selectedMode) ||
        typeof input.fallbackReason !== 'string' ||
        !FALLBACK_REASONS.has(input.fallbackReason)) {
        throw new TypeError('presentation reducer input fields are invalid');
    }
    const parsed = Object.freeze({
        schemaVersion: 1,
        reducerVersion: 1,
        requestKind: input.requestKind,
        profile: input.profile,
        textLengthBucket: input.textLengthBucket,
        hasReasoning: input.hasReasoning,
        hasCitation: input.hasCitation,
        buttonsEligible: input.buttonsEligible,
        ttsEligibility: input.ttsEligibility,
        pictureEligibility: input.pictureEligibility,
        quotePolicy: input.quotePolicy,
        selectedMode: input.selectedMode,
        fallbackReason: input.fallbackReason,
        configEnumVersion: 1
    });
    validateReducerMatrix(parsed);
    return parsed;
}
function validateReducerMatrix(value) {
    const profileMatches = value.profile === 'ordinary'
        ? value.requestKind === 'ordinary_chat'
        : value.profile === 'proactive'
            ? value.requestKind === 'proactive_chat'
            : value.profile === 'recovered_legacy_plain_text'
                ? value.requestKind === 'recovered_legacy_plain_text'
                : true;
    if (!profileMatches)
        throw new TypeError('presentation reducer profile matrix is invalid');
    if (value.profile !== 'progress')
        return;
    if ((value.textLengthBucket !== '1_40' && value.textLengthBucket !== '41_200') ||
        value.hasReasoning || value.hasCitation || value.buttonsEligible ||
        value.ttsEligibility !== 'disabled' || value.pictureEligibility !== 'disabled' ||
        value.quotePolicy !== 'none' || value.selectedMode !== 'text' ||
        value.fallbackReason !== 'none') {
        throw new TypeError('progress presentation reducer matrix is invalid');
    }
}
function parseDelivery(value) {
    const input = exactData(value, DELIVERY_KEYS, 'safe delivery observation');
    if (input.schemaVersion !== 1 || typeof input.media !== 'string' ||
        !DELIVERY_MEDIA.has(input.media) ||
        (input.attempt !== 1 && input.attempt !== 2) ||
        typeof input.outcome !== 'string' ||
        !DELIVERY_OUTCOMES.has(input.outcome)) {
        throw new TypeError('safe delivery observation fields are invalid');
    }
    if (input.outcome === 'sent') {
        if (input.code !== null)
            throw new TypeError('sent delivery code is invalid');
        return Object.freeze({
            schemaVersion: 1,
            media: input.media,
            attempt: input.attempt,
            outcome: 'sent',
            code: null
        });
    }
    if (typeof input.code !== 'string' ||
        !DELIVERY_ERROR_CODES.has(input.code)) {
        throw new TypeError('failed delivery code is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        media: input.media,
        attempt: input.attempt,
        outcome: input.outcome,
        code: input.code
    });
}
function validatePresentationCorrelation(runRef, terminalObservationId, profile) {
    const hasRun = runRef !== 'unavailable';
    if (hasRun && !RUN_REF_PATTERN.test(runRef)) {
        throw new TypeError('presentation run reference is invalid');
    }
    const hasTerminal = terminalObservationId !== 'unavailable' &&
        terminalObservationId !== 'not_attempted';
    if (hasTerminal && !OBSERVATION_ID_PATTERN.test(terminalObservationId)) {
        throw new TypeError('presentation terminal observation ID is invalid');
    }
    if (profile === 'progress') {
        if (!hasRun || terminalObservationId !== 'not_attempted') {
            throw new TypeError('progress presentation correlation is invalid');
        }
        return;
    }
    if ((!hasRun && terminalObservationId !== 'not_attempted') ||
        (hasRun && terminalObservationId === 'not_attempted')) {
        throw new TypeError('final presentation correlation is invalid');
    }
}
function hasPreDispatchTtsDeliveryShape(deliveries) {
    let index = 0;
    if (deliveries[index]?.media === 'forward')
        index += 1;
    if (deliveries[index]?.media !== 'text')
        return false;
    index += 1;
    if (deliveries[index]?.media === 'forward')
        index += 1;
    let trailingTexts = 0;
    while (deliveries[index]?.media === 'text' && trailingTexts < 2) {
        trailingTexts += 1;
        index += 1;
    }
    return index === deliveries.length && deliveries.every(delivery => delivery.outcome === 'sent');
}
function isPreDispatchTtsSynthesisPartial(deliveries, reducerInput) {
    return reducerInput.requestKind === 'ordinary_chat' &&
        reducerInput.profile === 'ordinary' &&
        reducerInput.ttsEligibility === 'eligible' &&
        reducerInput.selectedMode === 'text' &&
        reducerInput.fallbackReason === 'synthesis_failed' &&
        hasPreDispatchTtsDeliveryShape(deliveries);
}
function validatePresentationOutcome(outcome, deliveries, reducerInput) {
    const sent = deliveries.some(delivery => delivery.outcome === 'sent');
    const failed = deliveries.some(delivery => delivery.outcome === 'failed_definite');
    const unknown = deliveries.some(delivery => delivery.outcome === 'outcome_unknown');
    const valid = outcome === 'complete'
        ? !failed && !unknown
        : outcome === 'partial'
            ? sent && (failed || unknown ||
                isPreDispatchTtsSynthesisPartial(deliveries, reducerInput))
            : outcome === 'failed'
                ? !sent && !unknown
                : outcome === 'unknown'
                    ? !sent && unknown
                    : deliveries.length === 0;
    if (!valid)
        throw new TypeError('presentation observation outcome matrix is invalid');
}
export function createPresentationObservationId(random = nodeRandomBytes) {
    const bytes = random(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
        throw new TypeError('presentation observation random bytes are invalid');
    }
    return bytes.toString('hex');
}
export function createProgressPresentationReducerInput(input) {
    if (!REQUEST_KINDS.has(input.requestKind) || typeof input.text !== 'string') {
        throw new TypeError('progress presentation input is invalid');
    }
    const length = [...input.text].length;
    if (length < 1 || length > 200) {
        throw new TypeError('progress presentation text length is invalid');
    }
    return parseReducerInput({
        schemaVersion: 1,
        reducerVersion: 1,
        requestKind: input.requestKind,
        profile: 'progress',
        textLengthBucket: length <= 40 ? '1_40' : '41_200',
        hasReasoning: false,
        hasCitation: false,
        buttonsEligible: false,
        ttsEligibility: 'disabled',
        pictureEligibility: 'disabled',
        quotePolicy: 'none',
        selectedMode: 'text',
        fallbackReason: 'none',
        configEnumVersion: 1
    });
}
export function parsePresentationObservation(value) {
    const input = exactData(value, PRESENTATION_KEYS, 'presentation observation');
    if (input.schemaVersion !== 1 ||
        typeof input.presentationObservationId !== 'string' ||
        !OBSERVATION_ID_PATTERN.test(input.presentationObservationId) ||
        (input.runRef !== 'unavailable' && typeof input.runRef !== 'string') ||
        (input.terminalObservationId !== 'unavailable' &&
            input.terminalObservationId !== 'not_attempted' &&
            typeof input.terminalObservationId !== 'string') ||
        typeof input.profile !== 'string' ||
        !PRESENTATION_PROFILES.has(input.profile) ||
        typeof input.outcome !== 'string' ||
        !PRESENTATION_OUTCOMES.has(input.outcome) ||
        typeof input.postprocessAnomaly !== 'boolean') {
        throw new TypeError('presentation observation fields are invalid');
    }
    const deliveryValues = exactDataArray(input.deliveries, MAX_PRESENTATION_DELIVERY_OBSERVATIONS, 'presentation deliveries');
    const profile = input.profile;
    const runRef = input.runRef;
    const terminalId = input.terminalObservationId;
    validatePresentationCorrelation(runRef, terminalId, profile);
    const reducerInput = parseReducerInput(input.reducerInput);
    if (reducerInput.profile !== profile) {
        throw new TypeError('presentation observation profile matrix is invalid');
    }
    const deliveries = Object.freeze(deliveryValues.map(parseDelivery));
    const outcome = input.outcome;
    validatePresentationOutcome(outcome, deliveries, reducerInput);
    return Object.freeze({
        schemaVersion: 1,
        presentationObservationId: input.presentationObservationId,
        runRef,
        terminalObservationId: terminalId,
        profile,
        outcome,
        postprocessAnomaly: input.postprocessAnomaly,
        deliveries,
        totalDurationMs: parseObservationCount(input.totalDurationMs),
        reducerInput
    });
}
export function parseObservationEvent(value) {
    const input = exactData(value, EVENT_KEYS, 'observation event');
    if (input.schemaVersion !== 1)
        throw new TypeError('observation event schema is invalid');
    if (input.type === 'request') {
        return Object.freeze({ schemaVersion: 1, type: 'request', value: safeRequest(input.value) });
    }
    if (input.type === 'terminal_snapshot') {
        return Object.freeze({
            schemaVersion: 1,
            type: 'terminal_snapshot',
            value: safeSnapshot(input.value)
        });
    }
    if (input.type === 'terminal_commit') {
        return Object.freeze({
            schemaVersion: 1,
            type: 'terminal_commit',
            value: safeReceipt(input.value)
        });
    }
    if (input.type === 'presentation') {
        return Object.freeze({
            schemaVersion: 1,
            type: 'presentation',
            value: parsePresentationObservation(input.value)
        });
    }
    throw new TypeError('observation event type is invalid');
}
