import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PresentationRouteV1 } from '../../src/agent/contracts/interaction.js'
import type { ChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import type { PreparedYunzaiMessageEvidenceV1 } from '../../src/runtime/message-input.js'
import type { PresentationResult } from '../../src/runtime/presentation/presentation-result.js'
import type { PresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import type { PresentationInput } from '../../src/runtime/runtime-presentation-hooks.js'
import {
  buildYunzaiChatRules,
  createYunzaiChatController,
  type ChatEntryPolicySnapshot,
  type ChatPreferences,
  type YunzaiChatControllerOptions
} from '../../src/runtime/yunzai-chat-controller.js'

const settings: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: true,
  enableRobotAt: false,
  enableMarkdown: false,
  enableSuggestedResponses: true,
  forwardReasoning: false,
  forwardToolDetails: false,
  blockWords: Object.freeze([]),
  promptBlockWords: Object.freeze([]),
  tts: Object.freeze({
    enabled: false,
    mode: 'vits-uma-genshin-honkai',
    activeVoice: 'default',
    alsoSendText: false,
    autoFallbackThreshold: 299,
    filter: null,
    azureEmotionEnabled: false
  }),
  picture: Object.freeze({
    userEnabled: false,
    autoEnabled: false,
    autoThreshold: 1_200,
    deviceScaleFactor: 1,
    closeBrowserAfterRender: true,
    showQRCode: false,
    live2d: null
  })
})

const policy: ChatEntryPolicySnapshot = Object.freeze({
  toggleMode: 'prefix',
  enablePrivateChat: true,
  whitelist: Object.freeze([]),
  blacklist: Object.freeze([]),
  imgOcr: true,
  groupMerge: false,
  enableGroupContext: true,
  thinkingMode: 'enabled',
  reasoningEffort: 'high',
  sessionTtlSeconds: 600,
  assistantLabel: '派蒙',
  promptPrefixOverride: '自然地参与群聊。',
  actorCastApi: '你是可靠的群友。'
})

const preferences: ChatPreferences = Object.freeze({
  usePicture: false,
  useTTS: false,
  ttsRole: '纳西妲（草神）',
  ttsRoleAzure: 'zh-CN-XiaoxiaoNeural',
  ttsRoleVoiceVox: '四国めたん-ノーマル'
})

const presentationResult: PresentationResult = Object.freeze({
  schemaVersion: 1,
  outcome: 'complete',
  deliveries: Object.freeze([])
})

const sentPresentationResult: PresentationResult = Object.freeze({
  schemaVersion: 1,
  outcome: 'complete',
  deliveries: Object.freeze([Object.freeze({
    kind: 'sent' as const,
    media: 'text' as const,
    attempt: 1 as const,
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      media: 'text' as const,
      messageId: 'reply-1'
    }) as never
  })])
})

function event (overrides: Record<string, unknown> = {}) {
  return {
    isGroup: true,
    isPrivate: false,
    isMaster: false,
    atme: true,
    group_id: 'group-1',
    self_id: 'bot-1',
    user_id: 'actor-1',
    message_id: 'message-1',
    msg: '#chat1 你好',
    message: [{ type: 'text', text: '#chat1 你好' }],
    sender: { user_id: 'actor-1', nickname: '群友', role: 'member' },
    ...overrides
  }
}

function completedEnvelope (text = '你好呀'): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'completed',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    completion: Object.freeze({ kind: 'reply_text', text }),
    output: Object.freeze({
      role: 'assistant',
      parts: Object.freeze([Object.freeze({ type: 'text', text })])
    }),
    terminal: null,
    requestObservationDraft: Object.freeze({}),
    sessionPersistence: 'saved'
  }) as unknown as ChatReplyEnvelope
}

function pausedEnvelope (): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'paused',
    runId: 'run-paused',
    runRef: '2'.repeat(32),
    interruption: Object.freeze({})
  }) as unknown as ChatReplyEnvelope
}

