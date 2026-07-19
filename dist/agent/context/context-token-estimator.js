import { types as utilTypes } from 'node:util';
import { parseExactToolArgumentsText } from '../model/tool-arguments-text.js';
export const CONTEXT_TOKEN_ESTIMATOR_VERSION = 'context-byte-quarter-v1';
export const MAX_CONTEXT_CANONICAL_MESSAGE_BYTES = 512 * 1_024;
const SAFE_ASCII = /^[\x21-\x7e]{1,128}$/;
const PROFILE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
export const MAX_CONTEXT_MESSAGES = 128;
const MAX_CONTEXT_TOOL_CALLS = 128;
const MAX_CONTEXT_STRING_CODE_UNITS = 512 * 1_024;
export function invalidContextValue() {
    throw new TypeError('invalid canonical context value');
}
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
export function normalizeContextString(value) {
    if (typeof value !== 'string' || value.length > MAX_CONTEXT_STRING_CODE_UNITS ||
        hasLoneSurrogate(value))
        return invalidContextValue();
    return value.normalize('NFC');
}
function exactContextString(value) {
    if (typeof value !== 'string' || value.length > MAX_CONTEXT_STRING_CODE_UNITS ||
        hasLoneSurrogate(value))
        return invalidContextValue();
    return value;
}
export function requireContextAscii(value) {
    if (typeof value !== 'string' || !SAFE_ASCII.test(value))
        return invalidContextValue();
    return value;
}
export function requireContextHash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        return invalidContextValue();
    return value;
}
export function requireSafeInteger(value, options = {}) {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
        return invalidContextValue();
    const integer = value;
    if (options.positive === true ? integer <= 0 : integer < 0)
        return invalidContextValue();
    return integer;
}
export function inspectContextRecord(value, required, optional = []) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
        return invalidContextValue();
    }
    let prototype;
    let descriptors;
    let keys;
    let frozen;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
        frozen = Object.isFrozen(value);
    }
    catch {
        return invalidContextValue();
    }
    if (prototype !== Object.prototype || !frozen || keys.some(key => typeof key !== 'string')) {
        return invalidContextValue();
    }
    const allowed = new Set([...required, ...optional]);
    if (keys.some(key => !allowed.has(key)) || required.some(key => !(key in descriptors))) {
        return invalidContextValue();
    }
    const result = {};
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            return invalidContextValue();
        }
        Object.defineProperty(result, key, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return result;
}
export function inspectContextArray(value, maxLength = MAX_JSON_NODES) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || !Array.isArray(value)) {
        return invalidContextValue();
    }
    let prototype;
    let descriptors;
    let keys;
    let frozen;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
        frozen = Object.isFrozen(value);
    }
    catch {
        return invalidContextValue();
    }
    const lengthDescriptor = descriptors.length;
    if (prototype !== Array.prototype || !frozen || lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 || keys.some(key => typeof key !== 'string')) {
        return invalidContextValue();
    }
    const length = lengthDescriptor.value;
    if (length > maxLength)
        return invalidContextValue();
    const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key))) {
        return invalidContextValue();
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            return invalidContextValue();
        }
        result.push(descriptor.value);
    }
    return result;
}
function inspectArbitraryRecord(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
        return invalidContextValue();
    }
    let prototype;
    let descriptors;
    let keys;
    let frozen;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
        frozen = Object.isFrozen(value);
    }
    catch {
        return invalidContextValue();
    }
    if (prototype !== Object.prototype || !frozen || keys.length > MAX_JSON_NODES ||
        keys.some(key => typeof key !== 'string'))
        return invalidContextValue();
    const result = {};
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            return invalidContextValue();
        }
        Object.defineProperty(result, key, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return result;
}
export function asciiContextCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function cloneJsonValue(value, depth, state) {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
        return invalidContextValue();
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return normalizeContextString(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0) ||
            (Number.isInteger(value) && !Number.isSafeInteger(value)))
            return invalidContextValue();
        return value;
    }
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value))
        return invalidContextValue();
    if (state.ancestors.has(value))
        return invalidContextValue();
    state.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const input = inspectContextArray(value);
            return Object.freeze(input.map(item => cloneJsonValue(item, depth + 1, state)));
        }
        const input = inspectArbitraryRecord(value);
        const output = {};
        for (const key of Object.keys(input).sort(asciiContextCompare)) {
            const normalizedKey = normalizeContextString(key);
            if (normalizedKey !== key)
                return invalidContextValue();
            Object.defineProperty(output, key, {
                value: cloneJsonValue(input[key], depth + 1, state),
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return Object.freeze(output);
    }
    finally {
        state.ancestors.delete(value);
    }
}
function canonicalizeContextJsonValueWithState(value, state) {
    return cloneJsonValue(value, 0, state);
}
export function canonicalizeContextJsonValue(value) {
    return canonicalizeContextJsonValueWithState(value, {
        nodes: 0,
        ancestors: new Set()
    });
}
function cloneExactJsonValue(value, depth, state) {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
        return invalidContextValue();
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return exactContextString(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0) ||
            (Number.isInteger(value) && !Number.isSafeInteger(value)))
            return invalidContextValue();
        return value;
    }
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
        return invalidContextValue();
    }
    if (state.ancestors.has(value))
        return invalidContextValue();
    state.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const input = inspectContextArray(value);
            return Object.freeze(input.map(item => cloneExactJsonValue(item, depth + 1, state)));
        }
        const input = inspectArbitraryRecord(value);
        const output = {};
        for (const key of Object.keys(input)) {
            exactContextString(key);
            Object.defineProperty(output, key, {
                value: cloneExactJsonValue(input[key], depth + 1, state),
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return Object.freeze(output);
    }
    finally {
        state.ancestors.delete(value);
    }
}
function parseToolCall(value, state) {
    const input = inspectContextRecord(value, ['callId', 'name', 'arguments'], ['argumentsText']);
    const args = cloneExactJsonValue(input.arguments, 0, state);
    if (args === null || typeof args !== 'object' || Array.isArray(args))
        return invalidContextValue();
    const argumentsText = input.argumentsText === undefined
        ? undefined
        : parseExactToolArgumentsText(input.argumentsText, args);
    return Object.freeze({
        callId: requireContextAscii(input.callId),
        name: requireContextAscii(input.name),
        ...(argumentsText === undefined ? {} : { argumentsText }),
        arguments: args
    });
}
function parseProviderState(value, state) {
    const input = inspectContextRecord(value, ['profileId', 'profileVersion', 'payload']);
    if (typeof input.profileId !== 'string' || !PROFILE_ID.test(input.profileId))
        return invalidContextValue();
    const profileVersion = requireSafeInteger(input.profileVersion, { positive: true });
    return Object.freeze({
        profileId: input.profileId,
        profileVersion,
        payload: cloneExactJsonValue(input.payload, 0, state)
    });
}
function parseModelMessage(value, state) {
    const base = inspectContextRecord(value, ['role'], ['content', 'toolCalls', 'providerState', 'toolCallId']);
    switch (base.role) {
        case 'system':
        case 'developer':
        case 'user': {
            const input = inspectContextRecord(value, ['role', 'content']);
            return Object.freeze({ role: base.role, content: normalizeContextString(input.content) });
        }
        case 'assistant': {
            const input = inspectContextRecord(value, ['role', 'content'], ['toolCalls', 'providerState']);
            const content = input.content === null ? null : normalizeContextString(input.content);
            let toolCalls;
            if (input.toolCalls !== undefined) {
                const calls = inspectContextArray(input.toolCalls, MAX_CONTEXT_TOOL_CALLS)
                    .map(call => parseToolCall(call, state));
                if (calls.length === 0)
                    return invalidContextValue();
                const ids = new Set(calls.map(call => call.callId));
                if (ids.size !== calls.length)
                    return invalidContextValue();
                toolCalls = Object.freeze(calls);
            }
            const providerState = input.providerState === undefined
                ? undefined
                : parseProviderState(input.providerState, state);
            return Object.freeze({
                role: 'assistant',
                content,
                ...(toolCalls === undefined ? {} : { toolCalls }),
                ...(providerState === undefined ? {} : { providerState })
            });
        }
        case 'tool': {
            const input = inspectContextRecord(value, ['role', 'content', 'toolCallId']);
            return Object.freeze({
                role: 'tool',
                content: normalizeContextString(input.content),
                toolCallId: requireContextAscii(input.toolCallId)
            });
        }
        default:
            return invalidContextValue();
    }
}
export function canonicalizeModelMessages(value) {
    const state = { nodes: 0, ancestors: new Set() };
    const parsed = Object.freeze(inspectContextArray(value, MAX_CONTEXT_MESSAGES)
        .map(message => parseModelMessage(message, state)));
    const bytes = Buffer.byteLength(`[${parsed.map(modelMessageJson).join(',')}]`, 'utf8');
    if (bytes > MAX_CONTEXT_CANONICAL_MESSAGE_BYTES)
        return invalidContextValue();
    return parsed;
}
function stringifyJsonValue(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return JSON.stringify(value);
    }
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stringifyJsonValue).join(',')}]`;
    const object = value;
    return `{${Object.keys(object).sort(asciiContextCompare).map(key => {
        return `${JSON.stringify(key)}:${stringifyJsonValue(object[key])}`;
    }).join(',')}}`;
}
function modelMessageJson(message) {
    switch (message.role) {
        case 'system':
        case 'developer':
        case 'user':
            return `{"role":${JSON.stringify(message.role)},"content":${JSON.stringify(message.content)}}`;
        case 'assistant': {
            const fields = [
                `"role":"assistant"`,
                `"content":${message.content === null ? 'null' : JSON.stringify(message.content)}`
            ];
            if (message.toolCalls !== undefined) {
                fields.push(`"toolCalls":[${message.toolCalls.map(call => {
                    return `{"callId":${JSON.stringify(call.callId)},"name":${JSON.stringify(call.name)}${call.argumentsText === undefined ? '' : `,"argumentsText":${JSON.stringify(call.argumentsText)}`},"arguments":${stringifyJsonValue(call.arguments)}}`;
                }).join(',')}]`);
            }
            if (message.providerState !== undefined) {
                fields.push(`"providerState":{"profileId":${JSON.stringify(message.providerState.profileId)},"profileVersion":${message.providerState.profileVersion},"payload":${stringifyJsonValue(message.providerState.payload)}}`);
            }
            return `{${fields.join(',')}}`;
        }
        case 'tool':
            return `{"role":"tool","content":${JSON.stringify(message.content)},"toolCallId":${JSON.stringify(message.toolCallId)}}`;
    }
}
export function canonicalJsonStringify(value) {
    return stringifyJsonValue(value);
}
export function serializeModelMessages(value) {
    const messages = canonicalizeModelMessages(value);
    return `[${messages.map(modelMessageJson).join(',')}]`;
}
export function serializedModelMessagesBytes(value) {
    return Buffer.byteLength(serializeModelMessages(value), 'utf8');
}
export function estimateModelMessagesTokens(value) {
    const messages = canonicalizeModelMessages(value);
    if (messages.length === 0)
        return 0;
    return Math.max(1, Math.ceil(Buffer.byteLength(`[${messages.map(modelMessageJson).join(',')}]`, 'utf8') / 4));
}
