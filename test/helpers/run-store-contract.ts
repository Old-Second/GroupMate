import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import {
  AgentError,
  serializeAgentError,
  type AgentErrorCode
} from '../../src/agent/contracts/error.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  RunCheckpointCodec,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot,
  parseRunTerminalSnapshot,
  type RunTerminalSnapshotV2
} from '../../src/agent/run/run-observation.js'
import {
  RunStoreConflictError,
  type RunStore
} from '../../src/agent/run/run-store.js'
import { FIXTURE_MODEL_CAPABILITY } from './trace-fixture.js'

const createdAt = '2026-07-16T00:00:00.000Z'
const finishedAt = '2026-07-16T00:00:01.000Z'
const budget = createDefaultRunBudget({
  providerTimeoutMs: 120_000,
  outputTokens: 256
})
const emptyManifestFingerprint = createHash('sha256').update('[]').digest('hex')

type FinishRemoved = 'finish' extends keyof RunStore ? false : true
const FINISH_REMOVED: FinishRemoved = true

export interface RunStoreContractHarness {
  readonly store: RunStore
  readRawTombstone(runId: string): Promise<string | null>
  seedRawTombstone(runId: string, raw: string): Promise<void>
}

export interface RunStoreContractAdapter {
  readonly name: string
  create(): Promise<RunStoreContractHarness> | RunStoreContractHarness
}

function initialCheckpoint (runId: string): RunCheckpoint {
  const runRef = createHash('md5').update(`run:${runId}`).digest('hex')
  const requestRef = createHash('md5').update(`request:${runId}`).digest('hex')
  const sessionAddress = Object.freeze({
    botId: 'bot-private-value',
    scope: Object.freeze({
      kind: 'group_user' as const,
      groupId: 'group-private-value',
      userId: 'user-private-value'
    })
  })
  return createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId,
    sessionId: 'session-private-value',
    sessionAddress,
    runRef,
    requestRef,
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
      sessionAddress,
      actorId: 'actor-private-value',
      requestMessageId: 'message-private-value'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic',
      runRef
    }),
    model: Object.freeze({
      model: 'fixture-模型-🧪',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'snapshot-private-value',
      fingerprint: emptyManifestFingerprint,
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-16T00:04:00.000Z',
    createdAt,
    event: createRunEvent({
      eventId: 'event-private-value',
      runId,
      sessionId: 'session-private-value',
      sequence: 0,
      occurredAt: createdAt,
      type: 'run.created',
      payload: Object.freeze({ receiptFixture: '事件-🧪' })
    })
  })
}

async function activeCheckpoint (
  harness: RunStoreContractHarness,
  runId: string
): Promise<RunCheckpoint> {
  const created = await harness.store.create(initialCheckpoint(runId))
  const preparing = nextRunCheckpoint(created, 'preparing', {}, [], createdAt)
  await harness.store.compareAndSet(created, preparing)
  const calling = nextRunCheckpoint(preparing, 'calling_model', {}, [], createdAt)
  await harness.store.compareAndSet(preparing, calling)
  return calling
}

function assistantOutput (source: RunCheckpoint, text: string) {
  return Object.freeze({
    id: 'assistant-private-value',
    role: 'assistant' as const,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt: finishedAt,
    provenance: Object.freeze({
      source: 'model' as const,
      trust: 'untrusted' as const,
      sensitivity: 'group' as const,
      sourceId: source.runId,
      createdAt: finishedAt
    })
  })
}

function completedCheckpoint (source: RunCheckpoint, text = 'done'): RunCheckpoint {
  return nextRunCheckpoint(source, 'completed', {
    output: assistantOutput(source, text),
    completion: Object.freeze({ kind: 'reply_text', text }),
    observationCounters: Object.freeze({
      ...source.observationCounters,
      providerAttempts: 1,
      modelTurns: 1,
      providerInputTokens: 3,
      providerOutputTokens: 2,
      providerTotalTokens: 5,
      providerActiveDurationMs: 7,
      engineActiveDurationMs: 11
    })
  }, [], finishedAt)
}

function failedCheckpoint (
  source: RunCheckpoint,
  code: AgentErrorCode = 'provider_unavailable'
): RunCheckpoint {
  return nextRunCheckpoint(source, 'failed', {
    error: serializeAgentError(new AgentError({
      code,
      stage: 'model.response',
      retryable: false,
      userMessage: 'safe'
    })),
    observationCounters: Object.freeze({
      ...source.observationCounters,
      providerAttempts: 1,
      modelTurns: 'unavailable',
      providerInputTokens: 'unavailable',
      providerOutputTokens: 'unavailable',
      providerTotalTokens: 'unavailable',
      providerActiveDurationMs: 7,
      engineActiveDurationMs: 11
    })
  }, [], finishedAt)
}

