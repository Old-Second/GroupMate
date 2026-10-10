import { deepSeekBillingPeriod } from './deepseek-billing-calendar.js';
export const DEEPSEEK_CNY_CATALOG_VERSION = 'deepseek-cny-2026-10-10';
export const DEEPSEEK_PRICE_VERIFIED_AT = Date.parse('2026-10-10T00:00:00.000Z');
export const DEEPSEEK_PRICE_REVIEW_AT = Date.parse('2026-11-09T00:00:00.000Z');
const LEGACY_CATALOG_VERSION = 'deepseek-cny-2026-07-19';
const DEEPSEEK_ALIAS_EXPIRY_MS = Date.parse('2026-07-24T16:00:00.000Z');
const PRICE_KEYS = Object.freeze([
    'schemaVersion',
    'catalogVersion',
    'model',
    'inputCacheHitPicoYuanPerMillionTokens',
    'inputCacheMissPicoYuanPerMillionTokens',
    'outputPicoYuanPerMillionTokens'
]);
const MAX_PRICE_STRING_LENGTH = 128;
export function parseModelPriceSnapshot(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('model price is invalid');
    }
    const input = value;
    const keys = Object.keys(input);
    const boundedString = (item) => typeof item === 'string' &&
        item.length > 0 && item.length <= MAX_PRICE_STRING_LENGTH;
    const rate = (item) => typeof item === 'number' &&
        Number.isSafeInteger(item) && item >= 0;
    if (keys.length !== PRICE_KEYS.length || keys.some(key => !PRICE_KEYS.includes(key)) ||
        input.schemaVersion !== 1 || !boundedString(input.catalogVersion) ||
        !boundedString(input.model) ||
        !rate(input.inputCacheHitPicoYuanPerMillionTokens) ||
        !rate(input.inputCacheMissPicoYuanPerMillionTokens) ||
        !rate(input.outputPicoYuanPerMillionTokens)) {
        throw new TypeError('model price is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        catalogVersion: input.catalogVersion,
        model: input.model,
        inputCacheHitPicoYuanPerMillionTokens: input.inputCacheHitPicoYuanPerMillionTokens,
        inputCacheMissPicoYuanPerMillionTokens: input.inputCacheMissPicoYuanPerMillionTokens,
        outputPicoYuanPerMillionTokens: input.outputPicoYuanPerMillionTokens
    });
}
const DEEPSEEK_V4_FLASH_PRICE = Object.freeze({
    schemaVersion: 1,
    catalogVersion: LEGACY_CATALOG_VERSION,
    model: 'deepseek-v4-flash',
    inputCacheHitPicoYuanPerMillionTokens: 20_000_000_000,
    inputCacheMissPicoYuanPerMillionTokens: 1_000_000_000_000,
    outputPicoYuanPerMillionTokens: 2_000_000_000_000
});
const DEEPSEEK_V4_PRO_PRICE = Object.freeze({
    schemaVersion: 1,
    catalogVersion: LEGACY_CATALOG_VERSION,
    model: 'deepseek-v4-pro',
    inputCacheHitPicoYuanPerMillionTokens: 25_000_000_000,
    inputCacheMissPicoYuanPerMillionTokens: 3_000_000_000_000,
    outputPicoYuanPerMillionTokens: 6_000_000_000_000
});
function isValidNow(value) {
    return Number.isFinite(value.getTime());
}
function canonicalDeepSeekModel(model, now) {
    if (now.getTime() >= DEEPSEEK_PRICE_VERIFIED_AT) {
        if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) {
            return 'deepseek-flash';
        }
        return model === 'deepseek-v4-pro' ? model : undefined;
    }
    if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro')
        return model;
    if ((model === 'deepseek-chat' || model === 'deepseek-reasoner') &&
        now.getTime() < DEEPSEEK_ALIAS_EXPIRY_MS) {
        return 'deepseek-v4-flash';
    }
    return undefined;
}
export function resolveModelPriceSnapshot(model, now = new Date()) {
    if (typeof model !== 'string' || !isValidNow(now)) {
        throw new TypeError('model price lookup is invalid');
    }
    if (now.getTime() >= DEEPSEEK_PRICE_VERIFIED_AT) {
        if (now.getTime() >= DEEPSEEK_PRICE_REVIEW_AT)
            return undefined;
        const canonical = canonicalDeepSeekModel(model, now);
        const period = deepSeekBillingPeriod(now);
        if (canonical === undefined || period === undefined)
            return undefined;
        const multiplier = period === 'peak' ? 2 : 1;
        return parseModelPriceSnapshot({
            schemaVersion: 1,
            catalogVersion: `${DEEPSEEK_CNY_CATALOG_VERSION}-${period}`,
            model: canonical,
            inputCacheHitPicoYuanPerMillionTokens: (canonical === 'deepseek-flash' ? 20_000_000_000 : 150_000_000_000) * multiplier,
            inputCacheMissPicoYuanPerMillionTokens: (canonical === 'deepseek-flash' ? 1_000_000_000_000 : 4_500_000_000_000) * multiplier,
            outputPicoYuanPerMillionTokens: (canonical === 'deepseek-flash' ? 4_000_000_000_000 : 13_500_000_000_000) * multiplier
        });
    }
    switch (canonicalDeepSeekModel(model, now)) {
        case 'deepseek-v4-flash': return parseModelPriceSnapshot(DEEPSEEK_V4_FLASH_PRICE);
        case 'deepseek-v4-pro': return parseModelPriceSnapshot(DEEPSEEK_V4_PRO_PRICE);
        default: return undefined;
    }
}
