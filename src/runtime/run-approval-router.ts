import { createHash } from 'node:crypto'
import type { SessionAddress } from '../agent/contracts/identity.js'
import {
  isApprovalActorEligible,
  parseApprovalInterruption,
  parseApprovalReplyText,
  type ApprovalActorReference,
  type ApprovalInterruption
} from '../agent/run/interruption.js'
import type { RunRuntimeBinding } from '../agent/run/run-engine.js'
import {
  createApprovalRunIndex,
  deleteApprovalRunIndex,
  RUN_STORE_NAMESPACE,
  type RedisRunClient
} from '../agent/run/redis-run-store.js'
import { canonicalSessionKey } from '../agent/session/conversation-scope.js'
import {
  buildModelMessageInput,
  type MessageEventLike
} from './message-input.js'
import type {
  ActivePresentationContext,
  ChatReplyEnvelope
} from './agent-service.js'
import type { ApprovalRecoveryDeferred } from './request-observation.js'

export const APPROVAL_RECOVERY_DEFERRED_MESSAGE =
  '任务繁忙，审批未消费，可稍后重试'

export interface ApprovalReference {
  readonly schemaVersion: 1
  readonly approvalAddress: SessionAddress
  readonly messageId: string
  readonly runId: string
  readonly approvalId: string
}

export interface ApprovalReferenceIndex {
  create(reference: ApprovalReference, ttlSeconds: number): Promise<boolean>
  load(address: SessionAddress, messageId: string): Promise<ApprovalReference | null>
  delete(reference: ApprovalReference): Promise<void>
}

export interface ApprovalDisplayInput {
  readonly runId: string
  readonly approvalId: string
  readonly messageId: string
  readonly displayedAt: string
  readonly ttlSeconds: number
}

export interface ApprovalDecisionInput {
  readonly runId: string
  readonly approvalId: string
  readonly kind: 'approved' | 'rejected' | 'expired'
  readonly decidedAt: string
  readonly sessionAddress: SessionAddress
  readonly actor?: ApprovalActorReference
}

export interface ApprovalReplyProjection {
  readonly text: string
  readonly quotedMessageId: string | null
  readonly sessionAddress: SessionAddress
  readonly actor: ApprovalActorReference
  readonly occurredAt: string
}

export interface RunApprovalControl {
  pendingApproval(runId: string, approvalId: string): Promise<ApprovalInterruption | null>
  displayApproval(input: ApprovalDisplayInput): Promise<ApprovalInterruption | null>
  presentationContext(runId: string): Promise<ActivePresentationContext | null>
  decideApproval(
    input: ApprovalDecisionInput,
    runtime?: RunRuntimeBinding
  ): Promise<ChatReplyEnvelope | ApprovalRecoveryDeferred | null>
}

export interface RunApprovalRouterOptions {
  readonly control: RunApprovalControl
  readonly index: ApprovalReferenceIndex
  readonly runtimeFor?: (runId: string) => Promise<RunRuntimeBinding | undefined>
}

export interface YunzaiApprovalReplyEvent extends MessageEventLike {
  readonly msg?: unknown
  readonly time?: unknown
  readonly isGroup?: unknown
  readonly group_id?: unknown
  readonly user_id?: unknown
  readonly self_id?: unknown
  readonly sender?: {
    readonly user_id?: unknown
    readonly role?: unknown
  }
}

export interface ProjectYunzaiApprovalReplyOptions {
  readonly botId: string | number
  readonly masterIds: readonly (string | number)[]
  readonly now?: () => Date
}

export type ApprovalRouteOutcome = ChatReplyEnvelope | ApprovalRecoveryDeferred

export type ApprovalRouteResultHandler = (
  result: ApprovalRouteOutcome,
  reference: ApprovalReference,
  context: ActivePresentationContext
) => void | Promise<void>

export type { ActivePresentationContext } from './agent-service.js'

