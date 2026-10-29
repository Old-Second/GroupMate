import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { ACTIVITY_LIMITS, ActivityStore, type ActivityData } from '../runtime/activities/ActivityStore.js'
import { ActivityWorker } from '../runtime/activities/ActivityWorker.js'

/**
 * Paired resource gate for the P11A activity scheduler in its enabled state.
 *
 * `07-resources-options.md:51` sets one cumulative candidate threshold —
 * retained <= 16 MiB, peak <= 24 MiB — for the whole set of new paths that are
 * actually switched on. Every Phase 11 direction has to re-measure this
 * baseline before it may claim headroom, so the harness lives in the
 * repository instead of in an operator script.
 *
 * Four scenarios x five repetitions x two arms = 20 pairs in 40 fresh
 * processes. The baseline arm imports the same modules and stops there; the
 * candidate arm builds the store and worker and ticks them. Each candidate
 * also runs the workload twice: the first pass carries V8's compile and
 * inline-cache cost for the dispatch path, the second measures what the
 * enabled scheduler actually retains once warm. Reporting only the cold pass
 * charges one-time warmup to steady-state retention.
 *
 * Fake Redis, fake dispatch lease, no host, no provider and no QQ. This is a
 * component measurement of one path, not whole-process resource use.
 *
 * A fifth measurement runs on its own: five more fresh processes drive one
 * worker over a store whose bytes are reset to the same record before every
 * tick, so dispatch count is the only variable and the live-heap difference
 * between two dispatch counts is per-dispatch retention. The cross-scenario
 * regression this replaces mixed in each scenario's own prune and mutation
 * work, which is why it still read about 9 KB per dispatch after the retention
 * it was supposed to detect had been removed.
 */

const scenarios = ['future_only', 'active', 'saturated', 'terminal_churn'] as const
const arms = ['baseline', 'candidate'] as const
type Scenario = typeof scenarios[number]
type Arm = typeof arms[number]

export const PHASE_11A_RESOURCE_LIMITS = Object.freeze({
  pairs: 20,
  repetitions: 5,
  ticks: 30,
  records: ACTIVITY_LIMITS.records,
  wireBytes: ACTIVITY_LIMITS.bytes,
  cumulativeRetainedBytes: 16 * 1_024 * 1_024,
  cumulativePeakBytes: 24 * 1_024 * 1_024,
  /**
   * Live-heap growth charged to each dispatch. RSS is the wrong instrument for
   * this: the operating system reclaims the pages, so an RSS-only gate cannot
   * see a path that keeps a little JS heap per dispatch forever. A bounded
   * dispatch reads a record, renders one notification and commits state, so its
   * steady-state retention is nothing; 1 KiB leaves room for bookkeeping.
   *
   * Measured against the dedicated retention run, not the cross-scenario
   * regression: the composite-signal retention this threshold was written for
   * read 2567 B (Node 24) / 2253 B (Node 22) per dispatch before the fix and
   * 338 B / 64 B after, and its total stops growing with the batch size.
   */
  heapPerDispatchBytes: 1_024,
  retentionRepetitions: 5,
  retentionWarmupDispatches: 50,
  retentionBatchDispatches: 500,
  tickMs: 50
})

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

/** libuv reports `maxRSS` in KiB on every supported platform, including darwin. */
const processPeakBytes = (): number => process.resourceUsage().maxRSS * 1_024

/** Least-squares slope, used to charge live-heap growth to the dispatch count. */
function slope (xs: readonly number[], ys: readonly number[]): number {
  const meanX = xs.reduce((total, x) => total + x, 0) / xs.length
  const meanY = ys.reduce((total, y) => total + y, 0) / ys.length
  const covariance = xs.reduce((total, x, index) => total + (x - meanX) * (ys[index] - meanY), 0)
  const variance = xs.reduce((total, x) => total + (x - meanX) ** 2, 0)
  return variance === 0 ? 0 : covariance / variance
}

