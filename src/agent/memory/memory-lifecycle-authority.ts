import { types as utilTypes } from 'node:util'
import type {
  MemoryKindV1,
  MemorySensitivityV1,
  MemorySourceKindV1
} from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryBotInstanceIdV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

export const MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1 = Object.freeze([
  'propose_create',
  'propose_correction',
  'withdraw_own_proposal',
  'list_safe',
  'inspect_full',
  'approve',
  'reject',
  'correct',
  'renew',
  'change_conflict',
  'forget',
  'export',
  'delete_namespace',
  'resolve_deletion',
  'claim_export'
] as const)

export type MemoryLifecycleActorActionV1 =
  typeof MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1[number]

export type MemoryLifecycleActorRoleV1 =
  | 'personal_subject'
  | 'personal_bot_master'
  | 'group_member'
  | 'group_admin'
  | 'group_owner'
  | 'group_bot_master'

export type MemoryLifecycleActorAuthorityRequirementV1 =
  | 'safe'
  | 'ordinary'
  | 'elevated'
  | 'delete_only'

export type MemoryPolicyConsentV1 = 'owner_policy' | 'group_policy'
export const MEMORY_MAINTENANCE_OPERATIONS_V1 = Object.freeze([
  'proposal.expireDue',
  'proposal.purgeDecided',
  'record.purgeExpired',
  'namespace.scrubDeleted',
  'namespace.verifyScrubbed',
  'tombstone.purgeExpired',
  'audit.purgeExpired',
  'export.releaseExpiredReservations',
  'deletion.checkpoint'
] as const)
export type MemoryMaintenanceOperationV1 =
  typeof MEMORY_MAINTENANCE_OPERATIONS_V1[number]

const MEMORY_KINDS: readonly MemoryKindV1[] = [
  'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
  'task_fact', 'other'
]
const MEMORY_SENSITIVITIES: readonly MemorySensitivityV1[] = [
  'public', 'group', 'personal', 'sensitive'
]
const MEMORY_SOURCE_KINDS: readonly MemorySourceKindV1[] = [
  'current_message', 'quoted_message', 'group_history', 'private_history',
  'manual_user_input', 'manual_correction'
]
const ACTOR_ROLES: readonly MemoryLifecycleActorRoleV1[] = [
  'personal_subject', 'personal_bot_master', 'group_member', 'group_admin',
  'group_owner', 'group_bot_master'
]
const AUTHORITY_REQUIREMENTS: readonly MemoryLifecycleActorAuthorityRequirementV1[] = [
  'safe', 'ordinary', 'elevated', 'delete_only'
]
const MAX_CANONICAL_INSTANT_MS = 8_640_000_000_000_000
const OLD_GENERATION_MAINTENANCE_OPERATIONS = new Set<MemoryMaintenanceOperationV1>([
  'namespace.scrubDeleted', 'namespace.verifyScrubbed', 'deletion.checkpoint'
])

const PERSONAL_SUBJECT_ACTIONS = new Set<MemoryLifecycleActorActionV1>(
  MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1
)
const PERSONAL_DELETE_ONLY_ACTIONS = new Set<MemoryLifecycleActorActionV1>([
  'forget', 'delete_namespace', 'resolve_deletion'
])
const GROUP_MEMBER_ACTIONS = new Set<MemoryLifecycleActorActionV1>([
  'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe'
])
const GROUP_ADMIN_ACTIONS = new Set<MemoryLifecycleActorActionV1>([
  ...GROUP_MEMBER_ACTIONS,
  'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict', 'forget'
])
const GROUP_ELEVATED_ACTIONS = new Set<MemoryLifecycleActorActionV1>(
  MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1
)

export interface MemoryLifecycleActorAuthorityContextV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly sceneRef: string
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly actorRef: string
  readonly actorUserId: string
  readonly role: MemoryLifecycleActorRoleV1
  readonly roleObservedAt: string | null
  readonly actions: readonly MemoryLifecycleActorActionV1[]
}

