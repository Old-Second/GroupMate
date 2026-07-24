import { types as utilTypes } from 'node:util'
import {
  encodeCanonicalMemoryRecordV1,
  parseCanonicalMemoryRecordV1,
  type CanonicalMemoryRecordV1
} from './memory-canonical-wire.js'
import {
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

export interface MemoryHotCacheHeadV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly revision: number
  readonly contentHash: string
}

export type MemoryHotCacheRequestV1 =
  | {
      readonly schemaVersion: 1
      readonly operation: 'record.get'
      readonly head: MemoryHotCacheHeadV1
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'record.put'
      readonly record: CanonicalMemoryRecordV1
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'record.invalidate'
      readonly namespaceRef: MemoryNamespaceRefV1
      readonly namespaceGeneration: number
      readonly memoryId: string
      readonly deletedRevision: number
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'namespace.invalidate'
      readonly namespaceRef: MemoryNamespaceRefV1
      readonly deletedGeneration: number
      readonly nextGeneration: number
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'usage.get'
    }

export interface MemoryHotCacheUsageV1 {
  readonly schemaVersion: 1
  readonly recordCount: number
  readonly generationCount: number
  readonly recordEntryBytes: number
  readonly expiryIndexBytes: number
  readonly lruIndexBytes: number
  readonly dynamicMetadataBytes: number
  readonly staticBytes: number
  readonly totalLogicalBytes: number
}

export type MemoryHotCacheResultV1 =
  | { readonly status: 'hit'; readonly record: CanonicalMemoryRecordV1 }
  | {
      readonly status: 'miss'
      readonly reason: 'not_found' | 'expired' | 'stale' | 'mismatch' | 'corrupt'
    }
  | { readonly status: 'stored' | 'unchanged' | 'invalidated' }
  | { readonly status: 'skipped'; readonly reason: 'capacity' | 'expired' | 'stale' }
  | { readonly status: 'usage'; readonly value: MemoryHotCacheUsageV1 }
  | { readonly status: 'unavailable' }
  | { readonly status: 'aborted' }

export interface MemoryHotCachePortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryHotCacheResultV1>
}

export interface MemoryHotCacheAdapterV1 {
  readonly execute: (
    request: MemoryHotCacheRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export const MEMORY_HOT_CACHE_ACCOUNTING_V1 = Object.freeze({
  staticBytes: 357,
  recordFieldBytes: 64,
  indexEntryBytes: 80,
  headMetadataBytes: 147,
  generationMetadataBytes: 82
})

const REQUEST_OPERATIONS = [
  'record.get',
  'record.put',
  'record.invalidate',
  'namespace.invalidate',
  'usage.get'
] as const

const REQUEST_FIELDS = [
  'head',
  'record',
  'namespaceRef',
  'namespaceGeneration',
  'memoryId',
  'deletedRevision',
  'deletedGeneration',
  'nextGeneration'
] as const

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function positiveInteger (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function nonnegativeInteger (value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function memoryId (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !value.startsWith('memory:') || value.length === 'memory:'.length) {
    return invalidMemoryValue()
  }
  return value
}

function contentHash (value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

function parseHead (value: unknown): MemoryHotCacheHeadV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef',
    'namespaceGeneration',
    'memoryId',
    'revision',
    'contentHash'
  ])
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration),
    memoryId: memoryId(input.memoryId),
    revision: positiveInteger(input.revision),
    contentHash: contentHash(input.contentHash)
  })
}

