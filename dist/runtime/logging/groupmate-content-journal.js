import { isAgentErrorCode } from '../../agent/contracts/error.js';
import { parseAgentMessage } from '../../agent/contracts/content.js';
import { parsePresentationRoute } from '../../agent/contracts/interaction.js';
import { parseJsonValue } from '../../agent/model/json-value.js';
import { parseRunCheckpoint } from '../../agent/run/run-checkpoint.js';
import { RUN_RESOURCE_LIMITS } from '../../agent/run/run-limits.js';
import { parseProviderTurnState } from '../../agent/run/provider-state.js';
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js';
import { parseTerminalCommitReceipt } from '../../agent/run/run-store.js';
import { canonicalSessionKey } from '../../agent/session/conversation-scope.js';
const JSON_DEPTH_LIMIT = 32;
const JSON_NODE_LIMIT = 8_192;
const OUTBOUND_ARRAY_LIMIT = 256;
const MEDIA = new Set([
    'text', 'picture', 'voice', 'forward', 'video', 'music', 'dice', 'rps'
]);
const DELIVERY_CODES = new Set([
    'invalid_target', 'invalid_part', 'aborted_before_dispatch', 'host_rejected',
    'host_exception_after_dispatch', 'host_timeout_after_dispatch',
    'host_abort_after_dispatch', 'unknown_host_result'
]);
const RECALL_DEFINITE_CODES = new Set([
    'receipt_not_owned', 'message_id_unavailable', 'aborted_before_dispatch', 'host_rejected'
]);
const RECALL_UNKNOWN_CODES = new Set([
    'host_exception_after_dispatch', 'host_timeout_after_dispatch',
    'host_abort_after_dispatch', 'unknown_host_result'
]);
function boundedRecord(value, maxBytes, label, options = {}) {
    const parsed = parseJsonValue(value, {
        maxBytes,
        maxDepth: options.maxDepth ?? JSON_DEPTH_LIMIT,
        maxNodes: options.maxNodes ?? JSON_NODE_LIMIT
    });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError(`${label} is invalid`);
    }
    return parsed;
}
function exactKeys(value, allowed, required, label) {
    const keys = Reflect.ownKeys(value);
    const unknown = keys.find(key => typeof key !== 'string' || !allowed.includes(key));
    if (unknown !== undefined)
        throw new TypeError(`${label} contains an unknown key`);
    const missing = required.find(key => !Object.hasOwn(value, key));
    if (missing !== undefined)
        throw new TypeError(`${label} is missing a key`);
}
function text(value, label, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function timestamp(value, label) {
    const result = text(value, label);
    try {
        if (new Date(result).toISOString() !== result)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return result;
}
function safeInteger(value, label, minimum = 0) {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function jsonObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function jsonArray(value, maximum, label) {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function parseSessionAddress(value) {
    const input = jsonObject(value, 'session address');
    exactKeys(input, ['botId', 'scope'], ['botId', 'scope'], 'session address');
    text(input.botId, 'session bot ID');
    const scope = jsonObject(input.scope, 'conversation scope');
    const kind = scope.kind;
    if (kind === 'private') {
        exactKeys(scope, ['kind', 'userId'], ['kind', 'userId'], 'conversation scope');
        text(scope.userId, 'session user ID');
    }
    else if (kind === 'group') {
        exactKeys(scope, ['kind', 'groupId'], ['kind', 'groupId'], 'conversation scope');
        text(scope.groupId, 'session group ID');
    }
    else if (kind === 'group_user') {
        exactKeys(scope, ['kind', 'groupId', 'userId'], ['kind', 'groupId', 'userId'], 'conversation scope');
        text(scope.groupId, 'session group ID');
        text(scope.userId, 'session user ID');
    }
    else {
        throw new TypeError('conversation scope is invalid');
    }
    const address = value;
    canonicalSessionKey(address);
    return address;
}
function parseActor(value) {
    const input = jsonObject(value, 'actor');
    exactKeys(input, ['userId', 'displayName', 'role'], ['userId', 'role'], 'actor');
    text(input.userId, 'actor user ID');
    if (input.displayName !== undefined)
        text(input.displayName, 'actor display name');
    if (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'member') {
        throw new TypeError('actor role is invalid');
    }
}
function parseChannel(value) {
    const input = jsonObject(value, 'channel');
    if (input.kind === 'private') {
        exactKeys(input, ['kind', 'botId', 'userId'], ['kind', 'botId', 'userId'], 'channel');
        text(input.botId, 'channel bot ID');
        text(input.userId, 'channel user ID');
        return;
    }
    if (input.kind === 'group') {
        exactKeys(input, ['kind', 'botId', 'groupId'], ['kind', 'botId', 'groupId'], 'channel');
        text(input.botId, 'channel bot ID');
        text(input.groupId, 'channel group ID');
        return;
    }
    throw new TypeError('channel is invalid');
}
function parseRunModelConfig(value) {
    const input = jsonObject(value, 'run model');
    exactKeys(input, ['model', 'streaming', 'maxOutputTokens', 'reasoning', 'temperature', 'topP'], ['model', 'streaming', 'maxOutputTokens', 'reasoning'], 'run model');
    text(input.model, 'run model name');
    if (typeof input.streaming !== 'boolean')
        throw new TypeError('run streaming is invalid');
    safeInteger(input.maxOutputTokens, 'run output tokens', 1);
    const reasoning = jsonObject(input.reasoning, 'run reasoning');
    exactKeys(reasoning, ['enabled', 'effort'], ['enabled'], 'run reasoning');
    if (typeof reasoning.enabled !== 'boolean' ||
        (reasoning.effort !== undefined &&
            !['low', 'medium', 'high', 'max'].includes(String(reasoning.effort)))) {
        throw new TypeError('run reasoning is invalid');
    }
    if (input.temperature !== undefined)
        finiteNumber(input.temperature, 'run temperature');
    if (input.topP !== undefined)
        finiteNumber(input.topP, 'run top P');
}
function parseContextBudget(value) {
    const input = jsonObject(value, 'context budget');
    const keys = [
        'modelContextTokens', 'reservedOutputTokens', 'reservedToolTokens',
        'safetyMarginTokens', 'maxItems', 'maxBytes'
    ];
    exactKeys(input, keys, keys, 'context budget');
    safeInteger(input.modelContextTokens, 'context budget modelContextTokens', 1);
    safeInteger(input.reservedOutputTokens, 'context budget reservedOutputTokens');
    safeInteger(input.reservedToolTokens, 'context budget reservedToolTokens');
    safeInteger(input.safetyMarginTokens, 'context budget safetyMarginTokens');
    safeInteger(input.maxItems, 'context budget maxItems', 1);
    safeInteger(input.maxBytes, 'context budget maxBytes', 1);
}
function projectRequest(value) {
    const input = boundedRecord(value, RUN_RESOURCE_LIMITS.requestBytes, 'request');
    const allowed = [
        'requestId', 'requestRef', 'requestKind', 'presentationRoute', 'createdAt',
        'deadlineAt', 'sessionAddress', 'actor', 'channel', 'message', 'references',
        'systemInstructions', 'model', 'contextBudget', 'sessionTtlSeconds'
    ];
    exactKeys(input, allowed, allowed.slice(0, -1), 'request');
    text(input.requestId, 'request ID');
    if (typeof input.requestRef !== 'string' || !RUN_REF_PATTERN.test(input.requestRef)) {
        throw new TypeError('request reference is invalid');
    }
    if (input.requestKind !== 'ordinary_chat' && input.requestKind !== 'proactive_chat') {
        throw new TypeError('request kind is invalid');
    }
    timestamp(input.createdAt, 'request timestamp');
    timestamp(input.deadlineAt, 'request deadline');
    const sessionAddress = parseSessionAddress(input.sessionAddress);
    parseActor(input.actor);
    parseChannel(input.channel);
    parseAgentMessage(input.message);
    const route = parsePresentationRoute(input.presentationRoute);
    if (route.requestKind !== input.requestKind ||
        canonicalSessionKey(route.sessionAddress) !== canonicalSessionKey(sessionAddress)) {
        throw new TypeError('request route is invalid');
    }
    const references = jsonObject(input.references, 'request references');
    exactKeys(references, ['currentMessageId', 'quotedMessageId'], ['currentMessageId', 'quotedMessageId'], 'request references');
    text(references.currentMessageId, 'current message ID');
    if (references.quotedMessageId !== null)
        text(references.quotedMessageId, 'quoted message ID');
    const instructions = jsonArray(input.systemInstructions, 256, 'system instructions');
    for (const instruction of instructions)
        text(instruction, 'system instruction');
    parseRunModelConfig(input.model);
    parseContextBudget(input.contextBudget);
    if (input.sessionTtlSeconds !== undefined) {
        safeInteger(input.sessionTtlSeconds, 'session TTL', 1);
    }
    return input;
}
function parseModelMessage(value) {
    const input = jsonObject(value, 'model message');
    if (input.role === 'system' || input.role === 'developer' || input.role === 'user') {
        exactKeys(input, ['role', 'content'], ['role', 'content'], 'model message');
        text(input.content, 'model message content', true);
        return;
    }
    if (input.role === 'tool') {
        exactKeys(input, ['role', 'content', 'toolCallId'], ['role', 'content', 'toolCallId'], 'model message');
        text(input.content, 'model message content', true);
        text(input.toolCallId, 'model tool call ID');
        return;
    }
    if (input.role !== 'assistant')
        throw new TypeError('model message role is invalid');
    exactKeys(input, ['role', 'content', 'toolCalls', 'providerState'], ['role', 'content'], 'model message');
    if (input.content !== null)
        text(input.content, 'model message content', true);
    if (input.toolCalls !== undefined) {
        for (const call of jsonArray(input.toolCalls, OUTBOUND_ARRAY_LIMIT, 'model tool calls')) {
            const toolCall = jsonObject(call, 'model tool call');
            exactKeys(toolCall, ['callId', 'name', 'arguments'], ['callId', 'name', 'arguments'], 'model tool call');
            text(toolCall.callId, 'model tool call ID');
            text(toolCall.name, 'model tool name');
            jsonObject(toolCall.arguments, 'model tool arguments');
        }
    }
    if (input.providerState !== undefined)
        parseProviderTurnState(input.providerState);
}
function parseModelRequest(value) {
    const input = boundedRecord(value, RUN_RESOURCE_LIMITS.requestBytes, 'model request');
    exactKeys(input, [
        'model', 'messages', 'tools', 'toolMode', 'streaming', 'maxOutputTokens',
        'reasoning', 'temperature', 'topP'
    ], ['model', 'messages', 'tools', 'toolMode', 'streaming', 'maxOutputTokens', 'reasoning'], 'model request');
    text(input.model, 'model request name');
    for (const message of jsonArray(input.messages, 512, 'model messages')) {
        parseModelMessage(message);
    }
    for (const definition of jsonArray(input.tools, 256, 'model tools')) {
        const tool = jsonObject(definition, 'model tool');
        exactKeys(tool, ['name', 'description', 'parameters'], ['name', 'description', 'parameters'], 'model tool');
        text(tool.name, 'model tool name');
        text(tool.description, 'model tool description', true);
        jsonObject(tool.parameters, 'model tool parameters');
    }
    if (input.toolMode !== 'auto' && input.toolMode !== 'required' && input.toolMode !== 'disabled') {
        throw new TypeError('model tool mode is invalid');
    }
    if (typeof input.streaming !== 'boolean')
        throw new TypeError('model streaming is invalid');
    safeInteger(input.maxOutputTokens, 'model output tokens', 1);
    const reasoning = jsonObject(input.reasoning, 'model reasoning');
    exactKeys(reasoning, ['enabled', 'effort'], ['enabled'], 'model reasoning');
    if (typeof reasoning.enabled !== 'boolean' ||
        (reasoning.effort !== undefined &&
            !['low', 'medium', 'high', 'max'].includes(String(reasoning.effort)))) {
        throw new TypeError('model reasoning is invalid');
    }
    if (input.temperature !== undefined)
        finiteNumber(input.temperature, 'model temperature');
    if (input.topP !== undefined)
        finiteNumber(input.topP, 'model top P');
    return input;
}
function parseModelTurn(value) {
    const input = boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'model turn');
    exactKeys(input, ['text', 'refusal', 'toolCalls', 'finishReason', 'usage', 'providerState', 'responseId'], ['text', 'toolCalls', 'finishReason'], 'model turn');
    text(input.text, 'model turn text', true);
    if (input.refusal !== undefined)
        text(input.refusal, 'model refusal', true);
    for (const call of jsonArray(input.toolCalls, 256, 'normalized tool calls')) {
        const toolCall = jsonObject(call, 'normalized tool call');
        exactKeys(toolCall, ['index', 'callId', 'name', 'argumentsText', 'arguments'], ['index', 'callId', 'name', 'argumentsText', 'arguments'], 'normalized tool call');
        safeInteger(toolCall.index, 'normalized tool index');
        text(toolCall.callId, 'normalized tool call ID');
        text(toolCall.name, 'normalized tool name');
        text(toolCall.argumentsText, 'normalized tool arguments text', true);
        jsonObject(toolCall.arguments, 'normalized tool arguments');
    }
    if (!['stop', 'length', 'tool_calls', 'content_filter', 'unknown']
        .includes(String(input.finishReason))) {
        throw new TypeError('model finish reason is invalid');
    }
    if (input.usage !== undefined) {
        const usage = jsonObject(input.usage, 'model usage');
        exactKeys(usage, ['inputTokens', 'outputTokens', 'totalTokens'], ['inputTokens', 'outputTokens', 'totalTokens'], 'model usage');
        safeInteger(usage.inputTokens, 'model input tokens');
        safeInteger(usage.outputTokens, 'model output tokens');
        safeInteger(usage.totalTokens, 'model total tokens');
    }
    if (input.providerState !== undefined)
        parseProviderTurnState(input.providerState);
    if (input.responseId !== undefined)
        text(input.responseId, 'model response ID');
    return input;
}
function parseSerializedError(value) {
    const input = boundedRecord(value, RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes, 'serialized agent error', { maxDepth: 4, maxNodes: 256 });
    exactKeys(input, ['code', 'stage', 'retryable', 'userMessage', 'details'], ['code', 'stage', 'retryable', 'userMessage', 'details'], 'serialized agent error');
    if (!isAgentErrorCode(input.code))
        throw new TypeError('agent error code is invalid');
    text(input.stage, 'agent error stage');
    if (typeof input.retryable !== 'boolean')
        throw new TypeError('agent error retryable is invalid');
    text(input.userMessage, 'agent error user message');
    const details = jsonObject(input.details, 'agent error details');
    for (const detail of Object.values(details)) {
        if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
            throw new TypeError('agent error detail is invalid');
        }
    }
    return input;
}
function parseProviderCommon(input) {
    const occurredAt = timestamp(input.occurredAt, 'run journal timestamp');
    if (typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef) ||
        typeof input.requestRef !== 'string' || !RUN_REF_PATTERN.test(input.requestRef)) {
        throw new TypeError('run journal reference is invalid');
    }
    const ordinal = safeInteger(input.ordinal, 'provider ordinal', 1);
    if (!['primary', 'retry', 'recovery', 'correction'].includes(String(input.attemptKind))) {
        throw new TypeError('provider attempt kind is invalid');
    }
    return {
        occurredAt,
        runRef: input.runRef,
        requestRef: input.requestRef,
        ordinal,
        attemptKind: input.attemptKind
    };
}
function projectRunEvent(value) {
    const input = boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'run journal event');
    if (input.type === 'provider.request') {
        const keys = [
            'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'request'
        ];
        exactKeys(input, keys, keys, 'provider request journal event');
        return {
            type: input.type,
            payload: { ...parseProviderCommon(input), request: parseModelRequest(input.request) }
        };
    }
    if (input.type === 'provider.response') {
        const keys = [
            'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'turn'
        ];
        exactKeys(input, keys, keys, 'provider response journal event');
        return {
            type: input.type,
            payload: { ...parseProviderCommon(input), turn: parseModelTurn(input.turn) }
        };
    }
    if (input.type === 'provider.failure') {
        const keys = [
            'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'error'
        ];
        exactKeys(input, keys, keys, 'provider failure journal event');
        return {
            type: input.type,
            payload: { ...parseProviderCommon(input), error: parseSerializedError(input.error) }
        };
    }
    if (input.type !== 'run.terminal_committed') {
        throw new TypeError('run journal event type is invalid');
    }
    const keys = ['type', 'occurredAt', 'runRef', 'requestRef', 'checkpoint', 'receipt'];
    exactKeys(input, keys, keys, 'terminal journal event');
    const occurredAt = timestamp(input.occurredAt, 'terminal journal timestamp');
    const checkpoint = parseRunCheckpoint(input.checkpoint);
    const receipt = parseTerminalCommitReceipt(input.receipt);
    if (input.runRef !== checkpoint.runRef || input.requestRef !== checkpoint.requestRef ||
        receipt.runRef !== checkpoint.runRef || receipt.revision !== checkpoint.revision) {
        throw new TypeError('terminal journal correlation is invalid');
    }
    return {
        type: input.type,
        payload: {
            occurredAt,
            runRef: checkpoint.runRef,
            requestRef: checkpoint.requestRef,
            checkpoint,
            receipt
        }
    };
}
function ownDataRecord(value, label, options = {}) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} prototype is invalid`);
    }
    const symbols = Reflect.ownKeys(descriptors).filter(key => typeof key === 'symbol');
    if (!options.allowReceiptBrand && symbols.length > 0) {
        throw new TypeError(`${label} symbol is invalid`);
    }
    if (options.allowReceiptBrand && (symbols.length > 1 || symbols.some(key => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value') || descriptor.value !== true;
    }))) {
        throw new TypeError(`${label} brand is invalid`);
    }
    const output = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} field is invalid`);
        }
        output[key] = descriptor.value;
    }
    return output;
}
function ownDataArray(value, maximum, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 ||
        Reflect.ownKeys(descriptors).some(key => (typeof key === 'string' && key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new TypeError(`${label} is invalid`);
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} item is invalid`);
        }
        output.push(descriptor.value);
    }
    return output;
}
function exactOwnKeys(value, allowed, required, label) {
    exactKeys(value, allowed, required, label);
}
function projectRawSessionAddress(value) {
    const input = ownDataRecord(value, 'outbound target');
    exactOwnKeys(input, ['botId', 'scope'], ['botId', 'scope'], 'outbound target');
    const scope = ownDataRecord(input.scope, 'outbound scope');
    if (scope.kind === 'private') {
        exactOwnKeys(scope, ['kind', 'userId'], ['kind', 'userId'], 'outbound scope');
    }
    else if (scope.kind === 'group') {
        exactOwnKeys(scope, ['kind', 'groupId'], ['kind', 'groupId'], 'outbound scope');
    }
    else if (scope.kind === 'group_user') {
        exactOwnKeys(scope, ['kind', 'groupId', 'userId'], ['kind', 'groupId', 'userId'], 'outbound scope');
    }
    else {
        throw new TypeError('outbound scope is invalid');
    }
    return parseSessionAddress({ ...input, scope });
}
function projectTextAtom(value) {
    const input = ownDataRecord(value, 'outbound text atom');
    if (input.kind === 'text') {
        exactOwnKeys(input, ['kind', 'text'], ['kind', 'text'], 'outbound text atom');
        return { kind: input.kind, text: text(input.text, 'outbound text', true) };
    }
    if (input.kind === 'markdown') {
        exactOwnKeys(input, ['kind', 'markdown'], ['kind', 'markdown'], 'outbound markdown atom');
        return { kind: input.kind, markdown: text(input.markdown, 'outbound markdown', true) };
    }
    if (input.kind === 'face') {
        exactOwnKeys(input, ['kind', 'faceId'], ['kind', 'faceId'], 'outbound face atom');
        return { kind: input.kind, faceId: safeInteger(input.faceId, 'outbound face ID') };
    }
    if (input.kind !== 'at')
        throw new TypeError('outbound text atom is invalid');
    exactOwnKeys(input, ['kind', 'target'], ['kind', 'target'], 'outbound at atom');
    if (input.target === 'all')
        return { kind: input.kind, target: 'all' };
    const target = ownDataRecord(input.target, 'outbound at target');
    exactOwnKeys(target, ['userId'], ['userId'], 'outbound at target');
    return { kind: input.kind, target: { userId: text(target.userId, 'outbound at user ID') } };
}
function projectButtons(value) {
    const input = ownDataRecord(value, 'outbound buttons');
    exactOwnKeys(input, ['schemaVersion', 'kind', 'suggestions'], ['schemaVersion', 'kind', 'suggestions'], 'outbound buttons');
    if (input.schemaVersion !== 1 || input.kind !== 'chat_suggestions') {
        throw new TypeError('outbound buttons are invalid');
    }
    const suggestions = ownDataArray(input.suggestions, 64, 'outbound suggestions')
        .map(item => text(item, 'outbound suggestion'));
    return { schemaVersion: 1, kind: 'chat_suggestions', suggestions };
}
function projectResource(value) {
    const input = ownDataRecord(value, 'outbound resource');
    const commonKeys = ['kind', 'mimeType', 'byteLength'];
    const mimeType = text(input.mimeType, 'outbound resource mime type');
    const byteLength = safeInteger(input.byteLength, 'outbound resource byte length');
    if (input.kind === 'buffer') {
        exactOwnKeys(input, [...commonKeys, 'data'], [...commonKeys, 'data'], 'outbound buffer resource');
        if (!(input.data instanceof Uint8Array) || input.data.byteLength !== byteLength) {
            throw new TypeError('outbound buffer resource is invalid');
        }
        return { kind: input.kind, mimeType, byteLength };
    }
    if (input.kind === 'local_path') {
        exactOwnKeys(input, [...commonKeys, 'path'], [...commonKeys, 'path'], 'outbound local resource');
        return {
            kind: input.kind,
            path: text(input.path, 'outbound resource path'),
            mimeType,
            byteLength
        };
    }
    if (input.kind !== 'remote_url')
        throw new TypeError('outbound resource kind is invalid');
    exactOwnKeys(input, [...commonKeys, 'url'], [...commonKeys, 'url'], 'outbound remote resource');
    const url = new URL(text(input.url, 'outbound resource URL'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new TypeError('outbound resource URL is invalid');
    }
    return {
        kind: input.kind,
        url: `${url.origin}${url.pathname}`,
        mimeType,
        byteLength
    };
}
function projectOutboundPart(value) {
    const input = ownDataRecord(value, 'outbound part');
    if (input.media === 'text') {
        exactOwnKeys(input, ['media', 'atoms', 'buttons'], ['media', 'atoms'], 'outbound text part');
        const atoms = ownDataArray(input.atoms, OUTBOUND_ARRAY_LIMIT, 'outbound text atoms')
            .map(projectTextAtom);
        return {
            media: input.media,
            atoms,
            ...(input.buttons === undefined ? {} : { buttons: projectButtons(input.buttons) })
        };
    }
    if (input.media === 'picture' || input.media === 'voice' || input.media === 'video') {
        exactOwnKeys(input, ['media', 'resource'], ['media', 'resource'], 'outbound media part');
        return { media: input.media, resource: projectResource(input.resource) };
    }
    if (input.media === 'forward') {
        exactOwnKeys(input, ['media', 'title', 'nodes'], ['media', 'title', 'nodes'], 'outbound forward part');
        const nodes = ownDataArray(input.nodes, OUTBOUND_ARRAY_LIMIT, 'outbound forward nodes')
            .map(node => {
            const item = ownDataRecord(node, 'outbound forward node');
            exactOwnKeys(item, ['kind', 'text'], ['kind', 'text'], 'outbound forward node');
            if (item.kind !== 'text')
                throw new TypeError('outbound forward node is invalid');
            return { kind: 'text', text: text(item.text, 'outbound forward text', true) };
        });
        return {
            media: input.media,
            title: text(input.title, 'outbound forward title'),
            nodes
        };
    }
    if (input.media === 'music') {
        exactOwnKeys(input, ['media', 'provider', 'id'], ['media', 'provider', 'id'], 'outbound music');
        if (input.provider !== '163')
            throw new TypeError('outbound music provider is invalid');
        return { media: input.media, provider: input.provider, id: text(input.id, 'music ID') };
    }
    if (input.media === 'dice') {
        exactOwnKeys(input, ['media'], ['media'], 'outbound dice');
        return { media: input.media };
    }
    if (input.media === 'rps') {
        exactOwnKeys(input, ['media', 'value'], ['media', 'value'], 'outbound rps');
        if (input.value !== 1 && input.value !== 2 && input.value !== 3) {
            throw new TypeError('outbound rps value is invalid');
        }
        return { media: input.media, value: input.value };
    }
    throw new TypeError('outbound part media is invalid');
}
function projectReceipt(value) {
    const input = ownDataRecord(value, 'outbound receipt', { allowReceiptBrand: true });
    exactOwnKeys(input, ['schemaVersion', 'media', 'messageId'], ['schemaVersion', 'media'], 'outbound receipt');
    if (input.schemaVersion !== 1 || typeof input.media !== 'string' ||
        !MEDIA.has(input.media)) {
        throw new TypeError('outbound receipt is invalid');
    }
    return {
        schemaVersion: 1,
        media: input.media,
        ...(input.messageId === undefined
            ? {}
            : { messageId: text(input.messageId, 'outbound receipt message ID') })
    };
}
function projectDeliveryResult(value, media, attempt) {
    const input = ownDataRecord(value, 'outbound delivery result');
    if (input.kind === 'sent') {
        exactOwnKeys(input, ['kind', 'media', 'attempt', 'receipt'], ['kind', 'media', 'attempt', 'receipt'], 'outbound delivery result');
        const receipt = projectReceipt(input.receipt);
        if (input.media !== media || input.attempt !== attempt || receipt.media !== media) {
            throw new TypeError('outbound delivery result correlation is invalid');
        }
        return { kind: input.kind, media: input.media, attempt: input.attempt, receipt };
    }
    if (input.kind !== 'failed_definite' && input.kind !== 'outcome_unknown') {
        throw new TypeError('outbound delivery result kind is invalid');
    }
    exactOwnKeys(input, ['kind', 'media', 'attempt', 'code'], ['kind', 'media', 'attempt', 'code'], 'outbound delivery result');
    if (input.media !== media || input.attempt !== attempt ||
        typeof input.code !== 'string' || !DELIVERY_CODES.has(input.code)) {
        throw new TypeError('outbound delivery result is invalid');
    }
    return { kind: input.kind, media: input.media, attempt: input.attempt, code: input.code };
}
function projectRecallResult(value) {
    const input = ownDataRecord(value, 'outbound recall result');
    if (input.kind === 'recalled') {
        exactOwnKeys(input, ['kind'], ['kind'], 'outbound recall result');
        return { kind: input.kind };
    }
    exactOwnKeys(input, ['kind', 'code'], ['kind', 'code'], 'outbound recall result');
    const codes = input.kind === 'failed_definite'
        ? RECALL_DEFINITE_CODES
        : input.kind === 'outcome_unknown'
            ? RECALL_UNKNOWN_CODES
            : null;
    if (codes === null || typeof input.code !== 'string' || !codes.has(input.code)) {
        throw new TypeError('outbound recall result is invalid');
    }
    return { kind: input.kind, code: input.code };
}
function boundedOutboundPayload(value) {
    return boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'outbound payload');
}
function projectOutboundEvent(value) {
    const input = ownDataRecord(value, 'outbound journal event');
    if (input.type === 'qq.outbound.deliver') {
        const keys = [
            'type', 'occurredAt', 'target', 'part', 'attempt', 'quoteMessageId', 'result'
        ];
        exactOwnKeys(input, keys, keys, 'outbound delivery event');
        const part = projectOutboundPart(input.part);
        const media = part.media;
        const attempt = input.attempt;
        if (attempt !== 1 && attempt !== 2)
            throw new TypeError('outbound attempt is invalid');
        if (input.quoteMessageId !== null)
            text(input.quoteMessageId, 'outbound quote message ID');
        return {
            type: input.type,
            payload: boundedOutboundPayload({
                occurredAt: timestamp(input.occurredAt, 'outbound timestamp'),
                target: projectRawSessionAddress(input.target),
                part,
                attempt,
                quoteMessageId: input.quoteMessageId,
                result: projectDeliveryResult(input.result, media, attempt)
            })
        };
    }
    if (input.type !== 'qq.outbound.recall')
        throw new TypeError('outbound event type is invalid');
    const keys = ['type', 'occurredAt', 'target', 'receipt', 'result'];
    exactOwnKeys(input, keys, keys, 'outbound recall event');
    return {
        type: input.type,
        payload: boundedOutboundPayload({
            occurredAt: timestamp(input.occurredAt, 'outbound timestamp'),
            target: projectRawSessionAddress(input.target),
            receipt: projectReceipt(input.receipt),
            result: projectRecallResult(input.result)
        })
    };
}
function failureEvent(operation) {
    return Object.freeze({
        type: 'groupmate.content_journal.projection_failure',
        payload: Object.freeze({ operation, code: 'invalid_content' })
    });
}
export function createGroupMateContentJournal(diskLog) {
    const safeRecordEvent = (event) => {
        try {
            diskLog.record(event);
        }
        catch { }
    };
    const recordProjection = (operation, project) => {
        try {
            safeRecordEvent(project());
        }
        catch {
            safeRecordEvent(failureEvent(operation));
        }
    };
    return Object.freeze({
        recordRequest(request) {
            recordProjection('request', () => ({
                type: 'request.received',
                payload: { request: projectRequest(request) }
            }));
        },
        recordRunEvent(event) {
            recordProjection('run_event', () => projectRunEvent(event));
        },
        recordOutbound(event) {
            recordProjection('outbound', () => projectOutboundEvent(event));
        },
        async drain() {
            try {
                await diskLog.drain();
            }
            catch { }
        }
    });
}
