import { types as utilTypes } from 'node:util'
import type { MemoryOutboxEventV1, MemoryRecordV1 } from './memory-domain.js'
import {
  type MemoryHeadSourcePortV1,
  type MemoryHeadSourceResultV1,
  type MemoryHeadV1
} from './memory-head-reader.js'
import type {
  MemoryHotCachePortV1,
  MemoryHotCacheResultV1
} from './memory-hot-cache.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'
import type {
  MemoryOutboxPortV1,
  MemoryOutboxResultV1
} from './memory-outbox.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js'

export const MEMORY_HOT_PROJECTOR_RETRY_BACKOFF_MS_V1 = 5_000
export const MEMORY_HOT_PROJECTOR_RETRY_REASON_V1 = 'memory_projection_retry'
export const MEMORY_HOT_PROJECTOR_ABORT_REASON_V1 = 'projector_aborted'

export type MemoryHotProjectionBatchResultV1 =
  | { readonly status: 'busy' | 'empty' | 'aborted' }
  | {
      readonly status: 'completed'
      readonly claimed: number
      readonly acked: number
      readonly retried: 0
    }
  | {
      readonly status: 'retained'
      readonly claimed: number
      readonly acked: number
      readonly retried: 1
    }
  | {
      readonly status: 'incomplete'
      readonly claimed: number
      readonly acked: number
      readonly retried: 0
      readonly reason: 'claim_failed' | 'ack_failed' | 'retry_failed'
    }

export interface MemoryHotProjectorV1 {
  readonly projectBatch: (signal?: AbortSignal) => Promise<MemoryHotProjectionBatchResultV1>
}

interface CreateMemoryHotProjectorOptionsV1 {
  readonly ownerId: string
  readonly now: () => string
  readonly outbox: MemoryOutboxPortV1
  readonly source: MemoryHeadSourcePortV1
  readonly cache: MemoryHotCachePortV1
}

type ProjectionOutcomeV1 =
  | { readonly status: 'ack' }
  | { readonly status: 'retry' }
  | { readonly status: 'aborted' }

type HeadStateV1 =
  | { readonly status: 'found'; readonly head: MemoryHeadV1 }
  | { readonly status: 'expired'; readonly head: MemoryHeadV1 }
  | { readonly status: 'absent'; readonly namespaceGeneration: number }

type HeadTransitionV1 =
  | { readonly status: 'stable' }
  | { readonly status: 'replan'; readonly state: HeadStateV1 }
  | { readonly status: 'retry' }
  | { readonly status: 'aborted' }

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ACK_OUTCOME = Object.freeze({ status: 'ack' as const })
const RETRY_OUTCOME = Object.freeze({ status: 'retry' as const })
const ABORTED_OUTCOME = Object.freeze({ status: 'aborted' as const })
const BUSY_RESULT = Object.freeze({ status: 'busy' as const })
const EMPTY_RESULT = Object.freeze({ status: 'empty' as const })
const ABORTED_RESULT = Object.freeze({ status: 'aborted' as const })

