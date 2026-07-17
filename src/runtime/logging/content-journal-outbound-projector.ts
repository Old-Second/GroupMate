import { types as utilTypes } from 'node:util'
import type { SessionAddress } from '../../agent/contracts/identity.js'
import { RUN_RESOURCE_LIMITS } from '../../agent/run/run-limits.js'
import type {
  DeliveryResult,
  OutboundMedia,
  RuntimeDeliveryReceipt
} from '../presentation/presentation-result.js'
import type {
  OutboundPart,
  RecallResult
} from '../presentation/yunzai-outbound-port.js'
import {
  boundedRecord,
  CONTENT_JOURNAL_JSON_NODE_LIMIT,
  createProjectionBudget,
  exactKeys,
  ownDataArray,
  ownDataRecord,
  projectSessionAddress,
  safeHttpUrl,
  safeInteger,
  text,
  timestamp,
  type ProjectionBudget,
  type ProjectedJournalEvent,
  type UnknownRecord
} from './content-journal-projection.js'

export type GroupMateOutboundJournalEvent =
  | {
      readonly type: 'qq.outbound.deliver'
      readonly occurredAt: string
      readonly target: SessionAddress
      readonly part: OutboundPart
      readonly attempt: 1 | 2
      readonly quoteMessageId: string | null
      readonly result: DeliveryResult
    }
  | {
      readonly type: 'qq.outbound.recall'
      readonly occurredAt: string
      readonly target: SessionAddress
      readonly receipt: RuntimeDeliveryReceipt
      readonly result: RecallResult
    }

const MEDIA = new Set<OutboundMedia>([
  'text', 'picture', 'voice', 'forward', 'video', 'music', 'dice', 'rps'
])
const DELIVERY_CODES = new Set([
  'invalid_target', 'invalid_part', 'aborted_before_dispatch', 'host_rejected',
  'host_exception_after_dispatch', 'host_timeout_after_dispatch',
  'host_abort_after_dispatch', 'unknown_host_result'
])
const RECALL_DEFINITE_CODES = new Set([
  'receipt_not_owned', 'message_id_unavailable', 'aborted_before_dispatch', 'host_rejected'
])
const RECALL_UNKNOWN_CODES = new Set([
  'host_exception_after_dispatch', 'host_timeout_after_dispatch',
  'host_abort_after_dispatch', 'unknown_host_result'
])

function projectedText (
  value: unknown,
  label: string,
  budget: ProjectionBudget,
  allowEmpty = false
): string {
  const result = text(value, label, allowEmpty)
  budget.consumeText(result, label)
  return result
}

function projectTextAtom (
  value: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound text atom')
  if (input.kind === 'text') {
    exactKeys(input, ['kind', 'text'], ['kind', 'text'], 'outbound text atom')
    return { kind: input.kind, text: projectedText(input.text, 'outbound text', budget, true) }
  }
  if (input.kind === 'markdown') {
    exactKeys(input, ['kind', 'markdown'], ['kind', 'markdown'], 'outbound markdown atom')
    return {
      kind: input.kind,
      markdown: projectedText(input.markdown, 'outbound markdown', budget, true)
    }
  }
  if (input.kind === 'face') {
    exactKeys(input, ['kind', 'faceId'], ['kind', 'faceId'], 'outbound face atom')
    return { kind: input.kind, faceId: safeInteger(input.faceId, 'outbound face ID') }
  }
  if (input.kind !== 'at') throw new TypeError('outbound text atom is invalid')
  exactKeys(input, ['kind', 'target'], ['kind', 'target'], 'outbound at atom')
  if (input.target === 'all') return { kind: input.kind, target: 'all' }
  const target = ownDataRecord(input.target, 'outbound at target')
  exactKeys(target, ['userId'], ['userId'], 'outbound at target')
  return {
    kind: input.kind,
    target: { userId: projectedText(target.userId, 'outbound at user ID', budget) }
  }
}

function projectButtons (
  value: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound buttons')
  exactKeys(
    input,
    ['schemaVersion', 'kind', 'suggestions'],
    ['schemaVersion', 'kind', 'suggestions'],
    'outbound buttons'
  )
  if (input.schemaVersion !== 1 || input.kind !== 'chat_suggestions') {
    throw new TypeError('outbound buttons are invalid')
  }
  const suggestions = ownDataArray(input.suggestions, 'outbound suggestions', budget)
    .map(item => projectedText(item, 'outbound suggestion', budget))
  return { schemaVersion: 1, kind: 'chat_suggestions', suggestions }
}

