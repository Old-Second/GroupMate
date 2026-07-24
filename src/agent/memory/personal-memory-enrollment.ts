import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  memoryAccessSceneRefV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import {
  parseMemorySourceV1,
  type MemorySourceV1
} from './memory-domain.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  type MemoryLifecycleActorCapabilityV1
} from './memory-lifecycle-authority.js'
import {
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleHashV1,
  parseMemoryLifecycleInstantV1,
  parseMemoryLifecyclePositiveIntegerV1
} from './memory-lifecycle-domain.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import { MEMORY_DERIVATIVE_RESOURCE_LIMITS } from './memory-resource-limits.js'

export const PERSONAL_MEMORY_ENROLLMENT_COMMAND_HASH_DOMAIN_V1 =
  'groupmate.memory.personal-enrollment-command.v1'
export const PERSONAL_MEMORY_ENROLLMENT_COMMAND_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.personal-enrollment-command-ref.v1'
export const PERSONAL_MEMORY_ENROLLMENT_ACTOR_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.personal-enrollment-actor-ref.v1'
export const PERSONAL_MEMORY_ENROLLMENT_SOURCE_REF_HASH_DOMAIN_V1 =
  'groupmate.memory.personal-enrollment-source-ref.v1'
export const PERSONAL_MEMORY_ENROLLMENT_POLICY_HASH_DOMAIN_V1 =
  'groupmate.memory.personal-enrollment-policy.v1'

export type PersonalMemoryEnrollmentOperationV1 =
  | 'enrollment.optIn'
  | 'enrollment.optOut'

export type PersonalMemoryEnrollmentStateV1 = 'opted_out' | 'opted_in'
export type PersonalMemoryEnrollmentCandidateModeV1 =
  | 'off'
  | 'shadow'
  | 'policy_approved'

export interface PersonalMemoryEnrollmentCommandWireV1 {
  readonly schemaVersion: 1
  readonly commandRef: string
  readonly operation: PersonalMemoryEnrollmentOperationV1
  readonly initiatedByActorRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly expectedNamespaceGeneration: number
  readonly expectedPolicyGeneration: number
  readonly candidateMode: PersonalMemoryEnrollmentCandidateModeV1
  readonly occurredAt: string
  readonly sourceId: string
}

export interface PersonalMemoryEnrollmentCommandV1 {
  readonly wire: string
  readonly source: MemorySourceV1
}

export interface PersonalMemoryEnrollmentPolicyV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly state: PersonalMemoryEnrollmentStateV1
  readonly candidateMode: PersonalMemoryEnrollmentCandidateModeV1
  readonly policyGeneration: number
  readonly commandRefHash: string
  readonly commandHash: string
  readonly decidedByActorRefHash: string
  readonly decisionSourceRefHash: string
  readonly updatedAt: string
  readonly policyHash: string
}

type PersonalMemoryEnrollmentPolicyBaseV1 = Omit<
  PersonalMemoryEnrollmentPolicyV1,
  'policyHash'
>

export interface PersonalMemoryEnrollmentReadRequestV1 {
  readonly schemaVersion: 1
  readonly namespace: MemoryNamespaceV1
  readonly access: MemoryAccessCapabilityV1
}

export interface PersonalMemoryEnrollmentAdapterReadRequestV1 {
  readonly schemaVersion: 1
  readonly namespace: MemoryNamespaceV1
  readonly namespaceRef: MemoryNamespaceRefV1
}

export interface PersonalMemoryEnrollmentDecisionEnvelopeV1 {
  readonly schemaVersion: 1
  readonly namespace: MemoryNamespaceV1
  readonly command: PersonalMemoryEnrollmentCommandV1
  readonly access: MemoryAccessCapabilityV1
  readonly actor: MemoryLifecycleActorCapabilityV1
}

export type PersonalMemoryEnrollmentReadResultV1 =
  | { readonly status: 'found'; readonly policy: PersonalMemoryEnrollmentPolicyV1 }
  | { readonly status: 'not_enrolled' }
  | { readonly status: 'denied' }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'aborted' }