function preparedRequest (prompt: string, forcePicture: boolean): Readonly<{
  route: Extract<PresentationRouteV1, { requestKind: 'ordinary_chat' }>
  evidence: PreparedYunzaiMessageEvidenceV1
}> {
  const route = Object.freeze({
    schemaVersion: 1 as const,
    requestKind: 'ordinary_chat' as const,
    profile: 'ordinary' as const,
    presentationIntent: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'ordinary' as const,
      forcePicture
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-1',
      scope: Object.freeze({ kind: 'group_user' as const, groupId: 'group-1', userId: 'actor-1' })
    }),
    actorId: 'actor-1',
    requestMessageId: 'message-1'
  })
  const evidence = Object.freeze({
    schemaVersion: 1 as const,
    prompt,
    imageUrls: Object.freeze(['https://example.com/current.png', 'https://example.com/quote.png']),
    currentMessageId: 'message-1',
    quotedMessageId: 'quoted-1',
    quotedMessage: Object.freeze({
      messageId: 'quoted-1',
      sender: Object.freeze({ userId: 'quoted-user' }),
      parts: Object.freeze([Object.freeze({
        type: 'resource_ref' as const,
        resourceType: 'image' as const,
        resourceId: 'https://example.com/quote.png'
      })])
    }),
    hasReply: true,
    replyResolved: true,
    currentSegmentCount: 2,
    replySegmentCount: 2,
    ocrTexts: Object.freeze(['图片文字'])
  })
  return Object.freeze({ route, evidence })
}

