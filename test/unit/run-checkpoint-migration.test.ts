import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentEvent } from '../../src/agent/contracts/event.js'
import type { SerializedAgentError } from '../../src/agent/contracts/error.js'
import {
  createDefaultRunBudget,
  createLegacyRunBudgetLimits
} from '../../src/agent/run/run-budget.js'
import {
  RunCheckpointCodec,
  type RunCheckpointV1,
  type RunCheckpointV2,
  type RunCheckpointV3,
  type RunCheckpointV4,
  type RunCheckpointV5,
  type RunCheckpointV6
} from '../../src/agent/run/run-checkpoint.js'
import {
  upgradeCompletionFromRunCheckpointV1,
  upgradeRunCheckpointV1,
  upgradeRunCheckpointV2,
  upgradeRunCheckpointV3,
  upgradeRunCheckpointV4,
  upgradeRunCheckpointV5,
  validateExactRunCheckpointMigration
} from '../../src/agent/run/run-checkpoint-migration.js'
import {
  createFrozenObservationPolicy,
  createInitialRunObservationCounters,
  parseFrozenObservationPolicy,
  parseRunObservationCounters
} from '../../src/agent/run/run-observation.js'
import {
  CONTEXT_PLAN_HASH_DOMAIN,
  contextWireHash,
  createContextPlanV1,
  type ContextPlanV1,
  type LegacyContextPlanV1
} from '../../src/agent/context/context-plan.js'
import { domainSeparatedContextHash } from '../../src/agent/context/context-span.js'
import {
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  estimateModelMessagesTokens,
  serializedModelMessagesBytes
} from '../../src/agent/context/context-token-estimator.js'
import { modelCapabilityStableHash } from '../../src/agent/model/model-capability.js'

const createdAt = '2026-07-16T00:00:00.000Z'
const deadlineAt = '2026-07-16T00:04:00.000Z'
const runRef = '00000000000000000000000000000020'
const requestRef = '11111111111111111111111111111111'
const snapshotFingerprint = createHash('sha256').update('[]').digest('hex')
const budget = createDefaultRunBudget({
  providerTimeoutMs: 120_000,
  outputTokens: 256
})

test('checkpoint codec preserves exact tool argument text in messages and ledgers', () => {
  const argumentsText = '{ "second": "e\\u0301", "first": 1 }'
  const pending = pendingApprovalState()
  const calls = pending.toolLedgers[0]?.calls.map(call => Object.freeze({
    ...call,
    argumentsText,
    arguments: Object.freeze({ second: 'e\u0301', first: 1 })
  })) ?? []
  const source = legacyCheckpoint({
    status: 'waiting_approval',
    ...pending,
    messages: Object.freeze([Object.freeze({
      role: 'assistant' as const,
      content: null,
      toolCalls: Object.freeze([Object.freeze({
        callId: 'call-1',
        name: 'fixture',
        argumentsText,
        arguments: Object.freeze({ second: 'e\u0301', first: 1 })
      })])
    })]),
    toolLedgers: Object.freeze([Object.freeze({
      ...pending.toolLedgers[0],
      calls: Object.freeze(calls)
    })])
  } as unknown as Partial<RunCheckpointV1>)
  const { events, ...state } = source
  const loaded = new RunCheckpointCodec().decode(JSON.stringify(state), JSON.stringify({
    schemaVersion: 1,
    revision: source.revision,
    events
  }))

  const assistant = loaded.messages[0]
  assert.equal(assistant?.role, 'assistant')
  if (assistant?.role !== 'assistant') throw new Error('assistant message expected')
  assert.equal(assistant.toolCalls?.[0]?.argumentsText, argumentsText)
  assert.equal(loaded.toolLedgers[0]?.calls[0]?.argumentsText, argumentsText)
})
const legacyBudgetLimits = createLegacyRunBudgetLimits(budget.limits)

function runEvent (type: AgentEvent['type'] = 'run.created'): AgentEvent {
  return Object.freeze({
    eventVersion: 1,
    eventId: 'event-0',
    runId: 'run-legacy-1',
    sessionId: 'session-1',
    sequence: 0,
    occurredAt: createdAt,
    type,
    payload: Object.freeze({})
  })
}

function assistantOutput (text: string) {
  return Object.freeze({
    id: 'message-output-1',
    role: 'assistant' as const,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt,
    provenance: Object.freeze({
      source: 'model',
      trust: 'untrusted' as const,
      sensitivity: 'group' as const,
      sourceId: 'run-legacy-1',
      createdAt
    })
  })
}

function serializedError (): SerializedAgentError {
  return Object.freeze({
    code: 'provider_unavailable',
    stage: 'model.response',
    retryable: true,
    userMessage: 'AI 服务繁忙，请稍后重试。',
    details: Object.freeze({})
  })
}

