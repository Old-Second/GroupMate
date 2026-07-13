export function currentChannelTarget(facts) {
    return facts.channel.kind === 'group'
        ? Object.freeze({ kind: 'group', groupId: facts.channel.groupId })
        : Object.freeze({ kind: 'private', userId: facts.channel.userId });
}
export function visibleResult(message) {
    return Object.freeze({
        status: 'success', effect: 'visible',
        content: Object.freeze([{ type: 'text', text: message }]), retryable: false
    });
}
export function backgroundResourceResult(resource, callId) {
    const resourceId = resource.kind === 'remote_url'
        ? resource.url
        : resource.kind === 'local_path'
            ? resource.path
            : `runtime:${callId}`;
    return Object.freeze({
        status: 'success', effect: 'background',
        content: Object.freeze([{
                type: 'resource_ref',
                resourceType: 'image', resourceId, mimeType: resource.mimeType
            }]),
        retryable: false
    });
}
export function executionFailure(message = '工具执行失败。') {
    return Object.freeze({
        status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
        userMessage: message, retryable: false
    });
}
export function cancelledResult() {
    return Object.freeze({
        status: 'failed', effect: 'none', errorCode: 'tool_cancelled',
        userMessage: '工具执行已取消。', retryable: false
    });
}
export function indeterminateResult() {
    return Object.freeze({
        status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
        userMessage: '部分操作可能已完成，结果暂时无法确认。', retryable: false
    });
}
export function visibleDefinition(input) {
    return Object.freeze({
        name: input.name, version: 1, aliases: Object.freeze([]),
        description: input.description, inputSchema: input.inputSchema,
        effect: 'visible_output', risk: 'medium', readOnly: false, destructive: false,
        idempotency: 'call', openWorld: input.network === 'open_http',
        timeoutMs: 30_000, maxOutputBytes: input.maxOutputBytes ?? 16 * 1024,
        network: input.network ?? 'none', permission: 'current_channel',
        resolveTarget: (_toolInput, facts) => currentChannelTarget(facts),
        execute: input.execute
    });
}
export function crossChannelDefinition(input) {
    return Object.freeze({
        name: 'sendMessage', version: 1, aliases: Object.freeze([]),
        description: '向明确指定的其他群或用户发送一条文本消息。',
        inputSchema: input.inputSchema,
        effect: 'side_effect', risk: 'high', readOnly: false, destructive: false,
        idempotency: 'call', openWorld: false, timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024, network: 'none', permission: 'bot_master_cross_channel',
        resolveTarget: (toolInput) => toolInput.targetKind === 'group'
            ? Object.freeze({ kind: 'group', groupId: String(toolInput.targetId) })
            : Object.freeze({ kind: 'private', userId: String(toolInput.targetId) }),
        execute: input.execute
    });
}
export function resourceFromBytes(body, mimeType) {
    return Object.freeze({ kind: 'buffer', data: body, mimeType, byteLength: body.byteLength });
}
export function validResource(resource, maxBytes = 8 * 1024 * 1024) {
    return Number.isSafeInteger(resource.byteLength) && resource.byteLength >= 0 &&
        resource.byteLength <= maxBytes && typeof resource.mimeType === 'string' && resource.mimeType.length <= 256 &&
        ((resource.kind === 'buffer' && resource.data.byteLength === resource.byteLength) ||
            (resource.kind === 'remote_url' && resource.url.length > 0 && resource.url.length <= 4_096) ||
            (resource.kind === 'local_path' && resource.path.length > 0 && resource.path.length <= 4_096));
}
