import type { ModelAdapter } from '../agent/model/model-adapter.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import {
  bindYunzaiShutdownSignals,
  createYunzaiAgentServiceBridge,
  type YunzaiAgentServiceBridge,
  type YunzaiAgentServiceBridgeOptions,
  type YunzaiMessageEvent,
  type YunzaiBotPicker
} from './agent-service-bridge.js'
import { prepareYunzaiMessageEvidence } from './message-input.js'
import {
  PendingIndicatorPresenter
} from './presentation/pending-indicator-presenter.js'
import type {
  PendingIndicatorConfigPort
} from './presentation/pending-indicator-config.js'
import {
  ordinaryProfile,
  proactiveProfile,
  RECOVERED_LEGACY_PROFILE
} from './presentation/presentation-profile.js'
import type {
  PresentationSettings,
  PresentationSettingsPort
} from './presentation/presentation-settings.js'
import { ReplyPresenter } from './presentation/reply-presenter.js'
import {
  promptIsBlocked
} from './presentation/response-presentation-safety.js'
import {
  TTS_SYNTHESIS_DIAGNOSTIC_EVENT,
  type TtsPresentationDiagnosticPort
} from './presentation/tts-reply-presentation.js'
import type { GroupMatePictureRenderer } from './presentation/groupmate-picture-renderer.js'
import type { TtsReplyPort } from './presentation/yunzai-tts-reply-port.js'
import {
  createYunzaiOutboundPortFactory,
  deliverWithDefiniteRetry,
  type YunzaiOutboundHostPort,
  type YunzaiOutboundPortFactory
} from './presentation/yunzai-outbound-port.js'
import { plainTextPart } from './presentation/text-presentation.js'
import {
  createPresentationCompletionCoordinator,
  type PresentationCompletionCoordinator,
  type RequestObservationPublisher
} from './request-observation-completion.js'
import { createRunPresentationLifecycle } from './run-presentation-lifecycle.js'
import { RunProgressPresenter } from './run-progress-presenter.js'
import {
  PLAIN_TEXT_PRESENTATION_HOOKS
} from './runtime-presentation-hooks.js'
import {
  createApprovalControlPresenter,
  createApprovalOutcomeHandler,
  createYunzaiApprovalController,
  type ApprovalControlPresenter,
  type ApprovalRouterPort,
  type ApprovalTerminalPresenter,
  type YunzaiApprovalController,
  type YunzaiApprovalControllerOptions
} from './yunzai-approval-controller.js'
import type {
  ActivePresentationContext,
  ApprovalReference,
  ApprovalRouteOutcome,
  ApprovalRouteResultHandler
} from './run-approval-router.js'
import {
  createYunzaiBymController,
  type BymEphemeralAgentPort,
  type BymPolicyPort,
  type BymPromptScreeningPort,
  type BymRequestPreparationPort,
  type YunzaiBymController
} from './yunzai-bym-controller.js'
import type { ButtonCompatibilityPort } from './yunzai-button-content.js'
import {
  createYunzaiChatController,
  type ChatControlPresenter,
  type ChatDiagnosticsPort,
  type ChatEntryPolicyPort,
  type ChatLifecycleFactory,
  type ChatPreferencePort,
  type ChatPromptScreeningPort,
  type ChatRequestPreparationPort,
  type OpenAiBillingPort,
  type RuntimePresentationHookFactory,
  type SuggestionGenerationPort,
  type TtsAdministrationPort,
  type YunzaiChatController
} from './yunzai-chat-controller.js'
import { prepareYunzaiPresentationRequest } from './yunzai-request-adapter.js'

const CONVERSATION_MODE_PREFIXES = Object.freeze(['api', 'API'])

const RECOVERED_LEGACY_SETTINGS: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: false,
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

export interface ProductionModelPort extends ModelAdapter, SuggestionGenerationPort {}

