import type { ModelAdapter } from '../agent/model/model-adapter.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import { RunAdmission } from '../agent/run/run-admission.js'
import { RedisRunStore } from '../agent/run/redis-run-store.js'
import type { TraceCandidateProjectionFailureCode, TraceCandidateV1 } from '../agent/run/run-trace.js'
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
  createGroupMateContentJournal,
  type GroupMateContentJournal
} from './logging/groupmate-content-journal.js'
import {
  GroupMateDiskLog,
  type GroupMateDiskLogOptions
} from './logging/groupmate-disk-log.js'
import { createJournaledYunzaiOutboundPortFactory } from './logging/journaled-yunzai-outbound.js'
import { resolvePluginPath } from './plugin-context.js'
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
import type { RequestObservationV1 } from './request-observation.js'
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
import { MetricsRegistry } from './observability/metrics-registry.js'
import {
  ObservationHub,
  type ObservationSubscriber,
  type SafeSinkFailureV1
} from './observability/observation-hub.js'
import type { ObservationEventV1 } from './observability/observation-event.js'
import { RedisTraceStore } from './observability/redis-trace-store.js'
import { RunObservationPolicyGate } from './observability/run-observation-policy-gate.js'
import {
  SafeObservationFailureLogLimiter,
  createPresentationObservationLog,
  createRequestObservationLog
} from './observability/safe-observation-logging.js'
import { TraceRecorder } from './observability/trace-recorder.js'
import type { ObservabilityLevel } from './observability/trace-policy.js'
import { OwnerDiagnostics } from './observability/owner-diagnostics.js'
import { YunzaiDiagnosticsController } from './yunzai-diagnostics-controller.js'

const CONVERSATION_MODE_PREFIXES = Object.freeze(['api', 'API'])

const RECOVERED_LEGACY_SETTINGS: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: false,
  enableRobotAt: false,
  enableMarkdown: false,
  enableSuggestedResponses: false,
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
  readonly diagnosticsController: YunzaiDiagnosticsController
  readonly observability: Readonly<{
    hub: ObservationHub
    gate: RunObservationPolicyGate
    metrics: MetricsRegistry
    traceRecorder: TraceRecorder
    traceStore: RedisTraceStore
  }>
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
  /** Test-only post-gate monitor; the production entrypoint does not provide it. */
  readonly requestObservations?: RequestObservationPublisher
  readonly pictureRenderer: GroupMatePictureRenderer
  readonly tts: TtsReplyPort
  readonly modelFactory: () => ProductionModelPort
  readonly random?: () => number
  readonly now?: () => Date
  readonly monotonicNow?: () => number | 'unavailable'
  /** Test-only injection; production constructs one journal when disk logging is enabled. */
  readonly contentJournal?: GroupMateContentJournal
  /** Test-only wall clock dedicated to disk and outbound journal timestamps. */
  readonly journalNow?: () => Date
  /** Test-only seam for asserting construction without writing workspace runtime data. */
  readonly diskLogFactory?: (
    options: GroupMateDiskLogOptions
  ) => Pick<GroupMateDiskLog, 'record' | 'drain'>
  /** Test-only seam for proving journal-wrapper construction is fail-open. */
  readonly journaledOutboundFactory?: typeof createJournaledYunzaiOutboundPortFactory
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

interface ProductionJournalRuntime {
  readonly contentJournal?: GroupMateContentJournal
  readonly outboundFactory: YunzaiOutboundPortFactory
}

const JOURNAL_INITIALIZATION_FAILURE = Object.freeze({
  event: 'groupmate.disk_log.initialization_failure',
  code: 'construction_failed'
})

