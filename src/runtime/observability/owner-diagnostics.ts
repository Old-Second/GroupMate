import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js'
import type { ObservabilityLevel } from './trace-policy.js'
import type { MetricsSnapshotV1 } from './metrics-registry.js'
import { replayTrace, type TraceReplayReportV1 } from './trace-replay.js'
import type { TraceLookupResult, TraceSummaryV1 } from './trace-store.js'

const STATUS_MAXIMUM_CODE_POINTS = 2_000
const INSPECT_MAXIMUM_CODE_POINTS = 4_000
const RECENT_TRACE_LIMIT = 5
const INSPECT_EVENT_LIMIT = 20

export type OwnerDiagnosticResponseKind =
  | 'status'
  | 'found'
  | 'not_retained'
  | 'expired'
  | 'unavailable'
  | 'corrupt'
  | 'invalid_run_ref'
  | 'forbidden'

export interface OwnerDiagnosticResponse {
  readonly schemaVersion: 1
  readonly kind: OwnerDiagnosticResponseKind
  readonly text: string
}

interface OwnerMetricsPort {
  snapshot(): Promise<MetricsSnapshotV1>
}

interface OwnerTraceStorePort {
  load(runRef: string): Promise<TraceLookupResult>
  listRecent(limit: number): Promise<readonly TraceSummaryV1[]>
}

interface OwnerDiagnosticLogger {
  info?(event: Readonly<Record<string, unknown>>): void
}

export interface OwnerDiagnosticsOptions {
  readonly metrics: OwnerMetricsPort
  readonly traceStore: OwnerTraceStorePort
  readonly currentLevel: () => ObservabilityLevel
  readonly logger?: OwnerDiagnosticLogger
}

function boundedText (value: string, maximum: number): string {
  const codePoints = [...value]
  if (codePoints.length <= maximum) return value
  return `${codePoints.slice(0, maximum - 1).join('')}…`
}

function response (
  kind: OwnerDiagnosticResponseKind,
  text: string,
  maximum: number
): OwnerDiagnosticResponse {
  return Object.freeze({
    schemaVersion: 1,
    kind,
    text: boundedText(text, maximum)
  })
}

function levelLabel (level: ObservabilityLevel): string {
  if (level === 'off') return '关闭'
  if (level === 'diagnostic') return '诊断'
  return '基础'
}

function gauge (
  snapshot: MetricsSnapshotV1,
  name: MetricsSnapshotV1['gauges'][number]['name'],
  labelName?: string,
  labelValue?: string
): string {
  const point = snapshot.gauges.find(point => (
    point.name === name &&
    (labelName === undefined || point.labels.some(label => (
      label.name === labelName && label.value === labelValue
    )))
  ))
  return point === undefined ? '不可用' : String(point.value)
}

function recentLines (recent: readonly TraceSummaryV1[]): readonly string[] {
  if (recent.length === 0) return Object.freeze(['最近轨迹：无'])
  return Object.freeze([
    '最近轨迹：',
    ...recent.slice(0, RECENT_TRACE_LIMIT).map(item => (
      `${item.runRef} ${item.outcome}/${item.retention}`
    ))
  ])
}

function sumRows (rows: readonly { readonly count: number }[]): number {
  return rows.reduce((total, row) => total + row.count, 0)
}

function replayText (report: TraceReplayReportV1): string {
  const phases = report.phases.slice(0, INSPECT_EVENT_LIMIT)
  const phaseLines = phases.map((phase, index) => `${index + 1}. ${phase}`)
  const remaining = Math.max(0, report.phases.length - phases.length)
  if (remaining > 0) phaseLines.push(`其余 ${remaining} 个阶段未展开`)
  const presentation = report.presentation.kind === 'unavailable'
    ? '不可用'
    : `${report.presentation.selectedMode}/${report.presentation.fallbackReason}`
  return [
    'GroupMate 轨迹诊断',
    `runRef：${report.runRef}`,
    `结果：${report.outcome}`,
    `省略事件：${report.omittedEventCount}`,
    `不支持事件：${report.unsupportedEventCount}`,
    `模型请求：${sumRows(report.metricSummary.providerRequests)}`,
    `工具执行：${sumRows(report.metricSummary.toolExecutions)}`,
    `审批事件：${sumRows(report.metricSummary.approvals)}`,
    `呈现：${presentation}`,
    '阶段：',
    ...phaseLines
  ].join('\n')
}

