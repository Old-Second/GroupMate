import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import {
  MEMORY_MAINTENANCE_OPERATIONS_V1,
  memoryMaintenanceCapabilityAllowsRequestV1,
  type MemoryMaintenanceCapabilityV1,
  type MemoryMaintenanceOperationV1
} from './memory-lifecycle-authority.js'
import {
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleInstantV1,
  parseMemoryLifecyclePositiveIntegerV1
} from './memory-lifecycle-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

export const MEMORY_MAINTENANCE_COMMAND_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-command.v1'
export const MEMORY_MAINTENANCE_COMMAND_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-command-ref.v1'
export const MEMORY_MAINTENANCE_RESULT_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-result.v1'
export const MEMORY_MAINTENANCE_BATCH_RECEIPT_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-batch-receipt.v1'
export const MEMORY_MAINTENANCE_RESOLVE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.maintenance-resolve-ref.v1'

export interface MemoryMaintenanceCommandWireV1 {
  readonly schemaVersion: 1
  readonly commandRef: string
  readonly operation: MemoryMaintenanceOperationV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly deletionRef: string | null
  readonly limit: number
  readonly occurredAt: string
}

export interface MemoryMaintenanceCommandV1 {
  readonly wire: string
}

export interface MemoryMaintenanceAuthorizationEnvelopeV1 {
  readonly schemaVersion: 1
  readonly command: MemoryMaintenanceCommandV1
  readonly access: MemoryAccessCapabilityV1
  readonly maintenance: MemoryMaintenanceCapabilityV1
}

export interface MemoryMaintenanceBatchManifestV1 {
  readonly schemaVersion: 1
  readonly status: 'completed'
  readonly commandRefHash: string
  readonly commandHash: string
  readonly operation: MemoryMaintenanceOperationV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly deletionRef: string | null
  readonly selectionOrder: 'oldest_first'
  readonly processed: number
  readonly hasMore: boolean
  readonly itemReceiptHashes: readonly string[]
  readonly completedAt: string
  readonly receiptHash: string
}

export type MemoryMaintenanceBatchManifestFieldsV1 = Omit<
  MemoryMaintenanceBatchManifestV1,
  'receiptHash'
>

export type MemoryMaintenancePortResultV1 =
  | MemoryMaintenanceBatchManifestV1
  | { readonly status: 'denied'; readonly category: 'access' | 'authority' }
  | { readonly status: 'conflict'; readonly category: 'generation' | 'idempotency' }
  | {
      readonly status: 'capacity'
      readonly category: 'maintenance_capacity' | 'ledger_capacity'
    }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | {
      readonly status: 'committed_after_abort'
      readonly resolveRef: string
      readonly committedResultHash: string
    }
  | {
      readonly status: 'resolve_required'
      readonly category: 'outcome_unknown'
      readonly resolveRef: string
    }
  | { readonly status: 'aborted' }

