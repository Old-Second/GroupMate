import { performance } from 'node:perf_hooks'
import type { ToolCall } from '../tools/tool-call.js'
import type { ToolExecutionContext, ToolPreparationContext } from '../tools/tool-context.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../tools/prepared-capability.js'
import type { ToolSnapshot } from '../tools/tool-registry.js'
import {
  parseToolResult,
  type ToolDenyCode,
  type ToolErrorCode,
  type ToolResult
} from '../tools/tool-result.js'
import type { ToolRuntime } from '../tools/tool-runtime.js'
import { boundedMonotonicDurationMs } from './run-budget.js'

const MAX_TOOL_TIMEOUT_MS = 30_000

export interface PreparedToolBatch {
  readonly schemaVersion: 1
  readonly calls: readonly PreparedToolCall[]
}

export type ToolBatchPreflightResult =
  | { readonly kind: 'ready'; readonly batch: PreparedToolBatch }
  | { readonly kind: 'approval_required'; readonly batch: PreparedToolBatch }
  | {
      readonly kind: 'failed'
      readonly code: 'tool_budget_exceeded' | 'duplicate_call_id'
    }

export interface ToolBatchPreflightContext {
  readonly snapshot: ToolSnapshot
  readonly context: ToolPreparationContext
  readonly remainingToolCalls: number
}

export interface ToolBatchExecutionContext {
  readonly snapshot: ToolSnapshot
  readonly contextFor: (
    prepared: SerializablePreparedCapability
  ) => ToolExecutionContext | Promise<ToolExecutionContext>
  readonly signal: AbortSignal
}

export interface ScheduledToolResult {
  readonly callId: string
  readonly toolName: string
  readonly result: ToolResult
  readonly attemptObservations: ToolAttemptObservationsV1
}

export type ToolAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'indeterminate'

export type ToolAttemptResultCode = ToolDenyCode | ToolErrorCode | null

export interface ToolAttemptObservationV1 {
  readonly schemaVersion: 1
  readonly ordinal: 1 | 2
  readonly outcome: ToolAttemptOutcome
  readonly durationMs: number
  readonly resultCode: ToolAttemptResultCode
}

export type ToolAttemptObservationsV1 =
  | readonly []
  | readonly [ToolAttemptObservationV1]
  | readonly [ToolAttemptObservationV1, ToolAttemptObservationV1]

export interface ToolBatchExecutionResult {
  readonly results: readonly ScheduledToolResult[]
}

export interface ToolSchedulerOptions {
  readonly runtime: ToolRuntime
  readonly maxPerRunConcurrency?: number
  readonly maxGlobalConcurrency?: number
  readonly monotonicNow?: () => number
}

interface ToolAttemptExecution {
  readonly result: ToolResult
  readonly observation: ToolAttemptObservationV1 | null
}

interface Waiter {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

class Semaphore {
  readonly #limit: number
  #active = 0
  readonly #waiters: Waiter[] = []

  constructor (limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) {
      throw new TypeError('tool concurrency limit is invalid')
    }
    this.#limit = limit
  }

  async acquire (signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    if (this.#active < this.#limit) {
      this.#active += 1
      return this.#release()
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(new DOMException('operation was aborted', 'AbortError'))
        }
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #release (): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift() as Waiter
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (waiter.signal.aborted) continue
        waiter.resolve(this.#release())
        return
      }
      this.#active -= 1
    }
  }
}

function failedResult (code: 'tool_cancelled' | 'tool_execution_failed'): ToolResult {
  return parseToolResult({
    status: 'failed', effect: 'none', errorCode: code,
    userMessage: code === 'tool_cancelled' ? '工具执行已取消。' : '工具执行失败。',
    retryable: false
  })
}

function indeterminateResult (): ToolResult {
  return parseToolResult({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  })
}

function parallelEligible (capability: SerializablePreparedCapability): boolean {
  return capability.executionClass === 'read_only' && capability.retrySafe &&
    capability.resourceKeys.length > 0
}

