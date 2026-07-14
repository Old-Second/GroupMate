import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthorizedToolContext, ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import type { PolicyTransportRequest, PolicyTransportResponse } from '../../src/runtime/tools/policy-fetch.js'
import { PolicyFetch } from '../../src/runtime/tools/policy-fetch.js'
import { NetworkPolicy } from '../../src/agent/tools/network-policy.js'
import { createQueryToolRuntime } from '../../src/runtime/tools/tool-runtime-factory.js'

const facts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin',
  actorGroupRole: 'member',
  targetRole: 'none',
  targetIsBotMaster: false,
  targetExists: true
}

const context: AuthorizedToolContext = {
  runId: 'run-1',
  callId: 'call-1',
  snapshotId: 'snapshot-1',
  facts,
  target: { kind: 'none' },
  signal: new AbortController().signal
}

function response (body: unknown, options: {
  status?: number
  contentType?: string
} = {}): PolicyTransportResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status: options.status ?? 200,
    statusText: options.status === undefined || options.status === 200 ? 'OK' : 'Upstream Error',
    headers: { 'content-type': options.contentType ?? 'application/json' },
    body: (async function * () { yield Buffer.from(text) })()
  }
}

function policyFetchFixture (
  handler: (request: PolicyTransportRequest) => PolicyTransportResponse | Promise<PolicyTransportResponse>
): { policyFetch: PolicyFetch; calls: PolicyTransportRequest[] } {
  const calls: PolicyTransportRequest[] = []
  return {
    calls,
    policyFetch: new PolicyFetch({
      networkPolicy: new NetworkPolicy({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }]
      }),
      transport: {
        request: async request => {
          calls.push(request)
          return await handler(request)
        }
      }
    })
  }
}

function runtime (options: {
  policyFetch: PolicyFetch
  searchSource?: 'tavily' | 'bing' | 'public'
  tavilyApiKey?: string
  bingApiKey?: string
  amapKey?: string
  githubApiKey?: string
  imageSearchSource?: 'tavily' | 'brave' | 'public'
  braveSearchApiKey?: string
  extraUrl?: string
}): ReturnType<typeof createQueryToolRuntime> {
  return createQueryToolRuntime({
    policyFetch: options.policyFetch,
    config: {
      searchSource: options.searchSource ?? 'public',
      publicSearchSource: 'bing',
      tavilyApiKey: options.tavilyApiKey ?? '',
      bingApiKey: options.bingApiKey ?? '',
      amapKey: options.amapKey ?? 'amap-key',
      amapApiBaseUrl: 'https://restapi.amap.com',
      githubApiBaseUrl: 'https://api.github.com',
      githubApiKey: options.githubApiKey ?? '',
      imageSearchSource: options.imageSearchSource ?? 'public',
      braveSearchApiKey: options.braveSearchApiKey ?? '',
      extraUrl: options.extraUrl ?? 'https://caption.example.com'
    },
    currentGroupMembers: async () => new Map([
      ['7', { userId: '7', nickname: 'sender', role: 'member' }],
      ['8', { userId: '8', nickname: 'other', role: 'member' }]
    ]),
    queryGame: async () => ({
      kind: 'buffer', data: Buffer.from('game'), mimeType: 'image/png', byteLength: 4
    }),
    sendGameImage: async () => {}
  })
}

test('query tool runtime exposes eleven unique canonical definitions', () => {
  const { policyFetch } = policyFetchFixture(() => response({ data: [] }))
  const created = runtime({ policyFetch })
  assert.deepEqual(created.definitions.map(tool => tool.name), [
    'search', 'website', 'weather', 'github', 'queryUserinfo', 'queryGenshin',
    'queryStarRail', 'searchImage', 'searchVideo', 'searchMusic', 'imageCaption'
  ])
  assert.equal(new Set(created.definitions.map(tool => tool.name)).size, 11)
  assert.ok(created.registry instanceof ToolRegistry)
  assert.equal(created.definitions.filter(tool => tool.name === 'search').length, 1)
  assert.equal(created.definitions.find(tool => tool.name === 'website')?.network, 'open_http')
  assert.equal(created.definitions.find(tool => tool.name === 'website')?.readOnly, true)
  for (const definition of created.definitions) {
    assert.equal(definition.executionClass, definition.effect)
    assert.equal(definition.retrySafe, !['queryGenshin', 'queryStarRail', 'imageCaption'].includes(definition.name))
  }
})

