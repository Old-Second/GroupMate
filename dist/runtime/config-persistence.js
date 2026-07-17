import { isDeepStrictEqual } from 'node:util';
export function resolveForwardToolDetailsSetting(value, forwardReasoning) {
    return typeof value === 'boolean' ? value : forwardReasoning;
}
export function selectPersistedConfig(configuration, defaults) {
    const persisted = {};
    for (const [key, value] of Object.entries(configuration)) {
        if (!isDeepStrictEqual(value, defaults[key])) {
            persisted[key] = value;
        }
    }
    return persisted;
}
export function selectImportableConfig(candidate, supportedKeys) {
    const supported = new Set(supportedKeys);
    return Object.fromEntries(Object.entries(candidate).filter(([key]) => supported.has(key)));
}