export interface MemoryPolicyAuthorityContextV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly sceneRef: string
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly policyRef: string
  readonly policyGeneration: number
  readonly createdByActorRef: string
  readonly createdByUserId: string
  readonly consent: MemoryPolicyConsentV1
  readonly allowedKinds: readonly MemoryKindV1[]
  readonly allowedSensitivities: readonly MemorySensitivityV1[]
  readonly allowedSourceKinds: readonly MemorySourceKindV1[]
  readonly allowedRetentionPolicyRefs: readonly string[]
}

export interface MemoryMaintenanceAuthorityContextV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly deletionRef: string | null
  readonly operation: MemoryMaintenanceOperationV1
  readonly limit: number
}

export type MemoryLifecycleAuthorityRequestV1 =
  | { readonly kind: 'actor'; readonly context: MemoryLifecycleActorAuthorityContextV1 }
  | { readonly kind: 'policy'; readonly context: MemoryPolicyAuthorityContextV1 }
  | { readonly kind: 'maintenance'; readonly context: MemoryMaintenanceAuthorityContextV1 }

export type MemoryLifecycleTrustedVerifierV1 = (
  request: MemoryLifecycleAuthorityRequestV1,
  now: string
) => boolean

const authorityRootBrand: unique symbol = Symbol('MemoryLifecycleAuthorityRootV1')
export interface MemoryLifecycleAuthorityRootV1 {
  readonly schemaVersion: 1
  readonly [authorityRootBrand]: true
}

const actorCapabilityBrand: unique symbol = Symbol('MemoryLifecycleActorCapabilityV1')
export interface MemoryLifecycleActorCapabilityV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly actorRef: string
  readonly role: MemoryLifecycleActorRoleV1
  readonly roleObservedAt: string | null
  readonly actions: readonly MemoryLifecycleActorActionV1[]
  readonly validFrom: string
  readonly validUntil: string
  readonly [actorCapabilityBrand]: true
}

const policyCapabilityBrand: unique symbol = Symbol('MemoryPolicyCapabilityV1')
export interface MemoryPolicyCapabilityV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly policyRef: string
  readonly policyGeneration: number
  readonly createdByActorRef: string
  readonly consent: MemoryPolicyConsentV1
  readonly allowedKinds: readonly MemoryKindV1[]
  readonly allowedSensitivities: readonly MemorySensitivityV1[]
  readonly allowedSourceKinds: readonly MemorySourceKindV1[]
  readonly allowedRetentionPolicyRefs: readonly string[]
  readonly validFrom: string
  readonly validUntil: string
  readonly [policyCapabilityBrand]: true
}

const maintenanceCapabilityBrand: unique symbol = Symbol('MemoryMaintenanceCapabilityV1')
export interface MemoryMaintenanceCapabilityV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly deletionRef: string | null
  readonly operation: MemoryMaintenanceOperationV1
  readonly limit: number
  readonly validFrom: string
  readonly validUntil: string
  readonly [maintenanceCapabilityBrand]: true
}

interface TimedCapabilityStateV1 {
  readonly validFromMs: number
  readonly validUntilMs: number
}

interface ActorCapabilityStateV1 extends TimedCapabilityStateV1 {
  readonly actions: ReadonlySet<MemoryLifecycleActorActionV1>
  readonly role: MemoryLifecycleActorRoleV1
}

interface PolicyCapabilityStateV1 extends TimedCapabilityStateV1 {
  readonly allowedKinds: ReadonlySet<MemoryKindV1>
  readonly allowedSensitivities: ReadonlySet<MemorySensitivityV1>
  readonly allowedSourceKinds: ReadonlySet<MemorySourceKindV1>
  readonly allowedRetentionPolicyRefs: ReadonlySet<string>
}