function conflicts (
  keys: ReadonlySet<string>,
  capability: SerializablePreparedCapability
): boolean {
  return capability.resourceKeys.some(key => keys.has(key))
}

function frozenBatch (calls: readonly PreparedToolCall[]): PreparedToolBatch {
  return Object.freeze({ schemaVersion: 1, calls: Object.freeze([...calls]) })
}

function scheduled (
  capability: SerializablePreparedCapability,
  result: ToolResult,
  attemptObservations: ToolAttemptObservationsV1
): ScheduledToolResult {
  return Object.freeze({
    callId: capability.callId,
    toolName: capability.toolName,
    result: parseToolResult(result),
    attemptObservations
  })
}

function attemptObservation (
  result: ToolResult,
  ordinal: 1 | 2,
  durationMs: number
): ToolAttemptObservationV1 {
  const projected = result.status === 'success'
    ? { outcome: 'succeeded' as const, resultCode: null }
    : result.status === 'denied'
      ? { outcome: 'denied' as const, resultCode: result.reasonCode }
      : result.status === 'failed'
        ? { outcome: 'failed' as const, resultCode: result.errorCode }
        : {
            outcome: 'indeterminate' as const,
            resultCode: 'tool_outcome_unknown' as const
          }
  return Object.freeze({
    schemaVersion: 1,
    ordinal,
    outcome: projected.outcome,
    durationMs,
    resultCode: projected.resultCode
  })
}

function frozenAttemptObservations (
  observations: readonly ToolAttemptObservationV1[]
): ToolAttemptObservationsV1 {
  if (observations.length > 2) throw new TypeError('tool attempt observations are invalid')
  return Object.freeze([...observations]) as ToolAttemptObservationsV1
}

export class ToolScheduler {
  readonly #runtime: ToolRuntime
  readonly #maxPerRunConcurrency: number
  readonly #global: Semaphore
  readonly #monotonicNow: () => number

  constructor (options: ToolSchedulerOptions) {
    this.#runtime = options.runtime
    this.#maxPerRunConcurrency = options.maxPerRunConcurrency ?? 2
    this.#global = new Semaphore(options.maxGlobalConcurrency ?? 2)
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now())
    if (!Number.isSafeInteger(this.#maxPerRunConcurrency) ||
      this.#maxPerRunConcurrency < 1 || this.#maxPerRunConcurrency > 2) {
      throw new TypeError('tool concurrency limit is invalid')
    }
  }

  async preflight (
    calls: readonly ToolCall[],
    context: ToolBatchPreflightContext
  ): Promise<ToolBatchPreflightResult> {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > context.remainingToolCalls) {
      return Object.freeze({ kind: 'failed', code: 'tool_budget_exceeded' })
    }
    const callIds = calls.map(call => call.callId)
    if (new Set(callIds).size !== callIds.length) {
      return Object.freeze({ kind: 'failed', code: 'duplicate_call_id' })
    }
    const prepared: PreparedToolCall[] = []
    for (const call of calls) {
      prepared.push(await this.#runtime.prepare(call, context.context, context.snapshot))
    }
    const batch = frozenBatch(prepared)
    return prepared.some(item => item.kind === 'approval_required')
      ? Object.freeze({ kind: 'approval_required', batch })
      : Object.freeze({ kind: 'ready', batch })
  }

