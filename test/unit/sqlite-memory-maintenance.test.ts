import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryMaintenanceCapabilityV1,
  type MemoryMaintenanceOperationV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  encodeMemoryLifecycleAuditV1,
  encodeMemoryV1ToV2AggregateManifestV1
} from '../../src/agent/memory/memory-lifecycle-codec.js'
import {
  createMemoryLifecycleCommandV1,
  memoryLifecycleCommandHashV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  createMemoryLifecycleAuditV1,
  createMemoryV1ToV2AggregateManifestV1,
  memoryLifecycleDomainHashV1
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  encodeMemoryTombstoneV1
} from '../../src/agent/memory/memory-codec.js'
import { createMemoryTombstoneV1 } from '../../src/agent/memory/memory-domain.js'
import {
  createMemoryLifecyclePortV1,
  MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1,
  type MemoryLifecycleAuthorizationEnvelopeV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import { createMemoryControlRepositoryPortV1 } from '../../src/agent/memory/memory-control-repository.js'
import {
  createMemoryMaintenanceCommandV1,
  createMemoryMaintenancePortV1
} from '../../src/agent/memory/memory-maintenance-port.js'
import {
  createMemoryLifecycleStableResultV1,
  encodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleStableResultHashV1
} from '../../src/agent/memory/memory-lifecycle-result.js'
import {
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryDatabaseV2 } from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryControlRepositoryV1
} from '../../src/agent/memory/sqlite-memory-control-repository.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-mutation.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  createSqliteMemoryMaintenanceAdapterV1
} from '../../src/agent/memory/sqlite-memory-maintenance.js'
import { createSqliteMemoryOutboxV1 } from '../../src/agent/memory/sqlite-memory-outbox.js'
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-24T08:00:00.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const DAY_MS = 24 * 60 * 60 * 1_000

function instantAfterDays (days: number): string {
  return new Date(Date.parse(NOW) + days * DAY_MS).toISOString()
}

function commandRef (suffix: string): string {
  return `command:${createHash('sha256').update(suffix, 'utf8').digest('hex')}`
}

function alterHash (value: string): string {
  return `${value[0] === 'f' ? 'e' : 'f'}${value.slice(1)}`
}

function harness (t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-maintenance-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const store = openSqliteMemoryDatabaseV2({
    location,
    now: () => currentNow,
    manifests: []
  })
  t.after(store.close)
  return {
    store,
    location,
    now: () => currentNow,
    setNow: (value: string) => { currentNow = value },
    mutation: createMemoryLifecyclePortV1({
      now: () => currentNow,
      execute: createSqliteMemoryLifecycleMutationAdapterV1({
        database: store.database,
        now: () => currentNow
      }).execute
    }),
    direct: createMemoryLifecyclePortV1({
      now: () => currentNow,
      execute: createSqliteMemoryLifecycleProposalAdapterV1({
        database: store.database,
        now: () => currentNow
      }).execute
    }),
    maintenance: createMemoryMaintenancePortV1({
      now: () => currentNow,
      execute: createSqliteMemoryMaintenanceAdapterV1({
        database: store.database,
        now: () => currentNow
      }).execute
    }),
    control: createMemoryControlRepositoryPortV1({
      now: () => currentNow,
      execute: createSqliteMemoryControlRepositoryV1({
        database: store.database,
        now: () => currentNow
      }).execute
    })
  }
}

function accessAndActor (
  namespace: MemoryNamespaceV1,
  now: string,
  generation: number,
  actions: readonly string[]
) {
  const context = {
    schemaVersion: 1 as const,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq' as const,
    accountId: namespace.accountId,
    scene: { kind: 'private' as const, peerUserId: namespace.scope.kind === 'personal'
      ? namespace.scope.subjectUserId
      : FIXTURE_IDS.subjectUserId }
  }
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    context,
    [namespace],
    now
  )
  const actor = issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      sceneRef: access.sceneRef,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      generation,
      actorRef: ACTOR_REF,
      actorUserId: namespace.scope.kind === 'personal'
        ? namespace.scope.subjectUserId
        : FIXTURE_IDS.subjectUserId,
      role: 'personal_subject',
      roleObservedAt: null,
      actions
    },
    now
  )
  return { access, actor }
}

function actorEnvelope (
  namespace: MemoryNamespaceV1,
  now: string,
  generation: number,
  actions: readonly string[],
  command: ReturnType<typeof createMemoryLifecycleCommandV1>
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const authority = accessAndActor(namespace, now, generation, actions)
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: authority.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: authority.actor })
  })
}

function pendingFixture (ref: string, now = NOW) {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture({ observedAt: now })
  const proposal = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.create',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '偏好少糖饮品',
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: now,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const command = createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'proposal.create',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: now,
    newValidUntil: null,
    newPurgeAt: null,
    material: proposal
  })
  return { namespace, proposal, command }
}

function directFixture (ref: string) {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture()
  const proposal = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '偏好少糖饮品',
    sources: [source],
    observedAt: source.observedAt,
    proposedAt: NOW,
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: proposal.namespaceRef,
    namespaceGeneration: 1,
    proposal,
    approvedByActorRef: ACTOR_REF,
    freshNow: NOW,
    evidenceSource: proposal.sources[0],
    reason: null
  })
  const command = createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: proposal.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: NOW,
    newValidUntil: null,
    newPurgeAt: null,
    material: bundle
  })
  return { namespace, bundle, command }
}

function maintenanceEnvelope (
  namespace: MemoryNamespaceV1,
  now: string,
  operation: MemoryMaintenanceOperationV1,
  ref: string,
  currentGeneration = 1,
  targetGeneration = currentGeneration,
  deletionRef: string | null = null,
  limit = 32
) {
  const command = createMemoryMaintenanceCommandV1({
    commandRef: ref,
    operation,
    namespaceRef: memoryNamespaceRefV1(namespace),
    currentGeneration,
    targetGeneration,
    deletionRef,
    limit,
    occurredAt: now
  })
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      scene: { kind: 'private', peerUserId: namespace.scope.kind === 'personal'
        ? namespace.scope.subjectUserId
        : FIXTURE_IDS.subjectUserId }
    },
    [namespace],
    now
  )
  const maintenance = issueMemoryMaintenanceCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      currentGeneration,
      targetGeneration,
      deletionRef,
      operation,
      limit
    },
    now
  )
  return Object.freeze({ schemaVersion: 1 as const, command, access, maintenance })
}

function deletionControlRequest (
  namespace: MemoryNamespaceV1,
  now: string,
  operation: 'deletion.getStatus' | 'deletion.resolve',
  deletionRef: string,
  commandRefValue: string | null,
  generation = 1
) {
  const authority = accessAndActor(namespace, now, generation, ['resolve_deletion'])
  return {
    schemaVersion: 1 as const,
    operation,
    botInstanceId: namespace.botInstanceId,
    accountId: namespace.accountId,
    sceneRef: authority.access.sceneRef,
    namespaceRef: memoryNamespaceRefV1(namespace),
    generation,
    actorRef: ACTOR_REF,
    access: authority.access,
    actor: authority.actor,
    deletionRef,
    ...(operation === 'deletion.resolve' ? { commandRef: commandRefValue } : {})
  }
}