const roots = new WeakSet<MemoryLifecycleAuthorityRootV1>()
const rootVerifiers = new WeakMap<MemoryLifecycleAuthorityRootV1, MemoryLifecycleTrustedVerifierV1>()
const actorCapabilities = new WeakSet<MemoryLifecycleActorCapabilityV1>()
const actorStates = new WeakMap<MemoryLifecycleActorCapabilityV1, ActorCapabilityStateV1>()
const policyCapabilities = new WeakSet<MemoryPolicyCapabilityV1>()
const policyStates = new WeakMap<MemoryPolicyCapabilityV1, PolicyCapabilityStateV1>()
const maintenanceCapabilities = new WeakSet<MemoryMaintenanceCapabilityV1>()
const maintenanceStates = new WeakMap<MemoryMaintenanceCapabilityV1, TimedCapabilityStateV1>()

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function positiveInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    return invalidMemoryValue()
  }
  return value
}

function parseCanonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 ||
    milliseconds > MAX_CANONICAL_INSTANT_MS || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function parseSceneRef (value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalidMemoryValue()
  return value
}

function parseOpaqueRef (value: unknown, prefix: string): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    typeof value !== 'string' || !value.startsWith(prefix) || value.length <= prefix.length) {
    return invalidMemoryValue()
  }
  return value
}

