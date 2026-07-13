import type { IntentEvidence } from '../../runtime/tools/intent-evidence.js'
import type { ToolPolicyProfile } from './policy-engine.js'

export interface PendingToolCallMetadata {
  readonly runId: string
  readonly callId: string
  readonly snapshotId: string
  readonly requestedName: string
}

export interface PendingToolCall {
  readonly schemaVersion: 1
  readonly pendingCallId: string
  readonly toolName: string
  readonly toolVersion: 1
  readonly profile: ToolPolicyProfile
  readonly call: PendingToolCallMetadata
  readonly input: Readonly<Record<string, unknown>>
  readonly intent: IntentEvidence
  readonly argumentHash: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface PendingCallStore {
  put(call: PendingToolCall): void
  take(pendingCallId: string, argumentHash: string): PendingToolCall | null
  delete(pendingCallId: string): boolean
}
