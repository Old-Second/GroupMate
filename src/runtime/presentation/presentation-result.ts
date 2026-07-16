export type PresentationDeliveryMedia = 'text' | 'picture' | 'voice' | 'forward'

export type OutboundMedia =
  | PresentationDeliveryMedia
  | 'video'
  | 'music'
  | 'dice'
  | 'rps'

export type DeliveryErrorCode =
  | 'invalid_target'
  | 'invalid_part'
  | 'aborted_before_dispatch'
  | 'host_rejected'
  | 'host_exception_after_dispatch'
  | 'host_timeout_after_dispatch'
  | 'host_abort_after_dispatch'
  | 'unknown_host_result'

declare const runtimeDeliveryReceiptBrand: unique symbol

export interface RuntimeDeliveryReceipt<M extends OutboundMedia = OutboundMedia> {
  readonly [runtimeDeliveryReceiptBrand]: true
  readonly schemaVersion: 1
  readonly media: M
  readonly messageId?: string
}

export type DeliveryResult<M extends OutboundMedia = OutboundMedia> =
  | {
      readonly kind: 'sent'
      readonly media: M
      readonly attempt: 1 | 2
      readonly receipt: RuntimeDeliveryReceipt<M>
    }
  | {
      readonly kind: 'failed_definite'
      readonly media: M
      readonly attempt: 1 | 2
      readonly code: DeliveryErrorCode
    }
  | {
      readonly kind: 'outcome_unknown'
      readonly media: M
      readonly attempt: 1 | 2
      readonly code: DeliveryErrorCode
    }

export interface PresentationResult {
  readonly schemaVersion: 1
  readonly outcome: 'complete' | 'partial' | 'failed' | 'unknown' | 'skipped'
  readonly skipReason?: 'already_visible' | 'allowed_silence'
  readonly deliveries: readonly DeliveryResult<PresentationDeliveryMedia>[]
}

export function aggregatePresentationResults (
  children: readonly PresentationResult[]
): PresentationResult {
  const deliveries = Object.freeze(children.flatMap(child => [...child.deliveries]))
  const hasSent = deliveries.some(delivery => delivery.kind === 'sent')
  const hasUnknown = children.some(child => child.outcome === 'unknown') ||
    deliveries.some(delivery => delivery.kind === 'outcome_unknown')
  const hasFailure = children.some(child => child.outcome === 'failed' || child.outcome === 'partial') ||
    deliveries.some(delivery => delivery.kind === 'failed_definite')

  if (hasSent) {
    return Object.freeze({
      schemaVersion: 1,
      outcome: hasUnknown || hasFailure ? 'partial' : 'complete',
      deliveries
    })
  }
  if (hasUnknown) return Object.freeze({ schemaVersion: 1, outcome: 'unknown', deliveries })
  if (hasFailure) return Object.freeze({ schemaVersion: 1, outcome: 'failed', deliveries })

  const attempted = children.some(child => child.outcome !== 'skipped')
  if (attempted) return Object.freeze({ schemaVersion: 1, outcome: 'complete', deliveries })
  const reasons = new Set(children.map(child => child.skipReason).filter(reason => reason !== undefined))
  const skipReason = reasons.size === 1 ? [...reasons][0] : undefined
  return Object.freeze({
    schemaVersion: 1,
    outcome: 'skipped',
    ...(skipReason === undefined ? {} : { skipReason }),
    deliveries
  })
}
