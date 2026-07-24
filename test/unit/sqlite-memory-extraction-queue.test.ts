import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createMemoryExtractionJobV1,
  type MemoryExtractionPriorityV1
} from '../../src/agent/memory/memory-candidate-pipeline.js'
import { MEMORY_DERIVATIVE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  createSqliteMemoryExtractionQueueV1,
  MEMORY_EXTRACTION_SQLITE_APPLICATION_ID_V1,
  MEMORY_EXTRACTION_SQLITE_SCHEMA_VERSION_V1,
  type SqliteMemoryExtractionQueueV1
} from '../../src/agent/memory/sqlite-memory-extraction-queue.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-19T00:03:00.000Z'

function job (
  tag: string,
  priority: MemoryExtractionPriorityV1 = 'inferred',
  source = memorySourceFixture(),
  assistantReply = `候选回复 ${tag}`
) {
  const namespace = personalMemoryNamespaceFixture()
  return createMemoryExtractionJobV1({
    namespace,
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source,
    sceneRef: '1'.repeat(64),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: 'shadow',
    priority,
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply
  })
}

function fixture (): {
  readonly database: DatabaseSync
  readonly queue: SqliteMemoryExtractionQueueV1
  readonly setNow: (value: string) => void
} {
  let now = NOW
  const database = new DatabaseSync(':memory:')
  const queue = createSqliteMemoryExtractionQueueV1({
    database,
    now: () => now,
    leaseToken: () => 'a'.repeat(64)
  })
  return Object.freeze({
    database,
    queue,
    setNow: value => { now = value }
  })
}

test('sqlite extraction queue persists idempotent jobs and credential input never reaches disk', async () => {
  const current = fixture()
  try {
    const candidate = job('idempotent')
    assert.deepEqual(await current.queue.enqueue(candidate), { status: 'stored' })
    assert.deepEqual(await current.queue.enqueue(candidate), { status: 'unchanged' })

    const secret = job('secret', 'inferred', memorySourceFixture({
      normalizedText: 'API key: sk-example-1234567890'
    }))
    assert.deepEqual(await current.queue.enqueue(secret), {
      status: 'rejected', reason: 'credential'
    })
    assert.deepEqual(await current.queue.enqueue(job(
      'assistant-secret',
      'inferred',
      memorySourceFixture(),
      'Authorization: Bearer abcdefghijklmnop'
    )), {
      status: 'rejected', reason: 'credential'
    })
    const usage = await current.queue.usage()
    assert.deepEqual(usage, {
      status: 'usage', pendingRecords: 1, leasedRecords: 0,
      logicalBytes: usage.status === 'usage' ? usage.logicalBytes : -1
    })
    assert.equal(usage.status === 'usage' && usage.logicalBytes > 0, true)
    assert.equal(current.database.prepare(
      'SELECT count(*) AS count FROM memory_extraction_jobs'
    ).get()?.count, 1)
  } finally {
    current.database.close()
  }
})

test('sqlite extraction queue leases in priority order and protects lease ownership', async () => {
  const current = fixture()
  try {
    await current.queue.enqueue(job('low'))
    await current.queue.enqueue(job('high', 'asserted'))
    const claim = await current.queue.claim('worker-1', 2)
    assert.equal(claim.status, 'claimed')
    if (claim.status !== 'claimed') return
    assert.deepEqual(claim.jobs.map(value => value.priority), ['asserted', 'inferred'])
    assert.deepEqual(await current.queue.ack({
      ownerId: 'worker-2', leaseToken: claim.leaseToken, jobId: claim.jobs[0]!.jobId
    }), { status: 'lease_conflict' })
    assert.deepEqual(await current.queue.ack({
      ownerId: 'worker-1', leaseToken: claim.leaseToken, jobId: claim.jobs[0]!.jobId
    }), { status: 'acked' })
    assert.deepEqual(await current.queue.retry({
      ownerId: 'worker-1', leaseToken: claim.leaseToken, jobId: claim.jobs[1]!.jobId,
      retryAt: '2026-07-19T00:03:05.000Z', reasonCode: 'extractor_unavailable'
    }), { status: 'retried', attemptCount: 1 })
  } finally {
    current.database.close()
  }
})

test('queue pressure sheds oldest unleased inferred work for asserted work only', async () => {
  const current = fixture()
  try {
    for (let index = 0; index < MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords; index += 1) {
      assert.equal((await current.queue.enqueue(job(`fill-${index}`))).status, 'stored')
    }
    assert.deepEqual(await current.queue.enqueue(job('overflow-low')), {
      status: 'rejected', reason: 'queue_pressure'
    })
    assert.deepEqual(await current.queue.enqueue(job('overflow-high', 'asserted')), {
      status: 'stored', shedInferredJobs: 1
    })
    const usage = await current.queue.usage()
    assert.equal(usage.status === 'usage' &&
      usage.pendingRecords === MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords, true)
  } finally {
    current.database.close()
  }
})

test('expired leases can be reclaimed after restart-compatible durable time', async () => {
  const current = fixture()
  try {
    await current.queue.enqueue(job('lease'))
    const first = await current.queue.claim('worker-1', 1)
    assert.equal(first.status, 'claimed')
    current.setNow('2026-07-19T00:03:30.001Z')
    const second = await current.queue.claim('worker-2', 1)
    assert.equal(second.status, 'claimed')
    if (second.status === 'claimed') assert.equal(second.jobs.length, 1)
  } finally {
    current.database.close()
  }
})

test('queue reopen verifies its application identity and exact schema before use', () => {
  const current = fixture()
  try {
    assert.equal(current.database.prepare('PRAGMA application_id').get()?.application_id,
      MEMORY_EXTRACTION_SQLITE_APPLICATION_ID_V1)
    assert.equal(current.database.prepare('PRAGMA user_version').get()?.user_version,
      MEMORY_EXTRACTION_SQLITE_SCHEMA_VERSION_V1)
    assert.doesNotThrow(() => createSqliteMemoryExtractionQueueV1({
      database: current.database,
      now: () => NOW,
      leaseToken: () => 'b'.repeat(64)
    }))

    current.database.exec('DROP TRIGGER memory_extraction_jobs_ai_v1')
    assert.throws(() => createSqliteMemoryExtractionQueueV1({
      database: current.database,
      now: () => NOW,
      leaseToken: () => 'c'.repeat(64)
    }))
  } finally {
    current.database.close()
  }
})