/** Same shape and wire budget as the 2026-10-12 P11A fixture, so the numbers stay comparable. */
function fixture (scenario: Scenario, time: number): string {
  const records = Array.from({ length: PHASE_11A_RESOURCE_LIMITS.records }, (_, i) => ({
    schemaVersion: 1 as const, id: i.toString(16).padStart(16, '0'),
    kind: (i < 32 ? 'poll' : 'reminder') as 'poll' | 'reminder',
    botId: '10000', groupId: String(90_000 + Math.floor(i / 8)), ownerId: '7',
    requestKey: createHash('sha256').update(String(i)).digest('hex'),
    createdAt: time, updatedAt: time, dueAt: time + 1_000_000,
    state: 'pending' as string, token: '', leaseUntil: 0, content: '界'.repeat(5),
    timeZone: 'Asia/Shanghai', intervalMs: 0, remaining: 1,
    options: i < 32 ? ['甲', '乙'] : [], multiple: false, votes: {} as Record<string, number[]>
  }))
  if (scenario === 'active') for (const r of records.slice(0, 8)) r.dueAt = time - 1_000
  if (scenario === 'saturated') for (const r of records) r.dueAt = time - 1_000
  if (scenario === 'terminal_churn') {
    // Half the table is already terminal and past retention, so every tick also prunes.
    records.forEach((r, i) => {
      if (i < 8) r.dueAt = time - 1_000
      else if (i % 2 === 0) {
        r.state = i % 4 === 0 ? 'completed' : 'cancelled'
        r.remaining = 0
        r.updatedAt = time - ACTIVITY_LIMITS.retentionMs - 1_000
      }
    })
  }
  let raw = ''
  for (let voters = 100; voters >= 0; voters--) {
    const votes = Object.fromEntries(Array.from({ length: voters }, (_, voter) =>
      [createHash('sha256').update(String(voter)).digest('hex'), [1]]))
    for (const r of records.slice(0, 32)) r.votes = votes
    raw = JSON.stringify({ schemaVersion: 1, records })
    if (Buffer.byteLength(raw) <= PHASE_11A_RESOURCE_LIMITS.wireBytes) break
  }
  return raw
}

interface PassResult {
  dispatches: number
  tickMs: number
  records: number
  rss: number
  heap: number
  peak: number
}

/**
 * A WeakRef keeps its target alive until the turn that created it ends, so a
 * `gc()` called in the same turn as the last dispatch reports composite signals
 * and timers as retained whether or not anything still holds them. Yield first,
 * then collect.
 */
async function settle (gc?: () => void): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    gc?.()
  }
}

/** One record, always pending, always due: the smallest shape that dispatches on every tick. */
function retentionFixture (time: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    records: [{
      schemaVersion: 1, id: 'a'.repeat(16), kind: 'reminder', botId: '10000', groupId: '90001', ownerId: '7',
      requestKey: createHash('sha256').update('retention').digest('hex'),
      createdAt: time - 10_000, updatedAt: time - 10_000, dueAt: time - 1_000,
      state: 'pending', token: '', leaseUntil: 0, content: '提醒内容', timeZone: 'Asia/Shanghai',
      intervalMs: 0, remaining: 1, options: [], multiple: false, votes: {}
    }]
  })
}

/**
 * Per-dispatch live-heap retention, isolated from everything else a tick does.
 *
 * The store's bytes are reset to the same record before every tick, so the
 * table neither grows nor prunes and dispatch count is the only thing that
 * changes between the two readings. Warm-up absorbs V8's compile and
 * inline-cache cost. Anything the difference still shows is held by the
 * dispatch path itself.
 */
async function retentionSample (sampleId: string): Promise<unknown> {
  const gc = (globalThis as { gc?: () => void }).gc
  const limits = PHASE_11A_RESOURCE_LIMITS
  const time = 1_700_000_000_000
  const base = retentionFixture(time)
  let raw = base
  const store = new ActivityStore({
    get: async () => raw,
    eval: async (_script: string, input: { keys: string[]; arguments: string[] }) => {
      if (input.arguments[0] !== raw) return 0
      raw = input.arguments[1]
      return 1
    }
  })
  let dispatches = 0
  const worker = new ActivityWorker({
    store,
    now: () => time,
    acquire: async () => ({
      authorize: async () => 'allowed',
      deliver: async () => { dispatches++; return 'sent' },
      release: async () => undefined
    })
  })
  const drive = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index++) { raw = base; await worker.tick() }
  }
  await drive(limits.retentionWarmupDispatches)
  await settle(gc)
  const warmDispatches = dispatches
  const heapBefore = process.memoryUsage().heapUsed
  await drive(limits.retentionBatchDispatches)
  await settle(gc)
  const heapAfter = process.memoryUsage().heapUsed
  const batchDispatches = dispatches - warmDispatches
  await worker.close()
  return { sampleId, node: process.version, platform: process.platform, architecture: process.arch,
    gcAvailable: typeof gc === 'function', records: 1,
    warmupDispatches: warmDispatches, batchDispatches, heapBefore, heapAfter,
    bytesPerDispatch: Math.round((heapAfter - heapBefore) / batchDispatches) }
}

/**
 * One full enabled-state workload: fake Redis CAS, fake lease, bounded ticks.
 * The snapshot is taken while the store and worker are still reachable, so the
 * reading is the footprint of a live scheduler rather than of a released one.
 */
