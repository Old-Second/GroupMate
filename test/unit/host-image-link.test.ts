import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentMessage } from '../../src/agent/contracts/content.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import type {
  ModelAdapter,
  ModelRequest
} from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { RunAdmission } from '../../src/agent/run/run-admission.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import { RunEngine } from '../../src/agent/run/run-engine.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import { RedisAgentSessionStore } from '../../src/agent/session/redis-agent-session-store.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import { AgentService } from '../../src/runtime/agent-service.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'
import { FakeRedis } from '../helpers/fake-redis.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'
import {
  type HostImageLinkKeys,
  normalizeHostImageLinkKey,
  parseHostImageLink,
  refreshHostImageLink
} from '../../src/runtime/host-image-link.js'
import {
  HostImageLinkService,
  UNREFRESHABLE_LINK_MAX_AGE_MS,
  type HostImageLinkLiveness
} from '../../src/runtime/host-image-link-service.js'
import {
  HostImageLinkFetchProbe,
  YunzaiHostImageLinkKeySource,
  parseHostImageLinkKeys
} from '../../src/runtime/yunzai-host-image-link-adapter.js'

const GROUP_KEY = 'GROUPKEYgroupkey0123456789'
const PRIVATE_KEY = 'PRIVATEKEYprivatekey987654'
const CAPTURED_KEY = 'CAPTUREDKEYcaptured000111'

function groupLink (fileId = 'file-1', key = CAPTURED_KEY): string {
  return `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fileId}&rkey=${key}`
}

function privateLink (key = CAPTURED_KEY): string {
  return `https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=file-2&rkey=${key}`
}

function keys (overrides: Partial<HostImageLinkKeys> = {}): HostImageLinkKeys {
  return Object.freeze({
    group: GROUP_KEY,
    private: PRIVATE_KEY,
    refreshedAtMs: 0,
    expiresAtMs: 3_420_000,
    ...overrides
  })
}

test('a signed host image link is recognised by host, key and scene', () => {
  assert.deepEqual(parseHostImageLink(groupLink()), {
    scene: 'group',
    fileKey: '1407:file-1'
  })
  assert.equal(parseHostImageLink(privateLink())?.scene, 'private')
  // An unknown application id could belong to either scene, so the wrong key is
  // never guessed.
  assert.equal(
    parseHostImageLink('https://multimedia.nt.qq.com.cn/download?appid=9&fileid=f&rkey=k'),
    null
  )
  assert.equal(parseHostImageLink('https://cdn.example.test/a.png?rkey=k'), null)
  assert.equal(
    parseHostImageLink('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=f'),
    null
  )
  assert.equal(parseHostImageLink(''), null)
  assert.equal(parseHostImageLink(undefined), null)
})

test('refreshing a link replaces the key and nothing else', () => {
  const refreshed = refreshHostImageLink(groupLink(), keys())
  assert.equal(refreshed, groupLink('file-1', GROUP_KEY))
  assert.equal(refreshHostImageLink(privateLink(), keys()), privateLink(PRIVATE_KEY))
  // A link already carrying the current key is returned untouched.
  assert.equal(
    refreshHostImageLink(groupLink('file-1', GROUP_KEY), keys()),
    groupLink('file-1', GROUP_KEY)
  )
  assert.equal(refreshHostImageLink(groupLink(), keys({ group: undefined })), null)
  assert.equal(refreshHostImageLink(groupLink(), keys({ group: 'short' })), null)
  assert.equal(refreshHostImageLink('https://cdn.example.test/a.png', keys()), null)
})

test('a host key is accepted with or without its query prefix', () => {
  assert.equal(normalizeHostImageLinkKey(`&rkey=${GROUP_KEY}`), GROUP_KEY)
  assert.equal(normalizeHostImageLinkKey(`rkey=${GROUP_KEY}`), GROUP_KEY)
  assert.equal(normalizeHostImageLinkKey(GROUP_KEY), GROUP_KEY)
  assert.equal(normalizeHostImageLinkKey('&rkey=with space'), undefined)
  assert.equal(normalizeHostImageLinkKey(42), undefined)
})