function fixture (input: Readonly<{
  policy?: ChatEntryPolicySnapshot
  blocked?: boolean
  muted?: boolean
  envelope?: ChatReplyEnvelope
  agentError?: unknown
  settings?: PresentationSettings
  presentationResult?: PresentationResult
  candidateEnqueue?: (input: unknown) => Promise<void>
}> = {}) {
  const calls: string[] = []
  const commandReplies: Array<{ message: string, quote: boolean }> = []
  const routeNotices: Array<{ route: PresentationRouteV1, message: string, quote: boolean }> = []
  const requestInputs: unknown[] = []
  const agentInputs: unknown[] = []
  const presentationInputs: PresentationInput[] = []
  const preferencePatches: Array<Readonly<Partial<ChatPreferences>>> = []
  const candidateInputs: unknown[] = []
  let completionCalls = 0
  let ocrCalls = 0
  let preparationCalls = 0
  let lifecycleCalls = 0
  let deleteCalls = 0
  const currentPolicy = input.policy ?? policy
  const options: YunzaiChatControllerOptions = {
    policy: {
      entryMode: () => currentPolicy.toggleMode,
      snapshot: async () => currentPolicy,
      isMuted: async () => {
        calls.push('mute')
        return input.muted === true
      },
      ocrText: async () => {
        ocrCalls += 1
        calls.push('ocr')
        return Object.freeze(['图片文字'])
      },
      appendAzureEmotionFeedback: async ({ prompt }) => {
        calls.push('emotion')
        return prompt
      },
      clearAzureEmotionFeedback: async () => {
        calls.push('clear-emotion')
      }
    },
    preferences: {
      load: async () => preferences,
      patch: async (_actorId, patch) => {
        preferencePatches.push(patch)
        return Object.freeze({ ...preferences, ...patch })
      }
    },
    ttsAdministration: {
      getMode: () => 'vits-uma-genshin-honkai',
      setMode: mode => { calls.push(`tts-mode:${mode}`) },
      isConfigured: () => true,
      selectVoice: (mode, requested) => Object.freeze({
        kind: 'selected' as const,
        storedVoice: requested,
        message: `selected:${mode}:${requested}`
      }),
      missingConfigurationMessage: (mode, operation) => `missing:${mode}:${operation}`
    },
    billing: {
      queryLastHundredDays: async () => Object.freeze({
        hardLimitUsd: 20,
        totalUsageUsd: 3.5,
        expiresAt: new Date('2026-08-01T00:00:00.000Z')
      })
    },
    suggestions: {
      generate: async () => Object.freeze(['继续说', '#chatgpt文本模式', '继续说', '换个话题'])
    },
    promptScreening: {
      isBlocked: async ({ prompt }) => {
        calls.push(`screen:${prompt}`)
        return input.blocked === true
      }
    },
    requests: {
      prepare: async ({ prompt, presentationIntent }) => {
        preparationCalls += 1
        calls.push('prepare')
        requestInputs.push({ prompt, presentationIntent })
        return preparedRequest(prompt, presentationIntent.forcePicture)
      }
    },
    agent: {
      conversations: {
        get: async () => null,
        list: async function * () {},
        delete: async () => {
          deleteCalls += 1
          return true
        },
        deleteAll: async () => 2,
        fork: async (_source, target, startedBy) => ({
          schemaVersion: 1,
          sessionId: 'joined',
          botId: target.botId,
          scope: target.scope,
          startedBy,
          createdAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z',
          turnCount: 0,
          state: { schemaVersion: 1, messages: [] }
        }),
      },
      handle: async (currentEvent, evidence, handleOptions) => {
        calls.push('agent')
        agentInputs.push({ currentEvent, evidence, handleOptions })
        if (input.agentError !== undefined) throw input.agentError
        return input.envelope ?? completedEnvelope()
      }
    },
    controls: {
      presentCommand: async ({ message, quote }) => {
        commandReplies.push({ message, quote })
      },
      presentRouteNotice: async notice => {
        routeNotices.push(notice)
      }
    },
    presentationSettings: {
      load: async () => input.settings ?? settings
    },
    hooks: {
      forActiveEvent: () => {
        calls.push('hooks')
        return Object.freeze({
          postprocess: async ({ text }: { readonly text: string }) => Object.freeze({ text }),
          convertText: async ({ text }: { readonly text: string }) =>
            Object.freeze([{ kind: 'text' as const, text }]),
          notifyResponsePost: () => undefined
        })
      }
    },
    lifecycle: {
      create: async lifecycleInput => {
        lifecycleCalls += 1
        calls.push('lifecycle')
        assert.equal(lifecycleInput.route.presentationIntent.forcePicture,
          lifecycleInput.profile.forcePicture)
        return Object.freeze({
          onRunStarted: async () => undefined,
          onRunSettled: async () => undefined
        })
      }
    },
    presenter: {
      present: async presentationInput => {
        calls.push('present')
        presentationInputs.push(presentationInput)
        return input.presentationResult ?? presentationResult
      }
    },
    completionCoordinator: {
      complete: async ({ envelope, present }) => {
        completionCalls += 1
        calls.push('complete')
        return await present(Object.freeze({
          result: envelope as never,
          sessionPersistence: envelope.sessionPersistence
        }))
      }
    },
    diagnostics: {
      record: entry => {
        assert.equal(JSON.stringify(entry).includes('你好呀'), false)
      }
    },
    ...(input.candidateEnqueue === undefined
      ? {}
      : {
          postReplyCandidate: {
            enqueue: async (value: unknown) => {
              candidateInputs.push(value)
              await input.candidateEnqueue!(value)
            }
          }
        }),
    now: () => new Date('2026-07-17T12:00:00.000Z')
  }
  return {
    controller: createYunzaiChatController(options, ['api', 'API']),
    options,
    calls,
    commandReplies,
    routeNotices,
    requestInputs,
    agentInputs,
    presentationInputs,
    candidateInputs,
    preferencePatches,
    completionCalls: () => completionCalls,
    ocrCalls: () => ocrCalls,
    preparationCalls: () => preparationCalls,
    lifecycleCalls: () => lifecycleCalls,
    deleteCalls: () => deleteCalls
  }
}

test('chat controller gives the Yunzai loader mutable rule clones', () => {
  const controller = fixture().controller
  const hostRules = controller.hostRules()

  assert.notEqual(hostRules, controller.rules)
  assert.equal(Object.isFrozen(hostRules), false)
  for (const rule of hostRules) {
    assert.equal(Object.isFrozen(rule), false)
    if (!(rule.reg instanceof RegExp)) rule.reg = new RegExp(rule.reg)
  }
  assert.equal(hostRules.every(rule => rule.reg instanceof RegExp), true)
  assert.equal(typeof controller.rules[0]?.reg, 'string')
  assert.equal(Object.isFrozen(controller.rules[0]), true)
})

