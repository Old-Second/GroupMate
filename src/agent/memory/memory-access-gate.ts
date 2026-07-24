import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryBotInstanceIdV1,
  parseMemoryGroupLifecycleIdV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js'

export type MemoryAccessSceneV1 =
  | {
      readonly kind: 'private'
      readonly peerUserId: string
    }
  | {
      readonly kind: 'group'
      readonly groupId: string
      readonly groupLifecycleId: string
      readonly trustedMemberUserIds: readonly string[]
      readonly observedAt: string
    }

export interface MemoryAccessContextV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly scene: MemoryAccessSceneV1
}

export type MemoryAccessDeniedReasonV1 =
  | 'wrong_bot'
  | 'wrong_account'
  | 'wrong_group'
  | 'wrong_group_lifecycle'
  | 'subject_not_in_current_group'
  | 'private_subject_mismatch'

export interface MemoryAccessDecisionV1 {
  readonly allowedNamespaceRefs: readonly MemoryNamespaceRefV1[]
  readonly denied: readonly {
    readonly requestedNamespaceRef: MemoryNamespaceRefV1
    readonly reason: MemoryAccessDeniedReasonV1
  }[]
}

declare const memoryAccessSceneRefBrand: unique symbol
export type MemoryAccessSceneRefV1 = string & {
  readonly [memoryAccessSceneRefBrand]: 'MemoryAccessSceneRefV1'
}

const memoryAccessCapabilityBrand: unique symbol = Symbol('MemoryAccessCapabilityV1')
export interface MemoryAccessCapabilityV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly sceneRef: MemoryAccessSceneRefV1
  readonly observedAt: string | null
  readonly validFrom: string
  readonly validUntil: string
  readonly allowedNamespaceRefs: readonly MemoryNamespaceRefV1[]
  readonly [memoryAccessCapabilityBrand]: true
}

const memoryAccessCapabilityIssuerBrand: unique symbol = Symbol('MemoryAccessCapabilityIssuerV1')
export interface MemoryAccessCapabilityIssuerV1 {
  readonly [memoryAccessCapabilityIssuerBrand]: true
}

export type MemoryAccessTrustedVerifierV1 = (
  context: MemoryAccessContextV1,
  now: string
) => boolean

interface MemoryAccessCapabilityStateV1 {
  readonly allowedNamespaceRefs: ReadonlySet<MemoryNamespaceRefV1>
  readonly validFromMs: number
  readonly validUntilMs: number
}

const issuedMemoryAccessCapabilities = new WeakSet<MemoryAccessCapabilityV1>()
const issuedMemoryAccessCapabilityIssuers = new WeakSet<MemoryAccessCapabilityIssuerV1>()
const memoryAccessCapabilityVerifier = new WeakMap<
  MemoryAccessCapabilityIssuerV1,
  MemoryAccessTrustedVerifierV1
>()
const memoryAccessCapabilityState = new WeakMap<
  MemoryAccessCapabilityV1,
  MemoryAccessCapabilityStateV1
>()

const MEMORY_ACCESS_SCENE_HASH_DOMAIN = 'groupmate.memory.access-scene.v1'

const DENIED_REASONS: readonly MemoryAccessDeniedReasonV1[] = [
  'wrong_bot',
  'wrong_account',
  'wrong_group',
  'wrong_group_lifecycle',
  'subject_not_in_current_group',
  'private_subject_mismatch'
]

function parseCanonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalidMemoryValue()
  return value
}

function asciiMemoryCompare (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseMemoryAccessSceneV1 (value: unknown): MemoryAccessSceneV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['peerUserId', 'groupId', 'groupLifecycleId', 'trustedMemberUserIds', 'observedAt']
  )
  if (discriminator.kind === 'private') {
    const input = inspectMemoryRecord(value, ['kind', 'peerUserId'])
    return Object.freeze({
      kind: 'private' as const,
      peerUserId: parseMemoryQqIdV1(input.peerUserId)
    })
  }
  if (discriminator.kind === 'group') {
    const input = inspectMemoryRecord(value, [
      'kind',
      'groupId',
      'groupLifecycleId',
      'trustedMemberUserIds',
      'observedAt'
    ])
    const members = inspectMemoryArray(
      input.trustedMemberUserIds,
      MEMORY_RESOURCE_LIMITS.trustedMemberUserIds
    ).map(parseMemoryQqIdV1)
    if (new Set(members).size !== members.length) return invalidMemoryValue()
    members.sort(asciiMemoryCompare)
    return Object.freeze({
      kind: 'group' as const,
      groupId: parseMemoryQqIdV1(input.groupId),
      groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId),
      trustedMemberUserIds: Object.freeze(members),
      observedAt: parseCanonicalInstant(input.observedAt)
    })
  }
  return invalidMemoryValue()
}

