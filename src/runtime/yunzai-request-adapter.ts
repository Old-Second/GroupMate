import {
  parseAgentMessage,
  type AgentContentPart,
  type AgentMessage
} from '../agent/contracts/content.js'
import type {
  ActorIdentity,
  ChannelIdentity,
  SessionAddress
} from '../agent/contracts/identity.js'
import {
  parsePresentationRoute,
  type PresentationIntentV1,
  type PresentationRouteV1,
  type TrustedRequestKind
} from '../agent/contracts/interaction.js'
import type { ContextBudget } from '../agent/context/context-budget.js'
import type { RunModelConfig } from '../agent/run/run-checkpoint.js'
import { RUN_REF_PATTERN } from '../agent/run/run-reference.js'
import {
  type MessageEventLike,
  type PreparedYunzaiMessageEvidenceV1
} from './message-input.js'

export interface YunzaiRequestEvent extends MessageEventLike {
  readonly group_id?: unknown
  readonly user_id?: unknown
  readonly self_id?: unknown
  readonly bot?: MessageEventLike['bot'] & { readonly uin?: unknown }
  readonly sender?: {
    readonly user_id?: unknown
    readonly nickname?: unknown
    readonly card?: unknown
    readonly role?: unknown
  }
}

export interface AdaptYunzaiRequestInput {
  readonly event: YunzaiRequestEvent
  readonly messageEvidence: PreparedYunzaiMessageEvidenceV1
  readonly presentationRoute: PresentationRouteV1
  readonly requestId: string
  readonly requestRef: string
  readonly createdAt: string
  readonly deadlineAt: string
  readonly systemInstructions: readonly string[]
  readonly model: RunModelConfig
  readonly contextBudget: ContextBudget
  readonly sessionTtlSeconds?: number
}

export interface YunzaiPreparedPresentationRequest {
  readonly route: PresentationRouteV1
  readonly evidence: PreparedYunzaiMessageEvidenceV1
}

export interface YunzaiAgentRequestDraft {
  readonly requestId: string
  readonly requestRef: string
  readonly requestKind: TrustedRequestKind
  readonly presentationRoute: PresentationRouteV1
  readonly createdAt: string
  readonly deadlineAt: string
  readonly sessionAddress: SessionAddress
  readonly actor: ActorIdentity
  readonly channel: ChannelIdentity
  readonly message: AgentMessage
  readonly references: Readonly<{
    readonly currentMessageId: string
    readonly quotedMessageId: string | null
  }>
  readonly systemInstructions: readonly string[]
  readonly model: RunModelConfig
  readonly contextBudget: ContextBudget
  readonly sessionTtlSeconds?: number
}

export interface YunzaiAgentRequest extends YunzaiAgentRequestDraft {
  readonly schemaVersion: 2
  readonly runRef: string
}

function identifier (value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
    String(value).length === 0 || String(value).length > 128) {
    throw new TypeError(`${label} is missing or invalid`)
  }
  return String(value)
}

