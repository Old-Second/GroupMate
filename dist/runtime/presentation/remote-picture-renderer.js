import { isIP } from 'node:net';
import { isPublicNetworkAddress } from '../../agent/tools/network-policy.js';
import { parseGroupMatePictureRemoteResponse, revalidateGroupMatePictureRemoteRequest } from './groupmate-picture-contract.js';
const GROUPMATE_REMOTE_PAGE_PATH = /^\/groupmate\/reply\/v1\/[0-9a-f]{32}$/;
function defaultTimeoutSignal(milliseconds) {
    return AbortSignal.timeout(milliseconds);
}
function consumeCleanup(cleanup) {
    if (cleanup === undefined)
        return;
    try {
        void Promise.resolve(cleanup()).catch(() => undefined);
    }
    catch { }
}
async function settleBeforeAbort(factory, signal, onAbort) {
    if (signal.aborted) {
        consumeCleanup(onAbort);
        return Object.freeze({ kind: 'aborted' });
    }
    return await new Promise(resolve => {
        let finished = false;
        const finish = (result) => {
            if (finished)
                return;
            finished = true;
            signal.removeEventListener('abort', abort);
            resolve(Object.freeze(result));
        };
        const abort = () => {
            consumeCleanup(onAbort);
            finish({ kind: 'aborted' });
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
            return;
        }
        let operation;
        try {
            operation = Promise.resolve(factory());
        }
        catch {
            finish({ kind: 'rejected' });
            return;
        }
        operation.then(value => finish({ kind: 'completed', value }), () => finish({ kind: 'rejected' }));
    });
}
function safeOrigin(value) {
    if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 2_048)
        return null;
    try {
        const parsed = new URL(value.trim());
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '')
            return null;
        return parsed.origin;
    }
    catch {
        return null;
    }
}
function safeCloudPageUrl(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2_048)
        return null;
    try {
        const parsed = new URL(value);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username !== '' || parsed.password !== '' || parsed.search !== '' ||
            parsed.hash !== '' || !GROUPMATE_REMOTE_PAGE_PATH.test(parsed.pathname))
            return null;
        const wrappedHostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const hostname = wrappedHostname.startsWith('[') && wrappedHostname.endsWith(']')
            ? wrappedHostname.slice(1, -1)
            : wrappedHostname;
        if (hostname === '' || hostname.length > 253 || hostname === 'localhost' ||
            hostname.endsWith('.localhost'))
            return null;
        const family = isIP(hostname);
        if (family !== 0 && !isPublicNetworkAddress(hostname))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function safeRemoteRequest(value) {
    const parsed = revalidateGroupMatePictureRemoteRequest(value);
    if (parsed === null)
        return null;
    try {
        return Object.freeze({
            schemaVersion: 1,
            replyText: parsed.replyText,
            citations: Object.freeze(parsed.citations.map(citation => Object.freeze({
                title: citation.title,
                text: citation.text,
                ...(citation.sourceUrl === undefined ? {} : { sourceUrl: citation.sourceUrl })
            }))),
            reasoningView: parsed.reasoningView === null
                ? null
                : Object.freeze({
                    text: parsed.reasoningView.text,
                    truncated: parsed.reasoningView.truncated
                }),
            showQRCode: parsed.showQRCode
        });
    }
    catch {
        return null;
    }
}
function combineSignals(first, second) {
    if (second === undefined)
        return first;
    if (typeof AbortSignal.any === 'function')
        return AbortSignal.any([first, second]);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (first.aborted || second.aborted)
        controller.abort();
    else {
        first.addEventListener('abort', abort, { once: true });
        second.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}
function contentLengthAllowed(response, maximum) {
    const value = response.headers.get('content-length');
    if (value === null)
        return true;
    const normalized = value.trim();
    if (!/^(?:0|[1-9][0-9]*)$/.test(normalized))
        return false;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed <= maximum;
}
async function readBoundedBytes(response, maximum, signal) {
    const body = response.body;
    const cancelBody = () => {
        if (body === null || typeof body !== 'object')
            return;
        try {
            const cancel = body.cancel;
            if (typeof cancel === 'function')
                consumeCleanup(() => cancel.call(body));
        }
        catch { }
        try {
            if (Symbol.asyncIterator in body) {
                const iterator = body[Symbol.asyncIterator]();
                if (typeof iterator.return === 'function')
                    consumeCleanup(() => iterator.return());
            }
        }
        catch { }
    };
    if (signal.aborted) {
        cancelBody();
        return Object.freeze({ kind: 'aborted' });
    }
    try {
        if (!contentLengthAllowed(response, maximum)) {
            cancelBody();
            return Object.freeze({ kind: 'read', bytes: null });
        }
    }
    catch {
        cancelBody();
        return signal.aborted
            ? Object.freeze({ kind: 'aborted' })
            : Object.freeze({ kind: 'read', bytes: null });
    }
    if (body instanceof Uint8Array) {
        if (signal.aborted)
            return Object.freeze({ kind: 'aborted' });
        return Object.freeze({
            kind: 'read',
            bytes: body.byteLength <= maximum ? new Uint8Array(body) : null
        });
    }
    if (body !== null && typeof body === 'object' && Symbol.asyncIterator in body) {
        const chunks = [];
        let length = 0;
        let iterator;
        let cancelled = false;
        const cancel = () => {
            if (cancelled)
                return;
            cancelled = true;
            try {
                if (typeof iterator.return === 'function')
                    consumeCleanup(() => iterator.return());
            }
            catch { }
            try {
                const bodyCancel = body.cancel;
                if (typeof bodyCancel === 'function')
                    consumeCleanup(() => bodyCancel.call(body));
            }
            catch { }
        };
        try {
            iterator = body[Symbol.asyncIterator]();
            while (true) {
                const next = await settleBeforeAbort(async () => await iterator.next(), signal, cancel);
                if (next.kind === 'aborted')
                    return Object.freeze({ kind: 'aborted' });
                if (next.kind === 'rejected') {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                const item = next.value;
                if (item === null || typeof item !== 'object' || typeof item.done !== 'boolean') {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                if (item.done)
                    break;
                const chunk = item.value;
                const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? chunk : null;
                if (bytes === null) {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                length += bytes.byteLength;
                if (length > maximum) {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                chunks.push(new Uint8Array(bytes));
            }
        }
        catch {
            cancel();
            return signal.aborted
                ? Object.freeze({ kind: 'aborted' })
                : Object.freeze({ kind: 'read', bytes: null });
        }
        if (signal.aborted) {
            cancel();
            return Object.freeze({ kind: 'aborted' });
        }
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return Object.freeze({ kind: 'read', bytes: result });
    }
    if (body !== null && typeof body === 'object' &&
        typeof body.getReader === 'function') {
        let reader;
        try {
            reader = body.getReader();
        }
        catch {
            return Object.freeze({ kind: 'read', bytes: null });
        }
        const chunks = [];
        let length = 0;
        let cancelled = false;
        const cancel = () => {
            if (cancelled)
                return;
            cancelled = true;
            if (typeof reader.cancel === 'function')
                consumeCleanup(() => reader.cancel());
        };
        try {
            while (true) {
                const next = await settleBeforeAbort(async () => await reader.read(), signal, cancel);
                if (next.kind === 'aborted')
                    return Object.freeze({ kind: 'aborted' });
                if (next.kind === 'rejected') {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                if (next.value.done)
                    break;
                const bytes = next.value.value instanceof Uint8Array ? next.value.value : null;
                if (bytes === null) {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                length += bytes.byteLength;
                if (length > maximum) {
                    cancel();
                    return Object.freeze({ kind: 'read', bytes: null });
                }
                chunks.push(new Uint8Array(bytes));
            }
            if (signal.aborted) {
                cancel();
                return Object.freeze({ kind: 'aborted' });
            }
            const result = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return Object.freeze({ kind: 'read', bytes: result });
        }
        finally {
            try {
                reader.releaseLock?.();
            }
            catch { }
        }
    }
    return signal.aborted
        ? Object.freeze({ kind: 'aborted' })
        : Object.freeze({ kind: 'read', bytes: null });
}
function boundedWidth(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), 320), 1_920)
        : 1_280;
}
function boundedDpr(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, 0.5), 4)
        : 1;
}
export function createRemotePicturePagePort(input) {
    const origin = safeOrigin(input.baseUrl);
    if (origin === null)
        return null;
    const endpoint = `${origin}/groupmate/reply/v1`;
    const port = {
        async createPage(request, signal) {
            const projected = safeRemoteRequest(request);
            if (projected === null) {
                return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
            }
            let body;
            try {
                body = JSON.stringify(projected);
            }
            catch {
                return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
            }
            if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
                return Object.freeze({ kind: 'not_created', code: 'document_too_large' });
            }
            let timeout;
            try {
                timeout = (input.timeoutSignal ?? defaultTimeoutSignal)(5_000);
            }
            catch {
                return Object.freeze({ kind: 'not_created', code: 'remote_request_timeout' });
            }
            const exchangeSignal = combineSignals(timeout, signal);
            const fetched = await settleBeforeAbort(async () => await input.fetch(endpoint, {
                method: 'POST',
                headers: Object.freeze({ 'Content-Type': 'application/json' }),
                body,
                redirect: 'error',
                signal: exchangeSignal
            }), exchangeSignal);
            if (fetched.kind === 'aborted') {
                return Object.freeze({ kind: 'not_created', code: 'remote_request_timeout' });
            }
            if (fetched.kind === 'rejected') {
                return Object.freeze({ kind: 'not_created', code: 'remote_rejected' });
            }
            const response = fetched.value;
            let accepted = false;
            try {
                accepted = response.ok && response.status === 201;
            }
            catch { }
            if (exchangeSignal.aborted) {
                return Object.freeze({ kind: 'not_created', code: 'remote_request_timeout' });
            }
            if (!accepted) {
                return Object.freeze({ kind: 'not_created', code: 'remote_rejected' });
            }
            const read = await readBoundedBytes(response, 4 * 1024, exchangeSignal);
            if (read.kind === 'aborted' || exchangeSignal.aborted) {
                return Object.freeze({ kind: 'not_created', code: 'remote_request_timeout' });
            }
            if (read.bytes === null)
                return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
            const parsed = parseGroupMatePictureRemoteResponse(Buffer.from(read.bytes).toString('utf8'));
            if (parsed === null)
                return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
            try {
                const resolved = new URL(parsed.pagePath, origin);
                if (resolved.origin !== origin) {
                    return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
                }
                return Object.freeze({ kind: 'created', pageUrl: resolved.href });
            }
            catch {
                return Object.freeze({ kind: 'not_created', code: 'remote_contract_invalid' });
            }
        }
    };
    return Object.freeze(port);
}
function pngHeight(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value))
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR')
        return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? height : null;
}
export function createCloudScreenshotPort(input) {
    const origin = safeOrigin(input.baseUrl);
    if (origin === null)
        return null;
    const endpoint = `${origin}/screenshot`;
    const port = {
        async capture(request, signal) {
            const page = safeCloudPageUrl(request.pageUrl);
            if (page === null) {
                return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
            }
            const width = boundedWidth(request.width);
            const dpr = boundedDpr(request.deviceScaleFactor);
            const body = JSON.stringify({
                url: page.href,
                option: {
                    width,
                    height: 4096,
                    timeout: 120000,
                    waitUtil: 'networkidle2',
                    wait: 0,
                    func: 'document.documentElement.scrollHeight <= 4096',
                    dpr
                },
                type: 'image'
            });
            let timeout;
            try {
                timeout = (input.timeoutSignal ?? defaultTimeoutSignal)(120_000);
            }
            catch {
                return Object.freeze({ kind: 'not_rendered', code: 'render_timeout' });
            }
            const exchangeSignal = combineSignals(timeout, signal);
            const fetched = await settleBeforeAbort(async () => await input.fetch(endpoint, {
                method: 'POST',
                headers: Object.freeze({ 'Content-Type': 'application/json' }),
                body,
                redirect: 'error',
                signal: exchangeSignal
            }), exchangeSignal);
            if (fetched.kind === 'aborted') {
                return Object.freeze({ kind: 'not_rendered', code: 'render_timeout' });
            }
            if (fetched.kind === 'rejected') {
                return Object.freeze({ kind: 'not_rendered', code: 'cloud_renderer_unavailable' });
            }
            const response = fetched.value;
            let accepted = false;
            try {
                accepted = response.ok && response.status === 200;
            }
            catch { }
            if (exchangeSignal.aborted) {
                return Object.freeze({ kind: 'not_rendered', code: 'render_timeout' });
            }
            if (!accepted) {
                return Object.freeze({ kind: 'not_rendered', code: 'cloud_renderer_unavailable' });
            }
            const read = await readBoundedBytes(response, 8 * 1024 * 1024, exchangeSignal);
            if (read.kind === 'aborted' || exchangeSignal.aborted) {
                return Object.freeze({ kind: 'not_rendered', code: 'render_timeout' });
            }
            if (read.bytes === null)
                return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
            const height = pngHeight(read.bytes);
            if (height === null)
                return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
            if (height > Math.floor(4096 * dpr)) {
                return Object.freeze({ kind: 'not_rendered', code: 'height_limit' });
            }
            return Object.freeze({
                kind: 'rendered',
                source: 'remote_page_cloud_browser',
                resource: Object.freeze({
                    kind: 'buffer', data: read.bytes, mimeType: 'image/png', byteLength: read.bytes.byteLength
                })
            });
        }
    };
    return Object.freeze(port);
}
export function createRemoteGroupMatePictureRenderer(input) {
    const width = boundedWidth(input.chatViewWidth);
    return Object.freeze({
        async render(request, signal) {
            const projected = safeRemoteRequest({
                schemaVersion: 1,
                replyText: request.replyText,
                citations: request.citations,
                reasoningView: request.reasoningView,
                showQRCode: request.settings.showQRCode
            });
            if (projected === null) {
                return Object.freeze({ kind: 'not_rendered', code: 'remote_contract_invalid' });
            }
            let created;
            try {
                created = await input.page.createPage(projected, signal);
            }
            catch {
                return Object.freeze({ kind: 'not_rendered', code: 'remote_rejected' });
            }
            if (created.kind === 'not_created') {
                return Object.freeze({ kind: 'not_rendered', code: created.code });
            }
            const captureInput = Object.freeze({
                pageUrl: created.pageUrl,
                width,
                deviceScaleFactor: boundedDpr(request.settings.deviceScaleFactor),
                timeoutMs: 120000,
                maxContentHeightCssPx: 4096
            });
            if (input.cloud !== null) {
                if (safeCloudPageUrl(created.pageUrl) === null) {
                    return Object.freeze({ kind: 'not_rendered', code: 'remote_base_url_invalid' });
                }
                try {
                    const cloud = await input.cloud.capture(captureInput, signal);
                    if (cloud.kind === 'rendered') {
                        return Object.freeze({ ...cloud, source: 'remote_page_cloud_browser', pageUrl: created.pageUrl });
                    }
                }
                catch { }
            }
            try {
                const local = await input.localBrowser.capture(captureInput, signal);
                return local.kind === 'rendered'
                    ? Object.freeze({ ...local, source: 'remote_page_local_browser', pageUrl: created.pageUrl })
                    : local;
            }
            catch {
                return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
            }
        }
    });
}
