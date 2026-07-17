import {
  parseObservationEvent,
  type ObservationEventV1
} from './observation-event.js'

export type ObservationSinkName = 'metrics' | 'trace' | 'log'
export type ObservationPriority =
  | 'normal_success'
  | 'progress_delivery'
  | 'normal'
  | 'reserved'

export interface SafeSinkFailureV1 {
  readonly schemaVersion: 1
  readonly sink: ObservationSinkName
  readonly code: 'timeout' | 'rejected' | 'overflow' | 'unavailable'
  readonly occurredAt: string
}

export interface ObservationHubSnapshotV1 {
  readonly schemaVersion: 1
  readonly normalInFlight: number
  readonly normalPending: number
  readonly reservedInFlight: 0 | 1
  readonly sinks: readonly {
    readonly name: ObservationSinkName
    readonly accepted: number
    readonly dropped: number
    readonly failed: number
    readonly quarantined: number
  }[]
}

export interface ObservationSubscriber {
  readonly name: ObservationSinkName
  observe(event: ObservationEventV1, signal: AbortSignal): void | Promise<void>
}

interface SinkState {
  readonly subscriber: ObservationSubscriber
  readonly quarantined: Set<Promise<CallOutcome>>
  accepted: number
  dropped: number
  failed: number
}

interface ObservationJob {
  readonly sequence: number
  readonly priority: ObservationPriority
  readonly event: ObservationEventV1
}

type SinkFailureCode = SafeSinkFailureV1['code']
type CallOutcome = 'fulfilled' | 'rejected'

const SINK_ORDER: readonly ObservationSinkName[] = Object.freeze([
  'metrics', 'trace', 'log'
])
const FAILURE_CODES = new Set<SinkFailureCode>([
  'timeout', 'rejected', 'overflow', 'unavailable'
])
const NORMAL_CONCURRENCY = 2
const NORMAL_MAX_PENDING = 4
const SUBSCRIBER_TIMEOUT_MS = 500
const PRIORITY_RANK: Readonly<Record<Exclude<ObservationPriority, 'reserved'>, number>> =
  Object.freeze({
    normal_success: 0,
    progress_delivery: 1,
    normal: 2
  })

function safeTimestamp (now: () => number): string {
  let value: number
  try {
    value = now()
  } catch {
    value = 0
  }
  if (!Number.isFinite(value)) value = 0
  try {
    return new Date(value).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function exactFailureData (value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sink failure is invalid')
  }
  const input = value as Record<PropertyKey, unknown>
  const keys = ['schemaVersion', 'sink', 'code', 'occurredAt'] as const
  let actual: readonly PropertyKey[]
  try {
    actual = Reflect.ownKeys(input)
  } catch {
    throw new TypeError('sink failure is invalid')
  }
  if (actual.length !== keys.length || actual.some(key => (
    typeof key !== 'string' || !keys.includes(key as typeof keys[number])
  ))) {
    throw new TypeError('sink failure keys are invalid')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key)
    } catch {
      throw new TypeError('sink failure is invalid')
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      throw new TypeError('sink failure property is invalid')
    }
    result[key] = descriptor.value
  }
  return result
}

export function parseSafeSinkFailure (value: unknown): SafeSinkFailureV1 {
  const input = exactFailureData(value)
  if (input.schemaVersion !== 1 || typeof input.sink !== 'string' ||
    !SINK_ORDER.includes(input.sink as ObservationSinkName) ||
    typeof input.code !== 'string' || !FAILURE_CODES.has(input.code as SinkFailureCode) ||
    typeof input.occurredAt !== 'string') {
    throw new TypeError('sink failure fields are invalid')
  }
  try {
    if (new Date(input.occurredAt).toISOString() !== input.occurredAt) {
      throw new TypeError('sink failure timestamp is invalid')
    }
  } catch {
    throw new TypeError('sink failure timestamp is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    sink: input.sink as ObservationSinkName,
    code: input.code as SinkFailureCode,
    occurredAt: input.occurredAt
  })
}

