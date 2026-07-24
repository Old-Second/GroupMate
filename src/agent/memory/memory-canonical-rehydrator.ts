import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import type { CanonicalMemoryRecordV1 } from './memory-canonical-wire.js'
import {
  type MemoryHeadSourcePortV1,
  type MemoryHeadSourceResultV1,
  type MemoryHeadV1
} from './memory-head-reader.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'

export interface MemoryCanonicalIdentityV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly memoryRevision: number
  readonly revisionHash: string
}

export interface MemoryCanonicalRehydrateRequestV1 {
  readonly capability: MemoryAccessCapabilityV1
  readonly identity: MemoryCanonicalIdentityV1
}

export type MemoryRevisionIdentityVerificationResultV1 =
  | Readonly<{ readonly status: 'current' }>
  | Readonly<{ readonly status: 'stale' }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryRevisionIdentityVerifierV1 {
  readonly verify: (
    identity: MemoryCanonicalIdentityV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export type MemoryCanonicalRehydrateResultV1 =
  | Readonly<{
      readonly status: 'found'
      readonly record: CanonicalMemoryRecordV1
      readonly revisionHash: string
    }>
  | Readonly<{ readonly status: 'stale' }>
  | Readonly<{ readonly status: 'denied' }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryCanonicalRehydratorV1 {
  readonly rehydrate: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryCanonicalRehydrateResultV1>
}

interface CreateMemoryCanonicalRehydratorOptionsV1 {
  readonly source: MemoryHeadSourcePortV1
  readonly verifier: MemoryRevisionIdentityVerifierV1
  readonly now: () => string
}

const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const STALE = Object.freeze({ status: 'stale' as const })
const DENIED = Object.freeze({ status: 'denied' as const })
const UNAVAILABLE = Object.freeze({ status: 'unavailable' as const })
const ABORTED = Object.freeze({ status: 'aborted' as const })

function positiveInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function fixedId (value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalidMemoryValue()
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

function dataFunction<T extends (...args: never[]) => unknown> (
  value: unknown,
  name: string
): T {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return invalidMemoryValue()
  }
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
        utilTypes.isProxy(descriptor.value)) return invalidMemoryValue()
      return descriptor.value as T
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return invalidMemoryValue()
}

function parseIdentity (value: unknown): MemoryCanonicalIdentityV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision', 'revisionHash'
  ])
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration),
    memoryId: fixedId(input.memoryId, MEMORY_ID),
    memoryRevision: positiveInteger(input.memoryRevision),
    revisionHash: fixedId(input.revisionHash, HASH)
  })
}

function parseRequest (value: unknown): MemoryCanonicalRehydrateRequestV1 {
  const input = inspectMemoryRecord(value, ['capability', 'identity'])
  if (input.capability === null || typeof input.capability !== 'object' ||
    utilTypes.isProxy(input.capability)) return invalidMemoryValue()
  return Object.freeze({
    capability: input.capability as MemoryAccessCapabilityV1,
    identity: parseIdentity(input.identity)
  })
}

function parseVerification (value: unknown): MemoryRevisionIdentityVerificationResultV1 {
  const input = inspectMemoryRecord(value, ['status'])
  if (input.status === 'current') return Object.freeze({ status: 'current' as const })
  if (input.status === 'stale') return STALE
  if (input.status === 'unavailable') return UNAVAILABLE
  if (input.status === 'aborted') return ABORTED
  return invalidMemoryValue()
}

function sameHead (left: MemoryHeadV1, right: MemoryHeadV1): boolean {
  return left.namespaceRef === right.namespaceRef &&
    left.namespaceGeneration === right.namespaceGeneration &&
    left.memoryId === right.memoryId && left.revision === right.revision &&
    left.contentHash === right.contentHash
}

function headFromResult (value: MemoryHeadSourceResultV1): MemoryHeadV1 | null {
  return value.status === 'found' && 'head' in value ? value.head : null
}

function recordFromResult (
  value: MemoryHeadSourceResultV1
): CanonicalMemoryRecordV1 | null {
  return value.status === 'found' && 'record' in value ? value.record : null
}

