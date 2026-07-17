import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MetricsSnapshotV1 } from '../../src/runtime/observability/metrics-registry.js'
import { OwnerDiagnostics } from '../../src/runtime/observability/owner-diagnostics.js'
import type {
  TraceLookupResult,
  TraceSummaryV1
} from '../../src/runtime/observability/trace-store.js'
import { traceCandidateFixture, traceRunRef } from '../helpers/trace-fixture.js'

const metrics: MetricsSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  startedAt: '2026-07-17T00:00:00.000Z',
  counters: Object.freeze([]),
  gauges: Object.freeze([
    Object.freeze({
      name: 'groupmate.agent.admission',
      labels: Object.freeze([Object.freeze({ name: 'state', value: 'active' })]),
      value: 2
    }),
    Object.freeze({
      name: 'groupmate.agent.admission',
      labels: Object.freeze([Object.freeze({ name: 'state', value: 'queued' })]),
      value: 1
    }),
    Object.freeze({
      name: 'groupmate.observation.store_records',
      labels: Object.freeze([Object.freeze({ name: 'kind', value: 'trace' })]),
      value: 4
    }),
    Object.freeze({
      name: 'groupmate.observation.store_bytes',
      labels: Object.freeze([Object.freeze({ name: 'kind', value: 'trace' })]),
      value: 2048
    }),
    Object.freeze({
      name: 'groupmate.process.rss',
      labels: Object.freeze([]),
      value: 64 * 1024 * 1024
    })
  ]),
  histograms: Object.freeze([])
})

interface DiagnosticsHarness {
  readonly diagnostics: OwnerDiagnostics
  readonly reads: { metrics: number; load: number; recent: number }
  readonly logs: Readonly<Record<string, unknown>>[]
}

function harness (input: {
  readonly level?: 'off' | 'basic' | 'diagnostic'
  readonly lookup?: TraceLookupResult
  readonly recent?: readonly TraceSummaryV1[]
} = {}): DiagnosticsHarness {
  const reads = { metrics: 0, load: 0, recent: 0 }
  const logs: Readonly<Record<string, unknown>>[] = []
  return {
    reads,
    logs,
    diagnostics: new OwnerDiagnostics({
      metrics: Object.freeze({
        snapshot: async () => {
          reads.metrics += 1
          return metrics
        }
      }),
      traceStore: Object.freeze({
        load: async () => {
          reads.load += 1
          return input.lookup ?? { kind: 'not_retained' }
        },
        listRecent: async () => {
          reads.recent += 1
          return input.recent ?? Object.freeze([])
        }
      }),
      currentLevel: () => input.level ?? 'basic',
      logger: Object.freeze({
        info: (entry: Readonly<Record<string, unknown>>) => { logs.push(entry) }
      })
    })
  }
}

test('authorization happens before every metrics or trace-store read', async () => {
  const status = harness()
  const inspect = harness()

  assert.equal((await status.diagnostics.status({ authorized: false })).kind, 'forbidden')
  assert.equal((await inspect.diagnostics.inspect({
    authorized: false,
    runRef: traceRunRef(false)
  })).kind, 'forbidden')
  assert.deepEqual(status.reads, { metrics: 0, load: 0, recent: 0 })
  assert.deepEqual(inspect.reads, { metrics: 0, load: 0, recent: 0 })
})

test('status is bounded and lists no more than five complete run references', async () => {
  const recent = Object.freeze(Array.from({ length: 7 }, (_, index) => Object.freeze({
    schemaVersion: 1 as const,
    runRef: traceRunRef(false, 10_000 + index * 10_000),
    outcome: 'completed' as const,
    retention: 'sampled_success' as const,
    finishedAt: '2026-07-17T00:00:00.000Z'
  })))
  const state = harness({ recent })
  const response = await state.diagnostics.status({ authorized: true })

  assert.equal(response.kind, 'status')
  assert.ok([...response.text].length <= 2_000)
  assert.equal(state.reads.metrics, 1)
  assert.equal(state.reads.recent, 1)
  for (const item of recent.slice(0, 5)) assert.match(response.text, new RegExp(item.runRef))
  for (const item of recent.slice(5)) assert.doesNotMatch(response.text, new RegExp(item.runRef))
})

test('off status does not read retained traces or report fake store totals', async () => {
  const state = harness({ level: 'off' })
  const response = await state.diagnostics.status({ authorized: true })

  assert.equal(response.kind, 'status')
  assert.match(response.text, /可观测性：关闭/)
  assert.match(response.text, /轨迹：关闭/)
  assert.equal(state.reads.metrics, 1)
  assert.equal(state.reads.recent, 0)
})

test('inspect requires an exact lower-case 32-hex run reference', async () => {
  for (const runRef of ['a'.repeat(31), 'A'.repeat(32), ` ${'a'.repeat(32)}`, `${'a'.repeat(32)} `]) {
    const state = harness()
    const response = await state.diagnostics.inspect({ authorized: true, runRef })
    assert.equal(response.kind, 'invalid_run_ref')
    assert.equal(state.reads.load, 0)
  }
})

test('inspect differentiates every lookup state and bounds a found replay', async () => {
  const runRef = traceRunRef(false)
  const expectations = [
    ['not_retained', '未保留'],
    ['expired', '已过期'],
    ['unavailable', '暂不可用'],
    ['corrupt', '已损坏']
  ] as const
  for (const [kind, message] of expectations) {
    const state = harness({ lookup: { kind } })
    const response = await state.diagnostics.inspect({ authorized: true, runRef })
    assert.equal(response.kind, kind)
    assert.match(response.text, new RegExp(message))
    assert.ok([...response.text].length <= 4_000)
  }

  const candidate = traceCandidateFixture({ runRef })
  const found = harness({ lookup: { kind: 'found', record: candidate } })
  const response = await found.diagnostics.inspect({ authorized: true, runRef })
  assert.equal(response.kind, 'found')
  assert.match(response.text, new RegExp(runRef))
  assert.match(response.text, /阶段：/)
  assert.ok([...response.text].length <= 4_000)
  assert.ok((response.text.match(/^\d+\./gm) ?? []).length <= 20)
})

test('diagnostic logs contain only fixed operation and outcome fields', async () => {
  const state = harness()
  const runRef = traceRunRef(false)
  await state.diagnostics.status({ authorized: true })
  await state.diagnostics.inspect({ authorized: true, runRef })

  assert.deepEqual(state.logs, [
    { event: 'groupmate.owner_diagnostics', operation: 'status', outcome: 'status' },
    { event: 'groupmate.owner_diagnostics', operation: 'inspect', outcome: 'not_retained' }
  ])
  assert.equal(JSON.stringify(state.logs).includes(runRef), false)
})
