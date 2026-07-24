import type { PresentationIntentV1, PresentationRouteV1 } from '../agent/contracts/interaction.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import type {
  ChatReplyEnvelope,
  ConversationSessionPort,
  FinalChatReplyEnvelope
} from './agent-service.js'
import type {
  YunzaiAgentHandleOptions,
  YunzaiMessageEvent
} from './agent-service-bridge.js'
import { getChatErrorPresentation } from './chat-error-presentation.js'
import {
  endAllConversations,
  endConversation,
  joinConversation,
  listConversations,
  resolveConversationCommandAddress,
  type ConversationCommandEvent
} from './conversation-manager.js'
import type { PreparedYunzaiMessageEvidenceV1 } from './message-input.js'
import {
  ordinaryProfile,
  type FinalPresentationProfile
} from './presentation/presentation-profile.js'
import { normalizeSuggestions } from './presentation/reply-content.js'
import type { ReplyPresenter } from './presentation/reply-presenter.js'
import type {
  PresentationSettings,
  PresentationSettingsPort,
  TtsMode
} from './presentation/presentation-settings.js'
import type { PresentationResult } from './presentation/presentation-result.js'
import type { PresentationCompletionCoordinator } from './request-observation-completion.js'
import type { RunPresentationLifecycle } from './run-presentation-lifecycle.js'
import type { RuntimePresentationHooks } from './runtime-presentation-hooks.js'
import {
  createChatErrorLog,
  createChatRequestLog,
  createChatResponseLog,
  type RuntimeObservationCorrelationV1
} from './safe-chat-logging.js'

export type ConfiguredThinkingMode = 'default' | 'enabled' | 'disabled'
export type ConfiguredReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'max'

export interface ChatEntryPolicySnapshot {
  readonly toggleMode: 'at' | 'prefix'
  readonly enablePrivateChat: boolean
  readonly whitelist: readonly string[]
  readonly blacklist: readonly string[]
  readonly imgOcr: boolean
  readonly groupMerge: boolean
  readonly enableGroupContext: boolean
  readonly thinkingMode: ConfiguredThinkingMode
  readonly reasoningEffort: ConfiguredReasoningEffort
  readonly sessionTtlSeconds?: number
  readonly assistantLabel: string
  readonly promptPrefixOverride: string
  readonly actorCastApi: string
}

export interface ChatEntryPolicyPort {
  entryMode(): 'at' | 'prefix'
  snapshot(event: YunzaiMessageEvent): Promise<ChatEntryPolicySnapshot>
  isMuted(target: PresentationRouteV1['sessionAddress']): Promise<boolean>
  ocrText(event: YunzaiMessageEvent): Promise<readonly string[]>
  appendAzureEmotionFeedback(input: {
    readonly actorId: string
    readonly prompt: string
    readonly preferences: ChatPreferences
  }): Promise<string>
  clearAzureEmotionFeedback(actorId: string): Promise<void>
}

export interface ChatPreferences {
  readonly usePicture: boolean
  readonly useTTS: boolean
  readonly ttsRole: string
  readonly ttsRoleAzure: string
  readonly ttsRoleVoiceVox: string
}

export interface ChatPreferencePort {
  load(actorId: string): Promise<ChatPreferences>
  patch(actorId: string, patch: Readonly<Partial<ChatPreferences>>): Promise<ChatPreferences>
}

export type TtsVoiceSelection =
  | { readonly kind: 'selected', readonly storedVoice: string, readonly message: string }
  | { readonly kind: 'unsupported', readonly message: string }

export interface TtsAdministrationPort {
  getMode(): TtsMode
  setMode(mode: TtsMode): void
  isConfigured(mode: TtsMode): boolean
  selectVoice(mode: TtsMode, requested: string): TtsVoiceSelection
  missingConfigurationMessage(mode: TtsMode, operation: 'enable' | 'role'): string
}

export interface BillingSnapshot {
  readonly hardLimitUsd: number
  readonly totalUsageUsd: number
  readonly expiresAt: Date
}