function seedPreparedExportReservation (
  target: ReturnType<typeof harness>,
  namespace: MemoryNamespaceV1,
  suffix: string
) {
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const exportId = `export:${createHash('sha256').update(`export:${suffix}`).digest('hex')}`
  const commandHash = createHash('sha256').update(`command:${suffix}`).digest('hex')
  const reservationWire = '{}'
  const expiresAt = Date.parse(NOW) + 30 * 60 * 1_000
  target.store.database.prepare(`
    INSERT INTO export_jobs(
      export_id, namespace_ref, namespace_generation, content_epoch, state,
      prepared_command_hash, terminal_command_hash, lease_owner_id, lease_token,
      fencing_token, leased_until_ms, manifest_wire, manifest_wire_bytes, artifact_token,
      claim_command_hash, delivery_ref_hash, claim_receipt_hash, prepared_at_ms,
      terminal_at_ms, delivered_at_ms, expires_at_ms, job_wire_bytes
    ) VALUES (?, ?, 1, 1, 'prepared', ?, NULL, NULL, NULL, 1, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, 1)
  `).run(exportId, namespaceRef, commandHash, Date.parse(NOW), expiresAt)
  target.store.database.prepare(`
    INSERT INTO export_audit_reservations(
      export_id, namespace_ref, namespace_generation, command_hash, reserved_records,
      reserved_bytes, reservation_wire, reservation_wire_bytes, expires_at_ms
    ) VALUES (?, ?, 1, ?, 1, 512, ?, ?, ?)
  `).run(exportId, namespaceRef, commandHash, reservationWire,
    Buffer.byteLength(reservationWire), expiresAt)
  target.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = canonical_logical_bytes + 3,
      lifecycle_audit_reserved_records = 1, lifecycle_audit_reserved_bytes = 512,
      export_job_records = 1, export_job_logical_bytes = 1
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(namespaceRef)
  target.store.database.prepare(`
    UPDATE lifecycle_namespace_usage SET lifecycle_audit_reserved_records = 1,
      lifecycle_audit_reserved_bytes = 512, export_job_records = 1,
      export_job_logical_bytes = 1 WHERE namespace_ref = ?
  `).run(namespaceRef)
  target.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + 3,
      lifecycle_audit_reserved_records = 1, lifecycle_audit_reserved_bytes = 512,
      export_job_records = 1, export_job_logical_bytes = 1 WHERE singleton = 1
  `).run()
  return { namespaceRef, exportId, commandHash, expiresAt }
}

test('SQLite maintenance expires due proposals in one replayable oldest-first batch', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('1'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const future = instantAfterDays(8)
  target.setNow(future)
  const envelope = maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.expireDue',
    commandRef('2')
  )
  const result = await target.maintenance.execute(envelope)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  if (result.status !== 'completed') return
  assert.equal(result.processed, 1)
  assert.equal(result.hasMore, false)
  assert.equal(JSON.stringify(result).includes('偏好少糖饮品'), false)
  assert.deepEqual(await target.maintenance.execute(envelope), result)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT revision, state, decided_at_ms FROM proposals
  `).get()! }, { revision: 2, state: 'expired', decided_at_ms: Date.parse(future) })
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM outbox WHERE event_kind = 'proposal_changed'
  `).get()!.value, 2)
})

test('SQLite maintenance exact replay validates its complete ledger binding', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('maintenance-replay-aggregate'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const future = instantAfterDays(8)
  target.setNow(future)
  const envelope = maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.expireDue',
    commandRef('maintenance-replay-command')
  )
  assert.equal((await target.maintenance.execute(envelope)).status, 'completed')
  const ledger = target.store.database.prepare(`
    SELECT command_hash, aggregate_ref_hash FROM lifecycle_commands
    WHERE operation = 'proposal.expireDue'
  `).get()
  assert.notEqual(ledger, undefined)
  if (ledger === undefined) return
  for (const column of ['command_hash', 'aggregate_ref_hash'] as const) {
    const original = String(ledger[column])
    target.store.database.prepare(`
      UPDATE lifecycle_commands SET ${column} = ?
      WHERE operation = 'proposal.expireDue'
    `).run(alterHash(original))
    const replay = await target.maintenance.execute(envelope)
    assert.deepEqual(replay.status === 'corrupt' ? replay.category : null, 'canonical_data')
    target.store.database.prepare(`
      UPDATE lifecycle_commands SET ${column} = ?
      WHERE operation = 'proposal.expireDue'
    `).run(original)
  }
})

test('SQLite maintenance expires and prunes an overdue proposal as one aggregate', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('3'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const future = instantAfterDays(38)
  target.setNow(future)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.expireDue',
    commandRef('4')
  ))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  if (result.status !== 'completed') return
  assert.equal(result.processed, 1)
  assert.equal(target.store.database.prepare('SELECT count(*) AS value FROM proposals').get()!.value, 0)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_audits WHERE operation = 'proposal_pruned'
  `).get()!.value, 1)
})

