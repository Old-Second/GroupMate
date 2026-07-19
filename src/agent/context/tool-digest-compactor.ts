import { types as utilTypes } from 'node:util'
import type { ToolResult } from '../tools/tool-result.js'
import { parseToolResult, toolResultForModel } from '../tools/tool-result.js'
import {
  createContextArtifactV1,
  MAX_CONTEXT_ARTIFACT_CONTENT_BYTES,
  MAX_CONTEXT_ARTIFACT_REFS,
  type ContextArtifactV1
} from './context-artifact.js'
import {
  CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN,
  MAX_CONTEXT_COMPACTION_TOOL_CALLS,
  type ContextCompactionRequestV1
} from './context-planner.js'
import {
  contextSpanHash,
  domainSeparatedContextHash,
  parseContextSourceRefs,
  parseContextSpanV1,
  type ContextSourceRefV1,
  type ContextSpanV1
} from './context-span.js'
import {
  canonicalizeContextJsonValue,
  canonicalJsonStringify,
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  inspectContextArray,
  inspectContextRecord,
  requireContextAscii,
  requireSafeInteger
} from './context-token-estimator.js'

export const TOOL_DIGEST_GENERATOR_VERSION = 'consumed-tool-digest-v1'
export const CONSUMED_TOOL_DIGEST_PREFIX = 'Consumed tool protocol digest v1\n'
export const CONSUMED_TOOL_ARGUMENTS_HASH_DOMAIN = 'groupmate.context.tool-digest-arguments.v1'
export const CONSUMED_TOOL_RESULT_HASH_DOMAIN = 'groupmate.context.tool-digest-result.v1'
export const CONSUMED_TOOL_PROTOCOL_HASH_DOMAIN = 'groupmate.context.tool-digest-protocol.v1'
export const CONSUMED_TOOL_SOURCE_REFS_HASH_DOMAIN = 'groupmate.context.tool-digest-source-refs.v1'
export const MAX_CONSUMED_TOOL_DIGEST_CALLS = MAX_CONTEXT_COMPACTION_TOOL_CALLS
export const MAX_CONSUMED_TOOL_DIGEST_DISPLAY_CALLS = 4
export const MAX_CONSUMED_TOOL_ARGUMENTS_PREVIEW_BYTES = 192
export const MAX_CONSUMED_TOOL_RESULT_PREVIEW_BYTES = 256

export type ConsumedToolDigestTerminalStatus =
  | 'denied'
  | 'rejected'
  | 'expired'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

export interface ConsumedToolDigestEvidenceV1 {
  readonly schemaVersion: 1
  readonly step: number
  readonly calls: readonly Readonly<{
    readonly callId: string
    readonly terminalStatus: ConsumedToolDigestTerminalStatus
    readonly result: ToolResult
  }>[]
}

export type ToolDigestCompactionResult =
  | Readonly<{ readonly status: 'ready'; readonly artifact: ContextArtifactV1 }>
  | Readonly<{
      readonly status: 'unavailable'
      readonly code: 'invalid_compaction_request' | 'invalid_compaction_evidence' |
        'tool_protocol_incomplete' | 'tool_protocol_limit_exceeded' | 'artifact_limit_exceeded'
    }>

const INVALID_REQUEST = Object.freeze({
  status: 'unavailable' as const,
  code: 'invalid_compaction_request' as const
})
const INCOMPLETE_PROTOCOL = Object.freeze({
  status: 'unavailable' as const,
  code: 'tool_protocol_incomplete' as const
})
const INVALID_EVIDENCE = Object.freeze({
  status: 'unavailable' as const,
  code: 'invalid_compaction_evidence' as const
})
const ARTIFACT_LIMIT = Object.freeze({
  status: 'unavailable' as const,
  code: 'artifact_limit_exceeded' as const
})
const PROTOCOL_LIMIT = Object.freeze({
  status: 'unavailable' as const,
  code: 'tool_protocol_limit_exceeded' as const
})

interface DigestSource {
  readonly callId: string
  readonly tool: string
  readonly argumentsValue: ReturnType<typeof canonicalizeContextJsonValue>
  readonly argumentsText: string
  readonly resultText: string
  readonly resultValue: ReturnType<typeof canonicalizeContextJsonValue>
  readonly resultCanonical: string
  readonly terminalStatus: ConsumedToolDigestTerminalStatus
  readonly resultStatus: ToolResult['status']
}