export interface ProductionYunzaiAgent {
  readonly bridge: YunzaiAgentServiceBridge
  readonly outboundFactory: YunzaiOutboundPortFactory
  readonly presenter: ReplyPresenter
  readonly pendingIndicator: PendingIndicatorPresenter
  readonly progressPresenter: RunProgressPresenter
  readonly completionCoordinator: PresentationCompletionCoordinator
  readonly approvalControlPresenter: ApprovalControlPresenter
  readonly buttonPolicy: ButtonCompatibilityPort
  readonly chatController: YunzaiChatController
  readonly bymController: YunzaiBymController
  readonly approvalController: YunzaiApprovalController
  shutdown(reason?: string): Promise<number>
}

export interface ProductionYunzaiAgentOptions {
  readonly bridge: YunzaiAgentServiceBridgeOptions
  readonly botPicker: YunzaiBotPicker
  readonly outboundHost: YunzaiOutboundHostPort
  readonly presentationSettings: PresentationSettingsPort
  readonly pendingConfig: PendingIndicatorConfigPort
  readonly hooks: RuntimePresentationHookFactory
  readonly chatPolicy: ChatEntryPolicyPort
  readonly chatPreferences: ChatPreferencePort
  readonly ttsAdministration: TtsAdministrationPort
  readonly billing: OpenAiBillingPort
  readonly bymPolicy: BymPolicyPort
  readonly buttonPolicy: ButtonCompatibilityPort
  readonly requestObservations: RequestObservationPublisher
  readonly pictureRenderer: GroupMatePictureRenderer
  readonly tts: TtsReplyPort
  readonly modelFactory: () => ProductionModelPort
  readonly random?: () => number
  readonly now?: () => Date
  readonly monotonicNow?: () => number | 'unavailable'
}

export class ProductionYunzaiAgentAlreadyInitializedError extends Error {
  constructor () {
    super('production Yunzai agent is already initialized')
    this.name = 'ProductionYunzaiAgentAlreadyInitializedError'
  }
}

export class ProductionYunzaiAgentNotInitializedError extends Error {
  constructor () {
    super('production Yunzai agent is not initialized')
    this.name = 'ProductionYunzaiAgentNotInitializedError'
  }
}

interface GraphLifecycle {
  unbindShutdown: (() => void) | null
  shutdownPromise: Promise<number> | null
}

const graphLifecycles = new WeakMap<object, GraphLifecycle>()
let productionSingleton: ProductionYunzaiAgent | undefined

function eventScalar (value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).normalize('NFC').trim()
    : ''
}

function eventActorId (event: YunzaiMessageEvent): string {
  return eventScalar(event.sender?.user_id ?? event.user_id)
}

function commandTarget (
  event: YunzaiMessageEvent,
  getBotId: (event: unknown) => string | number
): SessionAddress {
  const botId = eventScalar(getBotId(event))
  const actorId = eventActorId(event)
  if (event.isGroup === true) {
    return Object.freeze({
      botId,
      scope: Object.freeze({
        kind: 'group' as const,
        groupId: eventScalar(event.group_id)
      })
    })
  }
  return Object.freeze({
    botId,
    scope: Object.freeze({ kind: 'private' as const, userId: actorId })
  })
}

function requestMessageId (event: YunzaiMessageEvent): string | undefined {
  const value = eventScalar(event.message_id ?? event.seq)
  return value === '' || Buffer.byteLength(value, 'utf8') > 128
    ? undefined
    : value
}

function createTtsDiagnostics (
  options: ProductionYunzaiAgentOptions
): TtsPresentationDiagnosticPort {
  return Object.freeze({
    reportSynthesisFailure: (
      code: Parameters<TtsPresentationDiagnosticPort['reportSynthesisFailure']>[0]
    ) => options.bridge.logger?.error?.(Object.freeze({
      event: TTS_SYNTHESIS_DIAGNOSTIC_EVENT,
      code
    }))
  })
}

async function interruptibleSleep (
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted === true) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, milliseconds))
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer.unref?.()
  })
}