test('SQLite maintenance purges due records and later releases retention tombstones', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('5'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const purgeAt = fixture.bundle.record.retention.purgeAt
  target.setNow(purgeAt)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    purgeAt,
    'record.purgeExpired',
    commandRef('6')
  ))
  assert.equal(purged.status, 'completed', JSON.stringify(purged))
  if (purged.status !== 'completed') return
  assert.equal(purged.processed, 1)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM tombstones) AS tombstones,
      (SELECT count(*) FROM outbox WHERE event_kind = 'record_forgotten') AS forgotten
  `).get()! }, { heads: 0, revisions: 0, tombstones: 1, forgotten: 1 })

  const outbox = createSqliteMemoryOutboxV1({
    database: target.store.database,
    now: target.now
  })
  const claimed = await outbox.execute({
    schemaVersion: 1,
    operation: 'claim',
    ownerId: 'maintenance-test-projector',
    limit: 32
  })
  assert.equal(claimed.status, 'claimed')
  if (claimed.status !== 'claimed') return
  for (const event of claimed.events) {
    assert.deepEqual(await outbox.execute({
      schemaVersion: 1,
      operation: 'ack',
      ownerId: 'maintenance-test-projector',
      leaseToken: claimed.leaseToken,
      eventId: event.eventId,
      sequence: event.sequence
    }), { status: 'acked' })
  }

  const expiresAt = String(target.store.database.prepare(`
    SELECT datetime(expires_at_ms / 1000, 'unixepoch') AS ignored,
      expires_at_ms FROM tombstones
  `).get()!.expires_at_ms)
  const expiry = new Date(Number(expiresAt)).toISOString()
  target.setNow(expiry)
  const released = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'tombstone.purgeExpired',
    commandRef('7')
  ))
  assert.equal(released.status, 'completed', JSON.stringify(released))
  assert.equal(target.store.database.prepare('SELECT count(*) AS value FROM tombstones').get()!.value, 0)
})

test('SQLite tombstone purge scans past an ineligible first page', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('tombstone-scan-namespace'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const namespaceRef = memoryNamespaceRefV1(fixture.namespace)
  const expiresAt = instantAfterDays(30)
  const insert = target.store.database.prepare(`
    INSERT INTO tombstones(
      namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
      deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash, tombstone_wire,
      tombstone_wire_bytes
    ) VALUES (?, 1, ?, ?, 1, 'memory_forgotten', ?, ?, ?, ?, ?)
  `)
  let addedBytes = 0
  for (let index = 0; index < 34; index += 1) {
    const eligible = index === 33
    const suffix = eligible ? 'f'.repeat(64) : index.toString(16).padStart(64, '0')
    const tombstone = createMemoryTombstoneV1({
      tombstoneId: `tombstone:${suffix}`,
      namespaceRef,
      namespaceGeneration: 1,
      memoryId: `memory:${(index + 1).toString(16).padStart(64, '0')}`,
      deletedRevision: 1,
      deletionKind: 'memory_forgotten',
      deletedAt: NOW,
      deletedByActorRef: eligible
        ? MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1
        : ACTOR_REF,
      reasonCode: eligible ? 'retention_expired' : 'explicit_forget',
      expiresAt
    })
    const wire = encodeMemoryTombstoneV1(tombstone)
    const bytes = Buffer.byteLength(wire, 'utf8')
    insert.run(
      namespaceRef,
      tombstone.tombstoneId,
      tombstone.memoryId,
      Date.parse(tombstone.deletedAt),
      Date.parse(tombstone.expiresAt),
      tombstone.receiptHash,
      wire,
      bytes
    )
    addedBytes += bytes
  }
  target.store.database.prepare(`
    UPDATE usage SET tombstone_records = tombstone_records + 34,
      canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(addedBytes, namespaceRef)
  target.store.database.prepare(`
    UPDATE global_usage SET tombstone_records = tombstone_records + 34,
      canonical_logical_bytes = canonical_logical_bytes + ? WHERE singleton = 1
  `).run(addedBytes)

  target.setNow(expiresAt)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiresAt,
    'tombstone.purgeExpired',
    commandRef('tombstone-scan-purge'),
    1,
    1,
    null,
    1
  ))
  assert.equal(purged.status, 'completed', JSON.stringify(purged))
  if (purged.status !== 'completed') return
  assert.equal(purged.processed, 1)
  assert.equal(purged.hasMore, false)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM tombstones
  `).get()!.value, 33)
})

test('SQLite maintenance scrubs and verifies the exact deleted namespace generation', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('8'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const deleteAt = instantAfterDays(1)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('9'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
  if (deleted.status !== 'deletion_pending') return
  const scrubAt = instantAfterDays(2)
  target.setNow(scrubAt)
  const scrubbed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    scrubAt,
    'namespace.scrubDeleted',
    commandRef('a'),
    2,
    1,
    deleted.receipt.deletionRef
  ))
  assert.equal(scrubbed.status, 'completed', JSON.stringify(scrubbed))
  if (scrubbed.status !== 'completed') return
  assert.equal(scrubbed.processed, 1)
  const verifyAt = instantAfterDays(3)
  target.setNow(verifyAt)
  const verified = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    verifyAt,
    'namespace.verifyScrubbed',
    commandRef('b'),
    2,
    1,
    deleted.receipt.deletionRef
  ))
  assert.equal(verified.status, 'completed', JSON.stringify(verified))
  const checkpointAt = instantAfterDays(4)
  target.setNow(checkpointAt)
  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('c'),
    2
  ))
  assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT canonical_bodies, payload_deletion, wal_checkpoint, derived_cleanup, stage
    FROM namespace_deletion_checkpoints
  `).get()! }, {
    canonical_bodies: 'verified_absent',
    payload_deletion: 'secure_delete_on',
    wal_checkpoint: 'truncated',
    derived_cleanup: 'queued',
    stage: 'canonical_complete'
  })
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals WHERE namespace_generation = 1) AS proposals,
      (SELECT count(*) FROM heads WHERE namespace_generation = 1) AS heads,
      (SELECT count(*) FROM revisions WHERE namespace_generation = 1) AS revisions,
      (SELECT count(*) FROM outbox WHERE namespace_generation = 1) AS outbox
  `).get()! }, { proposals: 0, heads: 0, revisions: 0, outbox: 0 })
})

test('SQLite namespace verification reports remaining carriers without violating batch shape', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('verify-remaining-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const deleteAt = instantAfterDays(1)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('verify-remaining-delete'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
  if (deleted.status !== 'deletion_pending') return

  const verifyAt = instantAfterDays(2)
  target.setNow(verifyAt)
  const verified = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    verifyAt,
    'namespace.verifyScrubbed',
    commandRef('verify-remaining'),
    2,
    1,
    deleted.receipt.deletionRef
  ))
  assert.equal(verified.status, 'completed', JSON.stringify(verified))
  if (verified.status !== 'completed') return
  assert.equal(verified.processed, 1)
  assert.equal(verified.hasMore, false)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT canonical_bodies, stage FROM namespace_deletion_checkpoints
  `).get()! }, { canonical_bodies: 'scrub_pending', stage: 'logical_committed' })
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM heads WHERE namespace_generation = 1
  `).get()!.value, 1)
})

test('SQLite namespace scrub fails closed on an orphan migration manifest', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('orphan-manifest-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const namespaceRef = memoryNamespaceRefV1(fixture.namespace)
  const manifest = createMemoryV1ToV2AggregateManifestV1({
    namespaceRef,
    namespaceGeneration: 1,
    aggregate: {
      kind: 'memory',
      aggregateId: fixture.bundle.record.memoryId,
      proposalState: 'approved',
      proposalRevision: 2,
      currentRevision: 1,
      legacyProposalWireHashes: ['1'.repeat(64), '2'.repeat(64)],
      legacyRevisionWires: [{ revision: 1, legacyWireHash: '3'.repeat(64) }]
    },
    initiatedByActorRef: ACTOR_REF,
    plannedMemoryId: fixture.bundle.record.memoryId,
    intent: { kind: 'create' },
    consentEvidenceId: fixture.bundle.consentEvidence.evidenceId,
    consentEvidenceHash: fixture.bundle.consentEvidence.evidenceHash,
    revisionEvidenceBindings: []
  })
  const manifestWire = encodeMemoryV1ToV2AggregateManifestV1(manifest)
  const manifestBytes = Buffer.byteLength(manifestWire, 'utf8')
  target.store.database.prepare(`
    INSERT INTO memory_v1_to_v2_manifests(
      namespace_ref, namespace_generation, manifest_id, aggregate_kind, aggregate_id,
      manifest_hash, manifest_wire, manifest_wire_bytes, applied_at_ms
    ) VALUES (?, 1, ?, 'memory', ?, ?, ?, ?, ?)
  `).run(
    namespaceRef,
    manifest.manifestId,
    fixture.bundle.record.memoryId,
    manifest.manifestHash,
    manifestWire,
    manifestBytes,
    Date.parse(NOW)
  )
  target.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(manifestBytes, namespaceRef)
  target.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE singleton = 1
  `).run(manifestBytes)

  const deleteAt = instantAfterDays(1)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('orphan-manifest-delete'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
  if (deleted.status !== 'deletion_pending') return

  target.store.database.prepare(`
    UPDATE memory_v1_to_v2_manifests SET aggregate_id = ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(`memory:${'f'.repeat(64)}`, namespaceRef)
  const scrubAt = instantAfterDays(2)
  target.setNow(scrubAt)
  const scrubbed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    scrubAt,
    'namespace.scrubDeleted',
    commandRef('orphan-manifest-scrub'),
    2,
    1,
    deleted.receipt.deletionRef
  ))
  assert.deepEqual(
    scrubbed.status === 'corrupt' ? scrubbed.category : null,
    'canonical_data'
  )
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM heads WHERE namespace_generation = 1) AS heads,
      (SELECT count(*) FROM memory_v1_to_v2_manifests
        WHERE namespace_generation = 1) AS manifests
  `).get()! }, { heads: 1, manifests: 1 })
})

