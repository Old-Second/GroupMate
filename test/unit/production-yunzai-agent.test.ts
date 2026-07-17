import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import type { PresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import {
  createProductionYunzaiAgent,
  getProductionYunzaiAgent,
  initializeProductionYunzaiAgent,
  ProductionYunzaiAgentAlreadyInitializedError,
  ProductionYunzaiAgentNotInitializedError,
  type ProductionModelPort,
  type ProductionYunzaiAgentOptions
} from '../../src/runtime/production-yunzai-agent.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const settings: PresentationSettings = Object.freeze({
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
    autoThreshold: 1_200,
    deviceScaleFactor: 1,
    closeBrowserAfterRender: true,
    showQRCode: false,
    live2d: null
  })
})

function model (): ProductionModelPort {
  return Object.freeze({
    async complete (_request: ModelRequest, _signal: AbortSignal): Promise<ModelTurn> {
      return Object.freeze({
        text: 'fixture',
        toolCalls: Object.freeze([]),
        finishReason: 'stop'
      })
    },
    async generate (): Promise<readonly string[]> {
      return Object.freeze([])
    }
  })
}

function options (onModelFactory: () => void): ProductionYunzaiAgentOptions {
  const redis = new FakeRedis()
  const botPicker = Object.freeze({
    pick: async () => null
  })
  return {
    bridge: {
      config: Object.freeze({
        openAiCompatibilityProfile: 'standard',
        model: 'fixture-model',
        toolPolicyProfile: 'compatible'
      }),
      redis,
      getMasterIds: async () => Object.freeze(['master']),
      getBotId: () => 'bot',
      segment: () => Object.freeze({}),
      botPicker
    },
    botPicker,
    outboundHost: Object.freeze({
      forTarget: async () => null
    }),
    presentationSettings: Object.freeze({
      load: async () => settings
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
        promptPrefixOverride: '',
        actorCastApi: ''
      }),
      isMuted: async () => false,
      ocrText: async () => Object.freeze([]),
      appendAzureEmotionFeedback: async ({ prompt }: { readonly prompt: string }) => prompt,
      clearAzureEmotionFeedback: async () => undefined
    }),
    chatPreferences: Object.freeze({
      load: async () => Object.freeze({
        usePicture: false,
        useTTS: false,
        ttsRole: 'default',
        ttsRoleAzure: 'default',
        ttsRoleVoiceVox: 'default'
      }),
      patch: async () => Object.freeze({
        usePicture: false,
        useTTS: false,
        ttsRole: 'default',
        ttsRoleAzure: 'default',
        ttsRoleVoiceVox: 'default'
      })
    }),
    ttsAdministration: Object.freeze({
      getMode: () => 'vits-uma-genshin-honkai' as const,
      setMode: () => undefined,
      isConfigured: () => false,
      selectVoice: () => Object.freeze({ kind: 'unsupported' as const, message: 'unsupported' }),
      missingConfigurationMessage: () => 'missing'
    }),
    billing: Object.freeze({
      queryLastHundredDays: async () => Object.freeze({
        hardLimitUsd: 0,
        totalUsageUsd: 0,
        expiresAt: new Date(0)
      })
    }),
    bymPolicy: Object.freeze({
      snapshot: () => Object.freeze({
        enabled: false,
        assistantLabel: 'GroupMate',
        recognizeLeadingAlias: true,
        ratePercent: 0,
        disabledGroupIds: Object.freeze([]),
        thinkingMode: 'default' as const,
        reasoningEffort: 'default' as const,
        preset: '',
        retaliationWords: Object.freeze([]),
        retaliationBlacklistActorIds: Object.freeze([]),
        retaliationPrompt: '',
        retaliationRecallEnabled: false,
        retaliationRecallSeconds: 100
      })
    }),
    buttonPolicy: Object.freeze({
      snapshot: () => Object.freeze({ markdownEnabled: false, openAiConfigured: false })
    }),
    requestObservations: Object.freeze({ publish: () => undefined }),
    pictureRenderer: Object.freeze({
      render: async () => Object.freeze({ kind: 'not_rendered' as const, code: 'render_failed' as const })
    }),
    tts: Object.freeze({
      synthesize: async () => Object.freeze({
        kind: 'failed_definite' as const,
        code: 'synthesis_rejected' as const
      })
    }),
    modelFactory: () => {
      onModelFactory()
      return model()
    },
    random: () => 0.5,
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    monotonicNow: () => 1
  }
}

test('production initializer owns one complete graph and rejects every reinitialization', async () => {
  assert.throws(
    () => getProductionYunzaiAgent(),
    ProductionYunzaiAgentNotInitializedError
  )
  const beforeSigint = process.listenerCount('SIGINT')
  const beforeSigterm = process.listenerCount('SIGTERM')
  let modelFactoryCalls = 0
  const graph = initializeProductionYunzaiAgent(options(() => { modelFactoryCalls += 1 }))

  assert.equal(getProductionYunzaiAgent(), graph)
  assert.equal(modelFactoryCalls, 1)
  assert.equal(process.listenerCount('SIGINT'), beforeSigint + 1)
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm + 1)
  assert.deepEqual(Reflect.ownKeys(graph), [
    'bridge', 'outboundFactory', 'presenter', 'pendingIndicator',
    'progressPresenter', 'completionCoordinator', 'approvalControlPresenter',
    'buttonPolicy', 'chatController', 'bymController', 'approvalController',
    'observability', 'shutdown'
  ])
  for (const key of [
    'bridge', 'outboundFactory', 'presenter', 'pendingIndicator',
    'progressPresenter', 'completionCoordinator', 'approvalControlPresenter',
    'chatController', 'bymController', 'approvalController'
  ] as const) {
    assert.ok(graph[key])
  }

  let rejectedFactoryCalls = 0
  assert.throws(
    () => initializeProductionYunzaiAgent(options(() => { rejectedFactoryCalls += 1 })),
    ProductionYunzaiAgentAlreadyInitializedError
  )
  assert.equal(rejectedFactoryCalls, 0)
  assert.equal(process.listenerCount('SIGINT'), beforeSigint + 1)
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm + 1)

  await graph.shutdown('unit_test')
  assert.equal(process.listenerCount('SIGINT'), beforeSigint)
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm)
})

test('agent service bridge factory is non-singleton and production graph binds shutdown once', async () => {
  const beforeSigint = process.listenerCount('SIGINT')
  const beforeSigterm = process.listenerCount('SIGTERM')
  let modelFactoryCalls = 0
  const first = createProductionYunzaiAgent(options(() => { modelFactoryCalls += 1 }))
  const second = createProductionYunzaiAgent(options(() => { modelFactoryCalls += 1 }))

  assert.notEqual(first, second)
  assert.notEqual(first.bridge, second.bridge)
  assert.notEqual(first.progressPresenter, second.progressPresenter)
  assert.notEqual(first.outboundFactory, second.outboundFactory)
  assert.notEqual(first.presenter, second.presenter)
  assert.equal(modelFactoryCalls, 2)
  assert.equal(process.listenerCount('SIGINT'), beforeSigint)
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm)

  await first.shutdown('unit_test')
  await second.shutdown('unit_test')
})