export interface MemoryMaintenancePortV1 {
  readonly execute: (
    envelope: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryMaintenancePortResultV1>
}

export interface MemoryMaintenancePortOptionsV1 {
  readonly now: () => string
  /**
   * The adapter must acquire its write lock, freeze one trusted high-water, and revalidate the
   * exact access capability, maintenance capability, generation binding and operation state
   * before applying the bounded batch. The outer check is advisory only.
   */
  readonly execute: (
    envelope: MemoryMaintenanceAuthorizationEnvelopeV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

const COMMAND_REF = /^command:[0-9a-f]{64}$/
const DELETION_REF = /^deletion:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const OLD_GENERATION_OPERATIONS = new Set<MemoryMaintenanceOperationV1>([
  'namespace.scrubDeleted',
  'namespace.verifyScrubbed'
])

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function parseCommandRef (value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_REF.test(value)) return invalidMemoryValue()
  return value
}

function parseDeletionRef (value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !DELETION_REF.test(value)) return invalidMemoryValue()
  return value
}

function parseHash (value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return invalidMemoryValue()
  return value
}

function parseNonnegativeInteger (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function assertMaintenanceOperationShape (
  operation: MemoryMaintenanceOperationV1,
  currentGeneration: number,
  targetGeneration: number,
  deletionRef: string | null
): void {
  if (OLD_GENERATION_OPERATIONS.has(operation)) {
    if (deletionRef === null || targetGeneration >= currentGeneration) return invalidMemoryValue()
  } else if (deletionRef !== null || targetGeneration !== currentGeneration) {
    return invalidMemoryValue()
  }
}

function parseWireObject (value: unknown): MemoryMaintenanceCommandWireV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'commandRef', 'operation', 'namespaceRef', 'currentGeneration',
    'targetGeneration', 'deletionRef', 'limit', 'occurredAt'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(input.operation, MEMORY_MAINTENANCE_OPERATIONS_V1)
  const currentGeneration = parseMemoryLifecyclePositiveIntegerV1(input.currentGeneration)
  const targetGeneration = parseMemoryLifecyclePositiveIntegerV1(input.targetGeneration)
  const deletionRef = parseDeletionRef(input.deletionRef)
  const limit = parseMemoryLifecyclePositiveIntegerV1(
    input.limit,
    MEMORY_RESOURCE_LIMITS.operationBatchRecords
  )
  assertMaintenanceOperationShape(operation, currentGeneration, targetGeneration, deletionRef)
  return Object.freeze({
    schemaVersion: 1 as const,
    commandRef: parseCommandRef(input.commandRef),
    operation,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    currentGeneration,
    targetGeneration,
    deletionRef,
    limit,
    occurredAt: parseMemoryLifecycleInstantV1(input.occurredAt)
  })
}

export function encodeMemoryMaintenanceCommandWireV1 (value: unknown): string {
  const wire = JSON.stringify(parseWireObject(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes) return invalidMemoryValue()
  return wire
}

export function decodeMemoryMaintenanceCommandWireV1 (
  raw: unknown
): MemoryMaintenanceCommandWireV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandWireBytes) return invalidMemoryValue()
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parseWireObject(value)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

export function createMemoryMaintenanceCommandV1 (value: unknown): MemoryMaintenanceCommandV1 {
  const input = inspectMemoryRecord(value, [
    'commandRef', 'operation', 'namespaceRef', 'currentGeneration', 'targetGeneration',
    'deletionRef', 'limit', 'occurredAt'
  ])
  return Object.freeze({
    wire: encodeMemoryMaintenanceCommandWireV1({ schemaVersion: 1, ...input })
  })
}

export function parseMemoryMaintenanceCommandV1 (value: unknown): MemoryMaintenanceCommandV1 {
  const input = inspectMemoryRecord(value, ['wire'])
  return Object.freeze({ wire: encodeMemoryMaintenanceCommandWireV1(
    decodeMemoryMaintenanceCommandWireV1(input.wire)
  ) })
}

export function memoryMaintenanceCommandHashV1 (value: unknown): string {
  const command = typeof value === 'string'
    ? Object.freeze({ wire: value })
    : parseMemoryMaintenanceCommandV1(value)
  return memoryLifecycleDomainHashV1(
    MEMORY_MAINTENANCE_COMMAND_HASH_DOMAIN_V1,
    parseMemoryMaintenanceCommandV1(command).wire
  )
}

export function memoryMaintenanceCommandRefHashV1 (value: unknown): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_MAINTENANCE_COMMAND_REF_HASH_DOMAIN_V1,
    parseCommandRef(value)
  )
}

export function memoryMaintenanceResolveRefV1 (value: unknown): string {
  return `resolve:${memoryLifecycleDomainHashV1(
    MEMORY_MAINTENANCE_RESOLVE_REF_HASH_DOMAIN_V1,
    parseCommandRef(value)
  )}`
}

