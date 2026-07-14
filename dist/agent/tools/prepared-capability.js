import { parseJsonValue } from '../model/json-value.js';
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js';
import { freezeResourceKeys } from './resource-key.js';
import { parseToolResult } from './tool-result.js';
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const executionClasses = [
    'read_only', 'visible_output', 'side_effect'
];
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function code(value, label) {
    if (typeof value !== 'string' || !codePattern.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function boundedString(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function exactKeys(value, expected, label) {
    const actual = Object.keys(value);
    if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) {
        throw new TypeError(`${label} contains unknown keys`);
    }
}
function target(value) {
    const input = record(value, 'prepared target');
    if (input.kind === 'none') {
        exactKeys(input, ['kind'], 'prepared target');
        return Object.freeze({ kind: 'none' });
    }
    if (input.kind === 'private') {
        exactKeys(input, ['kind', 'userId'], 'prepared target');
        return Object.freeze({ kind: 'private', userId: boundedString(input.userId, 'prepared target user') });
    }
    if (input.kind === 'group') {
        exactKeys(input, ['kind', 'groupId'], 'prepared target');
        return Object.freeze({ kind: 'group', groupId: boundedString(input.groupId, 'prepared target group') });
    }
    if (input.kind === 'member') {
        exactKeys(input, ['kind', 'groupId', 'userId'], 'prepared target');
        return Object.freeze({
            kind: 'member',
            groupId: boundedString(input.groupId, 'prepared target group'),
            userId: boundedString(input.userId, 'prepared target user')
        });
    }
    if (input.kind === 'message') {
        exactKeys(input, ['kind', 'groupId', 'messageId'], 'prepared target');
        return Object.freeze({
            kind: 'message',
            groupId: boundedString(input.groupId, 'prepared target group'),
            messageId: boundedString(input.messageId, 'prepared target message')
        });
    }
    throw new TypeError('prepared target is invalid');
}
function argumentsRecord(value) {
    const parsed = parseJsonValue(value, {
        maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
        maxDepth: 8,
        maxNodes: 512
    });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('prepared arguments are invalid');
    }
    return parsed;
}
export function parseSerializablePreparedCapability(value) {
    const input = record(value, 'prepared capability');
    exactKeys(input, [
        'schemaVersion', 'callId', 'toolName', 'toolVersion', 'snapshotId',
        'canonicalArguments', 'argumentHash', 'target', 'resourceKeys',
        'executionClass', 'retrySafe'
    ], 'prepared capability');
    if (input.schemaVersion !== 1 || input.toolVersion !== 1 ||
        !executionClasses.includes(input.executionClass) ||
        typeof input.retrySafe !== 'boolean' ||
        (input.retrySafe && input.executionClass !== 'read_only')) {
        throw new TypeError('prepared capability is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        callId: code(input.callId, 'prepared call ID'),
        toolName: code(input.toolName, 'prepared tool name'),
        toolVersion: 1,
        snapshotId: code(input.snapshotId, 'prepared snapshot ID'),
        canonicalArguments: argumentsRecord(input.canonicalArguments),
        argumentHash: boundedString(input.argumentHash, 'prepared argument hash'),
        target: target(input.target),
        resourceKeys: freezeResourceKeys(input.resourceKeys),
        executionClass: input.executionClass,
        retrySafe: input.retrySafe
    });
}
export function completedPreparedCall(callId, toolName, result) {
    return Object.freeze({
        kind: 'completed',
        callId: code(callId, 'prepared call ID'),
        toolName: code(toolName, 'prepared tool name'),
        result: parseToolResult(result)
    });
}
