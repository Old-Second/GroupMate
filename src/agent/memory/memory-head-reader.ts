import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import { encodeMemoryRecordV1 } from './memory-codec.js'
import {
  parseMemoryRecordV1,
  type MemoryRecordV1
} from './memory-domain.js'
import type { MemoryHotCachePortV1 } from './memory-hot-cache.js'
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

export interface MemoryHeadV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly revision: number
  readonly contentHash: string
}

export type MemoryHeadSourceRequestV1 =
  | {
      readonly schemaVersion: 1
      readonly operation: 'namespace.get'
      readonly namespaceRef: MemoryNamespaceRefV1
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'head.get'
      readonly namespaceRef: MemoryNamespaceRefV1
      readonly memoryId: string
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'record.getExact'
      readonly head: MemoryHeadV1
    }

export type MemoryHeadSourceResultV1 =
  | { readonly status: 'found'; readonly namespaceGeneration: number }
  | { readonly status: 'found'; readonly head: MemoryHeadV1 }
  | { readonly status: 'found'; readonly record: MemoryRecordV1 }
  | { readonly status: 'absent'; readonly namespaceGeneration: number }
  | { readonly status: 'expired'; readonly head: MemoryHeadV1 }
  | { readonly status: 'expired' }
  | { readonly status: 'not_found' }
  | { readonly status: 'stale' }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'aborted' }

export interface MemoryHeadSourcePortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryHeadSourceResultV1>
}

export interface MemoryHeadSourceAdapterV1 {
  readonly execute: (
    request: MemoryHeadSourceRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export type MemoryReadThroughResultV1 =
  | {
      readonly status: 'found'
      readonly source: 'hot' | 'canonical'
      readonly record: MemoryRecordV1
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict' }
  | { readonly status: 'denied' }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'aborted' }

export interface MemoryReadThroughPortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryReadThroughResultV1>
}

interface CreateMemoryReadThroughOptionsV1 {
  readonly now: () => string
  readonly source: MemoryHeadSourcePortV1
  readonly cache: MemoryHotCachePortV1
}

interface MemoryReadThroughRequestV1 {
  readonly schemaVersion: 1
  readonly capability: MemoryAccessCapabilityV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly memoryId: string
}

const SOURCE_OPERATIONS = ['namespace.get', 'head.get', 'record.getExact'] as const
const SOURCE_REQUEST_FIELDS = ['namespaceRef', 'memoryId', 'head'] as const
const ADAPTER_CONTRACT_RESULT = Object.freeze({
  status: 'corrupt' as const,
  category: 'adapter_contract' as const
}) satisfies MemoryHeadSourceResultV1
const ADAPTER_IO_RESULT = Object.freeze({
  status: 'unavailable' as const,
  category: 'io' as const,
  retryable: true
}) satisfies MemoryHeadSourceResultV1
const ABORTED_RESULT = Object.freeze({ status: 'aborted' as const })
const NOT_FOUND_RESULT = Object.freeze({ status: 'not_found' as const })
const CONFLICT_RESULT = Object.freeze({ status: 'conflict' as const })
const DENIED_RESULT = Object.freeze({ status: 'denied' as const })

function positiveInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
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

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function parseHead (value: unknown): MemoryHeadV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision', 'contentHash'
  ])
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration),
    memoryId: memoryId(input.memoryId),
    revision: positiveInteger(input.revision),
    contentHash: contentHash(input.contentHash)
  })
}

function parseSourceRequest (value: unknown): MemoryHeadSourceRequestV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation'],
    SOURCE_REQUEST_FIELDS
  )
  if (discriminator.schemaVersion !== 1 ||
    typeof discriminator.operation !== 'string' ||
    !SOURCE_OPERATIONS.includes(discriminator.operation as typeof SOURCE_OPERATIONS[number])) {
    return invalidMemoryValue()
  }
  if (discriminator.operation === 'namespace.get') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'namespaceRef'])
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'namespace.get' as const,
      namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef)
    })
  }
  if (discriminator.operation === 'head.get') {
    const input = inspectMemoryRecord(value, [
      'schemaVersion', 'operation', 'namespaceRef', 'memoryId'
    ])
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'head.get' as const,
      namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
      memoryId: memoryId(input.memoryId)
    })
  }
  const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'head'])
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'record.getExact' as const,
    head: parseHead(input.head)
  })
}

function retryableCategory (
  category: 'busy' | 'storage' | 'io',
  retryable: unknown
): boolean {
  if (typeof retryable !== 'boolean' || retryable !== (category !== 'storage')) {
    return invalidMemoryValue()
  }
  return retryable
}

