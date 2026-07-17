import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY_PRESENTATION_TRACE,
  PRESENTATION_TRACE_MAX_BYTES,
  PRESENTATION_TRACE_MAX_SEGMENTS,
  parsePresentationTrace
} from '../../src/agent/contracts/presentation-trace.js'
import type { JsonObject } from '../../src/agent/model/json-value.js'
import {
  buildPresentationTrace
} from '../../src/agent/run/presentation-trace-builder.js'
import type {
  TerminalToolLedgerStatus,
  ToolExecutionLedger
} from '../../src/agent/run/tool-ledger.js'
import {
  parseToolResult,
  type ToolContent,
  type ToolResult
} from '../../src/agent/tools/tool-result.js'

function successResult (
  content: ToolContent,
  effect: 'none' | 'background' | 'visible' = 'none'
): ToolResult {
  return parseToolResult({ status: 'success', effect, content, retryable: false })
}

function ledgerWith (
  argumentsValue: JsonObject,
  result: ToolResult,
  options: Readonly<{
    step?: number
    index?: number
    toolName?: string
    status?: TerminalToolLedgerStatus
  }> = {}
): ToolExecutionLedger {
  const step = options.step ?? 0
  const index = options.index ?? 0
  return Object.freeze({
    schemaVersion: 1,
    step,
    calls: Object.freeze([Object.freeze({
      occurrenceId: `${step}:${index}`,
      step,
      index,
      callId: `call-${step}-${index}`,
      toolName: options.toolName ?? 'website',
      arguments: argumentsValue,
      status: options.status ?? 'succeeded',
      capability: null,
      result
    })])
  })
}

function utf8Bytes (value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

test('presentation trace parser accepts only the exact bounded v1 contract', () => {
  const parsed = parsePresentationTrace({
    schemaVersion: 1,
    truncated: false,
    segments: [{
      kind: 'reasoning', step: 0, turn: 1,
      text: '分析', truncated: false
    }]
  })
  assert.equal(parsed.segments.length, 1)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.segments), true)
  assert.equal(Object.isFrozen(parsed.segments[0]), true)
  assert.throws(() => parsePresentationTrace({
    ...parsed, secret: 'must reject'
  }), /unknown|key/i)
  assert.throws(() => parsePresentationTrace({
    ...parsed,
    segments: Array.from({ length: PRESENTATION_TRACE_MAX_SEGMENTS + 1 }, () => (
      parsed.segments[0]
    ))
  }), /segment|limit/i)
})

test('presentation trace parser enforces tool fields, closed outcomes and field limits', () => {
  const tool = {
    kind: 'tool', step: 0, index: 0, toolName: 'website',
    outcome: 'succeeded', argumentsSummary: '{}', resultSummary: '完成',
    truncated: false
  } as const
  assert.deepEqual(parsePresentationTrace({
    schemaVersion: 1, truncated: false, segments: [tool]
  }).segments[0], tool)
  for (const invalid of [
    { ...tool, outcome: 'unknown' },
    { ...tool, step: -1 },
    { ...tool, index: -1 },
    { ...tool, toolName: 'bad name' },
    { ...tool, argumentsSummary: 'a'.repeat(501) },
    { ...tool, resultSummary: 'b'.repeat(1_001) },
    { ...tool, extra: true }
  ]) {
    assert.throws(() => parsePresentationTrace({
      schemaVersion: 1, truncated: false, segments: [invalid]
    }), /invalid|unknown|limit|length|key/i)
  }
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 1,
    truncated: false,
    segments: Array.from({ length: 6 }, (_, index) => ({
      kind: 'reasoning', step: index, turn: index + 1,
      text: '思'.repeat(2_000), truncated: false
    }))
  }), /byte|limit/i)
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 1,
    truncated: false,
    segments: [{ ...tool, truncated: true }]
  }), /truncation/i)
})

