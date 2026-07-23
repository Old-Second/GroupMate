import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1,
  type MemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  type MemoryLifecycleActorCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  MEMORY_EXPORT_EXCLUSIONS_HASH_V1,
  MEMORY_EXPORT_EXCLUSIONS_V1,
  MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
  acquireMemoryExportGenerateAttemptV1,
  consumeMemoryExportDeliveryHandleV1,
  createMemoryExportCommandV1,
  createMemoryExportPortV1,
  createMemoryExportStableResultV1,
  decodeMemoryExportCommandWireV1,
  decodeMemoryExportStableResultWireV1,
  deriveMemoryExportIdV1,
  encodeMemoryExportStableResultWireV1,
  memoryExportClaimReceiptHashV1,
  memoryExportCommandHashV1,
  memoryExportCommandRefHashV1,
  memoryExportDeliveryRefHashV1,
  memoryExportDeliveryHandleIsV1,
  memoryExportResolveRefV1,
  memoryExportStableResultHashV1,
  memoryExportStableResultIsBodyFreeV1,
  type MemoryExportAuthorizationEnvelopeV1,
  type MemoryExportBoundedSinkV1,
  type MemoryExportCommandOperationV1,
  type MemoryExportCommandV1,
  type MemoryExportDeliverableManifestV1,
  type MemoryExportGenerateAttemptV1,
  type MemoryExportPreparedManifestV1,
  type MemoryExportPersistentDeliveryAdapterV1,
  type MemoryExportSnapshotSourceV1,
  type MemoryExportStableResultV1
} from '../../src/agent/memory/memory-export-port.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'

const NOW = '2026-07-22T08:00:00.000Z'
const EXPIRES = '2026-07-22T08:30:00.000Z'
const BOT_ID = 'bot-main'
const ACCOUNT_ID = '10001'
const GROUP_ID = '30003'
const ACTOR_REF = `actor:${'a'.repeat(64)}`
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function namespace (): MemoryNamespaceV1 {
  return createMemoryNamespaceV1({
    botInstanceId: BOT_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    scope: {
      kind: 'group',
      groupId: GROUP_ID,
      groupLifecycleId: 'group-30003-generation-1'
    }
  })
}

function commandRef (digit: string): string {
  return `command:${digit.repeat(64).slice(0, 64)}`
}

function accessCapability (): MemoryAccessCapabilityV1 {
  return issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: BOT_ID,
      adapter: 'qq',
      accountId: ACCOUNT_ID,
      scene: {
        kind: 'group',
        groupId: GROUP_ID,
        groupLifecycleId: 'group-30003-generation-1',
        trustedMemberUserIds: ['20002'],
        observedAt: NOW
      }
    },
    [namespace()],
    NOW
  )
}

function actorCapability (
  access: MemoryAccessCapabilityV1,
  overrides: Record<string, unknown> = {}
): MemoryLifecycleActorCapabilityV1 {
  return issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: BOT_ID,
      adapter: 'qq',
      accountId: ACCOUNT_ID,
      sceneRef: access.sceneRef,
      namespace: namespace(),
      namespaceRef: memoryNamespaceRefV1(namespace()),
      generation: 1,
      actorRef: ACTOR_REF,
      actorUserId: '20002',
      role: 'group_owner',
      roleObservedAt: NOW,
      actions: ['export', 'claim_export'],
      ...overrides
    },
    NOW
  )
}

function exportCommand (
  operation: MemoryExportCommandOperationV1,
  overrides: Record<string, unknown> = {}
): MemoryExportCommandV1 {
  const phaseDefaults = operation === 'export.prepare'
    ? {
        exportId: null,
        expectedManifestHash: null,
        retryOfExportId: null,
        expectedSnapshotSha256: null
      }
    : {
        exportId: `export:${HASH_B}`,
        expectedManifestHash: HASH_A,
        retryOfExportId: null,
        expectedSnapshotSha256: null
      }
  const refDigit = operation === 'export.prepare'
    ? '1'
    : operation === 'export.generate' ? '2' : '3'
  return createMemoryExportCommandV1({
    commandRef: commandRef(refDigit),
    operation,
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace()),
    expectedNamespaceGeneration: 1,
    ...phaseDefaults,
    occurredAt: NOW,
    ...overrides
  })
}

function envelope (
  command: MemoryExportCommandV1,
  access = accessCapability(),
  actor = actorCapability(access)
): MemoryExportAuthorizationEnvelopeV1 {
  return Object.freeze({ schemaVersion: 1 as const, command, access, actor })
}

function acquireGenerateAttempt (attempt: MemoryExportGenerateAttemptV1 | undefined): void {
  acquireMemoryExportGenerateAttemptV1(attempt)
}

const NOT_COMMITTED = Object.freeze({ status: 'not_committed' as const })

function preparedManifest (
  command: MemoryExportCommandV1,
  overrides: Record<string, unknown> = {}
): MemoryExportPreparedManifestV1 {
  const wire = decodeMemoryExportCommandWireV1(command.wire)
  return createMemoryExportStableResultV1({
    schemaVersion: 1,
    commandRefHash: memoryExportCommandRefHashV1(wire.commandRef),
    commandHash: memoryExportCommandHashV1(command),
    operation: 'export.prepare',
    exportId: deriveMemoryExportIdV1({
      commandRef: wire.commandRef,
      namespaceRef: wire.namespaceRef,
      namespaceGeneration: wire.expectedNamespaceGeneration
    }),
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    contentEpoch: 4,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1,
    status: 'prepared',
    retryOfExportId: wire.retryOfExportId,
    expectedSnapshotSha256: wire.expectedSnapshotSha256,
    preparedAt: NOW,
    artifactExpiresAt: EXPIRES,
    ...overrides
  }) as MemoryExportPreparedManifestV1
}

