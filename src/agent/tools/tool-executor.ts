import type { ToolAuditEvent, ToolAuditEventType, ToolAuditSink } from './audit.js'
import type { ApprovalRecord, ApprovalStore } from './approval-store.js'
import type { ToolCall } from './tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts,
  ToolTarget
} from './tool-context.js'
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
  completedPreparedCall,
  parseSerializablePreparedCapability,
  type PreparedToolCall,
  type SerializablePreparedCapability
} from './prepared-capability.js'
import type { ToolRuntime } from './tool-runtime.js'
import {
  parseToolResult,
  shouldFinalizeToolExecution,
  type ToolDenyCode,
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

interface ToolAuditRequest {
  readonly call: ToolCall
  readonly profile: ToolPolicyProfile
}

interface DiscoveredToolCall {
  readonly definition: ToolDefinition
  readonly call: ToolCall
  readonly input: Readonly<Record<string, unknown>>
  readonly target: ToolTarget
  readonly resourceKeys: readonly string[]
}

export interface ToolExecutionRequest {
  readonly snapshot: ToolSnapshot
  readonly call: ToolCall
  readonly profile: ToolPolicyProfile
  readonly initialFacts: ToolRuntimeFacts
  readonly intent: IntentEvidence
  readonly refreshFacts: (target: ToolTarget, signal: AbortSignal) => Promise<ToolRuntimeFacts>
  readonly approvalTtlSeconds?: number
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
  readonly approvalMode?: 'enabled' | 'disabled'
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

function deniedResult (reasonCode: ToolDenyCode, message: string): ToolResult {
  return parseToolResult({ status: 'denied', effect: 'none', reasonCode, userMessage: message, retryable: false })
}

function indeterminateResult (): ToolResult {
  return parseToolResult({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  })
}

function completed (tool: string | ToolDefinition, result: ToolResult): ToolExecutionOutcome {
  const toolName = typeof tool === 'string' ? tool : tool.name
  return Object.freeze({
    kind: 'completed',
    toolName,
    result,
    finalize: typeof tool === 'string' ? false : shouldFinalizeToolExecution(tool.effect, result)
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

function idempotencyKey (
  definition: ToolDefinition,
  call: ToolCall,
  argumentHash: string,
  hash: (value: string) => string
): string {
  return definition.idempotency === 'semantic'
    ? hash(JSON.stringify({ version: 2, tool: definition.name, runId: call.runId, argumentHash }))
    : hash(JSON.stringify({ version: 1, tool: definition.name, runId: call.runId, callId: call.callId }))
}

function sameJson (left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function safeRequestedName (value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : 'unavailable'
}

function safeCallId (value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : 'invalid-call'
}

export class ToolExecutor implements ToolRuntime {
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
    request: ToolAuditRequest,
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
    request: ToolAuditRequest,
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
    const approvalTtlSeconds = request.approvalTtlSeconds ?? this.#approvalTtlSeconds
    if (!Number.isInteger(approvalTtlSeconds) || approvalTtlSeconds < 30 || approvalTtlSeconds > 300) {
      throw new TypeError('approval TTL is invalid')
    }
    const token = this.#options.generateToken()
    const tokenHash = this.#options.hash(token)
    const pendingCallId = this.#options.generateId()
    const rawVersion = this.#options.generateId()
    const createdAt = this.#options.now()
    const expiresAt = new Date(createdAt.getTime() + approvalTtlSeconds * 1_000)
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
      return completed(definition, failedResult('tool_control_unavailable'))
    }
    try {
      await this.#options.approvalStore.create(record, approvalTtlSeconds)
    } catch {
      this.#options.pendingCalls.delete(pendingCallId)
      return completed(definition, failedResult('tool_control_unavailable'))
    }
    return Object.freeze({
      kind: 'approval_required',
      toolName: definition.name,
      token,
      expiresAt: expiresAt.toISOString(),
      summaryCode
    })
  }

  #duplicateOutcome (definition: ToolDefinition, reservation: Exclude<Awaited<ReturnType<IdempotencyStore['reserve']>>, { kind: 'acquired' }>): ToolExecutionOutcome {
    if (reservation.kind === 'running') return completed(definition, failedResult('tool_in_progress'))
    if (reservation.kind === 'indeterminate') return completed(definition, indeterminateResult())
    const stored = reservation.outcome
    if (stored.status === 'success') {
      return completed(definition, parseToolResult({
        status: 'success', effect: stored.effect, content: [], retryable: false
      }))
    }
    return completed(definition, failedResult(stored.errorCode))
  }

  async #discover (
    call: ToolCall,
    context: ToolPreparationContext,
    snapshot: ToolSnapshot
  ): Promise<DiscoveredToolCall | PreparedToolCall> {
    const requestedName = safeRequestedName(call.requestedName)
    const callId = safeCallId(call.callId)
    let definition: ToolDefinition
    try {
      definition = snapshot.resolveCall(call).definition
    } catch (error) {
      return completedPreparedCall(
        callId,
        requestedName,
        error instanceof ToolUnavailableError
          ? deniedResult('tool_unavailable', '该工具在当前场景不可用。')
          : failedResult('tool_execution_failed')
      )
    }
    const auditRequest: ToolAuditRequest = { call, profile: context.profile }
    if (!await this.#tryAudit('requested', definition, auditRequest)) {
      return completedPreparedCall(callId, definition.name, failedResult('tool_control_unavailable'))
    }
    let input: Readonly<Record<string, unknown>>
    let target: ToolTarget
    try {
      input = validateToolInputRecord(
        definition.inputSchema as ToolObjectSchema,
        parseArguments(call)
      )
      target = definition.resolveTarget(input, context.facts)
    } catch (error) {
      const invalid = error instanceof ToolInputError || error instanceof SyntaxError
      const reasonCode = invalid ? 'invalid_arguments' : 'permission_denied'
      if (!await this.#tryAudit('denied', definition, auditRequest, { reasonCode })) {
        return completedPreparedCall(callId, definition.name, failedResult('tool_control_unavailable'))
      }
      return completedPreparedCall(
        callId,
        definition.name,
        invalid
          ? deniedResult('invalid_arguments', '工具参数无效。')
          : deniedResult('permission_denied', '当前身份不能执行该操作。')
      )
    }
    let resourceKeys: readonly string[]
    try {
      resourceKeys = definition.resourceKeys(input, context.facts)
    } catch {
      resourceKeys = Object.freeze([])
    }
    return Object.freeze({ definition, call, input, target, resourceKeys })
  }

  async #finishPreparation (
    discovered: DiscoveredToolCall,
    context: ToolPreparationContext
  ): Promise<PreparedToolCall> {
    const { definition, call, input, target, resourceKeys } = discovered
    const auditRequest: ToolAuditRequest = { call, profile: context.profile }
    let decision
    try {
      decision = this.#options.policy.decide({
        profile: context.profile,
        definition,
        input,
        facts: context.facts,
        target,
        intent: context.intent
      })
    } catch {
      decision = {
        kind: 'deny', reasonCode: 'permission_denied',
        userMessage: '当前身份不能执行该操作。'
      } as const
    }
    if (decision.kind === 'deny') {
      if (!await this.#tryAudit('denied', definition, auditRequest, {
        reasonCode: decision.reasonCode
      })) {
        return completedPreparedCall(
          safeCallId(call.callId), definition.name, failedResult('tool_control_unavailable')
        )
      }
      return completedPreparedCall(
        safeCallId(call.callId),
        definition.name,
        parseToolResult({
          status: 'denied', effect: 'none', reasonCode: decision.reasonCode,
          userMessage: decision.userMessage, retryable: false
        })
      )
    }
    let capability: SerializablePreparedCapability
    try {
      capability = parseSerializablePreparedCapability({
        schemaVersion: 1,
        callId: call.callId,
        toolName: definition.name,
        toolVersion: 1,
        snapshotId: call.snapshotId,
        canonicalArguments: input,
        argumentHash: this.#options.hash(JSON.stringify(input)),
        target,
        resourceKeys,
        executionClass: definition.executionClass,
        retrySafe: definition.retrySafe
      })
    } catch {
      return completedPreparedCall(
        safeCallId(call.callId), definition.name, failedResult('tool_execution_failed')
      )
    }
    if (decision.kind === 'approval_required') {
      if (!await this.#tryAudit('approval_required', definition, auditRequest, {
        reasonCode: 'approval_required'
      })) {
        return completedPreparedCall(
          capability.callId, definition.name, failedResult('tool_control_unavailable')
        )
      }
      return Object.freeze({
        kind: 'approval_required', capability, summaryCode: decision.summaryCode
      })
    }
    return Object.freeze({ kind: 'ready', capability })
  }

  async prepare (
    call: ToolCall,
    context: ToolPreparationContext,
    snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    const discovered = await this.#discover(call, context, snapshot)
    return 'kind' in discovered
      ? discovered
      : await this.#finishPreparation(discovered, context)
  }

  async executePrepared (
    inputPrepared: SerializablePreparedCapability,
    freshContext: ToolExecutionContext,
    snapshot: ToolSnapshot,
    signal: AbortSignal
  ): Promise<ToolResult> {
    let prepared: SerializablePreparedCapability
    try {
      prepared = parseSerializablePreparedCapability(inputPrepared)
    } catch {
      return failedResult('tool_execution_failed')
    }
    if (signal.aborted) return failedResult('tool_cancelled')
    if (prepared.snapshotId !== snapshot.id) {
      return deniedResult('tool_unavailable', '该工具在当前场景不可用。')
    }
    const call: ToolCall = Object.freeze({
      runId: freshContext.runId,
      callId: prepared.callId,
      snapshotId: prepared.snapshotId,
      requestedName: prepared.toolName,
      arguments: prepared.canonicalArguments
    })
    let definition: ToolDefinition
    try {
      definition = snapshot.resolveCall(call).definition
    } catch {
      return deniedResult('tool_unavailable', '该工具在当前场景不可用。')
    }
    if (definition.version !== prepared.toolVersion ||
      definition.executionClass !== prepared.executionClass ||
      definition.retrySafe !== prepared.retrySafe ||
      this.#options.hash(JSON.stringify(prepared.canonicalArguments)) !== prepared.argumentHash) {
      return deniedResult('approval_invalid', '该审批已失效，请重新发起。')
    }
    let target: ToolTarget
    let resourceKeys: readonly string[]
    try {
      target = definition.resolveTarget(prepared.canonicalArguments, freshContext.facts)
    } catch {
      return deniedResult('permission_denied', '当前身份不能执行该操作。')
    }
    try {
      resourceKeys = definition.resourceKeys(prepared.canonicalArguments, freshContext.facts)
    } catch {
      resourceKeys = Object.freeze([])
    }
    if (!sameJson(target, prepared.target) || !sameJson(resourceKeys, prepared.resourceKeys)) {
      return deniedResult('approval_invalid', '该审批已失效，请重新发起。')
    }
    let decision
    try {
      decision = this.#options.policy.decide({
        profile: freshContext.profile,
        definition,
        input: prepared.canonicalArguments,
        facts: freshContext.facts,
        target,
        intent: freshContext.intent
      })
    } catch {
      decision = {
        kind: 'deny', reasonCode: 'permission_denied',
        userMessage: '当前身份不能执行该操作。'
      } as const
    }
    const auditRequest: ToolAuditRequest = { call, profile: freshContext.profile }
    if (decision.kind === 'deny') {
      if (!await this.#tryAudit('denied', definition, auditRequest, {
        reasonCode: decision.reasonCode
      })) return failedResult('tool_control_unavailable')
      return parseToolResult({
        status: 'denied', effect: 'none', reasonCode: decision.reasonCode,
        userMessage: decision.userMessage, retryable: false
      })
    }
    if (decision.kind === 'approval_required' && freshContext.approval?.kind !== 'approved') {
      if (!await this.#tryAudit('denied', definition, auditRequest, {
        reasonCode: 'approval_invalid'
      })) return failedResult('tool_control_unavailable')
      return deniedResult('approval_invalid', '该审批已失效，请重新发起。')
    }
    return await this.#dispatch(definition, prepared, freshContext, signal, auditRequest)
  }

  async #dispatch (
    definition: ToolDefinition,
    prepared: SerializablePreparedCapability,
    context: ToolExecutionContext,
    signal: AbortSignal,
    auditRequest: ToolAuditRequest
  ): Promise<ToolResult> {
    if (signal.aborted) return failedResult('tool_cancelled')
    const call: ToolCall = Object.freeze({
      runId: context.runId,
      callId: prepared.callId,
      snapshotId: prepared.snapshotId,
      requestedName: prepared.toolName,
      arguments: prepared.canonicalArguments
    })
    const key = idempotencyKey(
      definition, call, prepared.argumentHash, this.#options.hash
    )
    if (definition.idempotency !== 'none') {
      const record: IdempotencyRecord = Object.freeze({
        schemaVersion: 1,
        key,
        toolName: definition.name,
        toolVersion: 1,
        runIdHash: this.#options.hash(call.runId),
        callIdHash: this.#options.hash(call.callId),
        startedAt: this.#options.now().toISOString()
      })
      let reservation
      try {
        reservation = await this.#options.idempotencyStore.reserve(
          record, idempotencyTtlSeconds
        )
      } catch {
        return failedResult('tool_control_unavailable')
      }
      if (reservation.kind !== 'acquired') {
        return (this.#duplicateOutcome(definition, reservation) as Extract<
          ToolExecutionOutcome, { kind: 'completed' }
        >).result
      }
    }

    const startedAt = this.#options.now().getTime()
    if (!await this.#tryAudit('started', definition, auditRequest)) {
      if (definition.idempotency !== 'none') {
        try {
          await this.#options.idempotencyStore.complete(key, {
            status: 'failed', effect: 'none', errorCode: 'tool_control_unavailable',
            completedAt: this.#options.now().toISOString()
          }, idempotencyTtlSeconds)
        } catch {}
      }
      return failedResult('tool_control_unavailable')
    }

    const controller = new AbortController()
    const externalAbort = (): void => controller.abort()
    signal.addEventListener('abort', externalAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), definition.timeoutMs)
    const handlerPromise = Promise.resolve().then(async () => definition.execute(
      prepared.canonicalArguments,
      {
        runId: context.runId,
        callId: prepared.callId,
        snapshotId: prepared.snapshotId,
        facts: context.facts,
        target: prepared.target,
        signal: controller.signal
      }
    ))
    handlerPromise.catch(() => {})
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DOMException('operation was aborted', 'AbortError'))
      }, { once: true })
    })

    try {
      const rawResult = await Promise.race([handlerPromise, abortPromise])
      let result: ToolResult
      try {
        result = parseToolResult(rawResult, definition.maxOutputBytes)
      } catch (error) {
        if (definition.effect !== 'read_only') throw error
        result = failedResult(
          error instanceof TypeError && /output byte limit|exceeds output byte/.test(error.message)
            ? 'tool_output_too_large'
            : 'tool_invalid_result'
        )
      }
      if (definition.idempotency !== 'none') {
        const stored: StoredToolOutcome = result.status === 'success'
          ? {
              status: 'success', effect: result.effect,
              completedAt: this.#options.now().toISOString()
            }
          : {
              status: 'failed', effect: 'none',
              errorCode: result.status === 'failed'
                ? result.errorCode
                : 'tool_execution_failed',
              completedAt: this.#options.now().toISOString()
            }
        await this.#options.idempotencyStore.complete(
          key, stored, idempotencyTtlSeconds
        )
      }
      await this.#tryAudit(
        result.status === 'success' ? 'completed' : 'failed',
        definition,
        auditRequest,
        {
          ...(result.status === 'failed' ? { errorCode: result.errorCode } : {}),
          outputBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
          startedAt
        }
      )
      return result
    } catch {
      if (definition.effect !== 'read_only') {
        if (definition.idempotency !== 'none') {
          try {
            await this.#options.idempotencyStore.markIndeterminate(
              key, idempotencyTtlSeconds
            )
          } catch {}
        }
        await this.#tryAudit('indeterminate', definition, auditRequest, {
          errorCode: 'tool_outcome_unknown', startedAt
        })
        return indeterminateResult()
      }
      const errorCode: ToolErrorCode = controller.signal.aborted
        ? (signal.aborted ? 'tool_cancelled' : 'tool_timeout')
        : 'tool_execution_failed'
      const result = failedResult(errorCode)
      await this.#tryAudit('failed', definition, auditRequest, {
        errorCode, startedAt
      })
      return result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', externalAbort)
    }
  }

  async execute (request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const requestedName = safeRequestedName(request.call.requestedName)
    if (isAborted(request.signal)) {
      return completed(requestedName, failedResult('tool_cancelled'))
    }
    const signal = request.signal ?? new AbortController().signal
    const initialContext: ToolPreparationContext = Object.freeze({
      runId: request.call.runId,
      profile: request.profile,
      facts: request.initialFacts,
      intent: request.intent,
      now: this.#options.now().toISOString()
    })
    const discovered = await this.#discover(
      request.call, initialContext, request.snapshot
    )
    if ('kind' in discovered) {
      if (discovered.kind !== 'completed') {
        return completed(requestedName, failedResult('tool_execution_failed'))
      }
      return completed(discovered.toolName, discovered.result)
    }
    let refreshedFacts: ToolRuntimeFacts
    try {
      refreshedFacts = await request.refreshFacts(discovered.target, signal)
    } catch {
      if (signal.aborted) {
        return completed(discovered.definition, failedResult('tool_cancelled'))
      }
      if (!await this.#tryAudit('denied', discovered.definition, request, {
        reasonCode: 'permission_denied'
      })) {
        return completed(discovered.definition, failedResult('tool_control_unavailable'))
      }
      return completed(
        discovered.definition,
        deniedResult('permission_denied', '当前身份不能执行该操作。')
      )
    }
    const freshContext: ToolExecutionContext = Object.freeze({
      ...initialContext,
      facts: refreshedFacts,
      ...(request.approvalGrant === undefined
        ? {}
        : {
            approval: Object.freeze({
              kind: 'approved' as const,
              decidedAt: this.#options.now().toISOString()
            })
          })
    })
    const prepared = await this.#finishPreparation(discovered, freshContext)
    if (prepared.kind === 'completed') {
      return completed(discovered.definition, prepared.result)
    }
    if (prepared.kind === 'approval_required') {
      if (this.#options.approvalMode === 'disabled') {
        if (!await this.#tryAudit('denied', discovered.definition, request, {
          reasonCode: 'approval_unavailable'
        })) {
          return completed(discovered.definition, failedResult('tool_control_unavailable'))
        }
        return completed(discovered.definition, deniedResult(
          'approval_unavailable',
          '该操作需要人工确认，当前审批流程不可用，未执行操作。'
        ))
      }
      if (request.approvalGrant === undefined) {
        return await this.#approval(
          discovered.definition,
          discovered.input,
          discovered.target,
          request,
          prepared.capability.argumentHash,
          prepared.summaryCode
        )
      }
      if (request.approvalGrant.callId !== prepared.capability.callId ||
        request.approvalGrant.argumentHash !== prepared.capability.argumentHash) {
        if (!await this.#tryAudit('denied', discovered.definition, request, {
          reasonCode: 'approval_invalid'
        })) {
          return completed(discovered.definition, failedResult('tool_control_unavailable'))
        }
        return completed(
          discovered.definition,
          deniedResult('approval_invalid', '该审批已失效，请重新发起。')
        )
      }
    }
    const result = await this.executePrepared(
      prepared.capability,
      freshContext,
      request.snapshot,
      signal
    )
    return completed(discovered.definition, result)
  }
}