export class OwnerDiagnostics {
  readonly #metrics: OwnerMetricsPort
  readonly #traceStore: OwnerTraceStorePort
  readonly #currentLevel: () => ObservabilityLevel
  readonly #logger?: OwnerDiagnosticLogger

  constructor (options: OwnerDiagnosticsOptions) {
    this.#metrics = options.metrics
    this.#traceStore = options.traceStore
    this.#currentLevel = options.currentLevel
    this.#logger = options.logger
  }

  async status (input: { readonly authorized: boolean }): Promise<OwnerDiagnosticResponse> {
    if (!input.authorized) return this.#finish('status', response(
      'forbidden',
      '仅机器人主人可以查看 GroupMate 状态',
      STATUS_MAXIMUM_CODE_POINTS
    ))

    let level: ObservabilityLevel
    let snapshot: MetricsSnapshotV1
    try {
      level = this.#currentLevel()
      snapshot = await this.#metrics.snapshot()
    } catch {
      return this.#finish('status', response(
        'unavailable',
        'GroupMate 状态暂不可用',
        STATUS_MAXIMUM_CODE_POINTS
      ))
    }

    let recent: readonly TraceSummaryV1[] = Object.freeze([])
    if (level !== 'off') {
      try {
        recent = (await this.#traceStore.listRecent(RECENT_TRACE_LIMIT)).slice(
          0,
          RECENT_TRACE_LIMIT
        )
      } catch {}
    }
    const traceLines = level === 'off'
      ? ['轨迹：关闭']
      : [
          `轨迹：${gauge(
            snapshot,
            'groupmate.observation.store_records',
            'kind',
            'trace'
          )} 条 / ${gauge(
            snapshot,
            'groupmate.observation.store_bytes',
            'kind',
            'trace'
          )} 字节`,
          ...recentLines(recent)
        ]
    return this.#finish('status', response('status', [
      'GroupMate 状态',
      `可观测性：${levelLabel(level)}`,
      `活动任务：${gauge(snapshot, 'groupmate.agent.admission', 'state', 'active')}`,
      `排队任务：${gauge(snapshot, 'groupmate.agent.admission', 'state', 'queued')}`,
      `RSS：${gauge(snapshot, 'groupmate.process.rss')} 字节`,
      ...traceLines
    ].join('\n'), STATUS_MAXIMUM_CODE_POINTS))
  }

  async inspect (input: {
    readonly authorized: boolean
    readonly runRef: string
  }): Promise<OwnerDiagnosticResponse> {
    if (!input.authorized) return this.#finish('inspect', response(
      'forbidden',
      '仅机器人主人可以查看 GroupMate 诊断',
      INSPECT_MAXIMUM_CODE_POINTS
    ))
    if (!RUN_REF_PATTERN.test(input.runRef)) return this.#finish('inspect', response(
      'invalid_run_ref',
      'runRef 格式无效，应为 32 位小写十六进制字符',
      INSPECT_MAXIMUM_CODE_POINTS
    ))

    let lookup: TraceLookupResult
    try {
      lookup = await this.#traceStore.load(input.runRef)
    } catch {
      lookup = Object.freeze({ kind: 'unavailable' })
    }
    if (lookup.kind !== 'found') {
      const messages: Readonly<Record<Exclude<TraceLookupResult['kind'], 'found'>, string>> = {
        not_retained: '该运行轨迹未保留',
        expired: '该运行轨迹已过期',
        unavailable: '轨迹存储暂不可用',
        corrupt: '该运行轨迹已损坏'
      }
      return this.#finish('inspect', response(
        lookup.kind,
        messages[lookup.kind],
        INSPECT_MAXIMUM_CODE_POINTS
      ))
    }

    const replay = replayTrace(lookup.record)
    if (replay.kind !== 'replayed') return this.#finish('inspect', response(
      'corrupt',
      '该运行轨迹已损坏',
      INSPECT_MAXIMUM_CODE_POINTS
    ))
    return this.#finish('inspect', response(
      'found',
      replayText(replay.report),
      INSPECT_MAXIMUM_CODE_POINTS
    ))
  }

  #finish (
    operation: 'status' | 'inspect',
    value: OwnerDiagnosticResponse
  ): OwnerDiagnosticResponse {
    try {
      this.#logger?.info?.(Object.freeze({
        event: 'groupmate.owner_diagnostics',
        operation,
        outcome: value.kind
      }))
    } catch {}
    return value
  }
}
