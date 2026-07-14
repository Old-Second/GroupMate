import { parseAgentEvent } from '../contracts/event.js';
import { parseJsonValue } from '../model/json-value.js';
import { RUN_RESOURCE_LIMITS } from './run-limits.js';
import { assertRunTransition } from './run-state.js';
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE = /^[a-z][a-z0-9_.-]{0,63}$/;
function timestamp(value, label) {
    if (typeof value !== 'string' || value.length > 64 || new Date(value).toISOString() !== value) {
        throw new TypeError(`${label} is invalid`);
    }
}
function nonNegative(value, label) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${label} is invalid`);
}
function freezeCheckpoint(value) {
    const parsed = parseJsonValue(value, {
        maxBytes: RUN_RESOURCE_LIMITS.checkpointBytes,
        maxDepth: 32,
        maxNodes: 8_192
    });
    return parsed;
}
function validateEvents(events, startSequence, runId, sessionId) {
    for (const [offset, rawEvent] of events.entries()) {
        const event = parseAgentEvent(rawEvent);
        if (event.runId !== runId || event.sessionId !== sessionId ||
            event.sequence !== startSequence + offset) {
            throw new TypeError('run event sequence is invalid');
        }
    }
}
export function createInitialRunCheckpoint(input) {
    if (!PROFILE.test(input.profileId) || !Number.isSafeInteger(input.profileVersion) ||
        input.profileVersion <= 0 || !CODE.test(input.runId) || !CODE.test(input.sessionId) ||
        input.event.sequence !== 0 || input.event.runId !== input.runId ||
        input.event.sessionId !== input.sessionId) {
        throw new TypeError('initial run checkpoint identity is invalid');
    }
    timestamp(input.deadlineAt, 'run deadline');
    timestamp(input.createdAt, 'run creation time');
    validateEvents([input.event], 0, input.runId, input.sessionId);
    return freezeCheckpoint({
        schemaVersion: 1,
        kernelVersion: 1,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        runId: input.runId,
        sessionId: input.sessionId,
        revision: 0,
        status: 'created',
        step: 0,
        model: input.model,
        messages: Object.freeze([]),
        estimatedInputTokens: 0,
        modelTurn: null,
        toolSnapshot: input.toolSnapshot,
        toolLedgers: Object.freeze([]),
        preparedBatch: null,
        interruption: null,
        budgetLimits: input.budgetLimits,
        budgetCounters: input.budgetCounters,
        recoveryUsed: false,
        forceCorrection: false,
        output: null,
        visibleOutput: false,
        error: null,
        cancellationReason: null,
        events: Object.freeze([input.event]),
        nextEventSequence: 1,
        deadlineAt: input.deadlineAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
    });
}
export function nextRunCheckpoint(checkpoint, status, changes, events, updatedAt) {
    assertRunTransition(checkpoint.status, status);
    timestamp(updatedAt, 'run update time');
    validateEvents(events, checkpoint.nextEventSequence, checkpoint.runId, checkpoint.sessionId);
    const nextSequence = checkpoint.nextEventSequence + events.length;
    nonNegative(nextSequence, 'next event sequence');
    return freezeCheckpoint({
        ...checkpoint,
        ...changes,
        revision: checkpoint.revision + 1,
        status,
        events: Object.freeze([...checkpoint.events, ...events]),
        nextEventSequence: nextSequence,
        updatedAt
    });
}
