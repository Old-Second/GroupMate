import type { SessionAddress } from '../../agent/contracts/identity.js'
import { canonicalSessionKey, parseCanonicalSessionKey } from '../../agent/session/conversation-scope.js'
import type { ToolResource } from '../../tools/visible-tool-support.js'
import {
  type DeliveryResult,
  type OutboundMedia,
  type RuntimeDeliveryReceipt
} from './presentation-result.js'

export type { RuntimeDeliveryReceipt } from './presentation-result.js'

const runtimeDeliveryReceiptBrand = Symbol('groupmate.runtimeDeliveryReceipt')

export type SafeTextAtom =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'at'; readonly target: 'all' | { readonly userId: string } }
  | { readonly kind: 'face'; readonly faceId: number }
  | { readonly kind: 'markdown'; readonly markdown: string }

export interface TrustedButtonRequest {
  readonly schemaVersion: 1
  readonly kind: 'chat_suggestions'
  readonly suggestions: readonly string[]
}

export interface SafeForwardNode {
  readonly kind: 'text'
  readonly text: string
}

export type OutboundPart =
  | { readonly media: 'text'; readonly atoms: readonly SafeTextAtom[]; readonly buttons?: TrustedButtonRequest }
  | { readonly media: 'picture'; readonly resource: ToolResource }
  | { readonly media: 'voice'; readonly resource: ToolResource }
  | { readonly media: 'forward'; readonly title: string; readonly nodes: readonly SafeForwardNode[] }
  | { readonly media: 'video'; readonly resource: ToolResource }
  | { readonly media: 'music'; readonly provider: '163'; readonly id: string }
  | { readonly media: 'dice' }
  | { readonly media: 'rps'; readonly value: 1 | 2 | 3 }

export interface OutboundDeliveryOptions {
  readonly quoteMessageId?: string
  readonly signal?: AbortSignal
}

export type RecallResult =
  | { readonly kind: 'recalled' }
  | {
      readonly kind: 'failed_definite'
      readonly code: 'receipt_not_owned' | 'message_id_unavailable' | 'aborted_before_dispatch' | 'host_rejected'
    }
  | {
      readonly kind: 'outcome_unknown'
      readonly code:
        | 'host_exception_after_dispatch'
        | 'host_timeout_after_dispatch'
        | 'host_abort_after_dispatch'
        | 'unknown_host_result'
    }

export interface YunzaiOutboundPort {
  readonly target: SessionAddress
  deliver<P extends OutboundPart>(
    part: P,
    attempt: 1 | 2,
    options?: OutboundDeliveryOptions
  ): Promise<DeliveryResult<P['media']>>
  recall(receipt: RuntimeDeliveryReceipt, signal?: AbortSignal): Promise<RecallResult>
}

export interface YunzaiOutboundPortFactory {
  forTarget(target: SessionAddress): Promise<YunzaiOutboundPort>
}

export const OUTBOUND_DELIVERY_TIMEOUT_MS = 30_000
export const OUTBOUND_RECALL_TIMEOUT_MS = 10_000

export interface YunzaiHostTargetPort {
  dispatch(
    part: OutboundPart,
    quoteMessageId: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<unknown>
  recall(messageId: string | number, signal?: AbortSignal): Promise<unknown>
}

export interface YunzaiOutboundHostPort {
  forTarget(target: SessionAddress): Promise<YunzaiHostTargetPort | null>
}

type RaceResult =
  | { readonly kind: 'fulfilled'; readonly value: unknown }
  | { readonly kind: 'exception' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'abort' }

const invalidTarget: SessionAddress = Object.freeze({
  botId: 'invalid', scope: Object.freeze({ kind: 'private', userId: 'invalid' })
})

function ownData (value: object, key: PropertyKey): PropertyDescriptor | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor : null
  } catch {
    return null
  }
}

function exactDataRecord (value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return false
    return keys.every(key => ownData(value, key) !== null)
  } catch {
    return false
  }
}

