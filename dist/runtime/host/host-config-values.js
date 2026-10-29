export function normalizedText(value, maximum, fallback = '') {
    if (typeof value !== 'string')
        return fallback;
    const normalized = value.normalize('NFC').trim();
    if (normalized === '')
        return fallback;
    return [...normalized].slice(0, maximum).join('');
}
export function normalizedStringList(value, maximumItems = 256, maximumCharacters = 128) {
    if (!Array.isArray(value) && typeof value !== 'string')
        return Object.freeze([]);
    const source = Array.isArray(value) ? value : [value];
    const result = [];
    const seen = new Set();
    for (const item of source) {
        if (result.length >= maximumItems)
            break;
        if (typeof item !== 'string')
            continue;
        const normalized = normalizedText(item, maximumCharacters);
        if (normalized === '' || seen.has(normalized))
            continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return Object.freeze(result);
}
export function finiteInteger(value, fallback, minimum, maximum) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
        : fallback;
}
export function finiteNumber(value, fallback, minimum, maximum) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, minimum), maximum)
        : fallback;
}
const THINKING_MODES = Object.freeze(['enabled', 'disabled']);
export function configuredThinkingMode(value) {
    return THINKING_MODES.find(item => item === value) ?? 'default';
}
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function configuredReasoningEffort(value) {
    return REASONING_EFFORTS.find(item => item === value) ?? 'default';
}
