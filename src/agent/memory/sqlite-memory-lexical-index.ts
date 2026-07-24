import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types as utilTypes } from 'node:util'
import {
  parseCanonicalMemoryRecordV1,
  type CanonicalMemoryRecordV1
} from './memory-canonical-wire.js'
import {
  createMemoryLexicalIndexPortV1,
  memoryLexicalBodyHashV1,
  type MemoryLexicalIndexPortV1,
  type MemoryLexicalSearchRequestV1,
  type MemoryLexicalSearchHitV1,
  type MemoryLexicalSearchResultV1
} from './memory-lexical-index.js'
import {
  normalizeMemoryLexicalTextV1,
  type MemoryLexicalTransliteratorV1
} from './memory-lexical-normalizer.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'

interface CreateSqliteMemoryLexicalIndexOptionsV1 {
  readonly database: DatabaseSync
  readonly transliterator?: MemoryLexicalTransliteratorV1
}

interface MemoryLexicalProjectionEntryV1 {
  readonly record: CanonicalMemoryRecordV1
  readonly revisionHash: string
}

interface MemoryLexicalProjectionV1 {
  readonly projectionGeneration: number
  readonly sourceLastSequence: number
  readonly updatedAt: string
  readonly documents: readonly MemoryLexicalProjectionEntryV1[]
}

export interface SqliteMemoryLexicalIndexV1 extends MemoryLexicalIndexPortV1 {
  readonly beginProjection: (value: unknown) => void
  readonly applyProjectionBatch: (value: unknown) => void
  readonly completeProjection: (value: unknown) => void
  readonly replaceProjection: (value: unknown) => void
}

export const MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1 = 32

const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const LEXICAL_CONTENT = /[A-Za-z0-9\p{Script=Han}\p{Extended_Pictographic}]/u

