import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError, serializeAgentError } from '../../src/agent/contracts/error.js'
import { parseRunAdvanceResult } from '../../src/agent/contracts/result.js'
import { parseProviderTurnState } from '../../src/agent/run/provider-state.js'
import {
  boundedMonotonicDurationMs,
  createDefaultRunBudget
} from '../../src/agent/run/run-budget.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import { RUN_RESOURCE_LIMITS } from '../../src/agent/run/run-limits.js'
import {
  createInitialRunObservationCounters,
  terminalObservationId
} from '../../src/agent/run/run-observation.js'
import { assertRunTransition } from '../../src/agent/run/run-state.js'

const timestamp = '2026-07-14T00:00:00.000Z'

function isRunBudgetExceeded (error: unknown): boolean {
  return error instanceof AgentError && error.code === 'run_budget_exceeded'
}

const assistantMessage = {
  id: 'message-1',
  role: 'assistant',
  parts: [{ type: 'text', text: '完成' }],
  createdAt: timestamp,
  provenance: {
    source: 'model_output',
    trust: 'untrusted',
    sensitivity: 'private',
    sourceId: 'run-1',
    createdAt: timestamp
  }
} as const

const interruption = {
  schemaVersion: 1,
  approvalId: 'approval-1',
  runId: 'run-1',
  step: 1,
  callId: 'call-1',
  toolFingerprint: 'tool-fingerprint',
  argumentHash: 'argument-hash',
  action: '禁言成员',
  target: '当前群成员',
  keyParameters: ['60 秒'],
  requester: { userId: 'actor-1', role: 'group_owner' },
  approverPolicy: {
    profile: 'safe',
    allowedRoles: ['bot_master', 'group_owner'],
    eligibleActorIds: ['actor-1'],
    requireDifferentActor: false
  },
  approvalAddress: {
    botId: 'bot-1',
    scope: { kind: 'group', groupId: 'group-1' }
  },
  createdAt: timestamp
} as const

const terminalRunRef = '1'.repeat(32)
const terminalRevision = 7
const terminalObservation = terminalObservationId(terminalRunRef, terminalRevision)
const terminalCounters = Object.freeze({
  ...createInitialRunObservationCounters(),
  providerAttempts: 1,
  modelTurns: 1,
  providerInputTokens: 3,
  providerOutputTokens: 2,
  providerTotalTokens: 5,
  providerActiveDurationMs: 7,
  engineActiveDurationMs: 11
})

function terminalFacts (
  status: 'completed' | 'failed' | 'cancelled' = 'completed'
) {
  const snapshot = Object.freeze({
    schemaVersion: 2 as const,
    observationId: terminalObservation,
    runRef: terminalRunRef,
    revision: terminalRevision,
    status,
    finishedAt: timestamp,
    completion: status === 'completed'
      ? Object.freeze({ kind: 'reply_text' as const, lengthBucket: '1_40' as const })
      : Object.freeze({ kind: 'none' as const }),
    errorCode: status === 'failed' ? 'provider_protocol_error' as const : null,
    cancellationReason: status === 'cancelled' ? 'user_cancelled' : null,
    counters: terminalCounters,
    engineDurationMs: terminalCounters.engineActiveDurationMs
  })
  return Object.freeze({
    snapshot,
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      observationId: terminalObservation,
      runRef: terminalRunRef,
      revision: terminalRevision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 100,
      eventBytesDeleted: 20,
      tombstoneBytes: 300
    })
  })
}

test('freezes the confirmed balanced run budget', () => {
  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })

  assert.deepEqual(budget.limits, {
    activeRuntimeMs: 240_000,
    providerTimeoutMs: 120_000,
    maxModelTurns: 6,
    maxToolCalls: 8,
    maxEstimatedTokens: 49_152,
    maxProgressEvents: 5,
    maxProviderRetries: 1,
    maxRecoveryAttempts: 1,
    maxCorrectionTurns: 1
  })
  assert.equal(Object.isFrozen(budget.limits), true)
  assert.equal(Object.isFrozen(budget.initialCounters), true)
})

