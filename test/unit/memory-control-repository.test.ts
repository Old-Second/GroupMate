import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  buildMemoryProposalDraftV2,
  buildMemoryRenewalBundleV1
} from '../../src/agent/memory/memory-lifecycle-builder.js'
import {
  createMemoryControlRepositoryPortV1,
  memoryProposalListCursorV1,
  memoryRevisionHistoryCursorV1,
  type MemoryControlRepositoryRequestV1
} from '../../src/agent/memory/memory-control-repository.js'
import {
  createDeletionMutationReceiptV1,
  createDeletionStatusV1,
  createMemoryLifecycleAuditV1
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import { createMemoryTombstoneV1 } from '../../src/agent/memory/memory-domain.js'
import { memoryLifecycleCommandRefHashV1 } from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  MEMORY_RESOURCE_LIMITS
} from '../../src/agent/memory/memory-resource-limits.js'
import {
  FIXTURE_IDS,
  memorySourceFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-22T08:00:00.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const PROPOSAL_COMMAND = `command:${'1'.repeat(64)}`
const CURSOR = `memory-control-cursor:v1:${'c'.repeat(64)}`

type TestActorRole =
  | 'personal_subject'
  | 'personal_bot_master'
  | 'group_member'
  | 'group_admin'
  | 'group_owner'
  | 'group_bot_master'

function issueAuthorization (
  namespace: MemoryNamespaceV1 = personalMemoryNamespaceFixture(),
  role: TestActorRole = 'personal_subject',
  generation = 1,
  actions: readonly string[] = ['list_safe', 'inspect_full', 'resolve_deletion']
) {
  const accessIssuer = createMemoryAccessCapabilityIssuerV1(() => true)
  const actorUserId = role === 'personal_bot_master'
    ? FIXTURE_IDS.secondUserId
    : namespace.scope.kind === 'personal'
      ? namespace.scope.subjectUserId
      : FIXTURE_IDS.subjectUserId
  const scene = namespace.scope.kind === 'personal'
    ? { kind: 'private' as const, peerUserId: namespace.scope.subjectUserId }
    : {
        kind: 'group' as const,
        groupId: namespace.scope.groupId,
        groupLifecycleId: namespace.scope.groupLifecycleId,
        trustedMemberUserIds: [actorUserId],
        observedAt: NOW
      }
  const context = {
    schemaVersion: 1 as const,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq' as const,
    accountId: namespace.accountId,
    scene
  }
  const access = issueMemoryAccessCapabilityV1(accessIssuer, context, [namespace], NOW)
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const actor = issueMemoryLifecycleActorCapabilityV1(root, {
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
    roleObservedAt: namespace.scope.kind === 'group' ? NOW : null,
    actions
  }, NOW)
  return Object.freeze({ access, actor })
}

function requestBase (
  operation: MemoryControlRepositoryRequestV1['operation'],
  namespace: MemoryNamespaceV1 = personalMemoryNamespaceFixture(),
  role: TestActorRole = 'personal_subject',
  generation = 1,
  actions: readonly string[] = ['list_safe', 'inspect_full', 'resolve_deletion']
) {
  const authorization = issueAuthorization(namespace, role, generation, actions)
  return {
    schemaVersion: 1 as const,
    operation,
    botInstanceId: namespace.botInstanceId,
    accountId: namespace.accountId,
    sceneRef: authorization.access.sceneRef,
    namespaceRef: memoryNamespaceRefV1(namespace),
    generation,
    actorRef: ACTOR_REF,
    access: authorization.access,
    actor: authorization.actor
  }
}

function proposal () {
  const namespace = personalMemoryNamespaceFixture()
  return buildMemoryProposalDraftV2({
    commandRef: PROPOSAL_COMMAND,
    operation: 'proposal.create',
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    initiatedByActorRef: ACTOR_REF,
    namespace,
    proposedBy: {
      kind: 'model',
      runRef: FIXTURE_IDS.runRef,
      modelProfile: 'deepseek-chat'
    },
    intent: { kind: 'create' },
    kind: 'preference',
    text: '喜欢无糖咖啡',
    sources: [memorySourceFixture()],
    observedAt: '2026-07-19T00:00:00.000Z',
    proposedAt: '2026-07-22T00:00:00.000Z',
    confidence: 0.9,
    sensitivity: 'personal',
    conflict: { state: 'none', relatedMemoryIds: [], note: null },
    customTtlDays: null,
    consentRequirement: 'explicit',
    consentPolicyRef: null,
    consentPolicyGeneration: null
  })
}

function approvedRecordAndRevision () {
  const pending = proposal()
  const bundle = buildMemoryProposalApprovalBundleV1({
    commandRef: `command:${'2'.repeat(64)}`,
    operation: 'proposal.approve',
    namespaceRef: pending.namespaceRef,
    namespaceGeneration: 1,
    proposal: pending,
    approvedByActorRef: ACTOR_REF,
    freshNow: NOW,
    evidenceSource: memorySourceFixture(),
    reason: null
  })
  return Object.freeze({ record: bundle.record, revision: bundle.revision })
}

function renewedRevision () {
  const { record, revision } = approvedRecordAndRevision()
  return buildMemoryRenewalBundleV1({
    commandRef: `command:${'3'.repeat(64)}`,
    operation: 'record.renew',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    beforeRevision: revision,
    changedByActorRef: ACTOR_REF,
    freshNow: NOW,
    newValidUntil: '2028-07-22T08:00:00.000Z',
    evidenceKind: 'explicit',
    evidenceSource: memorySourceFixture(),
    policyRef: null,
    policyGeneration: null,
    reason: null
  }).revision
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

function emptyPage (operation: 'proposal.list' | 'record.listSafe' | 'record.inspectList' |
'tombstone.list' | 'audit.list') {
  const records: readonly unknown[] = []
  const corruptRefs: readonly string[] = []
  return {
    status: 'page',
    operation,
    snapshotAt: NOW,
    records,
    nextCursor: null,
    wireBytes: pageWireBytes(records, corruptRefs),
    corruptRecords: 0,
    corruptRefs
  }
}

function globalUsage () {
  return {
    schemaVersion: 1,
    namespaceRecords: 1,
    pendingProposalRecords: 0,
    activeMemoryRecords: 0,
    retainedRevisionRecords: 0,
    tombstoneRecords: 0,
    lifecycleAuditRecords: 0,
    lifecycleAuditReservedRecords: 0,
    lifecycleCommandRecords: 0,
    deletionCheckpointRecords: 0,
    exportJobRecords: 0,
    canonicalLogicalBytes: 0,
    pendingOutboxRecords: 0,
    outboxLogicalBytes: 0,
    lifecycleAuditLogicalBytes: 0,
    lifecycleAuditReservedBytes: 0,
    lifecycleCommandLogicalBytes: 0,
    deletionCheckpointLogicalBytes: 0,
    exportJobLogicalBytes: 0
  }
}

function proposalSummary () {
  const value = proposal()
  return {
    schemaVersion: 1,
    namespaceRef: value.namespaceRef,
    namespaceGeneration: value.namespaceGeneration,
    proposalId: value.proposalId,
    revision: value.revision,
    state: value.state,
    effectiveState: value.state,
    intentKind: value.intent.kind,
    plannedMemoryId: value.plannedMemoryId,
    kind: value.kind,
    sensitivity: value.sensitivity,
    proposedAt: value.proposedAt,
    deadlineAt: '2026-07-29T00:00:00.000Z',
    validUntil: value.suggestedRetention.validUntil,
    approvalCutoff: '2026-07-29T00:00:00.000Z'
  }
}

function safeRecordSummary (memoryId = `memory:${'4'.repeat(64)}`) {
  const namespace = groupNamespace()
  return {
    schemaVersion: 1,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    memoryId,
    revision: 1,
    lifecycleState: 'current',
    kind: 'other',
    text: '群里每周五整理待办',
    validity: { state: 'current', validFrom: '2026-07-20T00:00:00.000Z' },
    confidence: 0.9,
    sensitivity: 'group',
    updatedAt: '2026-07-22T07:00:00.000Z',
    sourceCount: 1,
    validUntil: '2026-08-22T00:00:00.000Z',
    purgeAt: '2026-09-21T00:00:00.000Z'
  }
}

function revisionHeadProof (
  record: ReturnType<typeof approvedRecordAndRevision>['record'],
  revision: ReturnType<typeof approvedRecordAndRevision>['revision'],
  snapshotAt = NOW
) {
  const lifecycleState = Date.parse(snapshotAt) < Date.parse(record.retention.validUntil)
    ? 'current'
    : Date.parse(snapshotAt) < Date.parse(record.retention.purgeAt)
      ? 'expired'
      : 'purge_due'
  return {
    schemaVersion: 1,
    namespaceRef: record.namespaceRef,
    namespaceGeneration: record.namespaceGeneration,
    memoryId: record.memoryId,
    headRevision: revision.revision,
    lifecycleState,
    ...(lifecycleState === 'purge_due' ? {} : { headRevisionHash: revision.revisionHash }),
    validUntil: record.retention.validUntil,
    purgeAt: record.retention.purgeAt
  }
}

function tombstoneSummary (
  tombstoneId: string,
  deletedAt: string,
  expiresAt: string
) {
  const namespace = personalMemoryNamespaceFixture()
  return createMemoryTombstoneV1({
    tombstoneId,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    memoryId: approvedRecordAndRevision().record.memoryId,
    deletedRevision: 1,
    deletionKind: 'memory_forgotten',
    deletedAt,
    deletedByActorRef: ACTOR_REF,
    reasonCode: 'explicit_forget',
    expiresAt
  })
}

function tombstoneControlProjection (
  value: ReturnType<typeof tombstoneSummary>
) {
  return {
    schemaVersion: value.schemaVersion,
    tombstoneId: value.tombstoneId,
    namespaceRef: value.namespaceRef,
    namespaceGeneration: value.namespaceGeneration,
    memoryId: value.memoryId,
    deletedRevision: value.deletedRevision,
    deletionKind: value.deletionKind,
    deletedAt: value.deletedAt,
    receiptHash: value.receiptHash,
    expiresAt: value.expiresAt
  }
}

function pageWireBytes (
  records: readonly unknown[],
  corruptRefs: readonly string[],
  metadata: Readonly<Record<string, unknown>> = {}
): number {
  return Buffer.byteLength(JSON.stringify({ records, corruptRefs, ...metadata }), 'utf8')
}

test('control repository authorizes and normalizes an oldest-first safe proposal page', async () => {
  let dispatched: unknown
  const records = [proposalSummary()]
  const nextCursorAnchor = {
    schemaVersion: 1 as const,
    proposedAt: records[0]!.proposedAt,
    proposalId: records[0]!.proposalId
  }
  const nextCursor = memoryProposalListCursorV1({
    schemaVersion: 1,
    namespaceRef: memoryNamespaceRefV1(personalMemoryNamespaceFixture()),
    namespaceGeneration: 1,
    states: ['pending'],
    anchor: nextCursorAnchor
  })
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async envelope => {
      dispatched = envelope
      return {
        status: 'page',
        operation: 'proposal.list',
        snapshotAt: NOW,
        records,
        nextCursor,
        nextCursorAnchor,
        wireBytes: pageWireBytes(records, [], { nextCursorAnchor }),
        corruptRecords: 0,
        corruptRefs: []
      }
    }
  })
  const request = {
    ...requestBase(
      'proposal.list', personalMemoryNamespaceFixture(), 'personal_subject', 1,
      ['inspect_full']
    ),
    states: ['pending'],
    cursor: null,
    cursorAnchor: null,
    limit: 16,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const result = await repository.execute(request)

  const adapterEnvelope = dispatched as {
    readonly schemaVersion: 1
    readonly request: unknown
    readonly authorization: Readonly<Record<string, unknown>>
  }
  assert.deepEqual(adapterEnvelope.request, {
    schemaVersion: 1,
    operation: 'proposal.list',
    namespaceRef: memoryNamespaceRefV1(personalMemoryNamespaceFixture()),
    generation: 1,
    states: ['pending'],
    cursor: null,
    cursorAnchor: null,
    limit: 16,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  })
  assert.equal(adapterEnvelope.schemaVersion, 1)
  assert.equal(adapterEnvelope.authorization.access, request.access)
  assert.equal(adapterEnvelope.authorization.actor, request.actor)
  assert.equal(adapterEnvelope.authorization.sceneRef, request.sceneRef)
  assert.equal(adapterEnvelope.authorization.actorRef, request.actorRef)
  assert.equal(Object.isFrozen(adapterEnvelope), true)
  assert.equal(Object.isFrozen(adapterEnvelope.authorization), true)
  assert.equal(result.status, 'page')
  assert.equal(JSON.stringify(result).includes('喜欢无糖咖啡'), false)
  assert.equal(JSON.stringify(result).includes(FIXTURE_IDS.subjectUserId), false)
  assert.equal(Object.isFrozen(result), true)
})

test('control repository rejects malformed requests before adapter dispatch', async () => {
  let calls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return { status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW }
    }
  })
  const hostile = { ...requestBase('proposal.inspect'), proposalId: proposal().proposalId }
  Object.defineProperty(hostile, 'extra', { get: () => 'secret', enumerable: true })
  await assert.rejects(repository.execute(hostile), TypeError)
  await assert.rejects(repository.execute(new Proxy(hostile, {})), TypeError)
  assert.equal(calls, 0)
})

