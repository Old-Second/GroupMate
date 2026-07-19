import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
const MAX_CAPABILITY_TOKENS = 1_000_000;
const CAPABILITY_KEYS = Object.freeze([
    'schemaVersion',
    'source',
    'contextWindowTokens',
    'maxOutputTokens',
    'promptCaching',
    'usageExtensions',
    'priceCatalogVersion'
]);
const OVERRIDE_KEYS = Object.freeze([
    'contextWindowTokens',
    'maxOutputTokens',
    'promptCaching',
    'usageExtensions'
]);
const SAFE_DEFAULT = Object.freeze({
    schemaVersion: 1,
    source: 'safe_default',
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown',
    usageExtensions: Object.freeze([]),
    priceCatalogVersion: null
});
function plainDataRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value))
        return null;
    try {
        if (Object.getPrototypeOf(value) !== Object.prototype)
            return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== 'string'))
            return null;
        const result = {};
        for (const key of keys) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
                descriptor.enumerable !== true)
                return null;
            result[key] = descriptor.value;
        }
        return result;
    }
    catch {
        return null;
    }
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function isTokenCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) &&
        value > 0 && value <= MAX_CAPABILITY_TOKENS;
}
function parseUsageExtensions(value) {
    if (!Array.isArray(value) || value.length > 2)
        throw new TypeError('model capability is invalid');
    const known = new Set(['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']);
    if (value.some(item => typeof item !== 'string' || !known.has(item)) ||
        new Set(value).size !== value.length) {
        throw new TypeError('model capability is invalid');
    }
    return Object.freeze([...value]);
}
function parseOverride(value) {
    const input = plainDataRecord(value);
    if (input === null || Object.keys(input).some(key => !OVERRIDE_KEYS.includes(key)) ||
        Object.keys(input).length === 0) {
        throw new TypeError('model capability override is invalid');
    }
    if (input.contextWindowTokens !== undefined && !isTokenCount(input.contextWindowTokens)) {
        throw new TypeError('model capability override is invalid');
    }
    if (input.maxOutputTokens !== undefined && !isTokenCount(input.maxOutputTokens)) {
        throw new TypeError('model capability override is invalid');
    }
    if (input.promptCaching !== undefined && input.promptCaching !== 'deepseek_disk' &&
        input.promptCaching !== 'unknown') {
        throw new TypeError('model capability override is invalid');
    }
    return Object.freeze({
        ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.promptCaching === undefined ? {} : { promptCaching: input.promptCaching }),
        ...(input.usageExtensions === undefined
            ? {}
            : { usageExtensions: parseUsageExtensions(input.usageExtensions) })
    });
}
export function parseModelCapabilitySnapshot(value) {
    const input = plainDataRecord(value);
    if (input === null || !hasExactKeys(input, CAPABILITY_KEYS) ||
        input.schemaVersion !== 1 ||
        (input.source !== 'profile' && input.source !== 'user_override' && input.source !== 'safe_default') ||
        !isTokenCount(input.contextWindowTokens) || !isTokenCount(input.maxOutputTokens) ||
        input.maxOutputTokens > input.contextWindowTokens ||
        (input.promptCaching !== 'deepseek_disk' && input.promptCaching !== 'unknown') ||
        (typeof input.priceCatalogVersion !== 'string' && input.priceCatalogVersion !== null)) {
        throw new TypeError('model capability is invalid');
    }
    const priceCatalogVersion = input.priceCatalogVersion;
    if (typeof priceCatalogVersion === 'string' && priceCatalogVersion.length === 0) {
        throw new TypeError('model capability is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        source: input.source,
        contextWindowTokens: input.contextWindowTokens,
        maxOutputTokens: input.maxOutputTokens,
        promptCaching: input.promptCaching,
        usageExtensions: parseUsageExtensions(input.usageExtensions),
        priceCatalogVersion
    });
}
export function resolveModelCapabilitySnapshot(input) {
    if (typeof input.model !== 'string' || input.model.length === 0 ||
        (input.now !== undefined && !Number.isFinite(input.now.getTime()))) {
        throw new TypeError('model capability lookup is invalid');
    }
    const profileSnapshot = input.profile.resolveModelCapability(input.model, input.now ?? new Date());
    const base = profileSnapshot === undefined
        ? SAFE_DEFAULT
        : parseModelCapabilitySnapshot(profileSnapshot);
    const override = input.override === undefined ? undefined : parseOverride(input.override);
    if (override === undefined)
        return base;
    const known = profileSnapshot !== undefined;
    if (known) {
        if ((override.contextWindowTokens ?? base.contextWindowTokens) > base.contextWindowTokens ||
            (override.maxOutputTokens ?? 0) > base.maxOutputTokens ||
            (override.promptCaching !== undefined && override.promptCaching !== 'unknown' &&
                override.promptCaching !== base.promptCaching) ||
            (override.usageExtensions !== undefined && override.usageExtensions
                .some(extension => !base.usageExtensions.includes(extension)))) {
            throw new TypeError('model capability override may only narrow a known profile');
        }
    }
    else if ((override.promptCaching !== undefined && override.promptCaching !== 'unknown') ||
        (override.usageExtensions !== undefined && override.usageExtensions.length > 0)) {
        throw new TypeError('model capability override cannot infer provider features');
    }
    const contextWindowTokens = override.contextWindowTokens ?? base.contextWindowTokens;
    const maxOutputTokens = override.maxOutputTokens ??
        Math.min(base.maxOutputTokens, contextWindowTokens);
    if (maxOutputTokens > contextWindowTokens) {
        throw new TypeError('model capability override output exceeds context');
    }
    return parseModelCapabilitySnapshot({
        ...base,
        ...override,
        contextWindowTokens,
        maxOutputTokens,
        source: 'user_override'
    });
}
export function modelCapabilityStableHash(value) {
    const capability = parseModelCapabilitySnapshot(value);
    const wire = JSON.stringify({
        schemaVersion: capability.schemaVersion,
        source: capability.source,
        contextWindowTokens: capability.contextWindowTokens,
        maxOutputTokens: capability.maxOutputTokens,
        promptCaching: capability.promptCaching,
        usageExtensions: capability.usageExtensions,
        priceCatalogVersion: capability.priceCatalogVersion
    });
    return createHash('sha256')
        .update('groupmate.model-capability.v1\0', 'ascii')
        .update(wire, 'utf8')
        .digest('hex');
}
