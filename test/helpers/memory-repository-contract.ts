import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  decideMemoryAccessV1,
  issueMemoryAccessCapabilityV1,
  type MemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  memoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import {
  encodeMemoryProposalV1,
  encodeMemoryRecordV1
} from '../../src/agent/memory/memory-codec.js'
import type {
  MemoryOutboxPortV1,
  MemoryOutboxRequestV1
} from '../../src/agent/memory/memory-outbox.js'
import type {
  MemoryRepositoryPortV1,
  MemoryRepositoryRequestV1
} from '../../src/agent/memory/memory-repository.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  deepFreezeFixture,
  groupSceneFixture,
  memoryOutboxEventFixture,
  memoryProposalFixture,
  memoryRecordFixture,
  memoryRevisionFixture,
  memorySourceFixture,
  memoryTombstoneFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from './memory-fixture.js'

const NOW = FIXTURE_TIMES.observedAt
const LATER = '2026-07-19T00:02:00.000Z'
const RECEIPT = `memory-receipt:v1:${'a'.repeat(64)}`
const CURSOR = `memory-cursor:v1:${'b'.repeat(64)}`
const NEXT_CURSOR = `memory-cursor:v1:${'e'.repeat(64)}`
const LEASE = `memory-lease:v1:${'c'.repeat(64)}`
const OTHER_LEASE = `memory-lease:v1:${'d'.repeat(64)}`
const OWNER = 'groupmate-memory-worker'

type RepositoryExecute = (
  request: MemoryRepositoryRequestV1,
  signal?: AbortSignal
) => Promise<unknown>

type OutboxExecute = (
  request: MemoryOutboxRequestV1,
  signal?: AbortSignal
) => Promise<unknown>

type ApprovedDecisionRequestV1 = Extract<MemoryRepositoryRequestV1, {
  readonly operation: 'proposal.decide'
  readonly nextProposal: { readonly state: 'approved' }
  readonly initialRevision: object
}>
type DeclinedDecisionRequestV1 = Extract<MemoryRepositoryRequestV1, {
  readonly operation: 'proposal.decide'
  readonly nextProposal: { readonly state: 'rejected' | 'expired' }
  readonly initialRevision: null
}>
type IsNever<T> = [T] extends [never] ? true : false
type AssertFalse<T extends false> = T
type ProposalDecisionTypeMatrix = [
  AssertFalse<IsNever<ApprovedDecisionRequestV1>>,
  AssertFalse<IsNever<DeclinedDecisionRequestV1>>
]
const proposalDecisionTypeMatrix: ProposalDecisionTypeMatrix = [false, false]

export interface MemoryPortContractFactory {
  readonly name: string
  repository(options: {
    readonly now: () => string
    readonly execute: RepositoryExecute
  }): MemoryRepositoryPortV1
  outbox(options: {
    readonly now: () => string
    readonly execute: OutboxExecute
  }): MemoryOutboxPortV1
}

function assertDeepFrozen (value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, seen)
    }
  }
}

function abortSignalSymbol (signal: AbortSignal, description: string): symbol {
  const key = Reflect.ownKeys(signal).find(candidate => (
    typeof candidate === 'symbol' && candidate.description === description
  ))
  assert.equal(typeof key, 'symbol')
  return key as symbol
}

function accessFixture (): {
  readonly capability: MemoryAccessCapabilityV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly decision: unknown
  readonly forged: unknown
} {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const context = deepFreezeFixture({
    schemaVersion: 1,
    botInstanceId: FIXTURE_IDS.botInstanceId,
    adapter: 'qq',
    accountId: FIXTURE_IDS.accountId,
    scene: deepFreezeFixture({
      kind: 'private',
      peerUserId: FIXTURE_IDS.subjectUserId
    })
  })
  const decision = decideMemoryAccessV1(context, [namespace])
  const capability = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    context,
    [namespace],
    NOW
  )
  return Object.freeze({
    capability,
    namespaceRef,
    decision,
    forged: deepFreezeFixture(JSON.parse(JSON.stringify(capability)) as object)
  })
}

function approvedProposalFixture () {
  return memoryProposalFixture({
    revision: 2,
    state: 'approved',
    decision: deepFreezeFixture({
      decidedAt: FIXTURE_TIMES.confirmedAt,
      decidedByActorRef: FIXTURE_IDS.actorRef,
      reason: null
    })
  })
}

