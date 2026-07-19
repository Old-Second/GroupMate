import { parseAgentMessage } from '../contracts/content.js';
import { jsonByteLength, parseJsonValue } from '../model/json-value.js';
import { parseProviderTurnState } from '../run/provider-state.js';
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js';
import { parseExactToolArgumentsText } from '../model/tool-arguments-text.js';
const SESSION_STATE_BYTES = 512 * 1_024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE = /^[a-z][a-z0-9_.-]{0,63}$/;
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
function timestamp(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
        throw new TypeError(`${label} is invalid`);
    }
    try {
        if (new Date(value).toISOString() !== value)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function protocolAssistant(value, profileId, profileVersion) {
    const message = record(value, 'provider protocol assistant message');
    exact(message, ['role', 'content', 'toolCalls', 'providerState'], 'provider protocol assistant message');
    if (message.role !== 'assistant' || (message.content !== null && typeof message.content !== 'string') ||
        !Array.isArray(message.toolCalls) || message.toolCalls.length === 0 || message.toolCalls.length > 8) {
        throw new TypeError('provider protocol span assistant is invalid');
    }
    const callIds = new Set();
    const toolCalls = message.toolCalls.map(rawCall => {
        const call = record(rawCall, 'provider protocol tool call');
        exact(call, ['callId', 'name', 'argumentsText', 'arguments'], 'provider protocol tool call');
        if (typeof call.callId !== 'string' || !IDENTIFIER.test(call.callId) ||
            typeof call.name !== 'string' || !IDENTIFIER.test(call.name) || callIds.has(call.callId)) {
            throw new TypeError('provider protocol span tool call is invalid');
        }
        const parsedArguments = parseJsonValue(call.arguments, {
            maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
            maxDepth: 8,
            maxNodes: 512
        });
        if (parsedArguments === null || typeof parsedArguments !== 'object' ||
            Array.isArray(parsedArguments)) {
            throw new TypeError('provider protocol span tool arguments are invalid');
        }
        const argumentsText = call.argumentsText === undefined
            ? undefined
            : parseExactToolArgumentsText(call.argumentsText, parsedArguments);
        callIds.add(call.callId);
        return Object.freeze({
            callId: call.callId,
            name: call.name,
            ...(argumentsText === undefined ? {} : { argumentsText }),
            arguments: parsedArguments
        });
    });
    const providerState = message.providerState === undefined
        ? undefined
        : parseProviderTurnState(message.providerState);
    if (providerState !== undefined && (providerState.profileId !== profileId ||
        providerState.profileVersion !== profileVersion)) {
        throw new TypeError('provider protocol span profile does not match its state');
    }
    return Object.freeze({
        role: 'assistant',
        content: message.content,
        toolCalls: Object.freeze(toolCalls),
        ...(providerState === undefined ? {} : { providerState })
    });
}
function protocolTool(value) {
    const message = record(value, 'provider protocol tool message');
    exact(message, ['role', 'content', 'toolCallId'], 'provider protocol tool message');
    if (message.role !== 'tool' || typeof message.content !== 'string' ||
        typeof message.toolCallId !== 'string' || !IDENTIFIER.test(message.toolCallId)) {
        throw new TypeError('provider protocol span tool result is invalid');
    }
    return Object.freeze({
        role: 'tool', content: message.content, toolCallId: message.toolCallId
    });
}
function parseProtocolSpan(value) {
    const span = record(value, 'provider protocol span');
    exact(span, [
        'kind', 'id', 'profileId', 'profileVersion', 'createdAt', 'messages'
    ], 'provider protocol span');
    if (span.kind !== 'provider_protocol_span' || typeof span.id !== 'string' ||
        !IDENTIFIER.test(span.id) || typeof span.profileId !== 'string' ||
        !PROFILE.test(span.profileId) || !Number.isSafeInteger(span.profileVersion) ||
        Number(span.profileVersion) <= 0 || !Array.isArray(span.messages) ||
        span.messages.length < 2 || span.messages.length > 9) {
        throw new TypeError('provider protocol span is invalid');
    }
    const assistant = protocolAssistant(span.messages[0], span.profileId, Number(span.profileVersion));
    const tools = span.messages.slice(1).map(protocolTool);
    const callIds = assistant.toolCalls?.map(call => call.callId) ?? [];
    if (tools.length !== callIds.length || tools.some((tool, index) => (tool.toolCallId !== callIds[index]))) {
        throw new TypeError('provider protocol span is incomplete or out of order');
    }
    const messages = Object.freeze([assistant, ...tools]);
    if (jsonByteLength(messages) >
        RUN_RESOURCE_LIMITS.providerProtocolChainBytes) {
        throw new TypeError('provider protocol span byte limit exceeded');
    }
    return Object.freeze({
        kind: 'provider_protocol_span',
        id: span.id,
        profileId: span.profileId,
        profileVersion: Number(span.profileVersion),
        createdAt: timestamp(span.createdAt, 'provider protocol span timestamp'),
        messages
    });
}
function parseMigratedFrom(value) {
    const migrated = record(value, 'session migration');
    exact(migrated, ['kind', 'sourceVersion', 'migratedAt'], 'session migration');
    if (migrated.kind !== 'legacy' || migrated.sourceVersion !== 1) {
        throw new TypeError('session migration is invalid');
    }
    return Object.freeze({
        kind: 'legacy', sourceVersion: 1,
        migratedAt: timestamp(migrated.migratedAt, 'session migration timestamp')
    });
}
export function parseAgentSessionState(value) {
    const cloned = parseJsonValue(value, {
        maxBytes: SESSION_STATE_BYTES,
        maxDepth: 32,
        maxNodes: 32_768
    });
    const state = record(cloned, 'agent session state');
    exact(state, ['schemaVersion', 'messages', 'migratedFrom'], 'agent session state');
    if (state.schemaVersion !== 1 || !Array.isArray(state.messages) || state.messages.length > 128) {
        throw new TypeError('agent session state is invalid');
    }
    const ids = new Set();
    const messages = state.messages.map(rawItem => {
        const item = record(rawItem, 'canonical conversation item');
        if (item.kind === 'message') {
            exact(item, ['kind', 'message'], 'semantic conversation message');
            const message = parseAgentMessage(item.message);
            if (ids.has(message.id))
                throw new TypeError('canonical conversation item ID is duplicated');
            ids.add(message.id);
            return Object.freeze({ kind: 'message', message });
        }
        const span = parseProtocolSpan(item);
        if (ids.has(span.id))
            throw new TypeError('canonical conversation item ID is duplicated');
        ids.add(span.id);
        return span;
    });
    const migratedFrom = state.migratedFrom === undefined
        ? undefined
        : parseMigratedFrom(state.migratedFrom);
    return Object.freeze({
        schemaVersion: 1,
        messages: Object.freeze(messages),
        ...(migratedFrom === undefined ? {} : { migratedFrom })
    });
}
