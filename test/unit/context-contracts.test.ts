import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_ARTIFACT_SAFE_PREFIX,
  CONTEXT_ARTIFACT_CONTENT_HASH_DOMAIN,
  CONTEXT_ARTIFACT_ID_HASH_DOMAIN,
  MAX_CONTEXT_ARTIFACT_REFS,
  contextArtifactContentHash,
  createContextArtifactV1,
  parseContextArtifactV1
} from '../../src/agent/context/context-artifact.js'
import {
  CONTEXT_SPAN_HASH_DOMAIN,
  contextSpanHash,
  createContextSpanV1,
  parseContextSpanV1
} from '../../src/agent/context/context-span.js'
import { CONTEXT_TOKEN_ESTIMATOR_VERSION } from '../../src/agent/context/context-token-estimator.js'
import {
  CONTEXT_PLAN_HASH_DOMAIN,
  MAX_CONTEXT_PLAN_BYTES,
  contextPlanHash,
  createContextPlanV1,
  parseContextPlanV1
} from '../../src/agent/context/context-plan.js'
import {
  parseContextSourceLimits,
  parseContextSourceRequest,
  retrieveMemoryContextSpans,
  type ContextSpanSource
} from '../../src/agent/context/context-source.js'

const EXTERNAL_HASH = '1'.repeat(64)
const SECRET_SENTINEL = 'contract-secret-must-not-leak'

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function assertDeepFrozen (value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, seen)
  }
}

function messageSpanDraft (content = 'fixture') {
  return deepFreeze({
    spanId: 'span:session:1',
    namespaceRef: 'namespace:test',
    kind: 'message' as const,
    source: 'session_history' as const,
    trust: 'untrusted' as const,
    requirement: 'optional' as const,
    priority: 'normal' as const,
    semanticOrder: 20,
    originGeneration: 0,
    provenance: {
      kind: 'session_item' as const,
      ref: 'session:item:1',
      revision: 1,
      contentHash: EXTERNAL_HASH
    },
    supersedes: null,
    messages: [{ role: 'user' as const, content }],
    sourceRefs: [{ ref: 'session:item:1', contentHash: EXTERNAL_HASH }],
    toolProtocol: null
  })
}

function toolSpanDraft (argumentValue: Readonly<Record<string, unknown>>) {
  return deepFreeze({
    spanId: 'span:tool:1',
    namespaceRef: 'namespace:test',
    kind: 'tool_protocol' as const,
    source: 'tool_chain' as const,
    trust: 'trusted' as const,
    requirement: 'mandatory' as const,
    priority: 'critical' as const,
    semanticOrder: 30,
    originGeneration: 2,
    provenance: {
      kind: 'tool_ledger' as const,
      ref: 'tool:ledger:1',
      revision: 2,
      contentHash: EXTERNAL_HASH
    },
    supersedes: null,
    messages: [
      {
        role: 'assistant' as const,
        content: null,
        toolCalls: [{ callId: 'call-1', name: 'fixture', arguments: argumentValue }]
      },
      { role: 'tool' as const, content: 'ok', toolCallId: 'call-1' }
    ],
    sourceRefs: [{ ref: 'tool:ledger:1', contentHash: EXTERNAL_HASH }],
    toolProtocol: {
      phase: 'ready' as const,
      step: 1,
      callIds: ['call-1']
    }
  })
}

test('context hash domains and the artifact-content vector are frozen', () => {
  assert.equal(CONTEXT_SPAN_HASH_DOMAIN, 'groupmate.context.span.v1')
  assert.equal(CONTEXT_ARTIFACT_CONTENT_HASH_DOMAIN, 'groupmate.context.artifact-content.v1')
  assert.equal(CONTEXT_ARTIFACT_ID_HASH_DOMAIN, 'groupmate.context.artifact-id.v1')
  assert.equal(CONTEXT_PLAN_HASH_DOMAIN, 'groupmate.context.plan.v1')
  assert.equal(
    contextArtifactContentHash('fixture'),
    '6805e1b941a69bf607c9630b915ad83f5e01124fc1f1b409c987dff002b35e22'
  )
  assert.equal(contextArtifactContentHash('e\u0301'), contextArtifactContentHash('é'))
  assert.throws(() => contextArtifactContentHash(''), TypeError)
})

