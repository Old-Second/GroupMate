import type { SessionAddress } from './identity.js'
import {
  canonicalSessionKey,
  parseCanonicalSessionKey
} from '../session/conversation-scope.js'

export type TrustedRequestKind = 'ordinary_chat' | 'proactive_chat'
export type CheckpointRequestKind = TrustedRequestKind | 'legacy_unknown'

export type PresentationIntentV1 =
  | {
      readonly schemaVersion: 1
      readonly kind: 'ordinary'
      readonly forcePicture: boolean
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'proactive'
      readonly recallAfterMs: number | null
    }

export type PresentationRouteV1 =
  | {
      readonly schemaVersion: 1
      readonly requestKind: 'ordinary_chat'
      readonly profile: 'ordinary'
      readonly presentationIntent: Extract<
        PresentationIntentV1,
        { readonly kind: 'ordinary' }
      >
      readonly sessionAddress: SessionAddress
      readonly actorId: string
      readonly requestMessageId?: string
    }
  | {
      readonly schemaVersion: 1
      readonly requestKind: 'proactive_chat'
      readonly profile: 'proactive'
      readonly presentationIntent: Extract<
        PresentationIntentV1,
        { readonly kind: 'proactive' }
      >
      readonly sessionAddress: SessionAddress
      readonly actorId: string
      readonly requestMessageId?: string
    }

export interface RecoveredLegacyPresentationRoute {
  readonly schemaVersion: 1
  readonly requestKind: 'legacy_unknown'
  readonly profile: 'recovered_legacy_plain_text'
  readonly sessionAddress: SessionAddress
}

type UnknownRecord = Record<PropertyKey, unknown>

const ROUTE_KEYS = Object.freeze([
  'schemaVersion',
  'requestKind',
  'profile',
  'presentationIntent',
  'sessionAddress',
  'actorId',
  'requestMessageId'
])
const ROUTE_REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'requestKind',
  'profile',
  'presentationIntent',
  'sessionAddress',
  'actorId'
])

function record (value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function exactKeys (
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Reflect.ownKeys(value)
  const unknown = keys.find(key => typeof key !== 'string' || !allowed.includes(key))
  if (unknown !== undefined) {
    throw new TypeError(`${label} contains unknown key: ${String(unknown)}`)
  }
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new TypeError(`${label} key is missing: ${missing}`)
}

function canonicalSessionAddress (value: unknown): SessionAddress {
  const session = record(value, 'session address')
  exactKeys(session, ['botId', 'scope'], ['botId', 'scope'], 'session address')
  if (typeof session.botId !== 'string') {
    throw new TypeError('session address identifier is invalid')
  }
  const scope = record(session.scope, 'conversation scope')
  exactKeys(
    scope,
    ['kind', 'groupId', 'userId'],
    ['kind'],
    'conversation scope'
  )
  if (scope.kind === 'private') {
    exactKeys(scope, ['kind', 'userId'], ['kind', 'userId'], 'conversation scope')
    if (typeof scope.userId !== 'string') {
      throw new TypeError('session address identifier is invalid')
    }
  } else if (scope.kind === 'group') {
    exactKeys(scope, ['kind', 'groupId'], ['kind', 'groupId'], 'conversation scope')
    if (typeof scope.groupId !== 'string') {
      throw new TypeError('session address identifier is invalid')
    }
  } else if (scope.kind === 'group_user') {
    exactKeys(
      scope,
      ['kind', 'groupId', 'userId'],
      ['kind', 'groupId', 'userId'],
      'conversation scope'
    )
    if (typeof scope.groupId !== 'string' || typeof scope.userId !== 'string') {
      throw new TypeError('session address identifier is invalid')
    }
  } else {
    throw new TypeError('conversation scope kind is invalid')
  }

  try {
    const address = value as SessionAddress
    const canonical = canonicalSessionKey(address)
    const parsed = parseCanonicalSessionKey(canonical)
    if (parsed === null || canonicalSessionKey(parsed) !== canonical) {
      throw new TypeError('session address round trip failed')
    }
    return address
  } catch (error) {
    throw new TypeError('session address is invalid', { cause: error })
  }
}

function canonicalActorId (value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('actor ID is invalid')
  const address: SessionAddress = {
    botId: 'actor-validation',
    scope: { kind: 'private', userId: value }
  }
  try {
    const canonical = canonicalSessionKey(address)
    const parsed = parseCanonicalSessionKey(canonical)
    if (parsed?.scope.kind !== 'private' || parsed.scope.userId !== value) {
      throw new TypeError('actor ID round trip failed')
    }
  } catch (error) {
    throw new TypeError('actor ID is invalid', { cause: error })
  }
  return value
}

function requestMessageId (value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 128) {
    throw new TypeError('request message ID is invalid')
  }
  return value
}