export interface OpenAiBillingPort {
  queryLastHundredDays(now: Date): Promise<BillingSnapshot>
}

export interface SuggestionGenerationPort {
  generate(input: {
    readonly prompt: string
    readonly response: string
  }, signal?: AbortSignal): Promise<readonly string[]>
}

export interface YunzaiPluginRule {
  readonly reg: string
  readonly fnc: string
  readonly permission?: 'master'
  readonly log?: false
  readonly priority?: '-1000000'
}

export type YunzaiHostPluginRule = {
  -readonly [Key in keyof YunzaiPluginRule]:
  Key extends 'reg' ? string | RegExp : YunzaiPluginRule[Key]
}

export interface PreparedChatRequest {
  readonly route: PresentationRouteV1
  readonly evidence: PreparedYunzaiMessageEvidenceV1
}

type ValidatedPreparedChatRequest = PreparedChatRequest & {
  readonly route: Extract<PresentationRouteV1, { readonly requestKind: 'ordinary_chat' }>
}

export interface ChatRequestPreparationPort {
  prepare(input: {
    readonly event: YunzaiMessageEvent
    readonly prompt: string
    readonly ocrTexts: readonly string[]
    readonly groupMerge: boolean
    readonly presentationIntent: Extract<
      PresentationIntentV1,
      { readonly kind: 'ordinary' }
    >
  }): Promise<PreparedChatRequest>
}

export interface ChatPromptScreeningPort {
  isBlocked(input: {
    readonly event: YunzaiMessageEvent
    readonly prompt: string
  }): Promise<boolean>
}

export interface ChatAgentPort {
  readonly conversations: ConversationSessionPort
  handle(
    event: YunzaiMessageEvent,
    evidence: PreparedYunzaiMessageEvidenceV1,
    options: YunzaiAgentHandleOptions
  ): Promise<ChatReplyEnvelope>
}

export interface ChatControlPresenter {
  presentCommand(input: {
    readonly event: YunzaiMessageEvent
    readonly message: string
    readonly quote: boolean
  }): Promise<void>
  presentRouteNotice(input: {
    readonly route: Extract<PresentationRouteV1, { readonly requestKind: 'ordinary_chat' }>
    readonly message: string
    readonly quote: boolean
  }): Promise<void>
}

export interface ChatLifecycleFactory {
  create(input: {
    readonly route: Extract<PresentationRouteV1, { readonly requestKind: 'ordinary_chat' }>
    readonly profile: Extract<FinalPresentationProfile, { readonly kind: 'ordinary' }>
    readonly settings: PresentationSettings
  }): Promise<RunPresentationLifecycle>
}

export interface RuntimePresentationHookFactory {
  forActiveEvent(event: YunzaiMessageEvent): RuntimePresentationHooks
}

export interface ChatDiagnosticsPort {
  record(entry: Readonly<Record<string, unknown>>): void
}

export interface YunzaiChatController {
  readonly rules: readonly YunzaiPluginRule[]
  hostRules(): YunzaiHostPluginRule[]
  chatgpt(event: YunzaiMessageEvent): Promise<false | void>
  chatgpt1(event: YunzaiMessageEvent): Promise<boolean>
  getAllConversations(event: YunzaiMessageEvent): Promise<void>
  destroyConversations(event: YunzaiMessageEvent): Promise<void>
  endAllConversations(event: YunzaiMessageEvent): Promise<void>
  switch2Picture(event: YunzaiMessageEvent): Promise<void>
  switch2Text(event: YunzaiMessageEvent): Promise<void>
  switch2Audio(event: YunzaiMessageEvent): Promise<void>
  switchTTSSource(event: YunzaiMessageEvent): Promise<void>
  setDefaultRole(event: YunzaiMessageEvent): Promise<void>
  totalAvailable(event: YunzaiMessageEvent): Promise<void>
  joinConversation(event: YunzaiMessageEvent): Promise<boolean>
}

