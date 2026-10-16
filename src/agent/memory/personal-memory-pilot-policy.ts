import {
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js'

export type PersonalMemoryDeploymentModeV1 =
  | 'off'
  | 'explicit'
  | 'shadow'
  | 'automatic'

export type PersonalMemoryCandidateModeV1 =
  | 'off'
  | 'shadow'
  | 'policy_approved'

export interface PersonalMemoryEnrollmentV1 {
  readonly status: 'opted_out' | 'opted_in'
  readonly candidateMode: PersonalMemoryCandidateModeV1
}

export type PersonalMemoryPilotSceneV1 =
  | { readonly kind: 'private' }
  | { readonly kind: 'group'; readonly groupId: string }

export type PersonalMemoryPilotDisabledReasonV1 =
  | 'deployment_off'
  | 'user_opted_out'

export interface PersonalMemoryPilotDecisionV1 {
  readonly status: 'enabled' | 'disabled'
  readonly reason: 'enabled' | PersonalMemoryPilotDisabledReasonV1
  readonly recall: boolean
  readonly explicitWrite: boolean
  readonly shadowCandidate: boolean
  readonly automaticCandidate: boolean
}

export interface DecidePersonalMemoryPilotOptionsV1 {
  readonly deploymentMode: PersonalMemoryDeploymentModeV1
  readonly enrollment: PersonalMemoryEnrollmentV1
  readonly scene: PersonalMemoryPilotSceneV1
}

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function qqId (value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 ||
    value.length > MEMORY_RESOURCE_LIMITS.qqIdDigits || !/^\d+$/.test(value)) {
    return invalidMemoryValue()
  }
  return value
}

function parseEnrollment (value: unknown): PersonalMemoryEnrollmentV1 {
  const input = inspectMemoryRecord(value, ['status', 'candidateMode'])
  const status = enumValue(input.status, ['opted_out', 'opted_in'] as const)
  const candidateMode = enumValue(
    input.candidateMode,
    ['off', 'shadow', 'policy_approved'] as const
  )
  if (status === 'opted_out' && candidateMode !== 'off') return invalidMemoryValue()
  return Object.freeze({ status, candidateMode })
}

function parseScene (value: unknown): PersonalMemoryPilotSceneV1 {
  const discriminator = inspectMemoryRecord(value, ['kind'], ['groupId'])
  if (discriminator.kind === 'private') {
    if (Object.hasOwn(discriminator, 'groupId')) return invalidMemoryValue()
    return Object.freeze({ kind: 'private' as const })
  }
  if (discriminator.kind !== 'group' || !Object.hasOwn(discriminator, 'groupId')) {
    return invalidMemoryValue()
  }
  return Object.freeze({ kind: 'group' as const, groupId: qqId(discriminator.groupId) })
}

function disabledDecision (
  reason: PersonalMemoryPilotDisabledReasonV1
): PersonalMemoryPilotDecisionV1 {
  return Object.freeze({
    status: 'disabled' as const,
    reason,
    recall: false,
    explicitWrite: false,
    shadowCandidate: false,
    automaticCandidate: false
  })
}

export function decidePersonalMemoryPilotV1 (
  optionsValue: DecidePersonalMemoryPilotOptionsV1
): PersonalMemoryPilotDecisionV1 {
  const input = inspectMemoryRecord(optionsValue, [
    'deploymentMode', 'enrollment', 'scene'
  ])
  const deploymentMode = enumValue(
    input.deploymentMode,
    ['off', 'explicit', 'shadow', 'automatic'] as const
  )
  const enrollment = parseEnrollment(input.enrollment)
  // Every private and group scene participates by default; only the subject's durable opt-out narrows it.
  parseScene(input.scene)

  if (deploymentMode === 'off') return disabledDecision('deployment_off')
  if (enrollment.status === 'opted_out') return disabledDecision('user_opted_out')

  const automaticCandidate = deploymentMode === 'automatic' &&
    enrollment.candidateMode === 'policy_approved'
  const shadowCandidate = !automaticCandidate &&
    (deploymentMode === 'shadow' || deploymentMode === 'automatic') &&
    enrollment.candidateMode !== 'off'
  return Object.freeze({
    status: 'enabled' as const,
    reason: 'enabled' as const,
    recall: true,
    explicitWrite: true,
    shadowCandidate,
    automaticCandidate
  })
}