function parseActorRef (value: unknown): string {
  if (typeof value !== 'string' || !/^actor:[0-9a-f]{64}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

function parseDeletionRef (value: unknown): string {
  if (typeof value !== 'string' || !/^deletion:[0-9a-f]{64}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

function parseUniqueEnumArray<T extends string> (
  value: unknown,
  values: readonly T[],
  maximumLength: number
): readonly T[] {
  const parsed = inspectMemoryArray(value, maximumLength).map(item => enumValue(item, values))
  if (new Set(parsed).size !== parsed.length) return invalidMemoryValue()
  return Object.freeze(parsed)
}

function parseUniqueOpaqueArray (
  value: unknown,
  prefix: string
): readonly string[] {
  const parsed = inspectMemoryArray(
    value,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues
  ).map(item => parseOpaqueRef(item, prefix))
  if (new Set(parsed).size !== parsed.length) return invalidMemoryValue()
  return Object.freeze(parsed)
}

function parseNamespaceBoundContext (
  input: Readonly<Record<string, unknown>>
): {
    readonly botInstanceId: string
    readonly accountId: string
    readonly sceneRef: string
    readonly namespace: MemoryNamespaceV1
    readonly namespaceRef: MemoryNamespaceRefV1
    readonly generation: number
  } {
  if (input.adapter !== 'qq') return invalidMemoryValue()
  const botInstanceId = parseMemoryBotInstanceIdV1(input.botInstanceId)
  const accountId = parseMemoryQqIdV1(input.accountId)
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  if (namespace.botInstanceId !== botInstanceId || namespace.accountId !== accountId ||
    memoryNamespaceRefV1(namespace) !== namespaceRef) return invalidMemoryValue()
  return {
    botInstanceId,
    accountId,
    sceneRef: parseSceneRef(input.sceneRef),
    namespace,
    namespaceRef,
    generation: positiveInteger(input.generation)
  }
}

function allowedActionsForRole (
  role: MemoryLifecycleActorRoleV1
): ReadonlySet<MemoryLifecycleActorActionV1> {
  if (role === 'personal_subject') return PERSONAL_SUBJECT_ACTIONS
  if (role === 'personal_bot_master') return PERSONAL_DELETE_ONLY_ACTIONS
  if (role === 'group_member') return GROUP_MEMBER_ACTIONS
  if (role === 'group_admin') return GROUP_ADMIN_ACTIONS
  return GROUP_ELEVATED_ACTIONS
}

export function parseMemoryLifecycleActorAuthorityContextV1 (
  value: unknown
): MemoryLifecycleActorAuthorityContextV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'sceneRef', 'namespace',
    'namespaceRef', 'generation', 'actorRef', 'actorUserId', 'role', 'roleObservedAt',
    'actions'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const binding = parseNamespaceBoundContext(input)
  const role = enumValue(input.role, ACTOR_ROLES)
  const actorRef = parseActorRef(input.actorRef)
  const actorUserId = parseMemoryQqIdV1(input.actorUserId)
  const actions = parseUniqueEnumArray(
    input.actions,
    MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleActorActions
  )
  const allowedActions = allowedActionsForRole(role)
  if (actions.length === 0 || actions.some(action => !allowedActions.has(action))) {
    return invalidMemoryValue()
  }
  let roleObservedAt: string | null
  if (binding.namespace.scope.kind === 'personal') {
    if (role !== 'personal_subject' && role !== 'personal_bot_master') return invalidMemoryValue()
    roleObservedAt = input.roleObservedAt === null ? null : invalidMemoryValue()
    const isSubject = actorUserId === binding.namespace.scope.subjectUserId
    if ((role === 'personal_subject') !== isSubject) return invalidMemoryValue()
  } else {
    if (role === 'personal_subject' || role === 'personal_bot_master') return invalidMemoryValue()
    roleObservedAt = parseCanonicalInstant(input.roleObservedAt)
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: binding.botInstanceId,
    adapter: 'qq' as const,
    accountId: binding.accountId,
    sceneRef: binding.sceneRef,
    namespace: binding.namespace,
    namespaceRef: binding.namespaceRef,
    generation: binding.generation,
    actorRef,
    actorUserId,
    role,
    roleObservedAt,
    actions
  })
}

export function parseMemoryPolicyAuthorityContextV1 (
  value: unknown
): MemoryPolicyAuthorityContextV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'sceneRef', 'namespace',
    'namespaceRef', 'generation', 'policyRef', 'policyGeneration', 'createdByActorRef',
    'createdByUserId', 'consent', 'allowedKinds', 'allowedSensitivities', 'allowedSourceKinds',
    'allowedRetentionPolicyRefs'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const binding = parseNamespaceBoundContext(input)
  const consent = enumValue(input.consent, ['owner_policy', 'group_policy'] as const)
  if ((binding.namespace.scope.kind === 'personal') !== (consent === 'owner_policy')) {
    return invalidMemoryValue()
  }
  const createdByActorRef = parseActorRef(input.createdByActorRef)
  const createdByUserId = parseMemoryQqIdV1(input.createdByUserId)
  if (binding.namespace.scope.kind === 'personal' &&
    createdByUserId !== binding.namespace.scope.subjectUserId) {
    return invalidMemoryValue()
  }
  const allowedKinds = parseUniqueEnumArray(
    input.allowedKinds,
    MEMORY_KINDS,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues
  )
  const allowedSensitivities = parseUniqueEnumArray(
    input.allowedSensitivities,
    MEMORY_SENSITIVITIES,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues
  )
  const allowedSourceKinds = parseUniqueEnumArray(
    input.allowedSourceKinds,
    MEMORY_SOURCE_KINDS,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues
  )
  const allowedRetentionPolicyRefs = parseUniqueOpaqueArray(
    input.allowedRetentionPolicyRefs,
    'retention:'
  )
  if (allowedKinds.length === 0 || allowedSensitivities.length === 0 ||
    allowedSourceKinds.length === 0 || allowedRetentionPolicyRefs.length === 0) {
    return invalidMemoryValue()
  }
  if (binding.namespace.scope.kind === 'group' && (
    allowedKinds.some(kind => !['group_rule', 'group_culture', 'task_fact', 'other'].includes(kind)) ||
    allowedSensitivities.some(value => value !== 'public' && value !== 'group') ||
    allowedSourceKinds.includes('private_history')
  )) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: binding.botInstanceId,
    adapter: 'qq' as const,
    accountId: binding.accountId,
    sceneRef: binding.sceneRef,
    namespace: binding.namespace,
    namespaceRef: binding.namespaceRef,
    generation: binding.generation,
    policyRef: parseOpaqueRef(input.policyRef, 'policy:'),
    policyGeneration: positiveInteger(input.policyGeneration),
    createdByActorRef,
    createdByUserId,
    consent,
    allowedKinds,
    allowedSensitivities,
    allowedSourceKinds,
    allowedRetentionPolicyRefs
  })
}

