import { jsonByteLength, parseJsonValue } from '../model/json-value.js';
import { RUN_RESOURCE_LIMITS } from './run-limits.js';
const PROFILE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
function readRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('provider state must be an object');
    }
    let prototype;
    try {
        prototype = Object.getPrototypeOf(value);
    }
    catch {
        throw new TypeError('provider state cannot be inspected safely');
    }
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('provider state must be a plain object');
    }
    return value;
}
export function parseProviderTurnState(value) {
    const input = readRecord(value);
    const allowed = new Set(['profileId', 'profileVersion', 'payload']);
    if (Object.keys(input).some(key => !allowed.has(key))) {
        throw new TypeError('provider state contains unknown keys');
    }
    if (typeof input.profileId !== 'string' || !PROFILE_ID.test(input.profileId)) {
        throw new TypeError('provider state profile is invalid');
    }
    if (!Number.isSafeInteger(input.profileVersion) || Number(input.profileVersion) <= 0) {
        throw new TypeError('provider state profile version is invalid');
    }
    let payload;
    try {
        payload = parseJsonValue(input.payload, {
            maxBytes: RUN_RESOURCE_LIMITS.providerStateBytes
        });
    }
    catch (error) {
        if (error instanceof TypeError && error.message === 'JSON value byte limit exceeded') {
            throw new TypeError('provider state byte limit exceeded');
        }
        throw error;
    }
    const state = Object.freeze({
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        payload
    });
    if (jsonByteLength(state) > RUN_RESOURCE_LIMITS.providerStateBytes) {
        throw new TypeError('provider state byte limit exceeded');
    }
    return state;
}
