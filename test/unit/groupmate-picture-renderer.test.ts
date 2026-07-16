import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { PicturePresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import {
  createGroupMatePictureRenderer,
  createLive2dAssetResolver,
  type BrowserPicturePort
} from '../../src/runtime/presentation/groupmate-picture-renderer.js'
import {
  createCloudScreenshotPort,
  createRemoteGroupMatePictureRenderer,
  createRemotePicturePagePort,
  type CloudScreenshotPort,
  type RemotePageBrowserPort
} from '../../src/runtime/presentation/remote-picture-renderer.js'

const template = '<script type="application/json"><!--__GROUPMATE_DOCUMENT__--></script><script><!--__GROUPMATE_QR_SCRIPT__--></script>'
const png = Object.freeze({
  kind: 'buffer' as const,
  data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]),
  mimeType: 'image/png',
  byteLength: 24
})

function settings (overrides: Partial<PicturePresentationSettings> = {}): PicturePresentationSettings {
  return Object.freeze({
    userEnabled: true,
    autoEnabled: true,
    autoThreshold: 1,
    deviceScaleFactor: 1,
    closeBrowserAfterRender: true,
    showQRCode: true,
    live2d: null,
    ...overrides
  })
}

function renderInput (picture = settings()) {
  return Object.freeze({
    replyText: '最终回复',
    citations: Object.freeze([]),
    reasoningView: null,
    settings: picture
  })
}

test('local picture rendering works with toolbox disabled and enforces 4096px', async () => {
  const calls: unknown[] = []
  const browser: BrowserPicturePort = {
    render: async input => {
      calls.push(input)
      return { kind: 'rendered', resource: png, source: 'local' }
    }
  }
  const renderer = createGroupMatePictureRenderer({
    template,
    browser,
    remote: null,
    chatViewWidth: 777.9,
    live2dAssets: { resolve: () => null }
  })
  const result = await renderer.render(renderInput(settings({ deviceScaleFactor: 8 })))
  assert.equal(result.kind, 'rendered')
  assert.equal(calls.length, 1)
  const call = calls[0] as {
    html: string
    viewport: { width: number; deviceScaleFactor: number }
    maxContentHeightCssPx: number
    timeoutMs: number
    closeBrowserAfterRender: boolean
  }
  assert.match(call.html, /最终回复/)
  assert.deepEqual(call.viewport, { width: 777, deviceScaleFactor: 4 })
  assert.equal(call.maxContentHeightCssPx, 4096)
  assert.equal(call.timeoutMs, 120000)
  assert.equal(call.closeBrowserAfterRender, true)
})

test('Live2D stays local and rejects traversal outside static live2d', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'groupmate-live2d-'))
  const modelDir = path.join(root, 'safe')
  const outside = path.join(root, '..', 'outside.model3.json')
  await mkdir(modelDir)
  await writeFile(path.join(modelDir, 'safe.model3.json'), '{}')
  await writeFile(outside, '{}')
  await symlink(outside, path.join(modelDir, 'escape.model3.json'))
  const resolver = createLive2dAssetResolver(root)
  assert.match(resolver.resolve('/live2d/safe/safe.model3.json')?.modelFileUrl ?? '', /^file:/)
  assert.equal(resolver.resolve('../outside.model3.json'), null)
  assert.equal(resolver.resolve(path.resolve(outside)), null)
  assert.equal(resolver.resolve('/live2d/safe/escape.model3.json'), null)
  assert.equal(resolver.resolve('/live2d/safe/not-model.json'), null)

  const htmls: string[] = []
  const decorations: unknown[] = []
  const renderer = createGroupMatePictureRenderer({
    template,
    remote: null,
    live2dAssets: resolver,
    browser: {
      render: async input => {
        htmls.push(input.html)
        decorations.push(input.live2d)
        assert.equal(input.live2dReadinessFlag, '__GROUPMATE_LIVE2D_READY__')
        return htmls.length === 1
          ? { kind: 'not_rendered', code: 'live2d_unavailable' }
          : { kind: 'rendered', resource: png, source: 'local' }
      }
    }
  })
  const result = await renderer.render(renderInput(settings({
    live2d: {
      modelPath: '/live2d/safe/safe.model3.json', scale: 1, positionX: 0,
      positionY: 0, rotation: 0, alpha: 1
    }
  })))
  assert.equal(result.kind, 'rendered')
  assert.equal(htmls.length, 2)
  assert.match(htmls[0] ?? '', /safe\.model3\.json/)
  assert.doesNotMatch(htmls[1] ?? '', /safe\.model3\.json/)
  assert.deepEqual(decorations[0], {
    modelFileUrl: resolver.resolve('/live2d/safe/safe.model3.json')?.modelFileUrl,
    scale: 1, positionX: 0, positionY: 0, rotation: 0, alpha: 1
  })
  assert.equal(decorations[1], null)
})

