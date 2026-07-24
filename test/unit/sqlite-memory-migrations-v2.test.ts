import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import {
  encodeMemoryProposalV1,
  encodeMemoryRevisionV1
} from '../../src/agent/memory/memory-codec.js'
import { createMemoryV1ToV2AggregateManifestV1 } from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  memoryNamespaceRefV1,
  memoryNamespaceWireV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  openSqliteMemoryDatabaseV1,
  openSqliteMemoryDatabaseV2,
  SqliteMemoryDatabaseErrorV1
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  MEMORY_SQLITE_MIGRATION_V1,
  MEMORY_SQLITE_MIGRATION_V2,
  MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2,
  MEMORY_SQLITE_SCHEMA_VERSION_V2,
  runSqliteMemoryMigrationV2,
  sqliteMemorySchemaFingerprintV1
} from '../../src/agent/memory/sqlite-memory-migrations.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const V1_TIME = '2026-07-23T00:00:00.000Z'
const V2_TIME = '2026-07-23T00:01:00.000Z'
const LEGACY_HIGH_WATER = '2028-07-23T00:01:00.000Z'

const V2_TABLES = Object.freeze([
  'consent_evidence',
  'export_audit_reservations',
  'export_jobs',
  'global_usage',
  'heads',
  'lifecycle_audits',
  'lifecycle_commands',
  'lifecycle_deployment_state',
  'lifecycle_namespace_usage',
  'memory_v1_to_v2_manifests',
  'namespace_deletion_checkpoints',
  'namespaces',
  'outbox',
  'proposals',
  'revision_evidence',
  'revision_payloads',
  'revisions',
  'schema_migrations',
  'tombstones',
  'usage'
] as const)

function temporaryDatabasePath (t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-memory-v2-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'memory.sqlite')
}

function pragmaValue (
  database: DatabaseSync,
  name: string
): SQLOutputValue | undefined {
  const row = database.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

function tableColumns (database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name))
}

