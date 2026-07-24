import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryExtractionJobV1,
  deriveMemoryCandidateProvenanceV1,
  memoryCandidateValueRejectionReasonV1,
  memoryCredentialRejectionReasonV1,
  parseMemoryExtractorResultV1
} from '../../src/agent/memory/memory-candidate-pipeline.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

function extractionJob (overrides: Readonly<Record<string, unknown>> = {}) {
  const namespace = personalMemoryNamespaceFixture()
  return createMemoryExtractionJobV1({
    namespace,
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source: memorySourceFixture(),
    sceneRef: '1'.repeat(64),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: 'shadow',
    priority: 'inferred',
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply: '好，我记下了。',
    ...overrides
  })
}

test('extraction job is deterministic, frozen and binds the exact personal subject/source', () => {
  const first = extractionJob()
  const same = extractionJob()
  assert.equal(first.jobId, same.jobId)
  assert.match(first.jobId, /^extraction:[0-9a-f]{64}$/)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.subject), true)
  assert.equal(Object.isFrozen(first.source), true)

  assert.throws(() => extractionJob({
    subject: qqIdentityFixture({ userId: FIXTURE_IDS.secondUserId })
  }), TypeError)
  assert.throws(() => extractionJob({ requestedMode: 'automatic', approved: true }), TypeError)
})

test('extractor result is bounded data only and cannot request commit or approval', () => {
  const completed = parseMemoryExtractorResultV1({
    schemaVersion: 1,
    status: 'candidates',
    extractorVersion: 'candidate-v1',
    modelProfile: 'deepseek-chat',
    candidates: [{
      kind: 'preference',
      text: '喜欢无糖咖啡',
      sourceIds: [memorySourceFixture().sourceId],
      derivation: 'stated',
      confidence: 0.91,
      sensitivity: 'personal'
    }]
  }, extractionJob())
  assert.equal(completed.status, 'candidates')
  assert.equal(completed.candidates.length, 1)
  assert.equal(Object.isFrozen(completed.candidates[0]), true)

  for (const forbidden of [
    { approved: true },
    { operation: 'proposal.approve' },
    { namespaceRef: personalMemoryNamespaceFixture() },
    { conflict: { state: 'none', relatedMemoryIds: [], note: null } }
  ]) {
    assert.throws(() => parseMemoryExtractorResultV1({
      schemaVersion: 1,
      status: 'candidates',
      extractorVersion: 'candidate-v1',
      modelProfile: 'deepseek-chat',
      candidates: [{
        kind: 'preference',
        text: '喜欢无糖咖啡',
        sourceIds: [memorySourceFixture().sourceId],
        derivation: 'stated',
        confidence: 0.91,
        sensitivity: 'personal',
        ...forbidden
      }]
    }, extractionJob()), TypeError)
  }
})

test('credential admission rejects labelled secrets and verification codes without echoing them', () => {
  const cases = [
    ['我的 API key 是 sk-example-1234567890', 'api_key'],
    ['Authorization: Bearer abcdefghijklmnop', 'authorization'],
    ['cookie: sessionid=abcdefghijklmnop', 'cookie'],
    ['密码：hunter2-example', 'password'],
    ['验证码 834921', 'verification_code']
  ] as const
  for (const [text, reason] of cases) {
    assert.equal(memoryCredentialRejectionReasonV1(text), reason)
  }
  assert.equal(memoryCredentialRejectionReasonV1('我喜欢 2 杯无糖咖啡'), null)
  assert.equal(memoryCredentialRejectionReasonV1('我的生日是 2001 年 6 月 18 日'), null)

  const assistantLeak = extractionJob({
    assistantReply: '我误回显了 API key: sk-example-1234567890'
  })
  assert.equal(memoryCandidateValueRejectionReasonV1(assistantLeak, {
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sourceIds: [assistantLeak.source.sourceId],
    derivation: 'stated',
    confidence: 0.91,
    sensitivity: 'personal'
  }), 'credential')
})

test('third-party and inference provenance is derived from trusted subject/source binding', () => {
  const thirdPartyJob = extractionJob({
    source: memorySourceFixture({
      actor: qqIdentityFixture({ userId: FIXTURE_IDS.secondUserId })
    })
  })
  const provenance = deriveMemoryCandidateProvenanceV1(thirdPartyJob, {
    kind: 'profile_fact',
    text: '常住杭州',
    sourceIds: [thirdPartyJob.source.sourceId],
    derivation: 'inferred',
    confidence: 0.72,
    sensitivity: 'personal'
  })
  assert.deepEqual(provenance, deepFreezeFixture({
    schemaVersion: 1,
    subjectUserId: FIXTURE_IDS.subjectUserId,
    sourceActorUserIds: [FIXTURE_IDS.secondUserId],
    speakerRelation: 'third_party',
    derivation: 'inferred',
    sourceIds: [thirdPartyJob.source.sourceId]
  }))
})
