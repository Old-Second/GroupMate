import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  memoryAccessCapabilityAllowsV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1,
  type MemoryLifecycleActorActionV1,
  type MemoryLifecycleActorAuthorityRequirementV1
} from './memory-lifecycle-authority.js'
import {
  projectMemoryProposalLifecycleV2,
  projectMemoryRecordLifecycleV2
} from './memory-lifecycle-builder.js'
import {
  memoryProposalListCursorV1,
  memoryRevisionHistoryCursorV1,
  type MemoryControlRepositoryAdapterEnvelopeV1,
  type MemoryControlRepositoryAdapterRequestV1,
  type MemoryControlRepositoryAdapterV1,
  type MemoryProposalListCursorAnchorV1,
  type MemoryRecordControlProjectionV1,
  type MemoryRevisionHeadProofV1
} from './memory-control-repository.js'
import {
  decodeDeletionStatusV1,
  decodeMemoryLifecycleAuditV1,
  decodeMemoryProposalV2,
  decodeMemoryRevisionV2
} from './memory-lifecycle-codec.js'
import {
  MEMORY_DELETION_TOMBSTONE_ID_DOMAIN_V1,
  createDeletionStatusV1,
  memoryLifecycleDomainHashV1,
  memoryProposalDeadlineV2,
  parseMemoryLifecycleInstantV1,
  type MemoryProposalV2,
  type MemoryRevisionV2
} from './memory-lifecycle-domain.js'
import { memoryLifecycleCommandRefHashV1 } from './memory-lifecycle-command.js'
import {
  decodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleStableResultHashV1
} from './memory-lifecycle-result.js'
import {
  decodeMemoryTombstoneV1
} from './memory-codec.js'
import {
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'
import { MEMORY_CURSOR_HASH_DOMAIN_V1 } from './sqlite-memory-repository.js'

interface CreateSqliteMemoryControlRepositoryOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

type Row = Readonly<Record<string, SQLOutputValue>>

class CanonicalControlDataErrorV1 extends Error {}

const CONTROL_CURSOR_PREFIX = 'memory-control-cursor:v1:'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const SAFE_GROUP_KINDS = new Set(['group_rule', 'group_culture', 'task_fact', 'other'])
const SAFE_GROUP_SENSITIVITIES = new Set(['public', 'group'])

function rowValue (row: Row, name: string): SQLOutputValue {
  if (!Object.hasOwn(row, name)) throw new CanonicalControlDataErrorV1()
  return row[name]
}

function exactString (value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new CanonicalControlDataErrorV1()
  return value
}

function exactInteger (value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalControlDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue): number {
  const parsed = exactInteger(value)
  if (parsed === 0) throw new CanonicalControlDataErrorV1()
  return parsed
}

function nullableString (value: SQLOutputValue): string | null {
  return value === null ? null : exactString(value)
}

function nullableInteger (value: SQLOutputValue): number | null {
  return value === null ? null : positiveInteger(value)
}

function instantFromMilliseconds (value: SQLOutputValue): string {
  const milliseconds = exactInteger(value)
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) throw new CanonicalControlDataErrorV1()
  return date.toISOString()
}

function canonicalWire<T> (
  wireValue: SQLOutputValue,
  bytesValue: SQLOutputValue,
  decode: (wire: unknown) => T
): { readonly wire: string; readonly value: T } {
  const wire = exactString(wireValue)
  if (Buffer.byteLength(wire, 'utf8') !== positiveInteger(bytesValue)) {
    throw new CanonicalControlDataErrorV1()
  }
  try {
    return Object.freeze({ wire, value: decode(wire) })
  } catch {
    throw new CanonicalControlDataErrorV1()
  }
}

function freezeTrustedNow (database: DatabaseSync, now: () => string): string {
  let wall: string
  try {
    wall = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
  } catch {
    throw new CanonicalControlDataErrorV1()
  }
  const wallMs = Date.parse(wall)
  const row = database.prepare(`
    SELECT trusted_time_high_water_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalControlDataErrorV1()
  const persistedMs = exactInteger(rowValue(row, 'trusted_time_high_water_ms'))
  const trustedMs = Math.max(wallMs, persistedMs)
  const trusted = new Date(trustedMs)
  if (!Number.isFinite(trusted.getTime())) throw new CanonicalControlDataErrorV1()
  if (trustedMs > persistedMs) {
    const updated = database.prepare(`
      UPDATE lifecycle_deployment_state
      SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persistedMs)
    if (updated.changes !== 1) throw new CanonicalControlDataErrorV1()
  }
  return trusted.toISOString()
}

function actionForRequest (
  request: MemoryControlRepositoryAdapterRequestV1
): MemoryLifecycleActorActionV1 {
  if (request.operation === 'record.listSafe') return 'list_safe'
  if (request.operation === 'deletion.getStatus' || request.operation === 'deletion.resolve' ||
    ((request.operation === 'tombstone.list' || request.operation === 'audit.list') &&
      request.targetGeneration < request.generation)) return 'resolve_deletion'
  return 'inspect_full'
}

function requiredAuthority (
  action: MemoryLifecycleActorActionV1,
  role: NonNullable<ReturnType<typeof memoryLifecycleActorCapabilityRoleV1>>
): MemoryLifecycleActorAuthorityRequirementV1 {
  if (action === 'list_safe') return 'safe'
  if (action === 'resolve_deletion') {
    return role === 'personal_bot_master' ? 'delete_only' : 'elevated'
  }
  return 'ordinary'
}

function lockedAuthorizationDenial (
  envelope: MemoryControlRepositoryAdapterEnvelopeV1,
  freshNow: string
): { readonly status: 'denied'; readonly category: 'access' | 'authority' } | null {
  const { request, authorization } = envelope
  if (!memoryAccessCapabilityAllowsV1(authorization.access, request.namespaceRef, freshNow) ||
    authorization.access.botInstanceId !== authorization.botInstanceId ||
    authorization.access.accountId !== authorization.accountId ||
    authorization.access.sceneRef !== authorization.sceneRef ||
    authorization.namespaceRef !== request.namespaceRef ||
    authorization.generation !== request.generation) {
    return Object.freeze({ status: 'denied', category: 'access' })
  }
  const role = memoryLifecycleActorCapabilityRoleV1(authorization.actor)
  if (role === null) return Object.freeze({ status: 'denied', category: 'authority' })
  const action = actionForRequest(request)
  if (!memoryLifecycleActorCapabilityAllowsV1(authorization.actor, {
    botInstanceId: authorization.botInstanceId,
    accountId: authorization.accountId,
    sceneRef: authorization.sceneRef,
    namespaceRef: request.namespaceRef,
    generation: request.generation,
    actorRef: authorization.actorRef,
    action,
    requiredAuthority: requiredAuthority(action, role)
  }, freshNow) || (request.operation === 'usage.getGlobal' && role !== 'group_bot_master')) {
    return Object.freeze({ status: 'denied', category: 'authority' })
  }
  return null
}

function loadNamespaceGeneration (
  database: DatabaseSync,
  namespaceRef: string
): number | null {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) return null
  const storedRef = exactString(rowValue(row, 'namespace_ref'))
  const generation = positiveInteger(rowValue(row, 'namespace_generation'))
  const parsed = canonicalWire(
    rowValue(row, 'namespace_wire'),
    rowValue(row, 'namespace_wire_bytes'),
    wire => parseMemoryNamespaceV1(JSON.parse(exactString(wire as SQLOutputValue)) as unknown)
  )
  if (storedRef !== namespaceRef || memoryNamespaceRefV1(parsed.value) !== namespaceRef ||
    memoryNamespaceWireV1(parsed.value) !== parsed.wire) throw new CanonicalControlDataErrorV1()
  return generation
}