test('reserves run budget without mutating earlier counter snapshots', () => {
  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })
  const initial = budget.initialCounters
  let counters = initial

  for (let index = 0; index < 5; index += 1) {
    counters = budget.reserveModelTurn(counters, {
      kind: 'normal',
      estimatedInputTokens: 1_000
    })
  }
  assert.equal(initial.modelTurns, 0)
  assert.equal(counters.modelTurns, 5)
  assert.equal(Object.isFrozen(counters), true)
  assert.throws(
    () => budget.reserveModelTurn(counters, { kind: 'normal', estimatedInputTokens: 1 }),
    isRunBudgetExceeded
  )

  const withCorrection = budget.recordCorrection(counters)
  const corrected = budget.reserveModelTurn(withCorrection, {
    kind: 'correction',
    estimatedInputTokens: 1_000,
    maxOutputTokens: 2_048
  })
  assert.equal(corrected.modelTurns, 6)
  assert.equal(corrected.correctionTurns, 1)
  assert.equal(counters.correctionTurns, 0)
  assert.throws(() => budget.recordCorrection(corrected), isRunBudgetExceeded)

  const withTools = budget.reserveToolBatch(initial, 8)
  assert.equal(withTools.toolCalls, 8)
  assert.throws(() => budget.reserveToolBatch(withTools, 1), isRunBudgetExceeded)
})

test('keeps provider retry, recovery and correction counters independent', () => {
  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })
  const providerRetried = budget.recordProviderRetry(budget.initialCounters)
  assert.deepEqual({
    providerRetries: providerRetried.providerRetries,
    recoveryAttempts: providerRetried.recoveryAttempts,
    correctionTurns: providerRetried.correctionTurns
  }, {
    providerRetries: 1,
    recoveryAttempts: 0,
    correctionTurns: 0
  })
  const recovered = budget.recordRecovery(providerRetried)
  const corrected = budget.recordCorrection(recovered)
  assert.equal(corrected.providerRetries, 1)
  assert.equal(corrected.recoveryAttempts, 1)
  assert.equal(corrected.correctionTurns, 1)
  assert.throws(() => budget.recordProviderRetry(corrected), isRunBudgetExceeded)
  assert.throws(() => budget.recordRecovery(corrected), isRunBudgetExceeded)
  assert.throws(() => budget.recordCorrection(corrected), isRunBudgetExceeded)
})

test('accounts active runtime and progress before crossing their limits', () => {
  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })
  const used = budget.recordUsage(budget.initialCounters, {
    activeRuntimeMs: 239_999,
    providerReportedTokens: 512,
    progressEvents: 5
  })
  assert.equal(budget.remainingActiveMs(used), 1)
  assert.equal(used.providerReportedTokens, 512)
  assert.throws(
    () => budget.recordUsage(used, { activeRuntimeMs: 2 }),
    isRunBudgetExceeded
  )
  assert.throws(
    () => budget.recordUsage(used, { progressEvents: 1 }),
    isRunBudgetExceeded
  )
})

test('bounds monotonic observations without changing Provider-only active budget meaning', () => {
  assert.equal(boundedMonotonicDurationMs(10.2, 13.7, 100), 4)
  assert.equal(boundedMonotonicDurationMs(10, 9, 100), 0)
  assert.equal(boundedMonotonicDurationMs(10, 5_010, 1_000), 1_000)
  assert.equal(boundedMonotonicDurationMs(Number.NaN, 5, 100), 0)

  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 4_096
  })
  const counters = budget.recordUsage(budget.initialCounters, {
    activeRuntimeMs: 7
  })
  assert.equal(counters.usedActiveRuntimeMs, 7)
  assert.equal(budget.remainingActiveMs(counters), 239_993)
})

test('rejects illegal and terminal run transitions', () => {
  assert.doesNotThrow(() => assertRunTransition('calling_model', 'evaluating_tools'))
  assert.doesNotThrow(() => assertRunTransition('executing_tools', 'calling_model'))
  assert.doesNotThrow(() => assertRunTransition('waiting_approval', 'evaluating_tools'))
  assert.doesNotThrow(() => assertRunTransition('calling_model', 'correcting'))
  assert.throws(
    () => assertRunTransition('created', 'executing_tools'),
    /illegal run transition/
  )
  assert.throws(
    () => assertRunTransition('completed', 'calling_model'),
    /terminal run state/
  )
})

