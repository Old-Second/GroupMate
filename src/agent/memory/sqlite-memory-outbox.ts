import { randomBytes } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { decodeMemoryOutboxEventV1 } from './memory-codec.js'
import type { MemoryOutboxEventV1 } from './memory-domain.js'
import {
  createMemoryOutboxPortV1,
  type MemoryOutboxPortV1,
  type MemoryOutboxRequestV1,
  type MemoryOutboxResultV1
} from './memory-outbox.js'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'

export const SQLITE_MEMORY_OUTBOX_LEASE_DURATION_MS_V1 = 60_000
export const SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 = 16

interface CreateSqliteMemoryOutboxOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

interface UsageStateV1 {
  readonly pendingProposalRecords: number
  readonly activeMemoryRecords: number
  readonly retainedRevisionRecords: number
  readonly tombstoneRecords: number
  readonly canonicalLogicalBytes: number
  readonly pendingOutboxRecords: number
  readonly outboxLogicalBytes: number
}

interface GlobalUsageStateV1 {
  readonly namespaceRecords: number
  readonly activeMemoryRecords: number
  readonly canonicalLogicalBytes: number
  readonly pendingOutboxRecords: number
  readonly outboxLogicalBytes: number
}

interface ClaimedRowV1 {
  readonly event: MemoryOutboxEventV1
  readonly logicalBytes: number
}

class CanonicalMemoryOutboxDataErrorV1 extends Error {}

function rowValue (
  row: Readonly<Record<string, SQLOutputValue>> | undefined,
  key: string
): SQLOutputValue | undefined {
  if (row === undefined) return undefined
  return Object.getOwnPropertyDescriptor(row, key)?.value as SQLOutputValue | undefined
}

function exactInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalMemoryOutboxDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue | undefined): number {
  const result = exactInteger(value)
  if (result === 0) throw new CanonicalMemoryOutboxDataErrorV1()
  return result
}

function exactString (value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new CanonicalMemoryOutboxDataErrorV1()
  return value
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== value) return invalidMemoryValue()
  return value
}

function nowInstant (now: () => string): string {
  let value: unknown
  try {
    value = Reflect.apply(now, undefined, [])
  } catch {
    return invalidMemoryValue()
  }
  return canonicalInstant(value)
}

function parseOptions (
  value: CreateSqliteMemoryOutboxOptionsV1
): CreateSqliteMemoryOutboxOptionsV1 {
  const input = inspectMemoryRecord(value, ['database', 'now'])
  const database = input.database
  if (database === null || typeof database !== 'object' || utilTypes.isProxy(database) ||
    typeof (database as DatabaseSync).prepare !== 'function' ||
    typeof (database as DatabaseSync).exec !== 'function' ||
    typeof input.now !== 'function') return invalidMemoryValue()
  return Object.freeze({
    database: database as DatabaseSync,
    now: input.now as () => string
  })
}

