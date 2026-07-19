import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { ModelMessage } from '../../src/agent/model/model-adapter.js'
import type {
  ContextArtifactStore,
  ContextArtifactStoreResult
} from '../../src/agent/context/context-artifact-store.js'
import type { ContextArtifactV1 } from '../../src/agent/context/context-artifact.js'
import {
  createContextSpanV1,
  domainSeparatedContextHash,
  type ContextSpanV1
} from '../../src/agent/context/context-span.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import type { ToolExecutionLedger } from '../../src/agent/run/tool-ledger.js'
import { toolResultForModel } from '../../src/agent/tools/tool-result.js'
import {
  createRunContextPlanner,
  projectRunToolProtocolSpans
} from '../../src/runtime/run-context-planner.js'

const runRef = '1'.repeat(32)

function hash (value: string): string {
  return domainSeparatedContextHash('groupmate.test.run-context-planner.v1', value)
}

function ordinarySpan (
  id: string,
  source: 'system_instruction' | 'runtime_fact' | 'current_request',
  role: 'system' | 'user',
  content: string
): ContextSpanV1 {
  const ref = `run:${id}`
  return createContextSpanV1(Object.freeze({
    spanId: `span:${id}`,
    namespaceRef: runRef,
    kind: 'message' as const,
    source,
    trust: 'trusted' as const,
    requirement: source === 'system_instruction' || source === 'current_request'
      ? 'mandatory' as const
      : 'optional' as const,
    priority: source === 'runtime_fact' ? 'high' as const : 'critical' as const,
    semanticOrder: source === 'system_instruction' ? 1 : source === 'runtime_fact' ? 2 : 3,
    originGeneration: 0,
    provenance: Object.freeze({
      kind: 'run' as const,
      ref,
      revision: null,
      contentHash: hash(`provenance:${id}`)
    }),
    supersedes: null,
    messages: Object.freeze([Object.freeze({ role, content })]),
    sourceRefs: Object.freeze([Object.freeze({
      ref,
      contentHash: hash(`source:${id}`)
    })]),
    toolProtocol: null
  }))
}

function plannerCheckpoint (
  overrides: Partial<Pick<RunCheckpoint,
  'contextPlan' | 'messages' | 'pendingContextMessages' | 'toolLedgers' | 'step' |
  'modelCapability' | 'contextArtifactRefs'>> = {}
): RunCheckpoint {
  return Object.freeze({
    runRef,
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: Object.freeze({
      schemaVersion: 1,
      source: 'safe_default',
      contextWindowTokens: 32_768,
      maxOutputTokens: 8_192,
      promptCaching: 'unknown',
      usageExtensions: Object.freeze([]),
      priceCatalogVersion: null
    }),
    toolWireSnapshot: Object.freeze({
      schemaVersion: 1,
      estimatorVersion: 'openai-tool-wire-byte-quarter-v1',
      hash: '2'.repeat(64),
      estimatedTokens: 0
    }),
    contextPlan: null,
    contextArtifactRefs: Object.freeze([]),
    messages: Object.freeze([]),
    pendingContextMessages: Object.freeze([]),
    toolLedgers: Object.freeze([]),
    step: 0,
    deadlineAt: '2026-07-19T00:04:00.000Z',
    ...overrides
  }) as unknown as RunCheckpoint
}

class RecordingArtifactStore implements ContextArtifactStore {
  readonly puts: Array<Readonly<{ artifact: ContextArtifactV1; expiresAt: number }>> = []
  readonly touches: Array<Readonly<{ artifact: ContextArtifactV1; expiresAt: number }>> = []
  readonly artifacts = new Map<string, ContextArtifactV1>()

  constructor (readonly available = true) {}

  async get (artifactId: string): Promise<ContextArtifactStoreResult> {
    const artifact = this.artifacts.get(artifactId)
    return artifact === undefined
      ? Object.freeze({ status: 'missing' as const })
      : Object.freeze({ status: 'ready' as const, artifact })
  }

  async putIfAbsent (
    artifact: ContextArtifactV1,
    minimumExpiresAtMs: number
  ): Promise<ContextArtifactStoreResult> {
    this.puts.push(Object.freeze({ artifact, expiresAt: minimumExpiresAtMs }))
    if (this.available) this.artifacts.set(artifact.artifactId, artifact)
    return this.available
      ? Object.freeze({ status: 'ready' as const, artifact })
      : Object.freeze({ status: 'unavailable' as const, code: 'redis_unavailable' as const })
  }