function parseRequest (value: unknown): MemoryHotCacheRequestV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation'],
    REQUEST_FIELDS
  )
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(discriminator.operation, REQUEST_OPERATIONS)
  if (operation === 'record.get') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'head'])
    return Object.freeze({ schemaVersion: 1 as const, operation, head: parseHead(input.head) })
  }
  if (operation === 'record.put') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'record'])
    const record = parseCanonicalMemoryRecordV1(input.record)
    encodeCanonicalMemoryRecordV1(record)
    return Object.freeze({ schemaVersion: 1 as const, operation, record })
  }
  if (operation === 'record.invalidate') {
    const input = inspectMemoryRecord(value, [
      'schemaVersion',
      'operation',
      'namespaceRef',
      'namespaceGeneration',
      'memoryId',
      'deletedRevision'
    ])
    return Object.freeze({
      schemaVersion: 1 as const,
      operation,
      namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
      namespaceGeneration: positiveInteger(input.namespaceGeneration),
      memoryId: memoryId(input.memoryId),
      deletedRevision: positiveInteger(input.deletedRevision)
    })
  }
  if (operation === 'namespace.invalidate') {
    const input = inspectMemoryRecord(value, [
      'schemaVersion',
      'operation',
      'namespaceRef',
      'deletedGeneration',
      'nextGeneration'
    ])
    const deletedGeneration = positiveInteger(input.deletedGeneration)
    const nextGeneration = positiveInteger(input.nextGeneration)
    if (nextGeneration !== deletedGeneration + 1) return invalidMemoryValue()
    return Object.freeze({
      schemaVersion: 1 as const,
      operation,
      namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
      deletedGeneration,
      nextGeneration
    })
  }
  inspectMemoryRecord(value, ['schemaVersion', 'operation'])
  return Object.freeze({ schemaVersion: 1 as const, operation })
}

function recordMatchesHead (record: CanonicalMemoryRecordV1, head: MemoryHotCacheHeadV1): boolean {
  return record.namespaceRef === head.namespaceRef &&
    record.namespaceGeneration === head.namespaceGeneration &&
    record.memoryId === head.memoryId &&
    record.revision === head.revision &&
    record.contentHash === head.contentHash
}

function parseUsage (value: unknown): MemoryHotCacheUsageV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion',
    'recordCount',
    'generationCount',
    'recordEntryBytes',
    'expiryIndexBytes',
    'lruIndexBytes',
    'dynamicMetadataBytes',
    'staticBytes',
    'totalLogicalBytes'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const result = Object.freeze({
    schemaVersion: 1 as const,
    recordCount: nonnegativeInteger(input.recordCount, MEMORY_RESOURCE_LIMITS.redisHotRecords),
    generationCount: nonnegativeInteger(
      input.generationCount,
      MEMORY_RESOURCE_LIMITS.deploymentNamespaces
    ),
    recordEntryBytes: nonnegativeInteger(
      input.recordEntryBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    ),
    expiryIndexBytes: nonnegativeInteger(
      input.expiryIndexBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    ),
    lruIndexBytes: nonnegativeInteger(
      input.lruIndexBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    ),
    dynamicMetadataBytes: nonnegativeInteger(
      input.dynamicMetadataBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    ),
    staticBytes: nonnegativeInteger(
      input.staticBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    ),
    totalLogicalBytes: nonnegativeInteger(
      input.totalLogicalBytes,
      MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes
    )
  })
  if (result.staticBytes !== MEMORY_HOT_CACHE_ACCOUNTING_V1.staticBytes ||
    result.expiryIndexBytes !== result.recordCount *
      MEMORY_HOT_CACHE_ACCOUNTING_V1.indexEntryBytes ||
    result.lruIndexBytes !== result.recordCount *
      MEMORY_HOT_CACHE_ACCOUNTING_V1.indexEntryBytes ||
    result.dynamicMetadataBytes !== result.recordCount *
      MEMORY_HOT_CACHE_ACCOUNTING_V1.headMetadataBytes + result.generationCount *
      MEMORY_HOT_CACHE_ACCOUNTING_V1.generationMetadataBytes ||
    result.recordEntryBytes < result.recordCount *
      MEMORY_HOT_CACHE_ACCOUNTING_V1.recordFieldBytes ||
    result.recordEntryBytes > result.recordCount *
      (MEMORY_HOT_CACHE_ACCOUNTING_V1.recordFieldBytes +
        MEMORY_RESOURCE_LIMITS.recordWireBytes) ||
    result.totalLogicalBytes !==
    result.recordEntryBytes + result.expiryIndexBytes + result.lruIndexBytes +
      result.dynamicMetadataBytes + result.staticBytes) return invalidMemoryValue()
  return result
}