function tablePrimaryKey (database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info("${table}")`).all()
    .filter(row => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(row => String(row.name))
}

function indexKeyColumns (
  database: DatabaseSync,
  indexName: string
): readonly string[] {
  return database.prepare(`PRAGMA index_xinfo("${indexName}")`).all()
    .filter(row => row.key === 1)
    .map(row => String(row.name))
}

function sha256File (location: string): string {
  return createHash('sha256').update(readFileSync(location)).digest('hex')
}

function durableFileState (location: string): Readonly<Record<string, unknown>> {
  const stat = statSync(location, { bigint: true })
  return Object.freeze({
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    hash: sha256File(location),
    journal: existsSync(`${location}-journal`)
  })
}

function seedPendingV1Aggregate (database: DatabaseSync) {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const namespaceWire = memoryNamespaceWireV1(namespace)
  const proposal = memoryProposalFixture({ proposalId: `proposal:${'b'.repeat(64)}` })
  const proposalWire = encodeMemoryProposalV1(proposal)
  const canonicalBytes = Buffer.byteLength(namespaceWire, 'utf8') +
    Buffer.byteLength(proposalWire, 'utf8')
  database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes,
      namespace_generation, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(
    namespaceRef,
    namespaceWire,
    Buffer.byteLength(namespaceWire, 'utf8'),
    Date.parse(proposal.proposedAt),
    Date.parse(proposal.proposedAt)
  )
  database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, 1, ?, 1, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    namespaceRef,
    proposal.proposalId,
    Date.parse(proposal.proposedAt),
    proposalWire,
    Buffer.byteLength(proposalWire, 'utf8')
  )
  database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes, updated_at_ms
    ) VALUES (?, 1, 1, 0, 0, 0, ?, 0, 0, ?)
  `).run(namespaceRef, canonicalBytes, Date.parse(proposal.proposedAt))
  database.prepare(`
    UPDATE global_usage
    SET namespace_records = 1, canonical_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(canonicalBytes, Date.parse(proposal.proposedAt))
  return Object.freeze({ namespaceRef, proposal, proposalWire, canonicalBytes })
}

function seedOrphanV1Revision (
  database: DatabaseSync,
  fixture: ReturnType<typeof seedPendingV1Aggregate>,
  includeHead: boolean
): void {
  const memoryId = `memory:${'c'.repeat(64)}`
  const record = memoryRecordFixture({ memoryId })
  const revision = memoryRevisionFixture({ memoryId, record })
  const revisionWire = encodeMemoryRevisionV1(revision)
  const revisionWireBytes = Buffer.byteLength(revisionWire, 'utf8')
  database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, 1, ?, 1, 'created', ?, NULL, ?, ?)
  `).run(
    fixture.namespaceRef,
    revision.memoryId,
    revision.revisionHash,
    Date.parse(revision.changedAt),
    revisionWireBytes
  )
  database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, 1, ?, 1, ?)
  `).run(fixture.namespaceRef, revision.memoryId, revisionWire)
  if (includeHead) {
    database.prepare(`
      INSERT INTO heads(
        namespace_ref, namespace_generation, memory_id, current_revision,
        current_revision_hash, content_hash, cursor_ref, updated_at_ms,
        valid_until_ms, purge_at_ms
      ) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.namespaceRef,
      revision.memoryId,
      revision.revisionHash,
      revision.record.contentHash,
      'e'.repeat(64),
      Date.parse(revision.record.updatedAt),
      Date.parse(revision.record.retention.validUntil),
      Date.parse(revision.record.retention.purgeAt)
    )
  }
  database.prepare(`
    UPDATE usage
    SET active_memory_records = ?, retained_revision_records = 1,
      canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(includeHead ? 1 : 0, revisionWireBytes, fixture.namespaceRef)
  database.prepare(`
    UPDATE global_usage
    SET active_memory_records = ?, canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE singleton = 1
  `).run(includeHead ? 1 : 0, revisionWireBytes)
}

function seedApprovedV1Aggregate (database: DatabaseSync) {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const namespaceWire = memoryNamespaceWireV1(namespace)
  const pendingProposal = memoryProposalFixture()
  const approvedProposal = memoryProposalFixture({
    revision: 2,
    state: 'approved',
    decision: {
      decidedAt: FIXTURE_TIMES.confirmedAt,
      decidedByActorRef: FIXTURE_IDS.actorRef,
      reason: null
    }
  })
  const pendingProposalWire = encodeMemoryProposalV1(pendingProposal)
  const approvedProposalWire = encodeMemoryProposalV1(approvedProposal)
  const memoryId = `memory:${'c'.repeat(64)}`
  const record = memoryRecordFixture({ memoryId })
  const revision = memoryRevisionFixture({ memoryId, record })
  const revisionWire = encodeMemoryRevisionV1(revision)
  const canonicalBytes = [namespaceWire, approvedProposalWire, revisionWire]
    .reduce((total, wire) => total + Buffer.byteLength(wire, 'utf8'), 0)

  database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes,
      namespace_generation, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(
    namespaceRef,
    namespaceWire,
    Buffer.byteLength(namespaceWire, 'utf8'),
    Date.parse(approvedProposal.proposedAt),
    Date.parse(approvedProposal.decision!.decidedAt)
  )
  database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, 1, ?, 1, 'created', ?, NULL, ?, ?)
  `).run(
    namespaceRef,
    revision.memoryId,
    revision.revisionHash,
    Date.parse(revision.changedAt),
    Buffer.byteLength(revisionWire, 'utf8')
  )
  database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, 1, ?, 1, ?)
  `).run(namespaceRef, revision.memoryId, revisionWire)
  database.prepare(`
    INSERT INTO heads(
      namespace_ref, namespace_generation, memory_id, current_revision,
      current_revision_hash, content_hash, cursor_ref, updated_at_ms,
      valid_until_ms, purge_at_ms
    ) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    namespaceRef,
    revision.memoryId,
    revision.revisionHash,
    revision.record.contentHash,
    'f'.repeat(64),
    Date.parse(revision.record.updatedAt),
    Date.parse(revision.record.retention.validUntil),
    Date.parse(revision.record.retention.purgeAt)
  )
  database.prepare(`
    INSERT INTO proposals(
      namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    ) VALUES (?, 1, ?, 2, 'approved', ?, ?, ?, 1, ?, ?, ?)
  `).run(
    namespaceRef,
    approvedProposal.proposalId,
    Date.parse(approvedProposal.proposedAt),
    Date.parse(approvedProposal.decision!.decidedAt),
    revision.memoryId,
    revision.revisionHash,
    approvedProposalWire,
    Buffer.byteLength(approvedProposalWire, 'utf8')
  )
  database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes, updated_at_ms
    ) VALUES (?, 1, 0, 1, 1, 0, ?, 0, 0, ?)
  `).run(namespaceRef, canonicalBytes, Date.parse(revision.changedAt))
  database.prepare(`
    UPDATE global_usage
    SET namespace_records = 1, active_memory_records = 1,
      canonical_logical_bytes = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(canonicalBytes, Date.parse(revision.changedAt))
  return Object.freeze({
    namespaceRef,
    pendingProposalWire,
    approvedProposal,
    approvedProposalWire,
    revision,
    revisionWire,
    canonicalBytes
  })
}

function pendingV1Manifest (
  fixture: ReturnType<typeof seedPendingV1Aggregate>,
  proposalWire = fixture.proposalWire
) {
  return createMemoryV1ToV2AggregateManifestV1({
    namespaceRef: fixture.namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'proposal',
      aggregateId: fixture.proposal.proposalId,
      proposalState: 'pending',
      proposalRevision: 1,
      legacyProposalWireHashes: [createHash('sha256').update(proposalWire).digest('hex')],
      legacyRevisionWires: []
    },
    initiatedByActorRef: FIXTURE_IDS.actorRef,
    plannedMemoryId: `memory:${'c'.repeat(64)}`,
    intent: { kind: 'create' },
    consentEvidenceId: null,
    consentEvidenceHash: null,
    revisionEvidenceBindings: []
  })
}

function approvedV1Manifest (fixture: ReturnType<typeof seedApprovedV1Aggregate>) {
  return createMemoryV1ToV2AggregateManifestV1({
    namespaceRef: fixture.namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'memory',
      aggregateId: fixture.revision.memoryId,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 1,
      legacyProposalWireHashes: [
        createHash('sha256').update(fixture.pendingProposalWire).digest('hex'),
        createHash('sha256').update(fixture.approvedProposalWire).digest('hex')
      ],
      legacyRevisionWires: [{
        revision: 1,
        legacyWireHash: createHash('sha256').update(fixture.revisionWire).digest('hex')
      }]
    },
    initiatedByActorRef: FIXTURE_IDS.actorRef,
    plannedMemoryId: fixture.revision.memoryId,
    intent: { kind: 'create' },
    consentEvidenceId: `evidence:${'a'.repeat(64)}`,
    consentEvidenceHash: 'b'.repeat(64),
    revisionEvidenceBindings: []
  })
}