function pendingApprovalState () {
  const capability = Object.freeze({
    schemaVersion: 1 as const,
    callId: 'call-1',
    toolName: 'fixture',
    toolVersion: 1 as const,
    snapshotId: 'snapshot-1',
    canonicalArguments: Object.freeze({}),
    argumentHash: 'b'.repeat(64),
    target: Object.freeze({ kind: 'none' as const }),
    resourceKeys: Object.freeze(['fixture:000000000000000000000000']),
    executionClass: 'side_effect' as const,
    retrySafe: false
  })
  const interruption = Object.freeze({
    schemaVersion: 1 as const,
    approvalId: 'approval-1',
    runId: 'run-legacy-1',
    step: 0,
    callId: 'call-1',
    toolFingerprint: snapshotFingerprint,
    argumentHash: capability.argumentHash,
    action: 'fixture',
    target: 'none',
    keyParameters: Object.freeze([]),
    requester: Object.freeze({ userId: 'actor-1', role: 'group_owner' as const }),
    approverPolicy: Object.freeze({
      profile: 'safe' as const,
      allowedRoles: Object.freeze([
        'bot_master', 'group_owner', 'group_admin'
      ] as const),
      eligibleActorIds: Object.freeze(['actor-1']),
      requireDifferentActor: false
    }),
    approvalAddress: Object.freeze({
      botId: 'bot-1',
      scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
    }),
    createdAt
  })
  return Object.freeze({
    interruption,
    preparedBatch: Object.freeze({
      schemaVersion: 1 as const,
      calls: Object.freeze([Object.freeze({
        kind: 'approval_required' as const,
        capability,
        summaryCode: 'fixture_approval'
      })])
    }),
    toolLedgers: Object.freeze([Object.freeze({
      schemaVersion: 1 as const,
      step: 0,
      calls: Object.freeze([Object.freeze({
        occurrenceId: '0:0',
        step: 0,
        index: 0,
        callId: 'call-1',
        toolName: 'fixture',
        arguments: Object.freeze({}),
        status: 'waiting_approval' as const,
        capability,
        result: null
      })])
    })])
  })
}

function legacyCheckpoint (
  changes: Partial<RunCheckpointV1> = {}
): RunCheckpointV1 {
  return Object.freeze({
    schemaVersion: 1,
    kernelVersion: 1,
    profileId: 'standard',
    profileVersion: 1,
    runId: 'run-legacy-1',
    sessionId: 'session-1',
    sessionAddress: Object.freeze({
      botId: 'bot-1',
      scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
    }),
    revision: 3,
    status: 'created',
    step: 0,
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    messages: Object.freeze([]),
    estimatedInputTokens: 0,
    modelTurn: null,
    toolSnapshot: Object.freeze({
      id: 'snapshot-1',
      fingerprint: snapshotFingerprint,
      manifest: Object.freeze([])
    }),
    toolLedgers: Object.freeze([]),
    preparedBatch: null,
    interruption: null,
    approvalHistory: Object.freeze([]),
    budgetLimits: legacyBudgetLimits,
    budgetCounters: Object.freeze({
      ...budget.initialCounters,
      modelTurns: 2,
      toolCalls: 1,
      estimatedTokens: 42,
      providerRetries: 1,
      recoveryAttempts: 1,
      correctionTurns: 1,
      usedActiveRuntimeMs: 17
    }),
    recoveryUsed: true,
    forceCorrection: false,
    output: null,
    visibleOutput: false,
    error: null,
    cancellationReason: null,
    events: Object.freeze([runEvent()]),
    nextEventSequence: 1,
    deadlineAt,
    createdAt,
    updatedAt: createdAt,
    ...changes
  })
}

function checkpointV2 (
  changes: Partial<RunCheckpointV2> = {}
): RunCheckpointV2 {
  const legacy = legacyCheckpoint()
  const {
    schemaVersion: _schemaVersion,
    visibleOutput: _visibleOutput,
    ...state
  } = legacy
  return Object.freeze({
    ...state,
    schemaVersion: 2,
    revision: legacy.revision + 1,
    runRef,
    requestRef,
    requestKind: 'legacy_unknown',
    presentationRoute: null,
    completion: null,
    observationCounters: createInitialRunObservationCounters(),
    providerDispatch: Object.freeze({ state: 'idle' as const }),
    engineActivity: Object.freeze({ state: 'idle' as const }),
    observationPolicy: Object.freeze({
      schemaVersion: 1 as const,
      levelAtStart: 'off' as const,
      sampledSuccess: false
    }),
    ...changes
  })
}

function checkpointV3 (
  changes: Partial<RunCheckpointV3> = {}
): RunCheckpointV3 {
  const source = checkpointV2()
  const { schemaVersion: _schemaVersion, ...state } = source
  return Object.freeze({
    ...state,
    schemaVersion: 3,
    revision: source.revision + 1,
    reasoningSegments: Object.freeze([]),
    ...changes
  })
}