function validateProposalRow (row: Row): MemoryProposalV2 {
  const proposal = canonicalWire(
    rowValue(row, 'proposal_wire'),
    rowValue(row, 'proposal_wire_bytes'),
    decodeMemoryProposalV2
  ).value
  const decidedAt = nullableInteger(rowValue(row, 'decided_at_ms'))
  const decision = proposal.decision
  if (proposal.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    proposal.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    proposal.proposalId !== exactString(rowValue(row, 'proposal_id')) ||
    proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
    proposal.state !== exactString(rowValue(row, 'state')) ||
    Date.parse(proposal.proposedAt) !== exactInteger(rowValue(row, 'proposed_at_ms')) ||
    (decision === null ? null : Date.parse(decision.decidedAt)) !== decidedAt ||
    (decision?.resultingMemoryId ?? null) !== nullableString(rowValue(row, 'resulting_memory_id')) ||
    (decision?.resultingMemoryRevision ?? null) !== nullableInteger(rowValue(row, 'resulting_revision')) ||
    (decision?.resultingRevisionHash ?? null) !== nullableString(rowValue(row, 'resulting_revision_hash'))) {
    throw new CanonicalControlDataErrorV1()
  }
  return proposal
}

function proposalProjection (proposal: MemoryProposalV2, snapshotAt: string) {
  const lifecycle = projectMemoryProposalLifecycleV2(proposal, snapshotAt)
  const deadlineAt = memoryProposalDeadlineV2(proposal)
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    state: proposal.state,
    effectiveState: lifecycle.logicalState,
    intentKind: proposal.intent.kind,
    plannedMemoryId: proposal.plannedMemoryId,
    kind: proposal.kind,
    sensitivity: proposal.sensitivity,
    proposedAt: proposal.proposedAt,
    deadlineAt,
    validUntil: proposal.suggestedRetention.validUntil,
    approvalCutoff: Date.parse(deadlineAt) <= Date.parse(proposal.suggestedRetention.validUntil)
      ? deadlineAt
      : proposal.suggestedRetention.validUntil
  })
}

function headProofFromRow (
  row: Row,
  snapshotAt: string
): MemoryRevisionHeadProofV1 {
  const namespaceRef = parseMemoryNamespaceRefV1(exactString(rowValue(row, 'namespace_ref')))
  const namespaceGeneration = positiveInteger(rowValue(row, 'namespace_generation'))
  const memoryId = exactString(rowValue(row, 'memory_id'))
  const headRevision = positiveInteger(rowValue(row, 'current_revision'))
  const headRevisionHash = exactString(rowValue(row, 'current_revision_hash'))
  const contentHash = exactString(rowValue(row, 'content_hash'))
  const cursorRef = exactString(rowValue(row, 'cursor_ref'))
  const updatedAt = instantFromMilliseconds(rowValue(row, 'updated_at_ms'))
  const validUntil = instantFromMilliseconds(rowValue(row, 'valid_until_ms'))
  const purgeAt = instantFromMilliseconds(rowValue(row, 'purge_at_ms'))
  const expectedCursorRef = createHash('sha256')
    .update(MEMORY_CURSOR_HASH_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify({
      namespaceRef,
      namespaceGeneration,
      updatedAt,
      memoryId,
      currentRevision: headRevision
    }), 'utf8')
    .digest('hex')
  if (!memoryId.startsWith('memory:') || !HASH_PATTERN.test(memoryId.slice('memory:'.length)) ||
    headRevision > MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions ||
    !HASH_PATTERN.test(headRevisionHash) ||
    !HASH_PATTERN.test(contentHash) || cursorRef !== expectedCursorRef ||
    Date.parse(validUntil) <= Date.parse(updatedAt) ||
    Date.parse(purgeAt) - Date.parse(validUntil) !==
      MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs) {
    throw new CanonicalControlDataErrorV1()
  }
  const lifecycleState = Date.parse(snapshotAt) < Date.parse(validUntil)
    ? 'current' as const
    : Date.parse(snapshotAt) < Date.parse(purgeAt)
      ? 'expired' as const
      : 'purge_due' as const
  const common = {
    schemaVersion: 1 as const,
    namespaceRef,
    namespaceGeneration,
    memoryId,
    headRevision,
    validUntil,
    purgeAt
  }
  if (lifecycleState === 'purge_due') {
    return Object.freeze({ ...common, lifecycleState: 'purge_due' as const })
  }
  return Object.freeze({ ...common, lifecycleState, headRevisionHash })
}

function validateRevisionRow (row: Row): MemoryRevisionV2 {
  const revision = canonicalWire(
    rowValue(row, 'revision_wire'),
    rowValue(row, 'revision_wire_bytes'),
    decodeMemoryRevisionV2
  ).value
  if (revision.record.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    revision.record.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    revision.memoryId !== exactString(rowValue(row, 'memory_id')) ||
    revision.revision !== positiveInteger(rowValue(row, 'revision')) ||
    revision.operation !== exactString(rowValue(row, 'operation')) ||
    revision.revisionHash !== exactString(rowValue(row, 'revision_hash')) ||
    revision.previousRevisionHash !== nullableString(rowValue(row, 'previous_revision_hash')) ||
    Date.parse(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms'))) {
    throw new CanonicalControlDataErrorV1()
  }
  return revision
}

function validateHeadRevision (row: Row, revision: MemoryRevisionV2): void {
  const cursorRef = exactString(rowValue(row, 'cursor_ref'))
  const expectedCursorRef = createHash('sha256')
    .update(MEMORY_CURSOR_HASH_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify({
      namespaceRef: revision.record.namespaceRef,
      namespaceGeneration: revision.record.namespaceGeneration,
      updatedAt: revision.record.updatedAt,
      memoryId: revision.record.memoryId,
      currentRevision: revision.record.revision
    }), 'utf8')
    .digest('hex')
  if (revision.revision !== positiveInteger(rowValue(row, 'current_revision')) ||
    revision.revisionHash !== exactString(rowValue(row, 'current_revision_hash')) ||
    revision.record.contentHash !== exactString(rowValue(row, 'content_hash')) ||
    Date.parse(revision.record.updatedAt) !== exactInteger(rowValue(row, 'updated_at_ms')) ||
    Date.parse(revision.record.retention.validUntil) !== exactInteger(rowValue(row, 'valid_until_ms')) ||
    Date.parse(revision.record.retention.purgeAt) !== exactInteger(rowValue(row, 'purge_at_ms')) ||
    cursorRef !== expectedCursorRef) {
    throw new CanonicalControlDataErrorV1()
  }
}

function recordProjectionFromRow (row: Row, snapshotAt: string): MemoryRecordControlProjectionV1 {
  const head = headProofFromRow(row, snapshotAt)
  if (head.lifecycleState === 'purge_due') return Object.freeze({
    schemaVersion: 1 as const,
    lifecycleState: 'purge_due' as const,
    namespaceRef: head.namespaceRef,
    namespaceGeneration: head.namespaceGeneration,
    memoryId: head.memoryId,
    revision: head.headRevision,
    validUntil: head.validUntil,
    purgeAt: head.purgeAt
  })
  const revision = validateRevisionRow(row)
  validateHeadRevision(row, revision)
  const projected = projectMemoryRecordLifecycleV2(revision.record, snapshotAt)
  if (projected.state !== head.lifecycleState) throw new CanonicalControlDataErrorV1()
  return Object.freeze({
    schemaVersion: 1 as const,
    lifecycleState: head.lifecycleState,
    record: revision.record
  })
}

function safeRecordProjectionFromRow (row: Row, snapshotAt: string) {
  const projection = recordProjectionFromRow(row, snapshotAt)
  if (projection.lifecycleState !== 'current' ||
    !SAFE_GROUP_KINDS.has(projection.record.kind) ||
    !SAFE_GROUP_SENSITIVITIES.has(projection.record.sensitivity)) {
    throw new CanonicalControlDataErrorV1()
  }
  const record = projection.record
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    revision: record.revision,
    lifecycleState: 'current' as const,
    kind: record.kind,
    text: record.text,
    validity: record.validity,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    updatedAt: record.updatedAt,
    sourceCount: record.sources.length,
    validUntil: record.retention.validUntil,
    purgeAt: record.retention.purgeAt
  })
}