function snapshotManifest (
  command: MemoryExportCommandV1,
  status: 'deliverable' | 'snapshot_changed' = 'deliverable',
  overrides: Record<string, unknown> = {}
): MemoryExportDeliverableManifestV1 | MemoryExportStableResultV1 {
  const wire = decodeMemoryExportCommandWireV1(command.wire)
  return createMemoryExportStableResultV1({
    schemaVersion: 1,
    commandRefHash: memoryExportCommandRefHashV1(wire.commandRef),
    commandHash: memoryExportCommandHashV1(command),
    operation: 'export.generate',
    exportId: wire.exportId,
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    contentEpoch: 5,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1,
    status,
    snapshotAt: NOW,
    counts: {
      proposal: 1,
      proposalStatus: 2,
      recordHead: 3,
      recordRevision: 4,
      tombstone: 5,
      lifecycleAudit: 6
    },
    contentBytes: 1_024,
    wireBytes: 1_280,
    sha256: HASH_B,
    artifactExpiresAt: EXPIRES,
    completeness: 'complete',
    snapshotChanged: status === 'snapshot_changed' ? 'changed' : 'not_comparable',
    ...overrides
  })
}

function failedManifest (
  command: MemoryExportCommandV1,
  overrides: Record<string, unknown> = {}
): MemoryExportStableResultV1 {
  const wire = decodeMemoryExportCommandWireV1(command.wire)
  return createMemoryExportStableResultV1({
    schemaVersion: 1,
    commandRefHash: memoryExportCommandRefHashV1(wire.commandRef),
    commandHash: memoryExportCommandHashV1(command),
    operation: 'export.generate',
    exportId: wire.exportId,
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    contentEpoch: 5,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1,
    status: 'failed',
    failedAt: NOW,
    category: 'corrupt',
    ...overrides
  })
}

test('prepare, generate and claimDelivery remain separate authorized phases', async () => {
  const prepareCommand = exportCommand('export.prepare')
  const prepared = preparedManifest(prepareCommand)
  const generateCommand = exportCommand('export.generate', {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(prepared)
  })
  const deliverable = snapshotManifest(generateCommand) as MemoryExportDeliverableManifestV1
  const claimCommand = exportCommand('export.claimDelivery', {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  let cleanups = 0
  let finalizations = 0
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async (request, _signal, attempt) => {
      const wire = decodeMemoryExportCommandWireV1(request.command.wire)
      if (wire.operation === 'export.prepare') return prepared
      if (wire.operation === 'export.generate') {
        acquireGenerateAttempt(attempt)
        return deliverable
      }
      const manifestHash = memoryExportStableResultHashV1(deliverable)
      const deliveryRef = `delivery:${HASH_A}`
      return {
        status: 'delivery_claimed',
        manifest: deliverable,
        deliveryRef,
        claimReceiptHash: memoryExportClaimReceiptHashV1({
          commandHash: memoryExportCommandHashV1(request.command),
          manifestHash,
          deliveryRefHash: memoryExportDeliveryRefHashV1(deliveryRef)
        })
      }
    },
    cleanupPartial: async () => { cleanups += 1 },
    finalizeGenerate: async () => {
      finalizations += 1
      return { status: 'terminal', manifest: deliverable }
    }
  })

  const preparedResult = await port.execute(envelope(prepareCommand))
  assert.equal(preparedResult.status, 'prepared')
  const generatedResult = await port.execute(envelope(generateCommand))
  assert.equal(generatedResult.status, 'deliverable')
  assert.notEqual(generatedResult.status, 'delivery_claimed')
  const claimedResult = await port.execute(envelope(claimCommand))
  assert.equal(claimedResult.status, 'delivery_claimed')
  if (claimedResult.status === 'delivery_claimed') {
    assert.equal(memoryExportDeliveryHandleIsV1(claimedResult.handle), true)
    assert.equal(Object.isFrozen(claimedResult.handle), true)
    assert.throws(() => encodeMemoryExportStableResultWireV1(claimedResult), TypeError)
    const consumed = consumeMemoryExportDeliveryHandleV1(claimedResult.handle)
    assert.equal(consumed.exportId, deliverable.exportId)
    assert.equal(consumed.deliveryRef, `delivery:${HASH_A}`)
    assert.equal(memoryExportDeliveryHandleIsV1(claimedResult.handle), false)
    assert.throws(() => consumeMemoryExportDeliveryHandleV1(claimedResult.handle), TypeError)
  }
  assert.equal(cleanups, 0)
  assert.equal(finalizations, 1)
})