const NOW = 1_000_000

function service (options: {
  readonly keys?: HostImageLinkKeys | null
  readonly liveness?: HostImageLinkLiveness | (() => HostImageLinkLiveness)
  readonly probeBudgetMs?: number
  readonly onKeyRequest?: () => void
  readonly onProbe?: (link: string) => void
}): HostImageLinkService {
  return new HostImageLinkService({
    keySource: {
      keys: async () => {
        options.onKeyRequest?.()
        return options.keys === undefined ? keys() : options.keys
      }
    },
    ...(options.liveness === undefined
      ? {}
      : {
          probe: {
            probe: async (link: string) => {
              options.onProbe?.(link)
              return typeof options.liveness === 'function'
                ? options.liveness()
                : options.liveness as HostImageLinkLiveness
            }
          }
        }),
    now: () => NOW,
    ...(options.probeBudgetMs === undefined ? {} : { probeBudgetMs: options.probeBudgetMs })
  })
}

const context = Object.freeze({ botId: 'bot-1', referenceAtMs: NOW })

test('a replayed link is re-signed and expires with the host key', async () => {
  const decisions = await service({}).resolve(
    [{ resourceId: groupLink(), capturedAtMs: NOW - 6 * 60 * 60 * 1_000 }],
    context
  )

  assert.deepEqual(decisions.get(groupLink()), {
    link: groupLink('file-1', GROUP_KEY),
    expiresAt: new Date(3_420_000).toISOString()
  })
})

test('without a current key a replayed link keeps a bounded replay age', async () => {
  const capturedAtMs = NOW - 60 * 1_000
  const decisions = await service({ keys: null }).resolve(
    [
      { resourceId: groupLink(), capturedAtMs },
      // Without a capture instant there is no evidence the link went stale.
      { resourceId: groupLink('file-3'), capturedAtMs: null }
    ],
    context
  )

  assert.deepEqual(decisions.get(groupLink()), {
    link: groupLink(),
    expiresAt: new Date(capturedAtMs + UNREFRESHABLE_LINK_MAX_AGE_MS).toISOString()
  })
  assert.equal(decisions.has(groupLink('file-3')), false)
})

test('a link the host no longer serves is marked expired and remembered', async () => {
  let probes = 0
  const capturedAtMs = NOW - 6 * 60 * 60 * 1_000
  const resolver = service({ liveness: 'gone', onProbe: () => { probes += 1 } })
  const first = await resolver.resolve(
    [{ resourceId: groupLink(), capturedAtMs }],
    context
  )
  const second = await resolver.resolve(
    [{ resourceId: groupLink(), capturedAtMs }],
    context
  )

  assert.equal(first.get(groupLink())?.expiresAt, new Date(capturedAtMs).toISOString())
  assert.equal(second.get(groupLink())?.expiresAt, new Date(capturedAtMs).toISOString())
  assert.equal(probes, 1)
})

test('an inconclusive probe leaves the re-signed link in place', async () => {
  const decisions = await service({ liveness: 'unknown' }).resolve(
    [{ resourceId: groupLink(), capturedAtMs: NOW - 6 * 60 * 60 * 1_000 }],
    context
  )

  assert.equal(decisions.get(groupLink())?.link, groupLink('file-1', GROUP_KEY))
  assert.equal(decisions.get(groupLink())?.expiresAt, new Date(3_420_000).toISOString())
})

