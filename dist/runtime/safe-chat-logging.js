import { createHash } from 'node:crypto';
import { readChatErrorMetadata } from './chat-error-presentation.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function getSafeMode(mode) {
    return typeof mode === 'string' && /^[a-z0-9_-]{1,32}$/i.test(mode)
        ? mode
        : 'unknown';
}
function getStringLength(value) {
    return typeof value === 'string' ? value.length : 0;
}
function getSafeCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
}
function getSafeToken(value) {
    return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
        ? value
        : 'unknown';
}
export function createChatRequestLog({ mode, stream, prompt }) {
    return {
        event: 'chat.request',
        mode: getSafeMode(mode),
        stream: stream === true,
        promptCharacters: getStringLength(prompt)
    };
}
export function createChatResponseLog({ mode, response }) {
    const value = isRecord(response) ? response : {};
    const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.length : 0;
    const hasFunctionCall = isRecord(value.functionCall);
    const thinkingSegments = Array.isArray(value.thinking_segments)
        ? value.thinking_segments.length
        : 0;
    return {
        event: 'chat.response',
        mode: getSafeMode(mode),
        textCharacters: getStringLength(value.text),
        hasThinking: getStringLength(value.thinking_text) > 0 || thinkingSegments > 0,
        toolCallCount: toolCalls || (hasFunctionCall ? 1 : 0),
        failed: Boolean(value.error)
    };
}
export function createChatErrorLog({ mode, error, category }) {
    const metadata = readChatErrorMetadata(error);
    return {
        event: 'chat.error',
        mode: getSafeMode(mode),
        category: getSafeToken(category),
        error: getSafeToken(metadata.name),
        code: getSafeToken(metadata.code),
        statusCode: metadata.statusCode
    };
}
export function createMessageInputLog(input) {
    return {
        event: 'chat.input.context',
        hasReply: input.hasReply === true,
        replyResolved: input.replyResolved === true,
        currentSegmentCount: getSafeCount(input.currentSegmentCount),
        replySegmentCount: getSafeCount(input.replySegmentCount),
        imageCount: Array.isArray(input.imageUrls) ? input.imageUrls.length : 0,
        promptCharacters: getStringLength(input.prompt)
    };
}
export function createAgentRunLog(input) {
    const runId = typeof input.runId === 'string' ? input.runId : 'unknown';
    return {
        event: 'agent.run',
        runRef: createHash('sha256').update(runId).digest('hex').slice(0, 16),
        fromStatus: getSafeToken(input.fromStatus),
        toStatus: getSafeToken(input.toStatus),
        modelTurns: getSafeCount(input.modelTurns),
        toolCalls: getSafeCount(input.toolCalls),
        usedActiveRuntimeMs: getSafeCount(input.usedActiveRuntimeMs),
        providerAttempts: getSafeCount(input.providerAttempts),
        recoveryAttempts: getSafeCount(input.recoveryAttempts),
        correctionAttempts: getSafeCount(input.correctionAttempts),
        errorCode: getSafeToken(input.errorCode),
        storeKeyCount: getSafeCount(input.storeKeyCount),
        estimatedBytes: getSafeCount(input.estimatedBytes)
    };
}
