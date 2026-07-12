const CONTENT_LIST_FIELDS = new Set([
    'blockWords',
    'promptBlockWords',
    'bymFuckList'
]);
const IDENTIFIER_LIST_FIELDS = new Set([
    'initiativeChatGroups',
    'bymDisableGroup'
]);
const QQ_SCOPE_FIELDS = new Set([
    'whitelist',
    'blacklist'
]);
const QQ_IDENTIFIER_FIELDS = new Set([
    'bymFuckBlacklist'
]);
function splitList(value, separator) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(separator);
    const seen = new Set();
    return values.reduce((result, item) => {
        const normalized = String(item).trim();
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
        }
        return result;
    }, []);
}
export function normalizeGuobaConfigValue(key, value) {
    if (CONTENT_LIST_FIELDS.has(key)) {
        return splitList(value, /[,，;；|]/);
    }
    if (IDENTIFIER_LIST_FIELDS.has(key)) {
        return splitList(value, /[,，;；|\s]/);
    }
    if (QQ_SCOPE_FIELDS.has(key)) {
        return splitList(value, /[,，;；|\s]/)
            .filter(item => /^\^?[1-9]\d{5,9}(\^[1-9]\d{5,9})?$/.test(item));
    }
    if (QQ_IDENTIFIER_FIELDS.has(key)) {
        return splitList(value, /[,，;；|\s]/)
            .filter(item => /^[1-9]\d{5,9}$/.test(item));
    }
    return value;
}