export function parseMemoryMaintenanceAuthorityContextV1 (
  value: unknown
): MemoryMaintenanceAuthorityContextV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'namespace', 'namespaceRef',
    'currentGeneration', 'targetGeneration', 'deletionRef', 'operation', 'limit'
  ])
  if (input.schemaVersion !== 1 || input.adapter !== 'qq') return invalidMemoryValue()
  const botInstanceId = parseMemoryBotInstanceIdV1(input.botInstanceId)
  const accountId = parseMemoryQqIdV1(input.accountId)
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  if (namespace.botInstanceId !== botInstanceId || namespace.accountId !== accountId ||
    memoryNamespaceRefV1(namespace) !== namespaceRef) return invalidMemoryValue()
  const operation = enumValue(input.operation, MEMORY_MAINTENANCE_OPERATIONS_V1)
  const currentGeneration = positiveInteger(input.currentGeneration)
  const targetGeneration = positiveInteger(input.targetGeneration)
  const deletionRef = input.deletionRef === null
    ? null
    : parseDeletionRef(input.deletionRef)
  const limit = positiveInteger(input.limit)
  if (limit > MEMORY_RESOURCE_LIMITS.operationBatchRecords) return invalidMemoryValue()
  if (!OLD_GENERATION_MAINTENANCE_OPERATIONS.has(operation)) {
    if (deletionRef !== null || targetGeneration !== currentGeneration) return invalidMemoryValue()
  } else if (deletionRef === null || targetGeneration >= currentGeneration) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId,
    adapter: 'qq' as const,
    accountId,
    namespace,
    namespaceRef,
    currentGeneration,
    targetGeneration,
    deletionRef,
    operation,
    limit
  })
}

export function createMemoryLifecycleAuthorityRootV1 (
  verifier: MemoryLifecycleTrustedVerifierV1
): MemoryLifecycleAuthorityRootV1 {
  if (typeof verifier !== 'function' || utilTypes.isProxy(verifier)) return invalidMemoryValue()
  const root: MemoryLifecycleAuthorityRootV1 = Object.freeze({
    schemaVersion: 1 as const,
    [authorityRootBrand]: true as const
  })
  roots.add(root)
  rootVerifiers.set(root, verifier)
  return root
}

function verifyTrusted (
  rootValue: unknown,
  request: MemoryLifecycleAuthorityRequestV1,
  now: string
): void {
  if (rootValue === null || typeof rootValue !== 'object' || utilTypes.isProxy(rootValue) ||
    !roots.has(rootValue as MemoryLifecycleAuthorityRootV1)) return invalidMemoryValue()
  const verifier = rootVerifiers.get(rootValue as MemoryLifecycleAuthorityRootV1)
  if (verifier === undefined) return invalidMemoryValue()
  let result: unknown
  try {
    result = Reflect.apply(verifier, undefined, [request, now])
  } catch {
    return invalidMemoryValue()
  }
  if (utilTypes.isPromise(result)) {
    void Promise.prototype.then.call(result, undefined, () => undefined)
    return invalidMemoryValue()
  }
  if (result !== true) return invalidMemoryValue()
}

function capabilityWindow (
  now: string,
  observedAt: string | null
): { readonly validFromMs: number; readonly validUntilMs: number; readonly validUntil: string } {
  const validFromMs = Date.parse(now)
  let validUntilMs = validFromMs +
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCapabilityAbsoluteTtlMs
  if (!Number.isSafeInteger(validUntilMs) || validUntilMs > MAX_CANONICAL_INSTANT_MS) {
    return invalidMemoryValue()
  }
  if (observedAt !== null) {
    const observedAtMs = Date.parse(observedAt)
    if (validFromMs - observedAtMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs ||
      observedAtMs - validFromMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs) {
      return invalidMemoryValue()
    }
    validUntilMs = Math.min(
      validUntilMs,
      observedAtMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs
    )
  }
  return {
    validFromMs,
    validUntilMs,
    validUntil: new Date(validUntilMs).toISOString()
  }
}