  async touchAtLeast (
    artifact: ContextArtifactV1,
    minimumExpiresAtMs: number
  ): Promise<ContextArtifactStoreResult> {
    this.touches.push(Object.freeze({ artifact, expiresAt: minimumExpiresAtMs }))
    return this.available
      ? Object.freeze({ status: 'ready' as const, artifact })
      : Object.freeze({ status: 'unavailable' as const, code: 'redis_unavailable' as const })
  }
}

function protocol (
  step: number,
  callId: string
): Readonly<{
  assistant: ModelMessage
  tool: ModelMessage
  ledger: ToolExecutionLedger
}> {
  const assistant = Object.freeze({
    role: 'assistant' as const,
    content: null,
    toolCalls: Object.freeze([Object.freeze({
      callId,
      name: 'website',
      argumentsText: '{}',
      arguments: Object.freeze({})
    })])
  })
  const tool = Object.freeze({
    role: 'tool' as const,
    content: 'ok',
    toolCallId: callId
  })
  const ledger = Object.freeze({
    schemaVersion: 1 as const,
    step,
    calls: Object.freeze([Object.freeze({
      occurrenceId: `${step}:0`, step, index: 0, callId,
      toolName: 'website', argumentsText: '{}', arguments: Object.freeze({}),
      status: 'succeeded' as const, capability: null,
      result: Object.freeze({
        status: 'success' as const, effect: 'none' as const,
        content: Object.freeze([{ type: 'text' as const, text: 'ok' }]),
        retryable: false
      })
    })])
  })
  return Object.freeze({ assistant, tool, ledger })
}

function largeProtocol (
  step: number,
  callId: string,
  size = 60_000
): ReturnType<typeof protocol> {
  const assistant = Object.freeze({
    role: 'assistant' as const,
    content: null,
    toolCalls: Object.freeze([Object.freeze({
      callId,
      name: 'website',
      argumentsText: '{}',
      arguments: Object.freeze({})
    })])
  })
  const result = Object.freeze({
    status: 'success' as const,
    effect: 'none' as const,
    content: Object.freeze([Object.freeze({
      type: 'text' as const,
      text: 'x'.repeat(size)
    })]),
    retryable: false
  })
  const tool = Object.freeze({
    role: 'tool' as const,
    content: toolResultForModel(result),
    toolCallId: callId
  })
  const ledger = Object.freeze({
    schemaVersion: 1 as const,
    step,
    calls: Object.freeze([Object.freeze({
      occurrenceId: `${step}:0`, step, index: 0, callId,
      toolName: 'website', argumentsText: '{}', arguments: Object.freeze({}),
      status: 'succeeded' as const, capability: null, result
    })])
  })
  return Object.freeze({ assistant, tool, ledger })
}

const baseSpans = Object.freeze([
  ordinarySpan('system', 'system_instruction', 'system', 'S'),
  ordinarySpan('optional', 'runtime_fact', 'user', 'OPTIONAL'),
  ordinarySpan('current', 'current_request', 'user', 'U')
])

test('run context planner creates the first generation from immutable source spans', async () => {
  const planner = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })

  const planned = await planner.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )

  assert.equal(planned.plan.generation, 1)
  assert.deepEqual(planned.messages.map(message => message.content), ['S', 'OPTIONAL', 'U'])
  assert.equal(planned.estimatedInputTokens, planned.plan.estimatedInputTokens)
  assert.deepEqual(planned.artifactRefs, [])
})

test('tool protocol projection marks only the pending ledger ready', async () => {
  const planner = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await planner.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  const oldProtocol = protocol(0, 'call-old')
  const second = await planner.planModelTurn(plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages,
    pendingContextMessages: Object.freeze([oldProtocol.assistant, oldProtocol.tool]),
    toolLedgers: Object.freeze([oldProtocol.ledger]),
    step: 1
  }), Object.freeze({ kind: 'normal', transition: 'normal' }), new AbortController().signal)
  const nextProtocol = protocol(1, 'call-next')
  const pending = Object.freeze([nextProtocol.assistant, nextProtocol.tool])
  const checkpoint = plannerCheckpoint({
    contextPlan: second.plan,
    messages: second.messages,
    pendingContextMessages: pending,
    toolLedgers: Object.freeze([oldProtocol.ledger, nextProtocol.ledger]),
    step: 2
  })

  const spans = projectRunToolProtocolSpans(checkpoint, runRef)

  assert.deepEqual(spans.map(span => span.toolProtocol?.phase), ['consumed', 'ready'])
  assert.deepEqual(spans.map(span => span.requirement), ['optional', 'mandatory'])
  assert.deepEqual(spans.at(-1)?.messages, pending)
})