function timestamp (value: string, label: string): string {
  try {
    if (new Date(value).toISOString() !== value) throw new TypeError()
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function actorRole (value: unknown): ActorIdentity['role'] {
  return value === 'owner' || value === 'admin' ? value : 'member'
}

function publicImageReference (value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function frozenModel (input: RunModelConfig): RunModelConfig {
  if (typeof input.model !== 'string' || input.model.length === 0 ||
    typeof input.streaming !== 'boolean' || !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens <= 0 || typeof input.reasoning?.enabled !== 'boolean') {
    throw new TypeError('Yunzai request model configuration is invalid')
  }
  return Object.freeze({
    model: input.model,
    streaming: input.streaming,
    maxOutputTokens: input.maxOutputTokens,
    reasoning: Object.freeze({
      enabled: input.reasoning.enabled,
      ...(input.reasoning.effort === undefined ? {} : { effort: input.reasoning.effort })
    }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.topP === undefined ? {} : { topP: input.topP })
  })
}

function frozenBudget (input: ContextBudget): ContextBudget {
  return Object.freeze({
    modelContextTokens: input.modelContextTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    reservedToolTokens: input.reservedToolTokens,
    safetyMarginTokens: input.safetyMarginTokens,
    maxItems: input.maxItems,
    maxBytes: input.maxBytes
  })
}

function frozenPresentationRoute (input: {
  readonly requestKind: TrustedRequestKind
  readonly intent: PresentationIntentV1
  readonly sessionAddress: SessionAddress
  readonly actorId: string
  readonly requestMessageId: string | null
}): PresentationRouteV1 {
  const { requestKind, intent, sessionAddress, actorId, requestMessageId } = input
  const profile = requestKind === 'ordinary_chat' ? 'ordinary' : 'proactive'
  parsePresentationRoute({
    schemaVersion: 1,
    requestKind,
    profile,
    presentationIntent: intent,
    sessionAddress,
    actorId,
    ...(requestMessageId === null ? {} : { requestMessageId })
  })
  const presentationIntent: PresentationIntentV1 = intent.kind === 'ordinary'
    ? Object.freeze({
        schemaVersion: intent.schemaVersion,
        kind: intent.kind,
        forcePicture: intent.forcePicture
      })
    : Object.freeze({
        schemaVersion: intent.schemaVersion,
        kind: intent.kind,
        recallAfterMs: intent.recallAfterMs
      })
  const raw = Object.freeze({
    schemaVersion: 1 as const,
    requestKind,
    profile,
    presentationIntent,
    sessionAddress,
    actorId,
    ...(requestMessageId === null ? {} : { requestMessageId })
  })
  return parsePresentationRoute(raw)
}

function eventSessionAddress (input: {
  readonly event: YunzaiRequestEvent
  readonly botId: string
  readonly actorId: string
  readonly groupMerge: boolean
}): SessionAddress {
  if (input.event.isGroup !== true) {
    return Object.freeze({
      botId: input.botId,
      scope: Object.freeze({ kind: 'private' as const, userId: input.actorId })
    })
  }
  const groupId = identifier(input.event.group_id, 'group identity')
  return Object.freeze({
    botId: input.botId,
    scope: input.groupMerge
      ? Object.freeze({ kind: 'group' as const, groupId })
      : Object.freeze({
          kind: 'group_user' as const,
          groupId,
          userId: input.actorId
        })
  })
}

function assertPreparedEvidence (
  evidence: PreparedYunzaiMessageEvidenceV1
): PreparedYunzaiMessageEvidenceV1 {
  const required = [
    'schemaVersion', 'prompt', 'imageUrls', 'currentMessageId', 'quotedMessageId',
    'hasReply', 'replyResolved', 'currentSegmentCount', 'replySegmentCount', 'ocrTexts'
  ]
  const allowed = new Set([...required, 'quotedMessage'])
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence) ||
    Reflect.ownKeys(evidence).some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => !Object.hasOwn(evidence, key))) {
    throw new TypeError('prepared message evidence is invalid')
  }
  if (evidence.schemaVersion !== 1 || typeof evidence.prompt !== 'string' ||
    !Array.isArray(evidence.imageUrls) ||
    evidence.imageUrls.some(value => typeof value !== 'string') ||
    (evidence.currentMessageId !== null && typeof evidence.currentMessageId !== 'string') ||
    (evidence.quotedMessageId !== null && typeof evidence.quotedMessageId !== 'string') ||
    typeof evidence.hasReply !== 'boolean' || typeof evidence.replyResolved !== 'boolean' ||
    !Number.isSafeInteger(evidence.currentSegmentCount) || evidence.currentSegmentCount < 0 ||
    !Number.isSafeInteger(evidence.replySegmentCount) || evidence.replySegmentCount < 0 ||
    !Array.isArray(evidence.ocrTexts) || evidence.ocrTexts.length > 8 ||
    evidence.ocrTexts.some(value => typeof value !== 'string' ||
      value !== value.normalize('NFC').trim() || Array.from(value).length > 2_000)) {
    throw new TypeError('prepared message evidence is invalid')
  }
  if (!Object.isFrozen(evidence) || !Object.isFrozen(evidence.imageUrls) ||
    !Object.isFrozen(evidence.ocrTexts)) {
    throw new TypeError('prepared message evidence must be frozen')
  }
  if (evidence.quotedMessage !== undefined && (
    !Object.isFrozen(evidence.quotedMessage) ||
    !Object.isFrozen(evidence.quotedMessage.sender) ||
    !Object.isFrozen(evidence.quotedMessage.parts) ||
    evidence.quotedMessage.parts.some(part => !Object.isFrozen(part))
  )) {
    throw new TypeError('prepared quoted message evidence must be frozen')
  }
  return evidence
}

