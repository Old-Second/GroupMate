import type { TerminalRunStatus } from '../../agent/run/run-state.js'
import type {
  RunTraceEventV1,
  RunTraceMetricSummaryV1,
  StoredRunTraceEventV1
} from '../../agent/run/run-trace.js'
import type {
  PresentationFallbackReasonV1,
  PresentationReducerInputV1
} from './observation-event.js'
import { parseStoredTraceRecord } from './trace-record.js'

export interface TraceReplayReportV1 {
  readonly schemaVersion: 1
  readonly runRef: string
  readonly outcome: TerminalRunStatus
  readonly phases: readonly (RunTraceEventV1['type'] | 'unsupported_event')[]
  readonly omittedEventCount: number
  readonly unsupportedEventCount: number
  readonly metricSummary: RunTraceMetricSummaryV1
  readonly presentation:
    | { readonly kind: 'unavailable' }
    | {
        readonly kind: 'reduced'
        readonly selectedMode: PresentationReducerInputV1['selectedMode']
        readonly fallbackReason: PresentationFallbackReasonV1
      }
}

export type TraceReplayResult =
  | { readonly kind: 'replayed'; readonly report: TraceReplayReportV1 }
  | { readonly kind: 'invalid_trace' }
  | { readonly kind: 'unsupported_version' }

function schemaVersion (value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion')
    if (descriptor === undefined || !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !Number.isSafeInteger(descriptor.value) || Number(descriptor.value) < 1) {
      return null
    }
    return Number(descriptor.value)
  } catch {
    return null
  }
}

function unknownOptional (event: StoredRunTraceEventV1): boolean {
  return Object.hasOwn(event, 'optional')
}

export function replayTrace (value: unknown): TraceReplayResult {
  const version = schemaVersion(value)
  if (version === null) return Object.freeze({ kind: 'invalid_trace' })
  if (version !== 1) return Object.freeze({ kind: 'unsupported_version' })

  try {
    const record = parseStoredTraceRecord(value)
    let unsupportedEventCount = 0
    const phases: TraceReplayReportV1['phases'] = Object.freeze(record.events.map(event => {
      if (unknownOptional(event)) {
        unsupportedEventCount += 1
        return 'unsupported_event'
      }
      return event.type
    }) as Array<RunTraceEventV1['type'] | 'unsupported_event'>)
    const presentation: TraceReplayReportV1['presentation'] =
      record.presentation.kind === 'unavailable'
        ? Object.freeze({ kind: 'unavailable' })
        : Object.freeze({
            kind: 'reduced',
            selectedMode: record.presentation.value.reducerInput.selectedMode,
            fallbackReason: record.presentation.value.reducerInput.fallbackReason
          })
    return Object.freeze({
      kind: 'replayed',
      report: Object.freeze({
        schemaVersion: 1,
        runRef: record.runRef,
        outcome: record.terminal.status,
        phases,
        omittedEventCount: record.omittedEventCount,
        unsupportedEventCount,
        metricSummary: record.metricSummary,
        presentation
      })
    })
  } catch {
    return Object.freeze({ kind: 'invalid_trace' })
  }
}