export type PersonalMemoryEnrollmentDecisionResultV1 =
  | {
      readonly status: 'stored' | 'unchanged'
      readonly policy: PersonalMemoryEnrollmentPolicyV1
    }
  | { readonly status: 'denied'; readonly category: 'access' | 'authority' }
  | { readonly status: 'conflict'; readonly category: 'generation' | 'idempotency' }
  | { readonly status: 'capacity'; readonly category: 'namespaces' | 'canonical_bytes' }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'resolve_required'; readonly category: 'outcome_unknown' }
  | { readonly status: 'aborted' }

export interface PersonalMemoryEnrollmentAdapterV1 {
  readonly read: (
    request: PersonalMemoryEnrollmentAdapterReadRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
  readonly decide: (
    envelope: PersonalMemoryEnrollmentDecisionEnvelopeV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface PersonalMemoryEnrollmentPortV1 {
  readonly read: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<PersonalMemoryEnrollmentReadResultV1>
  readonly decide: (
    envelope: unknown,
    signal?: AbortSignal
  ) => Promise<PersonalMemoryEnrollmentDecisionResultV1>
}

export interface CreatePersonalMemoryEnrollmentPortOptionsV1
  extends PersonalMemoryEnrollmentAdapterV1 {
  readonly now: () => string
}

const COMMAND_REF = /^command:[0-9a-f]{64}$/
const ACTOR_REF = /^actor:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const OPERATIONS = Object.freeze([
  'enrollment.optIn', 'enrollment.optOut'
] as const)
const STATES = Object.freeze(['opted_out', 'opted_in'] as const)
const CANDIDATE_MODES = Object.freeze([
  'off', 'shadow', 'policy_approved'
] as const)

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function commandRef (value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_REF.test(value)) return invalidMemoryValue()
  return value
}

function actorRef (value: unknown): string {
  if (typeof value !== 'string' || !ACTOR_REF.test(value)) return invalidMemoryValue()
  return value
}

function sourceId (value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return invalidMemoryValue()
  return value
}

function plainCapabilityObject (value: unknown): value is object {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Reflect.ownKeys(value).every(key => {
      const descriptor = descriptors[key as keyof typeof descriptors]
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    })
  } catch {
    return false
  }
}

function parseCommandWireObject (value: unknown): PersonalMemoryEnrollmentCommandWireV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
    'expectedNamespaceGeneration', 'expectedPolicyGeneration', 'candidateMode',
    'occurredAt', 'sourceId'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(input.operation, OPERATIONS)
  const candidateMode = enumValue(input.candidateMode, CANDIDATE_MODES)
  if (operation === 'enrollment.optOut' && candidateMode !== 'off') {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    commandRef: commandRef(input.commandRef),
    operation,
    initiatedByActorRef: actorRef(input.initiatedByActorRef),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    expectedNamespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(
      input.expectedNamespaceGeneration
    ),
    expectedPolicyGeneration: nonnegativeInteger(input.expectedPolicyGeneration),
    candidateMode,
    occurredAt: parseMemoryLifecycleInstantV1(input.occurredAt),
    sourceId: sourceId(input.sourceId)
  })
}

export function encodePersonalMemoryEnrollmentCommandWireV1 (value: unknown): string {
  const wire = JSON.stringify(parseCommandWireObject(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes) return invalidMemoryValue()
  return wire
}

export function decodePersonalMemoryEnrollmentCommandWireV1 (
  raw: unknown
): PersonalMemoryEnrollmentCommandWireV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes) return invalidMemoryValue()
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parseCommandWireObject(value)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

export function createPersonalMemoryEnrollmentCommandV1 (
  value: unknown
): PersonalMemoryEnrollmentCommandV1 {
  const input = inspectMemoryRecord(value, [
    'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
    'expectedNamespaceGeneration', 'expectedPolicyGeneration', 'candidateMode',
    'occurredAt', 'source'
  ])
  const source = parseMemorySourceV1(input.source)
  if (source.sourceKind !== 'current_message') return invalidMemoryValue()
  const wire = encodePersonalMemoryEnrollmentCommandWireV1({
    schemaVersion: 1,
    commandRef: input.commandRef,
    operation: input.operation,
    initiatedByActorRef: input.initiatedByActorRef,
    namespaceRef: input.namespaceRef,
    expectedNamespaceGeneration: input.expectedNamespaceGeneration,
    expectedPolicyGeneration: input.expectedPolicyGeneration,
    candidateMode: input.candidateMode,
    occurredAt: input.occurredAt,
    sourceId: source.sourceId
  })
  const decoded = decodePersonalMemoryEnrollmentCommandWireV1(wire)
  if (source.observedAt !== decoded.occurredAt) return invalidMemoryValue()
  return Object.freeze({ wire, source })
}