function assertRouteMatchesEvent (
  route: PresentationRouteV1,
  event: YunzaiRequestEvent,
  evidence: PreparedYunzaiMessageEvidenceV1
): void {
  const rawBotId = event.self_id ?? event.bot?.uin
  const botId = rawBotId === undefined || rawBotId === null || String(rawBotId) === ''
    ? route.sessionAddress.botId
    : identifier(rawBotId, 'bot identity')
  const actorId = identifier(
    event.sender?.user_id ?? event.user_id,
    'actor identity'
  )
  if (route.sessionAddress.botId !== botId || route.actorId !== actorId) {
    throw new TypeError('presentation route identity does not match event')
  }
  if (event.isGroup === true) {
    const groupId = identifier(event.group_id, 'group identity')
    const scope = route.sessionAddress.scope
    const matchesGroup = scope.kind === 'group' && scope.groupId === groupId
    const matchesActorGroup = scope.kind === 'group_user' &&
      scope.groupId === groupId && scope.userId === actorId
    if (!matchesGroup && !matchesActorGroup) {
      throw new TypeError('presentation route session does not match event')
    }
  } else {
    const scope = route.sessionAddress.scope
    if (scope.kind !== 'private' || scope.userId !== actorId) {
      throw new TypeError('presentation route session does not match event')
    }
  }
  const hasRequestMessageId = Object.hasOwn(route, 'requestMessageId')
  if (hasRequestMessageId !== (evidence.currentMessageId !== null) ||
    (hasRequestMessageId && route.requestMessageId !== evidence.currentMessageId)) {
    throw new TypeError('presentation route message does not match evidence')
  }
}

function assertFrozenPresentationRoute (route: PresentationRouteV1): void {
  if (!Object.isFrozen(route) || !Object.isFrozen(route.presentationIntent) ||
    !Object.isFrozen(route.sessionAddress) || !Object.isFrozen(route.sessionAddress.scope)) {
    throw new TypeError('prepared presentation route must be frozen')
  }
}

export function prepareYunzaiPresentationRequest (input: {
  readonly event: YunzaiRequestEvent
  readonly evidence: PreparedYunzaiMessageEvidenceV1
  readonly requestKind: TrustedRequestKind
  readonly presentationIntent: PresentationIntentV1
  readonly getBotId: (event: YunzaiRequestEvent) => string
  readonly groupMerge?: boolean
}): YunzaiPreparedPresentationRequest {
  const evidence = assertPreparedEvidence(input.evidence)
  const botId = identifier(input.getBotId(input.event), 'bot identity')
  const actorId = identifier(
    input.event.sender?.user_id ?? input.event.user_id,
    'actor identity'
  )
  const sessionAddress = eventSessionAddress({
    event: input.event,
    botId,
    actorId,
    groupMerge: input.groupMerge === true
  })
  const route = frozenPresentationRoute({
    requestKind: input.requestKind,
    intent: input.presentationIntent,
    sessionAddress,
    actorId,
    requestMessageId: evidence.currentMessageId
  })
  return Object.freeze({ route, evidence })
}