export function parseMemoryAccessContextV1 (value: unknown): MemoryAccessContextV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion',
    'botInstanceId',
    'adapter',
    'accountId',
    'scene'
  ])
  if (input.schemaVersion !== 1 || input.adapter !== 'qq') return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    adapter: 'qq' as const,
    accountId: parseMemoryQqIdV1(input.accountId),
    scene: parseMemoryAccessSceneV1(input.scene)
  })
}

function deniedReason (
  context: MemoryAccessContextV1,
  namespace: MemoryNamespaceV1
): MemoryAccessDeniedReasonV1 | null {
  if (namespace.botInstanceId !== context.botInstanceId) return 'wrong_bot'
  if (namespace.accountId !== context.accountId) return 'wrong_account'
  if (context.scene.kind === 'private') {
    if (namespace.scope.kind === 'group') return 'wrong_group'
    return namespace.scope.subjectUserId === context.scene.peerUserId
      ? null
      : 'private_subject_mismatch'
  }
  if (namespace.scope.kind === 'personal') {
    return context.scene.trustedMemberUserIds.includes(namespace.scope.subjectUserId)
      ? null
      : 'subject_not_in_current_group'
  }
  if (namespace.scope.groupId !== context.scene.groupId) return 'wrong_group'
  return namespace.scope.groupLifecycleId === context.scene.groupLifecycleId
    ? null
    : 'wrong_group_lifecycle'
}

interface MemoryAccessEvaluationV1 {
  readonly context: MemoryAccessContextV1
  readonly decision: MemoryAccessDecisionV1
}

function evaluateMemoryAccessV1 (
  contextValue: unknown,
  requestedNamespacesValue: unknown
): MemoryAccessEvaluationV1 {
  const context = parseMemoryAccessContextV1(contextValue)
  const namespaces = inspectMemoryArray(
    requestedNamespacesValue,
    MEMORY_RESOURCE_LIMITS.accessNamespaces
  ).map(parseMemoryNamespaceV1)
  const refs = namespaces.map(memoryNamespaceRefV1)
  if (new Set(refs).size !== refs.length) return invalidMemoryValue()

  const allowedNamespaceRefs: MemoryNamespaceRefV1[] = []
  const denied: Array<MemoryAccessDecisionV1['denied'][number]> = []
  namespaces.forEach((namespace, index) => {
    const requestedNamespaceRef = refs[index]
    if (requestedNamespaceRef === undefined) return invalidMemoryValue()
    const reason = deniedReason(context, namespace)
    if (reason === null) {
      allowedNamespaceRefs.push(requestedNamespaceRef)
    } else {
      denied.push(Object.freeze({ requestedNamespaceRef, reason }))
    }
  })
  return Object.freeze({
    context,
    decision: Object.freeze({
      allowedNamespaceRefs: Object.freeze(allowedNamespaceRefs),
      denied: Object.freeze(denied)
    })
  })
}

export function decideMemoryAccessV1 (
  contextValue: unknown,
  requestedNamespacesValue: unknown
): MemoryAccessDecisionV1 {
  return evaluateMemoryAccessV1(contextValue, requestedNamespacesValue).decision
}

export function memoryAccessSceneRefV1 (sceneValue: unknown): MemoryAccessSceneRefV1 {
  const scene = parseMemoryAccessSceneV1(sceneValue)
  const wire = scene.kind === 'private'
    ? `{"kind":"private","peerUserId":${JSON.stringify(scene.peerUserId)}}`
    : `{"kind":"group","groupId":${JSON.stringify(scene.groupId)},"groupLifecycleId":${JSON.stringify(scene.groupLifecycleId)}}`
  return createHash('sha256')
    .update(MEMORY_ACCESS_SCENE_HASH_DOMAIN, 'utf8')
    .update('\0')
    .update(wire, 'utf8')
    .digest('hex') as MemoryAccessSceneRefV1
}

function canonicalInstantFromMilliseconds (milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) return invalidMemoryValue()
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return invalidMemoryValue()
  }
}

export function createMemoryAccessCapabilityIssuerV1 (
  verifierValue: unknown
): MemoryAccessCapabilityIssuerV1 {
  if (typeof verifierValue !== 'function') return invalidMemoryValue()
  const issuer: MemoryAccessCapabilityIssuerV1 = Object.freeze({
    [memoryAccessCapabilityIssuerBrand]: true as const
  })
  issuedMemoryAccessCapabilityIssuers.add(issuer)
  memoryAccessCapabilityVerifier.set(
    issuer,
    verifierValue as MemoryAccessTrustedVerifierV1
  )
  return issuer
}

function trustedVerifierAllows (
  issuer: MemoryAccessCapabilityIssuerV1,
  context: MemoryAccessContextV1,
  now: string
): boolean {
  const verifier = memoryAccessCapabilityVerifier.get(issuer)
  if (verifier === undefined) return false
  let result: unknown
  try {
    result = Reflect.apply(verifier, undefined, [context, now])
  } catch {
    return false
  }
  if (utilTypes.isPromise(result)) {
    void Promise.prototype.then.call(result, undefined, () => undefined)
    return false
  }
  return result === true
}