function checkpointV4 (): RunCheckpointV4 {
  const source = upgradeRunCheckpointV3(checkpointV3())
  const {
    schemaVersion: _schemaVersion,
    modelLoopPolicy: _modelLoopPolicy,
    contextPlan: _contextPlan,
    contextArtifactRefs: _contextArtifactRefs,
    toolWireSnapshot: _toolWireSnapshot,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    budgetLimits: _budgetLimits,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 4, budgetLimits: legacyBudgetLimits })
}

function checkpointV5 (): RunCheckpointV5 {
  const source = upgradeRunCheckpointV4(checkpointV4())
  const {
    schemaVersion: _schemaVersion,
    contextRuntimeMode: _contextRuntimeMode,
    pendingContextMessages: _pendingContextMessages,
    providerGeneration: _providerGeneration,
    ...state
  } = source
  return Object.freeze({ ...state, schemaVersion: 5 })
}

function legacyPlanFromCurrent (plan: ContextPlanV1): LegacyContextPlanV1 {
  const included = Object.freeze(plan.included.map(entry => {
    const { wireHash: _wireHash, ...legacy } = entry
    return Object.freeze(legacy)
  }))
  const includedJson = `[${included.map(entry => (
    `{"spanId":${JSON.stringify(entry.spanId)},"representation":${JSON.stringify(entry.representation)},"wireStart":${entry.wireStart},"wireCount":${entry.wireCount},"contentHash":${JSON.stringify(entry.contentHash)}}`
  )).join(',')}]`
  const omittedJson = `[${plan.omitted.map(entry => (
    `{"spanId":${JSON.stringify(entry.spanId)},"reason":${JSON.stringify(entry.reason)}}`
  )).join(',')}]`
  const preimage = `{"schemaVersion":1,"namespaceRef":${JSON.stringify(plan.namespaceRef)},"generation":${plan.generation},"previousPlanHash":${plan.previousPlanHash === null ? 'null' : JSON.stringify(plan.previousPlanHash)},"estimatorVersion":${JSON.stringify(plan.estimatorVersion)},"capabilityHash":${JSON.stringify(plan.capabilityHash)},"mode":${JSON.stringify(plan.mode)},"included":${includedJson},"omitted":${omittedJson},"artifactRefs":[${plan.artifactRefs.map(value => JSON.stringify(value)).join(',')}],"prefixMessageCount":${plan.prefixMessageCount},"estimatedInputTokens":${plan.estimatedInputTokens},"estimatedToolTokens":${plan.estimatedToolTokens},"reservedOutputTokens":${plan.reservedOutputTokens},"serializedMessageBytes":${plan.serializedMessageBytes},"messageCount":${plan.messageCount}}`
  return Object.freeze({
    ...plan,
    planHash: domainSeparatedContextHash(CONTEXT_PLAN_HASH_DOMAIN, preimage),
    included
  })
}

test('frozen observation policy uses the locked SHA-256 sample and off fails closed', () => {
  assert.deepEqual(createFrozenObservationPolicy({
    levelAtStart: 'basic',
    runRef
  }), {
    schemaVersion: 1,
    levelAtStart: 'basic',
    sampledSuccess: true
  })
  assert.deepEqual(createFrozenObservationPolicy({
    levelAtStart: 'basic',
    runRef: '00000000000000000000000000000000'
  }), {
    schemaVersion: 1,
    levelAtStart: 'basic',
    sampledSuccess: false
  })
  assert.deepEqual(createFrozenObservationPolicy({
    levelAtStart: 'off',
    runRef
  }), {
    schemaVersion: 1,
    levelAtStart: 'off',
    sampledSuccess: false
  })
  assert.throws(() => parseFrozenObservationPolicy({
    schemaVersion: 1,
    levelAtStart: 'basic',
    sampledSuccess: true,
    extra: true
  }), /unknown|invalid/i)
  assert.throws(() => parseFrozenObservationPolicy({
    schemaVersion: 1,
    levelAtStart: { toString: () => 'basic' },
    sampledSuccess: true
  }), /invalid/i)
})

