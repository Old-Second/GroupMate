import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  ModelProviderError,
  type ModelRequest,
  type ModelTurn
} from '../../src/agent/model/model-adapter.js'
import { RedisRunStore } from '../../src/agent/run/redis-run-store.js'
import type { RunContentJournalEvent } from '../../src/agent/run/run-content-journal.js'
import { AGENT_SESSION_NAMESPACE } from '../../src/agent/session/redis-agent-session-store.js'
import type { ToolResource } from '../../src/tools/visible-tool-support.js'
import type { RequestObservationV1 } from '../../src/runtime/request-observation.js'
import type { PresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import {
  SESSION_PERSISTENCE_FAILED_MESSAGE
} from '../../src/runtime/presentation/response-presentation-safety.js'
import type {
  OutboundPart,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import {
  createProductionYunzaiAgent,
  type ProductionModelPort,
  type ProductionYunzaiAgentOptions
} from '../../src/runtime/production-yunzai-agent.js'
import {
  APPROVAL_RECOVERY_DEFERRED_MESSAGE,
  RedisApprovalReferenceIndex
} from '../../src/runtime/run-approval-router.js'
import type { YunzaiMessageEvent } from '../../src/runtime/agent-service-bridge.js'
import type {
  GroupMateContentJournal,
  GroupMateOutboundJournalEvent
} from '../../src/runtime/logging/groupmate-content-journal.js'
import type {
  GroupMateDiskLogEvent,
  GroupMateDiskLogOptions
} from '../../src/runtime/logging/groupmate-disk-log.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'
import type { BymPolicySnapshot } from '../../src/runtime/yunzai-bym-controller.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const createdAt = '2026-07-17T00:00:00.000Z'

const png: ToolResource = Object.freeze({
  kind: 'buffer',
  data: new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
    73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1
  ]),
  mimeType: 'image/png',
  byteLength: 24
})

const audio: ToolResource = Object.freeze({
  kind: 'buffer',
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/mpeg',
  byteLength: 3
})

function presentationSettings (overrides: Readonly<{
  forcePicture?: boolean
  tts?: boolean
  alsoSendText?: boolean
  forwardReasoning?: boolean
  forwardToolDetails?: boolean
}> = {}): PresentationSettings {
  return Object.freeze({
    schemaVersion: 1,
    quoteReply: true,
    enableRobotAt: false,
    enableMarkdown: false,
    enableSuggestedResponses: false,
    forwardReasoning: overrides.forwardReasoning === true,
    forwardToolDetails: overrides.forwardToolDetails === true,
    blockWords: Object.freeze([]),
    promptBlockWords: Object.freeze([]),
    tts: Object.freeze({
      enabled: overrides.tts === true,
      mode: 'vits-uma-genshin-honkai' as const,
      activeVoice: 'fixture',
      alsoSendText: overrides.alsoSendText === true,
      autoFallbackThreshold: 299,
      filter: null,
      azureEmotionEnabled: false
    }),
    picture: Object.freeze({
      userEnabled: overrides.forcePicture === true,
      autoEnabled: false,
      autoThreshold: 1_200,
      deviceScaleFactor: 1,
      closeBrowserAfterRender: true,
      showQRCode: false,
      live2d: null
    })
  })
}

class SessionSaveFailingRedis extends FakeRedis {
  sessionSaveFailures = 0

  override async set (
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean }
  ): Promise<string | null> {
    if (key.startsWith(AGENT_SESSION_NAMESPACE)) {
      this.sessionSaveFailures += 1
      throw new Error('injected session save failure')
    }
    return await super.set(key, value, options)
  }
}

interface Dispatch {
  readonly target: SessionAddress
  readonly part: OutboundPart
  readonly messageId: string
  readonly quoteMessageId?: string
}

function oneBotSuccessProxy (messageId: string): unknown {
  const envelope = Object.freeze({
    status: 'ok',
    retcode: 0,
    data: Object.freeze({ message_id: messageId })
  })
  return new Proxy(envelope, {
    get (target, property, receiver) {
      return Reflect.has(target, property)
        ? Reflect.get(target, property, receiver)
        : Reflect.get(target.data, property, target.data)
    }
  })
}

interface GraphFixtureOptions {
  readonly redis?: FakeRedis
  readonly model: ProductionModelPort
  readonly dispatchResult?: (part: OutboundPart, messageId: string) => unknown
  readonly bot?: Readonly<Record<string, unknown>>
  readonly settingsForActor?: (actorId: string) => PresentationSettings
  readonly bymPolicy?: BymPolicySnapshot
  readonly toolPolicyProfile?: 'compatible' | 'safe' | 'strict'
  readonly diskLogEnabled?: boolean
  readonly observabilityLevel?: 'off' | 'basic' | 'diagnostic'
  readonly contentJournal?: GroupMateContentJournal
  readonly journalNow?: () => Date
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly createRequestRef?: () => string
  readonly promptPrefixOverride?: string
  readonly logger?: ProductionYunzaiAgentOptions['bridge']['logger']
  readonly diskLogFactory?: (
    options: GroupMateDiskLogOptions
  ) => Readonly<{
    record(event: GroupMateDiskLogEvent): void
    drain(): Promise<void>
  }>
  readonly journaledOutboundFactory?: (
    delegate: YunzaiOutboundPortFactory,
    journal: GroupMateContentJournal,
    now: () => Date
  ) => YunzaiOutboundPortFactory
}

class RecordingContentJournal implements GroupMateContentJournal {
  readonly requests: YunzaiAgentRequestDraft[] = []
  readonly runEvents: RunContentJournalEvent[] = []
  readonly outboundEvents: GroupMateOutboundJournalEvent[] = []
  drainCalls = 0
  throwOnRecord = false
  throwOnDrain = false
  blockedDrain: Promise<void> | undefined

  recordRequest (request: YunzaiAgentRequestDraft): void {
    if (this.throwOnRecord) throw new Error('injected request journal failure')
    this.requests.push(request)
  }

  recordRunEvent (event: RunContentJournalEvent): void {
    if (this.throwOnRecord) throw new Error('injected run journal failure')
    this.runEvents.push(event)
  }

  recordOutbound (event: GroupMateOutboundJournalEvent): void {
    if (this.throwOnRecord) throw new Error('injected outbound journal failure')
    this.outboundEvents.push(event)
  }

  async drain (): Promise<void> {
    this.drainCalls += 1
    if (this.throwOnDrain) throw new Error('injected drain failure')
    await this.blockedDrain
  }
}

