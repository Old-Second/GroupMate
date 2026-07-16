import type { SessionAddress } from '../agent/contracts/identity.js'
import {
  aggregatePresentationResults,
  type DeliveryResult,
  type PresentationDeliveryMedia,
  type PresentationResult
} from './presentation/presentation-result.js'
import type { PicturePresentationSettings } from './presentation/presentation-settings.js'
import {
  normalizeCitationForwards,
  normalizeReasoningView,
  type CitationForward,
  type ReasoningView
} from './presentation/reply-content.js'
import type { GroupMatePictureRenderer } from './presentation/groupmate-picture-renderer.js'
import {
  citationForwardPart,
  plainTextPart,
  reasoningForwardPart
} from './presentation/text-presentation.js'
import {
  deliverWithDefiniteRetry,
  type OutboundPart,
  type YunzaiOutboundPort,
  type YunzaiOutboundPortFactory
} from './presentation/yunzai-outbound-port.js'

export interface PictureReplyPresentationInput {
  readonly text: string
  readonly target: SessionAddress
  readonly citations: readonly CitationForward[]
  readonly reasoningView: ReasoningView | null
  readonly settings: PicturePresentationSettings
  readonly quoteMessageId?: string
  readonly signal?: AbortSignal
}

function frozenResult (
  outcome: PresentationResult['outcome'],
  deliveries: readonly DeliveryResult<PresentationDeliveryMedia>[]
): PresentationResult {
  return Object.freeze({ schemaVersion: 1, outcome, deliveries: Object.freeze([...deliveries]) })
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
    [delivery]
  )
}

async function deliverPart<P extends OutboundPart> (
  port: YunzaiOutboundPort,
  part: P,
  input: PictureReplyPresentationInput,
  quote = false
): Promise<PresentationResult> {
  const attempts = await deliverWithDefiniteRetry(port, part, {
    ...(quote && input.quoteMessageId !== undefined
      ? { quoteMessageId: input.quoteMessageId }
      : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  })
  const final = attempts.at(-1)
  return final === undefined
    ? frozenResult('failed', [])
    : resultFromDelivery(final as DeliveryResult<PresentationDeliveryMedia>)
}

async function presentTextFallback (
  port: YunzaiOutboundPort,
  input: PictureReplyPresentationInput
): Promise<PresentationResult> {
  const children: PresentationResult[] = []
  const citations = normalizeCitationForwards(input.citations)
  if (citations.length > 0) {
    children.push(await deliverPart(port, citationForwardPart(citations), input))
  }
  children.push(await deliverPart(port, plainTextPart(input.text), input, true))
  const reasoning = input.reasoningView === null
    ? undefined
    : normalizeReasoningView(input.reasoningView)
  if (reasoning !== undefined) {
    children.push(await deliverPart(port, reasoningForwardPart(reasoning.text), input))
  }
  return aggregatePresentationResults(children)
}

export async function presentPictureReply (
  input: PictureReplyPresentationInput,
  dependencies: {
    readonly renderer: GroupMatePictureRenderer
    readonly outboundFactory: YunzaiOutboundPortFactory
  }
): Promise<PresentationResult> {
  let rendered: Awaited<ReturnType<GroupMatePictureRenderer['render']>>
  try {
    rendered = await dependencies.renderer.render({
      replyText: input.text,
      citations: normalizeCitationForwards(input.citations),
      reasoningView: input.reasoningView === null
        ? null
        : normalizeReasoningView(input.reasoningView) ?? null,
      settings: input.settings
    }, input.signal)
  } catch {
    rendered = Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
  }

  let port: YunzaiOutboundPort
  try {
    port = await dependencies.outboundFactory.forTarget(input.target)
  } catch {
    return frozenResult('failed', [])
  }
  if (rendered.kind === 'not_rendered') return await presentTextFallback(port, input)

  let picture: PresentationResult
  try {
    picture = await deliverPart(port, Object.freeze({
      media: 'picture' as const,
      resource: rendered.resource
    }), input, true)
  } catch {
    return frozenResult('unknown', [])
  }
  if (picture.outcome === 'complete' || picture.outcome === 'unknown') return picture
  const fallback = await presentTextFallback(port, input)
  return aggregatePresentationResults([picture, fallback])
}