function projectResource (
  value: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound resource')
  const commonKeys = ['kind', 'mimeType', 'byteLength']
  const mimeType = projectedText(input.mimeType, 'outbound resource mime type', budget)
  const byteLength = safeInteger(input.byteLength, 'outbound resource byte length')
  if (input.kind === 'buffer') {
    exactKeys(
      input,
      [...commonKeys, 'data'],
      [...commonKeys, 'data'],
      'outbound buffer resource'
    )
    if (utilTypes.isProxy(input.data) || !(input.data instanceof Uint8Array) ||
      input.data.byteLength !== byteLength) {
      throw new TypeError('outbound buffer resource is invalid')
    }
    return { kind: input.kind, mimeType, byteLength }
  }
  if (input.kind === 'local_path') {
    exactKeys(
      input,
      [...commonKeys, 'path'],
      [...commonKeys, 'path'],
      'outbound local resource'
    )
    return {
      kind: input.kind,
      path: projectedText(input.path, 'outbound resource path', budget),
      mimeType,
      byteLength
    }
  }
  if (input.kind !== 'remote_url') throw new TypeError('outbound resource kind is invalid')
  exactKeys(
    input,
    [...commonKeys, 'url'],
    [...commonKeys, 'url'],
    'outbound remote resource'
  )
  const rawUrl = text(input.url, 'outbound resource URL')
  const url = safeHttpUrl(rawUrl)
  if (url !== undefined) budget.consumeText(url, 'outbound resource URL')
  return {
    kind: input.kind,
    ...(url === undefined ? {} : { url }),
    mimeType,
    byteLength
  }
}

function projectOutboundPart (
  value: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound part')
  if (input.media === 'text') {
    exactKeys(input, ['media', 'atoms', 'buttons'], ['media', 'atoms'], 'outbound text part')
    const atoms = ownDataArray(input.atoms, 'outbound text atoms', budget)
      .map(atom => projectTextAtom(atom, budget))
    return {
      media: input.media,
      atoms,
      ...(input.buttons === undefined ? {} : { buttons: projectButtons(input.buttons, budget) })
    }
  }
  if (input.media === 'picture' || input.media === 'voice' || input.media === 'video') {
    exactKeys(input, ['media', 'resource'], ['media', 'resource'], 'outbound media part')
    return { media: input.media, resource: projectResource(input.resource, budget) }
  }
  if (input.media === 'forward') {
    exactKeys(input, ['media', 'title', 'nodes'], ['media', 'title', 'nodes'], 'outbound forward part')
    const nodes = ownDataArray(input.nodes, 'outbound forward nodes', budget).map(node => {
      const item = ownDataRecord(node, 'outbound forward node')
      exactKeys(item, ['kind', 'text'], ['kind', 'text'], 'outbound forward node')
      if (item.kind !== 'text') throw new TypeError('outbound forward node is invalid')
      return {
        kind: 'text' as const,
        text: projectedText(item.text, 'outbound forward text', budget, true)
      }
    })
    return {
      media: input.media,
      title: projectedText(input.title, 'outbound forward title', budget),
      nodes
    }
  }
  if (input.media === 'music') {
    exactKeys(input, ['media', 'provider', 'id'], ['media', 'provider', 'id'], 'outbound music')
    if (input.provider !== '163') throw new TypeError('outbound music provider is invalid')
    return {
      media: input.media,
      provider: input.provider,
      id: projectedText(input.id, 'music ID', budget)
    }
  }
  if (input.media === 'dice') {
    exactKeys(input, ['media'], ['media'], 'outbound dice')
    return { media: input.media }
  }
  if (input.media === 'rps') {
    exactKeys(input, ['media', 'value'], ['media', 'value'], 'outbound rps')
    if (input.value !== 1 && input.value !== 2 && input.value !== 3) {
      throw new TypeError('outbound rps value is invalid')
    }
    return { media: input.media, value: input.value }
  }
  throw new TypeError('outbound part media is invalid')
}

function projectReceipt (
  value: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound receipt', { allowReceiptBrand: true })
  exactKeys(
    input,
    ['schemaVersion', 'media', 'messageId'],
    ['schemaVersion', 'media'],
    'outbound receipt'
  )
  if (input.schemaVersion !== 1 || typeof input.media !== 'string' ||
    !MEDIA.has(input.media as OutboundMedia)) {
    throw new TypeError('outbound receipt is invalid')
  }
  return {
    schemaVersion: 1,
    media: input.media,
    ...(input.messageId === undefined
      ? {}
      : {
          messageId: projectedText(
            input.messageId,
            'outbound receipt message ID',
            budget
          )
        })
  }
}

