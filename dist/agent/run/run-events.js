import { parseAgentEvent } from '../contracts/event.js';
function clonePrimitivePayload(payload) {
    const descriptors = Object.getOwnPropertyDescriptors(payload);
    if (Object.getOwnPropertySymbols(payload).length > 0) {
        throw new TypeError('event payload contains non-primitive data');
    }
    const entries = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('event payload contains non-primitive data');
        }
        const value = descriptor.value;
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
            throw new TypeError('event payload contains non-primitive data');
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new TypeError('event payload contains a non-finite number');
        }
        entries.push([key, value]);
    }
    return Object.freeze(Object.fromEntries(entries));
}
export function createRunEvent(input) {
    const event = {
        eventVersion: 1,
        eventId: input.eventId,
        runId: input.runId,
        sessionId: input.sessionId,
        sequence: input.sequence,
        occurredAt: input.occurredAt,
        type: input.type,
        payload: clonePrimitivePayload(input.payload)
    };
    parseAgentEvent(event);
    return Object.freeze(event);
}
