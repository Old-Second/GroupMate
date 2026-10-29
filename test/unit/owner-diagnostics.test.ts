import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DURATION_BUCKET_BOUNDS_MS } from '../../src/agent/run/run-observation.js'
import type {
  MetricCounterPoint,
  MetricHistogramPoint,
  MetricsSnapshotV1
} from '../../src/runtime/observability/metrics-registry.js'
import {
  OwnerDiagnostics,
  type ObservationPipelineSnapshotV1
} from '../../src/runtime/observability/owner-diagnostics.js'
import type {
  TraceLookupResult,
  TraceSummaryV1
} from '../../src/runtime/observability/trace-store.js'
import type {
  UsageAggregateSnapshotV1
} from '../../src/runtime/usage/usage-aggregator.js'
import { traceCandidateFixture, traceRunRef } from '../helpers/trace-fixture.js'

function counter (
  name: MetricCounterPoint['name'],
  labels: readonly (readonly [string, string])[],
  value: number
): MetricCounterPoint {
  return Object.freeze({
    name,
    labels: Object.freeze(labels.map(([labelName, labelValue]) => Object.freeze({
      name: labelName,
      value: labelValue
    }))),
    value
  }) as MetricCounterPoint
}

function histogram (stage: string, measured: readonly number[]): MetricHistogramPoint {
  return Object.freeze({
    name: 'groupmate.agent.duration',
    labels: Object.freeze([Object.freeze({ name: 'stage', value: stage })]),
    count: measured.length,
    sumMs: measured.reduce((total, item) => total + item, 0),
    unavailableCount: 0,
    buckets: Object.freeze(DURATION_BUCKET_BOUNDS_MS.map(bound => Object.freeze({
      upperBoundMs: bound,
      cumulativeCount: measured.filter(item => bound === 'inf' || item <= bound).length
    })))
  }) as MetricHistogramPoint
}

const metrics: MetricsSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  startedAt: '2026-07-17T00:00:00.000Z',
  windowResetCount: 2,
  counters: Object.freeze([
    counter('groupmate.agent.runs', [
      ['outcome', 'completed'], ['completion_kind', 'reply_text'], ['error_code', 'none']
    ], 12),
    counter('groupmate.agent.runs', [
      ['outcome', 'failed'], ['completion_kind', 'none'], ['error_code', 'provider_timeout']
    ], 1),
    counter('groupmate.agent.tokens', [['direction', 'input'], ['source', 'provider']], 1_200),
    counter('groupmate.agent.tokens', [['direction', 'output'], ['source', 'provider']], 340),
    counter('groupmate.agent.tokens', [['direction', 'total'], ['source', 'estimated']], 2_000),
    counter('groupmate.agent.model_price', [['status', 'available']], 15),
    counter('groupmate.agent.model_price', [['status', 'missing_or_expired']], 2)
  ]),
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
  histograms: Object.freeze([histogram('engine', [40, 900, 4_000, 90_000])])
})

const GROUP_MASK = '****1012'
const ACTOR_MASK = '****9034'

const usageTotals = Object.freeze({
  runs: 3,
  inputTokens: 1_200,
  outputTokens: 340,
  totalTokens: 1_540,
  cacheHitTokens: 600,
  cacheMissTokens: 600,
  availability: 'complete' as const,
  cost: Object.freeze({
    kind: 'exact' as const,
    currency: 'CNY' as const,
    picoYuan: '1234567890',
    catalogVersion: 'deepseek-cny-2026-10-10',
    billingAuthority: false as const
  })
})

const usageSnapshot: UsageAggregateSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  windowStartedAt: '2026-10-29T00:00:00.000Z',
  windowResetCount: 1,
  observedRuns: 3,
  rejectedRuns: 1,
  droppedGroupRuns: 2,
  droppedActorRuns: 0,
  total: usageTotals,
  days: Object.freeze([Object.freeze({ day: '2026-10-29', totals: usageTotals })]),
  groups: Object.freeze([
    Object.freeze({ day: '2026-10-29', maskedId: GROUP_MASK, totals: usageTotals })
  ]),
  actors: Object.freeze([
    Object.freeze({ day: '2026-10-29', maskedId: ACTOR_MASK, totals: usageTotals })
  ]),
  omittedGroupRows: 3,
  omittedActorRows: 0
})

const pipeline: ObservationPipelineSnapshotV1 = Object.freeze({
  hub: Object.freeze({
    schemaVersion: 1,
    normalInFlight: 1,
    normalPending: 2,
    reservedInFlight: 0,
    sinks: Object.freeze([
      Object.freeze({
        name: 'metrics' as const,
        accepted: 30,
        dropped: 1,
        failed: 2,
        quarantined: 0
      })
    ])
  }),
  recorder: Object.freeze({
    schemaVersion: 1,
    currentLevel: 'basic' as const,
    committedCandidateWait: 0 as const,
    presentationWait: 1 as const
  })
})

interface DiagnosticsHarness {
  readonly diagnostics: OwnerDiagnostics
  readonly reads: { metrics: number; load: number; recent: number; usage: number }
  readonly logs: Readonly<Record<string, unknown>>[]
}

