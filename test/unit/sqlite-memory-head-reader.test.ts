import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSqliteMemoryHeadSourceV1
} from '../../src/agent/memory/sqlite-memory-head-reader.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memoryRecordFixture
} from '../helpers/memory-fixture.js'
import {
  correctedRevisionV1,
  createSqliteMemoryRepositoryHarnessV1,
  recordCorrectRequestV1,
  recordCreateRequestV1
} from '../helpers/sqlite-memory-repository-fixture.js'

function head (record = memoryRecordFixture()) {
  return {
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: record.revision,
    contentHash: record.contentHash
  }
}

test('sqlite head source reads namespace and head metadata without loading a body', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => FIXTURE_TIMES.observedAt
    })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'namespace.get',
      namespaceRef: harness.namespaceRef
    }), { status: 'found', namespaceGeneration: 1 })
    harness.store.database.prepare('DELETE FROM revision_payloads').run()
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: harness.namespaceRef,
      memoryId: FIXTURE_IDS.memoryId
    }), { status: 'found', head: head() })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: head()
    }), { status: 'corrupt', category: 'canonical_data' })
  } finally {
    harness.close()
  }
})

test('sqlite head source loads and cross-checks the exact canonical revision', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const record = memoryRecordFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => FIXTURE_TIMES.observedAt
    })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: head(record)
    }), { status: 'found', record })
  } finally {
    harness.close()
  }
})

test('sqlite head source excludes a record at the exact valid-until boundary', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const record = memoryRecordFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => record.retention.validUntil
    })
    const expectedHead = head(record)
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: record.namespaceRef,
      memoryId: record.memoryId
    }), { status: 'expired', head: expectedHead })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: expectedHead
    }), { status: 'expired' })
  } finally {
    harness.close()
  }
})

test('sqlite head source proves the current generation and rejects an old-generation exact head', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const record = memoryRecordFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    harness.store.database.prepare(`
      UPDATE namespaces SET namespace_generation = 2, updated_at_ms = updated_at_ms + 1
      WHERE namespace_ref = ?
    `).run(record.namespaceRef)
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => FIXTURE_TIMES.observedAt
    })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: record.namespaceRef,
      memoryId: record.memoryId
    }), { status: 'absent', namespaceGeneration: 2 })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: head(record)
    }), { status: 'stale' })
  } finally {
    harness.close()
  }
})

test('sqlite head source detects a correction race and never falls back to the old revision', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const oldRecord = memoryRecordFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => FIXTURE_TIMES.observedAt
    })
    const oldHead = head(oldRecord)
    assert.equal((await harness.repository.execute(recordCorrectRequestV1(
      harness,
      correctedRevisionV1()
    ))).status, 'stored')
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: oldHead
    }), { status: 'stale' })

    const current = correctedRevisionV1().record
    harness.store.database.prepare(`
      DELETE FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ? AND revision = ?
    `).run(current.namespaceRef, 1, current.memoryId, 2)
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: head(current)
    }), { status: 'corrupt', category: 'canonical_data' })
  } finally {
    harness.close()
  }
})

test('sqlite head source fails closed for missing revisions and mismatched head metadata', async () => {
  const corruptions = [
    (database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']) => {
      database.exec('PRAGMA foreign_keys = OFF')
      database.prepare('DELETE FROM revisions').run()
      database.exec('PRAGMA foreign_keys = ON')
    },
    (database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']) => {
      database.prepare('UPDATE heads SET current_revision_hash = ?').run('f'.repeat(64))
    },
    (database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']) => {
      database.prepare('UPDATE heads SET content_hash = ?').run('f'.repeat(64))
    },
    (database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']) => {
      database.prepare('UPDATE heads SET cursor_ref = ?').run('f'.repeat(64))
    },
    (database: ReturnType<typeof createSqliteMemoryRepositoryHarnessV1>['store']['database']) => {
      database.prepare('UPDATE heads SET updated_at_ms = updated_at_ms + 1').run()
    }
  ]
  for (const corrupt of corruptions) {
    const harness = createSqliteMemoryRepositoryHarnessV1()
    try {
      const record = memoryRecordFixture()
      assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
      corrupt(harness.store.database)
      const source = createSqliteMemoryHeadSourceV1({
        database: harness.store.database,
        now: () => FIXTURE_TIMES.observedAt
      })
      const currentHead = await source.execute({
        schemaVersion: 1,
        operation: 'head.get',
        namespaceRef: record.namespaceRef,
        memoryId: record.memoryId
      })
      if (currentHead.status === 'found' && 'head' in currentHead) {
        assert.deepEqual(await source.execute({
          schemaVersion: 1,
          operation: 'record.getExact',
          head: currentHead.head
        }), { status: 'corrupt', category: 'canonical_data' })
      } else {
        assert.deepEqual(currentHead, { status: 'corrupt', category: 'canonical_data' })
      }
    } finally {
      harness.close()
    }
  }
})

test('sqlite head source rejects hostile exact options without querying', () => {
  let getterCalls = 0
  const hostile = Object.defineProperty({}, 'database', {
    enumerable: true,
    get () {
      getterCalls += 1
      return {}
    }
  })
  assert.throws(() => createSqliteMemoryHeadSourceV1(hostile as never), TypeError)
  assert.throws(() => createSqliteMemoryHeadSourceV1(new Proxy({
    database: {},
    now: () => FIXTURE_TIMES.observedAt
  }, {}) as never), TypeError)
  assert.equal(getterCalls, 0)
})

test('sqlite head source rejects canonical namespace wire drift before returning metadata or body', async () => {
  const harness = createSqliteMemoryRepositoryHarnessV1()
  try {
    const record = memoryRecordFixture()
    assert.equal((await harness.repository.execute(recordCreateRequestV1(harness))).status, 'stored')
    harness.store.database.prepare(`
      UPDATE namespaces SET namespace_wire = ?, namespace_wire_bytes = ?
      WHERE namespace_ref = ?
    `).run('{}', 2, record.namespaceRef)
    const source = createSqliteMemoryHeadSourceV1({
      database: harness.store.database,
      now: () => FIXTURE_TIMES.observedAt
    })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'namespace.get',
      namespaceRef: record.namespaceRef
    }), { status: 'corrupt', category: 'canonical_data' })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: record.namespaceRef,
      memoryId: record.memoryId
    }), { status: 'corrupt', category: 'canonical_data' })
    assert.deepEqual(await source.execute({
      schemaVersion: 1,
      operation: 'record.getExact',
      head: head(record)
    }), { status: 'corrupt', category: 'canonical_data' })
  } finally {
    harness.close()
  }
})
