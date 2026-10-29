import { CONFIGURABLE_TOOL_NAMES } from './tools/tool-availability.js';
const CONTENT_LIST_FIELDS = new Set([
    'blockWords',
    'promptBlockWords',
    'bymFuckList'
]);
const IDENTIFIER_LIST_FIELDS = new Set([
    'initiativeChatGroups',
    'bymDisableGroup'
]);
const GROUP_IDENTIFIER_LIST_FIELDS = new Set([
    'semanticSummaryGroups'
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
const OPENAI_COMPATIBILITY_PROFILES = new Set(['standard', 'deepseek']);
const OBSERVABILITY_LEVELS = new Set(['off', 'basic', 'diagnostic']);
const PERSONAL_MEMORY_MODES = new Set(['off', 'explicit', 'shadow', 'automatic']);
const PERSONAL_MEMORY_MAINTENANCE_ACTIONS = new Set(['none', 'verify', 'rebuild_lexical']);
const GUOBA_SECRET_MAXIMUM_UTF8_BYTES = 16 * 1_024;
export const PERSONAL_MEMORY_CONFIG_DEFAULTS = Object.freeze({
    personalMemoryMode: 'automatic',
    personalMemoryRecallMaxItems: 6,
    personalMemoryRecallMaxTokens: 1_200,
    personalMemoryRecallTimeoutMs: 150
});
export const GUOBA_MASKED_SECRET_FIELDS = Object.freeze([
    'apiKey',
    'tavilyApiKey',
    'azSerpKey',
    'braveSearchApiKey',
    'amapKey',
    'githubAPIKey',
    'azureTTSKey',
    'sunoSessToken',
    'sunoClientToken'
]);
const GUOBA_MASKED_SECRET_FIELD_SET = new Set(GUOBA_MASKED_SECRET_FIELDS);
export const RESTART_REQUIRED_CONFIG_FIELDS = new Set([
    'toggleMode',
    'apiKey',
    'openAiBaseUrl',
    'openAiCompatibilityProfile',
    'apiContextWindowTokens',
    'proxy',
    'headless',
    'chromePath',
    'diskLogEnabled',
    'personalMemoryMode',
    'semanticSummaryGroups',
    'personalMemoryRecallMaxItems',
    'personalMemoryRecallMaxTokens',
    'personalMemoryRecallTimeoutMs',
    'hostImageLinkRefresh',
    'hostImageLinkProbeBudgetMs'
]);
const SAVED_MESSAGE = '保存成功~';
const RESTART_REQUIRED_MESSAGE = '保存成功；部分模型传输、运行入口、落盘日志或 Chromium 配置将在重启后生效~';
export function guobaConfigSaveMessage(changedFields, priorityMessage = null) {
    if (priorityMessage !== null)
        return priorityMessage;
    for (const field of changedFields) {
        if (RESTART_REQUIRED_CONFIG_FIELDS.has(field))
            return RESTART_REQUIRED_MESSAGE;
    }
    return SAVED_MESSAGE;
}
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
function boundedPersonalMemoryInteger(value, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 ||
        value > maximum || Object.is(value, -0)) {
        throw new TypeError('长期记忆召回预算配置无效。');
    }
    return value;
}
function exactDataEntries(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value)) {
        throw new TypeError('Guoba 配置数据无效。');
    }
    const entries = [];
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Guoba 配置数据无效。');
        }
        entries.push(Object.freeze([key, descriptor.value]));
    }
    return Object.freeze(entries);
}
export function buildGuobaConfigPatch(value, options) {
    if (options.current === null || typeof options.current !== 'object' ||
        Array.isArray(options.current))
        throw new TypeError('Guoba 配置数据无效。');
    const supported = new Set(options.supportedKeys);
    const virtual = new Set(options.virtualKeys ?? []);
    const patch = {};
    for (const [key, raw] of exactDataEntries(value)) {
        if (!supported.has(key) && !virtual.has(key))
            continue;
        if (GUOBA_MASKED_SECRET_FIELD_SET.has(key)) {
            if (raw === '' || raw === null || raw === undefined)
                continue;
            if (typeof raw !== 'string' || raw.includes('\0') ||
                Buffer.byteLength(raw, 'utf8') > GUOBA_SECRET_MAXIMUM_UTF8_BYTES) {
                throw new TypeError('Guoba 密钥配置无效。');
            }
        }
        patch[key] = normalizeGuobaConfigValue(key, raw);
    }
    // The trigger and keep shares use different bases: the trigger is a share of
    // the available input budget (or an absolute token mark when configured), the
    // keep share is a share of the history present at the fold. A keep value at or
    // above the trigger is therefore a valid, deliberate choice and only the
    // per-field ranges are enforced here.
    return Object.freeze(patch);
}
export function normalizeGuobaConfigValue(key, value) {
    if (key === 'disabledTools') {
        if (!Array.isArray(value) || value.length > CONFIGURABLE_TOOL_NAMES.length ||
            value.some(name => typeof name !== 'string' || !CONFIGURABLE_TOOL_NAMES.includes(name)) ||
            new Set(value).size !== value.length)
            throw new TypeError('隐藏工具列表无效，请选择工具的标准名称。');
        return Object.freeze([...value]);
    }
    if (key === 'participationMode') {
        if (value !== 'legacy' && value !== 'shadow' && value !== 'active')
            throw new TypeError('群参与模式配置无效。');
        return value;
    }
    if (key === 'participationActiveGroups' || key === 'semanticSummaryGroups') {
        if (!Array.isArray(value) || value.length > 64 || value.some(group => typeof group !== 'string' || !/^[1-9]\d{0,19}$/.test(group)) ||
            new Set(value).size !== value.length)
            throw new TypeError('受控参与群列表配置无效。');
        return Object.freeze([...value]);
    }
    if (key === 'personalMemoryMode') {
        if (typeof value !== 'string' || !PERSONAL_MEMORY_MODES.has(value)) {
            throw new TypeError('长期记忆模式配置无效。');
        }
        return value;
    }
    if (key === 'personalMemoryMaintenanceAction') {
        if (typeof value !== 'string' || !PERSONAL_MEMORY_MAINTENANCE_ACTIONS.has(value)) {
            throw new TypeError('长期记忆维护动作无效。');
        }
        return value;
    }
    if (key === 'personalMemoryRecallMaxItems') {
        return boundedPersonalMemoryInteger(value, 12);
    }
    if (key === 'personalMemoryRecallMaxTokens') {
        return boundedPersonalMemoryInteger(value, 2_400);
    }
    if (key === 'personalMemoryRecallTimeoutMs') {
        return boundedPersonalMemoryInteger(value, 500);
    }
    if (key === 'conversationPreferencesEnabled') {
        if (typeof value !== 'boolean') {
            throw new TypeError('对话偏好开关配置无效。');
        }
        return value;
    }
    if (key === 'hostImageLinkRefresh') {
        if (typeof value !== 'boolean') {
            throw new TypeError('历史图片链接续签配置无效。');
        }
        return value;
    }
    if (key === 'hostImageLinkProbeBudgetMs') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 3_000) {
            throw new TypeError('历史图片链接探测预算配置无效。');
        }
        return value;
    }
    if (key === 'apiContextWindowTokens') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 16_777_216) {
            throw new TypeError('模型上下文窗口配置无效。');
        }
        return value;
    }
    if (key === 'contextCompactionEnabled') {
        if (typeof value !== 'boolean') {
            throw new TypeError('会话压缩开关配置无效。');
        }
        return value;
    }
    if (key === 'contextCompactionTriggerPercent') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 1 || value > 99) {
            throw new TypeError('会话压缩触发比例配置无效，应为 1-99。');
        }
        return value;
    }
    if (key === 'contextCompactionTriggerTokens') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 16_777_216) {
            throw new TypeError('会话压缩触发 Token 配置无效，应为 0-16777216。');
        }
        return value;
    }
    if (key === 'contextCompactionKeepPercent') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 1 || value > 98) {
            throw new TypeError('会话压缩保留比例配置无效，应为 1-98。');
        }
        return value;
    }
    if (key === 'contextCompactionSummaryMaxChars') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 200 || value > 20_000) {
            throw new TypeError('历史摘要字符上限配置无效，应为 200-20000。');
        }
        return value;
    }
    if (key === 'contextPrefixCacheIdleMinutes') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 43_200) {
            throw new TypeError('前缀缓存空闲时间配置无效，应为 0-43200 分钟。');
        }
        return value;
    }
    if (key === 'contextCompactionMinReclaimTokens') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 1_000_000) {
            throw new TypeError('提前压缩最小回收 Token 配置无效。');
        }
        return value;
    }
    if (key === 'observabilityLevel') {
        if (typeof value !== 'string' || !OBSERVABILITY_LEVELS.has(value)) {
            throw new TypeError('可观测性级别配置无效。');
        }
        return value;
    }
    if (key === 'observationSuccessSampleRate') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            value < 0 || value > 100) {
            throw new TypeError('成功轨迹采样率配置无效，应为 0-100。');
        }
        return value;
    }
    if (key === 'usageAggregationEnabled') {
        if (typeof value !== 'boolean') {
            throw new TypeError('用量聚合配置无效。');
        }
        return value;
    }
    if (key === 'turnConfirm') {
        if (typeof value !== 'boolean') {
            throw new TypeError('正在思考提示配置无效。');
        }
        return value;
    }
    if (key === 'openAiCompatibilityProfile') {
        if (typeof value !== 'string' || !OPENAI_COMPATIBILITY_PROFILES.has(value)) {
            throw new TypeError('OpenAI API 兼容配置无效。');
        }
        return value;
    }
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
    if (GROUP_IDENTIFIER_LIST_FIELDS.has(key)) {
        return splitList(value, /[,，;；|\s]/)
            .filter(item => /^[1-9]\d{5,9}$/.test(item));
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
import { types as utilTypes } from 'node:util';