test('exact claim replay delegates cross-restart one-shot redemption to persistent adapter', async () => {
  const generateCommand = exportCommand('export.generate')
  const deliverable = snapshotManifest(generateCommand) as MemoryExportDeliverableManifestV1
  const claimCommand = exportCommand('export.claimDelivery', {
    exportId: deliverable.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  let deliveryRef = `delivery:${HASH_A}`
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async request => ({
      status: 'delivery_claimed',
      manifest: deliverable,
      deliveryRef,
      claimReceiptHash: memoryExportClaimReceiptHashV1({
        commandHash: memoryExportCommandHashV1(request.command),
        manifestHash: memoryExportStableResultHashV1(deliverable),
        deliveryRefHash: memoryExportDeliveryRefHashV1(deliveryRef)
      })
    }),
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  const first = await port.execute(envelope(claimCommand))
  const replay = await port.execute(envelope(claimCommand))
  assert.equal(first.status, 'delivery_claimed')
  assert.equal(replay.status, 'delivery_claimed')
  if (first.status !== 'delivery_claimed' || replay.status !== 'delivery_claimed') {
    return assert.fail('claim fixtures must produce transient handles')
  }
  const firstDelivery = consumeMemoryExportDeliveryHandleV1(first.handle)
  const replayDelivery = consumeMemoryExportDeliveryHandleV1(replay.handle)
  assert.equal(firstDelivery.deliveryRef, replayDelivery.deliveryRef)
  assert.equal(firstDelivery.deliveryRefHash, memoryExportDeliveryRefHashV1(deliveryRef))

  deliveryRef = `delivery:${HASH_B}`
  assert.deepEqual(await port.execute(envelope(claimCommand)), {
    status: 'corrupt', category: 'adapter_contract'
  })
  deliveryRef = `delivery:${HASH_A}`

  let persistentlyConsumed = false
  const persistentAdapter: MemoryExportPersistentDeliveryAdapterV1 = {
    redeemOnce: async delivery => {
      assert.equal(delivery.deliveryRef, deliveryRef)
      if (persistentlyConsumed) return { status: 'already_consumed' }
      persistentlyConsumed = true
      return { status: 'delivered' }
    }
  }
  assert.deepEqual(await persistentAdapter.redeemOnce(firstDelivery), { status: 'delivered' })
  assert.deepEqual(await persistentAdapter.redeemOnce(replayDelivery), {
    status: 'already_consumed'
  })
})

test('stable export codec has exactly four body-free states and never accepts delivery carriers', () => {
  const prepareCommand = exportCommand('export.prepare')
  const prepared = preparedManifest(prepareCommand)
  const generateCommand = exportCommand('export.generate', { exportId: prepared.exportId })
  const fixtures = [
    prepared,
    snapshotManifest(generateCommand, 'deliverable'),
    snapshotManifest(generateCommand, 'snapshot_changed'),
    failedManifest(generateCommand)
  ]
  assert.deepEqual(fixtures.map(value => value.status), [
    'prepared', 'deliverable', 'snapshot_changed', 'failed'
  ])
  for (const value of fixtures) {
    const wire = encodeMemoryExportStableResultWireV1(value)
    const decoded = decodeMemoryExportStableResultWireV1(wire)
    assert.equal(memoryExportStableResultIsBodyFreeV1(value), true)
    assert.equal(Object.isFrozen(decoded), true)
    if ('counts' in decoded) assert.equal(Object.isFrozen(decoded.counts), true)
    for (const forbidden of [
      '"handle"', '"path"', '"fd"', 'artifactToken', BOT_ID, ACCOUNT_ID, GROUP_ID,
      'actorUserId', 'nickname', 'displayName'
    ]) assert.equal(wire.includes(forbidden), false)
  }
  const changed = fixtures[2]
  assert.equal(changed.status, 'snapshot_changed')
  assert.equal(Object.hasOwn(changed, 'handle'), false)

  for (const carrier of [
    { ...fixtures[1], handle: { token: 'x' } },
    { ...fixtures[1], path: '/tmp/export' },
    { ...fixtures[1], fd: 3 },
    { ...fixtures[1], artifactToken: 'secret' }
  ]) assert.throws(() => encodeMemoryExportStableResultWireV1(carrier), TypeError)
})

test('command operation matrix rejects path input, missing target hashes and invalid retry pairing', () => {
  const base = {
    commandRef: commandRef('1'),
    operation: 'export.prepare',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace()),
    expectedNamespaceGeneration: 1,
    exportId: null,
    expectedManifestHash: null,
    retryOfExportId: null,
    expectedSnapshotSha256: null,
    occurredAt: NOW
  }
  assert.throws(() => createMemoryExportCommandV1({ ...base, path: '/tmp/export' }), TypeError)
  assert.throws(() => createMemoryExportCommandV1({
    ...base,
    operation: 'export.generate'
  }), TypeError)
  assert.throws(() => createMemoryExportCommandV1({
    ...base,
    retryOfExportId: `export:${HASH_A}`
  }), TypeError)
  assert.throws(() => createMemoryExportCommandV1({
    ...base,
    expectedSnapshotSha256: HASH_A
  }), TypeError)
  assert.throws(() => createMemoryExportCommandV1({
    ...base,
    operation: 'export.deliver'
  }), TypeError)
  assert.doesNotThrow(() => createMemoryExportCommandV1({
    ...base,
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_B
  }))
  assert.doesNotThrow(() => exportCommand('export.generate', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_B
  }))
  assert.throws(() => exportCommand('export.claimDelivery', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_B
  }), TypeError)
})