async function pass (initial: string, gc?: () => void): Promise<PassResult> {
  let raw = initial
  const store = new ActivityStore({
    get: async () => raw,
    eval: async (_script: string, input: { keys: string[]; arguments: string[] }) => {
      if (input.arguments[0] !== raw) return 0
      raw = input.arguments[1]
      return 1
    }
  })
  let dispatches = 0
  const worker = new ActivityWorker({
    store,
    acquire: async () => ({
      authorize: async () => 'allowed',
      deliver: async () => { dispatches++; return 'sent' },
      release: async () => undefined
    })
  })
  const start = performance.now()
  for (let tick = 0; tick < PHASE_11A_RESOURCE_LIMITS.ticks; tick++) await worker.tick()
  const tickMs = (performance.now() - start) / PHASE_11A_RESOURCE_LIMITS.ticks
  const data: ActivityData = await store.read()
  gc?.()
  const usage = process.memoryUsage()
  const result = { dispatches, tickMs, records: data.records.length,
    rss: usage.rss, heap: usage.heapUsed, peak: processPeakBytes() }
  await worker.close()
  return result
}

async function sample (scenario: Scenario, arm: Arm, sampleId: string, fixturePath: string): Promise<unknown> {
  const gc = (globalThis as { gc?: () => void }).gc
  const gcAvailable = typeof gc === 'function'
  // The driver builds the fixture and both arms only read it. Building it here
  // would raise this process's RSS high-water before the snapshot and report
  // apparatus cost as scheduler cost.
  const raw = readFileSync(fixturePath, 'utf8')
  gc?.()
  const importedRss = process.memoryUsage().rss
  const importedHeap = process.memoryUsage().heapUsed
  const importedPeak = processPeakBytes()
  const common = { sampleId, scenario, arm, node: process.version, platform: process.platform,
    architecture: process.arch, gcAvailable, importedRss, importedHeap, importedPeak }
  if (arm === 'baseline') {
    // The not-enabled arm holds the same fixture and module graph and nothing else.
    gc?.()
    return { ...common, rss: process.memoryUsage().rss, peak: processPeakBytes(),
      bytes: Buffer.byteLength(raw), records: PHASE_11A_RESOURCE_LIMITS.records, dispatches: 0, tickMs: 0,
      coldRetainedDelta: 0, coldPeakDelta: 0, coldHeapDelta: 0,
      warmRetainedDelta: 0, warmPeakDelta: 0, warmHeapDelta: 0,
      steadyRetainedDelta: 0, steadyPeakDelta: 0, steadyHeapDelta: 0 }
  }
  // Three identical workloads, all measured against the same not-enabled baseline.
  // The first carries V8's compile and inline-cache cost for the dispatch path;
  // warm minus cold and steady minus warm show what a repeat workload adds.
  const cold = await pass(raw, gc)
  const warm = await pass(raw, gc)
  const steady = await pass(raw, gc)
  return { ...common, rss: cold.rss, peak: cold.peak,
    bytes: Buffer.byteLength(raw), records: cold.records, dispatches: cold.dispatches,
    tickMs: Math.max(cold.tickMs, warm.tickMs, steady.tickMs),
    coldRetainedDelta: Math.max(0, cold.rss - importedRss),
    coldPeakDelta: Math.max(0, cold.peak - importedPeak),
    coldHeapDelta: Math.max(0, cold.heap - importedHeap),
    warmRetainedDelta: Math.max(0, warm.rss - importedRss),
    warmPeakDelta: Math.max(0, warm.peak - importedPeak),
    warmHeapDelta: Math.max(0, warm.heap - importedHeap),
    steadyRetainedDelta: Math.max(0, steady.rss - importedRss),
    steadyPeakDelta: Math.max(0, steady.peak - importedPeak),
    steadyHeapDelta: Math.max(0, steady.heap - importedHeap) }
}

type Sample = Record<string, number | string | boolean>
const metrics = ['pairRetainedDelta', 'pairPeakDelta', 'coldRetainedDelta', 'coldPeakDelta',
  'coldHeapDelta', 'warmRetainedDelta', 'warmPeakDelta', 'warmHeapDelta',
  'steadyRetainedDelta', 'steadyPeakDelta', 'steadyHeapDelta', 'tickMs'] as const

function expectedDispatches (scenario: Scenario, dispatches: number): boolean {
  if (scenario === 'future_only') return dispatches === 0
  // One dispatch per tick at most, so a fully due table is bounded by the tick count.
  if (scenario === 'saturated') return dispatches === PHASE_11A_RESOURCE_LIMITS.ticks
  return dispatches === 8
}

