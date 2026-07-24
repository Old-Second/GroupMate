import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  decodeCanonicalMemoryRevisionV1,
  type CanonicalMemoryRevisionV1
} from './memory-canonical-wire.js'
import {
  createMemoryHeadSourcePortV1,
  type MemoryHeadSourcePortV1,
  type MemoryHeadSourceRequestV1,
  type MemoryHeadSourceResultV1,
  type MemoryHeadV1
} from './memory-head-reader.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { MEMORY_CURSOR_HASH_DOMAIN_V1 } from './sqlite-memory-repository.js'

interface CreateSqliteMemoryHeadSourceOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

class CanonicalMemoryHeadDataErrorV1 extends Error {}

function rowValue (
  row: Readonly<Record<string, SQLOutputValue>> | undefined,
  key: string
): SQLOutputValue | undefined {
  if (row === undefined) return undefined
  return Object.getOwnPropertyDescriptor(row, key)?.value as SQLOutputValue | undefined
}

function positiveInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    Object.is(value, -0)) throw new CanonicalMemoryHeadDataErrorV1()
  return value
}

function nonnegativeInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalMemoryHeadDataErrorV1()
  return value
}

function exactString (value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new CanonicalMemoryHeadDataErrorV1()
  return value
}

function nullableString (value: SQLOutputValue | undefined): string | null {
  if (value === null) return null
  return exactString(value)
}

function canonicalHash (value: SQLOutputValue | undefined): string {
  const result = exactString(value)
  if (!/^[0-9a-f]{64}$/.test(result)) throw new CanonicalMemoryHeadDataErrorV1()
  return result
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

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
  value: CreateSqliteMemoryHeadSourceOptionsV1
): CreateSqliteMemoryHeadSourceOptionsV1 {
  const input = inspectMemoryRecord(value, ['database', 'now'])
  if (input.database === null || typeof input.database !== 'object' ||
    utilTypes.isProxy(input.database) || !methodIsDataFunction(input.database, 'prepare') ||
    typeof input.now !== 'function' || utilTypes.isProxy(input.now)) return invalidMemoryValue()
  return Object.freeze({
    database: input.database as DatabaseSync,
    now: input.now as () => string
  })
}

function sqliteErrorNumber (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function sqliteFailure (error: unknown): MemoryHeadSourceResultV1 {
  const errcode = sqliteErrorNumber(error)
  const primary = errcode !== null && errcode >= 0 && errcode <= 0x7fffffff
    ? errcode & 0xff
    : null
  if (primary === 5 || primary === 6) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'busy' as const,
      retryable: true
    })
  }
  if (primary === 10) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'io' as const,
      retryable: true
    })
  }
  if (primary === 11 || primary === 26) {
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  return Object.freeze({
    status: 'unavailable' as const,
    category: 'storage' as const,
    retryable: false
  })
}