function namespaceTombstoneFixture () {
  return memoryTombstoneFixture({
    deletionKind: 'namespace_deleted',
    namespaceGeneration: 2,
    memoryId: null,
    deletedRevision: null
  })
}

function initialRevisionFixture (record = memoryRecordFixture()) {
  return memoryRevisionFixture({ record })
}

function correctedRevisionFixture () {
  const previous = memoryRevisionFixture()
  const record = memoryRecordFixture({
    revision: 2,
    text: '喜欢低因无糖咖啡',
    updatedAt: '2026-07-19T00:03:00.000Z'
  })
  return memoryRevisionFixture({
    revision: 2,
    operation: 'corrected',
    record,
    changedAt: record.updatedAt,
    reason: '用户更正',
    previousRevisionHash: previous.revisionHash
  })
}

function repositoryRequests (
  capability: MemoryAccessCapabilityV1,
  namespaceRef: MemoryNamespaceRefV1
): readonly Readonly<Record<string, unknown>>[] {
  return deepFreezeFixture([
    {
      schemaVersion: 1,
      operation: 'proposal.create',
      capability,
      namespaceRef,
      expectedNamespaceGeneration: 1,
      proposal: memoryProposalFixture()
    },
    {
      schemaVersion: 1,
      operation: 'proposal.load',
      capability,
      namespaceRef,
      proposalId: FIXTURE_IDS.proposalId
    },
    {
      schemaVersion: 1,
      operation: 'proposal.decide',
      capability,
      namespaceRef,
      expectedRevision: 1,
      expectedNamespaceGeneration: 1,
      nextProposal: approvedProposalFixture(),
      initialRevision: initialRevisionFixture()
    },
    {
      schemaVersion: 1,
      operation: 'record.create',
      capability,
      namespaceRef,
      expectedNamespaceGeneration: 1,
      initialRevision: initialRevisionFixture()
    },
    {
      schemaVersion: 1,
      operation: 'record.get',
      capability,
      namespaceRef,
      memoryId: FIXTURE_IDS.memoryId
    },
    {
      schemaVersion: 1,
      operation: 'record.list',
      capability,
      namespaceRef,
      cursor: null,
      limit: 16,
      maxWireBytes: 64 * 1_024
    },
    {
      schemaVersion: 1,
      operation: 'record.correct',
      capability,
      namespaceRef,
      expectedRevision: 1,
      expectedNamespaceGeneration: 1,
      nextRevision: correctedRevisionFixture()
    },
    {
      schemaVersion: 1,
      operation: 'record.forget',
      capability,
      namespaceRef,
      expectedRevision: 1,
      expectedNamespaceGeneration: 1,
      tombstone: memoryTombstoneFixture()
    },
    {
      schemaVersion: 1,
      operation: 'namespace.delete',
      capability,
      namespaceRef,
      expectedNamespaceGeneration: 1,
      tombstone: namespaceTombstoneFixture()
    },
    {
      schemaVersion: 1,
      operation: 'usage.get',
      capability,
      namespaceRef
    }
  ])
}

function mutationResult (value: unknown): Readonly<Record<string, unknown>> {
  return deepFreezeFixture({ status: 'stored', value, receipt: RECEIPT })
}

function usageValue (): Readonly<Record<string, unknown>> {
  return deepFreezeFixture({
    schemaVersion: 1,
    namespaceRef: memoryNamespaceRefV1(personalMemoryNamespaceFixture()),
    namespaceGeneration: 1,
    pendingProposalRecords: 1,
    activeMemoryRecords: 1,
    retainedRevisionRecords: 1,
    tombstoneRecords: 1,
    canonicalLogicalBytes: 2_048,
    pendingOutboxRecords: 1,
    outboxLogicalBytes: 512
  })
}

function oversizedSourcesFixture () {
  const identityText = '😀'.repeat(MEMORY_RESOURCE_LIMITS.identityTextCodePoints)
  const actor = qqIdentityFixture({
    nickname: identityText,
    groupCard: identityText,
    groupTitle: identityText,
    displayName: identityText
  })
  const scene = groupSceneFixture({ groupName: identityText })
  return Array.from({ length: MEMORY_RESOURCE_LIMITS.sources }, (_, index) => (
    memorySourceFixture({
      messageId: `message-oversized-${index + 1}`,
      actor,
      scene,
      normalizedText: 's'.repeat(MEMORY_RESOURCE_LIMITS.sourceExcerptUtf8Bytes)
    })
  ))
}