test('SQLite maintenance creates and completes a checkpoint for an exact record forget', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('d'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('e'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const forgotten = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))
  assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))
  if (forgotten.status !== 'deletion_pending') return
  const initialStatus = await target.control.execute(deletionControlRequest(
    fixture.namespace,
    forgetAt,
    'deletion.getStatus',
    forgotten.receipt.deletionRef,
    null
  ))
  assert.equal(initialStatus.status, 'found', JSON.stringify(initialStatus))
  const resolved = await target.control.execute(deletionControlRequest(
    fixture.namespace,
    forgetAt,
    'deletion.resolve',
    forgotten.receipt.deletionRef,
    commandRef('e')
  ))
  assert.equal(resolved.status, 'resolved', JSON.stringify(resolved))
  if (resolved.status === 'resolved') assert.deepEqual(resolved.receipt, forgotten.receipt)
  const checkpointAt = instantAfterDays(2)
  target.setNow(checkpointAt)
  const envelope = maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('f')
  )
  const checkpointed = await target.maintenance.execute(envelope)
  assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
  if (checkpointed.status !== 'completed') return
  assert.equal(checkpointed.processed, 1)
  assert.equal(checkpointed.hasMore, false)
  assert.deepEqual(await target.maintenance.execute(envelope), checkpointed)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT deletion_ref, canonical_bodies, payload_deletion, wal_checkpoint,
      derived_cleanup, stage FROM namespace_deletion_checkpoints
  `).get()! }, {
    deletion_ref: forgotten.status === 'deletion_pending'
      ? forgotten.receipt.deletionRef
      : null,
    canonical_bodies: 'verified_absent',
    payload_deletion: 'secure_delete_on',
    wal_checkpoint: 'truncated',
    derived_cleanup: 'queued',
    stage: 'canonical_complete'
  })
  const wrongResolve = await target.control.execute(deletionControlRequest(
    fixture.namespace,
    checkpointAt,
    'deletion.resolve',
    forgotten.receipt.deletionRef,
    commandRef('0')
  ))
  assert.equal(wrongResolve.status, 'not_found')
})

test('SQLite maintenance recovers an uncheckpointed forget after namespace generation advances', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('old-generation-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')

  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forgetCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('old-generation-forget'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const forgotten = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forgetCommand
  ))
  assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))

  const deleteAt = instantAfterDays(2)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('old-generation-delete'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))

  const checkpointAt = instantAfterDays(3)
  target.setNow(checkpointAt)
  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('old-generation-checkpoint'),
    2
  ))
  assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
  if (checkpointed.status !== 'completed') return
  assert.equal(checkpointed.processed, 2)
  assert.equal(checkpointed.hasMore, false)
  assert.deepEqual(target.store.database.prepare(`
    SELECT deleting_generation, observed_current_generation, stage
    FROM namespace_deletion_checkpoints ORDER BY deletion_ref ASC
  `).all().map(row => ({ ...row })), [
    { deleting_generation: 1, observed_current_generation: 2, stage: 'canonical_complete' },
    { deleting_generation: 1, observed_current_generation: 2, stage: 'canonical_complete' }
  ])
})

test('SQLite deletion checkpoint ignores a valid forget result without a deletion receipt', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('not-found-namespace'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('not-found-forget'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: `memory:${'f'.repeat(64)}`,
    expectedRevision: 1,
    expectedAggregateHash: 'e'.repeat(64),
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const missing = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))
  assert.equal(missing.status, 'not_found', JSON.stringify(missing))

  const checkpointAt = instantAfterDays(2)
  target.setNow(checkpointAt)
  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('not-found-checkpoint')
  ))
  assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
  if (checkpointed.status !== 'completed') return
  assert.equal(checkpointed.processed, 0)
  assert.equal(checkpointed.hasMore, false)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM namespace_deletion_checkpoints
  `).get()!.value, 0)
})

test('SQLite command purge preserves deletion receipts until checkpoint completion', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('retained-receipt-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forgetRef = commandRef('retained-receipt-forget')
  const forget = createMemoryLifecycleCommandV1({
    commandRef: forgetRef,
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))).status, 'deletion_pending')

  const expiry = instantAfterDays(366)
  target.setNow(expiry)
  const beforeCheckpoint = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'command.purgeExpired',
    commandRef('retained-receipt-first-purge')
  ))
  assert.equal(beforeCheckpoint.status, 'completed', JSON.stringify(beforeCheckpoint))
  if (beforeCheckpoint.status !== 'completed') return
  assert.equal(beforeCheckpoint.processed, 1)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE command_ref = ?
  `).get(forgetRef)!.value, 1)

  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'deletion.checkpoint',
    commandRef('retained-receipt-checkpoint')
  ))
  assert.equal(checkpointed.status, 'completed', JSON.stringify(checkpointed))
  if (checkpointed.status !== 'completed') return
  assert.equal(checkpointed.processed, 1)

  const afterCheckpoint = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'command.purgeExpired',
    commandRef('retained-receipt-second-purge')
  ))
  assert.equal(afterCheckpoint.status, 'completed', JSON.stringify(afterCheckpoint))
  if (afterCheckpoint.status !== 'completed') return
  assert.equal(afterCheckpoint.processed, 1)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE command_ref = ?
  `).get(forgetRef)!.value, 0)
})