test('POST-backed search definitions are never marked retry safe', () => {
  const { policyFetch } = policyFetchFixture(() => response({ data: [] }))
  for (const definition of [
    runtime({ policyFetch, searchSource: 'tavily', tavilyApiKey: 'key' })
      .definitions.find(tool => tool.name === 'search'),
    runtime({ policyFetch, imageSearchSource: 'tavily', tavilyApiKey: 'key' })
      .definitions.find(tool => tool.name === 'searchImage')
  ]) {
    assert.ok(definition)
    assert.equal(definition.executionClass, 'read_only')
    assert.equal(definition.retrySafe, false)
  }
})

test('search tool selects one configured backend and never leaks its key', async () => {
  const fixture = policyFetchFixture(() => response({
    answer: 'answer', results: [{ title: 'one', url: 'https://example.com', content: 'result' }]
  }))
  const created = runtime({ policyFetch: fixture.policyFetch, searchSource: 'tavily', tavilyApiKey: 'top-secret' })
  const tool = created.definitions.find(item => item.name === 'search')
  assert.ok(tool)
  const result = await tool.execute({ q: 'GroupMate', num: 5 }, context)
  assert.equal(result.status, 'success')
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].url.href, 'https://api.tavily.com/search')
  assert.equal(fixture.calls[0].headers.authorization, 'Bearer top-secret')
  assert.doesNotMatch(JSON.stringify(result), /top-secret/)
})

test('missing query configuration returns a typed redacted failure', async () => {
  const fixture = policyFetchFixture(() => response({ results: [] }))
  const created = runtime({ policyFetch: fixture.policyFetch, searchSource: 'tavily' })
  const tool = created.definitions.find(item => item.name === 'search')
  assert.ok(tool)
  assert.deepEqual(await tool.execute({ q: 'test', num: 5 }, context), {
    status: 'failed', effect: 'none', errorCode: 'configuration_missing',
    userMessage: '搜索服务尚未配置。', retryable: false
  })
  assert.equal(fixture.calls.length, 0)
})

test('website uses bounded open HTTP text access without browser fallback', async () => {
  const fixture = policyFetchFixture(() => response(
    '<html><head><script>secret()</script></head><body><h1>Hello</h1><p>world</p></body></html>',
    { contentType: 'text/html' }
  ))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const tool = created.definitions.find(item => item.name === 'website')
  assert.ok(tool)
  const result = await tool.execute({ url: 'https://example.com/short' }, context)
  assert.equal(result.status, 'success')
  assert.match(JSON.stringify(result), /Hello/)
  assert.doesNotMatch(JSON.stringify(result), /secret\(\)|ChatGPTPuppeteer|Chromium/)
  assert.equal(fixture.calls.length, 1)
})

test('weather performs only fixed Amap requests and normalizes the response', async () => {
  const fixture = policyFetchFixture(request => request.url.pathname.includes('/district')
    ? response({ districts: [{ adcode: '110000', name: '北京' }] })
    : response({ lives: [{ province: '北京', city: '北京', weather: '晴', temperature: '26' }] }))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const tool = created.definitions.find(item => item.name === 'weather')
  assert.ok(tool)
  const result = await tool.execute({ city: '北京' }, context)
  assert.equal(result.status, 'success')
  assert.equal(fixture.calls.length, 2)
  assert.ok(fixture.calls.every(call => call.url.origin === 'https://restapi.amap.com'))
  assert.match(JSON.stringify(result), /北京/)
})

test('github rejects absolute or unrelated custom paths before transport', async () => {
  const fixture = policyFetchFixture(() => response({ items: [] }))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const tool = created.definitions.find(item => item.name === 'github')
  assert.ok(tool)
  for (const path of [
    'https://evil.example/repos/a/b', '//evil.example/a', '/admin', '/search/code',
    '/repos/owner/repo/../../admin', '/repos/owner/repo/%2e%2e/admin'
  ]) {
    const result = await tool.execute({ q: '', type: 'custom', num: 5, path }, context)
    assert.equal(result.status, 'denied')
    if (result.status === 'denied') assert.equal(result.reasonCode, 'invalid_arguments')
  }
  assert.equal(fixture.calls.length, 0)
  await tool.execute({ q: '', type: 'custom', num: 5, path: '/repos/owner/repo/issues' }, context)
  assert.equal(fixture.calls[0].url.origin, 'https://api.github.com')
})

test('queryUserinfo can only read the current group member map', async () => {
  const fixture = policyFetchFixture(() => response({}))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const tool = created.definitions.find(item => item.name === 'queryUserinfo')
  assert.ok(tool)
  const found = await tool.execute({ userId: '8' }, context)
  assert.equal(found.status, 'success')
  assert.match(JSON.stringify(found), /other/)
  const missing = await tool.execute({ userId: '999' }, context)
  assert.equal(missing.status, 'denied')
  if (missing.status === 'denied') assert.equal(missing.reasonCode, 'target_not_found')
})

