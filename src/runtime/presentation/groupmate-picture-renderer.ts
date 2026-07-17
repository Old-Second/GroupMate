import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolResource } from '../../tools/visible-tool-support.js'
import { validResource } from '../../tools/visible-tool-support.js'
import type { PicturePresentationSettings } from './presentation-settings.js'
import type { CitationForward, ReasoningView } from './reply-content.js'
import {
  renderGroupMateHtml,
  type GroupMatePictureDocumentV1,
  type PictureRenderResult
} from './groupmate-picture-contract.js'
import type { RemoteGroupMatePictureRenderer } from './remote-picture-renderer.js'

export type { PictureRenderResult } from './groupmate-picture-contract.js'

export interface BrowserPicturePort {
  render(input: {
    readonly html: string
    readonly viewport: { readonly width: number; readonly deviceScaleFactor: number }
    readonly maxContentHeightCssPx: 4096
    readonly timeoutMs: 120000
    readonly closeBrowserAfterRender: boolean
    /** Local-only adapter handshake. The port must load it and set the readiness flag. */
    readonly live2d: GroupMatePictureDocumentV1['live2d'] | null
    readonly live2dReadinessFlag: '__GROUPMATE_LIVE2D_READY__'
  }, signal?: AbortSignal): Promise<PictureRenderResult>
}

export interface GroupMatePictureRenderer {
  render(input: {
    readonly replyText: string
    readonly citations: readonly CitationForward[]
    readonly reasoningView: ReasoningView | null
    readonly settings: PicturePresentationSettings
  }, signal?: AbortSignal): Promise<PictureRenderResult>
}

export interface Live2dAssetResolver {
  resolve(modelPath: string): null | { readonly modelFileUrl: string }
}

let lowMemoryRenderTail: Promise<void> = Promise.resolve()
const LOW_MEMORY_RENDER_ABORTED = Symbol('low-memory-render-aborted')

async function waitForRenderSlot (
  previous: Promise<void>,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted === true) return false
  if (signal === undefined) {
    await previous
    return true
  }
  return await new Promise<boolean>(resolve => {
    let settled = false
    const finish = (acquired: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(acquired)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    previous.then(
      () => finish(true),
      () => finish(true)
    )
  })
}

async function runLowMemoryRender<T> (
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const previous = lowMemoryRenderTail
  let release!: () => void
  const own = new Promise<void>(resolve => { release = resolve })
  lowMemoryRenderTail = previous.then(() => own, () => own)
  if (!await waitForRenderSlot(previous, signal)) {
    void previous.then(release, release)
    throw LOW_MEMORY_RENDER_ABORTED
  }
  try {
    return await operation()
  } finally {
    release()
  }
}

function boundedDpr (value: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 0.5), 4)
    : 1
}

function boundedWidth (value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 320), 1_920)
    : 1_280
}

function safeRendered (
  value: PictureRenderResult,
  source?: Extract<PictureRenderResult, { kind: 'rendered' }>['source'],
  pageUrl?: string
): PictureRenderResult {
  if (value.kind === 'not_rendered') return value
  try {
    if (!validResource(value.resource, 8 * 1024 * 1024) ||
      value.resource.mimeType !== 'image/png') return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
    const resource: ToolResource = value.resource.kind === 'buffer'
      ? Object.freeze({
          kind: 'buffer', data: new Uint8Array(value.resource.data),
          mimeType: 'image/png', byteLength: value.resource.byteLength
        })
      : value.resource.kind === 'remote_url'
        ? Object.freeze({ ...value.resource })
        : Object.freeze({ ...value.resource })
    return Object.freeze({
      kind: 'rendered',
      resource,
      source: source ?? value.source,
      ...(pageUrl ?? value.pageUrl) === undefined ? {} : { pageUrl: pageUrl ?? value.pageUrl }
    }) as PictureRenderResult
  } catch {
    return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
  }
}

