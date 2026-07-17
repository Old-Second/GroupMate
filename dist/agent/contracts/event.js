import { isAgentErrorCode } from './error.js';
export const AGENT_EVENT_TYPES = Object.freeze([
    'run.created', 'run.started', 'run.paused', 'run.resumed', 'run.progress',
    'context.prepared', 'model.started', 'model.delta', 'model.completed', 'model.attempted',
    'tool.batch_planned', 'tool.requested', 'tool.denied', 'tool.started',
    'tool.completed', 'tool.failed', 'tool.attempted', 'approval.required', 'approval.resolved',
    'approval.requested', 'approval.decided', 'approval.expired',
    'run.completed', 'run.failed', 'run.cancelled'
]);
const PROVIDER_ATTEMPT_KINDS = new Set([
    'primary', 'retry', 'recovery', 'correction'
]);
const PROVIDER_ATTEMPT_OUTCOMES = new Set([
    'succeeded', 'failed', 'cancelled', 'unknown'
]);
const TOOL_ATTEMPT_OUTCOMES = new Set([
    'succeeded', 'failed', 'denied', 'indeterminate'
]);
const TOOL_DENY_CODES = new Set([
    'permission_denied',
    'explicit_intent_required',
    'current_channel_uses_normal_reply',
    'target_invalid',
    'target_not_found',
    'target_protected',
    'bot_permission_denied',
    'cross_channel_disabled',
    'approval_invalid',
    'approval_unavailable',
    'tool_unavailable',
    'invalid_arguments',
    'current_message_protected',
    'self_unmute_denied',
    'self_mute_duration_exceeded',
    'role_hierarchy_denied',
    'unknown_policy_profile'
]);
const TOOL_ERROR_CODES = new Set([
    'configuration_missing',
    'upstream_unavailable',
    'tool_timeout',
    'tool_cancelled',
    'tool_execution_failed',
    'tool_invalid_result',
    'tool_output_too_large',
    'tool_control_unavailable',
    'tool_in_progress',
    'tool_outcome_unknown'
]);
function exactPayload(value, keys, label) {
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
    const entries = keys.map(key => {
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
    });
    return Object.fromEntries(entries);
}
function duration(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
export function parseProviderAttemptEventPayload(value) {
    const input = exactPayload(value, [
        'observationSchemaVersion', 'attemptKind', 'outcome', 'durationMs', 'errorCode'
    ], 'provider attempt payload');
    if (input.observationSchemaVersion !== 1 || typeof input.attemptKind !== 'string' ||
        !PROVIDER_ATTEMPT_KINDS.has(input.attemptKind) ||
        typeof input.outcome !== 'string' ||
        !PROVIDER_ATTEMPT_OUTCOMES.has(input.outcome) ||
        (input.errorCode !== null && !isAgentErrorCode(input.errorCode))) {
        throw new TypeError('provider attempt payload fields are invalid');
    }
    const outcome = input.outcome;
    if ((outcome === 'succeeded' && input.errorCode !== null) ||
        (outcome !== 'succeeded' && input.errorCode === null)) {
        throw new TypeError('provider attempt payload outcome is invalid');
    }
    return Object.freeze({
        observationSchemaVersion: 1,
        attemptKind: input.attemptKind,
        outcome,
        durationMs: duration(input.durationMs, 'provider attempt duration'),
        errorCode: input.errorCode
    });
}
export function parseToolAttemptEventPayload(value) {
    const input = exactPayload(value, [
        'observationSchemaVersion', 'ordinal', 'outcome', 'durationMs', 'resultCode'
    ], 'tool attempt payload');
    if (input.observationSchemaVersion !== 1 || (input.ordinal !== 1 && input.ordinal !== 2) ||
        typeof input.outcome !== 'string' ||
        !TOOL_ATTEMPT_OUTCOMES.has(input.outcome)) {
        throw new TypeError('tool attempt payload fields are invalid');
    }
    const outcome = input.outcome;
    const resultCode = input.resultCode;
    const validCode = outcome === 'succeeded'
        ? resultCode === null
        : outcome === 'denied'
            ? typeof resultCode === 'string' && TOOL_DENY_CODES.has(resultCode)
            : outcome === 'indeterminate'
                ? resultCode === 'tool_outcome_unknown'
                : typeof resultCode === 'string' && TOOL_ERROR_CODES.has(resultCode);
    if (!validCode)
        throw new TypeError('tool attempt result code is invalid');
    return Object.freeze({
        observationSchemaVersion: 1,
        ordinal: input.ordinal,
        outcome,
        durationMs: duration(input.durationMs, 'tool attempt duration'),
        resultCode: resultCode
    });
}
export function parseAgentEvent(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('agent event must be an object');
    const event = value;
    const allowed = new Set(['eventVersion', 'eventId', 'runId', 'sessionId', 'sequence', 'occurredAt', 'type', 'payload']);
    if (Object.keys(event).some(key => !allowed.has(key)))
        throw new TypeError('agent event contains unknown keys');
    if (event.eventVersion !== 1)
        throw new TypeError('event version is invalid');
    for (const field of ['eventId', 'runId', 'sessionId']) {
        if (typeof event[field] !== 'string' || event[field].length === 0)
            throw new TypeError(`${field} is invalid`);
    }
    if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0)
        throw new TypeError('event sequence is invalid');
    if (typeof event.occurredAt !== 'string' || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
        throw new TypeError('event timestamp is invalid');
    }
    if (!AGENT_EVENT_TYPES.includes(event.type))
        throw new TypeError('event type is invalid');
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        throw new TypeError('event payload is invalid');
    }
    if (event.type === 'model.attempted') {
        parseProviderAttemptEventPayload(event.payload);
        return value;
    }
    if (event.type === 'tool.attempted') {
        parseToolAttemptEventPayload(event.payload);
        return value;
    }
    let payloadKeys;
    try {
        payloadKeys = Reflect.ownKeys(event.payload);
    }
    catch {
        throw new TypeError('event payload is invalid');
    }
    for (const key of payloadKeys) {
        if (typeof key !== 'string')
            throw new TypeError('event payload key is invalid');
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(event.payload, key);
        }
        catch {
            throw new TypeError('event payload is invalid');
        }
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('event payload field is invalid');
        }
        const payloadValue = descriptor.value;
        if (payloadValue !== null && !['string', 'number', 'boolean'].includes(typeof payloadValue)) {
            throw new TypeError('event payload contains non-primitive data');
        }
        if (typeof payloadValue === 'number' && !Number.isFinite(payloadValue)) {
            throw new TypeError('event payload contains a non-finite number');
        }
    }
    return value;
}
