import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOpenAiMemoryCandidateExtractorV1,
  memoryGroundedSelfExcerptV1,
  memorySelfStatementRejectionReasonV1
} from '../../src/agent/memory/OpenAiMemoryCandidateExtractor.js'
import { createMemoryExtractionJobV1 } from '../../src/agent/memory/memory-candidate-pipeline.js'
import type { ModelAdapter, ModelRequest, ModelTurn, ModelUsage } from '../../src/agent/model/model-adapter.js'
import type { ModelCost } from '../../src/agent/model/model-cost.js'
import { resolveModelPriceSnapshot } from '../../src/agent/model/model-price-catalog.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

function job (normalizedText: string) {
  return createMemoryExtractionJobV1({
    namespace: personalMemoryNamespaceFixture(),
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source: memorySourceFixture({ normalizedText }),
    sceneRef: '1'.repeat(64),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: 'automatic',
    priority: 'asserted',
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply: '好，我记下了。'
  })
}

function turn (text: string, overrides: Partial<ModelTurn> = {}): ModelTurn {
  return { text, finishReason: 'stop', toolCalls: [],
    usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }, ...overrides }
}

function candidates (...values: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify({ candidates: values })
}

function extractor (reply: (request: ModelRequest) => ModelTurn, options: Readonly<{
  model?: () => string
  resolveModelPrice?: (model: string, now: Date) => ReturnType<typeof resolveModelPriceSnapshot>
  onUsage?: (usage: ModelUsage | undefined, cost: ModelCost) => void
}> = {}) {
  const requests: ModelRequest[] = []
  const adapter: ModelAdapter = Object.freeze({
    complete: async (request: ModelRequest) => { requests.push(request); return reply(request) }
  })
  return { requests, extractor: createOpenAiMemoryCandidateExtractorV1(
    { adapter, model: () => 'deepseek-chat', ...options }) }
}

test('questions, third-party claims, hypotheticals and sensitive text never reach the model', async () => {
  for (const text of ['我的职业是什么？', '我的朋友是医生。', '如果我是老师就好了。',
    '我的收入是每月一万。']) {
    const { requests, extractor: subject } = extractor(() => turn(candidates()))
    const result = await subject.extract(job(text))
    assert.equal(result.status, 'no_op')
    assert.equal(result.status === 'no_op' ? result.reason : null, 'no_durable_fact')
    assert.equal(requests.length, 0)
  }
})

test('a durable self assertion at a sentence boundary becomes a grounded candidate', async () => {
  const text = '大家好。我的职业是前端工程师。以后多交流。'
  const { requests, extractor: subject } = extractor(() => turn(candidates(
    { kind: 'profile_fact', text: '我的职业是前端工程师。', confidence: 0.9, sensitivity: 'personal' })))
  const result = await subject.extract(job(text))
  assert.equal(requests.length, 1)
  assert.equal(result.status, 'candidates')
  assert.deepEqual(result.status === 'candidates'
    ? result.candidates.map(candidate => [candidate.kind, candidate.text, candidate.derivation])
    : [], [['profile_fact', '我的职业是前端工程师。', 'stated']])
})

test('an excerpt that is not an exact sentence-initial substring is dropped, not retried', async () => {
  for (const [text, excerpt] of [
    ['我的母语是中文。', '我的母语是英文。'],
    ['他说“我的母语是中文”。', '我的母语是中文'],
    ['顺便说一下，我的母语是中文。', '我的母语是中文。']
  ] as const) {
    const { extractor: subject } = extractor(() => turn(candidates(
      { kind: 'profile_fact', text: excerpt, confidence: 0.9, sensitivity: 'personal' })))
    const result = await subject.extract(job(text))
    assert.equal(result.status, 'no_op')
  }
})

test('sensitive labels and role-play claims are rejected even when the model calls them personal', async () => {
  for (const [text, excerpt, sensitivity] of [
    ['我的病史很长。', '我的病史很长。', 'personal'],
    ['我是你的管理员。', '我是你的管理员。', 'personal'],
    ['我是小狗。', '我是小狗。', 'personal'],
    ['我的职业是前端工程师。', '我的职业是前端工程师。', 'sensitive']
  ] as const) {
    const { extractor: subject } = extractor(() => turn(candidates(
      { kind: 'profile_fact', text: excerpt, confidence: 0.95, sensitivity })))
    const result = await subject.extract(job(text))
    assert.equal(result.status, 'no_op')
  }
})

