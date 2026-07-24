import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createMemoryExtractionJobV1,
  type MemoryExtractionJobV1
} from '../../src/agent/memory/memory-candidate-pipeline.js'
import { createMemoryCandidateWorkerV1 } from '../../src/agent/memory/memory-candidate-worker.js'
import {
  createSqliteMemoryExtractionQueueV1,
  type SqliteMemoryExtractionQueueV1
} from '../../src/agent/memory/sqlite-memory-extraction-queue.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

const BASE_NOW = '2026-07-19T00:03:00.000Z'

function job (input: {
  readonly tag: string
  readonly mode?: 'shadow' | 'automatic'
  readonly thirdParty?: boolean
}): MemoryExtractionJobV1 {
  const namespace = personalMemoryNamespaceFixture()
  return createMemoryExtractionJobV1({
    namespace,
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source: memorySourceFixture(input.thirdParty === true
      ? { actor: qqIdentityFixture({ userId: FIXTURE_IDS.secondUserId }) }
      : {}),
    sceneRef: '1'.repeat(64),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: input.mode ?? 'shadow',
    priority: 'inferred',
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply: `回复 ${input.tag}`
  })
}

function candidate (
  current: MemoryExtractionJobV1,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sourceIds: [current.source.sourceId],
    derivation: 'stated',
    confidence: 0.91,
    sensitivity: 'personal',
    ...overrides
  }
}

function fixture (input: {
  readonly currentJob: MemoryExtractionJobV1
  readonly policy?: unknown
  readonly extractor?: (job: MemoryExtractionJobV1, signal?: AbortSignal) => Promise<unknown>
  readonly classify?: () => Promise<unknown>
  readonly rssBytes?: () => number
  readonly recordAudit?: SqliteMemoryExtractionQueueV1['recordAudit']
}) {
  let now = BASE_NOW
  const database = new DatabaseSync(':memory:')
  const queue = createSqliteMemoryExtractionQueueV1({
    database,
    now: () => now,
    leaseToken: () => 'a'.repeat(64)
  })
  const submissions: unknown[] = []
  let extractionCalls = 0
  const worker = createMemoryCandidateWorkerV1({
    queue: input.recordAudit === undefined
      ? queue
      : Object.freeze({ ...queue, recordAudit: input.recordAudit }),
    workerId: 'candidate-worker-1',
    now: () => now,
    rssBytes: input.rssBytes ?? (() => 128 * 1_024 * 1_024),
    policy: {
      decide: async () => input.policy ?? { status: 'enabled', mode: 'shadow' }
    },
    extractor: {
      extract: async (current, signal) => {
        extractionCalls += 1
        return input.extractor === undefined
          ? {
              schemaVersion: 1,
              status: 'candidates',
              extractorVersion: 'candidate-v1',
              modelProfile: 'deepseek-chat',
              candidates: [candidate(current)]
            }
          : await input.extractor(current, signal)
      }
    },
    classifier: {
      classify: input.classify ?? (async () => ({ status: 'distinct' }))
    },
    sink: {
      submit: async value => {
        submissions.push(value)
        const mode = (value as { readonly approvalMode: 'shadow' | 'policy_approved' }).approvalMode
        return {
          status: 'stored',
          outcome: mode === 'policy_approved' ? 'approved' : 'shadow',
          proposalId: `proposal:${'b'.repeat(64)}`
        }
      }
    }
  })
  return Object.freeze({
    database,
    queue,
    worker,
    submissions,
    extractionCalls: () => extractionCalls,
    setNow: (value: string) => { now = value }
  })
}

test('disabled policy is checked before extraction and the job is consumed safely', async () => {
  const currentJob = job({ tag: 'disabled' })
  const current = fixture({
    currentJob,
    policy: { status: 'disabled', reason: 'deployment_off' }
  })
  try {
    await current.queue.enqueue(currentJob)
    const result = await current.worker.runBatch()
    assert.deepEqual(result, {
      status: 'processed', claimed: 1, completed: 1, retried: 0, deadLettered: 0
    })
    assert.equal(current.extractionCalls(), 0)
    assert.equal(current.submissions.length, 0)
  } finally {
    current.database.close()
  }
})