test('SQLite maintenance resumes a deferred WAL checkpoint with a new command', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('wal-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('wal-forget'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))).status, 'deletion_pending')

  const reader = openSqliteMemoryDatabaseV2({
    location: target.location,
    now: target.now,
    manifests: []
  })
  try {
    reader.database.exec('BEGIN')
    reader.database.prepare('SELECT count(*) AS value FROM namespaces').get()
    const deferredAt = instantAfterDays(2)
    target.setNow(deferredAt)
    const deferred = await target.maintenance.execute(maintenanceEnvelope(
      fixture.namespace,
      deferredAt,
      'deletion.checkpoint',
      commandRef('wal-deferred'),
      1
    ))
    assert.equal(deferred.status, 'completed', JSON.stringify(deferred))
    assert.deepEqual({ ...target.store.database.prepare(`
      SELECT wal_checkpoint, stage FROM namespace_deletion_checkpoints
    `).get()! }, { wal_checkpoint: 'deferred', stage: 'verification_pending' })
    reader.database.exec('COMMIT')

    const resumedAt = instantAfterDays(3)
    target.setNow(resumedAt)
    const resumed = await target.maintenance.execute(maintenanceEnvelope(
      fixture.namespace,
      resumedAt,
      'deletion.checkpoint',
      commandRef('wal-resumed'),
      1
    ))
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
    assert.deepEqual({ ...target.store.database.prepare(`
      SELECT wal_checkpoint, stage FROM namespace_deletion_checkpoints
    `).get()! }, { wal_checkpoint: 'truncated', stage: 'canonical_complete' })
  } finally {
    try { reader.database.exec('ROLLBACK') } catch {}
    reader.close()
  }
})

test('SQLite deletion resolve and checkpoint reject command ledger drift', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('deletion-ledger-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forgetRef = commandRef('deletion-ledger-forget')
  const forget = createMemoryLifecycleCommandV1({
    commandRef: forgetRef,
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const forgotten = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))
  assert.equal(forgotten.status, 'deletion_pending', JSON.stringify(forgotten))
  if (forgotten.status !== 'deletion_pending') return
  const ledger = target.store.database.prepare(`
    SELECT command_hash, aggregate_ref_hash, expires_at_ms
    FROM lifecycle_commands WHERE command_ref = ?
  `).get(forgetRef)
  assert.notEqual(ledger, undefined)
  if (ledger === undefined) return
  for (const column of ['command_hash', 'aggregate_ref_hash'] as const) {
    const original = String(ledger[column])
    target.store.database.prepare(`
      UPDATE lifecycle_commands SET ${column} = ? WHERE command_ref = ?
    `).run(alterHash(original), forgetRef)
    const resolved = await target.control.execute(deletionControlRequest(
      fixture.namespace,
      forgetAt,
      'deletion.resolve',
      forgotten.receipt.deletionRef,
      forgetRef
    ))
    assert.deepEqual(
      resolved.status === 'corrupt' ? resolved.category : null,
      'canonical_data'
    )
    target.store.database.prepare(`
      UPDATE lifecycle_commands SET ${column} = ? WHERE command_ref = ?
    `).run(original, forgetRef)
  }
  target.store.database.prepare(`
    UPDATE lifecycle_commands SET expires_at_ms = expires_at_ms + 1 WHERE command_ref = ?
  `).run(forgetRef)
  const expiryDrift = await target.control.execute(deletionControlRequest(
    fixture.namespace,
    forgetAt,
    'deletion.resolve',
    forgotten.receipt.deletionRef,
    forgetRef
  ))
  assert.deepEqual(
    expiryDrift.status === 'corrupt' ? expiryDrift.category : null,
    'canonical_data'
  )
  target.store.database.prepare(`
    UPDATE lifecycle_commands SET expires_at_ms = ? WHERE command_ref = ?
  `).run(ledger.expires_at_ms, forgetRef)
  target.store.database.prepare(`
    UPDATE lifecycle_commands SET command_hash = ? WHERE command_ref = ?
  `).run(alterHash(String(ledger.command_hash)), forgetRef)

  const checkpointAt = instantAfterDays(2)
  target.setNow(checkpointAt)
  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('deletion-ledger-checkpoint')
  ))
  assert.deepEqual(
    checkpointed.status === 'corrupt' ? checkpointed.category : null,
    'canonical_data'
  )
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM namespace_deletion_checkpoints
  `).get()!.value, 0)
})

test('SQLite deletion checkpoint rejects tombstone wire-column drift', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('tombstone-drift-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const forgetAt = instantAfterDays(1)
  target.setNow(forgetAt)
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('tombstone-drift-forget'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: forgetAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    forgetAt,
    1,
    ['forget'],
    forget
  ))).status, 'deletion_pending')
  target.store.database.prepare(`
    UPDATE tombstones SET expires_at_ms = expires_at_ms + 1
  `).run()

  const checkpointAt = instantAfterDays(2)
  target.setNow(checkpointAt)
  const checkpointed = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    checkpointAt,
    'deletion.checkpoint',
    commandRef('tombstone-drift-checkpoint')
  ))
  assert.deepEqual(
    checkpointed.status === 'corrupt' ? checkpointed.category : null,
    'canonical_data'
  )
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM namespace_deletion_checkpoints
  `).get()!.value, 0)
})

test('SQLite deletion status and maintenance reject a checkpoint receipt mismatch', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('checkpoint-receipt-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const deleteAt = instantAfterDays(1)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('checkpoint-receipt-delete'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))
  assert.equal(deleted.status, 'deletion_pending', JSON.stringify(deleted))
  if (deleted.status !== 'deletion_pending') return
  target.store.database.prepare(`
    UPDATE namespace_deletion_checkpoints SET receipt_hash = ?
  `).run('f'.repeat(64))

  const status = await target.control.execute(deletionControlRequest(
    fixture.namespace,
    deleteAt,
    'deletion.getStatus',
    deleted.receipt.deletionRef,
    null,
    2
  ))
  assert.deepEqual(status.status === 'corrupt' ? status.category : null, 'canonical_data')

  const verifyAt = instantAfterDays(2)
  target.setNow(verifyAt)
  const verified = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    verifyAt,
    'namespace.verifyScrubbed',
    commandRef('checkpoint-receipt-verify'),
    2,
    1,
    deleted.receipt.deletionRef
  ))
  assert.deepEqual(verified.status === 'corrupt' ? verified.category : null, 'canonical_data')
})

