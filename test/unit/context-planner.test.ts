import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createContextSpanV1,
  contextSpanHash,
  parseContextSpanV1
} from '../../src/agent/context/context-span.js'
import { createContextArtifactV1 } from '../../src/agent/context/context-artifact.js'
import { createContextPlanV1 } from '../../src/agent/context/context-plan.js'
import {
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  serializedModelMessagesBytes
} from '../../src/agent/context/context-token-estimator.js'
import {
  parseContextPlannerInputV1,
  planModelTurn
} from '../../src/agent/context/context-planner.js'
import type { ModelMessage } from '../../src/agent/model/model-adapter.js'

const HASH = '1'.repeat(64)

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function span (options: {
  id: string
  order: number
  content: string
  source?: 'system_instruction' | 'current_request' | 'session_history' | 'runtime_fact' | 'group_context'
  role?: 'system' | 'user' | 'assistant'
  requirement?: 'mandatory' | 'optional'
  priority?: 'critical' | 'high' | 'normal' | 'low'
  originGeneration?: number
  supersedes?: string | null
  sourceRefs?: readonly { readonly ref: string; readonly contentHash: string }[]
}) {
  const source = options.source ?? 'session_history'
  return createContextSpanV1(deepFreeze({
    spanId: options.id,
    namespaceRef: 'namespace:test',
    kind: 'message' as const,
    source,
    trust: source === 'system_instruction' ? 'trusted' as const : 'untrusted' as const,
    requirement: options.requirement ?? (
      source === 'system_instruction' || source === 'current_request' ? 'mandatory' as const : 'optional' as const
    ),
    priority: options.priority ?? (
      source === 'system_instruction' || source === 'current_request' ? 'critical' as const : 'normal' as const
    ),
    semanticOrder: options.order,
    originGeneration: options.originGeneration ?? 0,
    provenance: {
      kind: source === 'system_instruction' || source === 'current_request' || source === 'runtime_fact'
        ? 'run' as const
        : source === 'group_context'
          ? 'group_snapshot' as const
          : 'session_item' as const,
      ref: `ref:${options.id}`,
      revision: 1,
      contentHash: HASH
    },
    supersedes: options.supersedes ?? null,
    messages: [{ role: options.role ?? (source === 'system_instruction' ? 'system' as const : 'user' as const), content: options.content }],
    sourceRefs: options.sourceRefs ?? [{ ref: `ref:${options.id}`, contentHash: HASH }],
    toolProtocol: null
  }))
}

function protocolSpan (options: {
  id: string
  order: number
  phase: 'awaiting' | 'ready' | 'indeterminate' | 'consumed'
  originGeneration?: number
  callId?: string
  sourceRefs?: readonly { readonly ref: string; readonly contentHash: string }[]
}) {
  const callId = options.callId ?? `call:${options.id}`
  const complete = options.phase === 'ready' || options.phase === 'consumed'
  return createContextSpanV1(deepFreeze({
    spanId: options.id,
    namespaceRef: 'namespace:test',
    kind: 'tool_protocol' as const,
    source: 'tool_chain' as const,
    trust: 'trusted' as const,
    requirement: options.phase === 'consumed' ? 'optional' as const : 'mandatory' as const,
    priority: 'critical' as const,
    semanticOrder: options.order,
    originGeneration: options.originGeneration ?? 1,
    provenance: {
      kind: 'tool_ledger' as const,
      ref: `ref:${options.id}`,
      revision: 1,
      contentHash: HASH
    },
    supersedes: null,
    messages: [
      {
        role: 'assistant' as const,
        content: null,
        toolCalls: [{ callId, name: 'fixture', arguments: { value: options.id } }]
      },
      ...(complete ? [{ role: 'tool' as const, content: 'ok', toolCallId: callId }] : [])
    ],
    sourceRefs: options.sourceRefs ?? [{ ref: `ref:${options.id}`, contentHash: HASH }],
    toolProtocol: { phase: options.phase, step: 1, callIds: [callId] }
  }))
}

function mandatorySpans () {
  return [
    span({ id: 'span:system', order: 10, content: 'S', source: 'system_instruction', role: 'system' }),
    span({ id: 'span:current', order: 20, content: 'U', source: 'current_request', role: 'user' })
  ]
}

