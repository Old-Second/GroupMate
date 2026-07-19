import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextArtifactToSpan,
  MAX_CONTEXT_ARTIFACT_CONTENT_BYTES
} from '../../src/agent/context/context-artifact.js'
import {
  CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN,
  type ContextCompactionRequestV1
} from '../../src/agent/context/context-planner.js'
import {
  contextSpanHash,
  createContextSpanV1,
  domainSeparatedContextHash,
  type ContextSourceRefV1,
  type ContextSpanV1,
  type ContextToolProtocolPhase
} from '../../src/agent/context/context-span.js'
import {
  compactConsumedToolSpan,
  CONSUMED_TOOL_ARGUMENTS_HASH_DOMAIN,
  CONSUMED_TOOL_DIGEST_PREFIX,
  CONSUMED_TOOL_PROTOCOL_HASH_DOMAIN,
  CONSUMED_TOOL_RESULT_HASH_DOMAIN,
  CONSUMED_TOOL_SOURCE_REFS_HASH_DOMAIN,
  MAX_CONSUMED_TOOL_DIGEST_CALLS,
  MAX_CONSUMED_TOOL_DIGEST_DISPLAY_CALLS,
  type ConsumedToolDigestEvidenceV1,
  type ConsumedToolDigestTerminalStatus,
  TOOL_DIGEST_GENERATOR_VERSION
} from '../../src/agent/context/tool-digest-compactor.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import {
  canonicalizeContextJsonValue,
  canonicalJsonStringify
} from '../../src/agent/context/context-token-estimator.js'

const HASH = 'a'.repeat(64)

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function protocolSpan (options: {
  readonly phase?: ContextToolProtocolPhase
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly result?: string
  readonly results?: readonly string[]
  readonly sourceRefs?: readonly ContextSourceRefV1[]
  readonly callCount?: number
} = {}): ContextSpanV1 {
  const phase = options.phase ?? 'consumed'
  const callCount = options.callCount ?? 1
  const calls = Array.from({ length: callCount }, (_, index) => ({
    callId: `call-${index}`,
    name: `fixture_tool_${index}`,
    arguments: options.arguments ?? { city: 'Beijing', unit: 'c' }
  }))
  const complete = phase === 'ready' || phase === 'consumed'
  return createContextSpanV1(deepFreeze({
    spanId: 'span:tool:fixture',
    namespaceRef: 'namespace:fixture',
    kind: 'tool_protocol' as const,
    source: 'tool_chain' as const,
    trust: 'untrusted' as const,
    requirement: phase === 'consumed' ? 'optional' as const : 'mandatory' as const,
    priority: 'normal' as const,
    semanticOrder: 30,
    originGeneration: 7,
    provenance: {
      kind: 'tool_ledger' as const,
      ref: 'run:fixture:tool:7',
      revision: 7,
      contentHash: HASH
    },
    supersedes: null,
    messages: [
      { role: 'assistant' as const, content: null, toolCalls: calls },
      ...(complete
        ? calls.map((call, index) => ({
            role: 'tool' as const,
            content: options.results?.[index] ?? options.result ?? `result for ${call.callId}`,
            toolCallId: call.callId
          }))
        : [])
    ],
    sourceRefs: options.sourceRefs ?? [{ ref: 'ledger:fixture:7', contentHash: 'b'.repeat(64) }],
    toolProtocol: {
      phase,
      step: 7,
      callIds: calls.map(call => call.callId)
    }
  }))
}

