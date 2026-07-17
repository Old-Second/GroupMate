import { getChatErrorPresentation } from '../chat-error-presentation.js'
import {
  EMPTY_PRESENTATION_TRACE,
  type PresentationTraceV1
} from '../../agent/contracts/presentation-trace.js'
import {
  aggregatePresentationResults,
  type DeliveryResult,
  type PresentationDeliveryMedia,
  type PresentationResult
} from './presentation-result.js'
import type { FinalPresentationProfile } from './presentation-profile.js'
import {
  buildChatSuggestionButtonRequest,
  normalizeCitationForwards,
  normalizeReasoningView,
  normalizeSuggestions
} from './reply-content.js'
import {
  BLOCKED_RESPONSE_MESSAGE,
  CANCELLED_MESSAGE,
  POSTPROCESS_EMPTY_MESSAGE,
  responseIsBlocked,
  SESSION_PERSISTENCE_FAILED_MESSAGE
} from './response-presentation-safety.js'
import {
  citationForwardPart,
  codePointLength,
  plainTextPart,
  repairCodeFences,
  splitProactiveText,
  textPart
} from './text-presentation.js'
import {
  executionTraceForwardPart,
  selectExecutionTrace
} from './execution-trace-presentation.js'
import {
  deliverWithDefiniteRetry,
  type OutboundDeliveryOptions,
  type OutboundPart,
  type YunzaiOutboundPort,
  type YunzaiOutboundPortFactory
} from './yunzai-outbound-port.js'
import {
  presentTtsReply,
  type TtsPresentationDiagnosticPort
} from './tts-reply-presentation.js'
import type { TtsReplyPort } from './yunzai-tts-reply-port.js'
import type { PresentationInput } from '../runtime-presentation-hooks.js'
import { presentPictureReply } from '../picture-reply.js'
import {
  preprocessTtsText,
  shouldFallbackVitsToText
} from '../tts-presentation.js'
import type { GroupMatePictureRenderer } from './groupmate-picture-renderer.js'
import {
  createPresentationObservationId,
  parseObservationEvent,
  type ObservationEventV1,
  type PresentationFallbackReasonV1,
  type PresentationReducerInputV1,
  type SafeDeliveryObservationV1
} from '../observability/observation-event.js'

export interface ReplyPresenterDependencies {
  readonly outboundFactory: YunzaiOutboundPortFactory
  readonly tts: TtsReplyPort
  readonly ttsDiagnostics: TtsPresentationDiagnosticPort
  readonly pictureRenderer: GroupMatePictureRenderer
  readonly random: () => number
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly schedule: (
    callback: () => void,
    milliseconds: number
  ) => ReturnType<typeof setTimeout>
  readonly publishObservation?: (event: ObservationEventV1) => void
  readonly monotonicNow?: () => number | 'unavailable'
}

interface PresentationDecisionDraft {
  textLengthBucket: PresentationReducerInputV1['textLengthBucket']
  hasReasoning: boolean
  hasCitation: boolean
  buttonsEligible: boolean
  ttsEligibility: PresentationReducerInputV1['ttsEligibility']
  pictureEligibility: PresentationReducerInputV1['pictureEligibility']
  quotePolicy: PresentationReducerInputV1['quotePolicy']
  selectedMode: PresentationReducerInputV1['selectedMode']
  fallbackReason: PresentationFallbackReasonV1
  postprocessAnomaly: boolean
}

function frozenResult (
  outcome: PresentationResult['outcome'],
  deliveries: readonly DeliveryResult<PresentationDeliveryMedia>[],
  skipReason?: PresentationResult['skipReason']
): PresentationResult {
  return Object.freeze({
    schemaVersion: 1,
    outcome,
    ...(skipReason === undefined ? {} : { skipReason }),
    deliveries: Object.freeze([...deliveries])
  })
}