test('observation counter sentinels are field-specific and initial values are exact', () => {
  const initial = createInitialRunObservationCounters()
  assert.deepEqual({
    providerInputTokens: initial.providerInputTokens,
    providerOutputTokens: initial.providerOutputTokens,
    providerTotalTokens: initial.providerTotalTokens,
    providerAttempts: initial.providerAttempts,
    providerActiveDurationMs: initial.providerActiveDurationMs,
    engineActiveDurationMs: initial.engineActiveDurationMs
  }, {
    providerInputTokens: 'not_attempted',
    providerOutputTokens: 'not_attempted',
    providerTotalTokens: 'not_attempted',
    providerAttempts: 0,
    providerActiveDurationMs: 0,
    engineActiveDurationMs: 0
  })
  assert.deepEqual(parseRunObservationCounters(initial), initial)
  assert.deepEqual(parseRunObservationCounters({
    ...initial,
    providerInputTokens: 'unavailable',
    providerOutputTokens: 7,
    providerTotalTokens: 11,
    providerAttempts: 'unavailable'
  }).providerAttempts, 'unavailable')
  for (const key of [
    'providerAttempts', 'modelTurns', 'toolAttempts', 'providerRetries',
    'recoveryAttempts', 'correctionTurns', 'toolCalls', 'approvalRequests',
    'toolDenied', 'toolExpired', 'toolIndeterminate', 'estimatedTokens',
    'providerActiveDurationMs', 'engineActiveDurationMs'
  ] as const) {
    assert.throws(() => parseRunObservationCounters({
      ...initial,
      [key]: 'not_attempted'
    }), new RegExp(key, 'i'))
  }
})

test('v1 migration upgrades directly to v6 once and marks historical usage unavailable', () => {
  const active = legacyCheckpoint()
  const upgraded = upgradeRunCheckpointV1(active, { runRef, requestRef })

  assert.equal(upgraded.schemaVersion, 6)
  assert.equal(upgraded.contextRuntimeMode, 'legacy_compatible')
  assert.deepEqual(upgraded.pendingContextMessages, [])
  assert.equal(upgraded.providerGeneration, null)
  assert.equal(upgraded.modelLoopPolicy.kind, 'legacy_fixed')
  assert.equal(upgraded.contextPlan, null)
  assert.deepEqual(upgraded.contextArtifactRefs, [])
  assert.deepEqual(upgraded.reasoningSegments, [])
  assert.equal(upgraded.revision, active.revision + 1)
  assert.equal(upgraded.runId, active.runId)
  assert.equal(upgraded.requestRef, requestRef)
  assert.equal(upgraded.runRef, runRef)
  assert.equal(upgraded.requestKind, 'legacy_unknown')
  assert.equal(upgraded.presentationRoute, null)
  assert.equal(upgraded.completion, null)
  assert.deepEqual(upgraded.observationPolicy, {
    schemaVersion: 1,
    levelAtStart: 'off',
    sampledSuccess: false
  })
  assert.deepEqual({
    modelTurns: upgraded.observationCounters.modelTurns,
    toolCalls: upgraded.observationCounters.toolCalls,
    providerRetries: upgraded.observationCounters.providerRetries,
    recoveryAttempts: upgraded.observationCounters.recoveryAttempts,
    correctionTurns: upgraded.observationCounters.correctionTurns,
    estimatedTokens: upgraded.observationCounters.estimatedTokens,
    providerActiveDurationMs: upgraded.observationCounters.providerActiveDurationMs,
    providerAttempts: upgraded.observationCounters.providerAttempts,
    toolAttempts: upgraded.observationCounters.toolAttempts,
    providerTotalTokens: upgraded.observationCounters.providerTotalTokens,
    engineActiveDurationMs: upgraded.observationCounters.engineActiveDurationMs
  }, {
    modelTurns: 2,
    toolCalls: 1,
    providerRetries: 1,
    recoveryAttempts: 1,
    correctionTurns: 1,
    estimatedTokens: 42,
    providerActiveDurationMs: 17,
    providerAttempts: 'unavailable',
    toolAttempts: 'unavailable',
    providerTotalTokens: 'unavailable',
    engineActiveDurationMs: 'unavailable'
  })
  assert.deepEqual(upgraded.providerDispatch, { state: 'idle' })
  assert.deepEqual(upgraded.engineActivity, { state: 'idle' })
  assert.equal(Object.hasOwn(upgraded, 'visibleOutput'), false)
  assert.deepEqual(upgraded.modelCapability, {
    schemaVersion: 1,
    source: 'safe_default',
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown',
    usageExtensions: [],
    priceCatalogVersion: null
  })
  assert.equal(upgraded.modelPrice, null)
  assert.deepEqual(upgraded.usage, {
    schemaVersion: 1,
    availability: 'unavailable',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 0,
    cacheUsageComplete: false
  })
})

test('v2 migration upgrades directly to v6 once and preserves references and ledgers', () => {
  const pending = pendingApprovalState()
  const source = checkpointV2({
    status: 'waiting_approval',
    ...pending
  })

  const upgraded = upgradeRunCheckpointV2(source)

  assert.equal(upgraded.schemaVersion, 6)
  assert.equal(upgraded.contextRuntimeMode, 'legacy_compatible')
  assert.equal(upgraded.revision, source.revision + 1)
  assert.equal(upgraded.runRef, source.runRef)
  assert.equal(upgraded.requestRef, source.requestRef)
  assert.deepEqual(upgraded.reasoningSegments, [])
  assert.deepEqual(upgraded.interruption, source.interruption)
  assert.deepEqual(upgraded.preparedBatch, source.preparedBatch)
  assert.deepEqual(upgraded.toolLedgers, source.toolLedgers)
  assert.deepEqual(upgraded.observationPolicy, source.observationPolicy)
})

