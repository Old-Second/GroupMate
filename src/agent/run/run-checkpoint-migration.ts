import {
  completionFromTerminalOutput,
  type CompletionDisposition
} from '../contracts/completion.js'
import {
  parseRunCheckpoint,
  type RunCheckpointV1,
  type RunCheckpointV2
} from './run-checkpoint.js'
import type { RunObservationCountersV1 } from './run-observation.js'

export function upgradeCompletionFromRunCheckpointV1 (
  checkpoint: RunCheckpointV1
): CompletionDisposition | null {
  if (checkpoint.status !== 'completed') return null
  return completionFromTerminalOutput({
    requestKind: 'legacy_unknown',
    output: checkpoint.output,
    visibleToolOutput: checkpoint.visibleOutput ? 'confirmed' : 'none'
  })
}

function legacyApprovalCounters (
  checkpoint: RunCheckpointV1
): Pick<
  RunObservationCountersV1,
  'approvalRequests' | 'toolDenied' | 'toolExpired' | 'toolIndeterminate'
> {
  const approvals = new Map<string, RunCheckpointV1['interruption']>()
  for (const interruption of checkpoint.approvalHistory) {
    approvals.set(interruption.approvalId, interruption)
  }
  if (checkpoint.interruption !== null) {
    approvals.set(checkpoint.interruption.approvalId, checkpoint.interruption)
  }
  let denied = 0
  let expired = 0
  for (const interruption of approvals.values()) {
    if (interruption?.decision?.kind === 'rejected') denied += 1
    if (interruption?.decision?.kind === 'expired') expired += 1
  }
  const indeterminate = checkpoint.toolLedgers.reduce((total, ledger) => (
    total + ledger.calls.filter(call => call.status === 'indeterminate').length
  ), 0)
  return Object.freeze({
    approvalRequests: approvals.size,
    toolDenied: denied,
    toolExpired: expired,
    toolIndeterminate: indeterminate
  })
}

function legacyObservationCounters (
  checkpoint: RunCheckpointV1
): RunObservationCountersV1 {
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: 'unavailable',
    modelTurns: checkpoint.budgetCounters.modelTurns,
    toolAttempts: 'unavailable',
    providerRetries: checkpoint.budgetCounters.providerRetries,
    recoveryAttempts: checkpoint.budgetCounters.recoveryAttempts,
    correctionTurns: checkpoint.budgetCounters.correctionTurns,
    toolCalls: checkpoint.budgetCounters.toolCalls,
    ...legacyApprovalCounters(checkpoint),
    estimatedTokens: checkpoint.budgetCounters.estimatedTokens,
    providerInputTokens: 'unavailable',
    providerOutputTokens: 'unavailable',
    providerTotalTokens: 'unavailable',
    providerActiveDurationMs: checkpoint.budgetCounters.usedActiveRuntimeMs,
    engineActiveDurationMs: 'unavailable'
  })
}

export function upgradeRunCheckpointV1 (
  checkpoint: RunCheckpointV1,
  input: { readonly runRef: string; readonly requestRef: string }
): RunCheckpointV2 {
  const { schemaVersion: _schemaVersion, visibleOutput: _visibleOutput, ...state } = checkpoint
  return parseRunCheckpoint({
    ...state,
    schemaVersion: 2,
    revision: checkpoint.revision + 1,
    runRef: input.runRef,
    requestRef: input.requestRef,
    requestKind: 'legacy_unknown',
    presentationRoute: null,
    completion: upgradeCompletionFromRunCheckpointV1(checkpoint),
    observationCounters: legacyObservationCounters(checkpoint),
    providerDispatch: Object.freeze({ state: 'idle' }),
    engineActivity: Object.freeze({ state: 'idle' }),
    observationPolicy: Object.freeze({
      schemaVersion: 1,
      levelAtStart: 'off',
      sampledSuccess: false
    })
  })
}
