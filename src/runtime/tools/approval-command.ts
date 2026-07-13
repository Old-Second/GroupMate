import { createHash } from 'node:crypto'
import type { ApprovalRecord, ApprovalStore } from '../../agent/tools/approval-store.js'
import type { ToolRuntimeFacts, ToolTarget } from '../../agent/tools/tool-context.js'
import type { ToolExecutionOutcome, ToolExecutor } from '../../agent/tools/tool-executor.js'
import type { PendingCallStore, PendingToolCall } from '../../agent/tools/pending-call-store.js'
import type { ToolSnapshot } from '../../agent/tools/tool-registry.js'

export type ApprovalCommandAction = 'confirm' | 'reject'

export interface ParsedApprovalCommand {
  readonly action: ApprovalCommandAction
  readonly token: string
}

export interface ApprovalEventBinding {
  readonly botIdHash: string
  readonly actorIdHash: string
  readonly channelHash: string
  readonly isBotMaster: boolean
}

export interface ApprovalExecutionRuntime {
  readonly snapshot: ToolSnapshot
  readonly initialFacts: ToolRuntimeFacts
  readonly refreshFacts: (target: ToolTarget, signal: AbortSignal) => Promise<ToolRuntimeFacts>
}

export interface ApprovalCommandServiceOptions {
  readonly approvals: ApprovalStore
  readonly pendingCalls: PendingCallStore
  readonly executor: ToolExecutor
  readonly hash: (value: string) => string
  readonly now: () => Date
  readonly bindEvent: (event: unknown) => Promise<ApprovalEventBinding>
  readonly resolveRuntime: (
    record: ApprovalRecord,
    pending: PendingToolCall,
    event: unknown,
    signal: AbortSignal
  ) => Promise<ApprovalExecutionRuntime>
}

export interface ApprovalCommandResult {
  readonly handled: true
  readonly message: string
  readonly effect: 'none' | 'background'
}

const commandPattern = /^#(确认|拒绝)\s+([A-Za-z0-9_-]{16,64})$/

export function parseApprovalCommand (text: string): ParsedApprovalCommand | null {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256) return null
  const match = commandPattern.exec(text)
  if (match === null || match[2] === undefined) return null
  return Object.freeze({ action: match[1] === '确认' ? 'confirm' : 'reject', token: match[2] })
}