test('chat and chat1 preserve every command at permission OCR quote and force-picture gate', async () => {
  const expectedMethods = [
    'hostRules', 'chatgpt', 'chatgpt1', 'getAllConversations', 'destroyConversations',
    'endAllConversations', 'switch2Picture', 'switch2Text', 'switch2Audio',
    'switchTTSSource', 'setDefaultRole', 'totalAvailable', 'joinConversation'
  ]
  const current = fixture()
  assert.deepEqual(
    Reflect.ownKeys(current.controller).filter(key => key !== 'rules'),
    expectedMethods
  )
  assert.deepEqual(current.controller.rules, buildYunzaiChatRules('prefix', ['api', 'API']))
  assert.equal(Object.isFrozen(current.controller.rules), true)
  assert.equal(Object.isFrozen(current.controller.rules[0]), true)

  assert.equal(await current.controller.chatgpt(event({
    msg: '#图片chat 引用图片',
    message: [{ type: 'text', text: '#图片chat 引用图片' }]
  })), undefined)
  const request = current.requestInputs[0] as { presentationIntent: { forcePicture: boolean } }
  assert.equal(request.presentationIntent.forcePicture, true)
  const agent = current.agentInputs[0] as {
    evidence: PreparedYunzaiMessageEvidenceV1
    handleOptions: { presentationRoute: PresentationRouteV1 }
  }
  assert.equal(agent.evidence.imageUrls.length, 2)
  assert.equal(agent.evidence.quotedMessageId, 'quoted-1')
  assert.equal(agent.handleOptions.presentationRoute.presentationIntent.kind, 'ordinary')

  const somebodyElse = fixture()
  assert.equal(await somebodyElse.controller.chatgpt1(event({
    atme: false,
    atBot: false,
    msg: '#chat1 你好',
    message: [{ type: 'at', qq: 'other' }, { type: 'text', text: '#chat1 你好' }]
  })), false)
  assert.equal(somebodyElse.agentInputs.length, 0)

  const chat1 = fixture()
  assert.equal(await chat1.controller.chatgpt1(event({ msg: '#图片chat1 你好' })), true)
  assert.equal((chat1.requestInputs[0] as {
    presentationIntent: { forcePicture: boolean }
  }).presentationIntent.forcePicture, true)

  const atMode = fixture({ policy: Object.freeze({ ...policy, toggleMode: 'at' }) })
  assert.equal(await atMode.controller.chatgpt(event({ atme: false, atBot: false, at: null })), false)
  assert.equal(atMode.agentInputs.length, 0)

  const privateDenied = fixture({
    policy: Object.freeze({ ...policy, enablePrivateChat: false })
  })
  assert.equal(await privateDenied.controller.chatgpt1(event({
    isGroup: false, isPrivate: true, isMaster: false, group_id: undefined
  })), true)
  assert.equal(privateDenied.ocrCalls(), 0)

  const blacklisted = fixture({
    policy: Object.freeze({ ...policy, blacklist: Object.freeze(['^actor-1']) })
  })
  assert.equal(await blacklisted.controller.chatgpt1(event()), true)
  assert.equal(blacklisted.agentInputs.length, 0)

  const allowlisted = fixture({
    policy: Object.freeze({
      ...policy,
      whitelist: Object.freeze(['^actor-1']),
      blacklist: Object.freeze(['^actor-1'])
    })
  })
  assert.equal(await allowlisted.controller.chatgpt1(event()), true)
  assert.equal(allowlisted.agentInputs.length, 1)
})

test('chat prepares OCR quote and image evidence once for route and Agent request', async () => {
  const current = fixture()
  await current.controller.chatgpt1(event({ msg: '#chat1 看看引用图' }))
  assert.equal(current.ocrCalls(), 1)
  assert.equal(current.preparationCalls(), 1)
  const agent = current.agentInputs[0] as {
    evidence: PreparedYunzaiMessageEvidenceV1
    handleOptions: { presentationRoute: PresentationRouteV1 }
  }
  assert.equal(Object.isFrozen(agent.evidence), true)
  assert.equal(agent.evidence, (current.agentInputs[0] as typeof agent).evidence)
  assert.equal(agent.handleOptions.presentationRoute.requestMessageId,
    agent.evidence.currentMessageId)
})