export interface YunzaiChatControllerOptions {
  readonly policy: ChatEntryPolicyPort
  readonly preferences: ChatPreferencePort
  readonly ttsAdministration: TtsAdministrationPort
  readonly billing: OpenAiBillingPort
  readonly suggestions: SuggestionGenerationPort
  readonly promptScreening: ChatPromptScreeningPort
  readonly requests: ChatRequestPreparationPort
  readonly agent: ChatAgentPort
  readonly controls: ChatControlPresenter
  readonly presentationSettings: PresentationSettingsPort
  readonly hooks: RuntimePresentationHookFactory
  readonly lifecycle: ChatLifecycleFactory
  readonly presenter: Pick<ReplyPresenter, 'present'>
  readonly completionCoordinator: PresentationCompletionCoordinator
  readonly diagnostics?: ChatDiagnosticsPort
  readonly postReplyCandidate?: {
    readonly enqueue: (input: Readonly<{
      event: YunzaiMessageEvent
      prepared: ValidatedPreparedChatRequest
      envelope: FinalChatReplyEnvelope
      presentation: PresentationResult
    }>) => Promise<void>
  }
  readonly now?: () => Date
}

function freezeRule (rule: YunzaiPluginRule): YunzaiPluginRule {
  return Object.freeze({ ...rule })
}

export function buildYunzaiChatRules (
  entryMode: 'at' | 'prefix',
  conversationModePrefixes: readonly string[]
): readonly YunzaiPluginRule[] {
  const modes = [...conversationModePrefixes].join('|')
  return Object.freeze([
    freezeRule({ reg: '^#(图片)?chat1[sS]*', fnc: 'chatgpt1' }),
    freezeRule({
      reg: entryMode === 'at' ? '^[^#][sS]*' : '^#(图片)?chat[^gpt][sS]*',
      fnc: 'chatgpt',
      log: false
    }),
    freezeRule({
      reg: '^#(chatgpt)?对话列表$', fnc: 'getAllConversations', permission: 'master'
    }),
    freezeRule({
      reg: `^#?(${modes})?(结束|新开|摧毁|毁灭|完结)对话([sS]*)$`,
      fnc: 'destroyConversations'
    }),
    freezeRule({
      reg: `^#?(${modes})?(结束|新开|摧毁|毁灭|完结)全部对话$`,
      fnc: 'endAllConversations',
      permission: 'master'
    }),
    freezeRule({ reg: '^#chatgpt图片模式$', fnc: 'switch2Picture' }),
    freezeRule({ reg: '^#chatgpt文本模式$', fnc: 'switch2Text' }),
    freezeRule({ reg: '^#chatgpt语音模式$', fnc: 'switch2Audio' }),
    freezeRule({ reg: '^#chatgpt语音换源', fnc: 'switchTTSSource' }),
    freezeRule({ reg: '^#chatgpt设置(语音角色|角色语音|角色)', fnc: 'setDefaultRole' }),
    freezeRule({
      reg: '#(OpenAI|openai)(剩余)?(余额|额度)', fnc: 'totalAvailable', permission: 'master'
    }),
    freezeRule({ reg: '^#(chatgpt)?加入对话', fnc: 'joinConversation' })
  ])
}

function scalarId (value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function actorId (event: YunzaiMessageEvent): string {
  return scalarId(event.sender?.user_id ?? event.user_id)
}

function botId (event: YunzaiMessageEvent): string {
  return scalarId(event.self_id ?? event.bot?.uin)
}

function messageText (event: YunzaiMessageEvent): string {
  return typeof event.msg === 'string' ? event.msg : ''
}

function booleanField (event: YunzaiMessageEvent, key: string): boolean {
  return (event as Readonly<Record<string, unknown>>)[key] === true
}

function atSegments (event: YunzaiMessageEvent): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(event.message)) return Object.freeze([])
  return Object.freeze(event.message.filter(segment =>
    segment !== null && typeof segment === 'object' &&
    (segment as Readonly<Record<string, unknown>>).type === 'at'
  ) as Readonly<Record<string, unknown>>[])
}

