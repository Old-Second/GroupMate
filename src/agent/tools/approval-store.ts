import type { ToolPolicyProfile } from './policy-engine.js'

export interface ApprovalRecord {
  readonly schemaVersion: 1
  readonly rawVersion: string
  readonly tokenHash: string
  readonly toolName: string
  readonly toolVersion: 1
  readonly profile: ToolPolicyProfile
  readonly runId: string
  readonly callId: string
  readonly snapshotId: string
  readonly argumentHash: string
  readonly pendingCallId: string
  readonly botIdHash: string
  readonly actorIdHash: string
  readonly channelHash: string
  readonly targetHash: string
  readonly summaryCode: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface ApprovalStore {
  create(record: ApprovalRecord, ttlSeconds: number): Promise<void>
  get(tokenHash: string): Promise<ApprovalRecord | null>
  consume(tokenHash: string, expectedRawVersion: string): Promise<ApprovalRecord | null>
}
