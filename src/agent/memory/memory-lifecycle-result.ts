import {
  memoryLifecycleDomainHashV1,
  parseDeletionMutationReceiptV1,
  parseMemoryLifecycleHashV1,
  parseMemoryLifecycleHashedRefV1,
  parseMemoryLifecyclePositiveIntegerV1,
  type DeletionMutationReceiptV1
} from './memory-lifecycle-domain.js'
import {
  MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1,
  type MemoryLifecycleCommandOperationV1
} from './memory-lifecycle-command.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

export const MEMORY_LIFECYCLE_STABLE_RESULT_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-result.v1'
export const MEMORY_LIFECYCLE_RESOLVE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-resolve-ref.v1'

export const MEMORY_LIFECYCLE_RESULT_STATUSES_V1 = Object.freeze([
  'stored',
  'unchanged',
  'deletion_pending',
  'deletion_complete',
  'not_found',
  'opaque_not_applied',
  'already_decided',
  'proposal_expired',
  'record_expired',
  'record_purge_due',
  'denied',
  'conflict',
  'capacity',
  'history_limit',
  'corrupt',
  'unavailable',
  'committed_after_abort',
  'resolve_required',
  'aborted'
] as const)

export const MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1 = Object.freeze([
  'stored',
  'unchanged',
  'deletion_pending',
  'deletion_complete',
  'not_found',
  'opaque_not_applied',
  'already_decided',
  'proposal_expired',
  'record_expired',
  'record_purge_due',
  'conflict',
  'history_limit'
] as const)

export type MemoryLifecycleResultStatusV1 =
  typeof MEMORY_LIFECYCLE_RESULT_STATUSES_V1[number]
export type MemoryLifecycleStableResultStatusV1 =
  typeof MEMORY_LIFECYCLE_LEDGER_STABLE_RESULT_STATUSES_V1[number]

export type MemoryLifecycleDeniedCategoryV1 = 'access' | 'authority'
export type MemoryLifecycleConflictCategoryV1 =
  | 'revision'
  | 'generation'
  | 'idempotency'
export type MemoryLifecycleCapacityCategoryV1 =
  | 'pending_proposals'
  | 'active_records'
  | 'retained_revisions'
  | 'namespaces'
  | 'canonical_bytes'
  | 'outbox_records'
  | 'outbox_bytes'
  | 'audit_records'
  | 'audit_bytes'
  | 'command_ledger'
  | 'maintenance_capacity'
  | 'ledger_capacity'
export type MemoryLifecycleCorruptCategoryV1 = 'canonical_data' | 'adapter_contract'
export type MemoryLifecycleUnavailableCategoryV1 = 'busy' | 'storage' | 'io'

interface MemoryLifecycleResultBaseV1 {
  readonly schemaVersion: 1
  readonly operation: MemoryLifecycleCommandOperationV1
  readonly commandHash: string
}

type MemoryLifecycleStoredResultV1 =
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'stored' | 'unchanged'
      readonly resultRef: string
      readonly resultRevision: number
      readonly resultHash: string
      readonly receiptHash: string
    }

type MemoryLifecycleDeletionResultV1 =
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'unchanged' | 'deletion_pending' | 'deletion_complete'
      readonly receipt: DeletionMutationReceiptV1
    }

type MemoryLifecyclePermanentTerminalResultV1 =
  | MemoryLifecycleResultBaseV1 & {
      readonly status:
        | 'not_found'
        | 'opaque_not_applied'
        | 'already_decided'
        | 'proposal_expired'
        | 'record_expired'
        | 'record_purge_due'
        | 'history_limit'
    }

type MemoryLifecycleConflictResultV1 = MemoryLifecycleResultBaseV1 & {
  readonly status: 'conflict'
  readonly category: MemoryLifecycleConflictCategoryV1
}

export type MemoryLifecycleStableResultV1 =
  | MemoryLifecycleStoredResultV1
  | MemoryLifecycleDeletionResultV1
  | MemoryLifecyclePermanentTerminalResultV1
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'conflict'
      readonly category: Exclude<MemoryLifecycleConflictCategoryV1, 'idempotency'>
    }