function mutateFileDatabase (
  location: string,
  mutate: (database: DatabaseSync) => void
): void {
  const database = new DatabaseSync(location, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  try {
    assert.equal(pragmaValue(database, 'journal_mode'), 'wal')
    assert.equal(pragmaValueAfter(database, 'journal_mode = DELETE'), 'delete')
    mutate(database)
  } finally {
    database.close()
  }
}

function pragmaValueAfter (database: DatabaseSync, expression: string): SQLOutputValue | undefined {
  const row = database.prepare(`PRAGMA ${expression}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

function assertV2OpenRejectedWithoutMutation (location: string): void {
  const before = durableFileState(location)
  assert.throws(() => openSqliteMemoryDatabaseV2({
    location,
    now: () => { throw new Error('rejected reopen must not request migration time') },
    manifests: []
  }), error => (
    error instanceof SqliteMemoryDatabaseErrorV1 &&
    error.code === 'memory_schema_unsupported'
  ))
  assert.deepEqual(durableFileState(location), before)
}

test('sqlite memory v2 fresh bootstrap freezes exact migration metadata and singleton state', () => {
  assert.equal(MEMORY_SQLITE_SCHEMA_VERSION_V2, 2)
  assert.equal(MEMORY_SQLITE_MIGRATION_V2.version, 2)
  assert.equal(MEMORY_SQLITE_MIGRATION_V2.sql.startsWith('\uFEFF'), false)
  assert.equal(MEMORY_SQLITE_MIGRATION_V2.sql.includes('\r'), false)
  assert.equal(MEMORY_SQLITE_MIGRATION_V2.sql.endsWith('\n'), true)
  assert.equal(
    createHash('sha256').update(MEMORY_SQLITE_MIGRATION_V2.sql).digest('hex'),
    MEMORY_SQLITE_MIGRATION_V2.checksum
  )
  const store = openSqliteMemoryDatabaseV2({
    location: ':memory:',
    now: () => V2_TIME,
    manifests: []
  })
  try {
    assert.equal(pragmaValue(store.database, 'user_version'), 2)
    assert.equal(
      sqliteMemorySchemaFingerprintV1(store.database),
      MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2
    )
    assert.deepEqual(store.database.prepare(`
      SELECT version, checksum, schema_fingerprint, applied_at
      FROM schema_migrations ORDER BY version ASC
    `).all().map(row => ({ ...row })), [
      {
        version: 1,
        checksum: MEMORY_SQLITE_MIGRATION_V1.checksum,
        schema_fingerprint: MEMORY_SQLITE_MIGRATION_V1.schemaFingerprint,
        applied_at: V2_TIME
      },
      {
        version: 2,
        checksum: MEMORY_SQLITE_MIGRATION_V2.checksum,
        schema_fingerprint: MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2,
        applied_at: V2_TIME
      }
    ])
    assert.deepEqual({ ...store.database.prepare(`
      SELECT trusted_time_high_water_ms, export_fencing_counter,
        export_lease_owner_id, export_lease_token, export_leased_until_ms
      FROM lifecycle_deployment_state WHERE singleton = 1
    `).get() }, {
      trusted_time_high_water_ms: Date.parse(V2_TIME),
      export_fencing_counter: 0,
      export_lease_owner_id: null,
      export_lease_token: null,
      export_leased_until_ms: null
    })
  } finally {
    store.close()
  }
})

test('sqlite memory v2 schema persists lifecycle bodies, ledgers, checkpoints, export and usage', () => {
  const store = openSqliteMemoryDatabaseV2({
    location: ':memory:',
    now: () => V2_TIME,
    manifests: []
  })
  try {
    const tables = store.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all().map(row => String(row.name))
    assert.deepEqual(tables, V2_TABLES)
    const tableList = store.database.prepare('PRAGMA table_list').all()
    for (const table of V2_TABLES) {
      assert.equal(tableList.find(row => row.name === table)?.strict, 1, table)
    }

    assert.deepEqual(tablePrimaryKey(store.database, 'lifecycle_audits'), [
      'namespace_ref', 'namespace_generation', 'audit_id'
    ])
    assert.deepEqual(tablePrimaryKey(store.database, 'lifecycle_commands'), [
      'namespace_ref', 'command_ref'
    ])
    assert.deepEqual(tablePrimaryKey(store.database, 'namespace_deletion_checkpoints'), [
      'namespace_ref', 'deletion_ref'
    ])
    assert.deepEqual(tablePrimaryKey(store.database, 'lifecycle_namespace_usage'), [
      'namespace_ref'
    ])
    assert.deepEqual(tablePrimaryKey(store.database, 'export_jobs'), ['export_id'])
    assert.deepEqual(tablePrimaryKey(store.database, 'export_audit_reservations'), ['export_id'])

    assert.ok(tableColumns(store.database, 'namespaces').includes('content_epoch'))
    const proposalSql = String(store.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'proposals'
    `).get()?.sql)
    assert.match(proposalSql, /'withdrawn'/)
    const exportColumns = tableColumns(store.database, 'export_jobs')
    for (const column of [
      'artifact_token', 'claim_command_hash', 'delivery_ref_hash',
      'claim_receipt_hash', 'delivered_at_ms'
    ]) {
      assert.ok(exportColumns.includes(column), column)
    }
    for (const column of [
      'lifecycle_audit_records', 'lifecycle_audit_reserved_records',
      'lifecycle_command_records', 'deletion_checkpoint_records', 'export_job_records',
      'lifecycle_audit_logical_bytes', 'lifecycle_audit_reserved_bytes',
      'lifecycle_command_logical_bytes', 'deletion_checkpoint_logical_bytes',
      'export_job_logical_bytes'
    ]) {
      assert.ok(tableColumns(store.database, 'usage').includes(column), column)
      assert.ok(tableColumns(store.database, 'global_usage').includes(column), column)
    }
  } finally {
    store.close()
  }
})