test('v3 migration upgrades directly to v6 once without changing legacy model config', () => {
  const source = checkpointV3()
  const upgraded = upgradeRunCheckpointV3(source)
  assert.equal(upgraded.schemaVersion, 6)
  assert.equal(upgraded.revision, source.revision + 1)
  assert.deepEqual(upgraded.model, source.model)
  assert.deepEqual(upgraded.reasoningSegments, source.reasoningSegments)
  assert.equal(upgraded.usage.availability, 'unavailable')
})

test('v4 migration upgrades directly to v6 while preserving frozen capability and usage', () => {
  const source = checkpointV4()
  const upgraded = upgradeRunCheckpointV4(source)
  assert.equal(upgraded.schemaVersion, 6)
  assert.equal(upgraded.revision, source.revision + 1)
  assert.deepEqual(upgraded.modelCapability, source.modelCapability)
  assert.deepEqual(upgraded.usage, source.usage)
  assert.equal(upgraded.toolWireSnapshot, null)
})

test('v5 migration upgrades directly to v6 and preserves its frozen planner inputs', () => {
  const source = checkpointV5()

  const upgraded = upgradeRunCheckpointV5(source)

  assert.equal(upgraded.schemaVersion, 6)
  assert.equal(upgraded.revision, source.revision + 1)
  assert.equal(upgraded.contextRuntimeMode, 'legacy_compatible')
  assert.deepEqual(upgraded.pendingContextMessages, [])
  assert.equal(upgraded.providerGeneration, null)
  assert.deepEqual(upgraded.modelLoopPolicy, source.modelLoopPolicy)
  assert.deepEqual(upgraded.contextPlan, source.contextPlan)
  assert.deepEqual(upgraded.contextArtifactRefs, source.contextArtifactRefs)
})

test('v5 codec preserves a legacy plan byte-for-byte and migration adds wire hashes', () => {
  const message = Object.freeze({ role: 'user' as const, content: 'legacy context' })
  const messages = Object.freeze([message])
  const base = checkpointV5()
  const estimatedInputTokens = estimateModelMessagesTokens(messages)
  const currentPlan = createContextPlanV1(Object.freeze({
    namespaceRef: base.runRef,
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: modelCapabilityStableHash(base.modelCapability),
    mode: 'normal' as const,
    included: Object.freeze([Object.freeze({
      spanId: 'span:legacy',
      representation: 'raw' as const,
      wireStart: 0,
      wireCount: 1,
      wireHash: contextWireHash(messages),
      contentHash: '4'.repeat(64)
    })]),
    omitted: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    prefixMessageCount: 0,
    estimatedInputTokens,
    estimatedToolTokens: 0,
    reservedOutputTokens: 1,
    serializedMessageBytes: serializedModelMessagesBytes(messages),
    messageCount: 1
  }))
  const legacyPlan = legacyPlanFromCurrent(currentPlan)
  const source = Object.freeze({
    ...base,
    messages,
    estimatedInputTokens,
    contextPlan: legacyPlan
  }) satisfies RunCheckpointV5
  const { events, ...state } = source
  const checkpointRaw = JSON.stringify(state)
  const eventsRaw = JSON.stringify({
    schemaVersion: 5,
    revision: source.revision,
    events
  })

  const loaded = new RunCheckpointCodec().decode(checkpointRaw, eventsRaw)

  assert.equal(loaded.schemaVersion, 5)
  if (loaded.schemaVersion !== 5) throw new Error('v5 checkpoint expected')
  const { events: loadedEvents, ...loadedState } = loaded
  assert.equal(JSON.stringify(loadedState), checkpointRaw)
  assert.deepEqual(loadedEvents, events)
  assert.deepEqual(loaded.contextPlan, legacyPlan)

  const upgraded = upgradeRunCheckpointV5(loaded)
  assert.equal(upgraded.contextPlan?.included[0]?.wireHash, contextWireHash(messages))
  assert.notEqual(upgraded.contextPlan?.planHash, legacyPlan.planHash)
  assert.deepEqual(validateExactRunCheckpointMigration(loaded, upgraded), upgraded)
})

