import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  MEMORY_MAINTENANCE_OPERATIONS_V1,
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryMaintenanceCapabilityV1,
  type MemoryMaintenanceOperationV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  createMemoryMaintenanceCommandV1,
  createMemoryMaintenanceBatchManifestV1,
  createMemoryMaintenancePortV1,
  decodeMemoryMaintenanceBatchManifestV1,
  decodeMemoryMaintenanceCommandWireV1,
  encodeMemoryMaintenanceBatchManifestV1,
  memoryMaintenanceBatchManifestHashV1,
  memoryMaintenanceCommandHashV1,
  memoryMaintenanceCommandRefHashV1,
  memoryMaintenanceResolveRefV1,
  type MemoryMaintenanceAuthorizationEnvelopeV1,
  type MemoryMaintenanceBatchManifestV1,
  type MemoryMaintenanceCommandV1
} from '../../src/agent/memory/memory-maintenance-port.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'

const NOW = '2026-07-22T08:00:00.000Z'
const BOT_ID = 'bot-main'
const ACCOUNT_ID = '10001'
const GROUP_ID = '30003'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

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

function commandRef (suffix: string): string {
  return `command:${suffix.repeat(64).slice(0, 64)}`
}

function operationShape (operation: MemoryMaintenanceOperationV1): {
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly deletionRef: string | null
} {
  if (operation === 'namespace.scrubDeleted' ||
    operation === 'namespace.verifyScrubbed') {
    return {
      currentGeneration: 3,
      targetGeneration: 1,
      deletionRef: `deletion:${HASH_B}`
    }
  }
  return { currentGeneration: 3, targetGeneration: 3, deletionRef: null }
}

function maintenanceCommand (
  operation: MemoryMaintenanceOperationV1 = 'proposal.expireDue',
  overrides: Record<string, unknown> = {}
): MemoryMaintenanceCommandV1 {
  return createMemoryMaintenanceCommandV1({
    commandRef: commandRef('1'),
    operation,
    namespaceRef: memoryNamespaceRefV1(namespace()),
    ...operationShape(operation),
    limit: 32,
    occurredAt: NOW,
    ...overrides
  })
}

function accessCapability () {
  const issuer = createMemoryAccessCapabilityIssuerV1(() => true)
  return issueMemoryAccessCapabilityV1(issuer, {
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
  }, [namespace()], NOW)
}

function envelope (
  operation: MemoryMaintenanceOperationV1 = 'proposal.expireDue',
  commandOverrides: Record<string, unknown> = {},
  authorityOverrides: Record<string, unknown> = {}
): MemoryMaintenanceAuthorizationEnvelopeV1 {
  const command = maintenanceCommand(operation, commandOverrides)
  const wire = decodeMemoryMaintenanceCommandWireV1(command.wire)
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const maintenance = issueMemoryMaintenanceCapabilityV1(root, {
    schemaVersion: 1,
    botInstanceId: BOT_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    namespace: namespace(),
    namespaceRef: wire.namespaceRef,
    currentGeneration: wire.currentGeneration,
    targetGeneration: wire.targetGeneration,
    deletionRef: wire.deletionRef,
    operation: wire.operation,
    limit: wire.limit,
    ...authorityOverrides
  }, NOW)
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    access: accessCapability(),
    maintenance
  })
}

function manifest (
  command: MemoryMaintenanceCommandV1,
  overrides: Record<string, unknown> = {}
): MemoryMaintenanceBatchManifestV1 {
  const wire = decodeMemoryMaintenanceCommandWireV1(command.wire)
  return createMemoryMaintenanceBatchManifestV1({
    schemaVersion: 1,
    status: 'completed',
    commandRefHash: memoryMaintenanceCommandRefHashV1(wire.commandRef),
    commandHash: memoryMaintenanceCommandHashV1(command),
    operation: wire.operation,
    namespaceRef: wire.namespaceRef,
    currentGeneration: wire.currentGeneration,
    targetGeneration: wire.targetGeneration,
    deletionRef: wire.deletionRef,
    selectionOrder: 'oldest_first',
    processed: 1,
    hasMore: false,
    itemReceiptHashes: [HASH_A],
    completedAt: NOW,
    ...overrides
  })
}

test('all ten maintenance operations dispatch one exact oldest-first body-free batch', async () => {
  assert.equal(MEMORY_MAINTENANCE_OPERATIONS_V1.length, 10)
  for (const operation of MEMORY_MAINTENANCE_OPERATIONS_V1) {
    const request = envelope(operation)
    let dispatches = 0
    const port = createMemoryMaintenancePortV1({
      now: () => NOW,
      execute: async received => {
        dispatches += 1
        assert.equal(received.command.wire, request.command.wire)
        return manifest(received.command)
      }
    })
    const result = await port.execute(request)
    assert.equal(result.status, 'completed')
    assert.equal(dispatches, 1)
    if (result.status === 'completed') {
      assert.equal(result.operation, operation)
      assert.equal(result.selectionOrder, 'oldest_first')
      assert.equal(Object.isFrozen(result), true)
      assert.equal(Object.isFrozen(result.itemReceiptHashes), true)
      assert.equal(JSON.stringify(result).includes('text'), false)
      assert.equal(JSON.stringify(result).includes('source'), false)
    }
  }
})

