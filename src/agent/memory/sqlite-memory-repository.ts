import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  createMemoryOutboxEventV1,
  type MemoryOutboxEventV1,
  type MemoryProposalV1,
  type MemoryRecordV1,
  type MemoryRevisionV1
} from './memory-domain.js'
import {
  decodeMemoryProposalV1,
  decodeMemoryRevisionV1,
  encodeMemoryOutboxEventV1,
  encodeMemoryProposalV1,
  encodeMemoryRecordV1,
  encodeMemoryRevisionV1
} from './memory-codec.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  createMemoryRepositoryPortV1,
  memoryApprovalBindsInitialRevisionV1,
  type MemoryRepositoryPortV1,
  type MemoryRepositoryRequestV1,
  type MemoryRepositoryResultV1,
  type MemoryRepositoryUsageV1
} from './memory-repository.js'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

export const MEMORY_CURSOR_HASH_DOMAIN_V1 = 'groupmate.memory.cursor.v1'
export const MEMORY_MUTATION_RECEIPT_HASH_DOMAIN_V1 =
  'groupmate.memory.mutation-receipt.v1'
export const MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1 =
  'groupmate.memory.outbox-event-id.v1'

interface CreateSqliteMemoryRepositoryOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

interface NamespaceRowV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespace: MemoryNamespaceV1
  readonly namespaceWire: string
  readonly namespaceWireBytes: number
  readonly generation: number
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

interface StoredRevisionV1 {
  readonly revision: MemoryRevisionV1
  readonly wire: string
  readonly wireBytes: number
}

interface StoredHeadV1 extends StoredRevisionV1 {
  readonly cursorRef: string
  readonly updatedAtMs: number
  readonly validUntilMs: number
  readonly purgeAtMs: number
}

interface StoredHeadCursorV1 {
  readonly memoryId: string
  readonly currentRevision: number
  readonly cursorRef: string
  readonly updatedAtMs: number
}

interface PreparedOutboxEventV1 {
  readonly event: MemoryOutboxEventV1
  readonly wire: string
  readonly wireBytes: number
}

interface TransactionOutcomeV1 {
  readonly commit: boolean
  readonly result: MemoryRepositoryResultV1
}

type SqliteMemoryRepositoryAdapterResultV1 =
  | MemoryRepositoryResultV1
  | {
      readonly status: 'page'
      readonly records: readonly MemoryRecordV1[]
      readonly nextCursor: string | null
      readonly corruptRecords: number
      readonly corruptRefs: readonly string[]
    }

class CanonicalMemoryDataErrorV1 extends Error {}

const CURSOR_PREFIX = 'memory-cursor:v1:'
const RECEIPT_PREFIX = 'memory-receipt:v1:'

function domainHash (domain: string, preimage: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(preimage, 'utf8')
    .digest('hex')
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== value) return invalidMemoryValue()
  return value
}

function instantMilliseconds (value: string): number {
  canonicalInstant(value)
  return Date.parse(value)
}

function exactInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalMemoryDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue | undefined): number {
  const result = exactInteger(value)
  if (result === 0) throw new CanonicalMemoryDataErrorV1()
  return result
}

function exactString (value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new CanonicalMemoryDataErrorV1()
  return value
}

function rowValue (
  row: Readonly<Record<string, SQLOutputValue>> | undefined,
  key: string
): SQLOutputValue | undefined {
  if (row === undefined) return undefined
  return Object.getOwnPropertyDescriptor(row, key)?.value as SQLOutputValue | undefined
}

function parseOptions (
  value: CreateSqliteMemoryRepositoryOptionsV1
): CreateSqliteMemoryRepositoryOptionsV1 {
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

function nowInstant (now: () => string): string {
  let value: unknown
  try {
    value = Reflect.apply(now, undefined, [])
  } catch {
    return invalidMemoryValue()
  }
  return canonicalInstant(value)
}

function namespaceFromWire (
  namespaceRef: MemoryNamespaceRefV1,
  wire: string,
  wireBytes: number
): MemoryNamespaceV1 {
  if (Buffer.byteLength(wire, 'utf8') !== wireBytes) {
    throw new CanonicalMemoryDataErrorV1()
  }
  let value: unknown
  try {
    value = JSON.parse(wire) as unknown
  } catch {
    throw new CanonicalMemoryDataErrorV1()
  }
  let namespace: MemoryNamespaceV1
  try {
    namespace = parseMemoryNamespaceV1(value)
  } catch {
    throw new CanonicalMemoryDataErrorV1()
  }
  if (memoryNamespaceRefV1(namespace) !== namespaceRef ||
    memoryNamespaceWireV1(namespace) !== wire) throw new CanonicalMemoryDataErrorV1()
  return namespace
}

function loadNamespace (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1
): NamespaceRowV1 | null {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces
    WHERE namespace_ref = ?
  `).get(namespaceRef)
  if (row === undefined) return null
  const storedRef = exactString(rowValue(row, 'namespace_ref'))
  const wire = exactString(rowValue(row, 'namespace_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'namespace_wire_bytes'))
  const generation = positiveInteger(rowValue(row, 'namespace_generation'))
  if (storedRef !== namespaceRef) throw new CanonicalMemoryDataErrorV1()
  return Object.freeze({
    namespaceRef,
    namespace: namespaceFromWire(namespaceRef, wire, wireBytes),
    namespaceWire: wire,
    namespaceWireBytes: wireBytes,
    generation
  })
}

function loadUsage (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number
): UsageStateV1 {
  const row = database.prepare(`
    SELECT pending_proposal_records, active_memory_records, retained_revision_records,
           tombstone_records, canonical_logical_bytes, pending_outbox_records,
           outbox_logical_bytes
    FROM usage
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).get(namespaceRef, generation)
  if (row === undefined) throw new CanonicalMemoryDataErrorV1()
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
  if (row === undefined) throw new CanonicalMemoryDataErrorV1()
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
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  usage: UsageStateV1,
  updatedAtMs: number
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
    updatedAtMs,
    namespaceRef,
    generation
  )
  if (result.changes !== 1) throw new CanonicalMemoryDataErrorV1()
}

function storeGlobalUsage (
  database: DatabaseSync,
  usage: GlobalUsageStateV1,
  updatedAtMs: number
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
    updatedAtMs
  )
  if (result.changes !== 1) throw new CanonicalMemoryDataErrorV1()
}

