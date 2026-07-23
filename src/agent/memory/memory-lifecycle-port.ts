import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1,
  memoryMaintenanceCapabilityAllowsRequestV1,
  memoryPolicyCapabilityAllowsBindingV1,
  type MemoryLifecycleActorActionV1,
  type MemoryLifecycleActorAuthorityRequirementV1,
  type MemoryLifecycleActorCapabilityV1,
  type MemoryMaintenanceCapabilityV1,
  type MemoryPolicyCapabilityV1
} from './memory-lifecycle-authority.js'
import {
  memoryLifecycleCommandHashV1,
  memoryLifecycleCommandRefHashV1,
  parseMemoryLifecycleCommandV1,
  decodeMemoryLifecycleCommandWireV1,
  type MemoryLifecycleCommandV1,
  type MemoryLifecycleCommandWireV1,
  type MemoryProposalApprovalMaterialV1
} from './memory-lifecycle-command.js'
import {
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleInstantV1,
  type MemoryConsentEvidenceV1,
  type MemoryProposalV2
} from './memory-lifecycle-domain.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  createMemoryLifecycleResultV1,
  memoryLifecycleResolveRefV1,
  memoryLifecycleResultIsLedgerStableV1,
  memoryLifecycleStableResultHashV1,
  parseMemoryLifecycleResultV1,
  type MemoryLifecycleResultV1
} from './memory-lifecycle-result.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue
} from './memory-namespace.js'

export const MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_HASH_DOMAIN_V1 =
  'groupmate.memory.lifecycle-maintenance-actor.v1'
export const MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 =
  `actor:${memoryLifecycleDomainHashV1(
    MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_HASH_DOMAIN_V1,
    'system:memory-lifecycle-maintenance:v1'
  )}`

export type MemoryLifecycleEnvelopeAuthorityV1 =
  | {
      readonly kind: 'actor'
      readonly capability: MemoryLifecycleActorCapabilityV1
    }
  | {
      readonly kind: 'policy'
      readonly capability: MemoryPolicyCapabilityV1
    }
  | {
      readonly kind: 'maintenance'
      readonly capability: MemoryMaintenanceCapabilityV1
    }

export interface MemoryLifecycleAuthorizationEnvelopeV1 {
  readonly schemaVersion: 1
  readonly command: MemoryLifecycleCommandV1
  readonly access: MemoryAccessCapabilityV1
  readonly authority: MemoryLifecycleEnvelopeAuthorityV1
}

export interface MemoryLifecycleAdapterV1 {
  /**
   * The outer port check is advisory. Under the Task 6 write lock, the adapter must freeze one
   * trusted fresh time and revalidate the exact access capability, authority capability, operation,
   * namespace generation and canonical before/after predicates. Policy approval must load the exact
   * canonical proposal and bind its consent, policy ref/generation, kind, sensitivity, every source
   * kind and retention policy to the transient branded policy capability. The command wire alone is
   * never sufficient for that decision. Delete-only not-found and revision/generation conflicts must
   * be projected to opaque_not_applied before commit. A ledger-stable result may be returned only
   * after its exact canonical result wire has committed to the command ledger; all other outcomes
   * remain transient.
   */
  readonly execute: (
    envelope: MemoryLifecycleAuthorizationEnvelopeV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface MemoryLifecyclePortV1 {
  readonly execute: (
    envelope: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryLifecycleResultV1>
}

export interface MemoryLifecyclePortOptionsV1 extends MemoryLifecycleAdapterV1 {
  readonly now: () => string
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

function parseEnvelopeAuthority (value: unknown): MemoryLifecycleEnvelopeAuthorityV1 {
  const discriminator = inspectMemoryRecord(value, ['kind', 'capability'])
  if (!plainCapabilityObject(discriminator.capability)) return invalidMemoryValue()
  if (discriminator.kind === 'actor') {
    return Object.freeze({
      kind: 'actor' as const,
      capability: discriminator.capability as MemoryLifecycleActorCapabilityV1
    })
  }
  if (discriminator.kind === 'policy') {
    return Object.freeze({
      kind: 'policy' as const,
      capability: discriminator.capability as MemoryPolicyCapabilityV1
    })
  }
  if (discriminator.kind === 'maintenance') {
    return Object.freeze({
      kind: 'maintenance' as const,
      capability: discriminator.capability as MemoryMaintenanceCapabilityV1
    })
  }
  return invalidMemoryValue()
}

function parseMemoryLifecycleAuthorizationEnvelopeV1 (
  value: unknown
): MemoryLifecycleAuthorizationEnvelopeV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'command', 'access', 'authority'
  ])
  if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    command: parseMemoryLifecycleCommandV1(input.command),
    access: input.access as MemoryAccessCapabilityV1,
    authority: parseEnvelopeAuthority(input.authority)
  })
}