function pageWireBytes (
  records: readonly unknown[],
  corruptRefs: readonly string[],
  metadata: Readonly<Record<string, unknown>> = {}
): number {
  return Buffer.byteLength(JSON.stringify({ records, corruptRefs, ...metadata }), 'utf8')
}

function pageFits (
  request: { readonly maxWireBytes: number },
  records: readonly unknown[],
  corruptRefs: readonly string[],
  metadata: Readonly<Record<string, unknown>> = {}
): boolean {
  return pageWireBytes(records, corruptRefs, metadata) <= request.maxWireBytes
}

function pageBudgetFailure () {
  return Object.freeze({
    status: 'unavailable' as const,
    category: 'storage' as const,
    retryable: false as const
  })
}

function cursorForRef (ref: string, prefix: string): string {
  if (!ref.startsWith(prefix) || !HASH_PATTERN.test(ref.slice(prefix.length))) {
    throw new CanonicalControlDataErrorV1()
  }
  return `${CONTROL_CURSOR_PREFIX}${ref.slice(prefix.length)}`
}

function refFromCursor (cursor: string, prefix: string): string {
  if (!cursor.startsWith(CONTROL_CURSOR_PREFIX) ||
    !HASH_PATTERN.test(cursor.slice(CONTROL_CURSOR_PREFIX.length))) {
    throw new CanonicalControlDataErrorV1()
  }
  return `${prefix}${cursor.slice(CONTROL_CURSOR_PREFIX.length)}`
}