test('third-party inference and conflict provenance are preserved but cannot auto approve', async () => {
  const currentJob = job({ tag: 'third-party', mode: 'automatic', thirdParty: true })
  const current = fixture({
    currentJob,
    policy: { status: 'enabled', mode: 'automatic' },
    extractor: async current => ({
      schemaVersion: 1,
      status: 'candidates',
      extractorVersion: 'candidate-v1',
      modelProfile: 'deepseek-chat',
      candidates: [candidate(current, { derivation: 'inferred', confidence: 0.95 })]
    }),
    classify: async () => ({
      status: 'conflict',
      relatedMemoryIds: [`memory:${'c'.repeat(64)}`],
      note: '与现有偏好不一致'
    })
  })
  try {
    await current.queue.enqueue(currentJob)
    await current.worker.runBatch()
    assert.equal(current.submissions.length, 1)
    const submission = current.submissions[0] as Record<string, unknown>
    assert.equal(submission.approvalMode, 'shadow')
    assert.deepEqual(submission.provenance, {
      schemaVersion: 1,
      subjectUserId: FIXTURE_IDS.subjectUserId,
      sourceActorUserIds: [FIXTURE_IDS.secondUserId],
      speakerRelation: 'third_party',
      derivation: 'inferred',
      sourceIds: [currentJob.source.sourceId]
    })
    assert.deepEqual(submission.conflict, {
      state: 'possible',
      relatedMemoryIds: [`memory:${'c'.repeat(64)}`],
      note: '与现有偏好不一致'
    })
  } finally {
    current.database.close()
  }
})

test('automatic approval uses a deterministic allowlist independent of model output', async () => {
  const currentJob = job({ tag: 'automatic', mode: 'automatic' })
  const current = fixture({
    currentJob,
    policy: { status: 'enabled', mode: 'automatic' }
  })
  try {
    await current.queue.enqueue(currentJob)
    await current.worker.runBatch()
    assert.equal((current.submissions[0] as Record<string, unknown>).approvalMode, 'policy_approved')
  } finally {
    current.database.close()
  }
})

test('credential, low-value and duplicate candidates never reach the proposal sink', async () => {
  const cases = [
    {
      tag: 'credential',
      extractor: async (current: MemoryExtractionJobV1) => ({
        schemaVersion: 1, status: 'candidates', extractorVersion: 'candidate-v1',
        modelProfile: 'deepseek-chat', candidates: [candidate(current, {
          text: 'API key: sk-example-1234567890'
        })]
      }),
      classify: undefined
    },
    {
      tag: 'low-value',
      extractor: async (current: MemoryExtractionJobV1) => ({
        schemaVersion: 1, status: 'candidates', extractorVersion: 'candidate-v1',
        modelProfile: 'deepseek-chat', candidates: [candidate(current, { text: '好的' })]
      }),
      classify: undefined
    },
    {
      tag: 'duplicate',
      extractor: undefined,
      classify: async () => ({
        status: 'duplicate', relatedMemoryIds: [`memory:${'d'.repeat(64)}`]
      })
    }
  ]
  for (const item of cases) {
    const currentJob = job({ tag: item.tag })
    const current = fixture({
      currentJob,
      ...(item.extractor === undefined ? {} : { extractor: item.extractor }),
      ...(item.classify === undefined ? {} : { classify: item.classify })
    })
    try {
      await current.queue.enqueue(currentJob)
      await current.worker.runBatch()
      assert.equal(current.submissions.length, 0, item.tag)
      assert.equal(current.database.prepare(
        'SELECT count(*) AS count FROM memory_candidate_audits'
      ).get()?.count, 1)
    } finally {
      current.database.close()
    }
  }
})

test('transient extractor failure schedules durable retry and does not acknowledge the job', async () => {
  const currentJob = job({ tag: 'retry' })
  const current = fixture({
    currentJob,
    extractor: async () => { throw new Error('provider unavailable') }
  })
  try {
    await current.queue.enqueue(currentJob)
    assert.deepEqual(await current.worker.runBatch(), {
      status: 'processed', claimed: 1, completed: 0, retried: 1, deadLettered: 0
    })
    assert.equal((await current.queue.usage()).status, 'usage')
    current.setNow('2026-07-19T00:03:05.000Z')
    assert.equal((await current.queue.claim('other-worker', 1)).status, 'claimed')
  } finally {
    current.database.close()
  }
})

test('extraction timeout aborts the adapter and schedules a durable retry', async () => {
  const currentJob = job({ tag: 'timeout' })
  let observedAbort = false
  const current = fixture({
    currentJob,
    extractor: async (_current, signal) => await new Promise<never>(() => {
      signal?.addEventListener('abort', () => { observedAbort = true }, { once: true })
    })
  })
  const nativeSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
    nativeSetTimeout(handler, 0, ...args)) as typeof globalThis.setTimeout
  try {
    await current.queue.enqueue(currentJob)
    assert.deepEqual(await current.worker.runBatch(), {
      status: 'processed', claimed: 1, completed: 0, retried: 1, deadLettered: 0
    })
    assert.equal(observedAbort, true)
    assert.equal(current.database.prepare(`
      SELECT last_reason_code FROM memory_extraction_jobs
    `).get()?.last_reason_code, 'extraction_timeout')
  } finally {
    globalThis.setTimeout = nativeSetTimeout
    current.database.close()
  }
})