export function parsePersonalMemoryEnrollmentCommandV1 (
  value: unknown
): PersonalMemoryEnrollmentCommandV1 {
  const input = inspectMemoryRecord(value, ['wire', 'source'])
  const wire = decodePersonalMemoryEnrollmentCommandWireV1(input.wire)
  const source = parseMemorySourceV1(input.source)
  if (source.sourceKind !== 'current_message' || source.sourceId !== wire.sourceId ||
    source.observedAt !== wire.occurredAt) return invalidMemoryValue()
  return Object.freeze({ wire: input.wire as string, source })
}

export function personalMemoryEnrollmentCommandHashV1 (wire: unknown): string {
  const canonical = encodePersonalMemoryEnrollmentCommandWireV1(
    decodePersonalMemoryEnrollmentCommandWireV1(wire)
  )
  return memoryLifecycleDomainHashV1(
    PERSONAL_MEMORY_ENROLLMENT_COMMAND_HASH_DOMAIN_V1,
    canonical
  )
}

function refHash (domain: string, value: string): string {
  return memoryLifecycleDomainHashV1(domain, value)
}

export function personalMemoryEnrollmentCommandRefHashV1 (value: unknown): string {
  return refHash(PERSONAL_MEMORY_ENROLLMENT_COMMAND_REF_HASH_DOMAIN_V1, commandRef(value))
}

export function personalMemoryEnrollmentActorRefHashV1 (value: unknown): string {
  return refHash(PERSONAL_MEMORY_ENROLLMENT_ACTOR_REF_HASH_DOMAIN_V1, actorRef(value))
}

export function personalMemoryEnrollmentSourceRefHashV1 (value: unknown): string {
  return refHash(PERSONAL_MEMORY_ENROLLMENT_SOURCE_REF_HASH_DOMAIN_V1, sourceId(value))
}

function parsePolicyBase (value: unknown): PersonalMemoryEnrollmentPolicyBaseV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'state', 'candidateMode',
    'policyGeneration', 'commandRefHash', 'commandHash', 'decidedByActorRefHash',
    'decisionSourceRefHash', 'updatedAt'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const state = enumValue(input.state, STATES)
  const candidateMode = enumValue(input.candidateMode, CANDIDATE_MODES)
  if (state === 'opted_out' && candidateMode !== 'off') return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
    state,
    candidateMode,
    policyGeneration: parseMemoryLifecyclePositiveIntegerV1(input.policyGeneration),
    commandRefHash: parseMemoryLifecycleHashV1(input.commandRefHash),
    commandHash: parseMemoryLifecycleHashV1(input.commandHash),
    decidedByActorRefHash: parseMemoryLifecycleHashV1(input.decidedByActorRefHash),
    decisionSourceRefHash: parseMemoryLifecycleHashV1(input.decisionSourceRefHash),
    updatedAt: parseMemoryLifecycleInstantV1(input.updatedAt)
  })
}

function policyHashForBase (base: PersonalMemoryEnrollmentPolicyBaseV1): string {
  return memoryLifecycleDomainHashV1(
    PERSONAL_MEMORY_ENROLLMENT_POLICY_HASH_DOMAIN_V1,
    JSON.stringify(base)
  )
}

export function createPersonalMemoryEnrollmentPolicyV1 (
  value: unknown
): PersonalMemoryEnrollmentPolicyV1 {
  const base = parsePolicyBase(value)
  return Object.freeze({ ...base, policyHash: policyHashForBase(base) })
}