test('command and result decoders reject hostile objects and 4096/4097 noncanonical wires', () => {
  const command = exportCommand('export.prepare')
  for (const forbidden of [BOT_ID, ACCOUNT_ID, GROUP_ID, 'capability', 'path', 'artifactToken']) {
    assert.equal(command.wire.includes(forbidden), false)
  }
  const object = {
    commandRef: commandRef('1'),
    operation: 'export.prepare',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace()),
    expectedNamespaceGeneration: 1,
    exportId: null,
    expectedManifestHash: null,
    retryOfExportId: null,
    expectedSnapshotSha256: null,
    occurredAt: NOW
  }
  const getter = { ...object }
  Object.defineProperty(getter, 'occurredAt', { enumerable: true, get: () => NOW })
  const symbol = { ...object }
  Object.defineProperty(symbol, Symbol('x'), { enumerable: true, value: true })
  for (const value of [new Proxy(object, {}), getter, symbol]) {
    assert.throws(() => createMemoryExportCommandV1(value), TypeError)
  }

  for (const length of [4_096, 4_097]) {
    const raw = command.wire.padEnd(length, ' ')
    assert.equal(Buffer.byteLength(raw), length)
    assert.throws(() => decodeMemoryExportCommandWireV1(raw), TypeError)
  }
  const stableWire = encodeMemoryExportStableResultWireV1(preparedManifest(command))
  for (const length of [4_096, 4_097]) {
    assert.throws(() => decodeMemoryExportStableResultWireV1(
      stableWire.padEnd(length, ' ')
    ), TypeError)
  }
  assert.throws(() => encodeMemoryExportStableResultWireV1(
    new Proxy(preparedManifest(command), {})
  ), TypeError)
  const stableGetter = { ...preparedManifest(command) }
  Object.defineProperty(stableGetter, 'receiptHash', {
    enumerable: true,
    get: () => HASH_A
  })
  const stableSymbol = { ...preparedManifest(command) }
  Object.defineProperty(stableSymbol, Symbol('carrier'), { enumerable: true, value: true })
  assert.throws(() => encodeMemoryExportStableResultWireV1(stableGetter), TypeError)
  assert.throws(() => encodeMemoryExportStableResultWireV1(stableSymbol), TypeError)
})

test('manifest receipt and command binding cannot be changed independently', async () => {
  const prepareCommand = exportCommand('export.prepare')
  const prepared = preparedManifest(prepareCommand)
  const { receiptHash: _receiptHash, ...preparedFields } = prepared
  assert.deepEqual(MEMORY_EXPORT_EXCLUSIONS_V1, [
    'sqlite_physical_layout',
    'transactional_outbox',
    'redis_derived_cache',
    'groupmate_configuration',
    'qq_server_history',
    'groupmate_content_journal',
    'provider_logs',
    'delivered_export_artifacts_from_future_memory_deletion'
  ])
  assert.throws(() => createMemoryExportStableResultV1({
    ...preparedFields,
    exclusionsHash: HASH_A
  }), TypeError)
  assert.throws(() => encodeMemoryExportStableResultWireV1({
    ...prepared,
    contentEpoch: prepared.contentEpoch + 1
  }), TypeError)

  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async () => createMemoryExportStableResultV1({
      schemaVersion: 1,
      commandRefHash: HASH_A,
      commandHash: HASH_A,
      operation: 'export.prepare',
      exportId: prepared.exportId,
      namespaceRef: prepared.namespaceRef,
      namespaceGeneration: prepared.namespaceGeneration,
      contentEpoch: prepared.contentEpoch,
      retryOfExportId: prepared.retryOfExportId,
      expectedSnapshotSha256: prepared.expectedSnapshotSha256,
      exclusionsHash: prepared.exclusionsHash,
      status: 'prepared',
      preparedAt: NOW,
      artifactExpiresAt: EXPIRES
    }),
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  assert.deepEqual(await port.execute(envelope(prepareCommand)), {
    status: 'corrupt', category: 'adapter_contract'
  })

  const retryCommand = exportCommand('export.prepare', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_B
  })
  const mismatchedComparisonPort = createMemoryExportPortV1({
    now: () => NOW,
    execute: async request => preparedManifest(request.command, {
      retryOfExportId: null,
      expectedSnapshotSha256: null
    }),
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  assert.deepEqual(await mismatchedComparisonPort.execute(envelope(retryCommand)), {
    status: 'corrupt', category: 'adapter_contract'
  })
})

test('snapshot constraints reject mismatched comparison, overflow and forged claim receipts', async () => {
  const generateCommand = exportCommand('export.generate')
  assert.throws(() => snapshotManifest(generateCommand, 'snapshot_changed', {
    snapshotChanged: 'matched'
  }), TypeError)
  assert.throws(() => snapshotManifest(generateCommand, 'deliverable', {
    snapshotChanged: 'changed'
  }), TypeError)
  assert.throws(() => snapshotManifest(generateCommand, 'deliverable', {
    wireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1 + 1
  }), TypeError)
  assert.throws(() => snapshotManifest(generateCommand, 'deliverable', {
    contentBytes: 1_280,
    wireBytes: 1_280
  }), TypeError)
  assert.throws(() => snapshotManifest(generateCommand, 'deliverable', {
    artifactExpiresAt: '2026-07-22T08:30:00.001Z'
  }), TypeError)

  const deliverable = snapshotManifest(generateCommand) as MemoryExportDeliverableManifestV1
  const claim = exportCommand('export.claimDelivery', {
    exportId: deliverable.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async () => ({
      status: 'delivery_claimed',
      manifest: deliverable,
      deliveryRef: `delivery:${HASH_A}`,
      claimReceiptHash: HASH_A
    }),
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  assert.deepEqual(await port.execute(envelope(claim)), {
    status: 'corrupt', category: 'adapter_contract'
  })
})

test('snapshot comparison projection is bound to the retry metadata in generate command', async () => {
  const initialCommand = exportCommand('export.generate')
  const retryCommand = exportCommand('export.generate', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_A
  })
  const matchingRetryCommand = exportCommand('export.generate', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_B
  })
  const invalidCases = [
    {
      command: initialCommand,
      result: snapshotManifest(initialCommand, 'deliverable', { snapshotChanged: 'matched' })
    },
    {
      command: initialCommand,
      result: snapshotManifest(initialCommand, 'snapshot_changed')
    },
    {
      command: retryCommand,
      result: snapshotManifest(retryCommand, 'deliverable', {
        snapshotChanged: 'not_comparable'
      })
    },
    {
      command: retryCommand,
      result: snapshotManifest(retryCommand, 'deliverable', { snapshotChanged: 'matched' })
    }
  ]
  for (const fixture of invalidCases) {
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async (_request, _signal, attempt) => {
        acquireGenerateAttempt(attempt)
        return fixture.result
      },
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => NOT_COMMITTED
    })
    assert.deepEqual(await port.execute(envelope(fixture.command)), {
      status: 'corrupt', category: 'adapter_contract'
    })
  }

  for (const fixture of [
    {
      command: matchingRetryCommand,
      result: snapshotManifest(matchingRetryCommand, 'deliverable', {
        snapshotChanged: 'matched'
      })
    },
    { command: retryCommand, result: snapshotManifest(retryCommand, 'snapshot_changed') }
  ]) {
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async (_request, _signal, attempt) => {
        acquireGenerateAttempt(attempt)
        return fixture.result
      },
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => ({
        status: 'terminal',
        manifest: fixture.result as Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1>
      })
    })
    assert.equal(
      (await port.execute(envelope(fixture.command))).status,
      fixture.result.status
    )
  }
})

