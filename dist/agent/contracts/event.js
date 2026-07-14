export const AGENT_EVENT_TYPES = Object.freeze([
    'run.created', 'run.started', 'run.paused', 'run.resumed', 'run.progress',
    'context.prepared', 'model.started', 'model.delta', 'model.completed',
    'tool.batch_planned', 'tool.requested', 'tool.denied', 'tool.started',
    'tool.completed', 'tool.failed', 'approval.required', 'approval.resolved',
    'approval.requested', 'approval.decided', 'approval.expired',
    'run.completed', 'run.failed', 'run.cancelled'
]);
export function parseAgentEvent(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('agent event must be an object');
    const event = value;
    const allowed = new Set(['eventVersion', 'eventId', 'runId', 'sessionId', 'sequence', 'occurredAt', 'type', 'payload']);
    if (Object.keys(event).some(key => !allowed.has(key)))
        throw new TypeError('agent event contains unknown keys');
    if (event.eventVersion !== 1)
        throw new TypeError('event version is invalid');
    for (const field of ['eventId', 'runId', 'sessionId']) {
        if (typeof event[field] !== 'string' || event[field].length === 0)
            throw new TypeError(`${field} is invalid`);
    }
    if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0)
        throw new TypeError('event sequence is invalid');
    if (typeof event.occurredAt !== 'string' || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
        throw new TypeError('event timestamp is invalid');
    }
    if (!AGENT_EVENT_TYPES.includes(event.type))
        throw new TypeError('event type is invalid');
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        throw new TypeError('event payload is invalid');
    }
    for (const payloadValue of Object.values(event.payload)) {
        if (payloadValue !== null && !['string', 'number', 'boolean'].includes(typeof payloadValue)) {
            throw new TypeError('event payload contains non-primitive data');
        }
        if (typeof payloadValue === 'number' && !Number.isFinite(payloadValue)) {
            throw new TypeError('event payload contains a non-finite number');
        }
    }
    return value;
}
