import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  memoryAccessCapabilityAllowsV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1
} from './memory-lifecycle-authority.js'
import {
  decodeMemoryLifecycleCommandWireV1,
  memoryLifecycleCommandHashV1,
  parseMemoryLifecycleCommandV1,
  type MemoryLifecycleCommandWireV1,
  type MemoryProposalApprovalMaterialV1
} from './memory-lifecycle-command.js'
import {
  encodeMemoryConsentEvidenceV1,
  encodeMemoryProposalV2,
  encodeMemoryRevisionV2
} from './memory-lifecycle-codec.js'
import {
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleInstantV1
} from './memory-lifecycle-domain.js'
import type {
  MemoryLifecycleAdapterV1,
  MemoryLifecycleAuthorizationEnvelopeV1
} from './memory-lifecycle-port.js'
import {
  createMemoryLifecycleResultV1,
  decodeMemoryLifecycleStableResultWireV1,
  encodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleStableResultHashV1,
  type MemoryLifecycleResultV1
} from './memory-lifecycle-result.js'
import {
  encodeMemoryOutboxEventV1
} from './memory-codec.js'
import {
  createMemoryOutboxEventV1
} from './memory-domain.js'
import {
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_CURSOR_HASH_DOMAIN_V1,
  MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1
} from './sqlite-memory-repository.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

interface CreateSqliteMemoryLifecycleProposalAdapterOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

type Row = Readonly<Record<string, SQLOutputValue>>

class CanonicalLifecycleProposalDataErrorV1 extends Error {}

const DIRECT_SAVE_RECEIPT_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-direct-save-receipt.v1'
const LIFECYCLE_AGGREGATE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-aggregate-ref.v1'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const NAMESPACE_CANONICAL_SOFT_BYTES =
  MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes - (2 * 1_024 * 1_024)
const DEPLOYMENT_CANONICAL_SOFT_BYTES =
  MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes - (8 * 1_024 * 1_024)
const OUTBOX_SOFT_RECORDS = MEMORY_RESOURCE_LIMITS.unackedOutboxRecords - 256
const OUTBOX_SOFT_BYTES = MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes - (1 * 1_024 * 1_024)

function rowValue (row: Row, name: string): SQLOutputValue {
  if (!Object.hasOwn(row, name)) throw new CanonicalLifecycleProposalDataErrorV1()
  return row[name]
}

function exactString (value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new CanonicalLifecycleProposalDataErrorV1()
  return value
}

function exactInteger (value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalLifecycleProposalDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue): number {
  const result = exactInteger(value)
  if (result === 0) throw new CanonicalLifecycleProposalDataErrorV1()
  return result
}

function requireOneChange (changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new CanonicalLifecycleProposalDataErrorV1()
}

function domainHash (domain: string, preimage: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(preimage, 'utf8')
    .digest('hex')
}

function freezeTrustedNow (database: DatabaseSync, now: () => string): string {
  let wall: string
  try {
    wall = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
  } catch {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  const wallMs = Date.parse(wall)
  const row = database.prepare(`
    SELECT trusted_time_high_water_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  const persisted = exactInteger(rowValue(row, 'trusted_time_high_water_ms'))
  const trustedMs = Math.max(wallMs, persisted)
  const trusted = new Date(trustedMs)
  if (!Number.isFinite(trusted.getTime())) throw new CanonicalLifecycleProposalDataErrorV1()
  if (trustedMs > persisted) {
    const updated = database.prepare(`
      UPDATE lifecycle_deployment_state SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persisted)
    if (updated.changes !== 1) throw new CanonicalLifecycleProposalDataErrorV1()
  }
  return trusted.toISOString()
}

function resultFor (
  operation: 'proposal.createAndApprove',
  commandHash: string,
  payload: Readonly<Record<string, unknown>>
): MemoryLifecycleResultV1 {
  return createMemoryLifecycleResultV1({
    schemaVersion: 1,
    operation,
    commandHash,
    ...payload
  })
}

function denied (
  commandHash: string,
  category: 'access' | 'authority'
): MemoryLifecycleResultV1 {
  return resultFor('proposal.createAndApprove', commandHash, { status: 'denied', category })
}