test('remote page uses fixed route timeout redirect origin and size policies', async () => {
  const captures: Array<{ url: string; init: unknown }> = []
  const timeoutCalls: number[] = []
  const page = createRemotePicturePagePort({
    baseUrl: 'https://render.example/base?ignored=no',
    fetch: async (url, init) => {
      captures.push({ url, init })
      return {
        ok: true,
        status: 201,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
        body: Buffer.from(JSON.stringify({
          schemaVersion: 1,
          pagePath: `/groupmate/reply/v1/${'b'.repeat(32)}`,
          expiresInSeconds: 600
        }))
      }
    }
  })
  assert.equal(page, null, 'query-bearing base URL must be rejected')
  const safePage = createRemotePicturePagePort({
    baseUrl: 'https://render.example',
    timeoutSignal: milliseconds => {
      timeoutCalls.push(milliseconds)
      return new AbortController().signal
    },
    fetch: async (url, init) => {
      captures.push({ url, init })
      return {
        ok: true,
        status: 201,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
        body: Buffer.from(JSON.stringify({
          schemaVersion: 1,
          pagePath: `/groupmate/reply/v1/${'b'.repeat(32)}`,
          expiresInSeconds: 600
        }))
      }
    }
  })
  assert.notEqual(safePage, null)
  const created = await safePage?.createPage({
    schemaVersion: 1, replyText: '安全正文', citations: [], reasoningView: null, showQRCode: true
  })
  assert.deepEqual(created, {
    kind: 'created', pageUrl: `https://render.example/groupmate/reply/v1/${'b'.repeat(32)}`
  })
  assert.equal(captures[0]?.url, 'https://render.example/groupmate/reply/v1')
  const pageInit = captures[0]?.init as {
    method: string
    redirect: string
    headers: Record<string, string>
    body: string
  }
  assert.equal(pageInit.method, 'POST')
  assert.equal(pageInit.redirect, 'error')
  assert.deepEqual(timeoutCalls, [5_000])
  assert.equal(pageInit.headers.Authorization, undefined)
  assert.equal(Buffer.byteLength(pageInit.body), Buffer.byteLength(JSON.stringify({
    schemaVersion: 1, replyText: '安全正文', citations: [], reasoningView: null, showQRCode: true
  })))
  assert.doesNotMatch(pageInit.body, /actorId|prompt|cookie|apiKey|hooks/)

  for (const body of [
    Buffer.alloc(4_097, 120),
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      pagePath: `//evil.invalid/groupmate/reply/v1/${'b'.repeat(32)}`,
      expiresInSeconds: 600
    }))
  ]) {
    const rejected = createRemotePicturePagePort({
      baseUrl: 'https://render.example',
      fetch: async () => ({
        ok: true, status: 201, headers: { get: () => null }, body
      })
    })
    assert.deepEqual(await rejected?.createPage({
      schemaVersion: 1, replyText: '安全正文', citations: [], reasoningView: null,
      showQRCode: true
    }), { kind: 'not_created', code: 'remote_contract_invalid' })
  }
})