const disabledBymPolicy: BymPolicySnapshot = Object.freeze({
  enabled: false,
  assistantLabel: 'GroupMate',
  recognizeLeadingAlias: true,
  ratePercent: 0,
  disabledGroupIds: Object.freeze([]),
  thinkingMode: 'default',
  reasoningEffort: 'default',
  preset: '',
  retaliationWords: Object.freeze([]),
  retaliationBlacklistActorIds: Object.freeze([]),
  retaliationPrompt: '',
  retaliationRecallEnabled: false,
  retaliationRecallSeconds: 100
})

function graphFixture (input: GraphFixtureOptions) {
  const redis = input.redis ?? new FakeRedis()
  const dispatches: Dispatch[] = []
  const recalls: string[] = []
  const observations: RequestObservationV1[] = []
  let pictureCalls = 0
  let ttsCalls = 0
  const botPicker = Object.freeze({
    pick: async () => (input.bot ?? null) as never
  })
  const options: ProductionYunzaiAgentOptions = {
    bridge: {
      config: Object.freeze({
        openAiCompatibilityProfile: 'standard',
        model: 'fixture-model',
        toolPolicyProfile: input.toolPolicyProfile ?? 'compatible',
        toolApprovalTtlSeconds: 120,
        ...(input.observabilityLevel === undefined
          ? {}
          : { observabilityLevel: input.observabilityLevel }),
        ...(input.diskLogEnabled === undefined
          ? {}
          : { diskLogEnabled: input.diskLogEnabled })
      }),
      redis,
      getMasterIds: async () => Object.freeze(['7']),
      getBotId: () => 'bot-1',
      segment: () => Object.freeze({}),
      botPicker,
      ...(input.generateId === undefined ? {} : { generateId: input.generateId }),
      ...(input.createRequestRef === undefined
        ? {}
        : { createRequestRef: input.createRequestRef }),
      ...(input.logger === undefined ? {} : { logger: input.logger })
    },
    botPicker,
    outboundHost: Object.freeze({
      async forTarget (currentTarget: SessionAddress) {
        return Object.freeze({
          async dispatch (part: OutboundPart, quoteMessageId: string | undefined) {
            const messageId = `delivery-${dispatches.length + 1}`
            dispatches.push(Object.freeze({
              target: currentTarget,
              part,
              messageId,
              ...(quoteMessageId === undefined ? {} : { quoteMessageId })
            }))
            return input.dispatchResult === undefined
              ? Object.freeze({ message_id: messageId })
              : input.dispatchResult(part, messageId)
          },
          async recall (messageId: string) {
            recalls.push(messageId)
            return true
          }
        })
      }
    }),
    presentationSettings: Object.freeze({
      load: async (actorId: string) => input.settingsForActor?.(actorId) ?? presentationSettings()
    }),
    pendingConfig: Object.freeze({
      getEnabled: async () => false,
      setEnabled: async () => undefined
    }),
    hooks: Object.freeze({
      forActiveEvent: () => Object.freeze({
        postprocess: async ({ text }: { readonly text: string }) => Object.freeze({ text }),
        convertText: async ({ text }: { readonly text: string }) =>
          Object.freeze([{ kind: 'text' as const, text }]),
        notifyResponsePost: () => undefined
      })
    }),
    chatPolicy: Object.freeze({
      entryMode: () => 'prefix' as const,
      snapshot: async () => Object.freeze({
        toggleMode: 'prefix' as const,
        enablePrivateChat: true,
        whitelist: Object.freeze([]),
        blacklist: Object.freeze([]),
        imgOcr: false,
        groupMerge: false,
        enableGroupContext: false,
        thinkingMode: 'default' as const,
        reasoningEffort: 'default' as const,
        assistantLabel: 'GroupMate',
        promptPrefixOverride: input.promptPrefixOverride ?? '',
        actorCastApi: ''
      }),
      isMuted: async () => false,
      ocrText: async () => Object.freeze([]),
      appendAzureEmotionFeedback: async ({ prompt }: { readonly prompt: string }) => prompt,
      clearAzureEmotionFeedback: async () => undefined
    }),
    chatPreferences: Object.freeze({
      load: async () => Object.freeze({
        usePicture: false, useTTS: false, ttsRole: 'fixture',
        ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
      }),
      patch: async () => Object.freeze({
        usePicture: false, useTTS: false, ttsRole: 'fixture',
        ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
      })
    }),
    ttsAdministration: Object.freeze({
      getMode: () => 'vits-uma-genshin-honkai' as const,
      setMode: () => undefined,
      isConfigured: () => true,
      selectVoice: () => Object.freeze({ kind: 'selected' as const, storedVoice: 'fixture', message: 'ok' }),
      missingConfigurationMessage: () => 'missing'
    }),
    billing: Object.freeze({
      queryLastHundredDays: async () => Object.freeze({
        hardLimitUsd: 0, totalUsageUsd: 0, expiresAt: new Date(0)
      })
    }),
    bymPolicy: Object.freeze({ snapshot: () => input.bymPolicy ?? disabledBymPolicy }),
    buttonPolicy: Object.freeze({
      snapshot: () => Object.freeze({ markdownEnabled: false, openAiConfigured: false })
    }),
    requestObservations: Object.freeze({
      publish: (value: RequestObservationV1) => { observations.push(value) }
    }),
    pictureRenderer: Object.freeze({
      render: async () => {
        pictureCalls += 1
        return Object.freeze({ kind: 'rendered' as const, resource: png, source: 'local' as const })
      }
    }),
    tts: Object.freeze({
      synthesize: async () => {
        ttsCalls += 1
        return Object.freeze({ kind: 'ready' as const, audio })
      }
    }),
    modelFactory: () => input.model,
    random: () => 0.5,
    now: input.now ?? (() => new Date(createdAt)),
    monotonicNow: () => 10,
    ...(input.contentJournal === undefined ? {} : { contentJournal: input.contentJournal }),
    ...(input.journalNow === undefined ? {} : { journalNow: input.journalNow }),
    ...(input.diskLogFactory === undefined ? {} : { diskLogFactory: input.diskLogFactory }),
    ...(input.journaledOutboundFactory === undefined
      ? {}
      : { journaledOutboundFactory: input.journaledOutboundFactory })
  }
  const graph = createProductionYunzaiAgent(options)
  return {
    graph,
    redis,
    dispatches,
    recalls,
    observations,
    pictureCalls: () => pictureCalls,
    ttsCalls: () => ttsCalls
  }
}