function repositoryReply (request: MemoryRepositoryRequestV1): unknown {
  switch (request.operation) {
    case 'proposal.create': return mutationResult(request.proposal)
    case 'proposal.load': return deepFreezeFixture({ status: 'found', value: memoryProposalFixture() })
    case 'proposal.decide': return mutationResult(request.nextProposal)
    case 'record.create': return mutationResult(request.initialRevision.record)
    case 'record.get': return deepFreezeFixture({ status: 'found', value: memoryRecordFixture() })
    case 'record.list': return deepFreezeFixture({
      status: 'page',
      records: [memoryRecordFixture()],
      nextCursor: request.cursor === CURSOR ? NEXT_CURSOR : CURSOR
    })
    case 'record.correct': return mutationResult(request.nextRevision.record)
    case 'record.forget': return mutationResult(request.tombstone)
    case 'namespace.delete': return mutationResult(request.tombstone)
    case 'usage.get': return deepFreezeFixture({ status: 'usage', value: usageValue() })
  }
}

function baseRecordGetRequest (
  capability: unknown,
  namespaceRef: unknown
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: 'record.get',
    capability,
    namespaceRef,
    memoryId: FIXTURE_IDS.memoryId
  }
}

export function registerMemoryPortContract (factory: MemoryPortContractFactory): void {
  describe(`${factory.name} memory repository port contract`, () => {
    test('dispatches the complete backend-neutral operation surface with canonical frozen values', async () => {
      const { capability, namespaceRef } = accessFixture()
      const seen: MemoryRepositoryRequestV1[] = []
      const port = factory.repository({
        now: () => NOW,
        execute: async request => {
          assertDeepFrozen(request)
          seen.push(request)
          return repositoryReply(request)
        }
      })
      assert.equal(Object.isFrozen(port), true)
      const requests = repositoryRequests(capability, namespaceRef)
      const results = []
      for (const request of requests) results.push(await port.execute({ ...request }))

      assert.deepEqual(seen.map(value => value.operation), [
        'proposal.create',
        'proposal.load',
        'proposal.decide',
        'record.create',
        'record.get',
        'record.list',
        'record.correct',
        'record.forget',
        'namespace.delete',
        'usage.get'
      ])
      for (const result of results) assertDeepFrozen(result)
      const page = results[5] as Readonly<Record<string, unknown>>
      assert.equal(page.status, 'page')
      assert.equal(
        page.wireBytes,
        Buffer.byteLength(JSON.stringify([memoryRecordFixture()]), 'utf8')
      )
      assert.equal(page.nextCursor, CURSOR)
    })

    test('requires an authentic current capability for the exact namespace', async () => {
      const access = accessFixture()
      let calls = 0
      const port = factory.repository({
        now: () => NOW,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      for (const capability of [
        access.decision,
        access.namespaceRef,
        access.forged
      ]) {
        await assert.rejects(
          port.execute(baseRecordGetRequest(capability, access.namespaceRef)),
          TypeError
        )
      }
      await assert.rejects(
        port.execute(baseRecordGetRequest(access.capability, 'f'.repeat(64))),
        TypeError
      )
      assert.equal(calls, 0)

      const expired = factory.repository({
        now: () => LATER,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      await assert.rejects(
        expired.execute(baseRecordGetRequest(access.capability, access.namespaceRef)),
        TypeError
      )
      assert.equal(calls, 0)
    })

    test('rejects extra keys, accessors and proxies before invoking the adapter', async () => {
      const access = accessFixture()
      let calls = 0
      let traps = 0
      const port = factory.repository({
        now: () => NOW,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      const valid = baseRecordGetRequest(access.capability, access.namespaceRef)
      const getter = { ...valid }
      Object.defineProperty(getter, 'memoryId', {
        enumerable: true,
        get: () => {
          traps += 1
          throw new Error('private getter body')
        }
      })
      const proxy = new Proxy({ ...valid }, {
        get: () => {
          traps += 1
          throw new Error('private proxy body')
        },
        ownKeys: () => {
          traps += 1
          throw new Error('private proxy body')
        }
      })
      const hostileSignal = new AbortController().signal
      Object.defineProperty(hostileSignal, 'aborted', {
        configurable: true,
        get: () => {
          traps += 1
          throw new Error('private signal body')
        }
      })
      const hostileSymbolSignal = new AbortController().signal
      Object.defineProperty(hostileSymbolSignal, abortSignalSymbol(hostileSymbolSignal, 'kAborted'), {
        configurable: true,
        enumerable: true,
        get: () => {
          traps += 1
          throw new Error('private signal symbol body')
        }
      })
      const hostileEventsSignal = new AbortController().signal
      Object.defineProperty(
        hostileEventsSignal,
        abortSignalSymbol(hostileEventsSignal, 'kEvents'),
        {
          configurable: true,
          enumerable: true,
          writable: true,
          value: new Proxy({}, {
            get: () => {
              traps += 1
              throw new Error('private signal events body')
            }
          })
        }
      )
      for (const invalid of [
        { ...valid, extra: true },
        { ...valid, operation: 'record.offset' },
        getter,
        proxy
      ]) await assert.rejects(port.execute(invalid), TypeError)
      await assert.rejects(port.execute(valid, hostileSignal), TypeError)
      await assert.rejects(port.execute(valid, hostileSymbolSignal), TypeError)
      await assert.rejects(port.execute(valid, hostileEventsSignal), TypeError)
      assert.equal(calls, 0)
      assert.equal(traps, 0)
    })

    test('enforces proposal and record canonical wire ceilings at both port directions', async () => {
      const access = accessFixture()
      const requests = repositoryRequests(access.capability, access.namespaceRef)
      const sources = oversizedSourcesFixture()
      const proposal = memoryProposalFixture({ sources })
      const recordBase = memoryRecordFixture()
      const record = memoryRecordFixture({
        sources,
        consent: {
          ...recordBase.consent,
          evidenceSourceId: sources[0]!.sourceId
        }
      })
      assert.throws(() => encodeMemoryProposalV1(proposal), TypeError)
      assert.throws(() => encodeMemoryRecordV1(record), TypeError)

      let calls = 0
      const inbound = factory.repository({
        now: () => NOW,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      await assert.rejects(inbound.execute({ ...requests[0], proposal }), TypeError)
      await assert.rejects(inbound.execute({
        ...requests[3],
        initialRevision: initialRevisionFixture(record)
      }), TypeError)
      assert.equal(calls, 0)

      for (const [request, value] of [
        [requests[1], proposal],
        [requests[4], record]
      ] as const) {
        assert.ok(request)
        const outbound = factory.repository({
          now: () => NOW,
          execute: async () => ({ status: 'found', value })
        })
        assert.deepEqual(await outbound.execute(request), {
          status: 'corrupt',
          category: 'adapter_contract'
        })
      }
    })

    test('binds approval and record writes to revision-bearing atomic requests', async () => {
      const access = accessFixture()
      const requests = repositoryRequests(access.capability, access.namespaceRef)
      const approved = requests[2]
      const create = requests[3]
      const correct = requests[6]
      const deleteNamespace = requests[8]
      assert.ok(approved)
      assert.ok(create)
      assert.ok(correct)
      assert.ok(deleteNamespace)
      let calls = 0
      const port = factory.repository({
        now: () => NOW,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      assert.equal((await port.execute(approved)).status, 'stored')
      const rejectedProposal = memoryProposalFixture({
        revision: 2,
        state: 'rejected',
        decision: deepFreezeFixture({
          decidedAt: FIXTURE_TIMES.confirmedAt,
          decidedByActorRef: FIXTURE_IDS.actorRef,
          reason: '用户拒绝'
        })
      })
      const rejected = {
        ...approved,
        nextProposal: rejectedProposal,
        initialRevision: null
      }
      assert.equal((await port.execute(rejected)).status, 'stored')

      const otherActor = `actor:${'e'.repeat(64)}`
      for (const invalid of [
        { ...approved, initialRevision: null },
        { ...rejected, initialRevision: initialRevisionFixture() },
        {
          ...approved,
          initialRevision: initialRevisionFixture(memoryRecordFixture({ text: '未获批准的正文' }))
        },
        {
          ...approved,
          initialRevision: memoryRevisionFixture({ changedByActorRef: otherActor })
        },
        {
          ...approved,
          initialRevision: memoryRevisionFixture({ reason: '与审批决定不一致' })
        },
        {
          ...approved,
          initialRevision: initialRevisionFixture(memoryRecordFixture({
            createdAt: FIXTURE_TIMES.observedAt
          }))
        },
        { ...create, initialRevision: correctedRevisionFixture() },
        { ...correct, nextRevision: initialRevisionFixture() },
        {
          ...deleteNamespace,
          tombstone: memoryTombstoneFixture({
            deletionKind: 'namespace_deleted',
            namespaceGeneration: 1,
            memoryId: null,
            deletedRevision: null
          })
        },
        { ...create, record: memoryRecordFixture() },
        { ...correct, nextRecord: correctedRevisionFixture().record }
      ]) await assert.rejects(port.execute(invalid), TypeError)
      assert.deepEqual(proposalDecisionTypeMatrix, [false, false])
      assert.equal(calls, 2)
    })

    test('returns fixed typed outcomes without leaking adapter exception text', async () => {
      const access = accessFixture()
      const request = repositoryRequests(access.capability, access.namespaceRef)[3]
      assert.ok(request)
      const record = memoryRecordFixture()
      const outcomes = [
        { status: 'stored', value: record, receipt: RECEIPT },
        { status: 'unchanged', value: record, receipt: RECEIPT },
        { status: 'conflict', category: 'revision' },
        { status: 'capacity', category: 'active_records' },
        { status: 'corrupt', category: 'canonical_data' },
        { status: 'unavailable', category: 'busy', retryable: true }
      ] as const
      for (const outcome of outcomes) {
        const port = factory.repository({
          now: () => NOW,
          execute: async () => deepFreezeFixture(outcome)
        })
        const result = await port.execute(request)
        assert.deepEqual(result, outcome)
        assertDeepFrozen(result)
      }

      const throwing = factory.repository({
        now: () => NOW,
        execute: async () => { throw new Error('private body QQ 20000002') }
      })
      const unavailable = await throwing.execute(request)
      assert.deepEqual(unavailable, {
        status: 'unavailable',
        category: 'io',
        retryable: true
      })
      assert.doesNotMatch(JSON.stringify(unavailable), /private|20000002/)

      const malformed = factory.repository({
        now: () => NOW,
        execute: async () => ({ status: 'stored', body: 'private', receipt: RECEIPT })
      })
      assert.deepEqual(await malformed.execute(request), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const replaced = factory.repository({
        now: () => NOW,
        execute: async () => ({
          status: 'stored',
          value: memoryRecordFixture({ text: '同一版本被替换的正文' }),
          receipt: RECEIPT
        })
      })
      assert.deepEqual(await replaced.execute(request), {
        status: 'corrupt',
        category: 'adapter_contract'
      })
    })

    test('aborts before dispatch and preserves an opaque committed-after-abort receipt', async () => {
      const access = accessFixture()
      const request = repositoryRequests(access.capability, access.namespaceRef)[3]
      assert.ok(request)
      let calls = 0
      const before = new AbortController()
      before.abort(new Error('private abort reason'))
      const port = factory.repository({
        now: () => NOW,
        execute: async () => {
          calls += 1
          return mutationResult(memoryRecordFixture())
        }
      })
      assert.deepEqual(await port.execute(request, before.signal), { status: 'aborted' })
      assert.equal(calls, 0)

      const during = new AbortController()
      const committed = factory.repository({
        now: () => NOW,
        execute: async () => {
          calls += 1
          during.abort(new Error('late private abort reason'))
          return { status: 'committed_after_abort', receipt: RECEIPT }
        }
      })
      assert.deepEqual(await committed.execute(request, during.signal), {
        status: 'committed_after_abort',
        receipt: RECEIPT
      })
      assert.equal(calls, 1)

      const ambiguous = new AbortController()
      const storedAfterAbort = factory.repository({
        now: () => NOW,
        execute: async () => {
          ambiguous.abort()
          return mutationResult(memoryRecordFixture())
        }
      })
      assert.deepEqual(await storedAfterAbort.execute(request, ambiguous.signal), {
        status: 'committed_after_abort',
        receipt: RECEIPT
      })

      for (const adapterResult of [
        { status: 'committed_after_abort', receipt: RECEIPT },
        { status: 'aborted' }
      ]) {
        const unjustified = factory.repository({
          now: () => NOW,
          execute: async () => adapterResult
        })
        assert.deepEqual(await unjustified.execute(request), {
          status: 'corrupt',
          category: 'adapter_contract'
        })
      }

      const readDuring = new AbortController()
      const read = repositoryRequests(access.capability, access.namespaceRef)[4]
      assert.ok(read)
      const invalidReadCommit = factory.repository({
        now: () => NOW,
        execute: async () => {
          readDuring.abort()
          return { status: 'committed_after_abort', receipt: RECEIPT }
        }
      })
      assert.deepEqual(await invalidReadCommit.execute(read, readDuring.signal), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const usage = repositoryRequests(access.capability, access.namespaceRef)[9]
      assert.ok(usage)
      const wrongUsage = factory.repository({
        now: () => NOW,
        execute: async () => ({
          status: 'usage',
          value: { ...usageValue(), namespaceRef: 'f'.repeat(64) }
        })
      })
      assert.deepEqual(await wrongUsage.execute(usage), {
        status: 'corrupt',
        category: 'adapter_contract'
      })
    })

    test('accepts a native AbortSignal.any composite and propagates abort safely', async () => {
      const access = accessFixture()
      const request = repositoryRequests(access.capability, access.namespaceRef)[4]
      assert.ok(request)
      const source = new AbortController()
      const composite = AbortSignal.any([source.signal])
      let calls = 0
      const port = factory.repository({
        now: () => NOW,
        execute: async (_request, signal) => {
          calls += 1
          assert.notEqual(signal, composite)
          source.abort(new Error('private composite abort reason'))
          assert.equal(signal?.aborted, true)
          return { status: 'aborted' }
        }
      })
      assert.deepEqual(await port.execute(request, composite), { status: 'aborted' })
      assert.equal(calls, 1)
    })

    test('uses a fixed opaque seek cursor and enforces page record and byte ceilings', async () => {
      const access = accessFixture()
      const base = repositoryRequests(access.capability, access.namespaceRef)[5]
      assert.ok(base)
      let calls = 0
      const validPort = factory.repository({
        now: () => NOW,
        execute: async request => {
          calls += 1
          return repositoryReply(request)
        }
      })
      assert.equal((await validPort.execute({ ...base, cursor: CURSOR }) as { status: string }).status, 'page')
      for (const invalid of [
        { ...base, cursor: `memory-cursor:v2:${'b'.repeat(64)}` },
        { ...base, cursor: 'offset:64' },
        { ...base, cursor: 64 },
        { ...base, offset: 64 },
        { ...base, limit: MEMORY_RESOURCE_LIMITS.listPageRecords + 1 },
        { ...base, maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes + 1 }
      ]) await assert.rejects(validPort.execute(invalid), TypeError)
      assert.equal(calls, 1)

      const tooMany = factory.repository({
        now: () => NOW,
        execute: async () => ({
          status: 'page',
          records: Array.from(
            { length: MEMORY_RESOURCE_LIMITS.listPageRecords + 1 },
            () => memoryRecordFixture()
          ),
          nextCursor: null
        })
      })
      assert.deepEqual(await tooMany.execute(base), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const oneRecordBytes = Buffer.byteLength(JSON.stringify([memoryRecordFixture()]), 'utf8')
      const tooManyBytes = factory.repository({
        now: () => NOW,
        execute: async () => ({
          status: 'page',
          records: [memoryRecordFixture()],
          nextCursor: null
        })
      })
      assert.deepEqual(await tooManyBytes.execute({
        ...base,
        maxWireBytes: oneRecordBytes - 1
      }), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const emptyContinuation = factory.repository({
        now: () => NOW,
        execute: async () => ({ status: 'page', records: [], nextCursor: CURSOR })
      })
      assert.deepEqual(await emptyContinuation.execute(base), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const cursorLoop = factory.repository({
        now: () => NOW,
        execute: async () => ({
          status: 'page',
          records: [memoryRecordFixture()],
          nextCursor: CURSOR
        })
      })
      assert.deepEqual(await cursorLoop.execute({ ...base, cursor: CURSOR }), {
        status: 'corrupt',
        category: 'adapter_contract'
      })
    })
  })

  describe(`${factory.name} memory outbox port contract`, () => {
    test('claims at most one bounded batch and requires the exact owner and lease for ack or retry', async () => {
      let activeOwner: string | null = null
      let activeLease: string | null = null
      const seen: MemoryOutboxRequestV1[] = []
      const port = factory.outbox({
        now: () => NOW,
        execute: async request => {
          assertDeepFrozen(request)
          seen.push(request)
          switch (request.operation) {
            case 'claim':
              activeOwner = request.ownerId
              activeLease = LEASE
              return {
                status: 'claimed',
                ownerId: request.ownerId,
                leaseToken: LEASE,
                leasedUntil: '2026-07-19T00:01:00.000Z',
                events: [memoryOutboxEventFixture()]
              }
            case 'ack':
              if (request.ownerId !== activeOwner || request.leaseToken !== activeLease) {
                return { status: 'lease_conflict' }
              }
              activeOwner = null
              activeLease = null
              return { status: 'acked' }
            case 'retry':
              if (request.ownerId !== activeOwner || request.leaseToken !== activeLease) {
                return { status: 'lease_conflict' }
              }
              activeOwner = null
              activeLease = null
              return { status: 'retried' }
            case 'usage':
              return {
                status: 'usage',
                value: {
                  schemaVersion: 1,
                  pendingRecords: 1,
                  leasedRecords: activeLease === null ? 0 : 1,
                  logicalBytes: 512
                }
              }
          }
        }
      })
      assert.equal(Object.isFrozen(port), true)
      const claimed = await port.execute({
        schemaVersion: 1,
        operation: 'claim',
        ownerId: OWNER,
        limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords
      })
      assert.equal(claimed.status, 'claimed')
      assertDeepFrozen(claimed)

      const common = {
        schemaVersion: 1,
        ownerId: OWNER,
        eventId: FIXTURE_IDS.eventId,
        sequence: 1
      } as const
      assert.deepEqual(await port.execute({
        ...common,
        operation: 'ack',
        leaseToken: OTHER_LEASE
      }), { status: 'lease_conflict' })
      assert.deepEqual(await port.execute({
        ...common,
        operation: 'ack',
        ownerId: 'another-memory-worker',
        leaseToken: LEASE
      }), { status: 'lease_conflict' })
      assert.deepEqual(await port.execute({
        ...common,
        operation: 'retry',
        leaseToken: LEASE,
        retryAt: '2026-07-19T00:01:00.000Z',
        reasonCode: 'downstream_unavailable'
      }), { status: 'retried' })
      await port.execute({
        schemaVersion: 1,
        operation: 'claim',
        ownerId: OWNER,
        limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords
      })
      assert.deepEqual(await port.execute({
        ...common,
        operation: 'ack',
        leaseToken: LEASE
      }), { status: 'acked' })
      assert.equal((await port.execute({ schemaVersion: 1, operation: 'usage' })).status, 'usage')
      assert.deepEqual(seen.map(value => value.operation), [
        'claim', 'ack', 'ack', 'retry', 'claim', 'ack', 'usage'
      ])
    })

    test('fails closed on oversized claims, forged lease forms, hostile input and adapter failures', async () => {
      let calls = 0
      let traps = 0
      const port = factory.outbox({
        now: () => NOW,
        execute: async () => {
          calls += 1
          return { status: 'empty' }
        }
      })
      const ack = {
        schemaVersion: 1,
        operation: 'ack',
        ownerId: OWNER,
        leaseToken: LEASE,
        eventId: FIXTURE_IDS.eventId,
        sequence: 1
      }
      const getter = { ...ack }
      Object.defineProperty(getter, 'leaseToken', {
        enumerable: true,
        get: () => {
          traps += 1
          throw new Error('private getter body')
        }
      })
      const proxy = new Proxy({ ...ack }, {
        ownKeys: () => {
          traps += 1
          throw new Error('private proxy body')
        }
      })
      const hostileSignal = new AbortController().signal
      Object.defineProperty(hostileSignal, 'aborted', {
        configurable: true,
        get: () => {
          traps += 1
          throw new Error('private signal body')
        }
      })
      const hostileSymbolSignal = new AbortController().signal
      Object.defineProperty(hostileSymbolSignal, abortSignalSymbol(hostileSymbolSignal, 'kAborted'), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { forged: true }
      })
      for (const invalid of [
        {
          schemaVersion: 1,
          operation: 'claim',
          ownerId: OWNER,
          limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords + 1
        },
        { ...ack, leaseToken: `memory-lease:v2:${'c'.repeat(64)}` },
        { ...ack, leaseToken: 'owner:offset:1' },
        { ...ack, body: 'private' },
        getter,
        proxy
      ]) await assert.rejects(port.execute(invalid), TypeError)
      await assert.rejects(port.execute(
        { schemaVersion: 1, operation: 'usage' },
        hostileSignal
      ), TypeError)
      await assert.rejects(port.execute(
        { schemaVersion: 1, operation: 'usage' },
        hostileSymbolSignal
      ), TypeError)
      assert.equal(calls, 0)
      assert.equal(traps, 0)

      const tooMany = factory.outbox({
        now: () => NOW,
        execute: async request => ({
          status: 'claimed',
          ownerId: request.operation === 'claim' ? request.ownerId : OWNER,
          leaseToken: LEASE,
          leasedUntil: '2026-07-19T00:01:00.000Z',
          events: Array.from(
            { length: MEMORY_RESOURCE_LIMITS.operationBatchRecords + 1 },
            () => memoryOutboxEventFixture()
          )
        })
      })
      assert.deepEqual(await tooMany.execute({
        schemaVersion: 1,
        operation: 'claim',
        ownerId: OWNER,
        limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords
      }), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const throwing = factory.outbox({
        now: () => NOW,
        execute: async () => { throw new Error('private body QQ 20000002') }
      })
      const unavailable = await throwing.execute({ schemaVersion: 1, operation: 'usage' })
      assert.deepEqual(unavailable, {
        status: 'unavailable',
        category: 'io',
        retryable: true
      })
      assert.doesNotMatch(JSON.stringify(unavailable), /private|20000002/)

      let clockReads = 0
      const expiredAfterDispatch = factory.outbox({
        now: () => clockReads++ === 0 ? NOW : LATER,
        execute: async request => ({
          status: 'claimed',
          ownerId: request.operation === 'claim' ? request.ownerId : OWNER,
          leaseToken: LEASE,
          leasedUntil: '2026-07-19T00:01:00.000Z',
          events: [memoryOutboxEventFixture()]
        })
      })
      assert.deepEqual(await expiredAfterDispatch.execute({
        schemaVersion: 1,
        operation: 'claim',
        ownerId: OWNER,
        limit: 1
      }), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      let oneClockRead = 0
      const usageWithoutPostClock = factory.outbox({
        now: () => {
          oneClockRead += 1
          if (oneClockRead > 1) throw new Error('clock must not be read after non-claim result')
          return NOW
        },
        execute: async () => ({
          status: 'usage',
          value: {
            schemaVersion: 1,
            pendingRecords: 0,
            leasedRecords: 0,
            logicalBytes: 0
          }
        })
      })
      assert.equal((await usageWithoutPostClock.execute({
        schemaVersion: 1,
        operation: 'usage'
      })).status, 'usage')
      assert.equal(oneClockRead, 1)

      const unjustifiedAbort = factory.outbox({
        now: () => NOW,
        execute: async () => ({ status: 'aborted' })
      })
      assert.deepEqual(await unjustifiedAbort.execute({
        schemaVersion: 1,
        operation: 'usage'
      }), {
        status: 'corrupt',
        category: 'adapter_contract'
      })

      const during = new AbortController()
      const justifiedAbort = factory.outbox({
        now: () => NOW,
        execute: async () => {
          during.abort()
          return { status: 'aborted' }
        }
      })
      assert.deepEqual(await justifiedAbort.execute(
        { schemaVersion: 1, operation: 'usage' },
        during.signal
      ), { status: 'aborted' })

      const aborted = new AbortController()
      aborted.abort(new Error('private abort'))
      assert.deepEqual(await port.execute(
        { schemaVersion: 1, operation: 'usage' },
        aborted.signal
      ), { status: 'aborted' })
      assert.equal(calls, 0)
    })

    test('accepts a native source after AbortSignal.any adds dependent state', async () => {
      const source = new AbortController()
      const composite = AbortSignal.any([source.signal])
      assert.equal(composite.aborted, false)
      let calls = 0
      const port = factory.outbox({
        now: () => NOW,
        execute: async (_request, signal) => {
          calls += 1
          assert.notEqual(signal, source.signal)
          source.abort(new Error('private dependent abort reason'))
          assert.equal(composite.aborted, true)
          assert.equal(signal?.aborted, true)
          return { status: 'aborted' }
        }
      })
      assert.deepEqual(await port.execute(
        { schemaVersion: 1, operation: 'usage' },
        source.signal
      ), { status: 'aborted' })
      assert.equal(calls, 1)
    })
  })
}