test('control repository performs zero dispatch for a pre-aborted read', async () => {
  let calls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return { status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW }
    }
  })
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await repository.execute({
    ...requestBase('proposal.inspect'),
    proposalId: proposal().proposalId
  }, controller.signal), { status: 'aborted' })
  assert.equal(calls, 0)
})

test('control repository covers every canonical read operation with a transient authorization envelope', async () => {
  const dispatched: unknown[] = []
  const { record, revision } = approvedRecordAndRevision()
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async envelope => {
      dispatched.push(envelope)
      const request = envelope.request
      if (request.operation === 'usage.getGlobal') {
        return {
          status: 'usage', operation: request.operation, snapshotAt: NOW, value: globalUsage()
        }
      }
      if (request.operation === 'revision.list') {
        const head = revisionHeadProof(record, revision)
        const records = [revision]
        return {
          status: 'page', operation: request.operation, snapshotAt: NOW, records,
          nextCursor: null, nextCursorAnchor: null,
          wireBytes: pageWireBytes(records, [], { head, nextCursorAnchor: null }),
          corruptRecords: 0, corruptRefs: [], head
        }
      }
      if (request.operation === 'proposal.list' || request.operation === 'record.listSafe' ||
        request.operation === 'record.inspectList' || request.operation === 'tombstone.list' ||
        request.operation === 'audit.list') {
        return emptyPage(request.operation as Parameters<typeof emptyPage>[0])
      }
      return { status: 'not_found', operation: request.operation, snapshotAt: NOW }
    }
  })
  const memoryId = record.memoryId
  const proposalId = proposal().proposalId
  const deletion = `deletion:${'d'.repeat(64)}`
  const commonPages = { cursor: null, limit: 8, maxWireBytes: 8_192 }
  const requests: unknown[] = [
    { ...requestBase('proposal.list'), ...commonPages },
    { ...requestBase('proposal.inspect'), proposalId },
    { ...requestBase('record.inspectGet'), memoryId },
    { ...requestBase('record.inspectList'), ...commonPages },
    {
      ...requestBase('record.listSafe', groupNamespace(), 'group_member', 1, ['list_safe']),
      ...commonPages
    },
    { ...requestBase('revision.get'), memoryId, revision: 1 },
    { ...requestBase('revision.list'), memoryId, cursorAnchor: null, ...commonPages },
    { ...requestBase('tombstone.list'), ...commonPages },
    { ...requestBase('audit.list'), ...commonPages },
    { ...requestBase('deletion.getStatus'), deletionRef: deletion },
    {
      ...requestBase('deletion.resolve'),
      deletionRef: deletion,
      commandRef: `command:${'d'.repeat(64)}`
    },
    { ...requestBase('usage.getGlobal', groupNamespace(), 'group_bot_master') }
  ]
  const results = []
  for (const request of requests) results.push(await repository.execute(request))

  assert.deepEqual(results.map(result => result.status), [
    'page', 'not_found', 'not_found', 'page', 'page', 'not_found', 'page', 'page', 'page',
    'not_found', 'not_found', 'usage'
  ])
  assert.equal(dispatched.length, 12)
  for (const envelope of dispatched as Array<{
    request: Readonly<Record<string, unknown>>
    authorization: Readonly<Record<string, unknown>>
  }>) {
    assert.equal(Object.hasOwn(envelope.request, 'access'), false)
    assert.equal(Object.hasOwn(envelope.request, 'actor'), false)
    assert.equal(Object.hasOwn(envelope.request, 'actorRef'), false)
    assert.equal(Object.hasOwn(envelope.request, 'sceneRef'), false)
    assert.equal(Object.hasOwn(envelope.authorization, 'access'), true)
    assert.equal(Object.hasOwn(envelope.authorization, 'actor'), true)
    assert.equal(Object.isFrozen(envelope), true)
    assert.equal(Object.isFrozen(envelope.request), true)
    assert.equal(Object.isFrozen(envelope.authorization), true)
  }
})

