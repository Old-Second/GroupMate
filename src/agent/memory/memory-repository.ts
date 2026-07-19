import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import {
  encodeMemoryProposalV1,
  encodeMemoryRecordV1,
  encodeMemoryRevisionV1,
  encodeMemoryTombstoneV1
} from './memory-codec.js'
import {
  parseMemoryProposalV1,
  parseMemoryRecordV1,
  parseMemoryRevisionV1,
  parseMemoryTombstoneV1,
  type MemoryProposalV1,
  type MemoryRecordV1,
  type MemoryRevisionV1,
  type MemoryTombstoneV1
} from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

interface MemoryRepositoryRequestBaseV1 {
  readonly schemaVersion: 1
  readonly capability: MemoryAccessCapabilityV1
  readonly namespaceRef: MemoryNamespaceRefV1
}

type ApprovedMemoryProposalV1 = MemoryProposalV1 & {
  readonly state: 'approved'
  readonly decision: NonNullable<MemoryProposalV1['decision']>
}

type DeclinedMemoryProposalV1 = MemoryProposalV1 & {
  readonly state: 'rejected' | 'expired'
  readonly decision: NonNullable<MemoryProposalV1['decision']>
}

export type MemoryRepositoryRequestV1 =
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'proposal.create'
      readonly expectedNamespaceGeneration: number
      readonly proposal: MemoryProposalV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'proposal.load'
      readonly proposalId: string
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'proposal.decide'
      readonly expectedRevision: number
      readonly expectedNamespaceGeneration: number
      readonly nextProposal: ApprovedMemoryProposalV1
      readonly initialRevision: MemoryRevisionV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'proposal.decide'
      readonly expectedRevision: number
      readonly expectedNamespaceGeneration: number
      readonly nextProposal: DeclinedMemoryProposalV1
      readonly initialRevision: null
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'record.create'
      readonly expectedNamespaceGeneration: number
      readonly initialRevision: MemoryRevisionV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'record.get'
      readonly memoryId: string
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'record.list'
      readonly cursor: string | null
      readonly limit: number
      readonly maxWireBytes: number
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'record.correct'
      readonly expectedRevision: number
      readonly expectedNamespaceGeneration: number
      readonly nextRevision: MemoryRevisionV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'record.forget'
      readonly expectedRevision: number
      readonly expectedNamespaceGeneration: number
      readonly tombstone: MemoryTombstoneV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'namespace.delete'
      readonly expectedNamespaceGeneration: number
      readonly tombstone: MemoryTombstoneV1
    }
  | MemoryRepositoryRequestBaseV1 & {
      readonly operation: 'usage.get'
    }

export interface MemoryRepositoryUsageV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly pendingProposalRecords: number
  readonly activeMemoryRecords: number
  readonly retainedRevisionRecords: number
  readonly tombstoneRecords: number
  readonly canonicalLogicalBytes: number
  readonly pendingOutboxRecords: number
  readonly outboxLogicalBytes: number
}

export type MemoryRepositoryResultV1 =
  | {
      readonly status: 'stored' | 'unchanged'
      readonly value: MemoryProposalV1 | MemoryRecordV1 | MemoryTombstoneV1
      readonly receipt: string
    }
  | { readonly status: 'found'; readonly value: MemoryProposalV1 | MemoryRecordV1 }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'page'
      readonly records: readonly MemoryRecordV1[]
      readonly nextCursor: string | null
      readonly wireBytes: number
    }
  | { readonly status: 'usage'; readonly value: MemoryRepositoryUsageV1 }
  | {
      readonly status: 'conflict'
      readonly category: 'revision' | 'generation' | 'idempotency'
    }
  | {
      readonly status: 'capacity'
      readonly category:
        | 'pending_proposals'
        | 'active_records'
        | 'retained_revisions'
        | 'tombstones'
        | 'canonical_bytes'
        | 'outbox_records'
        | 'outbox_bytes'
    }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'committed_after_abort'; readonly receipt: string }
  | { readonly status: 'aborted' }