function parseReceiptHashes (value: unknown, processed: number): readonly string[] {
  const hashes = inspectMemoryArray(
    value,
    MEMORY_RESOURCE_LIMITS.operationBatchRecords
  ).map(parseHash)
  if (hashes.length !== processed || new Set(hashes).size !== hashes.length) {
    return invalidMemoryValue()
  }
  return Object.freeze(hashes)
}

function parseMemoryMaintenanceBatchManifestFieldsV1 (
  value: unknown
): MemoryMaintenanceBatchManifestFieldsV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'status', 'commandRefHash', 'commandHash', 'operation',
    'namespaceRef', 'currentGeneration', 'targetGeneration', 'deletionRef',
    'selectionOrder', 'processed', 'hasMore', 'itemReceiptHashes', 'completedAt'
  ])
  if (input.schemaVersion !== 1 || input.status !== 'completed' ||
    input.selectionOrder !== 'oldest_first' || typeof input.hasMore !== 'boolean') {
    return invalidMemoryValue()
  }
  const processed = parseNonnegativeInteger(
    input.processed,
    MEMORY_RESOURCE_LIMITS.operationBatchRecords
  )
  if (processed === 0 && input.hasMore) return invalidMemoryValue()
  const operation = enumValue(input.operation, MEMORY_MAINTENANCE_OPERATIONS_V1)
  const currentGeneration = parseMemoryLifecyclePositiveIntegerV1(input.currentGeneration)
  const targetGeneration = parseMemoryLifecyclePositiveIntegerV1(input.targetGeneration)
  const deletionRef = parseDeletionRef(input.deletionRef)
  assertMaintenanceOperationShape(operation, currentGeneration, targetGeneration, deletionRef)
  return Object.freeze({
    schemaVersion: 1 as const,
    status: 'completed' as const,
    commandRefHash: parseHash(input.commandRefHash),
    commandHash: parseHash(input.commandHash),
    operation,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    currentGeneration,
    targetGeneration,
    deletionRef,
    selectionOrder: 'oldest_first' as const,
    processed,
    hasMore: input.hasMore,
    itemReceiptHashes: parseReceiptHashes(input.itemReceiptHashes, processed),
    completedAt: parseMemoryLifecycleInstantV1(input.completedAt)
  })
}

export function memoryMaintenanceBatchReceiptHashV1 (value: unknown): string {
  return memoryLifecycleDomainHashV1(
    MEMORY_MAINTENANCE_BATCH_RECEIPT_HASH_DOMAIN_V1,
    JSON.stringify(parseMemoryMaintenanceBatchManifestFieldsV1(value))
  )
}

export function createMemoryMaintenanceBatchManifestV1 (
  value: unknown
): MemoryMaintenanceBatchManifestV1 {
  const fields = parseMemoryMaintenanceBatchManifestFieldsV1(value)
  return Object.freeze({
    ...fields,
    receiptHash: memoryMaintenanceBatchReceiptHashV1(fields)
  })
}

export function parseMemoryMaintenanceBatchManifestV1 (
  value: unknown
): MemoryMaintenanceBatchManifestV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'status', 'commandRefHash', 'commandHash', 'operation',
    'namespaceRef', 'currentGeneration', 'targetGeneration', 'deletionRef',
    'selectionOrder', 'processed', 'hasMore', 'itemReceiptHashes', 'completedAt',
    'receiptHash'
  ])
  const { receiptHash, ...fieldValues } = input
  const fields = parseMemoryMaintenanceBatchManifestFieldsV1(fieldValues)
  const parsedReceiptHash = parseHash(receiptHash)
  if (parsedReceiptHash !== memoryMaintenanceBatchReceiptHashV1(fields)) {
    return invalidMemoryValue()
  }
  return Object.freeze({ ...fields, receiptHash: parsedReceiptHash })
}

