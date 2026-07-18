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

const completeUsage = Object.freeze({
  schemaVersion: 1 as const,
  availability: 'complete' as const,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cacheHitTokens: 80,
  cacheMissTokens: 20,
  turnsWithUsage: 1,
  turnsWithoutUsage: 0,
  cacheUsageComplete: true
})

const frozenPrice = Object.freeze({
  schemaVersion: 1 as const,
  catalogVersion: 'deepseek-cny-2026-07-19',
  model: 'deepseek-v4-flash',
  inputCacheHitPicoYuanPerMillionTokens: 20_000_000_000,
  inputCacheMissPicoYuanPerMillionTokens: 1_000_000_000_000,
  outputPicoYuanPerMillionTokens: 2_000_000_000_000
})

const emptyUsage = Object.freeze({
  ...completeUsage,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  turnsWithUsage: 0,
  cacheUsageComplete: true
})

type BuilderInput = Parameters<typeof buildPresentationTrace>[0]

function buildTrace (
  input: Omit<BuilderInput, 'usage' | 'modelPrice'> &
  Partial<Pick<BuilderInput, 'usage' | 'modelPrice'>>
) {
  return buildPresentationTrace({
    ...input,
    usage: input.usage ?? emptyUsage,
    modelPrice: input.modelPrice ?? null
  })
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

test('presentation trace parser keeps strict V1 compatibility and accepts only nested V2 usage', () => {
  const v1 = {
    schemaVersion: 1,
    truncated: false,
    segments: []
  } as const
  assert.deepEqual(parsePresentationTrace(v1), EMPTY_PRESENTATION_TRACE)
  assert.throws(() => parsePresentationTrace({
    ...v1,
    usage: {
      schemaVersion: 1,
      availability: 'complete',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheHitTokens: 0,
      cacheMissTokens: 1,
      cacheUsageComplete: true,
      cost: {
        kind: 'unavailable', catalogVersion: null, billingAuthority: false
      }
    }
  }), /unknown|key|version/i)

  const v2 = parsePresentationTrace({
    schemaVersion: 2,
    truncated: false,
    segments: [],
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
  assert.equal(v2.schemaVersion, 2)
  assert.equal(v2.usage?.cost.kind, 'exact')
  assert.equal(JSON.stringify(v2).includes('61600000'), true)
  assert.doesNotMatch(JSON.stringify(v2), /\d+n/)
})

test('presentation usage codec rejects noncanonical costs, cross-state values and hostile records', () => {
  const usage = {
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
    cacheUsageComplete: true,
    cost: {
      kind: 'exact', currency: 'CNY', picoYuan: '61600000',
      catalogVersion: 'catalog-v1', billingAuthority: false
    }
  } as const
  const trace = (candidate: unknown) => ({
    schemaVersion: 2, truncated: false, segments: [], usage: candidate
  })
  for (const picoYuan of [
    '-1', '01', '1e3', '1.0', '', '9'.repeat(129)
  ]) {
    assert.throws(() => parsePresentationTrace(trace({
      ...usage, cost: { ...usage.cost, picoYuan }
    })), /cost|pico|canonical|invalid|limit/i)
  }
  for (const candidate of [
    { ...usage, totalTokens: 121 },
    { ...usage, cacheMissTokens: 19 },
    { ...usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...usage, availability: 'partial' },
    { ...usage, cost: { ...usage.cost, kind: 'upper_bound' } },
    { ...usage, cost: { ...usage.cost, picoYuan: 1n } },
    Object.fromEntries(Object.entries(usage).filter(([key]) => key !== 'totalTokens')),
    { ...usage, extra: true }
  ]) {
    assert.throws(() => parsePresentationTrace(trace(candidate)), TypeError)
  }

  let reads = 0
  const hostile = Object.create(null)
  for (const [key, value] of Object.entries(usage)) {
    Object.defineProperty(hostile, key, key === 'inputTokens'
      ? { enumerable: true, get: () => { reads += 1; return value } }
      : { enumerable: true, value })
  }
  assert.throws(() => parsePresentationTrace(trace(hostile)), TypeError)
  assert.equal(reads, 0)

  let proxyTraps = 0
  const proxied = new Proxy(usage, {
    ownKeys: target => {
      proxyTraps += 1
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor: (target, key) => {
      proxyTraps += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    }
  })
  assert.throws(() => parsePresentationTrace(trace(proxied)), TypeError)
  assert.equal(proxyTraps, 0)
  const sparse = new Array(1)
  assert.throws(() => parsePresentationTrace({
    schemaVersion: 2, truncated: false, segments: sparse
  }), TypeError)
})

test('presentation builder always emits V2 and projects exact, upper-bound and unavailable costs', () => {
  const exact = buildTrace({
    reasoningSegments: [],
    toolLedgers: [],
    usage: completeUsage,
    modelPrice: frozenPrice
  })
  assert.deepEqual(exact, {
    schemaVersion: 2,
    truncated: false,
    segments: [],
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
  assert.doesNotThrow(() => JSON.stringify(exact))

  const upperBound = buildTrace({
    reasoningSegments: [],
    toolLedgers: [],
    usage: Object.freeze({ ...completeUsage, cacheUsageComplete: false }),
    modelPrice: frozenPrice
  })
  assert.equal(upperBound.schemaVersion, 2)
  assert.equal(upperBound.usage?.cost.kind, 'upper_bound')
  assert.equal(upperBound.usage?.cost.kind === 'upper_bound'
    ? upperBound.usage.cost.picoYuan
    : null, '140000000')

  for (const [availability, modelPrice] of [
    ['partial', frozenPrice],
    ['unavailable', frozenPrice],
    ['complete', null]
  ] as const) {
    const projected = buildTrace({
      reasoningSegments: [],
      toolLedgers: [],
      usage: Object.freeze({
        ...completeUsage,
        availability,
        ...(availability === 'partial' ? { turnsWithoutUsage: 1 } : {}),
        cacheUsageComplete: false
      }),
      modelPrice
    })
    assert.equal(projected.schemaVersion, 2)
    assert.equal(projected.usage?.cost.kind, 'unavailable')
    assert.equal(projected.usage?.inputTokens, 100)
  }
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
  const trace = buildTrace({
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
  const trace = buildTrace({
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
  const trace = buildTrace({
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
  const trace = buildTrace({
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
  const hostileOnly = buildTrace({
    reasoningSegments: [],
    toolLedgers: [ledgerWith(hostileArguments as JsonObject, successResult([]))]
  })
  assert.equal(hostileOnly.schemaVersion, 2)
  assert.equal(hostileOnly.truncated, true)
  assert.deepEqual(hostileOnly.segments, [])
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

  const trace = buildTrace({ reasoningSegments, toolLedgers })

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

test('presentation builder budgets full V2 bytes, retains usage on truncation and degrades only usage', () => {
  const reasoningSegments = Array.from({ length: 6 }, (_, index) => ({
    step: index,
    turn: index + 1,
    text: '思'.repeat(2_000),
    truncated: false
  }))
  const trace = buildTrace({
    reasoningSegments,
    toolLedgers: [],
    usage: completeUsage,
    modelPrice: frozenPrice
  })
  assert.equal(trace.schemaVersion, 2)
  assert.ok(utf8Bytes(trace) <= PRESENTATION_TRACE_MAX_BYTES)
  assert.equal(trace.truncated, true)
  assert.equal(trace.usage?.inputTokens, 100)
  assert.ok(trace.segments.length > 0)
  assert.ok(trace.segments.length <= PRESENTATION_TRACE_MAX_SEGMENTS)

  let getterReads = 0
  const hostileUsage = Object.defineProperty({ ...completeUsage }, 'inputTokens', {
    enumerable: true,
    get: () => {
      getterReads += 1
      return 100
    }
  })
  const degraded = buildTrace({
    reasoningSegments: [{ step: 0, turn: 1, text: '仍需保留', truncated: false }],
    toolLedgers: [],
    usage: hostileUsage as typeof completeUsage,
    modelPrice: frozenPrice
  })
  assert.equal(getterReads, 0)
  assert.equal(degraded.schemaVersion, 2)
  assert.equal(Object.hasOwn(degraded, 'usage'), false)
  assert.equal(degraded.segments[0]?.kind === 'reasoning'
    ? degraded.segments[0].text
    : null, '仍需保留')
})

test('presentation trace builder keeps at most eight chronological tool nodes', () => {
  const trace = buildTrace({
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