export interface MemoryRepositoryPortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryRepositoryResultV1>
}

interface MemoryRepositoryPortOptionsV1 {
  readonly now: () => string
  readonly execute: (
    request: MemoryRepositoryRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

const REPOSITORY_OPERATIONS = [
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
] as const

type MemoryRepositoryOperationV1 = typeof REPOSITORY_OPERATIONS[number]

const REPOSITORY_REQUEST_FIELDS = [
  'capability',
  'namespaceRef',
  'expectedNamespaceGeneration',
  'proposal',
  'proposalId',
  'expectedRevision',
  'nextProposal',
  'initialRevision',
  'memoryId',
  'cursor',
  'limit',
  'maxWireBytes',
  'nextRevision',
  'tombstone'
] as const

const RECEIPT_PATTERN = /^memory-receipt:v1:[0-9a-f]{64}$/
const CURSOR_PATTERN = /^memory-cursor:v1:[0-9a-f]{64}$/

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function positiveInteger (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function prefixedId (value: unknown, prefix: string): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !value.startsWith(prefix) || value.length === prefix.length) return invalidMemoryValue()
  return value
}

function opaqueReceipt (value: unknown): string {
  if (typeof value !== 'string' || !RECEIPT_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function opaqueCursor (value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function parseOperation (value: unknown): MemoryRepositoryOperationV1 {
  return enumValue(value, REPOSITORY_OPERATIONS)
}

function parseWireCheckedRevision (value: unknown): MemoryRevisionV1 {
  const revision = parseMemoryRevisionV1(value)
  encodeMemoryRevisionV1(revision)
  encodeMemoryRecordV1(revision.record)
  return revision
}

function canonicalValuesEqual (left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function approvalBindsInitialRevision (
  proposal: MemoryProposalV1,
  revision: MemoryRevisionV1,
  namespaceRef: MemoryNamespaceRefV1,
  namespaceGeneration: number
): boolean {
  const decision = proposal.decision
  const record = revision.record
  return proposal.state === 'approved' && decision !== null &&
    revision.operation === 'created' && revision.revision === 1 &&
    record.namespaceRef === namespaceRef &&
    record.namespaceGeneration === namespaceGeneration &&
    record.revision === 1 &&
    record.kind === proposal.kind &&
    record.text === proposal.text &&
    canonicalValuesEqual(record.sources, proposal.sources) &&
    record.observedAt === proposal.observedAt &&
    record.confidence === proposal.confidence &&
    record.sensitivity === proposal.sensitivity &&
    canonicalValuesEqual(record.conflict, proposal.conflict) &&
    canonicalValuesEqual(record.retention, proposal.suggestedRetention) &&
    record.consent.state === proposal.consentRequirement &&
    record.consent.approvedByActorRef === decision.decidedByActorRef &&
    record.consent.approvedAt === decision.decidedAt &&
    record.createdAt === decision.decidedAt &&
    record.confirmedAt === decision.decidedAt &&
    revision.changedByActorRef === decision.decidedByActorRef &&
    revision.changedAt === decision.decidedAt &&
    revision.reason === decision.reason
}

function parseRequestBase (
  value: unknown,
  keys: readonly string[]
): {
  readonly input: Readonly<Record<string, unknown>>
  readonly capability: MemoryAccessCapabilityV1
  readonly namespaceRef: MemoryNamespaceRefV1
} {
  const input = inspectMemoryRecord(value, keys)
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return {
    input,
    capability: input.capability as MemoryAccessCapabilityV1,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef)
  }
}

function parseMemoryRepositoryRequestV1 (value: unknown): MemoryRepositoryRequestV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation'],
    REPOSITORY_REQUEST_FIELDS
  )
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const operation = parseOperation(discriminator.operation)
  const shared = ['schemaVersion', 'operation', 'capability', 'namespaceRef'] as const

  switch (operation) {
    case 'proposal.create': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedNamespaceGeneration', 'proposal'
      ])
      const proposal = parseMemoryProposalV1(input.proposal)
      encodeMemoryProposalV1(proposal)
      if (proposal.namespaceRef !== namespaceRef || proposal.revision !== 1 ||
        proposal.state !== 'pending') return invalidMemoryValue()
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedNamespaceGeneration: positiveInteger(input.expectedNamespaceGeneration),
        proposal
      })
    }
    case 'proposal.load': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'proposalId'
      ])
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        proposalId: prefixedId(input.proposalId, 'proposal:')
      })
    }
    case 'proposal.decide': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedRevision', 'expectedNamespaceGeneration', 'nextProposal',
        'initialRevision'
      ])
      const expectedRevision = positiveInteger(input.expectedRevision)
      const expectedNamespaceGeneration = positiveInteger(input.expectedNamespaceGeneration)
      const nextProposal = parseMemoryProposalV1(input.nextProposal)
      encodeMemoryProposalV1(nextProposal)
      if (nextProposal.namespaceRef !== namespaceRef ||
        nextProposal.revision !== expectedRevision + 1 || nextProposal.state === 'pending') {
        return invalidMemoryValue()
      }
      const initialRevision = input.initialRevision === null
        ? null
        : parseWireCheckedRevision(input.initialRevision)
      if ((nextProposal.state === 'approved' && (initialRevision === null ||
        !approvalBindsInitialRevision(
          nextProposal,
          initialRevision,
          namespaceRef,
          expectedNamespaceGeneration
      ))) || (nextProposal.state !== 'approved' && initialRevision !== null)) {
        return invalidMemoryValue()
      }
      if (nextProposal.state === 'approved') {
        return Object.freeze({
          schemaVersion: 1 as const,
          operation,
          capability,
          namespaceRef,
          expectedRevision,
          expectedNamespaceGeneration,
          nextProposal: nextProposal as ApprovedMemoryProposalV1,
          initialRevision: initialRevision as MemoryRevisionV1
        })
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedRevision,
        expectedNamespaceGeneration,
        nextProposal: nextProposal as DeclinedMemoryProposalV1,
        initialRevision: null
      })
    }
    case 'record.create': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedNamespaceGeneration', 'initialRevision'
      ])
      const expectedNamespaceGeneration = positiveInteger(input.expectedNamespaceGeneration)
      const initialRevision = parseWireCheckedRevision(input.initialRevision)
      const record = initialRevision.record
      if (initialRevision.operation !== 'created' || initialRevision.revision !== 1 ||
        record.namespaceRef !== namespaceRef || record.revision !== 1 ||
        record.namespaceGeneration !== expectedNamespaceGeneration) return invalidMemoryValue()
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedNamespaceGeneration,
        initialRevision
      })
    }
    case 'record.get': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'memoryId'
      ])
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        memoryId: prefixedId(input.memoryId, 'memory:')
      })
    }
    case 'record.list': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'cursor', 'limit', 'maxWireBytes'
      ])
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        cursor: opaqueCursor(input.cursor),
        limit: positiveInteger(input.limit, MEMORY_RESOURCE_LIMITS.listPageRecords),
        maxWireBytes: positiveInteger(
          input.maxWireBytes,
          MEMORY_RESOURCE_LIMITS.listPageWireBytes
        )
      })
    }
    case 'record.correct': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedRevision', 'expectedNamespaceGeneration', 'nextRevision'
      ])
      const expectedRevision = positiveInteger(input.expectedRevision)
      const expectedNamespaceGeneration = positiveInteger(input.expectedNamespaceGeneration)
      const nextRevision = parseWireCheckedRevision(input.nextRevision)
      const nextRecord = nextRevision.record
      if (nextRevision.operation === 'created' ||
        nextRevision.revision !== expectedRevision + 1 ||
        nextRecord.namespaceRef !== namespaceRef ||
        nextRecord.revision !== expectedRevision + 1 ||
        nextRecord.namespaceGeneration !== expectedNamespaceGeneration ||
        nextRevision.changedAt !== nextRecord.updatedAt) return invalidMemoryValue()
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedRevision,
        expectedNamespaceGeneration,
        nextRevision
      })
    }
    case 'record.forget': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedRevision', 'expectedNamespaceGeneration', 'tombstone'
      ])
      const expectedRevision = positiveInteger(input.expectedRevision)
      const expectedNamespaceGeneration = positiveInteger(input.expectedNamespaceGeneration)
      const tombstone = parseMemoryTombstoneV1(input.tombstone)
      encodeMemoryTombstoneV1(tombstone)
      if (tombstone.namespaceRef !== namespaceRef ||
        tombstone.namespaceGeneration !== expectedNamespaceGeneration ||
        tombstone.deletionKind !== 'memory_forgotten' ||
        tombstone.deletedRevision !== expectedRevision) return invalidMemoryValue()
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedRevision,
        expectedNamespaceGeneration,
        tombstone
      })
    }
    case 'namespace.delete': {
      const { input, capability, namespaceRef } = parseRequestBase(value, [
        ...shared, 'expectedNamespaceGeneration', 'tombstone'
      ])
      const expectedNamespaceGeneration = positiveInteger(input.expectedNamespaceGeneration)
      const tombstone = parseMemoryTombstoneV1(input.tombstone)
      encodeMemoryTombstoneV1(tombstone)
      if (tombstone.namespaceRef !== namespaceRef ||
        tombstone.namespaceGeneration !== expectedNamespaceGeneration + 1 ||
        tombstone.deletionKind !== 'namespace_deleted') return invalidMemoryValue()
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef,
        expectedNamespaceGeneration,
        tombstone
      })
    }
    case 'usage.get': {
      const { capability, namespaceRef } = parseRequestBase(value, shared)
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        capability,
        namespaceRef
      })
    }
  }
}