function createProductionJournalRuntime (
  options: ProductionYunzaiAgentOptions,
  rawOutboundFactory: YunzaiOutboundPortFactory,
  journalNow: () => Date
): ProductionJournalRuntime {
  try {
    if (options.bridge.config.diskLogEnabled !== true) {
      return Object.freeze({ outboundFactory: rawOutboundFactory })
    }
    const contentJournal = options.contentJournal ?? createGroupMateContentJournal(
      (options.diskLogFactory ?? (diskLogOptions => new GroupMateDiskLog(diskLogOptions)))({
        directory: resolvePluginPath('data', 'logs', 'groupmate'),
        trustedRoot: resolvePluginPath(),
        now: journalNow,
        onFailure: failure => {
          try {
            options.bridge.logger?.error?.(Object.freeze({
              event: failure.event,
              code: failure.code
            }))
          } catch {}
        }
      })
    )
    const outboundFactory = (
      options.journaledOutboundFactory ?? createJournaledYunzaiOutboundPortFactory
    )(rawOutboundFactory, contentJournal, journalNow)
    return Object.freeze({ contentJournal, outboundFactory })
  } catch {
    try {
      options.bridge.logger?.error?.(JOURNAL_INITIALIZATION_FAILURE)
    } catch {}
    return Object.freeze({ outboundFactory: rawOutboundFactory })
  }
}

const graphLifecycles = new WeakMap<object, GraphLifecycle>()
let productionSingleton: ProductionYunzaiAgent | undefined
let activeObservabilityRuntime: ProductionObservabilityRuntime | undefined
let preInitializationLevel: ObservabilityLevel | undefined

export type ProductionObservabilityLevelUpdateV1 =
  | { readonly kind: 'applied' }
  | { readonly kind: 'barrier_pending' }
  | { readonly kind: 'barrier_failed' }

const OBSERVABILITY_LEVELS = new Set<ObservabilityLevel>(['off', 'basic', 'diagnostic'])
const OFF_BARRIER_ACK_MS = 500

function configuredObservabilityLevel (value: unknown): ObservabilityLevel {
  return typeof value === 'string' && OBSERVABILITY_LEVELS.has(value as ObservabilityLevel)
    ? value as ObservabilityLevel
    : 'basic'
}

function sinkFailure (
  sink: SafeSinkFailureV1['sink'],
  code: SafeSinkFailureV1['code'],
  now: () => Date
): SafeSinkFailureV1 {
  let occurredAt = new Date(0).toISOString()
  try {
    occurredAt = now().toISOString()
  } catch {}
  return Object.freeze({ schemaVersion: 1, sink, code, occurredAt })
}

export class ProductionObservabilityRuntime {
  readonly hub: ObservationHub
  readonly gate: RunObservationPolicyGate
  readonly metrics: MetricsRegistry
  readonly traceRecorder: TraceRecorder
  readonly traceStore: RedisTraceStore
  readonly #now: () => Date
  readonly #logger?: ProductionYunzaiAgentOptions['bridge']['logger']
  readonly #requestObservationMonitor?: RequestObservationPublisher
  #currentLevel: ObservabilityLevel
  #barrierState: 'idle' | 'pending' | 'confirmed' | 'failed' = 'idle'
  #barrierPromise: Promise<'confirmed' | 'failed'> | null = null

  constructor (options: {
    readonly redis: ProductionYunzaiAgentOptions['bridge']['redis']
    readonly runStore: RedisRunStore
    readonly admission: RunAdmission
    readonly logger?: ProductionYunzaiAgentOptions['bridge']['logger']
    readonly requestObservationMonitor?: RequestObservationPublisher
    readonly initialLevel: ObservabilityLevel
    readonly now: () => Date
  }) {
    this.#now = options.now
    this.#logger = options.logger
    this.#requestObservationMonitor = options.requestObservationMonitor
    this.#currentLevel = options.initialLevel
    this.traceStore = new RedisTraceStore({
      client: options.redis,
      now: () => {
        try {
          return options.now().getTime()
        } catch {
          return 0
        }
      }
    })
    this.gate = new RunObservationPolicyGate({
      now: () => {
        try {
          return options.now().getTime()
        } catch {
          return 0
        }
      }
    })
    this.metrics = new MetricsRegistry({
      admission: options.admission,
      runStoreUsage: async () => await options.runStore.observationUsage(),
      traceStoreUsage: async () => await this.traceStore.usage(),
      now: options.now
    })
    const failureLimiter = new SafeObservationFailureLogLimiter({
      now: () => {
        try {
          return options.now().getTime()
        } catch {
          return 0
        }
      }
    })
    const reportFailure = (failure: SafeSinkFailureV1): void => {
      try {
        this.metrics.recordSinkFailure(failure)
      } catch {}
      try {
        const log = failureLimiter.create(failure)
        if (log !== null) options.logger?.error?.(log)
      } catch {}
    }
    this.traceRecorder = new TraceRecorder({
      store: this.traceStore,
      onSinkFailure: reportFailure,
      now: () => {
        try {
          return options.now().getTime()
        } catch {
          return 0
        }
      }
    })
    const logSubscriber: ObservationSubscriber = Object.freeze({
      name: 'log' as const,
      observe: (event: ObservationEventV1) => {
        if (event.type === 'request') {
          options.logger?.info?.(createRequestObservationLog(event.value))
        } else if (event.type === 'presentation') {
          options.logger?.info?.(createPresentationObservationLog(event.value))
        }
      }
    })
    this.hub = new ObservationHub({
      subscribers: Object.freeze([this.metrics, this.traceRecorder, logSubscriber]),
      onSinkFailure: reportFailure,
      now: () => {
        try {
          return options.now().getTime()
        } catch {
          return 0
        }
      }
    })
    this.#setLevel(options.initialLevel)
    if (options.initialLevel === 'off') void this.#ensureBarrier()
  }