test('SQLite tombstone purge rejects a forged canonical-complete checkpoint column', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('forged-stage-direct'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const deleteAt = instantAfterDays(1)
  target.setNow(deleteAt)
  const deleteCommand = createMemoryLifecycleCommandV1({
    commandRef: commandRef('forged-stage-delete'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(fixture.namespace),
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: deleteAt,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    deleteAt,
    1,
    ['delete_namespace'],
    deleteCommand
  ))).status, 'deletion_pending')
  target.store.database.prepare(`
    UPDATE namespace_deletion_checkpoints SET stage = 'canonical_complete'
  `).run()

  const expiry = instantAfterDays(31)
  target.setNow(expiry)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'tombstone.purgeExpired',
    commandRef('forged-stage-purge'),
    2
  ))
  assert.deepEqual(purged.status === 'corrupt' ? purged.category : null, 'canonical_data')
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM tombstones) AS tombstones,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS checkpoints,
      (SELECT count(*) FROM heads WHERE namespace_generation = 1) AS heads
  `).get()! }, { tombstones: 1, checkpoints: 1, heads: 1 })
})

test('SQLite maintenance enforces a 32 aggregate batch and resumes with a new command', async t => {
  const target = harness(t)
  let namespace: MemoryNamespaceV1 | null = null
  for (let index = 0; index < 33; index += 1) {
    const fixture = pendingFixture(commandRef(index.toString(16)), NOW)
    namespace = fixture.namespace
    const stored = await target.mutation.execute(actorEnvelope(
      fixture.namespace,
      NOW,
      1,
      ['propose_create'],
      fixture.command
    ))
    assert.equal(stored.status, 'stored', `seed ${index}: ${JSON.stringify(stored)}`)
  }
  assert.notEqual(namespace, null)
  if (namespace === null) return
  const future = instantAfterDays(8)
  target.setNow(future)
  const first = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    future,
    'proposal.expireDue',
    commandRef('x'),
    1,
    1,
    null,
    32
  ))
  assert.equal(first.status, 'completed', JSON.stringify(first))
  if (first.status !== 'completed') return
  assert.equal(first.processed, 32)
  assert.equal(first.hasMore, true)
  const second = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    future,
    'proposal.expireDue',
    commandRef('y')
  ))
  assert.equal(second.status, 'completed', JSON.stringify(second))
  if (second.status !== 'completed') return
  assert.equal(second.processed, 1)
  assert.equal(second.hasMore, false)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM proposals WHERE state = 'pending'
  `).get()!.value, 0)
})

test('SQLite maintenance prunes decided proposal wire without deleting its live record', async t => {
  const target = harness(t)
  const fixture = directFixture(commandRef('g'))
  assert.equal((await target.direct.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create', 'approve'],
    fixture.command
  ))).status, 'stored')
  const future = instantAfterDays(31)
  target.setNow(future)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.purgeDecided',
    commandRef('h')
  ))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  if (result.status !== 'completed') return
  assert.equal(result.processed, 1)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM consent_evidence) AS evidence,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM lifecycle_audits WHERE operation = 'proposal_pruned') AS audits
  `).get()! }, { proposals: 0, evidence: 0, heads: 1, revisions: 1, audits: 1 })
})

test('SQLite maintenance purges expired audit and verified command ledgers', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('i'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const pruneAt = instantAfterDays(38)
  target.setNow(pruneAt)
  assert.equal((await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    pruneAt,
    'proposal.expireDue',
    commandRef('j')
  ))).status, 'completed')
  const expiry = new Date(Date.parse(pruneAt) + 365 * DAY_MS).toISOString()
  target.setNow(expiry)
  const audit = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'audit.purgeExpired',
    commandRef('k')
  ))
  assert.equal(audit.status, 'completed', JSON.stringify(audit))
  if (audit.status !== 'completed') return
  assert.equal(audit.processed, 1)
  assert.equal(target.store.database.prepare('SELECT count(*) AS value FROM lifecycle_audits').get()!.value, 0)
  const commandsBefore = Number(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE expires_at_ms <= ?
  `).get(Date.parse(expiry))!.value)
  const commands = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'command.purgeExpired',
    commandRef('l')
  ))
  assert.equal(commands.status, 'completed', JSON.stringify(commands))
  if (commands.status !== 'completed') return
  assert.equal(commands.processed, commandsBefore)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE expires_at_ms <= ?
  `).get(Date.parse(expiry))!.value, 0)
})

test('SQLite audit purge rolls the whole batch back on a wire-column mismatch', async t => {
  const target = harness(t)
  for (const suffix of ['audit-a', 'audit-b']) {
    const fixture = pendingFixture(commandRef(suffix))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.namespace,
      NOW,
      1,
      ['propose_create'],
      fixture.command
    ))).status, 'stored')
  }
  const namespace = personalMemoryNamespaceFixture()
  const pruneAt = instantAfterDays(38)
  target.setNow(pruneAt)
  assert.equal((await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    pruneAt,
    'proposal.expireDue',
    commandRef('audit-prune')
  ))).status, 'completed')
  const audits = target.store.database.prepare(`
    SELECT audit_id FROM lifecycle_audits ORDER BY audit_id ASC
  `).all()
  assert.equal(audits.length, 2)
  target.store.database.prepare(`
    UPDATE lifecycle_audits SET operation = 'export_failed' WHERE audit_id = ?
  `).run(audits[1]?.audit_id)

  const expiry = new Date(Date.parse(pruneAt) + 365 * DAY_MS).toISOString()
  target.setNow(expiry)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    expiry,
    'audit.purgeExpired',
    commandRef('audit-corrupt')
  ))
  assert.deepEqual(purged.status === 'corrupt' ? purged.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_audits
  `).get()!.value, 2)
})

test('SQLite audit purge rolls the whole batch back on a corrupted audit wire', async t => {
  const target = harness(t)
  for (const suffix of ['audit-wire-a', 'audit-wire-b']) {
    const fixture = pendingFixture(commandRef(suffix))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.namespace,
      NOW,
      1,
      ['propose_create'],
      fixture.command
    ))).status, 'stored')
  }
  const namespace = personalMemoryNamespaceFixture()
  const pruneAt = instantAfterDays(38)
  target.setNow(pruneAt)
  assert.equal((await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    pruneAt,
    'proposal.expireDue',
    commandRef('audit-wire-prune')
  ))).status, 'completed')
  const audits = target.store.database.prepare(`
    SELECT audit_id, command_ref_hash, audit_wire
    FROM lifecycle_audits ORDER BY audit_id ASC
  `).all()
  assert.equal(audits.length, 2)
  const originalHash = String(audits[1]?.command_ref_hash)
  const originalWire = String(audits[1]?.audit_wire)
  const corruptedWire = originalWire.replace(originalHash, alterHash(originalHash))
  assert.notEqual(corruptedWire, originalWire)
  assert.equal(Buffer.byteLength(corruptedWire), Buffer.byteLength(originalWire))
  target.store.database.prepare(`
    UPDATE lifecycle_audits SET audit_wire = ? WHERE audit_id = ?
  `).run(corruptedWire, audits[1]?.audit_id)

  const expiry = new Date(Date.parse(pruneAt) + 365 * DAY_MS).toISOString()
  target.setNow(expiry)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    expiry,
    'audit.purgeExpired',
    commandRef('audit-wire-corrupt')
  ))
  assert.deepEqual(purged.status === 'corrupt' ? purged.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_audits
  `).get()!.value, 2)
})

test('SQLite command purge rolls the whole batch back on a command hash mismatch', async t => {
  const target = harness(t)
  for (const suffix of ['command-a', 'command-b']) {
    const fixture = pendingFixture(commandRef(suffix))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.namespace,
      NOW,
      1,
      ['propose_create'],
      fixture.command
    ))).status, 'stored')
  }
  const namespace = personalMemoryNamespaceFixture()
  const rows = target.store.database.prepare(`
    SELECT command_ref FROM lifecycle_commands ORDER BY command_ref ASC
  `).all()
  assert.equal(rows.length, 2)
  target.store.database.prepare(`
    UPDATE lifecycle_commands SET command_hash = ? WHERE command_ref = ?
  `).run('f'.repeat(64), rows[1]?.command_ref)

  const expiry = instantAfterDays(365)
  target.setNow(expiry)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    expiry,
    'command.purgeExpired',
    commandRef('command-corrupt')
  ))
  assert.deepEqual(purged.status === 'corrupt' ? purged.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE expires_at_ms <= ?
  `).get(Date.parse(expiry))!.value, 2)
})