function readNamespace (
  database: DatabaseSync,
  request: Extract<MemoryHeadSourceRequestV1, { readonly operation: 'namespace.get' }>
): MemoryHeadSourceResultV1 {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces
    WHERE namespace_ref = ?
  `).get(request.namespaceRef)
  if (row === undefined) return Object.freeze({ status: 'not_found' as const })
  const namespaceGeneration = validateNamespaceRow(row, request.namespaceRef)
  return Object.freeze({
    status: 'found' as const,
    namespaceGeneration
  })
}

interface HeadRowV1 {
  readonly namespaceGeneration: number
  readonly head: MemoryHeadV1 | null
  readonly currentRevisionHash: string | null
  readonly validUntilMs: number | null
  readonly purgeAtMs: number | null
  readonly updatedAtMs: number | null
  readonly cursorRef: string | null
}

function validateNamespaceRow (
  row: Readonly<Record<string, SQLOutputValue>>,
  requestedRef: MemoryNamespaceRefV1
): number {
  const storedRef = exactString(rowValue(row, 'namespace_ref'))
  const wire = exactString(rowValue(row, 'namespace_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'namespace_wire_bytes'))
  if (storedRef !== requestedRef || Buffer.byteLength(wire, 'utf8') !== wireBytes) {
    throw new CanonicalMemoryHeadDataErrorV1()
  }
  let namespace: ReturnType<typeof parseMemoryNamespaceV1>
  try {
    namespace = parseMemoryNamespaceV1(JSON.parse(wire) as unknown)
  } catch {
    throw new CanonicalMemoryHeadDataErrorV1()
  }
  if (memoryNamespaceRefV1(namespace) !== requestedRef ||
    memoryNamespaceWireV1(namespace) !== wire) throw new CanonicalMemoryHeadDataErrorV1()
  return positiveInteger(rowValue(row, 'namespace_generation'))
}

function headStateFromRow (
  row: Readonly<Record<string, SQLOutputValue>>,
  namespaceRef: MemoryNamespaceRefV1,
  memoryId: string
): HeadRowV1 {
  const namespaceGeneration = validateNamespaceRow(row, namespaceRef)
  if (rowValue(row, 'current_revision') === null) {
    if (rowValue(row, 'head_generation') !== null ||
      rowValue(row, 'current_revision_hash') !== null ||
      rowValue(row, 'content_hash') !== null ||
      rowValue(row, 'cursor_ref') !== null ||
      rowValue(row, 'updated_at_ms') !== null ||
      rowValue(row, 'valid_until_ms') !== null ||
      rowValue(row, 'purge_at_ms') !== null) throw new CanonicalMemoryHeadDataErrorV1()
    return Object.freeze({
      namespaceGeneration,
      head: null,
      currentRevisionHash: null,
      validUntilMs: null,
      purgeAtMs: null,
      updatedAtMs: null,
      cursorRef: null
    })
  }
  const headGeneration = positiveInteger(rowValue(row, 'head_generation'))
  if (headGeneration !== namespaceGeneration) throw new CanonicalMemoryHeadDataErrorV1()
  const validUntilMs = nonnegativeInteger(rowValue(row, 'valid_until_ms'))
  const purgeAtMs = nonnegativeInteger(rowValue(row, 'purge_at_ms'))
  if (purgeAtMs < validUntilMs) throw new CanonicalMemoryHeadDataErrorV1()
  return Object.freeze({
    namespaceGeneration,
    head: Object.freeze({
      namespaceRef,
      namespaceGeneration,
      memoryId,
      revision: positiveInteger(rowValue(row, 'current_revision')),
      contentHash: canonicalHash(rowValue(row, 'content_hash'))
    }),
    currentRevisionHash: canonicalHash(rowValue(row, 'current_revision_hash')),
    validUntilMs,
    purgeAtMs,
    updatedAtMs: nonnegativeInteger(rowValue(row, 'updated_at_ms')),
    cursorRef: canonicalHash(rowValue(row, 'cursor_ref'))
  })
}

function loadHeadRow (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  memoryId: string
): HeadRowV1 | null {
  const row = database.prepare(`
    SELECT n.namespace_ref,
           n.namespace_wire,
           n.namespace_wire_bytes,
           n.namespace_generation,
           h.namespace_generation AS head_generation,
           h.current_revision,
           h.current_revision_hash,
           h.content_hash,
           h.cursor_ref,
           h.updated_at_ms,
           h.valid_until_ms,
           h.purge_at_ms
    FROM namespaces AS n
    LEFT JOIN heads AS h
      ON h.namespace_ref = n.namespace_ref
     AND h.namespace_generation = n.namespace_generation
     AND h.memory_id = ?
    WHERE n.namespace_ref = ?
  `).get(memoryId, namespaceRef)
  if (row === undefined) return null
  return headStateFromRow(row, namespaceRef, memoryId)
}

function readHead (
  database: DatabaseSync,
  request: Extract<MemoryHeadSourceRequestV1, { readonly operation: 'head.get' }>,
  nowMs: number
): MemoryHeadSourceResultV1 {
  const state = loadHeadRow(database, request.namespaceRef, request.memoryId)
  if (state === null) return Object.freeze({ status: 'not_found' as const })
  if (state.head === null) {
    return Object.freeze({
      status: 'absent' as const,
      namespaceGeneration: state.namespaceGeneration
    })
  }
  if (state.validUntilMs === null) throw new CanonicalMemoryHeadDataErrorV1()
  return nowMs >= state.validUntilMs
    ? Object.freeze({ status: 'expired' as const, head: state.head })
    : Object.freeze({ status: 'found' as const, head: state.head })
}

function sameHead (left: MemoryHeadV1, right: MemoryHeadV1): boolean {
  return left.namespaceRef === right.namespaceRef &&
    left.namespaceGeneration === right.namespaceGeneration &&
    left.memoryId === right.memoryId &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash
}

function revisionMatchesCanonical (
  revision: CanonicalMemoryRevisionV1,
  requestedHead: MemoryHeadV1,
  state: HeadRowV1,
  row: Readonly<Record<string, SQLOutputValue>>,
  wire: string
): boolean {
  const record = revision.record
  const cursorPreimage = JSON.stringify({
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    updatedAt: record.updatedAt,
    memoryId: record.memoryId,
    currentRevision: record.revision
  })
  const expectedCursorRef = createHash('sha256')
    .update(MEMORY_CURSOR_HASH_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(cursorPreimage, 'utf8')
    .digest('hex')
  return state.head !== null && sameHead(state.head, requestedHead) &&
    revision.memoryId === requestedHead.memoryId &&
    revision.revision === requestedHead.revision &&
    revision.revisionHash === state.currentRevisionHash &&
    revision.operation === exactString(rowValue(row, 'operation')) &&
    revision.revisionHash === canonicalHash(rowValue(row, 'revision_hash')) &&
    revision.previousRevisionHash === nullableString(rowValue(row, 'previous_revision_hash')) &&
    Date.parse(revision.changedAt) === nonnegativeInteger(rowValue(row, 'changed_at_ms')) &&
    Buffer.byteLength(wire, 'utf8') === positiveInteger(rowValue(row, 'revision_wire_bytes')) &&
    record.namespaceRef === requestedHead.namespaceRef &&
    record.namespaceGeneration === requestedHead.namespaceGeneration &&
    record.memoryId === requestedHead.memoryId &&
    record.revision === requestedHead.revision &&
    record.contentHash === requestedHead.contentHash &&
    Date.parse(record.updatedAt) === state.updatedAtMs &&
    expectedCursorRef === state.cursorRef &&
    Date.parse(record.retention.validUntil) === state.validUntilMs &&
    Date.parse(record.retention.purgeAt) === state.purgeAtMs
}

function readExactRecord (
  database: DatabaseSync,
  request: Extract<MemoryHeadSourceRequestV1, { readonly operation: 'record.getExact' }>,
  nowMs: number
): MemoryHeadSourceResultV1 {
  const row = database.prepare(`
    SELECT n.namespace_ref,
           n.namespace_wire,
           n.namespace_wire_bytes,
           n.namespace_generation,
           h.namespace_generation AS head_generation,
           h.current_revision,
           h.current_revision_hash,
           h.content_hash,
           h.cursor_ref,
           h.updated_at_ms,
           h.valid_until_ms,
           h.purge_at_ms,
           r.operation,
           r.revision_hash,
           r.previous_revision_hash,
           r.changed_at_ms,
           r.revision_wire_bytes,
           p.revision_wire
    FROM namespaces AS n
    LEFT JOIN heads AS h
      ON h.namespace_ref = n.namespace_ref
     AND h.namespace_generation = n.namespace_generation
     AND h.memory_id = ?
    LEFT JOIN revisions AS r
      ON r.namespace_ref = h.namespace_ref
     AND r.namespace_generation = h.namespace_generation
     AND r.memory_id = h.memory_id
     AND r.revision = h.current_revision
    LEFT JOIN revision_payloads AS p
      ON p.namespace_ref = r.namespace_ref
     AND p.namespace_generation = r.namespace_generation
     AND p.memory_id = r.memory_id
     AND p.revision = r.revision
    WHERE n.namespace_ref = ?
  `).get(request.head.memoryId, request.head.namespaceRef)
  if (row === undefined) return Object.freeze({ status: 'stale' as const })
  const state = headStateFromRow(
    row,
    request.head.namespaceRef,
    request.head.memoryId
  )
  if (state.head === null || !sameHead(state.head, request.head)) {
    return Object.freeze({ status: 'stale' as const })
  }
  if (state.validUntilMs === null) throw new CanonicalMemoryHeadDataErrorV1()
  if (nowMs >= state.validUntilMs) return Object.freeze({ status: 'expired' as const })
  if (rowValue(row, 'revision_wire') === null) {
    throw new CanonicalMemoryHeadDataErrorV1()
  }
  const wire = exactString(rowValue(row, 'revision_wire'))
  let revision: CanonicalMemoryRevisionV1
  try {
    revision = decodeCanonicalMemoryRevisionV1(wire)
  } catch {
    throw new CanonicalMemoryHeadDataErrorV1()
  }
  if (!revisionMatchesCanonical(revision, request.head, state, row, wire)) {
    throw new CanonicalMemoryHeadDataErrorV1()
  }
  return Object.freeze({ status: 'found' as const, record: revision.record })
}

export function createSqliteMemoryHeadSourceV1 (
  optionsValue: CreateSqliteMemoryHeadSourceOptionsV1
): MemoryHeadSourcePortV1 {
  const options = parseOptions(optionsValue)
  return createMemoryHeadSourcePortV1({
    execute: async (request, signal) => {
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      try {
        if (request.operation === 'namespace.get') {
          const result = readNamespace(options.database, request)
          return result
        }
        const now = canonicalInstant(Reflect.apply(options.now, undefined, []))
        const nowMs = Date.parse(now)
        const result = request.operation === 'head.get'
          ? readHead(options.database, request, nowMs)
          : readExactRecord(options.database, request, nowMs)
        return result
      } catch (error) {
        if (error instanceof CanonicalMemoryHeadDataErrorV1) {
          return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
        }
        return sqliteFailure(error)
      }
    }
  })
}