  publish (event: ObservationEventV1): void {
    if (!this.gate.allow(event)) return
    this.hub.publish(event)
    if (event.type === 'request' && this.#requestObservationMonitor !== undefined) {
      try {
        void Promise.resolve(this.#requestObservationMonitor.publish(event.value)).catch(() => {})
      } catch {}
    }
  }

  currentLevel (): ObservabilityLevel {
    return this.#currentLevel
  }

  registerPolicy (runRef: string, policy: TraceCandidateV1['policy']): void {
    this.gate.register(runRef, policy)
  }

  acceptCommittedTraceCandidate (candidate: TraceCandidateV1): void {
    if (!this.gate.allowCommittedCandidate(candidate)) return
    try {
      this.metrics.observeCommittedTraceCandidate(candidate)
    } catch {
      this.#reportDirectFailure('metrics', 'rejected')
    }
    try {
      this.traceRecorder.stageCommittedTraceCandidate(candidate)
    } catch {
      this.#reportDirectFailure('trace', 'rejected')
    }
  }

  acceptTraceProjectionFailure (code: TraceCandidateProjectionFailureCode): void {
    if (code !== 'projection_rejected') return
    this.#reportDirectFailure('trace', 'rejected')
    try {
      this.#logger?.error?.(Object.freeze({ event: 'trace/projection_rejected' }))
    } catch {}
  }

  async updateLevel (level: ObservabilityLevel): Promise<ProductionObservabilityLevelUpdateV1> {
    if (level === 'off') {
      this.#setLevel('off')
      if (this.#barrierState === 'confirmed') return Object.freeze({ kind: 'applied' })
      const barrier = this.#ensureBarrier()
      return await this.#boundedBarrierAck(barrier)
    }
    if (this.#currentLevel === 'off') {
      if (this.#barrierState === 'pending') {
        return Object.freeze({ kind: 'barrier_pending' })
      }
      if (this.#barrierState === 'failed' || this.#barrierState !== 'confirmed') {
        return Object.freeze({ kind: 'barrier_failed' })
      }
    }
    this.#setLevel(level)
    this.#barrierState = 'idle'
    return Object.freeze({ kind: 'applied' })
  }

  #setLevel (level: ObservabilityLevel): void {
    this.#currentLevel = level
    this.gate.setCurrentLevel(level)
    this.metrics.setCurrentLevel(level)
    this.traceRecorder.setCurrentLevel(level)
  }

  #ensureBarrier (): Promise<'confirmed' | 'failed'> {
    if (this.#barrierPromise !== null) return this.#barrierPromise
    this.#barrierState = 'pending'
    const bottom = this.traceStore.advanceGenerationAndClear().then(
      () => {
        this.#barrierState = 'confirmed'
        return 'confirmed' as const
      },
      () => {
        this.#barrierState = 'failed'
        return 'failed' as const
      }
    )
    this.#barrierPromise = bottom.finally(() => {
      this.#barrierPromise = null
    })
    return this.#barrierPromise
  }

  async #boundedBarrierAck (
    barrier: Promise<'confirmed' | 'failed'>
  ): Promise<ProductionObservabilityLevelUpdateV1> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), OFF_BARRIER_ACK_MS)
    })
    const result = await Promise.race([barrier, timeout])
    if (timer !== undefined) clearTimeout(timer)
    return Object.freeze({
      kind: result === 'confirmed'
        ? 'applied'
        : result === 'failed' ? 'barrier_failed' : 'barrier_pending'
    })
  }

  #reportDirectFailure (
    sink: SafeSinkFailureV1['sink'],
    code: SafeSinkFailureV1['code']
  ): void {
    const failure = sinkFailure(sink, code, this.#now)
    try {
      this.metrics.recordSinkFailure(failure)
    } catch {}
  }
}

