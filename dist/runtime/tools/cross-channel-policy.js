const audienceValues = new Set([
    'disabled',
    'master',
    'everyone'
]);
function audience(value, defaultValue) {
    if (value === undefined)
        return defaultValue;
    return typeof value === 'string' && audienceValues.has(value)
        ? value
        : 'disabled';
}
export function migrateLegacyCrossChannelPolicies(source) {
    const migrated = { ...source };
    if (!Object.hasOwn(source, 'toolPrivateSendPolicy') && Object.hasOwn(source, 'enableToolPrivateSend')) {
        migrated.toolPrivateSendPolicy = source.enableToolPrivateSend === true ? 'master' : 'disabled';
    }
    if (!Object.hasOwn(source, 'toolCrossGroupSendPolicy') && Object.hasOwn(source, 'enableToolCrossGroupSend')) {
        migrated.toolCrossGroupSendPolicy = source.enableToolCrossGroupSend === true ? 'master' : 'disabled';
    }
    return migrated;
}
export function resolveCrossChannelAccess(source) {
    const migrated = migrateLegacyCrossChannelPolicies(source);
    return Object.freeze({
        private: audience(migrated.toolPrivateSendPolicy, 'master'),
        group: audience(migrated.toolCrossGroupSendPolicy, 'disabled')
    });
}