test('a freshly captured link and a zero probe budget cost no host request', async () => {
  let probes = 0
  const young = await service({ liveness: 'gone', onProbe: () => { probes += 1 } }).resolve(
    [{ resourceId: groupLink(), capturedAtMs: NOW - 60 * 1_000 }],
    context
  )
  assert.equal(young.get(groupLink())?.link, groupLink('file-1', GROUP_KEY))
  assert.equal(probes, 0)

  const disabled = await service({
    liveness: 'gone',
    probeBudgetMs: 0,
    onProbe: () => { probes += 1 }
  }).resolve([{ resourceId: groupLink(), capturedAtMs: NOW - 86_400_000 }], context)
  assert.equal(disabled.get(groupLink())?.link, groupLink('file-1', GROUP_KEY))
  assert.equal(probes, 0)
})

test('links this project cannot re-sign are left out of the decisions', async () => {
  let keyRequests = 0
  const decisions = await service({ onKeyRequest: () => { keyRequests += 1 } }).resolve(
    [
      { resourceId: 'https://cdn.example.test/a.png', capturedAtMs: NOW - 86_400_000 },
      { resourceId: 'not a url', capturedAtMs: null }
    ],
    context
  )

  assert.equal(decisions.size, 0)
  assert.equal(keyRequests, 0)
})

test('a failing key source never fails the request', async () => {
  const resolver = new HostImageLinkService({
    keySource: { keys: async () => { throw new Error('host unavailable') } },
    now: () => NOW
  })

  const decisions = await resolver.resolve(
    [{ resourceId: groupLink(), capturedAtMs: NOW - 60 * 1_000 }],
    context
  )

  assert.equal(decisions.get(groupLink())?.link, groupLink())
})

test('an expired key snapshot is treated as no key at all', async () => {
  const decisions = await service({
    keys: keys({ refreshedAtMs: 0, expiresAtMs: NOW - 1 })
  }).resolve([{ resourceId: groupLink(), capturedAtMs: NOW - 60 * 1_000 }], context)

  assert.equal(decisions.get(groupLink())?.link, groupLink())
})

test('host key payloads are accepted in both reported shapes', () => {
  const entries = [
    { type: 'private', rkey: `&rkey=${PRIVATE_KEY}`, ttl: 3_420, created_at: 1 },
    { type: 'group', rkey: `&rkey=${GROUP_KEY}`, ttl: 3_420, created_at: 1 }
  ]

  assert.deepEqual(parseHostImageLinkKeys(entries, 1_000), {
    group: GROUP_KEY,
    private: PRIVATE_KEY,
    refreshedAtMs: 1_000,
    expiresAtMs: 1_000 + 3_420_000
  })
  assert.deepEqual(parseHostImageLinkKeys({ rkeys: entries }, 0), {
    group: GROUP_KEY,
    private: PRIVATE_KEY,
    refreshedAtMs: 0,
    expiresAtMs: 1_000 + 3_420_000
  })
  assert.deepEqual(parseHostImageLinkKeys({ data: { rkeys: entries } }, 1_000), {
    group: GROUP_KEY,
    private: PRIVATE_KEY,
    refreshedAtMs: 1_000,
    expiresAtMs: 1_000 + 3_420_000
  })
  // The reported lifetime is the key's whole life, so a key minted 50 minutes
  // ago is trusted for the few minutes it has left, not for another 57.
  const mintedAtMs = 3_000_000_000
  assert.equal(
    parseHostImageLinkKeys(
      [{ type: 'group', rkey: GROUP_KEY, ttl: 3_420, created_at: mintedAtMs / 1_000 - 3_000 }],
      mintedAtMs
    )?.expiresAtMs,
    mintedAtMs + 420_000
  )
  // An implausible mint instant falls back to the moment the keys arrived.
  assert.equal(
    parseHostImageLinkKeys(
      [{ type: 'group', rkey: GROUP_KEY, ttl: 3_420, created_at: 1 }],
      mintedAtMs
    )?.expiresAtMs,
    mintedAtMs + 3_420_000
  )
  // A lifetime the host reports as days cannot outlive one hour of trust.
  assert.equal(
    parseHostImageLinkKeys([{ type: 'group', rkey: GROUP_KEY, ttl: 864_000 }], 0)?.expiresAtMs,
    60 * 60 * 1_000
  )
  assert.equal(parseHostImageLinkKeys([{ type: 'group', rkey: 'x' }], 0), null)
  assert.equal(parseHostImageLinkKeys({ status: 'ok' }, 0), null)
  assert.equal(parseHostImageLinkKeys(null, 0), null)
})

