import { parseJsonValue } from '../model/json-value.js';
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js';
import { parseAgentSessionState } from './agent-session-state.js';
function timestamp(value) {
    if (new Date(value).toISOString() !== value)
        throw new TypeError('migration timestamp is invalid');
    return value;
}
function sensitivity(scope) {
    return scope.kind === 'private' ? 'private' : 'group';
}
export class LegacySessionProjector {
    project(legacy, migratedAt) {
        const parsedMessages = parseJsonValue(legacy.state.messages, {
            maxBytes: RUN_RESOURCE_LIMITS.providerProtocolChainBytes,
            maxDepth: 16,
            maxNodes: 8_192
        });
        if (!Array.isArray(parsedMessages) || parsedMessages.length > 64) {
            throw new TypeError('legacy session history is invalid');
        }
        const projected = [];
        for (const [index, raw] of parsedMessages.entries()) {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new TypeError('legacy session message is invalid');
            }
            const role = raw.role;
            if (role === 'system' || role === 'tool' || role === 'function')
                continue;
            if (role !== 'user' && role !== 'assistant') {
                throw new TypeError('legacy session message role is invalid');
            }
            if (raw.content === null || raw.content === undefined || raw.content === '')
                continue;
            if (typeof raw.content !== 'string') {
                throw new TypeError('legacy session message content is invalid');
            }
            const id = `legacy-${legacy.sessionId}-${index}`;
            const message = Object.freeze({
                id,
                role,
                parts: Object.freeze([{ type: 'text', text: raw.content }]),
                createdAt: legacy.updatedAt,
                provenance: Object.freeze({
                    source: 'legacy_session',
                    trust: 'untrusted',
                    sensitivity: sensitivity(legacy.scope),
                    sourceId: id,
                    createdAt: legacy.updatedAt
                })
            });
            projected.push(Object.freeze({ kind: 'message', message }));
        }
        const state = parseAgentSessionState({
            schemaVersion: 1,
            messages: projected,
            migratedFrom: {
                kind: 'legacy', sourceVersion: 1, migratedAt: timestamp(migratedAt)
            }
        });
        return Object.freeze({
            schemaVersion: 1,
            sessionId: legacy.sessionId,
            botId: legacy.botId,
            scope: Object.freeze({ ...legacy.scope }),
            startedBy: Object.freeze({ ...legacy.startedBy }),
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
            turnCount: legacy.turnCount,
            state
        });
    }
}