function terminalPresentation (
  options: ProductionYunzaiAgentOptions,
  presenter: ReplyPresenter
): ApprovalTerminalPresenter {
  return Object.freeze({
    async present ({ route, projection }: Parameters<ApprovalTerminalPresenter['present']>[0]) {
      if (route.requestKind === 'legacy_unknown') {
        return await presenter.present(Object.freeze({
          route,
          profile: RECOVERED_LEGACY_PROFILE,
          result: projection.result,
          sessionPersistence: projection.sessionPersistence,
          settings: RECOVERED_LEGACY_SETTINGS,
          citationForwards: Object.freeze([]),
          suggestions: Object.freeze([]),
          hooks: PLAIN_TEXT_PRESENTATION_HOOKS
        }))
      }
      const settings = await options.presentationSettings.load(route.actorId)
      if (route.requestKind === 'ordinary_chat') {
        return await presenter.present(Object.freeze({
          route,
          profile: ordinaryProfile({
            forcePicture: route.presentationIntent.forcePicture,
            quoteCurrentRequest: settings.quoteReply &&
              route.requestMessageId !== undefined &&
              route.sessionAddress.scope.kind !== 'private'
          }),
          result: projection.result,
          sessionPersistence: projection.sessionPersistence,
          settings,
          citationForwards: Object.freeze([]),
          suggestions: Object.freeze([]),
          hooks: PLAIN_TEXT_PRESENTATION_HOOKS
        }))
      }
      return await presenter.present(Object.freeze({
        route,
        profile: proactiveProfile({
          recallAfterMs: route.presentationIntent.recallAfterMs
        }),
        result: projection.result,
        sessionPersistence: projection.sessionPersistence,
        settings,
        citationForwards: Object.freeze([]),
        suggestions: Object.freeze([]),
        hooks: PLAIN_TEXT_PRESENTATION_HOOKS
      }))
    }
  })
}

