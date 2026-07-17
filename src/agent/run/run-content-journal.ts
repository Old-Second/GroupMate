import type { SerializedAgentError } from '../contracts/error.js'
import type { ModelRequest, ModelTurn } from '../model/model-adapter.js'
import type { RunCheckpoint } from './run-checkpoint.js'
import type { TerminalCommitReceiptV1 } from './run-store.js'
import type { ProviderAttemptEventPayloadV1 } from './run-trace.js'

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
  readonly request: ModelRequest
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
