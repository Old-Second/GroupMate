function asRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function assertExactKeys(value, allowed, label) {
    const allowedKeys = new Set(allowed);
    const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        throw new TypeError(`${label} contains unknown key: ${unknownKey}`);
    }
}
function requireString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}
function requireIsoTimestamp(value, label) {
    const timestamp = requireString(value, label);
    if (new Date(timestamp).toISOString() !== timestamp) {
        throw new TypeError(`${label} must be an ISO timestamp`);
    }
    return timestamp;
}
function parseContentPart(value) {
    const part = asRecord(value, 'message part');
    switch (part.type) {
        case 'text':
            assertExactKeys(part, ['type', 'text'], 'text part');
            requireString(part.text, 'text part text');
            return value;
        case 'resource_ref': {
            assertExactKeys(part, ['type', 'resourceType', 'resourceId', 'mimeType', 'expiresAt'], 'resource part');
            if (!['image', 'audio', 'file'].includes(String(part.resourceType))) {
                throw new TypeError('resource part type is invalid');
            }
            const resourceId = requireString(part.resourceId, 'resource ID');
            if (/^data:[^,]*;base64,/i.test(resourceId)) {
                throw new TypeError('inline base64 resources are not allowed');
            }
            if (part.mimeType !== undefined)
                requireString(part.mimeType, 'resource mime type');
            if (part.expiresAt !== undefined)
                requireIsoTimestamp(part.expiresAt, 'resource expiry');
            return value;
        }
        case 'mention':
            assertExactKeys(part, ['type', 'userId', 'displayName'], 'mention part');
            requireString(part.userId, 'mention user ID');
            if (part.displayName !== undefined)
                requireString(part.displayName, 'mention display name');
            return value;
        case 'tool_call':
            assertExactKeys(part, ['type', 'toolCallId', 'name', 'arguments'], 'tool call part');
            requireString(part.toolCallId, 'tool call ID');
            requireString(part.name, 'tool name');
            asRecord(part.arguments, 'tool arguments');
            return value;
        case 'tool_result':
            assertExactKeys(part, ['type', 'toolCallId', 'status', 'content'], 'tool result part');
            requireString(part.toolCallId, 'tool call ID');
            if (!['ok', 'error', 'denied', 'indeterminate'].includes(String(part.status))) {
                throw new TypeError('tool result status is invalid');
            }
            if (typeof part.content !== 'string')
                throw new TypeError('tool result content must be a string');
            return value;
        default:
            throw new TypeError('message part type is invalid');
    }
}
function parseProvenance(value) {
    const provenance = asRecord(value, 'message provenance');
    assertExactKeys(provenance, ['source', 'trust', 'sensitivity', 'sourceId', 'createdAt'], 'message provenance');
    requireString(provenance.source, 'provenance source');
    if (!['trusted', 'untrusted'].includes(String(provenance.trust))) {
        throw new TypeError('provenance trust is invalid');
    }
    if (!['public', 'group', 'private', 'sensitive'].includes(String(provenance.sensitivity))) {
        throw new TypeError('provenance sensitivity is invalid');
    }
    requireString(provenance.sourceId, 'provenance source ID');
    requireIsoTimestamp(provenance.createdAt, 'provenance timestamp');
    return value;
}
function parseQuotedMessage(value) {
    const quote = asRecord(value, 'quoted message');
    assertExactKeys(quote, ['messageId', 'sender', 'parts'], 'quoted message');
    requireString(quote.messageId, 'quoted message ID');
    const sender = asRecord(quote.sender, 'quoted sender');
    assertExactKeys(sender, ['userId', 'displayName'], 'quoted sender');
    requireString(sender.userId, 'quoted sender user ID');
    if (sender.displayName !== undefined)
        requireString(sender.displayName, 'quoted sender display name');
    if (!Array.isArray(quote.parts))
        throw new TypeError('quoted message parts must be an array');
    quote.parts.forEach(parseContentPart);
    return value;
}
export function parseAgentMessage(value) {
    const message = asRecord(value, 'agent message');
    assertExactKeys(message, ['id', 'role', 'parts', 'createdAt', 'provenance', 'replyTo'], 'agent message');
    requireString(message.id, 'message ID');
    if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) {
        throw new TypeError('message role is invalid');
    }
    if (!Array.isArray(message.parts))
        throw new TypeError('message parts must be an array');
    message.parts.forEach(parseContentPart);
    requireIsoTimestamp(message.createdAt, 'message timestamp');
    parseProvenance(message.provenance);
    if (message.replyTo !== undefined)
        parseQuotedMessage(message.replyTo);
    return value;
}
