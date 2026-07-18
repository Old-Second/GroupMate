import type { SerializedAgentError } from '../contracts/error.js'
import type { ModelRequest, ModelTurn } from '../model/model-adapter.js'
import { parseJsonValue } from '../model/json-value.js'
import {
  parseRunCheckpoint,
  type RunCheckpoint
} from './run-checkpoint.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'
import {
  parseTerminalCommitReceipt,
  type TerminalCommitReceiptV1
} from './run-store.js'
import type { ProviderAttemptEventPayloadV1 } from './run-trace.js'

export type JournalModelRequest = Omit<ModelRequest, 'metadata'>

interface ProviderContentJournalEventBase {
  readonly occurredAt: string
  readonly runRef: string
  readonly requestRef: string
  readonly ordinal: number
  readonly attemptKind: ProviderAttemptEventPayloadV1['attemptKind']
}

export interface ProviderRequestContentJournalEvent
  extends ProviderContentJournalEventBase {
  readonly type: 'provider.request'
  readonly request: JournalModelRequest
}

export interface ProviderResponseContentJournalEvent
  extends ProviderContentJournalEventBase {
  readonly type: 'provider.response'
  readonly turn: ModelTurn
}

export interface ProviderFailureContentJournalEvent
  extends ProviderContentJournalEventBase {
  readonly type: 'provider.failure'
  readonly error: SerializedAgentError
}

export interface RunTerminalCommittedContentJournalEvent {
  readonly type: 'run.terminal_committed'
  readonly occurredAt: string
  readonly runRef: string
  readonly requestRef: string
  readonly checkpoint: RunCheckpoint
  readonly receipt: TerminalCommitReceiptV1
}

export type RunContentJournalEvent =
  | ProviderRequestContentJournalEvent
  | ProviderResponseContentJournalEvent
  | ProviderFailureContentJournalEvent
  | RunTerminalCommittedContentJournalEvent

export interface RunContentJournal {
  // Synchronous best-effort hook; authoritative run state must never depend on it.
  record(event: RunContentJournalEvent): void
}

export function detachedRunContentSnapshot<T> (
  value: T,
  maxBytes: number
): T {
  return parseJsonValue(value, {
    maxBytes,
    maxDepth: 32,
    maxNodes: 8_192
  }) as unknown as T
}

export function snapshotModelRequestForJournal (
  request: ModelRequest
): JournalModelRequest {
  const projected: JournalModelRequest = Object.freeze({
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    toolMode: request.toolMode,
    streaming: request.streaming,
    maxOutputTokens: request.maxOutputTokens,
    reasoning: request.reasoning,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP })
  })
  return detachedRunContentSnapshot(projected, RUN_RESOURCE_LIMITS.requestBytes)
}

export function snapshotModelTurnForJournal (turn: ModelTurn): ModelTurn {
  return detachedRunContentSnapshot(turn, RUN_RESOURCE_LIMITS.providerResponseBytes)
}

export function snapshotRunCheckpointForJournal (
  checkpoint: RunCheckpoint
): RunCheckpoint {
  return parseRunCheckpoint(checkpoint)
}

export function snapshotTerminalReceiptForJournal (
  receipt: TerminalCommitReceiptV1
): TerminalCommitReceiptV1 {
  return parseTerminalCommitReceipt(receipt)
}