test('the host key source caches one request per bot and fails open', async () => {
  const previous = Reflect.get(globalThis, 'Bot')
  const actions: string[] = []
  Reflect.set(globalThis, 'Bot', {
    uin: ['1'],
    bots: { 1: { pickGroup: () => undefined, sendApi: async () => undefined } }
  })
  try {
    const source = new YunzaiHostImageLinkKeySource({
      now: () => NOW,
      requestKeys: async (_bot, action) => {
        actions.push(action)
        return [{ type: 'group', rkey: `&rkey=${GROUP_KEY}`, ttl: 3_420 }]
      }
    })
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      source.keys('1', signal),
      source.keys('1', signal)
    ])
    assert.equal(first?.group, GROUP_KEY)
    assert.equal(second?.group, GROUP_KEY)
    assert.equal((await source.keys('1', signal))?.group, GROUP_KEY)
    assert.deepEqual(actions, ['get_rkey'])

    // A build that only answers under its own namespace still yields keys.
    const aliased = new YunzaiHostImageLinkKeySource({
      now: () => NOW,
      requestKeys: async (_bot, action) => {
        actions.push(action)
        if (action === 'get_rkey') throw new Error('unsupported action')
        return { rkeys: [{ type: 'group', rkey: GROUP_KEY, ttl: 3_420 }] }
      }
    })
    assert.equal((await aliased.keys('1', signal))?.group, GROUP_KEY)
    assert.deepEqual(actions.slice(1), ['get_rkey', 'nc_get_rkey'])

    const failing = new YunzaiHostImageLinkKeySource({
      now: () => NOW,
      requestKeys: async () => { throw new Error('host action failed') }
    })
    assert.equal(await failing.keys('1', signal), null)
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'Bot')
    else Reflect.set(globalThis, 'Bot', previous)
  }
})

test('without a host bot the key source reports no key', async () => {
  const previous = Reflect.get(globalThis, 'Bot')
  Reflect.deleteProperty(globalThis, 'Bot')
  try {
    const source = new YunzaiHostImageLinkKeySource({ now: () => NOW })
    assert.equal(await source.keys(null, new AbortController().signal), null)
  } finally {
    if (previous !== undefined) Reflect.set(globalThis, 'Bot', previous)
  }
})