interface PersistedApprovalReference {
  readonly schemaVersion: 1
  readonly runId: string
  readonly approvalId: string
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INDEX_GRACE_SECONDS = 300

function boundedIdentifier (value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function boundedStableReference (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function timestamp (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64 ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

export function redisApprovalReferenceKey (
  address: SessionAddress,
  messageId: string
): string {
  const hash = createHash('sha256')
    .update(canonicalSessionKey(address))
    .update('\0')
    .update(boundedStableReference(messageId, 'approval message ID'))
    .digest('hex')
  return `${RUN_STORE_NAMESPACE}approval-index:${hash}`
}

function persistedReference (reference: ApprovalReference): PersistedApprovalReference {
  return Object.freeze({
    schemaVersion: 1,
    runId: boundedIdentifier(reference.runId, 'approval run ID'),
    approvalId: boundedIdentifier(reference.approvalId, 'approval ID')
  })
}

function encodeReference (reference: ApprovalReference): string {
  return JSON.stringify(persistedReference(reference))
}

function decodeReference (
  raw: string,
  approvalAddress: SessionAddress,
  messageId: string
): ApprovalReference {
  if (Buffer.byteLength(raw, 'utf8') > 1_024) {
    throw new TypeError('approval reference byte limit exceeded')
  }
  const value = JSON.parse(raw) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('approval reference is invalid')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !['schemaVersion', 'runId', 'approvalId']
    .every(key => Object.hasOwn(record, key)) || record.schemaVersion !== 1) {
    throw new TypeError('approval reference is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    approvalAddress,
    messageId: boundedStableReference(messageId, 'approval message ID'),
    runId: boundedIdentifier(record.runId, 'approval run ID'),
    approvalId: boundedIdentifier(record.approvalId, 'approval ID')
  })
}

function sameAddress (left: SessionAddress, right: SessionAddress): boolean {
  try {
    return canonicalSessionKey(left) === canonicalSessionKey(right)
  } catch {
    return false
  }
}

function yunzaiIdentifier (value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
    String(value).length === 0 || String(value).length > 128) {
    throw new TypeError(`${label} is invalid`)
  }
  return String(value)
}

function yunzaiActorRole (
  actorId: string,
  senderRole: unknown,
  masterIds: readonly (string | number)[]
): ApprovalActorReference['role'] {
  if (masterIds.some(value => String(value) === actorId)) return 'bot_master'
  if (senderRole === 'owner') return 'group_owner'
  if (senderRole === 'admin') return 'group_admin'
  return 'member'
}

function yunzaiOccurredAt (now: () => Date): string {
  return now().toISOString()
}

export async function projectYunzaiApprovalReply (
  event: YunzaiApprovalReplyEvent,
  options: ProjectYunzaiApprovalReplyOptions
): Promise<ApprovalReplyProjection | null> {
  const text = typeof event.msg === 'string' ? event.msg.normalize('NFC').trim() : ''
  if (parseApprovalReplyText(text) === null) return null
  const input = await buildModelMessageInput({ event, currentPrompt: text })
  if (input.quotedMessageId === null) return null
  const botId = yunzaiIdentifier(options.botId, 'approval bot ID')
  const actorId = yunzaiIdentifier(
    event.sender?.user_id ?? event.user_id,
    'approval actor ID'
  )
  const sessionAddress: SessionAddress = event.isGroup === true
    ? Object.freeze({
        botId,
        scope: Object.freeze({
          kind: 'group' as const,
          groupId: yunzaiIdentifier(event.group_id, 'approval group ID')
        })
      })
    : Object.freeze({
        botId,
        scope: Object.freeze({ kind: 'private' as const, userId: actorId })
      })
  return Object.freeze({
    text,
    quotedMessageId: input.quotedMessageId,
    sessionAddress,
    actor: Object.freeze({
      userId: actorId,
      role: yunzaiActorRole(actorId, event.sender?.role, options.masterIds)
    }),
    occurredAt: yunzaiOccurredAt(options.now ?? (() => new Date()))
  })
}

export class RedisApprovalReferenceIndex implements ApprovalReferenceIndex {
  readonly #client: RedisRunClient

  constructor (client: RedisRunClient) {
    this.#client = client
  }

  async create (reference: ApprovalReference, ttlSeconds: number): Promise<boolean> {
    return await createApprovalRunIndex(
      this.#client,
      redisApprovalReferenceKey(reference.approvalAddress, reference.messageId),
      encodeReference(reference),
      ttlSeconds
    )
  }

  async load (
    address: SessionAddress,
    messageId: string
  ): Promise<ApprovalReference | null> {
    const raw = await this.#client.get(redisApprovalReferenceKey(address, messageId))
    return raw === null ? null : decodeReference(raw, address, messageId)
  }

  async delete (reference: ApprovalReference): Promise<void> {
    await deleteApprovalRunIndex(
      this.#client,
      redisApprovalReferenceKey(reference.approvalAddress, reference.messageId),
      encodeReference(reference)
    )
  }
}

export class RunApprovalRouter {
  readonly #control: RunApprovalControl
  readonly #index: ApprovalReferenceIndex
  readonly #runtimeFor?: RunApprovalRouterOptions['runtimeFor']

  constructor (options: RunApprovalRouterOptions) {
    this.#control = options.control
    this.#index = options.index
    this.#runtimeFor = options.runtimeFor
  }

  async registerDisplayed (input: ApprovalDisplayInput): Promise<ApprovalInterruption | null> {
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 ||
      input.ttlSeconds > 300) {
      throw new TypeError('approval TTL is invalid')
    }
    const pending = await this.#control.pendingApproval(input.runId, input.approvalId)
    if (pending === null || pending.approvalMessageId !== undefined) return null
    const reference: ApprovalReference = Object.freeze({
      schemaVersion: 1,
      approvalAddress: pending.approvalAddress,
      messageId: boundedStableReference(input.messageId, 'approval message ID'),
      runId: pending.runId,
      approvalId: pending.approvalId
    })
    if (!await this.#index.create(reference, input.ttlSeconds + INDEX_GRACE_SECONDS)) {
      return null
    }
    try {
      const displayed = await this.#control.displayApproval(input)
      if (displayed === null) await this.#index.delete(reference)
      return displayed
    } catch (error) {
      await this.#index.delete(reference).catch(() => undefined)
      throw error
    }
  }

  async route (
    reply: ApprovalReplyProjection,
    onResult?: ApprovalRouteResultHandler
  ): Promise<boolean> {
    const kind = parseApprovalReplyText(reply.text)
    if (kind === null || reply.quotedMessageId === null) return false
    let occurredAt: string
    try {
      occurredAt = timestamp(reply.occurredAt, 'approval reply timestamp')
    } catch {
      return false
    }
    const reference = await this.#index.load(reply.sessionAddress, reply.quotedMessageId)
    if (reference === null) return false
    const context = await this.#control.presentationContext(reference.runId)
    if (context === null) return false
    const pending = await this.#control.pendingApproval(reference.runId, reference.approvalId)
    if (pending === null || pending.approvalMessageId !== reference.messageId ||
      pending.displayedAt === undefined || pending.expiresAt === undefined ||
      !sameAddress(reply.sessionAddress, pending.approvalAddress)) return false
    const expired = new Date(occurredAt).getTime() >= new Date(pending.expiresAt).getTime()
    if (!expired && !isApprovalActorEligible(pending, reply.actor)) return false
    const runtime = await this.#runtimeFor?.(reference.runId)
    const result = await this.#control.decideApproval({
      runId: reference.runId,
      approvalId: reference.approvalId,
      kind: expired ? 'expired' : kind,
      decidedAt: occurredAt,
      sessionAddress: reply.sessionAddress,
      ...(expired ? {} : { actor: reply.actor })
    }, runtime)
    if (result === null) return false
    if (result.kind === 'approval_deferred') {
      try {
        await onResult?.(result, reference, context)
      } catch {}
      return true
    }
    await this.#index.delete(reference)
    await onResult?.(result, reference, context)
    return true
  }

  async expire (
    address: SessionAddress,
    messageId: string,
    occurredAt: string,
    onResult?: ApprovalRouteResultHandler
  ): Promise<boolean> {
    const reference = await this.#index.load(address, messageId)
    if (reference === null) return false
    const context = await this.#control.presentationContext(reference.runId)
    if (context === null) return false
    const pending = await this.#control.pendingApproval(reference.runId, reference.approvalId)
    if (pending === null || pending.expiresAt === undefined ||
      new Date(timestamp(occurredAt, 'approval expiration timestamp')).getTime() <
        new Date(pending.expiresAt).getTime()) return false
    const runtime = await this.#runtimeFor?.(reference.runId)
    const result = await this.#control.decideApproval({
      runId: reference.runId,
      approvalId: reference.approvalId,
      kind: 'expired',
      decidedAt: occurredAt,
      sessionAddress: pending.approvalAddress
    }, runtime)
    if (result === null) return false
    if (result.kind === 'approval_deferred') {
      try {
        await onResult?.(result, reference, context)
      } catch {}
      return true
    }
    await this.#index.delete(reference)
    await onResult?.(result, reference, context)
    return true
  }
}
