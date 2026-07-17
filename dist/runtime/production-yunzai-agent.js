import { RunAdmission } from '../agent/run/run-admission.js';
import { RedisRunStore } from '../agent/run/redis-run-store.js';
import { bindYunzaiShutdownSignals, createYunzaiAgentServiceBridge } from './agent-service-bridge.js';
import { prepareYunzaiMessageEvidence } from './message-input.js';
import { createGroupMateContentJournal } from './logging/groupmate-content-journal.js';
import { GroupMateDiskLog } from './logging/groupmate-disk-log.js';
import { createJournaledYunzaiOutboundPortFactory } from './logging/journaled-yunzai-outbound.js';
import { resolvePluginPath } from './plugin-context.js';
import { PendingIndicatorPresenter } from './presentation/pending-indicator-presenter.js';
import { ordinaryProfile, proactiveProfile, RECOVERED_LEGACY_PROFILE } from './presentation/presentation-profile.js';
import { ReplyPresenter } from './presentation/reply-presenter.js';
import { promptIsBlocked } from './presentation/response-presentation-safety.js';
import { TTS_SYNTHESIS_DIAGNOSTIC_EVENT } from './presentation/tts-reply-presentation.js';
import { createYunzaiOutboundPortFactory, deliverWithDefiniteRetry } from './presentation/yunzai-outbound-port.js';
import { plainTextPart } from './presentation/text-presentation.js';
import { createPresentationCompletionCoordinator } from './request-observation-completion.js';
import { createRunPresentationLifecycle } from './run-presentation-lifecycle.js';
import { RunProgressPresenter } from './run-progress-presenter.js';
import { PLAIN_TEXT_PRESENTATION_HOOKS } from './runtime-presentation-hooks.js';
import { createApprovalControlPresenter, createApprovalOutcomeHandler, createYunzaiApprovalController } from './yunzai-approval-controller.js';
import { createYunzaiBymController } from './yunzai-bym-controller.js';
import { createYunzaiChatController } from './yunzai-chat-controller.js';
import { prepareYunzaiPresentationRequest } from './yunzai-request-adapter.js';
import { MetricsRegistry } from './observability/metrics-registry.js';
import { ObservationHub } from './observability/observation-hub.js';
import { RedisTraceStore } from './observability/redis-trace-store.js';
import { RunObservationPolicyGate } from './observability/run-observation-policy-gate.js';
import { SafeObservationFailureLogLimiter, createPresentationObservationLog, createRequestObservationLog } from './observability/safe-observation-logging.js';
import { TraceRecorder } from './observability/trace-recorder.js';
import { OwnerDiagnostics } from './observability/owner-diagnostics.js';
import { YunzaiDiagnosticsController } from './yunzai-diagnostics-controller.js';
const CONVERSATION_MODE_PREFIXES = Object.freeze(['api', 'API']);
const RECOVERED_LEGACY_SETTINGS = Object.freeze({
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
});
export class ProductionYunzaiAgentAlreadyInitializedError extends Error {
    constructor() {
        super('production Yunzai agent is already initialized');
        this.name = 'ProductionYunzaiAgentAlreadyInitializedError';
    }
}
export class ProductionYunzaiAgentNotInitializedError extends Error {
    constructor() {
        super('production Yunzai agent is not initialized');
        this.name = 'ProductionYunzaiAgentNotInitializedError';
    }
}
const JOURNAL_INITIALIZATION_FAILURE = Object.freeze({
    event: 'groupmate.disk_log.initialization_failure',
    code: 'construction_failed'
});
function createProductionJournalRuntime(options, rawOutboundFactory, journalNow) {
    try {
        if (options.bridge.config.diskLogEnabled !== true) {
            return Object.freeze({ outboundFactory: rawOutboundFactory });
        }
        const contentJournal = options.contentJournal ?? createGroupMateContentJournal((options.diskLogFactory ?? (diskLogOptions => new GroupMateDiskLog(diskLogOptions)))({
            directory: resolvePluginPath('data', 'logs', 'groupmate'),
            now: journalNow,
            onFailure: failure => {
                try {
                    options.bridge.logger?.error?.(Object.freeze({
                        event: failure.event,
                        code: failure.code
                    }));
                }
                catch { }
            }
        }));
        const outboundFactory = (options.journaledOutboundFactory ?? createJournaledYunzaiOutboundPortFactory)(rawOutboundFactory, contentJournal, journalNow);
        return Object.freeze({ contentJournal, outboundFactory });
    }
    catch {
        try {
            options.bridge.logger?.error?.(JOURNAL_INITIALIZATION_FAILURE);
        }
        catch { }
        return Object.freeze({ outboundFactory: rawOutboundFactory });
    }
}
const graphLifecycles = new WeakMap();
let productionSingleton;
let activeObservabilityRuntime;
let preInitializationLevel;
const OBSERVABILITY_LEVELS = new Set(['off', 'basic', 'diagnostic']);
const OFF_BARRIER_ACK_MS = 500;
function configuredObservabilityLevel(value) {
    return typeof value === 'string' && OBSERVABILITY_LEVELS.has(value)
        ? value
        : 'basic';
}
function sinkFailure(sink, code, now) {
    let occurredAt = new Date(0).toISOString();
    try {
        occurredAt = now().toISOString();
    }
    catch { }
    return Object.freeze({ schemaVersion: 1, sink, code, occurredAt });
}
export class ProductionObservabilityRuntime {
    hub;
    gate;
    metrics;
    traceRecorder;
    traceStore;
    #now;
    #logger;
    #requestObservationMonitor;
    #currentLevel;
    #barrierState = 'idle';
    #barrierPromise = null;
    constructor(options) {
        this.#now = options.now;
        this.#logger = options.logger;
        this.#requestObservationMonitor = options.requestObservationMonitor;
        this.#currentLevel = options.initialLevel;
        this.traceStore = new RedisTraceStore({
            client: options.redis,
            now: () => {
                try {
                    return options.now().getTime();
                }
                catch {
                    return 0;
                }
            }
        });
        this.gate = new RunObservationPolicyGate({
            now: () => {
                try {
                    return options.now().getTime();
                }
                catch {
                    return 0;
                }
            }
        });
        this.metrics = new MetricsRegistry({
            admission: options.admission,
            runStoreUsage: async () => await options.runStore.observationUsage(),
            traceStoreUsage: async () => await this.traceStore.usage(),
            now: options.now
        });
        const failureLimiter = new SafeObservationFailureLogLimiter({
            now: () => {
                try {
                    return options.now().getTime();
                }
                catch {
                    return 0;
                }
            }
        });
        const reportFailure = (failure) => {
            try {
                this.metrics.recordSinkFailure(failure);
            }
            catch { }
            try {
                const log = failureLimiter.create(failure);
                if (log !== null)
                    options.logger?.error?.(log);
            }
            catch { }
        };
        this.traceRecorder = new TraceRecorder({
            store: this.traceStore,
            onSinkFailure: reportFailure,
            now: () => {
                try {
                    return options.now().getTime();
                }
                catch {
                    return 0;
                }
            }
        });
        const logSubscriber = Object.freeze({
            name: 'log',
            observe: (event) => {
                if (event.type === 'request') {
                    options.logger?.info?.(createRequestObservationLog(event.value));
                }
                else if (event.type === 'presentation') {
                    options.logger?.info?.(createPresentationObservationLog(event.value));
                }
            }
        });
        this.hub = new ObservationHub({
            subscribers: Object.freeze([this.metrics, this.traceRecorder, logSubscriber]),
            onSinkFailure: reportFailure,
            now: () => {
                try {
                    return options.now().getTime();
                }
                catch {
                    return 0;
                }
            }
        });
        this.#setLevel(options.initialLevel);
        if (options.initialLevel === 'off')
            void this.#ensureBarrier();
    }
    publish(event) {
        if (!this.gate.allow(event))
            return;
        this.hub.publish(event);
        if (event.type === 'request' && this.#requestObservationMonitor !== undefined) {
            try {
                void Promise.resolve(this.#requestObservationMonitor.publish(event.value)).catch(() => { });
            }
            catch { }
        }
    }
    currentLevel() {
        return this.#currentLevel;
    }
    registerPolicy(runRef, policy) {
        this.gate.register(runRef, policy);
    }
    acceptCommittedTraceCandidate(candidate) {
        if (!this.gate.allowCommittedCandidate(candidate))
            return;
        try {
            this.metrics.observeCommittedTraceCandidate(candidate);
        }
        catch {
            this.#reportDirectFailure('metrics', 'rejected');
        }
        try {
            this.traceRecorder.stageCommittedTraceCandidate(candidate);
        }
        catch {
            this.#reportDirectFailure('trace', 'rejected');
        }
    }
    acceptTraceProjectionFailure(code) {
        if (code !== 'projection_rejected')
            return;
        this.#reportDirectFailure('trace', 'rejected');
        try {
            this.#logger?.error?.(Object.freeze({ event: 'trace/projection_rejected' }));
        }
        catch { }
    }
    async updateLevel(level) {
        if (level === 'off') {
            this.#setLevel('off');
            if (this.#barrierState === 'confirmed')
                return Object.freeze({ kind: 'applied' });
            const barrier = this.#ensureBarrier();
            return await this.#boundedBarrierAck(barrier);
        }
        if (this.#currentLevel === 'off') {
            if (this.#barrierState === 'pending') {
                return Object.freeze({ kind: 'barrier_pending' });
            }
            if (this.#barrierState === 'failed' || this.#barrierState !== 'confirmed') {
                return Object.freeze({ kind: 'barrier_failed' });
            }
        }
        this.#setLevel(level);
        this.#barrierState = 'idle';
        return Object.freeze({ kind: 'applied' });
    }
    #setLevel(level) {
        this.#currentLevel = level;
        this.gate.setCurrentLevel(level);
        this.metrics.setCurrentLevel(level);
        this.traceRecorder.setCurrentLevel(level);
    }
    #ensureBarrier() {
        if (this.#barrierPromise !== null)
            return this.#barrierPromise;
        this.#barrierState = 'pending';
        const bottom = this.traceStore.advanceGenerationAndClear().then(() => {
            this.#barrierState = 'confirmed';
            return 'confirmed';
        }, () => {
            this.#barrierState = 'failed';
            return 'failed';
        });
        this.#barrierPromise = bottom.finally(() => {
            this.#barrierPromise = null;
        });
        return this.#barrierPromise;
    }
    async #boundedBarrierAck(barrier) {
        let timer;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve('pending'), OFF_BARRIER_ACK_MS);
        });
        const result = await Promise.race([barrier, timeout]);
        if (timer !== undefined)
            clearTimeout(timer);
        return Object.freeze({
            kind: result === 'confirmed'
                ? 'applied'
                : result === 'failed' ? 'barrier_failed' : 'barrier_pending'
        });
    }
    #reportDirectFailure(sink, code) {
        const failure = sinkFailure(sink, code, this.#now);
        try {
            this.metrics.recordSinkFailure(failure);
        }
        catch { }
    }
}
export async function updateProductionObservabilityLevel(level) {
    if (!OBSERVABILITY_LEVELS.has(level)) {
        throw new TypeError('production observation level is invalid');
    }
    if (activeObservabilityRuntime === undefined) {
        preInitializationLevel = level;
        return Object.freeze({
            kind: level === 'off' ? 'barrier_pending' : 'applied'
        });
    }
    const result = await activeObservabilityRuntime.updateLevel(level);
    if (level === 'off' || result.kind === 'applied') {
        preInitializationLevel = level;
    }
    return result;
}
function eventScalar(value) {
    return typeof value === 'string' || typeof value === 'number'
        ? String(value).normalize('NFC').trim()
        : '';
}
function eventActorId(event) {
    return eventScalar(event.sender?.user_id ?? event.user_id);
}
function commandTarget(event, getBotId) {
    const botId = eventScalar(getBotId(event));
    const actorId = eventActorId(event);
    if (event.isGroup === true) {
        return Object.freeze({
            botId,
            scope: Object.freeze({
                kind: 'group',
                groupId: eventScalar(event.group_id)
            })
        });
    }
    return Object.freeze({
        botId,
        scope: Object.freeze({ kind: 'private', userId: actorId })
    });
}
function requestMessageId(event) {
    const value = eventScalar(event.message_id ?? event.seq);
    return value === '' || Buffer.byteLength(value, 'utf8') > 128
        ? undefined
        : value;
}
function createTtsDiagnostics(options) {
    return Object.freeze({
        reportSynthesisFailure: (code) => options.bridge.logger?.error?.(Object.freeze({
            event: TTS_SYNTHESIS_DIAGNOSTIC_EVENT,
            code
        }))
    });
}
async function interruptibleSleep(milliseconds, signal) {
    if (signal?.aborted === true)
        throw signal.reason;
    await new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
        };
        const timer = setTimeout(finish, Math.max(0, milliseconds));
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer.unref?.();
    });
}
function terminalPresentation(options, presenter) {
    return Object.freeze({
        async present({ route, projection }) {
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
                }));
            }
            const settings = await options.presentationSettings.load(route.actorId);
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
                }));
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
            }));
        }
    });
}
export function createProductionYunzaiAgent(options) {
    const model = options.modelFactory();
    const random = options.random ?? Math.random;
    const now = options.now ?? (() => new Date());
    const journalNow = options.journalNow ?? (() => new Date());
    const monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()));
    const runStore = new RedisRunStore({ client: options.bridge.redis });
    const admission = new RunAdmission({ client: options.bridge.redis });
    const observability = new ProductionObservabilityRuntime({
        redis: options.bridge.redis,
        runStore,
        admission,
        logger: options.bridge.logger,
        requestObservationMonitor: options.requestObservations,
        initialLevel: preInitializationLevel ?? configuredObservabilityLevel(options.bridge.config.observabilityLevel),
        now
    });
    const rawOutboundFactory = createYunzaiOutboundPortFactory(options.outboundHost);
    const { contentJournal, outboundFactory } = createProductionJournalRuntime(options, rawOutboundFactory, journalNow);
    const progressPresenter = new RunProgressPresenter({
        onAttachment: metadata => observability.registerPolicy(metadata.runRef, metadata.observationPolicy),
        publishObservation: event => observability.publish(event),
        monotonicNow,
        onDeliveryFailure: failure => options.bridge.logger?.warn?.(`运行进度发送失败：${failure.resultCode}`)
    });
    const pendingIndicator = new PendingIndicatorPresenter({
        onDeliveryFailure: failure => options.bridge.logger?.warn?.(`运行提示发送失败：${failure.resultCode}`)
    });
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
    });
    const completionCoordinator = createPresentationCompletionCoordinator({
        publisher: Object.freeze({
            publish: (observation) => observability.publish(Object.freeze({
                schemaVersion: 1,
                type: 'request',
                value: observation
            }))
        }),
        monotonicNow,
        onPublishFailure: code => options.bridge.logger?.error?.(Object.freeze({
            event: code
        }))
    });
    const approvalControlPresenter = createApprovalControlPresenter({ outboundFactory });
    let approvalOutcomeHandler = async () => {
        throw new Error('approval outcome handler is not initialized');
    };
    const bridge = createYunzaiAgentServiceBridge(Object.freeze({
        ...options.bridge,
        botPicker: options.botPicker,
        presentationRuntime: Object.freeze({
            outboundFactory,
            settings: options.presentationSettings,
            pendingConfig: options.pendingConfig,
            pendingIndicator,
            onApprovalOutcome: async (result, reference, context) => await approvalOutcomeHandler(result, reference, context)
        })
    }), {
        progressPresenter,
        modelAdapter: model,
        runStore,
        admission,
        ...(contentJournal === undefined ? {} : { contentJournal }),
        observations: Object.freeze({
            publish: event => observability.publish(event),
            acceptCommittedTraceCandidate: candidate => (observability.acceptCommittedTraceCandidate(candidate)),
            acceptTraceProjectionFailure: code => observability.acceptTraceProjectionFailure(code)
        })
    });
    const promptScreening = Object.freeze({
        async isBlocked({ event, prompt }) {
            const actorId = eventActorId(event);
            const settings = await options.presentationSettings.load(actorId);
            return promptIsBlocked(prompt, settings.promptBlockWords);
        }
    });
    const chatRequests = Object.freeze({
        async prepare({ event, prompt, ocrTexts, groupMerge, presentationIntent }) {
            const evidence = await prepareYunzaiMessageEvidence({
                event,
                currentPrompt: prompt,
                ocrTexts
            });
            const prepared = prepareYunzaiPresentationRequest({
                event,
                evidence,
                requestKind: 'ordinary_chat',
                presentationIntent,
                getBotId: current => eventScalar(options.bridge.getBotId(current)),
                groupMerge
            });
            if (prepared.route.requestKind !== 'ordinary_chat') {
                throw new TypeError('ordinary presentation route is invalid');
            }
            return Object.freeze({ route: prepared.route, evidence: prepared.evidence });
        }
    });
    const controls = Object.freeze({
        async presentCommand({ event, message, quote }) {
            const outbound = await outboundFactory.forTarget(commandTarget(event, options.bridge.getBotId));
            const quoteMessageId = quote ? requestMessageId(event) : undefined;
            await deliverWithDefiniteRetry(outbound, plainTextPart(message), quoteMessageId === undefined ? undefined : { quoteMessageId });
        },
        async presentRouteNotice({ route, message, quote }) {
            const outbound = await outboundFactory.forTarget(route.sessionAddress);
            const quoteMessageId = quote ? route.requestMessageId : undefined;
            await deliverWithDefiniteRetry(outbound, plainTextPart(message), quoteMessageId === undefined ? undefined : { quoteMessageId });
        }
    });
    const lifecycleFactory = Object.freeze({
        async create({ route, profile }) {
            const enabled = await options.pendingConfig.getEnabled().catch(() => false);
            return createRunPresentationLifecycle({
                route,
                profile,
                pendingEnabled: enabled,
                outboundFactory,
                pending: pendingIndicator,
                progress: progressPresenter
            });
        }
    });
    const diagnostics = Object.freeze({
        record: (entry) => options.bridge.logger?.info?.(entry)
    });
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
    }, CONVERSATION_MODE_PREFIXES);
    const bymRequests = Object.freeze({
        async prepare({ event, prompt, presentationIntent }) {
            const evidence = await prepareYunzaiMessageEvidence({
                event,
                currentPrompt: prompt,
                ocrTexts: Object.freeze([])
            });
            const prepared = prepareYunzaiPresentationRequest({
                event,
                evidence,
                requestKind: 'proactive_chat',
                presentationIntent,
                getBotId: current => eventScalar(options.bridge.getBotId(current)),
                groupMerge: true
            });
            if (prepared.route.requestKind !== 'proactive_chat') {
                throw new TypeError('proactive presentation route is invalid');
            }
            return Object.freeze({ route: prepared.route, evidence: prepared.evidence });
        }
    });
    const bymAgent = Object.freeze({
        async handleEphemeral({ event, prepared, systemInstructions, enableGroupContext, thinkingMode, reasoningEffort }) {
            return await bridge.handleEphemeral(event, prepared.evidence, Object.freeze({
                presentationRoute: prepared.route,
                systemInstructions,
                enableGroupContext,
                thinkingMode,
                reasoningEffort
            }));
        }
    });
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
    });
    const approvalBaseOptions = Object.freeze({
        projector: Object.freeze({
            project: async (event) => await bridge.projectApprovalReply(event)
        }),
        router: Object.freeze({
            route: async (projection, onResult) => await bridge.consumeApprovalReply(projection, onResult)
        }),
        controlPresenter: approvalControlPresenter,
        pausedHandler: Object.freeze({
            async handle({ result, reference, context }) {
                const displayed = await bridge.displayApprovalOrCancel(result);
                if (displayed.kind !== 'paused') {
                    await approvalOutcomeHandler(displayed, reference, context);
                }
            }
        }),
        terminalPresenter: terminalPresentation(options, presenter),
        completionCoordinator
    });
    approvalOutcomeHandler = createApprovalOutcomeHandler(approvalBaseOptions);
    const approvalOptions = Object.freeze({
        ...approvalBaseOptions,
        outcomeHandler: approvalOutcomeHandler
    });
    const approvalController = createYunzaiApprovalController(approvalOptions);
    const diagnosticsController = new YunzaiDiagnosticsController(new OwnerDiagnostics({
        metrics: observability.metrics,
        traceStore: observability.traceStore,
        currentLevel: () => observability.currentLevel(),
        logger: options.bridge.logger
    }));
    const lifecycle = {
        unbindShutdown: null,
        shutdownPromise: null
    };
    const graph = Object.freeze({
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
        shutdown: async (reason = 'process_shutdown') => {
            lifecycle.shutdownPromise ??= (async () => {
                try {
                    return await bridge.shutdown(reason);
                }
                finally {
                    try {
                        await contentJournal?.drain();
                    }
                    catch { }
                }
            })().finally(() => {
                lifecycle.unbindShutdown?.();
                lifecycle.unbindShutdown = null;
            });
            return await lifecycle.shutdownPromise;
        }
    });
    graphLifecycles.set(graph, lifecycle);
    activeObservabilityRuntime = observability;
    return graph;
}
export function initializeProductionYunzaiAgent(options) {
    if (productionSingleton !== undefined) {
        throw new ProductionYunzaiAgentAlreadyInitializedError();
    }
    const graph = createProductionYunzaiAgent(options);
    const lifecycle = graphLifecycles.get(graph);
    if (lifecycle === undefined)
        throw new TypeError('production graph lifecycle is unavailable');
    lifecycle.unbindShutdown = bindYunzaiShutdownSignals(graph);
    productionSingleton = graph;
    return graph;
}
export function getProductionYunzaiAgent() {
    if (productionSingleton === undefined) {
        throw new ProductionYunzaiAgentNotInitializedError();
    }
    return productionSingleton;
}