function mutationReceipt (
  request: MemoryRepositoryRequestV1,
  generation: number
): string {
  let payload: Readonly<Record<string, unknown>>
  switch (request.operation) {
    case 'proposal.create':
      payload = { proposalWire: encodeMemoryProposalV1(request.proposal) }
      break
    case 'proposal.decide':
      payload = {
        proposalWire: encodeMemoryProposalV1(request.nextProposal),
        revisionWire: request.initialRevision === null
          ? null
          : encodeMemoryRevisionV1(request.initialRevision)
      }
      break
    case 'record.create':
      payload = { revisionWire: encodeMemoryRevisionV1(request.initialRevision) }
      break
    case 'record.correct':
      payload = { revisionWire: encodeMemoryRevisionV1(request.nextRevision) }
      break
    case 'record.forget':
    case 'namespace.delete':
      payload = { tombstone: request.tombstone.receiptHash }
      break
    default:
      return invalidMemoryValue()
  }
  const preimage = JSON.stringify({
    operation: request.operation,
    namespaceRef: request.namespaceRef,
    namespaceGeneration: generation,
    payload
  })
  return `${RECEIPT_PREFIX}${domainHash(MEMORY_MUTATION_RECEIPT_HASH_DOMAIN_V1, preimage)}`
}

function cursorRefForFields (
  namespaceRef: MemoryNamespaceRefV1,
  namespaceGeneration: number,
  updatedAt: string,
  memoryId: string,
  currentRevision: number
): string {
  const preimage = JSON.stringify({
    namespaceRef,
    namespaceGeneration,
    updatedAt,
    memoryId,
    currentRevision
  })
  return domainHash(MEMORY_CURSOR_HASH_DOMAIN_V1, preimage)
}

function cursorRef (record: MemoryRecordV1): string {
  return cursorRefForFields(
    record.namespaceRef,
    record.namespaceGeneration,
    record.updatedAt,
    record.memoryId,
    record.revision
  )
}

function canonicalMemoryId (value: SQLOutputValue | undefined): string {
  const memoryId = exactString(value)
  if (!memoryAsciiWithinLimit(memoryId, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !memoryId.startsWith('memory:') || memoryId.length === 'memory:'.length) {
    throw new CanonicalMemoryDataErrorV1()
  }
  return memoryId
}

function instantFromMilliseconds (value: SQLOutputValue | undefined): {
  readonly milliseconds: number
  readonly instant: string
} {
  const milliseconds = exactInteger(value)
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) throw new CanonicalMemoryDataErrorV1()
  return Object.freeze({ milliseconds, instant: date.toISOString() })
}

function headCursorFromRow (
  row: Readonly<Record<string, SQLOutputValue>>,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number
): StoredHeadCursorV1 & { readonly hashMatches: boolean } {
  const memoryId = canonicalMemoryId(rowValue(row, 'memory_id'))
  const currentRevision = positiveInteger(rowValue(row, 'current_revision'))
  const storedCursor = exactString(rowValue(row, 'cursor_ref'))
  if (!/^[0-9a-f]{64}$/.test(storedCursor)) throw new CanonicalMemoryDataErrorV1()
  const updatedAt = instantFromMilliseconds(rowValue(row, 'updated_at_ms'))
  return Object.freeze({
    memoryId,
    currentRevision,
    cursorRef: storedCursor,
    updatedAtMs: updatedAt.milliseconds,
    hashMatches: storedCursor === cursorRefForFields(
      namespaceRef,
      generation,
      updatedAt.instant,
      memoryId,
      currentRevision
    )
  })
}

function outboxEventId (
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  aggregate: MemoryOutboxEventV1['aggregate'],
  aggregateId: string,
  revision: number,
  eventKind: MemoryOutboxEventV1['eventKind']
): string {
  const preimage = JSON.stringify({
    namespaceRef,
    namespaceGeneration: generation,
    aggregate,
    aggregateId,
    revision,
    eventKind
  })
  return `event:${domainHash(MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1, preimage)}`
}