function parseMutationValue (
  value: unknown,
  request: MemoryRepositoryRequestV1
): MemoryProposalV1 | MemoryRecordV1 | MemoryTombstoneV1 {
  switch (request.operation) {
    case 'proposal.create':
    case 'proposal.decide': {
      const proposal = parseMemoryProposalV1(value)
      const expected = request.operation === 'proposal.create'
        ? request.proposal
        : request.nextProposal
      if (encodeMemoryProposalV1(proposal) !== encodeMemoryProposalV1(expected)) {
        return invalidMemoryValue()
      }
      return proposal
    }
    case 'record.create':
    case 'record.correct': {
      const record = parseMemoryRecordV1(value)
      encodeMemoryRecordV1(record)
      const expected = request.operation === 'record.create'
        ? request.initialRevision.record
        : request.nextRevision.record
      if (encodeMemoryRecordV1(record) !== encodeMemoryRecordV1(expected)) {
        return invalidMemoryValue()
      }
      return record
    }
    case 'record.forget':
    case 'namespace.delete': {
      const tombstone = parseMemoryTombstoneV1(value)
      if (encodeMemoryTombstoneV1(tombstone) !== encodeMemoryTombstoneV1(request.tombstone)) {
        return invalidMemoryValue()
      }
      return tombstone
    }
    default:
      return invalidMemoryValue()
  }
}