export function issueMemoryLifecycleActorCapabilityV1 (
  root: unknown,
  contextValue: unknown,
  nowValue: unknown
): MemoryLifecycleActorCapabilityV1 {
  const now = parseCanonicalInstant(nowValue)
  const context = parseMemoryLifecycleActorAuthorityContextV1(contextValue)
  verifyTrusted(root, Object.freeze({ kind: 'actor' as const, context }), now)
  const window = capabilityWindow(now, context.roleObservedAt)
  const capability: MemoryLifecycleActorCapabilityV1 = Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: context.botInstanceId,
    adapter: 'qq' as const,
    accountId: context.accountId,
    sceneRef: context.sceneRef,
    namespaceRef: context.namespaceRef,
    generation: context.generation,
    actorRef: context.actorRef,
    role: context.role,
    roleObservedAt: context.roleObservedAt,
    actions: context.actions,
    validFrom: now,
    validUntil: window.validUntil,
    [actorCapabilityBrand]: true as const
  })
  actorCapabilities.add(capability)
  actorStates.set(capability, Object.freeze({
    validFromMs: window.validFromMs,
    validUntilMs: window.validUntilMs,
    actions: new Set(context.actions),
    role: context.role
  }))
  return capability
}

export function issueMemoryPolicyCapabilityV1 (
  root: unknown,
  contextValue: unknown,
  nowValue: unknown
): MemoryPolicyCapabilityV1 {
  const now = parseCanonicalInstant(nowValue)
  const context = parseMemoryPolicyAuthorityContextV1(contextValue)
  verifyTrusted(root, Object.freeze({ kind: 'policy' as const, context }), now)
  const window = capabilityWindow(now, null)
  const capability: MemoryPolicyCapabilityV1 = Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: context.botInstanceId,
    adapter: 'qq' as const,
    accountId: context.accountId,
    sceneRef: context.sceneRef,
    namespaceRef: context.namespaceRef,
    generation: context.generation,
    policyRef: context.policyRef,
    policyGeneration: context.policyGeneration,
    createdByActorRef: context.createdByActorRef,
    consent: context.consent,
    allowedKinds: context.allowedKinds,
    allowedSensitivities: context.allowedSensitivities,
    allowedSourceKinds: context.allowedSourceKinds,
    allowedRetentionPolicyRefs: context.allowedRetentionPolicyRefs,
    validFrom: now,
    validUntil: window.validUntil,
    [policyCapabilityBrand]: true as const
  })
  policyCapabilities.add(capability)
  policyStates.set(capability, Object.freeze({
    validFromMs: window.validFromMs,
    validUntilMs: window.validUntilMs,
    allowedKinds: new Set(context.allowedKinds),
    allowedSensitivities: new Set(context.allowedSensitivities),
    allowedSourceKinds: new Set(context.allowedSourceKinds),
    allowedRetentionPolicyRefs: new Set(context.allowedRetentionPolicyRefs)
  }))
  return capability
}

export function issueMemoryMaintenanceCapabilityV1 (
  root: unknown,
  contextValue: unknown,
  nowValue: unknown
): MemoryMaintenanceCapabilityV1 {
  const now = parseCanonicalInstant(nowValue)
  const context = parseMemoryMaintenanceAuthorityContextV1(contextValue)
  verifyTrusted(root, Object.freeze({ kind: 'maintenance' as const, context }), now)
  const window = capabilityWindow(now, null)
  const capability: MemoryMaintenanceCapabilityV1 = Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: context.botInstanceId,
    adapter: 'qq' as const,
    accountId: context.accountId,
    namespaceRef: context.namespaceRef,
    currentGeneration: context.currentGeneration,
    targetGeneration: context.targetGeneration,
    deletionRef: context.deletionRef,
    operation: context.operation,
    limit: context.limit,
    validFrom: now,
    validUntil: window.validUntil,
    [maintenanceCapabilityBrand]: true as const
  })
  maintenanceCapabilities.add(capability)
  maintenanceStates.set(capability, Object.freeze({
    validFromMs: window.validFromMs,
    validUntilMs: window.validUntilMs
  }))
  return capability
}