function identifier (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function canonicalTarget (value: unknown): SessionAddress | null {
  if (!exactDataRecord(value, ['botId', 'scope'])) return null
  const botId = ownData(value, 'botId')?.value
  const scopeValue = ownData(value, 'scope')?.value
  if (!identifier(botId) || scopeValue === null || typeof scopeValue !== 'object') return null
  let scope: SessionAddress['scope']
  if (exactDataRecord(scopeValue, ['kind', 'userId']) &&
    ownData(scopeValue, 'kind')?.value === 'private' && identifier(ownData(scopeValue, 'userId')?.value)) {
    scope = Object.freeze({ kind: 'private', userId: ownData(scopeValue, 'userId')?.value as string })
  } else if (exactDataRecord(scopeValue, ['kind', 'groupId']) &&
    ownData(scopeValue, 'kind')?.value === 'group' && identifier(ownData(scopeValue, 'groupId')?.value)) {
    scope = Object.freeze({ kind: 'group', groupId: ownData(scopeValue, 'groupId')?.value as string })
  } else if (exactDataRecord(scopeValue, ['kind', 'groupId', 'userId']) &&
    ownData(scopeValue, 'kind')?.value === 'group_user' &&
    identifier(ownData(scopeValue, 'groupId')?.value) && identifier(ownData(scopeValue, 'userId')?.value)) {
    scope = Object.freeze({ kind: 'group', groupId: ownData(scopeValue, 'groupId')?.value as string })
  } else {
    return null
  }
  const target = Object.freeze({ botId, scope })
  try {
    const roundTrip = parseCanonicalSessionKey(canonicalSessionKey(target))
    return roundTrip === null ? null : target
  } catch {
    return null
  }
}

function validResource (value: unknown): value is ToolResource {
  if (value === null || typeof value !== 'object') return false
  const kind = ownData(value, 'kind')?.value
  const common = ['kind', kind === 'buffer' ? 'data' : kind === 'remote_url' ? 'url' : 'path', 'mimeType', 'byteLength']
  if (!exactDataRecord(value, common)) return false
  const mimeType = ownData(value, 'mimeType')?.value
  const byteLength = ownData(value, 'byteLength')?.value
  if (typeof mimeType !== 'string' || mimeType.length > 256 ||
    typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 8 * 1024 * 1024) return false
  if (kind === 'buffer') {
    const data = ownData(value, 'data')?.value
    return data instanceof Uint8Array && data.byteLength === byteLength
  }
  if (kind === 'remote_url') {
    const url = ownData(value, 'url')?.value
    return typeof url === 'string' && url.length > 0 && url.length <= 4096
  }
  if (kind === 'local_path') {
    const path = ownData(value, 'path')?.value
    return typeof path === 'string' && path.length > 0 && path.length <= 4096
  }
  return false
}

function validTextAtom (value: unknown): value is SafeTextAtom {
  if (value === null || typeof value !== 'object') return false
  const kind = ownData(value, 'kind')?.value
  if ((kind === 'text' || kind === 'markdown') && exactDataRecord(value, ['kind', kind])) {
    return typeof ownData(value, kind)?.value === 'string'
  }
  if (kind === 'face' && exactDataRecord(value, ['kind', 'faceId'])) {
    const faceId = ownData(value, 'faceId')?.value
    return typeof faceId === 'number' && Number.isSafeInteger(faceId) && faceId >= 0
  }
  if (kind !== 'at' || !exactDataRecord(value, ['kind', 'target'])) return false
  const target = ownData(value, 'target')?.value
  return target === 'all' || (
    exactDataRecord(target, ['userId']) && identifier(ownData(target, 'userId')?.value)
  )
}

function validButtons (value: unknown): value is TrustedButtonRequest {
  if (!exactDataRecord(value, ['schemaVersion', 'kind', 'suggestions'])) return false
  const suggestions = ownData(value, 'suggestions')?.value
  return ownData(value, 'schemaVersion')?.value === 1 &&
    ownData(value, 'kind')?.value === 'chat_suggestions' && Array.isArray(suggestions) &&
    suggestions.every(item => typeof item === 'string')
}

function partMedia (value: unknown): OutboundMedia {
  const media = value !== null && typeof value === 'object' ? ownData(value, 'media')?.value : undefined
  return media === 'text' || media === 'picture' || media === 'voice' || media === 'forward' ||
    media === 'video' || media === 'music' || media === 'dice' || media === 'rps'
    ? media
    : 'text'
}

function validPartRecord (value: unknown): value is OutboundPart {
  if (value === null || typeof value !== 'object') return false
  const media = ownData(value, 'media')?.value
  if (media === 'text') {
    const hasButtons = Object.hasOwn(value, 'buttons')
    if (!exactDataRecord(value, hasButtons ? ['media', 'atoms', 'buttons'] : ['media', 'atoms'])) return false
    const atoms = ownData(value, 'atoms')?.value
    return Array.isArray(atoms) && atoms.length > 0 && atoms.every(validTextAtom) &&
      (!hasButtons || validButtons(ownData(value, 'buttons')?.value))
  }
  if (media === 'picture' || media === 'voice' || media === 'video') {
    return exactDataRecord(value, ['media', 'resource']) && validResource(ownData(value, 'resource')?.value)
  }
  if (media === 'forward') {
    if (!exactDataRecord(value, ['media', 'title', 'nodes']) || typeof ownData(value, 'title')?.value !== 'string') return false
    const nodes = ownData(value, 'nodes')?.value
    return Array.isArray(nodes) && nodes.every(node => exactDataRecord(node, ['kind', 'text']) &&
      ownData(node, 'kind')?.value === 'text' && typeof ownData(node, 'text')?.value === 'string')
  }
  if (media === 'music') {
    return exactDataRecord(value, ['media', 'provider', 'id']) && ownData(value, 'provider')?.value === '163' &&
      typeof ownData(value, 'id')?.value === 'string'
  }
  if (media === 'dice') return exactDataRecord(value, ['media'])
  if (media === 'rps') {
    const number = ownData(value, 'value')?.value
    return exactDataRecord(value, ['media', 'value']) && (number === 1 || number === 2 || number === 3)
  }
  return false
}

function validPart (value: unknown): value is OutboundPart {
  try {
    return validPartRecord(value)
  } catch {
    return false
  }
}

function validMessageId (value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function normalizedHostMessageId (
  value: unknown
): { readonly messageId: string; readonly hostMessageId: string | number } | null {
  if (validMessageId(value)) return { messageId: value, hostMessageId: value }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) {
    return { messageId: String(value), hostMessageId: value }
  }
  return null
}

function confirmedMessageId (value: unknown): {
  readonly confirmed: boolean
  readonly messageId?: string
  readonly hostMessageId?: string | number
} {
  if (value === true) return { confirmed: true }
  const direct = normalizedHostMessageId(value)
  if (direct !== null) return { confirmed: true, ...direct }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { confirmed: false }
  let snakeOwn: boolean
  let camelOwn: boolean
  try {
    snakeOwn = Object.hasOwn(value, 'message_id')
    camelOwn = Object.hasOwn(value, 'messageId')
  } catch {
    return { confirmed: false }
  }
  const snake = snakeOwn ? ownData(value, 'message_id') : null
  const camel = camelOwn ? ownData(value, 'messageId') : null
  if ((snakeOwn && snake === null) || (camelOwn && camel === null)) return { confirmed: false }
  if (!snakeOwn && !camelOwn) return { confirmed: false }
  if (snake !== null && camel !== null && snake.value !== camel.value) return { confirmed: false }
  const id = snake?.value ?? camel?.value
  const normalized = normalizedHostMessageId(id)
  return normalized === null ? { confirmed: false } : { confirmed: true, ...normalized }
}

function raceHost (
  invoke: () => Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<RaceResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: RaceResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish({ kind: 'abort' })
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    try {
      void invoke().then(
        value => finish({ kind: 'fulfilled', value }),
        () => finish({ kind: 'exception' })
      )
    } catch {
      finish({ kind: 'exception' })
    }
  })
}