export function sha256ApprovalValue (value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function invalidApproval (): ApprovalCommandResult {
  return Object.freeze({ handled: true, message: '该审批无效或已过期。', effect: 'none' })
}

function bindingMatches (record: ApprovalRecord, binding: ApprovalEventBinding): boolean {
  return record.botIdHash === binding.botIdHash && record.channelHash === binding.channelHash &&
    (record.actorIdHash === binding.actorIdHash || binding.isBotMaster)
}

function pendingMatches (record: ApprovalRecord, pending: PendingToolCall): boolean {
  return pending.schemaVersion === 1 && pending.toolName === record.toolName &&
    pending.toolVersion === record.toolVersion && pending.profile === record.profile &&
    pending.argumentHash === record.argumentHash && pending.call.runId === record.runId &&
    pending.call.callId === record.callId && pending.call.snapshotId === record.snapshotId &&
    pending.pendingCallId === record.pendingCallId &&
    pending.createdAt === record.createdAt &&
    pending.expiresAt === record.expiresAt
}

function runtimeChannelKey (facts: ToolRuntimeFacts): string {
  return facts.channel.kind === 'group'
    ? `group:${facts.channel.groupId}`
    : `private:${facts.channel.userId}`
}

function outcomeResult (outcome: ToolExecutionOutcome): ApprovalCommandResult {
  if (outcome.kind !== 'completed') return invalidApproval()
  if (outcome.result.status === 'success') {
    return Object.freeze({ handled: true, message: '操作已确认并执行。', effect: 'background' })
  }
  if (outcome.result.status === 'indeterminate') {
    return Object.freeze({ handled: true, message: '操作结果暂时无法确认，请勿重复执行。', effect: 'none' })
  }
  return Object.freeze({ handled: true, message: outcome.result.userMessage, effect: 'none' })
}

export class ApprovalCommandService {
  readonly #options: ApprovalCommandServiceOptions

  constructor (options: ApprovalCommandServiceOptions) {
    this.#options = options
  }

  async resolve (input: {
    readonly action: ApprovalCommandAction
    readonly token: string
    readonly event: unknown
    readonly signal?: AbortSignal
  }): Promise<ApprovalCommandResult> {
    const signal = input.signal ?? new AbortController().signal
    if (signal.aborted || !/^[A-Za-z0-9_-]{16,64}$/.test(input.token)) return invalidApproval()
    const tokenHash = this.#options.hash(input.token)
    let record: ApprovalRecord | null
    let binding: ApprovalEventBinding
    try {
      [record, binding] = await Promise.all([
        this.#options.approvals.get(tokenHash),
        this.#options.bindEvent(input.event)
      ])
    } catch {
      return invalidApproval()
    }
    if (record === null || record.tokenHash !== tokenHash || !bindingMatches(record, binding) ||
      Date.parse(record.expiresAt) <= this.#options.now().getTime()) return invalidApproval()

    let consumed: ApprovalRecord | null
    try {
      consumed = await this.#options.approvals.consume(tokenHash, record.rawVersion)
    } catch {
      return invalidApproval()
    }
    if (consumed === null) return invalidApproval()
    if (input.action === 'reject') {
      this.#options.pendingCalls.delete(consumed.pendingCallId)
      return Object.freeze({ handled: true, message: '操作已拒绝。', effect: 'none' })
    }

    const pending = this.#options.pendingCalls.take(consumed.pendingCallId, consumed.argumentHash)
    if (pending === null || !pendingMatches(consumed, pending)) return invalidApproval()
    let runtime: ApprovalExecutionRuntime
    try {
      runtime = await this.#options.resolveRuntime(consumed, pending, input.event, signal)
      if (this.#options.hash(runtime.initialFacts.botId) !== consumed.botIdHash ||
        this.#options.hash(runtime.initialFacts.actor.userId) !== consumed.actorIdHash ||
        this.#options.hash(runtimeChannelKey(runtime.initialFacts)) !== consumed.channelHash) {
        return invalidApproval()
      }
      const registered = runtime.snapshot.resolveCall({
        ...pending.call, arguments: pending.input
      })
      if (registered.canonicalName !== consumed.toolName || registered.definition.version !== consumed.toolVersion) {
        return invalidApproval()
      }
      const target = registered.definition.resolveTarget(pending.input, runtime.initialFacts)
      if (this.#options.hash(JSON.stringify(target)) !== consumed.targetHash ||
        this.#options.hash(JSON.stringify(pending.input)) !== consumed.argumentHash) return invalidApproval()
    } catch {
      return invalidApproval()
    }

    try {
      const outcome = await this.#options.executor.execute({
        snapshot: runtime.snapshot,
        call: { ...pending.call, arguments: pending.input },
        profile: pending.profile,
        initialFacts: runtime.initialFacts,
        intent: pending.intent,
        refreshFacts: runtime.refreshFacts,
        approvalGrant: {
          tokenHash, callId: pending.call.callId, argumentHash: pending.argumentHash
        },
        signal
      })
      return outcomeResult(outcome)
    } catch {
      return invalidApproval()
    }
  }
}

export interface ApprovalBridgeEvent {
  readonly msg?: unknown
  reply(message: string): Promise<unknown>
}

export interface ApprovalBridgeService {
  resolve(input: {
    action: ApprovalCommandAction
    token: string
    event: unknown
  }): Promise<ApprovalCommandResult>
}

type GlobalApprovalRuntime = typeof globalThis & {
  groupmateApprovalService?: ApprovalBridgeService
}

export function createApprovalCommandBridge (
  getService: () => ApprovalBridgeService | undefined = () =>
    (globalThis as GlobalApprovalRuntime).groupmateApprovalService
): (event: ApprovalBridgeEvent) => Promise<boolean> {
  return async event => {
    const command = parseApprovalCommand(typeof event.msg === 'string' ? event.msg : '')
    if (command === null) return false
    const service = getService()
    const result = service === undefined
      ? invalidApproval()
      : await service.resolve({ ...command, event })
    await event.reply(result.message)
    return true
  }
}
