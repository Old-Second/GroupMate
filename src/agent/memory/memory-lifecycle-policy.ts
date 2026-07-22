import type {
  MemoryKindV1,
  MemorySensitivityV1,
  MemorySourceV1
} from './memory-domain.js'
import { parseMemorySourceV1 } from './memory-domain.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1,
  type MemoryLifecycleActorActionV1,
  type MemoryLifecycleActorAuthorityRequirementV1
} from './memory-lifecycle-authority.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryBotInstanceIdV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js'

export type MemoryLifecycleConsentRequirementV1 =
  | 'explicit'
  | 'owner_policy'
  | 'group_policy'

export type MemoryLifecycleCanonicalAuthorityRequirementV1 =
  | 'none'
  | 'ordinary'
  | 'elevated'

export type MemoryLifecycleTargetModeV1 =
  | 'none'
  | 'expected_revision'
  | 'opaque_delete_only'

export interface MemoryLifecycleActorPolicyRequestV1 {
  readonly botInstanceId: string
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: string
  readonly generation: number
  readonly actorRef: string
  readonly action: MemoryLifecycleActorActionV1
  /**
   * These two values are an adapter-internal projection of canonical before/after
   * objects read under the SQLite write lock. Commands, model output and service
   * prechecks are not trusted sources for either value.
   */
  readonly beforeRequirement: MemoryLifecycleCanonicalAuthorityRequirementV1
  readonly afterRequirement: MemoryLifecycleCanonicalAuthorityRequirementV1
  readonly initiatedByActorRef: string | null
  readonly targetMode: MemoryLifecycleTargetModeV1
  readonly expectedRevision: number | null
}

export interface MemoryLifecycleActorPolicyDecisionV1 {
  readonly allowed: boolean
  readonly projection: 'none' | 'safe' | 'full' | 'delete_only'
  readonly reason:
    | null
    | 'invalid_request'
    | 'authority_denied'
    | 'not_own_proposal'
    | 'delete_only_target_required'
    | 'revision_target_required'
}

export interface GroupMemoryAdmissionV1 {
  readonly kind: MemoryKindV1
  readonly sensitivity: MemorySensitivityV1
  readonly sources: readonly MemorySourceV1[]
}

export type GroupMemoryAdmissionDecisionV1 =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason:
        | 'not_group_namespace'
        | 'kind_not_allowed'
        | 'sensitivity_not_allowed'
        | 'source_scene_not_allowed'
        | 'invalid_admission'
    }

const GROUP_MEMORY_KINDS: readonly MemoryKindV1[] = [
  'group_rule', 'group_culture', 'task_fact', 'other'
]
const MEMORY_KINDS: readonly MemoryKindV1[] = [
  'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
  'task_fact', 'other'
]
const MEMORY_SENSITIVITIES: readonly MemorySensitivityV1[] = [
  'public', 'group', 'personal', 'sensitive'
]
const ACTOR_ACTIONS: readonly MemoryLifecycleActorActionV1[] = [
  'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe',
  'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict',
  'forget', 'export', 'delete_namespace', 'resolve_deletion', 'claim_export'
]
const CANONICAL_REQUIREMENTS: readonly MemoryLifecycleCanonicalAuthorityRequirementV1[] = [
  'none', 'ordinary', 'elevated'
]
const TARGET_MODES: readonly MemoryLifecycleTargetModeV1[] = [
  'none', 'expected_revision', 'opaque_delete_only'
]

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

function parseSceneRef (value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalidMemoryValue()
  return value
}

function parseActorRef (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    typeof value !== 'string' || !/^actor:[0-9a-f]{64}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

export function parseMemoryLifecycleActorPolicyRequestV1 (
  value: unknown
): MemoryLifecycleActorPolicyRequestV1 {
  const input = inspectMemoryRecord(value, [
    'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
    'action', 'beforeRequirement', 'afterRequirement', 'initiatedByActorRef',
    'targetMode', 'expectedRevision'
  ])
  const targetMode = enumValue(input.targetMode, TARGET_MODES)
  const expectedRevision = input.expectedRevision === null
    ? null
    : positiveInteger(input.expectedRevision)
  if ((targetMode === 'expected_revision') !== (expectedRevision !== null)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    accountId: parseMemoryQqIdV1(input.accountId),
    sceneRef: parseSceneRef(input.sceneRef),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    generation: positiveInteger(input.generation),
    actorRef: parseActorRef(input.actorRef),
    action: enumValue(input.action, ACTOR_ACTIONS),
    beforeRequirement: enumValue(input.beforeRequirement, CANONICAL_REQUIREMENTS),
    afterRequirement: enumValue(input.afterRequirement, CANONICAL_REQUIREMENTS),
    initiatedByActorRef: input.initiatedByActorRef === null
      ? null
      : parseActorRef(input.initiatedByActorRef),
    targetMode,
    expectedRevision
  })
}

function denied (
  reason: Exclude<MemoryLifecycleActorPolicyDecisionV1['reason'], null>
): MemoryLifecycleActorPolicyDecisionV1 {
  return Object.freeze({ allowed: false, projection: 'none' as const, reason })
}