export type MemoryLifecycleResultV1 =
  | MemoryLifecycleStoredResultV1
  | MemoryLifecycleDeletionResultV1
  | MemoryLifecyclePermanentTerminalResultV1
  | MemoryLifecycleConflictResultV1
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'denied'
      readonly category: MemoryLifecycleDeniedCategoryV1
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'capacity'
      readonly category: MemoryLifecycleCapacityCategoryV1
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'corrupt'
      readonly category: MemoryLifecycleCorruptCategoryV1
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'unavailable'
      readonly category: MemoryLifecycleUnavailableCategoryV1
      readonly retryable: boolean
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'committed_after_abort'
      readonly resolveRef: string
      readonly committedResultHash: string
      readonly receipt?: DeletionMutationReceiptV1
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'resolve_required'
      readonly category: 'outcome_unknown'
      readonly resolveRef: string
    }
  | MemoryLifecycleResultBaseV1 & {
      readonly status: 'aborted'
    }

export type MemoryLifecycleStableResultWireV1 = string

const HASHED_REF = /^[0-9a-f]{64}$/
const RESOLVE_REF = /^resolve:[0-9a-f]{64}$/
const DELETION_OPERATIONS = new Set<MemoryLifecycleCommandOperationV1>([
  'record.forget', 'namespace.delete'
])
const PROPOSAL_RESULT_OPERATIONS = new Set<MemoryLifecycleCommandOperationV1>([
  'proposal.create', 'proposal.approve', 'proposal.reject', 'proposal.withdraw',
  'proposal.expire'
])
const COMMON_OUTER_STATUSES = [
  'denied', 'corrupt', 'unavailable', 'committed_after_abort', 'resolve_required', 'aborted'
] as const
function resultStatusSet (
  ...values: MemoryLifecycleResultStatusV1[]
): ReadonlySet<MemoryLifecycleResultStatusV1> {
  return new Set(values)
}
const OPERATION_STATUS_MATRIX: Readonly<Record<
MemoryLifecycleCommandOperationV1,
ReadonlySet<MemoryLifecycleResultStatusV1>
>> = Object.freeze({
  'proposal.create': resultStatusSet(
    'stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'proposal.createAndApprove': resultStatusSet(
    'stored', 'unchanged', 'proposal_expired', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'proposal.approve': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'proposal.reject': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'proposal.withdraw': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'proposal.expire': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'already_decided', 'proposal_expired',
    'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'record.correct': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES
  ),
  'record.renew': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES
  ),
  'record.changeConflict': resultStatusSet(
    'stored', 'unchanged', 'not_found', 'record_expired', 'record_purge_due',
    'conflict', 'capacity', 'history_limit', ...COMMON_OUTER_STATUSES
  ),
  'record.forget': resultStatusSet(
    'unchanged', 'deletion_pending', 'deletion_complete', 'not_found',
    'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  ),
  'namespace.delete': resultStatusSet(
    'unchanged', 'deletion_pending', 'deletion_complete', 'not_found',
    'opaque_not_applied', 'conflict', 'capacity', ...COMMON_OUTER_STATUSES
  )
})

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function parseHash (value: unknown): string {
  if (typeof value !== 'string' || !HASHED_REF.test(value)) return invalidMemoryValue()
  return value
}

function parseResolveRef (value: unknown, commandHash: string): string {
  if (typeof value !== 'string' || !RESOLVE_REF.test(value) ||
    value !== memoryLifecycleResolveRefV1(commandHash)) return invalidMemoryValue()
  return value
}

function expectedResultRefPrefix (operation: MemoryLifecycleCommandOperationV1): string {
  if (PROPOSAL_RESULT_OPERATIONS.has(operation)) return 'proposal:'
  return 'memory:'
}

function expectedFixedResultRevision (
  operation: MemoryLifecycleCommandOperationV1
): number | null {
  if (operation === 'proposal.create' || operation === 'proposal.createAndApprove') return 1
  if (operation.startsWith('proposal.')) return 2
  return null
}

function parseOperationAndStatus (value: unknown): {
  readonly operation: MemoryLifecycleCommandOperationV1
  readonly status: MemoryLifecycleResultStatusV1
} {
  const input = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation', 'commandHash', 'status'],
    [
      'resultRef', 'resultRevision', 'resultHash', 'receiptHash', 'receipt', 'category',
      'retryable', 'resolveRef', 'committedResultHash'
    ]
  )
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(input.operation, MEMORY_LIFECYCLE_COMMAND_OPERATIONS_V1)
  const status = enumValue(input.status, MEMORY_LIFECYCLE_RESULT_STATUSES_V1)
  if (!OPERATION_STATUS_MATRIX[operation].has(status)) return invalidMemoryValue()
  return Object.freeze({ operation, status })
}