test('control repository enforces exact access, actor action and master-only global usage', async () => {
  let calls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return { status: 'usage', operation: 'usage.getGlobal', snapshotAt: NOW, value: globalUsage() }
    }
  })
  const proposalRequest = {
    ...requestBase('proposal.list'),
    cursor: null,
    limit: 1,
    maxWireBytes: 1_024
  }
  const wrongBot = { ...proposalRequest, botInstanceId: 'groupmate-secondary' }
  const wrongActor = { ...proposalRequest, actorRef: `actor:${'b'.repeat(64)}` }
  const missingAction = {
    ...requestBase(
      'proposal.list', personalMemoryNamespaceFixture(), 'personal_subject', 1,
      ['list_safe']
    ),
    cursor: null,
    limit: 1,
    maxWireBytes: 1_024
  }
  assert.deepEqual(await repository.execute(wrongBot), { status: 'denied', category: 'access' })
  assert.deepEqual(await repository.execute(wrongActor), { status: 'denied', category: 'authority' })
  assert.deepEqual(await repository.execute(missingAction), {
    status: 'denied', category: 'authority'
  })
  assert.deepEqual(await repository.execute({
    ...requestBase('usage.getGlobal')
  }), { status: 'denied', category: 'authority' })
  assert.deepEqual(await repository.execute({
    ...requestBase('usage.getGlobal', groupNamespace(), 'group_owner', 1, ['inspect_full'])
  }), { status: 'denied', category: 'authority' })
  assert.equal(calls, 0)

  const master = requestBase('usage.getGlobal', groupNamespace(), 'group_bot_master')
  assert.equal((await repository.execute(master)).status, 'usage')
  assert.equal(calls, 1)
  assert.deepEqual(await repository.execute({ ...master, actor: { ...master.actor } }), {
    status: 'denied', category: 'authority'
  })
  assert.equal(calls, 1)
})