function parseSourceResult (
  value: unknown,
  request: MemoryHeadSourceRequestV1,
  signalAborted: boolean
): MemoryHeadSourceResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], [
    'namespaceGeneration', 'head', 'record', 'category', 'retryable'
  ])
  const status = discriminator.status
  if (status === 'found') {
    if (request.operation === 'namespace.get') {
      const input = inspectMemoryRecord(value, ['status', 'namespaceGeneration'])
      return Object.freeze({
        status,
        namespaceGeneration: positiveInteger(input.namespaceGeneration)
      })
    }
    if (request.operation === 'head.get') {
      const input = inspectMemoryRecord(value, ['status', 'head'])
      const head = parseHead(input.head)
      if (head.namespaceRef !== request.namespaceRef || head.memoryId !== request.memoryId) {
        return invalidMemoryValue()
      }
      return Object.freeze({ status, head })
    }
    const input = inspectMemoryRecord(value, ['status', 'record'])
    const record = parseMemoryRecordV1(input.record)
    encodeMemoryRecordV1(record)
    if (!recordMatchesHead(record, request.head)) return invalidMemoryValue()
    return Object.freeze({ status, record })
  }
  if (status === 'absent') {
    if (request.operation !== 'head.get') return invalidMemoryValue()
    const input = inspectMemoryRecord(value, ['status', 'namespaceGeneration'])
    return Object.freeze({
      status,
      namespaceGeneration: positiveInteger(input.namespaceGeneration)
    })
  }
  if (status === 'expired') {
    if (request.operation === 'head.get') {
      const input = inspectMemoryRecord(value, ['status', 'head'])
      const head = parseHead(input.head)
      if (head.namespaceRef !== request.namespaceRef || head.memoryId !== request.memoryId) {
        return invalidMemoryValue()
      }
      return Object.freeze({ status, head })
    }
    if (request.operation !== 'record.getExact') return invalidMemoryValue()
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status })
  }
  if (status === 'not_found') {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status })
  }
  if (status === 'stale') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'record.getExact') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    if (input.category !== 'canonical_data') return invalidMemoryValue()
    return Object.freeze({ status, category: 'canonical_data' as const })
  }
  if (status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    if (input.category !== 'busy' && input.category !== 'storage' && input.category !== 'io') {
      return invalidMemoryValue()
    }
    return Object.freeze({
      status,
      category: input.category,
      retryable: retryableCategory(input.category, input.retryable)
    })
  }
  if (status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    if (!signalAborted) return invalidMemoryValue()
    return ABORTED_RESULT
  }
  return invalidMemoryValue()
}

function recordMatchesHead (record: MemoryRecordV1, head: MemoryHeadV1): boolean {
  return record.namespaceRef === head.namespaceRef &&
    record.namespaceGeneration === head.namespaceGeneration &&
    record.memoryId === head.memoryId &&
    record.revision === head.revision &&
    record.contentHash === head.contentHash
}

function sameHead (left: MemoryHeadV1, right: MemoryHeadV1): boolean {
  return left.namespaceRef === right.namespaceRef &&
    left.namespaceGeneration === right.namespaceGeneration &&
    left.memoryId === right.memoryId &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash
}

function foundHeadValue (result: MemoryHeadSourceResultV1): MemoryHeadV1 | null {
  return result.status === 'found' && 'head' in result ? result.head : null
}

function foundRecordValue (result: MemoryHeadSourceResultV1): MemoryRecordV1 | null {
  return result.status === 'found' && 'record' in result ? result.record : null
}

function portExecute<T extends (...args: never[]) => unknown> (value: unknown): T {
  const input = inspectMemoryRecord(value, ['execute'])
  if (typeof input.execute !== 'function' || utilTypes.isProxy(input.execute)) {
    return invalidMemoryValue()
  }
  return input.execute as T
}

export function createMemoryHeadSourcePortV1 (
  optionsValue: MemoryHeadSourceAdapterV1
): MemoryHeadSourcePortV1 {
  const adapterExecute = portExecute<MemoryHeadSourceAdapterV1['execute']>(optionsValue)
  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryHeadSourceResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseSourceRequest(requestValue)
      if (signalScope.isAborted()) return ABORTED_RESULT
      let result: unknown
      try {
        result = await Reflect.apply(adapterExecute, undefined, [request, signalScope.signal])
      } catch {
        return signalScope.isAborted() ? ABORTED_RESULT : ADAPTER_IO_RESULT
      }
      if (signalScope.isAborted()) return ABORTED_RESULT
      try {
        return parseSourceResult(result, request, signalScope.isAborted())
      } catch {
        return ADAPTER_CONTRACT_RESULT
      }
    } finally {
      signalScope.close()
    }
  }
  return Object.freeze({ execute })
}

function parseReadRequest (value: unknown): MemoryReadThroughRequestV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'capability', 'namespaceRef', 'memoryId'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    capability: input.capability as MemoryAccessCapabilityV1,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    memoryId: memoryId(input.memoryId)
  })
}

