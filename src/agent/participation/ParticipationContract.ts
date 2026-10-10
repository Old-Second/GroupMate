import { types } from 'node:util'

export const PARTICIPATION_POLICY_VERSION = 1
export type ParticipationMode = 'legacy' | 'shadow'
export type ParticipationReason = 'disabled' | 'empty' | 'sample_miss' | 'direct' | 'continuation' | 'sampled' | 'acknowledgement' | 'untrusted' | 'unavailable'
export interface ParticipationEvent {
  readonly schemaVersion: 1
  readonly scopeRef: string
  readonly actorRef: string
  readonly messageRef: string
  readonly at: number
  readonly origin: 'current' | 'quoted' | 'model'
  readonly addressed: boolean
  readonly acknowledgement: boolean
  readonly eligible: boolean
}
export interface ParticipationDecision {
  readonly kind: 'ignore' | 'candidate'
  readonly source: 'direct' | 'continuation' | 'sampled' | 'none'
  readonly reason: ParticipationReason
}
const trustedEvents = new WeakSet<object>()
const keys = ['schemaVersion', 'scopeRef', 'actorRef', 'messageRef', 'at', 'origin', 'addressed', 'acknowledgement', 'eligible']

// Parsing persisted/model data never grants host provenance.
export function parseParticipationEvent (value: unknown): ParticipationEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('participation event invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
    !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw new TypeError('participation event fields invalid')
  const event = Object.fromEntries(keys.map(key => [key, descriptors[key].value])) as unknown as ParticipationEvent
  if (event.schemaVersion !== 1 || !['current', 'quoted', 'model'].includes(event.origin) ||
    !Number.isSafeInteger(event.at) || event.at < 0 ||
    [event.scopeRef, event.actorRef, event.messageRef].some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) ||
    [event.addressed, event.acknowledgement, event.eligible].some(flag => typeof flag !== 'boolean') ||
    (event.origin !== 'current' && event.addressed)) throw new TypeError('participation event evidence invalid')
  return Object.freeze(event)
}

// Only the project-owned host adapter should call this after projecting a current event.
export function hostParticipationEvent (value: ParticipationEvent): ParticipationEvent {
  const event = parseParticipationEvent(value)
  if (event.origin !== 'current') throw new TypeError('host provenance invalid')
  trustedEvents.add(event)
  return event
}

export function isTrustedParticipationEvent (event: ParticipationEvent): boolean {
  return trustedEvents.has(event)
}

export function participationMode (value: unknown): ParticipationMode {
  return value === 'shadow' ? 'shadow' : 'legacy'
}