test('group members receive only current group-safe record projections', async () => {
  let adapterResult: unknown
  let calls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return adapterResult
    }
  })
  const request = {
    ...requestBase('record.listSafe', groupNamespace(), 'group_member', 1, ['list_safe']),
    cursor: null,
    limit: 4,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const record = safeRecordSummary()
  const page = (records: readonly unknown[]) => ({
    status: 'page',
    operation: 'record.listSafe',
    snapshotAt: NOW,
    records,
    nextCursor: null,
    wireBytes: pageWireBytes(records, []),
    corruptRecords: 0,
    corruptRefs: []
  })

  adapterResult = page([record])
  const result = await repository.execute(request)
  assert.equal(result.status, 'page')
  assert.equal(JSON.stringify(result).includes(record.text), true)
  assert.equal(JSON.stringify(result).includes(FIXTURE_IDS.subjectUserId), false)
  assert.equal(JSON.stringify(result).includes('sources'), false)
  assert.equal(JSON.stringify(result).includes('contentHash'), false)

  adapterResult = page([{ ...record, kind: 'preference' }])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = page([{ ...record, sensitivity: 'personal' }])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = page([{ ...record, lifecycleState: 'expired' }])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = page([{
    ...record,
    sources: [memorySourceFixture()],
    contentHash: 'f'.repeat(64)
  }])
  const hostileSafeRecord = await repository.execute(request)
  assert.equal(hostileSafeRecord.status, 'corrupt')
  assert.equal(JSON.stringify(hostileSafeRecord).includes(FIXTURE_IDS.subjectUserId), false)
  adapterResult = page([{
    ...record,
    namespaceRef: memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  }])
  assert.equal((await repository.execute(request)).status, 'corrupt')

  const deniedInspect = {
    ...requestBase('record.inspectList', groupNamespace(), 'group_member', 1, ['list_safe']),
    cursor: null,
    limit: 1,
    maxWireBytes: 1_024
  }
  const beforeDenied = calls
  assert.deepEqual(await repository.execute(deniedInspect), {
    status: 'denied', category: 'authority'
  })
  assert.equal(calls, beforeDenied)
})