function parseResult (
  value: unknown,
  request: MemoryHotCacheRequestV1,
  signalAborted: boolean
): MemoryHotCacheResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], ['record', 'reason', 'value'])
  const status = discriminator.status
  if (status === 'hit') {
    if (request.operation !== 'record.get') return invalidMemoryValue()
    const input = inspectMemoryRecord(value, ['status', 'record'])
    const record = parseCanonicalMemoryRecordV1(input.record)
    encodeCanonicalMemoryRecordV1(record)
    if (!recordMatchesHead(record, request.head)) return invalidMemoryValue()
    return Object.freeze({ status, record })
  }
  if (status === 'miss') {
    if (request.operation !== 'record.get') return invalidMemoryValue()
    const input = inspectMemoryRecord(value, ['status', 'reason'])
    return Object.freeze({
      status,
      reason: enumValue(input.reason, [
        'not_found', 'expired', 'stale', 'mismatch', 'corrupt'
      ] as const)
    })
  }
  if (status === 'stored') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'record.put') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'unchanged') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'record.put' &&
      request.operation !== 'record.invalidate' &&
      request.operation !== 'namespace.invalidate') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'invalidated') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'record.invalidate' &&
      request.operation !== 'namespace.invalidate') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'skipped') {
    const input = inspectMemoryRecord(value, ['status', 'reason'])
    if (request.operation === 'namespace.invalidate') {
      if (input.reason !== 'capacity') return invalidMemoryValue()
      return Object.freeze({ status, reason: 'capacity' as const })
    }
    if (request.operation !== 'record.put') return invalidMemoryValue()
    return Object.freeze({
      status,
      reason: enumValue(input.reason, ['capacity', 'expired', 'stale'] as const)
    })
  }
  if (status === 'usage') {
    if (request.operation !== 'usage.get') return invalidMemoryValue()
    const input = inspectMemoryRecord(value, ['status', 'value'])
    return Object.freeze({ status, value: parseUsage(input.value) })
  }
  if (status === 'unavailable') {
    inspectMemoryRecord(value, ['status'])
    return UNAVAILABLE_RESULT
  }
  if (status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    if (!signalAborted) return invalidMemoryValue()
    return ABORTED_RESULT
  }
  return invalidMemoryValue()
}

const UNAVAILABLE_RESULT: MemoryHotCacheResultV1 = Object.freeze({ status: 'unavailable' })
const ABORTED_RESULT: MemoryHotCacheResultV1 = Object.freeze({ status: 'aborted' })

export function createMemoryHotCachePortV1 (
  optionsValue: MemoryHotCacheAdapterV1
): MemoryHotCachePortV1 {
  const options = inspectMemoryRecord(optionsValue, ['execute'])
  if (typeof options.execute !== 'function' || utilTypes.isProxy(options.execute)) {
    return invalidMemoryValue()
  }
  const adapterExecute = options.execute as MemoryHotCacheAdapterV1['execute']
  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryHotCacheResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseRequest(requestValue)
      if (signalScope.isAborted()) return ABORTED_RESULT
      let result: unknown
      try {
        result = await Reflect.apply(adapterExecute, undefined, [request, signalScope.signal])
      } catch {
        return UNAVAILABLE_RESULT
      }
      try {
        return parseResult(result, request, signalScope.isAborted())
      } catch {
        return UNAVAILABLE_RESULT
      }
    } finally {
      signalScope.close()
    }
  }
  return Object.freeze({ execute })
}
