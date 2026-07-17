import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import { RunAdmission } from '../../src/agent/run/run-admission.js'
import { createFrozenObservationPolicy } from '../../src/agent/run/run-observation.js'
import { RedisRunStore } from '../../src/agent/run/redis-run-store.js'
import {
  TRACE_KEY_PREFIX,
  TRACE_STORE_LUA_MARKER
} from '../../src/runtime/observability/redis-trace-store.js'
import {
  ProductionObservabilityRuntime
} from '../../src/runtime/production-yunzai-agent.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import {
  traceCandidateFixture,
  traceRunRef
} from '../helpers/trace-fixture.js'

const NOW = Date.parse('2026-07-16T00:00:00.000Z')

function runtime (redis: FakeRedis, logs: unknown[] = []) {
  return new ProductionObservabilityRuntime({
    redis,
    runStore: new RedisRunStore({ client: redis }),
    admission: new RunAdmission({ client: redis, generateId: () => 'lease-id' }),
    logger: Object.freeze({
      info: (entry: Readonly<Record<string, unknown>>) => logs.push(entry),
      error: (entry: Readonly<Record<string, unknown>>) => logs.push(entry)
    }),
    initialLevel: 'basic',
    now: () => new Date(NOW)
  })
}

test('production observability has exactly three sinks and direct candidate handoff is gated', async () => {
  const redis = new FakeRedis(() => NOW)
  const root = runtime(redis)
  assert.deepEqual(root.hub.snapshot().sinks.map(sink => sink.name), [
    'metrics', 'trace', 'log'
  ])
  const candidate = traceCandidateFixture({ status: 'failed' })
  root.acceptCommittedTraceCandidate(candidate)
  assert.equal(root.traceRecorder.snapshot().committedCandidateWait, 0)
  root.registerPolicy(candidate.runRef, candidate.policy)
  root.acceptCommittedTraceCandidate(candidate)
  assert.equal(root.traceRecorder.snapshot().committedCandidateWait, 1)
  root.publish(Object.freeze({
    schemaVersion: 1,
    type: 'terminal_snapshot',
    value: candidate.terminal
  }))
  await root.hub.drain()
  assert.equal((await root.traceStore.usage()).records, 1)
})

class DeferredBarrierRedis extends FakeRedis {
  advanceCalls = 0
  #resolve?: (value: unknown) => void

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (script.startsWith(TRACE_STORE_LUA_MARKER) &&
      options.arguments[0] === 'advance_clear') {
      this.advanceCalls += 1
      return await new Promise(resolve => { this.#resolve = resolve })
    }
    return await super.eval(script, options)
  }

  finish (): void {
    this.#resolve?.([1, 0, 0, 0, 0])
  }
}

class RejectOnceBarrierRedis extends FakeRedis {
  advanceCalls = 0

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (script.startsWith(TRACE_STORE_LUA_MARKER) &&
      options.arguments[0] === 'advance_clear') {
      this.advanceCalls += 1
      if (this.advanceCalls === 1) throw new Error('private Redis failure')
    }
    return await super.eval(script, options)
  }
}

class RejectSecondBatchOnceRedis extends FakeRedis {
  advanceCalls = 0
  clearCalls = 0

  override async eval (script: string, options: {
    keys: string[]
    arguments: string[]
  }): Promise<unknown> {
    if (script.startsWith(TRACE_STORE_LUA_MARKER)) {
      if (options.arguments[0] === 'advance_clear') this.advanceCalls += 1
      if (options.arguments[0] === 'clear') {
        this.clearCalls += 1
        if (this.clearCalls === 1) throw new Error('private second batch failure')
      }
    }
    return await super.eval(script, options)
  }
}

test('off is synchronous while the bounded acknowledgement reuses one bottom barrier', async () => {
  const redis = new DeferredBarrierRedis(() => NOW)
  const root = runtime(redis)
  const candidate = traceCandidateFixture()
  root.registerPolicy(candidate.runRef, candidate.policy)
  root.acceptCommittedTraceCandidate(candidate)
  assert.equal(root.traceRecorder.snapshot().committedCandidateWait, 1)

  const first = root.updateLevel('off')
  assert.equal(root.gate.snapshot().currentLevel, 'off')
  assert.equal(root.traceRecorder.snapshot().committedCandidateWait, 0)
  assert.deepEqual(await first, { kind: 'barrier_pending' })
  assert.deepEqual(await root.updateLevel('off'), { kind: 'barrier_pending' })
  assert.equal(redis.advanceCalls, 1)

  redis.finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await root.updateLevel('basic'), { kind: 'applied' })
  assert.equal(root.gate.snapshot().currentLevel, 'basic')
})