test('remote picture adapters reject invalid nested fields before crossing either port', async () => {
  const secret = 'NESTED-SECRET-MUST-NOT-CROSS'
  const invalidRequests = [
    {
      schemaVersion: 1,
      replyText: '安全正文',
      citations: [{ title: '来源', text: '引用', apiKey: secret }],
      reasoningView: null,
      showQRCode: true
    },
    {
      schemaVersion: 1,
      replyText: '安全正文',
      citations: [],
      reasoningView: { text: '推理', truncated: false, prompt: secret },
      showQRCode: true
    },
    {
      schemaVersion: 1,
      replyText: '安全正文',
      citations: [new Proxy({ title: '来源', text: '引用' }, {
        ownKeys: () => { throw new Error('hostile citation proxy') }
      })],
      reasoningView: null,
      showQRCode: true
    },
    {
      schemaVersion: 1,
      replyText: '安全正文',
      citations: [],
      reasoningView: new Proxy({ text: '推理', truncated: false }, {
        ownKeys: () => { throw new Error('hostile reasoning proxy') }
      }),
      showQRCode: true
    }
  ]

  for (const invalid of invalidRequests) {
    let fetchCalls = 0
    const bodies: string[] = []
    const page = createRemotePicturePagePort({
      baseUrl: 'https://render.example',
      fetch: async (_url, init) => {
        fetchCalls++
        bodies.push(init.body)
        return {
          ok: true,
          status: 201,
          headers: { get: () => null },
          body: Buffer.from(JSON.stringify({
            schemaVersion: 1,
            pagePath: `/groupmate/reply/v1/${'e'.repeat(32)}`,
            expiresInSeconds: 600
          }))
        }
      }
    })
    assert.deepEqual(await page?.createPage(invalid as never), {
      kind: 'not_created', code: 'remote_contract_invalid'
    })
    assert.equal(fetchCalls, 0)
    assert.equal(bodies.length, 0)

    let createPageCalls = 0
    const pageInputs: unknown[] = []
    let cloudCalls = 0
    let localCalls = 0
    const renderer = createRemoteGroupMatePictureRenderer({
      page: {
        createPage: async value => {
          createPageCalls++
          pageInputs.push(value)
          return { kind: 'not_created', code: 'remote_rejected' }
        }
      },
      cloud: {
        capture: async () => {
          cloudCalls++
          return { kind: 'rendered', resource: png, source: 'remote_page_cloud_browser' }
        }
      },
      localBrowser: {
        capture: async () => {
          localCalls++
          return { kind: 'rendered', resource: png, source: 'remote_page_local_browser' }
        }
      }
    })
    const result = await renderer.render({
      replyText: invalid.replyText,
      citations: invalid.citations,
      reasoningView: invalid.reasoningView,
      settings: settings()
    } as never)
    assert.deepEqual(result, { kind: 'not_rendered', code: 'remote_contract_invalid' })
    assert.equal(createPageCalls, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(localCalls, 0)
    assert.doesNotMatch(JSON.stringify({ bodies, pageInputs }), new RegExp(secret))
  }
})

test('arrayBuffer-only picture responses fail closed before unbounded allocation', async () => {
  const pageBody = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    pagePath: `/groupmate/reply/v1/${'d'.repeat(32)}`,
    expiresInSeconds: 600
  }))
  const pageCases = [
    { contentLength: null, bytes: pageBody },
    { contentLength: String(pageBody.byteLength), bytes: pageBody },
    { contentLength: '1', bytes: Buffer.alloc(4 * 1024 + 1) },
    { contentLength: '-1', bytes: pageBody },
    { contentLength: 'NaN', bytes: pageBody },
    { contentLength: String(4 * 1024 + 1), bytes: pageBody }
  ]
  for (const item of pageCases) {
    let arrayBufferCalls = 0
    const response = {
      ok: true,
      status: 201,
      headers: { get: () => item.contentLength },
      body: Object.freeze({}),
      arrayBuffer: async () => {
        arrayBufferCalls++
        return new Uint8Array(item.bytes).buffer
      }
    }
    const page = createRemotePicturePagePort({
      baseUrl: 'https://render.example',
      fetch: async () => response
    })
    assert.deepEqual(await page?.createPage({
      schemaVersion: 1,
      replyText: '安全正文',
      citations: [],
      reasoningView: null,
      showQRCode: true
    }), { kind: 'not_created', code: 'remote_contract_invalid' })
    assert.equal(arrayBufferCalls, 0, String(item.contentLength))
  }

  const cloudCases = [
    { contentLength: null, bytes: Buffer.from(png.data) },
    { contentLength: String(png.byteLength), bytes: Buffer.from(png.data) },
    { contentLength: '1', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
    { contentLength: '-1', bytes: Buffer.from(png.data) },
    { contentLength: 'NaN', bytes: Buffer.from(png.data) },
    { contentLength: String(8 * 1024 * 1024 + 1), bytes: Buffer.from(png.data) }
  ]
  for (const item of cloudCases) {
    let arrayBufferCalls = 0
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => item.contentLength },
      body: Object.freeze({}),
      arrayBuffer: async () => {
        arrayBufferCalls++
        return new Uint8Array(item.bytes).buffer
      }
    }
    const cloud = createCloudScreenshotPort({
      baseUrl: 'https://capture.example',
      fetch: async () => response
    })
    assert.deepEqual(await cloud?.capture({
      pageUrl: 'https://93.184.216.34/groupmate/reply/v1/' + 'd'.repeat(32),
      width: 320,
      deviceScaleFactor: 1,
      timeoutMs: 120000,
      maxContentHeightCssPx: 4096
    }), { kind: 'not_rendered', code: 'render_failed' })
    assert.equal(arrayBufferCalls, 0, String(item.contentLength))
  }
})