export async function adaptYunzaiRequest (
  input: AdaptYunzaiRequestInput
): Promise<YunzaiAgentRequestDraft> {
  const createdAt = timestamp(input.createdAt, 'request creation timestamp')
  const deadlineAt = timestamp(input.deadlineAt, 'request deadline')
  if (new Date(deadlineAt).getTime() <= new Date(createdAt).getTime()) {
    throw new TypeError('request deadline is invalid')
  }
  const requestId = identifier(input.requestId, 'request ID')
  if (typeof input.requestRef !== 'string' || !RUN_REF_PATTERN.test(input.requestRef)) {
    throw new TypeError('request reference is invalid')
  }
  const messageInput = assertPreparedEvidence(input.messageEvidence)
  const presentationRoute = parsePresentationRoute(input.presentationRoute)
  assertFrozenPresentationRoute(presentationRoute)
  assertRouteMatchesEvent(presentationRoute, input.event, messageInput)
  const botId = presentationRoute.sessionAddress.botId
  const actorId = identifier(
    input.event.sender?.user_id ?? input.event.user_id,
    'actor identity'
  )
  const isGroup = input.event.isGroup === true
  const groupId = isGroup ? identifier(input.event.group_id, 'group identity') : undefined
  const sessionAddress = presentationRoute.sessionAddress
  const channel: ChannelIdentity = isGroup
    ? Object.freeze({ kind: 'group', botId, groupId: groupId as string })
    : Object.freeze({ kind: 'private', botId, userId: actorId })
  const displayName = input.event.sender?.card ?? input.event.sender?.nickname
  const actor: ActorIdentity = Object.freeze({
    userId: actorId,
    ...(typeof displayName === 'string' && displayName.length > 0
      ? { displayName: displayName.slice(0, 256) }
      : {}),
    role: actorRole(input.event.sender?.role)
  })
  const messageId = messageInput.currentMessageId ?? requestId
  const parts: AgentContentPart[] = [Object.freeze({
    type: 'text',
    text: messageInput.prompt.length === 0 ? '[空消息]' : messageInput.prompt
  })]
  for (const resourceId of messageInput.imageUrls.filter(publicImageReference)) {
    parts.push(Object.freeze({
      type: 'resource_ref', resourceType: 'image', resourceId
    }))
  }
  const message = parseAgentMessage(Object.freeze({
    id: messageId,
    role: 'user',
    parts: Object.freeze(parts),
    createdAt,
    provenance: Object.freeze({
      source: 'qq_message',
      trust: 'untrusted',
      sensitivity: isGroup ? 'group' : 'private',
      sourceId: messageId,
      createdAt
    }),
    ...(messageInput.quotedMessage === undefined
      ? {}
      : { replyTo: messageInput.quotedMessage })
  }))
  if (!Array.isArray(input.systemInstructions) || input.systemInstructions.length === 0 ||
    input.systemInstructions.length > 16 || input.systemInstructions.some(value => (
      typeof value !== 'string' || value.length === 0 || value.length > 16_384
    ))) {
    throw new TypeError('system instructions are invalid')
  }
  if (input.sessionTtlSeconds !== undefined && (!Number.isSafeInteger(input.sessionTtlSeconds) ||
    input.sessionTtlSeconds <= 0)) {
    throw new TypeError('session TTL is invalid')
  }
  return Object.freeze({
    requestId,
    requestRef: input.requestRef,
    requestKind: presentationRoute.requestKind,
    presentationRoute,
    createdAt,
    deadlineAt,
    sessionAddress,
    actor,
    channel,
    message,
    references: Object.freeze({
      currentMessageId: messageId,
      quotedMessageId: messageInput.quotedMessageId
    }),
    systemInstructions: Object.freeze([...input.systemInstructions]),
    model: frozenModel(input.model),
    contextBudget: frozenBudget(input.contextBudget),
    ...(input.sessionTtlSeconds === undefined
      ? {}
      : { sessionTtlSeconds: input.sessionTtlSeconds })
  })
}