test('presentation trace parser rejects accessors and non-NFC text without invoking code', () => {
  let reads = 0
  const hostile = {
    kind: 'reasoning',
    step: 0,
    turn: 1,
    truncated: false,
    get text () {
      reads += 1
      return '不应读取'
    }
  }
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 1, truncated: false, segments: [hostile]
  }), /data propert|invalid/i)
  assert.equal(reads, 0)
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 1,
    truncated: false,
    segments: [{
      kind: 'reasoning', step: 0, turn: 1,
      text: 'e\u0301', truncated: false
    }]
  }), /NFC|normal/i)

  const hostileSegments: unknown[] = []
  Object.defineProperty(hostileSegments, '0', {
    enumerable: true,
    get: () => {
      reads += 1
      return hostile
    }
  })
  hostileSegments.length = 1
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 1, truncated: false, segments: hostileSegments
  }), /data propert|invalid/i)
  assert.equal(reads, 0)
})

test('presentation trace builder redacts credentials but preserves safe task details', () => {
  const trace = buildPresentationTrace({
    reasoningSegments: [{ step: 0, turn: 1, text: '先搜索', truncated: false }],
    toolLedgers: [ledgerWith(Object.freeze({
      api_key: 'secret-a',
      max_tokens: 64,
      authorization: 'Bearer secret-b',
      url: 'https://user:pass@example.test/page?access_token=secret-c&q=safe'
    }), successResult([
      { type: 'text', text: 'Authorization: Bearer secret-d\n安全结果' },
      {
        type: 'resource_ref', resourceType: 'image',
        resourceId: '/private/file', mimeType: 'image/png'
      }
    ]))]
  })

  const encoded = JSON.stringify(trace)
  assert.doesNotMatch(encoded, /secret-[abcd]|\/private\/file|user:pass/)
  assert.match(encoded, /max_tokens/)
  assert.match(encoded, /64/)
  assert.match(encoded, /安全结果/)
  assert.match(encoded, /image\/png/)
  assert.match(encoded, /已隐藏/)
  assert.deepEqual(trace.segments.map(item => item.kind), ['reasoning', 'tool'])
})

test('presentation trace builder masks every fixed sensitive key without masking max_tokens', () => {
  const sensitiveArguments: Record<string, string | number> = {
    apiKey: 'sensitive-value-1',
    token: 'sensitive-value-2',
    access_token: 'sensitive-value-3',
    refreshToken: 'sensitive-value-4',
    auth_token: 'sensitive-value-5',
    secret: 'sensitive-value-6',
    client_secret: 'sensitive-value-7',
    password: 'sensitive-value-8',
    passwd: 'sensitive-value-9',
    authorization: 'sensitive-value-10',
    cookie: 'sensitive-value-11',
    credential: 'sensitive-value-12',
    private_key: 'sensitive-value-13',
    max_tokens: 64
  }
  const trace = buildPresentationTrace({
    reasoningSegments: [],
    toolLedgers: [ledgerWith(
      Object.freeze(sensitiveArguments) as JsonObject,
      successResult([{ type: 'text', text: 'Cookie: sensitive-value-14\n安全' }])
    )]
  })
  const encoded = JSON.stringify(trace)
  assert.doesNotMatch(encoded, /sensitive-value-/)
  assert.match(encoded, /max_tokens/)
  assert.match(encoded, /64/)
  assert.match(encoded, /安全/)
})

test('presentation trace builder maps every terminal tool outcome and visible result safely', () => {
  const denied = parseToolResult({
    status: 'denied', effect: 'none', reasonCode: 'permission_denied',
    userMessage: '权限不足', retryable: false
  })
  const failed = parseToolResult({
    status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
    userMessage: '执行失败', retryable: false
  })
  const indeterminate = parseToolResult({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '结果待确认', retryable: false
  })
  const trace = buildPresentationTrace({
    reasoningSegments: [],
    toolLedgers: [
      ledgerWith({}, successResult([], 'none'), { step: 0, toolName: 'empty' }),
      ledgerWith({}, successResult([{ type: 'text', text: '不应重复' }], 'visible'), {
        step: 1, toolName: 'visible'
      }),
      ledgerWith({}, denied, { step: 2, toolName: 'denied', status: 'rejected' }),
      ledgerWith({}, failed, { step: 3, toolName: 'failed', status: 'cancelled' }),
      ledgerWith({}, indeterminate, {
        step: 4, toolName: 'uncertain', status: 'indeterminate'
      })
    ]
  })

  const tools = trace.segments.filter(segment => segment.kind === 'tool')
  assert.deepEqual(tools.map(segment => segment.outcome), [
    'succeeded', 'succeeded', 'denied', 'failed', 'indeterminate'
  ])
  assert.match(tools[0]?.resultSummary ?? '', /未返回文本结果/)
  assert.equal(tools[1]?.resultSummary, '结果已通过工具发送')
  assert.equal(tools[2]?.resultSummary, '权限不足')
  assert.equal(tools[3]?.resultSummary, '执行失败')
  assert.equal(tools[4]?.resultSummary, '结果待确认')
})