function harness (input: {
  readonly level?: 'off' | 'basic' | 'diagnostic'
  readonly lookup?: TraceLookupResult
  readonly recent?: readonly TraceSummaryV1[]
  readonly usage?: UsageAggregateSnapshotV1 | 'absent'
  readonly pipeline?: ObservationPipelineSnapshotV1
} = {}): DiagnosticsHarness {
  const reads = { metrics: 0, load: 0, recent: 0, usage: 0 }
  const logs: Readonly<Record<string, unknown>>[] = []
  const usageSource = input.usage === 'absent' ? undefined : input.usage ?? usageSnapshot
  const pipelineSource = input.pipeline
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
      ...(usageSource === undefined ? {} : {
        usage: (): UsageAggregateSnapshotV1 => {
          reads.usage += 1
          return usageSource
        }
      }),
      ...(pipelineSource === undefined ? {} : { pipeline: () => pipelineSource }),
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
  assert.deepEqual(status.reads, { metrics: 0, load: 0, recent: 0, usage: 0 })
  assert.deepEqual(inspect.reads, { metrics: 0, load: 0, recent: 0, usage: 0 })
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
  assert.doesNotMatch(response.text, /计数窗口/)
  assert.doesNotMatch(response.text, /上报 Token/)
  assert.equal(state.reads.metrics, 1)
  assert.equal(state.reads.recent, 0)
  assert.equal(state.reads.usage, 0)
})

test('status digests the counters that previously had no reader at all', async () => {
  const state = harness()
  const response = await state.diagnostics.status({ authorized: true })

  assert.match(response.text, /计数窗口：2026-07-17T00:00:00\.000Z 起（重置 2 次）/)
  assert.match(response.text, /运行：completed 12 \/ failed 1/)
  assert.match(response.text, /上报 Token：输入 1200 \/ 输出 340/)
  assert.match(response.text, /报价：available 15 \/ missing_or_expired 2/)
  assert.match(response.text, /累计费用：参考 0\.001234 元（deepseek-cny-2026-10-10）/)
  assert.ok([...response.text].length <= 2_000)
})

test('status omits the cost digest when usage aggregation is absent', async () => {
  const state = harness({ usage: 'absent' })
  const response = await state.diagnostics.status({ authorized: true })

  assert.match(response.text, /计数窗口/)
  assert.doesNotMatch(response.text, /累计费用/)
})

test('a metrics report lists every counter histogram quantile and pipeline sink', async () => {
  const state = harness({ pipeline })
  const response = await state.diagnostics.metricsReport({ authorized: true })

  assert.equal(response.kind, 'metrics')
  assert.match(response.text, /groupmate\.agent\.tokens\{direction=total,source=estimated\} 2000/)
  assert.match(response.text, /groupmate\.agent\.model_price\{status=missing_or_expired\} 2/)
  assert.match(
    response.text,
    /groupmate\.agent\.duration\{stage=engine\} 4 次 均值 23735ms p50 ≤1000ms p95 ≤120000ms 不可用 0/
  )
  assert.match(response.text, /metrics 接受 30 丢弃 1 失败 2 隔离 0/)
  assert.match(response.text, /轨迹记录：候选等待 0 呈现等待 1/)
  assert.ok([...response.text].length <= 4_000)
})

test('an off metrics report refuses to print cleared counters', async () => {
  const state = harness({ level: 'off', pipeline })
  const response = await state.diagnostics.metricsReport({ authorized: true })

  assert.equal(response.kind, 'metrics')
  assert.match(response.text, /计数：关闭/)
  assert.doesNotMatch(response.text, /groupmate\.agent/)
})

test('a usage report carries masked identifiers overflow counts and the window', async () => {
  const state = harness()
  const response = await state.diagnostics.usageReport({ authorized: true })

  assert.equal(response.kind, 'usage')
  assert.match(response.text, /计数窗口：2026-10-29T00:00:00\.000Z 起（重置 1 次）/)
  assert.match(response.text, /累计：运行 3 输入 1200 输出 340 缓存命中 600 费用 参考 0\.001234 元/)
  assert.match(response.text, /用量完整度：完整/)
  assert.match(response.text, /已统计运行：3（拒绝 1）/)
  assert.match(response.text, new RegExp(`${GROUP_MASK.replace(/\*/g, '\\*')} 2026-10-29`))
  assert.match(response.text, new RegExp(`${ACTOR_MASK.replace(/\*/g, '\\*')} 2026-10-29`))
  assert.match(response.text, /其余 3 行未展开/)
  assert.match(response.text, /维度溢出：群 2 \/ 人 0/)
  assert.ok([...response.text].length <= 4_000)
})

test('a usage report says so when aggregation is turned off', async () => {
  const absent = await harness({ usage: 'absent' }).diagnostics.usageReport({ authorized: true })
  assert.equal(absent.kind, 'unavailable')
  assert.match(absent.text, /用量聚合未启用/)

  const off = await harness({ level: 'off' }).diagnostics.usageReport({ authorized: true })
  assert.equal(off.kind, 'usage')
  assert.match(off.text, /聚合：关闭/)
})

test('every report refuses an unauthorized caller before reading anything', async () => {
  const metricsState = harness({ pipeline })
  const usageState = harness()

  assert.equal(
    (await metricsState.diagnostics.metricsReport({ authorized: false })).kind,
    'forbidden'
  )
  assert.equal((await usageState.diagnostics.usageReport({ authorized: false })).kind, 'forbidden')
  assert.deepEqual(metricsState.reads, { metrics: 0, load: 0, recent: 0, usage: 0 })
  assert.deepEqual(usageState.reads, { metrics: 0, load: 0, recent: 0, usage: 0 })
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
  await state.diagnostics.metricsReport({ authorized: true })
  await state.diagnostics.usageReport({ authorized: true })
  await state.diagnostics.inspect({ authorized: true, runRef })

  assert.deepEqual(state.logs, [
    { event: 'groupmate.owner_diagnostics', operation: 'status', outcome: 'status' },
    { event: 'groupmate.owner_diagnostics', operation: 'metrics', outcome: 'metrics' },
    { event: 'groupmate.owner_diagnostics', operation: 'usage', outcome: 'usage' },
    { event: 'groupmate.owner_diagnostics', operation: 'inspect', outcome: 'not_retained' }
  ])
  assert.equal(JSON.stringify(state.logs).includes(runRef), false)
})