function textTurn (text: string, reasoning?: string): ModelTurn {
  return Object.freeze({
    text,
    toolCalls: Object.freeze([]),
    finishReason: 'stop',
    ...(reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ text: reasoning, truncated: false }) })
  })
}

function toolTurn (
  callId: string,
  name: string,
  args: Readonly<Record<string, string | number>>
): ModelTurn {
  return Object.freeze({
    text: '',
    toolCalls: Object.freeze([Object.freeze({
      index: 0,
      callId,
      name,
      argumentsText: JSON.stringify(args),
      arguments: Object.freeze({ ...args })
    })]),
    finishReason: 'tool_calls'
  })
}

function requestContains (request: ModelRequest, marker: string): boolean {
  return JSON.stringify(request.messages).includes(marker)
}

class ControllerScenarioModel implements ProductionModelPort {
  readonly requests: ModelRequest[] = []
  readonly counts = new Map<string, number>()
  readonly cancelStarted: Promise<void>
  #resolveCancelStarted: (() => void) | undefined

  constructor () {
    this.cancelStarted = new Promise(resolve => { this.#resolveCancelStarted = resolve })
  }

  count (marker: string): number {
    return this.counts.get(marker) ?? 0
  }

  async complete (request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    this.requests.push(request)
    const marker = [
      '普通文字请求', '图片请求', '语音请求', '骰子请求',
      '主动静默请求', '主动拆分坏蛋请求', '失败请求', '取消请求'
    ].find(value => requestContains(request, value))
    if (marker === undefined) throw new Error('unexpected controller scenario request')
    this.counts.set(marker, this.count(marker) + 1)
    if (marker === '普通文字请求') return textTurn('普通正文', '生产链路思考')
    if (marker === '图片请求') return textTurn('图片正文')
    if (marker === '语音请求') return textTurn('语音正文')
    if (marker === '骰子请求') return toolTurn('call-dice', 'sendDice', { count: 1 })
    if (marker === '主动静默请求') return textTurn('<EMPTY>')
    if (marker === '主动拆分坏蛋请求') return textTurn('一。二。三。')
    if (marker === '失败请求') {
      throw new ModelProviderError({
        code: 'provider_unavailable',
        stage: 'fixture.provider',
        retryable: false,
        userMessage: '不得直接展示的 Provider 细节'
      })
    }
    this.#resolveCancelStarted?.()
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(signal.reason ?? new DOMException('cancelled', 'AbortError'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    throw new Error('cancelled model request unexpectedly resumed')
  }

  async generate (): Promise<readonly string[]> {
    return Object.freeze([])
  }
}

class ApprovalModel implements ProductionModelPort {
  readonly requests: ModelRequest[] = []

  async complete (request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request)
    if (!requestContains(request, '审批禁言请求')) {
      throw new Error('unexpected approval scenario request')
    }
    const resumed = request.messages.some(message => message.role === 'tool')
    return resumed
      ? textTurn('审批恢复正文')
      : toolTurn('call-approval-mute', 'jinyan', { userId: '8', seconds: 60 })
  }

  async generate (): Promise<readonly string[]> {
    return Object.freeze([])
  }
}

class RecoveryPressureModel implements ProductionModelPort {
  readonly requests: ModelRequest[] = []
  readonly activeResolvers: Array<() => void> = []
  #blockingStarted = 0

  async complete (request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request)
    if (requestContains(request, '审批禁言请求')) return textTurn('审批恢复正文')
    if (!requestContains(request, '阻塞任务')) {
      throw new Error('unexpected recovery pressure request')
    }
    if (this.#blockingStarted < 2) {
      this.#blockingStarted += 1
      await new Promise<void>(resolve => { this.activeResolvers.push(resolve) })
    }
    return textTurn('阻塞任务完成')
  }

  releaseActive (): void {
    for (const resolve of this.activeResolvers.splice(0)) resolve()
  }

  async generate (): Promise<readonly string[]> {
    return Object.freeze([])
  }
}

interface HostFixture {
  readonly bot: Readonly<Record<string, unknown>>
  readonly group: Readonly<Record<string, unknown>>
  readonly visibleMessages: unknown[]
  readonly muted: Array<Readonly<{ userId: unknown; seconds: unknown }>>
}

function hostFixture (): HostFixture {
  const visibleMessages: unknown[] = []
  const muted: Array<Readonly<{ userId: unknown; seconds: unknown }>> = []
  const members = new Map<unknown, Readonly<Record<string, unknown>>>([
    ['bot-1', Object.freeze({ user_id: 'bot-1', role: 'owner', nickname: 'GroupMate' })],
    [7, Object.freeze({ user_id: 7, role: 'owner', nickname: '群主' })],
    [8, Object.freeze({ user_id: 8, role: 'member', nickname: '测试小号' })]
  ])
  for (const actor of [
    'actor-text', 'actor-picture', 'actor-tts', 'actor-dice',
    'actor-silence', 'actor-split', 'actor-failed', 'actor-cancel',
    'actor-block-0', 'actor-block-1', 'actor-block-2', 'actor-block-3', 'actor-block-4'
  ]) {
    members.set(actor, Object.freeze({ user_id: actor, role: 'member', nickname: actor }))
  }
  const group = Object.freeze({
    getMemberMap: async () => members,
    sendMsg: async (message: unknown) => {
      visibleMessages.push(message)
      return Object.freeze({ message_id: `visible-${visibleMessages.length}` })
    },
    recallMsg: async () => true,
    muteMember: async (userId: unknown, seconds: unknown) => {
      muted.push(Object.freeze({ userId, seconds }))
    },
    kickMember: async () => undefined,
    setCard: async () => undefined,
    setTitle: async () => undefined
  })
  const friend = Object.freeze({
    sendMsg: async (message: unknown) => {
      visibleMessages.push(message)
      return Object.freeze({ message_id: `visible-${visibleMessages.length}` })
    },
    recallMsg: async () => true
  })
  const bot = Object.freeze({
    uin: 'bot-1',
    pickGroup: () => group,
    pickFriend: () => friend,
    getFriendList: async () => Object.freeze(['actor-approval']),
    setEssenceMessage: async () => undefined,
    removeEssenceMessage: async () => undefined
  })
  return { bot, group, visibleMessages, muted }
}

function groupEvent (input: Readonly<{
  marker: string
  actorId: string
  message?: readonly Readonly<Record<string, unknown>>[]
  groupId?: string
  msg?: string
  hasAlias?: boolean
  atme?: boolean
  isMaster?: boolean
  role?: 'owner' | 'admin' | 'member'
  messageId?: string
  sourceMessageId?: string
  quotedMessage?: Readonly<{
    readonly actorId: string
    readonly nickname: string
    readonly text: string
  }>
}>, host: HostFixture): YunzaiMessageEvent {
  const msg = input.msg ?? `#chat1 ${input.marker}`
  return {
    isGroup: true,
    group_id: input.groupId ?? `group-${input.actorId}`,
    self_id: 'bot-1',
    user_id: input.actorId,
    message_id: input.messageId ?? `message-${input.actorId}`,
    msg,
    message: input.message ?? Object.freeze([{ type: 'text', text: msg }]),
    sender: Object.freeze({
      user_id: input.actorId,
      role: input.role ?? 'member',
      nickname: input.actorId
    }),
    bot: host.bot as never,
    group: input.quotedMessage === undefined
      ? host.group
      : Object.freeze({
          ...host.group,
          getChatHistory: async () => Object.freeze([Object.freeze({
            message_id: input.sourceMessageId,
            sender: Object.freeze({
              user_id: input.quotedMessage?.actorId,
              nickname: input.quotedMessage?.nickname
            }),
            message: Object.freeze([Object.freeze({
              type: 'text', text: input.quotedMessage?.text
            })])
          })])
        }),
    ...(input.hasAlias === undefined ? {} : { hasAlias: input.hasAlias }),
    ...(input.atme === undefined ? {} : { atme: input.atme }),
    ...(input.isMaster === undefined ? {} : { isMaster: input.isMaster }),
    ...(input.sourceMessageId === undefined
      ? {}
      : { source: Object.freeze({ message_id: input.sourceMessageId }) })
  } as unknown as YunzaiMessageEvent
}

async function waitFor (predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function deliveredText (part: OutboundPart): string {
  return part.media === 'text'
    ? part.atoms.map(atom => atom.kind === 'text' ? atom.text : '').join('')
    : ''
}

function fixedModel (text = '日志正文'): ProductionModelPort & {
  readonly requests: ModelRequest[]
} {
  const requests: ModelRequest[] = []
  return Object.freeze({
    requests,
    async complete (request: ModelRequest): Promise<ModelTurn> {
      requests.push(request)
      return textTurn(text)
    },
    async generate (): Promise<readonly string[]> {
      return Object.freeze([])
    }
  })
}

const journalInitializationFailure = Object.freeze({
  event: 'groupmate.disk_log.initialization_failure',
  code: 'construction_failed'
})

test('disk journal construction failure falls back to the raw production graph', async () => {
  const host = hostFixture()
  const failures: Array<Readonly<Record<string, unknown>>> = []
  let factoryCalls = 0
  const fixture = graphFixture({
    model: fixedModel('构造失败仍可回复'),
    bot: host.bot,
    diskLogEnabled: true,
    diskLogFactory: () => {
      factoryCalls += 1
      throw new Error('sensitive disk path and content')
    },
    logger: Object.freeze({
      error: event => {
        failures.push(event)
        throw new Error('injected logger failure')
      }
    })
  })

  assert.equal(await fixture.graph.chatController.chatgpt1(groupEvent({
    marker: '落盘构造失败', actorId: 'actor-disk-failure'
  }, host)), true)
  assert.equal(deliveredText(fixture.dispatches[0]?.part as OutboundPart), '构造失败仍可回复')
  assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  assert.equal(factoryCalls, 1)
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0], journalInitializationFailure)
  assert.deepEqual(Reflect.ownKeys(failures[0] ?? {}), ['event', 'code'])
  assert.equal(Object.isFrozen(failures[0]), true)
  assert.doesNotMatch(JSON.stringify(failures), /sensitive|path|content|target|config/i)
})

test('outbound journal wrapper construction failure discards the journal and falls back once', async () => {
  const host = hostFixture()
  const journal = new RecordingContentJournal()
  const failures: Array<Readonly<Record<string, unknown>>> = []
  let wrapperCalls = 0
  const fixture = graphFixture({
    model: fixedModel('包装失败仍可回复'),
    bot: host.bot,
    diskLogEnabled: true,
    contentJournal: journal,
    journaledOutboundFactory: () => {
      wrapperCalls += 1
      throw new Error('hostile journal wrapper')
    },
    logger: Object.freeze({ error: event => { failures.push(event) } })
  })

  assert.equal(await fixture.graph.chatController.chatgpt1(groupEvent({
    marker: '日志包装失败', actorId: 'actor-wrapper-failure'
  }, host)), true)
  assert.equal(deliveredText(fixture.dispatches[0]?.part as OutboundPart), '包装失败仍可回复')
  assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  assert.equal(wrapperCalls, 1)
  assert.deepEqual(failures, [journalInitializationFailure])
  assert.equal(journal.requests.length, 0)
  assert.equal(journal.runEvents.length, 0)
  assert.equal(journal.outboundEvents.length, 0)
  assert.equal(journal.drainCalls, 0)
})

test('enabled production journal receives one complete request, provider run and outbound flow', async () => {
  const host = hostFixture()
  const model = fixedModel()
  const journal = new RecordingContentJournal()
  const fixture = graphFixture({
    model,
    bot: host.bot,
    diskLogEnabled: true,
    contentJournal: journal,
    promptPrefixOverride: '日志系统指令'
  })
  try {
    const handled = await fixture.graph.chatController.chatgpt1(groupEvent({
      marker: '完整日志请求',
      actorId: 'actor-journal',
      sourceMessageId: 'quoted-journal-message',
      quotedMessage: Object.freeze({
        actorId: 'actor-quoted', nickname: '被引用群友', text: '完整引用正文'
      })
    }, host))

    assert.equal(handled, true)
    assert.equal(journal.requests.length, 1)
    const request = journal.requests[0]
    assert.match(JSON.stringify(request.message), /完整日志请求/)
    assert.match(JSON.stringify(request.message.replyTo), /完整引用正文/)
    assert.match(JSON.stringify(request.systemInstructions), /日志系统指令/)
    assert.deepEqual(
      journal.runEvents.map(event => event.type),
      ['provider.request', 'provider.response', 'run.terminal_committed']
    )
    assert.match(
      JSON.stringify(journal.runEvents.find(event => event.type === 'provider.request')),
      /完整日志请求/
    )
    assert.match(
      JSON.stringify(journal.runEvents.find(event => event.type === 'provider.response')),
      /日志正文/
    )
    assert.equal(journal.outboundEvents.length, 1)
    assert.equal(journal.outboundEvents[0]?.type, 'qq.outbound.deliver')
    assert.equal(deliveredText(fixture.dispatches[0]?.part as OutboundPart), '日志正文')
    assert.equal(model.requests.length, 1)
  } finally {
    assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  }
  assert.equal(journal.drainCalls, 1)
})

test('visible tools reuse the selected production outbound factory and journal their delivery', async () => {
  const host = hostFixture()
  const journal = new RecordingContentJournal()
  const scenario = new ControllerScenarioModel()
  const fixture = graphFixture({
    model: scenario,
    bot: host.bot,
    diskLogEnabled: true,
    contentJournal: journal,
    dispatchResult: (part, messageId) => part.media === 'dice'
      ? oneBotSuccessProxy(messageId)
      : Object.freeze({ message_id: messageId })
  })
  try {
    assert.equal(await fixture.graph.chatController.chatgpt1(groupEvent({
      marker: '骰子请求', actorId: 'actor-dice', msg: '#chat1 骰子请求，请投掷 1 个骰子'
    }, host)), true)

    assert.deepEqual(fixture.dispatches.map(item => item.part.media), ['text', 'dice'])
    assert.equal(host.visibleMessages.length, 0)
    assert.deepEqual(
      journal.outboundEvents.map(event => (
        event.type === 'qq.outbound.deliver' ? event.part.media : event.type
      )),
      ['text', 'dice']
    )
    const diceEvents = journal.outboundEvents.filter(event => (
      event.type === 'qq.outbound.deliver' && event.part.media === 'dice'
    ))
    assert.equal(diceEvents.length, 1)
    const diceEvent = diceEvents[0]
    assert.equal(diceEvent?.type, 'qq.outbound.deliver')
    if (diceEvent?.type !== 'qq.outbound.deliver') assert.fail('expected dice delivery event')
    assert.equal(diceEvent.result.kind, 'sent')
    assert.deepEqual(diceEvent.target, {
      botId: 'bot-1', scope: { kind: 'group', groupId: 'group-actor-dice' }
    })
    assert.equal(scenario.count('骰子请求'), 1)
    assert.equal(scenario.requests.length, 1)
    const terminal = journal.runEvents.at(-1)
    assert.equal(terminal?.type, 'run.terminal_committed')
    if (terminal?.type !== 'run.terminal_committed') assert.fail('expected terminal journal event')
    assert.deepEqual(terminal.checkpoint.completion, {
      kind: 'already_visible', source: 'tool_output'
    })
  } finally {
    assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  }
})

test('visible tool unknown dispatch outcome terminates once without provider or tool retry', async () => {
  const host = hostFixture()
  const journal = new RecordingContentJournal()
  const scenario = new ControllerScenarioModel()
  const fixture = graphFixture({
    model: scenario,
    bot: host.bot,
    diskLogEnabled: true,
    contentJournal: journal,
    dispatchResult: (part, messageId) => part.media === 'dice'
      ? undefined
      : Object.freeze({ message_id: messageId })
  })
  try {
    assert.equal(await fixture.graph.chatController.chatgpt1(groupEvent({
      marker: '骰子请求',
      actorId: 'actor-dice-unknown',
      msg: '#chat1 骰子请求，请投掷 1 个骰子'
    }, host)), true)

    const diceDispatches = fixture.dispatches.filter(item => item.part.media === 'dice')
    assert.equal(diceDispatches.length, 1)
    assert.equal(scenario.requests.length, 1)
    assert.equal(scenario.count('骰子请求'), 1)

    const diceOutbound = journal.outboundEvents.filter(event => (
      event.type === 'qq.outbound.deliver' && event.part.media === 'dice'
    ))
    assert.equal(diceOutbound.length, 1)
    assert.equal(diceOutbound[0]?.type, 'qq.outbound.deliver')
    if (diceOutbound[0]?.type !== 'qq.outbound.deliver') {
      assert.fail('expected one dice delivery event')
    }
    assert.deepEqual(diceOutbound[0].result, {
      kind: 'outcome_unknown',
      media: 'dice',
      attempt: 1,
      code: 'unknown_host_result'
    })

    const warning = '操作结果暂时无法确认，请勿重复提交'
    assert.equal(fixture.dispatches.filter(item => deliveredText(item.part) === warning).length, 1)

    const terminal = journal.runEvents.at(-1)
    assert.equal(terminal?.type, 'run.terminal_committed')
    if (terminal?.type !== 'run.terminal_committed') {
      assert.fail('expected terminal journal event')
    }
    assert.equal(terminal.checkpoint.status, 'failed')
    assert.equal(terminal.checkpoint.error?.code, 'tool_outcome_unknown')
    assert.equal(terminal.checkpoint.observationCounters.providerAttempts, 1)
    assert.equal(terminal.checkpoint.observationCounters.modelTurns, 1)
    assert.equal(terminal.checkpoint.observationCounters.toolCalls, 1)
    assert.equal(terminal.checkpoint.observationCounters.toolAttempts, 1)
    assert.equal(terminal.checkpoint.observationCounters.providerRetries, 0)
    assert.equal(
      journal.runEvents.filter(event => event.type === 'provider.request').length,
      1
    )
    assert.equal(
      journal.runEvents.filter(event => event.type === 'provider.response').length,
      1
    )
  } finally {
    assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  }
})

test('production wraps its selected outbound factory once for delivery and recall', async () => {
  const journal = new RecordingContentJournal()
  const fixture = graphFixture({
    model: fixedModel(),
    diskLogEnabled: true,
    contentJournal: journal,
    journalNow: () => new Date('2026-07-17T03:04:05.000Z')
  })
  const target: SessionAddress = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'journal-group' })
  })
  const part: OutboundPart = Object.freeze({
    media: 'text',
    atoms: Object.freeze([Object.freeze({ kind: 'text', text: '出站完整正文' })])
  })
  try {
    const port = await fixture.graph.outboundFactory.forTarget(target)
    const delivered = await port.deliver(part, 1, { quoteMessageId: 'quoted-outbound' })
    assert.equal(delivered.kind, 'sent')
    if (delivered.kind !== 'sent') assert.fail('fixture delivery must succeed')
    const recalled = await port.recall(delivered.receipt)

    assert.deepEqual(recalled, { kind: 'recalled' })
    assert.deepEqual(journal.outboundEvents.map(event => event.type), [
      'qq.outbound.deliver', 'qq.outbound.recall'
    ])
    const deliveryEvent = journal.outboundEvents[0]
    const recallEvent = journal.outboundEvents[1]
    assert.ok(deliveryEvent?.type === 'qq.outbound.deliver')
    assert.ok(recallEvent?.type === 'qq.outbound.recall')
    assert.equal(deliveryEvent.result, delivered)
    assert.equal(recallEvent.result, recalled)
    assert.equal(deliveryEvent.part, part)
    assert.deepEqual(deliveryEvent.target, target)
    assert.equal(deliveryEvent.quoteMessageId, 'quoted-outbound')
    assert.equal(recallEvent.receipt, delivered.receipt)
    assert.equal(fixture.dispatches.length, 1)
    assert.equal(fixture.recalls.length, 1)
  } finally {
    await fixture.graph.shutdown('unit_test')
  }
})

