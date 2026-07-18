import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PRESENTATION_TRACE_MAX_BYTES,
  parsePresentationTrace
} from '../../src/agent/contracts/presentation-trace.js'
import {
  executionTraceForwardPart,
  selectExecutionTrace
} from '../../src/runtime/presentation/execution-trace-presentation.js'

const trace = parsePresentationTrace({
  schemaVersion: 1,
  truncated: false,
  segments: [
    {
      kind: 'reasoning', step: 0, turn: 1,
      text: '模型原生思考', truncated: false
    },
    {
      kind: 'tool', step: 0, index: 0, toolName: 'search', outcome: 'succeeded',
      argumentsSummary: '{"query":"天气"}', resultSummary: '晴', truncated: false
    }
  ]
})

const traceWithUsage = parsePresentationTrace({
  schemaVersion: 2,
  truncated: false,
  segments: trace.segments,
  usage: {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
    cacheUsageComplete: true,
    cost: {
      kind: 'exact',
      currency: 'CNY',
      picoYuan: '61600000',
      catalogVersion: 'deepseek-cny-2026-07-19',
      billingAuthority: false
    }
  }
})
if (traceWithUsage.schemaVersion !== 2 || traceWithUsage.usage === undefined) {
  throw new TypeError('V2 usage fixture is missing')
}
const traceUsage = traceWithUsage.usage

function largeToolSegments (count: number) {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    kind: 'tool' as const,
    step: index,
    index: 0,
    toolName: `tool_${index}`,
    outcome: 'succeeded' as const,
    argumentsSummary: 'a'.repeat(500),
    resultSummary: '结'.repeat(1_000),
    truncated: false
  }))
}

function largeToolTrace (segments = largeToolSegments(3)) {
  return parsePresentationTrace({
    schemaVersion: 2,
    truncated: false,
    segments,
    usage: traceUsage
  })
}

test('execution trace selection keeps the four independent switch combinations', () => {
  const cases = [
    [false, false, []],
    [true, false, ['reasoning']],
    [false, true, ['tool']],
    [true, true, ['reasoning', 'tool']]
  ] as const

  for (const [forwardReasoning, forwardToolDetails, expected] of cases) {
    const selected = selectExecutionTrace(
      trace,
      { forwardReasoning, forwardToolDetails },
      undefined
    )
    assert.deepEqual(selected.segments.map(segment => segment.kind), expected)
  }
})

test('provider reasoning wins over inline fallback and one forward keeps chronological nodes', () => {
  const selected = selectExecutionTrace(
    trace,
    { forwardReasoning: true, forwardToolDetails: true },
    { text: '内联推理不应重复', truncated: false }
  )
  const part = executionTraceForwardPart(selected)

  assert.equal(part.title, '执行过程')
  assert.deepEqual(part.nodes.map(node => node.text), [
    '【模型思考 1】\n模型原生思考',
    '【工具执行：search】\n状态：成功\n参数：{"query":"天气"}\n结果：晴'
  ])
  assert.doesNotMatch(JSON.stringify(part), /内联推理不应重复/)
})

test('inline reasoning is appended only when provider reasoning is absent', () => {
  const toolOnly = parsePresentationTrace({
    schemaVersion: 1,
    truncated: false,
    segments: [{
      kind: 'tool', step: 0, index: 0, toolName: 'website', outcome: 'failed',
      argumentsSummary: '{"url":"https://example.com/"}',
      resultSummary: '读取失败', truncated: false
    }]
  })
  const selected = selectExecutionTrace(
    toolOnly,
    { forwardReasoning: true, forwardToolDetails: true },
    { text: '内联回退思考', truncated: false }
  )

  assert.deepEqual(selected.segments.map(segment => segment.kind), ['tool', 'reasoning'])
  assert.equal(selected.segments[1]?.kind === 'reasoning'
    ? selected.segments[1].text
    : null, '内联回退思考')
  assert.equal(executionTraceForwardPart(selected).title, '执行过程')
})

