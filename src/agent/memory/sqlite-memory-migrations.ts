import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  decodeMemoryOutboxEventV1,
  decodeMemoryProposalV1,
  decodeMemoryRevisionV1,
  decodeMemoryTombstoneV1
} from './memory-codec.js'
import {
  parseMemoryV1ToV2AggregateManifestV1,
  type MemoryV1ToV2AggregateManifestV1
} from './memory-lifecycle-domain.js'
import { encodeMemoryV1ToV2AggregateManifestV1 } from './memory-lifecycle-codec.js'
import {
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

export const MEMORY_SQLITE_APPLICATION_ID_V1 = 0x474d454d
export const MEMORY_SQLITE_SCHEMA_VERSION_V1 = 1
export const MEMORY_SQLITE_SCHEMA_VERSION_V2 = 2
export const MEMORY_SQLITE_SCHEMA_FINGERPRINT_DOMAIN_V1 =
  'groupmate.memory.sqlite-schema.v1'

export interface MemorySqliteMigrationV1 {
  readonly version: number
  readonly sql: string
  readonly checksum: string
  readonly schemaFingerprint: string
}

interface SqliteSchemaObjectV1 {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string
}

interface RunSqliteMemoryMigrationSequenceOptionsV1 {
  readonly migrations: readonly MemorySqliteMigrationV1[]
  readonly appliedAt: string
}

export interface RunSqliteMemoryMigrationV2OptionsV1 {
  readonly appliedAt: string
  readonly manifests: readonly MemoryV1ToV2AggregateManifestV1[]
}

export class MemorySqliteMigrationErrorV2 extends TypeError {
  readonly code:
    | 'memory_migration_manifest_required'
    | 'memory_migration_manifest_invalid'
    | 'memory_migration_capacity'

  constructor (code: MemorySqliteMigrationErrorV2['code']) {
    super(code)
    this.name = 'MemorySqliteMigrationErrorV2'
    this.code = code
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/
const MAXIMUM_SCHEMA_OBJECTS = 256
const MAXIMUM_SCHEMA_OBJECT_SQL_BYTES = 64 * 1_024
const MAXIMUM_SCHEMA_SQL_BYTES = 1 * 1_024 * 1_024
const MAXIMUM_V1_TO_V2_MANIFESTS = 256
const V2_NAMESPACE_CANONICAL_SOFT_BYTES =
  MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes - (2 * 1_024 * 1_024)
const V2_DEPLOYMENT_CANONICAL_SOFT_BYTES =
  MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes - (8 * 1_024 * 1_024)
const V2_PENDING_PROPOSAL_SOFT_RECORDS = 240
const V2_OUTBOX_SOFT_RECORDS = MEMORY_RESOURCE_LIMITS.unackedOutboxRecords - 256
const V2_OUTBOX_SOFT_BYTES =
  MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes - (1 * 1_024 * 1_024)
const NAMESPACE_REF_CHECK = `
  length(namespace_ref) = 64 AND
  namespace_ref = lower(namespace_ref) AND
  namespace_ref NOT GLOB '*[^0-9a-f]*'
`.trim()
const HASH_CHECK = (column: string): string => `
  length(${column}) = 64 AND
  ${column} = lower(${column}) AND
  ${column} NOT GLOB '*[^0-9a-f]*'
`.trim()

const SCHEMA_OBJECTS_V1: readonly SqliteSchemaObjectV1[] = Object.freeze([
  Object.freeze({
    type: 'table' as const,
    name: 'schema_migrations',
    tableName: 'schema_migrations',
    sql: `CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version > 0),
  checksum TEXT NOT NULL CHECK(${HASH_CHECK('checksum')}),
  schema_fingerprint TEXT NOT NULL CHECK(${HASH_CHECK('schema_fingerprint')}),
  applied_at TEXT NOT NULL CHECK(length(applied_at) BETWEEN 20 AND 32)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'namespaces',
    tableName: 'namespaces',
    sql: `CREATE TABLE namespaces(
  namespace_ref TEXT PRIMARY KEY CHECK(${NAMESPACE_REF_CHECK}),
  namespace_wire TEXT NOT NULL CHECK(length(namespace_wire) > 0),
  namespace_wire_bytes INTEGER NOT NULL CHECK(namespace_wire_bytes > 0),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'proposals',
    tableName: 'proposals',
    sql: `CREATE TABLE proposals(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected', 'expired')),
  proposed_at_ms INTEGER NOT NULL CHECK(proposed_at_ms >= 0),
  decided_at_ms INTEGER CHECK(decided_at_ms IS NULL OR decided_at_ms >= proposed_at_ms),
  resulting_memory_id TEXT CHECK(
    resulting_memory_id IS NULL OR length(resulting_memory_id) BETWEEN 1 AND 128
  ),
  resulting_revision INTEGER CHECK(
    resulting_revision IS NULL OR resulting_revision = 1
  ),
  resulting_revision_hash TEXT CHECK(
    resulting_revision_hash IS NULL OR (${HASH_CHECK('resulting_revision_hash')})
  ),
  proposal_wire TEXT NOT NULL CHECK(length(proposal_wire) > 0),
  proposal_wire_bytes INTEGER NOT NULL CHECK(proposal_wire_bytes > 0),
  CHECK(
    (state = 'approved' AND resulting_memory_id IS NOT NULL AND
      resulting_revision IS NOT NULL AND resulting_revision_hash IS NOT NULL) OR
    (state != 'approved' AND resulting_memory_id IS NULL AND
      resulting_revision IS NULL AND resulting_revision_hash IS NULL)
  ),
  PRIMARY KEY(namespace_ref, namespace_generation, proposal_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE,
  FOREIGN KEY(namespace_ref, namespace_generation, resulting_memory_id, resulting_revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'revisions',
    tableName: 'revisions',
    sql: `CREATE TABLE revisions(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  operation TEXT NOT NULL CHECK(operation IN ('created', 'corrected', 'retention_changed', 'conflict_changed')),
  revision_hash TEXT NOT NULL CHECK(${HASH_CHECK('revision_hash')}),
  previous_revision_hash TEXT CHECK(previous_revision_hash IS NULL OR (${HASH_CHECK('previous_revision_hash')})),
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
  revision_wire_bytes INTEGER NOT NULL CHECK(revision_wire_bytes > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id, revision),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'revision_payloads',
    tableName: 'revision_payloads',
    sql: `CREATE TABLE revision_payloads(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  revision_wire TEXT NOT NULL CHECK(length(revision_wire) > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id, revision),
  FOREIGN KEY(namespace_ref, namespace_generation, memory_id, revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'heads',
    tableName: 'heads',
    sql: `CREATE TABLE heads(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  current_revision_hash TEXT NOT NULL CHECK(${HASH_CHECK('current_revision_hash')}),
  content_hash TEXT NOT NULL CHECK(${HASH_CHECK('content_hash')}),
  cursor_ref TEXT NOT NULL CHECK(
    length(cursor_ref) = 64 AND
    cursor_ref = lower(cursor_ref) AND
    cursor_ref NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  valid_until_ms INTEGER NOT NULL CHECK(valid_until_ms >= 0),
  purge_at_ms INTEGER NOT NULL CHECK(purge_at_ms >= valid_until_ms),
  PRIMARY KEY(namespace_ref, namespace_generation, memory_id),
  FOREIGN KEY(namespace_ref, namespace_generation, memory_id, current_revision)
    REFERENCES revisions(namespace_ref, namespace_generation, memory_id, revision)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'tombstones',
    tableName: 'tombstones',
    sql: `CREATE TABLE tombstones(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  tombstone_id TEXT NOT NULL CHECK(length(tombstone_id) BETWEEN 1 AND 128),
  memory_id TEXT CHECK(memory_id IS NULL OR length(memory_id) BETWEEN 1 AND 128),
  deleted_revision INTEGER CHECK(deleted_revision IS NULL OR deleted_revision > 0),
  deletion_kind TEXT NOT NULL CHECK(deletion_kind IN ('memory_forgotten', 'namespace_deleted')),
  deleted_at_ms INTEGER NOT NULL CHECK(deleted_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > deleted_at_ms),
  receipt_hash TEXT NOT NULL CHECK(${HASH_CHECK('receipt_hash')}),
  tombstone_wire TEXT NOT NULL CHECK(length(tombstone_wire) > 0),
  tombstone_wire_bytes INTEGER NOT NULL CHECK(tombstone_wire_bytes > 0),
  PRIMARY KEY(namespace_ref, namespace_generation, tombstone_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'usage',
    tableName: 'usage',
    sql: `CREATE TABLE usage(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  pending_proposal_records INTEGER NOT NULL CHECK(pending_proposal_records >= 0),
  active_memory_records INTEGER NOT NULL CHECK(active_memory_records >= 0),
  retained_revision_records INTEGER NOT NULL CHECK(retained_revision_records >= 0),
  tombstone_records INTEGER NOT NULL CHECK(tombstone_records >= 0),
  canonical_logical_bytes INTEGER NOT NULL CHECK(canonical_logical_bytes >= 0),
  pending_outbox_records INTEGER NOT NULL CHECK(pending_outbox_records >= 0),
  outbox_logical_bytes INTEGER NOT NULL CHECK(outbox_logical_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(namespace_ref, namespace_generation),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'global_usage',
    tableName: 'global_usage',
    sql: `CREATE TABLE global_usage(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  namespace_records INTEGER NOT NULL CHECK(namespace_records >= 0),
  active_memory_records INTEGER NOT NULL CHECK(active_memory_records >= 0),
  canonical_logical_bytes INTEGER NOT NULL CHECK(canonical_logical_bytes >= 0),
  pending_outbox_records INTEGER NOT NULL CHECK(pending_outbox_records >= 0),
  outbox_logical_bytes INTEGER NOT NULL CHECK(outbox_logical_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'outbox',
    tableName: 'outbox',
    sql: `CREATE TABLE outbox(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  aggregate TEXT NOT NULL CHECK(aggregate IN ('proposal', 'record', 'namespace')),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('proposal_changed', 'record_upserted', 'record_forgotten', 'namespace_deleted')),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= occurred_at_ms),
  event_wire TEXT NOT NULL CHECK(length(event_wire) > 0),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes > 0),
  lease_owner_id TEXT,
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) = 80),
  leased_until_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_reason_code TEXT,
  CHECK(
    (lease_owner_id IS NULL AND lease_token IS NULL AND leased_until_ms IS NULL) OR
    (lease_owner_id IS NOT NULL AND lease_token IS NOT NULL AND leased_until_ms IS NOT NULL)
  ),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_proposals_pending_v1',
    tableName: 'proposals',
    sql: `CREATE INDEX memory_proposals_pending_v1
ON proposals(namespace_ref ASC, namespace_generation ASC, state ASC, proposed_at_ms ASC, proposal_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_revisions_hash_v1',
    tableName: 'revisions',
    sql: `CREATE UNIQUE INDEX memory_revisions_hash_v1
ON revisions(namespace_ref ASC, namespace_generation ASC, revision_hash ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_proposals_resulting_memory_v1',
    tableName: 'proposals',
    sql: `CREATE INDEX memory_proposals_resulting_memory_v1
ON proposals(namespace_ref ASC, namespace_generation ASC, resulting_memory_id ASC,
  resulting_revision ASC, proposal_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_cursor_ref_v1',
    tableName: 'heads',
    sql: `CREATE UNIQUE INDEX memory_heads_cursor_ref_v1
ON heads(cursor_ref ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_seek_v1',
    tableName: 'heads',
    sql: `CREATE INDEX memory_heads_seek_v1
ON heads(namespace_ref ASC, namespace_generation ASC, updated_at_ms DESC, memory_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_heads_purge_v1',
    tableName: 'heads',
    sql: `CREATE INDEX memory_heads_purge_v1
ON heads(namespace_ref ASC, namespace_generation ASC, purge_at_ms ASC, memory_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_active_memory_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_active_memory_v1
ON tombstones(namespace_ref ASC, namespace_generation ASC, memory_id ASC,
  deletion_kind ASC, expires_at_ms ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_active_namespace_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_active_namespace_v1
ON tombstones(namespace_ref ASC, namespace_generation ASC, deletion_kind ASC,
  expires_at_ms ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_tombstones_expiry_v1',
    tableName: 'tombstones',
    sql: `CREATE INDEX memory_tombstones_expiry_v1
ON tombstones(namespace_ref ASC, expires_at_ms ASC, namespace_generation ASC, tombstone_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_event_id_v1',
    tableName: 'outbox',
    sql: `CREATE UNIQUE INDEX memory_outbox_event_id_v1
ON outbox(event_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_available_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_available_v1
ON outbox(available_at_ms ASC, sequence ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_namespace_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_namespace_v1
ON outbox(namespace_ref ASC, namespace_generation ASC, sequence ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_lease_v1',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_lease_v1
ON outbox(lease_owner_id ASC, leased_until_ms ASC, sequence ASC)`
  })
])

const USAGE_COLUMNS_V2 = Object.freeze([
  'lifecycle_audit_records INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_audit_records >= 0)',
  'lifecycle_audit_reserved_records INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_audit_reserved_records >= 0)',
  'lifecycle_command_records INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_command_records >= 0)',
  'deletion_checkpoint_records INTEGER NOT NULL DEFAULT 0 CHECK(deletion_checkpoint_records >= 0)',
  'export_job_records INTEGER NOT NULL DEFAULT 0 CHECK(export_job_records >= 0)',
  'lifecycle_audit_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_audit_logical_bytes >= 0)',
  'lifecycle_audit_reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_audit_reserved_bytes >= 0)',
  'lifecycle_command_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_command_logical_bytes >= 0)',
  'deletion_checkpoint_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(deletion_checkpoint_logical_bytes >= 0)',
  'export_job_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(export_job_logical_bytes >= 0)'
])

const GLOBAL_USAGE_COLUMNS_V2 = Object.freeze([
  'pending_proposal_records INTEGER NOT NULL DEFAULT 0 CHECK(pending_proposal_records >= 0)',
  'retained_revision_records INTEGER NOT NULL DEFAULT 0 CHECK(retained_revision_records >= 0)',
  'tombstone_records INTEGER NOT NULL DEFAULT 0 CHECK(tombstone_records >= 0)',
  ...USAGE_COLUMNS_V2
])

function sqliteAlteredTableSqlV2 (
  sql: string,
  columns: readonly string[]
): string {
  const marker = ') STRICT'
  const markerIndex = sql.lastIndexOf(marker)
  if (markerIndex < 0 || columns.length === 0) return invalidMemoryValue()
  return `${sql.slice(0, markerIndex)}, ${columns.join(', ')}${sql.slice(markerIndex)}`
}

function sqliteAlteredTableBeforeConstraintsSqlV2 (
  sql: string,
  columns: readonly string[]
): string {
  const marker = ',\n  PRIMARY KEY'
  const markerIndex = sql.indexOf(marker)
  if (markerIndex < 0 || columns.length === 0) return invalidMemoryValue()
  return `${sql.slice(0, markerIndex)}, ${columns.join(', ')}${sql.slice(markerIndex)}`
}

function v1SchemaObject (name: string): SqliteSchemaObjectV1 {
  const value = SCHEMA_OBJECTS_V1.find(object => object.name === name)
  return value ?? invalidMemoryValue()
}

const ALTERED_SCHEMA_SQL_V2 = Object.freeze({
  namespaces: sqliteAlteredTableSqlV2(
    v1SchemaObject('namespaces').sql,
    ['content_epoch INTEGER NOT NULL DEFAULT 0 CHECK(content_epoch >= 0)']
  ),
  usage: sqliteAlteredTableBeforeConstraintsSqlV2(
    v1SchemaObject('usage').sql,
    USAGE_COLUMNS_V2
  ),
  globalUsage: sqliteAlteredTableSqlV2(
    v1SchemaObject('global_usage').sql,
    GLOBAL_USAGE_COLUMNS_V2
  )
})

const PROPOSALS_TABLE_STAGE_SQL_V2 = v1SchemaObject('proposals').sql
  .replace('CREATE TABLE proposals(', 'CREATE TABLE proposals_v2_stage(')
  .replace(
    "state IN ('pending', 'approved', 'rejected', 'expired')",
    "state IN ('pending', 'approved', 'rejected', 'expired', 'withdrawn')"
  )
  .replace(
    'resulting_revision IS NULL OR resulting_revision = 1',
    `resulting_revision IS NULL OR (resulting_revision BETWEEN 1 AND ${
      MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
    })`
  )

const PROPOSALS_TABLE_SQL_V2 = PROPOSALS_TABLE_STAGE_SQL_V2.replace(
  'CREATE TABLE proposals_v2_stage(',
  'CREATE TABLE "proposals"('
)

const PROPOSAL_INDEX_OBJECTS_V1 = Object.freeze(
  SCHEMA_OBJECTS_V1.filter(object => (
    object.type === 'index' && object.tableName === 'proposals'
  ))
)

const PROPOSAL_REBUILD_SQL_V2 = Object.freeze([
  PROPOSALS_TABLE_STAGE_SQL_V2,
  `INSERT INTO proposals_v2_stage(
  namespace_ref, namespace_generation, proposal_id, revision, state,
  proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
  resulting_revision_hash, proposal_wire, proposal_wire_bytes
)
SELECT
  namespace_ref, namespace_generation, proposal_id, revision, state,
  proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
  resulting_revision_hash, proposal_wire, proposal_wire_bytes
FROM proposals
ORDER BY namespace_ref ASC, namespace_generation ASC, proposal_id ASC`,
  'DROP TABLE proposals',
  'ALTER TABLE proposals_v2_stage RENAME TO proposals',
  ...PROPOSAL_INDEX_OBJECTS_V1.map(object => object.sql)
])

const NEW_SCHEMA_OBJECTS_V2: readonly SqliteSchemaObjectV1[] = Object.freeze([
  Object.freeze({
    type: 'table' as const,
    name: 'consent_evidence',
    tableName: 'consent_evidence',
    sql: `CREATE TABLE consent_evidence(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) BETWEEN 1 AND 128),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 128),
  evidence_hash TEXT NOT NULL CHECK(${HASH_CHECK('evidence_hash')}),
  evidence_wire TEXT NOT NULL CHECK(length(evidence_wire) > 0),
  evidence_wire_bytes INTEGER NOT NULL CHECK(
    evidence_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes}
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  CHECK(evidence_wire_bytes = length(CAST(evidence_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, namespace_generation, evidence_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'revision_evidence',
    tableName: 'revision_evidence',
    sql: `CREATE TABLE revision_evidence(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) BETWEEN 1 AND 128),
  memory_id TEXT NOT NULL CHECK(length(memory_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 2 AND 32),
  evidence_hash TEXT NOT NULL CHECK(${HASH_CHECK('evidence_hash')}),
  evidence_wire TEXT NOT NULL CHECK(length(evidence_wire) > 0),
  evidence_wire_bytes INTEGER NOT NULL CHECK(
    evidence_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes}
  ),
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
  CHECK(evidence_wire_bytes = length(CAST(evidence_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, namespace_generation, evidence_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'memory_v1_to_v2_manifests',
    tableName: 'memory_v1_to_v2_manifests',
    sql: `CREATE TABLE memory_v1_to_v2_manifests(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 128),
  aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('proposal', 'memory')),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 128),
  manifest_hash TEXT NOT NULL CHECK(${HASH_CHECK('manifest_hash')}),
  manifest_wire TEXT NOT NULL CHECK(length(manifest_wire) > 0),
  manifest_wire_bytes INTEGER NOT NULL CHECK(
    manifest_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes}
  ),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0),
  CHECK(manifest_wire_bytes = length(CAST(manifest_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, namespace_generation, manifest_id),
  UNIQUE(namespace_ref, namespace_generation, aggregate_kind, aggregate_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lifecycle_audits',
    tableName: 'lifecycle_audits',
    sql: `CREATE TABLE lifecycle_audits(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  audit_id TEXT NOT NULL CHECK(length(audit_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  command_ref_hash TEXT NOT NULL CHECK(${HASH_CHECK('command_ref_hash')}),
  aggregate_ref_hash TEXT NOT NULL CHECK(${HASH_CHECK('aggregate_ref_hash')}),
  authorized_actor_ref_hash TEXT NOT NULL CHECK(${HASH_CHECK('authorized_actor_ref_hash')}),
  executed_actor_ref_hash TEXT NOT NULL CHECK(${HASH_CHECK('executed_actor_ref_hash')}),
  source_committed_at_ms INTEGER NOT NULL CHECK(source_committed_at_ms >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms >= source_committed_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > recorded_at_ms),
  audit_wire TEXT NOT NULL CHECK(length(audit_wire) > 0),
  audit_wire_bytes INTEGER NOT NULL CHECK(
    audit_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes}
  ),
  CHECK(audit_wire_bytes = length(CAST(audit_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, namespace_generation, audit_id),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lifecycle_commands',
    tableName: 'lifecycle_commands',
    sql: `CREATE TABLE lifecycle_commands(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  command_ref TEXT NOT NULL CHECK(length(command_ref) BETWEEN 1 AND 128),
  command_hash TEXT NOT NULL CHECK(${HASH_CHECK('command_hash')}),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  aggregate_ref_hash TEXT NOT NULL CHECK(${HASH_CHECK('aggregate_ref_hash')}),
  result_wire TEXT NOT NULL CHECK(length(result_wire) > 0),
  result_wire_bytes INTEGER NOT NULL CHECK(
    result_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes}
  ),
  result_hash TEXT NOT NULL CHECK(${HASH_CHECK('result_hash')}),
  committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > committed_at_ms),
  CHECK(result_wire_bytes = length(CAST(result_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, command_ref),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'namespace_deletion_checkpoints',
    tableName: 'namespace_deletion_checkpoints',
    sql: `CREATE TABLE namespace_deletion_checkpoints(
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  deletion_ref TEXT NOT NULL CHECK(length(deletion_ref) BETWEEN 1 AND 128),
  deleting_generation INTEGER NOT NULL CHECK(deleting_generation > 0),
  observed_current_generation INTEGER NOT NULL CHECK(observed_current_generation > deleting_generation),
  canonical_bodies TEXT NOT NULL CHECK(canonical_bodies IN ('verified_absent', 'scrub_pending', 'unverified')),
  payload_deletion TEXT NOT NULL CHECK(payload_deletion IN ('secure_delete_on', 'unverified')),
  wal_checkpoint TEXT NOT NULL CHECK(wal_checkpoint IN ('truncated', 'deferred', 'unverified')),
  derived_cleanup TEXT NOT NULL CHECK(derived_cleanup IN ('queued', 'applied', 'unverified')),
  stage TEXT NOT NULL CHECK(stage IN ('logical_committed', 'verification_pending', 'canonical_complete')),
  receipt_hash TEXT NOT NULL CHECK(${HASH_CHECK('receipt_hash')}),
  checkpoint_wire TEXT NOT NULL CHECK(length(checkpoint_wire) > 0),
  checkpoint_wire_bytes INTEGER NOT NULL CHECK(
    checkpoint_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointWireBytes}
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK(checkpoint_wire_bytes = length(CAST(checkpoint_wire AS BLOB))),
  PRIMARY KEY(namespace_ref, deletion_ref),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'export_audit_reservations',
    tableName: 'export_audit_reservations',
    sql: `CREATE TABLE export_audit_reservations(
  export_id TEXT PRIMARY KEY CHECK(length(export_id) BETWEEN 1 AND 128),
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  command_hash TEXT NOT NULL CHECK(${HASH_CHECK('command_hash')}),
  reserved_records INTEGER NOT NULL CHECK(reserved_records = 1),
  reserved_bytes INTEGER NOT NULL CHECK(
    reserved_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes}
  ),
  reservation_wire TEXT NOT NULL CHECK(length(reservation_wire) > 0),
  reservation_wire_bytes INTEGER NOT NULL CHECK(
    reservation_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditReservationWireBytes}
  ),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  CHECK(reservation_wire_bytes = length(CAST(reservation_wire AS BLOB))),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'export_jobs',
    tableName: 'export_jobs',
    sql: `CREATE TABLE export_jobs(
  export_id TEXT PRIMARY KEY CHECK(length(export_id) BETWEEN 1 AND 128),
  namespace_ref TEXT NOT NULL CHECK(${NAMESPACE_REF_CHECK}),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  content_epoch INTEGER NOT NULL CHECK(content_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('prepared', 'writing', 'deliverable', 'delivered', 'failed')),
  prepared_command_hash TEXT NOT NULL CHECK(${HASH_CHECK('prepared_command_hash')}),
  terminal_command_hash TEXT CHECK(terminal_command_hash IS NULL OR (${HASH_CHECK('terminal_command_hash')})),
  lease_owner_id TEXT CHECK(lease_owner_id IS NULL OR length(lease_owner_id) BETWEEN 1 AND 128),
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  leased_until_ms INTEGER,
  manifest_wire TEXT,
  manifest_wire_bytes INTEGER CHECK(
    manifest_wire_bytes IS NULL OR manifest_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes}
  ),
  artifact_token TEXT CHECK(artifact_token IS NULL OR length(artifact_token) BETWEEN 1 AND 256),
  claim_command_hash TEXT CHECK(claim_command_hash IS NULL OR (${HASH_CHECK('claim_command_hash')})),
  delivery_ref_hash TEXT CHECK(delivery_ref_hash IS NULL OR (${HASH_CHECK('delivery_ref_hash')})),
  claim_receipt_hash TEXT CHECK(claim_receipt_hash IS NULL OR (${HASH_CHECK('claim_receipt_hash')})),
  prepared_at_ms INTEGER NOT NULL CHECK(prepared_at_ms >= 0),
  terminal_at_ms INTEGER,
  delivered_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > prepared_at_ms),
  job_wire_bytes INTEGER NOT NULL CHECK(
    job_wire_bytes BETWEEN 1 AND ${MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobWireBytes}
  ),
  CHECK(
    (lease_owner_id IS NULL AND lease_token IS NULL AND leased_until_ms IS NULL) OR
    (lease_owner_id IS NOT NULL AND lease_token IS NOT NULL AND
      leased_until_ms IS NOT NULL AND leased_until_ms > prepared_at_ms)
  ),
  CHECK((manifest_wire IS NULL) = (manifest_wire_bytes IS NULL)),
  CHECK(
    manifest_wire_bytes IS NULL OR
    manifest_wire_bytes = length(CAST(manifest_wire AS BLOB))
  ),
  CHECK((terminal_command_hash IS NULL) = (terminal_at_ms IS NULL)),
  CHECK(terminal_at_ms IS NULL OR terminal_at_ms >= prepared_at_ms),
  CHECK(
    (state = 'prepared' AND terminal_command_hash IS NULL AND lease_owner_id IS NULL AND
      manifest_wire IS NULL AND artifact_token IS NULL) OR
    (state = 'writing' AND terminal_command_hash IS NULL AND lease_owner_id IS NOT NULL AND
      leased_until_ms <= expires_at_ms AND manifest_wire IS NULL AND artifact_token IS NULL) OR
    (state = 'deliverable' AND terminal_command_hash IS NOT NULL AND lease_owner_id IS NULL AND
      terminal_at_ms < expires_at_ms AND manifest_wire IS NOT NULL AND artifact_token IS NOT NULL) OR
    (state = 'delivered' AND terminal_command_hash IS NOT NULL AND lease_owner_id IS NULL AND
      terminal_at_ms < expires_at_ms AND manifest_wire IS NOT NULL AND artifact_token IS NOT NULL) OR
    (state = 'failed' AND terminal_command_hash IS NOT NULL AND lease_owner_id IS NULL AND
      manifest_wire IS NOT NULL AND artifact_token IS NULL)
  ),
  CHECK(
    (state = 'delivered' AND claim_command_hash IS NOT NULL AND
      delivery_ref_hash IS NOT NULL AND claim_receipt_hash IS NOT NULL AND
      delivered_at_ms IS NOT NULL AND delivered_at_ms >= terminal_at_ms AND
      delivered_at_ms < expires_at_ms) OR
    (state != 'delivered' AND claim_command_hash IS NULL AND
      delivery_ref_hash IS NULL AND claim_receipt_hash IS NULL AND delivered_at_ms IS NULL)
  ),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lifecycle_deployment_state',
    tableName: 'lifecycle_deployment_state',
    sql: `CREATE TABLE lifecycle_deployment_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  trusted_time_high_water_ms INTEGER NOT NULL CHECK(trusted_time_high_water_ms >= 0),
  export_fencing_counter INTEGER NOT NULL CHECK(export_fencing_counter >= 0),
  export_lease_owner_id TEXT CHECK(
    export_lease_owner_id IS NULL OR length(export_lease_owner_id) BETWEEN 1 AND 128
  ),
  export_lease_token TEXT CHECK(export_lease_token IS NULL OR length(export_lease_token) BETWEEN 1 AND 128),
  export_leased_until_ms INTEGER,
  CHECK(
    (export_lease_owner_id IS NULL AND export_lease_token IS NULL AND export_leased_until_ms IS NULL) OR
    (export_lease_owner_id IS NOT NULL AND export_lease_token IS NOT NULL AND
      export_leased_until_ms IS NOT NULL AND export_leased_until_ms >= 0)
  )
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'table' as const,
    name: 'lifecycle_namespace_usage',
    tableName: 'lifecycle_namespace_usage',
    sql: `CREATE TABLE lifecycle_namespace_usage(
  namespace_ref TEXT PRIMARY KEY CHECK(${NAMESPACE_REF_CHECK}),
  lifecycle_audit_records INTEGER NOT NULL CHECK(lifecycle_audit_records >= 0),
  lifecycle_audit_reserved_records INTEGER NOT NULL CHECK(lifecycle_audit_reserved_records >= 0),
  lifecycle_command_records INTEGER NOT NULL CHECK(lifecycle_command_records >= 0),
  deletion_checkpoint_records INTEGER NOT NULL CHECK(deletion_checkpoint_records >= 0),
  export_job_records INTEGER NOT NULL CHECK(export_job_records >= 0),
  lifecycle_audit_logical_bytes INTEGER NOT NULL CHECK(lifecycle_audit_logical_bytes >= 0),
  lifecycle_audit_reserved_bytes INTEGER NOT NULL CHECK(lifecycle_audit_reserved_bytes >= 0),
  lifecycle_command_logical_bytes INTEGER NOT NULL CHECK(lifecycle_command_logical_bytes >= 0),
  deletion_checkpoint_logical_bytes INTEGER NOT NULL CHECK(deletion_checkpoint_logical_bytes >= 0),
  export_job_logical_bytes INTEGER NOT NULL CHECK(export_job_logical_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  FOREIGN KEY(namespace_ref) REFERENCES namespaces(namespace_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_consent_evidence_proposal_v2',
    tableName: 'consent_evidence',
    sql: `CREATE UNIQUE INDEX memory_consent_evidence_proposal_v2
ON consent_evidence(namespace_ref ASC, namespace_generation ASC, proposal_id ASC, evidence_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_revision_evidence_revision_v2',
    tableName: 'revision_evidence',
    sql: `CREATE UNIQUE INDEX memory_revision_evidence_revision_v2
ON revision_evidence(namespace_ref ASC, namespace_generation ASC, memory_id ASC, revision ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_proposals_decided_v2',
    tableName: 'proposals',
    sql: `CREATE INDEX memory_proposals_decided_v2
ON proposals(namespace_ref ASC, namespace_generation ASC, state ASC, decided_at_ms ASC, proposal_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_lifecycle_audits_expiry_v2',
    tableName: 'lifecycle_audits',
    sql: `CREATE INDEX memory_lifecycle_audits_expiry_v2
ON lifecycle_audits(namespace_ref ASC, namespace_generation ASC, expires_at_ms ASC, audit_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_lifecycle_audits_order_v2',
    tableName: 'lifecycle_audits',
    sql: `CREATE INDEX memory_lifecycle_audits_order_v2
ON lifecycle_audits(namespace_ref ASC, namespace_generation ASC, recorded_at_ms ASC, audit_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_outbox_content_probe_v2',
    tableName: 'outbox',
    sql: `CREATE INDEX memory_outbox_content_probe_v2
ON outbox(namespace_ref ASC, namespace_generation ASC, event_kind ASC, sequence ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_lifecycle_commands_expiry_v2',
    tableName: 'lifecycle_commands',
    sql: `CREATE INDEX memory_lifecycle_commands_expiry_v2
ON lifecycle_commands(namespace_ref ASC, expires_at_ms ASC, command_ref ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_deletion_checkpoints_stage_v2',
    tableName: 'namespace_deletion_checkpoints',
    sql: `CREATE INDEX memory_deletion_checkpoints_stage_v2
ON namespace_deletion_checkpoints(namespace_ref ASC, stage ASC, updated_at_ms ASC, deletion_ref ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_export_jobs_expiry_v2',
    tableName: 'export_jobs',
    sql: `CREATE INDEX memory_export_jobs_expiry_v2
ON export_jobs(state ASC, expires_at_ms ASC, export_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_export_jobs_namespace_v2',
    tableName: 'export_jobs',
    sql: `CREATE INDEX memory_export_jobs_namespace_v2
ON export_jobs(namespace_ref ASC, namespace_generation ASC, prepared_at_ms ASC, export_id ASC)`
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'memory_export_reservations_expiry_v2',
    tableName: 'export_audit_reservations',
    sql: `CREATE INDEX memory_export_reservations_expiry_v2
ON export_audit_reservations(expires_at_ms ASC, export_id ASC)`
  })
])

const SCHEMA_OBJECTS_V2: readonly SqliteSchemaObjectV1[] = Object.freeze([
  ...SCHEMA_OBJECTS_V1.map(object => {
    if (object.name === 'namespaces') {
      return Object.freeze({ ...object, sql: ALTERED_SCHEMA_SQL_V2.namespaces })
    }
    if (object.name === 'usage') {
      return Object.freeze({ ...object, sql: ALTERED_SCHEMA_SQL_V2.usage })
    }
    if (object.name === 'global_usage') {
      return Object.freeze({ ...object, sql: ALTERED_SCHEMA_SQL_V2.globalUsage })
    }
    if (object.name === 'proposals') {
      return Object.freeze({ ...object, sql: PROPOSALS_TABLE_SQL_V2 })
    }
    return object
  }),
  ...NEW_SCHEMA_OBJECTS_V2
])

function sha256 (value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fingerprintRows (rows: readonly SqliteSchemaObjectV1[]): string {
  const canonicalRows = [...rows]
    .sort((left, right) => (
      left.type < right.type
        ? -1
        : left.type > right.type
          ? 1
          : left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : 0
    ))
    .map(row => ({
      type: row.type,
      name: row.name,
      tableName: row.tableName,
      sql: row.sql
    }))
  return createHash('sha256')
    .update(MEMORY_SQLITE_SCHEMA_FINGERPRINT_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(canonicalRows), 'utf8')
    .digest('hex')
}

export const MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1 = fingerprintRows(SCHEMA_OBJECTS_V1)

const INITIAL_DATA_SQL_V1 = `INSERT INTO global_usage(
  singleton,
  namespace_records,
  active_memory_records,
  canonical_logical_bytes,
  pending_outbox_records,
  outbox_logical_bytes,
  updated_at_ms
) VALUES (1, 0, 0, 0, 0, 0, 0)`

const MIGRATION_SQL_V1 = `${[
  ...SCHEMA_OBJECTS_V1.map(value => value.sql),
  INITIAL_DATA_SQL_V1
].map(value => `${value};`).join('\n')}\n`

export const MEMORY_SQLITE_MIGRATION_V1: MemorySqliteMigrationV1 = Object.freeze({
  version: 1,
  sql: MIGRATION_SQL_V1,
  checksum: sha256(MIGRATION_SQL_V1),
  schemaFingerprint: MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1
})

export const MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2 = fingerprintRows(SCHEMA_OBJECTS_V2)

const ALTER_TABLE_SQL_V2 = [
  'ALTER TABLE namespaces ADD COLUMN content_epoch INTEGER NOT NULL DEFAULT 0 CHECK(content_epoch >= 0)',
  ...USAGE_COLUMNS_V2.map(column => `ALTER TABLE usage ADD COLUMN ${column}`),
  ...GLOBAL_USAGE_COLUMNS_V2.map(column => `ALTER TABLE global_usage ADD COLUMN ${column}`)
]

const INITIAL_DATA_SQL_V2 = `INSERT INTO lifecycle_deployment_state(
  singleton,
  trusted_time_high_water_ms,
  export_fencing_counter,
  export_lease_owner_id,
  export_lease_token,
  export_leased_until_ms
) VALUES (1, 0, 0, NULL, NULL, NULL)`

const MIGRATION_SQL_V2 = `${[
  ...ALTER_TABLE_SQL_V2,
  ...PROPOSAL_REBUILD_SQL_V2,
  ...NEW_SCHEMA_OBJECTS_V2.map(value => value.sql),
  INITIAL_DATA_SQL_V2
].map(value => `${value};`).join('\n')}\n`

export const MEMORY_SQLITE_MIGRATION_V2: MemorySqliteMigrationV1 = Object.freeze({
  version: 2,
  sql: MIGRATION_SQL_V2,
  checksum: sha256(MIGRATION_SQL_V2),
  schemaFingerprint: MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2
})

export const MEMORY_SQLITE_MIGRATIONS_V2: readonly MemorySqliteMigrationV1[] =
  Object.freeze([MEMORY_SQLITE_MIGRATION_V1, MEMORY_SQLITE_MIGRATION_V2])

function schemaRowsFromDatabase (database: DatabaseSync): readonly SqliteSchemaObjectV1[] {
  const rows = database.prepare(`
    WITH bounded_schema AS (
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY type ASC, name ASC
      LIMIT ${MAXIMUM_SCHEMA_OBJECTS + 1}
    ), measured_schema AS (
      SELECT
        type,
        name,
        tbl_name,
        sql,
        length(CAST(sql AS BLOB)) AS sql_bytes,
        count(*) OVER () AS object_count,
        sum(length(CAST(sql AS BLOB))) OVER () AS total_sql_bytes
      FROM bounded_schema
    )
    SELECT
      type,
      name,
      tbl_name,
      sql_bytes,
      object_count,
      total_sql_bytes,
      CASE
        WHEN object_count <= ${MAXIMUM_SCHEMA_OBJECTS}
          AND sql_bytes <= ${MAXIMUM_SCHEMA_OBJECT_SQL_BYTES}
          AND total_sql_bytes <= ${MAXIMUM_SCHEMA_SQL_BYTES}
        THEN sql
        ELSE NULL
      END AS sql
    FROM measured_schema
    ORDER BY type ASC, name ASC
  `).all()
  if (rows.length > MAXIMUM_SCHEMA_OBJECTS) return invalidMemoryValue()
  let totalSqlBytes = 0
  return rows.map(row => {
    if (typeof row.type !== 'string' || typeof row.name !== 'string' ||
      typeof row.tbl_name !== 'string' ||
      typeof row.sql !== 'string' || typeof row.sql_bytes !== 'number' ||
      !Number.isSafeInteger(row.sql_bytes) || row.sql_bytes < 0 ||
      row.object_count !== rows.length || typeof row.total_sql_bytes !== 'number' ||
      !Number.isSafeInteger(row.total_sql_bytes) || row.total_sql_bytes < 0) {
      return invalidMemoryValue()
    }
    const sqlBytes = Buffer.byteLength(row.sql, 'utf8')
    totalSqlBytes += sqlBytes
    if (sqlBytes !== row.sql_bytes || sqlBytes > MAXIMUM_SCHEMA_OBJECT_SQL_BYTES ||
      totalSqlBytes > MAXIMUM_SCHEMA_SQL_BYTES ||
      row.total_sql_bytes > MAXIMUM_SCHEMA_SQL_BYTES) return invalidMemoryValue()
    return Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql
    })
  })
}

export function sqliteMemorySchemaFingerprintV1 (database: DatabaseSync): string {
  return fingerprintRows(schemaRowsFromDatabase(database))
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function exactObject (
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidMemoryValue()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => (
    typeof key !== 'string' || !keys.includes(key)
  ))) return invalidMemoryValue()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return invalidMemoryValue()
    result[key] = descriptor.value
  }
  return result
}

function parseMigration (value: unknown, expectedVersion: number): MemorySqliteMigrationV1 {
  const input = exactObject(value, ['version', 'sql', 'checksum', 'schemaFingerprint'])
  if (input.version !== expectedVersion || typeof input.sql !== 'string' ||
    input.sql.startsWith('\uFEFF') || input.sql.includes('\r') || !input.sql.endsWith('\n') ||
    typeof input.checksum !== 'string' || !HASH_PATTERN.test(input.checksum) ||
    sha256(input.sql) !== input.checksum ||
    typeof input.schemaFingerprint !== 'string' ||
    !HASH_PATTERN.test(input.schemaFingerprint)) return invalidMemoryValue()
  return Object.freeze({
    version: expectedVersion,
    sql: input.sql,
    checksum: input.checksum,
    schemaFingerprint: input.schemaFingerprint
  })
}

function parseMigrationSequence (
  value: unknown
): readonly MemorySqliteMigrationV1[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > 32) {
    return invalidMemoryValue()
  }
  return Object.freeze(value.map((migration, index) => parseMigration(migration, index + 1)))
}

function pragmaNumber (database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalidMemoryValue()
  return value
}

function validateAppliedMigrations (
  database: DatabaseSync,
  currentVersion: number,
  migrations: readonly MemorySqliteMigrationV1[]
): void {
  const rows = database.prepare(`
    SELECT version, checksum, schema_fingerprint, applied_at
    FROM schema_migrations
    ORDER BY version ASC
    LIMIT 33
  `).all()
  if (rows.length !== currentVersion) return invalidMemoryValue()
  rows.forEach((row, index) => {
    const migration = migrations[index]
    if (migration === undefined || row.version !== migration.version ||
      row.checksum !== migration.checksum ||
      row.schema_fingerprint !== migration.schemaFingerprint) {
      return invalidMemoryValue()
    }
    canonicalInstant(row.applied_at)
  })
}

function parseMigrationManifestsV2 (
  value: unknown
): readonly MemoryV1ToV2AggregateManifestV1[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAXIMUM_V1_TO_V2_MANIFESTS) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  try {
    const manifests = value.map(item => parseMemoryV1ToV2AggregateManifestV1(item))
    const ids = new Set(manifests.map(manifest => manifest.manifestId))
    const aggregates = new Set(manifests.map(manifest => (
      `${manifest.namespaceRef}\0${manifest.namespaceGeneration}\0` +
      `${manifest.aggregate.kind}\0${manifest.aggregate.aggregateId}`
    )))
    if (ids.size !== manifests.length || aggregates.size !== manifests.length) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    return Object.freeze(manifests)
  } catch (error) {
    if (error instanceof MemorySqliteMigrationErrorV2) throw error
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
}

function exactNonnegativeIntegerV2 (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  return value
}

function exactPositiveIntegerV2 (value: unknown): number {
  const parsed = exactNonnegativeIntegerV2(value)
  if (parsed === 0) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  return parsed
}

function exactStringV2 (value: unknown): string {
  if (typeof value !== 'string') {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  return value
}

function manifestAggregateKeyV2 (
  namespaceRef: string,
  generation: number,
  kind: 'proposal' | 'memory',
  aggregateId: string
): string {
  return `${namespaceRef}\0${generation}\0${kind}\0${aggregateId}`
}

function validateV1MigrationCapacityV2 (
  database: DatabaseSync,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): void {
  const manifestBytesByNamespace = new Map<string, number>()
  let deploymentManifestBytes = 0
  for (const manifest of manifests) {
    const wireBytes = Buffer.byteLength(
      encodeMemoryV1ToV2AggregateManifestV1(manifest),
      'utf8'
    )
    manifestBytesByNamespace.set(
      manifest.namespaceRef,
      (manifestBytesByNamespace.get(manifest.namespaceRef) ?? 0) + wireBytes
    )
    deploymentManifestBytes += wireBytes
  }

  const usageRows = database.prepare(`
    SELECT namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes
    FROM usage
    ORDER BY namespace_ref ASC, namespace_generation ASC
    LIMIT ${MEMORY_RESOURCE_LIMITS.deploymentNamespaces + MAXIMUM_V1_TO_V2_MANIFESTS + 1}
  `).all()
  if (usageRows.length >
    MEMORY_RESOURCE_LIMITS.deploymentNamespaces + MAXIMUM_V1_TO_V2_MANIFESTS) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }
  const canonicalByNamespace = new Map<string, number>()
  let pendingProposalRecords = 0
  let activeMemoryRecords = 0
  let retainedRevisionRecords = 0
  let tombstoneRecords = 0
  let canonicalLogicalBytes = 0
  let pendingOutboxRecords = 0
  let outboxLogicalBytes = 0
  for (const row of usageRows) {
    const namespaceRef = exactStringV2(row.namespace_ref)
    exactPositiveIntegerV2(row.namespace_generation)
    const pending = exactNonnegativeIntegerV2(row.pending_proposal_records)
    const active = exactNonnegativeIntegerV2(row.active_memory_records)
    const retained = exactNonnegativeIntegerV2(row.retained_revision_records)
    const tombstones = exactNonnegativeIntegerV2(row.tombstone_records)
    const canonical = exactNonnegativeIntegerV2(row.canonical_logical_bytes)
    const outboxRecords = exactNonnegativeIntegerV2(row.pending_outbox_records)
    const outboxBytes = exactNonnegativeIntegerV2(row.outbox_logical_bytes)
    if (pending > V2_PENDING_PROPOSAL_SOFT_RECORDS ||
      active > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
      retained > active * MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions ||
      tombstones > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
      outboxRecords > V2_OUTBOX_SOFT_RECORDS || outboxBytes > V2_OUTBOX_SOFT_BYTES) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
    }
    canonicalByNamespace.set(
      namespaceRef,
      (canonicalByNamespace.get(namespaceRef) ?? 0) + canonical
    )
    pendingProposalRecords += pending
    activeMemoryRecords += active
    retainedRevisionRecords += retained
    tombstoneRecords += tombstones
    canonicalLogicalBytes += canonical
    pendingOutboxRecords += outboxRecords
    outboxLogicalBytes += outboxBytes
    if (![pendingProposalRecords, activeMemoryRecords, retainedRevisionRecords, tombstoneRecords,
      canonicalLogicalBytes, pendingOutboxRecords, outboxLogicalBytes]
      .every(Number.isSafeInteger)) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
  }
  for (const [namespaceRef, bytes] of canonicalByNamespace) {
    if (bytes + (manifestBytesByNamespace.get(namespaceRef) ?? 0) >
      V2_NAMESPACE_CANONICAL_SOFT_BYTES) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
    }
  }
  const global = database.prepare(`
    SELECT namespace_records, active_memory_records, canonical_logical_bytes,
      pending_outbox_records, outbox_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get()
  const namespaceCount = database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count
  if (global === undefined || exactNonnegativeIntegerV2(namespaceCount) !==
      exactNonnegativeIntegerV2(global.namespace_records) ||
    exactNonnegativeIntegerV2(global.active_memory_records) !== activeMemoryRecords ||
    exactNonnegativeIntegerV2(global.canonical_logical_bytes) !== canonicalLogicalBytes ||
    exactNonnegativeIntegerV2(global.pending_outbox_records) !== pendingOutboxRecords ||
    exactNonnegativeIntegerV2(global.outbox_logical_bytes) !== outboxLogicalBytes) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  if (activeMemoryRecords > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords ||
    canonicalLogicalBytes + deploymentManifestBytes >
      V2_DEPLOYMENT_CANONICAL_SOFT_BYTES ||
    pendingOutboxRecords > V2_OUTBOX_SOFT_RECORDS ||
    outboxLogicalBytes > V2_OUTBOX_SOFT_BYTES) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }

  const actual = database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads) AS active_memory_records,
      (SELECT count(*) FROM revisions) AS retained_revision_records,
      (SELECT count(*) FROM tombstones) AS tombstone_records,
      (SELECT coalesce(sum(namespace_wire_bytes), 0) FROM namespaces) +
        (SELECT coalesce(sum(proposal_wire_bytes), 0) FROM proposals) +
        (SELECT coalesce(sum(revision_wire_bytes), 0) FROM revisions) +
        (SELECT coalesce(sum(tombstone_wire_bytes), 0) FROM tombstones)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox) AS pending_outbox_records,
      (SELECT coalesce(sum(logical_bytes), 0) FROM outbox) AS outbox_logical_bytes
  `).get()
  if (actual === undefined ||
    exactNonnegativeIntegerV2(actual.pending_proposal_records) !== pendingProposalRecords ||
    exactNonnegativeIntegerV2(actual.active_memory_records) !== activeMemoryRecords ||
    exactNonnegativeIntegerV2(actual.retained_revision_records) !== retainedRevisionRecords ||
    exactNonnegativeIntegerV2(actual.tombstone_records) !== tombstoneRecords ||
    exactNonnegativeIntegerV2(actual.canonical_logical_bytes) !== canonicalLogicalBytes ||
    exactNonnegativeIntegerV2(actual.pending_outbox_records) !== pendingOutboxRecords ||
    exactNonnegativeIntegerV2(actual.outbox_logical_bytes) !== outboxLogicalBytes) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  const scopedUsageDrift = database.prepare(`
    SELECT 1
    FROM usage u
    WHERE u.pending_proposal_records != (
        SELECT count(*) FROM proposals p
        WHERE p.namespace_ref = u.namespace_ref
          AND p.namespace_generation = u.namespace_generation
          AND p.state = 'pending'
      )
      OR u.active_memory_records != (
        SELECT count(*) FROM heads h
        WHERE h.namespace_ref = u.namespace_ref
          AND h.namespace_generation = u.namespace_generation
      )
      OR u.retained_revision_records != (
        SELECT count(*) FROM revisions r
        WHERE r.namespace_ref = u.namespace_ref
          AND r.namespace_generation = u.namespace_generation
      )
      OR u.tombstone_records != (
        SELECT count(*) FROM tombstones t
        WHERE t.namespace_ref = u.namespace_ref
          AND t.namespace_generation = u.namespace_generation
      )
      OR u.canonical_logical_bytes != (
        coalesce((
          SELECT namespace_wire_bytes FROM namespaces n
          WHERE n.namespace_ref = u.namespace_ref
            AND n.namespace_generation = u.namespace_generation
        ), 0) +
        coalesce((
          SELECT sum(proposal_wire_bytes) FROM proposals p
          WHERE p.namespace_ref = u.namespace_ref
            AND p.namespace_generation = u.namespace_generation
        ), 0) +
        coalesce((
          SELECT sum(revision_wire_bytes) FROM revisions r
          WHERE r.namespace_ref = u.namespace_ref
            AND r.namespace_generation = u.namespace_generation
        ), 0) +
        coalesce((
          SELECT sum(tombstone_wire_bytes) FROM tombstones t
          WHERE t.namespace_ref = u.namespace_ref
            AND t.namespace_generation = u.namespace_generation
        ), 0)
      )
      OR u.pending_outbox_records != (
        SELECT count(*) FROM outbox o
        WHERE o.namespace_ref = u.namespace_ref
          AND o.namespace_generation = u.namespace_generation
      )
      OR u.outbox_logical_bytes != coalesce((
        SELECT sum(logical_bytes) FROM outbox o
        WHERE o.namespace_ref = u.namespace_ref
          AND o.namespace_generation = u.namespace_generation
      ), 0)
    LIMIT 1
  `).get()
  if (scopedUsageDrift !== undefined) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
}

function validateV1AggregateCoverageV2 (database: DatabaseSync): void {
  const foreignKeyViolation = database.prepare(`
    SELECT "table", rowid, parent, fkid
    FROM pragma_foreign_key_check
    LIMIT 1
  `).get()
  if (foreignKeyViolation !== undefined) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }

  const uncoveredRevision = database.prepare(`
    SELECT 1
    FROM revisions r
    WHERE NOT EXISTS (
      SELECT 1 FROM revision_payloads p
      WHERE p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id
        AND p.revision = r.revision
    ) OR NOT EXISTS (
      SELECT 1 FROM heads h
      WHERE h.namespace_ref = r.namespace_ref
        AND h.namespace_generation = r.namespace_generation
        AND h.memory_id = r.memory_id
    )
    LIMIT 1
  `).get()
  if (uncoveredRevision !== undefined) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }

  const uncoveredHead = database.prepare(`
    SELECT 1
    FROM heads h
    WHERE (
      SELECT count(*) FROM proposals p
      WHERE p.namespace_ref = h.namespace_ref
        AND p.namespace_generation = h.namespace_generation
        AND p.state = 'approved'
        AND p.resulting_memory_id = h.memory_id
    ) != 1
    LIMIT 1
  `).get()
  if (uncoveredHead !== undefined) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
}

function validateV1AncillaryCanonicalRowsV2 (database: DatabaseSync): void {
  const tombstoneRows = database.prepare(`
    SELECT namespace_ref, namespace_generation, tombstone_id, memory_id,
      deleted_revision, deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash,
      tombstone_wire, tombstone_wire_bytes
    FROM tombstones
    ORDER BY namespace_ref ASC, namespace_generation ASC, tombstone_id ASC
    LIMIT ${MEMORY_RESOURCE_LIMITS.deploymentActiveRecords +
      MEMORY_RESOURCE_LIMITS.deploymentNamespaces + 1}
  `).all()
  if (tombstoneRows.length > MEMORY_RESOURCE_LIMITS.deploymentActiveRecords +
    MEMORY_RESOURCE_LIMITS.deploymentNamespaces) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }
  for (const row of tombstoneRows) {
    try {
      const wire = exactStringV2(row.tombstone_wire)
      if (Buffer.byteLength(wire, 'utf8') !==
        exactPositiveIntegerV2(row.tombstone_wire_bytes)) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      const tombstone = decodeMemoryTombstoneV1(wire)
      if (tombstone.namespaceRef !== exactStringV2(row.namespace_ref) ||
        tombstone.namespaceGeneration !== exactPositiveIntegerV2(row.namespace_generation) ||
        tombstone.tombstoneId !== exactStringV2(row.tombstone_id) ||
        tombstone.memoryId !== row.memory_id ||
        tombstone.deletedRevision !== row.deleted_revision ||
        tombstone.deletionKind !== row.deletion_kind ||
        Date.parse(tombstone.deletedAt) !== exactNonnegativeIntegerV2(row.deleted_at_ms) ||
        Date.parse(tombstone.expiresAt) !== exactNonnegativeIntegerV2(row.expires_at_ms) ||
        tombstone.receiptHash !== exactStringV2(row.receipt_hash)) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
    } catch (error) {
      if (error instanceof MemorySqliteMigrationErrorV2) throw error
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
  }

  const outboxRows = database.prepare(`
    SELECT sequence, event_id, namespace_ref, namespace_generation, aggregate,
      aggregate_id, revision, event_kind, occurred_at_ms, event_wire, logical_bytes
    FROM outbox
    ORDER BY sequence ASC
    LIMIT ${V2_OUTBOX_SOFT_RECORDS + 1}
  `).all()
  if (outboxRows.length > V2_OUTBOX_SOFT_RECORDS) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }
  for (const row of outboxRows) {
    try {
      const wire = exactStringV2(row.event_wire)
      if (Buffer.byteLength(wire, 'utf8') !== exactPositiveIntegerV2(row.logical_bytes)) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      const event = decodeMemoryOutboxEventV1(wire)
      if (event.sequence !== exactPositiveIntegerV2(row.sequence) ||
        event.eventId !== exactStringV2(row.event_id) ||
        event.namespaceRef !== exactStringV2(row.namespace_ref) ||
        event.namespaceGeneration !== exactPositiveIntegerV2(row.namespace_generation) ||
        event.aggregate !== row.aggregate || event.aggregateId !== row.aggregate_id ||
        event.revision !== exactPositiveIntegerV2(row.revision) ||
        event.eventKind !== row.event_kind ||
        Date.parse(event.occurredAt) !== exactNonnegativeIntegerV2(row.occurred_at_ms)) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
    } catch (error) {
      if (error instanceof MemorySqliteMigrationErrorV2) throw error
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
  }
}

function validateV1MigrationManifestsV2 (
  database: DatabaseSync,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[]
): void {
  const namespaceRows = database.prepare(`
    SELECT namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation
    FROM namespaces
    ORDER BY namespace_ref ASC
    LIMIT ${MEMORY_RESOURCE_LIMITS.deploymentNamespaces + 1}
  `).all()
  if (namespaceRows.length > MEMORY_RESOURCE_LIMITS.deploymentNamespaces) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }
  try {
    for (const row of namespaceRows) {
      const namespaceRef = exactStringV2(row.namespace_ref)
      const wire = exactStringV2(row.namespace_wire)
      if (Buffer.byteLength(wire, 'utf8') !== exactPositiveIntegerV2(row.namespace_wire_bytes) ||
        exactPositiveIntegerV2(row.namespace_generation) < 1) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      const parsed = parseMemoryNamespaceV1(JSON.parse(wire) as unknown)
      if (JSON.stringify(parsed) !== wire || memoryNamespaceRefV1(parsed) !== namespaceRef) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
    }
  } catch (error) {
    if (error instanceof MemorySqliteMigrationErrorV2) throw error
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  const proposalRows = database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals
    ORDER BY namespace_ref ASC, namespace_generation ASC, proposal_id ASC
    LIMIT ${MAXIMUM_V1_TO_V2_MANIFESTS + 1}
  `).all()
  if (proposalRows.length > MAXIMUM_V1_TO_V2_MANIFESTS) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_capacity')
  }
  validateV1AggregateCoverageV2(database)
  validateV1AncillaryCanonicalRowsV2(database)
  if (proposalRows.length === 0) {
    if (manifests.length !== 0) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    validateV1MigrationCapacityV2(database, manifests)
    return
  }
  if (manifests.length === 0) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_required')
  }

  const manifestsByAggregate = new Map(manifests.map(manifest => [
    manifestAggregateKeyV2(
      manifest.namespaceRef,
      manifest.namespaceGeneration,
      manifest.aggregate.kind,
      manifest.aggregate.aggregateId
    ),
    manifest
  ] as const))
  const consumed = new Set<string>()
  for (const row of proposalRows) {
    const namespaceRef = exactStringV2(row.namespace_ref)
    const generation = exactPositiveIntegerV2(row.namespace_generation)
    const proposalId = exactStringV2(row.proposal_id)
    const proposalRevision = exactPositiveIntegerV2(row.revision)
    const state = exactStringV2(row.state)
    const proposedAtMs = exactNonnegativeIntegerV2(row.proposed_at_ms)
    const decidedAtMs = row.decided_at_ms === null
      ? null
      : exactNonnegativeIntegerV2(row.decided_at_ms)
    const resultingMemoryId = row.resulting_memory_id === null
      ? null
      : exactStringV2(row.resulting_memory_id)
    const kind = resultingMemoryId === null ? 'proposal' as const : 'memory' as const
    const aggregateId = resultingMemoryId ?? proposalId
    const key = manifestAggregateKeyV2(namespaceRef, generation, kind, aggregateId)
    const manifest = manifestsByAggregate.get(key)
    if (manifest === undefined || manifest.aggregate.proposalState !== state ||
      manifest.aggregate.proposalRevision !== proposalRevision) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    const proposalWire = exactStringV2(row.proposal_wire)
    if (Buffer.byteLength(proposalWire, 'utf8') !==
      exactPositiveIntegerV2(row.proposal_wire_bytes)) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    try {
      const proposal = decodeMemoryProposalV1(proposalWire)
      if (proposal.namespaceRef !== namespaceRef || proposal.proposalId !== proposalId ||
        proposal.revision !== proposalRevision || proposal.state !== state ||
        Date.parse(proposal.proposedAt) !== proposedAtMs ||
        (proposal.decision === null ? null : Date.parse(proposal.decision.decidedAt)) !==
          decidedAtMs) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
    } catch (error) {
      if (error instanceof MemorySqliteMigrationErrorV2) throw error
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    const proposalWireHash = sha256(proposalWire)
    if (manifest.aggregate.legacyProposalWireHashes.at(-1) !== proposalWireHash) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    if (kind === 'memory') {
      if (manifest.aggregate.kind !== 'memory') {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      const head = database.prepare(`
        SELECT current_revision, current_revision_hash, content_hash,
          updated_at_ms, valid_until_ms, purge_at_ms
        FROM heads
        WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
      `).get(namespaceRef, generation, aggregateId)
      if (head === undefined ||
        exactPositiveIntegerV2(head.current_revision) !== manifest.aggregate.currentRevision) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      const revisions = database.prepare(`
        SELECT r.revision, r.operation, r.revision_hash, r.previous_revision_hash,
          r.changed_at_ms, r.revision_wire_bytes, p.revision_wire
        FROM revisions r
        JOIN revision_payloads p
          ON p.namespace_ref = r.namespace_ref
          AND p.namespace_generation = r.namespace_generation
          AND p.memory_id = r.memory_id
          AND p.revision = r.revision
        WHERE r.namespace_ref = ? AND r.namespace_generation = ? AND r.memory_id = ?
        ORDER BY r.revision ASC
        LIMIT 33
      `).all(namespaceRef, generation, aggregateId)
      if (revisions.length !== manifest.aggregate.currentRevision || revisions.length > 32) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
      let currentRevision: ReturnType<typeof decodeMemoryRevisionV1> | undefined
      for (const [index, revision] of revisions.entries()) {
        const wire = exactStringV2(revision.revision_wire)
        if (exactPositiveIntegerV2(revision.revision) !== index + 1 ||
          manifest.aggregate.legacyRevisionWires[index]?.legacyWireHash !== sha256(wire) ||
          exactPositiveIntegerV2(revision.revision_wire_bytes) !==
            Buffer.byteLength(wire, 'utf8')) {
          throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
        }
        try {
          const decoded = decodeMemoryRevisionV1(wire)
          if (decoded.memoryId !== aggregateId || decoded.revision !== index + 1 ||
            decoded.operation !== revision.operation ||
            decoded.revisionHash !== revision.revision_hash ||
            decoded.previousRevisionHash !== revision.previous_revision_hash ||
            Date.parse(decoded.changedAt) !== exactNonnegativeIntegerV2(revision.changed_at_ms) ||
            decoded.record.namespaceRef !== namespaceRef ||
            decoded.record.namespaceGeneration !== generation) {
            throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
          }
          currentRevision = decoded
        } catch (error) {
          if (error instanceof MemorySqliteMigrationErrorV2) throw error
          throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
        }
      }
      const initialRevision = revisions[0]
      if (initialRevision === undefined || currentRevision === undefined ||
        exactPositiveIntegerV2(row.resulting_revision) !== 1 ||
        exactStringV2(row.resulting_revision_hash) !== initialRevision.revision_hash ||
        exactStringV2(head.current_revision_hash) !== currentRevision.revisionHash ||
        exactStringV2(head.content_hash) !== currentRevision.record.contentHash ||
        exactNonnegativeIntegerV2(head.updated_at_ms) !==
          Date.parse(currentRevision.record.updatedAt) ||
        exactNonnegativeIntegerV2(head.valid_until_ms) !==
          Date.parse(currentRevision.record.retention.validUntil) ||
        exactNonnegativeIntegerV2(head.purge_at_ms) !==
          Date.parse(currentRevision.record.retention.purgeAt)) {
        throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
      }
    }
    consumed.add(key)
  }
  if (consumed.size !== manifests.length ||
    [...manifestsByAggregate.keys()].some(key => !consumed.has(key))) {
    throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
  }
  validateV1MigrationCapacityV2(database, manifests)
}

function persistV1MigrationManifestsV2 (
  database: DatabaseSync,
  manifests: readonly MemoryV1ToV2AggregateManifestV1[],
  appliedAtMs: number
): void {
  const insert = database.prepare(`
    INSERT INTO memory_v1_to_v2_manifests(
      namespace_ref, namespace_generation, manifest_id, aggregate_kind, aggregate_id,
      manifest_hash, manifest_wire, manifest_wire_bytes, applied_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const bytesByUsage = new Map<string, {
    readonly namespaceRef: string
    readonly generation: number
    bytes: number
  }>()
  let totalBytes = 0
  for (const manifest of manifests) {
    const wire = encodeMemoryV1ToV2AggregateManifestV1(manifest)
    const wireBytes = Buffer.byteLength(wire, 'utf8')
    const inserted = insert.run(
      manifest.namespaceRef,
      manifest.namespaceGeneration,
      manifest.manifestId,
      manifest.aggregate.kind,
      manifest.aggregate.aggregateId,
      manifest.manifestHash,
      wire,
      wireBytes,
      appliedAtMs
    )
    if (inserted.changes !== 1) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    const usageKey = `${manifest.namespaceRef}\0${manifest.namespaceGeneration}`
    const usage = bytesByUsage.get(usageKey) ?? {
      namespaceRef: manifest.namespaceRef,
      generation: manifest.namespaceGeneration,
      bytes: 0
    }
    usage.bytes += wireBytes
    bytesByUsage.set(usageKey, usage)
    totalBytes += wireBytes
  }
  for (const usage of bytesByUsage.values()) {
    const updated = database.prepare(`
      UPDATE usage
      SET canonical_logical_bytes = canonical_logical_bytes + ?,
        updated_at_ms = max(updated_at_ms, ?)
      WHERE namespace_ref = ? AND namespace_generation = ?
    `).run(usage.bytes, appliedAtMs, usage.namespaceRef, usage.generation)
    if (updated.changes !== 1) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
  }
  if (totalBytes > 0) {
    const updated = database.prepare(`
      UPDATE global_usage
      SET canonical_logical_bytes = canonical_logical_bytes + ?,
        updated_at_ms = max(updated_at_ms, ?)
      WHERE singleton = 1
    `).run(totalBytes, appliedAtMs)
    if (updated.changes !== 1) return invalidMemoryValue()
  }
}

function initializeLifecycleNamespaceUsageV2 (
  database: DatabaseSync,
  appliedAtMs: number
): void {
  database.prepare(`
    INSERT INTO lifecycle_namespace_usage(
      namespace_ref, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes, updated_at_ms
    )
    SELECT namespace_ref, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?
    FROM namespaces
    ORDER BY namespace_ref ASC
  `).run(appliedAtMs)
}

function backfillGlobalAggregateUsageV2 (database: DatabaseSync): void {
  const updated = database.prepare(`
    UPDATE global_usage
    SET pending_proposal_records = coalesce((
          SELECT sum(pending_proposal_records) FROM usage
        ), 0),
      retained_revision_records = coalesce((
          SELECT sum(retained_revision_records) FROM usage
        ), 0),
      tombstone_records = coalesce((
          SELECT sum(tombstone_records) FROM usage
        ), 0)
    WHERE singleton = 1
  `).run()
  if (updated.changes !== 1) return invalidMemoryValue()
}

function legacyTrustedTimeHighWaterV2 (database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT max(value) AS high_water FROM (
      SELECT max(max(created_at_ms, updated_at_ms)) AS value FROM namespaces
      UNION ALL
      SELECT max(max(proposed_at_ms, coalesce(decided_at_ms, proposed_at_ms))) FROM proposals
      UNION ALL
      SELECT max(changed_at_ms) FROM revisions
      UNION ALL
      SELECT max(updated_at_ms) FROM heads
      UNION ALL
      SELECT max(deleted_at_ms) FROM tombstones
      UNION ALL
      SELECT max(occurred_at_ms) FROM outbox
      UNION ALL
      SELECT max(updated_at_ms) FROM usage
      UNION ALL
      SELECT max(updated_at_ms) FROM global_usage
    )
  `).get()
  const value = row?.high_water
  let highWater = value === null || value === undefined
    ? 0
    : exactNonnegativeIntegerV2(value)
  const migrationRows = database.prepare(`
    SELECT applied_at FROM schema_migrations ORDER BY version ASC LIMIT 2
  `).all()
  for (const migration of migrationRows) {
    highWater = Math.max(highWater, Date.parse(canonicalInstant(migration.applied_at)))
  }
  return highWater
}

interface MigrationSequenceHooksV2 {
  readonly beforeApply?: (currentVersion: number, migration: MemorySqliteMigrationV1) => void
  readonly afterApply?: (currentVersion: number, migration: MemorySqliteMigrationV1) => void
  readonly onCurrent?: (currentVersion: number) => void
}

function runParsedMigrationSequenceV1 (
  database: DatabaseSync,
  migrations: readonly MemorySqliteMigrationV1[],
  appliedAt: string,
  hooks: MigrationSequenceHooksV2 = {}
): void {
  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const applicationId = pragmaNumber(database, 'application_id')
    const currentVersion = pragmaNumber(database, 'user_version')
    if (currentVersion < 0 || currentVersion > migrations.length ||
      (currentVersion === 0 && applicationId !== 0) ||
      (currentVersion > 0 && applicationId !== MEMORY_SQLITE_APPLICATION_ID_V1)) {
      return invalidMemoryValue()
    }
    if (currentVersion > 0) {
      validateAppliedMigrations(database, currentVersion, migrations)
      const currentMigration = migrations[currentVersion - 1]
      if (currentMigration === undefined ||
        sqliteMemorySchemaFingerprintV1(database) !== currentMigration.schemaFingerprint) {
        return invalidMemoryValue()
      }
    }
    hooks.onCurrent?.(currentVersion)
    for (const migration of migrations.slice(currentVersion)) {
      hooks.beforeApply?.(currentVersion, migration)
      database.exec(migration.sql)
      if (sqliteMemorySchemaFingerprintV1(database) !== migration.schemaFingerprint) {
        return invalidMemoryValue()
      }
      hooks.afterApply?.(currentVersion, migration)
      const insert = database.prepare(`
        INSERT INTO schema_migrations(version, checksum, schema_fingerprint, applied_at)
        VALUES (?, ?, ?, ?)
      `)
      insert.setAllowBareNamedParameters(false)
      insert.run(
        migration.version,
        migration.checksum,
        migration.schemaFingerprint,
        appliedAt
      )
      database.exec(`
        PRAGMA application_id = ${MEMORY_SQLITE_APPLICATION_ID_V1};
        PRAGMA user_version = ${migration.version};
      `)
    }
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The original fixed migration failure remains authoritative.
      }
    }
    throw error
  }
}

export function runSqliteMemoryMigrationSequenceV1 (
  database: DatabaseSync,
  optionsValue: RunSqliteMemoryMigrationSequenceOptionsV1
): void {
  const options = exactObject(optionsValue, ['migrations', 'appliedAt'])
  const migrations = parseMigrationSequence(options.migrations)
  const appliedAt = canonicalInstant(options.appliedAt)
  runParsedMigrationSequenceV1(database, migrations, appliedAt)
}

export function assertSqliteMemoryMigrationV2Ready (
  database: DatabaseSync,
  manifestsValue: unknown
): readonly MemoryV1ToV2AggregateManifestV1[] {
  const manifests = parseMigrationManifestsV2(manifestsValue)
  const version = pragmaNumber(database, 'user_version')
  if (version === MEMORY_SQLITE_SCHEMA_VERSION_V1) {
    validateAppliedMigrations(database, 1, MEMORY_SQLITE_MIGRATIONS_V2)
    if (sqliteMemorySchemaFingerprintV1(database) !== MEMORY_SQLITE_SCHEMA_FINGERPRINT_V1) {
      return invalidMemoryValue()
    }
    validateV1MigrationManifestsV2(database, manifests)
    return manifests
  }
  if (version === MEMORY_SQLITE_SCHEMA_VERSION_V2) {
    if (manifests.length !== 0) {
      throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
    }
    return manifests
  }
  return invalidMemoryValue()
}

export function runSqliteMemoryMigrationV2 (
  database: DatabaseSync,
  optionsValue: RunSqliteMemoryMigrationV2OptionsV1
): void {
  const options = exactObject(optionsValue, ['appliedAt', 'manifests'])
  const appliedAt = canonicalInstant(options.appliedAt)
  const appliedAtMs = Date.parse(appliedAt)
  const manifests = parseMigrationManifestsV2(options.manifests)
  let trustedTimeHighWaterMs = appliedAtMs
  runParsedMigrationSequenceV1(
    database,
    MEMORY_SQLITE_MIGRATIONS_V2,
    appliedAt,
    {
      onCurrent: currentVersion => {
        if (currentVersion === 0 && manifests.length !== 0) {
          throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
        }
        if (currentVersion === MEMORY_SQLITE_SCHEMA_VERSION_V1) {
          validateV1MigrationManifestsV2(database, manifests)
          trustedTimeHighWaterMs = Math.max(
            trustedTimeHighWaterMs,
            legacyTrustedTimeHighWaterV2(database)
          )
        } else if (currentVersion === MEMORY_SQLITE_SCHEMA_VERSION_V2 &&
          manifests.length !== 0) {
          throw new MemorySqliteMigrationErrorV2('memory_migration_manifest_invalid')
        }
      },
      afterApply: (_currentVersion, migration) => {
        if (migration.version !== MEMORY_SQLITE_SCHEMA_VERSION_V2) return
        backfillGlobalAggregateUsageV2(database)
        persistV1MigrationManifestsV2(database, manifests, appliedAtMs)
        initializeLifecycleNamespaceUsageV2(database, appliedAtMs)
        const updated = database.prepare(`
          UPDATE lifecycle_deployment_state
          SET trusted_time_high_water_ms = ?
          WHERE singleton = 1 AND trusted_time_high_water_ms = 0
        `).run(trustedTimeHighWaterMs)
        if (updated.changes !== 1) return invalidMemoryValue()
      }
    }
  )
}