test('omitted and false disk log configuration never touches an injected journal', async () => {
  for (const diskLogEnabled of [undefined, false] as const) {
    const journal = new RecordingContentJournal()
    const fixture = graphFixture({
      model: fixedModel(),
      contentJournal: journal,
      ...(diskLogEnabled === undefined ? {} : { diskLogEnabled })
    })
    const target: SessionAddress = Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'private', userId: 'journal-user' })
    })
    const port = await fixture.graph.outboundFactory.forTarget(target)
    await port.deliver(Object.freeze({
      media: 'text',
      atoms: Object.freeze([Object.freeze({ kind: 'text', text: '禁用日志' })])
    }), 1)
    assert.equal(await fixture.graph.shutdown('unit_test'), 0)

    assert.equal(journal.requests.length, 0)
    assert.equal(journal.runEvents.length, 0)
    assert.equal(journal.outboundEvents.length, 0)
    assert.equal(journal.drainCalls, 0)
  }
})

test('throwing production journal callbacks cannot alter model, presentation or shutdown', async () => {
  const host = hostFixture()
  const journal = new RecordingContentJournal()
  journal.throwOnRecord = true
  journal.throwOnDrain = true
  const fixture = graphFixture({
    model: fixedModel('投影失败仍可见'),
    bot: host.bot,
    diskLogEnabled: true,
    contentJournal: journal
  })

  assert.equal(await fixture.graph.chatController.chatgpt1(groupEvent({
    marker: '日志回调失败', actorId: 'actor-throwing-journal'
  }, host)), true)
  assert.equal(fixture.dispatches.length, 1)
  assert.equal(deliveredText(fixture.dispatches[0]?.part as OutboundPart), '投影失败仍可见')
  assert.equal(await fixture.graph.shutdown('unit_test'), 0)
  assert.equal(journal.drainCalls, 1)
})

