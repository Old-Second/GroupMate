import { bindYunzaiShutdownSignals, createYunzaiAgentServiceBridge } from './agent-service-bridge.js';
import { prepareYunzaiMessageEvidence } from './message-input.js';
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
const graphLifecycles = new WeakMap();
let productionSingleton;
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
    const monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()));
    const outboundFactory = createYunzaiOutboundPortFactory(options.outboundHost);
    const progressPresenter = new RunProgressPresenter({
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
        schedule: (callback, milliseconds) => setTimeout(callback, milliseconds)
    });
    const completionCoordinator = createPresentationCompletionCoordinator({
        publisher: options.requestObservations,
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
        modelAdapter: model
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
        completionCoordinator
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
        shutdown: async (reason = 'process_shutdown') => {
            lifecycle.shutdownPromise ??= bridge.shutdown(reason).finally(() => {
                lifecycle.unbindShutdown?.();
                lifecycle.unbindShutdown = null;
            });
            return await lifecycle.shutdownPromise;
        }
    });
    graphLifecycles.set(graph, lifecycle);
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
