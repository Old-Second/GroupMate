import { isToolResult, openImagePolicy, request } from './query-tool-support.js';
export function currentChannelTarget(facts) {
    return facts.channel.kind === 'group'
        ? Object.freeze({ kind: 'group', groupId: facts.channel.groupId })
        : Object.freeze({ kind: 'private', userId: facts.channel.userId });
}
export function sessionAddressForTarget(botId, target) {
    if (target.kind === 'group') {
        return Object.freeze({
            botId,
            scope: Object.freeze({ kind: 'group', groupId: target.groupId })
        });
    }
    if (target.kind === 'private') {
        return Object.freeze({
            botId,
            scope: Object.freeze({ kind: 'private', userId: target.userId })
        });
    }
    return null;
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
export function visibleDeliveryResult(delivery, successMessage, failureMessage = '工具执行失败。') {
    if (delivery.kind === 'sent')
        return visibleResult(successMessage);
    if (delivery.kind === 'outcome_unknown')
        return indeterminateResult();
    return executionFailure(failureMessage);
}
export async function dispatchVisible(dispatch, successMessage, failureMessage) {
    try {
        return visibleDeliveryResult(await dispatch(), successMessage, failureMessage);
    }
    catch {
        return indeterminateResult();
    }
}
export function visibleDefinition(input) {
    return Object.freeze({
        name: input.name, version: 1, aliases: Object.freeze([]),
        description: input.description, inputSchema: input.inputSchema,
        effect: 'visible_output', risk: 'medium', readOnly: false, destructive: false,
        idempotency: 'call', openWorld: input.network === 'open_http',
        timeoutMs: 30_000, maxOutputBytes: input.maxOutputBytes ?? 16 * 1024,
        network: input.network ?? 'none', permission: 'current_channel',
        executionClass: 'visible_output', retrySafe: false,
        resourceKeys: input.resourceKeys,
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
        idempotency: 'semantic', openWorld: false, timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024, network: 'none', permission: 'cross_channel',
        executionClass: 'side_effect', retrySafe: false,
        resourceKeys: input.resourceKeys,
        crossChannelAccess: Object.freeze({ ...input.crossChannelAccess }),
        resolveTarget: (toolInput) => toolInput.targetKind === 'group'
            ? Object.freeze({ kind: 'group', groupId: String(toolInput.targetId) })
            : Object.freeze({ kind: 'private', userId: String(toolInput.targetId) }),
        execute: input.execute
    });
}
export function resourceFromBytes(body, mimeType) {
    return Object.freeze({ kind: 'buffer', data: body, mimeType, byteLength: body.byteLength });
}
/** Download failures are definite; a dispatched QQ operation is never replayed. */
export async function sendRemoteImages(services, urls, context, label) {
    const target = sessionAddressForTarget(context.facts.botId, context.target);
    if (target === null)
        return executionFailure(`${label}发送失败。`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted)
        abort();
    // Covers both downloading and dispatch, leaving time to commit before 30s.
    const deadline = Date.now() + 25_000;
    const timer = setTimeout(abort, 25_000);
    let sent = 0;
    let dispatching = false;
    let lastFailure = executionFailure(`${label}暂时无法读取。`);
    const unit = label === '头像' ? '个' : '张';
    const confirmed = () => visibleResult(sent === urls.length
        ? `已发送 ${sent} ${unit}${label}。`
        : `已发送 ${sent} ${unit}${label}，其余${label}暂时无法发送。`);
    try {
        for (const url of urls) {
            if (controller.signal.aborted || Date.now() >= deadline)
                return sent > 0 ? confirmed() : cancelledResult();
            const fetched = await request(services.policyFetch, {
                url, policy: openImagePolicy, timeoutMs: Math.max(100, Math.min(8_000, deadline - Date.now())),
                signal: controller.signal, diagnosticTag: 'image_fetch'
            });
            if (isToolResult(fetched)) {
                // This visible operation has already tried its bounded candidate list.
                // A read adapter's retry flag must not ask the model to replay it.
                lastFailure = fetched.status === 'failed' ? Object.freeze({ ...fetched, retryable: false }) : fetched;
                continue;
            }
            if (fetched.status < 200 || fetched.status >= 300) {
                lastFailure = executionFailure(`${label}暂时无法读取。`);
                continue;
            }
            if (controller.signal.aborted)
                return sent > 0 ? confirmed() : cancelledResult();
            dispatching = true;
            const delivery = await services.qq.sendImage(target, resourceFromBytes(fetched.body, fetched.contentType), controller.signal);
            dispatching = false;
            if (delivery.kind === 'outcome_unknown')
                return indeterminateResult();
            if (delivery.kind === 'failed_definite')
                return sent > 0 ? confirmed() : executionFailure(`${label}发送失败。`);
            sent += 1;
        }
        return sent > 0 ? confirmed() : lastFailure;
    }
    catch {
        if (dispatching)
            return indeterminateResult();
        if (sent > 0)
            return confirmed();
        return context.signal.aborted ? cancelledResult() : executionFailure(`${label}发送失败。`);
    }
    finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
    }
}
export function validResource(resource, maxBytes = 8 * 1024 * 1024) {
    return Number.isSafeInteger(resource.byteLength) && resource.byteLength >= 0 &&
        resource.byteLength <= maxBytes && typeof resource.mimeType === 'string' && resource.mimeType.length <= 256 &&
        ((resource.kind === 'buffer' && resource.data.byteLength === resource.byteLength) ||
            (resource.kind === 'remote_url' && resource.url.length > 0 && resource.url.length <= 4_096) ||
            (resource.kind === 'local_path' && resource.path.length > 0 && resource.path.length <= 4_096));
}