export function issueMemoryAccessCapabilityV1 (
  issuer: unknown,
  contextValue: unknown,
  requestedNamespacesValue: unknown,
  nowValue: unknown
): MemoryAccessCapabilityV1 {
  if (issuer === null || typeof issuer !== 'object' ||
    !issuedMemoryAccessCapabilityIssuers.has(issuer as MemoryAccessCapabilityIssuerV1)) {
    return invalidMemoryValue()
  }
  const now = parseCanonicalInstant(nowValue)
  const context = parseMemoryAccessContextV1(contextValue)
  if (!trustedVerifierAllows(
    issuer as MemoryAccessCapabilityIssuerV1,
    context,
    now
  )) return invalidMemoryValue()
  const nowMs = Date.parse(now)
  const evaluation = evaluateMemoryAccessV1(context, requestedNamespacesValue)
  const observedAt = evaluation.context.scene.kind === 'group'
    ? evaluation.context.scene.observedAt
    : null
  let validUntilMs = nowMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
  if (evaluation.context.scene.kind === 'group') {
    const observedAtMs = Date.parse(evaluation.context.scene.observedAt)
    if (nowMs - observedAtMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs ||
      observedAtMs - nowMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs) {
      return invalidMemoryValue()
    }
    validUntilMs = Math.min(
      validUntilMs,
      observedAtMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
    )
  }
  const allowedNamespaceRefs = Object.freeze([
    ...evaluation.decision.allowedNamespaceRefs
  ])
  const capability: MemoryAccessCapabilityV1 = Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: evaluation.context.botInstanceId,
    adapter: 'qq' as const,
    accountId: evaluation.context.accountId,
    sceneRef: memoryAccessSceneRefV1(evaluation.context.scene),
    observedAt,
    validFrom: now,
    validUntil: canonicalInstantFromMilliseconds(validUntilMs),
    allowedNamespaceRefs,
    [memoryAccessCapabilityBrand]: true as const
  })
  issuedMemoryAccessCapabilities.add(capability)
  memoryAccessCapabilityState.set(capability, Object.freeze({
    allowedNamespaceRefs: new Set(allowedNamespaceRefs),
    validFromMs: nowMs,
    validUntilMs
  }))
  return capability
}

export function memoryAccessCapabilityAllowsV1 (
  capability: unknown,
  namespaceRefValue: unknown,
  nowValue?: unknown
): boolean {
  if (capability === null || typeof capability !== 'object' ||
    !issuedMemoryAccessCapabilities.has(capability as MemoryAccessCapabilityV1)) return false
  const state = memoryAccessCapabilityState.get(capability as MemoryAccessCapabilityV1)
  if (state === undefined) return false
  try {
    const namespaceRef = parseMemoryNamespaceRefV1(namespaceRefValue)
    const nowMs = nowValue === undefined
      ? Date.now()
      : Date.parse(parseCanonicalInstant(nowValue))
    return nowMs >= state.validFromMs && nowMs <= state.validUntilMs &&
      state.allowedNamespaceRefs.has(namespaceRef)
  } catch {
    return false
  }
}

function parseDeniedReason (value: unknown): MemoryAccessDeniedReasonV1 {
  if (typeof value !== 'string' || !DENIED_REASONS.includes(value as MemoryAccessDeniedReasonV1)) {
    return invalidMemoryValue()
  }
  return value as MemoryAccessDeniedReasonV1
}

export function parseMemoryAccessDecisionV1 (value: unknown): MemoryAccessDecisionV1 {
  const input = inspectMemoryRecord(value, ['allowedNamespaceRefs', 'denied'])
  const allowedNamespaceRefs = inspectMemoryArray(
    input.allowedNamespaceRefs,
    MEMORY_RESOURCE_LIMITS.accessNamespaces
  ).map(parseMemoryNamespaceRefV1)
  const denied = inspectMemoryArray(
    input.denied,
    MEMORY_RESOURCE_LIMITS.accessNamespaces
  ).map(entry => {
    const item = inspectMemoryRecord(entry, ['requestedNamespaceRef', 'reason'])
    return Object.freeze({
      requestedNamespaceRef: parseMemoryNamespaceRefV1(item.requestedNamespaceRef),
      reason: parseDeniedReason(item.reason)
    })
  })
  const allRefs = [
    ...allowedNamespaceRefs,
    ...denied.map(value => value.requestedNamespaceRef)
  ]
  if (allRefs.length > MEMORY_RESOURCE_LIMITS.accessNamespaces ||
    new Set(allRefs).size !== allRefs.length) return invalidMemoryValue()
  return Object.freeze({
    allowedNamespaceRefs: Object.freeze(allowedNamespaceRefs),
    denied: Object.freeze(denied)
  })
}
