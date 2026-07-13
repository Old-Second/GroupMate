const maxToolOutputBytes = 64 * 1024
const maxMessageBytes = 16 * 1024
const maxContentItems = 32
const codePattern = /^[a-z][a-z0-9_]{0,63}$/
const unsafeErrorDetailPattern = /https?:\/\/|authorization|cookie|rawarguments|responsebody|\bstack\b|\bcause\b/i

export type ToolSuccessEffect = 'none' | 'background' | 'visible'

export type ToolContentItem =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'resource_ref'
      readonly resourceType: string
      readonly resourceId: string
      readonly mimeType?: string
    }

export type ToolContent = readonly ToolContentItem[]

export type ToolDenyCode =
  | 'permission_denied'
  | 'explicit_intent_required'
  | 'current_channel_uses_normal_reply'
  | 'target_invalid'
  | 'target_not_found'
  | 'target_protected'
  | 'bot_permission_denied'
  | 'cross_channel_disabled'
  | 'approval_invalid'
  | 'tool_unavailable'
  | 'invalid_arguments'
  | 'current_message_protected'
  | 'self_unmute_denied'
  | 'self_mute_duration_exceeded'
  | 'role_hierarchy_denied'
  | 'unknown_policy_profile'

export type ToolErrorCode =
  | 'configuration_missing'
  | 'upstream_unavailable'
  | 'tool_timeout'
  | 'tool_cancelled'
  | 'tool_execution_failed'
  | 'tool_invalid_result'
  | 'tool_output_too_large'
  | 'tool_control_unavailable'
  | 'tool_in_progress'
  | 'tool_outcome_unknown'

const denyCodes: ReadonlySet<ToolDenyCode> = new Set([
  'permission_denied',
  'explicit_intent_required',
  'current_channel_uses_normal_reply',
  'target_invalid',
  'target_not_found',
  'target_protected',
  'bot_permission_denied',
  'cross_channel_disabled',
  'approval_invalid',
  'tool_unavailable',
  'invalid_arguments',
  'current_message_protected',
  'self_unmute_denied',
  'self_mute_duration_exceeded',
  'role_hierarchy_denied',
  'unknown_policy_profile'
])

const errorCodes: ReadonlySet<ToolErrorCode> = new Set([
  'configuration_missing',
  'upstream_unavailable',
  'tool_timeout',
  'tool_cancelled',
  'tool_execution_failed',
  'tool_invalid_result',
  'tool_output_too_large',
  'tool_control_unavailable',
  'tool_in_progress',
  'tool_outcome_unknown'
])

export type ToolResult =
  | {
      readonly status: 'success'
      readonly effect: ToolSuccessEffect
      readonly content: ToolContent
      readonly retryable: false
    }
  | {
      readonly status: 'denied'
      readonly effect: 'none'
      readonly reasonCode: ToolDenyCode
      readonly userMessage: string
      readonly retryable: false
    }
  | {
      readonly status: 'failed'
      readonly effect: 'none'
      readonly errorCode: ToolErrorCode
      readonly userMessage: string
      readonly retryable: boolean
    }
  | {
      readonly status: 'indeterminate'
      readonly effect: 'possible'
      readonly errorCode: 'tool_outcome_unknown'
      readonly userMessage: string
      readonly retryable: false
    }

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys (value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    throw new TypeError('tool result branch contains unknown or missing fields')
  }
}