function plannerInput (
  spans: readonly ReturnType<typeof span>[],
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return deepFreeze({
    schemaVersion: 1 as const,
    namespaceRef: 'namespace:test',
    generation: 1,
    previousPlan: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: '2'.repeat(64),
    artifactPolicy: 'disabled' as const,
    budget: {
      schemaVersion: 1 as const,
      maxInputTokens: 100_000,
      maxSerializedMessageBytes: 512 * 1_024,
      maxMessages: 128,
      estimatedToolTokens: 0,
      reservedOutputTokens: 0
    },
    spans,
    artifacts: deepFreeze([]),
    ...overrides
  })
}

function ready (value: ReturnType<typeof planModelTurn>) {
  if (value.status !== 'ready') throw new Error(`expected ready, got ${value.status}`)
  return value
}

test('planner is pure, insertion-order independent and emits semantic wire order', () => {
  const spans = [
    ...mandatorySpans(),
    span({ id: 'span:history:b', order: 40, content: 'B' }),
    span({ id: 'span:history:a', order: 30, content: 'A' })
  ]
  const first = ready(planModelTurn(plannerInput(deepFreeze(spans))))
  const second = ready(planModelTurn(plannerInput(deepFreeze([...spans].reverse()))))

  assert.deepEqual(first, second)
  assert.deepEqual(first.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' }
  ])
  assert.deepEqual(first.plan.included.map((value: { readonly spanId: string }) => value.spanId), [
    'span:system', 'span:current', 'span:history:a', 'span:history:b'
  ])
  assert.equal(first.plan.serializedMessageBytes, serializedModelMessagesBytes(first.messages))
  assert.equal(first.plan.messageCount, first.messages.length)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.plan), true)
  assert.equal(Object.isFrozen(first.messages), true)
})

test('planner rejects duplicate IDs, semantic orders, invalid generations and oversized input sets', () => {
  const base = mandatorySpans()
  const duplicateId = span({ id: base[0].spanId, order: 30, content: 'duplicate' })
  const duplicateOrder = span({ id: 'span:duplicate-order', order: base[0].semanticOrder, content: 'duplicate' })

  assert.throws(() => planModelTurn(plannerInput(deepFreeze([...base, duplicateId]))), TypeError)
  assert.throws(() => planModelTurn(plannerInput(deepFreeze([...base, duplicateOrder]))), TypeError)
  assert.throws(() => planModelTurn(plannerInput(deepFreeze(base), { generation: 0 })), TypeError)

  const tooMany = Array.from({ length: 129 }, (_, index) => span({
    id: `span:item:${index}`,
    order: index + 1,
    content: 'x'
  }))
  assert.throws(() => planModelTurn(plannerInput(deepFreeze(tooMany))), TypeError)
})

test('planner input preflight rejects root proxies and hostile nested containers without traps', () => {
  const valid = plannerInput(deepFreeze(mandatorySpans()))
  let traps = 0
  let getters = 0
  const handler: ProxyHandler<object> = {
    get: () => { traps += 1; throw new Error('planner-input-secret') },
    ownKeys: () => { traps += 1; throw new Error('planner-input-secret') }
  }
  assert.throws(() => parseContextPlannerInputV1(new Proxy(valid, handler)), TypeError)

  const budgetDescriptors: Record<string, PropertyDescriptor> = {
    ...Object.getOwnPropertyDescriptors(valid.budget)
  }
  budgetDescriptors.maxMessages = {
    enumerable: true,
    configurable: false,
    get: () => { getters += 1; throw new Error('planner-input-secret') }
  }
  const hostileBudget = Object.freeze(Object.defineProperties({}, budgetDescriptors))
  assert.throws(() => parseContextPlannerInputV1(Object.freeze({
    ...valid,
    budget: hostileBudget
  })), TypeError)

  const sparseSpans: unknown[] = []
  sparseSpans.length = 1
  Object.freeze(sparseSpans)
  assert.throws(() => parseContextPlannerInputV1(Object.freeze({
    ...valid,
    spans: sparseSpans
  })), TypeError)
  assert.equal(traps, 0)
  assert.equal(getters, 0)
})

