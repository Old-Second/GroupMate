const SECRET_KEYS = new Set([
    'authorization',
    'proxyauthorization',
    'apikey',
    'headers'
]);
function canonicalSecretKey(key) {
    return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}
function safeStructuredValue(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint')
        return String(value);
    if (value instanceof Uint8Array) {
        return { kind: 'binary', byteLength: value.byteLength };
    }
    if (typeof value !== 'object')
        return undefined;
    if (ancestors.has(value))
        throw new TypeError('journal content contains a cycle');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(item => safeStructuredValue(item, ancestors));
        }
        const output = {};
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
                continue;
            if (SECRET_KEYS.has(canonicalSecretKey(key)))
                continue;
            const projected = safeStructuredValue(descriptor.value, ancestors);
            if (projected !== undefined)
                output[key] = projected;
        }
        return output;
    }
    finally {
        ancestors.delete(value);
    }
}
function safeRecord(value) {
    const projected = safeStructuredValue(value);
    if (projected === null || typeof projected !== 'object' || Array.isArray(projected)) {
        throw new TypeError('journal payload is invalid');
    }
    return projected;
}
function projectRequest(request) {
    return safeRecord({
        requestId: request.requestId,
        requestRef: request.requestRef,
        requestKind: request.requestKind,
        presentationRoute: request.presentationRoute,
        createdAt: request.createdAt,
        deadlineAt: request.deadlineAt,
        sessionAddress: request.sessionAddress,
        actor: request.actor,
        channel: request.channel,
        message: request.message,
        references: request.references,
        systemInstructions: request.systemInstructions,
        model: request.model,
        contextBudget: request.contextBudget,
        ...(request.sessionTtlSeconds === undefined
            ? {}
            : { sessionTtlSeconds: request.sessionTtlSeconds })
    });
}
function projectRunEvent(event) {
    const common = {
        occurredAt: event.occurredAt,
        runRef: event.runRef,
        requestRef: event.requestRef
    };
    switch (event.type) {
        case 'provider.request':
            return safeRecord({
                ...common,
                ordinal: event.ordinal,
                attemptKind: event.attemptKind,
                request: event.request
            });
        case 'provider.response':
            return safeRecord({
                ...common,
                ordinal: event.ordinal,
                attemptKind: event.attemptKind,
                turn: event.turn
            });
        case 'provider.failure':
            return safeRecord({
                ...common,
                ordinal: event.ordinal,
                attemptKind: event.attemptKind,
                error: event.error
            });
        case 'run.terminal_committed':
            return safeRecord({
                ...common,
                checkpoint: event.checkpoint,
                receipt: event.receipt
            });
    }
}
function projectResource(resource) {
    const common = {
        kind: resource.kind,
        mimeType: resource.mimeType,
        byteLength: resource.byteLength
    };
    if (resource.kind === 'buffer')
        return common;
    if (resource.kind === 'local_path')
        return { ...common, path: resource.path };
    try {
        const url = new URL(resource.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return common;
        return { ...common, url: `${url.origin}${url.pathname}` };
    }
    catch {
        return common;
    }
}
function projectOutboundPart(part) {
    switch (part.media) {
        case 'text':
            return safeRecord({
                media: part.media,
                atoms: part.atoms,
                ...(part.buttons === undefined ? {} : { buttons: part.buttons })
            });
        case 'picture':
        case 'voice':
        case 'video':
            return { media: part.media, resource: projectResource(part.resource) };
        case 'forward':
            return safeRecord({ media: part.media, title: part.title, nodes: part.nodes });
        case 'music':
            return { media: part.media, provider: part.provider, id: part.id };
        case 'dice':
            return { media: part.media };
        case 'rps':
            return { media: part.media, value: part.value };
    }
}
function projectDeliveryResult(result) {
    if (result.kind !== 'sent') {
        return {
            kind: result.kind,
            media: result.media,
            attempt: result.attempt,
            code: result.code
        };
    }
    return {
        kind: result.kind,
        media: result.media,
        attempt: result.attempt,
        receipt: {
            schemaVersion: result.receipt.schemaVersion,
            media: result.receipt.media,
            ...(result.receipt.messageId === undefined
                ? {}
                : { messageId: result.receipt.messageId })
        }
    };
}
function projectRecallResult(result) {
    return result.kind === 'recalled'
        ? { kind: result.kind }
        : { kind: result.kind, code: result.code };
}
function projectOutboundEvent(event) {
    if (event.type === 'qq.outbound.deliver') {
        return safeRecord({
            occurredAt: event.occurredAt,
            target: event.target,
            part: projectOutboundPart(event.part),
            attempt: event.attempt,
            quoteMessageId: event.quoteMessageId,
            result: projectDeliveryResult(event.result)
        });
    }
    return safeRecord({
        occurredAt: event.occurredAt,
        target: event.target,
        receipt: {
            schemaVersion: event.receipt.schemaVersion,
            media: event.receipt.media,
            ...(event.receipt.messageId === undefined
                ? {}
                : { messageId: event.receipt.messageId })
        },
        result: projectRecallResult(event.result)
    });
}
export function createGroupMateContentJournal(diskLog) {
    const safeRecordEvent = (event) => {
        try {
            diskLog.record(event);
        }
        catch { }
    };
    return Object.freeze({
        recordRequest(request) {
            try {
                safeRecordEvent({
                    type: 'request.received',
                    payload: { request: projectRequest(request) }
                });
            }
            catch { }
        },
        recordRunEvent(event) {
            try {
                safeRecordEvent({ type: event.type, payload: projectRunEvent(event) });
            }
            catch { }
        },
        recordOutbound(event) {
            try {
                safeRecordEvent({ type: event.type, payload: projectOutboundEvent(event) });
            }
            catch { }
        },
        async drain() {
            try {
                await diskLog.drain();
            }
            catch { }
        }
    });
}