function parseResultObject (value: unknown): MemoryLifecycleResultV1 {
  const discriminator = parseOperationAndStatus(value)
  const operation = discriminator.operation
  const status = discriminator.status
  const baseKeys = ['schemaVersion', 'operation', 'commandHash', 'status']
  const commandHashInput = inspectMemoryRecord(
    value,
    baseKeys,
    [
      'resultRef', 'resultRevision', 'resultHash', 'receiptHash', 'receipt', 'category',
      'retryable', 'resolveRef', 'committedResultHash'
    ]
  ).commandHash
  const commandHash = parseHash(commandHashInput)
  const base = { schemaVersion: 1 as const, operation, commandHash }

  if (status === 'stored' || status === 'unchanged') {
    if (DELETION_OPERATIONS.has(operation)) {
      if (status !== 'unchanged') return invalidMemoryValue()
      const input = inspectMemoryRecord(value, [...baseKeys, 'receipt'])
      const receipt = parseDeletionMutationReceiptV1(input.receipt)
      const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace'
      if (receipt.operation !== expectedReceiptOperation) return invalidMemoryValue()
      return Object.freeze({ ...base, status, receipt })
    }
    const input = inspectMemoryRecord(value, [
      ...baseKeys, 'resultRef', 'resultRevision', 'resultHash', 'receiptHash'
    ])
    const resultRevision = parseMemoryLifecyclePositiveIntegerV1(
      input.resultRevision,
      MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
    )
    const fixedRevision = expectedFixedResultRevision(operation)
    if (fixedRevision !== null && resultRevision !== fixedRevision) return invalidMemoryValue()
    return Object.freeze({
      ...base,
      status,
      resultRef: parseMemoryLifecycleHashedRefV1(
        input.resultRef,
        expectedResultRefPrefix(operation)
      ),
      resultRevision,
      resultHash: parseMemoryLifecycleHashV1(input.resultHash),
      receiptHash: parseMemoryLifecycleHashV1(input.receiptHash)
    })
  }
  if (status === 'deletion_pending' || status === 'deletion_complete') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'receipt'])
    const receipt = parseDeletionMutationReceiptV1(input.receipt)
    const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace'
    if (receipt.operation !== expectedReceiptOperation) return invalidMemoryValue()
    return Object.freeze({ ...base, status, receipt })
  }
  if (status === 'denied') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category'])
    return Object.freeze({
      ...base,
      status,
      category: enumValue(input.category, ['access', 'authority'] as const)
    })
  }
  if (status === 'conflict') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category'])
    return Object.freeze({
      ...base,
      status,
      category: enumValue(input.category, ['revision', 'generation', 'idempotency'] as const)
    })
  }
  if (status === 'capacity') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category'])
    return Object.freeze({
      ...base,
      status,
      category: enumValue(input.category, [
        'pending_proposals', 'active_records', 'retained_revisions', 'namespaces',
        'canonical_bytes', 'outbox_records', 'outbox_bytes', 'audit_records',
        'audit_bytes', 'command_ledger', 'maintenance_capacity', 'ledger_capacity'
      ] as const)
    })
  }
  if (status === 'corrupt') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category'])
    return Object.freeze({
      ...base,
      status,
      category: enumValue(input.category, ['canonical_data', 'adapter_contract'] as const)
    })
  }
  if (status === 'unavailable') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category', 'retryable'])
    if (typeof input.retryable !== 'boolean') return invalidMemoryValue()
    const category = enumValue(input.category, ['busy', 'storage', 'io'] as const)
    if (input.retryable !== (category !== 'storage')) return invalidMemoryValue()
    return Object.freeze({
      ...base,
      status,
      category,
      retryable: input.retryable
    })
  }
  if (status === 'committed_after_abort') {
    const deletionOperation = DELETION_OPERATIONS.has(operation)
    const input = inspectMemoryRecord(
      value,
      [...baseKeys, 'resolveRef', 'committedResultHash'],
      deletionOperation ? ['receipt'] : []
    )
    const receipt = deletionOperation && input.receipt !== undefined
      ? parseDeletionMutationReceiptV1(input.receipt)
      : null
    if (receipt !== null) {
      const expectedReceiptOperation = operation === 'record.forget' ? 'forget' : 'delete_namespace'
      if (receipt.operation !== expectedReceiptOperation) return invalidMemoryValue()
    }
    return Object.freeze({
      ...base,
      status,
      resolveRef: parseResolveRef(input.resolveRef, commandHash),
      committedResultHash: parseMemoryLifecycleHashV1(input.committedResultHash),
      ...(receipt === null ? {} : { receipt })
    })
  }
  if (status === 'resolve_required') {
    const input = inspectMemoryRecord(value, [...baseKeys, 'category', 'resolveRef'])
    if (input.category !== 'outcome_unknown') return invalidMemoryValue()
    return Object.freeze({
      ...base,
      status,
      category: 'outcome_unknown' as const,
      resolveRef: parseResolveRef(input.resolveRef, commandHash)
    })
  }
  inspectMemoryRecord(value, baseKeys)
  return Object.freeze({ ...base, status })
}