function actorAllows (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  wire: MemoryLifecycleCommandWireV1,
  action: MemoryLifecycleActorActionV1,
  requiredAuthority: MemoryLifecycleActorAuthorityRequirementV1,
  freshNow: string
): boolean {
  if (envelope.authority.kind !== 'actor') return false
  return memoryLifecycleActorCapabilityAllowsV1(envelope.authority.capability, {
    botInstanceId: envelope.access.botInstanceId,
    accountId: envelope.access.accountId,
    sceneRef: envelope.access.sceneRef,
    namespaceRef: wire.namespaceRef,
    generation: wire.expectedNamespaceGeneration,
    actorRef: wire.initiatedByActorRef,
    action,
    requiredAuthority
  }, freshNow)
}

function proposalForCreate (
  command: MemoryLifecycleCommandV1,
  operation: 'proposal.create' | 'proposal.createAndApprove'
): MemoryProposalV2 {
  if (operation === 'proposal.create') return command.material as MemoryProposalV2
  return (command.material as MemoryProposalApprovalMaterialV1).proposal
}

function policyAllowsApproval (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  wire: MemoryLifecycleCommandWireV1,
  evidence: MemoryConsentEvidenceV1,
  freshNow: string
): boolean {
  if (envelope.authority.kind !== 'policy' ||
    (evidence.evidenceKind !== 'owner_policy' && evidence.evidenceKind !== 'group_policy') ||
    evidence.policyRef === null || evidence.policyGeneration === null) return false

  return memoryPolicyCapabilityAllowsBindingV1(envelope.authority.capability, {
    botInstanceId: envelope.access.botInstanceId,
    accountId: envelope.access.accountId,
    sceneRef: envelope.access.sceneRef,
    namespaceRef: wire.namespaceRef,
    generation: wire.expectedNamespaceGeneration,
    policyRef: evidence.policyRef,
    policyGeneration: evidence.policyGeneration,
    consent: evidence.evidenceKind,
    createdByActorRef: wire.initiatedByActorRef
  }, freshNow)
}

function maintenanceAllowsExpire (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  wire: MemoryLifecycleCommandWireV1,
  freshNow: string
): boolean {
  return envelope.authority.kind === 'maintenance' &&
    wire.initiatedByActorRef === MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 &&
    memoryMaintenanceCapabilityAllowsRequestV1(envelope.authority.capability, {
      botInstanceId: envelope.access.botInstanceId,
      accountId: envelope.access.accountId,
      namespaceRef: wire.namespaceRef,
      currentGeneration: wire.expectedNamespaceGeneration,
      targetGeneration: wire.expectedNamespaceGeneration,
      deletionRef: null,
      operation: 'proposal.expireDue',
      limit: 1
    }, freshNow)
}

