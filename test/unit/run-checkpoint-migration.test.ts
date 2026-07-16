import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentEvent } from '../../src/agent/contracts/event.js'
import type { SerializedAgentError } from '../../src/agent/contracts/error.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  RunCheckpointCodec,
  type RunCheckpointV1,
  type RunCheckpointV2
} from '../../src/agent/run/run-checkpoint.js'
import {
  upgradeCompletionFromRunCheckpointV1,
  upgradeRunCheckpointV1
} from '../../src/agent/run/run-checkpoint-migration.js'
import {
  createFrozenObservationPolicy,
  createInitialRunObservationCounters,
  parseFrozenObservationPolicy,
  parseRunObservationCounters
} from '../../src/agent/run/run-observation.js'

const createdAt = '2026-07-16T00:00:00.000Z'
const deadlineAt = '2026-07-16T00:04:00.000Z'
const runRef = '00000000000000000000000000000020'
const requestRef = '11111111111111111111111111111111'
const snapshotFingerprint = createHash('sha256').update('[]').digest('hex')
const budget = createDefaultRunBudget({
  providerTimeoutMs: 120_000,
  outputTokens: 256
})

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
    budgetLimits: budget.limits,
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

test('v1 migration preserves the full state, increments revision and maps only provable facts', () => {
  const active = legacyCheckpoint()
  const upgraded = upgradeRunCheckpointV1(active, { runRef, requestRef })

  assert.equal(upgraded.schemaVersion, 2)
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
    assert.equal(
      upgradeRunCheckpointV1(checkpoint, { runRef, requestRef }).completion,
      null
    )
  }
})

test('codec dual-reads schema v1, single-writes schema v2 and synchronizes envelope revision', () => {
  const codec = new RunCheckpointCodec()
  const legacy = legacyCheckpoint()
  const { events, ...legacyState } = legacy
  const loaded = codec.decode(JSON.stringify(legacyState), JSON.stringify({
    schemaVersion: 1,
    revision: legacy.revision,
    events
  }))
  assert.equal(loaded.schemaVersion, 1)

  const upgraded = upgradeRunCheckpointV1(legacy, { runRef, requestRef })
  const encoded = codec.encode(upgraded)
  assert.equal(JSON.parse(encoded.checkpoint).schemaVersion, 2)
  assert.deepEqual(JSON.parse(encoded.events), {
    schemaVersion: 2,
    revision: upgraded.revision,
    events: upgraded.events
  })
  assert.deepEqual(codec.decode(encoded.checkpoint, encoded.events), upgraded)
})

test('v2 codec rejects unknown fields, route mismatches and completion/output inconsistency', () => {
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
  } as unknown as RunCheckpointV2), /unknown checkpoint key/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    requestKind: 'ordinary_chat',
    presentationRoute: null
  } as RunCheckpointV2), /route|request kind|matrix/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    presentationRoute: ordinaryRoute
  } as RunCheckpointV2), /legacy|route/i)
  assert.throws(() => codec.encode({
    ...ordinary,
    requestKind: 'proactive_chat'
  } as RunCheckpointV2), /route|matrix/i)
  assert.throws(() => codec.encode({
    ...ordinary,
    presentationRoute: {
      ...ordinaryRoute,
      sessionAddress: {
        ...ordinaryRoute.sessionAddress,
        scope: { kind: 'group', groupId: 'another-group' }
      }
    }
  } as RunCheckpointV2), /route|matrix/i)
  assert.throws(() => codec.encode({
    ...upgraded,
    status: 'completed',
    completion: Object.freeze({ kind: 'already_visible', source: 'tool_output' }),
    output: assistantOutput('不应同时存在')
  } as RunCheckpointV2), /completion|output/i)
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
  } as RunCheckpointV2), /policy|sample/i)
})
