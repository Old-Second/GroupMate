import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import { createMemorySourceV1, type MemorySourceV1 } from '../../src/agent/memory/memory-domain.js'
import { createMemoryExportCommandV1 } from '../../src/agent/memory/memory-export-port.js'
import {
  createMemoryControlRepositoryPortV1
} from '../../src/agent/memory/memory-control-repository.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  buildMemoryCorrectionBundleV1,
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import { createMemoryLifecycleCommandV1 } from '../../src/agent/memory/memory-lifecycle-command.js'
import { createMemoryLifecyclePortV1 } from '../../src/agent/memory/memory-lifecycle-port.js'
import {
  createPersonalMemoryEnrollmentCommandV1,
  createPersonalMemoryEnrollmentPortV1,
  createPersonalMemoryEnrollmentPolicyV1
} from '../../src/agent/memory/personal-memory-enrollment.js'
import {
  PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1,
  PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1,
  PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1,
  createPersonalMemoryLifecycleFacadeV1
} from '../../src/agent/memory/personal-memory-lifecycle-facade.js'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryDatabaseV3 } from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqliteMemoryControlRepositoryV1
} from '../../src/agent/memory/sqlite-memory-control-repository.js'
import {
  createSqliteMemoryLifecycleAdapterV1
} from '../../src/agent/memory/sqlite-memory-lifecycle.js'
import {
  createSqlitePersonalMemoryEnrollmentAdapterV1
} from '../../src/agent/memory/sqlite-personal-memory-enrollment.js'
import {
  FIXTURE_IDS,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T08:00:00.000Z'
const PLUS_1 = '2026-07-25T08:00:01.000Z'
const PLUS_2 = '2026-07-25T08:00:02.000Z'
const PLUS_3 = '2026-07-25T08:00:03.000Z'
const PLUS_4 = '2026-07-25T08:00:04.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`

function commandRef (hex: string): string {
  return `command:${hex.repeat(64)}`
}

function source (
  observedAt: string,
  userId: string = FIXTURE_IDS.subjectUserId
): MemorySourceV1 {
  return createMemorySourceV1({
    sourceKind: 'current_message',
    messageId: `message:${observedAt}:${userId}`,
    actor: {
      userId,
      nickname: userId === FIXTURE_IDS.subjectUserId ? '爱丽丝' : '鲍勃',
      groupCard: null,
      groupTitle: null,
      groupRole: 'unknown',
      displayName: userId === FIXTURE_IDS.subjectUserId ? '爱丽丝' : '鲍勃'
    },
    scene: {
      kind: 'private',
      groupId: null,
      groupLifecycleId: null,
      groupName: null
    },
    observedAt,
    normalizedText: '个人记忆控制请求',
    resourceRefs: []
  })
}

function authorization (now = NOW) {
  const namespace = personalMemoryNamespaceFixture()
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
      generation: 1,
      actorRef: ACTOR_REF,
      actorUserId: FIXTURE_IDS.subjectUserId,
      role: 'personal_subject',
      roleObservedAt: null,
      actions: [
        'propose_create', 'approve', 'list_safe', 'inspect_full', 'correct', 'renew',
        'forget', 'export', 'delete_namespace', 'claim_export', 'manage_enrollment'
      ]
    },
    now
  )
  return { namespace, access, actor }
}

function actorEnvelope (command: ReturnType<typeof createMemoryLifecycleCommandV1>, now = NOW) {
  const auth = authorization(now)
  return {
    namespace: auth.namespace,
    payload: {
      schemaVersion: 1 as const,
      command,
      access: auth.access,
      authority: { kind: 'actor' as const, capability: auth.actor }
    }
  }
}

