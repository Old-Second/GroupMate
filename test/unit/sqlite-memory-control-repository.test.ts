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
  issueMemoryLifecycleActorCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryCorrectionBundleV1,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  encodeMemoryLifecycleAuditV1,
  encodeMemoryRevisionEvidenceV1,
  encodeMemoryRevisionV2
} from '../../src/agent/memory/memory-lifecycle-codec.js'
import {
  createMemoryLifecycleCommandV1,
  decodeMemoryLifecycleCommandWireV1,
  memoryLifecycleCommandHashV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  createMemoryLifecycleAuditV1
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  createMemoryControlRepositoryPortV1
} from '../../src/agent/memory/memory-control-repository.js'
import {
  createMemoryLifecyclePortV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import {
  encodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleStableResultHashV1
} from '../../src/agent/memory/memory-lifecycle-result.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { encodeMemoryTombstoneV1 } from '../../src/agent/memory/memory-codec.js'
import { createMemoryTombstoneV1 } from '../../src/agent/memory/memory-domain.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from '../../src/agent/memory/memory-resource-limits.js'
import {
  openSqliteMemoryDatabaseV2
} from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryControlRepositoryV1
} from '../../src/agent/memory/sqlite-memory-control-repository.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  MEMORY_CURSOR_HASH_DOMAIN_V1
} from '../../src/agent/memory/sqlite-memory-repository.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-24T08:00:00.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`

function commandRef (suffix: string): string {
  return `command:${suffix.repeat(64).slice(0, 64)}`
}

function groupNamespace (): MemoryNamespaceV1 {
  return createMemoryNamespaceV1({
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scope: {
      kind: 'group',
      groupId: FIXTURE_IDS.groupId,
      groupLifecycleId: FIXTURE_IDS.groupLifecycleId
    }
  })
}

function directCommand (
  now = NOW,
  ref = commandRef('1'),
  text = '喜欢无糖咖啡',
  generation = 1
) {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture()
  const pending = buildMemoryProposalDraftV2({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: generation,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text,
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
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: ref,
    operation: 'proposal.createAndApprove',
    namespaceRef: pending.namespaceRef,
    namespaceGeneration: generation,
    proposal: pending,
    approvedByActorRef: ACTOR_REF,
    freshNow: now,
    evidenceSource: source,
    reason: null
  })
  return Object.freeze({
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'proposal.createAndApprove',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: pending.namespaceRef,
      expectedNamespaceGeneration: generation,
      aggregateRef: null,
      expectedRevision: null,
      expectedAggregateHash: null,
      occurredAt: now,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  })
}

type ActorRole = 'personal_subject' | 'group_bot_master'

function authorization (
  namespace: MemoryNamespaceV1,
  now: string,
  role: ActorRole,
  actions: readonly string[],
  options: {
    readonly generation?: number
    readonly accessVerifier?: () => boolean
    readonly actorVerifier?: () => boolean
  } = {}
) {
  const generation = options.generation ?? 1
  const actorUserId = namespace.scope.kind === 'personal'
    ? namespace.scope.subjectUserId
    : FIXTURE_IDS.subjectUserId
  const scene = namespace.scope.kind === 'personal'
    ? { kind: 'private' as const, peerUserId: namespace.scope.subjectUserId }
    : {
        kind: 'group' as const,
        groupId: namespace.scope.groupId,
        groupLifecycleId: namespace.scope.groupLifecycleId,
        trustedMemberUserIds: [actorUserId],
        observedAt: now
      }
  const context = {
    schemaVersion: 1 as const,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq' as const,
    accountId: namespace.accountId,
    scene
  }
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(options.accessVerifier ?? (() => true)),
    context,
    [namespace],
    now
  )
  const actor = issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(options.actorVerifier ?? (() => true)),
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
      actorUserId,
      role,
      roleObservedAt: namespace.scope.kind === 'group' ? now : null,
      actions
    },
    now
  )
  return Object.freeze({ access, actor })
}

function lifecycleEnvelope (commandValue: ReturnType<typeof directCommand>['command'], now = NOW) {
  const namespace = personalMemoryNamespaceFixture()
  const generation = decodeMemoryLifecycleCommandWireV1(commandValue.wire)
    .expectedNamespaceGeneration
  const auth = authorization(
    namespace,
    now,
    'personal_subject',
    ['propose_create', 'approve'],
    { generation }
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    command: commandValue,
    access: auth.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: auth.actor })
  })
}

function controlRequestBase (
  operation: string,
  namespace: MemoryNamespaceV1,
  now: string,
  role: ActorRole = 'personal_subject',
  actions: readonly string[] = ['inspect_full'],
  generation = 1
) {
  const auth = authorization(namespace, now, role, actions, { generation })
  return {
    schemaVersion: 1 as const,
    operation,
    botInstanceId: namespace.botInstanceId,
    accountId: namespace.accountId,
    sceneRef: auth.access.sceneRef,
    namespaceRef: memoryNamespaceRefV1(namespace),
    generation,
    actorRef: ACTOR_REF,
    access: auth.access,
    actor: auth.actor
  }
}