export function encodeMemoryMaintenanceBatchManifestV1 (value: unknown): string {
  const wire = JSON.stringify(parseMemoryMaintenanceBatchManifestV1(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) {
    return invalidMemoryValue()
  }
  return wire
}

export function decodeMemoryMaintenanceBatchManifestV1 (
  raw: unknown
): MemoryMaintenanceBatchManifestV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandResultWireBytes) {
    return invalidMemoryValue()
  }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parseMemoryMaintenanceBatchManifestV1(value)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

export function memoryMaintenanceBatchManifestHashV1 (value: unknown): string {
  const wire = typeof value === 'string'
    ? encodeMemoryMaintenanceBatchManifestV1(decodeMemoryMaintenanceBatchManifestV1(value))
    : encodeMemoryMaintenanceBatchManifestV1(value)
  return memoryLifecycleDomainHashV1(MEMORY_MAINTENANCE_RESULT_HASH_DOMAIN_V1, wire)
}

function parseEnvelope (value: unknown): MemoryMaintenanceAuthorizationEnvelopeV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'command', 'access', 'maintenance'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  for (const capability of [input.access, input.maintenance]) {
    if (capability === null || typeof capability !== 'object' || utilTypes.isProxy(capability)) {
      return invalidMemoryValue()
    }
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    command: parseMemoryMaintenanceCommandV1(input.command),
    access: input.access as MemoryAccessCapabilityV1,
    maintenance: input.maintenance as MemoryMaintenanceCapabilityV1
  })
}

export function parseMemoryMaintenanceAuthorizationEnvelopeV1 (
  value: unknown
): MemoryMaintenanceAuthorizationEnvelopeV1 {
  return parseEnvelope(value)
}

function parseAdapterResult (
  value: unknown,
  command: MemoryMaintenanceCommandWireV1,
  commandHash: string,
  signalAborted: boolean
): Exclude<MemoryMaintenancePortResultV1, {
    readonly status: 'committed_after_abort' | 'resolve_required'
  }> {
  const discriminator = inspectMemoryRecord(value, ['status'], [
    'schemaVersion', 'commandRefHash', 'commandHash', 'operation', 'namespaceRef',
    'currentGeneration', 'targetGeneration', 'deletionRef', 'selectionOrder', 'processed',
    'hasMore', 'itemReceiptHashes', 'completedAt', 'receiptHash', 'category', 'retryable'
  ])
  if (discriminator.status === 'completed') {
    const manifest = parseMemoryMaintenanceBatchManifestV1(value)
    if (manifest.commandRefHash !== memoryMaintenanceCommandRefHashV1(command.commandRef) ||
      manifest.commandHash !== commandHash || manifest.operation !== command.operation ||
      manifest.namespaceRef !== command.namespaceRef ||
      manifest.currentGeneration !== command.currentGeneration ||
      manifest.targetGeneration !== command.targetGeneration ||
      manifest.deletionRef !== command.deletionRef || manifest.processed > command.limit ||
      (manifest.hasMore && manifest.processed !== command.limit)) return invalidMemoryValue()
    return manifest
  }
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'denied' as const,
      category: enumValue(input.category, ['access', 'authority'] as const)
    })
  }
  if (discriminator.status === 'conflict') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'conflict' as const,
      category: enumValue(input.category, ['generation', 'idempotency'] as const)
    })
  }
  if (discriminator.status === 'capacity') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'capacity' as const,
      category: enumValue(
        input.category,
        ['maintenance_capacity', 'ledger_capacity'] as const
      )
    })
  }
  if (discriminator.status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'corrupt' as const,
      category: enumValue(input.category, ['canonical_data', 'adapter_contract'] as const)
    })
  }
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    if (typeof input.retryable !== 'boolean') return invalidMemoryValue()
    const category = enumValue(input.category, ['busy', 'storage', 'io'] as const)
    if (input.retryable !== (category !== 'storage')) return invalidMemoryValue()
    return Object.freeze({
      status: 'unavailable' as const,
      category,
      retryable: input.retryable
    })
  }
  if (discriminator.status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    if (!signalAborted) return invalidMemoryValue()
    return Object.freeze({ status: 'aborted' as const })
  }
  return invalidMemoryValue()
}