test('journal activity consumes only its dedicated clock', async () => {
  const execute = async (enabled: boolean): Promise<Readonly<{
    authoritativeReads: number
    journalReads: number
  }>> => {
    let authoritativeReads = 0
    let journalReads = 0
    let generatedIds = 0
    const host = hostFixture()
    const journal = new RecordingContentJournal()
    const fixture = graphFixture({
      model: fixedModel(),
      bot: host.bot,
      diskLogEnabled: enabled,
      observabilityLevel: 'diagnostic',
      contentJournal: journal,
      generateId: () => `clock-id-${++generatedIds}`,
      createRequestRef: () => 'c'.repeat(32),
      now: () => {
        authoritativeReads += 1
        return new Date(Date.parse(createdAt) + authoritativeReads)
      },
      journalNow: () => {
        journalReads += 1
        return new Date('2026-07-17T03:04:05.000Z')
      }
    })
    await fixture.graph.chatController.chatgpt1(groupEvent({
      marker: '时钟隔离请求', actorId: 'actor-clock'
    }, host))
    await fixture.graph.shutdown('unit_test')
    await fixture.graph.observability.hub.drain()
    return { authoritativeReads, journalReads }
  }

  const disabled = await execute(false)
  const enabled = await execute(true)
  assert.equal(enabled.authoritativeReads, disabled.authoritativeReads)
  assert.ok(enabled.journalReads > 0)
  assert.equal(disabled.journalReads, 0)
})

