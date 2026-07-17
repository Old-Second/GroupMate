import { parseFrozenObservationPolicy } from '../../agent/run/run-observation.js';
const LEVEL_ORDER = Object.freeze({
    off: 0,
    basic: 1,
    diagnostic: 2
});
const TERMINAL_STATUSES = new Set([
    'completed', 'failed', 'cancelled'
]);
const PRESENTATION_STATES = new Set(['not_observed', 'normal', 'anomaly']);
function exactOwnData(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    let actual;
    try {
        actual = Reflect.ownKeys(value);
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
            descriptor = Object.getOwnPropertyDescriptor(value, key);
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
export function decideTraceRetention(input) {
    const fields = exactOwnData(input, [
        'policy', 'currentLevel', 'terminalStatus', 'presentation'
    ], 'trace policy input');
    const policy = parseFrozenObservationPolicy(fields.policy);
    if (!Object.hasOwn(LEVEL_ORDER, fields.currentLevel) ||
        !TERMINAL_STATUSES.has(fields.terminalStatus) ||
        !PRESENTATION_STATES.has(fields.presentation)) {
        throw new TypeError('trace policy fields are invalid');
    }
    const currentLevel = fields.currentLevel;
    const terminalStatus = fields.terminalStatus;
    const presentation = fields.presentation;
    const effective = LEVEL_ORDER[policy.levelAtStart] <= LEVEL_ORDER[currentLevel]
        ? policy.levelAtStart
        : currentLevel;
    if (effective === 'off')
        return Object.freeze({ kind: 'drop', reason: 'off' });
    if (terminalStatus === 'failed') {
        return Object.freeze({ kind: 'retain', reason: 'failed' });
    }
    if (terminalStatus === 'cancelled') {
        return Object.freeze({ kind: 'retain', reason: 'cancelled' });
    }
    if (effective === 'diagnostic') {
        return Object.freeze({ kind: 'retain', reason: 'diagnostic' });
    }
    if (policy.sampledSuccess) {
        return Object.freeze({ kind: 'retain', reason: 'sampled_success' });
    }
    if (presentation === 'anomaly') {
        return Object.freeze({ kind: 'retain', reason: 'presentation_anomaly' });
    }
    if (presentation === 'normal') {
        return Object.freeze({ kind: 'drop', reason: 'normal_success' });
    }
    return Object.freeze({ kind: 'await_presentation', reason: 'unsampled_success' });
}