function sourceTerminal (
  result: MemoryHeadSourceResultV1
): MemoryReadThroughResultV1 | null {
  if (result.status === 'not_found' || result.status === 'absent' ||
    result.status === 'expired') return NOT_FOUND_RESULT
  if (result.status === 'corrupt' || result.status === 'unavailable' ||
    result.status === 'aborted') return result
  return null
}

export function createMemoryReadThroughV1 (
  optionsValue: CreateMemoryReadThroughOptionsV1
): MemoryReadThroughPortV1 {
  const options = inspectMemoryRecord(optionsValue, ['now', 'source', 'cache'])
  if (typeof options.now !== 'function' || utilTypes.isProxy(options.now)) {
    return invalidMemoryValue()
  }
  const now = options.now as () => string
  const sourceExecute = portExecute<MemoryHeadSourcePortV1['execute']>(options.source)
  const cacheExecute = portExecute<MemoryHotCachePortV1['execute']>(options.cache)

  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryReadThroughResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseReadRequest(requestValue)
      if (signalScope.isAborted()) return ABORTED_RESULT
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let attemptTime: string
        try {
          attemptTime = canonicalInstant(Reflect.apply(now, undefined, []))
        } catch {
          return invalidMemoryValue()
        }
        if (!memoryAccessCapabilityAllowsV1(
          request.capability,
          request.namespaceRef,
          attemptTime
        )) return DENIED_RESULT
        const headResult = await Reflect.apply(sourceExecute, options.source, [{
          schemaVersion: 1,
          operation: 'head.get',
          namespaceRef: request.namespaceRef,
          memoryId: request.memoryId
        }, signalScope.signal])
        const canonicalHead = foundHeadValue(headResult)
        if (canonicalHead === null) {
          const terminal = sourceTerminal(headResult)
          if (terminal !== null) return terminal
          return ADAPTER_CONTRACT_RESULT
        }
        const cached = await Reflect.apply(cacheExecute, options.cache, [{
          schemaVersion: 1,
          operation: 'record.get',
          head: canonicalHead
        }, signalScope.signal])
        if (signalScope.isAborted()) return ABORTED_RESULT
        if (cached.status === 'aborted') return ABORTED_RESULT

        let record: MemoryRecordV1 | null = null
        let source: 'hot' | 'canonical' = 'canonical'
        if (cached.status === 'hit') {
          record = cached.record
          source = 'hot'
        } else {
          const canonical = await Reflect.apply(sourceExecute, options.source, [{
            schemaVersion: 1,
            operation: 'record.getExact',
            head: canonicalHead
          }, signalScope.signal])
          if (signalScope.isAborted()) return ABORTED_RESULT
          if (canonical.status === 'stale') {
            if (attempt === 0) continue
            return CONFLICT_RESULT
          }
          const canonicalRecord = foundRecordValue(canonical)
          if (canonicalRecord === null) {
            const terminal = sourceTerminal(canonical)
            if (terminal !== null) return terminal
            return ADAPTER_CONTRACT_RESULT
          }
          record = canonicalRecord
          const refill = await Reflect.apply(cacheExecute, options.cache, [{
            schemaVersion: 1,
            operation: 'record.put',
            record
          }, signalScope.signal])
          if (signalScope.isAborted()) return ABORTED_RESULT
          if (refill.status === 'aborted') return ABORTED_RESULT
        }
        if (signalScope.isAborted()) return ABORTED_RESULT
        const confirmed = await Reflect.apply(sourceExecute, options.source, [{
          schemaVersion: 1,
          operation: 'head.get',
          namespaceRef: request.namespaceRef,
          memoryId: request.memoryId
        }, signalScope.signal])
        if (signalScope.isAborted()) return ABORTED_RESULT
        const confirmedHead = foundHeadValue(confirmed)
        if (confirmedHead !== null && sameHead(canonicalHead, confirmedHead)) {
          if (record === null) return ADAPTER_CONTRACT_RESULT
          let completedAt: string
          try {
            completedAt = canonicalInstant(Reflect.apply(now, undefined, []))
          } catch {
            return invalidMemoryValue()
          }
          if (!memoryAccessCapabilityAllowsV1(
            request.capability,
            request.namespaceRef,
            completedAt
          )) return DENIED_RESULT
          if (signalScope.isAborted()) return ABORTED_RESULT
          return Object.freeze({ status: 'found' as const, source, record })
        }
        if (confirmed.status === 'corrupt' || confirmed.status === 'unavailable' ||
          confirmed.status === 'aborted') return confirmed
        if (attempt === 0) continue
        return CONFLICT_RESULT
      }
      return CONFLICT_RESULT
    } finally {
      signalScope.close()
    }
  }
  return Object.freeze({ execute })
}