function proposalList (
  database: DatabaseSync,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { operation: 'proposal.list' }>,
  snapshotAt: string
) {
  if (request.cursorAnchor !== null) {
    const anchorRow = database.prepare(`
      SELECT proposal_id, proposed_at_ms, state
      FROM proposals
      WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
    `).get(request.namespaceRef, request.generation, request.cursorAnchor.proposalId) as Row | undefined
    if (anchorRow === undefined ||
      exactInteger(rowValue(anchorRow, 'proposed_at_ms')) !== Date.parse(request.cursorAnchor.proposedAt) ||
      !request.states.includes(exactString(rowValue(anchorRow, 'state')) as MemoryProposalV2['state'])) {
      return Object.freeze({ status: 'invalid_cursor' as const, operation: request.operation })
    }
  }
  const statePlaceholders = request.states.map(() => '?').join(', ')
  const rows = database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ?
      AND state IN (${statePlaceholders})
      AND (? IS NULL OR proposed_at_ms > ? OR (proposed_at_ms = ? AND proposal_id > ?))
    ORDER BY proposed_at_ms ASC, proposal_id ASC
    LIMIT ?
  `).all(
    request.namespaceRef,
    request.generation,
    ...request.states,
    request.cursorAnchor?.proposalId ?? null,
    request.cursorAnchor === null ? 0 : Date.parse(request.cursorAnchor.proposedAt),
    request.cursorAnchor === null ? 0 : Date.parse(request.cursorAnchor.proposedAt),
    request.cursorAnchor?.proposalId ?? '',
    request.limit + 1
  ) as Row[]
  const records: unknown[] = []
  const corruptRefs: string[] = []
  let lastConsumed: Row | undefined
  let hasMore = false
  const selected = rows.slice(0, request.limit)
  for (const [index, row] of selected.entries()) {
    const ref = exactString(rowValue(row, 'proposal_id'))
    let record: unknown | null = null
    let corruptRef: string | null = null
    try {
      record = proposalProjection(validateProposalRow(row), snapshotAt)
    } catch {
      if (!/^proposal:[0-9a-f]{64}$/.test(ref)) throw new CanonicalControlDataErrorV1()
      corruptRef = ref
    }
    const candidateRecords = record === null ? records : [...records, record]
    const candidateCorruptRefs = corruptRef === null ? corruptRefs : [...corruptRefs, corruptRef]
    const candidateHasMore = index + 1 < rows.length
    const candidateAnchor = candidateHasMore
      ? Object.freeze({
          schemaVersion: 1 as const,
          proposedAt: instantFromMilliseconds(rowValue(row, 'proposed_at_ms')),
          proposalId: ref
        })
      : null
    const candidateMetadata = candidateAnchor === null ? {} : { nextCursorAnchor: candidateAnchor }
    if (!pageFits(request, candidateRecords, candidateCorruptRefs, candidateMetadata)) {
      if (lastConsumed === undefined) return pageBudgetFailure()
      hasMore = true
      break
    }
    if (record !== null) records.push(record)
    if (corruptRef !== null) corruptRefs.push(corruptRef)
    lastConsumed = row
    hasMore = candidateHasMore
  }
  let nextCursor: string | null = null
  let nextCursorAnchor: MemoryProposalListCursorAnchorV1 | undefined
  if (hasMore && lastConsumed !== undefined) {
    nextCursorAnchor = Object.freeze({
      schemaVersion: 1 as const,
      proposedAt: instantFromMilliseconds(rowValue(lastConsumed, 'proposed_at_ms')),
      proposalId: exactString(rowValue(lastConsumed, 'proposal_id'))
    })
    nextCursor = memoryProposalListCursorV1({
      schemaVersion: 1,
      namespaceRef: request.namespaceRef,
      namespaceGeneration: request.generation,
      states: request.states,
      anchor: nextCursorAnchor
    })
  }
  const metadata = nextCursorAnchor === undefined ? {} : { nextCursorAnchor }
  return Object.freeze({
    status: 'page' as const,
    operation: request.operation,
    snapshotAt,
    records: Object.freeze(records),
    nextCursor,
    wireBytes: pageWireBytes(records, corruptRefs, metadata),
    corruptRecords: corruptRefs.length,
    corruptRefs: Object.freeze(corruptRefs),
    ...metadata
  })
}

const HEAD_SELECT = `
  SELECT h.namespace_ref, h.namespace_generation, h.memory_id, h.current_revision,
    h.current_revision_hash, h.content_hash, h.cursor_ref, h.updated_at_ms,
    h.valid_until_ms, h.purge_at_ms, r.revision, r.operation, r.revision_hash,
    r.previous_revision_hash, r.changed_at_ms, r.revision_wire_bytes, p.revision_wire
  FROM heads h
  JOIN revisions r ON r.namespace_ref = h.namespace_ref
    AND r.namespace_generation = h.namespace_generation
    AND r.memory_id = h.memory_id AND r.revision = h.current_revision
  JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
    AND p.namespace_generation = r.namespace_generation
    AND p.memory_id = r.memory_id AND p.revision = r.revision
`

function recordList (
  database: DatabaseSync,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, {
    operation: 'record.listSafe' | 'record.inspectList'
  }>,
  snapshotAt: string
) {
  const anchorId = request.cursor === null ? null : refFromCursor(request.cursor, 'memory:')
  if (anchorId !== null) {
    const anchor = database.prepare(`
      SELECT 1 FROM heads
      WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
    `).get(request.namespaceRef, request.generation, anchorId)
    if (anchor === undefined) {
      return Object.freeze({ status: 'invalid_cursor' as const, operation: request.operation })
    }
  }
  const safePredicate = request.operation === 'record.listSafe'
    ? `AND h.valid_until_ms > ?
       AND CASE WHEN json_valid(p.revision_wire) THEN
         json_extract(p.revision_wire, '$.record.kind') IN
           ('group_rule', 'group_culture', 'task_fact', 'other')
         AND json_extract(p.revision_wire, '$.record.sensitivity') IN ('public', 'group')
       ELSE 1 END`
    : ''
  const parameters: Array<string | number | null> = [
    request.namespaceRef,
    request.generation,
    anchorId,
    anchorId ?? ''
  ]
  if (request.operation === 'record.listSafe') parameters.push(Date.parse(snapshotAt))
  parameters.push(request.limit + 1)
  const rows = database.prepare(`${HEAD_SELECT}
    WHERE h.namespace_ref = ? AND h.namespace_generation = ?
      AND (? IS NULL OR h.memory_id > ?)
      ${safePredicate}
    ORDER BY h.memory_id ASC
    LIMIT ?
  `).all(...parameters) as Row[]
  const records: unknown[] = []
  const corruptRefs: string[] = []
  let lastConsumed: Row | undefined
  let hasMore = false
  const selected = rows.slice(0, request.limit)
  for (const [index, row] of selected.entries()) {
    const ref = exactString(rowValue(row, 'memory_id'))
    let record: unknown | null = null
    let corruptRef: string | null = null
    try {
      record = request.operation === 'record.listSafe'
        ? safeRecordProjectionFromRow(row, snapshotAt)
        : recordProjectionFromRow(row, snapshotAt)
    } catch {
      if (!/^memory:[0-9a-f]{64}$/.test(ref)) throw new CanonicalControlDataErrorV1()
      corruptRef = ref
    }
    const candidateRecords = record === null ? records : [...records, record]
    const candidateCorruptRefs = corruptRef === null ? corruptRefs : [...corruptRefs, corruptRef]
    if (!pageFits(request, candidateRecords, candidateCorruptRefs)) {
      if (lastConsumed === undefined) return pageBudgetFailure()
      hasMore = true
      break
    }
    if (record !== null) records.push(record)
    if (corruptRef !== null) corruptRefs.push(corruptRef)
    lastConsumed = row
    hasMore = index + 1 < rows.length
  }
  const nextCursor = hasMore && lastConsumed !== undefined
    ? cursorForRef(exactString(rowValue(lastConsumed, 'memory_id')), 'memory:')
    : null
  return Object.freeze({
    status: 'page' as const,
    operation: request.operation,
    snapshotAt,
    records: Object.freeze(records),
    nextCursor,
    wireBytes: pageWireBytes(records, corruptRefs),
    corruptRecords: corruptRefs.length,
    corruptRefs: Object.freeze(corruptRefs)
  })
}

function loadHeadRow (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  memoryId: string
): Row | null {
  return (database.prepare(`${HEAD_SELECT}
    WHERE h.namespace_ref = ? AND h.namespace_generation = ? AND h.memory_id = ?
  `).get(namespaceRef, generation, memoryId) as Row | undefined) ?? null
}

function revisionList (
  database: DatabaseSync,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { operation: 'revision.list' }>,
  snapshotAt: string
) {
  const headRow = loadHeadRow(database, request.namespaceRef, request.generation, request.memoryId)
  if (headRow === null) {
    return Object.freeze({ status: 'not_found' as const, operation: request.operation, snapshotAt })
  }
  const head = headProofFromRow(headRow, snapshotAt)
  if (head.lifecycleState === 'purge_due') {
    return Object.freeze({ status: 'record_purge_due' as const, operation: request.operation,
      snapshotAt, head })
  }
  validateHeadRevision(headRow, validateRevisionRow(headRow))
  const start = request.cursorAnchor?.revision ?? 0
  if (request.cursorAnchor !== null) {
    const anchorRow = database.prepare(`
      SELECT r.namespace_ref, r.namespace_generation, r.memory_id, r.revision,
        r.operation, r.revision_hash, r.previous_revision_hash, r.changed_at_ms,
        r.revision_wire_bytes, p.revision_wire
      FROM revisions r
      JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id AND p.revision = r.revision
      WHERE r.namespace_ref = ? AND r.namespace_generation = ?
        AND r.memory_id = ? AND r.revision = ?
    `).get(
      request.namespaceRef,
      request.generation,
      request.memoryId,
      request.cursorAnchor.revision
    ) as Row | undefined
    if (anchorRow === undefined) {
      return Object.freeze({ status: 'invalid_cursor' as const, operation: request.operation })
    }
    let anchorRevision: MemoryRevisionV2
    try {
      anchorRevision = validateRevisionRow(anchorRow)
    } catch {
      throw new CanonicalControlDataErrorV1()
    }
    if (anchorRevision.revisionHash !== request.cursorAnchor.revisionHash) {
      return Object.freeze({ status: 'invalid_cursor' as const, operation: request.operation })
    }
  }
  const rows = database.prepare(`
    SELECT r.namespace_ref, r.namespace_generation, r.memory_id, r.revision,
      r.operation, r.revision_hash, r.previous_revision_hash, r.changed_at_ms,
      r.revision_wire_bytes, p.revision_wire
    FROM revisions r
    JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
      AND p.namespace_generation = r.namespace_generation
      AND p.memory_id = r.memory_id AND p.revision = r.revision
    WHERE r.namespace_ref = ? AND r.namespace_generation = ? AND r.memory_id = ?
      AND r.revision > ?
    ORDER BY r.revision ASC
    LIMIT ?
  `).all(request.namespaceRef, request.generation, request.memoryId, start, request.limit + 1) as Row[]
  const records: MemoryRevisionV2[] = []
  let lastConsumed: MemoryRevisionV2 | undefined
  let hasMore = false
  const selected = rows.slice(0, request.limit)
  for (const [index, row] of selected.entries()) {
    let revision: MemoryRevisionV2
    try {
      revision = validateRevisionRow(row)
    } catch {
      throw new CanonicalControlDataErrorV1()
    }
    const candidateHasMore = index + 1 < rows.length
    const candidateAnchor = candidateHasMore
      ? Object.freeze({
          schemaVersion: 1 as const,
          revision: revision.revision,
          revisionHash: revision.revisionHash
        })
      : null
    const candidateMetadata = { head, nextCursorAnchor: candidateAnchor }
    if (!pageFits(request, [...records, revision], [], candidateMetadata)) {
      if (lastConsumed === undefined) return pageBudgetFailure()
      hasMore = true
      break
    }
    records.push(revision)
    lastConsumed = revision
    hasMore = candidateHasMore
  }
  const nextCursorAnchor = hasMore && lastConsumed !== undefined
    ? Object.freeze({ schemaVersion: 1 as const, revision: lastConsumed.revision,
      revisionHash: lastConsumed.revisionHash })
    : null
  const nextCursor = nextCursorAnchor === null
    ? null
    : memoryRevisionHistoryCursorV1({
        schemaVersion: 1,
        namespaceRef: request.namespaceRef,
        namespaceGeneration: request.generation,
        memoryId: request.memoryId,
        anchor: nextCursorAnchor
      })
  const metadata = { head, nextCursorAnchor }
  if (!pageFits(request, records, [], metadata)) return pageBudgetFailure()
  return Object.freeze({
    status: 'page' as const,
    operation: request.operation,
    snapshotAt,
    records: Object.freeze(records),
    nextCursor,
    wireBytes: pageWireBytes(records, [], metadata),
    corruptRecords: 0,
    corruptRefs: Object.freeze([]),
    ...metadata
  })
}

function metadataList (
  database: DatabaseSync,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, {
    operation: 'tombstone.list' | 'audit.list'
  }>,
  snapshotAt: string
) {
  const isTombstone = request.operation === 'tombstone.list'
  const table = isTombstone ? 'tombstones' : 'lifecycle_audits'
  const idColumn = isTombstone ? 'tombstone_id' : 'audit_id'
  const timeColumn = isTombstone ? 'deleted_at_ms' : 'recorded_at_ms'
  const prefix = isTombstone ? 'tombstone:' : 'audit:'
  let anchorId: string | null = null
  let anchorTime = 0
  if (request.cursor !== null) {
    anchorId = refFromCursor(request.cursor, prefix)
    const row = database.prepare(`
      SELECT ${timeColumn} AS anchor_time FROM ${table}
      WHERE namespace_ref = ? AND namespace_generation = ? AND ${idColumn} = ?
    `).get(request.namespaceRef, request.targetGeneration, anchorId) as Row | undefined
    if (row === undefined) {
      return Object.freeze({ status: 'invalid_cursor' as const, operation: request.operation })
    }
    anchorTime = exactInteger(rowValue(row, 'anchor_time'))
  }
  const select = isTombstone
    ? `namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
       deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash,
       tombstone_wire AS canonical_wire, tombstone_wire_bytes AS canonical_wire_bytes`
    : `namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
       aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
       source_committed_at_ms, recorded_at_ms, expires_at_ms,
       audit_wire AS canonical_wire, audit_wire_bytes AS canonical_wire_bytes`
  const rows = database.prepare(`
    SELECT ${select}
    FROM ${table}
    WHERE namespace_ref = ? AND namespace_generation = ?
      AND (? IS NULL OR ${timeColumn} > ? OR (${timeColumn} = ? AND ${idColumn} > ?))
    ORDER BY ${timeColumn} ASC, ${idColumn} ASC
    LIMIT ?
  `).all(
    request.namespaceRef,
    request.targetGeneration,
    anchorId,
    anchorTime,
    anchorTime,
    anchorId ?? '',
    request.limit + 1
  ) as Row[]
  const records: unknown[] = []
  const wireRecords: unknown[] = []
  const corruptRefs: string[] = []
  let lastConsumed: Row | undefined
  let hasMore = false
  const selected = rows.slice(0, request.limit)
  for (const [index, row] of selected.entries()) {
    const ref = exactString(rowValue(row, idColumn))
    let record: unknown | null = null
    let wireRecord: unknown | null = null
    let corruptRef: string | null = null
    try {
      if (isTombstone) {
        const tombstone = canonicalWire(
          rowValue(row, 'canonical_wire'),
          rowValue(row, 'canonical_wire_bytes'),
          value => decodeMemoryTombstoneV1(exactString(value as SQLOutputValue))
        ).value
        if (tombstone.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
          tombstone.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
          tombstone.tombstoneId !== ref ||
          tombstone.memoryId !== nullableString(rowValue(row, 'memory_id')) ||
          tombstone.deletedRevision !== nullableInteger(rowValue(row, 'deleted_revision')) ||
          tombstone.deletionKind !== exactString(rowValue(row, 'deletion_kind')) ||
          Date.parse(tombstone.deletedAt) !== exactInteger(rowValue(row, 'deleted_at_ms')) ||
          Date.parse(tombstone.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
          tombstone.receiptHash !== exactString(rowValue(row, 'receipt_hash'))) {
          throw new CanonicalControlDataErrorV1()
        }
        record = tombstone
        wireRecord = Object.freeze({
          schemaVersion: 1 as const,
          tombstoneId: tombstone.tombstoneId,
          namespaceRef: tombstone.namespaceRef,
          namespaceGeneration: tombstone.namespaceGeneration,
          memoryId: tombstone.memoryId,
          deletedRevision: tombstone.deletedRevision,
          deletionKind: tombstone.deletionKind,
          deletedAt: tombstone.deletedAt,
          receiptHash: tombstone.receiptHash,
          expiresAt: tombstone.expiresAt
        })
      } else {
        const audit = canonicalWire(
          rowValue(row, 'canonical_wire'),
          rowValue(row, 'canonical_wire_bytes'),
          decodeMemoryLifecycleAuditV1
        ).value
        if (audit.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
          audit.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
          audit.auditId !== ref || audit.operation !== exactString(rowValue(row, 'operation')) ||
          audit.commandRefHash !== exactString(rowValue(row, 'command_ref_hash')) ||
          audit.aggregateRefHash !== exactString(rowValue(row, 'aggregate_ref_hash')) ||
          audit.authorizedByActorRefHash !== exactString(rowValue(row, 'authorized_actor_ref_hash')) ||
          audit.executedByActorRefHash !== exactString(rowValue(row, 'executed_actor_ref_hash')) ||
          Date.parse(audit.sourceCommittedAt) !==
            exactInteger(rowValue(row, 'source_committed_at_ms')) ||
          Date.parse(audit.recordedAt) !== exactInteger(rowValue(row, 'recorded_at_ms')) ||
          Date.parse(audit.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms'))) {
          throw new CanonicalControlDataErrorV1()
        }
        record = audit
        wireRecord = audit
      }
    } catch {
      if (!new RegExp(`^${prefix}[0-9a-f]{64}$`).test(ref)) {
        throw new CanonicalControlDataErrorV1()
      }
      corruptRef = ref
    }
    const candidateWireRecords = wireRecord === null
      ? wireRecords
      : [...wireRecords, wireRecord]
    const candidateCorruptRefs = corruptRef === null ? corruptRefs : [...corruptRefs, corruptRef]
    if (!pageFits(request, candidateWireRecords, candidateCorruptRefs)) {
      if (lastConsumed === undefined) return pageBudgetFailure()
      hasMore = true
      break
    }
    if (record !== null && wireRecord !== null) {
      records.push(record)
      wireRecords.push(wireRecord)
    }
    if (corruptRef !== null) corruptRefs.push(corruptRef)
    lastConsumed = row
    hasMore = index + 1 < rows.length
  }
  const nextCursor = hasMore && lastConsumed !== undefined
    ? cursorForRef(exactString(rowValue(lastConsumed, idColumn)), prefix)
    : null
  return Object.freeze({
    status: 'page' as const,
    operation: request.operation,
    snapshotAt,
    records: Object.freeze(records),
    nextCursor,
    wireBytes: pageWireBytes(wireRecords, corruptRefs),
    corruptRecords: corruptRefs.length,
    corruptRefs: Object.freeze(corruptRefs)
  })
}

function globalUsage (database: DatabaseSync, snapshotAt: string) {
  const row = database.prepare(`
    SELECT namespace_records, pending_proposal_records, active_memory_records,
      retained_revision_records, tombstone_records, lifecycle_audit_records,
      lifecycle_audit_reserved_records, lifecycle_command_records,
      deletion_checkpoint_records, export_job_records, canonical_logical_bytes,
      pending_outbox_records, outbox_logical_bytes, lifecycle_audit_logical_bytes,
      lifecycle_audit_reserved_bytes, lifecycle_command_logical_bytes,
      deletion_checkpoint_logical_bytes, export_job_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalControlDataErrorV1()
  const field = (name: string): number => exactInteger(rowValue(row, name))
  const actual = database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespace_records,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads) AS active_memory_records,
      (SELECT count(*) FROM revisions) AS retained_revision_records,
      (SELECT count(*) FROM revision_payloads) AS revision_payload_records,
      (SELECT count(*)
       FROM revisions r
       JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
         AND p.namespace_generation = r.namespace_generation
         AND p.memory_id = r.memory_id AND p.revision = r.revision
       WHERE r.revision_wire_bytes = length(CAST(p.revision_wire AS BLOB)))
        AS valid_revision_payload_records,
      (SELECT count(*) FROM tombstones) AS tombstone_records,
      (SELECT count(*) FROM lifecycle_audits) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations), 0)
        AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs) AS export_job_records,
      (SELECT coalesce(sum(namespace_wire_bytes), 0) FROM namespaces) +
        (SELECT coalesce(sum(proposal_wire_bytes), 0) FROM proposals) +
        (SELECT coalesce(sum(revision_wire_bytes), 0) FROM revisions) +
        (SELECT coalesce(sum(tombstone_wire_bytes), 0) FROM tombstones) +
        (SELECT coalesce(sum(manifest_wire_bytes), 0) FROM memory_v1_to_v2_manifests) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM consent_evidence) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM revision_evidence) +
        (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits) +
        (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands) +
        (SELECT coalesce(sum(checkpoint_wire_bytes), 0) FROM namespace_deletion_checkpoints) +
        (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) +
        (SELECT coalesce(sum(reservation_wire_bytes), 0) FROM export_audit_reservations)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox) AS pending_outbox_records,
      (SELECT coalesce(sum(logical_bytes), 0) FROM outbox) AS outbox_logical_bytes,
      (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits)
        AS lifecycle_audit_logical_bytes,
      (SELECT coalesce(sum(reserved_bytes), 0) FROM export_audit_reservations)
        AS lifecycle_audit_reserved_bytes,
      (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands)
        AS lifecycle_command_logical_bytes,
      (SELECT coalesce(sum(checkpoint_wire_bytes), 0) FROM namespace_deletion_checkpoints)
        AS deletion_checkpoint_logical_bytes,
      (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) AS export_job_logical_bytes
  `).get() as Row | undefined
  if (actual === undefined) throw new CanonicalControlDataErrorV1()
  const retainedRevisionRecords = exactInteger(rowValue(actual, 'retained_revision_records'))
  if (exactInteger(rowValue(actual, 'revision_payload_records')) !== retainedRevisionRecords ||
    exactInteger(rowValue(actual, 'valid_revision_payload_records')) !== retainedRevisionRecords) {
    throw new CanonicalControlDataErrorV1()
  }
  for (const name of [
    'namespace_records', 'pending_proposal_records', 'active_memory_records',
    'retained_revision_records', 'tombstone_records', 'lifecycle_audit_records',
    'lifecycle_audit_reserved_records', 'lifecycle_command_records',
    'deletion_checkpoint_records', 'export_job_records', 'canonical_logical_bytes',
    'pending_outbox_records', 'outbox_logical_bytes', 'lifecycle_audit_logical_bytes',
    'lifecycle_audit_reserved_bytes', 'lifecycle_command_logical_bytes',
    'deletion_checkpoint_logical_bytes', 'export_job_logical_bytes'
  ]) {
    if (field(name) !== exactInteger(rowValue(actual, name))) {
      throw new CanonicalControlDataErrorV1()
    }
  }
  return Object.freeze({
    status: 'usage' as const,
    operation: 'usage.getGlobal' as const,
    snapshotAt,
    value: Object.freeze({
      schemaVersion: 1 as const,
      namespaceRecords: field('namespace_records'),
      pendingProposalRecords: field('pending_proposal_records'),
      activeMemoryRecords: field('active_memory_records'),
      retainedRevisionRecords: field('retained_revision_records'),
      tombstoneRecords: field('tombstone_records'),
      lifecycleAuditRecords: field('lifecycle_audit_records'),
      lifecycleAuditReservedRecords: field('lifecycle_audit_reserved_records'),
      lifecycleCommandRecords: field('lifecycle_command_records'),
      deletionCheckpointRecords: field('deletion_checkpoint_records'),
      exportJobRecords: field('export_job_records'),
      canonicalLogicalBytes: field('canonical_logical_bytes'),
      pendingOutboxRecords: field('pending_outbox_records'),
      outboxLogicalBytes: field('outbox_logical_bytes'),
      lifecycleAuditLogicalBytes: field('lifecycle_audit_logical_bytes'),
      lifecycleAuditReservedBytes: field('lifecycle_audit_reserved_bytes'),
      lifecycleCommandLogicalBytes: field('lifecycle_command_logical_bytes'),
      deletionCheckpointLogicalBytes: field('deletion_checkpoint_logical_bytes'),
      exportJobLogicalBytes: field('export_job_logical_bytes')
    })
  })
}

function deletionTombstoneId (deletionRef: string): string {
  return `tombstone:${memoryLifecycleDomainHashV1(
    MEMORY_DELETION_TOMBSTONE_ID_DOMAIN_V1,
    deletionRef
  )}`
}

function loadDeletionTombstone (
  database: DatabaseSync,
  namespaceRef: string,
  deletionRef: string
) {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
      deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash, tombstone_wire,
      tombstone_wire_bytes
    FROM tombstones WHERE namespace_ref = ? AND tombstone_id = ?
  `).get(namespaceRef, deletionTombstoneId(deletionRef)) as Row | undefined
  if (row === undefined) return null
  const tombstone = canonicalWire(
    rowValue(row, 'tombstone_wire'),
    rowValue(row, 'tombstone_wire_bytes'),
    value => decodeMemoryTombstoneV1(exactString(value as SQLOutputValue))
  ).value
  if (tombstone.namespaceRef !== namespaceRef ||
    tombstone.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    tombstone.tombstoneId !== exactString(rowValue(row, 'tombstone_id')) ||
    tombstone.memoryId !== nullableString(rowValue(row, 'memory_id')) ||
    tombstone.deletedRevision !== nullableInteger(rowValue(row, 'deleted_revision')) ||
    tombstone.deletionKind !== exactString(rowValue(row, 'deletion_kind')) ||
    Date.parse(tombstone.deletedAt) !== exactInteger(rowValue(row, 'deleted_at_ms')) ||
    Date.parse(tombstone.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
    tombstone.receiptHash !== exactString(rowValue(row, 'receipt_hash'))) {
    throw new CanonicalControlDataErrorV1()
  }
  return tombstone
}

