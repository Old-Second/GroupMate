import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { memoryAccessCapabilityAllowsV1, type MemoryAccessCapabilityV1 } from './memory-access-gate.js'
import { memoryCandidateHashV1 } from './memory-candidate-pipeline.js'
import type {
  MemoryCandidateSubmissionResultV1,
  MemoryCandidateSubmissionV1
} from './memory-candidate-worker.js'
import {
  memoryCandidateSubmissionAllowsPolicyApprovalV1,
  parseMemoryCandidateSubmissionV1
} from './memory-candidate-worker.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1,
  memoryPolicyCapabilityAllowsBindingV1,
  memoryPolicyCapabilityAllowsV1,
  type MemoryLifecycleActorCapabilityV1,
  type MemoryPolicyCapabilityV1
} from './memory-lifecycle-authority.js'
import {
  buildMemoryProposalApprovalBundleV1,
  buildMemoryProposalDraftV2
} from './memory-lifecycle-builder.js'
import { createMemoryLifecycleCommandV1 } from './memory-lifecycle-command.js'
import type { MemoryLifecyclePortV1 } from './memory-lifecycle-port.js'
import type { MemoryLifecycleResultV1 } from './memory-lifecycle-result.js'
import { MEMORY_RETENTION_POLICY_REF_V1 } from './memory-lifecycle-domain.js'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'

export type MemoryCandidateAuthorizationResultV1 =
  | {
      readonly status: 'authorized'
      readonly access: MemoryAccessCapabilityV1
      readonly actor: MemoryLifecycleActorCapabilityV1
      readonly policy: MemoryPolicyCapabilityV1 | null
    }
  | { readonly status: 'denied'; readonly reason: 'policy' | 'scope' | 'authority' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }
  | { readonly status: 'aborted' }

export interface MemoryCandidateLifecycleSinkV1 {
  readonly submit: (
    input: MemoryCandidateSubmissionV1,
    signal?: AbortSignal
  ) => Promise<MemoryCandidateSubmissionResultV1>
}

export interface CreateMemoryCandidateLifecycleSinkOptionsV1 {
  readonly lifecycle: MemoryLifecyclePortV1
  readonly authorize: (
    input: MemoryCandidateSubmissionV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

function parseOptions (
  value: CreateMemoryCandidateLifecycleSinkOptionsV1
): CreateMemoryCandidateLifecycleSinkOptionsV1 {
  const input = inspectMemoryRecord(value, ['lifecycle', 'authorize'])
  if (input.lifecycle === null || typeof input.lifecycle !== 'object' ||
    utilTypes.isProxy(input.lifecycle) ||
    typeof (input.lifecycle as MemoryLifecyclePortV1).execute !== 'function' ||
    typeof input.authorize !== 'function' || utilTypes.isProxy(input.authorize)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    lifecycle: input.lifecycle as MemoryLifecyclePortV1,
    authorize: input.authorize as CreateMemoryCandidateLifecycleSinkOptionsV1['authorize']
  })
}

function parseAuthorization (value: unknown): MemoryCandidateAuthorizationResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['access', 'actor', 'policy', 'reason', 'retryable']
  )
  if (discriminator.status === 'authorized') {
    const input = inspectMemoryRecord(value, ['status', 'access', 'actor', 'policy'])
    if (input.access === null || typeof input.access !== 'object' ||
      input.actor === null || typeof input.actor !== 'object' ||
      (input.policy !== null && typeof input.policy !== 'object')) return invalidMemoryValue()
    return Object.freeze({
      status: 'authorized' as const,
      access: input.access as MemoryAccessCapabilityV1,
      actor: input.actor as MemoryLifecycleActorCapabilityV1,
      policy: input.policy as MemoryPolicyCapabilityV1 | null
    })
  }
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['status', 'reason'])
    if (input.reason !== 'policy' && input.reason !== 'scope' && input.reason !== 'authority') {
      return invalidMemoryValue()
    }
    return Object.freeze({ status: 'denied' as const, reason: input.reason })
  }
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'retryable'])
    if (typeof input.retryable !== 'boolean') return invalidMemoryValue()
    return Object.freeze({ status: 'unavailable' as const, retryable: input.retryable })
  }
  if (discriminator.status !== 'aborted') return invalidMemoryValue()
  inspectMemoryRecord(value, ['status'])
  return Object.freeze({ status: 'aborted' as const })
}