test('RSS pressure pauses before claiming any durable work', async () => {
  const currentJob = job({ tag: 'rss' })
  const current = fixture({
    currentJob,
    rssBytes: () => 513 * 1_024 * 1_024
  })
  try {
    await current.queue.enqueue(currentJob)
    assert.deepEqual(await current.worker.runBatch(), {
      status: 'resource_paused', claimed: 0, completed: 0, retried: 0, deadLettered: 0
    })
    const usage = await current.queue.usage()
    assert.equal(usage.status === 'usage' && usage.pendingRecords === 1, true)
  } finally {
    current.database.close()
  }
})

test('single worker rejects a concurrent batch while its current extraction is pending', async () => {
  const currentJob = job({ tag: 'busy' })
  let releaseExtraction: (() => void) | undefined
  let markStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const pending = new Promise<void>(resolve => { releaseExtraction = resolve })
  const current = fixture({
    currentJob,
    extractor: async currentJobValue => {
      markStarted?.()
      await pending
      return {
        schemaVersion: 1,
        status: 'candidates',
        extractorVersion: 'candidate-v1',
        modelProfile: 'deepseek-chat',
        candidates: [candidate(currentJobValue)]
      }
    }
  })
  try {
    await current.queue.enqueue(currentJob)
    const first = current.worker.runBatch()
    await started
    assert.deepEqual(await current.worker.runBatch(), {
      status: 'busy', claimed: 0, completed: 0, retried: 0, deadLettered: 0
    })
    releaseExtraction?.()
    assert.deepEqual(await first, {
      status: 'processed', claimed: 1, completed: 1, retried: 0, deadLettered: 0
    })
  } finally {
    current.database.close()
  }
})

test('fifth transient failure is durably audited and dead-lettered', async () => {
  const currentJob = job({ tag: 'dead-letter' })
  const current = fixture({
    currentJob,
    extractor: async () => { throw new Error('provider unavailable') }
  })
  const attemptTimes = [
    '2026-07-19T00:03:00.000Z',
    '2026-07-19T00:03:05.000Z',
    '2026-07-19T00:03:35.000Z',
    '2026-07-19T00:05:35.000Z',
    '2026-07-19T00:15:35.000Z'
  ]
  try {
    await current.queue.enqueue(currentJob)
    for (let index = 0; index < attemptTimes.length; index += 1) {
      current.setNow(attemptTimes[index]!)
      const result = await current.worker.runBatch()
      assert.equal(result.claimed, 1)
      if (index < attemptTimes.length - 1) {
        assert.equal(result.retried, 1)
        assert.equal(result.deadLettered, 0)
      } else {
        assert.equal(result.retried, 0)
        assert.equal(result.deadLettered, 1)
      }
    }
    const usage = await current.queue.usage()
    assert.equal(usage.status === 'usage' && usage.pendingRecords === 0, true)
    const audit = current.database.prepare(`
      SELECT outcome, reason_code FROM memory_candidate_audits
    `).get()
    assert.equal(audit?.outcome, 'dead_letter')
    assert.equal(audit?.reason_code, 'adapter_contract')
  } finally {
    current.database.close()
  }
})

test('dead-letter deletion waits until its durable audit can be recorded', async () => {
  const currentJob = job({ tag: 'audit-unavailable' })
  const current = fixture({
    currentJob,
    extractor: async () => { throw new Error('provider unavailable') },
    recordAudit: async () => ({ status: 'unavailable', retryable: true })
  })
  const attemptTimes = [
    '2026-07-19T00:03:00.000Z',
    '2026-07-19T00:03:05.000Z',
    '2026-07-19T00:03:35.000Z',
    '2026-07-19T00:05:35.000Z',
    '2026-07-19T00:15:35.000Z'
  ]
  try {
    await current.queue.enqueue(currentJob)
    for (const attemptTime of attemptTimes) {
      current.setNow(attemptTime)
      await current.worker.runBatch()
    }
    const usage = await current.queue.usage()
    assert.equal(usage.status === 'usage' && usage.pendingRecords === 1, true)
    assert.equal(current.database.prepare(`
      SELECT count(*) AS count FROM memory_candidate_audits
    `).get()?.count, 0)
  } finally {
    current.database.close()
  }
})