function mentionsSomebodyElse (event: YunzaiMessageEvent): boolean {
  return !booleanField(event, 'atme') && !booleanField(event, 'atBot') &&
    atSegments(event).length > 0
}

function eventIsGroup (event: YunzaiMessageEvent): boolean {
  return event.isGroup === true || scalarId(event.group_id) !== ''
}

function conversationEvent (event: YunzaiMessageEvent): ConversationCommandEvent {
  const sender = event.sender
  const message = Array.isArray(event.message)
    ? event.message.filter((value): value is Readonly<Record<string, unknown>> =>
        value !== null && typeof value === 'object')
    : undefined
  return Object.freeze({
    isGroup: eventIsGroup(event),
    ...(typeof event.group_id === 'string' || typeof event.group_id === 'number'
      ? { group_id: event.group_id }
      : {}),
    ...(typeof event.user_id === 'string' || typeof event.user_id === 'number'
      ? { user_id: event.user_id }
      : {}),
    ...(typeof event.self_id === 'string' || typeof event.self_id === 'number'
      ? { self_id: event.self_id }
      : {}),
    ...(typeof event.bot?.uin === 'string' || typeof event.bot?.uin === 'number'
      ? { bot: Object.freeze({ uin: event.bot.uin }) }
      : {}),
    ...(sender === undefined
      ? {}
      : {
          sender: Object.freeze({
            ...(typeof sender.user_id === 'string' || typeof sender.user_id === 'number'
              ? { user_id: sender.user_id }
              : {}),
            ...(typeof sender.nickname === 'string' ? { nickname: sender.nickname } : {}),
            ...(typeof sender.card === 'string' ? { card: sender.card } : {})
          })
        }),
    ...(message === undefined ? {} : { message: Object.freeze(message) })
  })
}

function removeBotDisplayName (event: YunzaiMessageEvent, prompt: string): string {
  if (!eventIsGroup(event)) return prompt
  try {
    const hostBot = event.bot as Readonly<Record<string, unknown>> | undefined
    const listing = hostBot?.gml
    const member = listing instanceof Map
      ? listing.get(event.self_id ?? event.bot?.uin)
      : undefined
    if (member === null || typeof member !== 'object') return prompt
    const record = member as Readonly<Record<string, unknown>>
    const names = [record.nickname, record.card]
      .filter((value): value is string => typeof value === 'string' && value !== '')
    let result = prompt
    for (const name of new Set(names)) result = result.replace(`@${name}`, '').trim()
    return result
  } catch {
    return prompt
  }
}

function atModePrompt (event: YunzaiMessageEvent): string | null {
  const message = messageText(event)
  if (message === '' || message.startsWith('#')) return null
  if (eventIsGroup(event) && !booleanField(event, 'atme') &&
    !booleanField(event, 'atBot') && scalarId((event as Readonly<Record<string, unknown>>).at) !== botId(event)) {
    return null
  }
  if (actorId(event) === botId(event)) return null
  return removeBotDisplayName(event, message.trim())
    .replace(/^｜本月已发送\d+条消息/, '')
    .trim()
}

function commandPrompt (
  event: YunzaiMessageEvent,
  pattern: RegExp
): { readonly prompt: string, readonly forcePicture: boolean } | null {
  if (mentionsSomebodyElse(event)) return null
  const source = messageText(event).trimStart()
  const prompt = source.replace(pattern, '').trim()
  if (prompt === '') return null
  return Object.freeze({
    prompt,
    forcePicture: source.startsWith('#图片')
  })
}

function listMatches (
  entries: readonly string[],
  event: YunzaiMessageEvent
): boolean {
  const group = scalarId(event.group_id)
  const actor = actorId(event)
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    if (entry.startsWith('^') && entry.slice(1) === actor) return true
    const separator = entry.indexOf('^')
    if (separator > 0 && eventIsGroup(event) &&
      entry.slice(0, separator) === group && entry.slice(separator + 1) === actor) return true
    if (!entry.startsWith('^') && separator < 0 && eventIsGroup(event) && entry === group) return true
  }
  return false
}