function skipped (reason: 'already_visible' | 'allowed_silence'): PresentationResult {
  return frozenResult('skipped', Object.freeze([]), reason)
}

function failedWithoutDelivery (): PresentationResult {
  return frozenResult('failed', Object.freeze([]))
}

function validRecallAfterMs (value: number | null): boolean {
  return value === null || (
    Number.isSafeInteger(value) &&
    value >= 1_000 &&
    value <= 3_600_000 &&
    value % 1_000 === 0
  )
}

function validOptionalRequestMessageId (value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 128
  )
}

function validPresentationMatrix (input: PresentationInput): boolean {
  try {
    const route = input.route
    const profile = input.profile
    if (route.schemaVersion !== 1 || typeof input.settings.quoteReply !== 'boolean') return false

    if (profile.kind === 'ordinary') {
      if (route.requestKind !== 'ordinary_chat' || route.profile !== 'ordinary' ||
        route.presentationIntent.schemaVersion !== 1 ||
        route.presentationIntent.kind !== 'ordinary' ||
        typeof route.presentationIntent.forcePicture !== 'boolean' ||
        typeof profile.forcePicture !== 'boolean' ||
        profile.forcePicture !== route.presentationIntent.forcePicture) return false
      if (!validOptionalRequestMessageId(route.requestMessageId)) return false
      const hasMessageId = route.requestMessageId !== undefined
      const quoteCurrentRequest = input.settings.quoteReply && hasMessageId &&
        route.sessionAddress.scope.kind !== 'private'
      return typeof profile.quoteCurrentRequest === 'boolean' &&
        profile.quoteCurrentRequest === quoteCurrentRequest
    }

    if (profile.kind === 'proactive') {
      if (route.requestKind !== 'proactive_chat' || route.profile !== 'proactive' ||
        route.presentationIntent.schemaVersion !== 1 ||
        route.presentationIntent.kind !== 'proactive' ||
        !validOptionalRequestMessageId(route.requestMessageId) ||
        !validRecallAfterMs(route.presentationIntent.recallAfterMs)) return false
      return profile.recallAfterMs === route.presentationIntent.recallAfterMs &&
        profile.maxParts === 3 &&
        profile.quoteProbability === 0.1 &&
        profile.delayPerCodePointMs === 200 &&
        profile.maxDelayMs === 3_000
    }

    return profile.kind === 'recovered_legacy_plain_text' &&
      route.requestKind === 'legacy_unknown' &&
      route.profile === 'recovered_legacy_plain_text'
  } catch {
    return false
  }
}

function resultFromDelivery (
  delivery: DeliveryResult<PresentationDeliveryMedia>
): PresentationResult {
  return frozenResult(
    delivery.kind === 'sent'
      ? 'complete'
      : delivery.kind === 'outcome_unknown'
        ? 'unknown'
        : 'failed',
    Object.freeze([delivery])
  )
}

async function deliverLogicalPart<P extends OutboundPart> (
  port: YunzaiOutboundPort,
  part: P,
  options?: OutboundDeliveryOptions
): Promise<PresentationResult> {
  const attempts = await deliverWithDefiniteRetry(port, part, options)
  const final = attempts.at(-1)
  if (final === undefined) return failedWithoutDelivery()
  return resultFromDelivery(final as DeliveryResult<PresentationDeliveryMedia>)
}

function quoteMessageId (
  input: PresentationInput,
  profile: Extract<FinalPresentationProfile, { kind: 'ordinary' }>
): string | undefined {
  if (!input.settings.quoteReply || !profile.quoteCurrentRequest ||
    input.route.requestKind !== 'ordinary_chat' ||
    input.route.sessionAddress.scope.kind === 'private') return undefined
  return input.route.requestMessageId
}

function consumeSideEffect (invoke: () => void | Promise<unknown>): void {
  try {
    void Promise.resolve(invoke()).catch(() => undefined)
  } catch {}
}

