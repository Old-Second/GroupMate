import type { JsonObject } from '../model/json-value.js'
import { parseJsonValue } from '../model/json-value.js'
import type { NormalizedToolCall } from '../model/model-adapter.js'
import type { SerializablePreparedCapability } from '../tools/prepared-capability.js'
import type { ToolResult } from '../tools/tool-result.js'
import { parseToolResult, toolResultForModel } from '../tools/tool-result.js'
import type {
  PreparedToolBatch,
  ScheduledToolResult
} from './tool-scheduler.js'

export type ToolLedgerStatus =
  | 'planned'
  | 'validating'
  | 'ready'
  | 'waiting_approval'
  | 'running'
  | 'denied'
  | 'rejected'
  | 'expired'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

export type TerminalToolLedgerStatus = Extract<
  ToolLedgerStatus,
  'denied' | 'rejected' | 'expired' | 'succeeded' | 'failed' | 'cancelled' | 'indeterminate'
>

export interface ToolLedgerCall {
  readonly occurrenceId: string
  readonly step: number
  readonly index: number
  readonly callId: string
  readonly toolName: string
  readonly arguments: JsonObject
  readonly status: ToolLedgerStatus
  readonly capability: SerializablePreparedCapability | null
  readonly result: ToolResult | null
}

export interface ToolExecutionLedger {
  readonly schemaVersion: 1
  readonly step: number
  readonly calls: readonly ToolLedgerCall[]
}

const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const terminalStatuses = new Set<ToolLedgerStatus>([
  'denied', 'rejected', 'expired', 'succeeded', 'failed', 'cancelled', 'indeterminate'
])

function freezeCall (call: ToolLedgerCall): ToolLedgerCall {
  return Object.freeze({ ...call })
}

function freezeLedger (
  step: number,
  calls: readonly ToolLedgerCall[]
): ToolExecutionLedger {
  return Object.freeze({
    schemaVersion: 1,
    step,
    calls: Object.freeze(calls.map(freezeCall))
  })
}

function resultStatus (result: ToolResult): TerminalToolLedgerStatus {
  if (result.status === 'success') return 'succeeded'
  if (result.status === 'denied') return 'denied'
  if (result.status === 'indeterminate') return 'indeterminate'
  return result.errorCode === 'tool_cancelled' ? 'cancelled' : 'failed'
}

function cancelledResult (): ToolResult {
  return parseToolResult({
    status: 'failed', effect: 'none', errorCode: 'tool_cancelled',
    userMessage: '工具执行已取消。', retryable: false
  })
}

function indeterminateResult (): ToolResult {
  return parseToolResult({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  })
}

export function isTerminalToolLedgerStatus (
  status: ToolLedgerStatus
): status is TerminalToolLedgerStatus {
  return terminalStatuses.has(status)
}

export function createToolExecutionLedger (
  step: number,
  inputCalls: readonly NormalizedToolCall[]
): ToolExecutionLedger {
  if (!Number.isSafeInteger(step) || step < 0 || !Array.isArray(inputCalls) ||
    inputCalls.length === 0 || inputCalls.length > 64) {
    throw new TypeError('tool ledger input is invalid')
  }
  const calls = [...inputCalls].sort((left, right) => left.index - right.index)
  const callIds = new Set<string>()
  const indexes = new Set<number>()
  const entries = calls.map((call, position): ToolLedgerCall => {
    if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index !== position ||
      indexes.has(call.index) || !CALL_ID.test(call.callId) || callIds.has(call.callId) ||
      !TOOL_NAME.test(call.name)) {
      throw new TypeError('tool ledger call identity is invalid')
    }
    const parsed = parseJsonValue(call.arguments, {
      maxBytes: 32 * 1_024,
      maxDepth: 8,
      maxNodes: 512
    })
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('tool ledger arguments are invalid')
    }
    indexes.add(call.index)
    callIds.add(call.callId)
    return {
      occurrenceId: `${step}:${call.index}`,
      step,
      index: call.index,
      callId: call.callId,
      toolName: call.name,
      arguments: parsed as JsonObject,
      status: 'planned',
      capability: null,
      result: null
    }
  })
  return freezeLedger(step, entries)
}

export function applyToolPreflight (
  ledger: ToolExecutionLedger,
  batch: PreparedToolBatch
): ToolExecutionLedger {
  if (batch.schemaVersion !== 1 || batch.calls.length !== ledger.calls.length) {
    throw new TypeError('prepared tool batch does not match the ledger')
  }
  const calls = ledger.calls.map((call, index): ToolLedgerCall => {
    const prepared = batch.calls[index]
    if (prepared.kind === 'completed') {
      if (prepared.callId !== call.callId || prepared.toolName !== call.toolName) {
        throw new TypeError('prepared tool result does not match the ledger')
      }
      const result = parseToolResult(prepared.result)
      return {
        ...call,
        status: resultStatus(result),
        result
      }
    }
    const capability = prepared.capability
    if (capability.callId !== call.callId || capability.toolName !== call.toolName) {
      throw new TypeError('prepared capability does not match the ledger')
    }
    return {
      ...call,
      status: prepared.kind === 'approval_required' ? 'waiting_approval' : 'ready',
      capability,
      result: null
    }
  })
  return freezeLedger(ledger.step, calls)
}

