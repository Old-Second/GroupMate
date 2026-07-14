import { modelProtocolError } from './model-adapter.js';
const SAFE_PROVIDER_CODE = /^[a-z0-9_.:-]{1,128}$/i;
function toBytes(value) {
    if (typeof value === 'string')
        return Buffer.from(value);
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw modelProtocolError('invalid_response_chunk');
}
export async function* iterateResponseBytes(response, signal) {
    if (signal.aborted)
        throw signal.reason;
    const body = response.body;
    if (body?.getReader) {
        const reader = body.getReader();
        try {
            while (true) {
                if (signal.aborted)
                    throw signal.reason;
                const next = await reader.read();
                if (next.done)
                    return;
                if (next.value !== undefined)
                    yield toBytes(next.value);
            }
        }
        finally {
            reader.releaseLock?.();
        }
    }
    if (body?.[Symbol.asyncIterator]) {
        for await (const chunk of body) {
            if (signal.aborted)
                throw signal.reason;
            yield toBytes(chunk);
        }
        return;
    }
    if (response.arrayBuffer) {
        yield new Uint8Array(await response.arrayBuffer());
        return;
    }
    if (response.text) {
        yield Buffer.from(await response.text());
        return;
    }
    throw modelProtocolError('missing_response_body');
}
export async function readBoundedResponseText(response, signal, maxBytes, options) {
    const chunks = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of iterateResponseBytes(response, signal)) {
        const remaining = maxBytes - total;
        if (chunk.byteLength > remaining) {
            if (!options.truncate)
                throw modelProtocolError(options.overflowReason);
            if (remaining > 0)
                chunks.push(chunk.subarray(0, remaining));
            total = maxBytes;
            truncated = true;
            break;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
    }
    return Object.freeze({
        text: new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
        truncated
    });
}
function sanitizeWireText(value, maxLength) {
    return value
        .slice(0, maxLength)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
        .replace(/https?:\/\/[^\s"']+/gi, '[url]');
}
function extractProviderCode(body) {
    try {
        const parsed = JSON.parse(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        const nested = record.error ?? record.detail;
        if (nested === null || typeof nested !== 'object' || Array.isArray(nested))
            return undefined;
        const code = nested.code;
        return typeof code === 'string' && SAFE_PROVIDER_CODE.test(code) ? code : undefined;
    }
    catch {
        return undefined;
    }
}
export async function readBoundedWireError(response, signal, maxBytes) {
    const bounded = await readBoundedResponseText(response, signal, maxBytes, {
        truncate: true,
        overflowReason: 'error_body_too_large'
    });
    const body = sanitizeWireText(bounded.text, maxBytes);
    return Object.freeze({
        status: response.status,
        statusText: sanitizeWireText(response.statusText, 128),
        body,
        truncated: bounded.truncated,
        providerCode: extractProviderCode(body)
    });
}
export function asWireRecord(value, reason) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw modelProtocolError(reason);
    }
    return value;
}
export function asWireJsonObject(value, reason) {
    return asWireRecord(value, reason);
}
