import {
  parseAgentEvent,
  type AgentEvent,
  type AgentEventType
} from '../contracts/event.js'

export interface CreateRunEventInput {
  readonly eventId: string
  readonly runId: string
  readonly sessionId: string
  readonly sequence: number
  readonly occurredAt: string
  readonly type: AgentEventType
  readonly payload: AgentEvent['payload']
}

function clonePrimitivePayload (
  payload: AgentEvent['payload']
): AgentEvent['payload'] {
  const descriptors = Object.getOwnPropertyDescriptors(payload)
  if (Object.getOwnPropertySymbols(payload).length > 0) {
    throw new TypeError('event payload contains non-primitive data')
  }
  const entries: [string, string | number | boolean | null][] = []
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('event payload contains non-primitive data')
    }
    const value = descriptor.value
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError('event payload contains non-primitive data')
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('event payload contains a non-finite number')
    }
    entries.push([key, value as string | number | boolean | null])
  }
  return Object.freeze(Object.fromEntries(entries))
}

export function createRunEvent (input: CreateRunEventInput): AgentEvent {
  const event = {
    eventVersion: 1 as const,
    eventId: input.eventId,
    runId: input.runId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: input.type,
    payload: clonePrimitivePayload(input.payload)
  }
  parseAgentEvent(event)
  return Object.freeze(event)
}
