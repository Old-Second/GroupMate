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
