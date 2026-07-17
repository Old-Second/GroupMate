import { parseAgentMessage } from '../../agent/contracts/content.js';
import { parseJsonValue } from '../../agent/model/json-value.js';
import { canonicalSessionKey } from '../../agent/session/conversation-scope.js';
import { parseToolResult } from '../../agent/tools/tool-result.js';
export const CONTENT_JOURNAL_JSON_DEPTH_LIMIT = 32;
export const CONTENT_JOURNAL_JSON_NODE_LIMIT = 8_192;
export function createProjectionBudget(options) {
    if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes <= 0 ||
        !Number.isSafeInteger(options.maxTextBytes) || options.maxTextBytes <= 0) {
        throw new TypeError('projection budget is invalid');
    }
    let nodes = 0;
    let textBytes = 0;
    return Object.freeze({
        reserveArray(length, label) {
            if (!Number.isSafeInteger(length) || length < 0 ||
                length + 1 > options.maxNodes - nodes) {
                throw new TypeError(`${label} exceeds the projection node budget`);
            }
            nodes += length + 1;
        },
        consumeText(value, label) {
            const bytes = Buffer.byteLength(value, 'utf8');
            if (bytes > options.maxTextBytes - textBytes) {
                throw new TypeError(`${label} exceeds the projection text budget`);
            }
            textBytes += bytes;
        }
    });
}
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
export function ownDataArray(value, label, budget) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    let prototype;
    let lengthDescriptor;
    try {
        prototype = Object.getPrototypeOf(value);
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (prototype !== Array.prototype || lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    const length = Number(lengthDescriptor.value);
    budget.reserveArray(length, label);
    const output = [];
    for (let index = 0; index < length; index += 1) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        }
        catch {
            throw new TypeError(`${label} item is invalid`);
        }
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
        let pathname = url.pathname;
        try {
            pathname = decodeURI(pathname);
        }
        catch { }
        return `${url.origin}${pathname}`;
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
    return Object.freeze({ ...result, content });
}