function directMemory (memorySource = source(NOW)) {
  const namespace = personalMemoryNamespaceFixture()
  const ref = commandRef('1')
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
    text: '喜欢无糖咖啡',
    sources: [memorySource],
    observedAt: memorySource.observedAt,
    proposedAt: memorySource.observedAt,
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
    freshNow: memorySource.observedAt,
    evidenceSource: memorySource,
    reason: null
  })
  return {
    bundle,
    command: createMemoryLifecycleCommandV1({
      commandRef: ref,
      operation: 'proposal.createAndApprove',
      initiatedByActorRef: ACTOR_REF,
      namespaceRef: proposal.namespaceRef,
      expectedNamespaceGeneration: 1,
      aggregateRef: null,
      expectedRevision: null,
      expectedAggregateHash: null,
      occurredAt: memorySource.observedAt,
      newValidUntil: null,
      newPurgeAt: null,
      material: bundle
    })
  }
}

function correction (before: ReturnType<typeof directMemory>['bundle']['revision']) {
  const evidenceSource = source(PLUS_1)
  const ref = commandRef('2')
  const bundle = buildMemoryCorrectionBundleV1({
    commandRef: ref,
    operation: 'record.correct',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_1,
    text: '喜欢低因无糖咖啡',
    confidence: 0.95,
    validity: before.record.validity,
    conflict: before.record.conflict,
    supersedes: before.record.supersedes,
    evidenceKind: 'explicit',
    evidenceSource,
    policyRef: null,
    policyGeneration: null,
    reason: '用户更正'
  })
  return createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'record.correct',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: before.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: before.record.memoryId,
    expectedRevision: before.revision,
    expectedAggregateHash: before.revisionHash,
    occurredAt: PLUS_1,
    newValidUntil: null,
    newPurgeAt: null,
    material: bundle
  })
}

function renewal (before: ReturnType<typeof directMemory>['bundle']['revision']) {
  const evidenceSource = source(PLUS_2)
  const ref = commandRef('3')
  const bundle = buildMemoryRenewalBundleV1({
    commandRef: ref,
    operation: 'record.renew',
    namespaceRef: before.record.namespaceRef,
    namespaceGeneration: 1,
    beforeRevision: before,
    changedByActorRef: ACTOR_REF,
    freshNow: PLUS_2,
    newValidUntil: '2027-07-26T08:00:00.000Z',
    evidenceKind: 'explicit',
    evidenceSource,
    policyRef: null,
    policyGeneration: null,
    reason: '用户续期'
  })
  return createMemoryLifecycleCommandV1({
    commandRef: ref,
    operation: 'record.renew',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: before.record.namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: before.record.memoryId,
    expectedRevision: before.revision,
    expectedAggregateHash: before.revisionHash,
    occurredAt: PLUS_2,
    newValidUntil: bundle.revision.record.retention.validUntil,
    newPurgeAt: bundle.revision.record.retention.purgeAt,
    material: bundle
  })
}

function correctionChange (before: ReturnType<typeof directMemory>['bundle']['revision']) {
  const command = correction(before)
  return {
    command,
    bundle: command.material as ReturnType<typeof buildMemoryCorrectionBundleV1>
  }
}

function renewalChange (before: ReturnType<typeof directMemory>['bundle']['revision']) {
  const command = renewal(before)
  return {
    command,
    bundle: command.material as ReturnType<typeof buildMemoryRenewalBundleV1>
  }
}

function fixture (enrollmentState: 'not_enrolled' | 'opted_in' = 'opted_in') {
  const calls: string[] = []
  const namespace = personalMemoryNamespaceFixture()
  const policy = createPersonalMemoryEnrollmentPolicyV1({
    schemaVersion: 1,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    state: 'opted_in',
    candidateMode: 'off',
    policyGeneration: 1,
    commandRefHash: 'a'.repeat(64),
    commandHash: 'b'.repeat(64),
    decidedByActorRefHash: 'c'.repeat(64),
    decisionSourceRefHash: 'd'.repeat(64),
    updatedAt: NOW
  })
  const facade = createPersonalMemoryLifecycleFacadeV1({
    enrollment: {
      read: async () => {
        calls.push('enrollment.read')
        return enrollmentState === 'opted_in'
          ? { status: 'found' as const, policy }
          : { status: 'not_enrolled' as const }
      },
      decide: async () => {
        calls.push('enrollment.decide')
        return { status: 'aborted' as const }
      }
    },
    lifecycle: {
      execute: async () => {
        calls.push('lifecycle.execute')
        return { status: 'aborted' } as never
      }
    },
    control: {
      execute: async () => {
        calls.push('control.execute')
        return { status: 'aborted' }
      }
    },
    export: {
      execute: async () => {
        calls.push('export.execute')
        return { status: 'aborted' }
      }
    }
  })
  return { calls, facade }
}