test('access, actor action, actor ref, namespace and generation are exact before dispatch', async () => {
  const command = exportCommand('export.prepare')
  const access = accessCapability()
  let dispatches = 0
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return preparedManifest(request.command)
    },
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  const wrongGeneration = actorCapability(access, { generation: 2 })
  assert.equal((await port.execute(envelope(command, access, wrongGeneration))).status, 'denied')

  const wrongScene = actorCapability(access, { sceneRef: HASH_B })
  assert.equal((await port.execute(envelope(command, access, wrongScene))).status, 'denied')

  const exportOnly = actorCapability(access, { actions: ['export'] })
  const claimCommand = exportCommand('export.claimDelivery')
  assert.equal((await port.execute(envelope(claimCommand, access, exportOnly))).status, 'denied')

  const wrongActorCommand = exportCommand('export.prepare', {
    initiatedByActorRef: `actor:${HASH_B}`
  })
  assert.equal((await port.execute(envelope(wrongActorCommand, access))).status, 'denied')

  const wrongNamespaceCommand = exportCommand('export.prepare', {
    namespaceRef: HASH_B
  })
  assert.equal((await port.execute(envelope(wrongNamespaceCommand, access))).status, 'denied')

  const forgedAccess = { ...access, accountId: '99999' }
  assert.equal((await port.execute({
    schemaVersion: 1,
    command,
    access: forgedAccess,
    actor: actorCapability(access)
  })).status, 'denied')
  assert.equal(dispatches, 0)
})

test('simple adapter results enforce phase categories and fixed retryability', async () => {
  const invalidCases: Array<{
    readonly operation: MemoryExportCommandOperationV1
    readonly result: Readonly<Record<string, unknown>>
  }> = [
    {
      operation: 'export.prepare',
      result: { status: 'conflict', category: 'state' }
    },
    {
      operation: 'export.prepare',
      result: { status: 'capacity', category: 'artifact_bytes' }
    },
    {
      operation: 'export.prepare',
      result: { status: 'unavailable', category: 'artifact', retryable: false }
    },
    {
      operation: 'export.generate',
      result: { status: 'capacity', category: 'export_jobs' }
    },
    {
      operation: 'export.claimDelivery',
      result: { status: 'capacity', category: 'export_jobs' }
    },
    {
      operation: 'export.prepare',
      result: { status: 'unavailable', category: 'storage', retryable: true }
    },
    {
      operation: 'export.generate',
      result: { status: 'unavailable', category: 'artifact', retryable: true }
    },
    {
      operation: 'export.claimDelivery',
      result: { status: 'unavailable', category: 'busy', retryable: false }
    }
  ]
  for (const fixture of invalidCases) {
    const command = exportCommand(fixture.operation)
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async () => fixture.result,
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => NOT_COMMITTED
    })
    assert.deepEqual(await port.execute(envelope(command)), {
      status: 'corrupt', category: 'adapter_contract'
    }, `${fixture.operation}:${String(fixture.result.category)}`)
  }

  for (const fixture of [
    {
      operation: 'export.prepare' as const,
      result: { status: 'unavailable' as const, category: 'storage' as const, retryable: false }
    },
    {
      operation: 'export.generate' as const,
      result: { status: 'unavailable' as const, category: 'io' as const, retryable: true }
    },
    {
      operation: 'export.claimDelivery' as const,
      result: { status: 'unavailable' as const, category: 'artifact' as const, retryable: false }
    }
  ]) {
    const command = exportCommand(fixture.operation)
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async () => fixture.result,
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => NOT_COMMITTED
    })
    assert.deepEqual(await port.execute(envelope(command)), fixture.result)
  }
})