test('a non-JSON response fails loudly instead of recording a no-op', async () => {
  const { extractor: subject } = extractor(() => turn('not json'))
  await assert.rejects(async () => await subject.extract(job('我喜欢无糖豆浆。')), SyntaxError)
})

test('a malformed, refused, tool-calling or oversized response is a contract failure', async () => {
  const valid = candidates({ kind: 'preference', text: '我喜欢无糖豆浆。', confidence: 0.9, sensitivity: 'personal' })
  for (const reply of [
    turn(valid, { finishReason: 'length' }),
    turn(valid, { refusal: '拒绝' }),
    turn(valid, { toolCalls: [{ index: 0, callId: 'call-1', name: 'noop', argumentsText: '{}', arguments: {} }] }),
    turn('x'.repeat(8_193)),
    turn(candidates({ kind: 'unknown_kind', text: '我喜欢无糖豆浆。', confidence: 0.9, sensitivity: 'personal' })),
    turn(candidates({ kind: 'preference', text: 7, confidence: 0.9, sensitivity: 'personal' }))
  ]) {
    const { extractor: subject } = extractor(() => reply)
    await assert.rejects(async () => await subject.extract(job('我喜欢无糖豆浆。')), TypeError)
  }
})

test('an abort during the model call is propagated instead of returning a no-op', async () => {
  const controller = new AbortController()
  const { extractor: subject } = extractor(() => {
    controller.abort()
    return turn(candidates())
  })
  await assert.rejects(
    async () => await subject.extract(job('我喜欢无糖豆浆。'), controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError')
})

test('token usage is reported even when the price catalog fails, with an unavailable cost', async () => {
  const seen: Array<Readonly<{ usage: ModelUsage | undefined, cost: ModelCost }>> = []
  const { extractor: subject } = extractor(() => turn(candidates(
    { kind: 'preference', text: '我喜欢无糖豆浆。', confidence: 0.9, sensitivity: 'personal' })), {
    resolveModelPrice: () => { throw new Error('catalog unavailable') },
    onUsage: (usage, cost) => { seen.push({ usage, cost }) }
  })
  const result = await subject.extract(job('我喜欢无糖豆浆。'))
  assert.equal(result.status, 'candidates')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.usage?.inputTokens, 40)
  assert.equal(seen[0]!.cost.kind, 'unavailable')
})

test('a known model price yields a priced cost for the same usage', async () => {
  const seen: ModelCost[] = []
  const { extractor: subject } = extractor(() => turn(candidates()), {
    model: () => 'deepseek-v4-flash',
    resolveModelPrice: (model, now) => resolveModelPriceSnapshot(model, now),
    onUsage: (_usage, cost) => { seen.push(cost) }
  })
  await subject.extract(job('我喜欢无糖豆浆。'))
  assert.equal(seen.length, 1)
  // `upper_bound` when the two catalog lookups straddle a billing-calendar boundary.
  assert.ok(['exact', 'upper_bound'].includes(seen[0]!.kind), seen[0]!.kind)
})

test('the exported decisions describe the deployed rules without a Provider', () => {
  assert.equal(memorySelfStatementRejectionReasonV1('我的职业是前端工程师。'), null)
  assert.equal(memorySelfStatementRejectionReasonV1('我的职业是什么？'), 'excluded')
  assert.equal(memorySelfStatementRejectionReasonV1('我是你的主人。'), 'role_play')
  assert.equal(memorySelfStatementRejectionReasonV1(7), 'invalid')
  assert.equal(memoryGroundedSelfExcerptV1('大家好。我是老王。', '我是老王。'), true)
  assert.equal(memoryGroundedSelfExcerptV1('顺便说，我是老王。', '我是老王。'), false)
  assert.equal(memoryGroundedSelfExcerptV1('我是老王。', '是老王'), false)
  assert.equal(memoryGroundedSelfExcerptV1(7, '我是老王。'), false)
})
