import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAiMemoryCandidateExtractorV1 } from '../../src/agent/memory/OpenAiMemoryCandidateExtractor.js'
import {
  createMemoryExtractionJobV1,
  memoryCandidateValueRejectionReasonV1,
  memoryCredentialRejectionReasonV1
} from '../../src/agent/memory/memory-candidate-pipeline.js'
import type { ModelAdapter, ModelTurn } from '../../src/agent/model/model-adapter.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

/** 最配合的模型：把整句原样当成高置信度个人候选交回，不做任何自我审查。 */
function cooperativeModel (candidate: string) {
  const adapter: ModelAdapter = {
    async complete (): Promise<ModelTurn> {
      return {
        text: JSON.stringify({
          candidates: [{
            kind: 'profile_fact',
            text: candidate,
            confidence: 0.95,
            sensitivity: 'personal'
          }]
        }),
        toolCalls: [],
        finishReason: 'stop'
      }
    }
  }
  return { adapter, model: () => 'synthetic-cooperative' }
}

function extractionJob (text: string) {
  return createMemoryExtractionJobV1({
    namespace: personalMemoryNamespaceFixture(),
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source: memorySourceFixture({ normalizedText: text }),
    sceneRef: '1'.repeat(64),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'synthetic-cooperative',
    requestedMode: 'shadow',
    priority: 'inferred',
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply: '好。'
  })
}

/** 真实准入链：抽取器（排除/接地/敏感标签）→ 凭据门禁 → 价值门禁。 */
async function admittedCount (text: string): Promise<number> {
  const job = extractionJob(text)
  const extractor = createOpenAiMemoryCandidateExtractorV1(cooperativeModel(text))
  const result = await extractor.extract(job)
  if (result.status !== 'candidates') return 0
  return result.candidates.filter(candidate =>
    memoryCredentialRejectionReasonV1(candidate.text) === null &&
    memoryCandidateValueRejectionReasonV1(job, candidate) === null).length
}

test('identifier and belief assertions stay out even when the model fully cooperates', async () => {
  for (const text of [
    '我家住在合成市幸福路18号3单元501。',
    '我的手机号是13800000000。',
    '我的身份证号前六位是110101。',
    '我的邮箱是synthetic@example.com。',
    '我信佛教，每年都去寺里。',
    '我的政治立场比较保守。',
    '我不相信任何宗教。'
  ]) {
    assert.equal(await admittedCount(text), 0, text)
  }
})

test('ordinary assertions next to the sensitive categories remain admissible', async () => {
  for (const text of [
    '我住在南方的城市。',
    '我的母语是中文。',
    '我喜欢被叫做小林。',
    '我喜欢读历史书。',
    '我喜欢参观博物馆。',
    '我喜欢安静的环境。',
    '我知道3种排序算法。',
    '我的生日是6月18号。'
  ]) {
    assert.equal(await admittedCount(text), 1, text)
  }
})

test('verification codes are rejected in ASCII, full-width and Chinese numeral shapes', () => {
  assert.equal(memoryCredentialRejectionReasonV1('我的验证码是4567。'), 'verification_code')
  assert.equal(memoryCredentialRejectionReasonV1('我的验证码是４５６７。'), 'verification_code')
  assert.equal(memoryCredentialRejectionReasonV1('我的验证码是四五六七。'), 'verification_code')
  assert.equal(memoryCredentialRejectionReasonV1('我的生日是 2001 年 6 月 18 日'), null)
  assert.equal(memoryCredentialRejectionReasonV1('我喜欢四五个同好一起打球'), null)
})