test('a failed off barrier blocks re-enable and a later off save retries once', async () => {
  const redis = new RejectOnceBarrierRedis(() => NOW)
  const root = runtime(redis)
  assert.deepEqual(await root.updateLevel('off'), { kind: 'barrier_failed' })
  assert.deepEqual(await root.updateLevel('diagnostic'), { kind: 'barrier_failed' })
  assert.equal(root.gate.snapshot().currentLevel, 'off')
  assert.deepEqual(await root.updateLevel('off'), { kind: 'applied' })
  assert.equal(redis.advanceCalls, 2)
  assert.deepEqual(await root.updateLevel('diagnostic'), { kind: 'applied' })
})

test('a failed later clear batch keeps off active until a retry empties the namespace', async () => {
  const redis = new RejectSecondBatchOnceRedis(() => NOW)
  const candidate = traceCandidateFixture({ runRef: traceRunRef(true, 315_000) })
  const expiresAtMs = Date.parse(candidate.expiresAt)
  for (let index = 0; index < 130; index += 1) {
    redis.seedTraceForTest({
      key: `${TRACE_KEY_PREFIX}f${index.toString(16).padStart(31, '0')}`,
      value: '{}',
      expiresAtMs: expiresAtMs + index,
      index: 'success',
      logicalBytes: 128
    })
  }
  const root = runtime(redis)

  assert.deepEqual(await root.updateLevel('off'), { kind: 'barrier_failed' })
  assert.equal((await root.traceStore.usage()).records, 66)
  assert.deepEqual(await root.updateLevel('diagnostic'), { kind: 'barrier_failed' })
  assert.deepEqual(await root.updateLevel('off'), { kind: 'applied' })
  assert.equal((await root.traceStore.usage()).records, 0)
  assert.equal(redis.advanceCalls, 2)
  assert.equal(redis.clearCalls, 2)
})

test('progress publishes one redacted fact with full run correlation per delivery', async () => {
  const observations: unknown[] = []
  const attachments: string[] = []
  const runRef = traceRunRef(false, 320_000)
  const presenter = new RunProgressPresenter({
    onAttachment: metadata => attachments.push(metadata.runRef),
    publishObservation: event => observations.push(event),
    monotonicNow: (() => {
      let value = 10
      return () => value++
    })()
  })
  presenter.attach({
    runId: 'run-id',
    runRef,
    requestKind: 'ordinary_chat',
    observationPolicy: createFrozenObservationPolicy({ levelAtStart: 'basic', runRef }),
    resume: Object.freeze({ attempts: 0, seenStages: Object.freeze([]) }),
    indicator: null,
    outbound: Object.freeze({
      target: Object.freeze({
        botId: 'bot-id',
        scope: Object.freeze({ kind: 'group' as const, groupId: 'group-id' })
      }),
      deliver: async () => Object.freeze({
        kind: 'sent' as const,
        media: 'text' as const,
        attempt: 1 as const,
        receipt: Object.freeze({ schemaVersion: 1, media: 'text' })
      }) as never,
      recall: async () => Object.freeze({
        kind: 'failed_definite' as const,
        code: 'message_id_unavailable' as const
      })
    })
  })
  assert.deepEqual(attachments, [runRef])
  presenter.handle(createRunEvent({
    eventId: 'event-id',
    runId: 'run-id',
    sessionId: 'session-id',
    sequence: 1,
    occurredAt: new Date(NOW).toISOString(),
    type: 'tool.started',
    payload: Object.freeze({
      callId: 'private-progress-call',
      toolName: 'website',
      occurrenceId: '3:0'
    })
  }))
  await presenter.drain('run-id')
  assert.equal(observations.length, 1)
  const encoded = JSON.stringify(observations[0])
  assert.match(encoded, new RegExp(runRef))
  assert.match(encoded, /"terminalObservationId":"not_attempted"/)
  assert.doesNotMatch(encoded, /正在读取网页|private-progress-call|website|3:0/)
})

test('production source has no discard publisher and every terminal fact uses the gated port', async () => {
  const [entry, root, bridge] = await Promise.all([
    readFile('index.js', 'utf8'),
    readFile('src/runtime/production-yunzai-agent.ts', 'utf8'),
    readFile('src/runtime/agent-service-bridge.ts', 'utf8')
  ])
  const source = `${entry}\n${root}`
  assert.doesNotMatch(source, /createPlan2DiscardingRequestObservationPublisher/)
  assert.match(root, /subscribers: Object\.freeze\(\[this\.metrics, this\.traceRecorder, logSubscriber\]\)/)
  assert.match(bridge, /type: 'terminal_snapshot'/)
  assert.match(bridge, /type: 'terminal_commit'/)
  assert.match(root, /if \(!this\.gate\.allow\(event\)\) return/)
})