function assertResultWireLimit<Result extends MemoryLifecycleResultV1> (
  result: Result
): Result {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) return invalidMemoryValue()
  return result
}

function isLedgerStableResult (
  result: MemoryLifecycleResultV1
): result is MemoryLifecycleStableResultV1 {
  return result.status === 'stored' || result.status === 'unchanged' ||
    result.status === 'deletion_pending' || result.status === 'deletion_complete' ||
    result.status === 'not_found' || result.status === 'opaque_not_applied' ||
    result.status === 'already_decided' || result.status === 'proposal_expired' ||
    result.status === 'record_expired' || result.status === 'record_purge_due' ||
    result.status === 'history_limit' ||
    (result.status === 'conflict' && result.category !== 'idempotency')
}

function parseLedgerStableResultObject (value: unknown): MemoryLifecycleStableResultV1 {
  const result = assertResultWireLimit(parseResultObject(value))
  if (!isLedgerStableResult(result)) return invalidMemoryValue()
  return result
}

export function createMemoryLifecycleResultV1 (
  value: unknown
): MemoryLifecycleResultV1 {
  return assertResultWireLimit(parseResultObject(value))
}

export function parseMemoryLifecycleResultV1 (
  value: unknown
): MemoryLifecycleResultV1 {
  return assertResultWireLimit(parseResultObject(value))
}

export function createMemoryLifecycleStableResultV1 (
  value: unknown
): MemoryLifecycleStableResultV1 {
  return parseLedgerStableResultObject(value)
}

export function parseMemoryLifecycleStableResultV1 (
  value: unknown
): MemoryLifecycleStableResultV1 {
  return parseLedgerStableResultObject(value)
}

export function encodeMemoryLifecycleStableResultWireV1 (value: unknown): string {
  const wire = JSON.stringify(parseLedgerStableResultObject(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) return invalidMemoryValue()
  return wire
}

export function decodeMemoryLifecycleStableResultWireV1 (
  raw: unknown
): MemoryLifecycleStableResultV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) return invalidMemoryValue()
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const result = parseLedgerStableResultObject(value)
  if (JSON.stringify(result) !== raw) return invalidMemoryValue()
  return result
}

export function memoryLifecycleStableResultHashV1 (value: unknown): string {
  const wire = typeof value === 'string'
    ? encodeMemoryLifecycleStableResultWireV1(
        decodeMemoryLifecycleStableResultWireV1(value)
      )
    : encodeMemoryLifecycleStableResultWireV1(value)
  return memoryLifecycleDomainHashV1(MEMORY_LIFECYCLE_STABLE_RESULT_HASH_DOMAIN_V1, wire)
}

export function memoryLifecycleResolveRefV1 (commandHashValue: unknown): string {
  const commandHash = parseHash(commandHashValue)
  return `resolve:${memoryLifecycleDomainHashV1(
    MEMORY_LIFECYCLE_RESOLVE_REF_HASH_DOMAIN_V1,
    commandHash
  )}`
}

export function memoryLifecycleResultIsLedgerStableV1 (
  value: MemoryLifecycleResultV1
): value is MemoryLifecycleStableResultV1
export function memoryLifecycleResultIsLedgerStableV1 (value: unknown): boolean
export function memoryLifecycleResultIsLedgerStableV1 (value: unknown): boolean {
  try {
    if (typeof value === 'string') {
      decodeMemoryLifecycleStableResultWireV1(value)
      return true
    }
    return isLedgerStableResult(parseMemoryLifecycleResultV1(value))
  } catch {
    return false
  }
}