function projectDeliveryResult (
  value: unknown,
  media: unknown,
  attempt: unknown,
  budget: ProjectionBudget
): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound delivery result')
  if (input.kind === 'sent') {
    exactKeys(
      input,
      ['kind', 'media', 'attempt', 'receipt'],
      ['kind', 'media', 'attempt', 'receipt'],
      'outbound delivery result'
    )
    const receipt = projectReceipt(input.receipt, budget)
    if (input.media !== media || input.attempt !== attempt || receipt.media !== media) {
      throw new TypeError('outbound delivery result correlation is invalid')
    }
    return { kind: input.kind, media: input.media, attempt: input.attempt, receipt }
  }
  if (input.kind !== 'failed_definite' && input.kind !== 'outcome_unknown') {
    throw new TypeError('outbound delivery result kind is invalid')
  }
  exactKeys(
    input,
    ['kind', 'media', 'attempt', 'code'],
    ['kind', 'media', 'attempt', 'code'],
    'outbound delivery result'
  )
  if (input.media !== media || input.attempt !== attempt ||
    typeof input.code !== 'string' || !DELIVERY_CODES.has(input.code)) {
    throw new TypeError('outbound delivery result is invalid')
  }
  return { kind: input.kind, media: input.media, attempt: input.attempt, code: input.code }
}

function projectRecallResult (value: unknown): Readonly<Record<string, unknown>> {
  const input = ownDataRecord(value, 'outbound recall result')
  if (input.kind === 'recalled') {
    exactKeys(input, ['kind'], ['kind'], 'outbound recall result')
    return { kind: input.kind }
  }
  exactKeys(input, ['kind', 'code'], ['kind', 'code'], 'outbound recall result')
  const codes = input.kind === 'failed_definite'
    ? RECALL_DEFINITE_CODES
    : input.kind === 'outcome_unknown'
      ? RECALL_UNKNOWN_CODES
      : null
  if (codes === null || typeof input.code !== 'string' || !codes.has(input.code)) {
    throw new TypeError('outbound recall result is invalid')
  }
  return { kind: input.kind, code: input.code }
}

function boundedOutboundPayload (
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'outbound payload')
}

export function projectOutboundJournalEvent (
  value: GroupMateOutboundJournalEvent
): ProjectedJournalEvent {
  const input = ownDataRecord(value, 'outbound journal event')
  const budget = createProjectionBudget({
    maxNodes: CONTENT_JOURNAL_JSON_NODE_LIMIT,
    maxTextBytes: RUN_RESOURCE_LIMITS.providerResponseBytes
  })
  if (input.type === 'qq.outbound.deliver') {
    const keys = [
      'type', 'occurredAt', 'target', 'part', 'attempt', 'quoteMessageId', 'result'
    ]
    exactKeys(input, keys, keys, 'outbound delivery event')
    const part = projectOutboundPart(input.part, budget)
    const media = part.media
    const attempt = input.attempt
    if (attempt !== 1 && attempt !== 2) throw new TypeError('outbound attempt is invalid')
    if (input.quoteMessageId !== null) {
      projectedText(input.quoteMessageId, 'outbound quote message ID', budget)
    }
    return {
      type: input.type,
      payload: boundedOutboundPayload({
        occurredAt: timestamp(input.occurredAt, 'outbound timestamp'),
        target: projectSessionAddress(input.target, 'outbound target'),
        part,
        attempt,
        quoteMessageId: input.quoteMessageId,
        result: projectDeliveryResult(input.result, media, attempt, budget)
      })
    }
  }
  if (input.type !== 'qq.outbound.recall') throw new TypeError('outbound event type is invalid')
  const keys = ['type', 'occurredAt', 'target', 'receipt', 'result']
  exactKeys(input, keys, keys, 'outbound recall event')
  return {
    type: input.type,
    payload: boundedOutboundPayload({
      occurredAt: timestamp(input.occurredAt, 'outbound timestamp'),
      target: projectSessionAddress(input.target, 'outbound target'),
      receipt: projectReceipt(input.receipt, budget),
      result: projectRecallResult(input.result)
    })
  }
}