test('complete ready tool protocols are atomic while active or malformed protocols fail closed', () => {
  const complete = protocolSpan({ id: 'span:protocol:ready', order: 30, phase: 'ready' })
  const planned = ready(planModelTurn(plannerInput(deepFreeze([...mandatorySpans(), complete]))))
  assert.deepEqual(planned.messages.slice(-2).map((value: ModelMessage) => value.role), ['assistant', 'tool'])

  for (const phase of ['awaiting', 'indeterminate'] as const) {
    const active = protocolSpan({ id: `span:protocol:${phase}`, order: 30, phase })
    assert.deepEqual(planModelTurn(plannerInput(deepFreeze([...mandatorySpans(), active]))), {
      status: 'blocked',
      code: 'tool_protocol_incomplete'
    })
  }

  const reused = protocolSpan({
    id: 'span:protocol:reused',
    order: 40,
    phase: 'ready',
    callId: complete.toolProtocol?.callIds[0]
  })
  assert.deepEqual(planModelTurn(plannerInput(deepFreeze([...mandatorySpans(), complete, reused]))), {
    status: 'blocked',
    code: 'tool_protocol_incomplete'
  })
})

test('mandatory spans fail closed independently at token, byte and message limits', () => {
  const spans = mandatorySpans()
  const messages = deepFreeze(spans.flatMap(value => value.messages))
  const bytes = serializedModelMessagesBytes(messages)
  const totalTokens = spans.reduce((total, value) => total + value.estimatedTokens, 0)
  const secret = 'planner-secret-must-not-leak'
  const secretSpans = [spans[0], span({
    id: 'span:current-secret', order: 20, content: secret,
    source: 'current_request', role: 'user'
  })]

  const limits = [
    { maxInputTokens: totalTokens - 1 },
    { maxSerializedMessageBytes: bytes - 1 },
    { maxMessages: messages.length - 1 }
  ]
  for (const budgetOverride of limits) {
    const input = plannerInput(deepFreeze(secretSpans), {
      budget: deepFreeze({ ...plannerInput(deepFreeze(spans)).budget, ...budgetOverride })
    })
    const result = planModelTurn(input)
    assert.deepEqual(result, { status: 'blocked', code: 'context_budget_exceeded' })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  }
})

test('aggregate message limits trim optional spans before wire construction and block mandatory overflow', () => {
  const optionalMany = createContextSpanV1(deepFreeze({
    spanId: 'span:optional-many',
    namespaceRef: 'namespace:test',
    kind: 'message' as const,
    source: 'session_history' as const,
    trust: 'untrusted' as const,
    requirement: 'optional' as const,
    priority: 'low' as const,
    semanticOrder: 30,
    originGeneration: 0,
    provenance: {
      kind: 'session_item' as const,
      ref: 'ref:optional-many',
      revision: 1,
      contentHash: HASH
    },
    supersedes: null,
    messages: Array.from({ length: 127 }, (_, index) => ({
      role: 'user' as const,
      content: `optional-${index}`
    })),
    sourceRefs: [{ ref: 'ref:optional-many', contentHash: HASH }],
    toolProtocol: null
  }))
  const trimmed = ready(planModelTurn(plannerInput(deepFreeze([
    ...mandatorySpans(), optionalMany
  ]))))
  assert.equal(trimmed.plan.messageCount, 2)
  assert.deepEqual(trimmed.plan.omitted, [{ spanId: optionalMany.spanId, reason: 'budget' }])

  const mandatoryMany = createContextSpanV1(deepFreeze({
    spanId: 'span:mandatory-many',
    namespaceRef: 'namespace:test',
    kind: 'message' as const,
    source: 'system_instruction' as const,
    trust: 'trusted' as const,
    requirement: 'mandatory' as const,
    priority: 'critical' as const,
    semanticOrder: 10,
    originGeneration: 0,
    provenance: {
      kind: 'run' as const,
      ref: 'ref:mandatory-many',
      revision: 1,
      contentHash: HASH
    },
    supersedes: null,
    messages: Array.from({ length: 128 }, (_, index) => ({
      role: 'system' as const,
      content: `mandatory-${index}`
    })),
    sourceRefs: [{ ref: 'ref:mandatory-many', contentHash: HASH }],
    toolProtocol: null
  }))
  const current = mandatorySpans()[1]
  assert.deepEqual(planModelTurn(plannerInput(deepFreeze([mandatoryMany, current]))), {
    status: 'blocked',
    code: 'context_budget_exceeded'
  })
})