function nextOutboxSequence (database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT seq FROM sqlite_sequence WHERE name = 'outbox'
  `).get()
  if (row === undefined) return 1
  const current = exactInteger(rowValue(row, 'seq'))
  if (current >= Number.MAX_SAFE_INTEGER) throw new CanonicalMemoryDataErrorV1()
  return current + 1
}

function prepareOutboxEvent (
  sequence: number,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  aggregate: MemoryOutboxEventV1['aggregate'],
  aggregateId: string,
  revision: number,
  eventKind: MemoryOutboxEventV1['eventKind'],
  occurredAt: string
): PreparedOutboxEventV1 {
  const event = createMemoryOutboxEventV1({
    eventId: outboxEventId(
      namespaceRef,
      generation,
      aggregate,
      aggregateId,
      revision,
      eventKind
    ),
    sequence,
    namespaceRef,
    namespaceGeneration: generation,
    aggregate,
    aggregateId,
    revision,
    eventKind,
    occurredAt
  })
  const wire = encodeMemoryOutboxEventV1(event)
  return Object.freeze({
    event,
    wire,
    wireBytes: Buffer.byteLength(wire, 'utf8')
  })
}

function insertOutboxEvent (database: DatabaseSync, prepared: PreparedOutboxEventV1): void {
  const event = prepared.event
  database.prepare(`
    INSERT INTO outbox(
      sequence, event_id, namespace_ref, namespace_generation, aggregate,
      aggregate_id, revision, event_kind, occurred_at_ms, available_at_ms,
      event_wire, logical_bytes, lease_owner_id, lease_token, leased_until_ms,
      attempt_count, last_reason_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL)
  `).run(
    event.sequence,
    event.eventId,
    event.namespaceRef,
    event.namespaceGeneration,
    event.aggregate,
    event.aggregateId,
    event.revision,
    event.eventKind,
    instantMilliseconds(event.occurredAt),
    instantMilliseconds(event.occurredAt),
    prepared.wire,
    prepared.wireBytes
  )
}

function capacityResult (
  usage: UsageStateV1,
  global: GlobalUsageStateV1,
  memoryRevisionRecords?: number
): MemoryRepositoryResultV1 | null {
  if (global.namespaceRecords > MEMORY_RESOURCE_LIMITS.deploymentNamespaces) {
    return Object.freeze({ status: 'capacity' as const, category: 'namespaces' as const })
  }
  if (usage.pendingProposalRecords > MEMORY_RESOURCE_LIMITS.namespacePendingProposals) {
    return Object.freeze({ status: 'capacity' as const, category: 'pending_proposals' as const })
  }
  if (usage.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
    global.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords) {
    return Object.freeze({ status: 'capacity' as const, category: 'active_records' as const })
  }
  if (memoryRevisionRecords !== undefined &&
    memoryRevisionRecords > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
    return Object.freeze({ status: 'capacity' as const, category: 'retained_revisions' as const })
  }
  if (usage.canonicalLogicalBytes > MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes ||
    global.canonicalLogicalBytes > MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes) {
    return Object.freeze({ status: 'capacity' as const, category: 'canonical_bytes' as const })
  }
  if (global.pendingOutboxRecords > MEMORY_RESOURCE_LIMITS.unackedOutboxRecords) {
    return Object.freeze({ status: 'capacity' as const, category: 'outbox_records' as const })
  }
  if (global.outboxLogicalBytes > MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes) {
    return Object.freeze({ status: 'capacity' as const, category: 'outbox_bytes' as const })
  }
  return null
}

function ensureNamespace (
  database: DatabaseSync,
  namespace: MemoryNamespaceV1,
  expectedGeneration: number,
  nowMs: number
): {
  readonly namespace: NamespaceRowV1
  readonly usage: UsageStateV1
  readonly global: GlobalUsageStateV1
  readonly created: boolean
  readonly failure: MemoryRepositoryResultV1 | null
} {
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const existing = loadNamespace(database, namespaceRef)
  const global = loadGlobalUsage(database)
  if (existing !== null) {
    if (existing.namespaceWire !== memoryNamespaceWireV1(namespace)) {
      throw new CanonicalMemoryDataErrorV1()
    }
    if (existing.generation !== expectedGeneration) {
      return Object.freeze({
        namespace: existing,
        usage: Object.freeze({
          pendingProposalRecords: 0,
          activeMemoryRecords: 0,
          retainedRevisionRecords: 0,
          tombstoneRecords: 0,
          canonicalLogicalBytes: 0,
          pendingOutboxRecords: 0,
          outboxLogicalBytes: 0
        }),
        global,
        created: false,
        failure: Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
      })
    }
    return Object.freeze({
      namespace: existing,
      usage: loadUsage(database, namespaceRef, existing.generation),
      global,
      created: false,
      failure: null
    })
  }
  if (expectedGeneration !== 1) {
    return Object.freeze({
      namespace: Object.freeze({
        namespaceRef,
        namespace,
        namespaceWire: memoryNamespaceWireV1(namespace),
        namespaceWireBytes: Buffer.byteLength(memoryNamespaceWireV1(namespace), 'utf8'),
        generation: 1
      }),
      usage: Object.freeze({
        pendingProposalRecords: 0,
        activeMemoryRecords: 0,
        retainedRevisionRecords: 0,
        tombstoneRecords: 0,
        canonicalLogicalBytes: 0,
        pendingOutboxRecords: 0,
        outboxLogicalBytes: 0
      }),
      global,
      created: false,
      failure: Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
    })
  }
  const wire = memoryNamespaceWireV1(namespace)
  const wireBytes = Buffer.byteLength(wire, 'utf8')
  const projectedUsage: UsageStateV1 = Object.freeze({
    pendingProposalRecords: 0,
    activeMemoryRecords: 0,
    retainedRevisionRecords: 0,
    tombstoneRecords: 0,
    canonicalLogicalBytes: wireBytes,
    pendingOutboxRecords: 0,
    outboxLogicalBytes: 0
  })
  const projectedGlobal: GlobalUsageStateV1 = Object.freeze({
    ...global,
    namespaceRecords: global.namespaceRecords + 1,
    canonicalLogicalBytes: global.canonicalLogicalBytes + wireBytes
  })
  const failure = capacityResult(projectedUsage, projectedGlobal)
  const row: NamespaceRowV1 = Object.freeze({
    namespaceRef,
    namespace,
    namespaceWire: wire,
    namespaceWireBytes: wireBytes,
    generation: 1
  })
  if (failure !== null) {
    return Object.freeze({
      namespace: row,
      usage: projectedUsage,
      global: projectedGlobal,
      created: false,
      failure
    })
  }
  database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(namespaceRef, wire, wireBytes, nowMs, nowMs)
  database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms
    ) VALUES (?, 1, 0, 0, 0, 0, ?, 0, 0, ?)
  `).run(namespaceRef, wireBytes, nowMs)
  storeGlobalUsage(database, projectedGlobal, nowMs)
  return Object.freeze({
    namespace: row,
    usage: projectedUsage,
    global: projectedGlobal,
    created: true,
    failure: null
  })
}

function unchangedResult (
  request: MemoryRepositoryRequestV1,
  generation: number,
  value: MemoryProposalV1 | MemoryRecordV1
): TransactionOutcomeV1 {
  return Object.freeze({
    commit: false,
    result: Object.freeze({
      status: 'unchanged' as const,
      value,
      receipt: mutationReceipt(request, generation)
    })
  })
}

function storedResult (
  request: MemoryRepositoryRequestV1,
  generation: number,
  value: MemoryProposalV1 | MemoryRecordV1
): TransactionOutcomeV1 {
  return Object.freeze({
    commit: true,
    result: Object.freeze({
      status: 'stored' as const,
      value,
      receipt: mutationReceipt(request, generation)
    })
  })
}

function failureOutcome (result: MemoryRepositoryResultV1): TransactionOutcomeV1 {
  return Object.freeze({ commit: false, result })
}

function proposalPendingWire (proposal: MemoryProposalV1): string {
  return encodeMemoryProposalV1({
    ...proposal,
    revision: 1,
    state: 'pending',
    decision: null
  })
}

