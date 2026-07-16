import {
  parseRunTerminalSnapshot,
  type RunTerminalSnapshotV2
} from '../agent/run/run-observation.js'
import {
  parseTerminalCommitReceipt,
  type TerminalCommitReceiptV1
} from '../agent/run/run-store.js'

interface TerminalFactEntry {
  snapshot?: RunTerminalSnapshotV2
  receipt?: TerminalCommitReceiptV1
  committed: boolean
}

export class TerminalFactCollector {
  readonly #capacity: number
  readonly #onCommitted: (
    snapshot: RunTerminalSnapshotV2,
    receipt: TerminalCommitReceiptV1
  ) => void
  readonly #entries = new Map<string, TerminalFactEntry>()

  constructor (options: {
    readonly capacity?: number
    readonly onCommitted: (
      snapshot: RunTerminalSnapshotV2,
      receipt: TerminalCommitReceiptV1
    ) => void
  }) {
    const capacity = options.capacity ?? 256
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) {
      throw new TypeError('terminal fact collector capacity is invalid')
    }
    this.#capacity = capacity
    this.#onCommitted = options.onCommitted
  }

  acceptSnapshot (value: RunTerminalSnapshotV2): void {
    let snapshot: RunTerminalSnapshotV2
    try {
      snapshot = parseRunTerminalSnapshot(value)
    } catch {
      return
    }
    const entry = this.#entry(snapshot.observationId)
    entry.snapshot = snapshot
    this.#commit(snapshot.observationId, entry)
  }

  acceptCommitReceipt (value: TerminalCommitReceiptV1): void {
    let receipt: TerminalCommitReceiptV1
    try {
      receipt = parseTerminalCommitReceipt(value)
    } catch {
      return
    }
    const entry = this.#entry(receipt.observationId)
    entry.receipt = receipt
    this.#commit(receipt.observationId, entry)
  }

  #entry (observationId: string): TerminalFactEntry {
    const existing = this.#entries.get(observationId)
    if (existing !== undefined) {
      this.#entries.delete(observationId)
      this.#entries.set(observationId, existing)
      return existing
    }
    const entry: TerminalFactEntry = { committed: false }
    this.#entries.set(observationId, entry)
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return entry
  }

  #commit (observationId: string, entry: TerminalFactEntry): void {
    if (entry.committed || entry.snapshot === undefined || entry.receipt === undefined) return
    if (entry.snapshot.observationId !== entry.receipt.observationId ||
      entry.snapshot.runRef !== entry.receipt.runRef ||
      entry.snapshot.revision !== entry.receipt.revision) return
    entry.committed = true
    this.#onCommitted(entry.snapshot, entry.receipt)
  }
}
