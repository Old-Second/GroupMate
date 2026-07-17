import {
  type RunTerminalSnapshotV2
} from '../agent/run/run-observation.js'
import {
  type TerminalCommitReceiptV1
} from '../agent/run/run-store.js'
import { readChatErrorMetadata } from './chat-error-presentation.js'
import { parseObservationEvent } from './observability/observation-event.js'

export {
  SafeObservationFailureLogLimiter,
  createObservationSinkFailureLog,
  createPresentationObservationLog,
  createRequestObservationLog
} from './observability/safe-observation-logging.js'

type UnknownRecord = Record<string, unknown>

const TERMINAL_SNAPSHOT_LOG_KEYS = Object.freeze([
  'schemaVersion',
  'observationId',
  'runRef',
  'revision',
  'status',
  'finishedAt',
  'completion',
  'errorCode',
  'cancellationReason',
  'counters',
  'engineDurationMs'
])
const TERMINAL_RECEIPT_LOG_KEYS = Object.freeze([
  'schemaVersion',
  'observationId',
  'runRef',
  'revision',
  'deletedKeyCount',
  'createdKeyCount',
  'checkpointBytesDeleted',
  'eventBytesDeleted',
  'tombstoneBytes'
])

interface ChatRequestLogInput {
  mode?: unknown
  stream?: unknown
  prompt?: unknown
}

interface ChatResponseLogInput {
  mode?: unknown
  response?: unknown
}

interface ChatErrorLogInput {
  mode?: unknown
  error?: unknown
  category?: unknown
}

interface MessageInputLogInput {
  prompt?: unknown
  imageUrls?: unknown
  hasReply?: unknown
  replyResolved?: unknown
  currentSegmentCount?: unknown
  replySegmentCount?: unknown
}

function isRecord (value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function projectOwnData (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const input = value as Record<PropertyKey, unknown>
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} property is invalid`)
    }
    output[key] = descriptor.value
  }
  return output
}

function getSafeMode (mode: unknown): string {
  return typeof mode === 'string' && /^[a-z0-9_-]{1,32}$/i.test(mode)
    ? mode
    : 'unknown'
}

function getStringLength (value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}

function getSafeCount (value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function getSafeToken (value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : 'unknown'
}

export function createChatRequestLog ({ mode, stream, prompt }: ChatRequestLogInput) {
  return {
    event: 'chat.request',
    mode: getSafeMode(mode),
    stream: stream === true,
    promptCharacters: getStringLength(prompt)
  } as const
}

export function createChatResponseLog ({ mode, response }: ChatResponseLogInput) {
  const value = isRecord(response) ? response : {}
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.length : 0
  const hasFunctionCall = isRecord(value.functionCall)
  const thinkingSegments = Array.isArray(value.thinking_segments)
    ? value.thinking_segments.length
    : 0

  return {
    event: 'chat.response',
    mode: getSafeMode(mode),
    textCharacters: getStringLength(value.text),
    hasThinking: getStringLength(value.thinking_text) > 0 || thinkingSegments > 0,
    toolCallCount: toolCalls || (hasFunctionCall ? 1 : 0),
    failed: Boolean(value.error)
  } as const
}

export function createChatErrorLog ({ mode, error, category }: ChatErrorLogInput) {
  const metadata = readChatErrorMetadata(error)

  return {
    event: 'chat.error',
    mode: getSafeMode(mode),
    category: getSafeToken(category),
    error: getSafeToken(metadata.name),
    code: getSafeToken(metadata.code),
    statusCode: metadata.statusCode
  } as const
}

export function createMessageInputLog (input: MessageInputLogInput) {
  return {
    event: 'chat.input.context',
    hasReply: input.hasReply === true,
    replyResolved: input.replyResolved === true,
    currentSegmentCount: getSafeCount(input.currentSegmentCount),
    replySegmentCount: getSafeCount(input.replySegmentCount),
    imageCount: Array.isArray(input.imageUrls) ? input.imageUrls.length : 0,
    promptCharacters: getStringLength(input.prompt)
  } as const
}

export function createAgentRunLog (
  snapshotValue: RunTerminalSnapshotV2,
  receiptValue: TerminalCommitReceiptV1
) {
  const snapshot = parseObservationEvent({
    schemaVersion: 1,
    type: 'terminal_snapshot',
    value: projectOwnData(
      snapshotValue,
      TERMINAL_SNAPSHOT_LOG_KEYS,
      'terminal snapshot log input'
    )
  }).value as RunTerminalSnapshotV2
  const receipt = parseObservationEvent({
    schemaVersion: 1,
    type: 'terminal_commit',
    value: projectOwnData(
      receiptValue,
      TERMINAL_RECEIPT_LOG_KEYS,
      'terminal receipt log input'
    )
  }).value as TerminalCommitReceiptV1
  if (snapshot.observationId !== receipt.observationId ||
    snapshot.runRef !== receipt.runRef || snapshot.revision !== receipt.revision) {
    throw new TypeError('agent run facts do not match')
  }
  return Object.freeze({
    event: 'agent.run',
    observationId: snapshot.observationId,
    runRef: snapshot.runRef,
    revision: snapshot.revision,
    status: snapshot.status,
    completion: snapshot.completion,
    errorCode: snapshot.errorCode,
    cancellationReason: snapshot.cancellationReason,
    providerAttempts: snapshot.counters.providerAttempts,
    modelTurns: snapshot.counters.modelTurns,
    toolAttempts: snapshot.counters.toolAttempts,
    providerRetries: snapshot.counters.providerRetries,
    recoveryAttempts: snapshot.counters.recoveryAttempts,
    correctionTurns: snapshot.counters.correctionTurns,
    toolCalls: snapshot.counters.toolCalls,
    approvalRequests: snapshot.counters.approvalRequests,
    toolDenied: snapshot.counters.toolDenied,
    toolExpired: snapshot.counters.toolExpired,
    toolIndeterminate: snapshot.counters.toolIndeterminate,
    estimatedTokens: snapshot.counters.estimatedTokens,
    providerInputTokens: snapshot.counters.providerInputTokens,
    providerOutputTokens: snapshot.counters.providerOutputTokens,
    providerTotalTokens: snapshot.counters.providerTotalTokens,
    providerActiveDurationMs: snapshot.counters.providerActiveDurationMs,
    engineDurationMs: snapshot.engineDurationMs,
    deletedKeyCount: receipt.deletedKeyCount,
    createdKeyCount: receipt.createdKeyCount,
    checkpointBytesDeleted: receipt.checkpointBytesDeleted,
    eventBytesDeleted: receipt.eventBytesDeleted,
    tombstoneBytes: receipt.tombstoneBytes
  })
}