export function completeToolExecutionLedger (
  ledger: ToolExecutionLedger,
  scheduled: readonly ScheduledToolResult[]
): ToolExecutionLedger {
  if (scheduled.length !== ledger.calls.length) {
    throw new TypeError('scheduled results do not match the ledger')
  }
  const calls = ledger.calls.map((call, index): ToolLedgerCall => {
    const completed = scheduled[index]
    if (completed.callId !== call.callId || completed.toolName !== call.toolName) {
      throw new TypeError('scheduled result identity does not match the ledger')
    }
    const result = parseToolResult(completed.result)
    if ((call.status === 'rejected' || call.status === 'expired') &&
      call.result !== null && JSON.stringify(call.result) === JSON.stringify(result)) {
      return call
    }
    return {
      ...call,
      status: resultStatus(result),
      result
    }
  })
  return freezeLedger(ledger.step, calls)
}

export function resolveToolApproval (
  ledger: ToolExecutionLedger,
  callId: string,
  resolution:
    | {
        readonly kind: 'approved'
        readonly capability: SerializablePreparedCapability
      }
    | {
        readonly kind: 'denied' | 'rejected' | 'expired'
        readonly result: ToolResult
      }
): ToolExecutionLedger {
  let matched = false
  const calls = ledger.calls.map(call => {
    if (call.callId !== callId) return call
    if (matched || call.status !== 'waiting_approval' || call.capability === null) {
      throw new TypeError('tool approval ledger state is invalid')
    }
    matched = true
    if (resolution.kind === 'approved') {
      if (resolution.capability.callId !== call.callId ||
        resolution.capability.toolName !== call.toolName) {
        throw new TypeError('approved capability does not match the ledger')
      }
      return {
        ...call,
        status: 'ready' as const,
        capability: resolution.capability,
        result: null
      }
    }
    const result = parseToolResult(resolution.result)
    if (result.status === 'success' || result.status === 'indeterminate') {
      throw new TypeError('approval terminal result is invalid')
    }
    return {
      ...call,
      status: resolution.kind,
      result
    }
  })
  if (!matched) throw new TypeError('tool approval ledger call is missing')
  return freezeLedger(ledger.step, calls)
}

export function failToolExecutionLedger (
  ledger: ToolExecutionLedger,
  inputResult: ToolResult
): ToolExecutionLedger {
  const result = parseToolResult(inputResult)
  const status = resultStatus(result)
  return freezeLedger(ledger.step, ledger.calls.map(call => (
    isTerminalToolLedgerStatus(call.status)
      ? call
      : { ...call, status, result }
  )))
}

export function cancelToolExecutionLedger (
  ledger: ToolExecutionLedger,
  startedCallIds: ReadonlySet<string> = new Set<string>()
): ToolExecutionLedger {
  return freezeLedger(ledger.step, ledger.calls.map(call => {
    if (isTerminalToolLedgerStatus(call.status)) return call
    const possibleEffect = startedCallIds.has(call.callId) && call.capability !== null &&
      call.capability.executionClass !== 'read_only'
    const result = possibleEffect ? indeterminateResult() : cancelledResult()
    return {
      ...call,
      status: possibleEffect ? 'indeterminate' as const : 'cancelled' as const,
      result
    }
  }))
}

export function toolLedgerHasUnresolvedNonRead (
  ledger: ToolExecutionLedger
): boolean {
  return ledger.calls.some(call => (
    !isTerminalToolLedgerStatus(call.status) &&
    (call.capability === null || call.capability.executionClass !== 'read_only')
  ))
}

export function resetToolExecutionLedgerForRecovery (
  ledger: ToolExecutionLedger
): ToolExecutionLedger {
  if (toolLedgerHasUnresolvedNonRead(ledger)) {
    throw new TypeError('non-read tool execution cannot be replayed')
  }
  return freezeLedger(ledger.step, ledger.calls.map(call => ({
    ...call,
    status: 'planned',
    capability: null,
    result: null
  })))
}

export function failRecoveredToolExecutionLedger (
  ledger: ToolExecutionLedger
): ToolExecutionLedger {
  return freezeLedger(ledger.step, ledger.calls.map(call => {
    if (isTerminalToolLedgerStatus(call.status)) return call
    const nonRead = call.capability === null ||
      call.capability.executionClass !== 'read_only'
    return {
      ...call,
      status: nonRead ? 'indeterminate' as const : 'cancelled' as const,
      result: nonRead ? indeterminateResult() : cancelledResult()
    }
  }))
}

export function toolLedgerIsTerminal (ledger: ToolExecutionLedger): boolean {
  return ledger.calls.every(call => isTerminalToolLedgerStatus(call.status))
}

export function toolLedgerHasVisibleOutput (ledger: ToolExecutionLedger): boolean {
  return ledger.calls.some(call => call.result?.status === 'success' && call.result.effect === 'visible')
}

export function toolLedgerRequiresToolDisabledFinalResponse (
  ledger: ToolExecutionLedger
): boolean {
  return ledger.calls.some(call => (
    call.capability?.executionClass === 'side_effect' &&
    call.result?.status === 'success' && call.result.effect === 'background'
  ))
}

export function toolLedgerHasIndeterminate (ledger: ToolExecutionLedger): boolean {
  return ledger.calls.some(call => call.status === 'indeterminate')
}

export function toolLedgerModelMessages (
  ledger: ToolExecutionLedger
): readonly Readonly<{ role: 'tool'; content: string; toolCallId: string }>[] {
  if (!toolLedgerIsTerminal(ledger)) throw new TypeError('tool ledger is not terminal')
  return Object.freeze(ledger.calls.map(call => {
    if (call.result === null) throw new TypeError('terminal tool ledger result is missing')
    return Object.freeze({
      role: 'tool' as const,
      content: toolResultForModel(call.result),
      toolCallId: call.callId
    })
  }))
}