function loadProposalRow (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  proposalId: string
): {
  readonly proposal: MemoryProposalV1
  readonly wire: string
  readonly wireBytes: number
  readonly resultingMemoryId: string | null
  readonly resultingRevision: number | null
  readonly resultingRevisionHash: string | null
} | null {
  const row = database.prepare(`
    SELECT revision, state, proposed_at_ms, decided_at_ms, proposal_wire,
           proposal_wire_bytes, resulting_memory_id, resulting_revision,
           resulting_revision_hash
    FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
  `).get(namespaceRef, generation, proposalId)
  if (row === undefined) return null
  const wire = exactString(rowValue(row, 'proposal_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'proposal_wire_bytes'))
  if (Buffer.byteLength(wire, 'utf8') !== wireBytes) throw new CanonicalMemoryDataErrorV1()
  let proposal: MemoryProposalV1
  try {
    proposal = decodeMemoryProposalV1(wire)
  } catch {
    throw new CanonicalMemoryDataErrorV1()
  }
  const decidedAt = rowValue(row, 'decided_at_ms')
  const resultingMemoryValue = rowValue(row, 'resulting_memory_id')
  const resultingRevisionValue = rowValue(row, 'resulting_revision')
  const resultingRevisionHashValue = rowValue(row, 'resulting_revision_hash')
  const resultingMemoryId = resultingMemoryValue === null
    ? null
    : exactString(resultingMemoryValue)
  const resultingRevision = resultingRevisionValue === null
    ? null
    : positiveInteger(resultingRevisionValue)
  const resultingRevisionHash = resultingRevisionHashValue === null
    ? null
    : exactString(resultingRevisionHashValue)
  if (proposal.namespaceRef !== namespaceRef || proposal.proposalId !== proposalId ||
    proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
    proposal.state !== exactString(rowValue(row, 'state')) ||
    instantMilliseconds(proposal.proposedAt) !== exactInteger(rowValue(row, 'proposed_at_ms')) ||
    (proposal.decision === null
      ? decidedAt !== null
      : instantMilliseconds(proposal.decision.decidedAt) !== exactInteger(decidedAt)) ||
    (proposal.state === 'approved'
      ? resultingMemoryId === null || resultingRevision === null || resultingRevisionHash === null
      : resultingMemoryId !== null || resultingRevision !== null ||
        resultingRevisionHash !== null)) {
    throw new CanonicalMemoryDataErrorV1()
  }
  if (resultingMemoryId !== null && resultingRevision !== null &&
    resultingRevisionHash !== null) {
    const stored = loadStoredRevision(
      database,
      namespaceRef,
      generation,
      resultingMemoryId,
      resultingRevision
    )
    if (stored === null || stored.revision.revisionHash !== resultingRevisionHash ||
      !memoryApprovalBindsInitialRevisionV1(
        proposal,
        stored.revision,
        namespaceRef,
        generation
      )) {
      throw new CanonicalMemoryDataErrorV1()
    }
  }
  return Object.freeze({
    proposal,
    wire,
    wireBytes,
    resultingMemoryId,
    resultingRevision,
    resultingRevisionHash
  })
}

function insertRevision (
  database: DatabaseSync,
  revision: MemoryRevisionV1,
  wire: string,
  wireBytes: number
): void {
  const record = revision.record
  database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.namespaceRef,
    record.namespaceGeneration,
    revision.memoryId,
    revision.revision,
    revision.operation,
    revision.revisionHash,
    revision.previousRevisionHash,
    instantMilliseconds(revision.changedAt),
    wireBytes
  )
  database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    record.namespaceRef,
    record.namespaceGeneration,
    revision.memoryId,
    revision.revision,
    wire
  )
}

function insertHead (database: DatabaseSync, revision: MemoryRevisionV1): void {
  const record = revision.record
  database.prepare(`
    INSERT INTO heads(
      namespace_ref, namespace_generation, memory_id, current_revision,
      current_revision_hash, content_hash, cursor_ref, updated_at_ms,
      valid_until_ms, purge_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.namespaceRef,
    record.namespaceGeneration,
    record.memoryId,
    record.revision,
    revision.revisionHash,
    record.contentHash,
    cursorRef(record),
    instantMilliseconds(record.updatedAt),
    instantMilliseconds(record.retention.validUntil),
    instantMilliseconds(record.retention.purgeAt)
  )
}

function loadStoredRevision (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  memoryId: string,
  revisionNumber: number
): StoredRevisionV1 | null {
  const row = database.prepare(`
    SELECT r.operation, r.revision_hash, r.previous_revision_hash,
           r.changed_at_ms, r.revision_wire_bytes, p.revision_wire
    FROM revisions AS r
    JOIN revision_payloads AS p
      ON p.namespace_ref = r.namespace_ref
     AND p.namespace_generation = r.namespace_generation
     AND p.memory_id = r.memory_id
     AND p.revision = r.revision
    WHERE r.namespace_ref = ? AND r.namespace_generation = ?
      AND r.memory_id = ? AND r.revision = ?
  `).get(namespaceRef, generation, memoryId, revisionNumber)
  if (row === undefined) {
    const metadata = database.prepare(`
      SELECT revision FROM revisions
      WHERE namespace_ref = ? AND namespace_generation = ?
        AND memory_id = ? AND revision = ?
    `).get(namespaceRef, generation, memoryId, revisionNumber)
    const payload = database.prepare(`
      SELECT revision FROM revision_payloads
      WHERE namespace_ref = ? AND namespace_generation = ?
        AND memory_id = ? AND revision = ?
    `).get(namespaceRef, generation, memoryId, revisionNumber)
    if (metadata !== undefined || payload !== undefined) throw new CanonicalMemoryDataErrorV1()
    return null
  }
  const wire = exactString(rowValue(row, 'revision_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'revision_wire_bytes'))
  if (Buffer.byteLength(wire, 'utf8') !== wireBytes) throw new CanonicalMemoryDataErrorV1()
  let revision: MemoryRevisionV1
  try {
    revision = decodeMemoryRevisionV1(wire)
  } catch {
    throw new CanonicalMemoryDataErrorV1()
  }
  const previousHash = rowValue(row, 'previous_revision_hash')
  if (revision.record.namespaceRef !== namespaceRef ||
    revision.record.namespaceGeneration !== generation ||
    revision.memoryId !== memoryId || revision.revision !== revisionNumber ||
    revision.operation !== exactString(rowValue(row, 'operation')) ||
    revision.revisionHash !== exactString(rowValue(row, 'revision_hash')) ||
    revision.previousRevisionHash !== (previousHash === null ? null : exactString(previousHash)) ||
    instantMilliseconds(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms'))) {
    throw new CanonicalMemoryDataErrorV1()
  }
  return Object.freeze({ revision, wire, wireBytes })
}

function loadHead (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  memoryId: string
): StoredHeadV1 | null {
  const row = database.prepare(`
    SELECT current_revision, current_revision_hash, content_hash, cursor_ref,
           updated_at_ms, valid_until_ms, purge_at_ms
    FROM heads
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).get(namespaceRef, generation, memoryId)
  if (row === undefined) return null
  const currentRevision = positiveInteger(rowValue(row, 'current_revision'))
  const stored = loadStoredRevision(
    database,
    namespaceRef,
    generation,
    memoryId,
    currentRevision
  )
  if (stored === null) throw new CanonicalMemoryDataErrorV1()
  const record = stored.revision.record
  const storedCursor = exactString(rowValue(row, 'cursor_ref'))
  const updatedAtMs = exactInteger(rowValue(row, 'updated_at_ms'))
  const validUntilMs = exactInteger(rowValue(row, 'valid_until_ms'))
  const purgeAtMs = exactInteger(rowValue(row, 'purge_at_ms'))
  if (stored.revision.revisionHash !== exactString(rowValue(row, 'current_revision_hash')) ||
    record.contentHash !== exactString(rowValue(row, 'content_hash')) ||
    storedCursor !== cursorRef(record) ||
    updatedAtMs !== instantMilliseconds(record.updatedAt) ||
    validUntilMs !== instantMilliseconds(record.retention.validUntil) ||
    purgeAtMs !== instantMilliseconds(record.retention.purgeAt)) {
    throw new CanonicalMemoryDataErrorV1()
  }
  return Object.freeze({
    ...stored,
    cursorRef: storedCursor,
    updatedAtMs,
    validUntilMs,
    purgeAtMs
  })
}