function maximumCanonicalRequirement (
  action: MemoryLifecycleActorActionV1,
  before: MemoryLifecycleCanonicalAuthorityRequirementV1,
  after: MemoryLifecycleCanonicalAuthorityRequirementV1
): MemoryLifecycleActorAuthorityRequirementV1 {
  if (before === 'elevated' || after === 'elevated') return 'elevated'
  if (before === 'ordinary' || after === 'ordinary' || ![
    'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe'
  ].includes(action)) return 'ordinary'
  return 'safe'
}

export function decideMemoryLifecycleActorPolicyV1 (
  capability: unknown,
  requestValue: unknown,
  freshNow: unknown
): MemoryLifecycleActorPolicyDecisionV1 {
  let request: MemoryLifecycleActorPolicyRequestV1
  try {
    request = parseMemoryLifecycleActorPolicyRequestV1(requestValue)
  } catch {
    return denied('invalid_request')
  }

  if (request.action === 'withdraw_own_proposal' &&
    request.initiatedByActorRef !== request.actorRef) return denied('not_own_proposal')

  const role = memoryLifecycleActorCapabilityRoleV1(capability)
  if (role === null) return denied('authority_denied')
  const deleteOnly = role === 'personal_bot_master'
  if (deleteOnly && request.action === 'forget' &&
    (request.targetMode !== 'opaque_delete_only' || request.expectedRevision !== null)) {
    return denied('delete_only_target_required')
  }
  if (!deleteOnly && request.action === 'forget' && request.targetMode !== 'expected_revision') {
    return denied('revision_target_required')
  }

  const requiredAuthority: MemoryLifecycleActorAuthorityRequirementV1 = deleteOnly
    ? 'delete_only'
    : maximumCanonicalRequirement(
        request.action,
        request.beforeRequirement,
        request.afterRequirement
      )
  if (!memoryLifecycleActorCapabilityAllowsV1(capability, {
    botInstanceId: request.botInstanceId,
    accountId: request.accountId,
    sceneRef: request.sceneRef,
    namespaceRef: request.namespaceRef,
    generation: request.generation,
    actorRef: request.actorRef,
    action: request.action,
    requiredAuthority
  }, freshNow)) return denied('authority_denied')

  const projection = deleteOnly
    ? 'delete_only'
    : request.action === 'list_safe'
      ? 'safe'
      : request.action === 'inspect_full' || request.action === 'export' ||
          request.action === 'claim_export'
        ? 'full'
        : 'none'
  return Object.freeze({ allowed: true, projection, reason: null })
}

export function memoryConsentMatchesNamespaceV1 (
  namespaceValue: unknown,
  consentValue: unknown
): boolean {
  try {
    const namespace = parseMemoryNamespaceV1(namespaceValue)
    const consent = enumValue(
      consentValue,
      ['explicit', 'owner_policy', 'group_policy'] as const
    )
    return consent === 'explicit' ||
      (namespace.scope.kind === 'personal' && consent === 'owner_policy') ||
      (namespace.scope.kind === 'group' && consent === 'group_policy')
  } catch {
    return false
  }
}

export function parseGroupMemoryAdmissionV1 (value: unknown): GroupMemoryAdmissionV1 {
  const input = inspectMemoryRecord(value, ['kind', 'sensitivity', 'sources'])
  const sources = inspectMemoryArray(input.sources, MEMORY_RESOURCE_LIMITS.sources)
    .map(parseMemorySourceV1)
  if (sources.length === 0) return invalidMemoryValue()
  return Object.freeze({
    kind: enumValue(input.kind, MEMORY_KINDS),
    sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
    sources: Object.freeze(sources)
  })
}

export function evaluateGroupMemoryAdmissionV1 (
  namespaceValue: unknown,
  admissionValue: unknown
): GroupMemoryAdmissionDecisionV1 {
  let namespace: MemoryNamespaceV1
  let admission: GroupMemoryAdmissionV1
  try {
    namespace = parseMemoryNamespaceV1(namespaceValue)
    admission = parseGroupMemoryAdmissionV1(admissionValue)
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_admission' as const })
  }
  if (namespace.scope.kind !== 'group') {
    return Object.freeze({ allowed: false, reason: 'not_group_namespace' as const })
  }
  if (!GROUP_MEMORY_KINDS.includes(admission.kind)) {
    return Object.freeze({ allowed: false, reason: 'kind_not_allowed' as const })
  }
  if (admission.sensitivity !== 'public' && admission.sensitivity !== 'group') {
    return Object.freeze({ allowed: false, reason: 'sensitivity_not_allowed' as const })
  }
  for (const source of admission.sources) {
    if (source.sourceKind === 'private_history' || source.scene.kind !== 'group' ||
      source.scene.groupId !== namespace.scope.groupId ||
      source.scene.groupLifecycleId !== namespace.scope.groupLifecycleId) {
      return Object.freeze({ allowed: false, reason: 'source_scene_not_allowed' as const })
    }
  }
  return Object.freeze({ allowed: true as const })
}
