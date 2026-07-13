import type { ToolAuditEvent, ToolAuditEventType, ToolAuditSink } from './audit.js'
import type { ApprovalRecord, ApprovalStore } from './approval-store.js'
import type { ToolCall } from './tool-call.js'
import type { ToolRuntimeFacts, ToolTarget } from './tool-context.js'
import type { ToolDefinition } from './tool-definition.js'
import type {
  IdempotencyRecord,
  IdempotencyStore,
  StoredToolOutcome
} from './idempotency-store.js'
import type { PendingCallStore, PendingToolCall } from './pending-call-store.js'
import { ToolPolicyEngine, type ToolPolicyProfile } from './policy-engine.js'
import type { ToolSnapshot } from './tool-registry.js'
import { ToolUnavailableError } from './tool-registry.js'
import { ToolInputError, validateToolInputRecord } from './schema-validator.js'
import type { ToolObjectSchema } from './tool-schema.js'
import {
  parseToolResult,
  shouldFinalizeToolResult,
  type ToolErrorCode,
  type ToolResult
} from './tool-result.js'
import type { IntentEvidence } from '../../runtime/tools/intent-evidence.js'

const idempotencyTtlSeconds = 300

interface ToolAuditFields {
  readonly reasonCode?: string
  readonly errorCode?: string
  readonly outputBytes?: number
  readonly startedAt?: number
}

export interface ToolExecutionRequest {
  readonly snapshot: ToolSnapshot
  readonly call: ToolCall
  readonly profile: ToolPolicyProfile
  readonly initialFacts: ToolRuntimeFacts
  readonly intent: IntentEvidence
  readonly refreshFacts: (target: ToolTarget, signal: AbortSignal) => Promise<ToolRuntimeFacts>
  readonly approvalGrant?: {
    readonly tokenHash: string
    readonly callId: string
    readonly argumentHash: string
  }
  readonly signal?: AbortSignal
}

export type ToolExecutionOutcome =
  | {
      readonly kind: 'completed'
      readonly toolName: string
      readonly result: ToolResult
      readonly finalize: boolean
    }
  | {
      readonly kind: 'approval_required'
      readonly toolName: string
      readonly token: string
      readonly expiresAt: string
      readonly summaryCode: string
    }

export interface ToolExecutorOptions {
  readonly policy: ToolPolicyEngine
  readonly approvalStore: ApprovalStore
  readonly pendingCalls: PendingCallStore
  readonly idempotencyStore: IdempotencyStore
  readonly audit: ToolAuditSink
  readonly generateId: () => string
  readonly generateToken: () => string
  readonly hash: (value: string) => string
  readonly now: () => Date
  readonly approvalTtlSeconds?: number
}

function failedResult (errorCode: ToolErrorCode): ToolResult {
  const messages: Readonly<Record<ToolErrorCode, string>> = {
    configuration_missing: '工具配置不完整。',
    upstream_unavailable: '工具暂时不可用。',
    tool_timeout: '工具执行超时。',
    tool_cancelled: '工具执行已取消。',
    tool_execution_failed: '工具执行失败。',
    tool_invalid_result: '工具返回了无效结果。',
    tool_output_too_large: '工具返回内容过大。',
    tool_control_unavailable: '工具控制服务暂时不可用。',
    tool_in_progress: '该操作正在处理中。',
    tool_outcome_unknown: '操作结果暂时无法确认。'
  }
  return parseToolResult({
    status: 'failed', effect: 'none', errorCode,
    userMessage: messages[errorCode], retryable: errorCode === 'tool_timeout' || errorCode === 'upstream_unavailable'
  })
}

function deniedResult (reasonCode: 'tool_unavailable' | 'invalid_arguments' | 'permission_denied' | 'approval_invalid', message: string): ToolResult {
  return parseToolResult({ status: 'denied', effect: 'none', reasonCode, userMessage: message, retryable: false })
}

function indeterminateResult (): ToolResult {
  return parseToolResult({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  })
}

function completed (toolName: string, result: ToolResult): ToolExecutionOutcome {
  return Object.freeze({
    kind: 'completed',
    toolName,
    result,
    finalize: shouldFinalizeToolResult(result)
  })
}