test('the liveness probe reads one byte and only trusts a definitive status', async () => {
  const seen: Array<Readonly<Record<string, unknown>>> = []
  const probeWith = (status: number): HostImageLinkFetchProbe => new HostImageLinkFetchProbe({
    fetchImpl: (async (_input: unknown, init: Readonly<Record<string, unknown>>) => {
      seen.push(init)
      return new Response(null, { status })
    }) as unknown as typeof fetch
  })
  const signal = new AbortController().signal

  assert.equal(await probeWith(206).probe(groupLink(), signal), 'alive')
  assert.equal(await probeWith(404).probe(groupLink(), signal), 'gone')
  assert.equal(await probeWith(400).probe(groupLink(), signal), 'unknown')
  assert.equal(await probeWith(500).probe(groupLink(), signal), 'unknown')
  assert.deepEqual(
    seen.map(init => (init.headers as Record<string, string>).range),
    ['bytes=0-0', 'bytes=0-0', 'bytes=0-0', 'bytes=0-0']
  )
  assert.deepEqual(new Set(seen.map(init => init.redirect)), new Set(['error']))

  // Anything outside the replayed host set is never fetched.
  let fetched = false
  const guarded = new HostImageLinkFetchProbe({
    fetchImpl: (async () => {
      fetched = true
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
  })
  assert.equal(await guarded.probe('https://cdn.example.test/a.png', signal), 'unknown')
  assert.equal(fetched, false)
})

const requestedAt = '2026-07-14T01:00:00.000Z'
const facts: ToolRuntimeFacts = Object.freeze({
  botId: 'bot-1',
  actor: Object.freeze({ userId: 'actor-1', role: 'owner', isBotMaster: true }),
  channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
  scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' }),
  botGroupRole: 'owner',
  actorGroupRole: 'owner',
  targetRole: 'member',
  targetIsBotMaster: false,
  targetExists: true
})
const intent = Object.freeze({
  trustedSources: Object.freeze(['current_request'] as const),
  actions: Object.freeze([]),
  explicitTargetIds: Object.freeze([]),
  mentionUserIds: Object.freeze([]),
  currentMessageId: 'message-1',
  replyMessageId: null
})

function imageRequest (
  id: string,
  text: string,
  imageUrl?: string,
  capturedAt: string = requestedAt
): YunzaiAgentRequestDraft {
  const message: AgentMessage = Object.freeze({
    id: `message-${id}`,
    role: 'user',
    parts: Object.freeze([
      { type: 'text' as const, text },
      ...(imageUrl === undefined
        ? []
        : [Object.freeze({
            type: 'resource_ref' as const,
            resourceType: 'image' as const,
            resourceId: imageUrl
          })])
    ]),
    createdAt: capturedAt,
    provenance: Object.freeze({
      source: 'qq_message',
      trust: 'untrusted',
      sensitivity: 'group',
      sourceId: `message-${id}`,
      createdAt: capturedAt
    })
  })
  const sessionAddress = Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'group_user' as const, groupId: 'group-1', userId: 'actor-1' })
  })
  return Object.freeze({
    requestId: id,
    requestRef: createHash('sha256').update(`request:${id}`).digest('hex').slice(0, 32),
    requestKind: 'ordinary_chat' as const,
    presentationRoute: Object.freeze({
      schemaVersion: 1 as const,
      requestKind: 'ordinary_chat' as const,
      profile: 'ordinary' as const,
      presentationIntent: Object.freeze({
        schemaVersion: 1 as const,
        kind: 'ordinary' as const,
        forcePicture: false
      }),
      sessionAddress,
      actorId: 'actor-1',
      requestMessageId: message.id
    }),
    createdAt: requestedAt,
    deadlineAt: '2026-07-14T01:04:00.000Z',
    sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'owner' }),
    channel: Object.freeze({ kind: 'group', botId: 'bot-1', groupId: 'group-1' }),
    message,
    references: Object.freeze({ currentMessageId: message.id, quotedMessageId: null }),
    systemInstructions: Object.freeze(['You are GroupMate.']),
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    contextBudget: Object.freeze({
      modelContextTokens: 8_192,
      reservedOutputTokens: 256,
      reservedToolTokens: 512,
      safetyMarginTokens: 128,
      maxItems: 64,
      maxBytes: 256 * 1_024
    }),
    sessionTtlSeconds: 600
  })
}

class UnusedToolRuntime implements ToolRuntime {
  async prepare (): Promise<never> {
    throw new Error('this fixture never calls a tool')
  }

  async executePrepared (): Promise<never> {
    throw new Error('this fixture never calls a tool')
  }
}