test('shutdown waits for one journal drain and preserves idempotent bridge count', async () => {
  let releaseDrain: (() => void) | undefined
  const journal = new RecordingContentJournal()
  journal.blockedDrain = new Promise(resolve => { releaseDrain = resolve })
  const fixture = graphFixture({
    model: fixedModel(), diskLogEnabled: true, contentJournal: journal
  })
  let settled = false
  const first = fixture.graph.shutdown('first_reason')
  const second = fixture.graph.shutdown('ignored_reason')
  void first.then(() => { settled = true })
  await waitFor(() => journal.drainCalls === 1, 'blocked journal drain')
  assert.equal(settled, false)
  assert.equal(journal.drainCalls, 1)

  releaseDrain?.()
  assert.deepEqual(await Promise.all([first, second]), [0, 0])
  assert.equal(journal.drainCalls, 1)
})

test('production presentation covers ordinary proactive approval and all terminal kinds', async () => {
  const host = hostFixture()
  const scenario = new ControllerScenarioModel()
  const activeBymPolicy: BymPolicySnapshot = Object.freeze({
    ...disabledBymPolicy,
    enabled: true,
    retaliationWords: Object.freeze(['坏蛋']),
    retaliationRecallEnabled: true,
    retaliationRecallSeconds: 1
  })
  const fixture = graphFixture({
    model: scenario,
    bot: host.bot,
    bymPolicy: activeBymPolicy,
    settingsForActor: actorId => {
      if (actorId === 'actor-text') return presentationSettings({ forwardReasoning: true })
      if (actorId === 'actor-picture') return presentationSettings({ forcePicture: true })
      if (actorId === 'actor-tts') return presentationSettings({ tts: true, alsoSendText: true })
      if (actorId === 'actor-dice') return presentationSettings({ forwardToolDetails: true })
      return presentationSettings()
    }
  })
  const { graph, dispatches, observations } = fixture
  let shutdown = false
  try {
    const ordinaryStart = dispatches.length
    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '普通文字请求', actorId: 'actor-text'
    }, host)), true)
    const ordinary = dispatches.slice(ordinaryStart)
    assert.deepEqual(ordinary.map(item => item.part.media), ['text', 'forward'])
    assert.equal(deliveredText(ordinary[0]?.part as OutboundPart), '普通正文')
    assert.equal(ordinary[1]?.part.media === 'forward' ? ordinary[1].part.title : null, '思考过程')
    assert.match(JSON.stringify(ordinary[1]?.part), /生产链路思考/)

    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '图片请求', actorId: 'actor-picture', msg: '#图片chat1 图片请求'
    }, host)), true)
    assert.equal(dispatches.at(-1)?.part.media, 'picture')

    const ttsStart = dispatches.length
    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '语音请求', actorId: 'actor-tts'
    }, host)), true)
    assert.deepEqual(
      dispatches.slice(ttsStart).map(item => item.part.media),
      ['text', 'voice']
    )

    const visibleStart = dispatches.length
    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '骰子请求', actorId: 'actor-dice', msg: '#chat1 骰子请求，请投掷 1 个骰子'
    }, host)), true)
    const visible = dispatches.slice(visibleStart)
    assert.deepEqual(visible.map(item => item.part.media), ['text', 'dice', 'forward'])
    assert.deepEqual(visible.map(item => deliveredText(item.part)), [
      '正在执行任务步骤（步骤 1）',
      '',
      ''
    ])
    assert.equal(visible[2]?.part.media === 'forward' ? visible[2].part.title : null, '工具执行详情')
    assert.match(JSON.stringify(visible[2]?.part), /工具执行：sendDice|结果已通过工具发送/)
    assert.equal(host.visibleMessages.length, 0)

    const silenceStart = dispatches.length
    assert.equal(await graph.bymController.bym(groupEvent({
      marker: '主动静默请求',
      actorId: 'actor-silence',
      msg: '主动静默请求',
      hasAlias: true
    }, host)), false)
    assert.equal(dispatches.length, silenceStart)

    const proactiveStart = dispatches.length
    const recallStart = fixture.recalls.length
    assert.equal(await graph.bymController.bym(groupEvent({
      marker: '主动拆分坏蛋请求',
      actorId: 'actor-split',
      msg: '主动拆分坏蛋请求',
      hasAlias: true
    }, host)), false)
    const proactive = dispatches.slice(proactiveStart)
    assert.deepEqual(proactive.map(item => deliveredText(item.part)), ['一', '二', '三。'])
    await waitFor(
      () => fixture.recalls.length - recallStart === proactive.length,
      'proactive receipt recalls'
    )

    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '失败请求', actorId: 'actor-failed'
    }, host)), true)
    assert.doesNotMatch(
      deliveredText(dispatches.at(-1)?.part as OutboundPart),
      /Provider 细节|fixture\.provider/
    )

    const cancellation = graph.chatController.chatgpt1(groupEvent({
      marker: '取消请求', actorId: 'actor-cancel'
    }, host))
    await scenario.cancelStarted
    assert.equal(await graph.shutdown('unit_test_cancel'), 0)
    shutdown = true
    assert.equal(await cancellation, true)
    assert.equal(dispatches.at(-1)?.part.media, 'text')

    assert.equal(fixture.pictureCalls(), 1)
    assert.equal(fixture.ttsCalls(), 1)
    for (const marker of [
      '普通文字请求', '图片请求', '语音请求', '骰子请求',
      '主动静默请求', '主动拆分坏蛋请求', '失败请求', '取消请求'
    ]) {
      assert.equal(scenario.count(marker), 1, marker)
    }
    assert.equal(observations.length, 8)
    assert.equal(new Set(observations.map(item => item.requestRef)).size, 8)
    assert.deepEqual(
      observations.map(item => item.requestKind),
      ['ordinary_chat', 'ordinary_chat', 'ordinary_chat', 'ordinary_chat',
        'proactive_chat', 'proactive_chat', 'ordinary_chat', 'ordinary_chat']
    )
    await graph.observability.hub.drain()
    const metrics = await graph.observability.metrics.snapshot()
    assert.ok(metrics.counters.some(point => (
      point.name === 'groupmate.presentation.deliveries' && point.value > 0
    )))
    assert.ok((await graph.observability.traceStore.usage()).records >= 2)
  } finally {
    if (!shutdown) await graph.shutdown('unit_test')
  }
})

