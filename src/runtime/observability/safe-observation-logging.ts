import type { RequestObservationV1 } from '../request-observation.js'
import { parseRequestObservation } from '../request-observation.js'
import {
  parsePresentationObservation,
  type PresentationObservationV1
} from './observation-event.js'
import {
  parseSafeSinkFailure,
  type SafeSinkFailureV1
} from './observation-hub.js'

type UnknownRecord = Record<PropertyKey, unknown>

const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'runRef',
  'requestRef',
  'requestKind',
  'outcome',
  'admissionRejectionReason',
  'queueDurationMs',
  'sessionLoadDurationMs',
  'sessionSaveDurationMs',
  'requestDurationMs',
  'terminalObservationId'
])
const SINK_FAILURE_KEYS = Object.freeze([
  'schemaVersion', 'sink', 'code', 'occurredAt'
])
const RATE_LIMIT_MS = 60_000

function ownDataProjection (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const input = value as UnknownRecord
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} field is invalid`)
    }
    output[key] = descriptor.value
  }
  return output
}

export function createRequestObservationLog (value: RequestObservationV1) {
  const observation = parseRequestObservation(ownDataProjection(
    value,
    REQUEST_KEYS,
    'request observation log input'
  ))
  return Object.freeze({
    event: 'observation.request',
    requestKind: observation.requestKind,
    outcome: observation.outcome,
    admissionRejectionReason: observation.admissionRejectionReason,
    queueDurationMs: observation.queueDurationMs,
    sessionLoadDurationMs: observation.sessionLoadDurationMs,
    sessionSaveDurationMs: observation.sessionSaveDurationMs,
    requestDurationMs: observation.requestDurationMs
  } as const)
}

export function createPresentationObservationLog (
  value: PresentationObservationV1
) {
  const observation = parsePresentationObservation(value)
  return Object.freeze({
    event: 'observation.presentation',
    profile: observation.profile,
    outcome: observation.outcome,
    postprocessAnomaly: observation.postprocessAnomaly,
    deliveryCount: observation.deliveries.length,
    totalDurationMs: observation.totalDurationMs,
    selectedMode: observation.reducerInput.selectedMode,
    fallbackReason: observation.reducerInput.fallbackReason
  } as const)
}

export function createObservationSinkFailureLog (value: SafeSinkFailureV1) {
  const failure = parseSafeSinkFailure(ownDataProjection(
    value,
    SINK_FAILURE_KEYS,
    'sink failure log input'
  ))
  return Object.freeze({
    event: 'observation.sink_failure',
    sink: failure.sink,
    code: failure.code,
    occurredAt: failure.occurredAt
  } as const)
}

export class SafeObservationFailureLogLimiter {
  readonly #now: () => number
  readonly #lastBySink = new Map<SafeSinkFailureV1['sink'], number>()

  constructor (options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  create (value: SafeSinkFailureV1): ReturnType<
  typeof createObservationSinkFailureLog
  > | null {
    const log = createObservationSinkFailureLog(value)
    const now = this.#safeNow()
    const last = this.#lastBySink.get(log.sink)
    if (last !== undefined && now - last < RATE_LIMIT_MS) return null
    this.#lastBySink.set(log.sink, now)
    return log
  }

  #safeNow (): number {
    try {
      const value = this.#now()
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
}
