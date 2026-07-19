import {
  encodeMemoryOutboxEventV1
} from './memory-codec.js'
import {
  parseMemoryOutboxEventV1,
  type MemoryOutboxEventV1
} from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

export type MemoryOutboxRequestV1 =
  | {
      readonly schemaVersion: 1
      readonly operation: 'claim'
      readonly ownerId: string
      readonly limit: number
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'ack'
      readonly ownerId: string
      readonly leaseToken: string
      readonly eventId: string
      readonly sequence: number
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'retry'
      readonly ownerId: string
      readonly leaseToken: string
      readonly eventId: string
      readonly sequence: number
      readonly retryAt: string
      readonly reasonCode: string
    }
  | {
      readonly schemaVersion: 1
      readonly operation: 'usage'
    }

export interface MemoryOutboxUsageV1 {
  readonly schemaVersion: 1
  readonly pendingRecords: number
  readonly leasedRecords: number
  readonly logicalBytes: number
}

export type MemoryOutboxResultV1 =
  | { readonly status: 'empty' }
  | {
      readonly status: 'claimed'
      readonly ownerId: string
      readonly leaseToken: string
      readonly leasedUntil: string
      readonly events: readonly MemoryOutboxEventV1[]
    }
  | { readonly status: 'acked' }
  | { readonly status: 'retried' }
  | { readonly status: 'lease_conflict' }
  | { readonly status: 'usage'; readonly value: MemoryOutboxUsageV1 }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'aborted' }

export interface MemoryOutboxPortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryOutboxResultV1>
}

interface MemoryOutboxPortOptionsV1 {
  readonly now: () => string
  readonly execute: (
    request: MemoryOutboxRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

const OUTBOX_OPERATIONS = ['claim', 'ack', 'retry', 'usage'] as const
type MemoryOutboxOperationV1 = typeof OUTBOX_OPERATIONS[number]

const OUTBOX_REQUEST_FIELDS = [
  'ownerId', 'limit', 'leaseToken', 'eventId', 'sequence', 'retryAt', 'reasonCode'
] as const

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const LEASE_PATTERN = /^memory-lease:v1:[0-9a-f]{64}$/

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

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function workerId (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !WORKER_ID_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function leaseToken (value: unknown): string {
  if (typeof value !== 'string' || !LEASE_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function eventId (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !value.startsWith('event:') || value.length === 'event:'.length) return invalidMemoryValue()
  return value
}

function reasonCode (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !WORKER_ID_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function parseMemoryOutboxRequestV1 (
  value: unknown,
  now: string
): MemoryOutboxRequestV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation'],
    OUTBOX_REQUEST_FIELDS
  )
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(
    discriminator.operation,
    OUTBOX_OPERATIONS
  ) as MemoryOutboxOperationV1

  if (operation === 'claim') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'operation', 'ownerId', 'limit'])
    return Object.freeze({
      schemaVersion: 1 as const,
      operation,
      ownerId: workerId(input.ownerId),
      limit: positiveInteger(input.limit, MEMORY_RESOURCE_LIMITS.operationBatchRecords)
    })
  }
  if (operation === 'ack') {
    const input = inspectMemoryRecord(value, [
      'schemaVersion', 'operation', 'ownerId', 'leaseToken', 'eventId', 'sequence'
    ])
    return Object.freeze({
      schemaVersion: 1 as const,
      operation,
      ownerId: workerId(input.ownerId),
      leaseToken: leaseToken(input.leaseToken),
      eventId: eventId(input.eventId),
      sequence: positiveInteger(input.sequence)
    })
  }
  if (operation === 'retry') {
    const input = inspectMemoryRecord(value, [
      'schemaVersion', 'operation', 'ownerId', 'leaseToken', 'eventId', 'sequence',
      'retryAt', 'reasonCode'
    ])
    const retryAt = canonicalInstant(input.retryAt)
    if (Date.parse(retryAt) < Date.parse(now)) return invalidMemoryValue()
    return Object.freeze({
      schemaVersion: 1 as const,
      operation,
      ownerId: workerId(input.ownerId),
      leaseToken: leaseToken(input.leaseToken),
      eventId: eventId(input.eventId),
      sequence: positiveInteger(input.sequence),
      retryAt,
      reasonCode: reasonCode(input.reasonCode)
    })
  }
  inspectMemoryRecord(value, ['schemaVersion', 'operation'])
  return Object.freeze({ schemaVersion: 1 as const, operation: 'usage' as const })
}

function parseOutboxUsage (value: unknown): MemoryOutboxUsageV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'pendingRecords', 'leasedRecords', 'logicalBytes'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    pendingRecords: nonnegativeInteger(input.pendingRecords),
    leasedRecords: nonnegativeInteger(input.leasedRecords),
    logicalBytes: nonnegativeInteger(input.logicalBytes)
  })
}