function parseFoundValue (
  value: unknown,
  request: MemoryRepositoryRequestV1
): MemoryProposalV1 | MemoryRecordV1 {
  if (request.operation === 'proposal.load') {
    const proposal = parseMemoryProposalV1(value)
    encodeMemoryProposalV1(proposal)
    if (proposal.namespaceRef !== request.namespaceRef || proposal.proposalId !== request.proposalId) {
      return invalidMemoryValue()
    }
    return proposal
  }
  if (request.operation === 'record.get') {
    const record = parseMemoryRecordV1(value)
    encodeMemoryRecordV1(record)
    if (record.namespaceRef !== request.namespaceRef || record.memoryId !== request.memoryId) {
      return invalidMemoryValue()
    }
    return record
  }
  return invalidMemoryValue()
}

function parsePageResult (
  value: unknown,
  request: Extract<MemoryRepositoryRequestV1, { readonly operation: 'record.list' }>
): MemoryRepositoryResultV1 {
  const input = inspectMemoryRecord(value, ['status', 'records', 'nextCursor'])
  if (input.status !== 'page') return invalidMemoryValue()
  const records = inspectMemoryArray(input.records, MEMORY_RESOURCE_LIMITS.listPageRecords)
    .map(parseMemoryRecordV1)
  if (records.length > request.limit || records.some(record => (
    record.namespaceRef !== request.namespaceRef
  )) || new Set(records.map(record => record.memoryId)).size !== records.length) {
    return invalidMemoryValue()
  }
  const canonicalWire = `[${records.map(encodeMemoryRecordV1).join(',')}]`
  const wireBytes = Buffer.byteLength(canonicalWire, 'utf8')
  if (wireBytes > request.maxWireBytes ||
    wireBytes > MEMORY_RESOURCE_LIMITS.listPageWireBytes) return invalidMemoryValue()
  const nextCursor = opaqueCursor(input.nextCursor)
  if ((records.length === 0 && nextCursor !== null) ||
    (nextCursor !== null && nextCursor === request.cursor)) return invalidMemoryValue()
  return Object.freeze({
    status: 'page' as const,
    records: Object.freeze(records),
    nextCursor,
    wireBytes
  })
}