test('command and batch codecs are canonical, deeply frozen and bounded', () => {
  const command = maintenanceCommand()
  const decodedCommand = decodeMemoryMaintenanceCommandWireV1(command.wire)
  const stable = manifest(command, {
    processed: 32,
    hasMore: true,
    itemReceiptHashes: Array.from(
      { length: 32 },
      (_, index) => index.toString(16).padStart(64, '0')
    )
  })
  const stableWire = encodeMemoryMaintenanceBatchManifestV1(stable)
  const decodedStable = decodeMemoryMaintenanceBatchManifestV1(stableWire)

  assert.equal(Object.isFrozen(decodedCommand), true)
  assert.equal(Object.isFrozen(decodedStable), true)
  assert.equal(Object.isFrozen(decodedStable.itemReceiptHashes), true)
  assert.equal(Buffer.byteLength(command.wire, 'utf8') <= 4_096, true)
  assert.equal(Buffer.byteLength(stableWire, 'utf8') <= 4_096, true)
  for (const forbidden of [BOT_ID, ACCOUNT_ID, GROUP_ID, 'capability', 'actorUserId']) {
    assert.equal(command.wire.includes(forbidden), false)
    assert.equal(stableWire.includes(forbidden), false)
  }
  assert.equal(memoryMaintenanceBatchManifestHashV1(stable),
    memoryMaintenanceBatchManifestHashV1(stableWire))
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1({
    ...decodedStable,
    completedAt: '2026-07-22T08:00:00.001Z'
  }), TypeError)

  const padded4096 = command.wire.padEnd(4_096, ' ')
  const padded4097 = command.wire.padEnd(4_097, ' ')
  assert.equal(Buffer.byteLength(padded4096), 4_096)
  assert.equal(Buffer.byteLength(padded4097), 4_097)
  assert.throws(() => decodeMemoryMaintenanceCommandWireV1(padded4096), TypeError)
  assert.throws(() => decodeMemoryMaintenanceCommandWireV1(padded4097), TypeError)
  assert.throws(() => decodeMemoryMaintenanceBatchManifestV1(stableWire.padEnd(4_096, ' ')), TypeError)
  assert.throws(() => decodeMemoryMaintenanceBatchManifestV1(stableWire.padEnd(4_097, ' ')), TypeError)
})

test('commands reject cursor, non-maintenance operations, limit 33 and invalid generation binding', () => {
  const base = {
    commandRef: commandRef('1'),
    operation: 'proposal.expireDue',
    namespaceRef: memoryNamespaceRefV1(namespace()),
    currentGeneration: 3,
    targetGeneration: 3,
    deletionRef: null,
    limit: 32,
    occurredAt: NOW
  }
  assert.throws(() => createMemoryMaintenanceCommandV1({ ...base, cursor: null }), TypeError)
  assert.throws(() => createMemoryMaintenanceCommandV1({
    ...base,
    operation: 'deletion.getStatus'
  }), TypeError)
  assert.throws(() => createMemoryMaintenanceCommandV1({ ...base, limit: 33 }), TypeError)
  assert.throws(() => createMemoryMaintenanceCommandV1({
    ...base,
    targetGeneration: 2
  }), TypeError)
  assert.throws(() => createMemoryMaintenanceCommandV1({
    ...base,
    operation: 'namespace.scrubDeleted',
    targetGeneration: 2,
    deletionRef: null
  }), TypeError)
  assert.throws(() => createMemoryMaintenanceCommandV1({
    ...base,
    operation: 'namespace.scrubDeleted',
    targetGeneration: 3,
    deletionRef: `deletion:${HASH_B}`
  }), TypeError)
  assert.doesNotThrow(() => createMemoryMaintenanceCommandV1({
    ...base,
    operation: 'deletion.checkpoint'
  }))
  assert.throws(() => createMemoryMaintenanceCommandV1({
    ...base,
    operation: 'deletion.checkpoint',
    targetGeneration: 2,
    deletionRef: `deletion:${HASH_B}`
  }), TypeError)
})

