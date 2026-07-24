import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  assertSqliteMemoryFts5AvailableV1,
  MEMORY_LEXICAL_SQLITE_APPLICATION_ID_V1,
  MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1,
  MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1,
  openSqliteMemoryLexicalDatabaseV1,
  SqliteMemoryLexicalDatabaseErrorV1,
  sqliteMemoryLexicalSchemaFingerprintV1
} from '../../src/agent/memory/sqlite-memory-lexical-database.js'

const NOW = '2026-07-25T00:02:00.000Z'

function temporaryDatabasePath (t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-fts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'memory-lexical.sqlite')
}

test('lexical SQLite is independent, bounded and keeps FTS shadow tables outside its fingerprint', t => {
  const location = temporaryDatabasePath(t)
  const store = openSqliteMemoryLexicalDatabaseV1({ location, now: () => NOW })
  try {
    assert.equal(MEMORY_LEXICAL_SQLITE_SCHEMA_VERSION_V1, 1)
    assert.equal(store.database.prepare('PRAGMA application_id').get()?.application_id,
      MEMORY_LEXICAL_SQLITE_APPLICATION_ID_V1)
    assert.equal(
      sqliteMemoryLexicalSchemaFingerprintV1(store.database),
      MEMORY_LEXICAL_SQLITE_SCHEMA_FINGERPRINT_V1
    )
    const names = store.database.prepare(`
      SELECT name FROM sqlite_schema ORDER BY name ASC
    `).all().map(row => String(row.name))
    assert.ok(names.includes('memory_lexical_search'))
    assert.ok(names.some(name => name.startsWith('memory_lexical_search_')))
    assert.deepEqual({ ...store.database.prepare(`
      SELECT status, projection_generation, source_last_sequence,
        indexed_records, indexed_logical_bytes
      FROM lexical_index_state WHERE singleton = 1
    `).get() }, {
      status: 'empty',
      projection_generation: 0,
      source_last_sequence: 0,
      indexed_records: 0,
      indexed_logical_bytes: 0
    })

    store.database.prepare(`
      UPDATE lexical_index_state
      SET status = 'rebuilding', projection_generation = 1
      WHERE singleton = 1
    `).run()

    store.database.prepare(`
      INSERT INTO lexical_documents(
        namespace_ref, namespace_generation, memory_id, memory_revision,
        revision_hash, body, body_bytes, updated_at_ms
      ) VALUES (?, 1, ?, 1, ?, ?, ?, ?)
    `).run(
      'a'.repeat(64), 'memory:one', 'b'.repeat(64),
      '喜欢火锅，也喜欢 TypeScript', Buffer.byteLength('喜欢火锅，也喜欢 TypeScript'),
      Date.parse(NOW)
    )
    const hit = store.database.prepare(`
      SELECT rowid FROM memory_lexical_search
      WHERE memory_lexical_search MATCH ?
    `).get('TypeScript')
    assert.equal(typeof hit?.rowid, 'number')
    assert.deepEqual({ ...store.database.prepare(`
      SELECT indexed_records, indexed_logical_bytes
      FROM lexical_index_state WHERE singleton = 1
    `).get() }, {
      indexed_records: 1,
      indexed_logical_bytes: Buffer.byteLength('喜欢火锅，也喜欢 TypeScript')
    })
  } finally {
    store.close()
  }

  const reopened = openSqliteMemoryLexicalDatabaseV1({
    location,
    now: () => { throw new Error('reopen must not request creation time') }
  })
  reopened.database.exec('PRAGMA ignore_check_constraints = ON')
  reopened.database.prepare(`
    UPDATE lexical_index_state
    SET status = 'ready', projection_generation = 0
    WHERE singleton = 1
  `).run()
  reopened.close()
  assert.throws(() => openSqliteMemoryLexicalDatabaseV1({
    location,
    now: () => { throw new Error('state-tampered reopen must not request time') }
  }), error => error instanceof SqliteMemoryLexicalDatabaseErrorV1 &&
    error.code === 'memory_lexical_schema_unsupported')
})

test('lexical SQLite reports FTS5 absence with a fixed error and rejects schema tampering', t => {
  assert.throws(() => assertSqliteMemoryFts5AvailableV1(() => {
    throw new Error('no such module: fts5')
  }), error => error instanceof SqliteMemoryLexicalDatabaseErrorV1 &&
    error.code === 'memory_fts_unavailable')

  const location = temporaryDatabasePath(t)
  const store = openSqliteMemoryLexicalDatabaseV1({ location, now: () => NOW })
  store.database.exec('CREATE TABLE attacker(value TEXT)')
  store.close()
  assert.throws(() => openSqliteMemoryLexicalDatabaseV1({
    location,
    now: () => { throw new Error('tampered reopen must not request time') }
  }), error => error instanceof SqliteMemoryLexicalDatabaseErrorV1 &&
    error.code === 'memory_lexical_schema_unsupported')
})

test('lexical SQLite constraints cap indexed bodies and accounting', () => {
  const store = openSqliteMemoryLexicalDatabaseV1({
    location: ':memory:', now: () => NOW
  })
  try {
    assert.throws(() => store.database.prepare(`
      INSERT INTO lexical_documents(
        namespace_ref, namespace_generation, memory_id, memory_revision,
        revision_hash, body, body_bytes, updated_at_ms
      ) VALUES (?, 1, ?, 1, ?, ?, ?, 0)
    `).run(
      'a'.repeat(64), 'memory:large', 'b'.repeat(64),
      'x'.repeat(4097), 4097
    ))
    store.database.prepare(`
      UPDATE lexical_index_state
      SET status = 'rebuilding', projection_generation = 1,
        indexed_records = 32768
      WHERE singleton = 1
    `).run()
    assert.throws(() => store.database.prepare(`
      INSERT INTO lexical_documents(
        namespace_ref, namespace_generation, memory_id, memory_revision,
        revision_hash, body, body_bytes, updated_at_ms
      ) VALUES (?, 1, ?, 1, ?, 'ok', 2, 0)
    `).run('a'.repeat(64), 'memory:overflow', 'b'.repeat(64)))
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM lexical_documents
    `).get()?.count, 0)
    store.database.prepare('DELETE FROM lexical_index_state WHERE singleton = 1').run()
    assert.throws(() => store.database.prepare(`
      INSERT INTO lexical_documents(
        namespace_ref, namespace_generation, memory_id, memory_revision,
        revision_hash, body, body_bytes, updated_at_ms
      ) VALUES (?, 1, ?, 1, ?, 'ok', 2, 0)
    `).run('a'.repeat(64), 'memory:no-state', 'b'.repeat(64)))
    assert.equal(store.database.prepare(`
      SELECT count(*) AS count FROM lexical_documents
    `).get()?.count, 0)
  } finally {
    store.close()
  }
})