  async execute (
    batch: PreparedToolBatch,
    context: ToolBatchExecutionContext
  ): Promise<ToolBatchExecutionResult> {
    if (batch.schemaVersion !== 1 || !Array.isArray(batch.calls) ||
      batch.calls.some(call => call.kind === 'approval_required')) {
      throw new TypeError('prepared tool batch is not executable')
    }
    const results: Array<ScheduledToolResult | undefined> = new Array(batch.calls.length)
    const perRun = new Semaphore(this.#maxPerRunConcurrency)
    let group: Array<{ index: number; capability: SerializablePreparedCapability }> = []
    let groupKeys = new Set<string>()

    const run = async (capability: SerializablePreparedCapability): Promise<ScheduledToolResult> => {
      const observations: ToolAttemptObservationV1[] = []
      let releaseRun: (() => void) | undefined
      let releaseGlobal: (() => void) | undefined
      try {
        releaseRun = await perRun.acquire(context.signal)
        releaseGlobal = await this.#global.acquire(context.signal)
        let attempt = await this.#attempt(capability, context, 1)
        if (attempt.observation !== null) observations.push(attempt.observation)
        if (parallelEligible(capability) && attempt.result.status === 'failed' &&
          attempt.result.retryable &&
          !context.signal.aborted) {
          attempt = await this.#attempt(capability, context, 2)
          if (attempt.observation !== null) observations.push(attempt.observation)
        }
        return scheduled(
          capability,
          attempt.result,
          frozenAttemptObservations(observations)
        )
      } catch {
        return scheduled(
          capability,
          capability.executionClass === 'read_only'
            ? failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
            : indeterminateResult(),
          frozenAttemptObservations(observations)
        )
      } finally {
        releaseGlobal?.()
        releaseRun?.()
      }
    }

    const flush = async (): Promise<void> => {
      const current = group
      group = []
      groupKeys = new Set<string>()
      const completed = await Promise.all(current.map(async item => ({
        index: item.index,
        result: await run(item.capability)
      })))
      for (const item of completed) results[item.index] = item.result
    }

    for (let index = 0; index < batch.calls.length; index += 1) {
      const item = batch.calls[index]
      if (item.kind === 'completed') {
        results[index] = Object.freeze({
          callId: item.callId,
          toolName: item.toolName,
          result: parseToolResult(item.result),
          attemptObservations: frozenAttemptObservations([])
        })
        continue
      }
      const capability = item.capability
      if (!parallelEligible(capability)) {
        await flush()
        results[index] = await run(capability)
        continue
      }
      if (conflicts(groupKeys, capability)) await flush()
      group.push({ index, capability })
      for (const key of capability.resourceKeys) groupKeys.add(key)
    }
    await flush()
    if (results.some(result => result === undefined)) {
      throw new TypeError('prepared tool batch is incomplete')
    }
    return Object.freeze({ results: Object.freeze(results as ScheduledToolResult[]) })
  }

  async #attempt (
    capability: SerializablePreparedCapability,
    context: ToolBatchExecutionContext,
    ordinal: 1 | 2
  ): Promise<ToolAttemptExecution> {
    if (context.signal.aborted) {
      return Object.freeze({ result: failedResult('tool_cancelled'), observation: null })
    }
    let fresh: ToolExecutionContext
    try {
      fresh = await context.contextFor(capability)
    } catch {
      return Object.freeze({
        result: failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed'),
        observation: null
      })
    }
    if (context.signal.aborted) {
      return Object.freeze({ result: failedResult('tool_cancelled'), observation: null })
    }
    let timeoutMs: number
    try {
      timeoutMs = context.snapshot.resolve(capability.toolName).definition.timeoutMs
    } catch {
      timeoutMs = MAX_TOOL_TIMEOUT_MS
    }
    const startedAt = this.#safeMonotonicNow()
    let result: ToolResult
    try {
      result = parseToolResult(await this.#runtime.executePrepared(
        capability, fresh, context.snapshot, context.signal
      ))
    } catch {
      result = capability.executionClass === 'read_only'
        ? failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
        : indeterminateResult()
    }
    const durationMs = boundedMonotonicDurationMs(
      startedAt,
      this.#safeMonotonicNow(),
      timeoutMs
    )
    return Object.freeze({
      result,
      observation: attemptObservation(result, ordinal, durationMs)
    })
  }

  #safeMonotonicNow (): number {
    try {
      return this.#monotonicNow()
    } catch {
      return Number.NaN
    }
  }
}