test('ordinary prompt screening precedes run claim pending and Provider', async () => {
  const current = fixture({ blocked: true })
  assert.equal(await current.controller.chatgpt1(event()), true)
  assert.deepEqual(current.calls, [
    'mute', 'ocr', 'prepare', 'screen:你好'
  ])
  assert.deepEqual(current.routeNotices.map(item => ({
    message: item.message,
    quote: item.quote
  })), [{
    message: '主人不让我回答你这种问题，真是抱歉了呢',
    quote: true
  }])
  assert.equal(current.lifecycleCalls(), 0)
  assert.equal(current.completionCalls(), 0)
})

test('ordinary terminal results enter the Presenter exactly once while paused does not', async () => {
  const terminal = fixture()
  await terminal.controller.chatgpt1(event())
  assert.equal(terminal.lifecycleCalls(), 1)
  assert.ok(terminal.calls.indexOf('hooks') < terminal.calls.indexOf('agent'))
  assert.equal(terminal.completionCalls(), 1)
  assert.equal(terminal.presentationInputs.length, 1)
  assert.equal(terminal.presentationInputs[0]?.sessionPersistence, 'saved')
  assert.deepEqual(terminal.presentationInputs[0]?.suggestions, ['继续说', '换个话题'])

  const paused = fixture({ envelope: pausedEnvelope() })
  await paused.controller.chatgpt1(event())
  assert.equal(paused.lifecycleCalls(), 1)
  assert.equal(paused.completionCalls(), 0)
  assert.equal(paused.presentationInputs.length, 0)
})

test('post-reply candidate extraction starts only after a definite sent delivery', async () => {
  const current = fixture({
    presentationResult: sentPresentationResult,
    candidateEnqueue: async () => undefined
  })
  const activeEvent = event()

  assert.equal(await current.controller.chatgpt1(activeEvent), true)
  assert.equal(current.candidateInputs.length, 1)
  const candidateInput = current.candidateInputs[0] as Record<string, unknown>
  assert.equal(candidateInput.event, activeEvent)
  assert.equal((candidateInput.envelope as { kind: string }).kind, 'completed')
  assert.equal(
    (candidateInput.envelope as { completion: { text: string } }).completion.text,
    '你好呀'
  )
  assert.equal(candidateInput.presentation, sentPresentationResult)
  assert.equal(
    (candidateInput.prepared as { evidence: PreparedYunzaiMessageEvidenceV1 }).evidence.prompt,
    '你好'
  )
})

test('post-reply candidate enqueue is fire-and-forget and cannot delay the QQ reply path', async () => {
  let enqueueStarted = false
  const neverSettles = new Promise<void>(() => undefined)
  const current = fixture({
    presentationResult: sentPresentationResult,
    candidateEnqueue: async () => {
      enqueueStarted = true
      await neverSettles
    }
  })

  assert.equal(await current.controller.chatgpt1(event()), true)
  assert.equal(enqueueStarted, true)
  assert.equal(current.candidateInputs.length, 1)
})

test('post-reply candidate extraction rejects unresolved and non-visible presentation outcomes', async () => {
  const outcomes: readonly PresentationResult[] = Object.freeze([
    presentationResult,
    Object.freeze({
      schemaVersion: 1,
      outcome: 'failed',
      deliveries: Object.freeze([Object.freeze({
        kind: 'failed_definite' as const,
        media: 'text' as const,
        attempt: 1 as const,
        code: 'host_rejected' as const
      })])
    }),
    Object.freeze({
      schemaVersion: 1,
      outcome: 'unknown',
      deliveries: Object.freeze([Object.freeze({
        kind: 'outcome_unknown' as const,
        media: 'text' as const,
        attempt: 1 as const,
        code: 'unknown_host_result' as const
      })])
    }),
    Object.freeze({
      schemaVersion: 1,
      outcome: 'skipped',
      skipReason: 'allowed_silence',
      deliveries: Object.freeze([])
    })
  ])
  for (const outcome of outcomes) {
    const current = fixture({
      presentationResult: outcome,
      candidateEnqueue: async () => undefined
    })
    await current.controller.chatgpt1(event())
    assert.equal(current.candidateInputs.length, 0, outcome.outcome)
  }

  const paused = fixture({
    envelope: pausedEnvelope(),
    presentationResult: sentPresentationResult,
    candidateEnqueue: async () => undefined
  })
  await paused.controller.chatgpt1(event())
  assert.equal(paused.candidateInputs.length, 0)
})

