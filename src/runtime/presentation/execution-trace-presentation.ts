import {
  EMPTY_PRESENTATION_TRACE,
  parsePresentationTrace,
  type PresentationTraceToolOutcomeV1,
  type PresentationTraceV1
} from '../../agent/contracts/presentation-trace.js'
import { normalizeReasoningView, type ReasoningView } from './reply-content.js'
import type { OutboundPart } from './yunzai-outbound-port.js'

export interface ExecutionTraceSettings {
  readonly forwardReasoning: boolean
  readonly forwardToolDetails: boolean
}

const OUTCOME_LABELS: Readonly<Record<PresentationTraceToolOutcomeV1, string>> = Object.freeze({
  succeeded: '成功',
  denied: '已拒绝',
  failed: '失败',
  indeterminate: '结果待确认'
})

export function selectExecutionTrace (
  trace: PresentationTraceV1,
  settings: ExecutionTraceSettings,
  fallbackReasoning: ReasoningView | undefined
): PresentationTraceV1 {
  const parsed = parsePresentationTrace(trace)
  const hasProviderReasoning = parsed.segments.some(segment => segment.kind === 'reasoning')
  const segments = parsed.segments.filter(segment => (
    segment.kind === 'reasoning'
      ? settings.forwardReasoning
      : settings.forwardToolDetails
  ))
  const fallback = hasProviderReasoning || !settings.forwardReasoning
    ? undefined
    : normalizeReasoningView(fallbackReasoning)
  if (fallback !== undefined) {
    const maximumStep = parsed.segments.reduce(
      (maximum, segment) => Math.max(maximum, segment.step),
      -1
    )
    if (maximumStep < Number.MAX_SAFE_INTEGER) {
      segments.push(Object.freeze({
        kind: 'reasoning',
        step: maximumStep + 1,
        turn: 1,
        text: fallback.text,
        truncated: fallback.truncated
      }))
    }
  }
  if (segments.length === 0) return EMPTY_PRESENTATION_TRACE
  return parsePresentationTrace({
    schemaVersion: 1,
    truncated: parsed.truncated || segments.some(segment => segment.truncated),
    segments
  })
}

export function executionTraceForwardPart (
  trace: PresentationTraceV1
): Extract<OutboundPart, { media: 'forward' }> {
  const parsed = parsePresentationTrace(trace)
  const hasReasoning = parsed.segments.some(segment => segment.kind === 'reasoning')
  const hasTools = parsed.segments.some(segment => segment.kind === 'tool')
  let reasoningIndex = 0
  return Object.freeze({
    media: 'forward',
    title: hasReasoning && hasTools
      ? '执行过程'
      : hasReasoning
        ? '思考过程'
        : '工具执行详情',
    nodes: Object.freeze(parsed.segments.map(segment => {
      if (segment.kind === 'reasoning') {
        reasoningIndex += 1
        return Object.freeze({
          kind: 'text' as const,
          text: `【模型思考 ${reasoningIndex}】\n${segment.text}`
        })
      }
      return Object.freeze({
        kind: 'text' as const,
        text: [
          `【工具执行：${segment.toolName}】`,
          `状态：${OUTCOME_LABELS[segment.outcome]}`,
          `参数：${segment.argumentsSummary}`,
          `结果：${segment.resultSummary}`
        ].join('\n')
      })
    }))
  })
}