export function observationPriorityFor (
  event: ObservationEventV1
): ObservationPriority {
  if (event.type === 'terminal_snapshot' &&
    (event.value.status === 'failed' || event.value.status === 'cancelled')) {
    return 'reserved'
  }
  if (event.type === 'presentation' &&
    (event.value.postprocessAnomaly || event.value.outcome === 'partial' ||
      event.value.outcome === 'failed' || event.value.outcome === 'unknown')) {
    return 'reserved'
  }
  if (event.type === 'presentation' && event.value.profile === 'progress') {
    return 'progress_delivery'
  }
  if (event.type === 'terminal_snapshot' && event.value.status === 'completed') {
    return 'normal_success'
  }
  if (event.type === 'presentation' &&
    (event.value.outcome === 'complete' || event.value.outcome === 'skipped')) {
    return 'normal_success'
  }
  return 'normal'
}

export class ObservationHub {
  readonly #sinks: readonly SinkState[]
  readonly #onSinkFailure?: (failure: SafeSinkFailureV1) => void
  readonly #now: () => number
  readonly #normalPending: ObservationJob[] = []
  readonly #activeJobs = new Set<Promise<void>>()
  #normalInFlight = 0
  #reservedInFlight: 0 | 1 = 0
  #sequence = 0

  constructor (options: {
    readonly subscribers: readonly ObservationSubscriber[]
    readonly onSinkFailure?: (failure: SafeSinkFailureV1) => void
    readonly now?: () => number
  }) {
    if (!Array.isArray(options.subscribers) || options.subscribers.length > 3) {
      throw new TypeError('observation subscriber set is invalid')
    }
    const byName = new Map<ObservationSinkName, ObservationSubscriber>()
    for (const subscriber of options.subscribers) {
      let name: ObservationSinkName
      let observe: ObservationSubscriber['observe']
      try {
        name = subscriber.name
        observe = subscriber.observe
      } catch {
        throw new TypeError('observation subscriber set is invalid')
      }
      if (subscriber === null || typeof subscriber !== 'object' ||
        !SINK_ORDER.includes(name) || typeof observe !== 'function' || byName.has(name)) {
        throw new TypeError('observation subscriber set is invalid')
      }
      byName.set(name, Object.freeze({
        name,
        observe: (event: ObservationEventV1, signal: AbortSignal) => (
          Reflect.apply(observe, subscriber, [event, signal]) as void | Promise<void>
        )
      }))
    }
    this.#sinks = Object.freeze(SINK_ORDER.flatMap(name => {
      const subscriber = byName.get(name)
      return subscriber === undefined
        ? []
        : [{
            subscriber,
            quarantined: new Set<Promise<CallOutcome>>(),
            accepted: 0,
            dropped: 0,
            failed: 0
          }]
    }))
    this.#onSinkFailure = options.onSinkFailure
    this.#now = options.now ?? Date.now
  }

  publish (value: ObservationEventV1): 'accepted' | 'dropped' {
    const event = parseObservationEvent(value)
    const priority = observationPriorityFor(event)
    const job: ObservationJob = Object.freeze({
      sequence: this.#sequence,
      priority,
      event
    })
    this.#sequence += 1
    if (priority === 'reserved') {
      if (this.#reservedInFlight === 1) {
        this.#dropJob(job, 'overflow')
        return 'dropped'
      }
      this.#startReserved(job)
      return 'accepted'
    }
    if (this.#normalInFlight < NORMAL_CONCURRENCY) {
      this.#startNormal(job)
      return 'accepted'
    }
    if (this.#normalPending.length < NORMAL_MAX_PENDING) {
      this.#normalPending.push(job)
      return 'accepted'
    }
    const rank = PRIORITY_RANK[priority]
    const evictable = this.#normalPending
      .filter(pending => PRIORITY_RANK[pending.priority as Exclude<ObservationPriority, 'reserved'>] < rank)
      .sort((left, right) => left.sequence - right.sequence)[0]
    if (evictable === undefined) {
      this.#dropJob(job, 'overflow')
      return 'dropped'
    }
    const index = this.#normalPending.indexOf(evictable)
    this.#normalPending.splice(index, 1, job)
    this.#dropJob(evictable, 'overflow')
    return 'accepted'
  }

  async drain (): Promise<void> {
    while (this.#normalInFlight > 0 || this.#reservedInFlight > 0 ||
      this.#normalPending.length > 0 || this.#activeJobs.size > 0) {
      const active = [...this.#activeJobs]
      if (active.length === 0) await Promise.resolve()
      else await Promise.all(active)
    }
  }

  snapshot (): ObservationHubSnapshotV1 {
    return Object.freeze({
      schemaVersion: 1,
      normalInFlight: this.#normalInFlight,
      normalPending: this.#normalPending.length,
      reservedInFlight: this.#reservedInFlight,
      sinks: Object.freeze(this.#sinks.map(state => Object.freeze({
        name: state.subscriber.name,
        accepted: state.accepted,
        dropped: state.dropped,
        failed: state.failed,
        quarantined: state.quarantined.size
      })))
    })
  }

  #startNormal (job: ObservationJob): void {
    this.#normalInFlight += 1
    let task!: Promise<void>
    task = this.#fanOut(job).finally(() => {
      this.#normalInFlight -= 1
      this.#activeJobs.delete(task)
      this.#startNextNormal()
    })
    this.#activeJobs.add(task)
  }

  #startReserved (job: ObservationJob): void {
    this.#reservedInFlight = 1
    let task!: Promise<void>
    task = this.#fanOut(job).finally(() => {
      this.#reservedInFlight = 0
      this.#activeJobs.delete(task)
    })
    this.#activeJobs.add(task)
  }

  #startNextNormal (): void {
    if (this.#normalInFlight >= NORMAL_CONCURRENCY || this.#normalPending.length === 0) return
    let selected = 0
    for (let index = 1; index < this.#normalPending.length; index += 1) {
      const current = this.#normalPending[index]
      const winner = this.#normalPending[selected]
      const currentRank = PRIORITY_RANK[current.priority as Exclude<ObservationPriority, 'reserved'>]
      const winnerRank = PRIORITY_RANK[winner.priority as Exclude<ObservationPriority, 'reserved'>]
      if (currentRank > winnerRank ||
        (currentRank === winnerRank && current.sequence < winner.sequence)) {
        selected = index
      }
    }
    const [next] = this.#normalPending.splice(selected, 1)
    this.#startNormal(next)
    this.#startNextNormal()
  }

  async #fanOut (job: ObservationJob): Promise<void> {
    for (const state of this.#sinks) {
      await this.#invoke(state, job.event)
    }
  }

  async #invoke (state: SinkState, event: ObservationEventV1): Promise<void> {
    if (state.quarantined.size > 0) {
      state.dropped += 1
      this.#reportFailure(state.subscriber.name, 'unavailable')
      return
    }
    const controller = new AbortController()
    let settled = false
    const call = Promise.resolve()
      .then(async () => {
        state.accepted += 1
        await state.subscriber.observe(event, controller.signal)
      })
      .then((): CallOutcome => {
        settled = true
        return 'fulfilled'
      })
      .catch((): CallOutcome => {
        settled = true
        return 'rejected'
      })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timed = new Promise<'timeout'>(resolve => {
      timeout = setTimeout(() => resolve('timeout'), SUBSCRIBER_TIMEOUT_MS)
    })
    const outcome = await Promise.race<CallOutcome | 'timeout'>([call, timed])
    if (timeout !== undefined) clearTimeout(timeout)
    if (outcome === 'timeout') {
      controller.abort()
      state.failed += 1
      this.#reportFailure(state.subscriber.name, 'timeout')
      if (!settled) {
        state.quarantined.add(call)
        void call.then(() => {
          state.quarantined.delete(call)
        })
      }
      return
    }
    if (outcome === 'rejected') {
      state.failed += 1
      this.#reportFailure(state.subscriber.name, 'rejected')
    }
  }

  #dropJob (_job: ObservationJob, code: Extract<SinkFailureCode, 'overflow'>): void {
    for (const state of this.#sinks) {
      state.dropped += 1
      this.#reportFailure(state.subscriber.name, code)
    }
  }

  #reportFailure (sink: ObservationSinkName, code: SinkFailureCode): void {
    if (this.#onSinkFailure === undefined) return
    const failure = Object.freeze({
      schemaVersion: 1 as const,
      sink,
      code,
      occurredAt: safeTimestamp(this.#now)
    })
    try {
      this.#onSinkFailure(failure)
    } catch {
      // Failure reporting is intentionally non-recursive and best-effort.
    }
  }
}