test('sqlite memory v2 has bounded covering indexes for lifecycle maintenance and absence probes', () => {
  const store = openSqliteMemoryDatabaseV2({
    location: ':memory:', now: () => V2_TIME, manifests: []
  })
  try {
    const expected = new Map<string, readonly string[]>([
      ['memory_proposals_decided_v2', [
        'namespace_ref', 'namespace_generation', 'state', 'decided_at_ms', 'proposal_id'
      ]],
      ['memory_lifecycle_audits_expiry_v2', [
        'namespace_ref', 'namespace_generation', 'expires_at_ms', 'audit_id'
      ]],
      ['memory_lifecycle_audits_order_v2', [
        'namespace_ref', 'namespace_generation', 'recorded_at_ms', 'audit_id'
      ]],
      ['memory_outbox_content_probe_v2', [
        'namespace_ref', 'namespace_generation', 'event_kind', 'sequence'
      ]],
      ['memory_lifecycle_commands_expiry_v2', [
        'namespace_ref', 'expires_at_ms', 'command_ref'
      ]],
      ['memory_deletion_checkpoints_stage_v2', [
        'namespace_ref', 'stage', 'updated_at_ms', 'deletion_ref'
      ]],
      ['memory_export_jobs_expiry_v2', [
        'state', 'expires_at_ms', 'export_id'
      ]]
    ])
    for (const [name, columns] of expected) {
      const row = store.database.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?
      `).get(name)
      assert.equal(row?.name, name)
      assert.deepEqual(indexKeyColumns(store.database, name), columns)
    }

    const plan = store.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT audit_id FROM lifecycle_audits
      WHERE namespace_ref = ? AND namespace_generation = ? AND expires_at_ms <= ?
      ORDER BY expires_at_ms ASC, audit_id ASC LIMIT 32
    `).all('a'.repeat(64), 1, 0)
    assert.ok(plan.some(row => String(row.detail).includes(
      'USING COVERING INDEX memory_lifecycle_audits_expiry_v2'
    )), JSON.stringify(plan))
    assert.equal(plan.some(row => String(row.detail).includes('USE TEMP B-TREE')), false)
  } finally {
    store.close()
  }
})

