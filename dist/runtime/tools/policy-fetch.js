import http from 'node:http';
import https from 'node:https';
import fetch from 'node-fetch';
import { NetworkPolicy, NetworkPolicyError } from '../../agent/tools/network-policy.js';
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const sensitiveHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);
const forbiddenHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
function normalizedHeaders(headers = {}) {
    const result = Object.create(null);
    for (const [name, value] of Object.entries(headers)) {
        const normalized = name.toLowerCase();
        if (!/^[a-z0-9-]{1,128}$/.test(normalized) || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8 * 1024) {
            throw new TypeError('request header is invalid');
        }
        if (!forbiddenHeaders.has(normalized))
            result[normalized] = value;
    }
    return result;
}
function header(headers, name) {
    const wanted = name.toLowerCase();
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1];
}
function allowedContentType(actual, allowed) {
    return allowed.some(candidate => candidate.endsWith('/*')
        ? actual.startsWith(candidate.slice(0, -1))
        : candidate === actual);
}
function publicFinalUrl(url) {
    return `${url.origin}${url.pathname}`;
}
function cancelled(signal) {
    return signal?.aborted === true;
}
function withAbort(operation, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(new NetworkPolicyError('network_cancelled'));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
export function createPinnedLookup(address, family) {
    return (_hostname, options, callback) => {
        if (options.all === true) {
            callback(null, [{ address, family }]);
            return;
        }
        callback(null, address, family);
    };
}
export function createNodeFetchTransport() {
    return {
        async request(request) {
            const Agent = request.url.protocol === 'https:' ? https.Agent : http.Agent;
            const agent = new Agent({
                lookup: createPinnedLookup(request.pinnedAddress, request.family)
            });
            const result = await fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                signal: request.signal,
                redirect: 'manual',
                agent
            });
            const headers = Object.fromEntries(result.headers.entries());
            const body = result.body ?? (async function* () { })();
            return {
                status: result.status,
                statusText: result.statusText,
                headers,
                body: body,
                cancel: () => { result.body?.destroy?.(); }
            };
        }
    };
}
export class PolicyFetch {
    #networkPolicy;
    #transport;
    constructor(options = {}) {
        this.#networkPolicy = options.networkPolicy ?? new NetworkPolicy();
        this.#transport = options.transport ?? createNodeFetchTransport();
    }
    async request(request) {
        if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 30_000) {
            throw new TypeError('network timeout is invalid');
        }
        if (cancelled(request.signal))
            throw new NetworkPolicyError('network_cancelled');
        const controller = new AbortController();
        let timedOut = false;
        const onCallerAbort = () => controller.abort();
        request.signal?.addEventListener('abort', onCallerAbort, { once: true });
        if (cancelled(request.signal))
            controller.abort();
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, request.timeoutMs);
        let currentUrl;
        try {
            currentUrl = new URL(request.url);
        }
        catch {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onCallerAbort);
            throw new NetworkPolicyError('invalid_url');
        }
        let method = (request.method ?? 'GET').toUpperCase();
        let body = request.body;
        let headers = normalizedHeaders(request.headers);
        let redirects = 0;
        try {
            while (true) {
                const authorized = await this.#networkPolicy.authorize(currentUrl, request.policy, controller.signal);
                let transportResponse;
                try {
                    transportResponse = await withAbort(this.#transport.request({
                        url: authorized.url,
                        method,
                        headers,
                        ...(body === undefined ? {} : { body }),
                        signal: controller.signal,
                        pinnedAddress: authorized.pinnedAddress,
                        family: authorized.family
                    }), controller.signal);
                }
                catch (error) {
                    if (cancelled(request.signal))
                        throw new NetworkPolicyError('network_cancelled');
                    if (timedOut)
                        throw new NetworkPolicyError('network_timeout');
                    if (error instanceof NetworkPolicyError)
                        throw error;
                    throw new NetworkPolicyError('network_failed');
                }
                if (redirectStatuses.has(transportResponse.status)) {
                    const location = header(transportResponse.headers, 'location');
                    transportResponse.cancel?.();
                    if (redirects >= 3)
                        throw new NetworkPolicyError('redirect_limit');
                    if (location === undefined)
                        throw new NetworkPolicyError('redirect_invalid');
                    let nextUrl;
                    try {
                        nextUrl = new URL(location, currentUrl);
                    }
                    catch {
                        throw new NetworkPolicyError('redirect_invalid');
                    }
                    if (nextUrl.origin !== currentUrl.origin) {
                        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitiveHeaders.has(name)));
                    }
                    if (transportResponse.status === 303 || ((transportResponse.status === 301 || transportResponse.status === 302) && method === 'POST')) {
                        method = 'GET';
                        body = undefined;
                    }
                    currentUrl = nextUrl;
                    redirects += 1;
                    continue;
                }
                const contentType = (header(transportResponse.headers, 'content-type') ?? '')
                    .split(';', 1)[0].trim().toLowerCase();
                if (!allowedContentType(contentType, request.policy.allowedContentTypes)) {
                    transportResponse.cancel?.();
                    throw new NetworkPolicyError('content_type_denied');
                }
                const contentLength = header(transportResponse.headers, 'content-length');
                if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > request.policy.maxBytes)) {
                    transportResponse.cancel?.();
                    throw new NetworkPolicyError('response_too_large');
                }
                const chunks = [];
                let bytes = 0;
                const iterator = transportResponse.body[Symbol.asyncIterator]();
                while (true) {
                    let item;
                    try {
                        item = await withAbort(iterator.next(), controller.signal);
                    }
                    catch (error) {
                        if (cancelled(request.signal))
                            throw new NetworkPolicyError('network_cancelled');
                        if (timedOut)
                            throw new NetworkPolicyError('network_timeout');
                        if (error instanceof NetworkPolicyError)
                            throw error;
                        throw new NetworkPolicyError('network_failed');
                    }
                    if (item.done === true)
                        break;
                    const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
                    bytes += chunk.byteLength;
                    if (bytes > request.policy.maxBytes) {
                        controller.abort();
                        transportResponse.cancel?.();
                        throw new NetworkPolicyError('response_too_large');
                    }
                    chunks.push(chunk);
                }
                const output = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) {
                    output.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return Object.freeze({
                    status: transportResponse.status,
                    statusText: transportResponse.statusText,
                    contentType,
                    finalUrl: publicFinalUrl(currentUrl),
                    body: output
                });
            }
        }
        catch (error) {
            if (error instanceof NetworkPolicyError) {
                if (error.code === 'network_cancelled' && timedOut)
                    throw new NetworkPolicyError('network_timeout');
                if (error.code === 'network_cancelled' && cancelled(request.signal))
                    throw error;
                throw error;
            }
            if (cancelled(request.signal))
                throw new NetworkPolicyError('network_cancelled');
            if (timedOut)
                throw new NetworkPolicyError('network_timeout');
            throw new NetworkPolicyError('network_failed');
        }
        finally {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onCallerAbort);
        }
    }
}