test('strict parsers reject proxies, getters, symbols, extra keys and sparse receipt arrays', () => {
  const command = maintenanceCommand()
  const commandObject = {
    commandRef: commandRef('1'),
    operation: 'proposal.expireDue',
    namespaceRef: memoryNamespaceRefV1(namespace()),
    currentGeneration: 3,
    targetGeneration: 3,
    deletionRef: null,
    limit: 32,
    occurredAt: NOW
  }
  const getter = { ...commandObject }
  Object.defineProperty(getter, 'limit', { enumerable: true, get: () => 32 })
  const symbol = { ...commandObject }
  Object.defineProperty(symbol, Symbol('x'), { enumerable: true, value: true })
  for (const value of [new Proxy(commandObject, {}), getter, symbol]) {
    assert.throws(() => createMemoryMaintenanceCommandV1(value), TypeError)
  }

  const sparse = Array(1) as string[]
  assert.throws(() => manifest(command, { itemReceiptHashes: sparse }), TypeError)
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1({
    ...manifest(command),
    path: '/tmp/export'
  }), TypeError)
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1(
    new Proxy(manifest(command), {})
  ), TypeError)
})

test('batch manifests enforce one unique receipt per aggregate and exact limit semantics', async () => {
  const request = envelope('audit.purgeExpired', { limit: 2 })
  const wire = decodeMemoryMaintenanceCommandWireV1(request.command.wire)
  assert.throws(() => manifest(request.command, {
    targetGeneration: 2,
    deletionRef: `deletion:${HASH_B}`
  }), TypeError)
  assert.throws(() => manifest(request.command, {
    operation: 'namespace.scrubDeleted',
    targetGeneration: 3,
    deletionRef: `deletion:${HASH_B}`
  }), TypeError)
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1(manifest(request.command, {
    processed: 2,
    itemReceiptHashes: [HASH_A]
  })), TypeError)
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1(manifest(request.command, {
    processed: 2,
    itemReceiptHashes: [HASH_A, HASH_A]
  })), TypeError)
  assert.throws(() => encodeMemoryMaintenanceBatchManifestV1(manifest(request.command, {
    processed: 0,
    hasMore: true,
    itemReceiptHashes: []
  })), TypeError)

  const valid = manifest(request.command)
  for (const bad of [
    manifest(request.command, { processed: 3, itemReceiptHashes: [HASH_A, HASH_B, HASH_C] }),
    manifest(request.command, { processed: 1, hasMore: true }),
    { ...valid, selectionOrder: 'newest_first' }
  ]) {
    const port = createMemoryMaintenancePortV1({
      now: () => NOW,
      execute: async () => bad
    })
    assert.deepEqual(await port.execute(request), {
      status: 'corrupt',
      category: 'adapter_contract'
    })
  }
  assert.equal(wire.limit, 2)
})

test('access and maintenance capabilities are exact and wrong fields never dispatch', async () => {
  const base = envelope()
  let dispatches = 0
  const port = createMemoryMaintenancePortV1({
    now: () => NOW,
    execute: async request => {
      dispatches += 1
      return manifest(request.command)
    }
  })

  const wrongOperationCommand = maintenanceCommand('proposal.purgeDecided')
  const mismatches: MemoryMaintenanceAuthorizationEnvelopeV1[] = [
    Object.freeze({ ...base, command: wrongOperationCommand }),
    envelope('proposal.expireDue', { limit: 31 }, { limit: 32 }),
    envelope('proposal.expireDue', { currentGeneration: 4, targetGeneration: 4 }, {
      currentGeneration: 3,
      targetGeneration: 3
    }),
    envelope('namespace.scrubDeleted', {
      deletionRef: `deletion:${HASH_C}`
    }, {
      deletionRef: `deletion:${HASH_B}`
    })
  ]
  for (const mismatch of mismatches) {
    const result = await port.execute(mismatch)
    assert.equal(result.status, 'denied')
  }
  assert.equal(dispatches, 0)

  const forged = {
    ...base.maintenance,
    operation: 'proposal.purgeDecided'
  }
  const forgedResult = await port.execute({ ...base, maintenance: forged })
  assert.deepEqual(forgedResult, { status: 'denied', category: 'authority' })
  assert.equal(dispatches, 0)
})

test('same command exact replay is byte-identical and a next batch needs a new commandRef', async () => {
  const request = envelope()
  const stable = manifest(request.command, { hasMore: true, processed: 32,
    itemReceiptHashes: Array.from({ length: 32 }, (_, index) =>
      index.toString(16).padStart(64, '0')) })
  const port = createMemoryMaintenancePortV1({
    now: () => NOW,
    execute: async () => JSON.parse(encodeMemoryMaintenanceBatchManifestV1(stable))
  })
  const first = await port.execute(request)
  const replay = await port.execute(request)
  assert.equal(JSON.stringify(first), JSON.stringify(replay))

  const next = maintenanceCommand('proposal.expireDue', { commandRef: commandRef('2') })
  assert.notEqual(memoryMaintenanceCommandHashV1(request.command), memoryMaintenanceCommandHashV1(next))
  assert.notEqual(
    memoryMaintenanceResolveRefV1(decodeMemoryMaintenanceCommandWireV1(request.command.wire).commandRef),
    memoryMaintenanceResolveRefV1(decodeMemoryMaintenanceCommandWireV1(next.wire).commandRef)
  )
})

