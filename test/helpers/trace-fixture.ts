import { createHash } from 'node:crypto'
import { AgentError, serializeAgentError } from '../../src/agent/contracts/error.js'
import type { AgentEventType } from '../../src/agent/contracts/event.js'
import { parseModelCapabilitySnapshot } from '../../src/agent/model/model-capability.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot,
  type FrozenObservationPolicyV1
} from '../../src/agent/run/run-observation.js'
import {
  createTraceCandidate,
  type TraceCandidateV1
} from '../../src/agent/run/run-trace.js'
import {
  parsePresentationObservation,
  type PresentationObservationV1
} from '../../src/runtime/observability/observation-event.js'

const DEFAULT_FINISHED_AT = '2026-07-16T00:00:00.000Z'
const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
const emptyFingerprint = createHash('sha256').update('[]').digest('hex')
export const FIXTURE_MODEL_CAPABILITY = parseModelCapabilitySnapshot({
  schemaVersion: 1,
  source: 'safe_default',
  contextWindowTokens: 32_768,
  maxOutputTokens: 8_192,
  promptCaching: 'unknown',
  usageExtensions: [],
  priceCatalogVersion: null
})

export function traceRunRef (sampledSuccess: boolean, seed = 0): string {
  for (let index = seed; index < seed + 10_000; index += 1) {
    const runRef = createHash('sha256').update(`trace-fixture:${index}`).digest('hex').slice(0, 32)
    if (createFrozenObservationPolicy({ levelAtStart: 'basic', runRef }).sampledSuccess ===
      sampledSuccess) return runRef
  }
  throw new Error('trace fixture run reference was not found')
}

function runEvent (
  runId: string,
  sequence: number,
  type: AgentEventType,
  occurredAt: string
) {
  return createRunEvent({
    eventId: `event-${runId}-${sequence}`,
    runId,
    sessionId: 'private-session-id',
    sequence,
    occurredAt,
    type,
    payload: Object.freeze({})
  })
}

function initialCheckpoint (input: {
  readonly runRef: string
  readonly level: FrozenObservationPolicyV1['levelAtStart']
  readonly finishedAt: string
}): RunCheckpoint {
  const runId = 'private-run-id'
  const sessionId = 'private-session-id'
  return createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId,
    sessionId,
    sessionAddress: Object.freeze({
      botId: 'fixture-bot',
      scope: Object.freeze({ kind: 'group', groupId: 'fixture-group' })
    }),
    runRef: input.runRef,
    requestRef: createHash('sha256').update(`request:${input.runRef}`).digest('hex').slice(0, 32),
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1,
        kind: 'ordinary',
        forcePicture: false
      }),
      sessionAddress: Object.freeze({
        botId: 'fixture-bot',
        scope: Object.freeze({ kind: 'group', groupId: 'fixture-group' })
      }),
      actorId: 'fixture-actor'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: input.level,
      runRef: input.runRef
    }),
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'fixture-snapshot',
      fingerprint: emptyFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: new Date(new Date(input.finishedAt).getTime() + 240_000).toISOString(),
    createdAt: input.finishedAt,
    event: runEvent(runId, 0, 'run.created', input.finishedAt)
  })
}

export function traceCandidateFixture (input: {
  readonly runRef?: string
  readonly sampledSuccess?: boolean
  readonly level?: FrozenObservationPolicyV1['levelAtStart']
  readonly status?: 'completed' | 'failed' | 'cancelled'
  readonly finishedAt?: string
} = {}): TraceCandidateV1 {
  const finishedAt = input.finishedAt ?? DEFAULT_FINISHED_AT
  const level = input.level ?? 'basic'
  const runRef = input.runRef ?? traceRunRef(input.sampledSuccess ?? false)
  const created = initialCheckpoint({ runRef, level, finishedAt })
  const preparing = nextRunCheckpoint(created, 'preparing', {}, [], finishedAt)
  const source = nextRunCheckpoint(preparing, 'calling_model', {}, [], finishedAt)
  const sequence = source.nextEventSequence
  const status = input.status ?? 'completed'
  let terminal: RunCheckpoint
  if (status === 'completed') {
    const output = Object.freeze({
      id: `assistant-${runRef}`,
      role: 'assistant' as const,
      parts: Object.freeze([{ type: 'text' as const, text: 'safe fixture' }]),
      createdAt: finishedAt,
      provenance: Object.freeze({
        source: 'model' as const,
        trust: 'untrusted' as const,
        sensitivity: 'group' as const,
        sourceId: source.runId,
        createdAt: finishedAt
      })
    })
    terminal = nextRunCheckpoint(source, 'completed', {
      output,
      completion: Object.freeze({ kind: 'reply_text', text: 'safe fixture' })
    }, [runEvent(source.runId, sequence, 'run.completed', finishedAt)], finishedAt)
  } else if (status === 'failed') {
    terminal = nextRunCheckpoint(source, 'failed', {
      error: serializeAgentError(new AgentError({
        code: 'provider_unavailable',
        stage: 'model.response',
        retryable: true,
        userMessage: 'safe fixture'
      }))
    }, [runEvent(source.runId, sequence, 'run.failed', finishedAt)], finishedAt)
  } else {
    terminal = nextRunCheckpoint(source, 'cancelled', {
      cancellationReason: 'user_cancelled'
    }, [runEvent(source.runId, sequence, 'run.cancelled', finishedAt)], finishedAt)
  }
  return createTraceCandidate({
    checkpoint: terminal,
    snapshot: createRunTerminalSnapshot(terminal)
  })
}

export function tracePresentationFixture (
  candidate: TraceCandidateV1,
  input: {
    readonly id?: string
    readonly anomaly?: boolean
  } = {}
): PresentationObservationV1 {
  const anomaly = input.anomaly ?? false
  return parsePresentationObservation({
    schemaVersion: 1,
    presentationObservationId: input.id ?? 'a'.repeat(64),
    runRef: candidate.runRef,
    terminalObservationId: candidate.observationId,
    profile: 'ordinary',
    outcome: anomaly ? 'failed' : 'complete',
    postprocessAnomaly: anomaly,
    deliveries: [],
    totalDurationMs: 12,
    reducerInput: {
      schemaVersion: 1,
      reducerVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      textLengthBucket: '1_40',
      hasReasoning: false,
      hasCitation: false,
      buttonsEligible: false,
      ttsEligibility: 'disabled',
      pictureEligibility: 'disabled',
      quotePolicy: 'none',
      selectedMode: 'text',
      fallbackReason: anomaly ? 'delivery_definite_failure' : 'none',
      configEnumVersion: 1
    }
  })
}