function authorityDenial (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  freshNow: string,
  namespaceRef: string,
  generation: number,
  actorRef: string
): 'access' | 'authority' | null {
  if (!memoryAccessCapabilityAllowsV1(envelope.access, namespaceRef, freshNow)) return 'access'
  if (envelope.authority.kind !== 'actor' ||
    memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability) !== 'personal_subject') {
    return 'authority'
  }
  const request = (action: 'propose_create' | 'approve', requiredAuthority: 'safe' | 'ordinary') => ({
    botInstanceId: envelope.access.botInstanceId,
    accountId: envelope.access.accountId,
    sceneRef: envelope.access.sceneRef,
    namespaceRef,
    generation,
    actorRef,
    action,
    requiredAuthority
  })
  return memoryLifecycleActorCapabilityAllowsV1(
    envelope.authority.capability,
    request('propose_create', 'safe'),
    freshNow
  ) && memoryLifecycleActorCapabilityAllowsV1(
    envelope.authority.capability,
    request('approve', 'ordinary'),
    freshNow
  )
    ? null
    : 'authority'
}

interface CoreUsageV1 {
  readonly pendingProposalRecords: number
  readonly activeMemoryRecords: number
  readonly retainedRevisionRecords: number
  readonly tombstoneRecords: number
  readonly canonicalLogicalBytes: number
  readonly pendingOutboxRecords: number
  readonly outboxLogicalBytes: number
}

interface LifecycleUsageV1 {
  readonly lifecycleCommandRecords: number
  readonly lifecycleCommandLogicalBytes: number
}

interface GlobalUsageV1 extends CoreUsageV1, LifecycleUsageV1 {
  readonly namespaceRecords: number
}

