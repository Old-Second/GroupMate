import { types as utilTypes } from 'node:util';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
const BLOCKED = Object.freeze({ status: 'blocked' });
function positiveInteger(value, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function trustedNow(now) {
    let value;
    try {
        value = Reflect.apply(now, undefined, []);
    }
    catch {
        return null;
    }
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
        !Object.is(value, -0)
        ? value
        : null;
}
export function createMemorySemanticCircuitBreakerV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, ['failureThreshold', 'cooldownMs', 'now']);
    if (typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
        return invalidMemoryValue();
    }
    const failureThreshold = positiveInteger(input.failureThreshold, 16);
    const cooldownMs = positiveInteger(input.cooldownMs, 60 * 60 * 1_000);
    const now = input.now;
    let state = 'closed';
    let failures = 0;
    let retryAtMs = null;
    let probeInFlight = false;
    const snapshot = () => Object.freeze({
        state,
        failures,
        retryAtMs,
        probeInFlight
    });
    const open = (failedAtMs) => {
        state = 'open';
        probeInFlight = false;
        retryAtMs = Math.min(Number.MAX_SAFE_INTEGER, failedAtMs + cooldownMs);
    };
    const acquire = () => {
        const acquiredAtMs = trustedNow(now);
        if (acquiredAtMs === null)
            return BLOCKED;
        const isProbe = state !== 'closed';
        if (state === 'open') {
            if (retryAtMs === null || acquiredAtMs < retryAtMs || probeInFlight)
                return BLOCKED;
            state = 'half_open';
            probeInFlight = true;
        }
        else if (state === 'half_open') {
            return BLOCKED;
        }
        let settled = false;
        const settle = (outcome) => {
            if (settled || (outcome !== 'success' && outcome !== 'failure'))
                return;
            settled = true;
            const settledAtMs = trustedNow(now) ?? acquiredAtMs;
            if (outcome === 'success') {
                if (isProbe || state === 'half_open') {
                    state = 'closed';
                    failures = 0;
                    retryAtMs = null;
                    probeInFlight = false;
                }
                else {
                    failures = 0;
                }
                return;
            }
            failures = Math.min(failureThreshold, failures + 1);
            if (isProbe || state === 'half_open' || failures >= failureThreshold) {
                open(settledAtMs);
            }
        };
        return Object.freeze({ status: 'allowed', settle });
    };
    return Object.freeze({ acquire, snapshot });
}
