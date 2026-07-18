const USAGE_KEYS = Object.freeze([
    'schemaVersion',
    'availability',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheHitTokens',
    'cacheMissTokens',
    'turnsWithUsage',
    'turnsWithoutUsage',
    'cacheUsageComplete'
]);
function record(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('run usage is invalid');
    }
    return value;
}
function nonNegativeSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function safeSum(left, right) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum))
        throw new TypeError('run usage overflow');
    return sum;
}
export function parseRunUsageSummary(value) {
    const input = record(value);
    const keys = Object.keys(input);
    if (keys.length !== USAGE_KEYS.length || keys.some(key => !USAGE_KEYS.includes(key)) ||
        input.schemaVersion !== 1 ||
        (input.availability !== 'complete' && input.availability !== 'partial' &&
            input.availability !== 'unavailable') ||
        !nonNegativeSafeInteger(input.inputTokens) ||
        !nonNegativeSafeInteger(input.outputTokens) ||
        !nonNegativeSafeInteger(input.totalTokens) ||
        !nonNegativeSafeInteger(input.cacheHitTokens) ||
        !nonNegativeSafeInteger(input.cacheMissTokens) ||
        !nonNegativeSafeInteger(input.turnsWithUsage) ||
        !nonNegativeSafeInteger(input.turnsWithoutUsage) ||
        typeof input.cacheUsageComplete !== 'boolean') {
        throw new TypeError('run usage is invalid');
    }
    if (safeSum(input.inputTokens, input.outputTokens) !== input.totalTokens ||
        safeSum(input.cacheHitTokens, input.cacheMissTokens) > input.inputTokens ||
        (input.availability === 'unavailable' && input.cacheUsageComplete) ||
        (input.availability === 'complete' && !input.cacheUsageComplete &&
            input.inputTokens === 0 && input.outputTokens === 0 && input.totalTokens === 0 &&
            input.cacheHitTokens === 0 && input.cacheMissTokens === 0 &&
            input.turnsWithUsage === 0 && input.turnsWithoutUsage === 0) ||
        (input.cacheUsageComplete &&
            (input.cacheHitTokens + input.cacheMissTokens !== input.inputTokens ||
                input.turnsWithoutUsage !== 0)) ||
        (input.availability === 'complete' && input.turnsWithoutUsage !== 0) ||
        (input.availability === 'partial' && input.turnsWithoutUsage === 0)) {
        throw new TypeError('run usage is inconsistent');
    }
    return Object.freeze({
        schemaVersion: 1,
        availability: input.availability,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        cacheHitTokens: input.cacheHitTokens,
        cacheMissTokens: input.cacheMissTokens,
        turnsWithUsage: input.turnsWithUsage,
        turnsWithoutUsage: input.turnsWithoutUsage,
        cacheUsageComplete: input.cacheUsageComplete
    });
}
export function createInitialRunUsageSummary() {
    return parseRunUsageSummary({
        schemaVersion: 1,
        availability: 'complete',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        turnsWithUsage: 0,
        turnsWithoutUsage: 0,
        cacheUsageComplete: true
    });
}
export function createUnavailableRunUsageSummary() {
    return parseRunUsageSummary({
        ...createInitialRunUsageSummary(),
        availability: 'unavailable',
        cacheUsageComplete: false
    });
}
function parseTurnUsage(value) {
    if (!nonNegativeSafeInteger(value.inputTokens) ||
        !nonNegativeSafeInteger(value.outputTokens) ||
        !nonNegativeSafeInteger(value.totalTokens) ||
        safeSum(value.inputTokens, value.outputTokens) !== value.totalTokens) {
        throw new TypeError('model usage is invalid');
    }
    if (value.inputCache === undefined)
        return value;
    if (!nonNegativeSafeInteger(value.inputCache.hitTokens) ||
        !nonNegativeSafeInteger(value.inputCache.missTokens) ||
        safeSum(value.inputCache.hitTokens, value.inputCache.missTokens) !== value.inputTokens) {
        throw new TypeError('model cache usage is invalid');
    }
    return value;
}
export function recordRunUsage(current, usage) {
    const parsed = parseRunUsageSummary(current);
    if (usage === undefined) {
        return parseRunUsageSummary({
            ...parsed,
            availability: parsed.availability === 'unavailable' ? 'unavailable' : 'partial',
            turnsWithoutUsage: safeSum(parsed.turnsWithoutUsage, 1),
            cacheUsageComplete: false
        });
    }
    const turn = parseTurnUsage(usage);
    return parseRunUsageSummary({
        ...parsed,
        inputTokens: safeSum(parsed.inputTokens, turn.inputTokens),
        outputTokens: safeSum(parsed.outputTokens, turn.outputTokens),
        totalTokens: safeSum(parsed.totalTokens, turn.totalTokens),
        cacheHitTokens: safeSum(parsed.cacheHitTokens, turn.inputCache?.hitTokens ?? 0),
        cacheMissTokens: safeSum(parsed.cacheMissTokens, turn.inputCache?.missTokens ?? 0),
        turnsWithUsage: safeSum(parsed.turnsWithUsage, 1),
        cacheUsageComplete: parsed.cacheUsageComplete && turn.inputCache !== undefined
    });
}
