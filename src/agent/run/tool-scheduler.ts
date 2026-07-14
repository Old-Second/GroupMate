import type { ToolCall } from '../tools/tool-call.js'
import type { ToolExecutionContext, ToolPreparationContext } from '../tools/tool-context.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from '../tools/prepared-capability.js'
import type { ToolSnapshot } from '../tools/tool-registry.js'
import { parseToolResult, type ToolResult } from '../tools/tool-result.js'
import type { ToolRuntime } from '../tools/tool-runtime.js'

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
}

export interface ToolBatchExecutionResult {
  readonly results: readonly ScheduledToolResult[]
}

export interface ToolSchedulerOptions {
  readonly runtime: ToolRuntime
  readonly maxPerRunConcurrency?: number
  readonly maxGlobalConcurrency?: number
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
  result: ToolResult
): ScheduledToolResult {
  return Object.freeze({
    callId: capability.callId,
    toolName: capability.toolName,
    result: parseToolResult(result)
  })
}

export class ToolScheduler {
  readonly #runtime: ToolRuntime
  readonly #maxPerRunConcurrency: number
  readonly #global: Semaphore

  constructor (options: ToolSchedulerOptions) {
    this.#runtime = options.runtime
    this.#maxPerRunConcurrency = options.maxPerRunConcurrency ?? 2
    this.#global = new Semaphore(options.maxGlobalConcurrency ?? 2)
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
      const releaseRun = await perRun.acquire(context.signal)
      let releaseGlobal: (() => void) | undefined
      try {
        releaseGlobal = await this.#global.acquire(context.signal)
        let result = await this.#attempt(capability, context)
        if (parallelEligible(capability) && result.status === 'failed' && result.retryable &&
          !context.signal.aborted) {
          result = await this.#attempt(capability, context)
        }
        return scheduled(capability, result)
      } catch {
        return scheduled(
          capability,
          capability.executionClass === 'read_only'
            ? failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
            : indeterminateResult()
        )
      } finally {
        releaseGlobal?.()
        releaseRun()
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
          callId: item.callId, toolName: item.toolName, result: parseToolResult(item.result)
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
    context: ToolBatchExecutionContext
  ): Promise<ToolResult> {
    if (context.signal.aborted) return failedResult('tool_cancelled')
    let fresh: ToolExecutionContext
    try {
      fresh = await context.contextFor(capability)
    } catch {
      return failedResult(context.signal.aborted ? 'tool_cancelled' : 'tool_execution_failed')
    }
    if (context.signal.aborted) return failedResult('tool_cancelled')
    return await this.#runtime.executePrepared(
      capability, fresh, context.snapshot, context.signal
    )
  }
}