function parseClaimedResult (
  value: unknown,
  request: Extract<MemoryOutboxRequestV1, { readonly operation: 'claim' }>,
  now: string
): MemoryOutboxResultV1 {
  const input = inspectMemoryRecord(value, [
    'status', 'ownerId', 'leaseToken', 'leasedUntil', 'events'
  ])
  if (input.status !== 'claimed' || workerId(input.ownerId) !== request.ownerId) {
    return invalidMemoryValue()
  }
  const leasedUntil = canonicalInstant(input.leasedUntil)
  if (Date.parse(leasedUntil) <= Date.parse(now)) return invalidMemoryValue()
  const events = inspectMemoryArray(
    input.events,
    MEMORY_RESOURCE_LIMITS.operationBatchRecords
  ).map(value => {
    const event = parseMemoryOutboxEventV1(value)
    encodeMemoryOutboxEventV1(event)
    return event
  })
  if (events.length === 0 || events.length > request.limit ||
    new Set(events.map(event => event.eventId)).size !== events.length ||
    new Set(events.map(event => event.sequence)).size !== events.length ||
    events.some((event, index) => index > 0 && event.sequence <= events[index - 1]!.sequence)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    status: 'claimed' as const,
    ownerId: request.ownerId,
    leaseToken: leaseToken(input.leaseToken),
    leasedUntil,
    events: Object.freeze(events)
  })
}

function parseMemoryOutboxResultV1 (
  value: unknown,
  request: MemoryOutboxRequestV1,
  now: string,
  signalAborted: boolean
): MemoryOutboxResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], [
    'ownerId', 'leaseToken', 'leasedUntil', 'events', 'value', 'category', 'retryable'
  ])
  const status = discriminator.status

  if (status === 'empty') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'claim') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'claimed') {
    if (request.operation !== 'claim') return invalidMemoryValue()
    return parseClaimedResult(value, request, now)
  }
  if (status === 'acked') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'ack') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'retried') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'retry') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'lease_conflict') {
    inspectMemoryRecord(value, ['status'])
    if (request.operation !== 'ack' && request.operation !== 'retry') return invalidMemoryValue()
    return Object.freeze({ status })
  }
  if (status === 'usage') {
    const input = inspectMemoryRecord(value, ['status', 'value'])
    if (request.operation !== 'usage') return invalidMemoryValue()
    return Object.freeze({ status, value: parseOutboxUsage(input.value) })
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
  if (status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    if (!signalAborted) return invalidMemoryValue()
    return Object.freeze({ status })
  }
  return invalidMemoryValue()
}

function outboxResultNeedsCompletionTime (value: unknown): boolean {
  const input = inspectMemoryRecord(value, ['status'], [
    'ownerId', 'leaseToken', 'leasedUntil', 'events', 'value', 'category', 'retryable'
  ])
  return input.status === 'claimed'
}

const ADAPTER_CONTRACT_RESULT: MemoryOutboxResultV1 = Object.freeze({
  status: 'corrupt' as const,
  category: 'adapter_contract' as const
})

const ADAPTER_IO_RESULT: MemoryOutboxResultV1 = Object.freeze({
  status: 'unavailable' as const,
  category: 'io' as const,
  retryable: true
})

const ABORTED_RESULT: MemoryOutboxResultV1 = Object.freeze({ status: 'aborted' as const })

export function createMemoryOutboxPortV1 (
  optionsValue: MemoryOutboxPortOptionsV1
): MemoryOutboxPortV1 {
  const options = inspectMemoryRecord(optionsValue, ['now', 'execute'])
  if (typeof options.now !== 'function' || typeof options.execute !== 'function') {
    return invalidMemoryValue()
  }
  const now = options.now as () => string
  const adapterExecute = options.execute as MemoryOutboxPortOptionsV1['execute']

  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryOutboxResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      let currentTime: string
      try {
        currentTime = canonicalInstant(Reflect.apply(now, undefined, []))
      } catch {
        return invalidMemoryValue()
      }
      const request = parseMemoryOutboxRequestV1(requestValue, currentTime)
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
      let needsCompletionTime: boolean
      try {
        needsCompletionTime = outboxResultNeedsCompletionTime(adapterResult)
      } catch {
        return ADAPTER_CONTRACT_RESULT
      }
      let completedAt = currentTime
      if (needsCompletionTime) {
        try {
          completedAt = canonicalInstant(Reflect.apply(now, undefined, []))
        } catch {
          return invalidMemoryValue()
        }
      }
      try {
        return parseMemoryOutboxResultV1(
          adapterResult,
          request,
          completedAt,
          signalScope.isAborted()
        )
      } catch {
        return ADAPTER_CONTRACT_RESULT
      }
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ execute })
}