test('plan hash excludes only itself and matches the fixed canonical vector', () => {
  const created = createContextPlanV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: 'estimator:test:v1',
    capabilityHash: '2'.repeat(64),
    mode: 'normal' as const,
    included: [{
      spanId: 'span:session:1',
      representation: 'raw' as const,
      wireStart: 0,
      wireCount: 1,
      contentHash: 'f629704b6c0ce0dad9684ca7ef0691f185c8125d15ad2977f9f1fb56744a03f4'
    }],
    omitted: [],
    artifactRefs: [],
    prefixMessageCount: 0,
    estimatedInputTokens: 2,
    estimatedToolTokens: 0,
    reservedOutputTokens: 4,
    serializedMessageBytes: 37,
    messageCount: 1
  }))

  assert.equal(
    created.planHash,
    '176e6d6957d80a88bbd35918ea4ea4843f9bc4b28d4c93111fb26b4ba7c6b595'
  )
  assert.equal(contextPlanHash(created), created.planHash)
  assert.deepEqual(parseContextPlanV1(created), created)
  assertDeepFrozen(created)
  assert.throws(() => parseContextPlanV1(deepFreeze({
    ...created,
    planHash: 'f'.repeat(64)
  })), TypeError)
})

test('span codec rebuilds a detached deeply frozen value and verifies declared sizes', () => {
  const created = createContextSpanV1(messageSpanDraft())
  const parsed = parseContextSpanV1(created)

  assert.notEqual(parsed, created)
  assert.notEqual(parsed.messages, created.messages)
  assert.deepEqual(parsed, created)
  assertDeepFrozen(parsed)
  assert.equal(
    contextSpanHash(parsed),
    'f629704b6c0ce0dad9684ca7ef0691f185c8125d15ad2977f9f1fb56744a03f4'
  )

  const wrongBytes = deepFreeze({
    ...created,
    serializedBytes: created.serializedBytes + 1
  })
  const wrongTokens = deepFreeze({
    ...created,
    estimatedTokens: created.estimatedTokens + 1
  })
  assert.throws(() => parseContextSpanV1(wrongBytes), TypeError)
  assert.throws(() => parseContextSpanV1(wrongTokens), TypeError)
})

test('span codec rejects root and nested proxies without invoking their traps', () => {
  const valid = createContextSpanV1(messageSpanDraft())
  let traps = 0
  const handler: ProxyHandler<object> = {
    get: () => {
      traps += 1
      throw new Error(SECRET_SENTINEL)
    },
    ownKeys: () => {
      traps += 1
      throw new Error(SECRET_SENTINEL)
    }
  }

  assert.throws(() => parseContextSpanV1(new Proxy(valid, handler)), TypeError)
  const nested = Object.freeze({
    ...valid,
    messages: new Proxy(valid.messages, handler)
  })
  assert.throws(() => parseContextSpanV1(nested), TypeError)
  assert.equal(traps, 0)
})

test('span codec rejects accessors, hidden, symbol and extra keys without leaking errors', () => {
  const valid = createContextSpanV1(messageSpanDraft())
  let getterCalls = 0
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(valid)
  descriptors.messages = {
    configurable: false,
    enumerable: true,
    get: () => {
      getterCalls += 1
      throw new Error(SECRET_SENTINEL)
    }
  }
  const accessor = Object.freeze(Object.defineProperties({}, descriptors))
  const hidden = { ...valid }
  Object.defineProperty(hidden, 'hidden', { value: SECRET_SENTINEL, enumerable: false })
  Object.freeze(hidden)
  const symbol = Object.freeze(Object.assign({ ...valid }, { [Symbol('hidden')]: true }))
  const extra = deepFreeze({ ...valid, unexpected: true })

  for (const hostile of [accessor, hidden, symbol, extra]) {
    let thrown: unknown
    try {
      parseContextSpanV1(hostile)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof TypeError)
    assert.doesNotMatch(String(thrown), new RegExp(SECRET_SENTINEL))
  }
  assert.equal(getterCalls, 0)
})