function parsePolicy (value: unknown): PersonalMemoryEnrollmentPolicyV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'state', 'candidateMode',
    'policyGeneration', 'commandRefHash', 'commandHash', 'decidedByActorRefHash',
    'decisionSourceRefHash', 'updatedAt', 'policyHash'
  ])
  const base = parsePolicyBase({
    schemaVersion: input.schemaVersion,
    namespaceRef: input.namespaceRef,
    namespaceGeneration: input.namespaceGeneration,
    state: input.state,
    candidateMode: input.candidateMode,
    policyGeneration: input.policyGeneration,
    commandRefHash: input.commandRefHash,
    commandHash: input.commandHash,
    decidedByActorRefHash: input.decidedByActorRefHash,
    decisionSourceRefHash: input.decisionSourceRefHash,
    updatedAt: input.updatedAt
  })
  const policyHash = parseMemoryLifecycleHashV1(input.policyHash)
  if (policyHash !== policyHashForBase(base)) return invalidMemoryValue()
  return Object.freeze({ ...base, policyHash })
}

export function encodePersonalMemoryEnrollmentPolicyV1 (value: unknown): string {
  const wire = JSON.stringify(parsePolicy(value))
  if (Buffer.byteLength(wire, 'utf8') >
    MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes) return invalidMemoryValue()
  return wire
}

export function decodePersonalMemoryEnrollmentPolicyV1 (
  raw: unknown
): PersonalMemoryEnrollmentPolicyV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
    MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes) return invalidMemoryValue()
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parsePolicy(value)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

export function personalMemoryEnrollmentSourceSceneRefV1 (sourceValue: unknown): string {
  const source = parseMemorySourceV1(sourceValue)
  if (source.scene.kind === 'private') {
    return memoryAccessSceneRefV1({
      kind: 'private',
      peerUserId: source.actor.userId
    })
  }
  return memoryAccessSceneRefV1({
    kind: 'group',
    groupId: source.scene.groupId,
    groupLifecycleId: source.scene.groupLifecycleId,
    trustedMemberUserIds: [source.actor.userId],
    observedAt: source.observedAt
  })
}

function parseReadRequest (value: unknown): PersonalMemoryEnrollmentReadRequestV1 {
  const input = inspectMemoryRecord(value, ['schemaVersion', 'namespace', 'access'])
  if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access)) {
    return invalidMemoryValue()
  }
  const namespace = parseMemoryNamespaceV1(input.namespace)
  if (namespace.scope.kind !== 'personal') return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespace,
    access: input.access as MemoryAccessCapabilityV1
  })
}

export function parsePersonalMemoryEnrollmentDecisionEnvelopeV1 (
  value: unknown
): PersonalMemoryEnrollmentDecisionEnvelopeV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespace', 'command', 'access', 'actor'
  ])
  if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access) ||
    !plainCapabilityObject(input.actor)) return invalidMemoryValue()
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const command = parsePersonalMemoryEnrollmentCommandV1(input.command)
  const wire = decodePersonalMemoryEnrollmentCommandWireV1(command.wire)
  if (namespace.scope.kind !== 'personal' || memoryNamespaceRefV1(namespace) !== wire.namespaceRef ||
    command.source.actor.userId !== namespace.scope.subjectUserId) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespace,
    command,
    access: input.access as MemoryAccessCapabilityV1,
    actor: input.actor as MemoryLifecycleActorCapabilityV1
  })
}

function retryableForCategory (
  category: 'busy' | 'storage' | 'io',
  value: unknown
): boolean {
  if (typeof value !== 'boolean' || value !== (category !== 'storage')) {
    return invalidMemoryValue()
  }
  return value
}

function parseReadResult (
  value: unknown,
  namespaceRef: MemoryNamespaceRefV1,
  aborted: boolean
): PersonalMemoryEnrollmentReadResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], ['policy', 'category', 'retryable'])
  if (discriminator.status === 'found') {
    const input = inspectMemoryRecord(value, ['status', 'policy'])
    const policy = parsePolicy(input.policy)
    if (policy.namespaceRef !== namespaceRef) return invalidMemoryValue()
    return Object.freeze({ status: 'found' as const, policy })
  }
  if (discriminator.status === 'not_enrolled') {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'not_enrolled' as const })
  }
  if (discriminator.status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'corrupt' as const,
      category: enumValue(input.category, ['canonical_data', 'adapter_contract'] as const)
    })
  }
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    const category = enumValue(input.category, ['busy', 'storage', 'io'] as const)
    return Object.freeze({
      status: 'unavailable' as const,
      category,
      retryable: retryableForCategory(category, input.retryable)
    })
  }
  if (discriminator.status === 'aborted' && aborted) {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'aborted' as const })
  }
  return invalidMemoryValue()
}