function loadUsage (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number
): UsageStateV1 {
  const row = database.prepare(`
    SELECT pending_proposal_records, active_memory_records, retained_revision_records,
           tombstone_records, canonical_logical_bytes, pending_outbox_records,
           outbox_logical_bytes
    FROM usage
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).get(namespaceRef, generation)
  if (row === undefined) throw new CanonicalMemoryOutboxDataErrorV1()
  return Object.freeze({
    pendingProposalRecords: exactInteger(rowValue(row, 'pending_proposal_records')),
    activeMemoryRecords: exactInteger(rowValue(row, 'active_memory_records')),
    retainedRevisionRecords: exactInteger(rowValue(row, 'retained_revision_records')),
    tombstoneRecords: exactInteger(rowValue(row, 'tombstone_records')),
    canonicalLogicalBytes: exactInteger(rowValue(row, 'canonical_logical_bytes')),
    pendingOutboxRecords: exactInteger(rowValue(row, 'pending_outbox_records')),
    outboxLogicalBytes: exactInteger(rowValue(row, 'outbox_logical_bytes'))
  })
}

function loadGlobalUsage (database: DatabaseSync): GlobalUsageStateV1 {
  const row = database.prepare(`
    SELECT namespace_records, active_memory_records, canonical_logical_bytes,
           pending_outbox_records, outbox_logical_bytes
    FROM global_usage
    WHERE singleton = 1
  `).get()
  if (row === undefined) throw new CanonicalMemoryOutboxDataErrorV1()
  return Object.freeze({
    namespaceRecords: exactInteger(rowValue(row, 'namespace_records')),
    activeMemoryRecords: exactInteger(rowValue(row, 'active_memory_records')),
    canonicalLogicalBytes: exactInteger(rowValue(row, 'canonical_logical_bytes')),
    pendingOutboxRecords: exactInteger(rowValue(row, 'pending_outbox_records')),
    outboxLogicalBytes: exactInteger(rowValue(row, 'outbox_logical_bytes'))
  })
}

function storeUsage (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  usage: UsageStateV1,
  nowMs: number
): void {
  const result = database.prepare(`
    UPDATE usage
    SET pending_proposal_records = ?, active_memory_records = ?,
        retained_revision_records = ?, tombstone_records = ?,
        canonical_logical_bytes = ?, pending_outbox_records = ?,
        outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(
    usage.pendingProposalRecords,
    usage.activeMemoryRecords,
    usage.retainedRevisionRecords,
    usage.tombstoneRecords,
    usage.canonicalLogicalBytes,
    usage.pendingOutboxRecords,
    usage.outboxLogicalBytes,
    nowMs,
    namespaceRef,
    generation
  )
  if (result.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
}

function storeGlobalUsage (
  database: DatabaseSync,
  usage: GlobalUsageStateV1,
  nowMs: number
): void {
  const result = database.prepare(`
    UPDATE global_usage
    SET namespace_records = ?, active_memory_records = ?, canonical_logical_bytes = ?,
        pending_outbox_records = ?, outbox_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(
    usage.namespaceRecords,
    usage.activeMemoryRecords,
    usage.canonicalLogicalBytes,
    usage.pendingOutboxRecords,
    usage.outboxLogicalBytes,
    nowMs
  )
  if (result.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
}

function deleteUsageWhenEmpty (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  usage: UsageStateV1
): void {
  if (usage.pendingProposalRecords !== 0 || usage.activeMemoryRecords !== 0 ||
    usage.retainedRevisionRecords !== 0 || usage.tombstoneRecords !== 0 ||
    usage.canonicalLogicalBytes !== 0 || usage.pendingOutboxRecords !== 0 ||
    usage.outboxLogicalBytes !== 0) return
  const deleted = database.prepare(`
    DELETE FROM usage WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(namespaceRef, generation)
  if (deleted.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
}

function sqliteErrorNumber (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function sqliteFailure (error: unknown): MemoryOutboxResultV1 {
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

function runImmediate (
  database: DatabaseSync,
  operation: () => MemoryOutboxResultV1
): MemoryOutboxResultV1 {
  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const result = operation()
    database.exec('COMMIT')
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The fixed canonical/storage result remains authoritative.
      }
    }
    if (error instanceof CanonicalMemoryOutboxDataErrorV1) {
      return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
    }
    return sqliteFailure(error)
  }
}

function decodeClaimedRow (
  row: Readonly<Record<string, SQLOutputValue>>
): ClaimedRowV1 {
  const wire = exactString(rowValue(row, 'event_wire'))
  const logicalBytes = positiveInteger(rowValue(row, 'logical_bytes'))
  if (Buffer.byteLength(wire, 'utf8') !== logicalBytes) {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  let event: MemoryOutboxEventV1
  try {
    event = decodeMemoryOutboxEventV1(wire)
  } catch {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  const attemptCount = exactInteger(rowValue(row, 'attempt_count'))
  if (attemptCount >= SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 ||
    event.sequence !== positiveInteger(rowValue(row, 'sequence')) ||
    event.eventId !== exactString(rowValue(row, 'event_id')) ||
    event.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    event.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    event.aggregate !== exactString(rowValue(row, 'aggregate')) ||
    event.aggregateId !== exactString(rowValue(row, 'aggregate_id')) ||
    event.revision !== positiveInteger(rowValue(row, 'revision')) ||
    event.eventKind !== exactString(rowValue(row, 'event_kind')) ||
    Date.parse(event.occurredAt) !== exactInteger(rowValue(row, 'occurred_at_ms'))) {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  return Object.freeze({ event, logicalBytes })
}

function claimEvents (
  database: DatabaseSync,
  request: Extract<MemoryOutboxRequestV1, { readonly operation: 'claim' }>,
  nowMs: number
): MemoryOutboxResultV1 {
  const rows = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
           aggregate_id, revision, event_kind, occurred_at_ms, event_wire,
           logical_bytes, attempt_count
    FROM outbox
    WHERE available_at_ms <= ? AND attempt_count < ?
      AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    ORDER BY sequence ASC
    LIMIT ?
  `).all(
    nowMs,
    SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1,
    nowMs,
    request.limit
  )
  if (rows.length === 0) return Object.freeze({ status: 'empty' as const })
  const claimed = rows.map(decodeClaimedRow)
  const leaseToken = `memory-lease:v1:${randomBytes(32).toString('hex')}`
  const leasedUntilMs = nowMs + SQLITE_MEMORY_OUTBOX_LEASE_DURATION_MS_V1
  if (!Number.isSafeInteger(leasedUntilMs)) throw new CanonicalMemoryOutboxDataErrorV1()
  for (const row of claimed) {
    const updated = database.prepare(`
      UPDATE outbox
      SET lease_owner_id = ?, lease_token = ?, leased_until_ms = ?
      WHERE sequence = ? AND event_id = ? AND available_at_ms <= ?
        AND attempt_count < ?
        AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    `).run(
      request.ownerId,
      leaseToken,
      leasedUntilMs,
      row.event.sequence,
      row.event.eventId,
      nowMs,
      SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1,
      nowMs
    )
    if (updated.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
  }
  return Object.freeze({
    status: 'claimed' as const,
    ownerId: request.ownerId,
    leaseToken,
    leasedUntil: new Date(leasedUntilMs).toISOString(),
    events: Object.freeze(claimed.map(row => row.event))
  })
}

function activeLeaseRow (
  database: DatabaseSync,
  request: Extract<MemoryOutboxRequestV1, { readonly operation: 'ack' | 'retry' }>,
  nowMs: number
): Readonly<Record<string, SQLOutputValue>> | null {
  const row = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
           aggregate_id, revision, event_kind, occurred_at_ms, event_wire,
           logical_bytes, attempt_count
    FROM outbox
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ?
  `).get(
    request.sequence,
    request.eventId,
    request.ownerId,
    request.leaseToken,
    nowMs
  )
  if (row === undefined) return null
  const claimed = decodeClaimedRow(row)
  if (claimed.event.eventId !== request.eventId ||
    claimed.event.sequence !== request.sequence) throw new CanonicalMemoryOutboxDataErrorV1()
  return row
}

function ackEvent (
  database: DatabaseSync,
  request: Extract<MemoryOutboxRequestV1, { readonly operation: 'ack' }>,
  nowMs: number
): MemoryOutboxResultV1 {
  const row = activeLeaseRow(database, request, nowMs)
  if (row === null) return Object.freeze({ status: 'lease_conflict' as const })
  const namespaceRef = exactString(rowValue(row, 'namespace_ref'))
  const generation = positiveInteger(rowValue(row, 'namespace_generation'))
  const logicalBytes = positiveInteger(rowValue(row, 'logical_bytes'))
  const usage = loadUsage(database, namespaceRef, generation)
  const global = loadGlobalUsage(database)
  const nextUsage: UsageStateV1 = Object.freeze({
    ...usage,
    pendingOutboxRecords: usage.pendingOutboxRecords - 1,
    outboxLogicalBytes: usage.outboxLogicalBytes - logicalBytes
  })
  const nextGlobal: GlobalUsageStateV1 = Object.freeze({
    ...global,
    pendingOutboxRecords: global.pendingOutboxRecords - 1,
    outboxLogicalBytes: global.outboxLogicalBytes - logicalBytes
  })
  if (nextUsage.pendingOutboxRecords < 0 || nextUsage.outboxLogicalBytes < 0 ||
    nextGlobal.pendingOutboxRecords < 0 || nextGlobal.outboxLogicalBytes < 0) {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  const deleted = database.prepare(`
    DELETE FROM outbox
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ?
  `).run(
    request.sequence,
    request.eventId,
    request.ownerId,
    request.leaseToken,
    nowMs
  )
  if (deleted.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
  storeUsage(database, namespaceRef, generation, nextUsage, nowMs)
  storeGlobalUsage(database, nextGlobal, nowMs)
  deleteUsageWhenEmpty(database, namespaceRef, generation, nextUsage)
  return Object.freeze({ status: 'acked' as const })
}

function retryEvent (
  database: DatabaseSync,
  request: Extract<MemoryOutboxRequestV1, { readonly operation: 'retry' }>,
  nowMs: number
): MemoryOutboxResultV1 {
  const row = activeLeaseRow(database, request, nowMs)
  if (row === null) return Object.freeze({ status: 'lease_conflict' as const })
  const attemptCount = exactInteger(rowValue(row, 'attempt_count'))
  const occurredAtMs = exactInteger(rowValue(row, 'occurred_at_ms'))
  const retryAtMs = Date.parse(request.retryAt)
  if (attemptCount >= SQLITE_MEMORY_OUTBOX_MAX_ATTEMPTS_V1 ||
    retryAtMs < occurredAtMs || !Number.isSafeInteger(retryAtMs)) {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  const updated = database.prepare(`
    UPDATE outbox
    SET available_at_ms = ?, lease_owner_id = NULL, lease_token = NULL,
        leased_until_ms = NULL, attempt_count = ?, last_reason_code = ?
    WHERE sequence = ? AND event_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ? AND attempt_count = ?
  `).run(
    retryAtMs,
    attemptCount + 1,
    request.reasonCode,
    request.sequence,
    request.eventId,
    request.ownerId,
    request.leaseToken,
    nowMs,
    attemptCount
  )
  if (updated.changes !== 1) throw new CanonicalMemoryOutboxDataErrorV1()
  return Object.freeze({ status: 'retried' as const })
}

function outboxUsage (database: DatabaseSync, nowMs: number): MemoryOutboxResultV1 {
  const global = loadGlobalUsage(database)
  const leasedRows = database.prepare(`
    SELECT sequence
    FROM outbox
    WHERE lease_owner_id IS NOT NULL AND leased_until_ms > ?
    ORDER BY sequence ASC
    LIMIT 4097
  `).all(nowMs)
  if (leasedRows.length > global.pendingOutboxRecords) {
    throw new CanonicalMemoryOutboxDataErrorV1()
  }
  return Object.freeze({
    status: 'usage' as const,
    value: Object.freeze({
      schemaVersion: 1 as const,
      pendingRecords: global.pendingOutboxRecords,
      leasedRecords: leasedRows.length,
      logicalBytes: global.outboxLogicalBytes
    })
  })
}

function executeAdapter (
  database: DatabaseSync,
  now: () => string,
  request: MemoryOutboxRequestV1,
  signal?: AbortSignal
): MemoryOutboxResultV1 {
  if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
  const nowMs = Date.parse(nowInstant(now))
  switch (request.operation) {
    case 'claim':
      return runImmediate(database, () => claimEvents(database, request, nowMs))
    case 'ack':
      return runImmediate(database, () => ackEvent(database, request, nowMs))
    case 'retry':
      return runImmediate(database, () => retryEvent(database, request, nowMs))
    case 'usage':
      return outboxUsage(database, nowMs)
  }
}

export function createSqliteMemoryOutboxV1 (
  optionsValue: CreateSqliteMemoryOutboxOptionsV1
): MemoryOutboxPortV1 {
  const options = parseOptions(optionsValue)
  return createMemoryOutboxPortV1({
    now: options.now,
    execute: async (request, signal) => executeAdapter(
      options.database,
      options.now,
      request,
      signal
    )
  })
}