function authorityAllows (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  wire: MemoryLifecycleCommandWireV1,
  freshNow: string
): boolean {
  if (wire.operation === 'proposal.create') {
    const proposal = proposalForCreate(envelope.command, wire.operation)
    return actorAllows(
      envelope,
      wire,
      proposal.intent.kind === 'correction' ? 'propose_correction' : 'propose_create',
      'safe',
      freshNow
    )
  }
  if (wire.operation === 'proposal.createAndApprove') {
    const proposal = proposalForCreate(envelope.command, wire.operation)
    if (envelope.authority.kind !== 'actor' ||
      memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability) !== 'personal_subject') {
      return false
    }
    const proposeAction = proposal.intent.kind === 'correction'
      ? 'propose_correction'
      : 'propose_create'
    return actorAllows(envelope, wire, proposeAction, 'safe', freshNow) &&
      actorAllows(envelope, wire, 'approve', 'ordinary', freshNow)
  }
  if (wire.operation === 'proposal.approve') {
    const evidence = envelope.command.material as MemoryConsentEvidenceV1
    if (evidence.evidenceKind === 'explicit') {
      return actorAllows(envelope, wire, 'approve', 'ordinary', freshNow)
    }
    return policyAllowsApproval(envelope, wire, evidence, freshNow)
  }
  if (wire.operation === 'proposal.reject') {
    return actorAllows(envelope, wire, 'reject', 'ordinary', freshNow)
  }
  if (wire.operation === 'proposal.withdraw') {
    return actorAllows(envelope, wire, 'withdraw_own_proposal', 'safe', freshNow)
  }
  if (wire.operation === 'proposal.expire') {
    return maintenanceAllowsExpire(envelope, wire, freshNow)
  }
  if (wire.operation === 'record.correct') {
    return actorAllows(envelope, wire, 'correct', 'ordinary', freshNow)
  }
  if (wire.operation === 'record.renew') {
    return actorAllows(envelope, wire, 'renew', 'ordinary', freshNow)
  }
  if (wire.operation === 'record.changeConflict') {
    return actorAllows(envelope, wire, 'change_conflict', 'ordinary', freshNow)
  }
  if (wire.operation === 'record.forget') {
    if (envelope.authority.kind !== 'actor') return false
    const role = memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability)
    const hasExactExpectedState = wire.expectedRevision !== null &&
      wire.expectedAggregateHash !== null
    if (role === 'personal_bot_master' ? hasExactExpectedState : !hasExactExpectedState) {
      return false
    }
    return actorAllows(
      envelope,
      wire,
      'forget',
      role === 'personal_bot_master' ? 'delete_only' : 'ordinary',
      freshNow
    )
  }
  if (envelope.authority.kind !== 'actor') return false
  const role = memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability)
  return actorAllows(
    envelope,
    wire,
    'delete_namespace',
    role === 'personal_bot_master' ? 'delete_only' : 'elevated',
    freshNow
  )
}

type MemoryLifecycleResultPayloadV1 = MemoryLifecycleResultV1 extends infer Result
  ? Result extends MemoryLifecycleResultV1
    ? Omit<Result, 'schemaVersion' | 'operation' | 'commandHash'>
    : never
  : never

function portResult (
  wire: MemoryLifecycleCommandWireV1,
  commandHash: string,
  value: MemoryLifecycleResultPayloadV1
): MemoryLifecycleResultV1 {
  return createMemoryLifecycleResultV1({
    schemaVersion: 1,
    operation: wire.operation,
    commandHash,
    ...value
  })
}

function expectedStoredResultRef (
  command: MemoryLifecycleCommandV1,
  wire: MemoryLifecycleCommandWireV1
): string | null {
  if (wire.operation === 'proposal.create') {
    return (command.material as MemoryProposalV2).proposalId
  }
  if (wire.operation === 'proposal.createAndApprove') {
    return (command.material as MemoryProposalApprovalMaterialV1).record.memoryId
  }
  return wire.aggregateRef
}

function expectedStoredRevision (wire: MemoryLifecycleCommandWireV1): number | null {
  if (wire.operation === 'proposal.create' || wire.operation === 'proposal.createAndApprove') return 1
  if (wire.operation.startsWith('proposal.')) return 2
  if (wire.operation === 'record.correct' || wire.operation === 'record.renew' ||
    wire.operation === 'record.changeConflict') {
    return (wire.expectedRevision as number) + 1
  }
  return null
}

function adapterResultBindsCommand (
  result: MemoryLifecycleResultV1,
  command: MemoryLifecycleCommandV1,
  wire: MemoryLifecycleCommandWireV1,
  commandHash: string
): boolean {
  if (result.operation !== wire.operation || result.commandHash !== commandHash) return false
  if ((result.status === 'stored' || result.status === 'unchanged') && 'resultRef' in result) {
    return result.resultRef === expectedStoredResultRef(command, wire) &&
      result.resultRevision === expectedStoredRevision(wire)
  }
  if ('receipt' in result) {
    const receipt = result.receipt
    if (receipt === undefined) return false
    if (receipt.commandRefHash !== memoryLifecycleCommandRefHashV1(wire.commandRef) ||
      receipt.namespaceRef !== wire.namespaceRef ||
      receipt.generationBefore !== wire.expectedNamespaceGeneration ||
      receipt.deletingGeneration !== wire.expectedNamespaceGeneration) return false
    if (wire.operation === 'record.forget') {
      return receipt.operation === 'forget' && receipt.memoryId === wire.aggregateRef &&
        (wire.expectedRevision === null || receipt.deletedRevision === wire.expectedRevision) &&
        receipt.generationAfter === wire.expectedNamespaceGeneration
    }
    return wire.operation === 'namespace.delete' && receipt.operation === 'delete_namespace' &&
      receipt.memoryId === null && receipt.deletedRevision === null &&
      receipt.generationAfter === wire.expectedNamespaceGeneration + 1
  }
  return true
}