test('maxInputTokens is already net of tool and output reserves', () => {
  const spans = deepFreeze(mandatorySpans())
  const inputTokens = ready(planModelTurn(plannerInput(spans))).plan.estimatedInputTokens
  const result = ready(planModelTurn(plannerInput(spans, {
    budget: deepFreeze({
      ...plannerInput(spans).budget,
      maxInputTokens: inputTokens,
      estimatedToolTokens: 10_000,
      reservedOutputTokens: 10_000
    })
  })))

  assert.equal(result.plan.estimatedInputTokens, inputTokens)
  assert.equal(result.plan.estimatedToolTokens, 10_000)
  assert.equal(result.plan.reservedOutputTokens, 10_000)
})

test('supersedes only removes an older optional span in the same namespace and source', () => {
  const old = span({ id: 'span:history:old', order: 30, content: 'old' })
  const next = span({
    id: 'span:history:new', order: 40, content: 'new', supersedes: old.spanId
  })
  const result = ready(planModelTurn(plannerInput(deepFreeze([...mandatorySpans(), next, old]))))

  assert.deepEqual(result.plan.omitted, [{ spanId: old.spanId, reason: 'superseded' }])
  assert.equal(result.plan.included.some((value: { readonly spanId: string }) => value.spanId === next.spanId), true)

  const crossSource = span({
    id: 'span:runtime:new', order: 50, content: 'runtime', source: 'runtime_fact',
    supersedes: old.spanId
  })
  assert.throws(() => planModelTurn(plannerInput(deepFreeze([
    ...mandatorySpans(), old, crossSource
  ]))), TypeError)
})

test('normal replans delay supersedes until a compaction boundary', () => {
  const old = span({ id: 'span:supersede:old', order: 30, content: 'old' })
  const next = span({
    id: 'span:supersede:new', order: 40, content: 'new', supersedes: old.spanId
  })
  const firstSpans = deepFreeze([...mandatorySpans(), old])
  const first = ready(planModelTurn(plannerInput(firstSpans)))
  const secondSpans = deepFreeze([...firstSpans, next])
  const second = ready(planModelTurn(plannerInput(secondSpans, {
    generation: 2,
    previousPlan: first.plan
  })))

  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages)
  assert.equal(second.plan.included.some(value => value.spanId === old.spanId), true)
  assert.equal(second.plan.included.some(value => value.spanId === next.spanId), true)
  assert.equal(second.plan.omitted.some(value => value.spanId === old.spanId), false)

  const pressured = deepFreeze([
    ...secondSpans,
    ...Array.from({ length: 13 }, (_, index) => span({
      id: `span:supersede:pressure:${index}`,
      order: 50 + index,
      content: `${index}`,
      priority: 'low'
    }))
  ])
  const third = ready(planModelTurn(plannerInput(pressured, {
    generation: 3,
    previousPlan: second.plan,
    budget: deepFreeze({ ...plannerInput(pressured).budget, maxMessages: 20 })
  })))
  assert.deepEqual(third.plan.omitted.find(value => value.spanId === old.spanId), {
    spanId: old.spanId,
    reason: 'superseded'
  })
})