function deletionCarrierKinds (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  memoryId: string | null
) {
  const exact = memoryId !== null
  const args = exact ? [namespaceRef, generation, memoryId] : [namespaceRef, generation]
  const proposal = exact
    ? database.prepare(`
        SELECT 1 AS present FROM proposals
          WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
        UNION ALL SELECT 1 AS present FROM consent_evidence
          WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id IN (
            SELECT proposal_id FROM proposals WHERE namespace_ref = ?
              AND namespace_generation = ? AND resulting_memory_id = ?
          ) LIMIT 1
      `).get(...args, namespaceRef, generation, namespaceRef, generation, memoryId) !== undefined
    : database.prepare(`
        SELECT 1 AS present FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
        UNION ALL SELECT 1 AS present FROM consent_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?
        UNION ALL SELECT 1 AS present FROM memory_v1_to_v2_manifests
          WHERE namespace_ref = ? AND namespace_generation = ? AND aggregate_kind = 'proposal'
        LIMIT 1
      `).get(...args, ...args, ...args) !== undefined
  const head = database.prepare(`
    SELECT 1 AS present FROM heads WHERE namespace_ref = ? AND namespace_generation = ?
      ${exact ? 'AND memory_id = ?' : ''} LIMIT 1
  `).get(...args) !== undefined
  const revision = exact
    ? database.prepare(`
        SELECT 1 AS present FROM revisions
          WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
        UNION ALL SELECT 1 AS present FROM revision_evidence
          WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
        UNION ALL SELECT 1 AS present FROM memory_v1_to_v2_manifests
          WHERE namespace_ref = ? AND namespace_generation = ?
            AND aggregate_kind = 'memory' AND aggregate_id = ? LIMIT 1
      `).get(...args, ...args, namespaceRef, generation, memoryId) !== undefined
    : database.prepare(`
        SELECT 1 AS present FROM revisions WHERE namespace_ref = ? AND namespace_generation = ?
        UNION ALL SELECT 1 AS present FROM revision_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?
        UNION ALL SELECT 1 AS present FROM memory_v1_to_v2_manifests
          WHERE namespace_ref = ? AND namespace_generation = ? AND aggregate_kind = 'memory'
        LIMIT 1
      `).get(...args, ...args, ...args) !== undefined
  const revisionPayload = database.prepare(`
    SELECT 1 AS present FROM revision_payloads
    WHERE namespace_ref = ? AND namespace_generation = ?
      ${exact ? 'AND memory_id = ?' : ''} LIMIT 1
  `).get(...args) !== undefined
  const contentOutbox = database.prepare(`
    SELECT 1 AS present FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
      ${exact ? "AND aggregate = 'record' AND aggregate_id = ? AND event_kind = 'record_upserted'" : "AND event_kind IN ('proposal_changed', 'record_upserted')"}
    LIMIT 1
  `).get(...args) !== undefined
  return Object.freeze([
    proposal ? 'proposal' as const : null,
    head ? 'head' as const : null,
    revision ? 'revision' as const : null,
    revisionPayload ? 'revision_payload' as const : null,
    contentOutbox ? 'content_outbox' as const : null
  ].filter((kind): kind is NonNullable<typeof kind> => kind !== null))
}