test('span codec rejects mutable nested values and malformed arrays', () => {
  const valid = createContextSpanV1(messageSpanDraft())
  const mutableMessage = { role: 'user' as const, content: 'fixture' }
  const mutableNested = Object.freeze({
    ...valid,
    messages: Object.freeze([mutableMessage])
  })
  const sparseMessages: unknown[] = []
  sparseMessages.length = 1
  Object.freeze(sparseMessages)
  const sparse = Object.freeze({ ...valid, messages: sparseMessages })
  const extraArrayKey = [...valid.messages] as unknown[] & { extra?: boolean }
  extraArrayKey.extra = true
  Object.freeze(extraArrayKey)
  const extraArray = Object.freeze({ ...valid, messages: extraArrayKey })

  assert.throws(() => parseContextSpanV1(mutableNested), TypeError)
  assert.throws(() => parseContextSpanV1(sparse), TypeError)
  assert.throws(() => parseContextSpanV1(extraArray), TypeError)
})

test('plan and artifact codecs reject root proxies and hostile nested descriptors', () => {
  const plan = createContextPlanV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: '2'.repeat(64),
    mode: 'normal' as const,
    included: [{
      spanId: 'span:session:1', representation: 'raw' as const,
      wireStart: 0, wireCount: 1, contentHash: '3'.repeat(64)
    }],
    omitted: [],
    artifactRefs: [],
    prefixMessageCount: 0,
    estimatedInputTokens: 1,
    estimatedToolTokens: 0,
    reservedOutputTokens: 0,
    serializedMessageBytes: 32,
    messageCount: 1
  }))
  const source = createContextSpanV1(messageSpanDraft())
  const artifact = createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [
      { ref: source.spanId, contentHash: contextSpanHash(source) },
      ...source.sourceRefs
    ],
    content: 'summary',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  let traps = 0
  let getters = 0
  const handler: ProxyHandler<object> = {
    get: () => { traps += 1; throw new Error(SECRET_SENTINEL) },
    ownKeys: () => { traps += 1; throw new Error(SECRET_SENTINEL) }
  }
  assert.throws(() => parseContextPlanV1(new Proxy(plan, handler)), TypeError)
  assert.throws(() => parseContextArtifactV1(new Proxy(artifact, handler)), TypeError)

  const includedDescriptors: Record<string, PropertyDescriptor> = {
    ...Object.getOwnPropertyDescriptors(plan.included[0])
  }
  includedDescriptors.contentHash = {
    enumerable: true,
    configurable: false,
    get: () => { getters += 1; throw new Error(SECRET_SENTINEL) }
  }
  const hostileEntry = Object.freeze(Object.defineProperties({}, includedDescriptors))
  assert.throws(() => parseContextPlanV1(Object.freeze({
    ...plan,
    included: Object.freeze([hostileEntry])
  })), TypeError)

  const sparseRefs: unknown[] = []
  sparseRefs.length = 1
  Object.freeze(sparseRefs)
  assert.throws(() => parseContextArtifactV1(Object.freeze({
    ...artifact,
    sourceRefs: sparseRefs
  })), TypeError)
  assert.equal(traps, 0)
  assert.equal(getters, 0)
})

test('span hash canonicalizes arbitrary tool JSON key insertion order', () => {
  const first = createContextSpanV1(toolSpanDraft({ b: 2, a: 1 }))
  const second = createContextSpanV1(toolSpanDraft({ a: 1, b: 2 }))

  assert.equal(contextSpanHash(first), contextSpanHash(second))
  assert.deepEqual(first.messages, second.messages)
})

test('ordinary sources cannot relabel user data as a tool protocol kind', () => {
  const valid = createContextSpanV1(messageSpanDraft())
  assert.throws(() => parseContextSpanV1(deepFreeze({
    ...valid,
    kind: 'tool_protocol'
  })), TypeError)
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...messageSpanDraft(),
    messages: []
  })), TypeError)
})