test('generate cleanup and finalization require the exact adapter-acquired attempt', async () => {
  const command = exportCommand('export.generate')
  let cleanups = 0
  let finalizations = 0
  for (const result of [
    { status: 'denied' as const, category: 'authority' as const },
    { status: 'conflict' as const, category: 'state' as const },
    { status: 'unavailable' as const, category: 'busy' as const, retryable: true }
  ]) {
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async () => result,
      cleanupPartial: async () => { cleanups += 1 },
      finalizeGenerate: async () => { finalizations += 1; return NOT_COMMITTED }
    })
    assert.deepEqual(await port.execute(envelope(command)), result)
  }
  assert.equal(cleanups, 0)
  assert.equal(finalizations, 0)

  let acquired: MemoryExportGenerateAttemptV1 | undefined
  const acquiredPort = createMemoryExportPortV1({
    now: () => NOW,
    execute: async (_request, _signal, attempt) => {
      acquired = acquireMemoryExportGenerateAttemptV1(attempt)
      return { status: 'unavailable', category: 'busy', retryable: true }
    },
    cleanupPartial: async attempt => {
      assert.strictEqual(attempt, acquired)
      cleanups += 1
    },
    finalizeGenerate: async attempt => {
      assert.strictEqual(attempt, acquired)
      finalizations += 1
      return NOT_COMMITTED
    }
  })
  assert.deepEqual(await acquiredPort.execute(envelope(command)), {
    status: 'unavailable', category: 'busy', retryable: true
  })
  assert.equal(cleanups, 1)
  assert.equal(finalizations, 1)
  assert.throws(() => acquireMemoryExportGenerateAttemptV1(acquired), TypeError)
})

test('generate exact terminal replay needs no new attempt lease or cleanup', async () => {
  const command = exportCommand('export.generate')
  const terminal = snapshotManifest(command) as MemoryExportDeliverableManifestV1
  let cleanups = 0
  let finalizations = 0
  const controller = new AbortController()
  let abortAfterRead = false
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async () => {
      if (abortAfterRead) controller.abort()
      return terminal
    },
    cleanupPartial: async () => { cleanups += 1 },
    finalizeGenerate: async () => { finalizations += 1; return NOT_COMMITTED }
  })
  assert.deepEqual(await port.execute(envelope(command)), terminal)
  abortAfterRead = true
  assert.deepEqual(await port.execute(envelope(command), controller.signal), {
    status: 'committed_after_abort',
    resolveRef: memoryExportResolveRefV1(
      decodeMemoryExportCommandWireV1(command.wire).commandRef
    ),
    committedResultHash: memoryExportStableResultHashV1(terminal)
  })
  assert.equal(cleanups, 0)
  assert.equal(finalizations, 0)
})