function deletionDerivedCleanup (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  deletingGeneration: number,
  memoryId: string | null
): 'queued' | 'applied' {
  const generation = memoryId === null ? currentGeneration : deletingGeneration
  return database.prepare(`
    SELECT 1 AS present FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
      AND aggregate = ? AND aggregate_id = ? AND event_kind = ? LIMIT 1
  `).get(
    namespaceRef,
    generation,
    memoryId === null ? 'namespace' : 'record',
    memoryId ?? namespaceRef,
    memoryId === null ? 'namespace_deleted' : 'record_forgotten'
  ) === undefined ? 'applied' : 'queued'
}

function deletionStatus (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  deletionRef: string,
  snapshotAt: string
) {
  const tombstone = loadDeletionTombstone(database, namespaceRef, deletionRef)
  if (tombstone === null) return null
  const receiptRows = database.prepare(`
    SELECT command_ref FROM lifecycle_commands
    WHERE namespace_ref = ? AND operation IN ('record.forget', 'namespace.delete')
      AND instr(result_wire, ?) > 0
    ORDER BY command_ref ASC LIMIT 2
  `).all(namespaceRef, deletionRef) as Row[]
  if (receiptRows.length > 1) throw new CanonicalControlDataErrorV1()
  const canonicalReceipt = receiptRows.length === 0
    ? null
    : resolveDeletionReceipt(
        database,
        namespaceRef,
        exactString(rowValue(receiptRows[0]!, 'command_ref')),
        deletionRef
      )
  if (receiptRows.length === 1 && canonicalReceipt === null) {
    throw new CanonicalControlDataErrorV1()
  }
  if (canonicalReceipt !== null && (
    canonicalReceipt.tombstoneId !== tombstone.tombstoneId ||
    canonicalReceipt.tombstoneReceiptHash !== tombstone.receiptHash ||
    canonicalReceipt.generationAfter !== tombstone.namespaceGeneration ||
    canonicalReceipt.memoryId !== tombstone.memoryId ||
    canonicalReceipt.deletedRevision !== tombstone.deletedRevision
  )) throw new CanonicalControlDataErrorV1()
  const checkpointRow = database.prepare(`
    SELECT deleting_generation, observed_current_generation, canonical_bodies,
      payload_deletion, wal_checkpoint, derived_cleanup, stage, receipt_hash,
      checkpoint_wire, checkpoint_wire_bytes, updated_at_ms
    FROM namespace_deletion_checkpoints WHERE namespace_ref = ? AND deletion_ref = ?
  `).get(namespaceRef, deletionRef) as Row | undefined
  let stored: ReturnType<typeof decodeDeletionStatusV1> | null = null
  if (checkpointRow !== undefined) {
    stored = canonicalWire(
      rowValue(checkpointRow, 'checkpoint_wire'),
      rowValue(checkpointRow, 'checkpoint_wire_bytes'),
      decodeDeletionStatusV1
    ).value
    if (stored.deletionRef !== deletionRef || stored.namespaceRef !== namespaceRef ||
      stored.deletingGeneration !==
        positiveInteger(rowValue(checkpointRow, 'deleting_generation')) ||
      stored.observedCurrentGeneration !==
        positiveInteger(rowValue(checkpointRow, 'observed_current_generation')) ||
      stored.canonicalBodies !== exactString(rowValue(checkpointRow, 'canonical_bodies')) ||
      stored.payloadDeletion !== exactString(rowValue(checkpointRow, 'payload_deletion')) ||
      stored.walCheckpoint !== exactString(rowValue(checkpointRow, 'wal_checkpoint')) ||
      stored.derivedCleanup !== exactString(rowValue(checkpointRow, 'derived_cleanup')) ||
      stored.stage !== exactString(rowValue(checkpointRow, 'stage')) ||
      stored.observedAt !==
        new Date(exactInteger(rowValue(checkpointRow, 'updated_at_ms'))).toISOString() ||
      !HASH_PATTERN.test(exactString(rowValue(checkpointRow, 'receipt_hash')))) {
      throw new CanonicalControlDataErrorV1()
    }
    if (canonicalReceipt !== null && canonicalReceipt.receiptHash !==
        exactString(rowValue(checkpointRow, 'receipt_hash'))) {
      throw new CanonicalControlDataErrorV1()
    }
  }
  const deletingGeneration = stored?.deletingGeneration ??
    (tombstone.deletionKind === 'namespace_deleted'
      ? tombstone.namespaceGeneration - 1
      : tombstone.namespaceGeneration)
  if (deletingGeneration <= 0 || deletingGeneration > currentGeneration) {
    throw new CanonicalControlDataErrorV1()
  }
  const remaining = deletionCarrierKinds(
    database,
    namespaceRef,
    deletingGeneration,
    tombstone.memoryId
  )
  if (stored?.stage === 'canonical_complete' && remaining.length > 0) {
    throw new CanonicalControlDataErrorV1()
  }
  const derivedCleanup = deletionDerivedCleanup(
    database,
    namespaceRef,
    currentGeneration,
    deletingGeneration,
    tombstone.memoryId
  )
  const canonicalBodies = remaining.length === 0 ? 'verified_absent' as const
    : stored === null ? 'unverified' as const : 'scrub_pending' as const
  const payloadDeletion = stored?.payloadDeletion ?? 'unverified'
  const walCheckpoint = stored?.walCheckpoint ?? 'unverified'
  const complete = remaining.length === 0 && payloadDeletion === 'secure_delete_on' &&
    walCheckpoint === 'truncated'
  return createDeletionStatusV1({
    deletionRef,
    namespaceRef,
    deletingGeneration,
    observedCurrentGeneration: currentGeneration,
    remainingCarrierKinds: remaining,
    canonicalBodies,
    payloadDeletion,
    walCheckpoint,
    derivedCleanup,
    stage: complete ? 'canonical_complete' : stored?.stage === 'logical_committed'
      ? 'logical_committed' : 'verification_pending',
    observedAt: snapshotAt
  })
}