function parseArguments (call: ToolCall): unknown {
  if (typeof call.arguments !== 'string') return call.arguments
  try {
    return JSON.parse(call.arguments)
  } catch {
    throw new ToolInputError('invalid_type')
  }
}

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function durationBucket (milliseconds: number): string {
  if (milliseconds < 10) return 'lt_10ms'
  if (milliseconds < 100) return 'lt_100ms'
  if (milliseconds < 1_000) return 'lt_1s'
  if (milliseconds < 10_000) return 'lt_10s'
  return 'gte_10s'
}

function channelKey (facts: ToolRuntimeFacts): string {
  return facts.channel.kind === 'private'
    ? `private:${facts.channel.userId}`
    : `group:${facts.channel.groupId}`
}

function idempotencyKey (definition: ToolDefinition, call: ToolCall, hash: (value: string) => string): string {
  return hash(JSON.stringify({ version: 1, tool: definition.name, runId: call.runId, callId: call.callId }))
}

export class ToolExecutor {
  readonly #options: ToolExecutorOptions
  readonly #approvalTtlSeconds: number

  constructor (options: ToolExecutorOptions) {
    const ttl = options.approvalTtlSeconds ?? 120
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) throw new TypeError('approval TTL is invalid')
    this.#options = options
    this.#approvalTtlSeconds = ttl
  }

  async #audit (
    eventType: ToolAuditEventType,
    definition: ToolDefinition,
    request: ToolExecutionRequest,
    fields: ToolAuditFields = {}
  ): Promise<void> {
    const now = this.#options.now()
    const event: ToolAuditEvent = Object.freeze({
      eventType,
      eventIdHash: this.#options.hash(this.#options.generateId()),
      runIdHash: this.#options.hash(request.call.runId),
      callIdHash: this.#options.hash(request.call.callId),
      snapshotIdHash: this.#options.hash(request.call.snapshotId),
      toolName: definition.name,
      toolVersion: 1,
      profile: request.profile,
      effect: definition.effect,
      risk: definition.risk,
      ...(fields.reasonCode === undefined ? {} : { reasonCode: fields.reasonCode }),
      ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode }),
      ...(fields.outputBytes === undefined ? {} : { outputBytes: fields.outputBytes }),
      ...(fields.startedAt === undefined ? {} : { durationBucket: durationBucket(Math.max(0, now.getTime() - fields.startedAt)) }),
      occurredAt: now.toISOString()
    })
    await this.#options.audit.emit(event)
  }

  async #tryAudit (
    eventType: ToolAuditEventType,
    definition: ToolDefinition,
    request: ToolExecutionRequest,
    fields: ToolAuditFields = {}
  ): Promise<boolean> {
    try {
      await this.#audit(eventType, definition, request, fields)
      return true
    } catch {
      return false
    }
  }

  async #approval (
    definition: ToolDefinition,
    input: Readonly<Record<string, unknown>>,
    target: ToolTarget,
    request: ToolExecutionRequest,
    argumentHash: string,
    summaryCode: string
  ): Promise<ToolExecutionOutcome> {
    const token = this.#options.generateToken()
    const tokenHash = this.#options.hash(token)
    const pendingCallId = this.#options.generateId()
    const rawVersion = this.#options.generateId()
    const createdAt = this.#options.now()
    const expiresAt = new Date(createdAt.getTime() + this.#approvalTtlSeconds * 1_000)
    const pending: PendingToolCall = Object.freeze({
      schemaVersion: 1,
      pendingCallId,
      toolName: definition.name,
      toolVersion: 1,
      profile: request.profile,
      call: Object.freeze({
        runId: request.call.runId,
        callId: request.call.callId,
        snapshotId: request.call.snapshotId,
        requestedName: request.call.requestedName
      }),
      input,
      intent: request.intent,
      argumentHash,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    })
    const record: ApprovalRecord = Object.freeze({
      schemaVersion: 1,
      rawVersion,
      tokenHash,
      toolName: definition.name,
      toolVersion: 1,
      profile: request.profile,
      runId: request.call.runId,
      callId: request.call.callId,
      snapshotId: request.call.snapshotId,
      argumentHash,
      pendingCallId,
      botIdHash: this.#options.hash(request.initialFacts.botId),
      actorIdHash: this.#options.hash(request.initialFacts.actor.userId),
      channelHash: this.#options.hash(channelKey(request.initialFacts)),
      targetHash: this.#options.hash(JSON.stringify(target)),
      summaryCode,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    })
    try {
      this.#options.pendingCalls.put(pending)
    } catch {
      return completed(definition.name, failedResult('tool_control_unavailable'))
    }
    try {
      await this.#options.approvalStore.create(record, this.#approvalTtlSeconds)
    } catch {
      this.#options.pendingCalls.delete(pendingCallId)
      return completed(definition.name, failedResult('tool_control_unavailable'))
    }
    await this.#tryAudit('approval_required', definition, request, { reasonCode: 'approval_required' })
    return Object.freeze({
      kind: 'approval_required',
      toolName: definition.name,
      token,
      expiresAt: expiresAt.toISOString(),
      summaryCode
    })
  }

  #duplicateOutcome (toolName: string, reservation: Exclude<Awaited<ReturnType<IdempotencyStore['reserve']>>, { kind: 'acquired' }>): ToolExecutionOutcome {
    if (reservation.kind === 'running') return completed(toolName, failedResult('tool_in_progress'))
    if (reservation.kind === 'indeterminate') return completed(toolName, indeterminateResult())
    const stored = reservation.outcome
    if (stored.status === 'success') {
      return completed(toolName, parseToolResult({
        status: 'success', effect: stored.effect, content: [], retryable: false
      }))
    }
    return completed(toolName, failedResult(stored.errorCode))
  }

  async execute (request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const requestedName = typeof request.call.requestedName === 'string' ? request.call.requestedName : 'unavailable'
    if (isAborted(request.signal)) return completed(requestedName, failedResult('tool_cancelled'))

    let definition: ToolDefinition
    try {
      definition = request.snapshot.resolveCall(request.call).definition
    } catch (error) {
      if (error instanceof ToolUnavailableError) {
        return completed(requestedName, deniedResult('tool_unavailable', '该工具在当前场景不可用。'))
      }
      return completed(requestedName, failedResult('tool_execution_failed'))
    }

    if (!await this.#tryAudit('requested', definition, request)) {
      return completed(definition.name, failedResult('tool_control_unavailable'))
    }
    let input: Readonly<Record<string, unknown>>
    let target: ToolTarget
    let refreshedFacts: ToolRuntimeFacts
    try {
      const parsed = parseArguments(request.call)
      input = validateToolInputRecord(definition.inputSchema as ToolObjectSchema, parsed)
      target = definition.resolveTarget(input, request.initialFacts)
      refreshedFacts = await request.refreshFacts(target, request.signal ?? new AbortController().signal)
    } catch (error) {
      if (isAborted(request.signal)) return completed(definition.name, failedResult('tool_cancelled'))
      if (error instanceof ToolInputError || error instanceof SyntaxError) {
        if (!await this.#tryAudit('denied', definition, request, { reasonCode: 'invalid_arguments' })) {
          return completed(definition.name, failedResult('tool_control_unavailable'))
        }
        return completed(definition.name, deniedResult('invalid_arguments', '工具参数无效。'))
      }
      if (!await this.#tryAudit('denied', definition, request, { reasonCode: 'permission_denied' })) {
        return completed(definition.name, failedResult('tool_control_unavailable'))
      }
      return completed(definition.name, deniedResult('permission_denied', '当前身份不能执行该操作。'))
    }

    let decision
    try {
      decision = this.#options.policy.decide({
        profile: request.profile,
        definition,
        input,
        facts: refreshedFacts,
        target,
        intent: request.intent
      })
    } catch {
      decision = { kind: 'deny', reasonCode: 'permission_denied', userMessage: '当前身份不能执行该操作。' } as const
    }
    if (decision.kind === 'deny') {
      if (!await this.#tryAudit('denied', definition, request, { reasonCode: decision.reasonCode })) {
        return completed(definition.name, failedResult('tool_control_unavailable'))
      }
      return completed(definition.name, parseToolResult({
        status: 'denied', effect: 'none', reasonCode: decision.reasonCode,
        userMessage: decision.userMessage, retryable: false
      }))
    }

    const argumentHash = this.#options.hash(JSON.stringify(input))
    if (decision.kind === 'approval_required') {
      if (request.approvalGrant === undefined) {
        return this.#approval(definition, input, target, request, argumentHash, decision.summaryCode)
      }
      if (request.approvalGrant.callId !== request.call.callId || request.approvalGrant.argumentHash !== argumentHash) {
        if (!await this.#tryAudit('denied', definition, request, { reasonCode: 'approval_invalid' })) {
          return completed(definition.name, failedResult('tool_control_unavailable'))
        }
        return completed(definition.name, deniedResult('approval_invalid', '该审批已失效，请重新发起。'))
      }
    }

    const key = idempotencyKey(definition, request.call, this.#options.hash)
    if (definition.idempotency !== 'none') {
      const record: IdempotencyRecord = Object.freeze({
        schemaVersion: 1,
        key,
        toolName: definition.name,
        toolVersion: 1,
        runIdHash: this.#options.hash(request.call.runId),
        callIdHash: this.#options.hash(request.call.callId),
        startedAt: this.#options.now().toISOString()
      })
      let reservation
      try {
        reservation = await this.#options.idempotencyStore.reserve(record, idempotencyTtlSeconds)
      } catch {
        return completed(definition.name, failedResult('tool_control_unavailable'))
      }
      if (reservation.kind !== 'acquired') return this.#duplicateOutcome(definition.name, reservation)
    }

    const startedAt = this.#options.now().getTime()
    if (!await this.#tryAudit('started', definition, request)) {
      if (definition.idempotency !== 'none') {
        try {
          await this.#options.idempotencyStore.complete(key, {
            status: 'failed', effect: 'none', errorCode: 'tool_control_unavailable',
            completedAt: this.#options.now().toISOString()
          }, idempotencyTtlSeconds)
        } catch {}
      }
      return completed(definition.name, failedResult('tool_control_unavailable'))
    }

    const controller = new AbortController()
    const externalAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', externalAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), definition.timeoutMs)
    const handlerPromise = Promise.resolve().then(async () => definition.execute(input, {
      runId: request.call.runId,
      callId: request.call.callId,
      snapshotId: request.call.snapshotId,
      facts: refreshedFacts,
      target,
      signal: controller.signal
    }))
    handlerPromise.catch(() => {})
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('operation was aborted', 'AbortError')), { once: true })
    })

    try {
      const rawResult = await Promise.race([handlerPromise, abortPromise])
      let result: ToolResult
      try {
        result = parseToolResult(rawResult, definition.maxOutputBytes)
      } catch (error) {
        if (definition.effect !== 'read_only') throw error
        const code = error instanceof TypeError && /output byte limit|exceeds output byte/.test(error.message)
          ? 'tool_output_too_large'
          : 'tool_invalid_result'
        result = failedResult(code)
      }
      if (definition.idempotency !== 'none') {
        const stored: StoredToolOutcome = result.status === 'success'
          ? { status: 'success', effect: result.effect, completedAt: this.#options.now().toISOString() }
          : {
              status: 'failed', effect: 'none',
              errorCode: result.status === 'failed' ? result.errorCode : 'tool_execution_failed',
              completedAt: this.#options.now().toISOString()
            }
        await this.#options.idempotencyStore.complete(key, stored, idempotencyTtlSeconds)
      }
      await this.#tryAudit(result.status === 'success' ? 'completed' : 'failed', definition, request, {
        ...(result.status === 'failed' ? { errorCode: result.errorCode } : {}),
        outputBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
        startedAt
      })
      return completed(definition.name, result)
    } catch {
      if (definition.effect !== 'read_only') {
        if (definition.idempotency !== 'none') {
          try {
            await this.#options.idempotencyStore.markIndeterminate(key, idempotencyTtlSeconds)
          } catch {}
        }
        await this.#tryAudit('indeterminate', definition, request, {
          errorCode: 'tool_outcome_unknown', startedAt
        })
        return completed(definition.name, indeterminateResult())
      }
      const code: ToolErrorCode = controller.signal.aborted
        ? (isAborted(request.signal) ? 'tool_cancelled' : 'tool_timeout')
        : 'tool_execution_failed'
      const result = failedResult(code)
      await this.#tryAudit('failed', definition, request, { errorCode: code, startedAt })
      return completed(definition.name, result)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', externalAbort)
    }
  }
}