function unknownDelivery<M extends OutboundMedia> (
  media: M,
  attempt: 1 | 2,
  race: Exclude<RaceResult['kind'], 'fulfilled'> | 'unknown'
): DeliveryResult<M> {
  const code = race === 'abort'
    ? 'host_abort_after_dispatch'
    : race === 'timeout'
      ? 'host_timeout_after_dispatch'
      : race === 'exception'
        ? 'host_exception_after_dispatch'
        : 'unknown_host_result'
  return Object.freeze({ kind: 'outcome_unknown', media, attempt, code })
}

function createPort (target: SessionAddress, hostTarget: YunzaiHostTargetPort | null): YunzaiOutboundPort {
  const receipts = new WeakSet<object>()
  const receiptIds = new WeakMap<object, string | number | undefined>()
  const port: YunzaiOutboundPort = {
    target,
    async deliver<P extends OutboundPart> (
      part: P,
      attempt: 1 | 2,
      options: OutboundDeliveryOptions = {}
    ): Promise<DeliveryResult<P['media']>> {
      const media = partMedia(part) as P['media']
      if (hostTarget === null) {
        return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'invalid_target' })
      }
      if (!validPart(part)) {
        return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'invalid_part' })
      }
      if (options.signal?.aborted === true) {
        return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'aborted_before_dispatch' })
      }
      const race = await raceHost(
        async () => await hostTarget.dispatch(part, options.quoteMessageId, options.signal),
        OUTBOUND_DELIVERY_TIMEOUT_MS,
        options.signal
      )
      if (race.kind !== 'fulfilled') return unknownDelivery(media, attempt, race.kind)
      if (race.value === false) {
        return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'host_rejected' })
      }
      const confirmation = confirmedMessageId(race.value)
      if (!confirmation.confirmed) return unknownDelivery(media, attempt, 'unknown')
      const receipt = Object.freeze({
        [runtimeDeliveryReceiptBrand]: true as const,
        schemaVersion: 1 as const,
        media,
        ...(confirmation.messageId === undefined ? {} : { messageId: confirmation.messageId })
      }) as unknown as RuntimeDeliveryReceipt<P['media']>
      receipts.add(receipt)
      receiptIds.set(receipt, confirmation.hostMessageId)
      return Object.freeze({ kind: 'sent', media, attempt, receipt })
    },
    async recall (receipt: RuntimeDeliveryReceipt, signal?: AbortSignal): Promise<RecallResult> {
      if (receipt === null || typeof receipt !== 'object' || !receipts.has(receipt) ||
        ownData(receipt, runtimeDeliveryReceiptBrand)?.value !== true) {
        return Object.freeze({ kind: 'failed_definite', code: 'receipt_not_owned' })
      }
      const messageId = receiptIds.get(receipt)
      if (messageId === undefined) {
        return Object.freeze({ kind: 'failed_definite', code: 'message_id_unavailable' })
      }
      if (signal?.aborted === true) {
        return Object.freeze({ kind: 'failed_definite', code: 'aborted_before_dispatch' })
      }
      if (hostTarget === null) return Object.freeze({ kind: 'failed_definite', code: 'host_rejected' })
      const race = await raceHost(
        async () => await hostTarget.recall(messageId, signal),
        OUTBOUND_RECALL_TIMEOUT_MS,
        signal
      )
      if (race.kind !== 'fulfilled') {
        const code = race.kind === 'abort'
          ? 'host_abort_after_dispatch'
          : race.kind === 'timeout'
            ? 'host_timeout_after_dispatch'
            : 'host_exception_after_dispatch'
        return Object.freeze({ kind: 'outcome_unknown', code })
      }
      if (race.value === true) return Object.freeze({ kind: 'recalled' })
      if (race.value === false) return Object.freeze({ kind: 'failed_definite', code: 'host_rejected' })
      return Object.freeze({ kind: 'outcome_unknown', code: 'unknown_host_result' })
    }
  }
  return Object.freeze(port)
}

export function createYunzaiOutboundPortFactory (
  host: YunzaiOutboundHostPort
): YunzaiOutboundPortFactory {
  return Object.freeze({
    async forTarget (target: SessionAddress): Promise<YunzaiOutboundPort> {
      const canonical = canonicalTarget(target)
      if (canonical === null) return createPort(invalidTarget, null)
      let hostTarget: YunzaiHostTargetPort | null = null
      try {
        hostTarget = await host.forTarget(canonical)
        if (hostTarget === null || typeof hostTarget.dispatch !== 'function' || typeof hostTarget.recall !== 'function') {
          hostTarget = null
        }
      } catch {
        hostTarget = null
      }
      return createPort(canonical, hostTarget)
    }
  })
}

export async function deliverWithDefiniteRetry<P extends OutboundPart> (
  port: YunzaiOutboundPort,
  part: P,
  options?: OutboundDeliveryOptions
): Promise<readonly DeliveryResult<P['media']>[]> {
  const first = await port.deliver(part, 1, options)
  if (first.kind !== 'failed_definite' || first.code !== 'host_rejected') {
    return Object.freeze([first])
  }
  const second = await port.deliver(part, 2, options)
  return Object.freeze([first, second])
}
