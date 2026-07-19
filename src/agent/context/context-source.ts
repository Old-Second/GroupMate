import {
  MAX_CONTEXT_SPANS,
  parseContextSpanV1,
  type ContextSpanV1
} from './context-span.js'
import {
  inspectContextArray,
  inspectContextRecord,
  invalidContextValue,
  requireContextAscii,
  requireSafeInteger
} from './context-token-estimator.js'

export interface ContextSourceRequest {
  readonly namespaceRef: string
  readonly sceneRef: string
  readonly activeParticipantRefs: readonly string[]
}

export interface ContextSourceLimits {
  readonly maxItems: number
  readonly maxBytes: number
  readonly deadlineMs: number
}

export interface ContextSpanSource {
  retrieve(
    request: ContextSourceRequest,
    limits: ContextSourceLimits,
    signal: AbortSignal
  ): Promise<readonly ContextSpanV1[]>
}

export interface MemoryContextSource extends ContextSpanSource {}

export function parseContextSourceRequest (value: unknown): ContextSourceRequest {
  const input = inspectContextRecord(value, [
    'namespaceRef', 'sceneRef', 'activeParticipantRefs'
  ])
  const activeParticipantRefs = Object.freeze(
    inspectContextArray(input.activeParticipantRefs, MAX_CONTEXT_SPANS).map(requireContextAscii)
  )
  if (new Set(activeParticipantRefs).size !== activeParticipantRefs.length) {
    return invalidContextValue()
  }
  return Object.freeze({
    namespaceRef: requireContextAscii(input.namespaceRef),
    sceneRef: requireContextAscii(input.sceneRef),
    activeParticipantRefs
  })
}

export function parseContextSourceLimits (value: unknown): ContextSourceLimits {
  const input = inspectContextRecord(value, ['maxItems', 'maxBytes', 'deadlineMs'])
  const limits = Object.freeze({
    maxItems: requireSafeInteger(input.maxItems, { positive: true }),
    maxBytes: requireSafeInteger(input.maxBytes, { positive: true }),
    deadlineMs: requireSafeInteger(input.deadlineMs, { positive: true })
  })
  if (limits.maxItems > MAX_CONTEXT_SPANS || limits.maxBytes > 512 * 1_024) {
    return invalidContextValue()
  }
  return limits
}

function throwAbortReason (signal: AbortSignal): never {
  throw signal.reason
}

export async function retrieveMemoryContextSpans (
  source: ContextSpanSource,
  requestValue: ContextSourceRequest,
  limitsValue: ContextSourceLimits,
  signal: AbortSignal = new AbortController().signal
): Promise<readonly ContextSpanV1[]> {
  const request = parseContextSourceRequest(requestValue)
  const limits = parseContextSourceLimits(limitsValue)
  if (signal.aborted) return throwAbortReason(signal)
  let raw: readonly ContextSpanV1[]
  try {
    raw = await source.retrieve(request, limits, signal)
  } catch {
    if (signal.aborted) return throwAbortReason(signal)
    return invalidContextValue()
  }
  if (signal.aborted) return throwAbortReason(signal)
  const values = inspectContextArray(raw, limits.maxItems)
  const spans = Object.freeze(values.map(parseContextSpanV1))
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(spans), 'utf8')
  } catch {
    return invalidContextValue()
  }
  if (bytes > limits.maxBytes) return invalidContextValue()
  const anchors = new Set([request.sceneRef, ...request.activeParticipantRefs])
  for (const span of spans) {
    if (span.namespaceRef !== request.namespaceRef || span.source !== 'memory' ||
      span.provenance.kind !== 'memory_record' ||
      !span.sourceRefs.some(ref => ref.ref === span.provenance.ref &&
        ref.contentHash === span.provenance.contentHash) ||
      !span.sourceRefs.some(ref => anchors.has(ref.ref))) return invalidContextValue()
  }
  return spans
}