function parsePresentationIntent (value: unknown): PresentationIntentV1 {
  const intent = record(value, 'presentation intent')
  exactKeys(
    intent,
    ['schemaVersion', 'kind', 'forcePicture', 'recallAfterMs'],
    ['schemaVersion', 'kind'],
    'presentation intent'
  )
  if (intent.kind === 'ordinary') {
    exactKeys(
      intent,
      ['schemaVersion', 'kind', 'forcePicture'],
      ['schemaVersion', 'kind', 'forcePicture'],
      'presentation intent'
    )
    if (intent.schemaVersion !== 1) {
      throw new TypeError('presentation intent schema version is invalid')
    }
    if (typeof intent.forcePicture !== 'boolean') {
      throw new TypeError('presentation intent force picture is invalid')
    }
    return value as PresentationIntentV1
  }
  if (intent.kind === 'proactive') {
    exactKeys(
      intent,
      ['schemaVersion', 'kind', 'recallAfterMs'],
      ['schemaVersion', 'kind', 'recallAfterMs'],
      'presentation intent'
    )
    if (intent.schemaVersion !== 1) {
      throw new TypeError('presentation intent schema version is invalid')
    }
    if (intent.recallAfterMs !== null &&
      (!Number.isSafeInteger(intent.recallAfterMs) ||
        Number(intent.recallAfterMs) < 1_000 ||
        Number(intent.recallAfterMs) > 3_600_000 ||
        Number(intent.recallAfterMs) % 1_000 !== 0)) {
      throw new TypeError('presentation intent recall delay is invalid')
    }
    return value as PresentationIntentV1
  }
  throw new TypeError('presentation intent kind is invalid')
}

export function parsePresentationRoute (value: unknown): PresentationRouteV1 {
  const route = record(value, 'presentation route')
  exactKeys(route, ROUTE_KEYS, ROUTE_REQUIRED_KEYS, 'presentation route')
  if (route.schemaVersion !== 1) {
    throw new TypeError('presentation route schema version is invalid')
  }
  const intent = parsePresentationIntent(route.presentationIntent)
  canonicalSessionAddress(route.sessionAddress)
  canonicalActorId(route.actorId)
  if (Object.hasOwn(route, 'requestMessageId')) requestMessageId(route.requestMessageId)

  const ordinary = route.requestKind === 'ordinary_chat' &&
    route.profile === 'ordinary' &&
    intent.kind === 'ordinary'
  const proactive = route.requestKind === 'proactive_chat' &&
    route.profile === 'proactive' &&
    intent.kind === 'proactive'
  if (!ordinary && !proactive) throw new TypeError('presentation route matrix is invalid')
  return value as PresentationRouteV1
}

export function recoveredLegacyRoute (
  sessionAddress: SessionAddress
): RecoveredLegacyPresentationRoute {
  canonicalSessionAddress(sessionAddress)
  return Object.freeze({
    schemaVersion: 1,
    requestKind: 'legacy_unknown',
    profile: 'recovered_legacy_plain_text',
    sessionAddress
  })
}
