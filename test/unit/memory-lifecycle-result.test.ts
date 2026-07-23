import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDeletionMutationReceiptV1
} from '../../src/agent/memory/memory-lifecycle-domain.js'
import {
  MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1,
  MEMORY_LIFECYCLE_RESULT_STATUSES_V1,
  createMemoryLifecycleResultV1,
  createMemoryLifecycleStableResultV1,
  decodeMemoryLifecycleStableResultWireV1,
  encodeMemoryLifecycleStableResultWireV1,
  memoryLifecycleResolveRefV1,
  memoryLifecycleResultIsLedgerStableV1,
  memoryLifecycleStableResultHashV1,
  parseMemoryLifecycleResultV1,
  parseMemoryLifecycleStableResultV1,
  type MemoryLifecycleResultStatusV1
} from '../../src/agent/memory/memory-lifecycle-result.js'
import {
  MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1,
  type MemoryLifecycleCommandOperationV1
} from '../../src/agent/memory/memory-lifecycle-command.js'
import {
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'
import { personalMemoryNamespaceFixture } from '../helpers/memory-fixture.js'

const COMMAND_HASH = 'a'.repeat(64)
const RESULT_HASH = 'b'.repeat(64)
const RECEIPT_HASH = 'c'.repeat(64)
const COMMITTED_RESULT_HASH = 'd'.repeat(64)
const PROPOSAL_REF = `proposal:${'e'.repeat(64)}`
const MEMORY_REF = `memory:${'f'.repeat(64)}`

const COMMON_OUTER = [
  'denied', 'corrupt', 'unavailable', 'committed_after_abort', 'resolve_required', 'aborted'
] as const

const LEGAL: Readonly<Record<MemoryLifecycleCommandOperationV1, readonly MemoryLifecycleResultStatusV1[]>> = {
  'proposal.create': [
    'stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER
  ],
  'proposal.createAndApprove': [
    'stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER
  ],
  'proposal.approve': [
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER
  ],
  'proposal.reject': [
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER
  ],
  'proposal.withdraw': [
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER
  ],
  'proposal.expire': [
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER
  ],
  'record.correct': [
    'stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER
  ],
  'record.renew': [
    'stored', 'unchanged', 'not_found', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER
  ],
  'record.changeConflict': [
    'stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER
  ],
  'record.forget': [
    'unchanged', 'deletion_pending', 'deletion_complete', 'not_found',
    'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER
  ],
  'namespace.delete': [
    'unchanged', 'deletion_pending', 'deletion_complete', 'not_found',
    'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER
  ]
}

function deletionReceipt (operation: 'record.forget' | 'namespace.delete') {
  const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  return createDeletionMutationReceiptV1({
    commandRefHash: '1'.repeat(64),
    operation: operation === 'record.forget' ? 'forget' : 'delete_namespace',
    repositoryReceiptHash: '2'.repeat(64),
    namespaceRef,
    generationBefore: 1,
    generationAfter: operation === 'record.forget' ? 1 : 2,
    deletingGeneration: 1,
    memoryId: operation === 'record.forget' ? MEMORY_REF : null,
    deletedRevision: operation === 'record.forget' ? 2 : null,
    committedAt: '2026-07-22T08:00:00.000Z',
    tombstoneReceiptHash: '3'.repeat(64)
  })
}

function resultRefFor (operation: MemoryLifecycleCommandOperationV1): string {
  if (operation === 'proposal.createAndApprove' || operation.startsWith('record.')) {
    return MEMORY_REF
  }
  return PROPOSAL_REF
}

function resultFixture (
  operation: MemoryLifecycleCommandOperationV1,
  status: MemoryLifecycleResultStatusV1
): Readonly<Record<string, unknown>> {
  const common = { schemaVersion: 1, operation, commandHash: COMMAND_HASH, status }
  if (status === 'stored' || status === 'unchanged') {
    if (operation === 'record.forget' || operation === 'namespace.delete') {
      return { ...common, receipt: deletionReceipt(operation) }
    }
    return {
      ...common,
      resultRef: resultRefFor(operation),
      resultRevision: operation === 'proposal.create' ||
        operation === 'proposal.createAndApprove'
        ? 1
        : operation.startsWith('proposal.')
          ? 2
          : 3,
      resultHash: RESULT_HASH,
      receiptHash: RECEIPT_HASH
    }
  }
  if (status === 'deletion_pending' || status === 'deletion_complete') {
    if (operation !== 'record.forget' && operation !== 'namespace.delete') {
      throw new TypeError('deletion status requires a deletion operation fixture')
    }
    return { ...common, receipt: deletionReceipt(operation) }
  }
  if (status === 'committed_after_abort') {
    return {
      ...common,
      resolveRef: memoryLifecycleResolveRefV1(COMMAND_HASH),
      committedResultHash: COMMITTED_RESULT_HASH,
      ...(operation === 'record.forget' || operation === 'namespace.delete'
        ? { receipt: deletionReceipt(operation) }
        : {})
    }
  }
  if (status === 'resolve_required') {
    return {
      ...common,
      category: 'outcome_unknown',
      resolveRef: memoryLifecycleResolveRefV1(COMMAND_HASH)
    }
  }
  if (status === 'denied') return { ...common, category: 'authority' }
  if (status === 'conflict') return { ...common, category: 'revision' }
  if (status === 'capacity') return { ...common, category: 'canonical_bytes' }
  if (status === 'corrupt') return { ...common, category: 'adapter_contract' }
  if (status === 'unavailable') return { ...common, category: 'io', retryable: true }
  return common
}

test('lifecycle port results enforce the complete operation-status Cartesian matrix', () => {
  assert.equal(MEMORY_LIFECYCLE_RESULT_STATUSES_V1.length, 19)
  assert.equal(MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1.length, 12)
  for (const operation of MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1) {
    for (const status of MEMORY_LIFECYCLE_RESULT_STATUSES_V1) {
      const create = () => createMemoryLifecycleResultV1(resultFixture(operation, status))
      if (LEGAL[operation].includes(status)) assert.doesNotThrow(create, `${operation}/${status}`)
      else assert.throws(create, TypeError, `${operation}/${status}`)
    }
  }
})

test('canonical result codec binds command, hashes exact wire and preserves deletion receipts', () => {
  const input = resultFixture('record.forget', 'deletion_complete')
  const result = createMemoryLifecycleStableResultV1(input)
  const wire = encodeMemoryLifecycleStableResultWireV1(result)
  const decoded = decodeMemoryLifecycleStableResultWireV1(wire)

  assert.deepEqual(decoded, result)
  assert.deepEqual(parseMemoryLifecycleStableResultV1(decoded), result)
  assert.equal(memoryLifecycleStableResultHashV1(result), memoryLifecycleStableResultHashV1(wire))
  assert.equal(Buffer.byteLength(wire, 'utf8') <= MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes, true)
  assert.equal(Object.isFrozen(result), true)
  if ('receipt' in result) assert.equal(Object.isFrozen(result.receipt), true)
  assert.equal(wire.includes('deletionRef'), true)
  assert.equal(wire.includes('receiptHash'), true)

  assert.throws(() => createMemoryLifecycleStableResultV1({
    ...input,
    commandHash: '9'.repeat(63)
  }), TypeError)
  assert.throws(() => createMemoryLifecycleStableResultV1({
    ...input,
    receipt: deletionReceipt('namespace.delete')
  }), TypeError)
})

test('fixed operations bind deterministic aggregate kind and revision', () => {
  for (const [operation, resultRef, resultRevision] of [
    ['proposal.create', PROPOSAL_REF, 1],
    ['proposal.createAndApprove', MEMORY_REF, 1],
    ['proposal.approve', PROPOSAL_REF, 2],
    ['proposal.reject', PROPOSAL_REF, 2],
    ['proposal.withdraw', PROPOSAL_REF, 2],
    ['proposal.expire', PROPOSAL_REF, 2]
  ] as const) {
    const base = resultFixture(operation, 'stored')
    assert.doesNotThrow(() => createMemoryLifecycleStableResultV1(base))
    assert.throws(() => createMemoryLifecycleStableResultV1({
      ...base,
      resultRevision: resultRevision + 1
    }), TypeError)
    assert.throws(() => createMemoryLifecycleStableResultV1({
      ...base,
      resultRef: resultRef === PROPOSAL_REF ? MEMORY_REF : PROPOSAL_REF
    }), TypeError)
  }
})

test('unavailable categories have a fixed retryability matrix', () => {
  for (const [category, retryable] of [
    ['busy', true],
    ['storage', false],
    ['io', true]
  ] as const) {
    const base = resultFixture('proposal.create', 'unavailable')
    assert.doesNotThrow(() => createMemoryLifecycleResultV1({
      ...base,
      category,
      retryable
    }))
    assert.throws(() => createMemoryLifecycleResultV1({
      ...base,
      category,
      retryable: !retryable
    }), TypeError)
  }
})

test('stable codec and hash reject every transient outcome and idempotency conflict', () => {
  const transientStatuses = [
    'denied', 'capacity', 'corrupt', 'unavailable', 'committed_after_abort',
    'resolve_required', 'aborted'
  ] as const
  for (const status of transientStatuses) {
    const value = createMemoryLifecycleResultV1(resultFixture('proposal.create', status))
    assert.equal(memoryLifecycleResultIsLedgerStableV1(value), false, status)
    for (const stableOperation of [
      () => createMemoryLifecycleStableResultV1(value),
      () => parseMemoryLifecycleStableResultV1(value),
      () => encodeMemoryLifecycleStableResultWireV1(value),
      () => decodeMemoryLifecycleStableResultWireV1(JSON.stringify(value)),
      () => memoryLifecycleStableResultHashV1(value)
    ]) assert.throws(stableOperation, TypeError, status)
  }

  const idempotency = createMemoryLifecycleResultV1({
    ...resultFixture('proposal.create', 'conflict'),
    category: 'idempotency'
  })
  assert.equal(memoryLifecycleResultIsLedgerStableV1(idempotency), false)
  assert.throws(() => createMemoryLifecycleStableResultV1(idempotency), TypeError)
  assert.throws(() => encodeMemoryLifecycleStableResultWireV1(idempotency), TypeError)
  assert.throws(() => decodeMemoryLifecycleStableResultWireV1(
    JSON.stringify(idempotency)
  ), TypeError)
  assert.throws(() => memoryLifecycleStableResultHashV1(idempotency), TypeError)

  for (const status of MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1) {
    const operation = MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1.find(candidate =>
      LEGAL[candidate].includes(status)
    )
    assert.notEqual(operation, undefined, status)
    assert.doesNotThrow(() => createMemoryLifecycleStableResultV1(
      resultFixture(operation as MemoryLifecycleCommandOperationV1, status)
    ), status)
  }
})

test('ledger stability is derived only from immutable commit receipts', () => {
  for (const operation of MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1) {
    for (const status of LEGAL[operation]) {
      const result = createMemoryLifecycleResultV1(resultFixture(operation, status))
      const expected = status === 'stored' || status === 'unchanged' ||
        status === 'deletion_pending' || status === 'deletion_complete' ||
        status === 'not_found' || status === 'opaque_not_applied' ||
        status === 'already_decided' || status === 'proposal_expired' ||
        status === 'record_expired' || status === 'record_purge_due' ||
        status === 'conflict' || status === 'history_limit'
      assert.equal(memoryLifecycleResultIsLedgerStableV1(result), expected, `${operation}/${status}`)
    }
  }
  assert.equal(memoryLifecycleResultIsLedgerStableV1({
    schemaVersion: 1,
    operation: 'proposal.create',
    commandHash: COMMAND_HASH,
    status: 'stored'
  }), false)
  assert.equal(memoryLifecycleResultIsLedgerStableV1({
    ...resultFixture('proposal.create', 'conflict'),
    category: 'idempotency'
  }), false)
})

test('late-abort and unknown outcomes carry deterministic resolve references only', () => {
  const committed = createMemoryLifecycleResultV1(
    resultFixture('proposal.approve', 'committed_after_abort')
  )
  const unknown = createMemoryLifecycleResultV1(
    resultFixture('proposal.approve', 'resolve_required')
  )
  assert.equal(committed.status, 'committed_after_abort')
  assert.equal(unknown.status, 'resolve_required')
  if (committed.status !== 'committed_after_abort' || unknown.status !== 'resolve_required') {
    throw new TypeError('unexpected result narrowing')
  }
  assert.equal(committed.resolveRef, unknown.resolveRef)
  assert.equal(committed.resolveRef, memoryLifecycleResolveRefV1(COMMAND_HASH))
  assert.equal(Object.keys(committed).sort().join(','), [
    'commandHash', 'committedResultHash', 'operation', 'resolveRef', 'schemaVersion', 'status'
  ].sort().join(','))
  assert.equal(Object.keys(unknown).sort().join(','), [
    'category', 'commandHash', 'operation', 'resolveRef', 'schemaVersion', 'status'
  ].sort().join(','))

  const deletionCommitted = createMemoryLifecycleResultV1(
    resultFixture('record.forget', 'committed_after_abort')
  )
  assert.equal(deletionCommitted.status, 'committed_after_abort')
  if (deletionCommitted.status !== 'committed_after_abort') {
    throw new TypeError('unexpected deletion committed result')
  }
  assert.deepEqual(deletionCommitted.receipt, deletionReceipt('record.forget'))
  assert.doesNotThrow(() => createMemoryLifecycleResultV1({
    ...resultFixture('record.forget', 'committed_after_abort'),
    receipt: undefined
  }))
})

test('capacity result accepts the maintenance reserve reason code', () => {
  const result = createMemoryLifecycleResultV1({
    ...resultFixture('proposal.reject', 'capacity'),
    category: 'maintenance_capacity'
  })
  assert.equal(result.status, 'capacity')
  if (result.status === 'capacity') assert.equal(result.category, 'maintenance_capacity')
})

test('result codec rejects body, identity, capability, path and artifact handle carriers', () => {
  const base = resultFixture('proposal.create', 'stored')
  for (const [key, value] of [
    ['proposal', { text: 'secret' }],
    ['record', { text: 'secret' }],
    ['revision', { text: 'secret' }],
    ['text', 'secret'],
    ['source', { qq: '10001' }],
    ['qqIdentity', { nickname: 'secret' }],
    ['path', '/tmp/export.jsonl'],
    ['artifactHandle', 'fd:7'],
    ['capability', Object.freeze({ allowed: true })],
    ['envelope', Object.freeze({ authority: true })]
  ] as const) {
    assert.throws(() => createMemoryLifecycleStableResultV1({ ...base, [key]: value }), TypeError)
  }
  const wire = encodeMemoryLifecycleStableResultWireV1(base)
  for (const forbidden of ['secret', '/tmp/', 'nickname', 'artifactHandle', 'capability']) {
    assert.equal(wire.includes(forbidden), false)
  }
})

test('result parser and decoder fail closed on proxy, getter, symbol, sparse and byte boundaries', () => {
  const base = resultFixture('proposal.create', 'stored')
  const getter = { ...base }
  Object.defineProperty(getter, 'status', { get: () => 'stored', enumerable: true })
  const symbol = { ...base }
  Object.defineProperty(symbol, Symbol('claim'), { value: true, enumerable: true })
  const sparse: unknown[] = []
  sparse.length = 2
  sparse[1] = base
  for (const hostile of [new Proxy(base, {}), getter, symbol, sparse]) {
    assert.throws(() => parseMemoryLifecycleResultV1(hostile), TypeError)
    assert.throws(() => parseMemoryLifecycleStableResultV1(hostile), TypeError)
  }

  const exactLimit = `${' '.repeat(MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes - 2)}{}`
  const overLimit = `${exactLimit}x`
  assert.equal(Buffer.byteLength(exactLimit, 'utf8'), 4_096)
  assert.equal(Buffer.byteLength(overLimit, 'utf8'), 4_097)
  assert.throws(() => decodeMemoryLifecycleStableResultWireV1(exactLimit), TypeError)
  assert.throws(() => decodeMemoryLifecycleStableResultWireV1(overLimit), TypeError)

  const canonical = encodeMemoryLifecycleStableResultWireV1(base)
  assert.throws(() => decodeMemoryLifecycleStableResultWireV1(` ${canonical}`), TypeError)
  assert.throws(() => decodeMemoryLifecycleStableResultWireV1(`${canonical} `), TypeError)
})