test('SQLite command purge rolls the whole batch back on a corrupted result wire', async t => {
  const target = harness(t)
  for (const suffix of ['result-wire-a', 'result-wire-b']) {
    const fixture = pendingFixture(commandRef(suffix))
    assert.equal((await target.mutation.execute(actorEnvelope(
      fixture.namespace,
      NOW,
      1,
      ['propose_create'],
      fixture.command
    ))).status, 'stored')
  }
  const namespace = personalMemoryNamespaceFixture()
  const rows = target.store.database.prepare(`
    SELECT command_ref, command_hash, result_wire
    FROM lifecycle_commands ORDER BY command_ref ASC
  `).all()
  assert.equal(rows.length, 2)
  const originalHash = String(rows[1]?.command_hash)
  const originalWire = String(rows[1]?.result_wire)
  const corruptedWire = originalWire.replace(originalHash, alterHash(originalHash))
  assert.notEqual(corruptedWire, originalWire)
  assert.equal(Buffer.byteLength(corruptedWire), Buffer.byteLength(originalWire))
  target.store.database.prepare(`
    UPDATE lifecycle_commands SET result_wire = ? WHERE command_ref = ?
  `).run(corruptedWire, rows[1]?.command_ref)

  const expiry = instantAfterDays(365)
  target.setNow(expiry)
  const purged = await target.maintenance.execute(maintenanceEnvelope(
    namespace,
    expiry,
    'command.purgeExpired',
    commandRef('result-wire-corrupt')
  ))
  assert.deepEqual(purged.status === 'corrupt' ? purged.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM lifecycle_commands WHERE expires_at_ms <= ?
  `).get(Date.parse(expiry))!.value, 2)
})

test('SQLite maintenance releases expired export audit reservation but preserves prepared job', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('m'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const { expiresAt } = seedPreparedExportReservation(target, fixture.namespace, 'release')
  const expiry = new Date(expiresAt).toISOString()
  target.setNow(expiry)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'export.releaseExpiredReservations',
    commandRef('n')
  ))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  if (result.status !== 'completed') return
  assert.equal(result.processed, 1)
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM export_audit_reservations) AS reservations,
      (SELECT count(*) FROM export_jobs WHERE state = 'prepared') AS prepared_jobs
  `).get()! }, { reservations: 0, prepared_jobs: 1 })
})

test('SQLite maintenance preserves an expired reservation with a terminal export audit', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('terminal-export-namespace'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const seeded = seedPreparedExportReservation(target, fixture.namespace, 'terminal')
  const audit = createMemoryLifecycleAuditV1({
    namespaceRef: seeded.namespaceRef,
    namespaceGeneration: 1,
    operation: 'export_completed',
    commandRefHash: '1'.repeat(64),
    aggregateKind: 'export',
    aggregateRefHash: memoryLifecycleDomainHashV1(
      'groupmate.memory.export-ref.v1',
      seeded.exportId
    ),
    authorizedByActorRefHash: '2'.repeat(64),
    executedByActorRefHash: '3'.repeat(64),
    sourceCommittedAt: NOW,
    recordedAt: NOW,
    outcome: 'completed',
    repositoryReceiptHash: '4'.repeat(64),
    priorRevision: null,
    nextRevision: null,
    exclusionsHash: '5'.repeat(64)
  })
  const auditWire = encodeMemoryLifecycleAuditV1(audit)
  const auditBytes = Buffer.byteLength(auditWire, 'utf8')
  target.store.database.prepare(`
    INSERT INTO lifecycle_audits(
      namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
      source_committed_at_ms, recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    seeded.namespaceRef,
    audit.auditId,
    audit.operation,
    audit.commandRefHash,
    audit.aggregateRefHash,
    audit.authorizedByActorRefHash,
    audit.executedByActorRefHash,
    Date.parse(audit.sourceCommittedAt),
    Date.parse(audit.recordedAt),
    Date.parse(audit.expiresAt),
    auditWire,
    auditBytes
  )
  target.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = canonical_logical_bytes + ?,
      lifecycle_audit_records = lifecycle_audit_records + 1,
      lifecycle_audit_logical_bytes = lifecycle_audit_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = 1
  `).run(auditBytes, auditBytes, seeded.namespaceRef)
  target.store.database.prepare(`
    UPDATE lifecycle_namespace_usage SET
      lifecycle_audit_records = lifecycle_audit_records + 1,
      lifecycle_audit_logical_bytes = lifecycle_audit_logical_bytes + ?
    WHERE namespace_ref = ?
  `).run(auditBytes, seeded.namespaceRef)
  target.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + ?,
      lifecycle_audit_records = lifecycle_audit_records + 1,
      lifecycle_audit_logical_bytes = lifecycle_audit_logical_bytes + ?
    WHERE singleton = 1
  `).run(auditBytes, auditBytes)

  const expiry = new Date(seeded.expiresAt).toISOString()
  target.setNow(expiry)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'export.releaseExpiredReservations',
    commandRef('terminal-export-release')
  ))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  if (result.status !== 'completed') return
  assert.equal(result.processed, 0)
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM export_audit_reservations
  `).get()!.value, 1)
})

test('SQLite maintenance rejects a reservation that no longer binds its prepared job', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('mismatched-export-namespace'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const seeded = seedPreparedExportReservation(target, fixture.namespace, 'mismatch')
  target.store.database.prepare(`
    UPDATE export_audit_reservations SET command_hash = ? WHERE export_id = ?
  `).run('f'.repeat(64), seeded.exportId)
  const expiry = new Date(seeded.expiresAt).toISOString()
  target.setNow(expiry)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    expiry,
    'export.releaseExpiredReservations',
    commandRef('mismatched-export-release')
  ))
  assert.deepEqual(result.status === 'corrupt' ? result.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare(`
    SELECT count(*) AS value FROM export_audit_reservations
  `).get()!.value, 1)
})