test('explicit context recovery resets optional prefix without mutating source spans', async () => {
  const planner = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await planner.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )

  const recovered = await planner.planModelTurn(plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages
  }), Object.freeze({
    kind: 'context_recovery', transition: 'recovery_prefix_reset'
  }), new AbortController().signal)

  assert.deepEqual(recovered.messages.map(message => message.content), ['S', 'U'])
  assert.deepEqual(baseSpans.map(span => span.messages[0]?.content), ['S', 'OPTIONAL', 'U'])
})

test('restart planner reconstructs the previous wire with a recovery baseline', async () => {
  const live = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await live.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  const pendingProtocol = protocol(0, 'call-recovered')
  const checkpoint = plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages,
    pendingContextMessages: Object.freeze([pendingProtocol.assistant, pendingProtocol.tool]),
    toolLedgers: Object.freeze([pendingProtocol.ledger]),
    step: 1
  })
  const recovered = createRunContextPlanner({ namespaceRef: runRef, initialSpans: null })

  const planned = await recovered.planModelTurn(
    checkpoint,
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )

  assert.equal(planned.plan.generation, 2)
  assert.deepEqual(planned.messages, Object.freeze([
    ...first.messages,
    pendingProtocol.assistant,
    pendingProtocol.tool
  ]))
})

test('restart baseline accepts a pending tool after prefix recovery advanced generation', async () => {
  const live = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await live.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  const prefixRecovered = await live.planModelTurn(plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages
  }), Object.freeze({
    kind: 'context_recovery', transition: 'recovery_prefix_reset'
  }), new AbortController().signal)
  const pendingProtocol = protocol(0, 'call-after-prefix-recovery')
  const checkpoint = plannerCheckpoint({
    contextPlan: prefixRecovered.plan,
    messages: prefixRecovered.messages,
    pendingContextMessages: Object.freeze([pendingProtocol.assistant, pendingProtocol.tool]),
    toolLedgers: Object.freeze([pendingProtocol.ledger]),
    step: 1
  })
  const restarted = createRunContextPlanner({ namespaceRef: runRef, initialSpans: null })

  const planned = await restarted.planModelTurn(
    checkpoint,
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )

  assert.equal(planned.plan.generation, 3)
  assert.deepEqual(planned.messages.at(-1), pendingProtocol.tool)
})

test('restart planner retains one recovery baseline across later tool generations', async () => {
  const live = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await live.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  const firstProtocol = protocol(0, 'restart-loop-one')
  const restarted = createRunContextPlanner({ namespaceRef: runRef, initialSpans: null })
  const second = await restarted.planModelTurn(plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages,
    pendingContextMessages: Object.freeze([firstProtocol.assistant, firstProtocol.tool]),
    toolLedgers: Object.freeze([firstProtocol.ledger]),
    step: 1
  }), Object.freeze({ kind: 'normal', transition: 'normal' }), new AbortController().signal)
  const secondProtocol = protocol(1, 'restart-loop-two')

  const third = await restarted.planModelTurn(plannerCheckpoint({
    contextPlan: second.plan,
    messages: second.messages,
    pendingContextMessages: Object.freeze([secondProtocol.assistant, secondProtocol.tool]),
    toolLedgers: Object.freeze([firstProtocol.ledger, secondProtocol.ledger]),
    step: 2
  }), Object.freeze({ kind: 'normal', transition: 'normal' }), new AbortController().signal)

  assert.equal(third.plan.generation, 3)
  assert.equal(third.plan.included[0]?.spanId, second.plan.included[0]?.spanId)
  assert.equal(third.messages.filter(message => (
    message.role === 'assistant' && message.toolCalls?.[0]?.callId === 'restart-loop-one'
  )).length, 1)
  assert.deepEqual(third.messages.at(-1), secondProtocol.tool)
})

