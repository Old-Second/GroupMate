import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const MEMORY_NAMESPACE_HASH_DOMAIN = 'groupmate.memory.namespace.v1';
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CANONICAL_QQ_ID = /^[1-9][0-9]*$/;
const MEMORY_NAMESPACE_REF = /^[0-9a-f]{64}$/;
export function invalidMemoryValue() {
    throw new TypeError('invalid canonical memory value');
}
export function inspectMemoryRecord(value, required, optional = []) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value))
        return invalidMemoryValue();
    let prototype;
    let descriptors;
    let keys;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
    }
    catch {
        return invalidMemoryValue();
    }
    if (prototype !== Object.prototype || keys.some(key => typeof key !== 'string')) {
        return invalidMemoryValue();
    }
    const allowed = new Set([...required, ...optional]);
    if (keys.some(key => !allowed.has(key)) ||
        required.some(key => !Object.hasOwn(descriptors, key)))
        return invalidMemoryValue();
    const result = {};
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true)
            return invalidMemoryValue();
        Object.defineProperty(result, key, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return result;
}
export function inspectMemoryArray(value, maximumLength) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value) ||
        utilTypes.isProxy(value) || !Number.isSafeInteger(maximumLength) || maximumLength < 0) {
        return invalidMemoryValue();
    }
    let prototype;
    let descriptors;
    let keys;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
    }
    catch {
        return invalidMemoryValue();
    }
    const lengthDescriptor = descriptors.length;
    if (prototype !== Array.prototype || lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maximumLength || keys.some(key => typeof key !== 'string')) {
        return invalidMemoryValue();
    }
    const length = lengthDescriptor.value;
    const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key))) {
        return invalidMemoryValue();
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true)
            return invalidMemoryValue();
        result.push(descriptor.value);
    }
    return result;
}
function codePoints(value) {
    return Array.from(value).length;
}
export function parseMemoryBotInstanceIdV1(value) {
    if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
        value.normalize('NFC') !== value ||
        codePoints(value) > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
        !CANONICAL_IDENTIFIER.test(value))
        return invalidMemoryValue();
    return value;
}
export function parseMemoryGroupLifecycleIdV1(value) {
    if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
        value.normalize('NFC') !== value ||
        codePoints(value) > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
        !CANONICAL_IDENTIFIER.test(value))
        return invalidMemoryValue();
    return value;
}
export function parseMemoryQqIdV1(value) {
    if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.qqIdDigits ||
        !CANONICAL_QQ_ID.test(value))
        return invalidMemoryValue();
    return value;
}
function parseMemoryScopeV1(value) {
    const discriminator = inspectMemoryRecord(value, ['kind'], ['subjectUserId', 'groupId', 'groupLifecycleId']);
    if (discriminator.kind === 'personal') {
        const input = inspectMemoryRecord(value, ['kind', 'subjectUserId']);
        return Object.freeze({
            kind: 'personal',
            subjectUserId: parseMemoryQqIdV1(input.subjectUserId)
        });
    }
    if (discriminator.kind === 'group') {
        const input = inspectMemoryRecord(value, ['kind', 'groupId', 'groupLifecycleId']);
        return Object.freeze({
            kind: 'group',
            groupId: parseMemoryQqIdV1(input.groupId),
            groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId)
        });
    }
    return invalidMemoryValue();
}
function parseMemoryNamespaceFields(value, includeSchemaVersion) {
    const keys = ['botInstanceId', 'adapter', 'accountId', 'scope'];
    const input = inspectMemoryRecord(value, includeSchemaVersion ? ['schemaVersion', ...keys] : keys);
    if (includeSchemaVersion && input.schemaVersion !== 1)
        return invalidMemoryValue();
    if (input.adapter !== 'qq')
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        adapter: 'qq',
        accountId: parseMemoryQqIdV1(input.accountId),
        scope: parseMemoryScopeV1(input.scope)
    });
}
export function createMemoryNamespaceV1(value) {
    return parseMemoryNamespaceFields(value, false);
}
export function parseMemoryNamespaceV1(value) {
    return parseMemoryNamespaceFields(value, true);
}
export function memoryNamespaceWireV1(value) {
    const namespace = parseMemoryNamespaceV1(value);
    const scope = namespace.scope.kind === 'personal'
        ? `{"kind":"personal","subjectUserId":${JSON.stringify(namespace.scope.subjectUserId)}}`
        : `{"kind":"group","groupId":${JSON.stringify(namespace.scope.groupId)},"groupLifecycleId":${JSON.stringify(namespace.scope.groupLifecycleId)}}`;
    return `{"schemaVersion":1,"botInstanceId":${JSON.stringify(namespace.botInstanceId)},"adapter":"qq","accountId":${JSON.stringify(namespace.accountId)},"scope":${scope}}`;
}
export function memoryNamespaceRefV1(value) {
    return createHash('sha256')
        .update(MEMORY_NAMESPACE_HASH_DOMAIN, 'utf8')
        .update('\0')
        .update(memoryNamespaceWireV1(value), 'utf8')
        .digest('hex');
}
export function parseMemoryNamespaceRefV1(value) {
    if (typeof value !== 'string' || !MEMORY_NAMESPACE_REF.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
export function parseRunScopedContextRefV1(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