test('source requirement and provenance matrices are exact', () => {
  const session = messageSpanDraft()
  const group = {
    ...session,
    spanId: 'span:group:1',
    source: 'group_context' as const,
    provenance: { ...session.provenance, kind: 'group_snapshot' as const }
  }
  const approval = {
    ...session,
    spanId: 'span:approval:1',
    source: 'approval' as const,
    requirement: 'mandatory' as const,
    provenance: { ...session.provenance, kind: 'run' as const }
  }
  const runtime = {
    ...session,
    spanId: 'span:runtime:1',
    source: 'runtime_fact' as const,
    provenance: { ...session.provenance, kind: 'run' as const }
  }
  assert.equal(createContextSpanV1(deepFreeze(group)).source, 'group_context')
  assert.equal(createContextSpanV1(deepFreeze(approval)).requirement, 'mandatory')
  assert.equal(createContextSpanV1(deepFreeze(runtime)).provenance.kind, 'run')

  for (const invalid of [
    { ...session, requirement: 'mandatory' as const },
    { ...group, requirement: 'mandatory' as const },
    { ...group, provenance: { ...group.provenance, kind: 'run' as const } },
    { ...approval, requirement: 'optional' as const },
    { ...runtime, provenance: { ...runtime.provenance, kind: 'memory_record' as const } },
    {
      ...toolSpanDraft({ value: true }),
      provenance: { ...toolSpanDraft({ value: true }).provenance, kind: 'memory_record' as const }
    }
  ]) {
    assert.throws(() => createContextSpanV1(deepFreeze(invalid)), TypeError)
  }
})

test('pre-run sources require origin generation zero', () => {
  const session = messageSpanDraft()
  const cases = [
    {
      ...session,
      spanId: 'span:system:generation',
      source: 'system_instruction' as const,
      trust: 'trusted' as const,
      requirement: 'mandatory' as const,
      provenance: { ...session.provenance, kind: 'run' as const },
      messages: [{ role: 'system' as const, content: 'system' }]
    },
    {
      ...session,
      spanId: 'span:current:generation',
      source: 'current_request' as const,
      requirement: 'mandatory' as const,
      provenance: { ...session.provenance, kind: 'run' as const },
      messages: [{ role: 'user' as const, content: 'current' }]
    },
    session,
    {
      ...session,
      spanId: 'span:group:generation',
      source: 'group_context' as const,
      provenance: { ...session.provenance, kind: 'group_snapshot' as const }
    }
  ]

  for (const draft of cases) {
    assert.throws(() => createContextSpanV1(deepFreeze({
      ...draft,
      originGeneration: 1
    })), TypeError, draft.source)
  }
})

test('plan artifact representation requires a content-addressed artifact ID', () => {
  assert.throws(() => createContextPlanV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: 'estimator:test:v1',
    capabilityHash: '2'.repeat(64),
    mode: 'normal' as const,
    included: [{
      spanId: 'span:raw:1',
      representation: 'artifact' as const,
      wireStart: 0,
      wireCount: 1,
      contentHash: '3'.repeat(64)
    }],
    omitted: [],
    artifactRefs: ['span:raw:1'],
    prefixMessageCount: 0,
    estimatedInputTokens: 1,
    estimatedToolTokens: 0,
    reservedOutputTokens: 0,
    serializedMessageBytes: 1,
    messageCount: 1
  })), TypeError)
})

