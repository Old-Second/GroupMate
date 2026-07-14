import type { RunCheckpoint } from './run-checkpoint.js'

export interface RunStore {
  create(checkpoint: RunCheckpoint): Promise<RunCheckpoint>
  load(runId: string): Promise<RunCheckpoint | null>
  compareAndSet(
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint>
}

export class RunStoreConflictError extends Error {
  readonly code: 'checkpoint_conflict'

  constructor () {
    super('run checkpoint revision conflict')
    this.name = 'RunStoreConflictError'
    this.code = 'checkpoint_conflict'
  }
}