function expectedPolicyForCommand (
  wire: PersonalMemoryEnrollmentCommandWireV1,
  policyGeneration: number
): Omit<PersonalMemoryEnrollmentPolicyBaseV1, 'updatedAt'> {
  return {
    schemaVersion: 1,
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    state: wire.operation === 'enrollment.optIn' ? 'opted_in' : 'opted_out',
    candidateMode: wire.candidateMode,
    policyGeneration,
    commandRefHash: personalMemoryEnrollmentCommandRefHashV1(wire.commandRef),
    commandHash: personalMemoryEnrollmentCommandHashV1(encodePersonalMemoryEnrollmentCommandWireV1(wire)),
    decidedByActorRefHash: personalMemoryEnrollmentActorRefHashV1(wire.initiatedByActorRef),
    decisionSourceRefHash: personalMemoryEnrollmentSourceRefHashV1(wire.sourceId)
  }
}

function policyBindsCommand (
  policy: PersonalMemoryEnrollmentPolicyV1,
  wire: PersonalMemoryEnrollmentCommandWireV1
): boolean {
  const expected = expectedPolicyForCommand(wire, wire.expectedPolicyGeneration + 1)
  return Object.entries(expected).every(([key, value]) => (
    policy[key as keyof PersonalMemoryEnrollmentPolicyV1] === value
  )) && Date.parse(policy.updatedAt) >= Date.parse(wire.occurredAt)
}

function parseDecisionResult (
  value: unknown,
  wire: PersonalMemoryEnrollmentCommandWireV1,
  aborted: boolean
): PersonalMemoryEnrollmentDecisionResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], ['policy', 'category', 'retryable'])
  if (discriminator.status === 'stored' || discriminator.status === 'unchanged') {
    const input = inspectMemoryRecord(value, ['status', 'policy'])
    const policy = parsePolicy(input.policy)
    if (!policyBindsCommand(policy, wire)) return invalidMemoryValue()
    return Object.freeze({ status: discriminator.status, policy })
  }
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'denied' as const,
      category: enumValue(input.category, ['access', 'authority'] as const)
    })
  }
  if (discriminator.status === 'conflict') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'conflict' as const,
      category: enumValue(input.category, ['generation', 'idempotency'] as const)
    })
  }
  if (discriminator.status === 'capacity') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'capacity' as const,
      category: enumValue(input.category, ['namespaces', 'canonical_bytes'] as const)
    })
  }
  if (discriminator.status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'corrupt' as const,
      category: enumValue(input.category, ['canonical_data', 'adapter_contract'] as const)
    })
  }
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    const category = enumValue(input.category, ['busy', 'storage', 'io'] as const)
    return Object.freeze({
      status: 'unavailable' as const,
      category,
      retryable: retryableForCategory(category, input.retryable)
    })
  }
  if (discriminator.status === 'resolve_required' && aborted) {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    if (input.category !== 'outcome_unknown') return invalidMemoryValue()
    return Object.freeze({ status: 'resolve_required' as const, category: 'outcome_unknown' as const })
  }
  if (discriminator.status === 'aborted' && aborted) {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'aborted' as const })
  }
  return invalidMemoryValue()
}

function accessBindsNamespace (
  capability: MemoryAccessCapabilityV1,
  namespace: MemoryNamespaceV1,
  now: string
): boolean {
  return capability.botInstanceId === namespace.botInstanceId &&
    capability.accountId === namespace.accountId &&
    memoryAccessCapabilityAllowsV1(capability, memoryNamespaceRefV1(namespace), now)
}

function trustedEnrollmentNow (source: () => string): string | null {
  try {
    return parseMemoryLifecycleInstantV1(Reflect.apply(source, undefined, []))
  } catch {
    return null
  }
}