test('85/70 hysteresis uses exact integer thresholds when mandatory spans cannot be trimmed', () => {
  const seventeen = deepFreeze([
    ...mandatorySpans(),
    ...Array.from({ length: 15 }, (_, index) => span({
      id: `span:hysteresis:${index}`,
      order: 30 + index,
      content: `${index}`,
      source: 'runtime_fact',
      requirement: 'mandatory'
    }))
  ])
  const entering = ready(planModelTurn(plannerInput(seventeen, {
    budget: deepFreeze({ ...plannerInput(seventeen).budget, maxMessages: 20 })
  })))
  assert.equal(entering.plan.mode, 'compacting')

  const holding = ready(planModelTurn(plannerInput(seventeen, {
    generation: 2,
    previousPlan: entering.plan,
    budget: deepFreeze({ ...plannerInput(seventeen).budget, maxMessages: 21 })
  })))
  assert.equal(holding.plan.mode, 'compacting')

  const exiting = ready(planModelTurn(plannerInput(seventeen, {
    generation: 3,
    previousPlan: holding.plan,
    budget: deepFreeze({ ...plannerInput(seventeen).budget, maxMessages: 25 })
  })))
  assert.equal(exiting.plan.mode, 'normal')

  const fourteen = deepFreeze(seventeen.slice(0, 14))
  const compactFourteen = ready(planModelTurn(plannerInput(fourteen, {
    budget: deepFreeze({ ...plannerInput(fourteen).budget, maxMessages: 16 })
  })))
  const exactSeventy = ready(planModelTurn(plannerInput(fourteen, {
    generation: 2,
    previousPlan: compactFourteen.plan,
    budget: deepFreeze({ ...plannerInput(fourteen).budget, maxMessages: 20 })
  })))
  assert.equal(exactSeventy.plan.mode, 'normal')
})

test('optional pressure at 85 percent is trimmed toward 70 percent and returns to normal', () => {
  const spans = deepFreeze([
    ...mandatorySpans(),
    ...Array.from({ length: 15 }, (_, index) => span({
      id: `span:optional-pressure:${index}`,
      order: 30 + index,
      content: `${index}`,
      priority: 'low'
    }))
  ])
  const result = ready(planModelTurn(plannerInput(spans, {
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 20 })
  })))

  assert.equal(result.plan.mode, 'normal')
  assert.ok(result.plan.messageCount <= 14)
  assert.ok(result.plan.omitted.some((value: { readonly reason: string }) => value.reason === 'budget'))
})

test('token and byte pressure independently trigger compaction and all dimensions exit below 70 percent', () => {
  const optional = span({
    id: 'span:token-byte-pressure', order: 30, content: 'x'.repeat(4_000), priority: 'low'
  })
  const spans = deepFreeze([...mandatorySpans(), optional])
  const full = ready(planModelTurn(plannerInput(spans)))
  const budgets = [
    deepFreeze({
      ...plannerInput(spans).budget,
      maxInputTokens: Math.floor(full.plan.estimatedInputTokens * 100 / 85)
    }),
    deepFreeze({
      ...plannerInput(spans).budget,
      maxSerializedMessageBytes: Math.floor(full.plan.serializedMessageBytes * 100 / 85)
    })
  ]

  for (const pressureBudget of budgets) {
    const result = ready(planModelTurn(plannerInput(spans, { budget: pressureBudget })))
    assert.equal(result.plan.mode, 'normal')
    assert.equal(result.plan.included.some(entry => entry.spanId === optional.spanId), false)
    assert.ok(BigInt(result.plan.estimatedInputTokens) * 100n <=
      BigInt(pressureBudget.maxInputTokens) * 70n)
    assert.ok(BigInt(result.plan.serializedMessageBytes) * 100n <=
      BigInt(pressureBudget.maxSerializedMessageBytes) * 70n)
    assert.ok(BigInt(result.plan.messageCount) * 100n <=
      BigInt(pressureBudget.maxMessages) * 70n)
  }
})

test('mandatory floor above 70 percent trims consumed optional protocol instead of requesting an artifact', () => {
  const mandatory = [
    ...mandatorySpans(),
    ...Array.from({ length: 15 }, (_, index) => span({
      id: `span:mandatory-floor:${index}`,
      order: 30 + index,
      content: `${index}`,
      source: 'runtime_fact',
      requirement: 'mandatory'
    }))
  ]
  const consumed = protocolSpan({
    id: 'span:protocol:mandatory-floor',
    order: 50,
    phase: 'consumed',
    originGeneration: 7
  })
  const spans = deepFreeze([...mandatory, consumed])
  const result = ready(planModelTurn(plannerInput(spans, {
    artifactPolicy: 'enabled',
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 20 })
  })))

  assert.equal(result.plan.mode, 'compacting')
  assert.equal(result.plan.messageCount, 17)
  assert.deepEqual(result.plan.omitted.find(value => value.spanId === consumed.spanId), {
    spanId: consumed.spanId,
    reason: 'budget'
  })
})