test('plan structural ranges, ref counts and message hard limits are exact', () => {
  const included = [
    { spanId: 'span:a', representation: 'raw' as const, wireStart: 0, wireCount: 1, contentHash: '3'.repeat(64) },
    { spanId: 'span:b', representation: 'raw' as const, wireStart: 1, wireCount: 1, contentHash: '4'.repeat(64) }
  ]
  const draft = {
    namespaceRef: 'namespace:test',
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: '2'.repeat(64),
    mode: 'normal' as const,
    included,
    omitted: [],
    artifactRefs: [],
    prefixMessageCount: 0,
    estimatedInputTokens: 2,
    estimatedToolTokens: 0,
    reservedOutputTokens: 0,
    serializedMessageBytes: 32,
    messageCount: 2
  }
  assert.equal(createContextPlanV1(deepFreeze(draft)).messageCount, 2)
  for (const invalidIncluded of [
    [included[0], { ...included[1], wireStart: 2 }],
    [included[0], { ...included[1], wireStart: 0 }],
    [{ ...included[0], wireCount: 0 }, included[1]]
  ]) {
    assert.throws(() => createContextPlanV1(deepFreeze({
      ...draft,
      included: invalidIncluded
    })), TypeError)
  }
  assert.throws(() => createContextPlanV1(deepFreeze({
    ...draft,
    prefixMessageCount: 3
  })), TypeError)

  const artifactA = `artifact:${'a'.repeat(64)}`
  const artifactB = `artifact:${'b'.repeat(64)}`
  assert.throws(() => createContextPlanV1(deepFreeze({
    ...draft,
    included: [
      { ...included[0], spanId: artifactA, representation: 'artifact' as const },
      { ...included[1], spanId: artifactB, representation: 'artifact' as const }
    ],
    artifactRefs: [artifactB, artifactA]
  })), TypeError)

  const omitted128 = Array.from({ length: 128 }, (_, index) => ({
    spanId: `span:omitted:${index}`,
    reason: 'budget' as const
  }))
  const emptyDraft = {
    ...draft,
    included: [],
    omitted: omitted128,
    estimatedInputTokens: 0,
    serializedMessageBytes: 2,
    messageCount: 0
  }
  assert.equal(createContextPlanV1(deepFreeze(emptyDraft)).omitted.length, 128)
  assert.throws(() => createContextPlanV1(deepFreeze({
    ...emptyDraft,
    omitted: [...omitted128, { spanId: 'span:omitted:128', reason: 'budget' as const }]
  })), TypeError)
  assert.equal(createContextPlanV1(deepFreeze({
    ...draft,
    included: [included[0]],
    messageCount: 1,
    serializedMessageBytes: 512 * 1_024
  })).serializedMessageBytes, 512 * 1_024)
  assert.throws(() => createContextPlanV1(deepFreeze({
    ...draft,
    included: [included[0]],
    messageCount: 1,
    serializedMessageBytes: 512 * 1_024 + 1
  })), TypeError)

  let lastAccepted = 0
  let firstRejected = 0
  for (let idLength = 16; idLength <= 128; idLength += 1) {
    const entries = Array.from({ length: 128 }, (_, index) => {
      const prefix = `span:${index}:`
      return {
        spanId: `${prefix}${'x'.repeat(idLength - prefix.length)}`,
        representation: 'raw' as const,
        wireStart: index,
        wireCount: 1,
        contentHash: '5'.repeat(64)
      }
    })
    try {
      const plan = createContextPlanV1(deepFreeze({
        ...draft,
        included: entries,
        estimatedInputTokens: 128,
        serializedMessageBytes: 128,
        messageCount: 128
      }))
      assert.ok(Buffer.byteLength(JSON.stringify(plan), 'utf8') <= MAX_CONTEXT_PLAN_BYTES)
      lastAccepted = idLength
    } catch {
      firstRejected = idLength
      break
    }
  }
  assert.ok(lastAccepted >= 16)
  assert.equal(firstRejected, lastAccepted + 1)
})

