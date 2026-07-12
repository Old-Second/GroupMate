export type AgentEventType =
  | 'run.started' | 'context.prepared' | 'model.started' | 'model.delta'
  | 'model.completed' | 'tool.requested' | 'tool.denied' | 'approval.required'
  | 'approval.resolved' | 'tool.started' | 'tool.completed' | 'tool.failed'
  | 'run.completed' | 'run.failed' | 'run.cancelled'

export interface AgentEvent {
  readonly eventVersion: 1
  readonly eventId: string
  readonly runId: string
  readonly sessionId: string
  readonly sequence: number
  readonly occurredAt: string
  readonly type: AgentEventType
  readonly payload: Readonly<Record<string, string | number | boolean | null>>
}
const eventTypes: readonly AgentEventType[] = [
  'run.started', 'context.prepared', 'model.started', 'model.delta',
  'model.completed', 'tool.requested', 'tool.denied', 'approval.required',
  'approval.resolved', 'tool.started', 'tool.completed', 'tool.failed',
  'run.completed', 'run.failed', 'run.cancelled'
]

export function parseAgentEvent (value: unknown): AgentEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('agent event must be an object')
  const event = value as Record<string, unknown>
  const allowed = new Set(['eventVersion', 'eventId', 'runId', 'sessionId', 'sequence', 'occurredAt', 'type', 'payload'])
  if (Object.keys(event).some(key => !allowed.has(key))) throw new TypeError('agent event contains unknown keys')
  if (event.eventVersion !== 1) throw new TypeError('event version is invalid')
  for (const field of ['eventId', 'runId', 'sessionId'] as const) {
    if (typeof event[field] !== 'string' || event[field].length === 0) throw new TypeError(`${field} is invalid`)
  }
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0) throw new TypeError('event sequence is invalid')
  if (typeof event.occurredAt !== 'string' || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
    throw new TypeError('event timestamp is invalid')
  }
  if (!eventTypes.includes(event.type as AgentEventType)) throw new TypeError('event type is invalid')
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new TypeError('event payload is invalid')
  }
  for (const payloadValue of Object.values(event.payload)) {
    if (payloadValue !== null && !['string', 'number', 'boolean'].includes(typeof payloadValue)) {
      throw new TypeError('event payload contains non-primitive data')
    }
    if (typeof payloadValue === 'number' && !Number.isFinite(payloadValue)) {
      throw new TypeError('event payload contains a non-finite number')
    }
  }
  return value as AgentEvent
}