test('enabled compaction requests only consumed protocols and uses origin generation', () => {
  const consumed = protocolSpan({
    id: 'span:protocol:consumed', order: 30, phase: 'consumed', originGeneration: 7
  })
  const spans = deepFreeze([...mandatorySpans(), consumed])
  const enabled = planModelTurn(plannerInput(spans, {
    artifactPolicy: 'enabled',
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 4 })
  }))
  assert.equal(enabled.status, 'requires_artifacts')
  if (enabled.status !== 'requires_artifacts') throw new Error('expected artifact request')
  assert.equal(enabled.compactionRequests.length, 1)
  assert.equal(enabled.compactionRequests[0].generation, 7)
  assert.deepEqual(enabled.compactionRequests[0].sourceSpanIds, [consumed.spanId])
  assert.deepEqual(enabled.compactionRequests[0].sourceRefs, [{
    ref: consumed.spanId,
    contentHash: contextSpanHash(consumed)
  }, ...consumed.sourceRefs])
  assert.doesNotMatch(JSON.stringify(enabled), /ok|fixture/)

  const disabled = ready(planModelTurn(plannerInput(spans, {
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 4 })
  })))
  assert.equal(disabled.plan.included.some((value: { readonly spanId: string }) => value.spanId === consumed.spanId), false)

  assert.deepEqual(planModelTurn(plannerInput(spans, {
    artifactPolicy: 'enabled',
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 1 })
  })), { status: 'blocked', code: 'context_budget_exceeded' })
})

test('compaction provenance rejects duplicate refs with conflicting hashes', () => {
  const id = 'span:protocol:conflicting-ref'
  const consumed = protocolSpan({
    id,
    order: 30,
    phase: 'consumed',
    sourceRefs: [{ ref: id, contentHash: HASH }]
  })
  const spans = deepFreeze([...mandatorySpans(), consumed])
  assert.throws(() => planModelTurn(plannerInput(spans, {
    artifactPolicy: 'enabled',
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 4 })
  })), TypeError)

  const sharedRef = 'ref:shared-conflict'
  const first = span({
    id: 'span:shared:first', order: 30, content: 'first', originGeneration: 2,
    source: 'runtime_fact',
    sourceRefs: [{ ref: sharedRef, contentHash: '3'.repeat(64) }]
  })
  const second = span({
    id: 'span:shared:second', order: 40, content: 'second', originGeneration: 2,
    source: 'runtime_fact',
    sourceRefs: [{ ref: sharedRef, contentHash: '4'.repeat(64) }]
  })
  const artifact = createContextArtifactV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: 2,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [first.spanId, second.spanId],
    sourceRefs: [
      { ref: first.spanId, contentHash: contextSpanHash(first) },
      { ref: second.spanId, contentHash: contextSpanHash(second) },
      { ref: sharedRef, contentHash: '3'.repeat(64) }
    ],
    content: 'summary',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  const raw = deepFreeze([...mandatorySpans(), first, second])
  assert.throws(() => planModelTurn(plannerInput(raw, {
    artifacts: deepFreeze([artifact]),
    budget: deepFreeze({ ...plannerInput(raw).budget, maxMessages: 4 })
  })), TypeError)
})

test('consumed spans whose full provenance exceeds 32 refs skip artifact requests', () => {
  const consumed = protocolSpan({
    id: 'span:protocol:too-many-refs', order: 30, phase: 'consumed', originGeneration: 2
  })
  const withManyRefs = parseContextSpanV1(deepFreeze({
    ...consumed,
    sourceRefs: Array.from({ length: 32 }, (_, index) => ({
      ref: `source:ref:${index}`,
      contentHash: `${index % 10}`.repeat(64)
    }))
  }))
  const spans = deepFreeze([...mandatorySpans(), withManyRefs])
  const result = planModelTurn(plannerInput(spans, {
    artifactPolicy: 'enabled',
    budget: deepFreeze({ ...plannerInput(spans).budget, maxMessages: 4 })
  }))

  assert.equal(result.status, 'ready')
})