test('proposal pages require legal progress, unique refs, bounded bytes and oldest-first order', async () => {
  const first = proposalSummary()
  const second = {
    ...proposalSummary(),
    proposalId: `proposal:${'f'.repeat(64)}`,
    plannedMemoryId: `memory:${'f'.repeat(64)}`
  }
  let adapterResult: unknown
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => adapterResult
  })
  const request = {
    ...requestBase('proposal.list'),
    states: ['pending'],
    cursor: null,
    limit: 4,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const result = (records: readonly unknown[], corruptRefs: readonly string[] = [],
    nextCursorAnchor: { readonly proposedAt: string; readonly proposalId: string } | null = null) => {
    const anchor = nextCursorAnchor === null
      ? null
      : { schemaVersion: 1 as const, ...nextCursorAnchor }
    const nextCursor = anchor === null
      ? null
      : memoryProposalListCursorV1({
          schemaVersion: 1,
          namespaceRef: first.namespaceRef,
          namespaceGeneration: first.namespaceGeneration,
          states: request.states,
          anchor
        })
    return ({
    status: 'page',
    operation: 'proposal.list',
    snapshotAt: NOW,
    records,
    nextCursor,
    wireBytes: pageWireBytes(
      records,
      corruptRefs,
      anchor === null ? {} : { nextCursorAnchor: anchor }
    ),
    corruptRecords: corruptRefs.length,
    corruptRefs,
    ...(anchor === null ? {} : { nextCursorAnchor: anchor })
  })
  }

  adapterResult = result([{
    ...first,
    namespaceRef: memoryNamespaceRefV1(groupNamespace())
  }])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = result([{ ...first, revision: 2 }])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  const decided = { ...first, state: 'approved', effectiveState: 'approved', revision: 1 }
  adapterResult = result([decided])
  assert.equal((await repository.execute({ ...request, states: ['approved'] })).status, 'corrupt')
  adapterResult = result([second, first])
  assert.deepEqual(await repository.execute(request), {
    status: 'corrupt', category: 'adapter_contract'
  })
  adapterResult = result([first, first])
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = result([], [], {
    proposedAt: first.proposedAt,
    proposalId: `proposal:${'e'.repeat(64)}`
  })
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = result([], [`proposal:${'e'.repeat(64)}`], {
    proposedAt: first.proposedAt,
    proposalId: `proposal:${'e'.repeat(64)}`
  })
  assert.equal((await repository.execute(request)).status, 'page')
  adapterResult = result([], [
    `proposal:${'e'.repeat(64)}`,
    `proposal:${'e'.repeat(64)}`
  ], {
    proposedAt: first.proposedAt,
    proposalId: `proposal:${'e'.repeat(64)}`
  })
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = result([first], [], {
    proposedAt: first.proposedAt,
    proposalId: first.proposalId
  })
  ;(adapterResult as { wireBytes: number }).wireBytes = 1
  assert.equal((await repository.execute(request)).status, 'corrupt')
  await assert.rejects(repository.execute({ ...request, limit: 65 }), TypeError)
  await assert.rejects(repository.execute({ ...request, states: new Array(1) }), TypeError)
})

test('record control reads expose content only before purge and keep purge_due body-free', async () => {
  const { record } = approvedRecordAndRevision()
  let adapterResult: unknown = {
    status: 'found',
    operation: 'record.inspectGet',
    snapshotAt: NOW,
    value: { schemaVersion: 1, lifecycleState: 'current', record }
  }
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => adapterResult
  })
  const request = { ...requestBase('record.inspectGet'), memoryId: record.memoryId }
  const current = await repository.execute(request)
  assert.equal(current.status, 'found')
  assert.equal(JSON.stringify(current).includes('喜欢无糖咖啡'), true)

  const purgeSnapshot = record.retention.purgeAt
  adapterResult = {
    status: 'found',
    operation: 'record.inspectGet',
    snapshotAt: purgeSnapshot,
    value: {
      schemaVersion: 1,
      lifecycleState: 'purge_due',
      namespaceRef: record.namespaceRef,
      namespaceGeneration: record.namespaceGeneration,
      memoryId: record.memoryId,
      revision: record.revision,
      validUntil: record.retention.validUntil,
      purgeAt: record.retention.purgeAt
    }
  }
  const purged = await repository.execute(request)
  assert.equal(purged.status, 'found')
  assert.equal(JSON.stringify(purged).includes(record.text), false)
  assert.equal(JSON.stringify(purged).includes(record.contentHash), false)
  assert.equal(JSON.stringify(purged).includes('sources'), false)

  adapterResult = {
    status: 'found',
    operation: 'record.inspectGet',
    snapshotAt: purgeSnapshot,
    value: { schemaVersion: 1, lifecycleState: 'expired', record }
  }
  assert.deepEqual(await repository.execute(request), {
    status: 'corrupt', category: 'adapter_contract'
  })
  adapterResult = {
    status: 'found',
    operation: 'record.inspectGet',
    snapshotAt: purgeSnapshot,
    value: {
      schemaVersion: 1,
      lifecycleState: 'purge_due',
      namespaceRef: record.namespaceRef,
      namespaceGeneration: record.namespaceGeneration,
      memoryId: record.memoryId,
      revision: record.revision,
      validUntil: record.retention.validUntil,
      purgeAt: record.retention.purgeAt,
      contentHash: record.contentHash
    }
  }
  assert.equal((await repository.execute(request)).status, 'corrupt')
  adapterResult = {
    status: 'found',
    operation: 'record.inspectGet',
    snapshotAt: new Date(Date.parse(purgeSnapshot) + 1).toISOString(),
    value: {
      schemaVersion: 1,
      lifecycleState: 'purge_due',
      namespaceRef: record.namespaceRef,
      namespaceGeneration: record.namespaceGeneration,
      memoryId: record.memoryId,
      revision: record.revision,
      validUntil: record.retention.validUntil,
      purgeAt: new Date(Date.parse(record.retention.purgeAt) + 1).toISOString()
    }
  }
  assert.equal((await repository.execute(request)).status, 'corrupt')
})

test('record and revision pages require stable unique order and revision history fails closed', async () => {
  const { record, revision } = approvedRecordAndRevision()
  const purgeAt = record.retention.purgeAt
  const projection = (memoryId: string) => ({
    schemaVersion: 1,
    lifecycleState: 'purge_due',
    namespaceRef: record.namespaceRef,
    namespaceGeneration: 1,
    memoryId,
    revision: 1,
    validUntil: record.retention.validUntil,
    purgeAt
  })
  let adapterResult: unknown
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => adapterResult
  })
  const listRequest = {
    ...requestBase('record.inspectList'),
    cursor: null,
    limit: 4,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const records = [projection(`memory:${'b'.repeat(64)}`), projection(`memory:${'a'.repeat(64)}`)]
  adapterResult = {
    status: 'page', operation: 'record.inspectList', snapshotAt: purgeAt, records,
    nextCursor: null, wireBytes: pageWireBytes(records, []), corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(listRequest)).status, 'corrupt')

  const historyRequest = {
    ...requestBase('revision.list'),
    memoryId: record.memoryId,
    cursor: null,
    cursorAnchor: null,
    limit: 32,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const head = revisionHeadProof(record, revision)
  adapterResult = {
    status: 'page', operation: 'revision.list', snapshotAt: NOW, records: [revision],
    nextCursor: null, wireBytes: pageWireBytes([revision], [record.memoryId]),
    nextCursorAnchor: null, corruptRecords: 1, corruptRefs: [record.memoryId], head
  }
  assert.deepEqual(await repository.execute(historyRequest), {
    status: 'corrupt', category: 'adapter_contract'
  })
  adapterResult = { status: 'corrupt', category: 'canonical_data' }
  assert.deepEqual(await repository.execute(historyRequest), {
    status: 'corrupt', category: 'canonical_data'
  })
  await assert.rejects(repository.execute({ ...historyRequest, limit: 33 }), TypeError)
})