export function createPersonalMemoryEnrollmentPortV1 (
  optionsValue: CreatePersonalMemoryEnrollmentPortOptionsV1
): PersonalMemoryEnrollmentPortV1 {
  const input = inspectMemoryRecord(optionsValue, ['now', 'read', 'decide'])
  if (typeof input.now !== 'function' || typeof input.read !== 'function' ||
    typeof input.decide !== 'function' || utilTypes.isProxy(input.now) ||
    utilTypes.isProxy(input.read) || utilTypes.isProxy(input.decide)) return invalidMemoryValue()
  const now = input.now as () => string
  const adapterRead = input.read as PersonalMemoryEnrollmentAdapterV1['read']
  const adapterDecide = input.decide as PersonalMemoryEnrollmentAdapterV1['decide']

  const read = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<PersonalMemoryEnrollmentReadResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseReadRequest(requestValue)
      const namespaceRef = memoryNamespaceRefV1(request.namespace)
      const freshNow = trustedEnrollmentNow(now)
      if (freshNow === null) {
        return Object.freeze({
          status: 'unavailable' as const,
          category: 'storage' as const,
          retryable: false
        })
      }
      if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
      if (!accessBindsNamespace(request.access, request.namespace, freshNow)) {
        return Object.freeze({ status: 'denied' as const })
      }
      let result: unknown
      try {
        result = await Reflect.apply(adapterRead, undefined, [Object.freeze({
          schemaVersion: 1 as const,
          namespace: request.namespace,
          namespaceRef
        }), signalScope.signal])
      } catch {
        if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
        return Object.freeze({
          status: 'unavailable' as const,
          category: 'io' as const,
          retryable: true
        })
      }
      if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
      const afterNow = trustedEnrollmentNow(now)
      if (afterNow === null) {
        return Object.freeze({
          status: 'unavailable' as const,
          category: 'storage' as const,
          retryable: false
        })
      }
      if (!accessBindsNamespace(request.access, request.namespace, afterNow)) {
        return Object.freeze({ status: 'denied' as const })
      }
      try {
        return parseReadResult(result, namespaceRef, signalScope.isAborted())
      } catch {
        return Object.freeze({
          status: 'corrupt' as const,
          category: 'adapter_contract' as const
        })
      }
    } finally {
      signalScope.close()
    }
  }

  const decide = async (
    envelopeValue: unknown,
    signal?: AbortSignal
  ): Promise<PersonalMemoryEnrollmentDecisionResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const envelope = parsePersonalMemoryEnrollmentDecisionEnvelopeV1(envelopeValue)
      const wire = decodePersonalMemoryEnrollmentCommandWireV1(envelope.command.wire)
      const freshNow = trustedEnrollmentNow(now)
      if (freshNow === null) {
        return Object.freeze({
          status: 'unavailable' as const,
          category: 'storage' as const,
          retryable: false
        })
      }
      if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
      if (!accessBindsNamespace(envelope.access, envelope.namespace, freshNow)) {
        return Object.freeze({ status: 'denied' as const, category: 'access' as const })
      }
      if (envelope.access.sceneRef !== envelope.actor.sceneRef ||
        envelope.access.sceneRef !== personalMemoryEnrollmentSourceSceneRefV1(
          envelope.command.source
        ) ||
        envelope.actor.botInstanceId !== envelope.namespace.botInstanceId ||
        envelope.actor.accountId !== envelope.namespace.accountId ||
        envelope.actor.actorRef !== wire.initiatedByActorRef ||
        !memoryLifecycleActorCapabilityAllowsV1(envelope.actor, {
          botInstanceId: envelope.namespace.botInstanceId,
          accountId: envelope.namespace.accountId,
          sceneRef: envelope.access.sceneRef,
          namespaceRef: wire.namespaceRef,
          generation: wire.expectedNamespaceGeneration,
          actorRef: wire.initiatedByActorRef,
          action: 'manage_enrollment',
          requiredAuthority: 'elevated'
        }, freshNow)) {
        return Object.freeze({ status: 'denied' as const, category: 'authority' as const })
      }
      let result: unknown
      try {
        result = await Reflect.apply(adapterDecide, undefined, [envelope, signalScope.signal])
      } catch {
        if (signalScope.isAborted()) {
          return Object.freeze({
            status: 'resolve_required' as const,
            category: 'outcome_unknown' as const
          })
        }
        return Object.freeze({
          status: 'unavailable' as const,
          category: 'io' as const,
          retryable: true
        })
      }
      try {
        return parseDecisionResult(result, wire, signalScope.isAborted())
      } catch {
        return Object.freeze({
          status: 'corrupt' as const,
          category: 'adapter_contract' as const
        })
      }
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ read, decide })
}
