import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
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
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryLifecycleCommandV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  createMemoryLifecyclePortV1
} from '../../src/agent/memory/memory-lifecycle-port.js'
import {
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
  consumeMemoryExportDeliveryHandleV1,
  createMemoryExportCommandV1,
  createMemoryExportPortV1,
  memoryExportStableResultHashV1,
  type MemoryExportAuthorizationEnvelopeV1,
  type MemoryExportCommandOperationV1,
  type MemoryExportCommandV1
} from '../../src/agent/memory/memory-export-port.js'
import {
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryDatabaseV2 } from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryExportAdapterV1
} from '../../src/agent/memory/sqlite-memory-export.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-proposal.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle-mutation.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T08:00:00.000Z'
const PLUS_1 = '2026-07-25T08:00:01.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
type ExportConsumer = Parameters<
typeof createSqliteMemoryExportAdapterV1
>[0]['consumeArtifact']

function commandRef (suffix: string): string {
  return `command:${createHash('sha256').update(suffix, 'utf8').digest('hex')}`
}

function directFixture (suffix = 'first', text = '偏好少糖饮品') {
  const namespace = personalMemoryNamespaceFixture()
  const source = memorySourceFixture({ observedAt: NOW })
  const proposal = buildMemoryProposalDraftV2({
    commandRef: commandRef(`export-direct-save-${suffix}`),
    operation: 'proposal.createAndApprove',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: { kind: 'user', actorRef: ACTOR_REF },
    intent: { kind: 'create' },
    kind: 'preference',
    text,
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
    commandRef: commandRef(`export-direct-save-${suffix}`),
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
    commandRef: commandRef(`export-direct-save-${suffix}`),
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
  return { namespace, command, bundle }
}

function authority (
  namespace: MemoryNamespaceV1,
  actions: readonly string[],
  issuedAt = NOW
) {
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      scene: { kind: 'private', peerUserId: FIXTURE_IDS.subjectUserId }
    },
    [namespace],
    issuedAt
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
      generation: 1,
      actorRef: ACTOR_REF,
      actorUserId: FIXTURE_IDS.subjectUserId,
      role: 'personal_subject',
      roleObservedAt: null,
      actions
    },
    issuedAt
  )
  return { access, actor }
}

function exportCommand (
  operation: MemoryExportCommandOperationV1,
  namespace: MemoryNamespaceV1,
  values: {
    readonly exportId?: string
    readonly expectedManifestHash?: string
    readonly retryOfExportId?: string
    readonly expectedSnapshotSha256?: string
    readonly commandTag?: string
  } = {}
): MemoryExportCommandV1 {
  return createMemoryExportCommandV1({
    commandRef: commandRef([
      'export', operation, values.exportId ?? 'new', values.retryOfExportId ?? 'none',
      values.expectedSnapshotSha256 ?? 'none', values.commandTag ?? 'default'
    ].join('-')),
    operation,
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace),
    expectedNamespaceGeneration: 1,
    exportId: values.exportId ?? null,
    expectedManifestHash: values.expectedManifestHash ?? null,
    retryOfExportId: values.retryOfExportId ?? null,
    expectedSnapshotSha256: values.expectedSnapshotSha256 ?? null,
    occurredAt: NOW
  })
}

function envelope (
  namespace: MemoryNamespaceV1,
  command: MemoryExportCommandV1,
  issuedAt = NOW
): MemoryExportAuthorizationEnvelopeV1 {
  const granted = authority(namespace, ['export', 'claim_export'], issuedAt)
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: granted.access,
    actor: granted.actor
  })
}