function fireNotification (
  input: PresentationInput,
  text: string,
  hasReasoning: boolean
): void {
  if (input.profile.kind === 'recovered_legacy_plain_text') return
  consumeSideEffect(() => input.hooks.notifyResponsePost({
    runRef: input.result.runRef,
    text,
    hasReasoning
  }))
}

async function presentFixedText (
  dependencies: ReplyPresenterDependencies,
  input: PresentationInput,
  text: string,
  quote = false
): Promise<PresentationResult> {
  const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress)
  const requestMessageId = quote && input.route.requestKind === 'ordinary_chat' &&
    input.route.sessionAddress.scope.kind !== 'private'
    ? input.route.requestMessageId
    : undefined
  return await deliverLogicalPart(port, plainTextPart(text), {
    ...(requestMessageId === undefined ? {} : { quoteMessageId: requestMessageId }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  })
}

async function presentOrdinary (
  dependencies: ReplyPresenterDependencies,
  input: PresentationInput,
  text: string,
  executionTrace: PresentationTraceV1
): Promise<PresentationResult> {
  const profile = input.profile
  if (profile.kind !== 'ordinary') return failedWithoutDelivery()
  const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress)
  const children: PresentationResult[] = []
  const citations = normalizeCitationForwards(input.citationForwards)
  const quote = quoteMessageId(input, profile)
  if (input.settings.tts.enabled) {
    if (citations.length > 0) {
      children.push(await deliverLogicalPart(port, citationForwardPart(citations), {
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }))
    }
    children.push(await presentTtsReply({
      text,
      target: input.route.sessionAddress,
      settings: input.settings.tts,
      ...(quote === undefined ? {} : { quoteMessageId: quote }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }, {
      tts: dependencies.tts,
      diagnostics: dependencies.ttsDiagnostics,
      outboundFactory: dependencies.outboundFactory
    }))
  } else if (
    profile.forcePicture ||
    input.settings.picture.userEnabled ||
    (input.settings.picture.autoEnabled &&
      codePointLength(text) >= input.settings.picture.autoThreshold)
  ) {
    children.push(await presentPictureReply({
      text,
      target: input.route.sessionAddress,
      citations,
      reasoningView: null,
      settings: input.settings.picture,
      ...(quote === undefined ? {} : { quoteMessageId: quote }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }, {
      renderer: dependencies.pictureRenderer,
      outboundFactory: dependencies.outboundFactory
    }))
  } else {
    if (citations.length > 0) {
      children.push(await deliverLogicalPart(port, citationForwardPart(citations), {
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }))
    }
    const atoms = await input.hooks.convertText({
      text,
      enableRobotAt: input.settings.enableRobotAt,
      enableMarkdown: input.settings.enableMarkdown
    })
    children.push(await deliverLogicalPart(port, textPart(atoms), {
      ...(quote === undefined ? {} : { quoteMessageId: quote }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }))
  }

  if (executionTrace.segments.length > 0) {
    children.push(await deliverLogicalPart(port, executionTraceForwardPart(executionTrace), {
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }))
  }

  if (input.settings.enableSuggestedResponses) {
    const suggestions = normalizeSuggestions(input.suggestions)
    if (suggestions.length > 0) {
      const buttons = input.settings.enableMarkdown
        ? buildChatSuggestionButtonRequest(suggestions)
        : undefined
      children.push(await deliverLogicalPart(
        port,
        textPart(Object.freeze([{
          kind: 'text',
          text: `建议的回复：\n${suggestions.join('\n')}`
        }]), buttons),
        { ...(input.signal === undefined ? {} : { signal: input.signal }) }
      ))
    }
  }
  return aggregatePresentationResults(children)
}

async function presentProactive (
  dependencies: ReplyPresenterDependencies,
  input: PresentationInput,
  text: string
): Promise<PresentationResult> {
  const profile = input.profile
  if (profile.kind !== 'proactive') return failedWithoutDelivery()
  const chunks = splitProactiveText(text, profile.maxParts)
  if (chunks.length === 0) return failedWithoutDelivery()
  const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress)
  const children: PresentationResult[] = []
  for (const chunk of chunks) {
    const quote = input.route.requestKind === 'proactive_chat' &&
      input.route.requestMessageId !== undefined &&
      dependencies.random() < profile.quoteProbability
      ? input.route.requestMessageId
      : undefined
    const child = await deliverLogicalPart(port, plainTextPart(chunk), {
      ...(quote === undefined ? {} : { quoteMessageId: quote }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    children.push(child)
    if (profile.recallAfterMs !== null) {
      for (const delivery of child.deliveries) {
        if (delivery.kind !== 'sent') continue
        dependencies.schedule(() => {
          consumeSideEffect(() => port.recall(delivery.receipt))
        }, profile.recallAfterMs)
      }
    }
    await dependencies.sleep(
      Math.min(codePointLength(chunk) * profile.delayPerCodePointMs, profile.maxDelayMs),
      input.signal
    )
  }
  return aggregatePresentationResults(children)
}

async function presentRecoveredLegacy (
  dependencies: ReplyPresenterDependencies,
  input: PresentationInput,
  text: string
): Promise<PresentationResult> {
  const port = await dependencies.outboundFactory.forTarget(input.route.sessionAddress)
  return await deliverLogicalPart(port, plainTextPart(text), {
    ...(input.signal === undefined ? {} : { signal: input.signal })
  })
}

export class ReplyPresenter {
  readonly #dependencies: ReplyPresenterDependencies
  readonly #monotonicNow: () => number | 'unavailable'

  constructor (dependencies: ReplyPresenterDependencies) {
    this.#dependencies = dependencies
    this.#monotonicNow = dependencies.monotonicNow ?? (() => Math.trunc(performance.now()))
  }

  async present (input: PresentationInput): Promise<PresentationResult> {
    const startedAt = this.#readMonotonic()
    const decision = this.#createDecisionDraft(input)
    const result = await this.#present(input, decision)
    this.#completeDeliveryDecision(decision, result)
    this.#publishObservation(input, result, decision, startedAt)
    return result
  }

  async #present (
    input: PresentationInput,
    decision: PresentationDecisionDraft
  ): Promise<PresentationResult> {
    if (!validPresentationMatrix(input)) return failedWithoutDelivery()
    if (input.result.kind === 'completed') {
      if (input.result.completion.kind === 'allowed_silence') {
        decision.selectedMode = 'silent'
        return skipped('allowed_silence')
      }
      if (input.result.completion.kind === 'already_visible') {
        if (input.profile.kind !== 'ordinary') {
          decision.selectedMode = 'silent'
          return skipped('already_visible')
        }
        decision.selectedMode = 'silent'
        const executionTrace = selectExecutionTrace(
          input.result.presentationTrace,
          input.settings,
          undefined
        )
        decision.hasReasoning = executionTrace.segments.some(segment => (
          segment.kind === 'reasoning'
        ))
        const children: PresentationResult[] = []
        if (executionTrace.segments.length > 0) {
          const port = await this.#dependencies.outboundFactory.forTarget(
            input.route.sessionAddress
          )
          children.push(await deliverLogicalPart(
            port,
            executionTraceForwardPart(executionTrace),
            { ...(input.signal === undefined ? {} : { signal: input.signal }) }
          ))
        }
        if (input.sessionPersistence === 'failed') {
          decision.textLengthBucket = this.#lengthBucket(SESSION_PERSISTENCE_FAILED_MESSAGE)
          children.push(await presentFixedText(
            this.#dependencies,
            input,
            SESSION_PERSISTENCE_FAILED_MESSAGE
          ))
        }
        return children.length === 0
          ? skipped('already_visible')
          : aggregatePresentationResults(children)
      }
      return await this.#presentReplyText(input, input.result.completion.text, decision)
    }

    if (input.profile.kind === 'proactive') return failedWithoutDelivery()
    const text = input.result.kind === 'failed'
      ? getChatErrorPresentation(input.result.error).message
      : CANCELLED_MESSAGE
    decision.textLengthBucket = this.#lengthBucket(text)
    return await presentFixedText(
      this.#dependencies,
      input,
      text,
      input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
        input.settings.quoteReply
    )
  }

  async #presentReplyText (
    input: PresentationInput,
    canonicalText: string,
    decision: PresentationDecisionDraft
  ): Promise<PresentationResult> {
    const normalizedCanonical = canonicalText.trim().normalize('NFC')
    if (input.profile.kind === 'recovered_legacy_plain_text' &&
      normalizedCanonical === '<EMPTY>') {
      const text = getChatErrorPresentation({ code: 'legacy_entry_kind_unavailable' }).message
      decision.textLengthBucket = this.#lengthBucket(text)
      return await presentFixedText(
        this.#dependencies,
        input,
        text
      )
    }
    const processed = await input.hooks.postprocess({
      text: normalizedCanonical
    })
    const normalized = typeof processed.text === 'string'
      ? processed.text.trim().normalize('NFC')
      : ''
    if (normalized === '') {
      decision.textLengthBucket = 'none'
      decision.fallbackReason = 'postprocess_empty'
      decision.postprocessAnomaly = true
      const main = input.profile.kind === 'proactive'
        ? failedWithoutDelivery()
        : await presentFixedText(
            this.#dependencies,
            input,
            POSTPROCESS_EMPTY_MESSAGE,
            input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
              input.settings.quoteReply
          )
      return await this.#appendPersistenceNotice(input, main)
    }
    if (input.profile.kind === 'recovered_legacy_plain_text' && normalized === '<EMPTY>') {
      const text = getChatErrorPresentation({ code: 'legacy_entry_kind_unavailable' }).message
      decision.textLengthBucket = this.#lengthBucket(text)
      return await presentFixedText(
        this.#dependencies,
        input,
        text
      )
    }
    decision.textLengthBucket = this.#lengthBucket(normalized)
    if (responseIsBlocked(normalized, input.settings.blockWords)) {
      const main = await presentFixedText(
        this.#dependencies,
        input,
        BLOCKED_RESPONSE_MESSAGE,
        input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest &&
          input.settings.quoteReply
      )
      return await this.#appendPersistenceNotice(input, main)
    }

    const finalText = repairCodeFences(normalized)
    const reasoningView = input.profile.kind === 'ordinary'
      ? normalizeReasoningView(processed.reasoningView)
      : undefined
    const executionTrace = input.profile.kind === 'ordinary' && input.result.kind === 'completed'
      ? selectExecutionTrace(
          input.result.presentationTrace,
          input.settings,
          reasoningView
        )
      : EMPTY_PRESENTATION_TRACE
    decision.hasReasoning = executionTrace.segments.some(segment => segment.kind === 'reasoning')
    fireNotification(input, finalText, decision.hasReasoning)

    let main: PresentationResult
    if (input.profile.kind === 'ordinary') {
      main = await presentOrdinary(this.#dependencies, input, finalText, executionTrace)
      this.#captureOrdinaryMode(input, finalText, main, decision)
    } else {
      main = input.profile.kind === 'proactive'
        ? await presentProactive(this.#dependencies, input, finalText)
        : await presentRecoveredLegacy(this.#dependencies, input, finalText)
    }
    return await this.#appendPersistenceNotice(input, main)
  }

  async #appendPersistenceNotice (
    input: PresentationInput,
    main: PresentationResult
  ): Promise<PresentationResult> {
    if (input.profile.kind !== 'ordinary' || input.sessionPersistence !== 'failed' ||
      input.result.kind !== 'completed' || input.result.completion.kind !== 'reply_text') {
      return main
    }
    const notice = await presentFixedText(
      this.#dependencies,
      input,
      SESSION_PERSISTENCE_FAILED_MESSAGE
    )
    return aggregatePresentationResults(Object.freeze([main, notice]))
  }

  #publishObservation (
    input: PresentationInput,
    result: PresentationResult,
    decision: PresentationDecisionDraft,
    startedAt: number | 'unavailable'
  ): void {
    if (this.#dependencies.publishObservation === undefined) return
    const finishedAt = this.#readMonotonic()
    const totalDurationMs = startedAt === 'unavailable' || finishedAt === 'unavailable' ||
      finishedAt < startedAt
      ? 'unavailable' as const
      : finishedAt - startedAt
    const runRef = input.result.runRef
    const terminalObservationId = runRef === 'unavailable'
      ? 'not_attempted' as const
      : input.result.terminal?.snapshot.observationId ?? 'unavailable' as const
    const requestKind = input.route.requestKind === 'legacy_unknown'
      ? 'recovered_legacy_plain_text' as const
      : input.route.requestKind
    const profile = input.profile.kind
    const deliveries = Object.freeze(result.deliveries.map(delivery => (
      this.#safeDelivery(delivery)
    )))
    const reducerInput: PresentationReducerInputV1 = Object.freeze({
      schemaVersion: 1,
      reducerVersion: 1,
      requestKind,
      profile,
      textLengthBucket: decision.textLengthBucket,
      hasReasoning: decision.hasReasoning,
      hasCitation: decision.hasCitation,
      buttonsEligible: decision.buttonsEligible,
      ttsEligibility: decision.ttsEligibility,
      pictureEligibility: decision.pictureEligibility,
      quotePolicy: decision.quotePolicy,
      selectedMode: decision.selectedMode,
      fallbackReason: decision.fallbackReason,
      configEnumVersion: 1
    })
    try {
      this.#dependencies.publishObservation(parseObservationEvent({
        schemaVersion: 1,
        type: 'presentation',
        value: {
          schemaVersion: 1,
          presentationObservationId: createPresentationObservationId(),
          runRef,
          terminalObservationId,
          profile,
          outcome: result.outcome,
          postprocessAnomaly: decision.postprocessAnomaly,
          deliveries,
          totalDurationMs,
          reducerInput
        }
      }))
    } catch {
      // Presentation facts are outside the delivery control plane.
    }
  }

  #safeDelivery (
    delivery: PresentationResult['deliveries'][number]
  ): SafeDeliveryObservationV1 {
    if (delivery.kind === 'sent') {
      return Object.freeze({
        schemaVersion: 1,
        media: delivery.media,
        attempt: delivery.attempt,
        outcome: 'sent',
        code: null
      })
    }
    return delivery.kind === 'failed_definite'
      ? Object.freeze({
          schemaVersion: 1,
          media: delivery.media,
          attempt: delivery.attempt,
          outcome: 'failed_definite',
          code: delivery.code
        })
      : Object.freeze({
          schemaVersion: 1,
          media: delivery.media,
          attempt: delivery.attempt,
          outcome: 'outcome_unknown',
          code: delivery.code
        })
  }

  #createDecisionDraft (input: PresentationInput): PresentationDecisionDraft {
    const ordinary = input.profile.kind === 'ordinary'
    const hasCitation = ordinary && normalizeCitationForwards(input.citationForwards).length > 0
    const pictureRequested = input.settings.picture.userEnabled ||
      input.settings.picture.autoEnabled ||
      (input.profile.kind === 'ordinary' && input.profile.forcePicture)
    const mediaRestricted = !ordinary && (input.settings.tts.enabled || pictureRequested)
    return {
      textLengthBucket: 'none',
      hasReasoning: false,
      hasCitation,
      buttonsEligible: ordinary && input.settings.enableSuggestedResponses &&
        normalizeSuggestions(input.suggestions).length > 0,
      ttsEligibility: ordinary
        ? input.settings.tts.enabled ? 'eligible' : 'disabled'
        : input.settings.tts.enabled ? 'unsupported' : 'disabled',
      pictureEligibility: ordinary
        ? pictureRequested ? 'eligible' : 'disabled'
        : pictureRequested ? 'unsupported' : 'disabled',
      quotePolicy: ordinary && quoteMessageId(input, input.profile) !== undefined
        ? 'current_request'
        : hasCitation ? 'citation_forward' : 'none',
      selectedMode: 'text',
      fallbackReason: mediaRestricted ? 'profile_restricted' : 'none',
      postprocessAnomaly: false
    }
  }

  #captureOrdinaryMode (
    input: PresentationInput,
    text: string,
    result: PresentationResult,
    decision: PresentationDecisionDraft
  ): void {
    const pictureSelected = (input.profile.kind === 'ordinary' && input.profile.forcePicture) ||
      input.settings.picture.userEnabled ||
      (input.settings.picture.autoEnabled &&
        codePointLength(text) >= input.settings.picture.autoThreshold)
    if (input.settings.tts.enabled) {
      const prepared = preprocessTtsText({
        text,
        mode: input.settings.tts.mode,
        filter: input.settings.tts.filter,
        azureEmotionEnabled: input.settings.tts.azureEmotionEnabled
      })
      const contentTooLarge = shouldFallbackVitsToText({
        ttsMode: input.settings.tts.mode,
        textCharacters: codePointLength(prepared.spokenText),
        threshold: input.settings.tts.autoFallbackThreshold
      })
      const voice = result.deliveries.filter(delivery => delivery.media === 'voice')
      const hasSentVoice = voice.some(delivery => delivery.kind === 'sent')
      const hasSentText = result.deliveries.some(delivery =>
        delivery.media === 'text' && delivery.kind === 'sent')
      decision.selectedMode = hasSentVoice ? 'tts' : hasSentText ? 'text' : 'tts'
      if (contentTooLarge) decision.fallbackReason = 'content_too_large'
      else if (voice.length === 0) decision.fallbackReason = 'synthesis_failed'
      return
    }
    if (!pictureSelected) {
      decision.selectedMode = 'text'
      return
    }
    const picture = result.deliveries.filter(delivery => delivery.media === 'picture')
    const hasSentPicture = picture.some(delivery => delivery.kind === 'sent')
    const hasSentText = result.deliveries.some(delivery =>
      delivery.media === 'text' && delivery.kind === 'sent')
    decision.selectedMode = hasSentPicture ? 'picture' : hasSentText ? 'text' : 'picture'
    if (picture.length === 0) decision.fallbackReason = 'render_failed'
  }

  #completeDeliveryDecision (
    decision: PresentationDecisionDraft,
    result: PresentationResult
  ): void {
    if (decision.fallbackReason !== 'none') return
    if (result.deliveries.some(delivery => delivery.kind === 'outcome_unknown')) {
      decision.fallbackReason = 'delivery_unknown'
    } else if (result.deliveries.some(delivery => delivery.kind === 'failed_definite')) {
      decision.fallbackReason = 'delivery_definite_failure'
    }
  }

  #lengthBucket (text: string): PresentationReducerInputV1['textLengthBucket'] {
    const length = [...text].length
    if (length === 0) return 'none'
    if (length <= 40) return '1_40'
    if (length <= 200) return '41_200'
    if (length <= 1_000) return '201_1000'
    if (length <= 4_000) return '1001_4000'
    return 'over_4000'
  }

  #readMonotonic (): number | 'unavailable' {
    try {
      const value = this.#monotonicNow()
      return value === 'unavailable' ||
        (Number.isSafeInteger(value) && value >= 0)
        ? value
        : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }
}