const DENIED_ACCESS = Object.freeze({ status: 'denied' as const, category: 'access' as const })
const DENIED_AUTHORITY = Object.freeze({
  status: 'denied' as const,
  category: 'authority' as const
})
const ABORTED = Object.freeze({ status: 'aborted' as const })
const ADAPTER_CORRUPT = Object.freeze({
  status: 'corrupt' as const,
  category: 'adapter_contract' as const
})
const IO_UNAVAILABLE = Object.freeze({
  status: 'unavailable' as const,
  category: 'io' as const,
  retryable: true
})

function resolveRequired (commandRef: string): MemoryMaintenancePortResultV1 {
  return Object.freeze({
    status: 'resolve_required' as const,
    category: 'outcome_unknown' as const,
    resolveRef: memoryMaintenanceResolveRefV1(commandRef)
  })
}

export function createMemoryMaintenancePortV1 (
  optionsValue: MemoryMaintenancePortOptionsV1
): MemoryMaintenancePortV1 {
  const options = inspectMemoryRecord(optionsValue, ['now', 'execute'])
  if (typeof options.now !== 'function' || typeof options.execute !== 'function' ||
    utilTypes.isProxy(options.now) || utilTypes.isProxy(options.execute)) {
    return invalidMemoryValue()
  }
  const now = options.now as MemoryMaintenancePortOptionsV1['now']
  const adapterExecute = options.execute as MemoryMaintenancePortOptionsV1['execute']

  const execute = async (
    envelopeValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryMaintenancePortResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const envelope = parseEnvelope(envelopeValue)
      const command = decodeMemoryMaintenanceCommandWireV1(envelope.command.wire)
      const commandHash = memoryMaintenanceCommandHashV1(envelope.command)
      if (signalScope.isAborted()) return ABORTED
      let currentTime: string
      try {
        currentTime = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
      } catch {
        return invalidMemoryValue()
      }
      if (!memoryAccessCapabilityAllowsV1(
        envelope.access,
        command.namespaceRef,
        currentTime
      )) return DENIED_ACCESS
      const authorityRequest = Object.freeze({
        botInstanceId: envelope.access.botInstanceId,
        accountId: envelope.access.accountId,
        namespaceRef: command.namespaceRef,
        currentGeneration: command.currentGeneration,
        targetGeneration: command.targetGeneration,
        deletionRef: command.deletionRef,
        operation: command.operation,
        limit: command.limit
      })
      if (!memoryMaintenanceCapabilityAllowsRequestV1(
        envelope.maintenance,
        authorityRequest,
        currentTime
      )) return DENIED_AUTHORITY
      let adapterResult: unknown
      try {
        adapterResult = await Reflect.apply(adapterExecute, undefined, [
          envelope,
          signalScope.signal
        ])
      } catch {
        return signalScope.isAborted()
          ? resolveRequired(command.commandRef)
          : IO_UNAVAILABLE
      }
      const signalAborted = signalScope.isAborted()
      let result: ReturnType<typeof parseAdapterResult>
      try {
        result = parseAdapterResult(adapterResult, command, commandHash, signalAborted)
      } catch {
        return signalAborted
          ? resolveRequired(command.commandRef)
          : ADAPTER_CORRUPT
      }
      if (signalAborted && result.status === 'completed') {
        return Object.freeze({
          status: 'committed_after_abort' as const,
          resolveRef: memoryMaintenanceResolveRefV1(command.commandRef),
          committedResultHash: memoryMaintenanceBatchManifestHashV1(result)
        })
      }
      return result
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ execute })
}
