import { parseAgentMessage, type AgentMessage } from './content.js'
import { AgentError } from './error.js'
import type { CheckpointRequestKind } from './interaction.js'

export type CompletionDisposition =
  | { readonly kind: 'reply_text'; readonly text: string }
  | { readonly kind: 'already_visible'; readonly source: 'tool_output' }
  | {
      readonly kind: 'allowed_silence'
      readonly reason: 'proactive_empty_directive'
    }

function normalizedText (value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('completion text must be a string')
  const text = value.trim().normalize('NFC')
  if (text.length === 0) throw new TypeError('completion text must not be empty')
  return text
}

export function parseCompletionDisposition (value: unknown): CompletionDisposition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('completion disposition must be an object')
  }
  const disposition = value as Record<PropertyKey, unknown>
  const entryKeys = Reflect.ownKeys(disposition)
  const unknownEntryKey = entryKeys.find(key =>
    typeof key !== 'string' || !['kind', 'text', 'source', 'reason'].includes(key)
  )
  if (unknownEntryKey !== undefined) {
    throw new TypeError(
      `completion disposition contains unknown key: ${String(unknownEntryKey)}`
    )
  }
  if (!Object.hasOwn(disposition, 'kind')) {
    throw new TypeError('completion disposition key is missing: kind')
  }
  if (disposition.kind === 'reply_text') {
    const keys = Reflect.ownKeys(disposition)
    const unknownKey = keys.find(key => key !== 'kind' && key !== 'text')
    if (unknownKey !== undefined) {
      throw new TypeError(
        `completion disposition contains unknown key: ${String(unknownKey)}`
      )
    }
    if (keys.length !== 2 ||
      !Object.hasOwn(disposition, 'kind') ||
      !Object.hasOwn(disposition, 'text')) {
      throw new TypeError('completion disposition reply keys are invalid')
    }
    return Object.freeze({
      kind: 'reply_text',
      text: normalizedText(disposition.text)
    })
  }
  if (disposition.kind === 'already_visible') {
    const keys = Reflect.ownKeys(disposition)
    const unknownKey = keys.find(key => key !== 'kind' && key !== 'source')
    if (unknownKey !== undefined) {
      throw new TypeError(
        `completion disposition contains unknown key: ${String(unknownKey)}`
      )
    }
    if (keys.length !== 2 ||
      !Object.hasOwn(disposition, 'kind') ||
      !Object.hasOwn(disposition, 'source')) {
      throw new TypeError('completion disposition visibility keys are invalid')
    }
    if (disposition.source !== 'tool_output') {
      throw new TypeError('completion visibility source is invalid')
    }
    return Object.freeze({ kind: 'already_visible', source: 'tool_output' })
  }
  if (disposition.kind === 'allowed_silence') {
    const keys = Reflect.ownKeys(disposition)
    const unknownKey = keys.find(key => key !== 'kind' && key !== 'reason')
    if (unknownKey !== undefined) {
      throw new TypeError(
        `completion disposition contains unknown key: ${String(unknownKey)}`
      )
    }
    if (keys.length !== 2 ||
      !Object.hasOwn(disposition, 'kind') ||
      !Object.hasOwn(disposition, 'reason')) {
      throw new TypeError('completion disposition silence keys are invalid')
    }
    if (disposition.reason !== 'proactive_empty_directive') {
      throw new TypeError('completion silence reason is invalid')
    }
    return Object.freeze({
      kind: 'allowed_silence',
      reason: 'proactive_empty_directive'
    })
  }
  throw new TypeError('completion disposition kind is invalid')
}

function assertRequestKind (value: unknown): asserts value is CheckpointRequestKind {
  if (value !== 'ordinary_chat' && value !== 'proactive_chat' && value !== 'legacy_unknown') {
    throw new TypeError('checkpoint request kind is invalid')
  }
}

function canonicalAssistantText (output: AgentMessage): string {
  const message = parseAgentMessage(output)
  if (message.role !== 'assistant' ||
    message.parts.length !== 1 ||
    message.parts[0]?.type !== 'text' ||
    'replyTo' in message) {
    throw new TypeError('terminal output must be a canonical assistant text message')
  }
  return normalizedText(message.parts[0].text)
}

export function completionFromTerminalOutput (input: {
  readonly requestKind: CheckpointRequestKind
  readonly output: AgentMessage | null
  readonly visibleToolOutput: 'confirmed' | 'none'
}): CompletionDisposition {
  assertRequestKind(input.requestKind)
  if (input.visibleToolOutput === 'confirmed') {
    if (input.output !== null) {
      throw new TypeError('confirmed visible tool output must not include terminal output')
    }
    return parseCompletionDisposition({
      kind: 'already_visible',
      source: 'tool_output'
    })
  }
  if (input.visibleToolOutput !== 'none') {
    throw new TypeError('visible tool output status is invalid')
  }
  if (input.output === null) throw new TypeError('terminal output is required')

  const text = canonicalAssistantText(input.output)
  if (text !== '<EMPTY>') {
    return parseCompletionDisposition({ kind: 'reply_text', text })
  }
  if (input.requestKind === 'ordinary_chat') {
    return parseCompletionDisposition({ kind: 'reply_text', text })
  }
  if (input.requestKind === 'proactive_chat') {
    return parseCompletionDisposition({
      kind: 'allowed_silence',
      reason: 'proactive_empty_directive'
    })
  }
  throw new AgentError({
    code: 'legacy_entry_kind_unavailable',
    stage: 'run.completion',
    retryable: false,
    userMessage: '旧任务缺少可信入口信息，无法安全恢复回复。'
  })
}