test('whole planner input has an independent 512 KiB preflight gate', () => {
  const bloated = Array.from({ length: 20 }, (_, index) => {
    const base = span({ id: `span:bloated:${index}`, order: index + 30, content: 'x' })
    return parseContextSpanV1(deepFreeze({
      ...base,
      sourceRefs: Array.from({ length: 128 }, (_, refIndex) => ({
        ref: `r:${index}:${refIndex}:`.padEnd(128, 'x'),
        contentHash: `${refIndex % 10}`.repeat(64)
      }))
    }))
  })
  const spans = deepFreeze([...mandatorySpans(), ...bloated])

  assert.throws(() => planModelTurn(plannerInput(spans)), TypeError)
})

test('same-rank optional trimming retains newer origin and semantic content', () => {
  const older = span({
    id: 'span:optional:older', order: 30, content: 'x'.repeat(1_000), originGeneration: 1,
    source: 'runtime_fact', priority: 'low'
  })
  const newer = span({
    id: 'span:optional:newer', order: 40, content: 'y'.repeat(1_000), originGeneration: 2,
    source: 'runtime_fact', priority: 'low'
  })
  const spans = deepFreeze([...mandatorySpans(), older, newer])
  const initialBytes = serializedModelMessagesBytes(deepFreeze(spans.flatMap(value => value.messages)))
  const result = ready(planModelTurn(plannerInput(spans, {
    budget: deepFreeze({
      ...plannerInput(spans).budget,
      maxMessages: 5,
      maxSerializedMessageBytes: Math.floor(initialBytes * 100 / 85)
    })
  })))

  assert.equal(result.plan.included.some(value => value.spanId === newer.spanId), true)
  assert.equal(result.plan.included.some(value => value.spanId === older.spanId), false)
})

test('crossing a compaction boundary may rewrite old optional wire and records its common prefix', () => {
  const optional = span({ id: 'span:old-optional', order: 30, content: 'old', priority: 'low' })
  const initialSpans = deepFreeze([...mandatorySpans(), optional])
  const initial = ready(planModelTurn(plannerInput(initialSpans)))
  const pressured = deepFreeze([
    ...initialSpans,
    ...Array.from({ length: 14 }, (_, index) => span({
      id: `span:pressure-rewrite:${index}`,
      order: 40 + index,
      content: `${index}`,
      priority: 'low'
    }))
  ])
  const next = ready(planModelTurn(plannerInput(pressured, {
    generation: 2,
    previousPlan: initial.plan,
    budget: deepFreeze({ ...plannerInput(pressured).budget, maxMessages: 20 })
  })))

  assert.equal(next.plan.mode, 'normal')
  assert.equal(next.plan.included.some(value => value.spanId === optional.spanId), false)
  assert.equal(next.plan.prefixMessageCount, 2)
})

