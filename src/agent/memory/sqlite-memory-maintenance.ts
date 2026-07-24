import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js'
import {
  MEMORY_MAINTENANCE_OPERATIONS_V1,
  memoryMaintenanceCapabilityAllowsRequestV1,
  type MemoryMaintenanceOperationV1
} from './memory-lifecycle-authority.js'
import {
  buildMemoryProposalDecisionV2,
  projectMemoryProposalLifecycleV2,
  projectMemoryRecordLifecycleV2
} from './memory-lifecycle-builder.js'
import {
  decodeDeletionStatusV1,
  decodeMemoryConsentEvidenceV1,
  decodeMemoryLifecycleAuditV1,
  decodeMemoryProposalV2,
  decodeMemoryV1ToV2AggregateManifestV1,
  encodeDeletionStatusV1,
  encodeMemoryLifecycleAuditV1,
  encodeMemoryProposalV2
} from './memory-lifecycle-codec.js'
import {
  createDeletionStatusV1,
  createMemoryLifecycleAuditV1,
  MEMORY_PROPOSAL_DEADLINE_DAYS_V2,
  MEMORY_RETENTION_PURGE_GRACE_DAYS_V2,
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleInstantV1,
  type DeletionMutationReceiptV1,
  type DeletionStatusV1,
  type MemoryProposalV2
} from './memory-lifecycle-domain.js'
import { MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 } from './memory-lifecycle-port.js'
import {
  decodeMemoryMaintenanceCommandWireV1,
  decodeMemoryMaintenanceBatchManifestV1,
  encodeMemoryMaintenanceBatchManifestV1,
  createMemoryMaintenanceBatchManifestV1,
  memoryMaintenanceBatchManifestHashV1,
  memoryMaintenanceCommandHashV1,
  memoryMaintenanceCommandRefHashV1,
  type MemoryMaintenanceAuthorizationEnvelopeV1,
  type MemoryMaintenanceBatchManifestV1,
  type MemoryMaintenancePortOptionsV1
} from './memory-maintenance-port.js'
import {
  decodeMemoryOutboxEventV1,
  decodeMemoryTombstoneV1,
  encodeMemoryOutboxEventV1,
  encodeMemoryTombstoneV1
} from './memory-codec.js'
import { createMemoryOutboxEventV1, createMemoryTombstoneV1 } from './memory-domain.js'
import {
  decodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleStableResultHashV1
} from './memory-lifecycle-result.js'
import {
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'
import {
  CanonicalLifecycleMutationDataErrorV1,
  deleteValidatedSqliteRecordCarriersV1,
  loadValidatedSqliteRecordCarriersV1
} from './sqlite-memory-lifecycle-mutation.js'
import { MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1 } from './sqlite-memory-repository.js'

interface CreateSqliteMemoryMaintenanceAdapterOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

type Row = Readonly<Record<string, SQLOutValue>>
type SQLOutValue = SQLOutputValue

class CanonicalMaintenanceDataErrorV1 extends Error {}
class MaintenanceCapacityErrorV1 extends Error {}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const MAINTENANCE_AGGREGATE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-aggregate-ref.v1'
const MAINTENANCE_ITEM_RECEIPT_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-item-receipt.v1'
const MAINTENANCE_ACTOR_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-actor-ref.v1'
const RETENTION_TOMBSTONE_ID_HASH_DOMAIN_V1 =
  'groupmate.memory.retention-tombstone-id.v1'
const EXPORT_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-ref.v1'
const DELETION_TOMBSTONE_ID_HASH_DOMAIN_V1 =
  'groupmate.memory.deletion-tombstone-id.v1'
const MUTATION_AGGREGATE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-aggregate-ref.v1'
const LIFECYCLE_AUDIT_RECORDS_PER_NAMESPACE = 8_192
const LIFECYCLE_AUDIT_BYTES_PER_NAMESPACE = 8 * 1_024 * 1_024
const LIFECYCLE_AUDIT_RECORDS_PER_DEPLOYMENT = 65_536
const LIFECYCLE_AUDIT_BYTES_PER_DEPLOYMENT = 64 * 1_024 * 1_024

const USAGE_FIELDS = Object.freeze([
  'pending_proposal_records', 'active_memory_records', 'retained_revision_records',
  'tombstone_records', 'canonical_logical_bytes', 'pending_outbox_records',
  'outbox_logical_bytes', 'lifecycle_audit_records',
  'lifecycle_audit_reserved_records', 'lifecycle_command_records',
  'deletion_checkpoint_records', 'export_job_records', 'lifecycle_audit_logical_bytes',
  'lifecycle_audit_reserved_bytes', 'lifecycle_command_logical_bytes',
  'deletion_checkpoint_logical_bytes', 'export_job_logical_bytes'
] as const)

const GLOBAL_USAGE_FIELDS = Object.freeze([
  'namespace_records', ...USAGE_FIELDS
] as const)

function rowValue (row: Row, name: string): SQLOutValue {
  if (!Object.hasOwn(row, name)) throw new CanonicalMaintenanceDataErrorV1()
  return row[name]
}

function exactString (value: SQLOutValue): string {
  if (typeof value !== 'string') throw new CanonicalMaintenanceDataErrorV1()
  return value
}

function exactInteger (value: SQLOutValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalMaintenanceDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutValue): number {
  const result = exactInteger(value)
  if (result === 0) throw new CanonicalMaintenanceDataErrorV1()
  return result
}

function nullableString (value: SQLOutValue): string | null {
  if (value === null) return null
  return exactString(value)
}

function nullableInteger (value: SQLOutValue): number | null {
  if (value === null) return null
  return positiveInteger(value)
}

function requireOneChange (value: number | bigint): void {
  if (value !== 1 && value !== 1n) throw new CanonicalMaintenanceDataErrorV1()
}

function canonicalWire<T> (
  wireValue: SQLOutValue,
  byteValue: SQLOutValue,
  decode: (wire: string) => T
): { readonly wire: string; readonly bytes: number; readonly value: T } {
  const wire = exactString(wireValue)
  const bytes = positiveInteger(byteValue)
  if (Buffer.byteLength(wire, 'utf8') !== bytes) throw new CanonicalMaintenanceDataErrorV1()
  try {
    return Object.freeze({ wire, bytes, value: decode(wire) })
  } catch {
    throw new CanonicalMaintenanceDataErrorV1()
  }
}

function freezeTrustedNow (database: DatabaseSync, now: () => string): string {
  let wall: string
  try {
    wall = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
  } catch {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const row = database.prepare(`
    SELECT trusted_time_high_water_ms FROM lifecycle_deployment_state WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  const persistedMs = exactInteger(rowValue(row, 'trusted_time_high_water_ms'))
  const trustedMs = Math.max(persistedMs, Date.parse(wall))
  const trusted = new Date(trustedMs)
  if (!Number.isFinite(trusted.getTime())) throw new CanonicalMaintenanceDataErrorV1()
  if (trustedMs > persistedMs) {
    requireOneChange(database.prepare(`
      UPDATE lifecycle_deployment_state SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persistedMs).changes)
  }
  return trusted.toISOString()
}

function loadNamespaceGeneration (database: DatabaseSync, namespaceRef: string): number | null {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) return null
  const loaded = canonicalWire(
    rowValue(row, 'namespace_wire'),
    rowValue(row, 'namespace_wire_bytes'),
    wire => parseMemoryNamespaceV1(JSON.parse(exactString(wire as SQLOutValue)) as unknown)
  )
  if (exactString(rowValue(row, 'namespace_ref')) !== namespaceRef ||
    memoryNamespaceRefV1(loaded.value) !== namespaceRef ||
    memoryNamespaceWireV1(loaded.value) !== loaded.wire) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return positiveInteger(rowValue(row, 'namespace_generation'))
}

function lockedAuthorizationDenial (
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
  freshNow: string
): { readonly status: 'denied'; readonly category: 'access' | 'authority' } | null {
  const wire = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
  if (!memoryAccessCapabilityAllowsV1(envelope.access, wire.namespaceRef, freshNow)) {
    return Object.freeze({ status: 'denied' as const, category: 'access' as const })
  }
  const request = Object.freeze({
    botInstanceId: envelope.access.botInstanceId,
    accountId: envelope.access.accountId,
    namespaceRef: wire.namespaceRef,
    currentGeneration: wire.currentGeneration,
    targetGeneration: wire.targetGeneration,
    deletionRef: wire.deletionRef,
    operation: wire.operation,
    limit: wire.limit
  })
  if (!memoryMaintenanceCapabilityAllowsRequestV1(
    envelope.maintenance,
    request,
    freshNow
  )) return Object.freeze({ status: 'denied' as const, category: 'authority' as const })
  return null
}

function generationUsageActual (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number
): Row {
  const params = Array.from({ length: 28 }, () => [namespaceRef, generation]).flat()
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
        AND state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads WHERE namespace_ref = ? AND namespace_generation = ?)
        AS active_memory_records,
      (SELECT count(*) FROM revisions WHERE namespace_ref = ? AND namespace_generation = ?)
        AS retained_revision_records,
      (SELECT count(*) FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ?)
        AS tombstone_records,
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
      (SELECT count(*) FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?)
        AS pending_outbox_records,
      coalesce((SELECT sum(logical_bytes) FROM outbox
        WHERE namespace_ref = ? AND namespace_generation = ?), 0) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_audits
        WHERE namespace_ref = ? AND namespace_generation = ?) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands
        WHERE namespace_ref = ? AND namespace_generation = ?) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints
        WHERE namespace_ref = ? AND deleting_generation = ?) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs
        WHERE namespace_ref = ? AND namespace_generation = ?) AS export_job_records,
      coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_audit_logical_bytes,
      coalesce((SELECT sum(reserved_bytes) FROM export_audit_reservations
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_audit_reserved_bytes,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS lifecycle_command_logical_bytes,
      coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints
        WHERE namespace_ref = ? AND deleting_generation = ?), 0)
        AS deletion_checkpoint_logical_bytes,
      coalesce((SELECT sum(job_wire_bytes) FROM export_jobs
        WHERE namespace_ref = ? AND namespace_generation = ?), 0)
        AS export_job_logical_bytes
  `).get(...params) as Row | undefined
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  return row
}

function namespaceLifecycleActual (database: DatabaseSync, namespaceRef: string): Row {
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM lifecycle_audits WHERE namespace_ref = ?)
        AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations
        WHERE namespace_ref = ?), 0) AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands WHERE namespace_ref = ?)
        AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints WHERE namespace_ref = ?)
        AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs WHERE namespace_ref = ?) AS export_job_records,
      coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits
        WHERE namespace_ref = ?), 0) AS lifecycle_audit_logical_bytes,
      coalesce((SELECT sum(reserved_bytes) FROM export_audit_reservations
        WHERE namespace_ref = ?), 0) AS lifecycle_audit_reserved_bytes,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands
        WHERE namespace_ref = ?), 0) AS lifecycle_command_logical_bytes,
      coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints
        WHERE namespace_ref = ?), 0) AS deletion_checkpoint_logical_bytes,
      coalesce((SELECT sum(job_wire_bytes) FROM export_jobs
        WHERE namespace_ref = ?), 0) AS export_job_logical_bytes
  `).get(...Array.from({ length: 10 }, () => namespaceRef)) as Row | undefined
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  return row
}