function methodIsDataFunction (value: object, name: string): boolean {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' &&
        !utilTypes.isProxy(descriptor.value)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

function parseOptions (
  value: CreateSqliteMemoryLexicalIndexOptionsV1
): CreateSqliteMemoryLexicalIndexOptionsV1 {
  const input = inspectMemoryRecord(value, ['database'], ['transliterator'])
  if (input.database === null || typeof input.database !== 'object' ||
    utilTypes.isProxy(input.database) ||
    !methodIsDataFunction(input.database, 'prepare') ||
    !methodIsDataFunction(input.database, 'exec')) return invalidMemoryValue()
  if (input.transliterator !== undefined && (
    input.transliterator === null || typeof input.transliterator !== 'object' ||
    utilTypes.isProxy(input.transliterator)
  )) return invalidMemoryValue()
  return Object.freeze({
    database: input.database as DatabaseSync,
    ...(input.transliterator === undefined
      ? {}
      : { transliterator: input.transliterator as MemoryLexicalTransliteratorV1 })
  })
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function positiveInteger (value: unknown): number {
  const parsed = nonnegativeInteger(value)
  if (parsed === 0) return invalidMemoryValue()
  return parsed
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function canonicalHash (value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return invalidMemoryValue()
  return value
}

function parseProjection (value: unknown): MemoryLexicalProjectionV1 {
  const input = inspectMemoryRecord(value, [
    'projectionGeneration', 'sourceLastSequence', 'updatedAt', 'documents'
  ])
  const documents = inspectMemoryArray(
    input.documents,
    MEMORY_LEXICAL_PROJECTION_BATCH_RECORDS_V1
  ).map(value => {
    const entry = inspectMemoryRecord(value, ['record', 'revisionHash'])
    const record = parseCanonicalMemoryRecordV1(entry.record)
    if (!MEMORY_ID.test(record.memoryId)) return invalidMemoryValue()
    return Object.freeze({
      record,
      revisionHash: canonicalHash(entry.revisionHash)
    })
  })
  const identities = documents.map(({ record }) => (
    `${record.namespaceRef}\0${record.namespaceGeneration}\0${record.memoryId}`
  ))
  if (new Set(identities).size !== identities.length) return invalidMemoryValue()
  return Object.freeze({
    projectionGeneration: positiveInteger(input.projectionGeneration),
    sourceLastSequence: nonnegativeInteger(input.sourceLastSequence),
    updatedAt: canonicalInstant(input.updatedAt),
    documents: Object.freeze(documents)
  })
}

function parseProjectionControl (value: unknown): Readonly<{
  readonly projectionGeneration: number
  readonly sourceLastSequence: number
  readonly updatedAt: string
}> {
  const input = inspectMemoryRecord(value, [
    'projectionGeneration', 'sourceLastSequence', 'updatedAt'
  ])
  return Object.freeze({
    projectionGeneration: positiveInteger(input.projectionGeneration),
    sourceLastSequence: nonnegativeInteger(input.sourceLastSequence),
    updatedAt: canonicalInstant(input.updatedAt)
  })
}

function stateValue (value: SQLOutputValue | undefined): 'fresh' | 'rebuilding' {
  if (value === 'empty' || value === 'ready') return 'fresh'
  if (value === 'rebuilding') return 'rebuilding'
  return invalidMemoryValue()
}

function searchResult (
  options: CreateSqliteMemoryLexicalIndexOptionsV1,
  request: MemoryLexicalSearchRequestV1
): MemoryLexicalSearchResultV1 {
  const state = options.database.prepare(`
    SELECT status, source_last_sequence
    FROM lexical_index_state WHERE singleton = 1
  `).get()
  if (state === undefined || typeof state.source_last_sequence !== 'number' ||
    !Number.isSafeInteger(state.source_last_sequence) || state.source_last_sequence < 0) {
    return invalidMemoryValue()
  }
  let normalized: ReturnType<typeof normalizeMemoryLexicalTextV1>
  try {
    normalized = normalizeMemoryLexicalTextV1(request.queryText, {
      ...(options.transliterator === undefined
        ? {}
        : { transliterator: options.transliterator })
    })
  } catch {
    return Object.freeze({
      status: 'completed' as const,
      state: stateValue(state.status),
      watermark: String(state.source_last_sequence),
      hits: Object.freeze([])
    })
  }
  const placeholders = request.namespaceRefs.map(() => '?').join(', ')
  const rows = options.database.prepare(`
    SELECT d.namespace_ref, d.namespace_generation, d.memory_id,
      d.memory_revision, d.revision_hash, d.updated_at_ms, d.body,
      bm25(memory_lexical_search) AS lexical_score
    FROM memory_lexical_search
    JOIN lexical_documents AS d
      ON d.document_id = memory_lexical_search.rowid
    WHERE memory_lexical_search MATCH ?
      AND d.namespace_ref IN (${placeholders})
    ORDER BY lexical_score ASC, d.updated_at_ms DESC, d.document_id ASC
    LIMIT ?
  `).all(normalized.query, ...request.namespaceRefs, request.maxHits)
  const hits: MemoryLexicalSearchHitV1[] = rows.map((row, index) => {
    if (typeof row.namespace_ref !== 'string' ||
      typeof row.namespace_generation !== 'number' ||
      typeof row.memory_id !== 'string' || typeof row.memory_revision !== 'number' ||
      typeof row.revision_hash !== 'string' || typeof row.updated_at_ms !== 'number' ||
      typeof row.body !== 'string' || typeof row.lexical_score !== 'number' ||
      !Number.isFinite(row.lexical_score)) return invalidMemoryValue()
    return Object.freeze({
      namespaceRef: row.namespace_ref as never,
      namespaceGeneration: row.namespace_generation,
      memoryId: row.memory_id,
      memoryRevision: row.memory_revision,
      revisionHash: row.revision_hash,
      bodyHash: memoryLexicalBodyHashV1(row.body),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
      exactMatch: row.body === normalized.body,
      lexicalRank: index + 1,
      bm25: row.lexical_score
    })
  })
  hits.sort((left, right) => Number(right.exactMatch) - Number(left.exactMatch) ||
    left.lexicalRank - right.lexicalRank)
  return Object.freeze({
    status: 'completed' as const,
    state: stateValue(state.status),
    watermark: String(state.source_last_sequence),
    hits: Object.freeze(hits)
  })
}

export function createSqliteMemoryLexicalIndexV1 (
  optionsValue: CreateSqliteMemoryLexicalIndexOptionsV1
): SqliteMemoryLexicalIndexV1 {
  const options = parseOptions(optionsValue)
  const port = createMemoryLexicalIndexPortV1({
    search: async request => searchResult(options, request)
  })
  const insertDocuments = (documents: readonly MemoryLexicalProjectionEntryV1[]): void => {
    const insert = options.database.prepare(`
      INSERT INTO lexical_documents(
        namespace_ref, namespace_generation, memory_id, memory_revision,
        revision_hash, body, body_bytes, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace_ref, namespace_generation, memory_id) DO UPDATE SET
        memory_revision = excluded.memory_revision,
        revision_hash = excluded.revision_hash,
        body = excluded.body,
        body_bytes = excluded.body_bytes,
        updated_at_ms = excluded.updated_at_ms
    `)
    for (const { record, revisionHash } of documents) {
      if (!LEXICAL_CONTENT.test(record.text)) continue
      const normalized = normalizeMemoryLexicalTextV1(record.text, {
        ...(options.transliterator === undefined
          ? {}
          : { transliterator: options.transliterator })
      })
      insert.run(
        record.namespaceRef,
        record.namespaceGeneration,
        record.memoryId,
        record.revision,
        revisionHash,
        normalized.body,
        Buffer.byteLength(normalized.body, 'utf8'),
        Date.parse(record.updatedAt)
      )
    }
  }
  const beginProjection = (value: unknown): void => {
    const projection = parseProjectionControl(value)
    let started = false
    try {
      options.database.exec('BEGIN IMMEDIATE')
      started = true
      const currentState = options.database.prepare(`
        SELECT projection_generation
        FROM lexical_index_state WHERE singleton = 1
      `).get()
      if (currentState === undefined ||
        typeof currentState.projection_generation !== 'number' ||
        !Number.isSafeInteger(currentState.projection_generation) ||
        projection.projectionGeneration <= currentState.projection_generation) {
        return invalidMemoryValue()
      }
      options.database.prepare(`
        UPDATE lexical_index_state
        SET status = 'rebuilding', projection_generation = ?,
          source_last_sequence = 0, updated_at_ms = ?
        WHERE singleton = 1
      `).run(projection.projectionGeneration, Date.parse(projection.updatedAt))
      options.database.exec('DELETE FROM lexical_documents')
      options.database.exec('COMMIT')
      started = false
    } catch (error) {
      if (started) {
        try {
          options.database.exec('ROLLBACK')
        } catch {}
      }
      throw error
    }
  }
  const applyProjectionBatch = (value: unknown): void => {
    const projection = parseProjection(value)
    let started = false
    try {
      options.database.exec('BEGIN IMMEDIATE')
      started = true
      const state = options.database.prepare(`
        SELECT status, projection_generation, source_last_sequence
        FROM lexical_index_state WHERE singleton = 1
      `).get()
      if (state?.status !== 'rebuilding' ||
        state.projection_generation !== projection.projectionGeneration ||
        typeof state.source_last_sequence !== 'number' ||
        !Number.isSafeInteger(state.source_last_sequence) ||
        projection.sourceLastSequence < state.source_last_sequence) {
        return invalidMemoryValue()
      }
      insertDocuments(projection.documents)
      options.database.prepare(`
        UPDATE lexical_index_state
        SET source_last_sequence = ?, updated_at_ms = max(updated_at_ms, ?)
        WHERE singleton = 1
      `).run(projection.sourceLastSequence, Date.parse(projection.updatedAt))
      options.database.exec('COMMIT')
      started = false
    } catch (error) {
      if (started) {
        try {
          options.database.exec('ROLLBACK')
        } catch {}
      }
      throw error
    }
  }
  const completeProjection = (value: unknown): void => {
    const projection = parseProjectionControl(value)
    let started = false
    try {
      options.database.exec('BEGIN IMMEDIATE')
      started = true
      const state = options.database.prepare(`
        SELECT status, projection_generation, source_last_sequence
        FROM lexical_index_state WHERE singleton = 1
      `).get()
      if (state?.status !== 'rebuilding' ||
        state.projection_generation !== projection.projectionGeneration ||
        typeof state.source_last_sequence !== 'number' ||
        !Number.isSafeInteger(state.source_last_sequence) ||
        projection.sourceLastSequence < state.source_last_sequence) {
        return invalidMemoryValue()
      }
      options.database.prepare(`
        UPDATE lexical_index_state
        SET status = 'ready', source_last_sequence = ?,
          updated_at_ms = max(updated_at_ms, ?)
        WHERE singleton = 1
      `).run(projection.sourceLastSequence, Date.parse(projection.updatedAt))
      options.database.exec('COMMIT')
      started = false
    } catch (error) {
      if (started) {
        try {
          options.database.exec('ROLLBACK')
        } catch {}
      }
      throw error
    }
  }
  const replaceProjection = (value: unknown): void => {
    const projection = parseProjection(value)
    let started = false
    try {
      options.database.exec('BEGIN IMMEDIATE')
      started = true
      const currentState = options.database.prepare(`
        SELECT projection_generation
        FROM lexical_index_state WHERE singleton = 1
      `).get()
      if (currentState === undefined ||
        typeof currentState.projection_generation !== 'number' ||
        !Number.isSafeInteger(currentState.projection_generation) ||
        projection.projectionGeneration <= currentState.projection_generation) {
        return invalidMemoryValue()
      }
      options.database.prepare(`
        UPDATE lexical_index_state
        SET status = 'rebuilding', projection_generation = ?,
          source_last_sequence = 0, updated_at_ms = ?
        WHERE singleton = 1
      `).run(projection.projectionGeneration, Date.parse(projection.updatedAt))
      options.database.exec('DELETE FROM lexical_documents')
      insertDocuments(projection.documents)
      options.database.prepare(`
        UPDATE lexical_index_state
        SET status = 'ready', source_last_sequence = ?,
          updated_at_ms = max(updated_at_ms, ?)
        WHERE singleton = 1
      `).run(projection.sourceLastSequence, Date.parse(projection.updatedAt))
      options.database.exec('COMMIT')
      started = false
    } catch (error) {
      if (started) {
        try {
          options.database.exec('ROLLBACK')
        } catch {
          // The projection failure remains authoritative.
        }
      }
      throw error
    }
  }
  return Object.freeze({
    search: port.search,
    beginProjection,
    applyProjectionBatch,
    completeProjection,
    replaceProjection
  })
}