test('SQLite maintenance rolls back the complete batch at the command ledger hard limit', async t => {
  const target = harness(t)
  const fixture = pendingFixture(commandRef('capacity-namespace'))
  assert.equal((await target.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const namespaceRef = memoryNamespaceRefV1(fixture.namespace)
  const aggregateRef = `memory:${'9'.repeat(64)}`
  const aggregateRefHash = memoryLifecycleDomainHashV1(
    'groupmate.memory.lifecycle-aggregate-ref.v1',
    aggregateRef
  )
  const insert = target.store.database.prepare(`
    INSERT INTO lifecycle_commands(
      namespace_ref, namespace_generation, command_ref, command_hash, operation,
      aggregate_ref_hash, result_wire, result_wire_bytes, result_hash,
      committed_at_ms, expires_at_ms
    ) VALUES (?, 1, ?, ?, 'record.forget', ?, ?, ?, ?, ?, ?)
  `)
  const additional =
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace - 1
  let additionalBytes = 0
  target.store.database.exec('BEGIN IMMEDIATE')
  try {
    for (let index = 0; index < additional; index += 1) {
      const ref = commandRef(`capacity-ledger-${index}`)
      const command = createMemoryLifecycleCommandV1({
        commandRef: ref,
        operation: 'record.forget',
        initiatedByActorRef: ACTOR_REF,
        namespaceRef,
        expectedNamespaceGeneration: 1,
        aggregateRef,
        expectedRevision: 1,
        expectedAggregateHash: '8'.repeat(64),
        occurredAt: NOW,
        newValidUntil: null,
        newPurgeAt: null,
        material: null
      })
      const commandHash = memoryLifecycleCommandHashV1(command.wire)
      const result = createMemoryLifecycleStableResultV1({
        schemaVersion: 1,
        operation: 'record.forget',
        commandHash,
        status: 'not_found'
      })
      const resultWire = encodeMemoryLifecycleStableResultWireV1(result)
      const resultBytes = Buffer.byteLength(resultWire, 'utf8')
      insert.run(
        namespaceRef,
        ref,
        commandHash,
        aggregateRefHash,
        resultWire,
        resultBytes,
        memoryLifecycleStableResultHashV1(resultWire),
        Date.parse(NOW),
        Date.parse(NOW) +
          MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerTtlMs
      )
      additionalBytes += resultBytes
    }
    target.store.database.prepare(`
      UPDATE usage SET canonical_logical_bytes = canonical_logical_bytes + ?,
        lifecycle_command_records = lifecycle_command_records + ?,
        lifecycle_command_logical_bytes = lifecycle_command_logical_bytes + ?
      WHERE namespace_ref = ? AND namespace_generation = 1
    `).run(additionalBytes, additional, additionalBytes, namespaceRef)
    target.store.database.prepare(`
      UPDATE lifecycle_namespace_usage SET lifecycle_command_records =
        lifecycle_command_records + ?, lifecycle_command_logical_bytes =
        lifecycle_command_logical_bytes + ? WHERE namespace_ref = ?
    `).run(additional, additionalBytes, namespaceRef)
    target.store.database.prepare(`
      UPDATE global_usage SET canonical_logical_bytes = canonical_logical_bytes + ?,
        lifecycle_command_records = lifecycle_command_records + ?,
        lifecycle_command_logical_bytes = lifecycle_command_logical_bytes + ?
      WHERE singleton = 1
    `).run(additionalBytes, additional, additionalBytes)
    target.store.database.exec('COMMIT')
  } catch (error) {
    target.store.database.exec('ROLLBACK')
    throw error
  }

  const future = instantAfterDays(8)
  target.setNow(future)
  const result = await target.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.expireDue',
    commandRef('capacity-maintenance')
  ))
  assert.deepEqual(
    result.status === 'capacity' ? result.category : null,
    'maintenance_capacity'
  )
  assert.deepEqual({ ...target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM lifecycle_commands) AS commands,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending,
      (SELECT count(*) FROM outbox) AS outbox
  `).get()! }, {
    commands: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace,
    pending: 1,
    outbox: 1
  })
})

test('SQLite maintenance rolls a late ledger failure back and reports real write contention', async t => {
  const rollback = harness(t)
  const fixture = pendingFixture(commandRef('o'))
  assert.equal((await rollback.mutation.execute(actorEnvelope(
    fixture.namespace,
    NOW,
    1,
    ['propose_create'],
    fixture.command
  ))).status, 'stored')
  const future = instantAfterDays(8)
  rollback.setNow(future)
  rollback.store.database.exec(`
    CREATE TEMP TRIGGER ignore_maintenance_ledger
    BEFORE INSERT ON lifecycle_commands
    WHEN NEW.operation = 'proposal.expireDue'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `)
  const failed = await rollback.maintenance.execute(maintenanceEnvelope(
    fixture.namespace,
    future,
    'proposal.expireDue',
    commandRef('p')
  ))
  assert.deepEqual(failed.status === 'corrupt' ? failed.category : null, 'canonical_data')
  assert.deepEqual({ ...rollback.store.database.prepare(`
    SELECT revision, state, decided_at_ms FROM proposals
  `).get()! }, { revision: 1, state: 'pending', decided_at_ms: null })

  const directory = mkdtempSync(join(tmpdir(), 'groupmate-maintenance-busy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let now = NOW
  const first = openSqliteMemoryDatabaseV2({ location, now: () => now, manifests: [] })
  const second = openSqliteMemoryDatabaseV2({ location, now: () => now, manifests: [] })
  try {
    const seeded = pendingFixture(commandRef('q'))
    const mutation = createMemoryLifecyclePortV1({
      now: () => now,
      execute: createSqliteMemoryLifecycleMutationAdapterV1({
        database: first.database,
        now: () => now
      }).execute
    })
    assert.equal((await mutation.execute(actorEnvelope(
      seeded.namespace,
      NOW,
      1,
      ['propose_create'],
      seeded.command
    ))).status, 'stored')
    now = instantAfterDays(8)
    second.database.exec('PRAGMA busy_timeout = 1')
    first.database.exec('BEGIN IMMEDIATE')
    const maintenance = createMemoryMaintenancePortV1({
      now: () => now,
      execute: createSqliteMemoryMaintenanceAdapterV1({
        database: second.database,
        now: () => now
      }).execute
    })
    const busy = await maintenance.execute(maintenanceEnvelope(
      seeded.namespace,
      now,
      'proposal.expireDue',
      commandRef('r')
    ))
    assert.deepEqual(busy.status === 'unavailable'
      ? { category: busy.category, retryable: busy.retryable }
      : null, { category: 'busy', retryable: true })
  } finally {
    try { first.database.exec('ROLLBACK') } catch {}
    second.close()
    first.close()
  }
})
