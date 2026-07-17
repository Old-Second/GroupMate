import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePresentationTrace } from '../../src/agent/contracts/presentation-trace.js'
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
