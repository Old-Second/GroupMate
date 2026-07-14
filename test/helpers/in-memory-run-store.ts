import { isTerminalRunStatus } from '../../src/agent/run/run-state.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import {
  checkpointWithAppendedEvents,
  createRunTombstone,
  parseRunTombstone,
  RunStoreConflictError,
  type RunTombstone,
  type RunStore
} from '../../src/agent/run/run-store.js'
import type { AgentEvent } from '../../src/agent/contracts/event.js'

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunCheckpoint>()
  readonly #tombstones = new Map<string, RunTombstone>()

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
    if (isTerminalRunStatus(next.status)) {
      this.#tombstones.set(next.runId, createRunTombstone(next))
    }
    return next
  }

  async appendEvents (
    expected: RunCheckpoint,
    events: readonly AgentEvent[]
  ): Promise<RunCheckpoint> {
    if (events.length === 0) return expected
    return await this.compareAndSet(
      expected,
      checkpointWithAppendedEvents(expected, events)
    )
  }

  async finish (
    expected: RunCheckpoint,
    summary: RunTombstone
  ): Promise<RunTombstone> {
    const parsed = parseRunTombstone(summary)
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.revision !== expected.revision ||
      parsed.runId !== expected.runId || parsed.revision !== expected.revision + 1) {
      throw new RunStoreConflictError()
    }
    this.#runs.delete(expected.runId)
    this.#tombstones.set(parsed.runId, parsed)
    return parsed
  }

  async loadTombstone (runId: string): Promise<RunTombstone | null> {
    return this.#tombstones.get(runId) ?? null
  }
}