test('remote picture exchanges own timeout through body read and release the render queue', async () => {
  const pageResponseBody = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    pagePath: `/groupmate/reply/v1/${'f'.repeat(32)}`,
    expiresInSeconds: 600
  }))
  const pageRequest = {
    schemaVersion: 1 as const,
    replyText: '安全正文',
    citations: Object.freeze([]),
    reasoningView: null,
    showQRCode: true
  }
  const captureRequest = {
    pageUrl: `https://93.184.216.34/groupmate/reply/v1/${'f'.repeat(32)}`,
    width: 320,
    deviceScaleFactor: 1,
    timeoutMs: 120000 as const,
    maxContentHeightCssPx: 4096 as const
  }
  const preAborted = new AbortController()
  preAborted.abort()
  let prePageFetchCalls = 0
  const prePage = createRemotePicturePagePort({
    baseUrl: 'https://render.example',
    timeoutSignal: () => preAborted.signal,
    fetch: async () => {
      prePageFetchCalls++
      return { ok: true, status: 201, headers: { get: () => null }, body: pageResponseBody }
    }
  })
  assert.deepEqual(await prePage?.createPage(pageRequest), {
    kind: 'not_created', code: 'remote_request_timeout'
  })
  assert.equal(prePageFetchCalls, 0)

  let preCloudFetchCalls = 0
  const preCloud = createCloudScreenshotPort({
    baseUrl: 'https://capture.example',
    timeoutSignal: () => preAborted.signal,
    fetch: async () => {
      preCloudFetchCalls++
      return { ok: true, status: 200, headers: { get: () => null }, body: Buffer.from(png.data) }
    }
  })
  assert.deepEqual(await preCloud?.capture(captureRequest), {
    kind: 'not_rendered', code: 'render_timeout'
  })
  assert.equal(preCloudFetchCalls, 0)

  function hangingBody () {
    let resolveNext!: (value: IteratorResult<Uint8Array, undefined>) => void
    let rejectNext!: (reason: unknown) => void
    const nextResult = new Promise<IteratorResult<Uint8Array, undefined>>((resolve, reject) => {
      resolveNext = resolve
      rejectNext = reject
    })
    const stats = { nextCalls: 0, returnCalls: 0 }
    const iterator: AsyncIterator<Uint8Array, undefined> = {
      next: async () => {
        stats.nextCalls++
        return await nextResult
      },
      return: async () => {
        stats.returnCalls++
        return { done: true, value: undefined }
      }
    }
    return {
      body: { [Symbol.asyncIterator]: () => iterator },
      stats,
      resolveNext,
      rejectNext
    }
  }

  async function beforeImmediate<T> (promise: Promise<T>) {
    return await Promise.race([
      promise.then(value => ({ kind: 'value' as const, value })),
      new Promise<{ readonly kind: 'sentinel' }>(resolve => {
        setImmediate(() => resolve({ kind: 'sentinel' }))
      })
    ])
  }

  const pageTimeout = new AbortController()
  const latePageResponse = {
    ok: true,
    status: 201,
    headers: { get: () => null },
    body: pageResponseBody
  }
  let resolvePageFetch!: (value: typeof latePageResponse) => void
  const pageFetch = new Promise<typeof latePageResponse>(resolve => {
    resolvePageFetch = resolve
  })
  let pageFetchCalls = 0
  const page = createRemotePicturePagePort({
    baseUrl: 'https://render.example',
    timeoutSignal: () => pageTimeout.signal,
    fetch: async () => {
      pageFetchCalls++
      return await pageFetch
    }
  })
  const pendingPage = page?.createPage(pageRequest) as Promise<unknown>
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(pageFetchCalls, 1)
  pageTimeout.abort()
  const pageSettlement = await beforeImmediate(pendingPage)
  resolvePageFetch(latePageResponse)
  if (pageSettlement.kind === 'sentinel') await pendingPage
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(pageSettlement.kind, 'value')
  assert.deepEqual(pageSettlement.kind === 'value' ? pageSettlement.value : null, {
    kind: 'not_created', code: 'remote_request_timeout'
  })
  assert.equal(pageFetchCalls, 1)

  const cloudTimeout = new AbortController()
  const hangingCloud = hangingBody()
  let cloudFetchCalls = 0
  const cloud = createCloudScreenshotPort({
    baseUrl: 'https://capture.example',
    timeoutSignal: () => cloudTimeout.signal,
    fetch: async () => {
      cloudFetchCalls++
      return { ok: true, status: 200, headers: { get: () => null }, body: hangingCloud.body }
    }
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const pendingCloud = cloud?.capture(captureRequest) as Promise<unknown>
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(hangingCloud.stats.nextCalls, 1)
    cloudTimeout.abort()
    const cloudSettlement = await beforeImmediate(pendingCloud)
    hangingCloud.rejectNext(new Error('late cloud body failure'))
    if (cloudSettlement.kind === 'sentinel') await pendingCloud
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(cloudSettlement.kind, 'value')
    assert.deepEqual(cloudSettlement.kind === 'value' ? cloudSettlement.value : null, {
      kind: 'not_rendered', code: 'render_timeout'
    })
    assert.equal(cloudFetchCalls, 1)
    assert.equal(hangingCloud.stats.returnCalls, 1)
    assert.equal(unhandled.length, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }

  const queueTimeout = new AbortController()
  const queueBody = hangingBody()
  let queueFetchCalls = 0
  const queuePage = createRemotePicturePagePort({
    baseUrl: 'https://render.example',
    timeoutSignal: () => queueTimeout.signal,
    fetch: async () => {
      queueFetchCalls++
      return { ok: true, status: 201, headers: { get: () => null }, body: queueBody.body }
    }
  })
  assert.notEqual(queuePage, null)
  let outerLocalCalls = 0
  const outer = createGroupMatePictureRenderer({
    template,
    live2dAssets: { resolve: () => null },
    remote: createRemoteGroupMatePictureRenderer({
      page: queuePage!,
      cloud: null,
      localBrowser: {
        capture: async () => ({ kind: 'not_rendered', code: 'render_failed' })
      }
    }),
    browser: {
      render: async () => {
        outerLocalCalls++
        return { kind: 'rendered', resource: png, source: 'local' }
      }
    }
  })
  const firstRender = outer.render(renderInput())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(queueBody.stats.nextCalls, 1)
  queueTimeout.abort()
  const firstRenderSettlement = await beforeImmediate(firstRender)
  queueBody.resolveNext({ done: true, value: undefined })
  if (firstRenderSettlement.kind === 'sentinel') await firstRender
  assert.equal(firstRenderSettlement.kind, 'value')
  const secondRenderSettlement = await beforeImmediate(outer.render(renderInput()))
  assert.equal(secondRenderSettlement.kind, 'value')
  assert.equal(queueFetchCalls, 1)
  assert.equal(queueBody.stats.returnCalls, 1)
  assert.equal(outerLocalCalls, 2)
})

