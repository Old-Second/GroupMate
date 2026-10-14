// Search addresses are data, not authority to bypass PolicyFetch. Keep complete
// HTTP(S) URLs; clipping a signed address makes the next tool unusable.
export function httpUrl(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.trim();
    if (text.length === 0 || text.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(text))
        return null;
    try {
        const url = new URL(text);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? text : null;
    }
    catch {
        return null;
    }
}
export function urlIdentity(value) {
    const url = new URL(value);
    url.hash = '';
    return url.href;
}
export function clipText(value, limit) {
    const text = typeof value === 'string' ? value : '';
    if (text.length <= limit)
        return text;
    if (limit === 0)
        return '';
    const last = text.charCodeAt(limit - 1);
    return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)}…`;
}