test('exact migration ignores object insertion order but preserves array order', () => {
  const source = legacyCheckpoint({
    messages: Object.freeze([
      Object.freeze({ role: 'user' as const, content: 'first' }),
      Object.freeze({ role: 'user' as const, content: 'second' })
    ])
  })
  const upgraded = upgradeRunCheckpointV1(source, { runRef, requestRef })
  const reorderedCounters = Object.freeze(Object.fromEntries(
    Object.entries(upgraded.budgetCounters).reverse()
  )) as unknown as typeof upgraded.budgetCounters
  assert.deepEqual(validateExactRunCheckpointMigration(source, Object.freeze({
    ...upgraded,
    budgetCounters: reorderedCounters
  })), upgraded)
  assert.throws(() => validateExactRunCheckpointMigration(source, Object.freeze({
    ...upgraded,
    messages: Object.freeze([...upgraded.messages].reverse())
  })), /not canonical/i)
})

test('v1 completion upgrade covers text, visible output, failed, cancelled, active and approval states', () => {
  const text = legacyCheckpoint({
    status: 'completed',
    output: assistantOutput('  已完成  ')
  })
  const visible = legacyCheckpoint({ status: 'completed', visibleOutput: true })
  const failed = legacyCheckpoint({ status: 'failed', error: serializedError() })
  const cancelled = legacyCheckpoint({
    status: 'cancelled',
    cancellationReason: 'user_cancelled'
  })
  const active = legacyCheckpoint()
  const waiting = legacyCheckpoint({
    status: 'waiting_approval',
    ...pendingApprovalState()
  })

  assert.deepEqual(upgradeCompletionFromRunCheckpointV1(text), {
    kind: 'reply_text',
    text: '已完成'
  })
  assert.deepEqual(upgradeCompletionFromRunCheckpointV1(visible), {
    kind: 'already_visible',
    source: 'tool_output'
  })
  for (const checkpoint of [failed, cancelled, active, waiting]) {
    assert.equal(upgradeCompletionFromRunCheckpointV1(checkpoint), null)
  }
  for (const checkpoint of [failed, cancelled]) {
    assert.throws(
      () => upgradeRunCheckpointV1(checkpoint, { runRef, requestRef }),
      /terminal active/i
    )
  }
  for (const checkpoint of [active, waiting]) {
    assert.equal(
      upgradeRunCheckpointV1(checkpoint, { runRef, requestRef }).completion,
      null
    )
  }
})

test('codec reads schema v1 through v5, single-writes schema v6 and synchronizes envelope revision', () => {
  const codec = new RunCheckpointCodec()
  const legacy = legacyCheckpoint()
  const { events, ...legacyState } = legacy
  const loaded = codec.decode(JSON.stringify(legacyState), JSON.stringify({
    schemaVersion: 1,
    revision: legacy.revision,
    events
  }))
  assert.equal(loaded.schemaVersion, 1)

  const sourceV2 = checkpointV2()
  const { events: v2Events, ...v2State } = sourceV2
  assert.equal(codec.decode(JSON.stringify(v2State), JSON.stringify({
    schemaVersion: 2,
    revision: sourceV2.revision,
    events: v2Events
  })).schemaVersion, 2)

  const sourceV3 = checkpointV3()
  const { events: v3Events, ...v3State } = sourceV3
  assert.equal(codec.decode(JSON.stringify(v3State), JSON.stringify({
    schemaVersion: 3,
    revision: sourceV3.revision,
    events: v3Events
  })).schemaVersion, 3)

  const sourceV4 = checkpointV4()
  const { events: v4Events, ...v4State } = sourceV4
  assert.equal(codec.decode(JSON.stringify(v4State), JSON.stringify({
    schemaVersion: 4,
    revision: sourceV4.revision,
    events: v4Events
  })).schemaVersion, 4)

  const sourceV5 = checkpointV5()
  const { events: v5Events, ...v5State } = sourceV5
  assert.equal(codec.decode(JSON.stringify(v5State), JSON.stringify({
    schemaVersion: 5,
    revision: sourceV5.revision,
    events: v5Events
  })).schemaVersion, 5)

  const upgraded = upgradeRunCheckpointV1(legacy, { runRef, requestRef })
  const encoded = codec.encode(upgraded)
  assert.equal(JSON.parse(encoded.checkpoint).schemaVersion, 6)
  assert.deepEqual(JSON.parse(encoded.events), {
    schemaVersion: 6,
    revision: upgraded.revision,
    events: upgraded.events
  })
  assert.deepEqual(codec.decode(encoded.checkpoint, encoded.events), upgraded)
})