test('verified artifacts only replace optional raw spans at a compaction boundary', () => {
  const raw = span({
    id: 'span:artifact-source', order: 30, content: 'x'.repeat(1_000),
    source: 'runtime_fact', originGeneration: 3
  })
  const artifact = createContextArtifactV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: raw.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [raw.spanId],
    sourceRefs: [
      { ref: raw.spanId, contentHash: contextSpanHash(raw) },
      ...raw.sourceRefs
    ],
    content: 'summary',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  const spans = deepFreeze([...mandatorySpans(), raw])
  const lowPressure = ready(planModelTurn(plannerInput(spans, {
    artifacts: deepFreeze([artifact])
  })))
  assert.equal(lowPressure.plan.included.some(value => value.spanId === raw.spanId), true)
  assert.equal(lowPressure.plan.included.some(value => value.spanId === artifact.artifactId), false)

  const rawBytes = serializedModelMessagesBytes(deepFreeze(spans.flatMap(value => value.messages)))
  const atBoundary = ready(planModelTurn(plannerInput(spans, {
    artifacts: deepFreeze([artifact]),
    budget: deepFreeze({
      ...plannerInput(spans).budget,
      maxSerializedMessageBytes: Math.floor(rawBytes * 100 / 85)
    })
  })))
  assert.equal(atBoundary.plan.included.some(value => value.spanId === artifact.artifactId), true)
  assert.deepEqual(atBoundary.plan.omitted.find(value => value.spanId === raw.spanId), {
    spanId: raw.spanId,
    reason: 'artifact'
  })

  const mandatory = mandatorySpans()[1]
  const forbiddenArtifact = createContextArtifactV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: mandatory.originGeneration,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [mandatory.spanId],
    sourceRefs: [
      { ref: mandatory.spanId, contentHash: contextSpanHash(mandatory) },
      ...mandatory.sourceRefs
    ],
    content: 'forbidden',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  assert.throws(() => planModelTurn(plannerInput(deepFreeze(mandatorySpans()), {
    artifacts: deepFreeze([forbiddenArtifact]),
    budget: deepFreeze({ ...plannerInput(deepFreeze(mandatorySpans())).budget, maxMessages: 2 })
  })), TypeError)

  const later = span({
    id: 'span:artifact-source-later', order: 40, content: 'later',
    source: 'runtime_fact', originGeneration: 3
  })
  const reverseOrderArtifact = createContextArtifactV1(deepFreeze({
    namespaceRef: 'namespace:test',
    generation: 3,
    kind: 'conversation_summary' as const,
    sourceSpanIds: [later.spanId, raw.spanId],
    sourceRefs: [
      { ref: later.spanId, contentHash: contextSpanHash(later) },
      { ref: raw.spanId, contentHash: contextSpanHash(raw) },
      ...later.sourceRefs,
      ...raw.sourceRefs
    ],
    content: 'reverse',
    generator: { kind: 'deterministic' as const, version: 'fixture-v1' },
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION
  }))
  const reverseSpans = deepFreeze([...mandatorySpans(), raw, later])
  assert.throws(() => planModelTurn(plannerInput(reverseSpans, {
    artifacts: deepFreeze([reverseOrderArtifact]),
    budget: deepFreeze({ ...plannerInput(reverseSpans).budget, maxMessages: 4 })
  })), TypeError)
})

test('normal replans preserve the prior structured wire as an exact prefix', () => {
  const initialSpans = deepFreeze(mandatorySpans())
  const first = ready(planModelTurn(plannerInput(initialSpans)))
  const appended = span({ id: 'span:append', order: 30, content: 'B' })
  const second = ready(planModelTurn(plannerInput(deepFreeze([...initialSpans, appended]), {
    generation: 2,
    previousPlan: first.plan
  })))

  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages)
  assert.equal(second.messages.length, first.messages.length + 1)
  assert.equal(second.plan.prefixMessageCount, first.messages.length)

  const inserted = span({ id: 'span:inserted', order: 15, content: 'X' })
  assert.deepEqual(planModelTurn(plannerInput(deepFreeze([...initialSpans, inserted]), {
    generation: 2,
    previousPlan: first.plan
  })), { status: 'blocked', code: 'context_budget_exceeded' })

  assert.throws(() => planModelTurn(plannerInput(initialSpans, {
    generation: 3,
    previousPlan: first.plan
  })), TypeError)
})

test('replans reject previous metrics that do not match the reconstructed wire', () => {
  const spans = deepFreeze(mandatorySpans())
  const first = ready(planModelTurn(plannerInput(spans)))
  const forgedPrevious = createContextPlanV1(deepFreeze({
    namespaceRef: first.plan.namespaceRef,
    generation: first.plan.generation,
    previousPlanHash: first.plan.previousPlanHash,
    estimatorVersion: first.plan.estimatorVersion,
    capabilityHash: first.plan.capabilityHash,
    mode: first.plan.mode,
    included: first.plan.included,
    omitted: first.plan.omitted,
    artifactRefs: first.plan.artifactRefs,
    prefixMessageCount: first.plan.prefixMessageCount,
    estimatedInputTokens: first.plan.estimatedInputTokens + 1,
    estimatedToolTokens: first.plan.estimatedToolTokens,
    reservedOutputTokens: first.plan.reservedOutputTokens,
    serializedMessageBytes: first.plan.serializedMessageBytes,
    messageCount: first.plan.messageCount
  }))

  assert.deepEqual(planModelTurn(plannerInput(spans, {
    generation: 2,
    previousPlan: forgedPrevious
  })), { status: 'blocked', code: 'context_budget_exceeded' })
})