function projectDeleteOnlyResult (
  envelope: MemoryLifecycleAuthorizationEnvelopeV1,
  wire: MemoryLifecycleCommandWireV1,
  commandHash: string,
  result: MemoryLifecycleResultV1
): MemoryLifecycleResultV1 {
  if (envelope.authority.kind !== 'actor' ||
    memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability) !== 'personal_bot_master' ||
    (wire.operation !== 'record.forget' && wire.operation !== 'namespace.delete')) return result
  if (result.status === 'not_found' ||
    (result.status === 'conflict' && result.category !== 'idempotency')) {
    return portResult(wire, commandHash, { status: 'opaque_not_applied' })
  }
  return result
}

export function createMemoryLifecyclePortV1 (
  optionsValue: MemoryLifecyclePortOptionsV1
): MemoryLifecyclePortV1 {
  const options = inspectMemoryRecord(optionsValue, ['now', 'execute'])
  if (typeof options.now !== 'function' || typeof options.execute !== 'function' ||
    utilTypes.isProxy(options.now) || utilTypes.isProxy(options.execute)) return invalidMemoryValue()
  const now = options.now as MemoryLifecyclePortOptionsV1['now']
  const adapterExecute = options.execute as MemoryLifecycleAdapterV1['execute']

  const execute = async (
    envelopeValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryLifecycleResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const envelope = parseMemoryLifecycleAuthorizationEnvelopeV1(envelopeValue)
      const wire = decodeMemoryLifecycleCommandWireV1(envelope.command.wire)
      const commandHash = memoryLifecycleCommandHashV1(envelope.command.wire)
      if (signalScope.isAborted()) {
        return portResult(wire, commandHash, { status: 'aborted' })
      }
      let freshNow: string
      try {
        freshNow = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
      } catch {
        return invalidMemoryValue()
      }

      if (!memoryAccessCapabilityAllowsV1(envelope.access, wire.namespaceRef, freshNow)) {
        return portResult(wire, commandHash, {
          status: 'denied', category: 'access'
        })
      }
      if (!authorityAllows(envelope, wire, freshNow)) {
        return portResult(wire, commandHash, {
          status: 'denied', category: 'authority'
        })
      }
      let adapterValue: unknown
      try {
        adapterValue = await Reflect.apply(adapterExecute, undefined, [
          envelope,
          signalScope.signal
        ])
      } catch {
        if (signalScope.isAborted()) {
          return portResult(wire, commandHash, {
            status: 'resolve_required',
            category: 'outcome_unknown',
            resolveRef: memoryLifecycleResolveRefV1(commandHash)
          })
        }
        return portResult(wire, commandHash, {
          status: 'unavailable', category: 'io', retryable: true
        })
      }

      let result: MemoryLifecycleResultV1
      try {
        result = parseMemoryLifecycleResultV1(adapterValue)
        if (!adapterResultBindsCommand(result, envelope.command, wire, commandHash) ||
          (result.status === 'committed_after_abort' && !signalScope.isAborted()) ||
          (result.status === 'resolve_required' && !signalScope.isAborted()) ||
          (result.status === 'aborted' && !signalScope.isAborted())) {
          return invalidMemoryValue()
        }
      } catch {
        if (signalScope.isAborted()) {
          return portResult(wire, commandHash, {
            status: 'resolve_required',
            category: 'outcome_unknown',
            resolveRef: memoryLifecycleResolveRefV1(commandHash)
          })
        }
        return portResult(wire, commandHash, {
          status: 'corrupt', category: 'adapter_contract'
        })
      }

      result = projectDeleteOnlyResult(envelope, wire, commandHash, result)
      const committedResultHash = signalScope.isAborted() &&
        memoryLifecycleResultIsLedgerStableV1(result)
        ? memoryLifecycleStableResultHashV1(result)
        : null
      if (committedResultHash !== null) {
        return portResult(wire, commandHash, {
          status: 'committed_after_abort',
          resolveRef: memoryLifecycleResolveRefV1(commandHash),
          committedResultHash,
          ...('receipt' in result ? { receipt: result.receipt } : {})
        })
      }
      return result
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ execute })
}