interface DigestCall {
  readonly ordinal: number
  readonly callId: string
  readonly toolName: string
  readonly argumentsBytes: number
  readonly argumentsHash: string
  readonly argumentsPreview: string
  readonly argumentsTruncated: boolean
  readonly terminalStatus: ConsumedToolDigestTerminalStatus
  readonly resultStatus: ToolResult['status']
  readonly resultBytes: number
  readonly resultHash: string
  readonly resultPreview: string | null
  readonly resultPreviewOmitted: boolean
  readonly resultTruncated: boolean
}

function requestJson (request: Omit<ContextCompactionRequestV1, 'requestId'>): string {
  return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(request.namespaceRef)},"generation":${request.generation},"kind":${JSON.stringify(request.kind)},"sourceSpanIds":[${request.sourceSpanIds.map(value => JSON.stringify(value)).join(',')}],"sourceRefs":[${request.sourceRefs.map(ref => `{"ref":${JSON.stringify(ref.ref)},"contentHash":${JSON.stringify(ref.contentHash)}}`).join(',')}]}`
}

function expectedSourceRefs (span: ContextSpanV1): readonly ContextSourceRefV1[] | null {
  const refs: ContextSourceRefV1[] = [Object.freeze({
    ref: span.spanId,
    contentHash: contextSpanHash(span)
  })]
  const seen = new Map(refs.map(ref => [ref.ref, ref.contentHash]))
  for (const ref of span.sourceRefs) {
    const prior = seen.get(ref.ref)
    if (prior !== undefined) {
      if (prior !== ref.contentHash) return null
      continue
    }
    seen.set(ref.ref, ref.contentHash)
    refs.push(ref)
  }
  return refs.length <= MAX_CONTEXT_ARTIFACT_REFS ? Object.freeze(refs) : null
}

function parseRequest (
  value: ContextCompactionRequestV1,
  span: ContextSpanV1
): ContextCompactionRequestV1 | null {
  try {
    const input = inspectContextRecord(value, [
      'schemaVersion', 'requestId', 'namespaceRef', 'generation', 'kind',
      'sourceSpanIds', 'sourceRefs'
    ])
    if (input.schemaVersion !== 1 || input.kind !== 'tool_digest') return null
    const sourceSpanIds = Object.freeze(inspectContextArray(input.sourceSpanIds, MAX_CONTEXT_ARTIFACT_REFS)
      .map(requireContextAscii))
    const sourceRefs = parseContextSourceRefs(input.sourceRefs, MAX_CONTEXT_ARTIFACT_REFS)
    const partial = Object.freeze({
      schemaVersion: 1 as const,
      namespaceRef: requireContextAscii(input.namespaceRef),
      generation: requireSafeInteger(input.generation),
      kind: 'tool_digest' as const,
      sourceSpanIds,
      sourceRefs
    })
    const requestId = requireContextAscii(input.requestId)
    const expectedRefs = expectedSourceRefs(span)
    if (expectedRefs === null || partial.namespaceRef !== span.namespaceRef ||
      partial.generation !== span.originGeneration || sourceSpanIds.length !== 1 ||
      sourceSpanIds[0] !== span.spanId || sourceRefs.length !== expectedRefs.length ||
      sourceRefs.some((ref, index) => {
        const expected = expectedRefs[index]
        return expected === undefined || ref.ref !== expected.ref || ref.contentHash !== expected.contentHash
      }) || requestId !== `request:${domainSeparatedContextHash(
        CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN,
        requestJson(partial)
      )}`) return null
    return Object.freeze({ ...partial, requestId })
  } catch {
    return null
  }
}

function truncateUtf8 (value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  const codePoints = [...value]
  let low = 0
  let high = codePoints.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(codePoints.slice(0, middle).join(''), 'utf8') <= maximumBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return codePoints.slice(0, low).join('')
}

function assertDeepFrozenData (
  value: unknown,
  depth = 0,
  state: { nodes: number; readonly ancestors: Set<object> } = { nodes: 0, ancestors: new Set() }
): void {
  state.nodes += 1
  if (state.nodes > 8_192 || depth > 32) throw new TypeError('invalid compaction evidence')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return
  if (typeof value !== 'object' || utilTypes.isProxy(value) || state.ancestors.has(value)) {
    throw new TypeError('invalid compaction evidence')
  }
  state.ancestors.add(value)
  try {
    if (!Object.isFrozen(value)) throw new TypeError('invalid compaction evidence')
    const prototype = Object.getPrototypeOf(value) as object | null
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError('invalid compaction evidence')
      const keys = Reflect.ownKeys(value)
      if (keys.some(key => key !== 'length' && (
        typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      )) || Object.keys(value).length !== value.length) throw new TypeError('invalid compaction evidence')
      for (const item of value) assertDeepFrozenData(item, depth + 1, state)
      return
    }
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid compaction evidence')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.entries(descriptors).some(([, descriptor]) => (
      !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    ))) throw new TypeError('invalid compaction evidence')
    for (const descriptor of Object.values(descriptors)) {
      assertDeepFrozenData(descriptor.value, depth + 1, state)
    }
  } finally {
    state.ancestors.delete(value)
  }
}

function resultMatchesTerminalStatus (
  terminalStatus: ConsumedToolDigestTerminalStatus,
  result: ToolResult
): boolean {
  switch (terminalStatus) {
    case 'succeeded': return result.status === 'success'
    case 'denied':
    case 'rejected':
    case 'expired': return result.status === 'denied'
    case 'cancelled': return result.status === 'failed' && result.errorCode === 'tool_cancelled'
    case 'failed': return result.status === 'failed' && result.errorCode !== 'tool_cancelled'
    case 'indeterminate': return result.status === 'indeterminate'
  }
}

function parseEvidence (
  value: ConsumedToolDigestEvidenceV1,
  span: ContextSpanV1
): readonly Readonly<{
  readonly callId: string
  readonly terminalStatus: ConsumedToolDigestTerminalStatus
  readonly result: ToolResult
}>[] | null {
  try {
    assertDeepFrozenData(value)
    const input = inspectContextRecord(value, ['schemaVersion', 'step', 'calls'])
    if (input.schemaVersion !== 1 || requireSafeInteger(input.step) !== span.toolProtocol?.step) {
      return null
    }
    const calls = Object.freeze(inspectContextArray(input.calls, MAX_CONSUMED_TOOL_DIGEST_CALLS).map(
      (rawCall, index) => {
        const call = inspectContextRecord(rawCall, ['callId', 'terminalStatus', 'result'])
        const callId = requireContextAscii(call.callId)
        const terminalStatus = call.terminalStatus
        if (terminalStatus !== 'denied' && terminalStatus !== 'rejected' && terminalStatus !== 'expired' &&
          terminalStatus !== 'succeeded' && terminalStatus !== 'failed' && terminalStatus !== 'cancelled' &&
          terminalStatus !== 'indeterminate') throw new TypeError('invalid terminal status')
        const result = parseToolResult(call.result)
        const message = span.messages[index + 1]
        if (callId !== span.toolProtocol?.callIds[index] || message?.role !== 'tool' ||
          message.toolCallId !== callId || !resultMatchesTerminalStatus(terminalStatus, result) ||
          toolResultForModel(result).normalize('NFC') !== message.content) {
          throw new TypeError('evidence does not match protocol')
        }
        return Object.freeze({ callId, terminalStatus, result })
      }
    ))
    if (calls.length === 0 || calls.length !== span.toolProtocol?.callIds.length) return null
    return calls
  } catch {
    return null
  }
}

function digestContent (
  sources: readonly DigestSource[],
  request: ContextCompactionRequestV1,
  span: ContextSpanV1
): string | null {
  const protocol = span.toolProtocol
  if (protocol === null) return null
  const sourceSpanHash = contextSpanHash(span)
  const sourceRefsHash = domainSeparatedContextHash(
    CONSUMED_TOOL_SOURCE_REFS_HASH_DOMAIN,
    canonicalJsonStringify(canonicalizeContextJsonValue(request.sourceRefs))
  )
  const completeCalls = Object.freeze(sources.map((source, ordinal) => Object.freeze({
    ordinal,
    callId: source.callId,
    toolName: source.tool,
    arguments: source.argumentsValue,
    terminalStatus: source.terminalStatus,
    result: source.resultValue
  })))
  const protocolHash = domainSeparatedContextHash(
    CONSUMED_TOOL_PROTOCOL_HASH_DOMAIN,
    canonicalJsonStringify(canonicalizeContextJsonValue(Object.freeze({
      sourceSpanId: span.spanId,
      sourceSpanHash,
      sourceRefs: request.sourceRefs,
      step: protocol.step,
      calls: completeCalls
    })))
  )
  const calls: readonly DigestCall[] = Object.freeze(sources
    .slice(0, MAX_CONSUMED_TOOL_DIGEST_DISPLAY_CALLS)
    .map((source, index) => {
      const complete = completeCalls[index]
      if (complete === undefined) throw new TypeError('complete digest call is missing')
      const argumentsBytes = Buffer.byteLength(source.argumentsText, 'utf8')
      const resultBytes = Buffer.byteLength(source.resultCanonical, 'utf8')
      return Object.freeze({
        ordinal: complete.ordinal,
        callId: source.callId,
        toolName: source.tool,
        terminalStatus: source.terminalStatus,
        resultStatus: source.resultStatus,
        argumentsBytes,
        argumentsHash: domainSeparatedContextHash(
          CONSUMED_TOOL_ARGUMENTS_HASH_DOMAIN,
          source.argumentsText
        ),
        argumentsPreview: truncateUtf8(
          source.argumentsText,
          MAX_CONSUMED_TOOL_ARGUMENTS_PREVIEW_BYTES
        ),
        argumentsTruncated: argumentsBytes > MAX_CONSUMED_TOOL_ARGUMENTS_PREVIEW_BYTES,
        resultBytes,
        resultHash: domainSeparatedContextHash(
          CONSUMED_TOOL_RESULT_HASH_DOMAIN,
          source.resultCanonical
        ),
        resultPreview: source.resultStatus === 'success'
          ? truncateUtf8(source.resultText, MAX_CONSUMED_TOOL_RESULT_PREVIEW_BYTES)
          : null,
        resultPreviewOmitted: source.resultStatus !== 'success',
        resultTruncated: source.resultStatus === 'success' &&
          Buffer.byteLength(source.resultText, 'utf8') > MAX_CONSUMED_TOOL_RESULT_PREVIEW_BYTES
      })
    }))
  const payload = Object.freeze({
    schemaVersion: 1,
    sourceSpanId: span.spanId,
    sourceSpanHash,
    sourceRefsHash,
    step: protocol.step,
    callCount: sources.length,
    omittedCallCount: Math.max(0, sources.length - calls.length),
    protocolHash,
    calls
  })
  const content = `${CONSUMED_TOOL_DIGEST_PREFIX}${canonicalJsonStringify(
    canonicalizeContextJsonValue(payload)
  )}`
  return Buffer.byteLength(content, 'utf8') <= MAX_CONTEXT_ARTIFACT_CONTENT_BYTES
    ? content
    : null
}

export function compactConsumedToolSpan (
  requestValue: ContextCompactionRequestV1,
  spanValue: ContextSpanV1,
  evidenceValue: ConsumedToolDigestEvidenceV1
): ToolDigestCompactionResult {
  let span: ContextSpanV1
  try {
    span = parseContextSpanV1(spanValue)
  } catch {
    return INCOMPLETE_PROTOCOL
  }
  if (span.kind !== 'tool_protocol' || span.source !== 'tool_chain' ||
    span.toolProtocol?.phase !== 'consumed' || span.messages.length < 2) {
    return INCOMPLETE_PROTOCOL
  }
  if (span.toolProtocol.callIds.length > MAX_CONSUMED_TOOL_DIGEST_CALLS) return PROTOCOL_LIMIT
  const request = parseRequest(requestValue, span)
  if (request === null) return INVALID_REQUEST
  const evidence = parseEvidence(evidenceValue, span)
  if (evidence === null) return INVALID_EVIDENCE
  const assistant = span.messages[0]
  if (assistant?.role !== 'assistant' || assistant.toolCalls === undefined ||
    assistant.toolCalls.length !== span.messages.length - 1) return INCOMPLETE_PROTOCOL
  const sources: DigestSource[] = []
  for (const [index, call] of assistant.toolCalls.entries()) {
    const result = span.messages[index + 1]
    const evidenceCall = evidence[index]
    if (result?.role !== 'tool' || result.toolCallId !== call.callId) return INCOMPLETE_PROTOCOL
    if (evidenceCall === undefined) return INVALID_EVIDENCE
    const argumentsValue = canonicalizeContextJsonValue(call.arguments)
    const resultValue = canonicalizeContextJsonValue(evidenceCall.result)
    sources.push(Object.freeze({
      callId: call.callId,
      tool: call.name,
      argumentsValue,
      argumentsText: canonicalJsonStringify(argumentsValue),
      resultText: result.content,
      resultValue,
      resultCanonical: canonicalJsonStringify(resultValue),
      terminalStatus: evidenceCall.terminalStatus,
      resultStatus: evidenceCall.result.status
    }))
  }
  const content = digestContent(Object.freeze(sources), request, span)
  if (content === null) return ARTIFACT_LIMIT
  try {
    return Object.freeze({
      status: 'ready' as const,
      artifact: createContextArtifactV1(Object.freeze({
        namespaceRef: request.namespaceRef,
        generation: request.generation,
        kind: 'tool_digest' as const,
        sourceSpanIds: request.sourceSpanIds,
        sourceRefs: request.sourceRefs,
        content,
        generator: Object.freeze({
          kind: 'deterministic' as const,
          version: TOOL_DIGEST_GENERATOR_VERSION
        }),
        estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
      }))
    })
  } catch {
    return ARTIFACT_LIMIT
  }
}