test('all conversation mode TTS role and billing entry methods preserve compatibility', async () => {
  const current = fixture()
  await current.controller.getAllConversations(event())
  await current.controller.destroyConversations(event())
  await current.controller.endAllConversations(event())
  assert.equal(await current.controller.joinConversation(event({
    message: [{ type: 'at', qq: 'target', text: '@目标' }]
  })), true)
  await current.controller.switch2Picture(event())
  await current.controller.switch2Text(event())
  await current.controller.switch2Audio(event())
  await current.controller.switchTTSSource(event({ msg: '#chatgpt语音换源2' }))
  await current.controller.setDefaultRole(event({ msg: '#chatgpt设置角色 纳西妲' }))
  await current.controller.totalAvailable(event())

  assert.equal(current.deleteCalls(), 1)
  assert.equal(current.calls.includes('clear-emotion'), true)
  assert.deepEqual(current.preferencePatches, [
    { usePicture: true, useTTS: false },
    { usePicture: false, useTTS: false },
    { useTTS: true, usePicture: false },
    { ttsRole: '纳西妲' }
  ])
  assert.equal(current.calls.includes('tts-mode:azure'), true)
  assert.equal(current.commandReplies.some(item =>
    item.message === 'ChatGPT回复已转换为图片模式'), true)
  assert.equal(current.commandReplies.some(item =>
    item.message === '语音转换源已切换为azure'), true)
  assert.equal(current.commandReplies.some(item =>
    item.message.startsWith('总额度：$20\n已经使用额度：$3.5\n当前剩余额度：$16.5\n到期日期(UTC)：')), true)
})

test('typed chat controller builds authorized reply input without chat source coupling', async () => {
  const current = fixture()
  const activeEvent = event()
  await current.controller.chatgpt1(activeEvent)
  const agent = current.agentInputs[0] as {
    currentEvent: unknown
    evidence: PreparedYunzaiMessageEvidenceV1
    handleOptions: {
      systemInstructions: readonly string[]
      enableGroupContext: boolean
      thinkingMode: string
      reasoningEffort: string
      sessionTtlSeconds: number
      presentationLifecycle: unknown
    }
  }
  assert.equal(agent.currentEvent, activeEvent)
  assert.equal(agent.evidence.prompt, '你好')
  assert.equal(Object.hasOwn(agent.evidence, 'event'), false)
  assert.equal(Object.values(agent.evidence).some(value => value === activeEvent), false)
  assert.equal(Object.values(agent.handleOptions).some(value => value === activeEvent), false)
  assert.match(agent.handleOptions.systemInstructions[0] ?? '',
    /^You are 派蒙\. 你是可靠的群友。 Current date: 2026-07-17\.$/)
  assert.equal(agent.handleOptions.enableGroupContext, true)
  assert.equal(agent.handleOptions.thinkingMode, 'enabled')
  assert.equal(agent.handleOptions.reasoningEffort, 'high')
  assert.equal(agent.handleOptions.sessionTtlSeconds, 600)
  assert.notEqual(agent.handleOptions.presentationLifecycle, undefined)
})

test('typed chat controller presents fixed errors without session deletion or raw Error leakage', async () => {
  let accessorReads = 0
  const hostile = Object.create(null)
  for (const key of ['message', 'name', 'code', 'status', 'statusCode', 'stack']) {
    Object.defineProperty(hostile, key, {
      get () {
        accessorReads += 1
        throw new Error('must not read hostile error accessors')
      }
    })
  }
  const current = fixture({ agentError: hostile })
  assert.equal(await current.controller.chatgpt1(event()), true)
  assert.equal(accessorReads, 0)
  assert.equal(current.deleteCalls(), 0)
  assert.deepEqual(current.routeNotices.map(item => item.message), [
    '处理请求时出现异常，请稍后重试'
  ])
  assert.equal(current.presentationInputs.length, 0)
})