test('pre-abort has zero dispatch and prepare/claim late aborts expose no handle', async () => {
  const prepareCommand = exportCommand('export.prepare')
  const prepared = preparedManifest(prepareCommand)
  let dispatches = 0
  const pre = new AbortController()
  pre.abort()
  const prePort = createMemoryExportPortV1({
    now: () => {
      dispatches += 10_000
      throw new Error('hostile clock must not run')
    },
    execute: async () => { dispatches += 1; return prepared },
    cleanupPartial: async () => { dispatches += 100 },
    finalizeGenerate: async () => { dispatches += 100; return NOT_COMMITTED }
  })
  assert.deepEqual(await prePort.execute(envelope(prepareCommand), pre.signal), {
    status: 'aborted'
  })
  assert.deepEqual(await prePort.execute(
    envelope(exportCommand('export.generate')),
    pre.signal
  ), { status: 'aborted' })
  assert.deepEqual(await prePort.execute(
    envelope(exportCommand('export.claimDelivery')),
    pre.signal
  ), { status: 'aborted' })
  assert.equal(dispatches, 0)

  const latePrepare = new AbortController()
  const preparePort = createMemoryExportPortV1({
    now: () => NOW,
    execute: async () => { latePrepare.abort(); return prepared },
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  const committedPrepare = await preparePort.execute(envelope(prepareCommand), latePrepare.signal)
  assert.equal(committedPrepare.status, 'committed_after_abort')
  assert.equal(Object.hasOwn(committedPrepare, 'handle'), false)

  const generateCommand = exportCommand('export.generate', { exportId: prepared.exportId })
  const deliverable = snapshotManifest(generateCommand) as MemoryExportDeliverableManifestV1
  const claimCommand = exportCommand('export.claimDelivery', {
    exportId: prepared.exportId,
    expectedManifestHash: memoryExportStableResultHashV1(deliverable)
  })
  const lateClaim = new AbortController()
  const claimPort = createMemoryExportPortV1({
    now: () => NOW,
    execute: async request => {
      lateClaim.abort()
      return {
        status: 'delivery_claimed',
        manifest: deliverable,
        deliveryRef: `delivery:${HASH_A}`,
        claimReceiptHash: memoryExportClaimReceiptHashV1({
          commandHash: memoryExportCommandHashV1(request.command),
          manifestHash: memoryExportStableResultHashV1(deliverable),
          deliveryRefHash: memoryExportDeliveryRefHashV1(`delivery:${HASH_A}`)
        })
      }
    },
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  const committedClaim = await claimPort.execute(envelope(claimCommand), lateClaim.signal)
  assert.equal(committedClaim.status, 'committed_after_abort')
  assert.equal(Object.hasOwn(committedClaim, 'handle'), false)
})

test('prepare and claim invalid or throwing late outcomes require explicit resolve', async () => {
  for (const operation of ['export.prepare', 'export.claimDelivery'] as const) {
    for (const kind of ['invalid', 'throw'] as const) {
      const command = exportCommand(operation)
      const controller = new AbortController()
      const port = createMemoryExportPortV1({
        now: () => NOW,
        execute: async () => {
          controller.abort()
          if (kind === 'throw') throw new Error('unknown')
          return { status: 'bad' }
        },
        cleanupPartial: async () => undefined,
        finalizeGenerate: async () => NOT_COMMITTED
      })
      const result = await port.execute(envelope(command), controller.signal)
      assert.deepEqual(result, {
        status: 'resolve_required',
        category: 'outcome_unknown',
        resolveRef: memoryExportResolveRefV1(
          decodeMemoryExportCommandWireV1(command.wire).commandRef
        )
      })
    }
  }
})

test('prepare and claim preserve authoritative non-commit adapter outcomes', async () => {
  for (const operation of ['export.prepare', 'export.claimDelivery'] as const) {
    const command = exportCommand(operation)
    const conflictCategory = operation === 'export.prepare' ? 'generation' : 'state'
    const conflictPort = createMemoryExportPortV1({
      now: () => NOW,
      execute: async () => ({ status: 'conflict', category: conflictCategory }),
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => NOT_COMMITTED
    })
    assert.deepEqual(await conflictPort.execute(envelope(command)), {
      status: 'conflict', category: conflictCategory
    })

    const controller = new AbortController()
    const abortedPort = createMemoryExportPortV1({
      now: () => NOW,
      execute: async () => {
        controller.abort()
        return { status: 'aborted' }
      },
      cleanupPartial: async () => undefined,
      finalizeGenerate: async () => NOT_COMMITTED
    })
    assert.deepEqual(await abortedPort.execute(envelope(command), controller.signal), {
      status: 'aborted'
    })
  }
})

test('generate invalid late-abort cleans and finalizes before requiring resolution', async () => {
  const command = exportCommand('export.generate')
  const controller = new AbortController()
  const calls: Array<{ readonly name: string; readonly args: number }> = []
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async (_request, _signal, attempt) => {
      acquireGenerateAttempt(attempt)
      controller.abort()
      return { status: 'partial', artifactToken: 'must-not-escape' }
    },
    cleanupPartial: async (...args) => {
      calls.push({ name: 'cleanup', args: args.length })
    },
    finalizeGenerate: async (...args) => {
      calls.push({ name: 'finalize', args: args.length })
      throw new Error('terminal state unknown')
    }
  })
  assert.deepEqual(await port.execute(envelope(command), controller.signal), {
    status: 'resolve_required',
    category: 'outcome_unknown',
    resolveRef: memoryExportResolveRefV1(
      decodeMemoryExportCommandWireV1(command.wire).commandRef
    )
  })
  assert.deepEqual(calls, [
    { name: 'cleanup', args: 1 },
    { name: 'finalize', args: 2 }
  ])
})

test('an abort after stable generate finalization preserves artifact and reports committed result', async () => {
  const command = exportCommand('export.generate')
  const deliverable = snapshotManifest(command) as MemoryExportDeliverableManifestV1
  const controller = new AbortController()
  let cleanups = 0
  let finalizations = 0
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async (_request, _signal, attempt) => {
      acquireGenerateAttempt(attempt)
      return deliverable
    },
    cleanupPartial: async () => { cleanups += 1 },
    finalizeGenerate: async () => {
      finalizations += 1
      controller.abort()
      return { status: 'terminal', manifest: deliverable }
    }
  })
  assert.deepEqual(await port.execute(envelope(command), controller.signal), {
    status: 'committed_after_abort',
    resolveRef: memoryExportResolveRefV1(
      decodeMemoryExportCommandWireV1(command.wire).commandRef
    ),
    committedResultHash: memoryExportStableResultHashV1(deliverable)
  })
  assert.equal(cleanups, 0)
  assert.equal(finalizations, 1)
})

test('generate late-abort reports a failed terminal committed by the finalizer', async () => {
  const command = exportCommand('export.generate')
  const terminal = failedManifest(command, { category: 'aborted' }) as Exclude<
  MemoryExportStableResultV1,
  MemoryExportPreparedManifestV1
  >
  const controller = new AbortController()
  let cleanups = 0
  const port = createMemoryExportPortV1({
    now: () => NOW,
    execute: async (_request, _signal, attempt) => {
      acquireGenerateAttempt(attempt)
      controller.abort()
      return { status: 'aborted' }
    },
    cleanupPartial: async () => { cleanups += 1 },
    finalizeGenerate: async (_attempt, outcome) => {
      assert.equal(outcome, 'aborted')
      return { status: 'terminal', manifest: terminal }
    }
  })
  assert.deepEqual(await port.execute(envelope(command), controller.signal), {
    status: 'committed_after_abort',
    resolveRef: memoryExportResolveRefV1(
      decodeMemoryExportCommandWireV1(command.wire).commandRef
    ),
    committedResultHash: memoryExportStableResultHashV1(terminal)
  })
  assert.equal(cleanups, 1)
})