test('production presentation preserves session-save failure across text visible and silence', async () => {
  const redis = new SessionSaveFailingRedis()
  const host = hostFixture()
  const scenario = new ControllerScenarioModel()
  const fixture = graphFixture({
    redis,
    model: scenario,
    bot: host.bot,
    bymPolicy: Object.freeze({ ...disabledBymPolicy, enabled: true })
  })
  const { graph, dispatches, observations } = fixture
  try {
    const textStart = dispatches.length
    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '普通文字请求', actorId: 'actor-text-save-failure'
    }, host)), true)
    assert.deepEqual(dispatches.slice(textStart).map(item => deliveredText(item.part)), [
      '普通正文',
      SESSION_PERSISTENCE_FAILED_MESSAGE
    ])

    const visibleStart = dispatches.length
    assert.equal(await graph.chatController.chatgpt1(groupEvent({
      marker: '骰子请求',
      actorId: 'actor-dice-save-failure',
      msg: '#chat1 骰子请求，请投掷 1 个骰子'
    }, host)), true)
    assert.deepEqual(dispatches.slice(visibleStart).map(item => deliveredText(item.part)), [
      '正在执行任务步骤（步骤 1）',
      '',
      SESSION_PERSISTENCE_FAILED_MESSAGE
    ])
    assert.equal(host.visibleMessages.length, 0)

    const silenceStart = dispatches.length
    assert.equal(await graph.bymController.bym(groupEvent({
      marker: '主动静默请求',
      actorId: 'actor-silence-save-failure',
      msg: '主动静默请求',
      hasAlias: true
    }, host)), false)
    assert.equal(dispatches.length, silenceStart)
    assert.equal(redis.sessionSaveFailures, 2)
    assert.equal(scenario.count('普通文字请求'), 1)
    assert.equal(scenario.count('骰子请求'), 1)
    assert.equal(scenario.count('主动静默请求'), 1)
    assert.deepEqual(observations.map(item => item.outcome), [
      'failed_session_save', 'failed_session_save', 'completed'
    ])
  } finally {
    await graph.shutdown('unit_test')
  }
})