test('selection preserves V2 usage and renderer appends one integer-formatted usage node', () => {
  for (const [forwardReasoning, forwardToolDetails] of [
    [false, false], [true, false], [false, true], [true, true]
  ] as const) {
    const selected = selectExecutionTrace(
      traceWithUsage,
      { forwardReasoning, forwardToolDetails },
      undefined
    )
    assert.equal(selected.schemaVersion, 2)
    assert.equal(selected.usage?.cost.kind, 'exact')
  }

  const part = executionTraceForwardPart(traceWithUsage)
  assert.equal(part.nodes.length, trace.segments.length + 1)
  assert.match(part.nodes.at(-1)?.text ?? '', /^【Token 与费用】/)
  assert.match(part.nodes.at(-1)?.text ?? '', /输入 100（缓存命中 80，未命中 20）/)
  assert.match(part.nodes.at(-1)?.text ?? '', /参考费用 ¥0\.0000616/)
  assert.match(part.nodes.at(-1)?.text ?? '', /非供应商账单/)
  assert.equal(part.nodes.filter(node => /Token 与费用/.test(node.text)).length, 1)

  const upper = parsePresentationTrace({
    ...traceWithUsage,
    usage: {
      ...traceUsage,
      cacheUsageComplete: false,
      cost: {
        kind: 'upper_bound', currency: 'CNY', picoYuan: '1000000000001',
        catalogVersion: 'catalog-v1', billingAuthority: false
      }
    }
  })
  const upperText = executionTraceForwardPart(upper).nodes.at(-1)?.text ?? ''
  assert.match(upperText, /参考费用上限 ¥1\.000000000001/)
  assert.match(upperText, /缓存明细不完整，全部输入按未命中估算/)

  const partial = parsePresentationTrace({
    ...traceWithUsage,
    usage: {
      ...traceUsage,
      availability: 'partial',
      cacheUsageComplete: false,
      cost: {
        kind: 'unavailable', catalogVersion: 'catalog-v1', billingAuthority: false
      }
    }
  })
  const partialText = executionTraceForwardPart(partial).nodes.at(-1)?.text ?? ''
  assert.match(partialText, /已记录\/可确认部分/)
  assert.match(partialText, /参考费用不可用/)
  assert.match(partialText, /非供应商账单/)
})

test('selector fits UTF-8 fallback reasoning without losing V2 tools or usage', () => {
  const original = largeToolTrace()
  const originalBytes = Buffer.byteLength(JSON.stringify(original), 'utf8')
  assert.ok(originalBytes > 11_000 && originalBytes < PRESENTATION_TRACE_MAX_BYTES)

  const selected = selectExecutionTrace(
    original,
    { forwardReasoning: true, forwardToolDetails: true },
    { text: '思'.repeat(2_000), truncated: false }
  )

  assert.equal(selected.schemaVersion, 2)
  if (selected.schemaVersion !== 2) return
  assert.deepEqual(selected.usage, traceUsage)
  assert.deepEqual(selected.segments.slice(0, 3), original.segments)
  assert.equal(selected.segments.length, 4)
  const fallback = selected.segments.at(-1)
  assert.equal(fallback?.kind, 'reasoning')
  if (fallback?.kind !== 'reasoning') return
  assert.equal(fallback.truncated, true)
  assert.match(fallback.text, /…（内容已截断）$/u)
  assert.ok([...fallback.text].length <= 2_000)
  assert.equal(selected.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(selected), 'utf8') <= PRESENTATION_TRACE_MAX_BYTES)
})

test('selector drops fallback when even its explicit truncation marker cannot fit', () => {
  const prefix = largeToolSegments(4)
  let low = 1
  let high = 1_000
  let fitted = 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = [
      ...prefix,
      Object.freeze({
        kind: 'tool' as const,
        step: 4,
        index: 0,
        toolName: 'tool_4',
        outcome: 'succeeded' as const,
        argumentsSummary: 'a',
        resultSummary: '结'.repeat(middle),
        truncated: false
      })
    ]
    const bytes = Buffer.byteLength(JSON.stringify({
      schemaVersion: 2,
      truncated: false,
      segments: candidate,
      usage: traceUsage
    }), 'utf8')
    if (bytes <= PRESENTATION_TRACE_MAX_BYTES) {
      fitted = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const original = largeToolTrace([
    ...prefix,
    Object.freeze({
      kind: 'tool' as const,
      step: 4,
      index: 0,
      toolName: 'tool_4',
      outcome: 'succeeded' as const,
      argumentsSummary: 'a',
      resultSummary: '结'.repeat(fitted),
      truncated: false
    })
  ])
  assert.ok(PRESENTATION_TRACE_MAX_BYTES -
    Buffer.byteLength(JSON.stringify(original), 'utf8') < 3)

  const selected = selectExecutionTrace(
    original,
    { forwardReasoning: true, forwardToolDetails: true },
    { text: '思'.repeat(2_000), truncated: false }
  )
  assert.equal(selected.schemaVersion, 2)
  if (selected.schemaVersion !== 2) return
  assert.deepEqual(selected.segments, original.segments)
  assert.deepEqual(selected.usage, traceUsage)
  assert.equal(selected.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(selected), 'utf8') <= PRESENTATION_TRACE_MAX_BYTES)
})