test('revision reads bind current-head lifecycle, cursor anchors and a complete hash chain', async () => {
  const first = approvedRecordAndRevision().revision
  const second = renewedRevision()
  const head = revisionHeadProof(second.record, second)
  let adapterResult: unknown
  let calls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return adapterResult
    }
  })
  const getRequest = {
    ...requestBase('revision.get'),
    memoryId: first.memoryId,
    revision: 1
  }
  adapterResult = {
    status: 'found', operation: 'revision.get', snapshotAt: NOW, value: first, head
  }
  assert.equal((await repository.execute(getRequest)).status, 'found')

  const initialRequest = {
    ...requestBase('revision.list'),
    memoryId: first.memoryId,
    cursor: null,
    cursorAnchor: null,
    limit: 1,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
  }
  const firstAnchor = {
    schemaVersion: 1 as const,
    revision: first.revision,
    revisionHash: first.revisionHash
  }
  const nextCursor = memoryRevisionHistoryCursorV1({
    schemaVersion: 1,
    namespaceRef: first.record.namespaceRef,
    namespaceGeneration: first.record.namespaceGeneration,
    memoryId: first.memoryId,
    anchor: firstAnchor
  })
  const firstMetadata = { head, nextCursorAnchor: firstAnchor }
  adapterResult = {
    status: 'page', operation: 'revision.list', snapshotAt: NOW, records: [first],
    nextCursor, nextCursorAnchor: firstAnchor,
    wireBytes: pageWireBytes([first], [], firstMetadata),
    corruptRecords: 0, corruptRefs: [], head
  }
  assert.equal((await repository.execute(initialRequest)).status, 'page')

  const continuationRequest = {
    ...initialRequest,
    cursor: nextCursor,
    cursorAnchor: firstAnchor
  }
  const finalMetadata = { head, nextCursorAnchor: null }
  adapterResult = {
    status: 'page', operation: 'revision.list', snapshotAt: NOW, records: [second],
    nextCursor: null, nextCursorAnchor: null,
    wireBytes: pageWireBytes([second], [], finalMetadata),
    corruptRecords: 0, corruptRefs: [], head
  }
  assert.equal((await repository.execute(continuationRequest)).status, 'page')

  adapterResult = {
    status: 'page', operation: 'revision.list', snapshotAt: NOW, records: [second],
    nextCursor: null, nextCursorAnchor: null,
    wireBytes: pageWireBytes([second], [], finalMetadata),
    corruptRecords: 0, corruptRefs: [], head
  }
  assert.equal((await repository.execute(initialRequest)).status, 'corrupt')

  const forgedAnchor = { ...firstAnchor, revisionHash: '0'.repeat(64) }
  const forgedCursor = memoryRevisionHistoryCursorV1({
    schemaVersion: 1,
    namespaceRef: first.record.namespaceRef,
    namespaceGeneration: first.record.namespaceGeneration,
    memoryId: first.memoryId,
    anchor: forgedAnchor
  })
  assert.equal((await repository.execute({
    ...initialRequest,
    cursor: forgedCursor,
    cursorAnchor: forgedAnchor
  })).status, 'corrupt')

  const beforeWrongBinding = calls
  await assert.rejects(repository.execute({
    ...continuationRequest,
    memoryId: `memory:${'9'.repeat(64)}`
  }), TypeError)
  assert.equal(calls, beforeWrongBinding)

  const purgeAt = second.record.retention.purgeAt
  const purgeHead = revisionHeadProof(second.record, second, purgeAt)
  adapterResult = {
    status: 'found', operation: 'revision.get', snapshotAt: purgeAt, value: second,
    head: purgeHead
  }
  assert.equal((await repository.execute({ ...getRequest, revision: 2 })).status, 'corrupt')
  adapterResult = {
    status: 'record_purge_due', operation: 'revision.get', snapshotAt: purgeAt, head: purgeHead
  }
  const purgedGet = await repository.execute({ ...getRequest, revision: 2 })
  assert.equal(purgedGet.status, 'record_purge_due')
  assert.equal(JSON.stringify(purgedGet).includes(second.record.text), false)
  assert.equal(JSON.stringify(purgedGet).includes(second.revisionHash), false)

  adapterResult = {
    status: 'page', operation: 'revision.list', snapshotAt: purgeAt, records: [first, second],
    nextCursor: null, nextCursorAnchor: null,
    wireBytes: pageWireBytes([first, second], [], { head: purgeHead, nextCursorAnchor: null }),
    corruptRecords: 0, corruptRefs: [], head: purgeHead
  }
  assert.equal((await repository.execute({ ...initialRequest, limit: 2 })).status, 'corrupt')
  adapterResult = {
    status: 'record_purge_due', operation: 'revision.list', snapshotAt: purgeAt, head: purgeHead
  }
  assert.equal((await repository.execute(initialRequest)).status, 'record_purge_due')
})