function projectedOutboxUsage (
  usage: UsageStateV1,
  global: GlobalUsageStateV1,
  events: readonly PreparedOutboxEventV1[]
): { readonly usage: UsageStateV1; readonly global: GlobalUsageStateV1 } {
  const bytes = events.reduce((total, event) => total + event.wireBytes, 0)
  return Object.freeze({
    usage: Object.freeze({
      ...usage,
      pendingOutboxRecords: usage.pendingOutboxRecords + events.length,
      outboxLogicalBytes: usage.outboxLogicalBytes + bytes
    }),
    global: Object.freeze({
      ...global,
      pendingOutboxRecords: global.pendingOutboxRecords + events.length,
      outboxLogicalBytes: global.outboxLogicalBytes + bytes
    })
  })
}

function proposalCreate (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'proposal.create' }>,
  nowMs: number
): TransactionOutcomeV1 {
  const namespaceState = ensureNamespace(
    database,
    request.proposal.namespace,
    request.expectedNamespaceGeneration,
    nowMs
  )
  if (namespaceState.failure !== null) return failureOutcome(namespaceState.failure)
  const existing = loadProposalRow(
    database,
    request.namespaceRef,
    namespaceState.namespace.generation,
    request.proposal.proposalId
  )
  const proposalWire = encodeMemoryProposalV1(request.proposal)
  if (existing !== null) {
    if (proposalPendingWire(existing.proposal) === proposalWire) {
      return unchangedResult(request, namespaceState.namespace.generation, request.proposal)
    }
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'idempotency' as const
    }))
  }
  const proposalBytes = Buffer.byteLength(proposalWire, 'utf8')
  const sequence = nextOutboxSequence(database)
  const event = prepareOutboxEvent(
    sequence,
    request.namespaceRef,
    namespaceState.namespace.generation,
    'proposal',
    request.proposal.proposalId,
    request.proposal.revision,
    'proposal_changed',
    request.proposal.proposedAt
  )
  const projected = projectedOutboxUsage(
    Object.freeze({
      ...namespaceState.usage,
      pendingProposalRecords: namespaceState.usage.pendingProposalRecords + 1,
      canonicalLogicalBytes: namespaceState.usage.canonicalLogicalBytes + proposalBytes
    }),
    Object.freeze({
      ...namespaceState.global,
      canonicalLogicalBytes: namespaceState.global.canonicalLogicalBytes + proposalBytes
    }),
    [event]
  )
  const failure = capacityResult(projected.usage, projected.global)
  if (failure !== null) return failureOutcome(failure)
  database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id,
      resulting_revision, resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    request.namespaceRef,
    namespaceState.namespace.generation,
    request.proposal.proposalId,
    request.proposal.revision,
    request.proposal.state,
    instantMilliseconds(request.proposal.proposedAt),
    proposalWire,
    proposalBytes
  )
  insertOutboxEvent(database, event)
  storeUsage(
    database,
    request.namespaceRef,
    namespaceState.namespace.generation,
    projected.usage,
    nowMs
  )
  storeGlobalUsage(database, projected.global, nowMs)
  return storedResult(request, namespaceState.namespace.generation, request.proposal)
}