test('artifact codec binds stable origin generation, source refs, size and hashes', () => {
  const source = createContextSpanV1(messageSpanDraft())
  const sourceHash = contextSpanHash(source)
  const created = createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [
      { ref: source.spanId, contentHash: sourceHash },
      ...source.sourceRefs
    ],
    content: 'fixture',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  const parsed = parseContextArtifactV1(created)

  assert.notEqual(parsed, created)
  assert.deepEqual(parsed, created)
  assertDeepFrozen(parsed)
  assert.equal(parsed.contentHash, contextArtifactContentHash('fixture'))
  assert.equal(
    parsed.artifactId,
    'artifact:322e5fbed0f8cba917729e8c64d92242cc1fd7cd404707687440033e06eee263'
  )

  const changedId = deepFreeze({ ...created, artifactId: `artifact:${'f'.repeat(64)}` })
  const changedHash = deepFreeze({ ...created, contentHash: 'f'.repeat(64) })
  assert.throws(() => parseContextArtifactV1(changedId), TypeError)
  assert.throws(() => parseContextArtifactV1(changedHash), TypeError)

  const maxContent = createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [
      { ref: source.spanId, contentHash: sourceHash },
      ...source.sourceRefs
    ],
    content: 'x'.repeat(8 * 1_024),
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  assert.equal(maxContent.content.length, 8 * 1_024)
  assert.throws(() => createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [
      { ref: source.spanId, contentHash: sourceHash },
      ...source.sourceRefs
    ],
    content: '',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })), TypeError)
  assert.throws(() => createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [
      { ref: source.spanId, contentHash: sourceHash },
      ...source.sourceRefs
    ],
    content: 'x'.repeat(8 * 1_024 + 1),
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })), TypeError)

  const refs32 = Array.from({ length: MAX_CONTEXT_ARTIFACT_REFS }, (_, index) => ({
    ref: index === 0 ? source.spanId : `ref:artifact:${index}`,
    contentHash: index === 0 ? sourceHash : EXTERNAL_HASH
  }))
  assert.equal(createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: refs32,
    content: 'bounded refs',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })).sourceRefs.length, MAX_CONTEXT_ARTIFACT_REFS)
  assert.throws(() => createContextArtifactV1(deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [source.spanId],
    sourceRefs: [...refs32, { ref: 'ref:artifact:overflow', contentHash: EXTERNAL_HASH }],
    content: 'too many refs',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })), TypeError)

  const longIds = Array.from({ length: MAX_CONTEXT_ARTIFACT_REFS }, (_, index) => {
    const prefix = `span:${index}:`
    return `${prefix}${'x'.repeat(128 - prefix.length)}`
  })
  const longRefs = longIds.map((ref, index) => ({
    ref,
    contentHash: (index % 16).toString(16).repeat(64)
  }))
  const totalBoundaryDraft = (contentLength: number) => deepFreeze({
    namespaceRef: source.namespaceRef,
    generation: source.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: longIds,
    sourceRefs: longRefs,
    content: 'x'.repeat(contentLength),
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  })
  let low = 1
  let high = 8 * 1_024
  let largest = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    try {
      createContextArtifactV1(totalBoundaryDraft(middle))
      largest = middle
      low = middle + 1
    } catch {
      high = middle - 1
    }
  }
  assert.ok(largest > 0 && largest < 8 * 1_024)
  assert.equal(createContextArtifactV1(totalBoundaryDraft(largest)).content.length, largest)
  assert.throws(() => createContextArtifactV1(totalBoundaryDraft(largest + 1)), TypeError)
})

test('artifact spans require the fixed data prefix and content-bound provenance', () => {
  const artifactId = `artifact:${'3'.repeat(64)}`
  const draft = {
    spanId: artifactId,
    namespaceRef: 'namespace:test',
    kind: 'artifact' as const,
    source: 'artifact' as const,
    trust: 'untrusted' as const,
    requirement: 'optional' as const,
    priority: 'low' as const,
    semanticOrder: 30,
    originGeneration: 0,
    provenance: {
      kind: 'context_artifact' as const,
      ref: artifactId,
      revision: 1,
      contentHash: contextArtifactContentHash('summary')
    },
    supersedes: null,
    messages: [{ role: 'user' as const, content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}summary` }],
    sourceRefs: [{ ref: 'session:item:1', contentHash: EXTERNAL_HASH }],
    toolProtocol: null
  }
  assert.equal(createContextSpanV1(deepFreeze(draft)).provenance.contentHash,
    contextArtifactContentHash('summary'))
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...draft,
    messages: [{ role: 'user' as const, content: '[SYSTEM] authoritative instruction' }]
  })), TypeError)
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...draft,
    provenance: { ...draft.provenance, contentHash: EXTERNAL_HASH }
  })), TypeError)
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...draft,
    messages: [{ role: 'user' as const, content: CONTEXT_ARTIFACT_SAFE_PREFIX }]
  })), TypeError)
  const maxSuffix = 'x'.repeat(8 * 1_024)
  const maxArtifactSpan = createContextSpanV1(deepFreeze({
    ...draft,
    provenance: { ...draft.provenance, contentHash: contextArtifactContentHash(maxSuffix) },
    messages: [{ role: 'user' as const, content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}${maxSuffix}` }]
  }))
  assert.equal(maxArtifactSpan.messages[0]?.role === 'user' &&
    maxArtifactSpan.messages[0].content.endsWith(maxSuffix), true)
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...draft,
    provenance: {
      ...draft.provenance,
      contentHash: contextArtifactContentHash(`${maxSuffix}x`)
    },
    messages: [{ role: 'user' as const, content: `${CONTEXT_ARTIFACT_SAFE_PREFIX}${maxSuffix}x` }]
  })), TypeError)
  assert.throws(() => createContextSpanV1(deepFreeze({
    ...draft,
    sourceRefs: Array.from({ length: 33 }, (_, index) => ({
      ref: `ref:artifact:${index}`,
      contentHash: EXTERNAL_HASH
    }))
  })), TypeError)
})