test('fixed query tools surface upstream status and invalid JSON as safe typed failures', async () => {
  const statusFixture = policyFetchFixture(() => response('provider token=secret', { status: 503, contentType: 'application/json' }))
  const statusRuntime = runtime({ policyFetch: statusFixture.policyFetch })
  const video = statusRuntime.definitions.find(item => item.name === 'searchVideo')
  assert.ok(video)
  const statusResult = await video.execute({ keyword: 'test', limit: 5 }, context)
  assert.equal(statusResult.status, 'failed')
  assert.doesNotMatch(JSON.stringify(statusResult), /provider|token|secret|503/)

  const jsonFixture = policyFetchFixture(() => response('{not json', { contentType: 'application/json' }))
  const jsonRuntime = runtime({ policyFetch: jsonFixture.policyFetch })
  const music = jsonRuntime.definitions.find(item => item.name === 'searchMusic')
  assert.ok(music)
  const jsonResult = await music.execute({ keyword: 'test', limit: 5 }, context)
  assert.equal(jsonResult.status, 'failed')
  assert.doesNotMatch(JSON.stringify(jsonResult), /not json/)
})

test('all query tool schemas are closed and require every declared property', () => {
  const fixture = policyFetchFixture(() => response({ data: [] }))
  const created = runtime({ policyFetch: fixture.policyFetch })
  for (const definition of created.definitions) {
    assert.equal('type' in definition.inputSchema && definition.inputSchema.type, 'object')
    if ('type' in definition.inputSchema && definition.inputSchema.type === 'object') {
      assert.equal(definition.inputSchema.additionalProperties, false)
      assert.deepEqual(
        [...definition.inputSchema.required].sort(),
        Object.keys(definition.inputSchema.properties).sort(),
        definition.name
      )
    }
  }
})

test('image search uses only the selected fixed backend and returns bounded candidates', async () => {
  const fixture = policyFetchFixture(() => response({
    results: [{ title: 'image', properties: { url: 'https://cdn.example/image.jpg' } }]
  }))
  const created = runtime({
    policyFetch: fixture.policyFetch,
    imageSearchSource: 'brave',
    braveSearchApiKey: 'brave-secret'
  })
  const tool = created.definitions.find(item => item.name === 'searchImage')
  assert.ok(tool)
  const result = await tool.execute({ q: 'cat', limit: 2 }, context)
  assert.equal(result.status, 'success')
  assert.equal(fixture.calls[0].url.origin, 'https://api.search.brave.com')
  assert.equal(fixture.calls[0].headers['x-subscription-token'], 'brave-secret')
  assert.doesNotMatch(JSON.stringify(result), /brave-secret/)

  const missing = runtime({
    policyFetch: fixture.policyFetch, imageSearchSource: 'brave'
  }).definitions.find(item => item.name === 'searchImage')
  assert.ok(missing)
  const missingResult = await missing.execute({ q: 'cat', limit: 2 }, context)
  assert.equal(missingResult.status, 'failed')
  if (missingResult.status === 'failed') assert.equal(missingResult.errorCode, 'configuration_missing')
})

test('video and music query tools normalize successful fixture responses', async () => {
  const fixture = policyFetchFixture(request => request.url.hostname === 'api.bilibili.com'
    ? response({ data: { result: [{ bvid: 'BV1', title: '<em>title</em>', author: 'up', play: 10, pubdate: 1 }] } })
    : response({ result: { songs: [{ id: 1, name: 'song', artists: [{ name: 'artist' }], alias: [] }] } }))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const video = created.definitions.find(item => item.name === 'searchVideo')
  const music = created.definitions.find(item => item.name === 'searchMusic')
  assert.ok(video)
  assert.ok(music)
  assert.equal((await video.execute({ keyword: 'title', limit: 5 }, context)).status, 'success')
  assert.equal((await music.execute({ keyword: 'song', limit: 5 }, context)).status, 'success')
  assert.deepEqual(fixture.calls.map(call => call.url.origin), [
    'https://api.bilibili.com', 'https://music.163.com'
  ])
})