test('abort boundaries distinguish zero-dispatch, committed and unknown outcomes', async () => {
  const request = envelope()
  const pre = new AbortController()
  pre.abort()
  let dispatches = 0
  let nowCalls = 0
  const prePort = createMemoryMaintenancePortV1({
    now: () => {
      nowCalls += 1
      throw new Error('hostile clock must not run')
    },
    execute: async envelope => {
      dispatches += 1
      return manifest(envelope.command)
    }
  })
  assert.deepEqual(await prePort.execute(request, pre.signal), { status: 'aborted' })
  assert.equal(dispatches, 0)
  assert.equal(nowCalls, 0)

  const late = new AbortController()
  const committedPort = createMemoryMaintenancePortV1({
    now: () => NOW,
    execute: async envelope => {
      late.abort()
      return manifest(envelope.command)
    }
  })
  const committed = await committedPort.execute(request, late.signal)
  assert.equal(committed.status, 'committed_after_abort')
  if (committed.status === 'committed_after_abort') {
    assert.equal(committed.committedResultHash,
      memoryMaintenanceBatchManifestHashV1(manifest(request.command)))
    assert.equal(committed.resolveRef,
      memoryMaintenanceResolveRefV1(decodeMemoryMaintenanceCommandWireV1(request.command.wire).commandRef))
  }

  for (const adapterKind of ['throw', 'invalid'] as const) {
    const lateAbortController = new AbortController()
    const port = createMemoryMaintenancePortV1({
      now: () => NOW,
      execute: async () => {
        lateAbortController.abort()
        if (adapterKind === 'throw') throw new Error('unknown')
        return { status: 'completed' }
      }
    })
    const result = await port.execute(request, lateAbortController.signal)
    assert.equal(result.status, 'resolve_required')
  }
})

test('adapter failures are fixed body-free results and cannot forge committed states', async () => {
  const request = envelope()
  const throwing = createMemoryMaintenancePortV1({
    now: () => NOW,
    execute: async () => { throw new Error('secret body') }
  })
  assert.deepEqual(await throwing.execute(request), {
    status: 'unavailable', category: 'io', retryable: true
  })

  for (const bad of [
    { status: 'committed_after_abort', committedResultHash: HASH_A },
    { status: 'resolve_required', category: 'outcome_unknown', resolveRef: `resolve:${HASH_A}` },
    new Proxy(manifest(request.command), {}),
    { ...manifest(request.command), operation: 'record.purgeExpired' }
  ]) {
    const port = createMemoryMaintenancePortV1({ now: () => NOW, execute: async () => bad })
    assert.deepEqual(await port.execute(request), {
      status: 'corrupt', category: 'adapter_contract'
    })
  }
})

test('maintenance unavailable results have fixed retryability', async () => {
  const request = envelope()
  for (const result of [
    { status: 'unavailable', category: 'busy', retryable: false },
    { status: 'unavailable', category: 'storage', retryable: true },
    { status: 'unavailable', category: 'io', retryable: false }
  ]) {
    const port = createMemoryMaintenancePortV1({ now: () => NOW, execute: async () => result })
    assert.deepEqual(await port.execute(request), {
      status: 'corrupt', category: 'adapter_contract'
    })
  }

  for (const result of [
    { status: 'unavailable' as const, category: 'busy' as const, retryable: true },
    { status: 'unavailable' as const, category: 'storage' as const, retryable: false },
    { status: 'unavailable' as const, category: 'io' as const, retryable: true }
  ]) {
    const port = createMemoryMaintenancePortV1({ now: () => NOW, execute: async () => result })
    assert.deepEqual(await port.execute(request), result)
  }
})

test('versioned envelopes and trusted time fail closed before adapter dispatch', async () => {
  const request = envelope()
  let dispatches = 0
  const port = createMemoryMaintenancePortV1({
    now: () => { throw new Error('clock secret') },
    execute: async envelope => {
      dispatches += 1
      return manifest(envelope.command)
    }
  })
  await assert.rejects(port.execute(request), TypeError)
  assert.equal(dispatches, 0)

  const validTimePort = createMemoryMaintenancePortV1({
    now: () => NOW,
    execute: async envelope => {
      dispatches += 1
      return manifest(envelope.command)
    }
  })
  const { schemaVersion: _schemaVersion, ...unversioned } = request
  await assert.rejects(validTimePort.execute(unversioned), TypeError)
  assert.equal(dispatches, 0)
})