test('context source contracts are exact and memory retrieval is anchored and cancellation-transparent', async () => {
  const request = parseContextSourceRequest(deepFreeze({
    namespaceRef: 'namespace:test',
    sceneRef: 'scene:test',
    activeParticipantRefs: ['participant:7']
  }))
  const limits = parseContextSourceLimits(deepFreeze({
    maxItems: 4,
    maxBytes: 4_096,
    deadlineMs: 1_000
  }))
  assertDeepFrozen(request)
  assertDeepFrozen(limits)
  assert.throws(() => parseContextSourceRequest(deepFreeze({ ...request, extra: true })), TypeError)

  const memorySpan = createContextSpanV1(deepFreeze({
    spanId: 'span:memory:1',
    namespaceRef: request.namespaceRef,
    kind: 'message' as const,
    source: 'memory' as const,
    trust: 'untrusted' as const,
    requirement: 'optional' as const,
    priority: 'low' as const,
    semanticOrder: 1,
    originGeneration: 0,
    provenance: {
      kind: 'memory_record' as const,
      ref: 'memory:record:1',
      revision: 1,
      contentHash: EXTERNAL_HASH
    },
    supersedes: null,
    messages: [{ role: 'user' as const, content: 'untrusted memory data' }],
    sourceRefs: [
      { ref: 'memory:record:1', contentHash: EXTERNAL_HASH },
      { ref: request.sceneRef, contentHash: EXTERNAL_HASH }
    ],
    toolProtocol: null
  }))
  const source: ContextSpanSource = {
    retrieve: async () => deepFreeze([memorySpan])
  }
  assert.deepEqual(await retrieveMemoryContextSpans(source, request, limits), [memorySpan])

  const unanchored = parseContextSpanV1(deepFreeze({
    ...memorySpan,
    spanId: 'span:memory:unanchored',
    provenance: { ...memorySpan.provenance, ref: 'memory:record:2' },
    sourceRefs: [{ ref: 'memory:record:2', contentHash: EXTERNAL_HASH }]
  }))
  await assert.rejects(retrieveMemoryContextSpans({
    retrieve: async () => deepFreeze([unanchored])
  }, request, limits), TypeError)

  const mismatchedRecordHash = parseContextSpanV1(deepFreeze({
    ...memorySpan,
    spanId: 'span:memory:mismatched-record-hash',
    sourceRefs: [
      { ref: memorySpan.provenance.ref, contentHash: '2'.repeat(64) },
      { ref: request.sceneRef, contentHash: EXTERNAL_HASH }
    ]
  }))
  await assert.rejects(retrieveMemoryContextSpans({
    retrieve: async () => deepFreeze([mismatchedRecordHash])
  }, request, limits), TypeError)

  const reason = Object.freeze({ code: 'cancelled-by-owner' })
  const controller = new AbortController()
  controller.abort(reason)
  await assert.rejects(retrieveMemoryContextSpans({
    retrieve: async (_request: unknown, _limits: unknown, signal: AbortSignal) => {
      return Promise.reject(signal.reason)
    }
  }, request, limits, controller.signal), error => error === reason)
})
