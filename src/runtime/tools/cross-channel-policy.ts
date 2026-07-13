import type {
  CrossChannelAccess,
  CrossChannelAudience
} from '../../agent/tools/cross-channel-access.js'

const audienceValues = new Set<CrossChannelAudience>([
  'disabled',
  'master',
  'everyone'
])

function audience (value: unknown, defaultValue: CrossChannelAudience): CrossChannelAudience {
  if (value === undefined) return defaultValue
  return typeof value === 'string' && audienceValues.has(value as CrossChannelAudience)
    ? value as CrossChannelAudience
    : 'disabled'
}

export function migrateLegacyCrossChannelPolicies (
  source: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const migrated = { ...source }
  if (!Object.hasOwn(source, 'toolPrivateSendPolicy') && Object.hasOwn(source, 'enableToolPrivateSend')) {
    migrated.toolPrivateSendPolicy = source.enableToolPrivateSend === true ? 'master' : 'disabled'
  }
  if (!Object.hasOwn(source, 'toolCrossGroupSendPolicy') && Object.hasOwn(source, 'enableToolCrossGroupSend')) {
    migrated.toolCrossGroupSendPolicy = source.enableToolCrossGroupSend === true ? 'master' : 'disabled'
  }
  return migrated
}

export function resolveCrossChannelAccess (
  source: Readonly<Record<string, unknown>>
): CrossChannelAccess {
  const migrated = migrateLegacyCrossChannelPolicies(source)
  return Object.freeze({
    private: audience(migrated.toolPrivateSendPolicy, 'master'),
    group: audience(migrated.toolCrossGroupSendPolicy, 'disabled')
  })
}
