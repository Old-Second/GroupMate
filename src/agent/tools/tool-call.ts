export interface ToolCall {
  readonly runId: string
  readonly runRef?: string
  readonly callId: string
  readonly snapshotId: string
  readonly requestedName: string
  readonly arguments: unknown
}