function commandRef (
  operation: 'propose' | 'approve',
  input: MemoryCandidateSubmissionV1
): string {
  const candidateHash = memoryCandidateHashV1(input.job, input.candidate)
  return `command:${createHash('sha256')
    .update(`groupmate.memory.candidate-${operation}.v1`, 'utf8')
    .update('\0')
    .update(input.job.jobId, 'utf8')
    .update('\0')
    .update(candidateHash, 'utf8')
    .digest('hex')}`
}

function authorizedForProposal (
  input: MemoryCandidateSubmissionV1,
  authorization: Extract<MemoryCandidateAuthorizationResultV1, { readonly status: 'authorized' }>
): boolean {
  const now = input.submittedAt
  const job = input.job
  return job.sceneRef === authorization.access.sceneRef &&
    memoryAccessCapabilityAllowsV1(authorization.access, job.namespaceRef, now) &&
    memoryLifecycleActorCapabilityRoleV1(authorization.actor) === 'personal_subject' &&
    memoryLifecycleActorCapabilityAllowsV1(authorization.actor, {
      botInstanceId: job.namespace.botInstanceId,
      accountId: job.namespace.accountId,
      sceneRef: authorization.access.sceneRef,
      namespaceRef: job.namespaceRef,
      generation: job.namespaceGeneration,
      actorRef: authorization.actor.actorRef,
      action: 'propose_create',
      requiredAuthority: 'safe'
    }, now)
}

function policyAllowsProposal (
  input: MemoryCandidateSubmissionV1,
  authorization: Extract<MemoryCandidateAuthorizationResultV1, { readonly status: 'authorized' }>
): boolean {
  const policy = authorization.policy
  if (policy === null) return false
  const job = input.job
  const common = {
    botInstanceId: job.namespace.botInstanceId,
    accountId: job.namespace.accountId,
    sceneRef: authorization.access.sceneRef,
    namespaceRef: job.namespaceRef,
    generation: job.namespaceGeneration,
    policyRef: policy.policyRef,
    policyGeneration: policy.policyGeneration,
    consent: 'owner_policy' as const
  }
  return memoryPolicyCapabilityAllowsBindingV1(policy, {
    ...common,
    createdByActorRef: authorization.actor.actorRef
  }, input.submittedAt) && memoryPolicyCapabilityAllowsV1(policy, {
    ...common,
    kind: input.candidate.kind,
    sensitivity: input.candidate.sensitivity,
    sourceKinds: [job.source.sourceKind],
    retentionPolicyRef: MEMORY_RETENTION_POLICY_REF_V1
  }, input.submittedAt)
}

function mapLifecycleFailure (
  result: MemoryLifecycleResultV1
): MemoryCandidateSubmissionResultV1 {
  if (result.status === 'denied') {
    return Object.freeze({
      status: 'denied' as const,
      reason: result.category === 'access' ? 'scope' as const : 'authority' as const
    })
  }
  if (result.status === 'capacity') return Object.freeze({ status: 'capacity' as const })
  if (result.status === 'aborted') return Object.freeze({ status: 'aborted' as const })
  if (result.status === 'unavailable') {
    return Object.freeze({ status: 'unavailable' as const, retryable: result.retryable })
  }
  return Object.freeze({ status: 'unavailable' as const, retryable: true })
}

