export type SunoDiagnosticOperation = 'token' | 'create' | 'poll' | 'account' | 'credit' | 'heartbeat' | 'generate'
export type SunoDiagnosticOutcome = 'success' | 'failure' | 'retry' | 'insufficient_credit'

// Never accept a response, error, account or credential object at this boundary.
export function recordSunoDiagnostic (
  logger: { debug?(entry: unknown): void } | undefined,
  operation: SunoDiagnosticOperation,
  outcome: SunoDiagnosticOutcome,
  status?: number
): void {
  if (!['token', 'create', 'poll', 'account', 'credit', 'heartbeat', 'generate'].includes(operation) ||
    !['success', 'failure', 'retry', 'insufficient_credit'].includes(outcome)) return
  try {
    logger?.debug?.(Object.freeze({
      event: 'groupmate.suno', operation, outcome,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status } : {})
    }))
  } catch {}
}
