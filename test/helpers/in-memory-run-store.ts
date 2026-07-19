import type { AgentEvent } from '../../src/agent/contracts/event.js'
import {
  RunCheckpointCodec,
  type LoadedRunCheckpoint,
  type RunCheckpoint,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpointV3,
  type RunCheckpointV4,
  type RunCheckpointV5
} from '../../src/agent/run/run-checkpoint.js'
import { validateExactRunCheckpointMigration } from '../../src/agent/run/run-checkpoint-migration.js'
import type { RunTerminalSnapshotV2 } from '../../src/agent/run/run-observation.js'
import { isTerminalRunStatus } from '../../src/agent/run/run-state.js'
import {
  checkpointWithAppendedEvents,
  normalizeRunTombstone,
  parseRunTombstone,
  parseTerminalCommitReceipt,
  RunReferenceConflictError,
  RunStoreConflictError,
  validateTerminalCommitInput,
  type NormalizedRunTombstoneV1,
  type RunStore,
  type RunStoreObservationUsageV1,
  type TerminalCommitReceiptV1
} from '../../src/agent/run/run-store.js'

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, LoadedRunCheckpoint>()
  readonly #tombstones = new Map<string, string>()
  readonly #references = new Map<string, string>()
  readonly #codec = new RunCheckpointCodec()

  seedLoadedCheckpoint (checkpoint: LoadedRunCheckpoint): void {
    if (this.#runs.has(checkpoint.runId)) throw new RunStoreConflictError()
    this.#runs.set(checkpoint.runId, checkpoint)
    if (checkpoint.schemaVersion === 2 || checkpoint.schemaVersion === 3 ||
      checkpoint.schemaVersion === 4 || checkpoint.schemaVersion === 5) {
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
    expected: RunCheckpointV1 | RunCheckpointV2 | RunCheckpointV3 | RunCheckpointV4,
    next: RunCheckpointV5
  ): Promise<RunCheckpointV5> {
    try {
      validateExactRunCheckpointMigration(expected, next)
    } catch {
      throw new RunStoreConflictError()
    }
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.schemaVersion !== expected.schemaVersion ||
      JSON.stringify(current) !== JSON.stringify(expected) ||
      current.revision !== expected.revision || next.runId !== expected.runId ||
      next.sessionId !== expected.sessionId || next.revision !== expected.revision + 1) {
      throw new RunStoreConflictError()
    }
    if (expected.schemaVersion === 1) {
      if (this.#references.has(next.runRef)) throw new RunReferenceConflictError()
      this.#references.set(next.runRef, next.runId)
    } else if (next.runRef !== expected.runRef || next.requestRef !== expected.requestRef ||
      this.#references.get(expected.runRef) !== expected.runId) {
      throw new RunStoreConflictError()
    }
    this.#runs.set(next.runId, next)
    return next
  }

  async compareAndSet (
    expected: RunCheckpoint,
    next: RunCheckpoint
  ): Promise<RunCheckpoint> {
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.schemaVersion !== 5 ||
      current.revision !== expected.revision ||
      next.runId !== expected.runId || next.revision !== expected.revision + 1 ||
      next.runRef !== expected.runRef || isTerminalRunStatus(current.status) ||
      isTerminalRunStatus(next.status)) {
      throw new RunStoreConflictError()
    }
    this.#runs.set(next.runId, next)
    return next
  }

  async commitTerminal (
    expected: RunCheckpoint,
    next: RunCheckpoint,
    snapshot: RunTerminalSnapshotV2
  ): Promise<TerminalCommitReceiptV1> {
    const validated = validateTerminalCommitInput(expected, next, snapshot)
    const current = this.#runs.get(expected.runId)
    if (current === undefined || current.schemaVersion !== 5 ||
      JSON.stringify(current) !== JSON.stringify(expected) ||
      this.#tombstones.has(expected.runId)) {
      throw new RunStoreConflictError()
    }
    const encoded = this.#codec.encode(expected)
    const raw = JSON.stringify(validated.tombstone)
    this.#runs.delete(expected.runId)
    this.#tombstones.set(expected.runId, raw)
    return parseTerminalCommitReceipt({
      schemaVersion: 1,
      observationId: validated.snapshot.observationId,
      runRef: validated.snapshot.runRef,
      revision: validated.snapshot.revision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: Buffer.byteLength(encoded.checkpoint, 'utf8'),
      eventBytesDeleted: Buffer.byteLength(encoded.events, 'utf8'),
      tombstoneBytes: Buffer.byteLength(raw, 'utf8')
    })
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

  readRawTombstone (runId: string): string | null {
    return this.#tombstones.get(runId) ?? null
  }

  seedRawTombstone (runId: string, raw: string): void {
    this.#tombstones.set(runId, raw)
  }

  async loadTombstone (runId: string): Promise<NormalizedRunTombstoneV1 | null> {
    const raw = this.#tombstones.get(runId)
    if (raw === undefined) return null
    const parsed = parseRunTombstone(JSON.parse(raw) as unknown)
    if (parsed.schemaVersion === 1 && parsed.runId !== runId) {
      throw new TypeError('run ID does not match its tombstone key')
    }
    return normalizeRunTombstone(parsed)
  }

  async observationUsage (): Promise<RunStoreObservationUsageV1> {
    let tombstoneBytes = 0
    for (const raw of this.#tombstones.values()) {
      tombstoneBytes += Buffer.byteLength(raw, 'utf8')
    }
    return Object.freeze({
      schemaVersion: 1,
      tombstoneRecords: this.#tombstones.size,
      tombstoneBytes
    })
  }
}