function replayService (
  liveness: HostImageLinkLiveness,
  requests: ModelRequest[]
): AgentService {
  const redis = new FakeRedis(() => Date.parse(requestedAt))
  const runStore = new InMemoryRunStore()
  const adapter: ModelAdapter = Object.freeze({
    complete: async (request: ModelRequest) => {
      requests.push(request)
      return Object.freeze({
        text: '收到。',
        finishReason: 'stop' as const,
        toolCalls: Object.freeze([])
      })
    }
  })
  const snapshot = new ToolRegistry(Object.freeze([])).createSnapshot({
    id: 'snapshot-host-image-link',
    facts,
    enabledTools: Object.freeze([])
  })
  let generated = 0
  return new AgentService({
    sessions: new RedisAgentSessionStore({
      redis,
      now: () => new Date(requestedAt),
      generateId: () => 'session-host-image-link'
    }),
    runStore,
    admission: new RunAdmission({
      client: redis,
      generateId: () => `host-image-lease-${++generated}`
    }),
    contextEngine: new ContextEngine({
      estimator: {
        estimate: message => Math.max(1, Math.ceil(JSON.stringify(message.parts).length / 4)),
        estimateModelMessage: message => Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
      }
    }),
    progressPresenter: new RunProgressPresenter(),
    createEngine: observer => new RunEngine({
      adapter,
      profile: standardOpenAIProfile,
      scheduler: new ToolScheduler({ runtime: new UnusedToolRuntime() }),
      store: runStore,
      budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
      now: () => new Date(requestedAt),
      generateId: () => `host-image-engine-${++generated}`,
      observer
    }),
    createRuntime: async () => Object.freeze({
      binding: Object.freeze({
        snapshot,
        prepareToolContext: async (): Promise<ToolPreparationContext> => Object.freeze({
          runId: 'host-image-run', profile: 'safe', facts, intent, now: requestedAt
        }),
        contextFor: async (): Promise<ToolExecutionContext> => Object.freeze({
          runId: 'host-image-run', profile: 'safe', facts, intent, now: requestedAt
        })
      })
    }),
    hostImageLinks: new HostImageLinkService({
      keySource: {
        keys: async () => keys({
          refreshedAtMs: Date.parse(requestedAt),
          expiresAtMs: Date.parse(requestedAt) + 3_420_000
        })
      },
      probe: { probe: async () => liveness },
      now: () => Date.parse(requestedAt),
      probeBudgetMs: 500
    }),
    now: () => new Date(requestedAt),
    generateId: () => `host-image-service-${++generated}`
  })
}

const capturedAt = '2026-07-13T19:00:00.000Z'

test('a history image reaches the provider with the current host key', async () => {
  const requests: ModelRequest[] = []
  const service = replayService('alive', requests)

  const first = await service.handle(imageRequest('replay-1', '看这张', groupLink(), capturedAt))
  const second = await service.handle(imageRequest('replay-2', '刚才那张是什么'))
  assert.deepEqual([first.kind, second.kind], ['completed', 'completed'])

  const replayed = requests[1]?.messages.filter(message => (
    message.role === 'user' && message.imageUrls !== undefined
  )) ?? []
  assert.deepEqual(
    replayed.flatMap(message => (message.role === 'user' ? [...message.imageUrls ?? []] : [])),
    [groupLink('file-1', GROUP_KEY)]
  )
  // The first turn sends the link exactly as the host handed it over.
  assert.deepEqual(
    (requests[0]?.messages ?? []).flatMap(message => (
      message.role === 'user' ? [...message.imageUrls ?? []] : []
    )),
    [groupLink()]
  )
  await service.shutdown('process_shutdown')
})

test('an image the host dropped leaves the request without failing it', async () => {
  const requests: ModelRequest[] = []
  const service = replayService('gone', requests)

  await service.handle(imageRequest('gone-1', '看这张', groupLink(), capturedAt))
  const second = await service.handle(imageRequest('gone-2', '刚才那张是什么'))
  assert.equal(second.kind, 'completed')

  assert.deepEqual(
    (requests[1]?.messages ?? []).flatMap(message => (
      message.role === 'user' ? [...message.imageUrls ?? []] : []
    )),
    []
  )
  // The conversation still remembers that an image was there.
  assert.equal(
    (requests[1]?.messages ?? []).some(message => (
      typeof message.content === 'string' && message.content.includes('看这张')
    )),
    true
  )
  await service.shutdown('process_shutdown')
})
