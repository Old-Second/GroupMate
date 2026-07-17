import { parseAgentMessage } from '../../agent/contracts/content.js';
import { parseJsonValue } from '../../agent/model/json-value.js';
import { canonicalSessionKey } from '../../agent/session/conversation-scope.js';
import { parseToolResult } from '../../agent/tools/tool-result.js';
export const CONTENT_JOURNAL_JSON_DEPTH_LIMIT = 32;
export const CONTENT_JOURNAL_JSON_NODE_LIMIT = 8_192;
export function boundedRecord(value, maxBytes, label, options = {}) {
    const parsed = parseJsonValue(value, {
        maxBytes,
        maxDepth: options.maxDepth ?? CONTENT_JOURNAL_JSON_DEPTH_LIMIT,
        maxNodes: options.maxNodes ?? CONTENT_JOURNAL_JSON_NODE_LIMIT
    });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError(`${label} is invalid`);
    }
    return parsed;
}
export function exactKeys(value, allowed, required, label) {
    const keys = Reflect.ownKeys(value);
    const unknown = keys.find(key => typeof key !== 'string' || !allowed.includes(key));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains an unknown key`);
    const missing = required.find(key => !Object.hasOwn(value, key));
    if (missing !== undefined)
        throw new TypeError(`${label} is missing a key`);
}
export function text(value, label, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
export function timestamp(value, label) {
    const result = text(value, label);
    try {
        if (new Date(result).toISOString() !== result)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return result;
}
export function safeInteger(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
export function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
export function jsonObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
export function jsonArray(value, maximum, label) {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
export function ownDataRecord(value, label, options = {}) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} prototype is invalid`);
    }
    const symbols = Reflect.ownKeys(descriptors).filter(key => typeof key === 'symbol');
    if (!options.allowReceiptBrand && symbols.length > 0) {
        throw new TypeError(`${label} symbol is invalid`);
    }
    if (options.allowReceiptBrand && (symbols.length > 1 || symbols.some(key => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value') || descriptor.value !== true;
    }))) {
        throw new TypeError(`${label} brand is invalid`);
    }
    const output = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} field is invalid`);
        }
        output[key] = descriptor.value;
    }
    return output;
}
export function ownDataArray(value, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 ||
        Reflect.ownKeys(descriptors).some(key => (typeof key === 'string' && key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new TypeError(`${label} is invalid`);
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} item is invalid`);
        }
        output.push(descriptor.value);
    }
    return output;
}
export function projectSessionAddress(value, label = 'session address') {
    const input = ownDataRecord(value, label);
    exactKeys(input, ['botId', 'scope'], ['botId', 'scope'], label);
    const botId = text(input.botId, `${label} bot ID`);
    const scopeInput = ownDataRecord(input.scope, `${label} scope`);
    let scope;
    if (scopeInput.kind === 'private') {
        exactKeys(scopeInput, ['kind', 'userId'], ['kind', 'userId'], `${label} scope`);
        scope = Object.freeze({
            kind: 'private', userId: text(scopeInput.userId, `${label} user ID`)
        });
    }
    else if (scopeInput.kind === 'group') {
        exactKeys(scopeInput, ['kind', 'groupId'], ['kind', 'groupId'], `${label} scope`);
        scope = Object.freeze({
            kind: 'group', groupId: text(scopeInput.groupId, `${label} group ID`)
        });
    }
    else if (scopeInput.kind === 'group_user') {
        exactKeys(scopeInput, ['kind', 'groupId', 'userId'], ['kind', 'groupId', 'userId'], `${label} scope`);
        scope = Object.freeze({
            kind: 'group_user',
            groupId: text(scopeInput.groupId, `${label} group ID`),
            userId: text(scopeInput.userId, `${label} user ID`)
        });
    }
    else {
        throw new TypeError(`${label} scope is invalid`);
    }
    const address = Object.freeze({ botId, scope });
    canonicalSessionKey(address);
    return address;
}
export function safeHttpUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return `${url.origin}${url.pathname}`;
    }
    catch {
        return undefined;
    }
}
function projectResourcePart(part) {
    if (part.type !== 'resource_ref')
        return part;
    const safe = safeHttpUrl(part.resourceId);
    if (safe === undefined || safe === part.resourceId)
        return part;
    return Object.freeze({ ...part, resourceId: safe });
}
export function projectAgentMessageResources(value) {
    const message = parseAgentMessage(value);
    const parts = Object.freeze(message.parts.map(projectResourcePart));
    const replyTo = message.replyTo === undefined
        ? undefined
        : Object.freeze({
            ...message.replyTo,
            parts: Object.freeze(message.replyTo.parts.map(projectResourcePart))
        });
    return Object.freeze({
        ...message,
        parts,
        ...(replyTo === undefined ? {} : { replyTo })
    });
}
export function projectToolResultResources(value) {
    const result = parseToolResult(value);
    if (result.status !== 'success')
        return result;
    const content = Object.freeze(result.content.map(item => {
        if (item.type !== 'resource_ref')
            return item;
        const safe = safeHttpUrl(item.resourceId);
        return safe === undefined || safe === item.resourceId
            ? item
            : Object.freeze({ ...item, resourceId: safe });
    }));
    return parseToolResult({ ...result, content });
}