function cancelledCheckpoint (
  source: RunCheckpoint,
  reason = 'user_cancelled'
): RunCheckpoint {
  return nextRunCheckpoint(source, 'cancelled', {
    cancellationReason: reason,
    observationCounters: Object.freeze({
      ...source.observationCounters,
      engineActiveDurationMs: 11
    })
  }, [], finishedAt)
}

function withCounterMismatch (
  snapshot: RunTerminalSnapshotV2
): RunTerminalSnapshotV2 {
  return parseRunTerminalSnapshot({
    ...snapshot,
    counters: {
      ...snapshot.counters,
      toolCalls: snapshot.counters.toolCalls === 0 ? 1 : 0
    }
  })
}

function legacyTombstone (runId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    sessionId: 'legacy-session-private-value',
    revision: 9,
    status: 'cancelled',
    finishedAt,
    visibleOutput: true,
    errorCode: null,
    cancellationReason: 'user_cancelled',
    providerRetries: 2,
    recoveryAttempts: 3,
    correctionTurns: 4
  })
}

export function registerRunStoreContract (
  adapter: RunStoreContractAdapter
): void {
  describe(`${adapter.name} RunStore contract`, () => {
    test('removes finish and rejects terminal compareAndSet bypasses', async () => {
      assert.equal(FINISH_REMOVED, true)
      const harness = await adapter.create()
      const active = await activeCheckpoint(harness, `${adapter.name}-terminal-cas`)
      const terminal = cancelledCheckpoint(active)

      await assert.rejects(
        harness.store.compareAndSet(active, terminal),
        error => error instanceof RunStoreConflictError
      )
      assert.deepEqual(await harness.store.load(active.runId), active)
      assert.equal(await harness.store.loadTombstone(active.runId), null)
    })

    test('atomically commits one terminal winner and returns exact byte receipt', async () => {
      const harness = await adapter.create()
      const active = await activeCheckpoint(harness, `${adapter.name}-commit-winner`)
      const terminal = completedCheckpoint(active)
      const snapshot = createRunTerminalSnapshot(terminal)
      const encoded = new RunCheckpointCodec().encode(active)
      assert.deepEqual(await harness.store.observationUsage(), {
        schemaVersion: 1,
        tombstoneRecords: 0,
        tombstoneBytes: 0
      })
      assert.notEqual(
        encoded.checkpoint.length,
        Buffer.byteLength(encoded.checkpoint, 'utf8'),
        'checkpoint fixture must distinguish UTF-16 length from UTF-8 bytes'
      )
      assert.notEqual(
        encoded.events.length,
        Buffer.byteLength(encoded.events, 'utf8'),
        'event fixture must distinguish UTF-16 length from UTF-8 bytes'
      )

      const [first, second] = await Promise.allSettled([
        harness.store.commitTerminal(active, terminal, snapshot),
        harness.store.commitTerminal(active, terminal, snapshot)
      ])
      assert.deepEqual([first.status, second.status].sort(), ['fulfilled', 'rejected'])
      const winner = first.status === 'fulfilled' ? first.value :
        second.status === 'fulfilled' ? second.value : null
      const loser = first.status === 'rejected' ? first.reason :
        second.status === 'rejected' ? second.reason : null
      assert.ok(winner !== null)
      assert.ok(loser instanceof RunStoreConflictError)
      assert.equal(await harness.store.load(active.runId), null)

      const raw = await harness.readRawTombstone(active.runId)
      assert.notEqual(raw, null)
      assert.deepEqual(await harness.store.observationUsage(), {
        schemaVersion: 1,
        tombstoneRecords: 1,
        tombstoneBytes: Buffer.byteLength(raw ?? '', 'utf8')
      })
      assert.deepEqual(winner, {
        schemaVersion: 1,
        observationId: snapshot.observationId,
        runRef: snapshot.runRef,
        revision: snapshot.revision,
        deletedKeyCount: 2,
        createdKeyCount: 1,
        checkpointBytesDeleted: Buffer.byteLength(encoded.checkpoint, 'utf8'),
        eventBytesDeleted: Buffer.byteLength(encoded.events, 'utf8'),
        tombstoneBytes: Buffer.byteLength(raw ?? '', 'utf8')
      })
      assert.ok(Buffer.byteLength(raw ?? '', 'utf8') <= 4 * 1_024)
      const {
        schemaVersion: _snapshotSchemaVersion,
        ...normalizedSnapshot
      } = snapshot
      assert.deepEqual(await harness.store.loadTombstone(active.runId), {
        schemaVersion: 1,
        sourceSchemaVersion: 2,
        ...normalizedSnapshot
      })
      assert.doesNotMatch(raw ?? '', /private-value/)
      assert.doesNotMatch(
        raw ?? '',
        /"(?:sessionId|runId|output|route|actorId|toolData|presentation)"/
      )
    })

    test('recomputes the canonical snapshot and rejects every valid mismatch', async () => {
      const cases = [
        {
          name: 'status',
          next: (active: RunCheckpoint) => cancelledCheckpoint(active),
          snapshot: (active: RunCheckpoint) => createRunTerminalSnapshot(
            failedCheckpoint(active)
          )
        },
        {
          name: 'completion',
          next: (active: RunCheckpoint) => completedCheckpoint(active, 'short'),
          snapshot: (active: RunCheckpoint) => createRunTerminalSnapshot(
            completedCheckpoint(active, 'x'.repeat(80))
          )
        },
        {
          name: 'error',
          next: (active: RunCheckpoint) => failedCheckpoint(active),
          snapshot: (active: RunCheckpoint) => createRunTerminalSnapshot(
            failedCheckpoint(active, 'provider_protocol_error')
          )
        },
        {
          name: 'cancellation',
          next: (active: RunCheckpoint) => cancelledCheckpoint(active),
          snapshot: (active: RunCheckpoint) => createRunTerminalSnapshot(
            cancelledCheckpoint(active, 'deadline_exceeded')
          )
        },
        {
          name: 'counters',
          next: (active: RunCheckpoint) => cancelledCheckpoint(active),
          snapshot: (active: RunCheckpoint) => withCounterMismatch(
            createRunTerminalSnapshot(cancelledCheckpoint(active))
          )
        }
      ] as const

      for (const mismatch of cases) {
        const harness = await adapter.create()
        const active = await activeCheckpoint(
          harness,
          `${adapter.name}-snapshot-mismatch-${mismatch.name}`
        )
        const next = mismatch.next(active)
        await assert.rejects(
          harness.store.commitTerminal(active, next, mismatch.snapshot(active)),
          TypeError,
          mismatch.name
        )
        assert.deepEqual(await harness.store.load(active.runId), active)
        assert.equal(await harness.store.loadTombstone(active.runId), null)
      }
    })

    test('rejects terminal checkpoints that retain a dispatch or engine reservation', async () => {
      for (const field of ['providerDispatch', 'engineActivity'] as const) {
        const harness = await adapter.create()
        const active = await activeCheckpoint(
          harness,
          `${adapter.name}-reserved-terminal-${field}`
        )
        const canonical = cancelledCheckpoint(active)
        const reserved = Object.freeze({
          ...canonical,
          [field]: Object.freeze({ state: 'reserved' as const })
        }) as RunCheckpoint
        await assert.rejects(
          harness.store.commitTerminal(
            active,
            reserved,
            createRunTerminalSnapshot(canonical)
          ),
          TypeError
        )
        assert.deepEqual(await harness.store.load(active.runId), active)
      }
    })

    test('dual-reads a legacy tombstone only through the normalized public shape', async () => {
      const harness = await adapter.create()
      const runId = `${adapter.name}-legacy-tombstone`
      await harness.seedRawTombstone(runId, legacyTombstone(runId))

      const loaded = await harness.store.loadTombstone(runId)
      assert.deepEqual(loaded, {
        schemaVersion: 1,
        sourceSchemaVersion: 1,
        observationId: 'unavailable',
        runRef: 'unavailable',
        revision: 9,
        status: 'cancelled',
        finishedAt,
        completion: 'unavailable',
        errorCode: null,
        cancellationReason: 'user_cancelled',
        counters: {
          schemaVersion: 1,
          providerAttempts: 'unavailable',
          modelTurns: 'unavailable',
          toolAttempts: 'unavailable',
          providerRetries: 2,
          recoveryAttempts: 3,
          correctionTurns: 4,
          toolCalls: 'unavailable',
          approvalRequests: 'unavailable',
          toolDenied: 'unavailable',
          toolExpired: 'unavailable',
          toolIndeterminate: 'unavailable',
          estimatedTokens: 'unavailable',
          providerInputTokens: 'unavailable',
          providerOutputTokens: 'unavailable',
          providerTotalTokens: 'unavailable',
          providerActiveDurationMs: 'unavailable',
          engineActiveDurationMs: 'unavailable'
        },
        engineDurationMs: 'unavailable'
      })
      const publicValue = JSON.stringify(loaded)
      assert.doesNotMatch(publicValue, /legacy-session-private-value/)
      assert.doesNotMatch(publicValue, new RegExp(runId))
      assert.equal(publicValue.includes('visibleOutput'), false)
    })
  })
}
