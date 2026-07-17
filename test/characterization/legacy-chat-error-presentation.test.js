import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createYunzaiChatController } from '../../dist/runtime/yunzai-chat-controller.js'

const policy = Object.freeze({
  toggleMode: 'prefix',
  enablePrivateChat: true,
  whitelist: Object.freeze([]),
  blacklist: Object.freeze([]),
  imgOcr: false,
  groupMerge: false,
  enableGroupContext: false,
  thinkingMode: 'default',
  reasoningEffort: 'default',
  assistantLabel: '派蒙',
  promptPrefixOverride: '',
  actorCastApi: ''
})

const route = Object.freeze({
  schemaVersion: 1,
  requestKind: 'ordinary_chat',
  profile: 'ordinary',
  presentationIntent: Object.freeze({
    schemaVersion: 1,
    kind: 'ordinary',
    forcePicture: false
  }),
  sessionAddress: Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' })
  }),
  actorId: 'actor-1',
  requestMessageId: 'message-1'
})

const evidence = Object.freeze({
  schemaVersion: 1,
  prompt: '测试',
  imageUrls: Object.freeze([]),
  currentMessageId: 'message-1',
  quotedMessageId: null,
  hasReply: false,
  replyResolved: false,
  currentSegmentCount: 1,
  replySegmentCount: 0,
  ocrTexts: Object.freeze([])
})

test('production chat presents fixed errors without recalling or deleting the session', async () => {
  let hostileReads = 0
  let sessionDeletes = 0
  let pictureCalls = 0
  let ttsCalls = 0
  const notices = []
  const hostile = Object.create(null)
  for (const property of ['message', 'name', 'code', 'status', 'statusCode', 'stack']) {
    Object.defineProperty(hostile, property, {
      get () {
        hostileReads += 1
        throw new Error('hostile metadata getter')
      }
    })
  }
  const controller = createYunzaiChatController({
    policy: {
      entryMode: () => 'prefix',
      snapshot: async () => policy,
      isMuted: async () => false,
      ocrText: async () => Object.freeze([]),
      appendAzureEmotionFeedback: async ({ prompt }) => prompt,
      clearAzureEmotionFeedback: async () => undefined
    },
    preferences: {
      load: async () => Object.freeze({
        usePicture: false,
        useTTS: false,
        ttsRole: 'default',
        ttsRoleAzure: 'default',
        ttsRoleVoiceVox: 'default'
      }),
      patch: async () => { throw new Error('not used') }
    },
    ttsAdministration: {
      getMode: () => 'vits-uma-genshin-honkai',
      setMode: () => undefined,
      isConfigured: () => true,
      selectVoice: () => Object.freeze({
        kind: 'unsupported', message: 'not used'
      }),
      missingConfigurationMessage: () => 'not used'
    },
    billing: { queryLastHundredDays: async () => { throw new Error('not used') } },
    suggestions: { generate: async () => Object.freeze([]) },
    promptScreening: { isBlocked: async () => false },
    requests: { prepare: async () => Object.freeze({ route, evidence }) },
    agent: {
      conversations: {
        get: async () => null,
        list: async function * () {},
        delete: async () => { sessionDeletes += 1; return true },
        deleteAll: async () => 0,
        fork: async () => { throw new Error('not used') }
      },
      handle: async () => { throw hostile }
    },
    controls: {
      presentCommand: async () => undefined,
      presentRouteNotice: async input => { notices.push(input) }
    },
    presentationSettings: {
      load: async () => Object.freeze({
        schemaVersion: 1,
        quoteReply: true,
        enableRobotAt: false,
        enableMarkdown: false,
        enableSuggestedResponses: false,
        forwardReasoning: false,
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
          autoThreshold: 1200,
          deviceScaleFactor: 1,
          closeBrowserAfterRender: true,
          showQRCode: false,
          live2d: null
        })
      })
    },
    hooks: { forActiveEvent: () => Object.freeze({}) },
    lifecycle: {
      create: async () => Object.freeze({
        onRunStarted: async () => undefined,
        onRunSettled: async () => undefined
      })
    },
    presenter: {
      present: async () => { pictureCalls += 1; ttsCalls += 1; throw new Error('not used') }
    },
    completionCoordinator: { complete: async () => { throw new Error('not used') } },
    diagnostics: { record: () => undefined },
    now: () => new Date('2026-07-17T00:00:00.000Z')
  }, ['api', 'API'])

  const handled = await controller.chatgpt1({
    isGroup: true,
    group_id: 'group-1',
    self_id: 'bot-1',
    user_id: 'actor-1',
    message_id: 'message-1',
    msg: '#chat1 测试',
    message: [{ type: 'text', text: '#chat1 测试' }],
    sender: { user_id: 'actor-1' }
  })

  assert.equal(handled, true)
  assert.equal(hostileReads, 0)
  assert.equal(sessionDeletes, 0)
  assert.equal(pictureCalls, 0)
  assert.equal(ttsCalls, 0)
  assert.deepEqual(notices, [{
    route,
    message: '处理请求时出现异常，请稍后重试',
    quote: true
  }])
})
