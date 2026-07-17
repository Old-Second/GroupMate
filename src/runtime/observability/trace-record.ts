import {
  MAX_TRACE_RECORD_BYTES,
  internalExactTraceArray,
  internalExactTraceData,
  internalFinalizeSerialized,
  internalParseTraceEvent,
  internalSelectTraceEvents,
  internalValidateTraceEvents,
  parseTraceCandidate,
  type RunTraceEventV1,
  type StoredRunTraceEventV1,
  type TraceCandidateV1,
  type TraceTruncatedEventV1,
  type UnknownOptionalTraceEventV1
} from '../../agent/run/run-trace.js'
import {
  parseFrozenObservationPolicy,
  parseRunTerminalSnapshot,
  parseRunTraceMetricSummary
} from '../../agent/run/run-observation.js'
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js'
import {
  parsePresentationObservation,
  type PresentationObservationV1
} from './observation-event.js'

export type { UnknownOptionalTraceEventV1 } from '../../agent/run/run-trace.js'
export type { StoredRunTraceEventV1 } from '../../agent/run/run-trace.js'

export interface TraceRecordV1 extends Omit<
TraceCandidateV1,
'presentation' | 'serializedBytes'
> {
  readonly presentation:
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'observed'; readonly value: PresentationObservationV1 }
  readonly serializedBytes: number
}

export interface StoredTraceRecordV1 extends Omit<TraceRecordV1, 'events'> {
  readonly events: readonly StoredRunTraceEventV1[]
}

const OBSERVATION_ID_PATTERN = /^[0-9a-f]{64}$/
const TRACE_TTL_MS = 24 * 60 * 60 * 1_000

function nonNegativeInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} is invalid`)
  }
  return Number(value)
}

function timestamp (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new TypeError(`${label} is invalid`)
  }
  try {
    if (new Date(value).toISOString() !== value) throw new TypeError(`${label} is invalid`)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function expiryFor (finishedAt: string): string {
  return new Date(new Date(finishedAt).getTime() + TRACE_TTL_MS).toISOString()
}

function parsePresentation (
  value: unknown
): TraceRecordV1['presentation'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('trace presentation is invalid')
  }
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  } catch {
    throw new TypeError('trace presentation is invalid')
  }
  if (descriptor === undefined || !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('trace presentation kind is invalid')
  }
  if (descriptor.value === 'unavailable') {
    internalExactTraceData(value, ['kind'], 'trace presentation')
    return Object.freeze({ kind: 'unavailable' })
  }
  if (descriptor.value === 'observed') {
    const observed = internalExactTraceData(value, ['kind', 'value'], 'trace presentation')
    return Object.freeze({
      kind: 'observed',
      value: parsePresentationObservation(observed.value)
    })
  }
  throw new TypeError('trace presentation kind is invalid')
}

function buildRecord<TEvent extends StoredRunTraceEventV1> (input: {
  readonly runRef: string
  readonly observationId: string
  readonly terminal: TraceCandidateV1['terminal']
  readonly policy: TraceCandidateV1['policy']
  readonly metricSummary: TraceCandidateV1['metricSummary']
  readonly events: readonly TEvent[]
  readonly omittedEventCount: number
  readonly presentation: TraceRecordV1['presentation']
  readonly expiresAt: string
}, serializedBytes: number): StoredTraceRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    runRef: input.runRef,
    observationId: input.observationId,
    terminal: input.terminal,
    policy: input.policy,
    metricSummary: input.metricSummary,
    events: Object.freeze([...input.events]),
    omittedEventCount: input.omittedEventCount,
    presentation: input.presentation,
    expiresAt: input.expiresAt,
    serializedBytes
  })
}

function parseRecord (
  value: unknown,
  allowUnknownOptional: boolean
): StoredTraceRecordV1 {
  const input = internalExactTraceData(value, [
    'schemaVersion', 'runRef', 'observationId', 'terminal', 'policy',
    'metricSummary', 'events', 'omittedEventCount', 'presentation',
    'expiresAt', 'serializedBytes'
  ], 'trace record')
  if (input.schemaVersion !== 1 || typeof input.runRef !== 'string' ||
    !RUN_REF_PATTERN.test(input.runRef) || typeof input.observationId !== 'string' ||
    !OBSERVATION_ID_PATTERN.test(input.observationId)) {
    throw new TypeError('trace record fields are invalid')
  }
  const terminal = parseRunTerminalSnapshot(input.terminal)
  if (input.runRef !== terminal.runRef || input.observationId !== terminal.observationId) {
    throw new TypeError('trace record correlation is invalid')
  }
  const policy = parseFrozenObservationPolicy(input.policy)
  const metricSummary = parseRunTraceMetricSummary(input.metricSummary)
  const events = Object.freeze(internalExactTraceArray(
    input.events,
    512,
    'trace record events'
  ).map(event => internalParseTraceEvent(event, allowUnknownOptional)))
  const omittedEventCount = nonNegativeInteger(input.omittedEventCount, 'trace omitted count')
  internalValidateTraceEvents(events, omittedEventCount, terminal)
  const presentation = parsePresentation(input.presentation)
  if (presentation.kind === 'observed' && (
    presentation.value.runRef !== input.runRef ||
    presentation.value.terminalObservationId !== input.observationId
  )) {
    throw new TypeError('trace presentation correlation is invalid')
  }
  const expiresAt = timestamp(input.expiresAt, 'trace expiry')
  if (expiresAt !== expiryFor(terminal.finishedAt)) throw new TypeError('trace expiry is invalid')
  const serializedBytes = nonNegativeInteger(input.serializedBytes, 'trace serialized bytes')
  const canonical = internalFinalizeSerialized(bytes => buildRecord({
    runRef: input.runRef as string,
    observationId: input.observationId as string,
    terminal,
    policy,
    metricSummary,
    events,
    omittedEventCount,
    presentation,
    expiresAt
  }, bytes))
  if (serializedBytes !== canonical.serializedBytes ||
    canonical.serializedBytes > MAX_TRACE_RECORD_BYTES) {
    throw new TypeError('trace serialized bytes are invalid')
  }
  return canonical
}

export function parseTraceRecord (value: unknown): TraceRecordV1 {
  return parseRecord(value, false) as TraceRecordV1
}

export function parseStoredTraceRecord (value: unknown): StoredTraceRecordV1 {
  return parseRecord(value, true)
}

function joinPresentation (
  runRef: string,
  observationId: string,
  value: unknown
): PresentationObservationV1 {
  const presentation = parsePresentationObservation(value)
  if (presentation.runRef !== runRef ||
    presentation.terminalObservationId !== observationId) {
    throw new TypeError('trace presentation join is invalid')
  }
  return presentation
}

function markerOf (
  events: readonly StoredRunTraceEventV1[]
): TraceTruncatedEventV1 | null {
  return events.find((event): event is TraceTruncatedEventV1 => (
    event.type === 'trace_truncated'
  )) ?? null
}

export function mergeTracePresentation (input: {
  readonly candidate: TraceCandidateV1
  readonly presentation: PresentationObservationV1
}): TraceRecordV1 {
  const candidate = parseTraceCandidate(input.candidate)
  const presentation = joinPresentation(
    candidate.runRef,
    candidate.observationId,
    input.presentation
  )
  const observed = Object.freeze({ kind: 'observed' as const, value: presentation })
  const marker = markerOf(candidate.events)
  const source = candidate.events.filter((event): event is Exclude<
  RunTraceEventV1,
  TraceTruncatedEventV1
  > => event.type !== 'trace_truncated')
  const selected = internalSelectTraceEvents({
    events: source,
    existingOmittedCount: candidate.omittedEventCount,
    existingMarkerSequence: marker?.sequence ?? null,
    build: (events, omittedEventCount) => internalFinalizeSerialized(bytes => buildRecord({
      runRef: candidate.runRef,
      observationId: candidate.observationId,
      terminal: candidate.terminal,
      policy: candidate.policy,
      metricSummary: candidate.metricSummary,
      events,
      omittedEventCount,
      presentation: observed,
      expiresAt: candidate.expiresAt
    }, bytes))
  })
  return parseTraceRecord(internalFinalizeSerialized(bytes => buildRecord({
    runRef: candidate.runRef,
    observationId: candidate.observationId,
    terminal: candidate.terminal,
    policy: candidate.policy,
    metricSummary: candidate.metricSummary,
    events: selected.events,
    omittedEventCount: selected.omittedEventCount,
    presentation: observed,
    expiresAt: candidate.expiresAt
  }, bytes)))
}

export function mergeStoredTracePresentation (input: {
  readonly record: StoredTraceRecordV1
  readonly presentation: PresentationObservationV1
}): StoredTraceRecordV1 {
  const record = parseStoredTraceRecord(input.record)
  const presentation = joinPresentation(record.runRef, record.observationId, input.presentation)
  if (record.presentation.kind === 'observed') {
    if (JSON.stringify(record.presentation.value) === JSON.stringify(presentation)) return record
    throw new TypeError('trace presentation already exists')
  }
  const observed = Object.freeze({ kind: 'observed' as const, value: presentation })
  const marker = markerOf(record.events)
  const source = record.events.filter((event): event is Exclude<
  StoredRunTraceEventV1,
  TraceTruncatedEventV1
  > => event.type !== 'trace_truncated')
  const selected = internalSelectTraceEvents({
    events: source,
    existingOmittedCount: record.omittedEventCount,
    existingMarkerSequence: marker?.sequence ?? null,
    build: (events, omittedEventCount) => internalFinalizeSerialized(bytes => buildRecord({
      runRef: record.runRef,
      observationId: record.observationId,
      terminal: record.terminal,
      policy: record.policy,
      metricSummary: record.metricSummary,
      events,
      omittedEventCount,
      presentation: observed,
      expiresAt: record.expiresAt
    }, bytes))
  })
  return parseStoredTraceRecord(internalFinalizeSerialized(bytes => buildRecord({
    runRef: record.runRef,
    observationId: record.observationId,
    terminal: record.terminal,
    policy: record.policy,
    metricSummary: record.metricSummary,
    events: selected.events,
    omittedEventCount: selected.omittedEventCount,
    presentation: observed,
    expiresAt: record.expiresAt
  }, bytes)))
}
