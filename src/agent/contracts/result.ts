import { parseAgentMessage, type AgentMessage } from './content.js'
import {
  parseCompletionDisposition,
  type CompletionDisposition
} from './completion.js'
import { isAgentErrorCode, type SerializedAgentError } from './error.js'
import {
  parseApprovalInterruption,
  type ApprovalInterruption
} from '../run/interruption.js'
import {
  parseRunTerminalSnapshot,
  type CompletionObservation,
  type RunTerminalSnapshotV2
} from '../run/run-observation.js'
import { RUN_REF_PATTERN } from '../run/run-reference.js'
import {
  parseTerminalCommitReceipt,
  type TerminalCommitReceiptV1
} from '../run/run-store.js'
import {
  parsePresentationTrace,
  type PresentationTrace
} from './presentation-trace.js'

export type AgentResult =
  | { readonly status: 'completed'; readonly completion: CompletionDisposition }
  | { readonly status: 'failed'; readonly error: SerializedAgentError }
  | { readonly status: 'cancelled'; readonly reason: string }

export interface TerminalFactsV1 {
  readonly snapshot: RunTerminalSnapshotV2
  readonly receipt: TerminalCommitReceiptV1
}

export type RunAdvanceResult =
  | {
      readonly kind: 'completed'
      readonly runId: string
      readonly runRef: string
      readonly completion: CompletionDisposition
      readonly output: AgentMessage | null
      readonly presentationTrace: PresentationTrace
      readonly terminal: TerminalFactsV1
    }
  | {
      readonly kind: 'paused'
      readonly runId: string
      readonly runRef: string
      readonly interruption: ApprovalInterruption
    }
  | {
      readonly kind: 'failed'
      readonly runId: string
      readonly runRef: string | 'unavailable'
      readonly error: SerializedAgentError
      readonly terminal: TerminalFactsV1 | null
    }
  | {
      readonly kind: 'cancelled'
      readonly runId: string
      readonly runRef: string | 'unavailable'
      readonly reason: string
      readonly terminal: TerminalFactsV1 | null
    }

function parseSerializedAgentError (value: unknown): SerializedAgentError {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('agent result error is invalid')
  }
  const error = value as Record<string, unknown>
  const keys = ['code', 'stage', 'retryable', 'userMessage', 'details']
  if (Object.keys(error).some(key => !keys.includes(key))) {
    throw new TypeError('agent result error contains unknown keys')
  }
  if (!isAgentErrorCode(error.code) || typeof error.stage !== 'string' ||
      typeof error.retryable !== 'boolean' || typeof error.userMessage !== 'string') {
    throw new TypeError('agent result error fields are invalid')
  }
  if (error.details === null || typeof error.details !== 'object' || Array.isArray(error.details)) {
    throw new TypeError('agent result error details are invalid')
  }
  for (const detail of Object.values(error.details)) {
    if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
      throw new TypeError('agent result error details contain non-primitive data')
    }
    if (typeof detail === 'number' && !Number.isFinite(detail)) {
      throw new TypeError('agent result error details contain a non-finite number')
    }
  }
  return value as SerializedAgentError
}

export function parseAgentResult (value: unknown): AgentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('agent result must be an object')
  const result = value as Record<string, unknown>
  const allowed = result.status === 'completed'
    ? ['status', 'completion']
    : result.status === 'failed'
      ? ['status', 'error']
      : result.status === 'cancelled'
        ? ['status', 'reason']
        : []
  if (allowed.length === 0 || Object.keys(result).some(key => !allowed.includes(key))) {
    throw new TypeError('agent result branch is invalid')
  }
  if (result.status === 'completed') {
    return Object.freeze({
      status: 'completed',
      completion: parseCompletionDisposition(result.completion)
    })
  }
  if (result.status === 'failed') parseSerializedAgentError(result.error)
  if (result.status === 'cancelled' && (typeof result.reason !== 'string' || result.reason.length === 0)) {
    throw new TypeError('agent result cancellation reason is invalid')
  }
  return value as AgentResult
}

function canonicalOutputText (value: AgentMessage): string {
  const output = parseAgentMessage(value)
  if (output.role !== 'assistant' || output.parts.length !== 1 ||
    output.parts[0]?.type !== 'text' || 'replyTo' in output) {
    throw new TypeError('completed run output is invalid')
  }
  const text = output.parts[0].text.trim().normalize('NFC')
  if (text.length === 0) throw new TypeError('completed run output is invalid')
  return text
}

function parseRunRef (value: unknown, allowUnavailable: boolean): string | 'unavailable' {
  if (allowUnavailable && value === 'unavailable') return value
  if (typeof value !== 'string' || !RUN_REF_PATTERN.test(value)) {
    throw new TypeError('run advance result run reference is invalid')
  }
  return value
}

function exactOwnKeys (
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Reflect.ownKeys(value)
  const unknown = actual.find(key => typeof key !== 'string' || !keys.includes(key))
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (unknown !== undefined) throw new TypeError(`${label} contains an unknown key`)
  if (missing !== undefined || actual.length !== keys.length) {
    throw new TypeError(`${label} key is missing`)
  }
}