test('production approval deferral retains reference and later retry finalizes once', async () => {
  const redis = new FakeRedis()
  const host = hostFixture()
  const initialModel = new ApprovalModel()
  const initial = graphFixture({
    redis,
    model: initialModel,
    bot: host.bot,
    toolPolicyProfile: 'safe'
  })
  let recovery: ReturnType<typeof graphFixture> | undefined
  let pressureModel: RecoveryPressureModel | undefined
  try {
    const approvalEvent = groupEvent({
      marker: '审批禁言请求',
      actorId: '7',
      groupId: '9',
      msg: '#图片chat1 审批禁言请求，请禁言 QQ:8 60 秒',
      message: Object.freeze([
        Object.freeze({ type: 'text', text: '#图片chat1 审批禁言请求，请禁言 QQ:8 ' }),
        Object.freeze({ type: 'at', qq: 8, text: '@测试小号' }),
        Object.freeze({ type: 'text', text: ' 60 秒' })
      ]),
      atme: true,
      isMaster: true,
      role: 'owner',
      messageId: 'approval-original-request'
    }, host)
    assert.equal(
      await initial.graph.chatController.chatgpt1(approvalEvent),
      true,
      JSON.stringify(initial.dispatches.map(item => item.part))
    )
    assert.equal(
      initialModel.requests.length,
      1,
      JSON.stringify(initialModel.requests.at(-1)?.messages.filter(message => message.role === 'tool'))
    )
    assert.equal(initial.observations.length, 0)
    assert.equal(initial.dispatches.length, 1)
    assert.equal(initial.dispatches[0]?.part.media, 'text')

    const approvalDelivery = initial.dispatches[0]
    if (approvalDelivery === undefined) assert.fail('approval delivery is missing')
    const index = new RedisApprovalReferenceIndex(redis)
    const reference = await index.load(approvalDelivery.target, approvalDelivery.messageId)
    assert.ok(reference !== null)
    const store = new RedisRunStore({ client: redis })
    const paused = await store.load(reference.runId)
    assert.ok(paused !== null)
    if (paused.schemaVersion !== 3) assert.fail('approval checkpoint must use schema v3')
    assert.equal(paused.status, 'waiting_approval')
    assert.equal(paused.completion, null)
    assert.equal(paused.output, null)
    assert.equal(paused.presentationRoute?.requestKind, 'ordinary_chat')
    const intentBytes = JSON.stringify(paused.presentationRoute?.presentationIntent)
    assert.equal(intentBytes, JSON.stringify({
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: true
    }))

    const activePressureModel = new RecoveryPressureModel()
    pressureModel = activePressureModel
    recovery = graphFixture({
      redis,
      model: activePressureModel,
      bot: host.bot,
      toolPolicyProfile: 'safe'
    })
    const recoveryGraph = recovery
    const blockers = Array.from({ length: 5 }, (_, indexValue) => (
      recoveryGraph.graph.chatController.chatgpt1(groupEvent({
        marker: `阻塞任务-${indexValue}`,
        actorId: `actor-block-${indexValue}`
      }, host))
    ))
    await waitFor(
      () => activePressureModel.requests.length === 2 &&
        activePressureModel.activeResolvers.length === 2,
      'two active recovery pressure runs'
    )

    const confirmation = groupEvent({
      marker: '审批确认',
      actorId: '7',
      groupId: '9',
      msg: '确认',
      message: Object.freeze([Object.freeze({ type: 'text', text: '确认' })]),
      isMaster: true,
      role: 'owner',
      messageId: 'approval-decision-request',
      sourceMessageId: approvalDelivery.messageId
    }, host)
    assert.equal(await recovery.graph.approvalController.confirmToolOperation(confirmation), true)
    assert.equal(activePressureModel.requests.length, 2)
    assert.equal(recovery.observations.length, 0)
    assert.equal(
      deliveredText(recovery.dispatches.at(-1)?.part as OutboundPart),
      APPROVAL_RECOVERY_DEFERRED_MESSAGE
    )
    assert.deepEqual(
      await index.load(approvalDelivery.target, approvalDelivery.messageId),
      reference
    )
    const deferred = await store.load(reference.runId)
    assert.ok(deferred !== null)
    if (deferred.schemaVersion !== 3) assert.fail('deferred checkpoint must use schema v3')
    assert.equal(JSON.stringify(deferred.presentationRoute?.presentationIntent), intentBytes)
    assert.equal(deferred.completion, null)

    activePressureModel.releaseActive()
    assert.deepEqual(await Promise.all(blockers), [true, true, true, true, true])
    assert.equal(activePressureModel.requests.length, 5)
    assert.equal(recovery.observations.length, 5)

    const finalStart = recovery.dispatches.length
    assert.equal(await recovery.graph.approvalController.confirmToolOperation(confirmation), true)
    assert.equal(activePressureModel.requests.length, 6)
    assert.deepEqual(host.muted, [Object.freeze({ userId: 8, seconds: 60 })])
    assert.equal(recovery.pictureCalls(), 1)
    assert.deepEqual(
      recovery.dispatches.slice(finalStart).map(item => item.part.media),
      ['text', 'picture']
    )
    assert.equal(
      deliveredText(recovery.dispatches[finalStart]?.part as OutboundPart),
      '正在执行任务步骤（步骤 1）'
    )
    const resumedPicture = recovery.dispatches[finalStart + 1]
    assert.equal(resumedPicture?.part.media, 'picture')
    const pausedAddress = paused.presentationRoute?.sessionAddress
    assert.ok(pausedAddress !== undefined && pausedAddress.scope.kind === 'group_user')
    assert.deepEqual(resumedPicture?.target, {
      botId: pausedAddress.botId,
      scope: { kind: 'group', groupId: pausedAddress.scope.groupId }
    })
    assert.equal(resumedPicture?.quoteMessageId, 'approval-original-request')
    assert.notEqual(resumedPicture?.quoteMessageId, 'approval-decision-request')
    assert.equal(recovery.observations.length, 6)
    assert.equal(new Set(recovery.observations.map(item => item.requestRef)).size, 6)
    assert.equal(await index.load(approvalDelivery.target, approvalDelivery.messageId), null)
    assert.equal(await store.load(reference.runId), null)
    assert.equal(await recovery.graph.approvalController.confirmToolOperation(confirmation), false)
    assert.equal(recovery.observations.length, 6)
  } finally {
    pressureModel?.releaseActive()
    await recovery?.graph.shutdown('unit_test')
    await initial.graph.shutdown('unit_test')
  }
})