test('sqlite memory v2 schema rejects oversized lifecycle wires and inconsistent export claims', () => {
  const store = openSqliteMemoryDatabaseV2({
    location: ':memory:', now: () => V2_TIME, manifests: []
  })
  try {
    const namespace = personalMemoryNamespaceFixture()
    const namespaceRef = memoryNamespaceRefV1(namespace)
    const namespaceWire = memoryNamespaceWireV1(namespace)
    store.database.prepare(`
      INSERT INTO namespaces(
        namespace_ref, namespace_wire, namespace_wire_bytes,
        namespace_generation, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?)
    `).run(
      namespaceRef,
      namespaceWire,
      Buffer.byteLength(namespaceWire, 'utf8'),
      Date.parse(V2_TIME),
      Date.parse(V2_TIME)
    )

    const oversizedEvidence = 'x'.repeat(4 * 1_024 + 1)
    assert.throws(() => store.database.prepare(`
      INSERT INTO consent_evidence(
        namespace_ref, namespace_generation, evidence_id, proposal_id,
        evidence_hash, evidence_wire, evidence_wire_bytes, created_at_ms
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      namespaceRef,
      `evidence:${'a'.repeat(64)}`,
      `proposal:${'b'.repeat(64)}`,
      'c'.repeat(64),
      oversizedEvidence,
      Buffer.byteLength(oversizedEvidence, 'utf8'),
      Date.parse(V2_TIME)
    ))

    assert.throws(() => store.database.prepare(`
      INSERT INTO export_jobs(
        export_id, namespace_ref, namespace_generation, content_epoch, state,
        prepared_command_hash, terminal_command_hash, lease_owner_id, lease_token,
        fencing_token, leased_until_ms, manifest_wire, manifest_wire_bytes,
        artifact_token, claim_command_hash, delivery_ref_hash, claim_receipt_hash,
        prepared_at_ms, terminal_at_ms, delivered_at_ms, expires_at_ms, job_wire_bytes
      ) VALUES (?, ?, 1, 1, 'delivered', ?, NULL, NULL, NULL, 1, NULL,
        NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, 1)
    `).run(
      `export:${'d'.repeat(64)}`,
      namespaceRef,
      'e'.repeat(64),
      'f'.repeat(64),
      '1'.repeat(64),
      '2'.repeat(64),
      Date.parse(V2_TIME),
      Date.parse(V2_TIME),
      Date.parse(V2_TIME) + 60_000
    ))

    const exportId = `export:${'3'.repeat(64)}`
    const preparedAt = Date.parse(V2_TIME)
    const expiresAt = preparedAt + 60_000
    store.database.prepare(`
      INSERT INTO export_jobs(
        export_id, namespace_ref, namespace_generation, content_epoch, state,
        prepared_command_hash, terminal_command_hash, lease_owner_id, lease_token,
        fencing_token, leased_until_ms, manifest_wire, manifest_wire_bytes,
        artifact_token, claim_command_hash, delivery_ref_hash, claim_receipt_hash,
        prepared_at_ms, terminal_at_ms, delivered_at_ms, expires_at_ms, job_wire_bytes
      ) VALUES (?, ?, 1, 1, 'prepared', ?, NULL, NULL, NULL, 1, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, 1)
    `).run(exportId, namespaceRef, '4'.repeat(64), preparedAt, expiresAt)
    store.database.prepare(`
      UPDATE export_jobs
      SET state = 'writing', lease_owner_id = 'worker:fixture', lease_token = 'lease:fixture',
        leased_until_ms = ?
      WHERE export_id = ?
    `).run(preparedAt + 30_000, exportId)
    store.database.prepare(`
      UPDATE export_jobs
      SET state = 'deliverable', terminal_command_hash = ?, terminal_at_ms = ?,
        lease_owner_id = NULL, lease_token = NULL, leased_until_ms = NULL,
        manifest_wire = '{}', manifest_wire_bytes = 2, artifact_token = 'artifact:fixture'
      WHERE export_id = ?
    `).run('5'.repeat(64), preparedAt + 40_000, exportId)
    store.database.prepare(`
      UPDATE export_jobs
      SET state = 'delivered', claim_command_hash = ?, delivery_ref_hash = ?,
        claim_receipt_hash = ?, delivered_at_ms = ?
      WHERE export_id = ?
    `).run(
      '6'.repeat(64),
      '7'.repeat(64),
      '8'.repeat(64),
      preparedAt + 50_000,
      exportId
    )
    assert.deepEqual({ ...store.database.prepare(`
      SELECT state, manifest_wire_bytes, delivered_at_ms
      FROM export_jobs WHERE export_id = ?
    `).get(exportId) }, {
      state: 'delivered',
      manifest_wire_bytes: 2,
      delivered_at_ms: preparedAt + 50_000
    })
  } finally {
    store.close()
  }
})

test('sqlite memory v2 atomically upgrades an empty v1 file and reopens without migration time', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  v1.close()
  assert.equal(pragmaFromFile(location, 'user_version'), 1)

  const upgraded = openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: []
  })
  upgraded.close()
  assert.equal(pragmaFromFile(location, 'user_version'), 2)

  const reopened = openSqliteMemoryDatabaseV2({
    location,
    now: () => { throw new Error('reopen must not request migration time') },
    manifests: []
  })
  try {
    assert.equal(
      sqliteMemorySchemaFingerprintV1(reopened.database),
      MEMORY_SQLITE_SCHEMA_FINGERPRINT_V2
    )
  } finally {
    reopened.close()
  }
})

test('sqlite memory v2 bootstrap preserves and upgrades a concurrent v1 publisher', t => {
  const location = temporaryDatabasePath(t)
  let published = false
  const opened = openSqliteMemoryDatabaseV2({
    location,
    manifests: [],
    now: () => {
      if (!published) {
        published = true
        const winner = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
        try {
          winner.database.prepare(`
            UPDATE global_usage SET updated_at_ms = 777 WHERE singleton = 1
          `).run()
        } finally {
          winner.close()
        }
      }
      return V2_TIME
    }
  })
  try {
    assert.equal(published, true)
    assert.equal(pragmaValue(opened.database, 'user_version'), 2)
    assert.equal(opened.database.prepare(`
      SELECT updated_at_ms FROM global_usage WHERE singleton = 1
    `).get()?.updated_at_ms, 777)
  } finally {
    opened.close()
  }
})

test('sqlite memory v2 rejects non-empty v1 without a manifest before schema mutation', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  try {
    seedPendingV1Aggregate(v1.database)
  } finally {
    v1.close()
  }
  const before = durableFileState(location)
  assert.throws(() => openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: []
  }), error => error instanceof TypeError && error.message === 'memory_migration_manifest_required')
  assert.deepEqual(durableFileState(location), before)
  if (existsSync(`${location}-wal`)) {
    assert.equal(statSync(`${location}-wal`).size, 0)
  }
  assert.equal(pragmaFromFile(location, 'user_version'), 1)
})

test('sqlite memory v2 upgrades a bounded non-empty v1 fixture with an exact manifest', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  let fixture: ReturnType<typeof seedPendingV1Aggregate>
  try {
    fixture = seedPendingV1Aggregate(v1.database)
    v1.database.prepare('UPDATE usage SET updated_at_ms = ?')
      .run(Date.parse(LEGACY_HIGH_WATER))
    v1.database.prepare('UPDATE global_usage SET updated_at_ms = ?')
      .run(Date.parse(LEGACY_HIGH_WATER))
  } finally {
    v1.close()
  }
  const manifest = pendingV1Manifest(fixture)
  const upgraded = openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: [manifest]
  })
  try {
    assert.equal(pragmaValue(upgraded.database, 'user_version'), 2)
    assert.deepEqual({ ...upgraded.database.prepare(`
      SELECT manifest_id, aggregate_kind, aggregate_id, manifest_hash,
        manifest_wire_bytes, applied_at_ms
      FROM memory_v1_to_v2_manifests
    `).get() }, {
      manifest_id: manifest.manifestId,
      aggregate_kind: 'proposal',
      aggregate_id: fixture.proposal.proposalId,
      manifest_hash: manifest.manifestHash,
      manifest_wire_bytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
      applied_at_ms: Date.parse(V2_TIME)
    })
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8')
    assert.equal(upgraded.database.prepare(`
      SELECT canonical_logical_bytes FROM usage
      WHERE namespace_ref = ? AND namespace_generation = 1
    `).get(fixture.namespaceRef)?.canonical_logical_bytes, fixture.canonicalBytes + manifestBytes)
    assert.equal(upgraded.database.prepare(`
      SELECT canonical_logical_bytes FROM global_usage WHERE singleton = 1
    `).get()?.canonical_logical_bytes, fixture.canonicalBytes + manifestBytes)
    assert.deepEqual({ ...upgraded.database.prepare(`
      SELECT lifecycle_audit_records, lifecycle_audit_reserved_records,
        lifecycle_command_records, deletion_checkpoint_records, export_job_records
      FROM lifecycle_namespace_usage WHERE namespace_ref = ?
    `).get(fixture.namespaceRef) }, {
      lifecycle_audit_records: 0,
      lifecycle_audit_reserved_records: 0,
      lifecycle_command_records: 0,
      deletion_checkpoint_records: 0,
      export_job_records: 0
    })
    assert.equal(upgraded.database.prepare(`
      SELECT trusted_time_high_water_ms FROM lifecycle_deployment_state WHERE singleton = 1
    `).get()?.trusted_time_high_water_ms, Date.parse(LEGACY_HIGH_WATER))
  } finally {
    upgraded.close()
  }
  const reopened = openSqliteMemoryDatabaseV2({
    location,
    now: () => { throw new Error('v2 reopen must not request migration time') },
    manifests: []
  })
  reopened.close()
})

test('sqlite memory v2 upgrades an approved aggregate and backfills exact global usage', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  let fixture: ReturnType<typeof seedApprovedV1Aggregate>
  try {
    fixture = seedApprovedV1Aggregate(v1.database)
  } finally {
    v1.close()
  }
  const manifest = approvedV1Manifest(fixture)
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8')
  const upgraded = openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: [manifest]
  })
  try {
    assert.deepEqual({ ...upgraded.database.prepare(`
      SELECT pending_proposal_records, active_memory_records,
        retained_revision_records, tombstone_records, canonical_logical_bytes
      FROM global_usage WHERE singleton = 1
    `).get() }, {
      pending_proposal_records: 0,
      active_memory_records: 1,
      retained_revision_records: 1,
      tombstone_records: 0,
      canonical_logical_bytes: fixture.canonicalBytes + manifestBytes
    })
    assert.deepEqual({ ...upgraded.database.prepare(`
      SELECT pending_proposal_records, active_memory_records,
        retained_revision_records, tombstone_records, canonical_logical_bytes
      FROM usage WHERE namespace_ref = ? AND namespace_generation = 1
    `).get(fixture.namespaceRef) }, {
      pending_proposal_records: 0,
      active_memory_records: 1,
      retained_revision_records: 1,
      tombstone_records: 0,
      canonical_logical_bytes: fixture.canonicalBytes + manifestBytes
    })
    assert.equal(upgraded.database.prepare(`
      SELECT trusted_time_high_water_ms
      FROM lifecycle_deployment_state WHERE singleton = 1
    `).get()?.trusted_time_high_water_ms, Date.parse(V2_TIME))
  } finally {
    upgraded.close()
  }
})

test('sqlite memory v2 preserves the v1 migration timestamp in trusted time high-water', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => LEGACY_HIGH_WATER })
  v1.close()
  const upgraded = openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: []
  })
  try {
    assert.equal(upgraded.database.prepare(`
      SELECT trusted_time_high_water_ms
      FROM lifecycle_deployment_state WHERE singleton = 1
    `).get()?.trusted_time_high_water_ms, Date.parse(LEGACY_HIGH_WATER))
  } finally {
    upgraded.close()
  }
})

test('sqlite memory v2 rejects wrong legacy hashes and migration capacity without mutation', t => {
  for (const mode of ['wrong_hash', 'capacity'] as const) {
    const location = temporaryDatabasePath(t)
    const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
    let fixture: ReturnType<typeof seedPendingV1Aggregate>
    try {
      fixture = seedPendingV1Aggregate(v1.database)
      if (mode === 'capacity') {
        const overSoft = MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes -
          (2 * 1_024 * 1_024) + 1
        v1.database.prepare(`
          UPDATE usage SET canonical_logical_bytes = ?
        `).run(overSoft)
        v1.database.prepare(`
          UPDATE global_usage SET canonical_logical_bytes = ?
        `).run(overSoft)
      }
    } finally {
      v1.close()
    }
    const exact = pendingV1Manifest(fixture)
    const manifest = mode === 'wrong_hash'
      ? createMemoryV1ToV2AggregateManifestV1({
          namespaceRef: exact.namespaceRef,
          namespaceGeneration: exact.namespaceGeneration,
          aggregate: {
            ...exact.aggregate,
            legacyProposalWireHashes: ['d'.repeat(64)]
          },
          initiatedByActorRef: exact.initiatedByActorRef,
          plannedMemoryId: exact.plannedMemoryId,
          intent: exact.intent,
          consentEvidenceId: exact.consentEvidenceId,
          consentEvidenceHash: exact.consentEvidenceHash,
          revisionEvidenceBindings: exact.revisionEvidenceBindings
        })
      : exact
    const before = durableFileState(location)
    assert.throws(() => openSqliteMemoryDatabaseV2({
      location,
      now: () => V2_TIME,
      manifests: [manifest]
    }), error => error instanceof TypeError && error.message === (
      mode === 'capacity'
        ? 'memory_migration_capacity'
        : 'memory_migration_manifest_invalid'
    ))
    assert.deepEqual(durableFileState(location), before)
    assert.equal(pragmaFromFile(location, 'user_version'), 1)
  }
})

test('sqlite memory v2 rejects in-limit usage drift from canonical rows', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  let fixture: ReturnType<typeof seedPendingV1Aggregate>
  try {
    fixture = seedPendingV1Aggregate(v1.database)
    v1.database.prepare('UPDATE usage SET pending_proposal_records = 0').run()
  } finally {
    v1.close()
  }
  const before = durableFileState(location)
  assert.throws(() => openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: [pendingV1Manifest(fixture)]
  }), error => (
    error instanceof TypeError && error.message === 'memory_migration_manifest_invalid'
  ))
  assert.deepEqual(durableFileState(location), before)
  assert.equal(pragmaFromFile(location, 'user_version'), 1)
})

test('sqlite memory v2 rejects malformed legacy wire even when the manifest hashes it exactly', t => {
  const location = temporaryDatabasePath(t)
  const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
  let fixture: ReturnType<typeof seedPendingV1Aggregate>
  let malformedWire: string
  try {
    fixture = seedPendingV1Aggregate(v1.database)
    malformedWire = fixture.proposalWire.replace('"schemaVersion":1', '"schemaVersion":2')
    assert.notEqual(malformedWire, fixture.proposalWire)
    v1.database.prepare(`
      UPDATE proposals SET proposal_wire = ?, proposal_wire_bytes = ?
      WHERE namespace_ref = ? AND namespace_generation = 1 AND proposal_id = ?
    `).run(
      malformedWire,
      Buffer.byteLength(malformedWire, 'utf8'),
      fixture.namespaceRef,
      fixture.proposal.proposalId
    )
  } finally {
    v1.close()
  }
  const before = durableFileState(location)
  assert.throws(() => openSqliteMemoryDatabaseV2({
    location,
    now: () => V2_TIME,
    manifests: [pendingV1Manifest(fixture, malformedWire)]
  }), error => (
    error instanceof TypeError && error.message === 'memory_migration_manifest_invalid'
  ))
  assert.deepEqual(durableFileState(location), before)
  assert.equal(pragmaFromFile(location, 'user_version'), 1)
})

test('sqlite memory v2 rejects legacy columns that disagree with canonical aggregate wires', t => {
  for (const mutation of ['proposal_time', 'result_hash', 'head_content_hash'] as const) {
    const location = temporaryDatabasePath(t)
    const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
    let fixture: ReturnType<typeof seedPendingV1Aggregate> |
      ReturnType<typeof seedApprovedV1Aggregate>
    let manifest: ReturnType<typeof pendingV1Manifest> |
      ReturnType<typeof approvedV1Manifest>
    try {
      if (mutation === 'proposal_time') {
        fixture = seedPendingV1Aggregate(v1.database)
        manifest = pendingV1Manifest(fixture)
        v1.database.prepare(`
          UPDATE proposals SET proposed_at_ms = proposed_at_ms + 1
        `).run()
      } else {
        fixture = seedApprovedV1Aggregate(v1.database)
        manifest = approvedV1Manifest(fixture)
        if (mutation === 'result_hash') {
          v1.database.prepare(`
            UPDATE proposals SET resulting_revision_hash = ?
          `).run('c'.repeat(64))
        } else {
          v1.database.prepare(`
            UPDATE heads SET content_hash = ?
          `).run('d'.repeat(64))
        }
      }
    } finally {
      v1.close()
    }
    const before = durableFileState(location)
    assert.throws(() => openSqliteMemoryDatabaseV2({
      location,
      now: () => V2_TIME,
      manifests: [manifest]
    }), error => (
      error instanceof TypeError && error.message === 'memory_migration_manifest_invalid'
    ))
    assert.deepEqual(durableFileState(location), before)
    assert.equal(pragmaFromFile(location, 'user_version'), 1)
  }
})

test('sqlite memory v2 rejects malformed retained tombstone and outbox wires', t => {
  for (const kind of ['tombstone', 'outbox'] as const) {
    const location = temporaryDatabasePath(t)
    const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
    let fixture: ReturnType<typeof seedPendingV1Aggregate>
    try {
      fixture = seedPendingV1Aggregate(v1.database)
      if (kind === 'tombstone') {
        v1.database.prepare(`
          INSERT INTO tombstones(
            namespace_ref, namespace_generation, tombstone_id, memory_id,
            deleted_revision, deletion_kind, deleted_at_ms, expires_at_ms,
            receipt_hash, tombstone_wire, tombstone_wire_bytes
          ) VALUES (?, 1, ?, NULL, NULL, 'namespace_deleted', ?, ?, ?, '{}', 2)
        `).run(
          fixture.namespaceRef,
          `tombstone:${'e'.repeat(64)}`,
          Date.parse(V1_TIME),
          Date.parse(V1_TIME) + 60_000,
          'f'.repeat(64)
        )
        v1.database.prepare(`
          UPDATE usage SET tombstone_records = 1,
            canonical_logical_bytes = canonical_logical_bytes + 2
        `).run()
        v1.database.prepare(`
          UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + 2
        `).run()
      } else {
        v1.database.prepare(`
          INSERT INTO outbox(
            event_id, namespace_ref, namespace_generation, aggregate, aggregate_id,
            revision, event_kind, occurred_at_ms, available_at_ms,
            event_wire, logical_bytes
          ) VALUES (?, ?, 1, 'proposal', ?, 1, 'proposal_changed', ?, ?, '{}', 2)
        `).run(
          `event:${'1'.repeat(64)}`,
          fixture.namespaceRef,
          fixture.proposal.proposalId,
          Date.parse(V1_TIME),
          Date.parse(V1_TIME)
        )
        v1.database.prepare(`
          UPDATE usage SET pending_outbox_records = 1, outbox_logical_bytes = 2
        `).run()
        v1.database.prepare(`
          UPDATE global_usage SET pending_outbox_records = 1, outbox_logical_bytes = 2
        `).run()
      }
    } finally {
      v1.close()
    }
    const before = durableFileState(location)
    assert.throws(() => openSqliteMemoryDatabaseV2({
      location,
      now: () => V2_TIME,
      manifests: [pendingV1Manifest(fixture)]
    }), error => (
      error instanceof TypeError && error.message === 'memory_migration_manifest_invalid'
    ))
    assert.deepEqual(durableFileState(location), before)
    assert.equal(pragmaFromFile(location, 'user_version'), 1)
  }
})

test('sqlite memory v2 rejects revision and head aggregates absent from the manifest set', t => {
  for (const includeHead of [false, true]) {
    const location = temporaryDatabasePath(t)
    const v1 = openSqliteMemoryDatabaseV1({ location, now: () => V1_TIME })
    let fixture: ReturnType<typeof seedPendingV1Aggregate>
    try {
      fixture = seedPendingV1Aggregate(v1.database)
      seedOrphanV1Revision(v1.database, fixture, includeHead)
    } finally {
      v1.close()
    }
    const before = durableFileState(location)
    assert.throws(() => openSqliteMemoryDatabaseV2({
      location,
      now: () => V2_TIME,
      manifests: [pendingV1Manifest(fixture)]
    }), error => (
      error instanceof TypeError && error.message === 'memory_migration_manifest_invalid'
    ))
    assert.deepEqual(durableFileState(location), before)
    assert.equal(pragmaFromFile(location, 'user_version'), 1)
  }
})

test('sqlite memory v2 reopen rejects migration metadata and schema tampering without repair', t => {
  for (const mutation of ['checksum', 'fingerprint', 'extra_index'] as const) {
    const location = temporaryDatabasePath(t)
    const store = openSqliteMemoryDatabaseV2({
      location, now: () => V2_TIME, manifests: []
    })
    store.close()
    mutateFileDatabase(location, database => {
      if (mutation === 'checksum') {
        database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
          .run('0'.repeat(64))
      } else if (mutation === 'fingerprint') {
        database.prepare(`
          UPDATE schema_migrations SET schema_fingerprint = ? WHERE version = 2
        `).run('1'.repeat(64))
      } else {
        database.exec('CREATE INDEX unexpected_memory_index_v2 ON heads(memory_id)')
      }
    })
    assertV2OpenRejectedWithoutMutation(location)
  }
})

test('sqlite memory v2 migration rollback preserves authenticated v1 authority', () => {
  const database = new DatabaseSync(':memory:', {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  try {
    database.exec(MEMORY_SQLITE_MIGRATION_V1.sql)
    database.exec(`
      INSERT INTO schema_migrations(version, checksum, schema_fingerprint, applied_at)
      VALUES (
        1,
        '${MEMORY_SQLITE_MIGRATION_V1.checksum}',
        '${MEMORY_SQLITE_MIGRATION_V1.schemaFingerprint}',
        '${V1_TIME}'
      );
      PRAGMA application_id = 1196246349;
      PRAGMA user_version = 1;
    `)
    assert.throws(() => runSqliteMemoryMigrationV2(database, {
      appliedAt: V2_TIME,
      manifests: [Object.freeze({ invalid: true }) as unknown as never]
    }))
    assert.equal(pragmaValue(database, 'user_version'), 1)
    assert.equal(
      sqliteMemorySchemaFingerprintV1(database),
      MEMORY_SQLITE_MIGRATION_V1.schemaFingerprint
    )
    assert.equal(database.prepare(`
      SELECT count(*) AS count FROM schema_migrations
    `).get()?.count, 1)
  } finally {
    database.close()
  }
})

function pragmaFromFile (location: string, name: string): SQLOutputValue | undefined {
  const database = new DatabaseSync(location, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true
  })
  try {
    return pragmaValue(database, name)
  } finally {
    database.close()
  }
}