function parseTerminalFacts (value: unknown): TerminalFactsV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run terminal facts are invalid')
  }
  exactOwnKeys(
    value as Record<PropertyKey, unknown>,
    ['snapshot', 'receipt'],
    'run terminal facts'
  )
  const terminal = value as Record<string, unknown>
  const snapshot = parseRunTerminalSnapshot(terminal.snapshot)
  const receipt = parseTerminalCommitReceipt(terminal.receipt)
  if (snapshot.observationId !== receipt.observationId ||
    snapshot.runRef !== receipt.runRef || snapshot.revision !== receipt.revision) {
    throw new TypeError('run terminal facts identities do not match')
  }
  return Object.freeze({ snapshot, receipt })
}

function completionObservation (
  completion: CompletionDisposition
): CompletionObservation {
  if (completion.kind === 'already_visible') {
    return Object.freeze({ kind: 'already_visible', source: 'tool_output' })
  }
  if (completion.kind === 'allowed_silence') {
    return Object.freeze({
      kind: 'allowed_silence',
      reason: 'proactive_empty_directive'
    })
  }
  const length = [...completion.text].length
  return Object.freeze({
    kind: 'reply_text',
    lengthBucket: length <= 40
      ? '1_40'
      : length <= 200
        ? '41_200'
        : length <= 1_000
          ? '201_1000'
          : length <= 4_000
            ? '1001_4000'
            : 'over_4000'
  })
}

const TERMINAL_CANCELLATION_REASONS = new Set([
  'user_cancelled',
  'deadline_exceeded',
  'process_shutdown',
  'approval_delivery_failed',
  'service_failure',
  'fatal_error',
  'other'
])

function cancellationObservation (reason: string): string {
  return TERMINAL_CANCELLATION_REASONS.has(reason) ? reason : 'other'
}

export function parseRunAdvanceResult (value: unknown): RunAdvanceResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run advance result must be an object')
  }
  const result = value as Record<string, unknown>
  if (typeof result.runId !== 'string' || result.runId.length === 0 || result.runId.length > 128) {
    throw new TypeError('run advance result run ID is invalid')
  }
  const allowed = result.kind === 'completed'
    ? ['kind', 'runId', 'runRef', 'completion', 'output', 'presentationTrace', 'terminal']
    : result.kind === 'paused'
      ? ['kind', 'runId', 'runRef', 'interruption']
      : result.kind === 'failed'
      ? ['kind', 'runId', 'runRef', 'error', 'terminal']
        : result.kind === 'cancelled'
          ? ['kind', 'runId', 'runRef', 'reason', 'terminal']
          : []
  if (allowed.length === 0) {
    throw new TypeError('run advance result branch is invalid')
  }
  exactOwnKeys(result, allowed, 'run advance result')
  const runRef = parseRunRef(
    result.runRef,
    result.kind === 'failed' || result.kind === 'cancelled'
  )
  const terminal = result.kind === 'paused' || result.terminal === null
    ? null
    : parseTerminalFacts(result.terminal)
  if (result.kind === 'completed' && terminal === null) {
    throw new TypeError('completed run terminal facts are missing')
  }
  if (terminal !== null && (terminal.snapshot.status !== result.kind ||
    runRef === 'unavailable' || terminal.snapshot.runRef !== runRef)) {
    throw new TypeError('run terminal facts do not match the result branch')
  }
  if (result.kind === 'completed') {
    const completion = parseCompletionDisposition(result.completion)
    parsePresentationTrace(result.presentationTrace)
    if (completion.kind === 'already_visible') {
      if (result.output !== null) throw new TypeError('completed run output is invalid')
    } else {
      if (result.output === null) throw new TypeError('completed run output is invalid')
      const text = canonicalOutputText(result.output as AgentMessage)
      if ((completion.kind === 'reply_text' && text !== completion.text) ||
        (completion.kind === 'allowed_silence' && text !== '<EMPTY>')) {
        throw new TypeError('completed run completion does not match its output')
      }
    }
    if (terminal === null ||
      JSON.stringify(completionObservation(completion)) !==
        JSON.stringify(terminal.snapshot.completion)) {
      throw new TypeError('completed run completion does not match terminal facts')
    }
  }
  if (result.kind === 'paused') {
    const interruption = parseApprovalInterruption(result.interruption)
    if (interruption.runId !== result.runId) {
      throw new TypeError('paused run interruption does not match the run')
    }
  }
  if (result.kind === 'failed') {
    const error = parseSerializedAgentError(result.error)
    if (terminal !== null && terminal.snapshot.errorCode !== error.code) {
      throw new TypeError('failed run error does not match terminal facts')
    }
  }
  if (result.kind === 'cancelled' &&
      (typeof result.reason !== 'string' || result.reason.length === 0 || result.reason.length > 128)) {
    throw new TypeError('run cancellation reason is invalid')
  }
  if (result.kind === 'cancelled' && terminal !== null &&
    terminal.snapshot.cancellationReason !== cancellationObservation(result.reason as string)) {
    throw new TypeError('cancelled run reason does not match terminal facts')
  }
  return value as RunAdvanceResult
}