function assertBoundedString (value: unknown, label: string, maxBytes = maxMessageBytes): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${label} is invalid`)
  }
}

function assertCode (value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !codePattern.test(value)) throw new TypeError(`${label} is invalid`)
}

function assertSafeUserMessage (value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label)
  if (unsafeErrorDetailPattern.test(value)) throw new TypeError(`${label} contains unsafe details`)
}

function parseContent (value: unknown): ToolContent {
  if (!Array.isArray(value) || value.length > maxContentItems) throw new TypeError('tool content is invalid')
  const content = value.map(item => {
    if (!isRecord(item)) throw new TypeError('tool content item is invalid')
    if (item.type === 'text') {
      assertExactKeys(item, ['type', 'text'])
      assertBoundedString(item.text, 'tool content text', maxToolOutputBytes)
      return Object.freeze({ type: 'text' as const, text: item.text })
    }
    if (item.type === 'resource_ref') {
      const keys = item.mimeType === undefined
        ? ['type', 'resourceType', 'resourceId']
        : ['type', 'resourceType', 'resourceId', 'mimeType']
      assertExactKeys(item, keys)
      assertBoundedString(item.resourceType, 'resource type', 256)
      assertBoundedString(item.resourceId, 'resource ID', 4 * 1024)
      if (item.mimeType !== undefined) assertBoundedString(item.mimeType, 'mime type', 256)
      return Object.freeze({
        type: 'resource_ref' as const,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType })
      })
    }
    throw new TypeError('tool content item type is invalid')
  })
  return Object.freeze(content)
}

export function parseToolResult (value: unknown, outputLimitBytes = maxToolOutputBytes): ToolResult {
  if (!isRecord(value) || !Number.isInteger(outputLimitBytes) || outputLimitBytes <= 0 || outputLimitBytes > maxToolOutputBytes) {
    throw new TypeError('tool result is invalid')
  }

  let result: ToolResult
  if (value.status === 'success') {
    assertExactKeys(value, ['status', 'effect', 'content', 'retryable'])
    if (!['none', 'background', 'visible'].includes(value.effect as string) || value.retryable !== false) {
      throw new TypeError('tool success result is invalid')
    }
    result = Object.freeze({
      status: 'success',
      effect: value.effect as ToolSuccessEffect,
      content: parseContent(value.content),
      retryable: false
    })
  } else if (value.status === 'denied') {
    assertExactKeys(value, ['status', 'effect', 'reasonCode', 'userMessage', 'retryable'])
    assertCode(value.reasonCode, 'tool deny code')
    if (!denyCodes.has(value.reasonCode as ToolDenyCode)) throw new TypeError('tool deny code is unknown')
    assertSafeUserMessage(value.userMessage, 'tool denied message')
    if (value.effect !== 'none' || value.retryable !== false) throw new TypeError('tool denied result is invalid')
    result = Object.freeze({
      status: 'denied', effect: 'none', reasonCode: value.reasonCode as ToolDenyCode,
      userMessage: value.userMessage, retryable: false
    })
  } else if (value.status === 'failed') {
    assertExactKeys(value, ['status', 'effect', 'errorCode', 'userMessage', 'retryable'])
    assertCode(value.errorCode, 'tool error code')
    if (!errorCodes.has(value.errorCode as ToolErrorCode)) throw new TypeError('tool error code is unknown')
    assertSafeUserMessage(value.userMessage, 'tool failed message')
    if (value.effect !== 'none' || typeof value.retryable !== 'boolean') throw new TypeError('tool failed result is invalid')
    result = Object.freeze({
      status: 'failed', effect: 'none', errorCode: value.errorCode as ToolErrorCode,
      userMessage: value.userMessage, retryable: value.retryable
    })
  } else if (value.status === 'indeterminate') {
    assertExactKeys(value, ['status', 'effect', 'errorCode', 'userMessage', 'retryable'])
    assertSafeUserMessage(value.userMessage, 'tool indeterminate message')
    if (value.effect !== 'possible' || value.errorCode !== 'tool_outcome_unknown' || value.retryable !== false) {
      throw new TypeError('tool indeterminate result is invalid')
    }
    result = Object.freeze({
      status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
      userMessage: value.userMessage, retryable: false
    })
  } else {
    throw new TypeError('tool result status is invalid')
  }

  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > outputLimitBytes) {
    throw new TypeError('tool result exceeds output byte limit')
  }
  return result
}

export function toolResultForModel (result: ToolResult): string {
  if (result.status !== 'success') return result.userMessage
  const text = result.content
    .map(item => item.type === 'text'
      ? item.text
      : `[${item.resourceType}:${item.resourceId}]`)
    .join('\n')
  return Buffer.byteLength(text, 'utf8') <= maxToolOutputBytes
    ? text
    : Buffer.from(text, 'utf8').subarray(0, maxToolOutputBytes).toString('utf8')
}

export function shouldFinalizeToolResult (result: ToolResult): boolean {
  return result.status === 'success' && result.effect === 'visible'
}