function parseUsageValue (
  value: unknown,
  expectedNamespaceRef: MemoryNamespaceRefV1
): MemoryRepositoryUsageV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion',
    'namespaceRef',
    'namespaceGeneration',
    'pendingProposalRecords',
    'activeMemoryRecords',
    'retainedRevisionRecords',
    'tombstoneRecords',
    'canonicalLogicalBytes',
    'pendingOutboxRecords',
    'outboxLogicalBytes'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  if (namespaceRef !== expectedNamespaceRef) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef,
    namespaceGeneration: positiveInteger(input.namespaceGeneration),
    pendingProposalRecords: nonnegativeInteger(input.pendingProposalRecords),
    activeMemoryRecords: nonnegativeInteger(input.activeMemoryRecords),
    retainedRevisionRecords: nonnegativeInteger(input.retainedRevisionRecords),
    tombstoneRecords: nonnegativeInteger(input.tombstoneRecords),
    canonicalLogicalBytes: nonnegativeInteger(input.canonicalLogicalBytes),
    pendingOutboxRecords: nonnegativeInteger(input.pendingOutboxRecords),
    outboxLogicalBytes: nonnegativeInteger(input.outboxLogicalBytes)
  })
}

function parseRepositoryResult (
  value: unknown,
  request: MemoryRepositoryRequestV1,
  signalAborted: boolean
): MemoryRepositoryResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], [
    'value', 'receipt', 'records', 'nextCursor', 'wireBytes', 'category', 'retryable'
  ])
  const status = discriminator.status

  if (status === 'stored' || status === 'unchanged') {
    const input = inspectMemoryRecord(value, ['status', 'value', 'receipt'])
    return Object.freeze({
      status,
      value: parseMutationValue(input.value, request),
      receipt: opaqueReceipt(input.receipt)
    })
  }
  if (status === 'found') {
    const input = inspectMemoryRecord(value, ['status', 'value'])
    return Object.freeze({ status, value: parseFoundValue(input.value, request) })
  }
  if (status === 'not_found') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'proposal.load' && request.operation !== 'record.get') {
      return invalidMemoryValue()
    }
    return Object.freeze({ status })
  }
  if (status === 'page') {
    if (request.operation !== 'record.list') return invalidMemoryValue()
    return parsePageResult(value, request)
  }
  if (status === 'usage') {
    if (request.operation !== 'usage.get') return invalidMemoryValue()
    const input = inspectMemoryRecord(value, ['status', 'value'])
    return Object.freeze({
      status,
      value: parseUsageValue(input.value, request.namespaceRef)
    })
  }
  if (status === 'conflict') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status,
      category: enumValue(input.category, ['revision', 'generation', 'idempotency'] as const)
    })
  }
  if (status === 'capacity') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status,
      category: enumValue(input.category, [
        'pending_proposals',
        'active_records',
        'retained_revisions',
        'tombstones',
        'canonical_bytes',
        'outbox_records',
        'outbox_bytes'
      ] as const)
    })
  }
  if (status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status,
      category: enumValue(input.category, ['canonical_data', 'adapter_contract'] as const)
    })
  }
  if (status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    if (typeof input.retryable !== 'boolean') return invalidMemoryValue()
    return Object.freeze({
      status,
      category: enumValue(input.category, ['busy', 'storage', 'io'] as const),
      retryable: input.retryable
    })
  }
  if (status === 'committed_after_abort') {
    const input = inspectMemoryRecord(value, ['status', 'receipt'])
    if (!signalAborted || !isMutationRequest(request)) return invalidMemoryValue()
    return Object.freeze({ status, receipt: opaqueReceipt(input.receipt) })
  }
  if (status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    if (!signalAborted) return invalidMemoryValue()
    return Object.freeze({ status })
  }
  return invalidMemoryValue()
}