function authorized (policy: ChatEntryPolicySnapshot, event: YunzaiMessageEvent): boolean {
  if (!booleanField(event, 'isMaster') && booleanField(event, 'isPrivate') &&
    !policy.enablePrivateChat) return false
  if (listMatches(policy.whitelist, event)) return true
  return !listMatches(policy.blacklist, event)
}

function sameSessionAddress (left: SessionAddress, right: SessionAddress): boolean {
  if (left.botId !== right.botId || left.scope.kind !== right.scope.kind) return false
  if (left.scope.kind === 'group' && right.scope.kind === 'group') {
    return left.scope.groupId === right.scope.groupId
  }
  if (left.scope.kind === 'private' && right.scope.kind === 'private') {
    return left.scope.userId === right.scope.userId
  }
  if (left.scope.kind === 'group_user' && right.scope.kind === 'group_user') {
    return left.scope.groupId === right.scope.groupId && left.scope.userId === right.scope.userId
  }
  return false
}

function dateOnly (date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function displayDate (date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
    `${date.getHours()}:${date.getMinutes()}`
}

function positiveTtl (value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function recordDiagnostic (
  port: ChatDiagnosticsPort | undefined,
  entry: Readonly<Record<string, unknown>>
): void {
  try {
    port?.record(entry)
  } catch {}
}

async function safeSuggestions (
  port: SuggestionGenerationPort,
  enabled: boolean,
  prompt: string,
  envelope: FinalChatReplyEnvelope
): Promise<readonly string[]> {
  if (!enabled || envelope.kind !== 'completed' || envelope.completion.kind !== 'reply_text') {
    return Object.freeze([])
  }
  try {
    return normalizeSuggestions(await port.generate({
      prompt,
      response: envelope.completion.text
    }))
  } catch {
    return Object.freeze([])
  }
}

async function presentFinal (
  options: YunzaiChatControllerOptions,
  prepared: ValidatedPreparedChatRequest,
  settings: PresentationSettings,
  profile: Extract<FinalPresentationProfile, { readonly kind: 'ordinary' }>,
  hooks: RuntimePresentationHooks,
  envelope: FinalChatReplyEnvelope
): Promise<PresentationResult> {
  return await options.completionCoordinator.complete({
    envelope,
    present: async projection => await options.presenter.present(Object.freeze({
      route: prepared.route,
      profile,
      result: projection.result,
      sessionPersistence: projection.sessionPersistence,
      settings,
      citationForwards: Object.freeze([]),
      suggestions: await safeSuggestions(
        options.suggestions,
        settings.enableSuggestedResponses,
        prepared.evidence.prompt,
        envelope
      ),
      hooks
    }))
  })
}

async function presentControlResult (
  options: YunzaiChatControllerOptions,
  event: YunzaiMessageEvent,
  result: { readonly message: string, readonly quote: boolean }
): Promise<void> {
  await options.controls.presentCommand({ event, message: result.message, quote: result.quote })
}

function assertOrdinaryPreparedRequest (
  value: PreparedChatRequest,
  forcePicture: boolean
): asserts value is ValidatedPreparedChatRequest {
  if (value.route.requestKind !== 'ordinary_chat' ||
    value.route.presentationIntent.forcePicture !== forcePicture ||
    value.evidence.prompt.trim() === '') {
    throw new TypeError('prepared chat request is invalid')
  }
}

async function runOrdinaryChat (
  options: YunzaiChatControllerOptions,
  event: YunzaiMessageEvent,
  policy: ChatEntryPolicySnapshot,
  prompt: string,
  forcePicture: boolean
): Promise<void> {
  if (!authorized(policy, event)) return
  let prepared: ValidatedPreparedChatRequest | undefined
  let requestDiagnosticRecorded = false
  let latestCorrelation: RuntimeObservationCorrelationV1 = Object.freeze({
    runRef: 'unavailable' as const,
    terminalObservationId: 'not_attempted' as const
  })
  try {
    const actor = actorId(event)
    const entryAddress = resolveConversationCommandAddress(
      conversationEvent(event),
      policy.groupMerge
    )
    if (await options.policy.isMuted(entryAddress)) return
    const ocrTexts = policy.imgOcr
      ? await options.policy.ocrText(event)
      : Object.freeze([])
    const presentationIntent = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'ordinary' as const,
      forcePicture
    })
    const candidate = await options.requests.prepare({
      event,
      prompt,
      ocrTexts,
      groupMerge: policy.groupMerge,
      presentationIntent
    })
    assertOrdinaryPreparedRequest(candidate, forcePicture)
    prepared = candidate
    if (!sameSessionAddress(prepared.route.sessionAddress, entryAddress)) {
      throw new TypeError('prepared chat route does not match the entry address')
    }
    if (await options.promptScreening.isBlocked({
      event,
      prompt: prepared.evidence.prompt
    })) {
      await options.controls.presentRouteNotice({
        route: prepared.route,
        message: '主人不让我回答你这种问题，真是抱歉了呢',
        quote: true
      })
      return
    }
    const preferences = await options.preferences.load(actor)
    const augmentedPrompt = await options.policy.appendAzureEmotionFeedback({
      actorId: actor,
      prompt: prepared.evidence.prompt,
      preferences
    })
    const presentationSettings = await options.presentationSettings.load(actor)
    const profile = ordinaryProfile({
      forcePicture: prepared.route.presentationIntent.forcePicture,
      quoteCurrentRequest: presentationSettings.quoteReply &&
        prepared.route.requestMessageId !== undefined &&
        prepared.route.sessionAddress.scope.kind !== 'private'
    })
    const hooks = options.hooks.forActiveEvent(event)
    const lifecycle = await options.lifecycle.create({
      route: prepared.route,
      profile,
      settings: presentationSettings
    })
    const cast = policy.actorCastApi.trim() !== ''
      ? policy.actorCastApi
      : policy.promptPrefixOverride
    const systemInstruction = `You are ${policy.assistantLabel}. ${cast} ` +
      `Current date: ${dateOnly((options.now ?? (() => new Date()))())}.`
    const feedbackInstruction = augmentedPrompt.startsWith(prepared.evidence.prompt)
      ? augmentedPrompt.slice(prepared.evidence.prompt.length).trim()
      : augmentedPrompt.trim()
    const ttl = positiveTtl(policy.sessionTtlSeconds)
    const handleOptions: YunzaiAgentHandleOptions = Object.freeze({
      presentationRoute: prepared.route,
      presentationLifecycle: lifecycle,
      systemInstructions: Object.freeze([
        systemInstruction,
        ...(feedbackInstruction === '' ? [] : [feedbackInstruction])
      ]),
      enableGroupContext: policy.enableGroupContext,
      thinkingMode: policy.thinkingMode,
      reasoningEffort: policy.reasoningEffort,
      ...(ttl === undefined ? {} : { sessionTtlSeconds: ttl })
    })
    const envelope = await options.agent.handle(event, prepared.evidence, handleOptions)
    recordDiagnostic(options.diagnostics, createChatRequestLog({
      mode: 'api',
      stream: false,
      prompt: prepared.evidence.prompt,
      correlation: Object.freeze({
        runRef: envelope.runRef,
        terminalObservationId: 'not_attempted'
      })
    }))
    requestDiagnosticRecorded = true
    if (envelope.kind === 'paused') return
    const responseCorrelation = Object.freeze({
      runRef: envelope.runRef,
      terminalObservationId: envelope.runRef === 'unavailable'
        ? 'not_attempted' as const
        : envelope.terminal?.snapshot.observationId ?? 'unavailable' as const
    })
    latestCorrelation = responseCorrelation
    recordDiagnostic(options.diagnostics, createChatResponseLog({
      mode: 'api',
      correlation: responseCorrelation,
      response: envelope.kind === 'completed' && envelope.completion.kind === 'reply_text'
        ? { text: envelope.completion.text }
        : envelope.kind === 'failed'
          ? { error: true }
          : {}
    }))
    const presentation = await presentFinal(
      options,
      prepared,
      presentationSettings,
      profile,
      hooks,
      envelope
    )
    if (options.postReplyCandidate !== undefined &&
      envelope.kind === 'completed' && envelope.completion.kind === 'reply_text' &&
      presentation.deliveries.some(delivery => delivery.kind === 'sent')) {
      const candidateInput = Object.freeze({ event, prepared, envelope, presentation })
      void Promise.resolve()
        .then(async () => await options.postReplyCandidate!.enqueue(candidateInput))
        .catch(() => undefined)
    }
  } catch (error) {
    const presentation = getChatErrorPresentation(error)
    if (!requestDiagnosticRecorded && prepared !== undefined) {
      recordDiagnostic(options.diagnostics, createChatRequestLog({
        mode: 'api',
        stream: false,
        prompt: prepared.evidence.prompt,
        correlation: Object.freeze({
          runRef: 'unavailable',
          terminalObservationId: 'not_attempted'
        })
      }))
    }
    recordDiagnostic(options.diagnostics, createChatErrorLog({
      mode: 'api',
      error,
      category: presentation.code,
      correlation: latestCorrelation
    }))
    if (prepared !== undefined) {
      await options.controls.presentRouteNotice({
        route: prepared.route,
        message: presentation.message,
        quote: true
      })
      return
    }
    await options.controls.presentCommand({
      event,
      message: presentation.message,
      quote: true
    })
  }
}

