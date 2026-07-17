const CONTENT_LIST_FIELDS = new Set([
  'blockWords',
  'promptBlockWords',
  'bymFuckList'
])

const IDENTIFIER_LIST_FIELDS = new Set([
  'initiativeChatGroups',
  'bymDisableGroup'
])

const QQ_SCOPE_FIELDS = new Set([
  'whitelist',
  'blacklist'
])

const QQ_IDENTIFIER_FIELDS = new Set([
  'bymFuckBlacklist'
])

const TOOL_POLICY_PROFILES = new Set(['compatible', 'safe', 'strict'])
const CROSS_CHANNEL_POLICIES = new Set(['disabled', 'master', 'everyone'])
const OPENAI_COMPATIBILITY_PROFILES = new Set(['standard', 'deepseek'])
const OBSERVABILITY_LEVELS = new Set(['off', 'basic', 'diagnostic'])

export const RESTART_REQUIRED_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  'toggleMode',
  'apiKey',
  'openAiBaseUrl',
  'openAiCompatibilityProfile',
  'proxy',
  'headless',
  'chromePath',
  'diskLogEnabled'
])

const SAVED_MESSAGE = '保存成功~'
const RESTART_REQUIRED_MESSAGE = '保存成功；部分模型传输、运行入口、落盘日志或 Chromium 配置将在重启后生效~'

export function guobaConfigSaveMessage (
  changedFields: Iterable<string>,
  priorityMessage: string | null = null
): string {
  if (priorityMessage !== null) return priorityMessage
  for (const field of changedFields) {
    if (RESTART_REQUIRED_CONFIG_FIELDS.has(field)) return RESTART_REQUIRED_MESSAGE
  }
  return SAVED_MESSAGE
}

function splitList (value: unknown, separator: RegExp): string[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(separator)
  const seen = new Set<string>()

  return values.reduce<string[]>((result, item) => {
    const normalized = String(item).trim()
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
    return result
  }, [])
}

export function normalizeGuobaConfigValue (key: string, value: unknown): unknown {
  if (key === 'observabilityLevel') {
    if (typeof value !== 'string' || !OBSERVABILITY_LEVELS.has(value)) {
      throw new TypeError('可观测性级别配置无效。')
    }
    return value
  }

  if (key === 'turnConfirm') {
    if (typeof value !== 'boolean') {
      throw new TypeError('正在思考提示配置无效。')
    }
    return value
  }

  if (key === 'openAiCompatibilityProfile') {
    if (typeof value !== 'string' || !OPENAI_COMPATIBILITY_PROFILES.has(value)) {
      throw new TypeError('OpenAI API 兼容配置无效。')
    }
    return value
  }

  if (key === 'toolPrivateSendPolicy' || key === 'toolCrossGroupSendPolicy') {
    if (typeof value !== 'string' || !CROSS_CHANNEL_POLICIES.has(value)) {
      throw new TypeError('工具跨会话发送权限配置无效。')
    }
    return value
  }

  if (key === 'toolPolicyProfile') {
    if (typeof value !== 'string' || !TOOL_POLICY_PROFILES.has(value)) {
      throw new TypeError('工具权限策略配置无效。')
    }
    return value
  }

  if (key === 'toolApprovalTtlSeconds') {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 30), 300)
      : 120
  }

  if (CONTENT_LIST_FIELDS.has(key)) {
    return splitList(value, /[,，;；|]/)
  }

  if (IDENTIFIER_LIST_FIELDS.has(key)) {
    return splitList(value, /[,，;；|\s]/)
  }

  if (QQ_SCOPE_FIELDS.has(key)) {
    return splitList(value, /[,，;；|\s]/)
      .filter(item => /^\^?[1-9]\d{5,9}(\^[1-9]\d{5,9})?$/.test(item))
  }

  if (QQ_IDENTIFIER_FIELDS.has(key)) {
    return splitList(value, /[,，;；|\s]/)
      .filter(item => /^[1-9]\d{5,9}$/.test(item))
  }

  return value
}