test('generate failure paths clean partial state while deliverable keeps the committed artifact', async () => {
  const command = exportCommand('export.generate')
  const deliverable = snapshotManifest(command) as MemoryExportDeliverableManifestV1
  const changedCommand = exportCommand('export.generate', {
    retryOfExportId: `export:${HASH_A}`,
    expectedSnapshotSha256: HASH_A
  })
  const cases: Array<{
    readonly name: string
    readonly command: MemoryExportCommandV1
    readonly execute: (attempt: MemoryExportGenerateAttemptV1 | undefined) => Promise<unknown>
    readonly expected: string
    readonly cleanup: number
    readonly terminal: () => Exclude<
    MemoryExportStableResultV1,
    MemoryExportPreparedManifestV1
    > | null
  }> = [
    {
      name: 'deliverable', command, execute: async attempt => {
        acquireGenerateAttempt(attempt)
        return deliverable
      },
      expected: 'deliverable', cleanup: 0, terminal: () => deliverable
    },
    {
      name: 'snapshot_changed',
      command: changedCommand,
      execute: async attempt => {
        acquireGenerateAttempt(attempt)
        return snapshotManifest(changedCommand, 'snapshot_changed')
      },
      expected: 'snapshot_changed',
      cleanup: 1,
      terminal: () => snapshotManifest(
        changedCommand,
        'snapshot_changed'
      ) as Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1>
    },
    {
      name: 'failed', command, execute: async attempt => {
        acquireGenerateAttempt(attempt)
        return failedManifest(command)
      },
      expected: 'failed', cleanup: 1,
      terminal: () => failedManifest(command) as Exclude<
      MemoryExportStableResultV1,
      MemoryExportPreparedManifestV1
      >
    },
    {
      name: 'invalid', command, execute: async attempt => {
        acquireGenerateAttempt(attempt)
        return { status: 'partial' }
      },
      expected: 'corrupt', cleanup: 1, terminal: () => null
    },
    {
      name: 'throw',
      command,
      execute: async attempt => {
        acquireGenerateAttempt(attempt)
        throw new Error('sink failure')
      },
      expected: 'unavailable',
      cleanup: 1,
      terminal: () => null
    }
  ]
  for (const fixture of cases) {
    let cleanups = 0
    let finalizations = 0
    const port = createMemoryExportPortV1({
      now: () => NOW,
      execute: async (_request, _signal, attempt) => fixture.execute(attempt),
      cleanupPartial: async () => { cleanups += 1 },
      finalizeGenerate: async () => {
        finalizations += 1
        const terminal = fixture.terminal()
        return terminal === null
          ? NOT_COMMITTED
          : { status: 'terminal', manifest: terminal }
      }
    })
    const result = await port.execute(envelope(fixture.command))
    assert.equal(result.status, fixture.expected, fixture.name)
    assert.equal(cleanups, fixture.cleanup, fixture.name)
    assert.equal(finalizations, 1, fixture.name)
  }
})

test('cleanup or finalize uncertainty cannot be presented as a successful or clean outcome', async () => {
  const command = exportCommand('export.generate')
  const deliverable = snapshotManifest(command) as MemoryExportDeliverableManifestV1
  const cleanupFailurePort = createMemoryExportPortV1({
    now: () => NOW,
    cleanupPartial: async () => { throw new Error('cleanup failed') },
    finalizeGenerate: async () => ({
      status: 'terminal',
      manifest: failedManifest(command) as Exclude<
      MemoryExportStableResultV1,
      MemoryExportPreparedManifestV1
      >
    }),
    execute: async (_request, _signal, attempt) => {
      acquireGenerateAttempt(attempt)
      return failedManifest(command)
    }
  })
  assert.equal((await cleanupFailurePort.execute(envelope(command))).status, 'resolve_required')

  let finalArtifactCleanups = 0
  const finalizeFailurePort = createMemoryExportPortV1({
    now: () => NOW,
    cleanupPartial: async () => { finalArtifactCleanups += 1 },
    finalizeGenerate: async () => { throw new Error('finalize failed') },
    execute: async (_request, _signal, attempt) => {
      acquireGenerateAttempt(attempt)
      return deliverable
    }
  })
  assert.equal((await finalizeFailurePort.execute(envelope(command))).status, 'resolve_required')
  assert.equal(finalArtifactCleanups, 1)
})

test('snapshot source and bounded sink interfaces expose no filesystem path', async () => {
  const chunks: Uint8Array[] = []
  const sink: MemoryExportBoundedSinkV1 = {
    maximumWireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
    maximumChunkBytes: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
    write: async chunk => { chunks.push(chunk) },
    commit: async () => undefined,
    abort: async () => undefined
  }
  const source: MemoryExportSnapshotSourceV1 = {
    streamInto: async target => {
      await target.write(new Uint8Array([1, 2, 3]))
    },
    close: async () => undefined
  }
  await source.streamInto(sink)
  assert.equal(chunks.length, 1)
  assert.equal(Object.hasOwn(sink, 'path'), false)
  assert.equal(Object.hasOwn(sink, 'fd'), false)
  assert.equal(Object.hasOwn(source, 'path'), false)
})

test('trusted time and versioned envelope failures stop before adapter execution', async () => {
  const command = exportCommand('export.prepare')
  let dispatches = 0
  const port = createMemoryExportPortV1({
    now: () => { throw new Error('clock secret') },
    execute: async request => { dispatches += 1; return preparedManifest(request.command) },
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  await assert.rejects(port.execute(envelope(command)), TypeError)
  assert.equal(dispatches, 0)

  const request = envelope(command)
  const { schemaVersion: _schemaVersion, ...unversioned } = request
  const validClockPort = createMemoryExportPortV1({
    now: () => NOW,
    execute: async adapterRequest => {
      dispatches += 1
      return preparedManifest(adapterRequest.command)
    },
    cleanupPartial: async () => undefined,
    finalizeGenerate: async () => NOT_COMMITTED
  })
  await assert.rejects(validClockPort.execute(unversioned), TypeError)
  assert.equal(dispatches, 0)
})
