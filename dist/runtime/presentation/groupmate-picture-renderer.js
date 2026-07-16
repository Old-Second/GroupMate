import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validResource } from '../../tools/visible-tool-support.js';
import { renderGroupMateHtml } from './groupmate-picture-contract.js';
let lowMemoryRenderTail = Promise.resolve();
async function runLowMemoryRender(operation) {
    const previous = lowMemoryRenderTail;
    let release;
    lowMemoryRenderTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
    }
}
function boundedDpr(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, 0.5), 4)
        : 1;
}
function boundedWidth(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), 320), 1_920)
        : 1_280;
}
function safeRendered(value, source, pageUrl) {
    if (value.kind === 'not_rendered')
        return value;
    try {
        if (!validResource(value.resource, 8 * 1024 * 1024) ||
            value.resource.mimeType !== 'image/png')
            return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
        const resource = value.resource.kind === 'buffer'
            ? Object.freeze({
                kind: 'buffer', data: new Uint8Array(value.resource.data),
                mimeType: 'image/png', byteLength: value.resource.byteLength
            })
            : value.resource.kind === 'remote_url'
                ? Object.freeze({ ...value.resource })
                : Object.freeze({ ...value.resource });
        return Object.freeze({
            kind: 'rendered',
            resource,
            source: source ?? value.source,
            ...(pageUrl ?? value.pageUrl) === undefined ? {} : { pageUrl: pageUrl ?? value.pageUrl }
        });
    }
    catch {
        return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
    }
}
function withinRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function createLive2dAssetResolver(rootPath) {
    let root = null;
    try {
        root = realpathSync(rootPath);
    }
    catch { }
    return Object.freeze({
        resolve(modelPath) {
            if (root === null || typeof modelPath !== 'string' || modelPath === '')
                return null;
            let relative = modelPath;
            if (relative.startsWith('/live2d/'))
                relative = relative.slice('/live2d/'.length);
            else if (path.isAbsolute(relative))
                return null;
            const segments = relative.split(/[\\/]/);
            if (segments.some(segment => segment === '..' || segment === '' || segment === '.'))
                return null;
            if (!relative.endsWith('.model3.json'))
                return null;
            try {
                const candidate = path.resolve(root, ...segments);
                if (!withinRoot(root, candidate))
                    return null;
                const canonical = realpathSync(candidate);
                if (!withinRoot(root, canonical) || !statSync(canonical).isFile())
                    return null;
                return Object.freeze({ modelFileUrl: pathToFileURL(canonical).href });
            }
            catch {
                return null;
            }
        }
    });
}
function localDocument(input, live2dAssets, includeLive2d) {
    const configured = includeLive2d && input.settings.live2d !== null
        ? live2dAssets.resolve(input.settings.live2d.modelPath)
        : null;
    return Object.freeze({
        schemaVersion: 1,
        replyText: input.replyText,
        citations: Object.freeze([...input.citations]),
        reasoningView: input.reasoningView,
        showQRCode: false,
        ...(configured === null || input.settings.live2d === null
            ? {}
            : {
                live2d: Object.freeze({
                    modelFileUrl: configured.modelFileUrl,
                    scale: input.settings.live2d.scale,
                    positionX: input.settings.live2d.positionX,
                    positionY: input.settings.live2d.positionY,
                    rotation: input.settings.live2d.rotation,
                    alpha: input.settings.live2d.alpha
                })
            })
    });
}
export function createGroupMatePictureRenderer(input) {
    const width = boundedWidth(input.chatViewWidth);
    const renderer = {
        async render(request, signal) {
            return await runLowMemoryRender(async () => {
                if (signal?.aborted === true)
                    return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
                const remoteRequestBytes = Buffer.byteLength(JSON.stringify({
                    schemaVersion: 1,
                    replyText: request.replyText,
                    citations: request.citations,
                    reasoningView: request.reasoningView,
                    showQRCode: request.settings.showQRCode
                }), 'utf8');
                if (remoteRequestBytes > 64 * 1024) {
                    return Object.freeze({ kind: 'not_rendered', code: 'document_too_large' });
                }
                if (input.remote !== null) {
                    try {
                        const remote = safeRendered(await input.remote.render(request, signal));
                        if (remote.kind === 'rendered')
                            return remote;
                    }
                    catch { }
                }
                const renderLocal = async (includeLive2d) => {
                    let html;
                    const document = localDocument(request, input.live2dAssets, includeLive2d);
                    try {
                        html = renderGroupMateHtml(input.template, document);
                    }
                    catch {
                        return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
                    }
                    try {
                        return safeRendered(await input.browser.render({
                            html,
                            viewport: Object.freeze({
                                width,
                                deviceScaleFactor: boundedDpr(request.settings.deviceScaleFactor)
                            }),
                            maxContentHeightCssPx: 4096,
                            timeoutMs: 120000,
                            closeBrowserAfterRender: request.settings.closeBrowserAfterRender,
                            live2d: document.live2d ?? null,
                            live2dReadinessFlag: '__GROUPMATE_LIVE2D_READY__'
                        }, signal), 'local');
                    }
                    catch {
                        return Object.freeze({ kind: 'not_rendered', code: 'render_failed' });
                    }
                };
                const withDecoration = await renderLocal(true);
                if (withDecoration.kind === 'not_rendered' && withDecoration.code === 'live2d_unavailable' &&
                    request.settings.live2d !== null)
                    return await renderLocal(false);
                return withDecoration;
            });
        }
    };
    return Object.freeze(renderer);
}
export const UNAVAILABLE_GROUPMATE_PICTURE_RENDERER = Object.freeze({
    render: async () => Object.freeze({ kind: 'not_rendered', code: 'local_renderer_unavailable' })
});