export function createProductionYunzaiAgent (
  options: ProductionYunzaiAgentOptions
): ProductionYunzaiAgent {
  const model = options.modelFactory()
  const random = options.random ?? Math.random
  const now = options.now ?? (() => new Date())
  const monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()))
  const outboundFactory = createYunzaiOutboundPortFactory(options.outboundHost)
  const progressPresenter = new RunProgressPresenter({
    onDeliveryFailure: failure => options.bridge.logger?.warn?.(
      `运行进度发送失败：${failure.resultCode}`
    )
  })
  const pendingIndicator = new PendingIndicatorPresenter({
    onDeliveryFailure: failure => options.bridge.logger?.warn?.(
      `运行提示发送失败：${failure.resultCode}`
    )
  })
  const presenter = new ReplyPresenter({
    outboundFactory,
    tts: options.tts,
    ttsDiagnostics: createTtsDiagnostics(options),
    pictureRenderer: options.pictureRenderer,
    random,
    sleep: interruptibleSleep,
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds)
  })
  const completionCoordinator = createPresentationCompletionCoordinator({
    publisher: options.requestObservations,
    monotonicNow,
    onPublishFailure: code => options.bridge.logger?.error?.(Object.freeze({
      event: code
    }))
  })
  const approvalControlPresenter = createApprovalControlPresenter({ outboundFactory })
  let approvalOutcomeHandler: ApprovalRouteResultHandler = async () => {
    throw new Error('approval outcome handler is not initialized')
  }
  const bridge = createYunzaiAgentServiceBridge(Object.freeze({
    ...options.bridge,
    botPicker: options.botPicker,
    presentationRuntime: Object.freeze({
      outboundFactory,
      settings: options.presentationSettings,
      pendingConfig: options.pendingConfig,
      pendingIndicator,
      onApprovalOutcome: async (
        result: ApprovalRouteOutcome,
        reference: ApprovalReference,
        context: ActivePresentationContext
      ) => await approvalOutcomeHandler(result, reference, context)
    })
  }), {
    progressPresenter,
    modelAdapter: model
  })
  const promptScreening: ChatPromptScreeningPort & BymPromptScreeningPort = Object.freeze({
    async isBlocked ({ event, prompt }: {
      readonly event: YunzaiMessageEvent
      readonly prompt: string
    }): Promise<boolean> {
      const actorId = eventActorId(event)
      const settings = await options.presentationSettings.load(actorId)
      return promptIsBlocked(prompt, settings.promptBlockWords)
    }
  })
  const chatRequests: ChatRequestPreparationPort = Object.freeze({
    async prepare ({ event, prompt, ocrTexts, groupMerge, presentationIntent }:
    Parameters<ChatRequestPreparationPort['prepare']>[0]) {
      const evidence = await prepareYunzaiMessageEvidence({
        event,
        currentPrompt: prompt,
        ocrTexts
      })
      const prepared = prepareYunzaiPresentationRequest({
        event,
        evidence,
        requestKind: 'ordinary_chat',
        presentationIntent,
        getBotId: current => eventScalar(options.bridge.getBotId(current)),
        groupMerge
      })
      if (prepared.route.requestKind !== 'ordinary_chat') {
        throw new TypeError('ordinary presentation route is invalid')
      }
      return Object.freeze({ route: prepared.route, evidence: prepared.evidence })
    }
  })
  const controls: ChatControlPresenter = Object.freeze({
    async presentCommand ({ event, message, quote }:
    Parameters<ChatControlPresenter['presentCommand']>[0]) {
      const outbound = await outboundFactory.forTarget(commandTarget(
        event,
        options.bridge.getBotId
      ))
      const quoteMessageId = quote ? requestMessageId(event) : undefined
      await deliverWithDefiniteRetry(
        outbound,
        plainTextPart(message),
        quoteMessageId === undefined ? undefined : { quoteMessageId }
      )
    },
    async presentRouteNotice ({ route, message, quote }:
    Parameters<ChatControlPresenter['presentRouteNotice']>[0]) {
      const outbound = await outboundFactory.forTarget(route.sessionAddress)
      const quoteMessageId = quote ? route.requestMessageId : undefined
      await deliverWithDefiniteRetry(
        outbound,
        plainTextPart(message),
        quoteMessageId === undefined ? undefined : { quoteMessageId }
      )
    }
  })
  const lifecycleFactory: ChatLifecycleFactory = Object.freeze({
    async create ({ route, profile }: Parameters<ChatLifecycleFactory['create']>[0]) {
      const enabled = await options.pendingConfig.getEnabled().catch(() => false)
      return createRunPresentationLifecycle({
        route,
        profile,
        pendingEnabled: enabled,
        outboundFactory,
        pending: pendingIndicator,
        progress: progressPresenter
      })
    }
  })
  const diagnostics: ChatDiagnosticsPort = Object.freeze({
    record: (entry: Readonly<Record<string, unknown>>) => options.bridge.logger?.info?.(entry)
  })
  const chatController = createYunzaiChatController({
    policy: options.chatPolicy,
    preferences: options.chatPreferences,
    ttsAdministration: options.ttsAdministration,
    billing: options.billing,
    suggestions: model,
    promptScreening,
    requests: chatRequests,
    agent: bridge,
    controls,
    presentationSettings: options.presentationSettings,
    hooks: options.hooks,
    lifecycle: lifecycleFactory,
    presenter,
    completionCoordinator,
    diagnostics,
    now
  }, CONVERSATION_MODE_PREFIXES)
  const bymRequests: BymRequestPreparationPort = Object.freeze({
    async prepare ({ event, prompt, presentationIntent }:
    Parameters<BymRequestPreparationPort['prepare']>[0]) {
      const evidence = await prepareYunzaiMessageEvidence({
        event,
        currentPrompt: prompt,
        ocrTexts: Object.freeze([])
      })
      const prepared = prepareYunzaiPresentationRequest({
        event,
        evidence,
        requestKind: 'proactive_chat',
        presentationIntent,
        getBotId: current => eventScalar(options.bridge.getBotId(current)),
        groupMerge: true
      })
      if (prepared.route.requestKind !== 'proactive_chat') {
        throw new TypeError('proactive presentation route is invalid')
      }
      return Object.freeze({ route: prepared.route, evidence: prepared.evidence })
    }
  })
  const bymAgent: BymEphemeralAgentPort = Object.freeze({
    async handleEphemeral ({
      event,
      prepared,
      systemInstructions,
      enableGroupContext,
      thinkingMode,
      reasoningEffort
    }: Parameters<BymEphemeralAgentPort['handleEphemeral']>[0]) {
      return await bridge.handleEphemeral(event, prepared.evidence, Object.freeze({
        presentationRoute: prepared.route,
        systemInstructions,
        enableGroupContext,
        thinkingMode,
        reasoningEffort
      }))
    }
  })
  const bymController = createYunzaiBymController({
    policy: options.bymPolicy,
    random,
    promptScreening,
    requests: bymRequests,
    agent: bymAgent,
    presentationSettings: options.presentationSettings,
    hooks: options.hooks,
    presenter,
    completionCoordinator
  })
  const approvalBaseOptions: Omit<
  YunzaiApprovalControllerOptions,
  'outcomeHandler'
  > = Object.freeze({
    projector: Object.freeze({
      project: async (event: YunzaiMessageEvent) => await bridge.projectApprovalReply(event)
    }),
    router: Object.freeze({
      route: async (
        projection: Parameters<ApprovalRouterPort['route']>[0],
        onResult: Parameters<ApprovalRouterPort['route']>[1]
      ) => await bridge.consumeApprovalReply(projection, onResult)
    }),
    controlPresenter: approvalControlPresenter,
    pausedHandler: Object.freeze({
      async handle ({ result, reference, context }: Parameters<
      YunzaiApprovalControllerOptions['pausedHandler']['handle']
      >[0]) {
        const displayed = await bridge.displayApprovalOrCancel(result)
        if (displayed.kind !== 'paused') {
          await approvalOutcomeHandler(displayed, reference, context)
        }
      }
    }),
    terminalPresenter: terminalPresentation(options, presenter),
    completionCoordinator
  })
  approvalOutcomeHandler = createApprovalOutcomeHandler(approvalBaseOptions)
  const approvalOptions: YunzaiApprovalControllerOptions = Object.freeze({
    ...approvalBaseOptions,
    outcomeHandler: approvalOutcomeHandler
  })
  const approvalController = createYunzaiApprovalController(approvalOptions)

  const lifecycle: GraphLifecycle = {
    unbindShutdown: null,
    shutdownPromise: null
  }
  const graph: ProductionYunzaiAgent = Object.freeze({
    bridge,
    outboundFactory,
    presenter,
    pendingIndicator,
    progressPresenter,
    completionCoordinator,
    approvalControlPresenter,
    buttonPolicy: options.buttonPolicy,
    chatController,
    bymController,
    approvalController,
    shutdown: async (reason = 'process_shutdown'): Promise<number> => {
      lifecycle.shutdownPromise ??= bridge.shutdown(reason).finally(() => {
        lifecycle.unbindShutdown?.()
        lifecycle.unbindShutdown = null
      })
      return await lifecycle.shutdownPromise
    }
  })
  graphLifecycles.set(graph, lifecycle)
  return graph
}

export function initializeProductionYunzaiAgent (
  options: ProductionYunzaiAgentOptions
): ProductionYunzaiAgent {
  if (productionSingleton !== undefined) {
    throw new ProductionYunzaiAgentAlreadyInitializedError()
  }
  const graph = createProductionYunzaiAgent(options)
  const lifecycle = graphLifecycles.get(graph)
  if (lifecycle === undefined) throw new TypeError('production graph lifecycle is unavailable')
  lifecycle.unbindShutdown = bindYunzaiShutdownSignals(graph)
  productionSingleton = graph
  return graph
}

export function getProductionYunzaiAgent (): ProductionYunzaiAgent {
  if (productionSingleton === undefined) {
    throw new ProductionYunzaiAgentNotInitializedError()
  }
  return productionSingleton
}