function freshAt (
  state: TimedCapabilityStateV1,
  nowValue: unknown
): boolean {
  const nowMs = Date.parse(parseCanonicalInstant(nowValue))
  return nowMs >= state.validFromMs && nowMs <= state.validUntilMs
}

function actorRoleAllowsRequirement (
  role: MemoryLifecycleActorRoleV1,
  requirement: MemoryLifecycleActorAuthorityRequirementV1
): boolean {
  if (requirement === 'safe') return role === 'group_member' || role === 'group_admin' ||
    role === 'group_owner' || role === 'group_bot_master' || role === 'personal_subject'
  if (requirement === 'ordinary') return role === 'group_admin' || role === 'group_owner' ||
    role === 'group_bot_master' || role === 'personal_subject'
  if (requirement === 'elevated') return role === 'group_owner' ||
    role === 'group_bot_master' || role === 'personal_subject'
  return role === 'personal_bot_master'
}

export interface MemoryLifecycleActorCapabilityRequestV1 {
  readonly botInstanceId: string
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly actorRef: string
  readonly action: MemoryLifecycleActorActionV1
  readonly requiredAuthority: MemoryLifecycleActorAuthorityRequirementV1
}

export function parseMemoryLifecycleActorCapabilityRequestV1 (
  value: unknown
): MemoryLifecycleActorCapabilityRequestV1 {
  const input = inspectMemoryRecord(value, [
    'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
    'action', 'requiredAuthority'
  ])
  return Object.freeze({
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    accountId: parseMemoryQqIdV1(input.accountId),
    sceneRef: parseSceneRef(input.sceneRef),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    generation: positiveInteger(input.generation),
    actorRef: parseActorRef(input.actorRef),
    action: enumValue(input.action, MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1),
    requiredAuthority: enumValue(input.requiredAuthority, AUTHORITY_REQUIREMENTS)
  })
}

export function memoryLifecycleActorCapabilityAllowsV1 (
  capabilityValue: unknown,
  requestValue: unknown,
  freshNowValue: unknown
): boolean {
  if (capabilityValue === null || typeof capabilityValue !== 'object' ||
    utilTypes.isProxy(capabilityValue) ||
    !actorCapabilities.has(capabilityValue as MemoryLifecycleActorCapabilityV1)) return false
  const capability = capabilityValue as MemoryLifecycleActorCapabilityV1
  const state = actorStates.get(capability)
  if (state === undefined) return false
  try {
    const request = parseMemoryLifecycleActorCapabilityRequestV1(requestValue)
    return freshAt(state, freshNowValue) &&
      capability.botInstanceId === request.botInstanceId &&
      capability.accountId === request.accountId &&
      capability.sceneRef === request.sceneRef &&
      capability.namespaceRef === request.namespaceRef &&
      capability.generation === request.generation &&
      capability.actorRef === request.actorRef &&
      state.actions.has(request.action) &&
      actorRoleAllowsRequirement(capability.role, request.requiredAuthority)
  } catch {
    return false
  }
}

export interface MemoryPolicyCapabilityRequestV1 {
  readonly botInstanceId: string
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly policyRef: string
  readonly policyGeneration: number
  readonly consent: MemoryPolicyConsentV1
  readonly kind: MemoryKindV1
  readonly sensitivity: MemorySensitivityV1
  readonly sourceKinds: readonly MemorySourceKindV1[]
  readonly retentionPolicyRef: string
}