function resolveDeletionReceipt (
  database: DatabaseSync,
  namespaceRef: string,
  commandRef: string,
  deletionRef: string
) {
  const row = database.prepare(`
    SELECT namespace_generation, command_hash, operation, aggregate_ref_hash,
      result_wire, result_wire_bytes, result_hash, committed_at_ms, expires_at_ms
    FROM lifecycle_commands WHERE namespace_ref = ? AND command_ref = ?
  `).get(namespaceRef, commandRef) as Row | undefined
  if (row === undefined) return null
  const operation = exactString(rowValue(row, 'operation'))
  const loaded = canonicalWire(
    rowValue(row, 'result_wire'),
    rowValue(row, 'result_wire_bytes'),
    decodeMemoryLifecycleStableResultWireV1
  )
  if (memoryLifecycleStableResultHashV1(loaded.wire) !==
      exactString(rowValue(row, 'result_hash'))) {
    throw new CanonicalControlDataErrorV1()
  }
  const result = loaded.value
  const commandHash = exactString(rowValue(row, 'command_hash'))
  const committedAt = exactInteger(rowValue(row, 'committed_at_ms'))
  if (!HASH_PATTERN.test(commandHash) || result.commandHash !== commandHash ||
    result.operation !== operation ||
    exactInteger(rowValue(row, 'expires_at_ms')) - committedAt !==
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
    throw new CanonicalControlDataErrorV1()
  }
  if (operation !== 'record.forget' && operation !== 'namespace.delete') return null
  if (result.status !== 'deletion_pending' && result.status !== 'deletion_complete') return null
  const receipt = result.receipt
  if (receipt.deletionRef !== deletionRef) return null
  const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace'
  const aggregateRef = operation === 'record.forget' ? receipt.memoryId : receipt.namespaceRef
  if (receipt.namespaceRef !== namespaceRef ||
    receipt.operation !== expectedReceiptOperation || aggregateRef === null ||
    receipt.generationBefore !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    receipt.commandRefHash !== memoryLifecycleCommandRefHashV1(commandRef) ||
    exactString(rowValue(row, 'aggregate_ref_hash')) !== memoryLifecycleDomainHashV1(
      'groupmate.memory.lifecycle-aggregate-ref.v1',
      aggregateRef
    ) ||
    receipt.committedAt !== new Date(committedAt).toISOString()) {
    throw new CanonicalControlDataErrorV1()
  }
  return receipt
}

