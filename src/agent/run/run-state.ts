export const RUN_STATUSES = Object.freeze([
  'created',
  'preparing',
  'calling_model',
  'evaluating_tools',
  'waiting_approval',
  'executing_tools',
  'correcting',
  'completed',
  'failed',
  'cancelled'
] as const)

export type RunStatus = typeof RUN_STATUSES[number]
export type TerminalRunStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>

const terminalStatuses = new Set<RunStatus>(['completed', 'failed', 'cancelled'])

const allowedTransitions: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = Object.freeze({
  created: new Set<RunStatus>(['preparing', 'failed', 'cancelled']),
  preparing: new Set<RunStatus>(['calling_model', 'failed', 'cancelled']),
  calling_model: new Set<RunStatus>([
    'evaluating_tools',
    'correcting',
    'completed',
    'failed',
    'cancelled'
  ]),
  evaluating_tools: new Set<RunStatus>([
    'waiting_approval',
    'executing_tools',
    'failed',
    'cancelled'
  ]),
  waiting_approval: new Set<RunStatus>(['evaluating_tools', 'failed', 'cancelled']),
  executing_tools: new Set<RunStatus>(['calling_model', 'failed', 'cancelled']),
  correcting: new Set<RunStatus>(['completed', 'failed', 'cancelled']),
  completed: new Set<RunStatus>(),
  failed: new Set<RunStatus>(),
  cancelled: new Set<RunStatus>()
})

export function parseRunStatus (value: unknown): RunStatus {
  if (typeof value !== 'string' || !RUN_STATUSES.includes(value as RunStatus)) {
    throw new TypeError('run status is invalid')
  }
  return value as RunStatus
}

export function isTerminalRunStatus (status: RunStatus): status is TerminalRunStatus {
  return terminalStatuses.has(status)
}

export function assertRunTransition (from: RunStatus, to: RunStatus): void {
  if (isTerminalRunStatus(from)) throw new TypeError(`terminal run state ${from} cannot transition`)
  if (!allowedTransitions[from].has(to)) {
    throw new TypeError(`illegal run transition from ${from} to ${to}`)
  }
}
