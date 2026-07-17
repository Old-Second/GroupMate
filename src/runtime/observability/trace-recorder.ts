import { parseTraceCandidate, type TraceCandidateV1 } from '../../agent/run/run-trace.js'
import {
  parseObservationEvent,
  type ObservationEventV1,
  type PresentationObservationV1
} from './observation-event.js'
import {
  type ObservationSubscriber,
  type SafeSinkFailureV1
} from './observation-hub.js'
import {
  type TraceRecorderSnapshotV1,
  type TraceStore,
  type TraceWriteReceiptV1
} from './trace-store.js'
import { decideTraceRetention, type ObservabilityLevel } from './trace-policy.js'

interface CandidateEntry {
  readonly candidate: TraceCandidateV1
  readonly sequence: number
}

const WAIT_CAPACITY = 2
const LEVELS = new Set<ObservabilityLevel>(['off', 'basic', 'diagnostic'])

function presentationIsAnomaly (value: PresentationObservationV1): boolean {
  return value.postprocessAnomaly || value.outcome === 'partial' ||
    value.outcome === 'failed' || value.outcome === 'unknown' ||
    value.deliveries.some(delivery => delivery.outcome !== 'sent')
}

function safeTimestamp (now: () => number): string {
  try {
    const value = now()
    return new Date(Number.isFinite(value) ? value : 0).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

export class TraceRecorder implements ObservationSubscriber {
  readonly name = 'trace' as const
  readonly #store: TraceStore
  readonly #onSinkFailure?: (failure: SafeSinkFailureV1) => void
  readonly #now: () => number
  readonly #committed = new Map<string, CandidateEntry>()
  readonly #presentationWait = new Map<string, CandidateEntry>()
  #currentLevel: ObservabilityLevel = 'basic'
  #sequence = 0
  #queue: Promise<void> = Promise.resolve()

  constructor (options: {
    readonly store: TraceStore
    readonly onSinkFailure?: (failure: SafeSinkFailureV1) => void
    readonly now?: () => number
  }) {
    if (options.store === null || typeof options.store !== 'object' ||
      typeof options.store.upsertEngine !== 'function' ||
      typeof options.store.appendPresentation !== 'function') {
      throw new TypeError('trace recorder store is invalid')
    }
    this.#store = options.store
    this.#onSinkFailure = options.onSinkFailure
    this.#now = options.now ?? Date.now
  }

  stageCommittedTraceCandidate (value: TraceCandidateV1): void {
    if (this.#currentLevel === 'off') return
    const candidate = parseTraceCandidate(value)
    const existing = this.#committed.get(candidate.observationId) ??
      this.#presentationWait.get(candidate.observationId)
    if (existing !== undefined) {
      if (JSON.stringify(existing.candidate) !== JSON.stringify(candidate)) {
        this.#failure('rejected')
      }
      return
    }
    if (this.#committed.size >= WAIT_CAPACITY) {
      const evictable = [...this.#committed.entries()].find(([, entry]) => (
        entry.candidate.terminal.status === 'completed' &&
        !entry.candidate.policy.sampledSuccess
      ))
      if (evictable === undefined) {
        this.#failure('overflow')
        return
      }
      this.#committed.delete(evictable[0])
      this.#failure('overflow')
    }
    this.#committed.set(candidate.observationId, {
      candidate,
      sequence: this.#sequence
    })
    this.#sequence += 1
  }

  observe (value: ObservationEventV1, signal: AbortSignal): Promise<void> {
    let event: ObservationEventV1
    try {
      event = parseObservationEvent(value)
    } catch {
      this.#failure('rejected')
      return Promise.resolve()
    }
    const operation = this.#queue.then(async () => {
      if (signal.aborted || this.#currentLevel === 'off') return
      if (event.type === 'terminal_snapshot') {
        await this.#observeSnapshot(event.value.observationId)
      } else if (event.type === 'presentation') {
        await this.#observePresentation(event.value)
      }
    })
    this.#queue = operation.catch(() => {})
    return operation.catch(() => {
      this.#failure('unavailable')
    })
  }

  setCurrentLevel (level: ObservabilityLevel): void {
    if (!LEVELS.has(level)) throw new TypeError('trace recorder level is invalid')
    this.#currentLevel = level
    if (level === 'off') {
      this.#committed.clear()
      this.#presentationWait.clear()
    }
  }

  snapshot (): TraceRecorderSnapshotV1 {
    return Object.freeze({
      schemaVersion: 1,
      currentLevel: this.#currentLevel,
      committedCandidateWait: this.#committed.size as 0 | 1 | 2,
      presentationWait: this.#presentationWait.size as 0 | 1 | 2
    })
  }

  async #observeSnapshot (observationId: string): Promise<void> {
    const entry = this.#committed.get(observationId)
    if (entry === undefined) return
    const decision = decideTraceRetention({
      policy: entry.candidate.policy,
      currentLevel: this.#currentLevel,
      terminalStatus: entry.candidate.terminal.status,
      presentation: 'not_observed'
    })
    if (decision.kind === 'retain') {
      const receipt = await this.#writeEngine(entry.candidate)
      this.#committed.delete(observationId)
      if (!this.#accepted(receipt)) return
      return
    }
    if (decision.kind === 'drop') {
      this.#committed.delete(observationId)
      return
    }
    this.#committed.delete(observationId)
    if (this.#presentationWait.size >= WAIT_CAPACITY) {
      const oldest = this.#presentationWait.keys().next().value as string | undefined
      if (oldest !== undefined) this.#presentationWait.delete(oldest)
      this.#failure('overflow')
    }
    this.#presentationWait.set(observationId, entry)
  }

  async #observePresentation (presentation: PresentationObservationV1): Promise<void> {
    if (presentation.runRef === 'unavailable' ||
      presentation.terminalObservationId === 'unavailable' ||
      presentation.terminalObservationId === 'not_attempted') return
    const observationId = presentation.terminalObservationId
    const entry = this.#committed.get(observationId) ??
      this.#presentationWait.get(observationId)
    if (entry === undefined) {
      await this.#writePresentation(presentation)
      return
    }
    const anomaly = presentationIsAnomaly(presentation)
    const decision = decideTraceRetention({
      policy: entry.candidate.policy,
      currentLevel: this.#currentLevel,
      terminalStatus: entry.candidate.terminal.status,
      presentation: anomaly ? 'anomaly' : 'normal'
    })
    this.#committed.delete(observationId)
    this.#presentationWait.delete(observationId)
    if (decision.kind === 'drop' || decision.kind === 'await_presentation') return
    const engine = await this.#writeEngine(entry.candidate)
    if (!this.#accepted(engine)) return
    await this.#writePresentation(presentation)
  }

  async #writeEngine (candidate: TraceCandidateV1): Promise<TraceWriteReceiptV1> {
    try {
      const receipt = await this.#store.upsertEngine(candidate)
      this.#recordReceipt(receipt)
      return receipt
    } catch {
      this.#failure('unavailable')
      return { schemaVersion: 1, kind: 'rejected', code: 'capacity' }
    }
  }

  async #writePresentation (
    presentation: PresentationObservationV1
  ): Promise<TraceWriteReceiptV1> {
    try {
      const receipt = await this.#store.appendPresentation(presentation)
      this.#recordReceipt(receipt)
      return receipt
    } catch {
      this.#failure('unavailable')
      return { schemaVersion: 1, kind: 'rejected', code: 'capacity' }
    }
  }

  #accepted (receipt: TraceWriteReceiptV1): boolean {
    return receipt.kind === 'stored' || receipt.kind === 'unchanged'
  }

  #recordReceipt (receipt: TraceWriteReceiptV1): void {
    if (receipt.kind !== 'rejected') return
    this.#failure(receipt.code === 'capacity' ? 'overflow' : 'rejected')
  }

  #failure (code: SafeSinkFailureV1['code']): void {
    try {
      this.#onSinkFailure?.(Object.freeze({
        schemaVersion: 1,
        sink: 'trace',
        code,
        occurredAt: safeTimestamp(this.#now)
      }))
    } catch {
      // A diagnostic callback cannot affect the recorder or the run.
    }
  }
}
