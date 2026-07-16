import { isTerminalRunStatus } from '../../src/agent/run/run-state.js'
import type {
  LoadedRunCheckpoint,
  RunCheckpoint,
  RunCheckpointV1,
  RunCheckpointV2
} from '../../src/agent/run/run-checkpoint.js'
import {
  checkpointWithAppendedEvents,
  createRunTombstone,
  parseRunTombstone,
  RunStoreConflictError,
  RunReferenceConflictError,
  type RunTombstone,
  type RunStore
} from '../../src/agent/run/run-store.js'
import type { AgentEvent } from '../../src/agent/contracts/event.js'

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, LoadedRunCheckpoint>()
  readonly #tombstones = new Map<string, RunTombstone>()
  readonly #references = new Map<string, string>()

  seedLoadedCheckpoint (checkpoint: LoadedRunCheckpoint): void {
    if (this.#runs.has(checkpoint.runId)) throw new RunStoreConflictError()
    this.#runs.set(checkpoint.runId, checkpoint)
    if (checkpoint.schemaVersion === 2) {
      if (this.#references.has(checkpoint.runRef)) {
        this.#runs.delete(checkpoint.runId)
        throw new RunReferenceConflictError()
      }
      this.#references.set(checkpoint.runRef, checkpoint.runId)
    }
  }

  async create (checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
    if (this.#references.has(checkpoint.runRef)) {
      throw new RunReferenceConflictError()
    }
    if (this.#runs.has(checkpoint.runId) || checkpoint.revision !== 0 ||
      checkpoint.status !== 'created') {
      throw new RunStoreConflictError()
    }
    this.#runs.set(checkpoint.runId, checkpoint)
    this.#references.set(checkpoint.runRef, checkpoint.runId)
    return checkpoint
  }

  async load (runId: string): Promise<LoadedRunCheckpoint | null> {
    return this.#runs.get(runId) ?? null
  }

  async upgrade (
    expected: RunCheckpointV1,
    next: RunCheckpointV2
  ): Promise<RunCheckpointV2> {
    if (this.#references.has(next.runRef)) throw new RunReferenceConflictError()
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.schemaVersion !== 1 ||
      current.revision !== expected.revision || next.runId !== expected.runId ||
      next.revision !== expected.revision + 1) {
      throw new RunStoreConflictError()
    }
    this.#runs.set(next.runId, next)
    this.#references.set(next.runRef, next.runId)
    return next
  }

  async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.schemaVersion !== 2 ||
      current.revision !== expected.revision ||
      next.runId !== expected.runId || next.revision !== expected.revision + 1 ||
      next.runRef !== expected.runRef ||
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