function coreUsageFromRow (row: Row): CoreUsageV1 {
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

function loadGlobalUsage (database: DatabaseSync): GlobalUsageV1 {
  const row = database.prepare(`
    SELECT namespace_records, pending_proposal_records, active_memory_records,
      retained_revision_records, tombstone_records, canonical_logical_bytes,
      pending_outbox_records, outbox_logical_bytes, lifecycle_command_records,
      lifecycle_command_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  return Object.freeze({
    namespaceRecords: exactInteger(rowValue(row, 'namespace_records')),
    ...coreUsageFromRow(row),
    lifecycleCommandRecords: exactInteger(rowValue(row, 'lifecycle_command_records')),
    lifecycleCommandLogicalBytes: exactInteger(rowValue(row, 'lifecycle_command_logical_bytes'))
  })
}

function assertNotUndercounted (
  stored: Readonly<Record<string, number>>,
  actual: Row
): void {
  for (const [name, value] of Object.entries(stored)) {
    if (value < exactInteger(rowValue(actual, name))) {
      throw new CanonicalLifecycleProposalDataErrorV1()
    }
  }
}

function validateConservativeUsage (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  namespace: {
    readonly created: boolean
    readonly usage: CoreUsageV1
    readonly generationLifecycle: LifecycleUsageV1
    readonly lifecycle: LifecycleUsageV1
  },
  global: GlobalUsageV1
): void {
  const payloadCoverage = database.prepare(`
    SELECT
      (SELECT count(*) FROM revisions) AS revision_records,
      (SELECT count(*) FROM revision_payloads) AS payload_records,
      (SELECT count(*)
       FROM revisions r
       JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
         AND p.namespace_generation = r.namespace_generation
         AND p.memory_id = r.memory_id AND p.revision = r.revision
       WHERE r.revision_wire_bytes = length(CAST(p.revision_wire AS BLOB)))
        AS valid_payload_records
  `).get() as Row | undefined
  if (payloadCoverage === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  const revisionRecords = exactInteger(rowValue(payloadCoverage, 'revision_records'))
  if (exactInteger(rowValue(payloadCoverage, 'payload_records')) !== revisionRecords ||
    exactInteger(rowValue(payloadCoverage, 'valid_payload_records')) !== revisionRecords) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }

  const actualGlobal = database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespace_records,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads) AS active_memory_records,
      (SELECT count(*) FROM revisions) AS retained_revision_records,
      (SELECT count(*) FROM tombstones) AS tombstone_records,
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
      (SELECT count(*) FROM lifecycle_commands) AS lifecycle_command_records,
      (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands)
        AS lifecycle_command_logical_bytes
  `).get() as Row | undefined
  if (actualGlobal === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  assertNotUndercounted({
    namespace_records: global.namespaceRecords,
    pending_proposal_records: global.pendingProposalRecords,
    active_memory_records: global.activeMemoryRecords,
    retained_revision_records: global.retainedRevisionRecords,
    tombstone_records: global.tombstoneRecords,
    canonical_logical_bytes: global.canonicalLogicalBytes,
    pending_outbox_records: global.pendingOutboxRecords,
    outbox_logical_bytes: global.outboxLogicalBytes,
    lifecycle_command_records: global.lifecycleCommandRecords,
    lifecycle_command_logical_bytes: global.lifecycleCommandLogicalBytes
  }, actualGlobal)

  if (namespace.created) return
  const actualNamespace = database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals
       WHERE namespace_ref = ? AND namespace_generation = ? AND state = 'pending')
        AS pending_proposal_records,
      (SELECT count(*) FROM heads
       WHERE namespace_ref = ? AND namespace_generation = ?) AS active_memory_records,
      (SELECT count(*) FROM revisions
       WHERE namespace_ref = ? AND namespace_generation = ?) AS retained_revision_records,
      (SELECT count(*) FROM tombstones
       WHERE namespace_ref = ? AND namespace_generation = ?) AS tombstone_records,
      coalesce((SELECT namespace_wire_bytes FROM namespaces
        WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(proposal_wire_bytes) FROM proposals
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(revision_wire_bytes) FROM revisions
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(tombstone_wire_bytes) FROM tombstones
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(manifest_wire_bytes) FROM memory_v1_to_v2_manifests
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(evidence_wire_bytes) FROM consent_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(evidence_wire_bytes) FROM revision_evidence
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints
          WHERE namespace_ref = ? AND deleting_generation = ?), 0) +
        coalesce((SELECT sum(job_wire_bytes) FROM export_jobs
          WHERE namespace_ref = ? AND namespace_generation = ?), 0) +
        coalesce((SELECT sum(reservation_wire_bytes) FROM export_audit_reservations
          WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox
       WHERE namespace_ref = ? AND namespace_generation = ?) AS pending_outbox_records,
      coalesce((SELECT sum(logical_bytes) FROM outbox
        WHERE namespace_ref = ? AND namespace_generation = ?), 0) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_commands
       WHERE namespace_ref = ? AND namespace_generation = ?) AS lifecycle_command_records,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_command_logical_bytes
  `).get(...Array.from({ length: 20 }, () => [namespaceRef, generation]).flat()) as Row | undefined
  if (actualNamespace === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  assertNotUndercounted({
    pending_proposal_records: namespace.usage.pendingProposalRecords,
    active_memory_records: namespace.usage.activeMemoryRecords,
    retained_revision_records: namespace.usage.retainedRevisionRecords,
    tombstone_records: namespace.usage.tombstoneRecords,
    canonical_logical_bytes: namespace.usage.canonicalLogicalBytes,
    pending_outbox_records: namespace.usage.pendingOutboxRecords,
    outbox_logical_bytes: namespace.usage.outboxLogicalBytes,
    lifecycle_command_records: namespace.generationLifecycle.lifecycleCommandRecords,
    lifecycle_command_logical_bytes: namespace.generationLifecycle.lifecycleCommandLogicalBytes
  }, actualNamespace)

  const actualLifecycle = database.prepare(`
    SELECT count(*) AS lifecycle_command_records,
      coalesce(sum(result_wire_bytes), 0) AS lifecycle_command_logical_bytes
    FROM lifecycle_commands WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (actualLifecycle === undefined) throw new CanonicalLifecycleProposalDataErrorV1()
  assertNotUndercounted({
    lifecycle_command_records: namespace.lifecycle.lifecycleCommandRecords,
    lifecycle_command_logical_bytes: namespace.lifecycle.lifecycleCommandLogicalBytes
  }, actualLifecycle)
}

function loadNamespaceState (
  database: DatabaseSync,
  bundle: MemoryProposalApprovalMaterialV1
): {
    readonly generationMismatch: true
  } | {
    readonly generationMismatch: false
    readonly created: boolean
    readonly usage: CoreUsageV1
    readonly generationLifecycle: LifecycleUsageV1
    readonly lifecycle: LifecycleUsageV1
    readonly namespaceWireBytes: number
  } {
  const proposal = bundle.proposal
  const namespaceWire = memoryNamespaceWireV1(proposal.namespace)
  const namespaceWireBytes = Buffer.byteLength(namespaceWire, 'utf8')
  const row = database.prepare(`
    SELECT namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces WHERE namespace_ref = ?
  `).get(proposal.namespaceRef) as Row | undefined
  if (row === undefined) {
    if (proposal.namespaceGeneration !== 1) {
      return Object.freeze({ generationMismatch: true as const })
    }
    return Object.freeze({
      generationMismatch: false as const,
      created: true,
      usage: Object.freeze({
        pendingProposalRecords: 0,
        activeMemoryRecords: 0,
        retainedRevisionRecords: 0,
        tombstoneRecords: 0,
        canonicalLogicalBytes: namespaceWireBytes,
        pendingOutboxRecords: 0,
        outboxLogicalBytes: 0
      }),
      generationLifecycle: Object.freeze({
        lifecycleCommandRecords: 0,
        lifecycleCommandLogicalBytes: 0
      }),
      lifecycle: Object.freeze({ lifecycleCommandRecords: 0, lifecycleCommandLogicalBytes: 0 }),
      namespaceWireBytes
    })
  }
  const storedWire = exactString(rowValue(row, 'namespace_wire'))
  if (Buffer.byteLength(storedWire, 'utf8') !== positiveInteger(rowValue(row, 'namespace_wire_bytes'))) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  let storedNamespace: ReturnType<typeof parseMemoryNamespaceV1>
  try {
    storedNamespace = parseMemoryNamespaceV1(JSON.parse(storedWire) as unknown)
  } catch {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  if (memoryNamespaceRefV1(storedNamespace) !== proposal.namespaceRef ||
    memoryNamespaceWireV1(storedNamespace) !== storedWire || storedWire !== namespaceWire) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  if (positiveInteger(rowValue(row, 'namespace_generation')) !== proposal.namespaceGeneration) {
    return Object.freeze({ generationMismatch: true as const })
  }
  const usageRow = database.prepare(`
    SELECT pending_proposal_records, active_memory_records, retained_revision_records,
      tombstone_records, canonical_logical_bytes, pending_outbox_records,
      outbox_logical_bytes, lifecycle_command_records, lifecycle_command_logical_bytes
    FROM usage WHERE namespace_ref = ? AND namespace_generation = ?
  `).get(proposal.namespaceRef, proposal.namespaceGeneration) as Row | undefined
  const lifecycleRow = database.prepare(`
    SELECT lifecycle_command_records, lifecycle_command_logical_bytes
    FROM lifecycle_namespace_usage WHERE namespace_ref = ?
  `).get(proposal.namespaceRef) as Row | undefined
  if (usageRow === undefined || lifecycleRow === undefined) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  return Object.freeze({
    generationMismatch: false as const,
    created: false,
    usage: coreUsageFromRow(usageRow),
    generationLifecycle: Object.freeze({
      lifecycleCommandRecords: exactInteger(rowValue(usageRow, 'lifecycle_command_records')),
      lifecycleCommandLogicalBytes: exactInteger(
        rowValue(usageRow, 'lifecycle_command_logical_bytes')
      )
    }),
    lifecycle: Object.freeze({
      lifecycleCommandRecords: exactInteger(rowValue(lifecycleRow, 'lifecycle_command_records')),
      lifecycleCommandLogicalBytes: exactInteger(
        rowValue(lifecycleRow, 'lifecycle_command_logical_bytes')
      )
    }),
    namespaceWireBytes
  })
}

function insertNamespaceState (
  database: DatabaseSync,
  bundle: MemoryProposalApprovalMaterialV1,
  namespaceWireBytes: number,
  nowMs: number
): void {
  const proposal = bundle.proposal
  const namespaceWire = memoryNamespaceWireV1(proposal.namespace)
  requireOneChange(database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation,
      created_at_ms, updated_at_ms, content_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(
    proposal.namespaceRef,
    namespaceWire,
    namespaceWireBytes,
    proposal.namespaceGeneration,
    nowMs,
    nowMs
  ).changes)
  requireOneChange(database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes
    ) VALUES (?, ?, 0, 0, 0, 0, ?, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `).run(proposal.namespaceRef, proposal.namespaceGeneration, namespaceWireBytes, nowMs).changes)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_namespace_usage(
      namespace_ref, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes, updated_at_ms
    ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
  `).run(proposal.namespaceRef, nowMs).changes)
}

function nextOutboxSequence (database: DatabaseSync): number {
  const row = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`).get() as
    Row | undefined
  if (row === undefined) return 1
  const current = exactInteger(rowValue(row, 'seq'))
  if (current >= Number.MAX_SAFE_INTEGER - 1) throw new CanonicalLifecycleProposalDataErrorV1()
  return current + 1
}

function prepareEvent (
  sequence: number,
  namespaceRef: string,
  generation: number,
  aggregate: 'proposal' | 'record',
  aggregateId: string,
  revision: number,
  eventKind: 'proposal_changed' | 'record_upserted',
  occurredAt: string
) {
  const eventId = `event:${domainHash(
    MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1,
    JSON.stringify({
      sequence,
      namespaceRef,
      namespaceGeneration: generation,
      aggregate,
      aggregateId,
      revision,
      eventKind
    })
  )}`
  const event = createMemoryOutboxEventV1({
    eventId,
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
  return Object.freeze({ event, wire, wireBytes: Buffer.byteLength(wire, 'utf8') })
}

function insertEvent (database: DatabaseSync, prepared: ReturnType<typeof prepareEvent>): void {
  const event = prepared.event
  requireOneChange(database.prepare(`
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
    Date.parse(event.occurredAt),
    Date.parse(event.occurredAt),
    prepared.wire,
    prepared.wireBytes
  ).changes)
}