test('remote failure falls back through local render to text at most once', async () => {
  let remoteCalls = 0
  let localCalls = 0
  const renderer = createGroupMatePictureRenderer({
    template,
    live2dAssets: { resolve: () => null },
    remote: {
      render: async () => {
        remoteCalls++
        return { kind: 'not_rendered', code: 'remote_rejected' }
      }
    },
    browser: {
      render: async () => {
        localCalls++
        return { kind: 'not_rendered', code: 'render_failed' }
      }
    }
  })
  assert.deepEqual(await renderer.render(renderInput()), { kind: 'not_rendered', code: 'render_failed' })
  assert.equal(remoteCalls, 1)
  assert.equal(localCalls, 1)
})

test('cloud screenshot failure falls back to local browser without duplicate delivery', async () => {
  let cloudCalls = 0
  let browserCalls = 0
  const cloud: CloudScreenshotPort = {
    capture: async () => {
      cloudCalls++
      return { kind: 'not_rendered', code: 'cloud_renderer_unavailable' }
    }
  }
  const browser: RemotePageBrowserPort = {
    capture: async input => {
      browserCalls++
      assert.match(input.pageUrl, /^https:\/\/render\.example\//)
      return { kind: 'rendered', resource: png, source: 'remote_page_local_browser' }
    }
  }
  const renderer = createRemoteGroupMatePictureRenderer({
    page: {
      createPage: async () => ({
        kind: 'created', pageUrl: `https://render.example/groupmate/reply/v1/${'c'.repeat(32)}`
      })
    },
    localBrowser: browser,
    cloud
  })
  const result = await renderer.render(renderInput())
  assert.equal(result.kind, 'rendered')
  assert.equal(cloudCalls, 1)
  assert.equal(browserCalls, 1)
})

test('cloud renderer never receives loopback or noncanonical remote page URLs', async () => {
  const unsafeCloudPages = [
    'https://localhost/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://service.localhost/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://127.0.0.1/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://127.1/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://2130706433/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://0177.0.0.1/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://[::1]/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://[::ffff:127.0.0.1]/groupmate/reply/v1/' + 'a'.repeat(32),
    'https://93.184.216.34/groupmate/reply/v1/' + 'a'.repeat(32) + '?apiKey=secret',
    'https://93.184.216.34/groupmate/reply/v1/' + 'a'.repeat(32) + '#secret',
    'https://93.184.216.34/not-groupmate/' + 'a'.repeat(32)
  ]
  for (const pageUrl of unsafeCloudPages) {
    let cloudCalls = 0
    let remotePageLocalCalls = 0
    let outerLocalCalls = 0
    const remote = createRemoteGroupMatePictureRenderer({
      page: { createPage: async () => ({ kind: 'created', pageUrl }) },
      cloud: {
        capture: async () => {
          cloudCalls++
          return { kind: 'rendered', resource: png, source: 'remote_page_cloud_browser' }
        }
      },
      localBrowser: {
        capture: async () => {
          remotePageLocalCalls++
          return { kind: 'rendered', resource: png, source: 'remote_page_local_browser' }
        }
      }
    })
    const renderer = createGroupMatePictureRenderer({
      template,
      remote,
      live2dAssets: { resolve: () => null },
      browser: {
        render: async input => {
          outerLocalCalls++
          assert.doesNotMatch(input.html, new RegExp(pageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
          assert.match(input.html, /"showQRCode":false/)
          return { kind: 'rendered', resource: png, source: 'local' }
        }
      }
    })
    const result = await renderer.render(renderInput(settings({ showQRCode: true })))
    assert.equal(result.kind, 'rendered', pageUrl)
    assert.equal(result.kind === 'rendered' ? result.source : null, 'local', pageUrl)
    assert.equal(cloudCalls, 0, pageUrl)
    assert.equal(remotePageLocalCalls, 0, pageUrl)
    assert.equal(outerLocalCalls, 1, pageUrl)
  }

  let publicCloudCalls = 0
  let publicLocalCalls = 0
  const publicRenderer = createRemoteGroupMatePictureRenderer({
    page: {
      createPage: async () => ({
        kind: 'created',
        pageUrl: `https://93.184.216.34/groupmate/reply/v1/${'b'.repeat(32)}`
      })
    },
    cloud: {
      capture: async () => {
        publicCloudCalls++
        return { kind: 'rendered', resource: png, source: 'remote_page_cloud_browser' }
      }
    },
    localBrowser: {
      capture: async () => {
        publicLocalCalls++
        return { kind: 'rendered', resource: png, source: 'remote_page_local_browser' }
      }
    }
  })
  const publicResult = await publicRenderer.render(renderInput())
  assert.equal(publicResult.kind === 'rendered' ? publicResult.source : null, 'remote_page_cloud_browser')
  assert.equal(publicCloudCalls, 1)
  assert.equal(publicLocalCalls, 0)
})

test('cloud capture accepts only an exact public GroupMate page path', async () => {
  const bodies: string[] = []
  let fetchCalls = 0
  const cloud = createCloudScreenshotPort({
    baseUrl: 'https://capture.example',
    fetch: async (_url, init) => {
      fetchCalls++
      bodies.push(init.body)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: Buffer.from(png.data)
      }
    }
  })
  const unsafePages = [
    `https://93.184.216.34/groupmate/reply/v1/${'a'.repeat(32)}?apiKey=secret`,
    `https://93.184.216.34/groupmate/reply/v1/${'a'.repeat(32)}#secret`,
    `https://93.184.216.34/wrong/${'a'.repeat(32)}`,
    `https://127.0.0.1/groupmate/reply/v1/${'a'.repeat(32)}`
  ]
  for (const pageUrl of unsafePages) {
    assert.deepEqual(await cloud?.capture({
      pageUrl,
      width: 320,
      deviceScaleFactor: 1,
      timeoutMs: 120000,
      maxContentHeightCssPx: 4096
    }), { kind: 'not_rendered', code: 'render_failed' })
  }
  assert.equal(fetchCalls, 0)
  assert.doesNotMatch(JSON.stringify(bodies), /apiKey|secret/)
})

test('picture settings preserve auto DPR browser release QR and local Live2D behavior', async () => {
  const calls: Array<Record<string, unknown>> = []
  const renderer = createGroupMatePictureRenderer({
    template,
    remote: null,
    live2dAssets: { resolve: () => ({ modelFileUrl: 'file:///safe/model.model3.json' }) },
    browser: {
      render: async input => {
        calls.push(input as unknown as Record<string, unknown>)
        return { kind: 'rendered', resource: png, source: 'local' }
      }
    }
  })
  await renderer.render(renderInput(settings({
    deviceScaleFactor: 0.1,
    closeBrowserAfterRender: true,
    showQRCode: true,
    live2d: {
      modelPath: '/live2d/model.model3.json', scale: 1, positionX: 2,
      positionY: 3, rotation: 4, alpha: 0.5
    }
  })))
  assert.equal((calls[0]?.viewport as { deviceScaleFactor: number }).deviceScaleFactor, 0.5)
  assert.equal(calls[0]?.closeBrowserAfterRender, true)
  assert.deepEqual(calls[0]?.live2d, {
    modelFileUrl: 'file:///safe/model.model3.json',
    scale: 1, positionX: 2, positionY: 3, rotation: 4, alpha: 0.5
  })
  assert.equal(calls[0]?.live2dReadinessFlag, '__GROUPMATE_LIVE2D_READY__')
  assert.match(String(calls[0]?.html), /file:\/\/\/safe\/model\.model3\.json/)
  assert.doesNotMatch(String(calls[0]?.html), /https?:\/\/[^"']*groupmate\/reply/)

  assert.equal(createCloudScreenshotPort({ baseUrl: 'file:///unsafe', fetch: async () => { throw new Error('must not call') } }), null)

  const cloudCaptures: Array<{ url: string; init: unknown }> = []
  const cloudTimeouts: number[] = []
  const cloud = createCloudScreenshotPort({
    baseUrl: 'https://capture.example',
    timeoutSignal: milliseconds => {
      cloudTimeouts.push(milliseconds)
      return new AbortController().signal
    },
    fetch: async (url, init) => {
      cloudCaptures.push({ url, init })
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null },
        body: Buffer.from(png.data)
      }
    }
  })
  const captured = await cloud?.capture({
    pageUrl: `https://render.example/groupmate/reply/v1/${'a'.repeat(32)}`,
    width: 777,
    deviceScaleFactor: 2,
    timeoutMs: 120000,
    maxContentHeightCssPx: 4096
  })
  assert.equal(captured?.kind, 'rendered')
  assert.equal(cloudCaptures[0]?.url, 'https://capture.example/screenshot')
  const cloudInit = cloudCaptures[0]?.init as { redirect: string; body: string }
  assert.equal(cloudInit.redirect, 'error')
  assert.deepEqual(cloudTimeouts, [120_000])
  assert.deepEqual(JSON.parse(cloudInit.body), {
    url: `https://render.example/groupmate/reply/v1/${'a'.repeat(32)}`,
    option: {
      width: 777, height: 4096, timeout: 120000, waitUtil: 'networkidle2',
      wait: 0, func: 'document.documentElement.scrollHeight <= 4096', dpr: 2
    },
    type: 'image'
  })
  assert.doesNotMatch(cloudInit.body, /cookie|apiKey|Authorization|actorId|prompt/)

  const invalidPngBodies = [
    Buffer.from([0, 1, 2, 3]),
    Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 32, 1
    ])
  ]
  for (const [index, body] of invalidPngBodies.entries()) {
    const invalidCloud = createCloudScreenshotPort({
      baseUrl: 'https://capture.example',
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body })
    })
    assert.deepEqual(await invalidCloud?.capture({
      pageUrl: `https://render.example/groupmate/reply/v1/${'a'.repeat(32)}`,
      width: 320, deviceScaleFactor: 1,
      timeoutMs: 120000, maxContentHeightCssPx: 4096
    }), {
      kind: 'not_rendered',
      code: index === 0 ? 'render_failed' : 'height_limit'
    })
  }

  const oversizedCloud = createCloudScreenshotPort({
    baseUrl: 'https://capture.example',
    fetch: async () => ({
      ok: true, status: 200,
      headers: { get: name => name.toLowerCase() === 'content-length' ? String(8 * 1024 * 1024 + 1) : null },
      body: Buffer.alloc(0)
    })
  })
  assert.deepEqual(await oversizedCloud?.capture({
    pageUrl: `https://render.example/groupmate/reply/v1/${'a'.repeat(32)}`,
    width: 320, deviceScaleFactor: 1,
    timeoutMs: 120000, maxContentHeightCssPx: 4096
  }), { kind: 'not_rendered', code: 'render_failed' })
})