test('freezes every confirmed provider and tool protocol byte limit', () => {
  assert.deepEqual(RUN_RESOURCE_LIMITS, {
    requestBytes: 512 * 1_024,
    sseLineBytes: 64 * 1_024,
    providerResponseBytes: 1_024 * 1_024,
    toolArgumentsBytes: 32 * 1_024,
    toolResultBytes: 64 * 1_024,
    providerStateBytes: 128 * 1_024,
    sanitizedErrorBodyBytes: 16 * 1_024,
    providerProtocolChainBytes: 192 * 1_024,
    checkpointBytes: 256 * 1_024,
    eventCount: 96,
    eventBytes: 128 * 1_024,
    namespaceBytes: 8 * 1_024 * 1_024,
    tombstoneBytes: 4 * 1_024,
    checkpointKeys: 16,
    eventKeys: 16,
    tombstoneKeys: 128,
    referenceKeys: 144,
    indexAdmissionKeys: 64
  })
  assert.equal(Object.isFrozen(RUN_RESOURCE_LIMITS), true)
})

test('accepts only bounded opaque provider turn state', () => {
  const state = parseProviderTurnState({
    profileId: 'deepseek',
    profileVersion: 1,
    payload: {
      reasoning_content: 'bounded thought',
      flags: [true, null, 1]
    }
  })

  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.payload), true)
  assert.throws(() => parseProviderTurnState({
    profileId: 'deepseek',
    profileVersion: 1,
    payload: { unsafe: () => 'secret' }
  }), /JSON value/)
  assert.throws(() => parseProviderTurnState({
    profileId: 'deepseek',
    profileVersion: 1,
    payload: { reasoning_content: 'x'.repeat(RUN_RESOURCE_LIMITS.providerStateBytes) }
  }), /provider state byte limit/)
})

test('creates the new stable run and approval events with primitive payloads', () => {
  const types = ['run.paused', 'run.resumed', 'run.progress', 'approval.expired'] as const

  for (const [sequence, type] of types.entries()) {
    const event = createRunEvent({
      eventId: `event-${sequence}`,
      runId: 'run-1',
      sessionId: 'session-1',
      sequence,
      occurredAt: timestamp,
      type,
      payload: { step: sequence, visible: true }
    })
    assert.equal(event.type, type)
    assert.equal(Object.isFrozen(event), true)
    assert.equal(Object.isFrozen(event.payload), true)
  }

  assert.throws(() => createRunEvent({
    eventId: 'event-unsafe',
    runId: 'run-1',
    sessionId: 'session-1',
    sequence: 4,
    occurredAt: timestamp,
    type: 'run.progress',
    payload: { nested: { secret: true } } as never
  }), /non-primitive/)
})

test('parses every bounded run advance result branch', () => {
  const completed = parseRunAdvanceResult({
    kind: 'completed',
    runId: 'run-1',
    runRef: terminalRunRef,
    completion: { kind: 'reply_text', text: '完成' },
    output: assistantMessage,
    terminal: terminalFacts()
  })
  assert.equal(completed.kind, 'completed')
  assert.equal(parseRunAdvanceResult({
    kind: 'completed',
    runId: 'run-1',
    runRef: terminalRunRef,
    completion: { kind: 'already_visible', source: 'tool_output' },
    output: null,
    terminal: Object.freeze({
      ...terminalFacts(),
      snapshot: Object.freeze({
        ...terminalFacts().snapshot,
        completion: Object.freeze({
          kind: 'already_visible' as const,
          source: 'tool_output' as const
        })
      })
    })
  }).kind, 'completed')
  assert.equal(parseRunAdvanceResult({
    kind: 'paused',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    interruption
  }).kind, 'paused')
  assert.equal(parseRunAdvanceResult({
    kind: 'failed',
    runId: 'run-1',
    runRef: 'unavailable',
    error: serializeAgentError(new AgentError({
      code: 'provider_protocol_error',
      stage: 'model.decode',
      retryable: false,
      userMessage: '模型响应协议异常，请稍后重试。'
    })),
    terminal: null
  }).kind, 'failed')
  assert.equal(parseRunAdvanceResult({
    kind: 'cancelled',
    runId: 'run-1',
    runRef: 'unavailable',
    reason: 'caller_aborted',
    terminal: null
  }).kind, 'cancelled')

  assert.throws(() => parseRunAdvanceResult({
    kind: 'completed',
    runId: 'run-1',
    runRef: terminalRunRef,
    completion: { kind: 'reply_text', text: '完成' },
    output: null,
    terminal: terminalFacts()
  }), /completed run output/)
  assert.throws(() => parseRunAdvanceResult({
    kind: 'failed',
    runId: 'run-1',
    runRef: 'unavailable',
    error: {
      code: 'provider_protocol_error',
      stage: 'model.decode',
      retryable: false,
      userMessage: 'safe',
      details: { nested: { secret: true } }
    },
    terminal: null
  }), /non-primitive/)
})

