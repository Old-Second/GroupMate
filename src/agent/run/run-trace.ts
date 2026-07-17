import type { AgentErrorCode } from '../contracts/error.js'
import type {
  DurationBucketCountsV1,
  FrozenObservationPolicyV1,
  RunTerminalSnapshotV2,
  RunTraceMetricSummaryV1
} from './run-observation.js'
import type {
  ToolAttemptOutcome,
  ToolAttemptResultCode
} from './tool-scheduler.js'

export type {
  DurationBucketCountsV1,
  RunTraceMetricSummaryV1
} from './run-observation.js'

export interface TraceEventBaseV1 {
  readonly sequence: number
  readonly occurredAt: string
  readonly durationMs: number | null
}

export interface ProviderAttemptEventPayloadV1 {
  readonly observationSchemaVersion: 1
  readonly attemptKind: 'primary' | 'retry' | 'recovery' | 'correction'
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly durationMs: number
  readonly errorCode: AgentErrorCode | null
}

export interface ToolAttemptEventPayloadV1 {
  readonly observationSchemaVersion: 1
  readonly ordinal: 1 | 2
  readonly outcome: ToolAttemptOutcome
  readonly durationMs: number
  readonly resultCode: ToolAttemptResultCode
}

export interface ProviderTraceEventV1 extends TraceEventBaseV1 {
  readonly type: 'provider_request'
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly attemptKind: 'primary' | 'retry' | 'recovery' | 'correction'
  readonly errorCode: AgentErrorCode | null
}

export interface ToolExecutionTraceEventV1 extends TraceEventBaseV1 {
  readonly type: 'tool_execution'
  readonly outcome: ToolAttemptOutcome
  readonly resultCode: ToolAttemptResultCode
}

export interface ApprovalTraceEventV1 extends TraceEventBaseV1 {
  readonly type: 'approval'
  readonly decision: 'requested' | 'approved' | 'denied' | 'expired'
}

export interface RunStateTraceEventV1 extends TraceEventBaseV1 {
  readonly type: 'run_state'
  readonly state: 'created' | 'paused' | 'resumed' | 'completed' | 'failed' | 'cancelled'
  readonly errorCode: AgentErrorCode | null
}

export interface TraceTruncatedEventV1 {
  readonly type: 'trace_truncated'
  readonly sequence: number
  readonly omittedCount: number
}

export type RunTraceEventV1 =
  | ProviderTraceEventV1
  | ToolExecutionTraceEventV1
  | ApprovalTraceEventV1
  | RunStateTraceEventV1
  | TraceTruncatedEventV1

export interface TraceCandidateV1 {
  readonly schemaVersion: 1
  readonly runRef: string
  readonly observationId: string
  readonly terminal: RunTerminalSnapshotV2
  readonly policy: FrozenObservationPolicyV1
  readonly metricSummary: RunTraceMetricSummaryV1
  readonly events: readonly RunTraceEventV1[]
  readonly omittedEventCount: number
  readonly presentation: { readonly kind: 'unavailable' }
  readonly expiresAt: string
  readonly serializedBytes: number
}