function existingLedgerResult (
  database: DatabaseSync,
  wire: MemoryLifecycleCommandWireV1,
  bundle: MemoryProposalApprovalMaterialV1,
  commandHash: string
): MemoryLifecycleResultV1 | null | 'conflict' {
  const row = database.prepare(`
    SELECT namespace_generation, command_hash, operation, aggregate_ref_hash,
      result_wire, result_wire_bytes, result_hash, committed_at_ms, expires_at_ms
    FROM lifecycle_commands WHERE namespace_ref = ? AND command_ref = ?
  `).get(wire.namespaceRef, wire.commandRef) as Row | undefined
  if (row === undefined) return null
  const resultWire = exactString(rowValue(row, 'result_wire'))
  const storedCommandHash = exactString(rowValue(row, 'command_hash'))
  const storedOperation = exactString(rowValue(row, 'operation'))
  const aggregateRefHash = exactString(rowValue(row, 'aggregate_ref_hash'))
  const committedAtMs = exactInteger(rowValue(row, 'committed_at_ms'))
  const expiresAtMs = positiveInteger(rowValue(row, 'expires_at_ms'))
  if (Buffer.byteLength(resultWire, 'utf8') !== positiveInteger(rowValue(row, 'result_wire_bytes')) ||
    memoryLifecycleStableResultHashV1(resultWire) !== exactString(rowValue(row, 'result_hash')) ||
    !HASH_PATTERN.test(storedCommandHash) || !HASH_PATTERN.test(aggregateRefHash) ||
    expiresAtMs - committedAtMs !==
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  let result: ReturnType<typeof decodeMemoryLifecycleStableResultWireV1>
  try {
    result = decodeMemoryLifecycleStableResultWireV1(resultWire)
  } catch {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  if (result.commandHash !== storedCommandHash || result.operation !== storedOperation) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  if (storedCommandHash !== commandHash || storedOperation !== 'proposal.createAndApprove') {
    return 'conflict'
  }
  const expectedAggregateRefHash = memoryLifecycleDomainHashV1(
    LIFECYCLE_AGGREGATE_REF_HASH_DOMAIN_V1,
    bundle.record.memoryId
  )
  const expectedReceiptHash = directSaveReceiptHash(commandHash, bundle)
  if (positiveInteger(rowValue(row, 'namespace_generation')) !==
      wire.expectedNamespaceGeneration || aggregateRefHash !== expectedAggregateRefHash ||
    result.status !== 'stored' || result.resultRef !== bundle.record.memoryId ||
    result.resultRevision !== bundle.record.revision ||
    result.resultHash !== bundle.revision.revisionHash ||
    result.receiptHash !== expectedReceiptHash) {
    throw new CanonicalLifecycleProposalDataErrorV1()
  }
  return result
}

function directSaveReceiptHash (
  commandHash: string,
  bundle: MemoryProposalApprovalMaterialV1
): string {
  return memoryLifecycleDomainHashV1(
    DIRECT_SAVE_RECEIPT_HASH_DOMAIN_V1,
    JSON.stringify({
      commandHash,
      proposalId: bundle.proposal.proposalId,
      evidenceHash: bundle.consentEvidence.evidenceHash,
      revisionHash: bundle.revision.revisionHash
    })
  )
}

function capacityFailure (
  usage: CoreUsageV1,
  lifecycle: LifecycleUsageV1,
  global: GlobalUsageV1
): 'active_records' | 'canonical_bytes' | 'outbox_records' | 'outbox_bytes' |
'command_ledger' | 'namespaces' | null {
  if (global.namespaceRecords > MEMORY_RESOURCE_LIMITS.deploymentNamespaces) return 'namespaces'
  if (usage.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
    global.activeMemoryRecords > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords) {
    return 'active_records'
  }
  if (usage.canonicalLogicalBytes > NAMESPACE_CANONICAL_SOFT_BYTES ||
    global.canonicalLogicalBytes > DEPLOYMENT_CANONICAL_SOFT_BYTES) return 'canonical_bytes'
  if (global.pendingOutboxRecords > OUTBOX_SOFT_RECORDS) return 'outbox_records'
  if (global.outboxLogicalBytes > OUTBOX_SOFT_BYTES) return 'outbox_bytes'
  if (lifecycle.lifecycleCommandRecords >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace ||
    lifecycle.lifecycleCommandLogicalBytes >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace ||
    global.lifecycleCommandRecords >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerDeployment ||
    global.lifecycleCommandLogicalBytes >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerDeployment) {
    return 'command_ledger'
  }
  return null
}

function executeCreateAndApprove (
  database: DatabaseSync,
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  freshNow: string
): MemoryLifecycleResultV1 {
  const command = parseMemoryLifecycleCommandV1(envelope.command)
  const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
  const commandHash = memoryLifecycleCommandHashV1(command.wire)
  if (wire.operation !== 'proposal.createAndApprove') {
    return resultFor('proposal.createAndApprove', commandHash, {
      status: 'unavailable', category: 'storage', retryable: false
    })
  }
  const bundle = command.material as MemoryProposalApprovalMaterialV1
  const denial = authorityDenial(
    envelope,
    freshNow,
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    wire.initiatedByActorRef
  )
  if (denial !== null) return denied(commandHash, denial)
  const replay = existingLedgerResult(
    database,
    wire,
    bundle,
    commandHash
  )
  if (replay === 'conflict') {
    return resultFor(wire.operation, commandHash, { status: 'conflict', category: 'idempotency' })
  }
  if (replay !== null) return replay
  if (Date.parse(wire.occurredAt) > Date.parse(freshNow)) {
    return denied(commandHash, 'authority')
  }
  const globalBefore = loadGlobalUsage(database)
  const namespace = loadNamespaceState(database, bundle)
  if (namespace.generationMismatch) return denied(commandHash, 'authority')
  validateConservativeUsage(
    database,
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    namespace,
    globalBefore
  )
  const duplicate = database.prepare(`
    SELECT 1 FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
      AND proposal_id = ?
    UNION ALL
    SELECT 1 FROM heads WHERE namespace_ref = ? AND namespace_generation = ?
      AND memory_id = ?
    LIMIT 1
  `).get(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.proposal.proposalId,
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.record.memoryId
  )
  if (duplicate !== undefined) {
    return resultFor(wire.operation, commandHash, { status: 'conflict', category: 'idempotency' })
  }
  const proposalWire = encodeMemoryProposalV2(bundle.proposal)
  const evidenceWire = encodeMemoryConsentEvidenceV1(bundle.consentEvidence)
  const revisionWire = encodeMemoryRevisionV2(bundle.revision)
  const proposalBytes = Buffer.byteLength(proposalWire, 'utf8')
  const evidenceBytes = Buffer.byteLength(evidenceWire, 'utf8')
  const revisionBytes = Buffer.byteLength(revisionWire, 'utf8')
  const receiptHash = directSaveReceiptHash(commandHash, bundle)
  const result = resultFor(wire.operation, commandHash, {
    status: 'stored',
    resultRef: bundle.record.memoryId,
    resultRevision: bundle.record.revision,
    resultHash: bundle.revision.revisionHash,
    receiptHash
  })
  const resultWire = encodeMemoryLifecycleStableResultWireV1(result)
  const resultWireBytes = Buffer.byteLength(resultWire, 'utf8')
  const sequence = nextOutboxSequence(database)
  const events = [
    prepareEvent(
      sequence,
      wire.namespaceRef,
      wire.expectedNamespaceGeneration,
      'proposal',
      bundle.proposal.proposalId,
      bundle.proposal.revision,
      'proposal_changed',
      wire.occurredAt
    ),
    prepareEvent(
      sequence + 1,
      wire.namespaceRef,
      wire.expectedNamespaceGeneration,
      'record',
      bundle.record.memoryId,
      bundle.record.revision,
      'record_upserted',
      wire.occurredAt
    )
  ] as const
  const outboxBytes = events.reduce((total, event) => total + event.wireBytes, 0)
  const canonicalDelta = proposalBytes + evidenceBytes + revisionBytes + resultWireBytes
  const usage: CoreUsageV1 = Object.freeze({
    ...namespace.usage,
    activeMemoryRecords: namespace.usage.activeMemoryRecords + 1,
    retainedRevisionRecords: namespace.usage.retainedRevisionRecords + 1,
    canonicalLogicalBytes: namespace.usage.canonicalLogicalBytes + canonicalDelta,
    pendingOutboxRecords: namespace.usage.pendingOutboxRecords + 2,
    outboxLogicalBytes: namespace.usage.outboxLogicalBytes + outboxBytes
  })
  const lifecycle: LifecycleUsageV1 = Object.freeze({
    lifecycleCommandRecords: namespace.lifecycle.lifecycleCommandRecords + 1,
    lifecycleCommandLogicalBytes:
      namespace.lifecycle.lifecycleCommandLogicalBytes + resultWireBytes
  })
  const generationLifecycle: LifecycleUsageV1 = Object.freeze({
    lifecycleCommandRecords: namespace.generationLifecycle.lifecycleCommandRecords + 1,
    lifecycleCommandLogicalBytes:
      namespace.generationLifecycle.lifecycleCommandLogicalBytes + resultWireBytes
  })
  const global: GlobalUsageV1 = Object.freeze({
    ...globalBefore,
    namespaceRecords: globalBefore.namespaceRecords + (namespace.created ? 1 : 0),
    activeMemoryRecords: globalBefore.activeMemoryRecords + 1,
    retainedRevisionRecords: globalBefore.retainedRevisionRecords + 1,
    canonicalLogicalBytes: globalBefore.canonicalLogicalBytes +
      (namespace.created ? namespace.namespaceWireBytes : 0) + canonicalDelta,
    pendingOutboxRecords: globalBefore.pendingOutboxRecords + 2,
    outboxLogicalBytes: globalBefore.outboxLogicalBytes + outboxBytes,
    lifecycleCommandRecords: globalBefore.lifecycleCommandRecords + 1,
    lifecycleCommandLogicalBytes:
      globalBefore.lifecycleCommandLogicalBytes + resultWireBytes
  })
  const capacity = capacityFailure(usage, lifecycle, global)
  if (capacity !== null) return resultFor(wire.operation, commandHash, {
    status: 'capacity', category: capacity
  })

  if (namespace.created) {
    insertNamespaceState(database, bundle, namespace.namespaceWireBytes, Date.parse(freshNow))
  }

  requireOneChange(database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, ?, ?, 1, 'created', ?, NULL, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.revision.memoryId,
    bundle.revision.revisionHash,
    Date.parse(bundle.revision.changedAt),
    revisionBytes
  ).changes)
  requireOneChange(database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, ?, ?, 1, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.revision.memoryId,
    revisionWire
  ).changes)
  const cursorRef = domainHash(MEMORY_CURSOR_HASH_DOMAIN_V1, JSON.stringify({
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    updatedAt: bundle.record.updatedAt,
    memoryId: bundle.record.memoryId,
    currentRevision: bundle.record.revision
  }))
  requireOneChange(database.prepare(`
    INSERT INTO heads(
      namespace_ref, namespace_generation, memory_id, current_revision,
      current_revision_hash, content_hash, cursor_ref, updated_at_ms,
      valid_until_ms, purge_at_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.record.memoryId,
    bundle.revision.revisionHash,
    bundle.record.contentHash,
    cursorRef,
    Date.parse(bundle.record.updatedAt),
    Date.parse(bundle.record.retention.validUntil),
    Date.parse(bundle.record.retention.purgeAt)
  ).changes)
  requireOneChange(database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, ?, ?, 2, 'approved', ?, ?, ?, 1, ?, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.proposal.proposalId,
    Date.parse(bundle.proposal.proposedAt),
    Date.parse(bundle.proposal.decision!.decidedAt),
    bundle.record.memoryId,
    bundle.revision.revisionHash,
    proposalWire,
    proposalBytes
  ).changes)
  requireOneChange(database.prepare(`
    INSERT INTO consent_evidence(
      namespace_ref, namespace_generation, evidence_id, proposal_id,
      evidence_hash, evidence_wire, evidence_wire_bytes, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    bundle.consentEvidence.evidenceId,
    bundle.proposal.proposalId,
    bundle.consentEvidence.evidenceHash,
    evidenceWire,
    evidenceBytes,
    Date.parse(bundle.consentEvidence.approvedAt)
  ).changes)
  for (const event of events) insertEvent(database, event)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_commands(
      namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
      committed_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, 'proposal.createAndApprove', ?, ?, ?, ?, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.expectedNamespaceGeneration,
    wire.commandRef,
    commandHash,
    memoryLifecycleDomainHashV1(LIFECYCLE_AGGREGATE_REF_HASH_DOMAIN_V1, bundle.record.memoryId),
    resultWire,
    resultWireBytes,
    memoryLifecycleStableResultHashV1(resultWire),
    Date.parse(freshNow),
    Date.parse(freshNow) + MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs
  ).changes)
  requireOneChange(database.prepare(`
    UPDATE usage SET active_memory_records = ?, retained_revision_records = ?,
      canonical_logical_bytes = ?, pending_outbox_records = ?, outbox_logical_bytes = ?,
      lifecycle_command_records = ?, lifecycle_command_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(
    usage.activeMemoryRecords,
    usage.retainedRevisionRecords,
    usage.canonicalLogicalBytes,
    usage.pendingOutboxRecords,
    usage.outboxLogicalBytes,
    generationLifecycle.lifecycleCommandRecords,
    generationLifecycle.lifecycleCommandLogicalBytes,
    Date.parse(freshNow),
    wire.namespaceRef,
    wire.expectedNamespaceGeneration
  ).changes)
  requireOneChange(database.prepare(`
    UPDATE lifecycle_namespace_usage
    SET lifecycle_command_records = ?, lifecycle_command_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ?
  `).run(
    lifecycle.lifecycleCommandRecords,
    lifecycle.lifecycleCommandLogicalBytes,
    Date.parse(freshNow),
    wire.namespaceRef
  ).changes)
  requireOneChange(database.prepare(`
    UPDATE global_usage SET namespace_records = ?, active_memory_records = ?,
      retained_revision_records = ?, canonical_logical_bytes = ?,
      pending_outbox_records = ?, outbox_logical_bytes = ?,
      lifecycle_command_records = ?, lifecycle_command_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(
    global.namespaceRecords,
    global.activeMemoryRecords,
    global.retainedRevisionRecords,
    global.canonicalLogicalBytes,
    global.pendingOutboxRecords,
    global.outboxLogicalBytes,
    global.lifecycleCommandRecords,
    global.lifecycleCommandLogicalBytes,
    Date.parse(freshNow)
  ).changes)
  requireOneChange(database.prepare(`
    UPDATE namespaces SET content_epoch = content_epoch + 1, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(Date.parse(freshNow), wire.namespaceRef, wire.expectedNamespaceGeneration).changes)
  return result
}

function sqliteErrcode (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function failureResult (error: unknown, commandHash: string): MemoryLifecycleResultV1 {
  if (error instanceof CanonicalLifecycleProposalDataErrorV1 || error instanceof SyntaxError) {
    return resultFor('proposal.createAndApprove', commandHash, {
      status: 'corrupt', category: 'canonical_data'
    })
  }
  const errcode = sqliteErrcode(error)
  const primary = errcode === null ? null : errcode & 0xff
  if (primary === 5 || primary === 6) return resultFor('proposal.createAndApprove', commandHash, {
    status: 'unavailable', category: 'busy', retryable: true
  })
  if (primary === 10) return resultFor('proposal.createAndApprove', commandHash, {
    status: 'unavailable', category: 'io', retryable: true
  })
  if (primary === 11 || primary === 26) return resultFor('proposal.createAndApprove', commandHash, {
    status: 'corrupt', category: 'canonical_data'
  })
  return resultFor('proposal.createAndApprove', commandHash, {
    status: 'unavailable', category: 'storage', retryable: false
  })
}

export function createSqliteMemoryLifecycleProposalAdapterV1 (
  options: CreateSqliteMemoryLifecycleProposalAdapterOptionsV1
): MemoryLifecycleAdapterV1 {
  if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
    options.database === null || typeof options.database !== 'object' ||
    utilTypes.isProxy(options.database) || typeof options.database.exec !== 'function' ||
    typeof options.database.prepare !== 'function' || typeof options.now !== 'function' ||
    utilTypes.isProxy(options.now)) throw new TypeError('invalid lifecycle proposal adapter options')
  const { database, now } = options
  return Object.freeze({
    execute: async (envelope: MemoryLifecycleAuthorizationEnvelopeV1) => {
      let commandHash = '0'.repeat(64)
      try {
        commandHash = memoryLifecycleCommandHashV1(envelope.command.wire)
      } catch {
        return failureResult(new CanonicalLifecycleProposalDataErrorV1(), commandHash)
      }
      let started = false
      try {
        database.exec('BEGIN IMMEDIATE')
        started = true
        const freshNow = freezeTrustedNow(database, now)
        const result = executeCreateAndApprove(database, envelope, freshNow)
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
        return failureResult(error, commandHash)
      }
    }
  })
}
