import type { TerminalRunStatus } from '../../agent/run/run-state.js'
import type { TraceCandidateV1 } from '../../agent/run/run-trace.js'
import type { PresentationObservationV1 } from './observation-event.js'
import type { ObservabilityLevel } from './trace-policy.js'
import type { StoredTraceRecordV1 } from './trace-record.js'

export type TraceRetentionV1 =
  | 'diagnostic'
  | 'failed'
  | 'cancelled'
  | 'sampled_success'
  | 'presentation_anomaly'

export type TraceLookupResult =
  | { readonly kind: 'found'; readonly record: StoredTraceRecordV1 }
  | { readonly kind: 'not_retained' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'corrupt' }

export type TraceWriteReceiptV1 =
  | { readonly schemaVersion: 1; readonly kind: 'stored' }
  | { readonly schemaVersion: 1; readonly kind: 'unchanged' }
  | {
      readonly schemaVersion: 1
      readonly kind: 'rejected'
      readonly code:
        | 'not_found'
        | 'expired'
        | 'conflict'
        | 'corrupt'
        | 'capacity'
        | 'stale_generation'
    }

export interface TraceSummaryV1 {
  readonly schemaVersion: 1
  readonly runRef: string
  readonly outcome: TerminalRunStatus
  readonly retention: TraceRetentionV1
  readonly finishedAt: string
}

export interface TraceUsageV1 {
  readonly schemaVersion: 1
  readonly records: number
  readonly bytes: number
}

export interface TraceClearReceiptV1 {
  readonly schemaVersion: 1
  readonly removedRecords: number
  readonly removedBytes: number
  readonly remainingRecords: number
  readonly remainingBytes: number
}

export interface TraceOffBarrierReceiptV1 {
  readonly schemaVersion: 1
  readonly generation: number
  readonly clear: TraceClearReceiptV1
}

export interface TraceRecorderSnapshotV1 {
  readonly schemaVersion: 1
  readonly currentLevel: ObservabilityLevel
  readonly committedCandidateWait: 0 | 1 | 2
  readonly presentationWait: 0 | 1 | 2
}

export interface TraceStore {
  upsertEngine(candidate: TraceCandidateV1): Promise<TraceWriteReceiptV1>
  appendPresentation(observation: PresentationObservationV1): Promise<TraceWriteReceiptV1>
  load(runRef: string): Promise<TraceLookupResult>
  listRecent(limit: number): Promise<readonly TraceSummaryV1[]>
  usage(): Promise<TraceUsageV1>
  clear(maxRecords?: number): Promise<TraceClearReceiptV1>
  advanceGenerationAndClear(maxRecords?: number): Promise<TraceOffBarrierReceiptV1>
}
