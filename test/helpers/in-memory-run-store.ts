import { isTerminalRunStatus } from '../../src/agent/run/run-state.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import {
  RunStoreConflictError,
  type RunStore
} from '../../src/agent/run/run-store.js'

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunCheckpoint>()

  async create (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    if (this.#runs.has(checkpoint.runId) || checkpoint.revision !== 0 ||
      checkpoint.status !== 'created') {
      throw new RunStoreConflictError()
    }
    this.#runs.set(checkpoint.runId, checkpoint)
    return checkpoint
  }

  async load (runId: string): Promise<RunCheckpoint | null> {
    return this.#runs.get(runId) ?? null
  }

  async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.revision !== expected.revision ||
      next.runId !== expected.runId || next.revision !== expected.revision + 1 ||
      isTerminalRunStatus(current.status)) {
      throw new RunStoreConflictError()
    }
    this.#runs.set(next.runId, next)
    return next
  }
}