function harness (t: TestContext, initialNow = NOW) {
  let currentNow = initialNow
  const now = () => currentNow
  const store = openSqliteMemoryDatabaseV2({ location: ':memory:', now, manifests: [] })
  t.after(store.close)
  const lifecycleAdapter = createSqliteMemoryLifecycleProposalAdapterV1({
    database: store.database,
    now
  })
  const controlAdapter = createSqliteMemoryControlRepositoryV1({
    database: store.database,
    now
  })
  return Object.freeze({
    store,
    now,
    setNow: (value: string) => { currentNow = value },
    lifecycleAdapter,
    controlAdapter,
    lifecycle: createMemoryLifecyclePortV1({ now, execute: lifecycleAdapter.execute }),
    control: createMemoryControlRepositoryPortV1({ now, execute: controlAdapter.execute })
  })
}

async function saveDirect (
  target: ReturnType<typeof harness>,
  commandValue = directCommand(),
  now = NOW
) {
  return target.lifecycle.execute(lifecycleEnvelope(commandValue.command, now))
}

function insertTombstone (
  target: ReturnType<typeof harness>,
  value: ReturnType<typeof createMemoryTombstoneV1>
): void {
  const wire = encodeMemoryTombstoneV1(value)
  target.store.database.prepare(`
    INSERT INTO tombstones(
      namespace_ref, namespace_generation, tombstone_id, memory_id, deleted_revision,
      deletion_kind, deleted_at_ms, expires_at_ms, receipt_hash,
      tombstone_wire, tombstone_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.namespaceRef,
    value.namespaceGeneration,
    value.tombstoneId,
    value.memoryId,
    value.deletedRevision,
    value.deletionKind,
    Date.parse(value.deletedAt),
    Date.parse(value.expiresAt),
    value.receiptHash,
    wire,
    Buffer.byteLength(wire, 'utf8')
  )
}

function insertAudit (
  target: ReturnType<typeof harness>,
  value: ReturnType<typeof createMemoryLifecycleAuditV1>
): void {
  const wire = encodeMemoryLifecycleAuditV1(value)
  target.store.database.prepare(`
    INSERT INTO lifecycle_audits(
      namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
      source_committed_at_ms, recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.namespaceRef,
    value.namespaceGeneration,
    value.auditId,
    value.operation,
    value.commandRefHash,
    value.aggregateRefHash,
    value.authorizedByActorRefHash,
    value.executedByActorRefHash,
    Date.parse(value.sourceCommittedAt),
    Date.parse(value.recordedAt),
    Date.parse(value.expiresAt),
    wire,
    Buffer.byteLength(wire, 'utf8')
  )
}

test('SQLite v2 createAndApprove commits the complete aggregate and exact replay atomically', async t => {
  const target = harness(t)
  const fixture = directCommand()
  const first = await saveDirect(target, fixture)
  assert.equal(first.status, 'stored')
  assert.equal('resultRef' in first ? first.resultRef : null, fixture.bundle.record.memoryId)

  const counts = target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM consent_evidence) AS evidence,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM lifecycle_commands) AS commands
  `).get()
  assert.deepEqual({ ...counts }, {
    proposals: 1,
    evidence: 1,
    revisions: 1,
    heads: 1,
    outbox: 2,
    commands: 1
  })
  assert.deepEqual(await saveDirect(target, fixture), first)
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 2)
})

test('SQLite v2 createAndApprove rejects a same-ref command collision without partial rows', async t => {
  const target = harness(t)
  const first = directCommand(NOW, commandRef('2'), '喜欢无糖咖啡')
  const collision = directCommand(NOW, commandRef('2'), '喜欢低因咖啡')
  assert.equal((await saveDirect(target, first)).status, 'stored')
  const result = await saveDirect(target, collision)
  assert.deepEqual(
    result.status === 'conflict' ? result.category : null,
    'idempotency'
  )
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM proposals').get()?.count, 1)
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 2)
})

test('SQLite v2 createAndApprove uses locked soft capacity and leaves a fresh namespace absent', async t => {
  const target = harness(t)
  target.store.database.prepare(`
    UPDATE global_usage SET canonical_logical_bytes = ? WHERE singleton = 1
  `).run(MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes - (8 * 1_024 * 1_024))
  const result = await saveDirect(target)
  assert.deepEqual(
    result.status === 'capacity' ? result.category : null,
    'canonical_bytes'
  )
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 0)
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM proposals').get()?.count, 0)
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 0)
})

test('direct save reserves namespace, outbox and command-ledger capacity dimensions', async t => {
  const cases = [
    {
      column: 'namespace_records',
      value: MEMORY_RESOURCE_LIMITS.deploymentNamespaces,
      category: 'namespaces'
    },
    {
      column: 'pending_outbox_records',
      value: MEMORY_RESOURCE_LIMITS.unackedOutboxRecords - 256,
      category: 'outbox_records'
    },
    {
      column: 'outbox_logical_bytes',
      value: MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes - (1 * 1_024 * 1_024),
      category: 'outbox_bytes'
    },
    {
      column: 'lifecycle_command_records',
      value: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerDeployment,
      category: 'command_ledger'
    }
  ] as const
  for (const [index, value] of cases.entries()) {
    const target = harness(t)
    target.store.database.prepare(`UPDATE global_usage SET ${value.column} = ?`).run(value.value)
    const result = await saveDirect(
      target,
      directCommand(NOW, commandRef(['4', '5', '6', '7'][index]!))
    )
    assert.deepEqual(result.status === 'capacity' ? result.category : null, value.category)
    assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 0)
  }

  const namespaceTarget = harness(t)
  assert.equal((await saveDirect(namespaceTarget, directCommand(NOW, commandRef('f')))).status, 'stored')
  namespaceTarget.store.database.prepare(`
    UPDATE usage SET canonical_logical_bytes = ?
  `).run(MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes - (2 * 1_024 * 1_024))
  const namespaceCapacity = await saveDirect(
    namespaceTarget,
    directCommand(NOW, commandRef('0'), '第二条偏好')
  )
  assert.deepEqual(
    namespaceCapacity.status === 'capacity' ? namespaceCapacity.category : null,
    'canonical_bytes'
  )
})

test('direct save fails closed when namespace capacity counters understate canonical rows', async t => {
  const target = harness(t)
  assert.equal((await saveDirect(target, directCommand(NOW, commandRef('c')))).status, 'stored')
  target.store.database.prepare(`
    UPDATE usage SET active_memory_records = 0
  `).run()
  const result = await saveDirect(
    target,
    directCommand(NOW, commandRef('d'), '第二条偏好')
  )
  assert.deepEqual(result.status === 'corrupt' ? result.category : null, 'canonical_data')
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM heads').get()?.count, 1)
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM proposals').get()?.count, 1)
})

test('direct save keeps generation, namespace and deployment command usage distinct', async t => {
  const target = harness(t)
  const first = directCommand(NOW, commandRef('1'), '第一代偏好', 1)
  assert.equal((await saveDirect(target, first)).status, 'stored')
  const namespaceRef = first.bundle.proposal.namespaceRef
  const namespaceWireBytes = target.store.database.prepare(`
    SELECT namespace_wire_bytes FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef)?.namespace_wire_bytes
  if (typeof namespaceWireBytes !== 'number') throw new Error('missing namespace wire bytes')
  target.store.database.prepare(`
    UPDATE namespaces SET namespace_generation = 2
    WHERE namespace_ref = ?
  `).run(namespaceRef)
  target.store.database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes
    ) VALUES (?, 2, 0, 0, 0, 0, ?, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `).run(namespaceRef, namespaceWireBytes, Date.parse(NOW))
  const second = directCommand(NOW, commandRef('2'), '第二代偏好', 2)
  assert.equal((await saveDirect(target, second)).status, 'stored')
  const generationRows = target.store.database.prepare(`
    SELECT namespace_generation, lifecycle_command_records
    FROM usage WHERE namespace_ref = ? ORDER BY namespace_generation ASC
  `).all(namespaceRef)
  assert.deepEqual(generationRows.map(row => ({ ...row })), [
    { namespace_generation: 1, lifecycle_command_records: 1 },
    { namespace_generation: 2, lifecycle_command_records: 1 }
  ])
  assert.equal(target.store.database.prepare(`
    SELECT lifecycle_command_records FROM lifecycle_namespace_usage WHERE namespace_ref = ?
  `).get(namespaceRef)?.lifecycle_command_records, 2)
  assert.equal(target.store.database.prepare(`
    SELECT lifecycle_command_records FROM global_usage WHERE singleton = 1
  `).get()?.lifecycle_command_records, 2)

  const replay = await saveDirect(target, first)
  assert.equal(replay.status, 'stored')
  const rejected = await saveDirect(
    target,
    directCommand(NOW, commandRef('3'), '错误代际写入', 1)
  )
  assert.deepEqual(rejected.status === 'denied' ? rejected.category : null, 'authority')
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM lifecycle_commands').get()?.count, 2)
})

test('SQLite v2 control reads expose bounded safe/full projections and complete revision history', async t => {
  const target = harness(t)
  const fixture = directCommand()
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  const namespace = personalMemoryNamespaceFixture()
  const pageBase = {
    cursor: null,
    limit: 8,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const proposalPage = await target.control.execute({
    ...controlRequestBase('proposal.list', namespace, NOW),
    states: ['approved'],
    cursorAnchor: null,
    ...pageBase
  })
  assert.equal(proposalPage.status, 'page')
  assert.equal(JSON.stringify(proposalPage).includes(fixture.bundle.proposal.text), false)

  const proposal = await target.control.execute({
    ...controlRequestBase('proposal.inspect', namespace, NOW),
    proposalId: fixture.bundle.proposal.proposalId
  })
  assert.equal(proposal.status, 'found', JSON.stringify(proposal))
  assert.equal(JSON.stringify(proposal).includes(fixture.bundle.proposal.text), true)

  const record = await target.control.execute({
    ...controlRequestBase('record.inspectGet', namespace, NOW),
    memoryId: fixture.bundle.record.memoryId
  })
  assert.equal(record.status, 'found')
  const history = await target.control.execute({
    ...controlRequestBase('revision.list', namespace, NOW),
    memoryId: fixture.bundle.record.memoryId,
    cursorAnchor: null,
    ...pageBase
  })
  assert.equal(history.status, 'page')
  assert.deepEqual(history.status === 'page' && history.operation === 'revision.list'
    ? history.records.map(item => item.revision)
    : [], [1])
})

test('proposal seek cursor binds namespace generation, filters and anchor without process state', async t => {
  const target = harness(t)
  const first = directCommand(NOW, commandRef('3'), '第一条偏好')
  assert.equal((await saveDirect(target, first)).status, 'stored')
  const secondNow = '2026-07-24T08:00:01.000Z'
  target.setNow(secondNow)
  const second = directCommand(secondNow, commandRef('4'), '第二条偏好')
  assert.equal((await saveDirect(target, second, secondNow)).status, 'stored')
  const namespace = personalMemoryNamespaceFixture()
  const base = {
    ...controlRequestBase('proposal.list', namespace, secondNow),
    states: ['approved'],
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const page1 = await target.control.execute({ ...base, cursor: null, cursorAnchor: null })
  assert.equal(page1.status, 'page')
  assert.notEqual(page1.status === 'page' && page1.operation === 'proposal.list'
    ? page1.nextCursor
    : null, null)
  const page1Cursor = page1.status === 'page' && page1.operation === 'proposal.list'
    ? page1.nextCursor
    : null
  const page1Anchor = page1.status === 'page' && page1.operation === 'proposal.list'
    ? page1.nextCursorAnchor
    : null
  const page2 = await target.control.execute({
    ...base,
    cursor: page1Cursor,
    cursorAnchor: page1Anchor
  })
  assert.equal(page2.status, 'page')
  assert.deepEqual(page2.status === 'page' && page2.operation === 'proposal.list'
    ? page2.records.map(item => item.proposalId)
    : [], [second.bundle.proposal.proposalId])
  await assert.rejects(target.control.execute({
    ...base,
    states: ['pending', 'approved'],
    cursor: page1Cursor,
    cursorAnchor: page1Anchor
  }), TypeError)
})

test('revision seek cursor rejects a SQLite anchor whose canonical payload disappeared', async t => {
  const target = harness(t)
  const fixture = directCommand()
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  const changedAt = '2026-07-24T08:00:01.000Z'
  const correction = buildMemoryCorrectionBundleV1({
    commandRef: commandRef('b'),
    operation: 'record.correct',
    namespaceRef: fixture.bundle.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: fixture.bundle.revision,
    changedByActorRef: ACTOR_REF,
    freshNow: changedAt,
    text: '喜欢低因咖啡',
    confidence: 0.95,
    validity: fixture.bundle.record.validity,
    conflict: fixture.bundle.record.conflict,
    supersedes: fixture.bundle.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture({
      sourceKind: 'manual_correction',
      messageId: null,
      normalizedText: '更正为低因咖啡'
    }),
    policyRef: null,
    policyGeneration: null,
    reason: '用户更正'
  })
  const revisionWire = encodeMemoryRevisionV2(correction.revision)
  const revisionBytes = Buffer.byteLength(revisionWire, 'utf8')
  const evidenceWire = encodeMemoryRevisionEvidenceV1(correction.evidence)
  const evidenceBytes = Buffer.byteLength(evidenceWire, 'utf8')
  const cursorRef = createHash('sha256')
    .update(MEMORY_CURSOR_HASH_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify({
      namespaceRef: correction.revision.record.namespaceRef,
      namespaceGeneration: correction.revision.record.namespaceGeneration,
      updatedAt: correction.revision.record.updatedAt,
      memoryId: correction.revision.memoryId,
      currentRevision: correction.revision.revision
    }), 'utf8')
    .digest('hex')
  target.store.database.prepare(`
    INSERT INTO revision_evidence(
      namespace_ref, namespace_generation, evidence_id, memory_id, revision,
      evidence_hash, evidence_wire, evidence_wire_bytes, changed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    correction.revision.record.namespaceRef,
    correction.revision.record.namespaceGeneration,
    correction.evidence.evidenceId,
    correction.revision.memoryId,
    correction.revision.revision,
    correction.evidence.evidenceHash,
    evidenceWire,
    evidenceBytes,
    Date.parse(changedAt)
  )
  target.store.database.prepare(`
    INSERT INTO revisions(
      namespace_ref, namespace_generation, memory_id, revision, operation,
      revision_hash, previous_revision_hash, changed_at_ms, revision_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    correction.revision.record.namespaceRef,
    correction.revision.record.namespaceGeneration,
    correction.revision.memoryId,
    correction.revision.revision,
    correction.revision.operation,
    correction.revision.revisionHash,
    correction.revision.previousRevisionHash,
    Date.parse(changedAt),
    revisionBytes
  )
  target.store.database.prepare(`
    INSERT INTO revision_payloads(
      namespace_ref, namespace_generation, memory_id, revision, revision_wire
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    correction.revision.record.namespaceRef,
    correction.revision.record.namespaceGeneration,
    correction.revision.memoryId,
    correction.revision.revision,
    revisionWire
  )
  target.store.database.prepare(`
    UPDATE heads SET current_revision = ?, current_revision_hash = ?, content_hash = ?,
      cursor_ref = ?, updated_at_ms = ?, valid_until_ms = ?, purge_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ?
  `).run(
    correction.revision.revision,
    correction.revision.revisionHash,
    correction.revision.record.contentHash,
    cursorRef,
    Date.parse(correction.revision.record.updatedAt),
    Date.parse(correction.revision.record.retention.validUntil),
    Date.parse(correction.revision.record.retention.purgeAt),
    correction.revision.record.namespaceRef,
    correction.revision.record.namespaceGeneration,
    correction.revision.memoryId
  )
  target.store.database.prepare(`
    UPDATE usage SET retained_revision_records = retained_revision_records + 1,
      canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE namespace_ref = ? AND namespace_generation = ?
  `).run(
    revisionBytes + evidenceBytes,
    correction.revision.record.namespaceRef,
    correction.revision.record.namespaceGeneration
  )
  target.store.database.prepare(`
    UPDATE global_usage SET retained_revision_records = retained_revision_records + 1,
      canonical_logical_bytes = canonical_logical_bytes + ?
    WHERE singleton = 1
  `).run(revisionBytes + evidenceBytes)

  const namespace = personalMemoryNamespaceFixture()
  const request = {
    ...controlRequestBase('revision.list', namespace, changedAt),
    memoryId: fixture.bundle.record.memoryId,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  target.setNow(changedAt)
  const firstPage = await target.control.execute({ ...request, cursor: null, cursorAnchor: null })
  assert.equal(firstPage.status, 'page', JSON.stringify(firstPage))
  const cursor = firstPage.status === 'page' && firstPage.operation === 'revision.list'
    ? firstPage.nextCursor
    : null
  const cursorAnchor = firstPage.status === 'page' && firstPage.operation === 'revision.list'
    ? firstPage.nextCursorAnchor
    : null
  assert.notEqual(cursor, null)
  assert.notEqual(cursorAnchor, null)
  target.store.database.prepare(`
    DELETE FROM revision_payloads
    WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ? AND revision = 1
  `).run(
    fixture.bundle.record.namespaceRef,
    fixture.bundle.record.namespaceGeneration,
    fixture.bundle.record.memoryId
  )
  const rejected = await target.control.execute({ ...request, cursor, cursorAnchor })
  assert.deepEqual(rejected, { status: 'invalid_cursor', operation: 'revision.list' })
})

test('ordinary proposal list skips a corrupt body while exact inspect and history fail closed', async t => {
  const target = harness(t)
  const fixture = directCommand()
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  target.store.database.prepare(`
    UPDATE proposals SET proposal_wire = '{}', proposal_wire_bytes = 2
  `).run()
  const namespace = personalMemoryNamespaceFixture()
  const page = await target.control.execute({
    ...controlRequestBase('proposal.list', namespace, NOW),
    states: ['approved'],
    cursor: null,
    cursorAnchor: null,
    limit: 8,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.equal(page.status, 'page')
  assert.equal(page.status === 'page' ? page.corruptRecords : 0, 1)
  const inspect = await target.control.execute({
    ...controlRequestBase('proposal.inspect', namespace, NOW),
    proposalId: fixture.bundle.proposal.proposalId
  })
  assert.deepEqual(inspect, { status: 'corrupt', category: 'canonical_data' })

  target.store.database.prepare(`
    UPDATE revision_payloads SET revision_wire = '{}'
  `).run()
  const history = await target.control.execute({
    ...controlRequestBase('revision.list', namespace, NOW),
    memoryId: fixture.bundle.record.memoryId,
    cursor: null,
    cursorAnchor: null,
    limit: 8,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.deepEqual(history, { status: 'corrupt', category: 'canonical_data' })
})

test('purge-due control projection is body-free even when physical revision payload remains', async t => {
  const target = harness(t)
  const fixture = directCommand()
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  const purgeAt = fixture.bundle.record.retention.purgeAt
  target.setNow(purgeAt)
  const namespace = personalMemoryNamespaceFixture()
  const result = await target.control.execute({
    ...controlRequestBase('record.inspectGet', namespace, purgeAt),
    memoryId: fixture.bundle.record.memoryId
  })
  assert.equal(result.status, 'found')
  assert.equal(JSON.stringify(result).includes(fixture.bundle.record.text), false)
  assert.equal(JSON.stringify(result).includes('sources'), false)
  assert.equal(JSON.stringify(result).includes(fixture.bundle.revision.revisionHash), false)
})

test('global usage is restricted to group bot master and reflects atomic direct-save counters', async t => {
  const target = harness(t)
  assert.equal((await saveDirect(target)).status, 'stored')
  const namespace = groupNamespace()
  const result = await target.control.execute({
    ...controlRequestBase('usage.getGlobal', namespace, NOW, 'group_bot_master', ['inspect_full'])
  })
  assert.equal(result.status, 'usage')
  if (result.status === 'usage') {
    assert.equal(result.value.namespaceRecords, 1)
    assert.equal(result.value.activeMemoryRecords, 1)
    assert.equal(result.value.retainedRevisionRecords, 1)
    assert.equal(result.value.pendingOutboxRecords, 2)
    assert.equal(result.value.lifecycleCommandRecords, 1)
  }
})

test('direct save rejects future time and stale locked authority without committing stable rows', async t => {
  const target = harness(t)
  const future = '2026-07-24T08:00:30.000Z'
  const futureResult = await saveDirect(target, directCommand(future, commandRef('5')), NOW)
  assert.deepEqual(
    futureResult.status === 'denied' ? futureResult.category : null,
    'authority'
  )
  assert.equal(target.store.database.prepare(
    'SELECT count(*) AS count FROM lifecycle_commands'
  ).get()?.count, 0)

  const staleAuth = authorization(
    personalMemoryNamespaceFixture(),
    NOW,
    'personal_subject',
    ['propose_create', 'approve']
  )
  const staleAt = '2026-07-24T08:01:01.000Z'
  target.setNow(staleAt)
  const accessEnvelope = Object.freeze({
    schemaVersion: 1 as const,
    command: directCommand(NOW, commandRef('6')).command,
    access: staleAuth.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: staleAuth.actor })
  })
  const accessResult = await target.lifecycleAdapter.execute(accessEnvelope)
  assert.deepEqual(
    accessResult !== null && typeof accessResult === 'object' && 'status' in accessResult
      ? accessResult
      : null,
    {
      schemaVersion: 1,
      operation: 'proposal.createAndApprove',
      commandHash: memoryLifecycleCommandHashV1(accessEnvelope.command.wire),
      status: 'denied',
      category: 'access'
    }
  )

  const freshAuth = authorization(
    personalMemoryNamespaceFixture(),
    staleAt,
    'personal_subject',
    ['propose_create', 'approve']
  )
  const actorCommand = directCommand(NOW, commandRef('7')).command
  const actorResult = await target.lifecycleAdapter.execute(Object.freeze({
    schemaVersion: 1 as const,
    command: actorCommand,
    access: freshAuth.access,
    authority: Object.freeze({ kind: 'actor' as const, capability: staleAuth.actor })
  }))
  assert.equal(
    actorResult !== null && typeof actorResult === 'object' && 'status' in actorResult
      ? actorResult.status
      : null,
    'denied'
  )
  assert.equal(
    actorResult !== null && typeof actorResult === 'object' && 'category' in actorResult
      ? actorResult.category
      : null,
    'authority'
  )
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 0)
})

test('direct save validates the complete command ledger binding before exact replay', async t => {
  const target = harness(t)
  const fixture = directCommand(NOW, commandRef('8'))
  const stored = await saveDirect(target, fixture)
  assert.equal(stored.status, 'stored')
  if (stored.status !== 'stored') return
  const row = target.store.database.prepare(`
    SELECT namespace_generation, command_hash, aggregate_ref_hash, result_wire,
      result_wire_bytes, result_hash
    FROM lifecycle_commands WHERE namespace_ref = ? AND command_ref = ?
  `).get(
    fixture.bundle.proposal.namespaceRef,
    decodeMemoryLifecycleCommandWireV1(fixture.command.wire).commandRef
  )
  assert.notEqual(row, undefined)
  if (row === undefined) return

  const mutations = [
    ['namespace_generation', 2, row.namespace_generation],
    ['command_hash', 'e'.repeat(64), row.command_hash],
    ['aggregate_ref_hash', 'f'.repeat(64), row.aggregate_ref_hash]
  ] as const
  for (const [column, forged, original] of mutations) {
    target.store.database.prepare(`UPDATE lifecycle_commands SET ${column} = ?`).run(forged)
    const replay = await saveDirect(target, fixture)
    assert.deepEqual(replay.status === 'corrupt' ? replay.category : null, 'canonical_data')
    target.store.database.prepare(`UPDATE lifecycle_commands SET ${column} = ?`).run(original)
  }

  const forgedResult = {
    ...stored,
    resultHash: 'd'.repeat(64),
    receiptHash: 'c'.repeat(64)
  }
  const forgedWire = encodeMemoryLifecycleStableResultWireV1(forgedResult)
  target.store.database.prepare(`
    UPDATE lifecycle_commands
    SET result_wire = ?, result_wire_bytes = ?, result_hash = ?
  `).run(
    forgedWire,
    Buffer.byteLength(forgedWire, 'utf8'),
    memoryLifecycleStableResultHashV1(forgedWire)
  )
  const forgedReplay = await saveDirect(target, fixture)
  assert.deepEqual(
    forgedReplay.status === 'corrupt' ? forgedReplay.category : null,
    'canonical_data'
  )
  assert.equal(target.store.database.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 2)
})

test('direct save rolls back every aggregate carrier when a late SQLite write fails', async t => {
  const target = harness(t)
  target.store.database.exec(`
    CREATE TEMP TRIGGER fail_direct_save_ledger
    BEFORE INSERT ON lifecycle_commands
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `)
  const failed = await saveDirect(target)
  assert.deepEqual(failed.status === 'corrupt' ? failed.category : null, 'canonical_data')
  const counts = target.store.database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespaces,
      (SELECT count(*) FROM proposals) AS proposals,
      (SELECT count(*) FROM consent_evidence) AS evidence,
      (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS payloads,
      (SELECT count(*) FROM heads) AS heads,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM lifecycle_commands) AS commands
  `).get()
  assert.deepEqual({ ...counts }, {
    namespaces: 0,
    proposals: 0,
    evidence: 0,
    revisions: 0,
    payloads: 0,
    heads: 0,
    outbox: 0,
    commands: 0
  })
  assert.equal(target.store.database.prepare(`
    SELECT canonical_logical_bytes FROM global_usage WHERE singleton = 1
  `).get()?.canonical_logical_bytes, 0)
  target.store.database.exec('DROP TRIGGER fail_direct_save_ledger')
  assert.equal((await saveDirect(target)).status, 'stored')
})

test('two SQLite handles preserve one direct-save aggregate under exact replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-control-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  const firstStore = openSqliteMemoryDatabaseV2({ location, now: () => NOW, manifests: [] })
  const secondStore = openSqliteMemoryDatabaseV2({ location, now: () => NOW, manifests: [] })
  t.after(firstStore.close)
  t.after(secondStore.close)
  const first = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: createSqliteMemoryLifecycleProposalAdapterV1({
      database: firstStore.database,
      now: () => NOW
    }).execute
  })
  const second = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: createSqliteMemoryLifecycleProposalAdapterV1({
      database: secondStore.database,
      now: () => NOW
    }).execute
  })
  const fixture = directCommand(NOW, commandRef('9'))
  const envelope = lifecycleEnvelope(fixture.command)
  const [left, right] = await Promise.all([first.execute(envelope), second.execute(envelope)])
  assert.deepEqual(left, right)
  assert.equal(left.status, 'stored')
  assert.equal(firstStore.database.prepare('SELECT count(*) AS count FROM proposals').get()?.count, 1)
  assert.equal(firstStore.database.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 2)
})

test('control reads persist trusted high-water and roll it back with a failed transaction', async t => {
  const target = harness(t)
  const later = '2026-07-24T08:00:20.000Z'
  target.setNow(later)
  const group = groupNamespace()
  const advanced = await target.control.execute({
    ...controlRequestBase('usage.getGlobal', group, later, 'group_bot_master', ['inspect_full'])
  })
  assert.equal(advanced.status, 'usage')
  assert.equal(advanced.status === 'usage' ? advanced.snapshotAt : null, later)
  target.setNow(NOW)
  const rolledBackWall = await target.control.execute({
    ...controlRequestBase('usage.getGlobal', group, NOW, 'group_bot_master', ['inspect_full'])
  })
  assert.equal(rolledBackWall.status === 'usage' ? rolledBackWall.snapshotAt : null, later)

  target.setNow(later)
  const fixture = directCommand(later, commandRef('a'))
  assert.equal((await saveDirect(target, fixture, later)).status, 'stored')
  const beforeFailure = target.store.database.prepare(`
    SELECT trusted_time_high_water_ms AS value
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()?.value
  target.store.database.prepare(`
    UPDATE namespaces SET namespace_wire = '{}', namespace_wire_bytes = 2
  `).run()
  const muchLater = '2026-07-24T08:00:40.000Z'
  target.setNow(muchLater)
  const failed = await target.control.execute({
    ...controlRequestBase('record.inspectGet', personalMemoryNamespaceFixture(), muchLater),
    memoryId: fixture.bundle.record.memoryId
  })
  assert.deepEqual(failed, { status: 'corrupt', category: 'canonical_data' })
  assert.equal(target.store.database.prepare(`
    SELECT trusted_time_high_water_ms AS value
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()?.value, beforeFailure)
})

test('control list pages truncate by exact wire budget and reject an unrepresentable first item', async t => {
  const target = harness(t)
  const first = directCommand(NOW, commandRef('b'), 'x'.repeat(1_800))
  assert.equal((await saveDirect(target, first)).status, 'stored')
  const later = '2026-07-24T08:00:01.000Z'
  target.setNow(later)
  const second = directCommand(later, commandRef('c'), 'y'.repeat(1_800))
  assert.equal((await saveDirect(target, second, later)).status, 'stored')
  const namespace = personalMemoryNamespaceFixture()
  const one = await target.control.execute({
    ...controlRequestBase('record.inspectList', namespace, later),
    cursor: null,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.equal(one.status, 'page')
  if (one.status !== 'page') return
  const bounded = await target.control.execute({
    ...controlRequestBase('record.inspectList', namespace, later),
    cursor: null,
    limit: 64,
    maxWireBytes: one.wireBytes
  })
  assert.equal(bounded.status, 'page')
  if (bounded.status !== 'page') return
  assert.equal(bounded.records.length, 1)
  assert.notEqual(bounded.nextCursor, null)
  assert.ok(bounded.wireBytes <= one.wireBytes)
  const continuation = await target.control.execute({
    ...controlRequestBase('record.inspectList', namespace, later),
    cursor: bounded.nextCursor,
    limit: 64,
    maxWireBytes: one.wireBytes
  })
  assert.equal(continuation.status, 'page')
  assert.equal(continuation.status === 'page' ? continuation.records.length : 0, 1)
  const tooSmall = await target.control.execute({
    ...controlRequestBase('record.inspectList', namespace, later),
    cursor: null,
    limit: 64,
    maxWireBytes: 1_024
  })
  assert.deepEqual(tooSmall, { status: 'unavailable', category: 'storage', retryable: false })
  await assert.rejects(target.control.execute({
    ...controlRequestBase('record.inspectList', namespace, later),
    cursor: null,
    limit: 64,
    maxWireBytes: 1_023
  }), TypeError)
})

test('real SQLite tombstone and audit pages require deletion authority for old generations', async t => {
  const target = harness(t)
  const fixture = directCommand(NOW, commandRef('d'))
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  const namespaceRef = fixture.bundle.proposal.namespaceRef
  const tombstones = [
    createMemoryTombstoneV1({
      tombstoneId: `tombstone:${'1'.repeat(64)}`,
      namespaceRef,
      namespaceGeneration: 1,
      memoryId: fixture.bundle.record.memoryId,
      deletedRevision: 1,
      deletionKind: 'memory_forgotten',
      deletedAt: '2026-07-24T08:01:00.000Z',
      deletedByActorRef: ACTOR_REF,
      reasonCode: 'explicit_forget',
      expiresAt: '2026-08-23T08:01:00.000Z'
    }),
    createMemoryTombstoneV1({
      tombstoneId: `tombstone:${'2'.repeat(64)}`,
      namespaceRef,
      namespaceGeneration: 1,
      memoryId: fixture.bundle.record.memoryId,
      deletedRevision: 1,
      deletionKind: 'memory_forgotten',
      deletedAt: '2026-07-24T08:02:00.000Z',
      deletedByActorRef: ACTOR_REF,
      reasonCode: 'explicit_forget',
      expiresAt: '2026-08-23T08:02:00.000Z'
    })
  ]
  tombstones.forEach(value => insertTombstone(target, value))
  const audit = (recordedAt: string, hash: string) => createMemoryLifecycleAuditV1({
    namespaceRef,
    namespaceGeneration: 1,
    operation: 'proposal_pruned',
    commandRefHash: hash,
    aggregateKind: 'proposal',
    aggregateRefHash: hash,
    authorizedByActorRefHash: 'a'.repeat(64),
    executedByActorRefHash: 'b'.repeat(64),
    sourceCommittedAt: recordedAt,
    recordedAt,
    outcome: 'pruned',
    repositoryReceiptHash: 'c'.repeat(64),
    priorRevision: 2,
    nextRevision: null,
    exclusionsHash: null
  })
  const audits = [
    audit('2026-07-24T08:01:00.000Z', '3'.repeat(64)),
    audit('2026-07-24T08:02:00.000Z', '4'.repeat(64))
  ]
  audits.forEach(value => insertAudit(target, value))
  target.store.database.prepare(`
    UPDATE namespaces SET namespace_generation = 2, updated_at_ms = ?
  `).run(Date.parse('2026-07-24T08:03:00.000Z'))

  const readNow = '2026-07-24T08:03:00.000Z'
  target.setNow(readNow)
  const namespace = personalMemoryNamespaceFixture()
  const denied = await target.control.execute({
    ...controlRequestBase(
      'tombstone.list', namespace, readNow, 'personal_subject', ['inspect_full'], 2
    ),
    targetGeneration: 1,
    cursor: null,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.deepEqual(denied, { status: 'denied', category: 'authority' })
  const request = {
    ...controlRequestBase(
      'tombstone.list',
      namespace,
      readNow,
      'personal_subject',
      ['resolve_deletion'],
      2
    ),
    targetGeneration: 1,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const firstPage = await target.control.execute({ ...request, cursor: null })
  assert.equal(firstPage.status, 'page', JSON.stringify(firstPage))
  assert.deepEqual(firstPage.status === 'page' && firstPage.operation === 'tombstone.list'
    ? firstPage.records.map(item => item.tombstoneId)
    : [], [tombstones[0]!.tombstoneId])
  const secondPage = await target.control.execute({
    ...request,
    cursor: firstPage.status === 'page' && firstPage.operation === 'tombstone.list'
      ? firstPage.nextCursor
      : null
  })
  assert.deepEqual(secondPage.status === 'page' && secondPage.operation === 'tombstone.list'
    ? secondPage.records.map(item => item.tombstoneId)
    : [], [tombstones[1]!.tombstoneId])

  const auditRequest = {
    ...controlRequestBase(
      'audit.list',
      namespace,
      readNow,
      'personal_subject',
      ['resolve_deletion'],
      2
    ),
    targetGeneration: 1,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const firstAudit = await target.control.execute({ ...auditRequest, cursor: null })
  assert.equal(firstAudit.status, 'page', JSON.stringify(firstAudit))
  const secondAudit = await target.control.execute({
    ...auditRequest,
    cursor: firstAudit.status === 'page' && firstAudit.operation === 'audit.list'
      ? firstAudit.nextCursor
      : null
  })
  assert.deepEqual([
    ...(firstAudit.status === 'page' && firstAudit.operation === 'audit.list'
      ? firstAudit.records.map(item => item.auditId)
      : []),
    ...(secondAudit.status === 'page' && secondAudit.operation === 'audit.list'
      ? secondAudit.records.map(item => item.auditId)
      : [])
  ], audits.map(item => item.auditId))
})

test('control reads fail closed on global usage and current-head tampering', async t => {
  const target = harness(t)
  const fixture = directCommand(NOW, commandRef('e'))
  assert.equal((await saveDirect(target, fixture)).status, 'stored')
  const namespace = personalMemoryNamespaceFixture()
  const originalCursor = target.store.database.prepare(`
    SELECT cursor_ref FROM heads WHERE memory_id = ?
  `).get(fixture.bundle.record.memoryId)?.cursor_ref
  if (typeof originalCursor !== 'string') throw new Error('missing current-head cursor')
  target.store.database.prepare(`UPDATE heads SET cursor_ref = ? WHERE memory_id = ?`).run(
    'f'.repeat(64),
    fixture.bundle.record.memoryId
  )
  const corruptHead = await target.control.execute({
    ...controlRequestBase('record.inspectGet', namespace, NOW),
    memoryId: fixture.bundle.record.memoryId
  })
  assert.deepEqual(corruptHead, { status: 'corrupt', category: 'canonical_data' })
  target.store.database.prepare(`UPDATE heads SET cursor_ref = ? WHERE memory_id = ?`).run(
    originalCursor,
    fixture.bundle.record.memoryId
  )
  target.store.database.prepare(`UPDATE revisions SET revision_hash = ? WHERE memory_id = ?`).run(
    'e'.repeat(64),
    fixture.bundle.record.memoryId
  )
  const corruptHistory = await target.control.execute({
    ...controlRequestBase('revision.list', namespace, NOW),
    memoryId: fixture.bundle.record.memoryId,
    cursor: null,
    cursorAnchor: null,
    limit: 8,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.deepEqual(corruptHistory, { status: 'corrupt', category: 'canonical_data' })

  target.store.database.prepare(`
    UPDATE global_usage SET active_memory_records = active_memory_records + 1
  `).run()
  const usage = await target.control.execute({
    ...controlRequestBase(
      'usage.getGlobal',
      groupNamespace(),
      NOW,
      'group_bot_master',
      ['inspect_full']
    )
  })
  assert.deepEqual(usage, { status: 'corrupt', category: 'canonical_data' })

  target.store.database.prepare(`
    UPDATE global_usage SET active_memory_records = active_memory_records - 1
  `).run()
  target.store.database.prepare(`
    UPDATE revision_payloads SET revision_wire = '{}'
  `).run()
  const payloadUsage = await target.control.execute({
    ...controlRequestBase(
      'usage.getGlobal',
      groupNamespace(),
      NOW,
      'group_bot_master',
      ['inspect_full']
    )
  })
  assert.deepEqual(payloadUsage, { status: 'corrupt', category: 'canonical_data' })
})