test('cross-validates terminal result kind, payload and exact receipt identity', () => {
  const failedError = serializeAgentError(new AgentError({
    code: 'provider_protocol_error',
    stage: 'model.decode',
    retryable: false,
    userMessage: 'safe'
  }))
  const completed = {
    kind: 'completed',
    runId: 'run-1',
    runRef: terminalRunRef,
    completion: { kind: 'reply_text', text: '完成' },
    output: assistantMessage,
    terminal: terminalFacts()
  } as const
  const failed = {
    kind: 'failed',
    runId: 'run-1',
    runRef: terminalRunRef,
    error: failedError,
    terminal: terminalFacts('failed')
  } as const
  const cancelled = {
    kind: 'cancelled',
    runId: 'run-1',
    runRef: terminalRunRef,
    reason: 'user_cancelled',
    terminal: terminalFacts('cancelled')
  } as const

  assert.equal(parseRunAdvanceResult(completed).kind, 'completed')
  assert.equal(parseRunAdvanceResult(failed).kind, 'failed')
  assert.equal(parseRunAdvanceResult(cancelled).kind, 'cancelled')

  for (const valid of [
    { ...failed, runRef: 'unavailable', terminal: null },
    { ...failed, terminal: null },
    { ...cancelled, runRef: 'unavailable', terminal: null },
    { ...cancelled, terminal: null }
  ]) {
    assert.doesNotThrow(() => parseRunAdvanceResult(valid))
  }

  const hostile = [
    { ...completed, terminal: null },
    { ...completed, terminal: terminalFacts('failed') },
    { ...failed, terminal: terminalFacts() },
    { ...cancelled, terminal: terminalFacts('failed') },
    { ...completed, runRef: '2'.repeat(32) },
    {
      ...completed,
      terminal: {
        ...completed.terminal,
        receipt: { ...completed.terminal.receipt, runRef: '2'.repeat(32) }
      }
    },
    {
      ...completed,
      terminal: {
        ...completed.terminal,
        receipt: { ...completed.terminal.receipt, revision: terminalRevision + 1 }
      }
    },
    {
      ...completed,
      terminal: {
        ...completed.terminal,
        receipt: { ...completed.terminal.receipt, observationId: 'f'.repeat(64) }
      }
    },
    { ...completed, extra: true },
    { ...completed, terminal: { ...completed.terminal, extra: true } },
    {
      ...completed,
      terminal: {
        ...completed.terminal,
        snapshot: { ...completed.terminal.snapshot, extra: true }
      }
    },
    {
      ...completed,
      terminal: {
        ...completed.terminal,
        receipt: { ...completed.terminal.receipt, extra: true }
      }
    }
  ]
  for (const value of hostile) {
    assert.throws(() => parseRunAdvanceResult(value), TypeError)
  }

  assert.throws(() => parseRunAdvanceResult({
    ...completed,
    completion: { kind: 'already_visible', source: 'tool_output' },
    output: null
  }), /completion|terminal/i)
  assert.throws(() => parseRunAdvanceResult({
    ...failed,
    error: serializeAgentError(new AgentError({
      code: 'provider_unavailable',
      stage: 'model.decode',
      retryable: false,
      userMessage: 'safe'
    }))
  }), /error|terminal/i)
  assert.throws(() => parseRunAdvanceResult({
    ...cancelled,
    reason: 'deadline_exceeded'
  }), /reason|terminal/i)
})