/** The churn fixture plants 60 terminal records past the retention window, and every tick prunes them. */
function expectedRecords (scenario: Scenario): number {
  return scenario === 'terminal_churn' ? 68 : PHASE_11A_RESOURCE_LIMITS.records
}

export async function main (): Promise<void> {
  const self = fileURLToPath(import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), `phase-11a-resources-${randomBytes(6).toString('hex')}-`))
  const run = (scenario: Scenario, arm: Arm, repetition: number, fixturePath: string): Sample => JSON.parse(execFileSync(
    process.execPath,
    ['--expose-gc', self, '--sample', scenario, arm, `${scenario}-${arm}-${repetition}`, fixturePath],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 65_536 }
  ))
  const pairs: Array<{ baseline: Sample; candidate: Sample }> = []
  const rows: Array<Record<string, number | string>> = []
  try {
    for (const scenario of scenarios) {
      const fixturePath = join(directory, `${scenario}.json`)
      writeFileSync(fixturePath, fixture(scenario, Date.now()), { mode: 0o600 })
      for (let repetition = 1; repetition <= PHASE_11A_RESOURCE_LIMITS.repetitions; repetition++) {
        const baseline = run(scenario, 'baseline', repetition, fixturePath)
        const candidate = run(scenario, 'candidate', repetition, fixturePath)
        pairs.push({ baseline, candidate })
        rows.push({ scenario, repetition, node: String(candidate.node),
          bytes: Number(candidate.bytes), records: Number(candidate.records),
          dispatches: Number(candidate.dispatches), tickMs: Number(candidate.tickMs),
          baselineRss: Number(baseline.rss), candidateRss: Number(candidate.rss),
          pairRetainedDelta: Number(candidate.rss) - Number(baseline.rss),
          pairPeakDelta: Number(candidate.peak) - Number(baseline.peak),
          coldRetainedDelta: Number(candidate.coldRetainedDelta),
          coldPeakDelta: Number(candidate.coldPeakDelta),
          coldHeapDelta: Number(candidate.coldHeapDelta),
          warmRetainedDelta: Number(candidate.warmRetainedDelta),
          warmPeakDelta: Number(candidate.warmPeakDelta),
          warmHeapDelta: Number(candidate.warmHeapDelta),
          steadyRetainedDelta: Number(candidate.steadyRetainedDelta),
          steadyPeakDelta: Number(candidate.steadyPeakDelta),
          steadyHeapDelta: Number(candidate.steadyHeapDelta) })
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const retention: Sample[] = []
  for (let repetition = 1; repetition <= PHASE_11A_RESOURCE_LIMITS.retentionRepetitions; repetition++) {
    retention.push(JSON.parse(execFileSync(
      process.execPath,
      ['--expose-gc', self, '--retention', `retention-${repetition}`],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536 }
    )))
  }
  const values = (key: string): number[] => rows.map(row => Number(row[key]))
  const range = (key: typeof metrics[number]): Record<string, number> => ({
    min: Math.min(...values(key)), max: Math.max(...values(key)),
    p50: percentile(values(key), 0.5), p95: percentile(values(key), 0.95)
  })
  const limits = PHASE_11A_RESOURCE_LIMITS
  const retentionBytes = retention.map(row => Number(row.bytesPerDispatch))
  const heapPerDispatchBytes = Math.max(...retentionBytes)
  /**
   * Kept as a diagnostic only. Regressing one cold reading per scenario on that
   * scenario's dispatch count also absorbs how much each fixture prunes and
   * rewrites, so it read 10026 B per dispatch with the composite-signal
   * retention present and 9082 B with it removed. A number that barely moves
   * when the defect it is aimed at disappears cannot gate anything.
   */
  const crossScenarioHeapSlopeBytes = slope(values('dispatches'), values('coldHeapDelta'))
  const identifiers = new Set(pairs.flatMap(pair => [String(pair.baseline.sampleId), String(pair.candidate.sampleId)]))
  /**
   * One named entry per criterion, so a red gate says which criterion is red.
   * A single boolean made the per-dispatch retention defect and the RSS budget
   * overruns indistinguishable, and they have different causes and owners.
   */
  const checks: Record<string, boolean> = {
    pairCount: rows.length === limits.pairs && identifiers.size === 2 * limits.pairs,
    gcAvailable: pairs.every(pair => pair.baseline.gcAvailable === true && pair.candidate.gcAvailable === true) &&
      retention.every(row => row.gcAvailable === true),
    retentionRuns: retention.length === limits.retentionRepetitions &&
      new Set(retention.map(row => String(row.sampleId))).size === limits.retentionRepetitions &&
      retention.every(row => Number(row.batchDispatches) === limits.retentionBatchDispatches &&
        Number(row.warmupDispatches) === limits.retentionWarmupDispatches),
    heapPerDispatch: heapPerDispatchBytes <= limits.heapPerDispatchBytes,
    recordsAndWire: rows.every(row => row.records === expectedRecords(row.scenario as Scenario) &&
      Number(row.bytes) <= limits.wireBytes),
    dispatchCounts: rows.every(row => expectedDispatches(row.scenario as Scenario, Number(row.dispatches))),
    tickLatency: rows.every(row => Number(row.tickMs) <= limits.tickMs),
    coldRetainedRss: rows.every(row => Number(row.coldRetainedDelta) <= limits.cumulativeRetainedBytes),
    coldPeakRss: rows.every(row => Number(row.coldPeakDelta) <= limits.cumulativePeakBytes),
    steadyRetainedRss: rows.every(row => Number(row.steadyRetainedDelta) <= limits.cumulativeRetainedBytes),
    steadyPeakRss: rows.every(row => Number(row.steadyPeakDelta) <= limits.cumulativePeakBytes),
    pairedRetainedRss: rows.every(row => Number(row.pairRetainedDelta) <= limits.cumulativeRetainedBytes),
    pairedPeakRss: rows.every(row => Number(row.pairPeakDelta) <= limits.cumulativePeakBytes)
  }
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  const passed = failures.length === 0
  const headroom = {
    coldRetainedBytes: limits.cumulativeRetainedBytes - Math.max(...values('coldRetainedDelta')),
    coldPeakBytes: limits.cumulativePeakBytes - Math.max(...values('coldPeakDelta')),
    steadyRetainedBytes: limits.cumulativeRetainedBytes - Math.max(...values('steadyRetainedDelta')),
    steadyPeakBytes: limits.cumulativePeakBytes - Math.max(...values('steadyPeakDelta')),
    pairedRetainedBytes: limits.cumulativeRetainedBytes - Math.max(...values('pairRetainedDelta')),
    pairedPeakBytes: limits.cumulativePeakBytes - Math.max(...values('pairPeakDelta'))
  }
  /** Shows the conclusion is not threshold shopping: the first number is the smallest limit every sample clears. */
  const sensitivity = {
    retainedPassAtOrAbove: Math.max(...values('coldRetainedDelta'), ...values('steadyRetainedDelta'), ...values('pairRetainedDelta')),
    retainedAllFailBelow: Math.min(...values('coldRetainedDelta'), ...values('steadyRetainedDelta'), ...values('pairRetainedDelta')),
    peakPassAtOrAbove: Math.max(...values('coldPeakDelta'), ...values('steadyPeakDelta'), ...values('pairPeakDelta')),
    peakAllFailBelow: Math.min(...values('coldPeakDelta'), ...values('steadyPeakDelta'), ...values('pairPeakDelta')),
    heapPerDispatchPassAtOrAbove: heapPerDispatchBytes,
    heapPerDispatchAllFailBelow: Math.min(...retentionBytes)
  }
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 }).trim()
  } catch {
    // 提交号只是给记录贴标签，取不到就留 unknown，不要让它影响测量结果。
  }
  process.stdout.write(JSON.stringify({ passed, failures, checks, pairs: rows.length,
    freshProcesses: 2 * rows.length + retention.length,
    method: 'four_scenarios_five_pairs_baseline_candidate_plus_five_dispatch_retention_runs_fake_redis_no_host_provider_qq',
    commit, node: process.version, platform: process.platform, architecture: process.arch,
    limits, headroom, sensitivity, heapPerDispatchBytes, crossScenarioHeapSlopeBytes,
    heapPerDispatchRetention: { min: Math.min(...retentionBytes), max: heapPerDispatchBytes,
      p50: percentile(retentionBytes, 0.5), p95: percentile(retentionBytes, 0.95) },
    ...Object.fromEntries(metrics.map(key => [key, range(key)])), rows, retention }, null, 2) + '\n')
  if (!passed) process.exitCode = 1
}

if (process.argv[2] === '--sample') {
  const scenario = process.argv[3] as Scenario
  const arm = process.argv[4] as Arm
  if (!scenarios.includes(scenario) || !arms.includes(arm)) throw new TypeError('resource scenario invalid')
  process.stdout.write(JSON.stringify(await sample(scenario, arm, process.argv[5], process.argv[6])) + '\n')
} else if (process.argv[2] === '--retention') {
  process.stdout.write(JSON.stringify(await retentionSample(process.argv[3])) + '\n')
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