function proposalDecide (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'proposal.decide' }>,
  nowMs: number
): TransactionOutcomeV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'generation' as const
    }))
  }
  const usage = loadUsage(database, request.namespaceRef, namespace.generation)
  const global = loadGlobalUsage(database)
  const existing = loadProposalRow(
    database,
    request.namespaceRef,
    namespace.generation,
    request.nextProposal.proposalId
  )
  if (existing === null) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'revision' as const
    }))
  }
  const nextWire = encodeMemoryProposalV1(request.nextProposal)
  if (existing.wire === nextWire) {
    if (request.initialRevision !== null) {
      if (existing.resultingMemoryId !== request.initialRevision.memoryId ||
        existing.resultingRevision !== request.initialRevision.revision ||
        existing.resultingRevisionHash !== request.initialRevision.revisionHash) {
        return failureOutcome(Object.freeze({
          status: 'conflict' as const,
          category: 'idempotency' as const
        }))
      }
      const stored = loadStoredRevision(
        database,
        request.namespaceRef,
        namespace.generation,
        request.initialRevision.memoryId,
        request.initialRevision.revision
      )
      const head = loadHead(
        database,
        request.namespaceRef,
        namespace.generation,
        request.initialRevision.memoryId
      )
      if (stored === null || head === null ||
        stored.wire !== encodeMemoryRevisionV1(request.initialRevision)) {
        throw new CanonicalMemoryDataErrorV1()
      }
    }
    return unchangedResult(request, namespace.generation, request.nextProposal)
  }
  if (existing.proposal.revision !== request.expectedRevision ||
    existing.proposal.state !== 'pending') {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'revision' as const
    }))
  }
  if (proposalPendingWire(request.nextProposal) !== existing.wire) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'idempotency' as const
    }))
  }
  const sequence = nextOutboxSequence(database)
  const proposalEvent = prepareOutboxEvent(
    sequence,
    request.namespaceRef,
    namespace.generation,
    'proposal',
    request.nextProposal.proposalId,
    request.nextProposal.revision,
    'proposal_changed',
    request.nextProposal.decision.decidedAt
  )
  const events: PreparedOutboxEventV1[] = [proposalEvent]
  let revisionWire: string | null = null
  let revisionBytes = 0
  if (request.initialRevision !== null) {
    const revision = request.initialRevision
    const stored = loadStoredRevision(
      database,
      request.namespaceRef,
      namespace.generation,
      revision.memoryId,
      revision.revision
    )
    const head = loadHead(
      database,
      request.namespaceRef,
      namespace.generation,
      revision.memoryId
    )
    if ((stored === null) !== (head === null)) throw new CanonicalMemoryDataErrorV1()
    if (stored !== null && head !== null) {
      return failureOutcome(Object.freeze({
        status: 'conflict' as const,
        category: 'idempotency' as const
      }))
    }
    revisionWire = encodeMemoryRevisionV1(revision)
    revisionBytes = Buffer.byteLength(revisionWire, 'utf8')
    events.push(prepareOutboxEvent(
      sequence + 1,
      request.namespaceRef,
      namespace.generation,
      'record',
      revision.memoryId,
      revision.revision,
      'record_upserted',
      revision.changedAt
    ))
  }
  const proposalBytesDelta = Buffer.byteLength(nextWire, 'utf8') - existing.wireBytes
  const projectedBaseUsage: UsageStateV1 = Object.freeze({
    ...usage,
    pendingProposalRecords: usage.pendingProposalRecords - 1,
    activeMemoryRecords: usage.activeMemoryRecords + (request.initialRevision === null ? 0 : 1),
    retainedRevisionRecords: usage.retainedRevisionRecords +
      (request.initialRevision === null ? 0 : 1),
    canonicalLogicalBytes: usage.canonicalLogicalBytes + proposalBytesDelta + revisionBytes
  })
  if (projectedBaseUsage.pendingProposalRecords < 0) throw new CanonicalMemoryDataErrorV1()
  const projectedBaseGlobal: GlobalUsageStateV1 = Object.freeze({
    ...global,
    activeMemoryRecords: global.activeMemoryRecords +
      (request.initialRevision === null ? 0 : 1),
    canonicalLogicalBytes: global.canonicalLogicalBytes + proposalBytesDelta + revisionBytes
  })
  const projected = projectedOutboxUsage(projectedBaseUsage, projectedBaseGlobal, events)
  const failure = capacityResult(
    projected.usage,
    projected.global,
    request.initialRevision === null ? undefined : 1
  )
  if (failure !== null) return failureOutcome(failure)
  const updated = database.prepare(`
    UPDATE proposals
    SET revision = ?, state = ?, decided_at_ms = ?, resulting_memory_id = ?,
        resulting_revision = ?, resulting_revision_hash = ?, proposal_wire = ?,
        proposal_wire_bytes = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
      AND revision = ? AND state = 'pending'
  `).run(
    request.nextProposal.revision,
    request.nextProposal.state,
    instantMilliseconds(request.nextProposal.decision.decidedAt),
    request.initialRevision?.memoryId ?? null,
    request.initialRevision?.revision ?? null,
    request.initialRevision?.revisionHash ?? null,
    nextWire,
    Buffer.byteLength(nextWire, 'utf8'),
    request.namespaceRef,
    namespace.generation,
    request.nextProposal.proposalId,
    request.expectedRevision
  )
  if (updated.changes !== 1) throw new CanonicalMemoryDataErrorV1()
  if (request.initialRevision !== null && revisionWire !== null) {
    insertRevision(database, request.initialRevision, revisionWire, revisionBytes)
    insertHead(database, request.initialRevision)
  }
  for (const event of events) insertOutboxEvent(database, event)
  storeUsage(database, request.namespaceRef, namespace.generation, projected.usage, nowMs)
  storeGlobalUsage(database, projected.global, nowMs)
  return storedResult(request, namespace.generation, request.nextProposal)
}

function recordCreate (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.create' }>,
  nowMs: number
): TransactionOutcomeV1 {
  const revision = request.initialRevision
  const namespaceState = ensureNamespace(
    database,
    revision.record.namespace,
    request.expectedNamespaceGeneration,
    nowMs
  )
  if (namespaceState.failure !== null) return failureOutcome(namespaceState.failure)
  const wire = encodeMemoryRevisionV1(revision)
  const existing = loadStoredRevision(
    database,
    request.namespaceRef,
    namespaceState.namespace.generation,
    revision.memoryId,
    revision.revision
  )
  if (existing !== null) {
    if (existing.wire === wire) {
      const head = loadHead(
        database,
        request.namespaceRef,
        namespaceState.namespace.generation,
        revision.memoryId
      )
      if (head === null || head.revision.revision < revision.revision) {
        throw new CanonicalMemoryDataErrorV1()
      }
      return unchangedResult(request, namespaceState.namespace.generation, revision.record)
    }
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'idempotency' as const
    }))
  }
  if (loadHead(
    database,
    request.namespaceRef,
    namespaceState.namespace.generation,
    revision.memoryId
  ) !== null) throw new CanonicalMemoryDataErrorV1()
  const wireBytes = Buffer.byteLength(wire, 'utf8')
  const event = prepareOutboxEvent(
    nextOutboxSequence(database),
    request.namespaceRef,
    namespaceState.namespace.generation,
    'record',
    revision.memoryId,
    revision.revision,
    'record_upserted',
    revision.changedAt
  )
  const projected = projectedOutboxUsage(
    Object.freeze({
      ...namespaceState.usage,
      activeMemoryRecords: namespaceState.usage.activeMemoryRecords + 1,
      retainedRevisionRecords: namespaceState.usage.retainedRevisionRecords + 1,
      canonicalLogicalBytes: namespaceState.usage.canonicalLogicalBytes + wireBytes
    }),
    Object.freeze({
      ...namespaceState.global,
      activeMemoryRecords: namespaceState.global.activeMemoryRecords + 1,
      canonicalLogicalBytes: namespaceState.global.canonicalLogicalBytes + wireBytes
    }),
    [event]
  )
  const failure = capacityResult(projected.usage, projected.global, 1)
  if (failure !== null) return failureOutcome(failure)
  insertRevision(database, revision, wire, wireBytes)
  insertHead(database, revision)
  insertOutboxEvent(database, event)
  storeUsage(
    database,
    request.namespaceRef,
    namespaceState.namespace.generation,
    projected.usage,
    nowMs
  )
  storeGlobalUsage(database, projected.global, nowMs)
  return storedResult(request, namespaceState.namespace.generation, revision.record)
}