function modeFromSuffix (message: string): TtsMode | null {
  const suffix = message.replace(/^#chatgpt语音换源/, '').trim()
  if (suffix === '1') return 'vits-uma-genshin-honkai'
  if (suffix === '2') return 'azure'
  if (suffix === '3') return 'voicevox'
  return null
}

function roleField (mode: TtsMode): keyof Pick<
ChatPreferences,
'ttsRole' | 'ttsRoleAzure' | 'ttsRoleVoiceVox'
> {
  if (mode === 'azure') return 'ttsRoleAzure'
  if (mode === 'voicevox') return 'ttsRoleVoiceVox'
  return 'ttsRole'
}

export function createYunzaiChatController (
  options: YunzaiChatControllerOptions,
  conversationModePrefixes: readonly string[]
): YunzaiChatController {
  const rules = buildYunzaiChatRules(options.policy.entryMode(), conversationModePrefixes)
  const controller: YunzaiChatController = {
    rules,

    hostRules (): YunzaiHostPluginRule[] {
      return rules.map(rule => ({ ...rule }))
    },

    async chatgpt (event: YunzaiMessageEvent): Promise<false | void> {
      const current = await options.policy.snapshot(event)
      const parsed = current.toggleMode === 'at'
        ? (() => {
            const prompt = atModePrompt(event)
            return prompt === null || prompt === ''
              ? null
              : Object.freeze({ prompt, forcePicture: false })
          })()
        : commandPrompt(event, /#(图片)?chat/)
      if (parsed === null) return false
      await runOrdinaryChat(options, event, current, parsed.prompt, parsed.forcePicture)
    },

    async chatgpt1 (event: YunzaiMessageEvent): Promise<boolean> {
      const parsed = commandPrompt(event, /#(图片)?chat1/)
      if (parsed === null) return false
      const current = await options.policy.snapshot(event)
      await runOrdinaryChat(options, event, current, parsed.prompt, parsed.forcePicture)
      return true
    },

    async getAllConversations (event: YunzaiMessageEvent): Promise<void> {
      await presentControlResult(options, event, await listConversations({
        bridge: options.agent.conversations,
        event: conversationEvent(event)
      }))
    },

    async destroyConversations (event: YunzaiMessageEvent): Promise<void> {
      const current = await options.policy.snapshot(event)
      await options.policy.clearAzureEmotionFeedback(actorId(event))
      await presentControlResult(options, event, await endConversation({
        bridge: options.agent.conversations,
        event: conversationEvent(event),
        groupMerge: current.groupMerge,
        toggleMode: current.toggleMode
      }))
    },

    async endAllConversations (event: YunzaiMessageEvent): Promise<void> {
      await presentControlResult(options, event, await endAllConversations({
        bridge: options.agent.conversations,
        event: conversationEvent(event)
      }))
    },

    async switch2Picture (event: YunzaiMessageEvent): Promise<void> {
      await options.preferences.patch(actorId(event), { usePicture: true, useTTS: false })
      await presentControlResult(options, event, {
        message: 'ChatGPT回复已转换为图片模式', quote: false
      })
    },

    async switch2Text (event: YunzaiMessageEvent): Promise<void> {
      await options.preferences.patch(actorId(event), { usePicture: false, useTTS: false })
      await presentControlResult(options, event, {
        message: 'ChatGPT回复已转换为文字模式', quote: false
      })
    },

    async switch2Audio (event: YunzaiMessageEvent): Promise<void> {
      const mode = options.ttsAdministration.getMode()
      if (!options.ttsAdministration.isConfigured(mode)) {
        await presentControlResult(options, event, {
          message: options.ttsAdministration.missingConfigurationMessage(mode, 'enable'),
          quote: false
        })
        return
      }
      await options.preferences.patch(actorId(event), { useTTS: true, usePicture: false })
      await presentControlResult(options, event, {
        message: 'ChatGPT回复已转换为语音模式', quote: false
      })
    },

    async switchTTSSource (event: YunzaiMessageEvent): Promise<void> {
      const mode = modeFromSuffix(messageText(event))
      if (mode === null) {
        await presentControlResult(options, event, {
          message: '请使用#chatgpt语音换源+数字进行换源。1为vits-uma-genshin-honkai，2为微软Azure，3为voicevox',
          quote: false
        })
        return
      }
      options.ttsAdministration.setMode(mode)
      await presentControlResult(options, event, {
        message: `语音转换源已切换为${mode}`, quote: false
      })
    },

    async setDefaultRole (event: YunzaiMessageEvent): Promise<void> {
      const mode = options.ttsAdministration.getMode()
      if (!options.ttsAdministration.isConfigured(mode)) {
        await presentControlResult(options, event, {
          message: options.ttsAdministration.missingConfigurationMessage(mode, 'role'),
          quote: false
        })
        return
      }
      const requested = messageText(event)
        .replace(/^#chatgpt设置(语音角色|角色语音|角色)/, '')
        .trim() || '随机'
      const selection = options.ttsAdministration.selectVoice(mode, requested)
      if (selection.kind === 'selected') {
        await options.preferences.patch(actorId(event), {
          [roleField(mode)]: selection.storedVoice
        })
      }
      await presentControlResult(options, event, {
        message: selection.message, quote: false
      })
    },

    async totalAvailable (event: YunzaiMessageEvent): Promise<void> {
      const snapshot = await options.billing.queryLastHundredDays(
        (options.now ?? (() => new Date()))()
      )
      const remaining = snapshot.hardLimitUsd - snapshot.totalUsageUsd
      await presentControlResult(options, event, {
        message: `总额度：$${snapshot.hardLimitUsd}\n` +
          `已经使用额度：$${snapshot.totalUsageUsd}\n` +
          `当前剩余额度：$${remaining}\n` +
          `到期日期(UTC)：${displayDate(snapshot.expiresAt)}`,
        quote: false
      })
    },

    async joinConversation (event: YunzaiMessageEvent): Promise<boolean> {
      const current = await options.policy.snapshot(event)
      const result = await joinConversation({
        bridge: options.agent.conversations,
        event: conversationEvent(event),
        groupMerge: current.groupMerge,
        toggleMode: current.toggleMode,
        ...(positiveTtl(current.sessionTtlSeconds) === undefined
          ? {}
          : { ttlSeconds: positiveTtl(current.sessionTtlSeconds) })
      })
      await presentControlResult(options, event, result)
      return result.success
    }
  }
  return Object.freeze(controller)
}