test('personal lifecycle facade requires opt-in before direct remember', async () => {
  const direct = directMemory()
  const delegated = actorEnvelope(direct.command)
  const disabled = fixture('not_enrolled')
  const denied = await disabled.facade.execute({
    schemaVersion: 1,
    operation: 'remember',
    namespace: delegated.namespace,
    payload: delegated.payload
  })
  assert.deepEqual(denied.result, { status: 'enrollment_required' })
  assert.deepEqual(disabled.calls, ['enrollment.read'])

  const enabled = fixture()
  const stored = await enabled.facade.execute({
    schemaVersion: 1,
    operation: 'remember',
    namespace: delegated.namespace,
    payload: delegated.payload
  })
  assert.equal(stored.result.status, 'aborted')
  assert.deepEqual(enabled.calls, ['enrollment.read', 'lifecycle.execute'])
})

test('personal lifecycle facade routes controls and freezes journal boundary notices', async () => {
  const state = fixture()
  const direct = directMemory()
  const auth = authorization(PLUS_2)
  const namespaceRef = memoryNamespaceRefV1(auth.namespace)
  const revision = direct.bundle.revision
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('4'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: revision.record.memoryId,
    expectedRevision: revision.revision,
    expectedAggregateHash: revision.revisionHash,
    occurredAt: PLUS_2,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deletion = createMemoryLifecycleCommandV1({
    commandRef: commandRef('5'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: PLUS_2,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const lifecyclePayload = (command: ReturnType<typeof createMemoryLifecycleCommandV1>) => ({
    schemaVersion: 1 as const,
    command,
    access: auth.access,
    authority: { kind: 'actor' as const, capability: auth.actor }
  })
  const requests = [
    { operation: 'correct' as const, payload: lifecyclePayload(correction(revision)) },
    { operation: 'renew' as const, payload: lifecyclePayload(renewal(revision)) },
    { operation: 'forget' as const, payload: lifecyclePayload(forget) },
    { operation: 'delete' as const, payload: lifecyclePayload(deletion) }
  ]
  for (const request of requests) {
    const response = await state.facade.execute({
      schemaVersion: 1,
      operation: request.operation,
      namespace: auth.namespace,
      payload: request.payload
    })
    assert.equal(response.result.status, 'aborted')
    assert.deepEqual(response.notices, request.operation === 'forget' || request.operation === 'delete'
      ? [PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1]
      : [])
  }

  const list = await state.facade.execute({
    schemaVersion: 1,
    operation: 'list',
    namespace: auth.namespace,
    payload: {
      schemaVersion: 1,
      operation: 'record.inspectList',
      botInstanceId: auth.namespace.botInstanceId,
      accountId: auth.namespace.accountId,
      sceneRef: auth.access.sceneRef,
      namespaceRef,
      generation: 1,
      actorRef: ACTOR_REF,
      access: auth.access,
      actor: auth.actor,
      cursor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    }
  })
  assert.equal(list.result.status, 'aborted')

  const exported = await state.facade.execute({
    schemaVersion: 1,
    operation: 'export',
    namespace: auth.namespace,
    payload: {
      schemaVersion: 1,
      command: createMemoryExportCommandV1({
        commandRef: commandRef('6'),
        operation: 'export.prepare',
        initiatedByActorRef: ACTOR_REF,
        namespaceRef,
        expectedNamespaceGeneration: 1,
        exportId: null,
        expectedManifestHash: null,
        retryOfExportId: null,
        expectedSnapshotSha256: null,
        occurredAt: PLUS_2
      }),
      access: auth.access,
      actor: auth.actor
    }
  })
  assert.deepEqual(exported.notices, [PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1])

  const optOut = await state.facade.execute({
    schemaVersion: 1,
    operation: 'enrollment.optOut',
    namespace: auth.namespace,
    payload: {
      schemaVersion: 1,
      namespace: auth.namespace,
      command: createPersonalMemoryEnrollmentCommandV1({
        commandRef: commandRef('7'),
        operation: 'enrollment.optOut',
        initiatedByActorRef: ACTOR_REF,
        namespaceRef,
        expectedNamespaceGeneration: 1,
        expectedPolicyGeneration: 1,
        candidateMode: 'off',
        occurredAt: PLUS_2,
        source: source(PLUS_2)
      }),
      access: auth.access,
      actor: auth.actor
    }
  })
  assert.deepEqual(optOut.notices, [PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1])
  assert.deepEqual(state.calls, [
    'lifecycle.execute', 'lifecycle.execute', 'lifecycle.execute', 'lifecycle.execute',
    'control.execute', 'export.execute', 'enrollment.decide'
  ])
})

test('personal lifecycle facade rejects a third-party source before delegation', async () => {
  const state = fixture()
  const direct = directMemory(source(NOW, FIXTURE_IDS.secondUserId))
  const delegated = actorEnvelope(direct.command)
  await assert.rejects(state.facade.execute({
    schemaVersion: 1,
    operation: 'remember',
    namespace: delegated.namespace,
    payload: delegated.payload
  }), TypeError)
  assert.deepEqual(state.calls, [])
})

test('personal lifecycle facade completes the SQLite lifecycle and clears enrollment on delete', async (t: TestContext) => {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-personal-facade-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let currentNow = NOW
  const store = openSqliteMemoryDatabaseV3({
    location: join(directory, 'memory.sqlite'),
    now: () => currentNow,
    manifests: []
  })
  t.after(store.close)
  const enrollmentAdapter = createSqlitePersonalMemoryEnrollmentAdapterV1({
    database: store.database,
    now: () => currentNow
  })
  const enrollment = createPersonalMemoryEnrollmentPortV1({
    now: () => currentNow,
    read: enrollmentAdapter.read,
    decide: enrollmentAdapter.decide
  })
  const lifecycleAdapter = createSqliteMemoryLifecycleAdapterV1({
    database: store.database,
    now: () => currentNow
  })
  const lifecycle = createMemoryLifecyclePortV1({
    now: () => currentNow,
    execute: lifecycleAdapter.execute
  })
  const controlAdapter = createSqliteMemoryControlRepositoryV1({
    database: store.database,
    now: () => currentNow
  })
  const control = createMemoryControlRepositoryPortV1({
    now: () => currentNow,
    execute: controlAdapter.execute
  })
  const facade = createPersonalMemoryLifecycleFacadeV1({
    enrollment,
    lifecycle,
    control,
    export: { execute: async () => ({ status: 'aborted' }) }
  })
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)

  let auth = authorization(currentNow)
  const optedIn = await facade.execute({
    schemaVersion: 1,
    operation: 'enrollment.optIn',
    namespace,
    payload: {
      schemaVersion: 1,
      namespace,
      command: createPersonalMemoryEnrollmentCommandV1({
        commandRef: commandRef('8'),
        operation: 'enrollment.optIn',
        initiatedByActorRef: ACTOR_REF,
        namespaceRef,
        expectedNamespaceGeneration: 1,
        expectedPolicyGeneration: 0,
        candidateMode: 'off',
        occurredAt: currentNow,
        source: source(currentNow)
      }),
      access: auth.access,
      actor: auth.actor
    }
  })
  assert.equal(optedIn.result.status, 'stored')

  const direct = directMemory()
  auth = authorization(currentNow)
  const lifecyclePayload = (
    command: ReturnType<typeof createMemoryLifecycleCommandV1>,
    currentAuth = auth
  ) => ({
    schemaVersion: 1 as const,
    command,
    access: currentAuth.access,
    authority: { kind: 'actor' as const, capability: currentAuth.actor }
  })
  const remembered = await facade.execute({
    schemaVersion: 1,
    operation: 'remember',
    namespace,
    payload: lifecyclePayload(direct.command)
  })
  assert.equal(remembered.result.status, 'stored', JSON.stringify(remembered.result))

  const listRequest = () => ({
    schemaVersion: 1,
    operation: 'record.inspectList',
    botInstanceId: namespace.botInstanceId,
    accountId: namespace.accountId,
    sceneRef: auth.access.sceneRef,
    namespaceRef,
    generation: 1,
    actorRef: ACTOR_REF,
    access: auth.access,
    actor: auth.actor,
    cursor: null,
    limit: 16,
    maxWireBytes: 64 * 1_024
  })
  const listed = await facade.execute({
    schemaVersion: 1,
    operation: 'list',
    namespace,
    payload: listRequest()
  })
  assert.equal(listed.result.status, 'page')
  if (listed.result.status === 'page') assert.equal(listed.result.records.length, 1)

  currentNow = PLUS_1
  auth = authorization(currentNow)
  const correctedChange = correctionChange(direct.bundle.revision)
  const corrected = await facade.execute({
    schemaVersion: 1,
    operation: 'correct',
    namespace,
    payload: lifecyclePayload(correctedChange.command)
  })
  assert.equal(corrected.result.status, 'stored')

  currentNow = PLUS_2
  auth = authorization(currentNow)
  const renewedChange = renewalChange(correctedChange.bundle.revision)
  const renewed = await facade.execute({
    schemaVersion: 1,
    operation: 'renew',
    namespace,
    payload: lifecyclePayload(renewedChange.command)
  })
  assert.equal(renewed.result.status, 'stored')

  currentNow = PLUS_3
  auth = authorization(currentNow)
  const finalRevision = renewedChange.bundle.revision
  const forget = createMemoryLifecycleCommandV1({
    commandRef: commandRef('9'),
    operation: 'record.forget',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: finalRevision.record.memoryId,
    expectedRevision: finalRevision.revision,
    expectedAggregateHash: finalRevision.revisionHash,
    occurredAt: currentNow,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const forgotten = await facade.execute({
    schemaVersion: 1,
    operation: 'forget',
    namespace,
    payload: lifecyclePayload(forget)
  })
  assert.equal(forgotten.result.status, 'deletion_pending')

  currentNow = PLUS_4
  auth = authorization(currentNow)
  const deletion = createMemoryLifecycleCommandV1({
    commandRef: commandRef('a'),
    operation: 'namespace.delete',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef,
    expectedNamespaceGeneration: 1,
    aggregateRef: null,
    expectedRevision: null,
    expectedAggregateHash: null,
    occurredAt: currentNow,
    newValidUntil: null,
    newPurgeAt: null,
    material: null
  })
  const deleted = await facade.execute({
    schemaVersion: 1,
    operation: 'delete',
    namespace,
    payload: lifecyclePayload(deletion)
  })
  assert.equal(deleted.result.status, 'deletion_pending')
  assert.equal(store.database.prepare(`
    SELECT count(*) AS count FROM personal_memory_policies WHERE namespace_ref = ?
  `).get(namespaceRef)?.count, 0)

  const afterDelete = await facade.execute({
    schemaVersion: 1,
    operation: 'enrollment.read',
    namespace,
    payload: {
      schemaVersion: 1,
      namespace,
      access: auth.access
    }
  })
  assert.equal(afterDelete.result.status, 'not_enrolled')
})