function globalUsageActual (database: DatabaseSync): Row {
  const row = database.prepare(`
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
      (SELECT count(*) FROM lifecycle_audits) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations), 0)
        AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs) AS export_job_records,
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
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  return row
}

function assertSameFields (stored: Row, actual: Row, fields: readonly string[]): void {
  for (const field of fields) {
    if (exactInteger(rowValue(stored, field)) !== exactInteger(rowValue(actual, field))) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
  }
}

function assertUsageExact (database: DatabaseSync, namespaceRef: string): void {
  const payloads = database.prepare(`
    SELECT (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS payloads,
      (SELECT count(*) FROM revisions r JOIN revision_payloads p
        ON p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id AND p.revision = r.revision
        WHERE r.revision_wire_bytes = length(CAST(p.revision_wire AS BLOB))) AS valid_payloads
  `).get() as Row | undefined
  if (payloads === undefined ||
    exactInteger(rowValue(payloads, 'revisions')) !== exactInteger(rowValue(payloads, 'payloads')) ||
    exactInteger(rowValue(payloads, 'revisions')) !==
      exactInteger(rowValue(payloads, 'valid_payloads'))) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const rows = database.prepare(`
    SELECT * FROM usage WHERE namespace_ref = ? ORDER BY namespace_generation ASC
  `).all(namespaceRef) as Row[]
  if (rows.length === 0) throw new CanonicalMaintenanceDataErrorV1()
  for (const row of rows) {
    assertSameFields(
      row,
      generationUsageActual(database, namespaceRef, positiveInteger(rowValue(row, 'namespace_generation'))),
      USAGE_FIELDS
    )
  }
  const lifecycle = database.prepare(`
    SELECT * FROM lifecycle_namespace_usage WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (lifecycle === undefined) throw new CanonicalMaintenanceDataErrorV1()
  assertSameFields(lifecycle, namespaceLifecycleActual(database, namespaceRef), USAGE_FIELDS.slice(7))
  const global = database.prepare('SELECT * FROM global_usage WHERE singleton = 1').get() as
    Row | undefined
  if (global === undefined) throw new CanonicalMaintenanceDataErrorV1()
  assertSameFields(global, globalUsageActual(database), GLOBAL_USAGE_FIELDS)
}

function capacityAllowed (database: DatabaseSync, namespaceRef: string): boolean {
  const global = globalUsageActual(database)
  if (exactInteger(rowValue(global, 'namespace_records')) > MEMORY_RESOURCE_LIMITS.deploymentNamespaces ||
    exactInteger(rowValue(global, 'active_memory_records')) >
      MEMORY_RESOURCE_LIMITS.deploymentActiveRecords ||
    exactInteger(rowValue(global, 'canonical_logical_bytes')) >
      MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes ||
    exactInteger(rowValue(global, 'pending_outbox_records')) >
      MEMORY_RESOURCE_LIMITS.unackedOutboxRecords ||
    exactInteger(rowValue(global, 'outbox_logical_bytes')) >
      MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes ||
    exactInteger(rowValue(global, 'lifecycle_command_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerDeployment ||
    exactInteger(rowValue(global, 'lifecycle_command_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerDeployment ||
    exactInteger(rowValue(global, 'deletion_checkpoint_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerDeployment ||
    exactInteger(rowValue(global, 'deletion_checkpoint_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointBytesPerDeployment ||
    exactInteger(rowValue(global, 'export_job_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerDeployment ||
    exactInteger(rowValue(global, 'export_job_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobBytesPerDeployment ||
    exactInteger(rowValue(global, 'lifecycle_audit_records')) +
      exactInteger(rowValue(global, 'lifecycle_audit_reserved_records')) >
      LIFECYCLE_AUDIT_RECORDS_PER_DEPLOYMENT ||
    exactInteger(rowValue(global, 'lifecycle_audit_logical_bytes')) +
      exactInteger(rowValue(global, 'lifecycle_audit_reserved_bytes')) >
      LIFECYCLE_AUDIT_BYTES_PER_DEPLOYMENT) return false
  const rows = database.prepare(`
    SELECT namespace_generation FROM usage WHERE namespace_ref = ?
  `).all(namespaceRef) as Row[]
  for (const row of rows) {
    const actual = generationUsageActual(
      database,
      namespaceRef,
      positiveInteger(rowValue(row, 'namespace_generation'))
    )
    if (exactInteger(rowValue(actual, 'pending_proposal_records')) >
        MEMORY_RESOURCE_LIMITS.namespacePendingProposals ||
      exactInteger(rowValue(actual, 'active_memory_records')) >
        MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
      exactInteger(rowValue(actual, 'canonical_logical_bytes')) >
        MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes) return false
  }
  const lifecycle = namespaceLifecycleActual(database, namespaceRef)
  return exactInteger(rowValue(lifecycle, 'lifecycle_command_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'lifecycle_command_logical_bytes')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace &&
    exactInteger(rowValue(lifecycle, 'deletion_checkpoint_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'export_job_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'export_job_logical_bytes')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobBytesPerNamespace &&
    exactInteger(rowValue(lifecycle, 'lifecycle_audit_records')) +
      exactInteger(rowValue(lifecycle, 'lifecycle_audit_reserved_records')) <=
      LIFECYCLE_AUDIT_RECORDS_PER_NAMESPACE &&
    exactInteger(rowValue(lifecycle, 'lifecycle_audit_logical_bytes')) +
      exactInteger(rowValue(lifecycle, 'lifecycle_audit_reserved_bytes')) <=
      LIFECYCLE_AUDIT_BYTES_PER_NAMESPACE
}

function synchronizeUsage (database: DatabaseSync, namespaceRef: string, nowMs: number): void {
  const rows = database.prepare(`
    SELECT namespace_generation FROM usage WHERE namespace_ref = ?
    ORDER BY namespace_generation ASC
  `).all(namespaceRef) as Row[]
  for (const row of rows) {
    const generation = positiveInteger(rowValue(row, 'namespace_generation'))
    const actual = generationUsageActual(database, namespaceRef, generation)
    const values = USAGE_FIELDS.map(field => exactInteger(rowValue(actual, field)))
    requireOneChange(database.prepare(`
      UPDATE usage SET pending_proposal_records = ?, active_memory_records = ?,
        retained_revision_records = ?, tombstone_records = ?, canonical_logical_bytes = ?,
        pending_outbox_records = ?, outbox_logical_bytes = ?, lifecycle_audit_records = ?,
        lifecycle_audit_reserved_records = ?, lifecycle_command_records = ?,
        deletion_checkpoint_records = ?, export_job_records = ?,
        lifecycle_audit_logical_bytes = ?, lifecycle_audit_reserved_bytes = ?,
        lifecycle_command_logical_bytes = ?, deletion_checkpoint_logical_bytes = ?,
        export_job_logical_bytes = ?, updated_at_ms = ?
      WHERE namespace_ref = ? AND namespace_generation = ?
    `).run(...values, nowMs, namespaceRef, generation).changes)
  }
  const lifecycle = namespaceLifecycleActual(database, namespaceRef)
  const lifecycleValues = USAGE_FIELDS.slice(7).map(field => exactInteger(rowValue(lifecycle, field)))
  requireOneChange(database.prepare(`
    UPDATE lifecycle_namespace_usage SET lifecycle_audit_records = ?,
      lifecycle_audit_reserved_records = ?, lifecycle_command_records = ?,
      deletion_checkpoint_records = ?, export_job_records = ?, lifecycle_audit_logical_bytes = ?,
      lifecycle_audit_reserved_bytes = ?, lifecycle_command_logical_bytes = ?,
      deletion_checkpoint_logical_bytes = ?, export_job_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ?
  `).run(...lifecycleValues, nowMs, namespaceRef).changes)
  const global = globalUsageActual(database)
  const globalValues = GLOBAL_USAGE_FIELDS.map(field => exactInteger(rowValue(global, field)))
  requireOneChange(database.prepare(`
    UPDATE global_usage SET namespace_records = ?, pending_proposal_records = ?,
      active_memory_records = ?, retained_revision_records = ?, tombstone_records = ?,
      canonical_logical_bytes = ?, pending_outbox_records = ?, outbox_logical_bytes = ?,
      lifecycle_audit_records = ?, lifecycle_audit_reserved_records = ?,
      lifecycle_command_records = ?, deletion_checkpoint_records = ?, export_job_records = ?,
      lifecycle_audit_logical_bytes = ?, lifecycle_audit_reserved_bytes = ?,
      lifecycle_command_logical_bytes = ?, deletion_checkpoint_logical_bytes = ?,
      export_job_logical_bytes = ?, updated_at_ms = ? WHERE singleton = 1
  `).run(...globalValues, nowMs).changes)
}

function itemReceiptHash (
  operation: MemoryMaintenanceOperationV1,
  aggregateRef: string,
  committedAt: string,
  outcome: string
): string {
  return memoryLifecycleDomainHashV1(
    MAINTENANCE_ITEM_RECEIPT_HASH_DOMAIN_V1,
    JSON.stringify({ operation, aggregateRef, committedAt, outcome })
  )
}

function aggregateRefHash (value: string): string {
  return memoryLifecycleDomainHashV1(MAINTENANCE_AGGREGATE_REF_HASH_DOMAIN_V1, value)
}

function maintenanceActorHash (): string {
  return memoryLifecycleDomainHashV1(
    MAINTENANCE_ACTOR_REF_HASH_DOMAIN_V1,
    MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
  )
}

function validateProposalRow (row: Row): MemoryProposalV2 {
  const loaded = canonicalWire(
    rowValue(row, 'proposal_wire'),
    rowValue(row, 'proposal_wire_bytes'),
    decodeMemoryProposalV2
  )
  const proposal = loaded.value
  const decision = proposal.decision
  const decidedAt = rowValue(row, 'decided_at_ms') === null
    ? null
    : new Date(exactInteger(rowValue(row, 'decided_at_ms'))).toISOString()
  if (proposal.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    proposal.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    proposal.proposalId !== exactString(rowValue(row, 'proposal_id')) ||
    proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
    proposal.state !== exactString(rowValue(row, 'state')) ||
    proposal.proposedAt !== new Date(exactInteger(rowValue(row, 'proposed_at_ms'))).toISOString() ||
    (decision === null ? null : decision.decidedAt) !== decidedAt ||
    (decision === null ? null : decision.resultingMemoryId) !==
      rowValue(row, 'resulting_memory_id') ||
    (decision === null ? null : decision.resultingMemoryRevision) !==
      rowValue(row, 'resulting_revision') ||
    (decision === null ? null : decision.resultingRevisionHash) !==
      rowValue(row, 'resulting_revision_hash')) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return proposal
}

function validateLifecycleAuditRow (
  row: Row,
  expectedNamespaceRef: string
): ReturnType<typeof decodeMemoryLifecycleAuditV1> {
  const audit = canonicalWire(
    rowValue(row, 'audit_wire'),
    rowValue(row, 'audit_wire_bytes'),
    decodeMemoryLifecycleAuditV1
  ).value
  if (audit.namespaceRef !== expectedNamespaceRef ||
    audit.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    audit.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    audit.auditId !== exactString(rowValue(row, 'audit_id')) ||
    audit.operation !== exactString(rowValue(row, 'operation')) ||
    audit.commandRefHash !== exactString(rowValue(row, 'command_ref_hash')) ||
    audit.aggregateRefHash !== exactString(rowValue(row, 'aggregate_ref_hash')) ||
    audit.authorizedByActorRefHash !==
      exactString(rowValue(row, 'authorized_actor_ref_hash')) ||
    audit.executedByActorRefHash !== exactString(rowValue(row, 'executed_actor_ref_hash')) ||
    Date.parse(audit.sourceCommittedAt) !==
      exactInteger(rowValue(row, 'source_committed_at_ms')) ||
    Date.parse(audit.recordedAt) !== exactInteger(rowValue(row, 'recorded_at_ms')) ||
    Date.parse(audit.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms'))) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return audit
}

function proposalRows (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  operation: 'proposal.expireDue' | 'proposal.purgeDecided',
  freshNow: string
): Row[] {
  if (operation === 'proposal.expireDue') return database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND state = 'pending'
    ORDER BY proposed_at_ms ASC, proposal_id ASC LIMIT 257
  `).all(namespaceRef, generation) as Row[]
  const graceMs = MEMORY_RETENTION_PURGE_GRACE_DAYS_V2 * 24 * 60 * 60 * 1_000
  const expiredGraceMs = (
    MEMORY_PROPOSAL_DEADLINE_DAYS_V2 + MEMORY_RETENTION_PURGE_GRACE_DAYS_V2
  ) * 24 * 60 * 60 * 1_000
  return database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND state != 'pending'
      AND ((state = 'expired' AND proposed_at_ms <= ?) OR
        (state != 'expired' AND decided_at_ms <= ?))
    ORDER BY CASE WHEN state = 'expired' THEN proposed_at_ms ELSE decided_at_ms END ASC,
      proposal_id ASC LIMIT 33
  `).all(
    namespaceRef,
    generation,
    Date.parse(freshNow) - expiredGraceMs,
    Date.parse(freshNow) - graceMs
  ) as Row[]
}

function insertProposalEvent (
  database: DatabaseSync,
  proposal: MemoryProposalV2,
  occurredAt: string
): void {
  const sequenceRow = database.prepare(`
    SELECT seq FROM sqlite_sequence WHERE name = 'outbox'
  `).get() as Row | undefined
  const sequence = sequenceRow === undefined
    ? 1
    : exactInteger(rowValue(sequenceRow, 'seq')) + 1
  if (!Number.isSafeInteger(sequence)) throw new CanonicalMaintenanceDataErrorV1()
  const eventId = `event:${memoryLifecycleDomainHashV1(
    MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1,
    JSON.stringify({
      sequence,
      namespaceRef: proposal.namespaceRef,
      namespaceGeneration: proposal.namespaceGeneration,
      aggregate: 'proposal',
      aggregateId: proposal.proposalId,
      revision: proposal.revision,
      eventKind: 'proposal_changed'
    })
  )}`
  const event = createMemoryOutboxEventV1({
    eventId,
    sequence,
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    aggregate: 'proposal',
    aggregateId: proposal.proposalId,
    revision: proposal.revision,
    eventKind: 'proposal_changed',
    occurredAt
  })
  const wire = encodeMemoryOutboxEventV1(event)
  const bytes = Buffer.byteLength(wire, 'utf8')
  requireOneChange(database.prepare(`
    INSERT INTO outbox(
      sequence, event_id, namespace_ref, namespace_generation, aggregate, aggregate_id,
      revision, event_kind, occurred_at_ms, available_at_ms, event_wire, logical_bytes,
      lease_owner_id, lease_token, leased_until_ms, attempt_count, last_reason_code
    ) VALUES (?, ?, ?, ?, 'proposal', ?, ?, 'proposal_changed', ?, ?, ?, ?,
      NULL, NULL, NULL, 0, NULL)
  `).run(
    sequence,
    event.eventId,
    event.namespaceRef,
    event.namespaceGeneration,
    event.aggregateId,
    event.revision,
    Date.parse(occurredAt),
    Date.parse(occurredAt),
    wire,
    bytes
  ).changes)
}

function validateAndDeleteProposalCarriers (
  database: DatabaseSync,
  proposal: MemoryProposalV2
): void {
  const evidenceRows = database.prepare(`
    SELECT evidence_id, evidence_hash, evidence_wire, evidence_wire_bytes, created_at_ms
    FROM consent_evidence WHERE namespace_ref = ? AND namespace_generation = ?
      AND proposal_id = ? ORDER BY evidence_id ASC LIMIT 2
  `).all(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId) as Row[]
  if (evidenceRows.length > 1 ||
    (proposal.state === 'approved') !== (evidenceRows.length === 1)) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  for (const row of evidenceRows) {
    const evidence = canonicalWire(
      rowValue(row, 'evidence_wire'),
      rowValue(row, 'evidence_wire_bytes'),
      decodeMemoryConsentEvidenceV1
    ).value
    if (evidence.proposalId !== proposal.proposalId ||
      evidence.namespaceRef !== proposal.namespaceRef ||
      evidence.namespaceGeneration !== proposal.namespaceGeneration ||
      evidence.evidenceId !== exactString(rowValue(row, 'evidence_id')) ||
      evidence.evidenceHash !== exactString(rowValue(row, 'evidence_hash')) ||
      Date.parse(evidence.approvedAt) !== exactInteger(rowValue(row, 'created_at_ms'))) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
  }
  const manifests = database.prepare(`
    SELECT manifest_id, aggregate_kind, aggregate_id, manifest_hash, manifest_wire,
      manifest_wire_bytes FROM memory_v1_to_v2_manifests
    WHERE namespace_ref = ? AND namespace_generation = ?
      AND aggregate_kind = 'proposal' AND aggregate_id = ? LIMIT 2
  `).all(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId) as Row[]
  if (manifests.length > 1) throw new CanonicalMaintenanceDataErrorV1()
  for (const row of manifests) {
    const manifest = canonicalWire(
      rowValue(row, 'manifest_wire'),
      rowValue(row, 'manifest_wire_bytes'),
      decodeMemoryV1ToV2AggregateManifestV1
    ).value
    if (manifest.manifestId !== exactString(rowValue(row, 'manifest_id')) ||
      manifest.manifestHash !== exactString(rowValue(row, 'manifest_hash')) ||
      manifest.namespaceRef !== proposal.namespaceRef ||
      manifest.namespaceGeneration !== proposal.namespaceGeneration ||
      manifest.aggregate.kind !== 'proposal' ||
      manifest.aggregate.aggregateId !== proposal.proposalId) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
  }
  const evidenceDeleted = database.prepare(`
    DELETE FROM consent_evidence WHERE namespace_ref = ? AND namespace_generation = ?
      AND proposal_id = ?
  `).run(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId)
  if (Number(evidenceDeleted.changes) !== evidenceRows.length) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const manifestsDeleted = database.prepare(`
    DELETE FROM memory_v1_to_v2_manifests WHERE namespace_ref = ?
      AND namespace_generation = ? AND aggregate_kind = 'proposal' AND aggregate_id = ?
  `).run(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId)
  if (Number(manifestsDeleted.changes) !== manifests.length) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  requireOneChange(database.prepare(`
    DELETE FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
  `).run(proposal.namespaceRef, proposal.namespaceGeneration, proposal.proposalId).changes)
}

function insertProposalPrunedAudit (
  database: DatabaseSync,
  commandRefHash: string,
  proposal: MemoryProposalV2,
  freshNow: string,
  itemHash: string
): void {
  const actorHash = maintenanceActorHash()
  const audit = createMemoryLifecycleAuditV1({
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: proposal.namespaceGeneration,
    operation: 'proposal_pruned',
    commandRefHash,
    aggregateKind: 'proposal',
    aggregateRefHash: aggregateRefHash(proposal.proposalId),
    authorizedByActorRefHash: actorHash,
    executedByActorRefHash: actorHash,
    sourceCommittedAt: freshNow,
    recordedAt: freshNow,
    outcome: 'pruned',
    repositoryReceiptHash: itemHash,
    priorRevision: proposal.revision,
    nextRevision: null,
    exclusionsHash: null
  })
  const wire = encodeMemoryLifecycleAuditV1(audit)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_audits(
      namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
      source_committed_at_ms, recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audit.namespaceRef,
    audit.namespaceGeneration,
    audit.auditId,
    audit.operation,
    audit.commandRefHash,
    audit.aggregateRefHash,
    audit.authorizedByActorRefHash,
    audit.executedByActorRefHash,
    Date.parse(audit.sourceCommittedAt),
    Date.parse(audit.recordedAt),
    Date.parse(audit.expiresAt),
    wire,
    Buffer.byteLength(wire, 'utf8')
  ).changes)
}

function maintainProposals (
  database: DatabaseSync,
  operation: 'proposal.expireDue' | 'proposal.purgeDecided',
  namespaceRef: string,
  generation: number,
  commandRef: string,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const rows = proposalRows(
    database,
    namespaceRef,
    generation,
    operation,
    freshNow
  )
  if (operation === 'proposal.expireDue' &&
    rows.length > MEMORY_RESOURCE_LIMITS.namespacePendingProposals) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const candidates = rows.map(validateProposalRow).filter(proposal => {
    const lifecycle = projectMemoryProposalLifecycleV2(proposal, freshNow)
    return operation === 'proposal.expireDue'
      ? lifecycle.logicalState === 'expired_due'
      : !lifecycle.fullWireReadable
  })
  const selected = candidates.slice(0, limit)
  const hashes: string[] = []
  const commandRefHash = memoryMaintenanceCommandRefHashV1(commandRef)
  for (const before of selected) {
    let proposal = before
    if (operation === 'proposal.expireDue') {
      proposal = buildMemoryProposalDecisionV2({
        commandRef,
        operation: 'proposal.expire',
        namespaceRef,
        namespaceGeneration: generation,
        proposal: before,
        decidedByActorRef: MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
        freshNow,
        reason: null
      })
      const wire = encodeMemoryProposalV2(proposal)
      requireOneChange(database.prepare(`
        UPDATE proposals SET revision = 2, state = 'expired', decided_at_ms = ?,
          proposal_wire = ?, proposal_wire_bytes = ?
        WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
          AND revision = 1 AND state = 'pending'
      `).run(
        Date.parse(freshNow),
        wire,
        Buffer.byteLength(wire, 'utf8'),
        namespaceRef,
        generation,
        before.proposalId
      ).changes)
      insertProposalEvent(database, proposal, freshNow)
    }
    const lifecycle = projectMemoryProposalLifecycleV2(proposal, freshNow)
    const pruned = !lifecycle.fullWireReadable
    const itemHash = itemReceiptHash(
      operation,
      proposal.proposalId,
      freshNow,
      pruned ? 'expired_and_pruned' : 'expired'
    )
    if (pruned) {
      validateAndDeleteProposalCarriers(database, proposal)
      insertProposalPrunedAudit(database, commandRefHash, proposal, freshNow, itemHash)
    }
    hashes.push(itemHash)
  }
  return Object.freeze({
    hashes: Object.freeze(hashes),
    hasMore: candidates.length > selected.length
  })
}

function nextOutboxSequence (database: DatabaseSync): number {
  const row = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`).get() as
    Row | undefined
  const sequence = row === undefined ? 1 : exactInteger(rowValue(row, 'seq')) + 1
  if (!Number.isSafeInteger(sequence)) throw new CanonicalMaintenanceDataErrorV1()
  return sequence
}

function insertRecordForgottenEvent (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  memoryId: string,
  revision: number,
  occurredAt: string
): void {
  const sequence = nextOutboxSequence(database)
  const eventId = `event:${memoryLifecycleDomainHashV1(
    MEMORY_OUTBOX_EVENT_ID_HASH_DOMAIN_V1,
    JSON.stringify({
      sequence,
      namespaceRef,
      namespaceGeneration: generation,
      aggregate: 'record',
      aggregateId: memoryId,
      revision,
      eventKind: 'record_forgotten'
    })
  )}`
  const event = createMemoryOutboxEventV1({
    eventId,
    sequence,
    namespaceRef,
    namespaceGeneration: generation,
    aggregate: 'record',
    aggregateId: memoryId,
    revision,
    eventKind: 'record_forgotten',
    occurredAt
  })
  const wire = encodeMemoryOutboxEventV1(event)
  requireOneChange(database.prepare(`
    INSERT INTO outbox(
      sequence, event_id, namespace_ref, namespace_generation, aggregate, aggregate_id,
      revision, event_kind, occurred_at_ms, available_at_ms, event_wire, logical_bytes,
      lease_owner_id, lease_token, leased_until_ms, attempt_count, last_reason_code
    ) VALUES (?, ?, ?, ?, 'record', ?, ?, 'record_forgotten', ?, ?, ?, ?,
      NULL, NULL, NULL, 0, NULL)
  `).run(
    sequence,
    event.eventId,
    namespaceRef,
    generation,
    memoryId,
    revision,
    Date.parse(occurredAt),
    Date.parse(occurredAt),
    wire,
    Buffer.byteLength(wire, 'utf8')
  ).changes)
}

function purgeExpiredRecords (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const rows = database.prepare(`
    SELECT memory_id FROM heads WHERE namespace_ref = ? AND namespace_generation = ?
      AND purge_at_ms <= ? ORDER BY purge_at_ms ASC, memory_id ASC LIMIT 33
  `).all(namespaceRef, generation, Date.parse(freshNow)) as Row[]
  const selected = rows.slice(0, limit)
  const hashes: string[] = []
  for (const row of selected) {
    const memoryId = exactString(rowValue(row, 'memory_id'))
    const loaded = loadValidatedSqliteRecordCarriersV1(
      database,
      namespaceRef,
      generation,
      memoryId,
      freshNow
    )
    if (loaded === null ||
      projectMemoryRecordLifecycleV2(loaded.revision.record, freshNow).state !== 'purge_due') {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    deleteValidatedSqliteRecordCarriersV1(
      database,
      namespaceRef,
      generation,
      memoryId,
      loaded.carriers
    )
    const tombstoneId = `tombstone:${memoryLifecycleDomainHashV1(
      RETENTION_TOMBSTONE_ID_HASH_DOMAIN_V1,
      JSON.stringify({ namespaceRef, generation, memoryId, revision: loaded.revision.revision })
    )}`
    const tombstone = createMemoryTombstoneV1({
      tombstoneId,
      namespaceRef,
      namespaceGeneration: generation,
      memoryId,
      deletedRevision: loaded.revision.revision,
      deletionKind: 'memory_forgotten',
      deletedAt: freshNow,
      deletedByActorRef: MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
      reasonCode: 'retention_expired',
      expiresAt: new Date(Date.parse(freshNow) + MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs)
        .toISOString()
    })
    const tombstoneWire = encodeMemoryTombstoneV1(tombstone)
    requireOneChange(database.prepare(`
      INSERT INTO tombstones(
        namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
        deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash, tombstone_wire,
        tombstone_wire_bytes
      ) VALUES (?, ?, ?, ?, ?, 'memory_forgotten', ?, ?, ?, ?, ?)
    `).run(
      namespaceRef,
      generation,
      tombstone.tombstoneId,
      memoryId,
      tombstone.deletedRevision,
      Date.parse(tombstone.deletedAt),
      Date.parse(tombstone.expiresAt),
      tombstone.receiptHash,
      tombstoneWire,
      Buffer.byteLength(tombstoneWire, 'utf8')
    ).changes)
    insertRecordForgottenEvent(
      database,
      namespaceRef,
      generation,
      memoryId,
      loaded.revision.revision,
      freshNow
    )
    hashes.push(itemReceiptHash(operation, memoryId, freshNow, tombstone.receiptHash))
  }
  return Object.freeze({
    hashes: Object.freeze(hashes),
    hasMore: rows.length > selected.length
  })
}

function deletionTombstoneId (deletionRef: string): string {
  return `tombstone:${memoryLifecycleDomainHashV1(
    DELETION_TOMBSTONE_ID_HASH_DOMAIN_V1,
    deletionRef
  )}`
}

function carrierKinds (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number,
  memoryId: string | null
): DeletionStatusV1['remainingCarrierKinds'] {
  const exact = memoryId !== null
  const args = exact ? [namespaceRef, generation, memoryId] : [namespaceRef, generation]
  const proposal = exact
    ? database.prepare(`
        SELECT 1 AS present FROM proposals
          WHERE namespace_ref = ? AND namespace_generation = ? AND resulting_memory_id = ?
        UNION ALL
        SELECT 1 AS present FROM consent_evidence
          WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id IN (
            SELECT proposal_id FROM proposals WHERE namespace_ref = ?
              AND namespace_generation = ? AND resulting_memory_id = ?
          )
        LIMIT 1
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
  const result = [
    proposal ? 'proposal' as const : null,
    head ? 'head' as const : null,
    revision ? 'revision' as const : null,
    revisionPayload ? 'revision_payload' as const : null,
    contentOutbox ? 'content_outbox' as const : null
  ].filter((kind): kind is NonNullable<typeof kind> => kind !== null)
  return Object.freeze(result)
}

function loadCheckpoint (
  database: DatabaseSync,
  namespaceRef: string,
  deletionRef: string
): { readonly status: DeletionStatusV1; readonly receiptHash: string; readonly bytes: number } |
  null {
  const row = database.prepare(`
    SELECT deleting_generation, observed_current_generation, canonical_bodies,
      payload_deletion, wal_checkpoint, derived_cleanup, stage, receipt_hash,
      checkpoint_wire, checkpoint_wire_bytes, updated_at_ms
    FROM namespace_deletion_checkpoints WHERE namespace_ref = ? AND deletion_ref = ?
  `).get(namespaceRef, deletionRef) as Row | undefined
  if (row === undefined) return null
  const loaded = canonicalWire(
    rowValue(row, 'checkpoint_wire'),
    rowValue(row, 'checkpoint_wire_bytes'),
    decodeDeletionStatusV1
  )
  const status = loaded.value
  if (status.namespaceRef !== namespaceRef || status.deletionRef !== deletionRef ||
    status.deletingGeneration !== positiveInteger(rowValue(row, 'deleting_generation')) ||
    status.observedCurrentGeneration !==
      positiveInteger(rowValue(row, 'observed_current_generation')) ||
    status.canonicalBodies !== exactString(rowValue(row, 'canonical_bodies')) ||
    status.payloadDeletion !== exactString(rowValue(row, 'payload_deletion')) ||
    status.walCheckpoint !== exactString(rowValue(row, 'wal_checkpoint')) ||
    status.derivedCleanup !== exactString(rowValue(row, 'derived_cleanup')) ||
    status.stage !== exactString(rowValue(row, 'stage')) ||
    status.observedAt !== new Date(exactInteger(rowValue(row, 'updated_at_ms'))).toISOString()) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const receiptHash = exactString(rowValue(row, 'receipt_hash'))
  if (!HASH_PATTERN.test(receiptHash)) throw new CanonicalMaintenanceDataErrorV1()
  const receipt = deletionReceiptForRef(database, namespaceRef, deletionRef)
  if (receipt !== null) {
    if (receipt.receiptHash !== receiptHash) throw new CanonicalMaintenanceDataErrorV1()
    tombstoneForDeletion(database, receipt)
  }
  return Object.freeze({ status, receiptHash, bytes: loaded.bytes })
}

function storeCheckpoint (
  database: DatabaseSync,
  status: DeletionStatusV1,
  receiptHash: string
): void {
  const wire = encodeDeletionStatusV1(status)
  const bytes = Buffer.byteLength(wire, 'utf8')
  const existing = database.prepare(`
    SELECT 1 AS present FROM namespace_deletion_checkpoints
    WHERE namespace_ref = ? AND deletion_ref = ?
  `).get(status.namespaceRef, status.deletionRef)
  if (existing === undefined) {
    requireOneChange(database.prepare(`
      INSERT INTO namespace_deletion_checkpoints(
        namespace_ref, deletion_ref, deleting_generation, observed_current_generation,
        canonical_bodies, payload_deletion, wal_checkpoint, derived_cleanup, stage,
        receipt_hash, checkpoint_wire, checkpoint_wire_bytes, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      status.namespaceRef,
      status.deletionRef,
      status.deletingGeneration,
      status.observedCurrentGeneration,
      status.canonicalBodies,
      status.payloadDeletion,
      status.walCheckpoint,
      status.derivedCleanup,
      status.stage,
      receiptHash,
      wire,
      bytes,
      Date.parse(status.observedAt)
    ).changes)
    return
  }
  requireOneChange(database.prepare(`
    UPDATE namespace_deletion_checkpoints SET observed_current_generation = ?,
      canonical_bodies = ?, payload_deletion = ?, wal_checkpoint = ?, derived_cleanup = ?,
      stage = ?, checkpoint_wire = ?, checkpoint_wire_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND deletion_ref = ? AND receipt_hash = ?
  `).run(
    status.observedCurrentGeneration,
    status.canonicalBodies,
    status.payloadDeletion,
    status.walCheckpoint,
    status.derivedCleanup,
    status.stage,
    wire,
    bytes,
    Date.parse(status.observedAt),
    status.namespaceRef,
    status.deletionRef,
    receiptHash
  ).changes)
}

function assertNoOrphanScrubCarriers (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number
): void {
  const row = database.prepare(`
    SELECT 1 AS present FROM consent_evidence e
      LEFT JOIN proposals p ON p.namespace_ref = e.namespace_ref
        AND p.namespace_generation = e.namespace_generation
        AND p.proposal_id = e.proposal_id
      WHERE e.namespace_ref = ? AND e.namespace_generation = ? AND p.proposal_id IS NULL
    UNION ALL
    SELECT 1 AS present FROM revision_evidence e
      LEFT JOIN revisions r ON r.namespace_ref = e.namespace_ref
        AND r.namespace_generation = e.namespace_generation
        AND r.memory_id = e.memory_id AND r.revision = e.revision
      WHERE e.namespace_ref = ? AND e.namespace_generation = ? AND r.memory_id IS NULL
    UNION ALL
    SELECT 1 AS present FROM revision_payloads p
      LEFT JOIN revisions r ON r.namespace_ref = p.namespace_ref
        AND r.namespace_generation = p.namespace_generation
        AND r.memory_id = p.memory_id AND r.revision = p.revision
      WHERE p.namespace_ref = ? AND p.namespace_generation = ? AND r.memory_id IS NULL
    UNION ALL
    SELECT 1 AS present FROM revisions r
      LEFT JOIN heads h ON h.namespace_ref = r.namespace_ref
        AND h.namespace_generation = r.namespace_generation AND h.memory_id = r.memory_id
      WHERE r.namespace_ref = ? AND r.namespace_generation = ? AND h.memory_id IS NULL
    UNION ALL
    SELECT 1 AS present FROM proposals p
      LEFT JOIN heads h ON h.namespace_ref = p.namespace_ref
        AND h.namespace_generation = p.namespace_generation
        AND h.memory_id = p.resulting_memory_id
      WHERE p.namespace_ref = ? AND p.namespace_generation = ?
        AND p.resulting_memory_id IS NOT NULL AND h.memory_id IS NULL
    UNION ALL
    SELECT 1 AS present FROM memory_v1_to_v2_manifests m
      LEFT JOIN proposals p ON m.aggregate_kind = 'proposal'
        AND p.namespace_ref = m.namespace_ref
        AND p.namespace_generation = m.namespace_generation
        AND p.proposal_id = m.aggregate_id
      LEFT JOIN heads h ON m.aggregate_kind = 'memory'
        AND h.namespace_ref = m.namespace_ref
        AND h.namespace_generation = m.namespace_generation
        AND h.memory_id = m.aggregate_id
      WHERE m.namespace_ref = ? AND m.namespace_generation = ?
        AND ((m.aggregate_kind = 'proposal' AND p.proposal_id IS NULL) OR
          (m.aggregate_kind = 'memory' AND h.memory_id IS NULL))
    LIMIT 1
  `).get(
    namespaceRef, generation,
    namespaceRef, generation,
    namespaceRef, generation,
    namespaceRef, generation,
    namespaceRef, generation,
    namespaceRef, generation
  )
  if (row !== undefined) throw new CanonicalMaintenanceDataErrorV1()
}

function scrubDeletedNamespace (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  targetGeneration: number,
  deletionRef: string,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const checkpoint = loadCheckpoint(database, namespaceRef, deletionRef)
  if (checkpoint === null || checkpoint.status.deletingGeneration !== targetGeneration ||
    checkpoint.status.observedCurrentGeneration > currentGeneration) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  assertNoOrphanScrubCarriers(database, namespaceRef, targetGeneration)
  const candidates = database.prepare(`
    SELECT kind, aggregate_id FROM (
      SELECT 'record' AS kind, memory_id AS aggregate_id, 1 AS priority
        FROM heads WHERE namespace_ref = ? AND namespace_generation = ?
      UNION ALL
      SELECT 'proposal' AS kind, proposal_id AS aggregate_id, 2 AS priority
        FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
          AND resulting_memory_id IS NULL
      UNION ALL
      SELECT aggregate AS kind, aggregate_id, 3 AS priority
        FROM outbox o WHERE namespace_ref = ? AND namespace_generation = ? AND (
          (aggregate = 'record' AND NOT EXISTS (
            SELECT 1 FROM heads h WHERE h.namespace_ref = o.namespace_ref
              AND h.namespace_generation = o.namespace_generation
              AND h.memory_id = o.aggregate_id
          )) OR
          (aggregate = 'proposal' AND NOT EXISTS (
            SELECT 1 FROM proposals p WHERE p.namespace_ref = o.namespace_ref
              AND p.namespace_generation = o.namespace_generation
              AND p.proposal_id = o.aggregate_id
          ))
        )
    ) ORDER BY priority ASC, aggregate_id ASC LIMIT 33
  `).all(
    namespaceRef, targetGeneration,
    namespaceRef, targetGeneration,
    namespaceRef, targetGeneration
  ) as Row[]
  const selected = candidates.slice(0, limit)
  const hashes: string[] = []
  for (const row of selected) {
    const kind = exactString(rowValue(row, 'kind'))
    const aggregateId = exactString(rowValue(row, 'aggregate_id'))
    if (kind === 'record') {
      const loaded = loadValidatedSqliteRecordCarriersV1(
        database,
        namespaceRef,
        targetGeneration,
        aggregateId,
        freshNow
      )
      if (loaded !== null) {
        deleteValidatedSqliteRecordCarriersV1(
          database,
          namespaceRef,
          targetGeneration,
          aggregateId,
          loaded.carriers
        )
      } else {
        database.prepare(`
          DELETE FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
            AND aggregate = 'record' AND aggregate_id = ?
        `).run(namespaceRef, targetGeneration, aggregateId)
      }
    } else if (kind === 'proposal') {
      const exact = database.prepare(`
        SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
          proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
          resulting_revision_hash, proposal_wire, proposal_wire_bytes
        FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND proposal_id = ?
      `).get(namespaceRef, targetGeneration, aggregateId) as Row | undefined
      if (exact !== undefined) validateAndDeleteProposalCarriers(database, validateProposalRow(exact))
      database.prepare(`
        DELETE FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
          AND aggregate = 'proposal' AND aggregate_id = ?
      `).run(namespaceRef, targetGeneration, aggregateId)
    } else {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    hashes.push(itemReceiptHash(operation, aggregateId, freshNow, 'scrubbed'))
  }
  const remaining = carrierKinds(database, namespaceRef, targetGeneration, null)
  const status = createDeletionStatusV1({
    deletionRef,
    namespaceRef,
    deletingGeneration: targetGeneration,
    observedCurrentGeneration: currentGeneration,
    remainingCarrierKinds: remaining,
    canonicalBodies: remaining.length === 0 ? 'verified_absent' : 'scrub_pending',
    payloadDeletion: checkpoint.status.payloadDeletion,
    walCheckpoint: checkpoint.status.walCheckpoint,
    derivedCleanup: checkpoint.status.derivedCleanup,
    stage: remaining.length === 0 ? 'verification_pending' : 'logical_committed',
    observedAt: freshNow
  })
  storeCheckpoint(database, status, checkpoint.receiptHash)
  return Object.freeze({
    hashes: Object.freeze(hashes),
    hasMore: candidates.length > selected.length || remaining.length > 0
  })
}

function verifyDeletedNamespace (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  targetGeneration: number,
  deletionRef: string,
  operation: MemoryMaintenanceOperationV1,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const checkpoint = loadCheckpoint(database, namespaceRef, deletionRef)
  if (checkpoint === null || checkpoint.status.deletingGeneration !== targetGeneration) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  assertNoOrphanScrubCarriers(database, namespaceRef, targetGeneration)
  const remaining = carrierKinds(database, namespaceRef, targetGeneration, null)
  const status = createDeletionStatusV1({
    deletionRef,
    namespaceRef,
    deletingGeneration: targetGeneration,
    observedCurrentGeneration: currentGeneration,
    remainingCarrierKinds: remaining,
    canonicalBodies: remaining.length === 0 ? 'verified_absent' : 'scrub_pending',
    payloadDeletion: checkpoint.status.payloadDeletion,
    walCheckpoint: checkpoint.status.walCheckpoint,
    derivedCleanup: checkpoint.status.derivedCleanup,
    stage: remaining.length === 0 ? 'verification_pending' : 'logical_committed',
    observedAt: freshNow
  })
  storeCheckpoint(database, status, checkpoint.receiptHash)
  return Object.freeze({
    hashes: Object.freeze([
      itemReceiptHash(operation, deletionRef, freshNow,
        remaining.length === 0 ? 'verified_absent' : 'remaining')
    ]),
    hasMore: false
  })
}

function loadDeletionReceiptFromCommandRow (row: Row): DeletionMutationReceiptV1 | null {
  const loaded = canonicalWire(
    rowValue(row, 'result_wire'),
    rowValue(row, 'result_wire_bytes'),
    decodeMemoryLifecycleStableResultWireV1
  )
  if (memoryLifecycleStableResultHashV1(loaded.wire) !==
      exactString(rowValue(row, 'result_hash'))) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const result = loaded.value
  const commandHash = exactString(rowValue(row, 'command_hash'))
  const operation = exactString(rowValue(row, 'operation'))
  const committedAt = exactInteger(rowValue(row, 'committed_at_ms'))
  if (!HASH_PATTERN.test(commandHash) || result.commandHash !== commandHash ||
    (operation !== 'record.forget' && operation !== 'namespace.delete') ||
    result.operation !== operation ||
    exactInteger(rowValue(row, 'expires_at_ms')) - committedAt !==
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  if (result.status !== 'deletion_pending' && result.status !== 'deletion_complete') return null
  const receipt = result.receipt
  const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace'
  const aggregateRef = operation === 'record.forget' ? receipt.memoryId : receipt.namespaceRef
  if (receipt.operation !== expectedReceiptOperation || aggregateRef === null ||
    receipt.namespaceRef !==
      exactString(rowValue(row, 'namespace_ref')) ||
    receipt.generationBefore !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    receipt.commandRefHash !== memoryLifecycleDomainHashV1(
      'groupmate.memory.lifecycle-command-ref.v1',
      exactString(rowValue(row, 'command_ref'))
    ) ||
    exactString(rowValue(row, 'aggregate_ref_hash')) !== memoryLifecycleDomainHashV1(
      MUTATION_AGGREGATE_REF_HASH_DOMAIN_V1,
      aggregateRef
    ) ||
    receipt.committedAt !== new Date(committedAt).toISOString()) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return receipt
}

function deletionReceiptForRef (
  database: DatabaseSync,
  namespaceRef: string,
  deletionRef: string
): DeletionMutationReceiptV1 | null {
  const rows = database.prepare(`
    SELECT namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash, committed_at_ms,
      expires_at_ms
    FROM lifecycle_commands
    WHERE namespace_ref = ? AND operation IN ('record.forget', 'namespace.delete')
      AND instr(result_wire, ?) > 0
    ORDER BY command_ref ASC LIMIT 2
  `).all(namespaceRef, deletionRef) as Row[]
  if (rows.length === 0) return null
  if (rows.length !== 1) throw new CanonicalMaintenanceDataErrorV1()
  const receipt = loadDeletionReceiptFromCommandRow(rows[0]!)
  if (receipt === null || receipt.deletionRef !== deletionRef) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return receipt
}

function forgottenDeletionReceipts (
  database: DatabaseSync,
  namespaceRef: string
): readonly DeletionMutationReceiptV1[] {
  const rows = database.prepare(`
    SELECT namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash, committed_at_ms,
      expires_at_ms
    FROM lifecycle_commands WHERE namespace_ref = ? AND operation = 'record.forget'
    ORDER BY committed_at_ms ASC, command_ref ASC LIMIT 8193
  `).all(namespaceRef) as Row[]
  if (rows.length > MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const receipts: DeletionMutationReceiptV1[] = []
  for (const row of rows) {
    const receipt = loadDeletionReceiptFromCommandRow(row)
    if (receipt === null) continue
    const expectedAggregateHash = memoryLifecycleDomainHashV1(
      MUTATION_AGGREGATE_REF_HASH_DOMAIN_V1,
      receipt.memoryId as string
    )
    if (exactString(rowValue(row, 'operation')) !== 'record.forget' ||
      exactString(rowValue(row, 'aggregate_ref_hash')) !== expectedAggregateHash) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    receipts.push(receipt)
  }
  return Object.freeze(receipts)
}

function validateTombstoneRow (
  row: Row,
  expectedNamespaceRef: string
): ReturnType<typeof decodeMemoryTombstoneV1> {
  const tombstone = canonicalWire(
    rowValue(row, 'tombstone_wire'),
    rowValue(row, 'tombstone_wire_bytes'),
    decodeMemoryTombstoneV1
  ).value
  if (tombstone.namespaceRef !== expectedNamespaceRef ||
    tombstone.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    tombstone.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    tombstone.tombstoneId !== exactString(rowValue(row, 'tombstone_id')) ||
    tombstone.memoryId !== nullableString(rowValue(row, 'memory_id')) ||
    tombstone.deletedRevision !== nullableInteger(rowValue(row, 'deleted_revision')) ||
    tombstone.deletionKind !== exactString(rowValue(row, 'deletion_kind')) ||
    Date.parse(tombstone.deletedAt) !== exactInteger(rowValue(row, 'deleted_at_ms')) ||
    Date.parse(tombstone.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
    tombstone.receiptHash !== exactString(rowValue(row, 'receipt_hash'))) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return tombstone
}

function tombstoneForDeletion (
  database: DatabaseSync,
  receipt: DeletionMutationReceiptV1
) {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
      deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash, tombstone_wire,
      tombstone_wire_bytes
    FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ? AND tombstone_id = ?
  `).get(
    receipt.namespaceRef,
    receipt.generationAfter,
    receipt.tombstoneId
  ) as Row | undefined
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  const tombstone = validateTombstoneRow(row, receipt.namespaceRef)
  if (tombstone.tombstoneId !== receipt.tombstoneId ||
    tombstone.receiptHash !== receipt.tombstoneReceiptHash ||
    tombstone.namespaceGeneration !== receipt.generationAfter ||
    tombstone.memoryId !== receipt.memoryId ||
    tombstone.deletedRevision !== receipt.deletedRevision ||
    tombstone.deletedAt !== receipt.committedAt ||
    tombstone.expiresAt !== receipt.tombstoneExpiresAt) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return tombstone
}

function deletionMemoryId (
  database: DatabaseSync,
  namespaceRef: string,
  deletionRef: string
): string | null {
  const receipt = deletionReceiptForRef(database, namespaceRef, deletionRef)
  if (receipt !== null) {
    tombstoneForDeletion(database, receipt)
    return receipt.memoryId
  }
  const tombstoneId = deletionTombstoneId(deletionRef)
  const row = database.prepare(`
    SELECT tombstone_wire, tombstone_wire_bytes FROM tombstones
    WHERE namespace_ref = ? AND tombstone_id = ?
  `).get(namespaceRef, tombstoneId) as Row | undefined
  if (row === undefined) throw new CanonicalMaintenanceDataErrorV1()
  const tombstone = canonicalWire(
    rowValue(row, 'tombstone_wire'),
    rowValue(row, 'tombstone_wire_bytes'),
    decodeMemoryTombstoneV1
  ).value
  if (tombstone.deletionKind !== 'namespace_deleted' || tombstone.memoryId !== null) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return null
}

function derivedCleanupState (
  database: DatabaseSync,
  status: DeletionStatusV1,
  memoryId: string | null
): DeletionStatusV1['derivedCleanup'] {
  const generation = memoryId === null
    ? status.observedCurrentGeneration
    : status.deletingGeneration
  const aggregate = memoryId === null ? 'namespace' : 'record'
  const aggregateId = memoryId ?? status.namespaceRef
  const eventKind = memoryId === null ? 'namespace_deleted' : 'record_forgotten'
  return database.prepare(`
    SELECT 1 AS present FROM outbox WHERE namespace_ref = ? AND namespace_generation = ?
      AND aggregate = ? AND aggregate_id = ? AND event_kind = ? LIMIT 1
  `).get(status.namespaceRef, generation, aggregate, aggregateId, eventKind) === undefined
    ? 'applied'
    : 'queued'
}

function secureDeleteState (database: DatabaseSync): DeletionStatusV1['payloadDeletion'] {
  const row = database.prepare('PRAGMA secure_delete').get() as Row | undefined
  return row !== undefined && Object.values(row)[0] === 1 ? 'secure_delete_on' : 'unverified'
}

function prepareDeletionCheckpointBatch (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  limit: number,
  freshNow: string
): { readonly refs: readonly string[]; readonly hasMore: boolean } {
  const existingRows = database.prepare(`
    SELECT deletion_ref FROM namespace_deletion_checkpoints
    WHERE namespace_ref = ? AND stage != 'canonical_complete'
    ORDER BY updated_at_ms ASC, deletion_ref ASC LIMIT 33
  `).all(namespaceRef) as Row[]
  const existingRefs = existingRows.map(row => exactString(rowValue(row, 'deletion_ref')))
  const refs = existingRefs.slice(0, limit)
  let hasMore = existingRefs.length > refs.length
  if (refs.length < limit && !hasMore) {
    for (const receipt of forgottenDeletionReceipts(database, namespaceRef)) {
      if (receipt.generationAfter > currentGeneration) continue
      if (database.prepare(`
        SELECT 1 AS present FROM namespace_deletion_checkpoints
        WHERE namespace_ref = ? AND deletion_ref = ?
      `).get(namespaceRef, receipt.deletionRef) !== undefined) continue
      if (refs.length >= limit) {
        hasMore = true
        break
      }
      tombstoneForDeletion(database, receipt)
      const remaining = carrierKinds(
        database,
        namespaceRef,
        receipt.deletingGeneration,
        receipt.memoryId
      )
      const provisional = createDeletionStatusV1({
        deletionRef: receipt.deletionRef,
        namespaceRef,
        deletingGeneration: receipt.deletingGeneration,
        observedCurrentGeneration: currentGeneration,
        remainingCarrierKinds: remaining,
        canonicalBodies: remaining.length === 0 ? 'verified_absent' : 'unverified',
        payloadDeletion: 'unverified',
        walCheckpoint: 'unverified',
        derivedCleanup: 'queued',
        stage: remaining.length === 0 ? 'verification_pending' : 'logical_committed',
        observedAt: freshNow
      })
      storeCheckpoint(database, provisional, receipt.receiptHash)
      refs.push(receipt.deletionRef)
    }
  }
  for (const deletionRef of refs) {
    const checkpoint = loadCheckpoint(database, namespaceRef, deletionRef)
    if (checkpoint === null) throw new CanonicalMaintenanceDataErrorV1()
    const memoryId = deletionMemoryId(database, namespaceRef, deletionRef)
    const remaining = carrierKinds(
      database,
      namespaceRef,
      checkpoint.status.deletingGeneration,
      memoryId
    )
    const derivedCleanup = derivedCleanupState(database, checkpoint.status, memoryId)
    const status = createDeletionStatusV1({
      deletionRef,
      namespaceRef,
      deletingGeneration: checkpoint.status.deletingGeneration,
      observedCurrentGeneration: currentGeneration,
      remainingCarrierKinds: remaining,
      canonicalBodies: remaining.length === 0 ? 'verified_absent' : 'unverified',
      payloadDeletion: secureDeleteState(database),
      walCheckpoint: 'unverified',
      derivedCleanup,
      stage: remaining.length === 0 ? 'verification_pending' : 'logical_committed',
      observedAt: freshNow
    })
    storeCheckpoint(database, status, checkpoint.receiptHash)
  }
  return Object.freeze({ refs: Object.freeze(refs), hasMore })
}

function finalizeDeletionCheckpointBatch (
  database: DatabaseSync,
  namespaceRef: string,
  currentGeneration: number,
  operation: MemoryMaintenanceOperationV1,
  refs: readonly string[],
  hasMore: boolean,
  walCheckpoint: 'truncated' | 'deferred',
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const hashes: string[] = []
  for (const deletionRef of refs) {
    const checkpoint = loadCheckpoint(database, namespaceRef, deletionRef)
    if (checkpoint === null) throw new CanonicalMaintenanceDataErrorV1()
    const memoryId = deletionMemoryId(database, namespaceRef, deletionRef)
    const remaining = carrierKinds(
      database,
      namespaceRef,
      checkpoint.status.deletingGeneration,
      memoryId
    )
    const derivedCleanup = derivedCleanupState(database, checkpoint.status, memoryId)
    const complete = remaining.length === 0 &&
      checkpoint.status.payloadDeletion === 'secure_delete_on' && walCheckpoint === 'truncated' &&
      derivedCleanup !== 'unverified'
    const status = createDeletionStatusV1({
      deletionRef,
      namespaceRef,
      deletingGeneration: checkpoint.status.deletingGeneration,
      observedCurrentGeneration: currentGeneration,
      remainingCarrierKinds: remaining,
      canonicalBodies: remaining.length === 0 ? 'verified_absent' : 'unverified',
      payloadDeletion: checkpoint.status.payloadDeletion,
      walCheckpoint,
      derivedCleanup,
      stage: complete ? 'canonical_complete' : 'verification_pending',
      observedAt: freshNow
    })
    storeCheckpoint(database, status, checkpoint.receiptHash)
    hashes.push(itemReceiptHash(operation, deletionRef, freshNow, status.stage))
  }
  return Object.freeze({
    hashes: Object.freeze(hashes),
    hasMore
  })
}

function checkpointForTombstone (
  database: DatabaseSync,
  namespaceRef: string,
  tombstoneId: string
): { readonly deletionRef: string; readonly status: DeletionStatusV1 } | null {
  const rows = database.prepare(`
    SELECT deletion_ref FROM namespace_deletion_checkpoints
    WHERE namespace_ref = ? ORDER BY deletion_ref ASC LIMIT 33
  `).all(namespaceRef) as Row[]
  if (rows.length > MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const matches = rows.map(row => exactString(rowValue(row, 'deletion_ref')))
    .filter(deletionRef => deletionTombstoneId(deletionRef) === tombstoneId)
  if (matches.length === 0) return null
  if (matches.length !== 1) throw new CanonicalMaintenanceDataErrorV1()
  const deletionRef = matches[0]!
  const checkpoint = loadCheckpoint(database, namespaceRef, deletionRef)
  if (checkpoint === null) throw new CanonicalMaintenanceDataErrorV1()
  return Object.freeze({ deletionRef, status: checkpoint.status })
}

function purgeExpiredTombstones (
  database: DatabaseSync,
  namespaceRef: string,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const selected: Row[] = []
  let hasMore = false
  let cursorExpiresAt = -1
  let cursorTombstoneId = ''
  let cursorGeneration = 0
  scan: while (true) {
    const rows = database.prepare(`
      SELECT namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
        deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash, tombstone_wire,
        tombstone_wire_bytes
      FROM tombstones WHERE namespace_ref = ? AND expires_at_ms <= ? AND (
        expires_at_ms > ? OR
        (expires_at_ms = ? AND tombstone_id > ?) OR
        (expires_at_ms = ? AND tombstone_id = ? AND namespace_generation > ?)
      )
      ORDER BY expires_at_ms ASC, tombstone_id ASC, namespace_generation ASC LIMIT 33
    `).all(
      namespaceRef,
      Date.parse(freshNow),
      cursorExpiresAt,
      cursorExpiresAt,
      cursorTombstoneId,
      cursorExpiresAt,
      cursorTombstoneId,
      cursorGeneration
    ) as Row[]
    if (rows.length === 0) break
    for (const row of rows) {
      cursorExpiresAt = exactInteger(rowValue(row, 'expires_at_ms'))
      cursorTombstoneId = exactString(rowValue(row, 'tombstone_id'))
      cursorGeneration = positiveInteger(rowValue(row, 'namespace_generation'))
      const tombstone = validateTombstoneRow(row, namespaceRef)
      const matching = checkpointForTombstone(database, namespaceRef, tombstone.tombstoneId)
      const eligible = matching !== null
        ? matching.status.stage === 'canonical_complete'
        : tombstone.deletedByActorRef === MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 &&
          carrierKinds(
            database,
            namespaceRef,
            tombstone.namespaceGeneration,
            tombstone.memoryId
          ).length === 0 && database.prepare(`
            SELECT 1 AS present FROM outbox
            WHERE namespace_ref = ? AND namespace_generation = ?
              AND aggregate = 'record' AND aggregate_id = ?
              AND event_kind = 'record_forgotten' LIMIT 1
          `).get(
            namespaceRef,
            tombstone.namespaceGeneration,
            tombstone.memoryId
          ) === undefined
      if (!eligible) continue
      if (selected.length < limit) {
        selected.push(row)
      } else {
        hasMore = true
        break scan
      }
    }
    if (rows.length < 33) break
  }
  const hashes: string[] = []
  for (const row of selected) {
    const tombstoneId = exactString(rowValue(row, 'tombstone_id'))
    const matching = checkpointForTombstone(database, namespaceRef, tombstoneId)
    if (matching !== null) {
      requireOneChange(database.prepare(`
        DELETE FROM namespace_deletion_checkpoints WHERE namespace_ref = ? AND deletion_ref = ?
      `).run(namespaceRef, matching.deletionRef).changes)
    }
    requireOneChange(database.prepare(`
      DELETE FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ?
        AND tombstone_id = ?
    `).run(
      namespaceRef,
      positiveInteger(rowValue(row, 'namespace_generation')),
      tombstoneId
    ).changes)
    hashes.push(itemReceiptHash(operation, tombstoneId, freshNow, 'purged'))
  }
  return Object.freeze({
    hashes: Object.freeze(hashes),
    hasMore
  })
}

function purgeExpiredAudits (
  database: DatabaseSync,
  namespaceRef: string,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const rows = database.prepare(`
    SELECT namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash,
      authorized_actor_ref_hash, executed_actor_ref_hash, source_committed_at_ms,
      recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    FROM lifecycle_audits WHERE namespace_ref = ? AND expires_at_ms <= ?
    ORDER BY expires_at_ms ASC, audit_id ASC LIMIT 33
  `).all(namespaceRef, Date.parse(freshNow)) as Row[]
  const selected = rows.slice(0, limit)
  const hashes: string[] = []
  for (const row of selected) {
    const audit = validateLifecycleAuditRow(row, namespaceRef)
    requireOneChange(database.prepare(`
      DELETE FROM lifecycle_audits WHERE namespace_ref = ? AND namespace_generation = ?
        AND audit_id = ?
    `).run(namespaceRef, audit.namespaceGeneration, audit.auditId).changes)
    hashes.push(itemReceiptHash(operation, audit.auditId, freshNow, audit.receiptHash))
  }
  return Object.freeze({ hashes: Object.freeze(hashes), hasMore: rows.length > selected.length })
}

function purgeExpiredCommands (
  database: DatabaseSync,
  namespaceRef: string,
  currentCommandRef: string,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const selected: { readonly row: Row; readonly storedHash: string }[] = []
  let hasMore = false
  let cursorExpiresAt = -1
  let cursorCommandRef = ''
  scan: while (true) {
    const rows = database.prepare(`
      SELECT namespace_ref, namespace_generation, command_ref, command_hash, operation,
        aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
        committed_at_ms, expires_at_ms FROM lifecycle_commands
      WHERE namespace_ref = ? AND expires_at_ms <= ? AND command_ref != ? AND (
        expires_at_ms > ? OR (expires_at_ms = ? AND command_ref > ?)
      )
      ORDER BY expires_at_ms ASC, command_ref ASC LIMIT 33
    `).all(
      namespaceRef,
      Date.parse(freshNow),
      currentCommandRef,
      cursorExpiresAt,
      cursorExpiresAt,
      cursorCommandRef
    ) as Row[]
    if (rows.length === 0) break
    for (const row of rows) {
      cursorExpiresAt = exactInteger(rowValue(row, 'expires_at_ms'))
      cursorCommandRef = exactString(rowValue(row, 'command_ref'))
      const wire = canonicalWire(
        rowValue(row, 'result_wire'),
        rowValue(row, 'result_wire_bytes'),
        value => exactString(value as SQLOutValue)
      ).wire
      if (exactString(rowValue(row, 'namespace_ref')) !== namespaceRef) {
        throw new CanonicalMaintenanceDataErrorV1()
      }
      const namespaceGeneration = positiveInteger(rowValue(row, 'namespace_generation'))
      const commandHash = exactString(rowValue(row, 'command_hash'))
      const aggregateHash = exactString(rowValue(row, 'aggregate_ref_hash'))
      if (!HASH_PATTERN.test(commandHash) || !HASH_PATTERN.test(aggregateHash)) {
        throw new CanonicalMaintenanceDataErrorV1()
      }
      const storedOperation = exactString(rowValue(row, 'operation'))
      const storedHash = exactString(rowValue(row, 'result_hash'))
      let purgeable = true
      if ((MEMORY_MAINTENANCE_OPERATIONS_V1 as readonly string[]).includes(storedOperation)) {
        const manifest = decodeMemoryMaintenanceBatchManifestV1(wire)
        if (manifest.operation !== storedOperation ||
          manifest.namespaceRef !== namespaceRef ||
          manifest.currentGeneration !== namespaceGeneration ||
          manifest.commandRefHash !== memoryMaintenanceCommandRefHashV1(cursorCommandRef) ||
          manifest.commandHash !== commandHash ||
          aggregateHash !== aggregateRefHash(manifest.deletionRef ?? namespaceRef) ||
          Date.parse(manifest.completedAt) !== exactInteger(rowValue(row, 'committed_at_ms')) ||
          memoryMaintenanceBatchManifestHashV1(manifest) !== storedHash) {
          throw new CanonicalMaintenanceDataErrorV1()
        }
      } else {
        let stable: ReturnType<typeof decodeMemoryLifecycleStableResultWireV1>
        try {
          stable = decodeMemoryLifecycleStableResultWireV1(wire)
        } catch {
          throw new CanonicalMaintenanceDataErrorV1()
        }
        if (stable.operation !== storedOperation || stable.commandHash !== commandHash ||
          memoryLifecycleStableResultHashV1(wire) !== storedHash) {
          throw new CanonicalMaintenanceDataErrorV1()
        }
        if ((storedOperation === 'record.forget' || storedOperation === 'namespace.delete') &&
          (stable.status === 'deletion_pending' || stable.status === 'deletion_complete')) {
          const receipt = loadDeletionReceiptFromCommandRow(row)
          if (receipt === null) throw new CanonicalMaintenanceDataErrorV1()
          const tombstoneExists = database.prepare(`
            SELECT 1 AS present FROM tombstones
            WHERE namespace_ref = ? AND namespace_generation = ? AND tombstone_id = ?
          `).get(receipt.namespaceRef, receipt.generationAfter, receipt.tombstoneId) !== undefined
          const checkpointExists = database.prepare(`
            SELECT 1 AS present FROM namespace_deletion_checkpoints
            WHERE namespace_ref = ? AND deletion_ref = ?
          `).get(receipt.namespaceRef, receipt.deletionRef) !== undefined
          if (!tombstoneExists) {
            if (checkpointExists) throw new CanonicalMaintenanceDataErrorV1()
          } else {
            tombstoneForDeletion(database, receipt)
            const checkpoint = loadCheckpoint(database, receipt.namespaceRef, receipt.deletionRef)
            if (checkpoint === null || checkpoint.status.stage !== 'canonical_complete') {
              purgeable = false
            } else if (checkpoint.status.deletingGeneration !== receipt.deletingGeneration ||
              carrierKinds(
                database,
                receipt.namespaceRef,
                receipt.deletingGeneration,
                receipt.memoryId
              ).length > 0) {
              throw new CanonicalMaintenanceDataErrorV1()
            }
          }
        }
      }
      const committedAt = exactInteger(rowValue(row, 'committed_at_ms'))
      if (cursorExpiresAt - committedAt !==
          MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
        throw new CanonicalMaintenanceDataErrorV1()
      }
      if (!purgeable) continue
      if (selected.length < limit) {
        selected.push(Object.freeze({ row, storedHash }))
      } else {
        hasMore = true
        break scan
      }
    }
    if (rows.length < 33) break
  }
  const hashes: string[] = []
  for (const candidate of selected) {
    const commandRef = exactString(rowValue(candidate.row, 'command_ref'))
    requireOneChange(database.prepare(`
      DELETE FROM lifecycle_commands WHERE namespace_ref = ? AND command_ref = ?
    `).run(namespaceRef, commandRef).changes)
    hashes.push(itemReceiptHash(operation, commandRef, freshNow, candidate.storedHash))
  }
  return Object.freeze({ hashes: Object.freeze(hashes), hasMore })
}

function releaseExpiredExportReservations (
  database: DatabaseSync,
  namespaceRef: string,
  operation: MemoryMaintenanceOperationV1,
  limit: number,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const candidateRows = database.prepare(`
    SELECT r.export_id, r.namespace_ref, r.namespace_generation, r.command_hash,
      r.reserved_records, r.reserved_bytes, r.reservation_wire, r.reservation_wire_bytes,
      r.expires_at_ms, j.namespace_ref AS job_namespace_ref,
      j.namespace_generation AS job_namespace_generation,
      j.prepared_command_hash, j.prepared_at_ms, j.expires_at_ms AS job_expires_at_ms
    FROM export_audit_reservations r
    JOIN export_jobs j ON j.export_id = r.export_id
    WHERE r.namespace_ref = ? AND r.expires_at_ms <= ? AND j.state = 'prepared'
    ORDER BY r.expires_at_ms ASC, r.export_id ASC LIMIT 65
  `).all(namespaceRef, Date.parse(freshNow)) as Row[]
  if (candidateRows.length > MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const terminalAuditRows = database.prepare(`
    SELECT namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
      source_committed_at_ms, recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    FROM lifecycle_audits WHERE namespace_ref = ?
      AND operation IN ('export_completed', 'export_failed')
    ORDER BY recorded_at_ms ASC, audit_id ASC LIMIT 8193
  `).all(namespaceRef) as Row[]
  if (terminalAuditRows.length > LIFECYCLE_AUDIT_RECORDS_PER_NAMESPACE) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  const terminalExportHashes = new Set(terminalAuditRows.map(row => {
    const audit = validateLifecycleAuditRow(row, namespaceRef)
    if (audit.aggregateKind !== 'export') {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    return audit.aggregateRefHash
  }))
  const rows = candidateRows.filter(row => !terminalExportHashes.has(
    memoryLifecycleDomainHashV1(
      EXPORT_REF_HASH_DOMAIN_V1,
      exactString(rowValue(row, 'export_id'))
    )
  ))
  const selected = rows.slice(0, limit)
  const hashes: string[] = []
  for (const row of selected) {
    const wire = exactString(rowValue(row, 'reservation_wire'))
    const exportId = exactString(rowValue(row, 'export_id'))
    const generation = positiveInteger(rowValue(row, 'namespace_generation'))
    const commandHash = exactString(rowValue(row, 'command_hash'))
    const expiresAt = exactInteger(rowValue(row, 'expires_at_ms'))
    const preparedAt = exactInteger(rowValue(row, 'prepared_at_ms'))
    if (exactString(rowValue(row, 'namespace_ref')) !== namespaceRef ||
      exactString(rowValue(row, 'job_namespace_ref')) !== namespaceRef ||
      positiveInteger(rowValue(row, 'job_namespace_generation')) !== generation ||
      exactString(rowValue(row, 'prepared_command_hash')) !== commandHash ||
      expiresAt !== preparedAt +
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportTerminalTtlMs ||
      exactInteger(rowValue(row, 'job_expires_at_ms')) !== expiresAt ||
      Buffer.byteLength(wire, 'utf8') !==
      positiveInteger(rowValue(row, 'reservation_wire_bytes')) ||
      positiveInteger(rowValue(row, 'reserved_records')) !== 1 ||
      positiveInteger(rowValue(row, 'reserved_bytes')) >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes ||
      !HASH_PATTERN.test(commandHash)) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    requireOneChange(database.prepare(`
      DELETE FROM export_audit_reservations WHERE export_id = ? AND namespace_ref = ?
    `).run(exportId, namespaceRef).changes)
    hashes.push(itemReceiptHash(operation, exportId, freshNow, 'released'))
  }
  return Object.freeze({ hashes: Object.freeze(hashes), hasMore: rows.length > selected.length })
}

function executeOperation (
  database: DatabaseSync,
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
  freshNow: string
): { readonly hashes: readonly string[]; readonly hasMore: boolean } {
  const wire = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
  if (wire.operation === 'proposal.expireDue' || wire.operation === 'proposal.purgeDecided') {
    return maintainProposals(
      database,
      wire.operation,
      wire.namespaceRef,
      wire.targetGeneration,
      wire.commandRef,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'record.purgeExpired') {
    return purgeExpiredRecords(
      database,
      wire.namespaceRef,
      wire.targetGeneration,
      wire.operation,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'namespace.scrubDeleted') {
    return scrubDeletedNamespace(
      database,
      wire.namespaceRef,
      wire.currentGeneration,
      wire.targetGeneration,
      wire.deletionRef as string,
      wire.operation,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'namespace.verifyScrubbed') {
    return verifyDeletedNamespace(
      database,
      wire.namespaceRef,
      wire.currentGeneration,
      wire.targetGeneration,
      wire.deletionRef as string,
      wire.operation,
      freshNow
    )
  }
  if (wire.operation === 'tombstone.purgeExpired') {
    return purgeExpiredTombstones(
      database,
      wire.namespaceRef,
      wire.operation,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'audit.purgeExpired') {
    return purgeExpiredAudits(database, wire.namespaceRef, wire.operation, wire.limit, freshNow)
  }
  if (wire.operation === 'command.purgeExpired') {
    return purgeExpiredCommands(
      database,
      wire.namespaceRef,
      wire.commandRef,
      wire.operation,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'export.releaseExpiredReservations') {
    return releaseExpiredExportReservations(
      database,
      wire.namespaceRef,
      wire.operation,
      wire.limit,
      freshNow
    )
  }
  if (wire.operation === 'deletion.checkpoint') {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  throw new CanonicalMaintenanceDataErrorV1()
}

function existingResult (
  database: DatabaseSync,
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1
): MemoryMaintenanceBatchManifestV1 | 'conflict' | null {
  const command = envelope.command
  const wire = decodeMemoryMaintenanceCommandWireV1(command.wire)
  const commandHash = memoryMaintenanceCommandHashV1(command)
  const row = database.prepare(`
    SELECT namespace_generation, command_hash, operation, aggregate_ref_hash,
      result_wire, result_wire_bytes, result_hash, committed_at_ms, expires_at_ms
    FROM lifecycle_commands
    WHERE namespace_ref = ? AND command_ref = ?
  `).get(wire.namespaceRef, wire.commandRef) as Row | undefined
  if (row === undefined) return null
  const storedCommandHash = exactString(rowValue(row, 'command_hash'))
  const storedOperation = exactString(rowValue(row, 'operation'))
  const storedGeneration = positiveInteger(rowValue(row, 'namespace_generation'))
  const loaded = canonicalWire(
    rowValue(row, 'result_wire'),
    rowValue(row, 'result_wire_bytes'),
    decodeMemoryMaintenanceBatchManifestV1
  )
  if (memoryMaintenanceBatchManifestHashV1(loaded.value) !==
      exactString(rowValue(row, 'result_hash')) ||
    !HASH_PATTERN.test(storedCommandHash) ||
    loaded.value.commandHash !== storedCommandHash ||
    loaded.value.operation !== storedOperation ||
    loaded.value.namespaceRef !== wire.namespaceRef ||
    loaded.value.currentGeneration !== storedGeneration ||
    loaded.value.commandRefHash !== memoryMaintenanceCommandRefHashV1(wire.commandRef) ||
    exactString(rowValue(row, 'aggregate_ref_hash')) !==
      aggregateRefHash(loaded.value.deletionRef ?? wire.namespaceRef) ||
    Date.parse(loaded.value.completedAt) !== exactInteger(rowValue(row, 'committed_at_ms')) ||
    exactInteger(rowValue(row, 'expires_at_ms')) -
      exactInteger(rowValue(row, 'committed_at_ms')) !==
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  if (storedCommandHash !== commandHash || storedOperation !== wire.operation ||
    storedGeneration !== wire.currentGeneration) return 'conflict'
  if (loaded.value.targetGeneration !== wire.targetGeneration ||
    loaded.value.deletionRef !== wire.deletionRef) {
    throw new CanonicalMaintenanceDataErrorV1()
  }
  return loaded.value
}

function insertResult (
  database: DatabaseSync,
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
  batch: { readonly hashes: readonly string[]; readonly hasMore: boolean },
  freshNow: string
): MemoryMaintenanceBatchManifestV1 {
  const command = envelope.command
  const wire = decodeMemoryMaintenanceCommandWireV1(command.wire)
  const commandHash = memoryMaintenanceCommandHashV1(command)
  const manifest = createMemoryMaintenanceBatchManifestV1({
    schemaVersion: 1,
    status: 'completed',
    commandRefHash: memoryMaintenanceCommandRefHashV1(wire.commandRef),
    commandHash,
    operation: wire.operation,
    namespaceRef: wire.namespaceRef,
    currentGeneration: wire.currentGeneration,
    targetGeneration: wire.targetGeneration,
    deletionRef: wire.deletionRef,
    selectionOrder: 'oldest_first',
    processed: batch.hashes.length,
    hasMore: batch.hasMore,
    itemReceiptHashes: batch.hashes,
    completedAt: freshNow
  })
  const resultWire = encodeMemoryMaintenanceBatchManifestV1(manifest)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_commands(
      namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
      committed_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wire.namespaceRef,
    wire.currentGeneration,
    wire.commandRef,
    commandHash,
    wire.operation,
    aggregateRefHash(wire.deletionRef ?? wire.namespaceRef),
    resultWire,
    Buffer.byteLength(resultWire, 'utf8'),
    memoryMaintenanceBatchManifestHashV1(manifest),
    Date.parse(freshNow),
    Date.parse(freshNow) + MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs
  ).changes)
  return manifest
}

function executeLocked (
  database: DatabaseSync,
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
  freshNow: string
): unknown {
  const denial = lockedAuthorizationDenial(envelope, freshNow)
  if (denial !== null) return denial
  const wire = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
  const currentGeneration = loadNamespaceGeneration(database, wire.namespaceRef)
  if (currentGeneration === null || currentGeneration !== wire.currentGeneration) {
    return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
  }
  const replay = existingResult(database, envelope)
  if (replay === 'conflict') {
    return Object.freeze({ status: 'conflict' as const, category: 'idempotency' as const })
  }
  if (replay !== null) return replay
  assertUsageExact(database, wire.namespaceRef)
  const batch = executeOperation(database, envelope, freshNow)
  const manifest = insertResult(database, envelope, batch, freshNow)
  if (!capacityAllowed(database, wire.namespaceRef)) throw new MaintenanceCapacityErrorV1()
  synchronizeUsage(database, wire.namespaceRef, Date.parse(freshNow))
  return manifest
}

function sqliteErrcode (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function storageFailure (error: unknown): unknown {
  if (error instanceof MaintenanceCapacityErrorV1) {
    return Object.freeze({ status: 'capacity' as const, category: 'maintenance_capacity' as const })
  }
  if (error instanceof CanonicalMaintenanceDataErrorV1 ||
    error instanceof CanonicalLifecycleMutationDataErrorV1 || error instanceof SyntaxError ||
    error instanceof TypeError) {
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

async function executeDeletionCheckpoint (
  database: DatabaseSync,
  now: () => string,
  envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
  signal?: AbortSignal
): Promise<unknown> {
  const wire = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
  let started = false
  let refs: readonly string[] = Object.freeze([])
  let hasMore = false
  try {
    database.exec('BEGIN IMMEDIATE')
    started = true
    const freshNow = freezeTrustedNow(database, now)
    const denial = lockedAuthorizationDenial(envelope, freshNow)
    if (denial !== null) {
      database.exec('COMMIT')
      started = false
      return denial
    }
    const currentGeneration = loadNamespaceGeneration(database, wire.namespaceRef)
    if (currentGeneration === null || currentGeneration !== wire.currentGeneration) {
      database.exec('COMMIT')
      started = false
      return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
    }
    const replay = existingResult(database, envelope)
    if (replay === 'conflict') {
      database.exec('COMMIT')
      started = false
      return Object.freeze({ status: 'conflict' as const, category: 'idempotency' as const })
    }
    if (replay !== null) {
      database.exec('COMMIT')
      started = false
      return replay
    }
    assertUsageExact(database, wire.namespaceRef)
    const prepared = prepareDeletionCheckpointBatch(
      database,
      wire.namespaceRef,
      wire.currentGeneration,
      wire.limit,
      freshNow
    )
    refs = prepared.refs
    hasMore = prepared.hasMore
    if (!capacityAllowed(database, wire.namespaceRef)) throw new MaintenanceCapacityErrorV1()
    synchronizeUsage(database, wire.namespaceRef, Date.parse(freshNow))
    database.exec('COMMIT')
    started = false

    let walCheckpoint: 'truncated' | 'deferred' = 'deferred'
    if (refs.length > 0) {
      try {
        const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row | undefined
        if (row !== undefined && exactInteger(rowValue(row, 'busy')) === 0) {
          walCheckpoint = 'truncated'
        }
      } catch {
        walCheckpoint = 'deferred'
      }
    }

    database.exec('BEGIN IMMEDIATE')
    started = true
    const finalizedAt = freezeTrustedNow(database, now)
    const finalDenial = lockedAuthorizationDenial(envelope, finalizedAt)
    if (finalDenial !== null) throw new CanonicalMaintenanceDataErrorV1()
    if (loadNamespaceGeneration(database, wire.namespaceRef) !== wire.currentGeneration) {
      throw new CanonicalMaintenanceDataErrorV1()
    }
    const concurrentReplay = existingResult(database, envelope)
    if (concurrentReplay !== null) {
      if (concurrentReplay === 'conflict') throw new CanonicalMaintenanceDataErrorV1()
      database.exec('COMMIT')
      started = false
      return concurrentReplay
    }
    assertUsageExact(database, wire.namespaceRef)
    const batch = finalizeDeletionCheckpointBatch(
      database,
      wire.namespaceRef,
      wire.currentGeneration,
      wire.operation,
      refs,
      hasMore,
      walCheckpoint,
      finalizedAt
    )
    const result = insertResult(database, envelope, batch, finalizedAt)
    if (!capacityAllowed(database, wire.namespaceRef)) throw new MaintenanceCapacityErrorV1()
    synchronizeUsage(database, wire.namespaceRef, Date.parse(finalizedAt))
    database.exec('COMMIT')
    started = false
    return result
  } catch (error) {
    if (started) {
      try {
        database.exec('ROLLBACK')
      } catch {}
    }
    return storageFailure(error)
  }
}

export function createSqliteMemoryMaintenanceAdapterV1 (
  options: CreateSqliteMemoryMaintenanceAdapterOptionsV1
): Pick<MemoryMaintenancePortOptionsV1, 'execute'> {
  if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
    options.database === null || typeof options.database !== 'object' ||
    utilTypes.isProxy(options.database) || typeof options.database.exec !== 'function' ||
    typeof options.database.prepare !== 'function' || typeof options.now !== 'function' ||
    utilTypes.isProxy(options.now)) throw new TypeError('invalid sqlite memory maintenance options')
  const { database, now } = options
  return Object.freeze({
    execute: async (envelope: MemoryMaintenanceAuthorizationEnvelopeV1, signal?: AbortSignal) => {
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const wire = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
      if (wire.operation === 'deletion.checkpoint') {
        return executeDeletionCheckpoint(database, now, envelope, signal)
      }
      let started = false
      try {
        database.exec('BEGIN IMMEDIATE')
        started = true
        const freshNow = freezeTrustedNow(database, now)
        const result = executeLocked(database, envelope, freshNow)
        database.exec('COMMIT')
        started = false
        return result
      } catch (error) {
        if (started) {
          try {
            database.exec('ROLLBACK')
          } catch {}
        }
        return storageFailure(error)
      }
    }
  })
}