test('body-free tombstone and audit pages can target an old generation with stable order', async () => {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const firstTombstone = tombstoneSummary(
    `tombstone:${'1'.repeat(64)}`,
    '2026-07-20T00:00:00.000Z',
    '2026-08-19T00:00:00.000Z'
  )
  const secondTombstone = tombstoneSummary(
    `tombstone:${'2'.repeat(64)}`,
    '2026-07-20T00:01:00.000Z',
    '2026-08-19T00:01:00.000Z'
  )
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
  const firstAudit = audit('2026-07-20T00:00:00.000Z', 'd'.repeat(64))
  const secondAudit = audit('2026-07-20T00:01:00.000Z', 'e'.repeat(64))
  let adapterResult: unknown
  let adapterCalls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async envelope => {
      adapterCalls += 1
      const request = envelope.request
      assert.equal(request.generation, 2)
      assert.equal('targetGeneration' in request && request.targetGeneration, 1)
      return adapterResult
    }
  })
  const base = {
    cursor: null,
    limit: 4,
    maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes,
    targetGeneration: 1
  }
  const tombstoneRequest = {
    ...requestBase('tombstone.list', namespace, 'personal_subject', 2),
    ...base
  }
  const groupAdminOldGenerationRequest = {
    ...requestBase('tombstone.list', groupNamespace(), 'group_admin', 2, ['inspect_full']),
    ...base
  }
  assert.deepEqual(await repository.execute(groupAdminOldGenerationRequest), {
    status: 'denied', category: 'authority'
  })
  assert.equal(adapterCalls, 0)
  const tombstones = [firstTombstone, secondTombstone]
  const tombstoneProjections = tombstones.map(tombstoneControlProjection)
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW, records: tombstones,
    nextCursor: null, wireBytes: pageWireBytes(tombstoneProjections, []),
    corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(tombstoneRequest)).status, 'page')
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW,
    records: [tombstoneControlProjection(firstTombstone)],
    nextCursor: null,
    wireBytes: pageWireBytes([tombstoneControlProjection(firstTombstone)], []),
    corruptRecords: 0,
    corruptRefs: []
  }
  assert.equal((await repository.execute(tombstoneRequest)).status, 'corrupt')
  const forgedReceiptTombstone = { ...firstTombstone, receiptHash: 'f'.repeat(64) }
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW,
    records: [forgedReceiptTombstone],
    nextCursor: null,
    wireBytes: pageWireBytes([tombstoneControlProjection(forgedReceiptTombstone)], []),
    corruptRecords: 0,
    corruptRefs: []
  }
  assert.equal((await repository.execute(tombstoneRequest)).status, 'corrupt')
  const hostileTombstone = {
    ...firstTombstone,
    tombstoneId: 'tombstone:raw-qq-123456',
    deletedByActorRef: 'actor:123456',
    reasonCode: '喜欢无糖咖啡'
  }
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW,
    records: [hostileTombstone],
    nextCursor: null,
    wireBytes: pageWireBytes([tombstoneControlProjection(firstTombstone)], []),
    corruptRecords: 0,
    corruptRefs: []
  }
  const hostileTombstoneResult = await repository.execute(tombstoneRequest)
  assert.equal(hostileTombstoneResult.status, 'corrupt')
  assert.equal(JSON.stringify(hostileTombstoneResult).includes('123456'), false)
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW, records: [],
    nextCursor: CURSOR, wireBytes: pageWireBytes([], ['tombstone:raw-qq-123456']),
    corruptRecords: 1, corruptRefs: ['tombstone:raw-qq-123456']
  }
  assert.equal((await repository.execute(tombstoneRequest)).status, 'corrupt')
  const reversedTombstones = [...tombstones].reverse()
  const reversedTombstoneProjections = reversedTombstones.map(tombstoneControlProjection)
  adapterResult = {
    status: 'page', operation: 'tombstone.list', snapshotAt: NOW,
    records: reversedTombstones, nextCursor: null,
    wireBytes: pageWireBytes(reversedTombstoneProjections, []),
    corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(tombstoneRequest)).status, 'corrupt')

  const auditRequest = {
    ...requestBase('audit.list', namespace, 'personal_subject', 2),
    ...base
  }
  const audits = [secondAudit, firstAudit]
  adapterResult = {
    status: 'page', operation: 'audit.list', snapshotAt: NOW, records: audits,
    nextCursor: null, wireBytes: pageWireBytes(audits, []), corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(auditRequest)).status, 'corrupt')
  const orderedAudits = [...audits].reverse()
  adapterResult = {
    status: 'page', operation: 'audit.list', snapshotAt: NOW, records: orderedAudits,
    nextCursor: null, wireBytes: pageWireBytes(orderedAudits, []),
    corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(auditRequest)).status, 'page')
  await assert.rejects(repository.execute({ ...auditRequest, targetGeneration: 3 }), TypeError)
})