test('presentation trace builder drops hostile nodes without executing accessors or toJSON', () => {
  let getterReads = 0
  let toJsonCalls = 0
  const hostileArguments = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostileArguments, 'safe', {
    enumerable: true,
    get: () => {
      getterReads += 1
      return 'unsafe'
    }
  })
  Object.defineProperty(hostileArguments, 'toJSON', {
    enumerable: true,
    value: () => {
      toJsonCalls += 1
      return { leaked: true }
    }
  })
  const trace = buildPresentationTrace({
    reasoningSegments: [],
    toolLedgers: [
      ledgerWith(hostileArguments as JsonObject, successResult([]), {
        step: 0, toolName: 'hostile'
      }),
      ledgerWith({ safe: true }, successResult([{ type: 'text', text: '安全' }]), {
        step: 1, toolName: 'safe'
      })
    ]
  })

  assert.equal(getterReads, 0)
  assert.equal(toJsonCalls, 0)
  assert.equal(trace.truncated, true)
  assert.deepEqual(trace.segments.map(segment => (
    segment.kind === 'tool' ? segment.toolName : segment.kind
  )), ['safe'])
  assert.deepEqual(buildPresentationTrace({
    reasoningSegments: [],
    toolLedgers: [ledgerWith(hostileArguments as JsonObject, successResult([]))]
  }), EMPTY_PRESENTATION_TRACE)
})

test('presentation trace builder preserves only a bounded chronological prefix', () => {
  const reasoningSegments = Array.from({ length: 6 }, (_, index) => ({
    step: index,
    turn: index + 1,
    text: '思'.repeat(2_000),
    truncated: false
  }))
  const toolLedgers = Array.from({ length: 8 }, (_, index) => ledgerWith(
    { query: `query-${index}-${'a'.repeat(500)}` },
    successResult([{ type: 'text', text: `result-${index}-${'结'.repeat(1_000)}` }]),
    { step: index, index: 0, toolName: `tool_${index}` }
  ))

  const trace = buildPresentationTrace({ reasoningSegments, toolLedgers })

  assert.ok(utf8Bytes(trace) <= PRESENTATION_TRACE_MAX_BYTES)
  assert.ok(trace.segments.length <= PRESENTATION_TRACE_MAX_SEGMENTS)
  assert.equal(trace.truncated, true)
  const last = trace.segments.at(-1)
  assert.ok(last !== undefined)
  assert.match(
    last.kind === 'reasoning' ? last.text : last.resultSummary,
    /已截断/
  )
  for (let index = 1; index < trace.segments.length; index += 1) {
    assert.ok((trace.segments[index - 1]?.step ?? -1) <= (trace.segments[index]?.step ?? -1))
  }
})

test('presentation trace builder keeps at most eight chronological tool nodes', () => {
  const trace = buildPresentationTrace({
    reasoningSegments: [],
    toolLedgers: Array.from({ length: 9 }, (_, index) => ledgerWith(
      { index },
      successResult([{ type: 'text', text: `result-${index}` }]),
      { step: index, toolName: `tool_${index}` }
    ))
  })

  assert.equal(trace.segments.length, 8)
  assert.equal(trace.truncated, true)
  assert.deepEqual(trace.segments.slice(0, 7).map(segment => segment.step), [0, 1, 2, 3, 4, 5, 6])
  const last = trace.segments.at(-1)
  assert.equal(last?.kind, 'tool')
  assert.match(last?.kind === 'tool' ? last.resultSummary : '', /已截断/)
})