function requestJson (request: Omit<ContextCompactionRequestV1, 'requestId'>): string {
  return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(request.namespaceRef)},"generation":${request.generation},"kind":${JSON.stringify(request.kind)},"sourceSpanIds":[${request.sourceSpanIds.map(value => JSON.stringify(value)).join(',')}],"sourceRefs":[${request.sourceRefs.map(ref => `{"ref":${JSON.stringify(ref.ref)},"contentHash":${JSON.stringify(ref.contentHash)}}`).join(',')}]}`
}

function requestFor (span: ContextSpanV1): ContextCompactionRequestV1 {
  const refs: ContextSourceRefV1[] = [{ ref: span.spanId, contentHash: contextSpanHash(span) }]
  for (const ref of span.sourceRefs) {
    if (!refs.some(existing => existing.ref === ref.ref)) refs.push(ref)
  }
  const partial = deepFreeze({
    schemaVersion: 1 as const,
    namespaceRef: span.namespaceRef,
    generation: span.originGeneration,
    kind: 'tool_digest' as const,
    sourceSpanIds: [span.spanId],
    sourceRefs: refs
  })
  return deepFreeze({
    ...partial,
    requestId: `request:${domainSeparatedContextHash(
      CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN,
      requestJson(partial)
    )}`
  })
}

function resultFor (
  terminalStatus: ConsumedToolDigestTerminalStatus,
  content: string
): ToolResult {
  if (terminalStatus === 'succeeded') {
    return deepFreeze({
      status: 'success' as const,
      effect: 'none' as const,
      content: [{ type: 'text' as const, text: content }],
      retryable: false as const
    })
  }
  if (terminalStatus === 'denied' || terminalStatus === 'rejected' || terminalStatus === 'expired') {
    return deepFreeze({
      status: 'denied' as const,
      effect: 'none' as const,
      reasonCode: 'permission_denied' as const,
      userMessage: content,
      retryable: false as const
    })
  }
  if (terminalStatus === 'indeterminate') {
    return deepFreeze({
      status: 'indeterminate' as const,
      effect: 'possible' as const,
      errorCode: 'tool_outcome_unknown' as const,
      userMessage: content,
      retryable: false as const
    })
  }
  return deepFreeze({
    status: 'failed' as const,
    effect: 'none' as const,
    errorCode: terminalStatus === 'cancelled' ? 'tool_cancelled' as const : 'tool_execution_failed' as const,
    userMessage: content,
    retryable: false
  })
}

function evidenceFor (
  span: ContextSpanV1,
  terminalStatuses: readonly ConsumedToolDigestTerminalStatus[] = ['succeeded']
): ConsumedToolDigestEvidenceV1 {
  assert.ok(span.toolProtocol !== null)
  return deepFreeze({
    schemaVersion: 1 as const,
    step: span.toolProtocol.step,
    calls: span.toolProtocol.callIds.map((callId, index) => {
      const message = span.messages[index + 1]
      assert.equal(message?.role, 'tool')
      if (message?.role !== 'tool') throw new Error('tool fixture is missing')
      const terminalStatus = terminalStatuses[index] ?? terminalStatuses[0] ?? 'succeeded'
      return {
        callId,
        terminalStatus,
        result: resultFor(terminalStatus, message.content)
      }
    })
  })
}

function ready (
  span: ContextSpanV1,
  request = requestFor(span),
  evidence = evidenceFor(span)
) {
  const result = compactConsumedToolSpan(request, span, evidence)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('expected a compacted artifact')
  return result.artifact
}

function digestPayload (content: string): Record<string, unknown> {
  assert.equal(content.startsWith(CONSUMED_TOOL_DIGEST_PREFIX), true)
  return JSON.parse(content.slice(CONSUMED_TOOL_DIGEST_PREFIX.length)) as Record<string, unknown>
}

test('consumed tool digest canonicalizes argument key order and preserves low-trust provenance', () => {
  const first = protocolSpan({ arguments: { z: 1, a: { y: true, x: false } } })
  const second = protocolSpan({ arguments: { a: { x: false, y: true }, z: 1 } })
  const firstArtifact = ready(first)
  const secondArtifact = ready(second)

  assert.deepEqual(secondArtifact, firstArtifact)
  assert.equal(firstArtifact.generator.kind, 'deterministic')
  assert.equal(firstArtifact.generator.version, TOOL_DIGEST_GENERATOR_VERSION)
  assert.deepEqual(firstArtifact.sourceSpanIds, [first.spanId])
  assert.deepEqual(firstArtifact.sourceRefs, requestFor(first).sourceRefs)

  const content = digestPayload(firstArtifact.content) as unknown as {
    schemaVersion: number
    protocolHash: string
    sourceSpanId: string
    sourceSpanHash: string
    sourceRefsHash: string
    step: number
    callCount: number
    omittedCallCount: number
    calls: Array<{
      callId: string
      ordinal: number
      toolName: string
      argumentsBytes: number
      argumentsHash: string
      argumentsPreview: string
      argumentsTruncated: boolean
      terminalStatus: string
      resultStatus: string
      resultBytes: number
      resultHash: string
      resultPreview: string | null
      resultPreviewOmitted: boolean
      resultTruncated: boolean
    }>
  }
  assert.equal(content.schemaVersion, 1)
  assert.equal(content.calls[0]?.callId, 'call-0')
  assert.equal(content.calls[0]?.ordinal, 0)
  assert.equal(content.calls[0]?.toolName, 'fixture_tool_0')
  assert.equal(content.calls[0]?.argumentsPreview, '{"a":{"x":false,"y":true},"z":1}')
  assert.equal(content.calls[0]?.terminalStatus, 'succeeded')
  assert.equal(content.calls[0]?.resultStatus, 'success')
  assert.equal(content.sourceSpanId, first.spanId)
  assert.equal(content.sourceSpanHash, contextSpanHash(first))
  assert.match(content.sourceRefsHash, /^[0-9a-f]{64}$/)
  assert.equal(content.step, 7)
  assert.equal(content.callCount, 1)
  assert.equal(content.omittedCallCount, 0)
  assert.match(content.protocolHash, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(content).sort(), [
    'callCount', 'calls', 'omittedCallCount', 'protocolHash', 'schemaVersion',
    'sourceRefsHash', 'sourceSpanHash', 'sourceSpanId', 'step'
  ])

  const artifactSpan = contextArtifactToSpan(firstArtifact, 30)
  assert.equal(artifactSpan.messages[0]?.role, 'user')
  assert.equal(artifactSpan.kind, 'artifact')
  assert.equal(artifactSpan.trust, 'untrusted')
  assert.equal(artifactSpan.requirement, 'optional')
  assert.equal(artifactSpan.priority, 'low')
  assert.equal(artifactSpan.toolProtocol, null)
})

test('consumed tool digest has a literal canonical golden vector', () => {
  const span = protocolSpan({ arguments: { z: 1, a: { y: true, x: false } } })
  const artifact = ready(span)
  assert.equal(artifact.content,
    'Consumed tool protocol digest v1\n' +
    '{"callCount":1,"calls":[{"argumentsBytes":32,"argumentsHash":"dd1e4f165f2bb5b7fc3521a258dafe00296206d9fcb1f0d4f214f80b66319513","argumentsPreview":"{\\"a\\":{\\"x\\":false,\\"y\\":true},\\"z\\":1}","argumentsTruncated":false,"callId":"call-0","ordinal":0,"resultBytes":109,"resultHash":"842235cf446b8a8eaa56f5802aa491e2252f12d440d879bd9efecb6e4d633460","resultPreview":"result for call-0","resultPreviewOmitted":false,"resultStatus":"success","resultTruncated":false,"terminalStatus":"succeeded","toolName":"fixture_tool_0"}],"omittedCallCount":0,"protocolHash":"c67e75dde677addf5fe76284afdf0e7eae5b6aeeab9ed3c4be541b75ad4e7303","schemaVersion":1,"sourceRefsHash":"7017991cc8205dd5651035e04a15ad3e33d13e2a5b1d81d845a38855d31831c2","sourceSpanHash":"902731a5c9625c2ac07181f5bb64e030a660e8c7dce9032b67b1c46fb225147f","sourceSpanId":"span:tool:fixture","step":7}'
  )
})

test('digest truncates summaries at Unicode boundaries while retaining full canonical source hashes', () => {
  const argumentsValue = { text: '你😀'.repeat(4_000) }
  const resultValue = '结果😀'.repeat(4_000)
  const span = protocolSpan({ arguments: argumentsValue, result: resultValue })
  const artifact = ready(span)
  const content = digestPayload(artifact.content) as unknown as {
    calls: Array<{
      argumentsBytes: number
      argumentsHash: string
      argumentsPreview: string
      argumentsTruncated: boolean
      resultBytes: number
      resultHash: string
      resultPreview: string | null
      resultPreviewOmitted: boolean
      resultTruncated: boolean
    }>
  }
  const call = content.calls[0]
  assert.ok(call !== undefined)
  assert.equal(Buffer.byteLength(artifact.content, 'utf8') <= MAX_CONTEXT_ARTIFACT_CONTENT_BYTES, true)
  const argumentsText = '{"text":' + JSON.stringify(argumentsValue.text) + '}'
  const resultText = canonicalJsonStringify(canonicalizeContextJsonValue(resultFor('succeeded', resultValue)))
  assert.equal(call.argumentsHash, domainSeparatedContextHash(
    CONSUMED_TOOL_ARGUMENTS_HASH_DOMAIN, argumentsText
  ))
  assert.equal(call.resultHash, domainSeparatedContextHash(CONSUMED_TOOL_RESULT_HASH_DOMAIN, resultText))
  assert.equal(call.argumentsBytes, Buffer.byteLength(argumentsText, 'utf8'))
  assert.equal(call.resultBytes, Buffer.byteLength(resultText, 'utf8'))
  assert.equal(call.argumentsTruncated, true)
  assert.equal(call.resultTruncated, true)
  assert.equal(call.resultPreviewOmitted, false)
  assert.equal(Buffer.byteLength(call.argumentsPreview, 'utf8') <= 192, true)
  assert.equal(Buffer.byteLength(call.resultPreview ?? '', 'utf8') <= 256, true)
  assert.equal(Buffer.from(call.argumentsPreview, 'utf8').toString('utf8'), call.argumentsPreview)
  assert.equal(Buffer.from(call.resultPreview ?? '', 'utf8').toString('utf8'), call.resultPreview)
  assert.equal(/[\uD800-\uDFFF]/u.test(call.argumentsPreview.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')), false)
  assert.equal(/[\uD800-\uDFFF]/u.test((call.resultPreview ?? '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')), false)
  assert.equal((call.resultPreview ?? '').length < resultValue.length, true)
})

test('source content changes artifact identity and identical sources remain content-addressed', () => {
  const firstSpan = protocolSpan({ result: 'first result' })
  const secondSpan = protocolSpan({ result: 'second result' })
  const first = ready(firstSpan)
  const repeated = ready(firstSpan)
  const second = ready(secondSpan)

  assert.equal(repeated.artifactId, first.artifactId)
  assert.equal(repeated.contentHash, first.contentHash)
  assert.notEqual(second.artifactId, first.artifactId)
  assert.notEqual(second.contentHash, first.contentHash)
})

test('compactor rejects every non-consumed or incomplete protocol with body-free unavailable results', () => {
  const unrelatedEvidence = evidenceFor(protocolSpan())
  for (const phase of ['ready', 'awaiting', 'indeterminate'] as const) {
    const span = protocolSpan({ phase, result: 'SECRET_RESULT_BODY' })
    const result = compactConsumedToolSpan(requestFor(span), span, unrelatedEvidence)
    assert.deepEqual(result, { status: 'unavailable', code: 'tool_protocol_incomplete' })
    assert.doesNotMatch(JSON.stringify(result), /SECRET_RESULT_BODY/)
  }

  const consumed = protocolSpan({ result: 'SECRET_RESULT_BODY' })
  const missingResult = deepFreeze({ ...consumed, messages: consumed.messages.slice(0, 1) }) as ContextSpanV1
  const result = compactConsumedToolSpan(requestFor(consumed), missingResult, evidenceFor(consumed))
  assert.deepEqual(result, { status: 'unavailable', code: 'tool_protocol_incomplete' })
  assert.doesNotMatch(JSON.stringify(result), /SECRET_RESULT_BODY/)
})

test('compactor strictly binds request identity, ordered refs and artifact hard limits', () => {
  const span = protocolSpan()
  const valid = requestFor(span)
  const wrongOrder = deepFreeze({
    ...valid,
    sourceRefs: [...valid.sourceRefs].reverse()
  })
  assert.deepEqual(compactConsumedToolSpan(wrongOrder, span, evidenceFor(span)), {
    status: 'unavailable', code: 'invalid_compaction_request'
  })

  const duplicate = deepFreeze({
    ...valid,
    sourceRefs: [...valid.sourceRefs, valid.sourceRefs[0]]
  })
  assert.deepEqual(compactConsumedToolSpan(duplicate, span, evidenceFor(span)), {
    status: 'unavailable', code: 'invalid_compaction_request'
  })

  const overflowRefs = deepFreeze({
    ...valid,
    sourceRefs: Array.from({ length: 33 }, (_, index) => ({
      ref: `ref:${index}`,
      contentHash: `${index % 10}`.repeat(64)
    }))
  })
  assert.deepEqual(compactConsumedToolSpan(overflowRefs, span, evidenceFor(span)), {
    status: 'unavailable', code: 'invalid_compaction_request'
  })

  assert.equal(MAX_CONSUMED_TOOL_DIGEST_CALLS, 8)
  const oversizedEnvelope = protocolSpan({ callCount: 9 })
  const oversizedResult = compactConsumedToolSpan(
    requestFor(oversizedEnvelope), oversizedEnvelope, evidenceFor(oversizedEnvelope)
  )
  assert.deepEqual(oversizedResult, { status: 'unavailable', code: 'tool_protocol_limit_exceeded' })
})

test('strict evidence is the only source of terminal and ToolResult status', () => {
  const mappings: ReadonlyArray<readonly [ConsumedToolDigestTerminalStatus, ToolResult['status']]> = [
    ['succeeded', 'success'],
    ['denied', 'denied'],
    ['rejected', 'denied'],
    ['expired', 'denied'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['indeterminate', 'indeterminate']
  ]
  for (const [terminalStatus, resultStatus] of mappings) {
    const message = terminalStatus === 'succeeded' ? `result ${terminalStatus}` : `Result ${terminalStatus}`
    const span = protocolSpan({ result: message })
    const artifact = ready(span, requestFor(span), evidenceFor(span, [terminalStatus]))
    const content = digestPayload(artifact.content) as unknown as {
      calls: Array<{
        terminalStatus: string
        resultStatus: string
        resultPreview: string | null
        resultPreviewOmitted: boolean
      }>
    }
    assert.equal(content.calls[0]?.terminalStatus, terminalStatus)
    assert.equal(content.calls[0]?.resultStatus, resultStatus)
    assert.equal(content.calls[0]?.resultPreview, terminalStatus === 'succeeded' ? message : null)
    assert.equal(content.calls[0]?.resultPreviewOmitted, terminalStatus !== 'succeeded')
  }

  const span = protocolSpan({ result: 'SECRET_EVIDENCE_BODY' })
  const valid = evidenceFor(span)
  const mutable = {
    schemaVersion: 1 as const,
    step: valid.step,
    calls: valid.calls
  }
  const wrongStep = deepFreeze({ ...valid, step: valid.step + 1 })
  const mismatchedResult = deepFreeze({
    ...valid,
    calls: [{
      ...valid.calls[0],
      result: resultFor('succeeded', 'different model output')
    }]
  })
  const consumedAsStatus = deepFreeze({
    ...valid,
    calls: [{ ...valid.calls[0], terminalStatus: 'consumed' }]
  }) as unknown as ConsumedToolDigestEvidenceV1
  const accessor = Object.freeze(Object.defineProperty({}, 'schemaVersion', {
    enumerable: true,
    get: () => 1
  })) as unknown as ConsumedToolDigestEvidenceV1
  const hostileProxy = new Proxy(valid, {})
  let proxyTrapCalls = 0
  const explosiveProxy = new Proxy(valid, {
    get: () => { proxyTrapCalls += 1; throw new Error('SECRET_PROXY_TRAP') },
    getOwnPropertyDescriptor: () => { proxyTrapCalls += 1; throw new Error('SECRET_PROXY_TRAP') },
    getPrototypeOf: () => { proxyTrapCalls += 1; throw new Error('SECRET_PROXY_TRAP') },
    ownKeys: () => { proxyTrapCalls += 1; throw new Error('SECRET_PROXY_TRAP') }
  })
  for (const evidence of [
    mutable, wrongStep, mismatchedResult, consumedAsStatus, accessor, hostileProxy, explosiveProxy
  ]) {
    const result = compactConsumedToolSpan(requestFor(span), span, evidence)
    assert.deepEqual(result, { status: 'unavailable', code: 'invalid_compaction_evidence' })
    assert.doesNotMatch(JSON.stringify(result), /SECRET_EVIDENCE_BODY|different model output|SECRET_PROXY_TRAP/)
  }
  assert.equal(proxyTrapCalls, 0)
})

test('digest displays four calls but binds every ordered call into the protocol hash', () => {
  assert.equal(MAX_CONSUMED_TOOL_DIGEST_DISPLAY_CALLS, 4)
  const five = protocolSpan({ callCount: 5 })
  const first = ready(five)
  const payload = digestPayload(first.content) as unknown as {
    calls: readonly unknown[]
    callCount: number
    omittedCallCount: number
    protocolHash: string
  }
  assert.equal(payload.calls.length, 4)
  assert.equal(payload.callCount, 5)
  assert.equal(payload.omittedCallCount, 1)
  assert.match(payload.protocolHash, /^[0-9a-f]{64}$/)

  const changed = protocolSpan({ callCount: 5, result: 'changed fifth and all fixture results' })
  const second = ready(changed)
  const changedPayload = digestPayload(second.content) as unknown as { protocolHash: string }
  assert.notEqual(changedPayload.protocolHash, payload.protocolHash)
  assert.notEqual(second.artifactId, first.artifactId)
  assert.equal(CONSUMED_TOOL_PROTOCOL_HASH_DOMAIN, 'groupmate.context.tool-digest-protocol.v1')
  assert.equal(CONSUMED_TOOL_ARGUMENTS_HASH_DOMAIN, 'groupmate.context.tool-digest-arguments.v1')
  assert.equal(CONSUMED_TOOL_RESULT_HASH_DOMAIN, 'groupmate.context.tool-digest-result.v1')
  assert.equal(CONSUMED_TOOL_SOURCE_REFS_HASH_DOMAIN, 'groupmate.context.tool-digest-source-refs.v1')
})

test('exactly eight calls bind hidden fifth and eighth results without changing displayed calls', () => {
  const baselineSpan = protocolSpan({ callCount: 8 })
  const changedSpan = protocolSpan({
    callCount: 8,
    results: Array.from({ length: 8 }, (_, index) => (
      index === 4 || index === 7 ? `changed hidden call ${index}` : `result for call-${index}`
    ))
  })
  const baseline = ready(baselineSpan)
  const changed = ready(changedSpan)
  const baselinePayload = digestPayload(baseline.content) as unknown as {
    calls: readonly unknown[]
    callCount: number
    omittedCallCount: number
    protocolHash: string
  }
  const changedPayload = digestPayload(changed.content) as unknown as {
    calls: readonly unknown[]
    protocolHash: string
  }

  assert.equal(baselinePayload.callCount, 8)
  assert.equal(baselinePayload.omittedCallCount, 4)
  assert.equal(baselinePayload.calls.length, 4)
  assert.deepEqual(changedPayload.calls, baselinePayload.calls)
  assert.notEqual(changedPayload.protocolHash, baselinePayload.protocolHash)
  assert.notEqual(changed.artifactId, baseline.artifactId)
})

test('resultTruncated describes only truncation of a visible success preview', () => {
  const shortVisibleBody = 'v'.repeat(230)
  const success = ready(protocolSpan({ result: shortVisibleBody }))
  const successCall = (digestPayload(success.content) as unknown as {
    calls: Array<{
      resultBytes: number
      resultPreview: string | null
      resultPreviewOmitted: boolean
      resultTruncated: boolean
    }>
  }).calls[0]
  assert.ok(successCall !== undefined)
  assert.equal(successCall.resultBytes > 256, true)
  assert.equal(successCall.resultPreview, shortVisibleBody)
  assert.equal(successCall.resultPreviewOmitted, false)
  assert.equal(successCall.resultTruncated, false)

  const deniedSpan = protocolSpan({ result: 'hidden'.repeat(100) })
  const denied = ready(deniedSpan, requestFor(deniedSpan), evidenceFor(deniedSpan, ['denied']))
  const deniedCall = (digestPayload(denied.content) as unknown as {
    calls: Array<{ resultBytes: number; resultPreviewOmitted: boolean; resultTruncated: boolean }>
  }).calls[0]
  assert.ok(deniedCall !== undefined)
  assert.equal(deniedCall.resultBytes > 256, true)
  assert.equal(deniedCall.resultPreviewOmitted, true)
  assert.equal(deniedCall.resultTruncated, false)
})

test('same non-success model body with different ledger status never collides or exposes a preview', () => {
  const span = protocolSpan({ result: 'Same safe failure body' })
  const denied = ready(span, requestFor(span), evidenceFor(span, ['denied']))
  const rejected = ready(span, requestFor(span), evidenceFor(span, ['rejected']))
  const failed = ready(span, requestFor(span), evidenceFor(span, ['failed']))
  const ids = new Set([denied.artifactId, rejected.artifactId, failed.artifactId])
  assert.equal(ids.size, 3)
  for (const artifact of [denied, rejected, failed]) {
    const payload = digestPayload(artifact.content) as unknown as {
      calls: Array<{ resultPreview: string | null; resultPreviewOmitted: boolean }>
    }
    assert.equal(payload.calls[0]?.resultPreview, null)
    assert.equal(payload.calls[0]?.resultPreviewOmitted, true)
    assert.doesNotMatch(artifact.content, /Same safe failure body/)
  }
})
