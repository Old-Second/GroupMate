import { parseJsonValue } from './json-value.js';
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js';
function hasLoneSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
                return true;
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function jsonEqual(left, right) {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return Object.is(left, right);
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
            left.every((value, index) => jsonEqual(value, right[index]));
    }
    const leftObject = left;
    const rightObject = right;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (key === rightKeys[index] && jsonEqual(leftObject[key], rightObject[key])));
}
export function parseExactToolArgumentsText(value, expectedArguments) {
    if (typeof value !== 'string' || hasLoneSurrogate(value) ||
        Buffer.byteLength(value, 'utf8') > RUN_RESOURCE_LIMITS.toolArgumentsBytes) {
        throw new TypeError('tool arguments text is invalid');
    }
    let decoded;
    try {
        decoded = JSON.parse(value);
    }
    catch {
        throw new TypeError('tool arguments text is invalid');
    }
    const parsed = parseJsonValue(decoded, {
        maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
        maxDepth: 8,
        maxNodes: 512
    });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !jsonEqual(parsed, expectedArguments)) {
        throw new TypeError('tool arguments text does not match arguments');
    }
    return value;
}