export function createMemoryCandidateLifecycleSinkV1 (
  optionsValue: CreateMemoryCandidateLifecycleSinkOptionsV1
): MemoryCandidateLifecycleSinkV1 {
  const options = parseOptions(optionsValue)
  return Object.freeze({
    async submit (
      inputValue: MemoryCandidateSubmissionV1,
      signal?: AbortSignal
    ): Promise<MemoryCandidateSubmissionResultV1> {
      let input: MemoryCandidateSubmissionV1
      try {
        input = parseMemoryCandidateSubmissionV1(inputValue)
      } catch {
        return Object.freeze({ status: 'unavailable' as const, retryable: false })
      }
      if (input.approvalMode === 'policy_approved' &&
        !memoryCandidateSubmissionAllowsPolicyApprovalV1(input)) {
        return Object.freeze({ status: 'denied' as const, reason: 'policy' as const })
      }
      let authorization: MemoryCandidateAuthorizationResultV1
      try {
        authorization = parseAuthorization(await options.authorize(input, signal))
      } catch {
        return Object.freeze({ status: 'unavailable' as const, retryable: false })
      }
      if (authorization.status !== 'authorized') return authorization
      if (!authorizedForProposal(input, authorization)) {
        return Object.freeze({ status: 'denied' as const, reason: 'authority' as const })
      }
      const automatic = input.approvalMode === 'policy_approved'
      if ((automatic && !policyAllowsProposal(input, authorization)) ||
        (!automatic && authorization.policy !== null)) {
        return Object.freeze({ status: 'denied' as const, reason: 'policy' as const })
      }
      const proposeRef = commandRef('propose', input)
      const proposal = buildMemoryProposalDraftV2({
        commandRef: proposeRef,
        operation: 'proposal.create',
        namespaceRef: input.job.namespaceRef,
        namespaceGeneration: input.job.namespaceGeneration,
        initiatedByActorRef: authorization.actor.actorRef,
        namespace: input.job.namespace,
        proposedBy: {
          kind: 'model',
          runRef: input.job.sourceRunRef,
          modelProfile: input.extractorModelProfile
        },
        intent: { kind: 'create' },
        kind: input.candidate.kind,
        text: input.candidate.text,
        sources: [input.job.source],
        observedAt: input.job.source.observedAt,
        proposedAt: input.submittedAt,
        confidence: input.candidate.confidence,
        sensitivity: input.candidate.sensitivity,
        conflict: input.conflict,
        customTtlDays: null,
        consentRequirement: automatic ? 'owner_policy' : 'explicit',
        consentPolicyRef: automatic ? authorization.policy!.policyRef : null,
        consentPolicyGeneration: automatic ? authorization.policy!.policyGeneration : null
      })
      const createCommand = createMemoryLifecycleCommandV1({
        commandRef: proposeRef,
        operation: 'proposal.create',
        initiatedByActorRef: authorization.actor.actorRef,
        namespaceRef: proposal.namespaceRef,
        expectedNamespaceGeneration: proposal.namespaceGeneration,
        aggregateRef: null,
        expectedRevision: null,
        expectedAggregateHash: null,
        occurredAt: input.submittedAt,
        newValidUntil: null,
        newPurgeAt: null,
        material: proposal
      })
      const created = await options.lifecycle.execute({
        schemaVersion: 1,
        command: createCommand,
        access: authorization.access,
        authority: { kind: 'actor', capability: authorization.actor }
      }, signal)
      if (created.status !== 'stored' && created.status !== 'unchanged') {
        return mapLifecycleFailure(created)
      }
      if (!automatic) {
        return Object.freeze({
          status: created.status,
          outcome: 'shadow' as const,
          proposalId: proposal.proposalId
        })
      }
      const approveRef = commandRef('approve', input)
      const approval = buildMemoryProposalApprovalBundleV1({
        commandRef: approveRef,
        operation: 'proposal.approve',
        namespaceRef: proposal.namespaceRef,
        namespaceGeneration: proposal.namespaceGeneration,
        proposal,
        approvedByActorRef: authorization.actor.actorRef,
        freshNow: input.submittedAt,
        evidenceSource: null,
        reason: null
      })
      const approveCommand = createMemoryLifecycleCommandV1({
        commandRef: approveRef,
        operation: 'proposal.approve',
        initiatedByActorRef: authorization.actor.actorRef,
        namespaceRef: proposal.namespaceRef,
        expectedNamespaceGeneration: proposal.namespaceGeneration,
        aggregateRef: proposal.proposalId,
        expectedRevision: proposal.revision,
        expectedAggregateHash: proposal.consentTargetHash,
        occurredAt: input.submittedAt,
        newValidUntil: null,
        newPurgeAt: null,
        material: approval.consentEvidence
      })
      const approved = await options.lifecycle.execute({
        schemaVersion: 1,
        command: approveCommand,
        access: authorization.access,
        authority: { kind: 'policy', capability: authorization.policy! }
      }, signal)
      if (approved.status !== 'stored' && approved.status !== 'unchanged') {
        return mapLifecycleFailure(approved)
      }
      return Object.freeze({
        status: created.status === 'unchanged' || approved.status === 'unchanged'
          ? 'unchanged' as const
          : 'stored' as const,
        outcome: 'approved' as const,
        proposalId: proposal.proposalId
      })
    }
  })
}