function revisionCountForMemory (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1,
  generation: number,
  memoryId: string
): number {
  const rows = database.prepare(`
    SELECT revision
    FROM revisions
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    ORDER BY revision ASC
    LIMIT 33
  `).all(namespaceRef, generation, memoryId)
  if (rows.length > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) return rows.length
  rows.forEach((row, index) => {
    if (positiveInteger(rowValue(row, 'revision')) !== index + 1) {
      throw new CanonicalMemoryDataErrorV1()
    }
  })
  return rows.length
}

function recordCorrect (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.correct' }>,
  nowMs: number
): TransactionOutcomeV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null || namespace.generation !== request.expectedNamespaceGeneration) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'generation' as const
    }))
  }
  const next = request.nextRevision
  const nextWire = encodeMemoryRevisionV1(next)
  const usage = loadUsage(database, request.namespaceRef, namespace.generation)
  const global = loadGlobalUsage(database)
  const existingTarget = loadStoredRevision(
    database,
    request.namespaceRef,
    namespace.generation,
    next.memoryId,
    next.revision
  )
  if (existingTarget !== null) {
    if (existingTarget.wire === nextWire) {
      const replayHead = loadHead(
        database,
        request.namespaceRef,
        namespace.generation,
        next.memoryId
      )
      if (replayHead === null || replayHead.revision.revision < next.revision) {
        throw new CanonicalMemoryDataErrorV1()
      }
      return unchangedResult(request, namespace.generation, next.record)
    }
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'idempotency' as const
    }))
  }
  const head = loadHead(database, request.namespaceRef, namespace.generation, next.memoryId)
  if (head === null || head.revision.revision !== request.expectedRevision) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'revision' as const
    }))
  }
  if (next.previousRevisionHash !== head.revision.revisionHash) {
    return failureOutcome(Object.freeze({
      status: 'conflict' as const,
      category: 'revision' as const
    }))
  }
  const revisionCount = revisionCountForMemory(
    database,
    request.namespaceRef,
    namespace.generation,
    next.memoryId
  )
  const wireBytes = Buffer.byteLength(nextWire, 'utf8')
  const event = prepareOutboxEvent(
    nextOutboxSequence(database),
    request.namespaceRef,
    namespace.generation,
    'record',
    next.memoryId,
    next.revision,
    'record_upserted',
    next.changedAt
  )
  const projected = projectedOutboxUsage(
    Object.freeze({
      ...usage,
      retainedRevisionRecords: usage.retainedRevisionRecords + 1,
      canonicalLogicalBytes: usage.canonicalLogicalBytes + wireBytes
    }),
    Object.freeze({
      ...global,
      canonicalLogicalBytes: global.canonicalLogicalBytes + wireBytes
    }),
    [event]
  )
  const failure = capacityResult(projected.usage, projected.global, revisionCount + 1)
  if (failure !== null) return failureOutcome(failure)
  insertRevision(database, next, nextWire, wireBytes)
  const updated = database.prepare(`
    UPDATE heads
    SET current_revision = ?, current_revision_hash = ?, content_hash = ?,
        cursor_ref = ?, updated_at_ms = ?, valid_until_ms = ?, purge_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      AND current_revision = ? AND current_revision_hash = ?
  `).run(
    next.revision,
    next.revisionHash,
    next.record.contentHash,
    cursorRef(next.record),
    instantMilliseconds(next.record.updatedAt),
    instantMilliseconds(next.record.retention.validUntil),
    instantMilliseconds(next.record.retention.purgeAt),
    request.namespaceRef,
    namespace.generation,
    next.memoryId,
    request.expectedRevision,
    head.revision.revisionHash
  )
  if (updated.changes !== 1) throw new CanonicalMemoryDataErrorV1()
  insertOutboxEvent(database, event)
  storeUsage(database, request.namespaceRef, namespace.generation, projected.usage, nowMs)
  storeGlobalUsage(database, projected.global, nowMs)
  return storedResult(request, namespace.generation, next.record)
}

function sqliteErrorNumber (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

export function classifySqliteMemoryErrcodeV1 (
  errcode: number | null
): MemoryRepositoryResultV1 {
  const primaryCode = errcode !== null && Number.isSafeInteger(errcode) && errcode >= 0 &&
    errcode <= 0x7fffffff
    ? errcode & 0xff
    : null
  if (primaryCode === 5 || primaryCode === 6) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'busy' as const,
      retryable: true
    })
  }
  if (primaryCode === 10) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'io' as const,
      retryable: true
    })
  }
  if (primaryCode === 11 || primaryCode === 26) {
    return Object.freeze({
      status: 'corrupt' as const,
      category: 'canonical_data' as const
    })
  }
  return Object.freeze({
    status: 'unavailable' as const,
    category: 'storage' as const,
    retryable: false
  })
}

function unavailableForSqliteError (error: unknown): MemoryRepositoryResultV1 {
  return classifySqliteMemoryErrcodeV1(sqliteErrorNumber(error))
}

function runImmediateTransaction (
  database: DatabaseSync,
  operation: () => TransactionOutcomeV1
): MemoryRepositoryResultV1 {
  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const outcome = operation()
    database.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK')
    transactionStarted = false
    return outcome.result
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The fixed canonical/storage result remains authoritative.
      }
    }
    if (error instanceof CanonicalMemoryDataErrorV1) {
      return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
    }
    return unavailableForSqliteError(error)
  }
}

function runReadTransaction (
  database: DatabaseSync,
  operation: () => SqliteMemoryRepositoryAdapterResultV1
): SqliteMemoryRepositoryAdapterResultV1 {
  let transactionStarted = false
  try {
    database.exec('BEGIN')
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
    if (error instanceof CanonicalMemoryDataErrorV1) {
      return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
    }
    return unavailableForSqliteError(error)
  }
}

function proposalLoad (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'proposal.load' }>
): MemoryRepositoryResultV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null) return Object.freeze({ status: 'not_found' as const })
  const proposal = loadProposalRow(
    database,
    request.namespaceRef,
    namespace.generation,
    request.proposalId
  )
  return proposal === null
    ? Object.freeze({ status: 'not_found' as const })
    : Object.freeze({ status: 'found' as const, value: proposal.proposal })
}

function recordGet (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.get' }>,
  nowMs: number
): MemoryRepositoryResultV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null) return Object.freeze({ status: 'not_found' as const })
  const head = loadHead(database, request.namespaceRef, namespace.generation, request.memoryId)
  if (head === null || head.validUntilMs <= nowMs) {
    return Object.freeze({ status: 'not_found' as const })
  }
  return Object.freeze({ status: 'found' as const, value: head.revision.record })
}