function sourceFailure (value: MemoryHeadSourceResultV1): MemoryCanonicalRehydrateResultV1 {
  if (value.status === 'aborted') return ABORTED
  if (value.status === 'corrupt' || value.status === 'unavailable') return UNAVAILABLE
  return STALE
}

function verificationFailure (
  value: MemoryRevisionIdentityVerificationResultV1
): MemoryCanonicalRehydrateResultV1 | null {
  if (value.status === 'current') return null
  if (value.status === 'aborted') return ABORTED
  if (value.status === 'unavailable') return UNAVAILABLE
  return STALE
}

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

export function createMemoryCanonicalRehydratorV1 (
  optionsValue: CreateMemoryCanonicalRehydratorOptionsV1
): MemoryCanonicalRehydratorV1 {
  const options = inspectMemoryRecord(optionsValue, ['source', 'verifier', 'now'])
  if (typeof options.now !== 'function' || utilTypes.isProxy(options.now)) {
    return invalidMemoryValue()
  }
  const now = options.now as () => string
  const sourceExecute = dataFunction<MemoryHeadSourcePortV1['execute']>(options.source, 'execute')
  const verify = dataFunction<MemoryRevisionIdentityVerifierV1['verify']>(
    options.verifier,
    'verify'
  )

  const rehydrate = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryCanonicalRehydrateResultV1> => {
    if (isAborted(signal)) return ABORTED
    const request = parseRequest(requestValue)
    let readAt: string
    try {
      readAt = canonicalInstant(Reflect.apply(now, undefined, []))
    } catch {
      return UNAVAILABLE
    }
    if (!memoryAccessCapabilityAllowsV1(
      request.capability,
      request.identity.namespaceRef,
      readAt
    )) return DENIED

    let verified: MemoryRevisionIdentityVerificationResultV1
    try {
      verified = parseVerification(await Reflect.apply(
        verify,
        options.verifier,
        [request.identity, signal]
      ))
    } catch {
      return isAborted(signal) ? ABORTED : UNAVAILABLE
    }
    const firstFailure = verificationFailure(verified)
    if (firstFailure !== null) return firstFailure

    const headResult = await Reflect.apply(sourceExecute, options.source, [{
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: request.identity.namespaceRef,
      memoryId: request.identity.memoryId
    }, signal])
    const head = headFromResult(headResult)
    if (head === null) return sourceFailure(headResult)
    if (head.namespaceGeneration !== request.identity.namespaceGeneration ||
      head.revision !== request.identity.memoryRevision) return STALE

    const recordResult = await Reflect.apply(sourceExecute, options.source, [{
      schemaVersion: 1,
      operation: 'record.getExact',
      head
    }, signal])
    const record = recordFromResult(recordResult)
    if (record === null) return sourceFailure(recordResult)
    if (record.namespaceRef !== request.identity.namespaceRef ||
      record.namespaceGeneration !== request.identity.namespaceGeneration ||
      record.memoryId !== request.identity.memoryId ||
      record.revision !== request.identity.memoryRevision) return UNAVAILABLE

    try {
      verified = parseVerification(await Reflect.apply(
        verify,
        options.verifier,
        [request.identity, signal]
      ))
    } catch {
      return isAborted(signal) ? ABORTED : UNAVAILABLE
    }
    const secondFailure = verificationFailure(verified)
    if (secondFailure !== null) return secondFailure

    const confirmedResult = await Reflect.apply(sourceExecute, options.source, [{
      schemaVersion: 1,
      operation: 'head.get',
      namespaceRef: request.identity.namespaceRef,
      memoryId: request.identity.memoryId
    }, signal])
    const confirmed = headFromResult(confirmedResult)
    if (confirmed === null) return sourceFailure(confirmedResult)
    if (!sameHead(head, confirmed)) return STALE
    if (isAborted(signal)) return ABORTED
    let completedAt: string
    try {
      completedAt = canonicalInstant(Reflect.apply(now, undefined, []))
    } catch {
      return UNAVAILABLE
    }
    if (!memoryAccessCapabilityAllowsV1(
      request.capability,
      request.identity.namespaceRef,
      completedAt
    )) return DENIED
    return Object.freeze({
      status: 'found' as const,
      record,
      revisionHash: request.identity.revisionHash
    })
  }
  return Object.freeze({ rehydrate })
}