let memoryHotProjectionBatchActive = false

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function ownerId (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !OWNER_ID_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function portExecute<T> (value: unknown): T {
  const input = inspectMemoryRecord(value, ['execute'])
  if (typeof input.execute !== 'function' || utilTypes.isProxy(input.execute)) {
    return invalidMemoryValue()
  }
  return input.execute as T
}

function sameHead (left: MemoryHeadV1, right: MemoryHeadV1): boolean {
  return left.namespaceRef === right.namespaceRef &&
    left.namespaceGeneration === right.namespaceGeneration &&
    left.memoryId === right.memoryId &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash
}

function isHeadState (result: MemoryHeadSourceResultV1): result is HeadStateV1 {
  if (result.status === 'absent') return true
  return (result.status === 'found' || result.status === 'expired') && 'head' in result
}

function sameCanonicalState (left: HeadStateV1, right: HeadStateV1): boolean {
  if (left.status === 'absent' || right.status === 'absent') {
    return left.status === 'absent' && right.status === 'absent' &&
      left.namespaceGeneration === right.namespaceGeneration
  }
  return left.status === right.status && sameHead(left.head, right.head)
}

function foundRecord (result: MemoryHeadSourceResultV1): MemoryRecordV1 | null {
  return result.status === 'found' && 'record' in result ? result.record : null
}

function foundNamespaceGeneration (result: MemoryHeadSourceResultV1): number | null {
  return result.status === 'found' && 'namespaceGeneration' in result
    ? result.namespaceGeneration
    : null
}

function putIsStableCandidate (result: MemoryHotCacheResultV1): boolean {
  return result.status === 'stored' || result.status === 'unchanged' ||
    (result.status === 'skipped' && result.reason !== 'stale')
}

function invalidateIsIdempotent (result: MemoryHotCacheResultV1): boolean {
  return result.status === 'invalidated' || result.status === 'unchanged'
}

function completedResult (
  claimed: number,
  acked: number
): MemoryHotProjectionBatchResultV1 {
  return Object.freeze({ status: 'completed' as const, claimed, acked, retried: 0 as const })
}

function retainedResult (
  claimed: number,
  acked: number
): MemoryHotProjectionBatchResultV1 {
  return Object.freeze({ status: 'retained' as const, claimed, acked, retried: 1 as const })
}

function incompleteResult (
  claimed: number,
  acked: number,
  reason: Extract<MemoryHotProjectionBatchResultV1, { readonly status: 'incomplete' }>['reason']
): MemoryHotProjectionBatchResultV1 {
  return Object.freeze({
    status: 'incomplete' as const,
    claimed,
    acked,
    retried: 0 as const,
    reason
  })
}

export function createMemoryHotProjectorV1 (
  optionsValue: CreateMemoryHotProjectorOptionsV1
): MemoryHotProjectorV1 {
  const input = inspectMemoryRecord(optionsValue, [
    'ownerId', 'now', 'outbox', 'source', 'cache'
  ])
  if (typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
    return invalidMemoryValue()
  }
  const options = Object.freeze({
    ownerId: ownerId(input.ownerId),
    now: input.now as () => string,
    outbox: input.outbox as MemoryOutboxPortV1,
    source: input.source as MemoryHeadSourcePortV1,
    cache: input.cache as MemoryHotCachePortV1,
    outboxExecute: portExecute<MemoryOutboxPortV1['execute']>(input.outbox),
    sourceExecute: portExecute<MemoryHeadSourcePortV1['execute']>(input.source),
    cacheExecute: portExecute<MemoryHotCachePortV1['execute']>(input.cache)
  })

  const source = async (
    request: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<MemoryHeadSourceResultV1> => await Reflect.apply(
    options.sourceExecute,
    options.source,
    [request, signal]
  )

  const cache = async (
    request: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<MemoryHotCacheResultV1> => await Reflect.apply(
    options.cacheExecute,
    options.cache,
    [request, signal]
  )

  const readHead = async (
    event: MemoryOutboxEventV1,
    signal?: AbortSignal
  ): Promise<MemoryHeadSourceResultV1> => await source({
    schemaVersion: 1,
    operation: 'head.get',
    namespaceRef: event.namespaceRef,
    memoryId: event.aggregateId
  }, signal)

  const invalidateEventRecord = async (
    event: MemoryOutboxEventV1,
    signal?: AbortSignal
  ): Promise<ProjectionOutcomeV1> => {
    const result = await cache({
      schemaVersion: 1,
      operation: 'record.invalidate',
      namespaceRef: event.namespaceRef,
      namespaceGeneration: event.namespaceGeneration,
      memoryId: event.aggregateId,
      deletedRevision: event.revision
    }, signal)
    if (result.status === 'aborted') return ABORTED_OUTCOME
    return invalidateIsIdempotent(result) ? ACK_OUTCOME : RETRY_OUTCOME
  }

  const reconcileRecord = async (
    event: MemoryOutboxEventV1,
    signal?: AbortSignal
  ): Promise<ProjectionOutcomeV1> => {
    let plannedState: HeadStateV1 | null = null
    let headChanges = 0
    let staleCleanupUsed = false

    const transitionAfter = (
      previous: HeadStateV1,
      result: MemoryHeadSourceResultV1
    ): HeadTransitionV1 => {
      if (result.status === 'aborted') return ABORTED_OUTCOME
      if (!isHeadState(result)) return RETRY_OUTCOME
      if (sameCanonicalState(previous, result)) {
        return Object.freeze({ status: 'stable' as const })
      }
      if (headChanges >= 1) return RETRY_OUTCOME
      headChanges += 1
      return Object.freeze({ status: 'replan' as const, state: result })
    }

    const applyTransition = (
      transition: HeadTransitionV1
    ): ProjectionOutcomeV1 | null => {
      if (transition.status === 'stable') return ACK_OUTCOME
      if (transition.status === 'retry') return RETRY_OUTCOME
      if (transition.status === 'aborted') return ABORTED_OUTCOME
      plannedState = transition.state
      return null
    }

    const cleanupStaleDerived = async (
      previous: HeadStateV1
    ): Promise<ProjectionOutcomeV1 | null> => {
      if (staleCleanupUsed) return RETRY_OUTCOME
      staleCleanupUsed = true
      const invalidated = await invalidateEventRecord(event, signal)
      if (invalidated.status !== 'ack') return invalidated
      const afterInvalidate = await readHead(event, signal)
      const transition = transitionAfter(previous, afterInvalidate)
      if (transition.status === 'stable') {
        plannedState = previous
        return null
      }
      return applyTransition(transition)
    }

    while (true) {
      const currentResult = plannedState ?? await readHead(event, signal)
      plannedState = null
      if (currentResult.status === 'aborted') return ABORTED_OUTCOME
      if (!isHeadState(currentResult)) return RETRY_OUTCOME
      const current = currentResult

      if (current.status === 'absent') {
        if (current.namespaceGeneration < event.namespaceGeneration) return RETRY_OUTCOME
        const invalidated = await invalidateEventRecord(event, signal)
        if (invalidated.status !== 'ack') return invalidated
        const afterInvalidate = await readHead(event, signal)
        if (afterInvalidate.status === 'aborted') return ABORTED_OUTCOME
        if (afterInvalidate.status === 'absent' &&
          afterInvalidate.namespaceGeneration >= event.namespaceGeneration) return ACK_OUTCOME
        const transition = transitionAfter(current, afterInvalidate)
        const outcome = applyTransition(transition)
        if (outcome !== null) return outcome
        continue
      }

      const cached = await cache({
        schemaVersion: 1,
        operation: 'record.get',
        head: current.head
      }, signal)
      if (cached.status === 'aborted') return ABORTED_OUTCOME
      if (cached.status === 'unavailable') return RETRY_OUTCOME

      if (current.status === 'expired') {
        if (cached.status === 'hit' ||
          (cached.status === 'miss' && cached.reason === 'stale')) {
          const cleanup = await cleanupStaleDerived(current)
          if (cleanup !== null) return cleanup
          continue
        }
        if (cached.status !== 'miss') return RETRY_OUTCOME
        const transition = transitionAfter(current, await readHead(event, signal))
        const outcome = applyTransition(transition)
        if (outcome !== null) return outcome
        continue
      }

      if (cached.status === 'hit') {
        const transition = transitionAfter(current, await readHead(event, signal))
        const outcome = applyTransition(transition)
        if (outcome !== null) return outcome
        continue
      }
      if (cached.status !== 'miss') return RETRY_OUTCOME
      if (cached.reason === 'stale') {
        const cleanup = await cleanupStaleDerived(current)
        if (cleanup !== null) return cleanup
        continue
      }

      const loaded = await source({
        schemaVersion: 1,
        operation: 'record.getExact',
        head: current.head
      }, signal)
      if (loaded.status === 'aborted') return ABORTED_OUTCOME
      const record = foundRecord(loaded)
      if (record === null) {
        const transition = transitionAfter(current, await readHead(event, signal))
        if (transition.status === 'stable') return RETRY_OUTCOME
        const outcome = applyTransition(transition)
        if (outcome !== null) return outcome
        continue
      }

      const beforePut = transitionAfter(current, await readHead(event, signal))
      if (beforePut.status !== 'stable') {
        const outcome = applyTransition(beforePut)
        if (outcome !== null) return outcome
        continue
      }
      const put = await cache({
        schemaVersion: 1,
        operation: 'record.put',
        record
      }, signal)
      if (put.status === 'aborted') return ABORTED_OUTCOME
      if (put.status === 'skipped' && put.reason === 'stale') {
        const cleanup = await cleanupStaleDerived(current)
        if (cleanup !== null) return cleanup
        continue
      }
      if (!putIsStableCandidate(put)) return RETRY_OUTCOME
      const afterPut = transitionAfter(current, await readHead(event, signal))
      const outcome = applyTransition(afterPut)
      if (outcome !== null) return outcome
    }
  }

  const projectNamespaceDeletion = async (
    event: MemoryOutboxEventV1,
    signal?: AbortSignal
  ): Promise<ProjectionOutcomeV1> => {
    if (event.namespaceGeneration <= 1) return RETRY_OUTCOME
    const canonical = await source({
      schemaVersion: 1,
      operation: 'namespace.get',
      namespaceRef: event.namespaceRef
    }, signal)
    if (canonical.status === 'aborted') return ABORTED_OUTCOME
    const canonicalGeneration = foundNamespaceGeneration(canonical)
    if (canonicalGeneration === null || canonicalGeneration < event.namespaceGeneration) {
      return RETRY_OUTCOME
    }
    const invalidated = await cache({
      schemaVersion: 1,
      operation: 'namespace.invalidate',
      namespaceRef: event.namespaceRef,
      deletedGeneration: event.namespaceGeneration - 1,
      nextGeneration: event.namespaceGeneration
    }, signal)
    if (invalidated.status === 'aborted') return ABORTED_OUTCOME
    if (invalidateIsIdempotent(invalidated)) return ACK_OUTCOME
    if (invalidated.status !== 'skipped' || invalidated.reason !== 'capacity') {
      return RETRY_OUTCOME
    }
    const usage = await cache({ schemaVersion: 1, operation: 'usage.get' }, signal)
    if (usage.status === 'aborted') return ABORTED_OUTCOME
    return usage.status === 'usage' &&
      usage.value.generationCount === MEMORY_RESOURCE_LIMITS.deploymentNamespaces
      ? ACK_OUTCOME
      : RETRY_OUTCOME
  }

  const projectEvent = async (
    event: MemoryOutboxEventV1,
    signal?: AbortSignal
  ): Promise<ProjectionOutcomeV1> => {
    if (event.eventKind === 'proposal_changed') return ACK_OUTCOME
    if (event.eventKind === 'namespace_deleted') {
      return await projectNamespaceDeletion(event, signal)
    }
    return await reconcileRecord(event, signal)
  }

  const retryEvent = async (
    claim: Extract<MemoryOutboxResultV1, { readonly status: 'claimed' }>,
    event: MemoryOutboxEventV1,
    reasonCode: string,
    signal?: AbortSignal
  ): Promise<MemoryOutboxResultV1 | null> => {
    let now: string
    try {
      now = canonicalInstant(Reflect.apply(options.now, undefined, []))
    } catch {
      return null
    }
    const retryAtMs = Date.parse(now) + MEMORY_HOT_PROJECTOR_RETRY_BACKOFF_MS_V1
    if (!Number.isSafeInteger(retryAtMs)) return null
    try {
      return await Reflect.apply(options.outboxExecute, options.outbox, [{
        schemaVersion: 1,
        operation: 'retry',
        ownerId: claim.ownerId,
        leaseToken: claim.leaseToken,
        eventId: event.eventId,
        sequence: event.sequence,
        retryAt: new Date(retryAtMs).toISOString(),
        reasonCode
      }, signal])
    } catch {
      return null
    }
  }

  const projectBatch = async (
    signal?: AbortSignal
  ): Promise<MemoryHotProjectionBatchResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    let acquired = false
    try {
      if (memoryHotProjectionBatchActive) return BUSY_RESULT
      if (signalScope.isAborted()) return ABORTED_RESULT
      memoryHotProjectionBatchActive = true
      acquired = true

      const claim = await Reflect.apply(options.outboxExecute, options.outbox, [{
        schemaVersion: 1,
        operation: 'claim',
        ownerId: options.ownerId,
        limit: MEMORY_RESOURCE_LIMITS.operationBatchRecords
      }, signalScope.signal])
      if (claim.status === 'aborted' || signalScope.isAborted()) return ABORTED_RESULT
      if (claim.status === 'empty') return EMPTY_RESULT
      if (claim.status !== 'claimed') return incompleteResult(0, 0, 'claim_failed')

      let acked = 0
      for (const event of claim.events) {
        if (signalScope.isAborted()) return ABORTED_RESULT
        const outcome = await projectEvent(event, signalScope.signal)
        if (outcome.status === 'aborted' || signalScope.isAborted()) {
          await retryEvent(claim, event, MEMORY_HOT_PROJECTOR_ABORT_REASON_V1)
          return ABORTED_RESULT
        }
        if (outcome.status === 'retry') {
          const retried = await retryEvent(
            claim,
            event,
            MEMORY_HOT_PROJECTOR_RETRY_REASON_V1,
            signalScope.signal
          )
          if (signalScope.isAborted()) {
            if (retried?.status !== 'retried') {
              await retryEvent(claim, event, MEMORY_HOT_PROJECTOR_ABORT_REASON_V1)
            }
            return ABORTED_RESULT
          }
          return retried?.status === 'retried'
            ? retainedResult(claim.events.length, acked)
            : incompleteResult(claim.events.length, acked, 'retry_failed')
        }
        if (signalScope.isAborted()) {
          await retryEvent(claim, event, MEMORY_HOT_PROJECTOR_ABORT_REASON_V1)
          return ABORTED_RESULT
        }
        const ack = await Reflect.apply(options.outboxExecute, options.outbox, [{
          schemaVersion: 1,
          operation: 'ack',
          ownerId: claim.ownerId,
          leaseToken: claim.leaseToken,
          eventId: event.eventId,
          sequence: event.sequence
        }, signalScope.signal])
        if (signalScope.isAborted()) {
          if (ack.status !== 'acked') {
            await retryEvent(claim, event, MEMORY_HOT_PROJECTOR_ABORT_REASON_V1)
          }
          return ABORTED_RESULT
        }
        if (ack.status !== 'acked') {
          return incompleteResult(claim.events.length, acked, 'ack_failed')
        }
        acked += 1
      }
      return completedResult(claim.events.length, acked)
    } finally {
      if (acquired) memoryHotProjectionBatchActive = false
      signalScope.close()
    }
  }

  return Object.freeze({ projectBatch })
}
