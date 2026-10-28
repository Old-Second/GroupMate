import type { ToolEffect, ToolRisk } from './tool-definition.js'

export type ToolAuditEventType =
  | 'requested'
  | 'denied'
  | 'approval_required'
  | 'started'
  | 'completed'
  | 'failed'
  | 'indeterminate'

export interface ToolAuditEvent {
  readonly eventType: ToolAuditEventType
  readonly runRef: string | 'unavailable'
  readonly terminalObservationId: 'not_attempted'
  readonly eventIdHash: string
  readonly runIdHash: string
  readonly callIdHash: string
  readonly snapshotIdHash: string
  readonly toolName: string
  readonly toolVersion: 1
  readonly profile: 'compatible' | 'safe' | 'strict'
  readonly effect: ToolEffect
  readonly risk: ToolRisk
  readonly reasonCode?: string
  readonly errorCode?: string
  readonly durationBucket?: string
  readonly outputBytes?: number
  readonly occurredAt: string
}

export interface ToolAuditSink {
  emit(event: ToolAuditEvent): void | Promise<void>
}

export type ToolControlOperation =
  | 'idempotency_complete'
  | 'idempotency_mark_indeterminate'

/**
 * A control-plane write that could not record the outcome of a side effect.
 *
 * The runtime never compensates an irreversible QQ action, so the recovery
 * policy stays unchanged: the tool result is still returned and the run keeps
 * going. Without this event the lost state would be invisible, which is the
 * one case where a dispatched side effect may later look replayable.
 */
export interface ToolControlFailureEvent {
  readonly eventType: 'control_failure'
  readonly operation: ToolControlOperation
  readonly unpersistedState: 'failed' | 'unknown'
  readonly runRef: string | 'unavailable'
  readonly runIdHash: string
  readonly callIdHash: string
  readonly toolName: string
  readonly toolVersion: 1
  readonly profile: 'compatible' | 'safe' | 'strict'
  readonly effect: ToolEffect
  readonly risk: ToolRisk
  readonly errorName: string
  readonly occurredAt: string
}

export interface ToolControlFailureSink {
  emit(event: ToolControlFailureEvent): void
}