test('codec keeps the frozen legacy token budget when reading an existing checkpoint', () => {
  const codec = new RunCheckpointCodec()
  const legacy = legacyCheckpoint({
    budgetLimits: Object.freeze({
      ...legacyBudgetLimits,
      maxEstimatedTokens: 49_152 as const
    }),
    budgetCounters: Object.freeze({
      ...budget.initialCounters,
      estimatedTokens: 49_152
    })
  })
  const { events, ...state } = legacy

  const loaded = codec.decode(JSON.stringify(state), JSON.stringify({
    schemaVersion: 1,
    revision: legacy.revision,
    events
  }))

  assert.equal(loaded.schemaVersion === 1
    ? loaded.budgetLimits.maxEstimatedTokens
    : null, 49_152)
  assert.equal(loaded.budgetCounters.estimatedTokens, 49_152)
})

test('codec rejects string-encoded token budget limits', () => {
  const codec = new RunCheckpointCodec()
  const source = upgradeRunCheckpointV1(legacyCheckpoint(), { runRef, requestRef })
  const { events, ...state } = source

  for (const maxEstimatedTokens of ['49152', '196608']) {
    assert.throws(() => codec.decode(JSON.stringify({
      ...state,
      modelLoopPolicy: {
        ...state.modelLoopPolicy,
        maxEstimatedTokens
      }
    }), JSON.stringify({
      schemaVersion: 6,
      revision: source.revision,
      events
    })), /loop policy|budget limits/i)
  }
})

test('codec rejects string-encoded run budget counters', () => {
  const codec = new RunCheckpointCodec()
  const source = upgradeRunCheckpointV1(legacyCheckpoint(), { runRef, requestRef })
  const { events, ...state } = source

  for (const key of Object.keys(state.budgetCounters)) {
    assert.throws(() => codec.decode(JSON.stringify({
      ...state,
      budgetCounters: {
        ...state.budgetCounters,
        [key]: String(state.budgetCounters[key as keyof typeof state.budgetCounters])
      }
    }), JSON.stringify({
      schemaVersion: 6,
      revision: source.revision,
      events
    })), new RegExp(`run budget counter ${key} is invalid`, 'i'))
  }
})

test('v6 codec requires frozen capability, price and usage with a consistent catalog', () => {
  const codec = new RunCheckpointCodec()
  const upgraded = upgradeRunCheckpointV1(legacyCheckpoint(), { runRef, requestRef })
  const ordinaryRoute = Object.freeze({
    schemaVersion: 1 as const,
    requestKind: 'ordinary_chat' as const,
    profile: 'ordinary' as const,
    presentationIntent: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'ordinary' as const,
      forcePicture: false
    }),
    sessionAddress: upgraded.sessionAddress,
    actorId: 'actor-1'
  })
  const ordinary = Object.freeze({
    ...upgraded,
    requestKind: 'ordinary_chat' as const,
    presentationRoute: ordinaryRoute
  })
  assert.deepEqual(codec.decode(
    codec.encode(ordinary).checkpoint,
    codec.encode(ordinary).events
  ), ordinary)
  assert.throws(() => codec.encode({
    ...upgraded,
    secret: 'must-not-persist'
  } as unknown as RunCheckpointV6), /unknown checkpoint key/i)
  const { reasoningSegments: _reasoningSegments, ...missingReasoning } = upgraded
  assert.throws(() => codec.encode(
    missingReasoning as unknown as RunCheckpointV6
  ), /reasoning|missing/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    requestKind: 'ordinary_chat',
    presentationRoute: null
  } as RunCheckpointV6), /route|request kind|matrix/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    presentationRoute: ordinaryRoute
  } as RunCheckpointV6), /legacy|route/i)
  assert.throws(() => codec.encode({
    ...ordinary,
    requestKind: 'proactive_chat'
  } as RunCheckpointV6), /route|matrix/i)
  assert.throws(() => codec.encode({
    ...ordinary,
    presentationRoute: {
      ...ordinaryRoute,
      sessionAddress: {
        ...ordinaryRoute.sessionAddress,
        scope: { kind: 'group', groupId: 'another-group' }
      }
    }
  } as RunCheckpointV6), /route|matrix/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    status: 'completed',
    completion: Object.freeze({ kind: 'already_visible', source: 'tool_output' }),
    output: assistantOutput('不应同时存在')
  } as RunCheckpointV6), /completion|output/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    observationPolicy: Object.freeze({
      schemaVersion: 1,
      levelAtStart: 'basic',
      sampledSuccess: !createFrozenObservationPolicy({
        levelAtStart: 'basic',
        runRef: upgraded.runRef
      }).sampledSuccess
    })
  } as RunCheckpointV6), /policy|sample/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    modelCapability: {
      ...upgraded.modelCapability,
      priceCatalogVersion: 'catalog-v1'
    },
    modelPrice: null
  } as RunCheckpointV6), /price|catalog/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    usage: { ...upgraded.usage, extra: true }
  } as unknown as RunCheckpointV6), /usage/i)
})