function isMutationRequest (request: MemoryRepositoryRequestV1): boolean {
  return request.operation === 'proposal.create' ||
    request.operation === 'proposal.decide' ||
    request.operation === 'record.create' ||
    request.operation === 'record.correct' ||
    request.operation === 'record.forget' ||
    request.operation === 'namespace.delete'
}

const ADAPTER_CONTRACT_RESULT: MemoryRepositoryResultV1 = Object.freeze({
  status: 'corrupt' as const,
  category: 'adapter_contract' as const
})

const ADAPTER_IO_RESULT: MemoryRepositoryResultV1 = Object.freeze({
  status: 'unavailable' as const,
  category: 'io' as const,
  retryable: true
})

const ABORTED_RESULT: MemoryRepositoryResultV1 = Object.freeze({ status: 'aborted' as const })

export function createMemoryRepositoryPortV1 (
  optionsValue: MemoryRepositoryPortOptionsV1
): MemoryRepositoryPortV1 {
  const options = inspectMemoryRecord(optionsValue, ['now', 'execute'])
  if (typeof options.now !== 'function' || typeof options.execute !== 'function') {
    return invalidMemoryValue()
  }
  const now = options.now as () => string
  const adapterExecute = options.execute as MemoryRepositoryPortOptionsV1['execute']

  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryRepositoryResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseMemoryRepositoryRequestV1(requestValue)
      let currentTime: unknown
      try {
        currentTime = Reflect.apply(now, undefined, [])
      } catch {
        return invalidMemoryValue()
      }
      if (!memoryAccessCapabilityAllowsV1(
        request.capability,
        request.namespaceRef,
        currentTime
      )) return invalidMemoryValue()
      if (signalScope.isAborted()) return ABORTED_RESULT

      let adapterResult: unknown
      try {
        adapterResult = await Reflect.apply(adapterExecute, undefined, [
          request,
          signalScope.signal
        ])
      } catch {
        return ADAPTER_IO_RESULT
      }
      try {
        const signalAborted = signalScope.isAborted()
        const result = parseRepositoryResult(adapterResult, request, signalAborted)
        if (signalAborted && isMutationRequest(request) &&
          (result.status === 'stored' || result.status === 'unchanged')) {
          return Object.freeze({
            status: 'committed_after_abort' as const,
            receipt: result.receipt
          })
        }
        return result
      } catch {
        return ADAPTER_CONTRACT_RESULT
      }
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ execute })
}