function harness (t: TestContext, artifactCapacityBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-memory-export-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const artifactDirectory = join(directory, 'artifacts')
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const store = openSqliteMemoryDatabaseV2({
    location,
    now: () => currentNow,
    manifests: []
  })
  t.after(store.close)
  let delivered = ''
  const consumeArtifact: ExportConsumer = async source => {
    const chunks: Buffer[] = []
    await source.streamInto({
      maximumWireBytes: 80 * 1_024 * 1_024,
      maximumChunkBytes: 64 * 1_024,
      write: async chunk => { chunks.push(Buffer.from(chunk)) },
      commit: async () => undefined,
      abort: async () => undefined
    })
    delivered = Buffer.concat(chunks).toString('utf8')
  }
  const createAdapter = (
    database = store.database,
    leaseOwnerId = 'test-export-worker',
    consumer: ExportConsumer = consumeArtifact
  ) => createSqliteMemoryExportAdapterV1({
    database,
    now: () => currentNow,
    artifactDirectory,
    leaseOwnerId,
    ...(artifactCapacityBytes === undefined ? {} : { artifactCapacityBytes }),
    consumeArtifact: consumer
  })
  const adapter = createAdapter()
  const createPort = (value = adapter) => createMemoryExportPortV1({
    now: () => currentNow,
    execute: value.execute,
    cleanupPartial: value.cleanupPartial,
    finalizeGenerate: value.finalizeGenerate
  })
  return {
    store,
    location,
    artifactDirectory,
    delivered: () => delivered,
    adapter,
    createAdapter,
    createPort,
    now: () => currentNow,
    setNow: (value: string) => { currentNow = value },
    port: createPort()
  }
}

async function seedMemory (
  target: ReturnType<typeof harness>,
  namespace: MemoryNamespaceV1,
  command: ReturnType<typeof createMemoryLifecycleCommandV1>
): Promise<void> {
  const granted = authority(namespace, ['propose_create', 'approve'])
  const lifecycle = createMemoryLifecyclePortV1({
    now: () => NOW,
    execute: createSqliteMemoryLifecycleProposalAdapterV1({
      database: target.store.database,
      now: () => NOW
    }).execute
  })
  const result = await lifecycle.execute({
    schemaVersion: 1,
    command,
    access: granted.access,
    authority: { kind: 'actor', capability: granted.actor }
  })
  assert.equal(result.status, 'stored')
}