function withinRoot (root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function createLive2dAssetResolver (rootPath: string): Live2dAssetResolver {
  let root: string | null = null
  try {
    root = realpathSync(rootPath)
  } catch {}
  return Object.freeze({
    resolve (modelPath: string): null | { readonly modelFileUrl: string } {
      if (root === null || typeof modelPath !== 'string' || modelPath === '') return null
      let relative = modelPath
      if (relative.startsWith('/live2d/')) relative = relative.slice('/live2d/'.length)
      else if (path.isAbsolute(relative)) return null
      const segments = relative.split(/[\\/]/)
      if (segments.some(segment => segment === '..' || segment === '' || segment === '.')) return null
      if (!relative.endsWith('.model3.json')) return null
      try {
        const candidate = path.resolve(root, ...segments)
        if (!withinRoot(root, candidate)) return null
        const canonical = realpathSync(candidate)
        if (!withinRoot(root, canonical) || !statSync(canonical).isFile()) return null
        return Object.freeze({ modelFileUrl: pathToFileURL(canonical).href })
      } catch {
        return null
      }
    }
  })
}

function localDocument (
  input: Parameters<GroupMatePictureRenderer['render']>[0],
  live2dAssets: Live2dAssetResolver,
  includeLive2d: boolean
): GroupMatePictureDocumentV1 {
  const configured = includeLive2d && input.settings.live2d !== null
    ? live2dAssets.resolve(input.settings.live2d.modelPath)
    : null
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
  })
}

export function createGroupMatePictureRenderer (input: {
  readonly template: string
  readonly browser: BrowserPicturePort
  readonly remote: RemoteGroupMatePictureRenderer | null
  readonly live2dAssets: Live2dAssetResolver
  /** Private bootstrap adapter for legacy chatViewWidth; never part of PresentationSettings. */
  readonly chatViewWidth?: unknown | (() => unknown)
  /** Safe display-only legacy settings; never enter the remote request contract. */
  readonly appearance?: unknown | (() => unknown)
}): GroupMatePictureRenderer {
  const renderer: GroupMatePictureRenderer = {
    async render (request, signal): Promise<PictureRenderResult> {
      try {
        return await runLowMemoryRender(async () => {
          if (signal?.aborted === true) return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
          const remoteRequestBytes = Buffer.byteLength(JSON.stringify({
            schemaVersion: 1,
            replyText: request.replyText,
            citations: request.citations,
            reasoningView: request.reasoningView,
            showQRCode: request.settings.showQRCode
          }), 'utf8')
          if (remoteRequestBytes > 64 * 1024) {
            return Object.freeze({ kind: 'not_rendered', code: 'document_too_large' })
          }
          if (input.remote !== null) {
            try {
              const remote = safeRendered(await input.remote.render(request, signal))
              if (remote.kind === 'rendered') return remote
            } catch {}
          }

          const renderLocal = async (includeLive2d: boolean): Promise<PictureRenderResult> => {
            let html: string
            const document = localDocument(request, input.live2dAssets, includeLive2d)
            try {
              html = renderGroupMateHtml(
                input.template,
                document,
                typeof input.appearance === 'function'
                  ? input.appearance()
                  : input.appearance
              )
            } catch {
              return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
            }
            try {
              const width = boundedWidth(
                typeof input.chatViewWidth === 'function'
                  ? input.chatViewWidth()
                  : input.chatViewWidth
              )
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
              }, signal), 'local')
            } catch {
              return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
            }
          }

          const withDecoration = await renderLocal(true)
          if (withDecoration.kind === 'not_rendered' && withDecoration.code === 'live2d_unavailable' &&
            request.settings.live2d !== null) return await renderLocal(false)
          return withDecoration
        }, signal)
      } catch (error) {
        if (error === LOW_MEMORY_RENDER_ABORTED) {
          return Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
        }
        throw error
      }
    }
  }
  return Object.freeze(renderer)
}

export const UNAVAILABLE_GROUPMATE_PICTURE_RENDERER: GroupMatePictureRenderer = Object.freeze({
  render: async () => Object.freeze({ kind: 'not_rendered', code: 'local_renderer_unavailable' })
})