export async function updateProductionObservabilityLevel (
  level: ObservabilityLevel
): Promise<ProductionObservabilityLevelUpdateV1> {
  if (!OBSERVABILITY_LEVELS.has(level)) {
    throw new TypeError('production observation level is invalid')
  }
  if (activeObservabilityRuntime === undefined) {
    preInitializationLevel = level
    return Object.freeze({
      kind: level === 'off' ? 'barrier_pending' : 'applied'
    })
  }
  const result = await activeObservabilityRuntime.updateLevel(level)
  if (level === 'off' || result.kind === 'applied') {
    preInitializationLevel = level
  }
  return result
}

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
  const journalNow = options.journalNow ?? (() => new Date())
  const monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()))
  const runStore = new RedisRunStore({ client: options.bridge.redis })
  const admission = new RunAdmission({ client: options.bridge.redis })
  const observability = new ProductionObservabilityRuntime({
    redis: options.bridge.redis,
    runStore,
    admission,
    logger: options.bridge.logger,
    requestObservationMonitor: options.requestObservations,
    initialLevel: preInitializationLevel ?? configuredObservabilityLevel(
      options.bridge.config.observabilityLevel
    ),
    now
  })
  const rawOutboundFactory = createYunzaiOutboundPortFactory(options.outboundHost)
  const { contentJournal, outboundFactory } = createProductionJournalRuntime(
    options,
    rawOutboundFactory,
    journalNow
  )
  const progressPresenter = new RunProgressPresenter({
    onAttachment: metadata => observability.registerPolicy(
      metadata.runRef,
      metadata.observationPolicy
    ),
    publishObservation: event => observability.publish(event),
    monotonicNow,
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
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
    publishObservation: event => observability.publish(event),
    monotonicNow
  })
  const completionCoordinator = createPresentationCompletionCoordinator({
    publisher: Object.freeze({
      publish: (observation: RequestObservationV1) => observability.publish(Object.freeze({
        schemaVersion: 1,
        type: 'request',
        value: observation
      }))
    }),
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
    modelAdapter: model,
    runStore,
    admission,
    ...(contentJournal === undefined ? {} : { contentJournal }),
    observations: Object.freeze({
      publish: event => observability.publish(event),
      acceptCommittedTraceCandidate: candidate => (
        observability.acceptCommittedTraceCandidate(candidate)
      ),
      acceptTraceProjectionFailure: code => observability.acceptTraceProjectionFailure(code)
    })
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
    completionCoordinator,
    diagnostics
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
  const diagnosticsController = new YunzaiDiagnosticsController(new OwnerDiagnostics({
    metrics: observability.metrics,
    traceStore: observability.traceStore,
    currentLevel: () => observability.currentLevel(),
    logger: options.bridge.logger
  }))

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
    diagnosticsController,
    observability: Object.freeze({
      hub: observability.hub,
      gate: observability.gate,
      metrics: observability.metrics,
      traceRecorder: observability.traceRecorder,
      traceStore: observability.traceStore
    }),
    shutdown: async (reason = 'process_shutdown'): Promise<number> => {
      lifecycle.shutdownPromise ??= (async () => {
        try {
          return await bridge.shutdown(reason)
        } finally {
          try {
            await contentJournal?.drain()
          } catch {}
        }
      })().finally(() => {
        lifecycle.unbindShutdown?.()
        lifecycle.unbindShutdown = null
      })
      return await lifecycle.shutdownPromise
    }
  })
  graphLifecycles.set(graph, lifecycle)
  activeObservabilityRuntime = observability
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