test('game query tools pass only normalized input and trusted current actor defaults', async () => {
  const fixture = policyFetchFixture(() => response({}))
  const calls: unknown[] = []
  const sent: unknown[] = []
  const created = createQueryToolRuntime({
    ...runtimeOptions(fixture.policyFetch),
    queryGame: async input => {
      calls.push(input)
      return { kind: 'buffer', data: Buffer.from('game'), mimeType: 'image/png', byteLength: 4 }
    },
    sendGameImage: async (resource, target) => { sent.push({ resource, target }) }
  })
  const genshin = created.definitions.find(item => item.name === 'queryGenshin')
  const starRail = created.definitions.find(item => item.name === 'queryStarRail')
  assert.ok(genshin)
  assert.ok(starRail)
  const gameContext = { ...context, target: { kind: 'group' as const, groupId: '9' } }
  assert.equal((await genshin.execute({ userId: '', uid: '123', character: '胡桃' }, gameContext)).status, 'success')
  assert.equal((await starRail.execute({ userId: '8', uid: '', character: '' }, gameContext)).status, 'success')
  assert.deepEqual(calls, [
    { game: 'genshin', userId: '7', uid: '123', character: '胡桃' },
    { game: 'star_rail', userId: '8', uid: '', character: '' }
  ])
  assert.equal(sent.length, 2)
  assert.deepEqual((sent[0] as { target: unknown }).target, { kind: 'group', groupId: '9' })
})

test('image caption reads a public image then calls only the configured fixed origin', async () => {
  const fixture = policyFetchFixture(request => request.url.hostname === 'image.example'
    ? response('image-bytes', { contentType: 'image/png' })
    : response('a small cat', { contentType: 'text/plain' }))
  const created = runtime({ policyFetch: fixture.policyFetch, extraUrl: 'https://caption.example.com' })
  const tool = created.definitions.find(item => item.name === 'imageCaption')
  assert.ok(tool)
  const result = await tool.execute({
    imageUrl: 'https://image.example/cat.png', userId: '', question: 'what is this?'
  }, context)
  assert.equal(result.status, 'success')
  assert.deepEqual(fixture.calls.map(call => `${call.url.origin}${call.url.pathname}`), [
    'https://image.example/cat.png', 'https://caption.example.com/visual-qa'
  ])
  assert.match(JSON.stringify(result), /small cat/)

  const missing = runtime({ policyFetch: fixture.policyFetch, extraUrl: '' })
    .definitions.find(item => item.name === 'imageCaption')
  assert.ok(missing)
  const missingResult = await missing.execute({ imageUrl: '', userId: '7', question: '' }, context)
  assert.equal(missingResult.status, 'failed')
  if (missingResult.status === 'failed') assert.equal(missingResult.errorCode, 'configuration_missing')
})

test('query tool abort is returned as a typed cancellation without upstream details', async () => {
  const fixture = policyFetchFixture(() => response('unused', { contentType: 'text/plain' }))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const tool = created.definitions.find(item => item.name === 'website')
  assert.ok(tool)
  const controller = new AbortController()
  controller.abort()
  const result = await tool.execute({ url: 'https://secret.example/?token=value' }, {
    ...context, signal: controller.signal
  })
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.errorCode, 'tool_cancelled')
  assert.doesNotMatch(JSON.stringify(result), /secret|token|value/)
})

test('empty query strings are denied before any network request', async () => {
  const fixture = policyFetchFixture(() => response({}))
  const created = runtime({ policyFetch: fixture.policyFetch })
  const inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    search: { q: '', num: 5 },
    weather: { city: '' },
    searchImage: { q: '', limit: 2 },
    searchVideo: { keyword: '', limit: 5 },
    searchMusic: { keyword: '', limit: 5 }
  }
  for (const [name, input] of Object.entries(inputs)) {
    const tool = created.definitions.find(item => item.name === name)
    assert.ok(tool)
    const result = await tool.execute(input, context)
    assert.equal(result.status, 'denied', name)
    if (result.status === 'denied') assert.equal(result.reasonCode, 'invalid_arguments', name)
  }
  assert.equal(fixture.calls.length, 0)
})

function runtimeOptions (policyFetch: PolicyFetch): Parameters<typeof createQueryToolRuntime>[0] {
  return {
    policyFetch,
    config: {
      searchSource: 'public', publicSearchSource: 'bing', tavilyApiKey: '', bingApiKey: '',
      amapKey: 'amap-key', amapApiBaseUrl: 'https://restapi.amap.com',
      githubApiBaseUrl: 'https://api.github.com', githubApiKey: '',
      imageSearchSource: 'public', braveSearchApiKey: '',
      extraUrl: 'https://caption.example.com'
    },
    currentGroupMembers: async () => new Map(),
    queryGame: async () => ({
      kind: 'buffer', data: Buffer.from('game'), mimeType: 'image/png', byteLength: 4
    }),
    sendGameImage: async () => {}
  }
}