test('deletion status and resolve return only exact body-free immutable evidence', async () => {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const command = `command:${'9'.repeat(64)}`
  const memoryId = approvedRecordAndRevision().record.memoryId
  const receipt = createDeletionMutationReceiptV1({
    commandRefHash: memoryLifecycleCommandRefHashV1(command),
    operation: 'forget',
    repositoryReceiptHash: '1'.repeat(64),
    namespaceRef,
    generationBefore: 1,
    generationAfter: 1,
    deletingGeneration: 1,
    memoryId,
    deletedRevision: 1,
    committedAt: NOW,
    tombstoneReceiptHash: '2'.repeat(64)
  })
  const deletionStatus = createDeletionStatusV1({
    deletionRef: receipt.deletionRef,
    namespaceRef,
    deletingGeneration: 1,
    observedCurrentGeneration: 1,
    remainingCarrierKinds: ['content_outbox'],
    canonicalBodies: 'scrub_pending',
    payloadDeletion: 'unverified',
    walCheckpoint: 'unverified',
    derivedCleanup: 'queued',
    stage: 'verification_pending',
    observedAt: NOW
  })
  let adapterResult: unknown = {
    status: 'resolved',
    operation: 'deletion.resolve',
    snapshotAt: NOW,
    receipt,
    deletionStatus
  }
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => adapterResult
  })
  const resolveRequest = {
    ...requestBase('deletion.resolve'),
    deletionRef: receipt.deletionRef,
    commandRef: command
  }
  const resolved = await repository.execute(resolveRequest)
  assert.equal(resolved.status, 'resolved')
  assert.equal(Object.isFrozen(resolved), true)
  assert.equal(JSON.stringify(resolved).includes('喜欢无糖咖啡'), false)
  assert.equal(JSON.stringify(resolved).includes(FIXTURE_IDS.subjectUserId), false)

  adapterResult = {
    status: 'found',
    operation: 'deletion.getStatus',
    snapshotAt: NOW,
    value: deletionStatus
  }
  assert.equal((await repository.execute({
    ...requestBase('deletion.getStatus'), deletionRef: receipt.deletionRef
  })).status, 'found')
  assert.equal((await repository.execute({
    ...requestBase(
      'deletion.getStatus', namespace, 'personal_bot_master', 1, ['resolve_deletion']
    ),
    deletionRef: receipt.deletionRef
  })).status, 'found')

  adapterResult = {
    status: 'resolved',
    operation: 'deletion.resolve',
    snapshotAt: NOW,
    receipt,
    deletionStatus
  }
  assert.equal((await repository.execute({
    ...resolveRequest, commandRef: `command:${'8'.repeat(64)}`
  })).status, 'corrupt')
  adapterResult = {
    status: 'resolved',
    operation: 'deletion.resolve',
    snapshotAt: NOW,
    receipt,
    deletionStatus,
    text: 'secret'
  }
  assert.equal((await repository.execute(resolveRequest)).status, 'corrupt')
})

test('adapter result validation rejects proxies, accessors, symbols, sparse arrays and cross-operation shapes', async () => {
  let getterCalls = 0
  let adapterResult: unknown
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => adapterResult
  })
  const inspectRequest = {
    ...requestBase('proposal.inspect'),
    proposalId: proposal().proposalId
  }
  for (const category of ['access', 'authority'] as const) {
    adapterResult = { status: 'denied', category }
    assert.deepEqual(await repository.execute(inspectRequest), { status: 'denied', category })
  }
  adapterResult = new Proxy({
    status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW
  }, {})
  assert.equal((await repository.execute(inspectRequest)).status, 'corrupt')
  const accessor = { status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW }
  Object.defineProperty(accessor, 'secret', {
    get: () => { getterCalls += 1; return proposal().text },
    enumerable: true
  })
  adapterResult = accessor
  assert.equal((await repository.execute(inspectRequest)).status, 'corrupt')
  assert.equal(getterCalls, 0)
  const symbolResult = { status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW }
  Object.defineProperty(symbolResult, Symbol('secret'), { value: true, enumerable: true })
  adapterResult = symbolResult
  assert.equal((await repository.execute(inspectRequest)).status, 'corrupt')
  adapterResult = { status: 'not_found', operation: 'record.inspectGet', snapshotAt: NOW }
  assert.equal((await repository.execute(inspectRequest)).status, 'corrupt')

  const pageRequest = {
    ...requestBase('proposal.list'), cursor: null, limit: 4, maxWireBytes: 4_096
  }
  const sparse = new Array(1)
  adapterResult = {
    status: 'page', operation: 'proposal.list', snapshotAt: NOW, records: sparse,
    nextCursor: null, wireBytes: pageWireBytes(sparse, []), corruptRecords: 0, corruptRefs: []
  }
  assert.equal((await repository.execute(pageRequest)).status, 'corrupt')
})

test('adapter exceptions are redacted and every late abort overrides success or failure', async () => {
  const request = {
    ...requestBase('proposal.inspect'), proposalId: proposal().proposalId
  }
  const throwing = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => { throw new Error(proposal().text) }
  })
  const failed = await throwing.execute(request)
  assert.deepEqual(failed, { status: 'unavailable', category: 'io', retryable: true })
  assert.equal(JSON.stringify(failed).includes(proposal().text), false)

  for (const reject of [false, true]) {
    let settle: (() => void) | undefined
    const repository = createMemoryControlRepositoryPortV1({
      now: () => NOW,
      execute: async () => await new Promise((resolve, rejectPromise) => {
        settle = () => reject
          ? rejectPromise(new Error(proposal().text))
          : resolve({ status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW })
      })
    })
    const controller = new AbortController()
    const pending = repository.execute(request, controller.signal)
    while (settle === undefined) await Promise.resolve()
    controller.abort()
    settle()
    assert.deepEqual(await pending, { status: 'aborted' })
  }
})

test('pre-abort still strictly parses hostile requests and never invokes their getters', async () => {
  let calls = 0
  let getterCalls = 0
  const repository = createMemoryControlRepositoryPortV1({
    now: () => NOW,
    execute: async () => {
      calls += 1
      return { status: 'not_found', operation: 'proposal.inspect', snapshotAt: NOW }
    }
  })
  const hostile = {
    ...requestBase('proposal.inspect'),
    proposalId: proposal().proposalId
  }
  Object.defineProperty(hostile, 'secret', {
    get: () => { getterCalls += 1; return 'secret' },
    enumerable: true
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(repository.execute(hostile, controller.signal), TypeError)
  const valid = {
    ...requestBase('proposal.inspect'),
    proposalId: proposal().proposalId
  }
  await assert.rejects(repository.execute({
    ...valid,
    access: new Proxy(valid.access, {})
  }, controller.signal), TypeError)
  assert.equal(getterCalls, 0)
  assert.equal(calls, 0)
})