function executeLocked (
  database: DatabaseSync,
  envelope: MemoryControlRepositoryAdapterEnvelopeV1,
  snapshotAt: string
): unknown {
  const denial = lockedAuthorizationDenial(envelope, snapshotAt)
  if (denial !== null) return denial
  const request = envelope.request
  const currentGeneration = loadNamespaceGeneration(database, request.namespaceRef)
  if (currentGeneration !== null && currentGeneration !== request.generation) {
    return Object.freeze({ status: 'denied' as const, category: 'authority' as const })
  }
  if (request.operation === 'usage.getGlobal') return globalUsage(database, snapshotAt)
  if (request.operation === 'proposal.list') {
    if (currentGeneration === null) return proposalList(database, request, snapshotAt)
    return proposalList(database, request, snapshotAt)
  }
  if (request.operation === 'record.listSafe' || request.operation === 'record.inspectList') {
    return recordList(database, request, snapshotAt)
  }
  if (request.operation === 'tombstone.list' || request.operation === 'audit.list') {
    return metadataList(database, request, snapshotAt)
  }
  if (request.operation === 'revision.list') return revisionList(database, request, snapshotAt)
  if (request.operation === 'proposal.inspect') {
    const row = database.prepare(`
      SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
        proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
        resulting_revision_hash, proposal_wire, proposal_wire_bytes
      FROM proposals
      WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
    `).get(request.namespaceRef, request.generation, request.proposalId) as Row | undefined
    if (row === undefined) return Object.freeze({ status: 'not_found', operation: request.operation,
      snapshotAt })
    const proposal = validateProposalRow(row)
    const lifecycle = projectMemoryProposalLifecycleV2(proposal, snapshotAt)
    if (!lifecycle.fullWireReadable) throw new CanonicalControlDataErrorV1()
    return Object.freeze({ status: 'found', operation: request.operation, snapshotAt,
      value: proposal, effectiveState: lifecycle.logicalState })
  }
  if (request.operation === 'record.inspectGet') {
    const row = loadHeadRow(database, request.namespaceRef, request.generation, request.memoryId)
    if (row === null) return Object.freeze({ status: 'not_found', operation: request.operation,
      snapshotAt })
    return Object.freeze({ status: 'found', operation: request.operation, snapshotAt,
      value: recordProjectionFromRow(row, snapshotAt) })
  }
  if (request.operation === 'revision.get') {
    const headRow = loadHeadRow(database, request.namespaceRef, request.generation, request.memoryId)
    if (headRow === null) return Object.freeze({ status: 'not_found', operation: request.operation,
      snapshotAt })
    const head = headProofFromRow(headRow, snapshotAt)
    if (head.lifecycleState === 'purge_due') return Object.freeze({
      status: 'record_purge_due', operation: request.operation, snapshotAt, head
    })
    validateHeadRevision(headRow, validateRevisionRow(headRow))
    const row = database.prepare(`
      SELECT r.namespace_ref, r.namespace_generation, r.memory_id, r.revision,
        r.operation, r.revision_hash, r.previous_revision_hash, r.changed_at_ms,
        r.revision_wire_bytes, p.revision_wire
      FROM revisions r
      JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id AND p.revision = r.revision
      WHERE r.namespace_ref = ? AND r.namespace_generation = ?
        AND r.memory_id = ? AND r.revision = ?
    `).get(request.namespaceRef, request.generation, request.memoryId, request.revision) as
      Row | undefined
    if (row === undefined) return Object.freeze({ status: 'not_found', operation: request.operation,
      snapshotAt })
    return Object.freeze({ status: 'found', operation: request.operation, snapshotAt,
      value: validateRevisionRow(row), head })
  }
  if (request.operation === 'deletion.getStatus') {
    const status = deletionStatus(
      database,
      request.namespaceRef,
      request.generation,
      request.deletionRef,
      snapshotAt
    )
    if (status === null) return Object.freeze({
      status: 'not_found' as const, operation: request.operation, snapshotAt
    })
    return Object.freeze({
      status: 'found' as const,
      operation: request.operation,
      snapshotAt,
      value: status
    })
  }
  if (request.operation === 'deletion.resolve') {
    const receipt = resolveDeletionReceipt(
      database,
      request.namespaceRef,
      request.commandRef,
      request.deletionRef
    )
    if (receipt === null) return Object.freeze({
      status: 'not_found' as const, operation: request.operation, snapshotAt
    })
    const status = deletionStatus(
      database,
      request.namespaceRef,
      request.generation,
      request.deletionRef,
      snapshotAt
    )
    if (status === null || status.deletingGeneration !== receipt.deletingGeneration) {
      throw new CanonicalControlDataErrorV1()
    }
    return Object.freeze({
      status: 'resolved' as const,
      operation: request.operation,
      snapshotAt,
      receipt,
      deletionStatus: status
    })
  }
  throw new CanonicalControlDataErrorV1()
}

function sqliteErrcode (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function storageFailure (error: unknown) {
  if (error instanceof CanonicalControlDataErrorV1 || error instanceof SyntaxError) {
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  const errcode = sqliteErrcode(error)
  const primary = errcode === null ? null : errcode & 0xff
  if (primary === 5 || primary === 6) return Object.freeze({
    status: 'unavailable' as const, category: 'busy' as const, retryable: true
  })
  if (primary === 10) return Object.freeze({
    status: 'unavailable' as const, category: 'io' as const, retryable: true
  })
  if (primary === 11 || primary === 26) return Object.freeze({
    status: 'corrupt' as const, category: 'canonical_data' as const
  })
  return Object.freeze({
    status: 'unavailable' as const, category: 'storage' as const, retryable: false
  })
}

export function createSqliteMemoryControlRepositoryV1 (
  options: CreateSqliteMemoryControlRepositoryOptionsV1
): MemoryControlRepositoryAdapterV1 {
  if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
    options.database === null || typeof options.database !== 'object' ||
    utilTypes.isProxy(options.database) || typeof options.database.exec !== 'function' ||
    typeof options.database.prepare !== 'function' || typeof options.now !== 'function' ||
    utilTypes.isProxy(options.now)) throw new TypeError('invalid memory control repository options')
  const { database, now } = options
  return Object.freeze({
    execute: async (
      envelope: MemoryControlRepositoryAdapterEnvelopeV1,
      signal?: AbortSignal
    ) => {
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      let started = false
      try {
        database.exec('BEGIN IMMEDIATE')
        started = true
        const snapshotAt = freezeTrustedNow(database, now)
        const result = executeLocked(database, envelope, snapshotAt)
        database.exec('COMMIT')
        started = false
        return result
      } catch (error) {
        if (started) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // The fixed canonical/storage result remains authoritative.
          }
        }
        return storageFailure(error)
      }
    }
  })
}