async function forgetMemory (
  target: ReturnType<typeof harness>,
  fixture: ReturnType<typeof directFixture>,
  suffix: string
): Promise<void> {
  const command = createMemoryLifecycleCommandV1({
    commandRef: commandRef(`export-forget-${suffix}`),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: fixture.bundle.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: fixture.bundle.record.memoryId,
    expectedRevision: fixture.bundle.revision.revision,
    expectedAggregateHash: fixture.bundle.revision.revisionHash,
    occurredAt: PLUS_1,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const granted = authority(fixture.namespace, ['forget'])
  const lifecycle = createMemoryLifecyclePortV1({
    now: target.now,
    execute: createSqliteMemoryLifecycleMutationAdapterV1({
      database: target.store.database,
      now: target.now
    }).execute
  })
  const result = await lifecycle.execute({
    schemaVersion: 1,
    command,
    access: granted.access,
    authority: { kind: 'actor', capability: granted.actor }
  })
  assert.equal(result.status, 'deletion_pending')
}

async function generateExport (
  target: ReturnType<typeof harness>,
  namespace: MemoryNamespaceV1,
  comparison: {
    readonly retryOfExportId: string
    readonly expectedSnapshotSha256: string
  } | null = null,
  commandTag = 'default'
) {
  const prepareCommand = exportCommand('export.prepare', namespace, {
    ...(comparison ?? {}),
    commandTag
  })
  const prepared = await target.port.execute(envelope(namespace, prepareCommand))
  assert.equal(prepared.status, 'prepared')
  if (prepared.status !== 'prepared') return assert.fail('prepare must succeed')
  const generateCommand = exportCommand('export.generate', namespace, {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(prepared),
    ...(comparison ?? {}),
    commandTag
  })
  return target.port.execute(envelope(namespace, generateCommand))
}

async function claimExport (
  target: ReturnType<typeof harness>,
  namespace: MemoryNamespaceV1,
  deliverable: Awaited<ReturnType<typeof generateExport>>
) {
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('export must be deliverable')
  const claimCommand = exportCommand('export.claimDelivery', namespace, {
    exportId: deliverable.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  const claimed = await target.port.execute(envelope(namespace, claimCommand))
  assert.equal(claimed.status, 'delivery_claimed')
  if (claimed.status !== 'delivery_claimed') return assert.fail('claim must succeed')
  return consumeMemoryExportDeliveryHandleV1(claimed.handle)
}

test('streams one ordered snapshot, persists claim replay and redeems the 0600 artifact once', async t => {
  const target = harness(t)
  const fixture = directFixture()
  await seedMemory(target, fixture.namespace, fixture.command)

  const prepareCommand = exportCommand('export.prepare', fixture.namespace)
  const prepared = await target.port.execute(envelope(fixture.namespace, prepareCommand))
  assert.equal(prepared.status, 'prepared')
  if (prepared.status !== 'prepared') return assert.fail('prepare must succeed')

  const generateCommand = exportCommand('export.generate', fixture.namespace, {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(prepared)
  })
  const deliverable = await target.port.execute(envelope(fixture.namespace, generateCommand))
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('generate must succeed')
  assert.deepEqual(deliverable.counts, {
    proposal: 1,
    proposalStatus: 1,
    recordHead: 1,
    recordRevision: 1,
    tombstone: 0,
    lifecycleAudit: 1
  })
  const fenceBeforeReplay = target.store.database.prepare(`
    SELECT export_fencing_counter AS counter FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()?.counter
  assert.deepEqual(
    await target.port.execute(envelope(fixture.namespace, generateCommand)),
    deliverable
  )
  assert.equal(target.store.database.prepare(`
    SELECT export_fencing_counter AS counter FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()?.counter, fenceBeforeReplay)

  const rows = target.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(deliverable.exportId) as { artifact_token: string }
  const artifact = join(target.artifactDirectory, rows.artifact_token)
  assert.equal(statSync(target.artifactDirectory).mode & 0o777, 0o700)
  assert.equal(statSync(artifact).mode & 0o777, 0o600)
  const wire = readFileSync(artifact, 'utf8')
  const types = wire.trimEnd().split('\n').map(line => JSON.parse(line).type as string)
  assert.deepEqual(types, [
    'header', 'proposal', 'proposal_status', 'record_head', 'record_revision',
    'lifecycle_audit', 'footer'
  ])
  assert.deepEqual(
    await target.port.execute(envelope(fixture.namespace, prepareCommand)),
    prepared
  )

  const claimCommand = exportCommand('export.claimDelivery', fixture.namespace, {
    exportId: deliverable.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  const firstClaim = await target.port.execute(envelope(fixture.namespace, claimCommand))
  const replayClaim = await target.port.execute(envelope(fixture.namespace, claimCommand))
  assert.equal(firstClaim.status, 'delivery_claimed')
  assert.equal(replayClaim.status, 'delivery_claimed')
  if (firstClaim.status !== 'delivery_claimed' || replayClaim.status !== 'delivery_claimed') {
    return assert.fail('claim must return transient delivery handles')
  }
  assert.deepEqual(
    await target.adapter.persistentDelivery.redeemOnce(
      consumeMemoryExportDeliveryHandleV1(firstClaim.handle)
    ),
    { status: 'delivered' }
  )
  assert.match(target.delivered(), /"type":"record_revision"/)
  assert.deepEqual(
    await target.adapter.persistentDelivery.redeemOnce(
      consumeMemoryExportDeliveryHandleV1(replayClaim.handle)
    ),
    { status: 'already_consumed' }
  )
  const restartedStore = openSqliteMemoryDatabaseV2({
    location: target.location,
    now: target.now,
    manifests: []
  })
  t.after(restartedStore.close)
  const restartedAdapter = target.createAdapter(
    restartedStore.database,
    'test-export-worker-restarted'
  )
  const restartedPort = target.createPort(restartedAdapter)
  const restartReplay = await restartedPort.execute(envelope(fixture.namespace, claimCommand))
  assert.equal(restartReplay.status, 'delivery_claimed')
  if (restartReplay.status === 'delivery_claimed') {
    assert.deepEqual(
      await restartedAdapter.persistentDelivery.redeemOnce(
        consumeMemoryExportDeliveryHandleV1(restartReplay.handle)
      ),
      { status: 'already_consumed' }
    )
  }
  assert.deepEqual(
    await restartedPort.execute(envelope(fixture.namespace, generateCommand)),
    deliverable
  )
})

test('snapshot comparison ignores export bookkeeping but detects canonical memory changes', async t => {
  const target = harness(t)
  const firstMemory = directFixture('comparison-first', '偏好少糖饮品')
  await seedMemory(target, firstMemory.namespace, firstMemory.command)
  const first = await generateExport(target, firstMemory.namespace)
  assert.equal(first.status, 'deliverable')
  if (first.status !== 'deliverable') return assert.fail('first export must be deliverable')

  const comparison = {
    retryOfExportId: first.exportId,
    expectedSnapshotSha256: first.sha256
  }
  const matched = await generateExport(target, firstMemory.namespace, comparison, 'matched')
  assert.equal(matched.status, 'deliverable')
  if (matched.status === 'deliverable') {
    assert.equal(matched.snapshotChanged, 'matched')
    assert.equal(matched.sha256, first.sha256)
  }

  const secondMemory = directFixture('comparison-second', '喜欢清晨骑车')
  await seedMemory(target, secondMemory.namespace, secondMemory.command)
  const changed = await generateExport(target, firstMemory.namespace, comparison, 'changed')
  assert.equal(changed.status, 'snapshot_changed')
  if (changed.status === 'snapshot_changed') {
    assert.equal(changed.snapshotChanged, 'changed')
    assert.notEqual(changed.sha256, first.sha256)
    const row = target.store.database.prepare(`
      SELECT state, artifact_token FROM export_jobs WHERE export_id = ?
    `).get(changed.exportId) as { state: string; artifact_token: string | null }
    assert.equal(row.state, 'failed')
    assert.equal(row.artifact_token, null)
  }
})

test('abort and corrupt canonical rows commit body-free failed terminals and clean partial files', async t => {
  const abortedTarget = harness(t)
  const abortedFixture = directFixture('aborted')
  await seedMemory(abortedTarget, abortedFixture.namespace, abortedFixture.command)
  const prepareCommand = exportCommand('export.prepare', abortedFixture.namespace)
  const prepared = await abortedTarget.port.execute(envelope(abortedFixture.namespace, prepareCommand))
  assert.equal(prepared.status, 'prepared')
  if (prepared.status !== 'prepared') return assert.fail('prepare must succeed')
  const generateCommand = exportCommand('export.generate', abortedFixture.namespace, {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(prepared)
  })
  const controller = new AbortController()
  const pending = abortedTarget.port.execute(
    envelope(abortedFixture.namespace, generateCommand),
    controller.signal
  )
  queueMicrotask(() => controller.abort())
  const aborted = await pending
  assert.equal(aborted.status, 'committed_after_abort')
  const abortedRow = abortedTarget.store.database.prepare(`
    SELECT state, artifact_token FROM export_jobs WHERE export_id = ?
  `).get(prepared.exportId) as { state: string; artifact_token: string | null }
  assert.equal(abortedRow.state, 'failed')
  assert.equal(abortedRow.artifact_token, null)
  assert.deepEqual(readdirSync(abortedTarget.artifactDirectory), [])

  const corruptTarget = harness(t)
  const corruptFixture = directFixture('corrupt')
  await seedMemory(corruptTarget, corruptFixture.namespace, corruptFixture.command)
  const corruptPrepare = exportCommand('export.prepare', corruptFixture.namespace)
  const corruptPrepared = await corruptTarget.port.execute(
    envelope(corruptFixture.namespace, corruptPrepare)
  )
  assert.equal(corruptPrepared.status, 'prepared')
  if (corruptPrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  corruptTarget.store.database.prepare(`
    UPDATE proposals SET resulting_revision_hash = ? WHERE namespace_ref = ?
  `).run('f'.repeat(64), memoryNamespaceRefV1(corruptFixture.namespace))
  const corruptGenerate = exportCommand('export.generate', corruptFixture.namespace, {
    exportId: corruptPrepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(corruptPrepared)
  })
  const corrupt = await corruptTarget.port.execute(
    envelope(corruptFixture.namespace, corruptGenerate)
  )
  assert.equal(corrupt.status, 'failed')
  if (corrupt.status === 'failed') assert.equal(corrupt.category, 'corrupt')
  assert.deepEqual(
    await corruptTarget.port.execute(envelope(corruptFixture.namespace, corruptGenerate)),
    corrupt
  )
  assert.deepEqual(readdirSync(corruptTarget.artifactDirectory), [])
})

test('artifact capacity is hard and expired jobs release canonical usage and files', async t => {
  const capacityTarget = harness(t, MEMORY_EXPORT_MAX_WIRE_BYTES_V1)
  const capacityFixture = directFixture('capacity')
  await seedMemory(capacityTarget, capacityFixture.namespace, capacityFixture.command)
  const filler = join(
    capacityTarget.artifactDirectory,
    `memory-export-v1-${'f'.repeat(64)}-1-${'e'.repeat(64)}.jsonl`
  )
  const descriptor = openSync(filler, 'wx', 0o600)
  try {
    ftruncateSync(descriptor, MEMORY_EXPORT_MAX_WIRE_BYTES_V1)
  } finally {
    closeSync(descriptor)
  }
  const capacity = await generateExport(capacityTarget, capacityFixture.namespace)
  assert.equal(capacity.status, 'failed')
  if (capacity.status === 'failed') assert.equal(capacity.category, 'capacity')

  const cleanupTarget = harness(t)
  const cleanupFixture = directFixture('cleanup')
  await seedMemory(cleanupTarget, cleanupFixture.namespace, cleanupFixture.command)
  const deliverable = await generateExport(cleanupTarget, cleanupFixture.namespace)
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('export must be deliverable')
  cleanupTarget.setNow('2026-07-25T08:31:00.000Z')
  assert.deepEqual(await cleanupTarget.adapter.cleanupExpired(), {
    deletedJobs: 1,
    deletedArtifacts: 1,
    hasMore: false
  })
  assert.equal(cleanupTarget.store.database.prepare(`
    SELECT count(*) AS count FROM export_jobs
  `).get()?.count, 0)
  assert.deepEqual(readdirSync(cleanupTarget.artifactDirectory), [])
})

test('artifact hash tampering fails closed before claim state changes', async t => {
  const target = harness(t)
  const fixture = directFixture('artifact-tamper')
  await seedMemory(target, fixture.namespace, fixture.command)
  const deliverable = await generateExport(target, fixture.namespace)
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('export must be deliverable')
  const row = target.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(deliverable.exportId) as { artifact_token: string }
  const path = join(target.artifactDirectory, row.artifact_token)
  const bytes = readFileSync(path)
  bytes[Math.min(32, bytes.length - 1)] ^= 1
  writeFileSync(path, bytes, { mode: 0o600 })
  const claim = exportCommand('export.claimDelivery', fixture.namespace, {
    exportId: deliverable.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  assert.deepEqual(await target.port.execute(envelope(fixture.namespace, claim)), {
    status: 'unavailable',
    category: 'artifact',
    retryable: false
  })
  assert.equal(target.store.database.prepare(`
    SELECT state FROM export_jobs WHERE export_id = ?
  `).get(deliverable.exportId)?.state, 'deliverable')
})

test('multiple canonical rows retain strict section and key ordering', async t => {
  const target = harness(t)
  const fixtures = [
    directFixture('ordered-d', '第四条偏好'),
    directFixture('ordered-a', '第一条偏好'),
    directFixture('ordered-c', '第三条偏好'),
    directFixture('ordered-b', '第二条偏好')
  ]
  for (const fixture of fixtures) await seedMemory(target, fixture.namespace, fixture.command)
  target.setNow(PLUS_1)
  await forgetMemory(target, fixtures[0], 'ordered-d')
  await forgetMemory(target, fixtures[2], 'ordered-c')

  const deliverable = await generateExport(target, fixtures[0].namespace, null, 'ordered')
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('export must be deliverable')
  const token = target.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(deliverable.exportId)?.artifact_token as string
  const records = readFileSync(join(target.artifactDirectory, token), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as { type: string; value: Record<string, unknown> })
  const section = new Map([
    ['header', 0],
    ['proposal', 1],
    ['proposal_status', 2],
    ['record_head', 3],
    ['record_revision', 4],
    ['tombstone', 5],
    ['lifecycle_audit', 6],
    ['footer', 7]
  ])
  const ranks = records.map(record => section.get(record.type) ?? -1)
  assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right))

  const sortedField = (type: string, field: string) => records
    .filter(record => record.type === type)
    .map(record => String(record.value[field]))
  for (const [type, field] of [
    ['proposal', 'proposalId'],
    ['proposal_status', 'proposalId'],
    ['record_head', 'memoryId'],
    ['tombstone', 'tombstoneId']
  ]) {
    const values = sortedField(type, field)
    assert.deepEqual(values, [...values].sort())
  }
  const revisions = records
    .filter(record => record.type === 'record_revision')
    .map(record => `${record.value.memoryId}\0${String(record.value.revision).padStart(16, '0')}`)
  assert.deepEqual(revisions, [...revisions].sort())
  const audits = records
    .filter(record => record.type === 'lifecycle_audit')
    .map(record => `${record.value.recordedAt}\0${record.value.auditId}`)
  assert.deepEqual(audits, [...audits].sort())
})

test('two SQLite handles enforce active leases and stale fencing takeover', async t => {
  const active = harness(t)
  const activeFixture = directFixture('active-lease')
  await seedMemory(active, activeFixture.namespace, activeFixture.command)
  const activePreparedCommand = exportCommand('export.prepare', activeFixture.namespace, {
    commandTag: 'active-lease'
  })
  const activePrepared = await active.port.execute(envelope(
    activeFixture.namespace,
    activePreparedCommand
  ))
  assert.equal(activePrepared.status, 'prepared')
  if (activePrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  const activeGenerate = exportCommand('export.generate', activeFixture.namespace, {
    exportId: activePrepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(activePrepared),
    commandTag: 'active-lease'
  })
  const activePeerStore = openSqliteMemoryDatabaseV2({
    location: active.location,
    now: active.now,
    manifests: []
  })
  t.after(activePeerStore.close)
  const activePeer = active.createAdapter(activePeerStore.database, 'active-peer')
  const firstPending = active.port.execute(envelope(activeFixture.namespace, activeGenerate))
  assert.deepEqual(
    await active.createPort(activePeer).execute(envelope(activeFixture.namespace, activeGenerate)),
    { status: 'unavailable', category: 'busy', retryable: true }
  )
  assert.equal((await firstPending).status, 'deliverable')

  const stale = harness(t)
  const staleFixture = directFixture('stale-lease')
  await seedMemory(stale, staleFixture.namespace, staleFixture.command)
  const stalePreparedCommand = exportCommand('export.prepare', staleFixture.namespace, {
    commandTag: 'stale-lease'
  })
  const stalePrepared = await stale.port.execute(envelope(
    staleFixture.namespace,
    stalePreparedCommand
  ))
  assert.equal(stalePrepared.status, 'prepared')
  if (stalePrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  const staleGenerate = exportCommand('export.generate', staleFixture.namespace, {
    exportId: stalePrepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(stalePrepared),
    commandTag: 'stale-lease'
  })
  const stalePeerStore = openSqliteMemoryDatabaseV2({
    location: stale.location,
    now: stale.now,
    manifests: []
  })
  t.after(stalePeerStore.close)
  const stalePeer = stale.createAdapter(stalePeerStore.database, 'stale-peer')
  const fencedPending = stale.port.execute(envelope(staleFixture.namespace, staleGenerate))
  stale.setNow('2026-07-25T08:06:00.000Z')
  const winnerPending = stale.createPort(stalePeer).execute(
    envelope(staleFixture.namespace, staleGenerate, '2026-07-25T08:06:00.000Z')
  )
  const [fenced, winner] = await Promise.all([fencedPending, winnerPending])
  const staleCounter = stale.store.database.prepare(`
    SELECT export_fencing_counter AS value FROM lifecycle_deployment_state WHERE singleton = 1
  `).get()?.value
  assert.equal(fenced.status, 'resolve_required')
  assert.equal(winner.status, 'deliverable')
  assert.equal(staleCounter, 2)
  const artifactNames = readdirSync(stale.artifactDirectory)
    .filter(name => !name.endsWith('.lock'))
  assert.equal(artifactNames.length, 1)
  assert.match(artifactNames[0], /-2-[0-9a-f]{64}\.jsonl$/)
})

test('reservation, job and global lease tampering fail closed', async t => {
  const reservationTarget = harness(t)
  const reservationFixture = directFixture('reservation-tamper')
  await seedMemory(reservationTarget, reservationFixture.namespace, reservationFixture.command)
  const reservationPrepare = exportCommand('export.prepare', reservationFixture.namespace, {
    commandTag: 'reservation-tamper'
  })
  const reservationPrepared = await reservationTarget.port.execute(envelope(
    reservationFixture.namespace,
    reservationPrepare
  ))
  assert.equal(reservationPrepared.status, 'prepared')
  if (reservationPrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  reservationTarget.store.database.prepare(`
    UPDATE export_audit_reservations SET command_hash = ? WHERE export_id = ?
  `).run('f'.repeat(64), reservationPrepared.exportId)
  const reservationGenerate = exportCommand('export.generate', reservationFixture.namespace, {
    exportId: reservationPrepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(reservationPrepared),
    commandTag: 'reservation-tamper'
  })
  assert.deepEqual(await reservationTarget.port.execute(envelope(
    reservationFixture.namespace,
    reservationGenerate
  )), { status: 'corrupt', category: 'canonical_data' })

  const jobTarget = harness(t)
  const jobFixture = directFixture('job-tamper')
  await seedMemory(jobTarget, jobFixture.namespace, jobFixture.command)
  const jobPrepare = exportCommand('export.prepare', jobFixture.namespace, {
    commandTag: 'job-tamper'
  })
  const jobPrepared = await jobTarget.port.execute(envelope(jobFixture.namespace, jobPrepare))
  assert.equal(jobPrepared.status, 'prepared')
  if (jobPrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  jobTarget.store.database.prepare(`
    UPDATE export_jobs SET prepared_command_hash = ? WHERE export_id = ?
  `).run('e'.repeat(64), jobPrepared.exportId)
  assert.deepEqual(await jobTarget.port.execute(envelope(jobFixture.namespace, jobPrepare)), {
    status: 'conflict', category: 'idempotency'
  })

  const leaseTarget = harness(t)
  const leaseFixture = directFixture('lease-tamper')
  await seedMemory(leaseTarget, leaseFixture.namespace, leaseFixture.command)
  const leasePrepare = exportCommand('export.prepare', leaseFixture.namespace, {
    commandTag: 'lease-tamper'
  })
  const leasePrepared = await leaseTarget.port.execute(envelope(leaseFixture.namespace, leasePrepare))
  assert.equal(leasePrepared.status, 'prepared')
  if (leasePrepared.status !== 'prepared') return assert.fail('prepare must succeed')
  leaseTarget.store.database.prepare(`
    UPDATE lifecycle_deployment_state SET export_lease_owner_id = ?,
      export_lease_token = ?, export_leased_until_ms = ? WHERE singleton = 1
  `).run('invalid lease owner', 'd'.repeat(64), Date.parse(NOW) + 60_000)
  const leaseGenerate = exportCommand('export.generate', leaseFixture.namespace, {
    exportId: leasePrepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(leasePrepared),
    commandTag: 'lease-tamper'
  })
  assert.deepEqual(await leaseTarget.port.execute(envelope(
    leaseFixture.namespace,
    leaseGenerate
  )), { status: 'corrupt', category: 'canonical_data' })
})

test('cleanup batches jobs and retains canonical state when artifact deletion fails', async t => {
  const batch = harness(t)
  const fixture = directFixture('cleanup-batch')
  await seedMemory(batch, fixture.namespace, fixture.command)
  for (const tag of ['cleanup-a', 'cleanup-b', 'cleanup-c']) {
    assert.equal((await generateExport(batch, fixture.namespace, null, tag)).status, 'deliverable')
  }
  batch.setNow('2026-07-25T08:31:00.000Z')
  assert.deepEqual(await batch.adapter.cleanupExpired(2), {
    deletedJobs: 2,
    deletedArtifacts: 2,
    hasMore: true
  })
  assert.deepEqual(await batch.adapter.cleanupExpired(2), {
    deletedJobs: 1,
    deletedArtifacts: 1,
    hasMore: false
  })

  const failed = harness(t)
  const failedFixture = directFixture('cleanup-failure')
  await seedMemory(failed, failedFixture.namespace, failedFixture.command)
  const deliverable = await generateExport(failed, failedFixture.namespace)
  assert.equal(deliverable.status, 'deliverable')
  if (deliverable.status !== 'deliverable') return assert.fail('export must be deliverable')
  const token = failed.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(deliverable.exportId)?.artifact_token as string
  const artifact = join(failed.artifactDirectory, token)
  unlinkSync(artifact)
  mkdirSync(artifact, { mode: 0o700 })
  failed.setNow('2026-07-25T08:31:00.000Z')
  await assert.rejects(failed.adapter.cleanupExpired())
  assert.equal(failed.store.database.prepare(`
    SELECT count(*) AS value FROM export_jobs
  `).get()?.value, 1)
  rmSync(artifact, { recursive: true, force: true })
  assert.deepEqual(await failed.adapter.cleanupExpired(), {
    deletedJobs: 1,
    deletedArtifacts: 0,
    hasMore: false
  })
})

test('redemption recovers stale final locks but never retries ambiguous consumption', async t => {
  const recoverable = harness(t)
  const recoverableFixture = directFixture('stale-final-lock')
  await seedMemory(recoverable, recoverableFixture.namespace, recoverableFixture.command)
  const recoverableExport = await generateExport(recoverable, recoverableFixture.namespace)
  const recoverableDelivery = await claimExport(
    recoverable,
    recoverableFixture.namespace,
    recoverableExport
  )
  const recoverableToken = recoverable.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(recoverableDelivery.exportId)?.artifact_token as string
  const recoverableLock = join(recoverable.artifactDirectory, `${recoverableToken}.lock`)
  writeFileSync(recoverableLock, '', { flag: 'wx', mode: 0o600 })
  const staleTime = new Date(Date.parse(NOW) - 5 * 60 * 1_000 - 1)
  utimesSync(recoverableLock, staleTime, staleTime)
  assert.deepEqual(
    await recoverable.adapter.persistentDelivery.redeemOnce(recoverableDelivery),
    { status: 'delivered' }
  )

  const ambiguous = harness(t)
  const ambiguousFixture = directFixture('ambiguous-consume')
  await seedMemory(ambiguous, ambiguousFixture.namespace, ambiguousFixture.command)
  const ambiguousExport = await generateExport(ambiguous, ambiguousFixture.namespace)
  const ambiguousDelivery = await claimExport(ambiguous, ambiguousFixture.namespace, ambiguousExport)
  let attempts = 0
  const failingAdapter = ambiguous.createAdapter(
    ambiguous.store.database,
    'ambiguous-consumer',
    async () => {
      attempts += 1
      throw new Error('consumer outcome unknown')
    }
  )
  assert.deepEqual(
    await failingAdapter.persistentDelivery.redeemOnce(ambiguousDelivery),
    { status: 'unavailable' }
  )
  const ambiguousToken = ambiguous.store.database.prepare(`
    SELECT artifact_token FROM export_jobs WHERE export_id = ?
  `).get(ambiguousDelivery.exportId)?.artifact_token as string
  const ambiguousFinal = join(ambiguous.artifactDirectory, ambiguousToken)
  const ambiguousRedeeming = `${ambiguousFinal}.redeeming`
  assert.equal(statSync(ambiguousRedeeming).isFile(), true)
  assert.equal(readdirSync(ambiguous.artifactDirectory).includes(ambiguousToken), false)
  const ambiguousLock = `${ambiguousFinal}.lock`
  writeFileSync(ambiguousLock, '', { flag: 'wx', mode: 0o600 })
  utimesSync(ambiguousLock, staleTime, staleTime)
  assert.deepEqual(
    await failingAdapter.persistentDelivery.redeemOnce(ambiguousDelivery),
    { status: 'already_consumed' }
  )
  assert.equal(attempts, 1)
})