test('correction planning appends one mandatory tool-disabled instruction', async () => {
  const planner = createRunContextPlanner({ namespaceRef: runRef, initialSpans: baseSpans })
  const first = await planner.planModelTurn(
    plannerCheckpoint(),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )

  const corrected = await planner.planModelTurn(plannerCheckpoint({
    contextPlan: first.plan,
    messages: first.messages
  }), Object.freeze({ kind: 'correction', transition: 'normal' }), new AbortController().signal)

  assert.equal(corrected.messages.length, first.messages.length + 1)
  assert.equal(corrected.messages.at(-1)?.role, 'user')
  assert.match(corrected.messages.at(-1)?.content ?? '', /不要调用工具/)
})

test('correction pressure fails closed instead of compacting its committed prefix', async () => {
  const planner = createRunContextPlanner({
    namespaceRef: runRef,
    initialSpans: Object.freeze([
      ordinarySpan('pressure-system', 'system_instruction', 'system', 'S'),
      ordinarySpan('pressure-optional', 'runtime_fact', 'user', 'x'.repeat(167_000)),
      ordinarySpan('pressure-current', 'current_request', 'user', 'U')
    ])
  })
  const capability = Object.freeze({
    schemaVersion: 1 as const,
    source: 'safe_default' as const,
    contextWindowTokens: 65_536,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown' as const,
    usageExtensions: Object.freeze([]),
    priceCatalogVersion: null
  })
  const first = await planner.planModelTurn(
    plannerCheckpoint({ modelCapability: capability }),
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  assert.equal(first.plan.mode, 'normal')

  await assert.rejects(planner.planModelTurn(plannerCheckpoint({
    modelCapability: capability,
    contextPlan: first.plan,
    messages: first.messages
  }), Object.freeze({ kind: 'correction', transition: 'normal' }),
  new AbortController().signal), error => (
    error instanceof AgentError && error.code === 'context_budget_exceeded'
  ))
})

async function planFourLargeToolTurns (store: ContextArtifactStore) {
  const planner = createRunContextPlanner({
    namespaceRef: runRef,
    initialSpans: baseSpans,
    artifactStore: store
  })
  const capability = Object.freeze({
    schemaVersion: 1 as const,
    source: 'safe_default' as const,
    contextWindowTokens: 65_536,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown' as const,
    usageExtensions: Object.freeze([]),
    priceCatalogVersion: null
  })
  let checkpoint = plannerCheckpoint({ modelCapability: capability })
  let planned = await planner.planModelTurn(
    checkpoint,
    Object.freeze({ kind: 'normal', transition: 'normal' }),
    new AbortController().signal
  )
  const ledgers: ToolExecutionLedger[] = []
  for (let step = 0; step < 4; step += 1) {
    const next = largeProtocol(step, `large-call-${step}`)
    ledgers.push(next.ledger)
    checkpoint = plannerCheckpoint({
      modelCapability: capability,
      contextPlan: planned.plan,
      contextArtifactRefs: planned.artifactRefs,
      messages: planned.messages,
      pendingContextMessages: Object.freeze([next.assistant, next.tool]),
      toolLedgers: Object.freeze([...ledgers]),
      step: step + 1
    })
    planned = await planner.planModelTurn(
      checkpoint,
      Object.freeze({ kind: 'normal', transition: 'normal' }),
      new AbortController().signal
    )
  }
  return Object.freeze({
    planner,
    planned,
    checkpoint,
    ledgers: Object.freeze(ledgers),
    capability
  })
}

test('run context planner stores step-zero consumed artifacts before returning their refs', async () => {
  const store = new RecordingArtifactStore()

  const { planned } = await planFourLargeToolTurns(store)

  assert.ok(store.puts.length > 0, JSON.stringify({
    mode: planned.plan.mode,
    estimatedInputTokens: planned.estimatedInputTokens,
    serializedMessageBytes: planned.plan.serializedMessageBytes,
    messageCount: planned.messages.length
  }))
  assert.equal(store.puts.some(entry => entry.artifact.generation === 1), true)
  assert.equal(store.puts.every(entry => (
    entry.expiresAt === Date.parse('2026-07-19T00:04:00.000Z')
  )), true)
  assert.deepEqual(planned.artifactRefs, store.puts.map(entry => entry.artifact.artifactId))
  assert.equal(planned.plan.mode, 'normal')
})

test('run context planner falls back to raw deterministic trimming when artifact storage is unavailable', async () => {
  const store = new RecordingArtifactStore(false)

  const { planned } = await planFourLargeToolTurns(store)

  assert.ok(store.puts.length > 0)
  assert.deepEqual(planned.artifactRefs, [])
  assert.equal(planned.messages.some(message => (
    message.role === 'tool' && message.toolCallId === 'large-call-3'
  )), true)
  assert.ok(planned.messages.length < 11)
})

test('retained artifacts preserve the next same-process tool generation', async () => {
  const store = new RecordingArtifactStore()
  const state = await planFourLargeToolTurns(store)
  const next = protocol(4, 'after-artifact-same-process')

  const planned = await state.planner.planModelTurn(plannerCheckpoint({
    modelCapability: state.capability,
    contextPlan: state.planned.plan,
    contextArtifactRefs: state.planned.artifactRefs,
    messages: state.planned.messages,
    pendingContextMessages: Object.freeze([next.assistant, next.tool]),
    toolLedgers: Object.freeze([...state.ledgers, next.ledger]),
    step: 5
  }), Object.freeze({ kind: 'normal', transition: 'normal' }), new AbortController().signal)

  assert.equal(planned.plan.generation, state.planned.plan.generation + 1)
  assert.equal(state.planned.artifactRefs.every(ref => planned.artifactRefs.includes(ref)), true)
  assert.deepEqual(planned.messages.at(-1), next.tool)
})

test('restart verifies committed artifacts before rebasing their compacted wire', async () => {
  const store = new RecordingArtifactStore()
  const state = await planFourLargeToolTurns(store)
  const next = protocol(4, 'after-artifact-restart')
  const restarted = createRunContextPlanner({
    namespaceRef: runRef,
    initialSpans: null,
    artifactStore: store
  })

  const planned = await restarted.planModelTurn(plannerCheckpoint({
    modelCapability: state.capability,
    contextPlan: state.planned.plan,
    contextArtifactRefs: state.planned.artifactRefs,
    messages: state.planned.messages,
    pendingContextMessages: Object.freeze([next.assistant, next.tool]),
    toolLedgers: Object.freeze([...state.ledgers, next.ledger]),
    step: 5
  }), Object.freeze({ kind: 'normal', transition: 'normal' }), new AbortController().signal)

  assert.equal(planned.plan.generation, state.planned.plan.generation + 1)
  assert.deepEqual(planned.messages.at(-1), next.tool)
  assert.deepEqual(planned.artifactRefs, [])
})

test('same-process correction retains its verified committed artifact refs', async () => {
  const store = new RecordingArtifactStore()
  const state = await planFourLargeToolTurns(store)
  const checkpoint = plannerCheckpoint({
    modelCapability: state.capability,
    contextPlan: state.planned.plan,
    contextArtifactRefs: state.planned.artifactRefs,
    messages: state.planned.messages,
    toolLedgers: state.ledgers,
    step: 4
  })

  const planned = await state.planner.planModelTurn(
    checkpoint,
    Object.freeze({ kind: 'correction', transition: 'normal' }),
    new AbortController().signal
  )

  assert.deepEqual(
    planned.messages.slice(0, state.planned.messages.length),
    state.planned.messages
  )
  assert.deepEqual(planned.artifactRefs, state.planned.artifactRefs)
})

test('restart correction preserves the committed wire while clearing rebased artifact refs', async () => {
  const store = new RecordingArtifactStore()
  const state = await planFourLargeToolTurns(store)
  const restarted = createRunContextPlanner({
    namespaceRef: runRef,
    initialSpans: null,
    artifactStore: store
  })
  const checkpoint = plannerCheckpoint({
    modelCapability: state.capability,
    contextPlan: state.planned.plan,
    contextArtifactRefs: state.planned.artifactRefs,
    messages: state.planned.messages,
    toolLedgers: state.ledgers,
    step: 4
  })

  const planned = await restarted.planModelTurn(
    checkpoint,
    Object.freeze({ kind: 'correction', transition: 'normal' }),
    new AbortController().signal
  )

  assert.deepEqual(
    planned.messages.slice(0, state.planned.messages.length),
    state.planned.messages
  )
  assert.equal(planned.messages.length, state.planned.messages.length + 1)
  assert.equal(planned.messages.at(-1)?.role, 'user')
  assert.match(planned.messages.at(-1)?.content ?? '', /不要调用工具/)
  assert.equal(planned.plan.prefixMessageCount, state.planned.messages.length)
  assert.deepEqual(planned.artifactRefs, [])
})