test('v6 codec cross-validates context plan against run, wire and frozen capability', () => {
  const codec = new RunCheckpointCodec()
  const upgraded = upgradeRunCheckpointV1(legacyCheckpoint(), { runRef, requestRef })
  const plan = createContextPlanV1(Object.freeze({
    namespaceRef: upgraded.runRef,
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: modelCapabilityStableHash(upgraded.modelCapability),
    mode: 'normal' as const,
    included: Object.freeze([]),
    omitted: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    prefixMessageCount: 0,
    estimatedInputTokens: 0,
    estimatedToolTokens: 0,
    reservedOutputTokens: 1,
    serializedMessageBytes: serializedModelMessagesBytes(upgraded.messages),
    messageCount: 0
  }))
  const planned = Object.freeze({ ...upgraded, contextPlan: plan })
  assert.deepEqual(codec.decode(codec.encode(planned).checkpoint, codec.encode(planned).events), planned)
  assert.throws(() => codec.encode(Object.freeze({
    ...planned,
    contextPlan: Object.freeze({ ...plan, namespaceRef: 'f'.repeat(32) })
  }) as RunCheckpointV6), /context plan|invalid canonical/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...planned,
    estimatedInputTokens: 1
  }) as RunCheckpointV6), /context plan/i)
  const { schemaVersion: _planSchema, planHash: _planHash, ...planDraft } = plan
  const wrongCapabilityPlan = createContextPlanV1(Object.freeze({
    ...planDraft,
    capabilityHash: 'f'.repeat(64)
  }))
  assert.throws(() => codec.encode(Object.freeze({
    ...planned,
    contextPlan: wrongCapabilityPlan
  }) as RunCheckpointV6), /context plan/i)
  const wrongBytesPlan = createContextPlanV1(Object.freeze({
    ...planDraft,
    serializedMessageBytes: plan.serializedMessageBytes + 1
  }))
  assert.throws(() => codec.encode(Object.freeze({
    ...planned,
    contextPlan: wrongBytesPlan
  }) as RunCheckpointV6), /context plan/i)
  const wrongCountPlan = createContextPlanV1(Object.freeze({
    ...planDraft,
    included: Object.freeze([Object.freeze({
      spanId: 'span-1',
      representation: 'raw' as const,
      wireStart: 0,
      wireCount: 1,
      wireHash: '2'.repeat(64),
      contentHash: '1'.repeat(64)
    })]),
    messageCount: 1
  }))
  assert.throws(() => codec.encode(Object.freeze({
    ...planned,
    contextPlan: wrongCountPlan
  }) as RunCheckpointV6), /context plan/i)
  const actualWire = Object.freeze([
    Object.freeze({ role: 'user' as const, content: '甲' })
  ])
  const sameShapeWrongWire = Object.freeze([
    Object.freeze({ role: 'user' as const, content: '乙' })
  ])
  const wrongWirePlan = createContextPlanV1(Object.freeze({
    namespaceRef: upgraded.runRef,
    generation: 1,
    previousPlanHash: null,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    capabilityHash: modelCapabilityStableHash(upgraded.modelCapability),
    mode: 'normal' as const,
    included: Object.freeze([Object.freeze({
      spanId: 'span-same-shape-wrong-wire',
      representation: 'raw' as const,
      wireStart: 0,
      wireCount: 1,
      wireHash: contextWireHash(sameShapeWrongWire),
      contentHash: '1'.repeat(64)
    })]),
    omitted: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    prefixMessageCount: 0,
    estimatedInputTokens: estimateModelMessagesTokens(actualWire),
    estimatedToolTokens: 0,
    reservedOutputTokens: 1,
    serializedMessageBytes: serializedModelMessagesBytes(actualWire),
    messageCount: 1
  }))
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    messages: actualWire,
    estimatedInputTokens: estimateModelMessagesTokens(actualWire),
    contextPlan: wrongWirePlan
  }) as RunCheckpointV6), /context plan wire/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    contextArtifactRefs: Object.freeze(['artifact:'.concat('1'.repeat(64))])
  }) as RunCheckpointV6), /artifact|references/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    modelLoopPolicy: Object.freeze({ schemaVersion: 1, kind: 'adaptive_context' }),
    toolWireSnapshot: null
  }) as RunCheckpointV6), /tool wire snapshot/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    status: 'calling_model',
    providerDispatch: Object.freeze({ state: 'reserved' }),
    modelTurn: null
  }) as RunCheckpointV6), /dispatch state matrix/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    status: 'preparing',
    modelTurn: Object.freeze({ kind: 'normal' as const, maxOutputTokens: 1 })
  }) as RunCheckpointV6), /dispatch state matrix/i)
  assert.throws(() => codec.encode(Object.freeze({
    ...upgraded,
    status: 'calling_model',
    modelTurn: Object.freeze({ kind: 'correction' as const, maxOutputTokens: 1 })
  }) as RunCheckpointV6), /dispatch state matrix/i)
})