export function parseMemoryPolicyCapabilityRequestV1 (
  value: unknown
): MemoryPolicyCapabilityRequestV1 {
  const input = inspectMemoryRecord(value, [
    'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'policyRef',
    'policyGeneration', 'consent', 'kind', 'sensitivity', 'sourceKinds',
    'retentionPolicyRef'
  ])
  const sourceKinds = parseUniqueEnumArray(
    input.sourceKinds,
    MEMORY_SOURCE_KINDS,
    MEMORY_RESOURCE_LIMITS.sources
  )
  if (sourceKinds.length === 0) return invalidMemoryValue()
  return Object.freeze({
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    accountId: parseMemoryQqIdV1(input.accountId),
    sceneRef: parseSceneRef(input.sceneRef),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    generation: positiveInteger(input.generation),
    policyRef: parseOpaqueRef(input.policyRef, 'policy:'),
    policyGeneration: positiveInteger(input.policyGeneration),
    consent: enumValue(input.consent, ['owner_policy', 'group_policy'] as const),
    kind: enumValue(input.kind, MEMORY_KINDS),
    sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
    sourceKinds,
    retentionPolicyRef: parseOpaqueRef(input.retentionPolicyRef, 'retention:')
  })
}

export function memoryPolicyCapabilityAllowsV1 (
  capabilityValue: unknown,
  requestValue: unknown,
  freshNowValue: unknown
): boolean {
  if (capabilityValue === null || typeof capabilityValue !== 'object' ||
    utilTypes.isProxy(capabilityValue) ||
    !policyCapabilities.has(capabilityValue as MemoryPolicyCapabilityV1)) return false
  const capability = capabilityValue as MemoryPolicyCapabilityV1
  const state = policyStates.get(capability)
  if (state === undefined) return false
  try {
    const request = parseMemoryPolicyCapabilityRequestV1(requestValue)
    return freshAt(state, freshNowValue) &&
      capability.botInstanceId === request.botInstanceId &&
      capability.accountId === request.accountId &&
      capability.sceneRef === request.sceneRef &&
      capability.namespaceRef === request.namespaceRef &&
      capability.generation === request.generation &&
      capability.policyRef === request.policyRef &&
      capability.policyGeneration === request.policyGeneration &&
      capability.consent === request.consent &&
      state.allowedKinds.has(request.kind) &&
      state.allowedSensitivities.has(request.sensitivity) &&
      request.sourceKinds.every(kind => state.allowedSourceKinds.has(kind)) &&
      state.allowedRetentionPolicyRefs.has(request.retentionPolicyRef)
  } catch {
    return false
  }
}

export function memoryLifecycleActorCapabilityRoleV1 (
  capabilityValue: unknown
): MemoryLifecycleActorRoleV1 | null {
  if (capabilityValue === null || typeof capabilityValue !== 'object' ||
    utilTypes.isProxy(capabilityValue) ||
    !actorCapabilities.has(capabilityValue as MemoryLifecycleActorCapabilityV1)) return null
  return actorStates.get(capabilityValue as MemoryLifecycleActorCapabilityV1)?.role ?? null
}

export function memoryMaintenanceCapabilityAllowsV1 (
  capabilityValue: unknown,
  requestValue: unknown,
  freshNowValue: unknown
): boolean {
  if (capabilityValue === null || typeof capabilityValue !== 'object' ||
    utilTypes.isProxy(capabilityValue) ||
    !maintenanceCapabilities.has(capabilityValue as MemoryMaintenanceCapabilityV1)) return false
  const capability = capabilityValue as MemoryMaintenanceCapabilityV1
  const state = maintenanceStates.get(capability)
  if (state === undefined) return false
  try {
    const request = parseMemoryMaintenanceAuthorityContextV1(requestValue)
    return freshAt(state, freshNowValue) &&
      capability.botInstanceId === request.botInstanceId &&
      capability.accountId === request.accountId &&
      capability.namespaceRef === request.namespaceRef &&
      capability.currentGeneration === request.currentGeneration &&
      capability.targetGeneration === request.targetGeneration &&
      capability.deletionRef === request.deletionRef &&
      capability.operation === request.operation &&
      capability.limit === request.limit
  } catch {
    return false
  }
}