function usageGet (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'usage.get' }>
): MemoryRepositoryResultV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null) return Object.freeze({ status: 'not_found' as const })
  const usage = loadUsage(database, request.namespaceRef, namespace.generation)
  const value: MemoryRepositoryUsageV1 = Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef: request.namespaceRef,
    namespaceGeneration: namespace.generation,
    ...usage
  })
  return Object.freeze({ status: 'usage' as const, value })
}

function cursorAnchor (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.list' }>,
  generation: number
): { readonly updatedAtMs: number; readonly memoryId: string } | null | false {
  if (request.cursor === null) return null
  const raw = request.cursor.slice(CURSOR_PREFIX.length)
  const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, memory_id, current_revision,
           cursor_ref, updated_at_ms
    FROM heads
    WHERE cursor_ref = ?
  `).get(raw)
  if (row === undefined) return false
  const namespaceRef = exactString(rowValue(row, 'namespace_ref'))
  const storedGeneration = positiveInteger(rowValue(row, 'namespace_generation'))
  if (namespaceRef !== request.namespaceRef || storedGeneration !== generation) return false
  const cursor = headCursorFromRow(row, request.namespaceRef, generation)
  if (!cursor.hashMatches || cursor.cursorRef !== raw) return false
  return Object.freeze({ updatedAtMs: cursor.updatedAtMs, memoryId: cursor.memoryId })
}

function recordList (
  database: DatabaseSync,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.list' }>,
  nowMs: number
): SqliteMemoryRepositoryAdapterResultV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null) {
    return request.cursor === null
      ? Object.freeze({
          status: 'page' as const,
          records: Object.freeze([]),
          nextCursor: null,
          corruptRecords: 0,
          corruptRefs: Object.freeze([])
        })
      : Object.freeze({ status: 'invalid_cursor' as const })
  }
  const anchor = cursorAnchor(database, request, namespace.generation)
  if (anchor === false) return Object.freeze({ status: 'invalid_cursor' as const })
  const rows = anchor === null
    ? database.prepare(`
        SELECT memory_id, current_revision, cursor_ref, updated_at_ms
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND valid_until_ms > ?
        ORDER BY updated_at_ms DESC, memory_id ASC
        LIMIT ?
      `).all(request.namespaceRef, namespace.generation, nowMs, request.limit + 1)
    : database.prepare(`
        SELECT memory_id, current_revision, cursor_ref, updated_at_ms
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND valid_until_ms > ?
          AND (updated_at_ms < ? OR (updated_at_ms = ? AND memory_id > ?))
        ORDER BY updated_at_ms DESC, memory_id ASC
        LIMIT ?
      `).all(
        request.namespaceRef,
        namespace.generation,
        nowMs,
        anchor.updatedAtMs,
        anchor.updatedAtMs,
        anchor.memoryId,
        request.limit + 1
      )
  const records: MemoryRecordV1[] = []
  const corruptRefs: string[] = []
  let wireBytes = Buffer.byteLength('[]', 'utf8')
  let hasMore = rows.length > request.limit
  let lastConsumedCursor: string | null = null
  for (const row of rows.slice(0, request.limit)) {
    const cursor = headCursorFromRow(row, request.namespaceRef, namespace.generation)
    if (!cursor.hashMatches) throw new CanonicalMemoryDataErrorV1()
    let head: StoredHeadV1 | null
    try {
      head = loadHead(database, request.namespaceRef, namespace.generation, cursor.memoryId)
    } catch (error) {
      if (!(error instanceof CanonicalMemoryDataErrorV1)) throw error
      corruptRefs.push(`${CURSOR_PREFIX}${cursor.cursorRef}`)
      lastConsumedCursor = cursor.cursorRef
      continue
    }
    if (head === null || head.cursorRef !== cursor.cursorRef ||
      head.revision.revision !== cursor.currentRevision ||
      head.updatedAtMs !== cursor.updatedAtMs) throw new CanonicalMemoryDataErrorV1()
    const recordWireBytes = Buffer.byteLength(
      encodeMemoryRecordV1(head.revision.record),
      'utf8'
    )
    const projectedWireBytes = wireBytes + recordWireBytes + (records.length === 0 ? 0 : 1)
    if (projectedWireBytes > request.maxWireBytes) {
      hasMore = true
      break
    }
    records.push(head.revision.record)
    wireBytes = projectedWireBytes
    lastConsumedCursor = cursor.cursorRef
  }
  const nextCursor = hasMore && lastConsumedCursor !== null
    ? `${CURSOR_PREFIX}${lastConsumedCursor}`
    : null
  return Object.freeze({
    status: 'page' as const,
    records: Object.freeze(records),
    nextCursor,
    corruptRecords: corruptRefs.length,
    corruptRefs: Object.freeze(corruptRefs)
  })
}

function executeAdapter (
  database: DatabaseSync,
  now: () => string,
  request: MemoryRepositoryRequestV1,
  signal?: AbortSignal
): SqliteMemoryRepositoryAdapterResultV1 {
  if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
  const currentTime = nowInstant(now)
  const nowMs = instantMilliseconds(currentTime)
  switch (request.operation) {
    case 'proposal.create':
      return runImmediateTransaction(database, () => proposalCreate(database, request, nowMs))
    case 'proposal.decide':
      return runImmediateTransaction(database, () => proposalDecide(database, request, nowMs))
    case 'record.create':
      return runImmediateTransaction(database, () => recordCreate(database, request, nowMs))
    case 'record.correct':
      return runImmediateTransaction(database, () => recordCorrect(database, request, nowMs))
    case 'proposal.load':
      return runReadTransaction(database, () => proposalLoad(database, request))
    case 'record.get':
      return runReadTransaction(database, () => recordGet(database, request, nowMs))
    case 'record.list':
      return runReadTransaction(database, () => recordList(database, request, nowMs))
    case 'usage.get':
      return runReadTransaction(database, () => usageGet(database, request))
    case 'record.forget':
    case 'namespace.delete':
      return Object.freeze({
        status: 'unavailable' as const,
        category: 'storage' as const,
        retryable: false
      })
  }
}

export function createSqliteMemoryRepositoryV1 (
  optionsValue: CreateSqliteMemoryRepositoryOptionsV1
): MemoryRepositoryPortV1 {
  const options = parseOptions(optionsValue)
  return createMemoryRepositoryPortV1({
    now: options.now,
    execute: async (request, signal) => executeAdapter(
      options.database,
      options.now,
      request,
      signal
    )
  })
}
