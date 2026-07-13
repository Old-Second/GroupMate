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
const TOOL_POLICY_PROFILES = new Set(['compatible', 'safe', 'strict']);
const CROSS_CHANNEL_POLICIES = new Set(['disabled', 'master', 'everyone']);
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
    if (key === 'toolPrivateSendPolicy' || key === 'toolCrossGroupSendPolicy') {
        if (typeof value !== 'string' || !CROSS_CHANNEL_POLICIES.has(value)) {
            throw new TypeError('工具跨会话发送权限配置无效。');
        }
        return value;
    }
    if (key === 'toolPolicyProfile') {
        if (typeof value !== 'string' || !TOOL_POLICY_PROFILES.has(value)) {
            throw new TypeError('工具权限策略配置无效。');
        }
        return value;
    }
    if (key === 'toolApprovalTtlSeconds') {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.min(Math.max(Math.trunc(value), 30), 300)
            : 120;
    }
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
