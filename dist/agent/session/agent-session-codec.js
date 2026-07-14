import { parseJsonValue } from '../model/json-value.js';
import { canonicalSessionKey } from './conversation-scope.js';
import { parseAgentSessionState } from './agent-session-state.js';
const SESSION_BYTES = 512 * 1_024;
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function exact(value, keys, label) {
    const allowed = new Set(keys);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new TypeError(`${label} contains unknown keys`);
    }
}
function text(value, label, maxLength = 128) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function timestamp(value, label) {
    const result = text(value, label, 64);
    try {
        if (new Date(result).toISOString() !== result)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return result;
}
function parseCanonicalRecord(value, address) {
    const cloned = parseJsonValue(value, {
        maxBytes: SESSION_BYTES,
        maxDepth: 36,
        maxNodes: 40_000
    });
    const session = record(cloned, 'agent session');
    exact(session, [
        'schemaVersion', 'sessionId', 'botId', 'scope', 'startedBy',
        'createdAt', 'updatedAt', 'turnCount', 'state'
    ], 'agent session');
    if (session.schemaVersion !== 1 || session.botId !== address.botId ||
        canonicalSessionKey({
            botId: String(session.botId),
            scope: session.scope
        }) !== canonicalSessionKey(address)) {
        throw new TypeError('agent session address does not match its key');
    }
    const startedBy = record(session.startedBy, 'agent session starter');
    exact(startedBy, ['userId', 'displayName'], 'agent session starter');
    const parsedStartedBy = Object.freeze({
        userId: text(startedBy.userId, 'agent session starter ID'),
        ...(startedBy.displayName === undefined
            ? {}
            : { displayName: text(startedBy.displayName, 'agent session starter name', 256) })
    });
    if (!Number.isSafeInteger(session.turnCount) || Number(session.turnCount) < 0) {
        throw new TypeError('agent session turn count is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        sessionId: text(session.sessionId, 'agent session ID'),
        botId: address.botId,
        scope: Object.freeze({ ...address.scope }),
        startedBy: parsedStartedBy,
        createdAt: timestamp(session.createdAt, 'agent session creation timestamp'),
        updatedAt: timestamp(session.updatedAt, 'agent session update timestamp'),
        turnCount: Number(session.turnCount),
        state: parseAgentSessionState(session.state)
    });
}
export const agentSessionCodec = Object.freeze({
    encode(session) {
        const parsed = parseCanonicalRecord(session, {
            botId: session.botId,
            scope: session.scope
        });
        return JSON.stringify(parsed);
    },
    decodeCanonical(raw, address) {
        return parseCanonicalRecord(JSON.parse(raw), address);
    },
    decodeLegacy() {
        throw new TypeError('legacy sessions require the bounded legacy projector');
    }
});
