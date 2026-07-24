import { MEMORY_INITIAL_RETENTION_MAX_DAYS_V2, MEMORY_PROPOSAL_DEADLINE_DAYS_V2, MEMORY_RETENTION_POLICY_REF_V1, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2, addMemoryLifecycleDaysV1, assertMemoryConsentEvidenceForProposalV1, assertMemoryCreateApprovalResultBindingV2, assertMemoryRecordApprovalBindingV2, assertMemoryRevisionEvidenceBindingV1, createMemoryConsentEvidenceV1, createMemoryProposalV2, createMemoryRecordV2, createMemoryRevisionEvidenceV1, createMemoryRevisionV2, memoryLifecycleDomainHashV1, parseMemoryConsentEvidenceV1, parseMemoryLifecycleHashV1, parseMemoryLifecycleHashedRefV1, parseMemoryLifecycleInstantV1, parseMemoryLifecyclePositiveIntegerV1, parseMemoryProposalIntentV2, parseMemoryProposalV2, parseMemoryRecordV2, parseMemoryRevisionEvidenceV1, parseMemoryRevisionV2, requireMemoryV1ToV2AggregateManifestV1 } from './memory-lifecycle-domain.js';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const MEMORY_PROPOSAL_ID_HASH_DOMAIN_V2 = 'groupmate.memory.proposal-id.v2';
export const MEMORY_PLANNED_MEMORY_ID_HASH_DOMAIN_V2 = 'groupmate.memory.planned-memory-id.v2';
export const MEMORY_CONSENT_EVIDENCE_ID_HASH_DOMAIN_V1 = 'groupmate.memory.consent-evidence-id.v1';
export const MEMORY_REVISION_EVIDENCE_ID_HASH_DOMAIN_V1 = 'groupmate.memory.revision-evidence-id.v1';
export const MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2 = Object.freeze({
    profile_fact: 365,
    preference: 365,
    relationship: 365,
    group_rule: 365,
    group_culture: 365,
    task_fact: 90,
    other: 180
});
export const MEMORY_LIFECYCLE_BUILDER_OPERATIONS_V1 = Object.freeze([
    'proposal.create',
    'proposal.createAndApprove',
    'proposal.approve',
    'proposal.reject',
    'proposal.withdraw',
    'proposal.expire',
    'record.correct',
    'record.renew',
    'record.changeConflict'
]);
const MEMORY_KINDS = Object.freeze(Object.keys(MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2));
const COMMAND_REF = /^command:[0-9a-f]{64}$/;
const PROPOSAL_CREATE_OPERATIONS = Object.freeze([
    'proposal.create', 'proposal.createAndApprove'
]);
const CONSENT_EVIDENCE_OPERATIONS = Object.freeze([
    'proposal.approve', 'proposal.createAndApprove'
]);
const REVISION_EVIDENCE_OPERATIONS = Object.freeze([
    'record.correct', 'record.renew', 'record.changeConflict'
]);
const REVISION_EVIDENCE_ID_OPERATIONS = Object.freeze([
    'proposal.approve', ...REVISION_EVIDENCE_OPERATIONS
]);
const PROPOSAL_DECISION_OPERATIONS = Object.freeze([
    'proposal.reject', 'proposal.withdraw', 'proposal.expire'
]);
const RECORD_CANONICAL_FIELDS = Object.freeze([
    'schemaVersion', 'memoryId', 'revision', 'namespace', 'namespaceRef',
    'namespaceGeneration', 'kind', 'text', 'sources', 'createdAt', 'observedAt',
    'confirmedAt', 'updatedAt', 'validity', 'confidence', 'consent', 'sensitivity',
    'conflict', 'supersedes', 'retention', 'retentionPolicyRef', 'deletionState',
    'contentHash'
]);
function canonicalEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function assertDirectSaveProposalV2(proposal) {
    if (proposal.proposedBy.kind !== 'user' ||
        proposal.proposedBy.actorRef !== proposal.initiatedByActorRef ||
        proposal.consentRequirement !== 'explicit' ||
        proposal.sources.length !== 1 ||
        proposal.sources[0]?.sourceKind !== 'current_message')
        return invalidMemoryValue();
}
function parseBuilderOperation(value) {
    if (typeof value !== 'string' ||
        !MEMORY_LIFECYCLE_BUILDER_OPERATIONS_V1.includes(value))
        return invalidMemoryValue();
    return value;
}
function operationAllowed(operation, allowed) {
    return allowed.includes(operation);
}
function parseCommandRef(value) {
    if (typeof value !== 'string' || !COMMAND_REF.test(value))
        return invalidMemoryValue();
    return value;
}
function parseDeterministicReferenceInput(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'namespaceRef', 'namespaceGeneration', 'operation'
    ]);
    return Object.freeze({
        commandRef: parseCommandRef(input.commandRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
        operation: parseBuilderOperation(input.operation)
    });
}
function deterministicReferencePreimage(value) {
    return JSON.stringify({
        schemaVersion: 1,
        commandRef: value.commandRef,
        namespaceRef: value.namespaceRef,
        namespaceGeneration: value.namespaceGeneration,
        operation: value.operation
    });
}
function deriveReference(prefix, domain, value) {
    return `${prefix}${memoryLifecycleDomainHashV1(domain, deterministicReferencePreimage(value))}`;
}
export function deriveMemoryProposalIdV2(value) {
    const input = parseDeterministicReferenceInput(value);
    if (!operationAllowed(input.operation, PROPOSAL_CREATE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    return deriveReference('proposal:', MEMORY_PROPOSAL_ID_HASH_DOMAIN_V2, input);
}
export function deriveMemoryPlannedMemoryIdV2(value) {
    const raw = inspectMemoryRecord(value, [
        'commandRef', 'namespaceRef', 'namespaceGeneration', 'operation',
        'proposalId', 'intent'
    ]);
    const input = parseDeterministicReferenceInput({
        commandRef: raw.commandRef,
        namespaceRef: raw.namespaceRef,
        namespaceGeneration: raw.namespaceGeneration,
        operation: raw.operation
    });
    if (!operationAllowed(input.operation, PROPOSAL_CREATE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const proposalId = parseMemoryLifecycleHashedRefV1(raw.proposalId, 'proposal:');
    if (proposalId !== deriveMemoryProposalIdV2(input))
        return invalidMemoryValue();
    const intent = parseMemoryProposalIntentV2(raw.intent);
    if (intent.kind === 'correction')
        return intent.targetMemoryId;
    return `memory:${memoryLifecycleDomainHashV1(MEMORY_PLANNED_MEMORY_ID_HASH_DOMAIN_V2, JSON.stringify({
        schemaVersion: 2,
        commandRef: input.commandRef,
        namespaceRef: input.namespaceRef,
        namespaceGeneration: input.namespaceGeneration,
        operation: input.operation,
        proposalId,
        intent
    }))}`;
}
export function deriveMemoryConsentEvidenceIdV1(value) {
    const raw = inspectMemoryRecord(value, [
        'commandRef', 'namespaceRef', 'namespaceGeneration', 'operation',
        'proposalId', 'consentTargetHash'
    ]);
    const input = parseDeterministicReferenceInput({
        commandRef: raw.commandRef,
        namespaceRef: raw.namespaceRef,
        namespaceGeneration: raw.namespaceGeneration,
        operation: raw.operation
    });
    if (!operationAllowed(input.operation, CONSENT_EVIDENCE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    return `evidence:${memoryLifecycleDomainHashV1(MEMORY_CONSENT_EVIDENCE_ID_HASH_DOMAIN_V1, JSON.stringify({
        schemaVersion: 1,
        commandRef: input.commandRef,
        namespaceRef: input.namespaceRef,
        namespaceGeneration: input.namespaceGeneration,
        operation: input.operation,
        proposalId: parseMemoryLifecycleHashedRefV1(raw.proposalId, 'proposal:'),
        consentTargetHash: parseMemoryLifecycleHashV1(raw.consentTargetHash)
    }))}`;
}
export function deriveMemoryRevisionEvidenceIdV1(value) {
    const raw = inspectMemoryRecord(value, [
        'commandRef', 'namespaceRef', 'namespaceGeneration', 'operation', 'memoryId',
        'revision', 'baseRevisionHash', 'revisionTargetHash'
    ]);
    const input = parseDeterministicReferenceInput({
        commandRef: raw.commandRef,
        namespaceRef: raw.namespaceRef,
        namespaceGeneration: raw.namespaceGeneration,
        operation: raw.operation
    });
    if (!operationAllowed(input.operation, REVISION_EVIDENCE_ID_OPERATIONS)) {
        return invalidMemoryValue();
    }
    return `evidence:${memoryLifecycleDomainHashV1(MEMORY_REVISION_EVIDENCE_ID_HASH_DOMAIN_V1, JSON.stringify({
        schemaVersion: 1,
        commandRef: input.commandRef,
        namespaceRef: input.namespaceRef,
        namespaceGeneration: input.namespaceGeneration,
        operation: input.operation,
        memoryId: parseMemoryLifecycleHashedRefV1(raw.memoryId, 'memory:'),
        revision: parseMemoryLifecyclePositiveIntegerV1(raw.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
        baseRevisionHash: parseMemoryLifecycleHashV1(raw.baseRevisionHash),
        revisionTargetHash: parseMemoryLifecycleHashV1(raw.revisionTargetHash)
    }))}`;
}
function parseMemoryKind(value) {
    if (typeof value !== 'string' || !MEMORY_KINDS.includes(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseNonNegativeInstant(value) {
    let instant;
    try {
        instant = parseMemoryLifecycleInstantV1(value);
    }
    catch {
        return invalidMemoryValue();
    }
    if (Date.parse(instant) < 0)
        return invalidMemoryValue();
    return instant;
}
function addLifecycleDays(instant, days) {
    try {
        return parseNonNegativeInstant(addMemoryLifecycleDaysV1(parseNonNegativeInstant(instant), days));
    }
    catch {
        return invalidMemoryValue();
    }
}
function assertSourceDates(sources) {
    for (const source of sources)
        parseNonNegativeInstant(source.observedAt);
}
function assertProposalDates(proposal) {
    parseNonNegativeInstant(proposal.observedAt);
    parseNonNegativeInstant(proposal.proposedAt);
    parseNonNegativeInstant(proposal.suggestedRetention.validUntil);
    parseNonNegativeInstant(proposal.suggestedRetention.purgeAt);
    if (proposal.decision !== null)
        parseNonNegativeInstant(proposal.decision.decidedAt);
    assertSourceDates(proposal.sources);
}
function assertRecordDates(record) {
    parseNonNegativeInstant(record.createdAt);
    parseNonNegativeInstant(record.observedAt);
    parseNonNegativeInstant(record.confirmedAt);
    parseNonNegativeInstant(record.updatedAt);
    parseNonNegativeInstant(record.consent.approvedAt);
    parseNonNegativeInstant(record.retention.validUntil);
    parseNonNegativeInstant(record.retention.purgeAt);
    if (record.validity.validFrom !== null)
        parseNonNegativeInstant(record.validity.validFrom);
    assertSourceDates(record.sources);
}
function assertMaterialLimit(value) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') >
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandMaterialWireBytes) {
        return invalidMemoryValue();
    }
    return value;
}
export function buildMemoryInitialRetentionV2(value) {
    const input = inspectMemoryRecord(value, ['proposedAt', 'kind', 'customTtlDays']);
    const proposedAt = parseNonNegativeInstant(input.proposedAt);
    const kind = parseMemoryKind(input.kind);
    const ttlDays = input.customTtlDays === null
        ? MEMORY_INITIAL_RETENTION_DAYS_BY_KIND_V2[kind]
        : parseMemoryLifecyclePositiveIntegerV1(input.customTtlDays, MEMORY_INITIAL_RETENTION_MAX_DAYS_V2);
    const validUntil = addLifecycleDays(proposedAt, ttlDays);
    const purgeAt = addLifecycleDays(validUntil, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2);
    return Object.freeze({ validUntil, purgeAt });
}
export function buildMemoryRenewalRetentionV2(value) {
    const input = inspectMemoryRecord(value, [
        'currentRetention', 'freshNow', 'newValidUntil'
    ]);
    const current = inspectMemoryRecord(input.currentRetention, ['validUntil', 'purgeAt']);
    const oldValidUntil = parseNonNegativeInstant(current.validUntil);
    const oldPurgeAt = parseNonNegativeInstant(current.purgeAt);
    if (addLifecycleDays(oldValidUntil, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2) !== oldPurgeAt) {
        return invalidMemoryValue();
    }
    const freshNow = parseNonNegativeInstant(input.freshNow);
    const newValidUntil = parseNonNegativeInstant(input.newValidUntil);
    if (Date.parse(freshNow) >= Date.parse(oldPurgeAt) ||
        Date.parse(newValidUntil) <= Date.parse(oldValidUntil))
        return invalidMemoryValue();
    const minimum = addLifecycleDays(freshNow, 1);
    const maximum = addLifecycleDays(freshNow, MEMORY_INITIAL_RETENTION_MAX_DAYS_V2);
    if (Date.parse(newValidUntil) < Date.parse(minimum) ||
        Date.parse(newValidUntil) > Date.parse(maximum))
        return invalidMemoryValue();
    return Object.freeze({
        validUntil: newValidUntil,
        purgeAt: addLifecycleDays(newValidUntil, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2)
    });
}
export function projectMemoryProposalLifecycleV2(proposalValue, freshNowValue) {
    const proposal = parseMemoryProposalV2(proposalValue);
    assertProposalDates(proposal);
    const freshNow = parseNonNegativeInstant(freshNowValue);
    const deadline = addLifecycleDays(proposal.proposedAt, MEMORY_PROPOSAL_DEADLINE_DAYS_V2);
    const approvalCutoff = Date.parse(deadline) <=
        Date.parse(proposal.suggestedRetention.validUntil)
        ? deadline
        : proposal.suggestedRetention.validUntil;
    const approveEligible = proposal.state === 'pending' &&
        Date.parse(freshNow) < Date.parse(approvalCutoff);
    const fullWirePurgeAt = proposal.state === 'pending' || proposal.state === 'expired'
        ? addLifecycleDays(proposal.proposedAt, MEMORY_PROPOSAL_DEADLINE_DAYS_V2 + MEMORY_RETENTION_PURGE_GRACE_DAYS_V2)
        : addLifecycleDays(proposal.decision.decidedAt, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2);
    return Object.freeze({
        logicalState: proposal.state === 'pending' && !approveEligible
            ? 'expired_due'
            : proposal.state,
        approvalCutoff,
        approveEligible,
        fullWirePurgeAt,
        fullWireReadable: Date.parse(freshNow) < Date.parse(fullWirePurgeAt)
    });
}
export function projectMemoryRecordLifecycleV2(recordValue, freshNowValue) {
    const record = parseMemoryRecordV2(recordValue);
    assertRecordDates(record);
    const freshNow = parseNonNegativeInstant(freshNowValue);
    const state = Date.parse(freshNow) < Date.parse(record.retention.validUntil)
        ? 'current'
        : Date.parse(freshNow) < Date.parse(record.retention.purgeAt)
            ? 'expired'
            : 'purge_due';
    return Object.freeze({
        state,
        retrievalEligible: state === 'current',
        controlContentReadable: state !== 'purge_due',
        renewEligible: state !== 'purge_due'
    });
}
function referenceFromFields(input) {
    return parseDeterministicReferenceInput({
        commandRef: input.commandRef,
        namespaceRef: input.namespaceRef,
        namespaceGeneration: input.namespaceGeneration,
        operation: input.operation
    });
}
function assertReferenceBinding(reference, namespaceRef, namespaceGeneration) {
    if (reference.namespaceRef !== namespaceRef ||
        reference.namespaceGeneration !== namespaceGeneration)
        return invalidMemoryValue();
}
export function buildMemoryProposalDraftV2(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration',
        'initiatedByActorRef', 'namespace', 'proposedBy', 'intent', 'kind', 'text',
        'sources', 'observedAt', 'proposedAt', 'confidence', 'sensitivity', 'conflict',
        'customTtlDays', 'consentRequirement', 'consentPolicyRef',
        'consentPolicyGeneration'
    ]);
    const reference = referenceFromFields(input);
    if (!operationAllowed(reference.operation, PROPOSAL_CREATE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = memoryNamespaceRefV1(namespace);
    assertReferenceBinding(reference, namespaceRef, reference.namespaceGeneration);
    const intent = parseMemoryProposalIntentV2(input.intent);
    if (intent.kind !== 'create')
        return invalidMemoryValue();
    const kind = parseMemoryKind(input.kind);
    const proposedAt = parseNonNegativeInstant(input.proposedAt);
    const retention = buildMemoryInitialRetentionV2({
        proposedAt,
        kind,
        customTtlDays: input.customTtlDays
    });
    const proposalId = deriveMemoryProposalIdV2(reference);
    const proposal = createMemoryProposalV2({
        proposalId,
        namespace,
        namespaceGeneration: reference.namespaceGeneration,
        initiatedByActorRef: input.initiatedByActorRef,
        proposedBy: input.proposedBy,
        plannedMemoryId: deriveMemoryPlannedMemoryIdV2({
            ...reference,
            proposalId,
            intent
        }),
        intent,
        kind,
        text: input.text,
        sources: input.sources,
        observedAt: parseNonNegativeInstant(input.observedAt),
        proposedAt,
        confidence: input.confidence,
        sensitivity: input.sensitivity,
        conflict: input.conflict,
        suggestedRetention: retention,
        retentionPolicyRef: MEMORY_RETENTION_POLICY_REF_V1,
        consentRequirement: input.consentRequirement,
        consentPolicyRef: input.consentPolicyRef,
        consentPolicyGeneration: input.consentPolicyGeneration
    });
    if (reference.operation === 'proposal.createAndApprove') {
        assertDirectSaveProposalV2(proposal);
    }
    assertProposalDates(proposal);
    return proposal;
}
export function buildMemoryCorrectionProposalDraftV2(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration',
        'initiatedByActorRef', 'namespace', 'beforeRevision', 'proposedBy', 'text',
        'sources', 'observedAt', 'proposedAt', 'confidence', 'conflict',
        'consentRequirement', 'consentPolicyRef', 'consentPolicyGeneration'
    ]);
    const reference = referenceFromFields(input);
    if (reference.operation !== 'proposal.create')
        return invalidMemoryValue();
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = memoryNamespaceRefV1(namespace);
    assertReferenceBinding(reference, namespaceRef, reference.namespaceGeneration);
    const before = parseMemoryRevisionV2(input.beforeRevision);
    assertRecordDates(before.record);
    if (before.record.namespaceRef !== namespaceRef ||
        before.record.namespaceGeneration !== reference.namespaceGeneration ||
        before.revision >= MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions) {
        return invalidMemoryValue();
    }
    const proposedAt = parseNonNegativeInstant(input.proposedAt);
    if (Date.parse(proposedAt) < Date.parse(before.record.updatedAt) ||
        projectMemoryRecordLifecycleV2(before.record, proposedAt).state !== 'current') {
        return invalidMemoryValue();
    }
    const intent = Object.freeze({
        kind: 'correction',
        targetMemoryId: before.memoryId,
        targetRevision: before.revision,
        targetRevisionHash: before.revisionHash
    });
    const proposalId = deriveMemoryProposalIdV2(reference);
    const proposal = createMemoryProposalV2({
        proposalId,
        namespace,
        namespaceGeneration: reference.namespaceGeneration,
        initiatedByActorRef: input.initiatedByActorRef,
        proposedBy: input.proposedBy,
        plannedMemoryId: deriveMemoryPlannedMemoryIdV2({
            ...reference,
            proposalId,
            intent
        }),
        intent,
        kind: before.record.kind,
        text: input.text,
        sources: input.sources,
        observedAt: parseNonNegativeInstant(input.observedAt),
        proposedAt,
        confidence: input.confidence,
        sensitivity: before.record.sensitivity,
        conflict: input.conflict,
        suggestedRetention: before.record.retention,
        retentionPolicyRef: MEMORY_RETENTION_POLICY_REF_V1,
        consentRequirement: input.consentRequirement,
        consentPolicyRef: input.consentPolicyRef,
        consentPolicyGeneration: input.consentPolicyGeneration
    });
    assertProposalDates(proposal);
    return proposal;
}
function proposalAfterDecision(proposal, state, decision) {
    return parseMemoryProposalV2({
        schemaVersion: 2,
        proposalId: proposal.proposalId,
        revision: 2,
        namespace: proposal.namespace,
        namespaceRef: proposal.namespaceRef,
        namespaceGeneration: proposal.namespaceGeneration,
        state,
        initiatedByActorRef: proposal.initiatedByActorRef,
        proposedBy: proposal.proposedBy,
        plannedMemoryId: proposal.plannedMemoryId,
        intent: proposal.intent,
        kind: proposal.kind,
        text: proposal.text,
        sources: proposal.sources,
        observedAt: proposal.observedAt,
        proposedAt: proposal.proposedAt,
        confidence: proposal.confidence,
        sensitivity: proposal.sensitivity,
        conflict: proposal.conflict,
        suggestedRetention: proposal.suggestedRetention,
        retentionPolicyRef: proposal.retentionPolicyRef,
        consentRequirement: proposal.consentRequirement,
        consentPolicyRef: proposal.consentPolicyRef,
        consentPolicyGeneration: proposal.consentPolicyGeneration,
        consentTargetHash: proposal.consentTargetHash,
        decision
    });
}
export function buildMemoryProposalDecisionV2(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'proposal',
        'decidedByActorRef', 'freshNow', 'reason'
    ]);
    const reference = referenceFromFields(input);
    if (!operationAllowed(reference.operation, PROPOSAL_DECISION_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const proposal = parseMemoryProposalV2(input.proposal);
    assertProposalDates(proposal);
    if (proposal.state !== 'pending' || proposal.revision !== 1 || proposal.decision !== null) {
        return invalidMemoryValue();
    }
    assertReferenceBinding(reference, proposal.namespaceRef, proposal.namespaceGeneration);
    const freshNow = parseNonNegativeInstant(input.freshNow);
    const projection = projectMemoryProposalLifecycleV2(proposal, freshNow);
    if ((reference.operation !== 'proposal.expire' && !projection.fullWireReadable) ||
        (reference.operation === 'proposal.expire' && projection.approveEligible)) {
        return invalidMemoryValue();
    }
    const state = !projection.approveEligible || reference.operation === 'proposal.expire'
        ? 'expired'
        : reference.operation === 'proposal.reject'
            ? 'rejected'
            : 'withdrawn';
    return proposalAfterDecision(proposal, state, {
        decidedAt: freshNow,
        decidedByActorRef: parseMemoryLifecycleHashedRefV1(input.decidedByActorRef, 'actor:'),
        reason: input.reason,
        consentEvidenceId: null,
        consentEvidenceHash: null,
        resultingMemoryId: null,
        resultingMemoryRevision: null,
        resultingRevisionHash: null
    });
}
function parseProposalApprovalBundle(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'kind', 'proposal', 'consentEvidence', 'record', 'revision'
    ]);
    if (input.schemaVersion !== 1 || input.kind !== 'proposal_approval_v1') {
        return invalidMemoryValue();
    }
    const bundle = Object.freeze({
        schemaVersion: 1,
        kind: 'proposal_approval_v1',
        proposal: parseMemoryProposalV2(input.proposal),
        consentEvidence: parseMemoryConsentEvidenceV1(input.consentEvidence),
        record: parseMemoryRecordV2(input.record),
        revision: parseMemoryRevisionV2(input.revision)
    });
    return assertMaterialLimit(bundle);
}
function proposalImmutableFieldsMatch(before, after) {
    return before.proposalId === after.proposalId &&
        canonicalEqual(before.namespace, after.namespace) &&
        before.namespaceRef === after.namespaceRef &&
        before.namespaceGeneration === after.namespaceGeneration &&
        before.initiatedByActorRef === after.initiatedByActorRef &&
        canonicalEqual(before.proposedBy, after.proposedBy) &&
        before.plannedMemoryId === after.plannedMemoryId &&
        canonicalEqual(before.intent, after.intent) && before.kind === after.kind &&
        before.text === after.text && canonicalEqual(before.sources, after.sources) &&
        before.observedAt === after.observedAt && before.proposedAt === after.proposedAt &&
        before.confidence === after.confidence && before.sensitivity === after.sensitivity &&
        canonicalEqual(before.conflict, after.conflict) &&
        canonicalEqual(before.suggestedRetention, after.suggestedRetention) &&
        before.retentionPolicyRef === after.retentionPolicyRef &&
        before.consentRequirement === after.consentRequirement &&
        before.consentPolicyRef === after.consentPolicyRef &&
        before.consentPolicyGeneration === after.consentPolicyGeneration &&
        before.consentTargetHash === after.consentTargetHash;
}
export function assertMemoryProposalApprovalBundleV1(pendingProposalValue, bundleValue) {
    const pending = parseMemoryProposalV2(pendingProposalValue);
    const bundle = parseProposalApprovalBundle(bundleValue);
    assertProposalDates(pending);
    assertProposalDates(bundle.proposal);
    assertRecordDates(bundle.record);
    assertMemoryConsentEvidenceForProposalV1(pending, bundle.consentEvidence);
    assertMemoryRecordApprovalBindingV2(pending, bundle.consentEvidence, bundle.record);
    const approvalProjection = projectMemoryProposalLifecycleV2(pending, bundle.consentEvidence.approvedAt);
    assertMemoryCreateApprovalResultBindingV2(bundle.proposal, bundle.consentEvidence, bundle.record, bundle.revision);
    if (pending.state !== 'pending' || pending.revision !== 1 || pending.decision !== null ||
        !approvalProjection.approveEligible || !approvalProjection.fullWireReadable ||
        bundle.proposal.state !== 'approved' || bundle.proposal.revision !== 2 ||
        bundle.proposal.decision === null || !proposalImmutableFieldsMatch(pending, bundle.proposal) ||
        bundle.revision.operation !== 'created' || bundle.revision.revision !== 1 ||
        bundle.revision.memoryId !== bundle.record.memoryId ||
        !canonicalEqual(bundle.revision.record, bundle.record) ||
        bundle.revision.previousRevisionHash !== null ||
        bundle.revision.evidence.kind !== 'consent' ||
        bundle.revision.evidence.evidenceId !== bundle.consentEvidence.evidenceId ||
        bundle.revision.evidence.evidenceHash !== bundle.consentEvidence.evidenceHash ||
        bundle.revision.changedByActorRef !== bundle.consentEvidence.approvedByActorRef ||
        bundle.revision.changedAt !== bundle.consentEvidence.approvedAt ||
        bundle.proposal.decision.decidedAt !== bundle.consentEvidence.approvedAt ||
        bundle.proposal.decision.decidedByActorRef !== bundle.consentEvidence.approvedByActorRef ||
        bundle.proposal.decision.consentEvidenceId !== bundle.consentEvidence.evidenceId ||
        bundle.proposal.decision.consentEvidenceHash !== bundle.consentEvidence.evidenceHash ||
        bundle.proposal.decision.resultingMemoryId !== bundle.record.memoryId ||
        bundle.proposal.decision.resultingMemoryRevision !== bundle.record.revision ||
        bundle.proposal.decision.resultingRevisionHash !== bundle.revision.revisionHash ||
        bundle.proposal.decision.reason !== bundle.revision.reason) {
        return invalidMemoryValue();
    }
    return bundle;
}
export function buildMemoryProposalApprovalBundleV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'proposal',
        'approvedByActorRef', 'freshNow', 'evidenceSource', 'reason'
    ]);
    const reference = referenceFromFields(input);
    if (!operationAllowed(reference.operation, CONSENT_EVIDENCE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const proposal = parseMemoryProposalV2(input.proposal);
    assertProposalDates(proposal);
    if (proposal.state !== 'pending' || proposal.revision !== 1 ||
        proposal.decision !== null || proposal.intent.kind !== 'create')
        return invalidMemoryValue();
    assertReferenceBinding(reference, proposal.namespaceRef, proposal.namespaceGeneration);
    if (reference.operation === 'proposal.createAndApprove') {
        assertDirectSaveProposalV2(proposal);
        if (proposal.proposalId !== deriveMemoryProposalIdV2(reference) ||
            proposal.plannedMemoryId !== deriveMemoryPlannedMemoryIdV2({
                ...reference,
                proposalId: proposal.proposalId,
                intent: proposal.intent
            }))
            return invalidMemoryValue();
    }
    const freshNow = parseNonNegativeInstant(input.freshNow);
    const projection = projectMemoryProposalLifecycleV2(proposal, freshNow);
    if (!projection.approveEligible || !projection.fullWireReadable)
        return invalidMemoryValue();
    const approvedByActorRef = parseMemoryLifecycleHashedRefV1(input.approvedByActorRef, 'actor:');
    if (reference.operation === 'proposal.createAndApprove' && (proposal.proposedAt !== freshNow ||
        proposal.initiatedByActorRef !== approvedByActorRef))
        return invalidMemoryValue();
    const consentEvidence = createMemoryConsentEvidenceV1({
        evidenceId: deriveMemoryConsentEvidenceIdV1({
            ...reference,
            proposalId: proposal.proposalId,
            consentTargetHash: proposal.consentTargetHash
        }),
        evidenceKind: proposal.consentRequirement,
        namespaceRef: proposal.namespaceRef,
        namespaceGeneration: proposal.namespaceGeneration,
        proposalId: proposal.proposalId,
        proposalRevision: 1,
        consentTargetHash: proposal.consentTargetHash,
        approvedByActorRef,
        approvedAt: freshNow,
        source: input.evidenceSource,
        policyRef: proposal.consentPolicyRef,
        policyGeneration: proposal.consentPolicyGeneration
    });
    if (consentEvidence.source !== null)
        parseNonNegativeInstant(consentEvidence.source.observedAt);
    if (reference.operation === 'proposal.createAndApprove' &&
        !canonicalEqual(proposal.sources[0], consentEvidence.source))
        return invalidMemoryValue();
    const record = createMemoryRecordV2({
        memoryId: proposal.plannedMemoryId,
        revision: 1,
        namespace: proposal.namespace,
        namespaceGeneration: proposal.namespaceGeneration,
        kind: proposal.kind,
        text: proposal.text,
        sources: proposal.sources,
        createdAt: proposal.proposedAt,
        observedAt: proposal.observedAt,
        confirmedAt: freshNow,
        updatedAt: freshNow,
        validity: { state: 'current', validFrom: proposal.observedAt },
        confidence: proposal.confidence,
        consent: {
            state: consentEvidence.evidenceKind,
            approvedByActorRef: consentEvidence.approvedByActorRef,
            approvedAt: consentEvidence.approvedAt,
            consentTargetHash: consentEvidence.consentTargetHash,
            evidenceId: consentEvidence.evidenceId,
            evidenceHash: consentEvidence.evidenceHash,
            policyRef: consentEvidence.policyRef,
            policyGeneration: consentEvidence.policyGeneration
        },
        sensitivity: proposal.sensitivity,
        conflict: proposal.conflict,
        supersedes: [],
        retention: proposal.suggestedRetention,
        retentionPolicyRef: proposal.retentionPolicyRef,
        deletionState: 'active'
    });
    const revision = createMemoryRevisionV2({
        memoryId: record.memoryId,
        revision: 1,
        operation: 'created',
        record,
        changedByActorRef: approvedByActorRef,
        changedAt: freshNow,
        reason: input.reason,
        evidence: {
            kind: 'consent',
            evidenceId: consentEvidence.evidenceId,
            evidenceHash: consentEvidence.evidenceHash
        },
        previousRevisionHash: null
    });
    const approvedProposal = proposalAfterDecision(proposal, 'approved', {
        decidedAt: freshNow,
        decidedByActorRef: approvedByActorRef,
        reason: input.reason,
        consentEvidenceId: consentEvidence.evidenceId,
        consentEvidenceHash: consentEvidence.evidenceHash,
        resultingMemoryId: record.memoryId,
        resultingMemoryRevision: record.revision,
        resultingRevisionHash: revision.revisionHash
    });
    return assertMemoryProposalApprovalBundleV1(proposal, Object.freeze({
        schemaVersion: 1,
        kind: 'proposal_approval_v1',
        proposal: approvedProposal,
        consentEvidence,
        record,
        revision
    }));
}
function recordAfterChange(before, revision, updatedAt, changes) {
    const changed = (key, fallback) => Object.hasOwn(changes, key) ? changes[key] : fallback;
    return createMemoryRecordV2({
        memoryId: before.memoryId,
        revision,
        namespace: before.namespace,
        namespaceGeneration: before.namespaceGeneration,
        kind: before.kind,
        text: changed('text', before.text),
        sources: before.sources,
        createdAt: before.createdAt,
        observedAt: before.observedAt,
        confirmedAt: before.confirmedAt,
        updatedAt,
        validity: changed('validity', before.validity),
        confidence: changed('confidence', before.confidence),
        consent: before.consent,
        sensitivity: before.sensitivity,
        conflict: changed('conflict', before.conflict),
        supersedes: changed('supersedes', before.supersedes),
        retention: changed('retention', before.retention),
        retentionPolicyRef: before.retentionPolicyRef,
        deletionState: before.deletionState
    });
}
function parseCorrectionProposalApprovalBundle(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'kind', 'proposal', 'consentEvidence', 'revisionEvidence',
        'record', 'revision'
    ]);
    if (input.schemaVersion !== 1 || input.kind !== 'correction_proposal_approval_v1') {
        return invalidMemoryValue();
    }
    return assertMaterialLimit(Object.freeze({
        schemaVersion: 1,
        kind: 'correction_proposal_approval_v1',
        proposal: parseMemoryProposalV2(input.proposal),
        consentEvidence: parseMemoryConsentEvidenceV1(input.consentEvidence),
        revisionEvidence: parseMemoryRevisionEvidenceV1(input.revisionEvidence),
        record: parseMemoryRecordV2(input.record),
        revision: parseMemoryRevisionV2(input.revision)
    }));
}
export function assertMemoryCorrectionProposalApprovalBundleV1(pendingProposalValue, beforeRevisionValue, bundleValue) {
    const pending = parseMemoryProposalV2(pendingProposalValue);
    const before = parseMemoryRevisionV2(beforeRevisionValue);
    const bundle = parseCorrectionProposalApprovalBundle(bundleValue);
    assertProposalDates(pending);
    assertProposalDates(bundle.proposal);
    assertRecordDates(before.record);
    assertRecordDates(bundle.record);
    assertMemoryConsentEvidenceForProposalV1(pending, bundle.consentEvidence);
    assertMemoryRevisionEvidenceBindingV1(bundle.revisionEvidence, bundle.revision);
    const approvalProjection = projectMemoryProposalLifecycleV2(pending, bundle.consentEvidence.approvedAt);
    if (pending.state !== 'pending' || pending.revision !== 1 || pending.decision !== null ||
        pending.intent.kind !== 'correction' ||
        pending.intent.targetMemoryId !== before.memoryId ||
        pending.intent.targetRevision !== before.revision ||
        pending.intent.targetRevisionHash !== before.revisionHash ||
        pending.plannedMemoryId !== before.memoryId ||
        pending.namespaceRef !== before.record.namespaceRef ||
        pending.namespaceGeneration !== before.record.namespaceGeneration ||
        pending.kind !== before.record.kind || pending.sensitivity !== before.record.sensitivity ||
        !canonicalEqual(pending.suggestedRetention, before.record.retention) ||
        !approvalProjection.approveEligible || !approvalProjection.fullWireReadable ||
        bundle.proposal.state !== 'approved' || bundle.proposal.revision !== 2 ||
        bundle.proposal.decision === null ||
        !proposalImmutableFieldsMatch(pending, bundle.proposal) ||
        bundle.record.memoryId !== before.memoryId ||
        bundle.record.revision !== before.revision + 1 ||
        bundle.record.text !== pending.text ||
        bundle.record.confidence !== pending.confidence ||
        !canonicalEqual(bundle.record.conflict, pending.conflict) ||
        !canonicalEqual(bundle.record.validity, before.record.validity) ||
        !canonicalEqual(bundle.record.supersedes, before.record.supersedes) ||
        bundle.revision.operation !== 'corrected' ||
        bundle.revision.memoryId !== before.memoryId ||
        bundle.revision.revision !== before.revision + 1 ||
        !canonicalEqual(bundle.revision.record, bundle.record) ||
        bundle.revision.previousRevisionHash !== before.revisionHash ||
        bundle.revision.changedByActorRef !== bundle.consentEvidence.approvedByActorRef ||
        bundle.revision.changedAt !== bundle.consentEvidence.approvedAt ||
        bundle.revision.reason !== bundle.proposal.decision.reason ||
        bundle.revisionEvidence.evidenceKind !== pending.consentRequirement ||
        bundle.revisionEvidence.policyRef !== pending.consentPolicyRef ||
        bundle.revisionEvidence.policyGeneration !== pending.consentPolicyGeneration ||
        bundle.revisionEvidence.changedByActorRef !== bundle.consentEvidence.approvedByActorRef ||
        bundle.revisionEvidence.changedAt !== bundle.consentEvidence.approvedAt ||
        !canonicalEqual(bundle.revisionEvidence.source, bundle.consentEvidence.source) ||
        bundle.proposal.decision.decidedAt !== bundle.consentEvidence.approvedAt ||
        bundle.proposal.decision.decidedByActorRef !== bundle.consentEvidence.approvedByActorRef ||
        bundle.proposal.decision.consentEvidenceId !== bundle.consentEvidence.evidenceId ||
        bundle.proposal.decision.consentEvidenceHash !== bundle.consentEvidence.evidenceHash ||
        bundle.proposal.decision.resultingMemoryId !== bundle.record.memoryId ||
        bundle.proposal.decision.resultingMemoryRevision !== bundle.record.revision ||
        bundle.proposal.decision.resultingRevisionHash !== bundle.revision.revisionHash) {
        return invalidMemoryValue();
    }
    assertRecordFieldDelta(before.record, bundle.record, 'corrected');
    return bundle;
}
export function buildMemoryCorrectionProposalApprovalBundleV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'proposal',
        'beforeRevision', 'approvedByActorRef', 'freshNow', 'evidenceSource', 'reason'
    ]);
    const reference = referenceFromFields(input);
    if (reference.operation !== 'proposal.approve')
        return invalidMemoryValue();
    const pending = parseMemoryProposalV2(input.proposal);
    const before = parseMemoryRevisionV2(input.beforeRevision);
    assertProposalDates(pending);
    assertRecordDates(before.record);
    if (pending.state !== 'pending' || pending.revision !== 1 || pending.decision !== null ||
        pending.intent.kind !== 'correction' || pending.plannedMemoryId !== before.memoryId ||
        pending.intent.targetMemoryId !== before.memoryId ||
        pending.intent.targetRevision !== before.revision ||
        pending.intent.targetRevisionHash !== before.revisionHash ||
        pending.namespaceRef !== before.record.namespaceRef ||
        pending.namespaceGeneration !== before.record.namespaceGeneration ||
        pending.kind !== before.record.kind || pending.sensitivity !== before.record.sensitivity ||
        !canonicalEqual(pending.suggestedRetention, before.record.retention)) {
        return invalidMemoryValue();
    }
    assertReferenceBinding(reference, pending.namespaceRef, pending.namespaceGeneration);
    const freshNow = parseNonNegativeInstant(input.freshNow);
    const projection = projectMemoryProposalLifecycleV2(pending, freshNow);
    if (!projection.approveEligible || !projection.fullWireReadable ||
        projectMemoryRecordLifecycleV2(before.record, freshNow).state !== 'current') {
        return invalidMemoryValue();
    }
    const approvedByActorRef = parseMemoryLifecycleHashedRefV1(input.approvedByActorRef, 'actor:');
    const consentEvidence = createMemoryConsentEvidenceV1({
        evidenceId: deriveMemoryConsentEvidenceIdV1({
            ...reference,
            proposalId: pending.proposalId,
            consentTargetHash: pending.consentTargetHash
        }),
        evidenceKind: pending.consentRequirement,
        namespaceRef: pending.namespaceRef,
        namespaceGeneration: pending.namespaceGeneration,
        proposalId: pending.proposalId,
        proposalRevision: 1,
        consentTargetHash: pending.consentTargetHash,
        approvedByActorRef,
        approvedAt: freshNow,
        source: input.evidenceSource,
        policyRef: pending.consentPolicyRef,
        policyGeneration: pending.consentPolicyGeneration
    });
    if (consentEvidence.source !== null)
        parseNonNegativeInstant(consentEvidence.source.observedAt);
    const record = recordAfterChange(before.record, before.revision + 1, freshNow, {
        text: pending.text,
        confidence: pending.confidence,
        validity: before.record.validity,
        conflict: pending.conflict,
        supersedes: before.record.supersedes
    });
    const revisionEvidence = createMemoryRevisionEvidenceV1({
        evidenceId: deriveMemoryRevisionEvidenceIdV1({
            ...reference,
            memoryId: before.memoryId,
            revision: before.revision + 1,
            baseRevisionHash: before.revisionHash,
            revisionTargetHash: record.contentHash
        }),
        evidenceKind: pending.consentRequirement,
        namespaceRef: pending.namespaceRef,
        namespaceGeneration: pending.namespaceGeneration,
        memoryId: before.memoryId,
        revision: before.revision + 1,
        operation: 'corrected',
        baseRevisionHash: before.revisionHash,
        revisionTargetHash: record.contentHash,
        changedByActorRef: approvedByActorRef,
        changedAt: freshNow,
        source: input.evidenceSource,
        policyRef: pending.consentPolicyRef,
        policyGeneration: pending.consentPolicyGeneration
    });
    const revision = createMemoryRevisionV2({
        memoryId: record.memoryId,
        revision: record.revision,
        operation: 'corrected',
        record,
        changedByActorRef: approvedByActorRef,
        changedAt: freshNow,
        reason: input.reason,
        evidence: {
            kind: 'revision',
            evidenceId: revisionEvidence.evidenceId,
            evidenceHash: revisionEvidence.evidenceHash
        },
        previousRevisionHash: before.revisionHash
    });
    const approvedProposal = proposalAfterDecision(pending, 'approved', {
        decidedAt: freshNow,
        decidedByActorRef: approvedByActorRef,
        reason: input.reason,
        consentEvidenceId: consentEvidence.evidenceId,
        consentEvidenceHash: consentEvidence.evidenceHash,
        resultingMemoryId: record.memoryId,
        resultingMemoryRevision: record.revision,
        resultingRevisionHash: revision.revisionHash
    });
    return assertMemoryCorrectionProposalApprovalBundleV1(pending, before, Object.freeze({
        schemaVersion: 1,
        kind: 'correction_proposal_approval_v1',
        proposal: approvedProposal,
        consentEvidence,
        revisionEvidence,
        record,
        revision
    }));
}
function parseRevisionChangeBundle(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'kind', 'evidence', 'revision'
    ]);
    if (input.schemaVersion !== 1 || input.kind !== 'revision_change_v1') {
        return invalidMemoryValue();
    }
    const bundle = Object.freeze({
        schemaVersion: 1,
        kind: 'revision_change_v1',
        evidence: parseMemoryRevisionEvidenceV1(input.evidence),
        revision: parseMemoryRevisionV2(input.revision)
    });
    return assertMaterialLimit(bundle);
}
function expectedRevisionOperation(operation) {
    if (operation === 'record.correct')
        return 'corrected';
    if (operation === 'record.renew')
        return 'retention_changed';
    return 'conflict_changed';
}
function assertRecordFieldDelta(before, after, operation) {
    const allowed = new Set([
        'revision', 'updatedAt', 'contentHash',
        ...(operation === 'corrected'
            ? ['text', 'confidence', 'validity', 'conflict', 'supersedes']
            : operation === 'retention_changed'
                ? ['retention']
                : ['validity', 'conflict'])
    ]);
    for (const field of RECORD_CANONICAL_FIELDS) {
        if (!allowed.has(field) && !canonicalEqual(before[field], after[field])) {
            return invalidMemoryValue();
        }
    }
    const businessFields = operation === 'corrected'
        ? ['text', 'confidence', 'validity', 'conflict', 'supersedes']
        : operation === 'retention_changed'
            ? ['retention']
            : ['validity', 'conflict'];
    if (!businessFields.some(field => !canonicalEqual(before[field], after[field]))) {
        return invalidMemoryValue();
    }
}
export function assertMemoryRevisionChangeBundleV1(beforeRevisionValue, operationValue, bundleValue) {
    const before = parseMemoryRevisionV2(beforeRevisionValue);
    const operation = parseBuilderOperation(operationValue);
    if (!operationAllowed(operation, REVISION_EVIDENCE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const bundle = parseRevisionChangeBundle(bundleValue);
    const expectedOperation = expectedRevisionOperation(operation);
    assertRecordDates(before.record);
    assertRecordDates(bundle.revision.record);
    assertMemoryRevisionEvidenceBindingV1(bundle.evidence, bundle.revision);
    if (bundle.revision.operation !== expectedOperation ||
        bundle.revision.revision !== before.revision + 1 ||
        bundle.revision.memoryId !== before.memoryId ||
        bundle.revision.previousRevisionHash !== before.revisionHash ||
        bundle.evidence.baseRevisionHash !== before.revisionHash ||
        bundle.evidence.revisionTargetHash !== bundle.revision.record.contentHash ||
        bundle.evidence.memoryId !== before.memoryId ||
        bundle.evidence.revision !== before.revision + 1 ||
        bundle.evidence.operation !== expectedOperation ||
        bundle.evidence.changedByActorRef !== bundle.revision.changedByActorRef ||
        bundle.evidence.changedAt !== bundle.revision.changedAt ||
        bundle.revision.changedAt !== bundle.revision.record.updatedAt) {
        return invalidMemoryValue();
    }
    assertRecordFieldDelta(before.record, bundle.revision.record, expectedOperation);
    return bundle;
}
function buildRevisionChange(value) {
    const operation = value.reference.operation;
    if (!operationAllowed(operation, REVISION_EVIDENCE_OPERATIONS)) {
        return invalidMemoryValue();
    }
    const revisionOperation = expectedRevisionOperation(operation);
    const evidence = createMemoryRevisionEvidenceV1({
        evidenceId: deriveMemoryRevisionEvidenceIdV1({
            ...value.reference,
            memoryId: value.before.memoryId,
            revision: value.before.revision + 1,
            baseRevisionHash: value.before.revisionHash,
            revisionTargetHash: value.record.contentHash
        }),
        evidenceKind: value.evidenceKind,
        namespaceRef: value.before.record.namespaceRef,
        namespaceGeneration: value.before.record.namespaceGeneration,
        memoryId: value.before.memoryId,
        revision: value.before.revision + 1,
        operation: revisionOperation,
        baseRevisionHash: value.before.revisionHash,
        revisionTargetHash: value.record.contentHash,
        changedByActorRef: value.changedByActorRef,
        changedAt: value.freshNow,
        source: value.evidenceSource,
        policyRef: value.policyRef,
        policyGeneration: value.policyGeneration
    });
    if (evidence.source !== null)
        parseNonNegativeInstant(evidence.source.observedAt);
    const revision = createMemoryRevisionV2({
        memoryId: value.record.memoryId,
        revision: value.record.revision,
        operation: revisionOperation,
        record: value.record,
        changedByActorRef: value.changedByActorRef,
        changedAt: value.freshNow,
        reason: value.reason,
        evidence: {
            kind: 'revision',
            evidenceId: evidence.evidenceId,
            evidenceHash: evidence.evidenceHash
        },
        previousRevisionHash: value.before.revisionHash
    });
    return assertMemoryRevisionChangeBundleV1(value.before, operation, Object.freeze({
        schemaVersion: 1,
        kind: 'revision_change_v1',
        evidence,
        revision
    }));
}
function parseRevisionBuilderBase(input, expectedOperationValue) {
    const reference = referenceFromFields(input);
    if (reference.operation !== expectedOperationValue)
        return invalidMemoryValue();
    const before = parseMemoryRevisionV2(input.beforeRevision);
    assertRecordDates(before.record);
    assertReferenceBinding(reference, before.record.namespaceRef, before.record.namespaceGeneration);
    const freshNow = parseNonNegativeInstant(input.freshNow);
    if (Date.parse(freshNow) < Date.parse(before.record.updatedAt)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        reference,
        before,
        changedByActorRef: parseMemoryLifecycleHashedRefV1(input.changedByActorRef, 'actor:'),
        freshNow
    });
}
export function buildMemoryCorrectionBundleV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'beforeRevision',
        'changedByActorRef', 'freshNow', 'text', 'confidence', 'validity', 'conflict',
        'supersedes', 'evidenceKind', 'evidenceSource', 'policyRef', 'policyGeneration',
        'reason'
    ]);
    const base = parseRevisionBuilderBase(input, 'record.correct');
    if (projectMemoryRecordLifecycleV2(base.before.record, base.freshNow).state !== 'current') {
        return invalidMemoryValue();
    }
    const record = recordAfterChange(base.before.record, base.before.revision + 1, base.freshNow, {
        text: input.text,
        confidence: input.confidence,
        validity: input.validity,
        conflict: input.conflict,
        supersedes: input.supersedes
    });
    return buildRevisionChange({
        ...base,
        evidenceKind: input.evidenceKind,
        evidenceSource: input.evidenceSource,
        policyRef: input.policyRef,
        policyGeneration: input.policyGeneration,
        reason: input.reason,
        record
    });
}
export function buildMemoryRenewalBundleV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'beforeRevision',
        'changedByActorRef', 'freshNow', 'newValidUntil', 'evidenceKind',
        'evidenceSource', 'policyRef', 'policyGeneration', 'reason'
    ]);
    const base = parseRevisionBuilderBase(input, 'record.renew');
    if (!projectMemoryRecordLifecycleV2(base.before.record, base.freshNow).renewEligible) {
        return invalidMemoryValue();
    }
    const retention = buildMemoryRenewalRetentionV2({
        currentRetention: base.before.record.retention,
        freshNow: base.freshNow,
        newValidUntil: input.newValidUntil
    });
    const record = recordAfterChange(base.before.record, base.before.revision + 1, base.freshNow, { retention });
    return buildRevisionChange({
        ...base,
        evidenceKind: input.evidenceKind,
        evidenceSource: input.evidenceSource,
        policyRef: input.policyRef,
        policyGeneration: input.policyGeneration,
        reason: input.reason,
        record
    });
}
export function buildMemoryConflictChangeBundleV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'namespaceRef', 'namespaceGeneration', 'beforeRevision',
        'changedByActorRef', 'freshNow', 'validity', 'conflict', 'evidenceKind',
        'evidenceSource', 'policyRef', 'policyGeneration', 'reason'
    ]);
    const base = parseRevisionBuilderBase(input, 'record.changeConflict');
    if (projectMemoryRecordLifecycleV2(base.before.record, base.freshNow).state !== 'current') {
        return invalidMemoryValue();
    }
    const record = recordAfterChange(base.before.record, base.before.revision + 1, base.freshNow, { validity: input.validity, conflict: input.conflict });
    return buildRevisionChange({
        ...base,
        evidenceKind: input.evidenceKind,
        evidenceSource: input.evidenceSource,
        policyRef: input.policyRef,
        policyGeneration: input.policyGeneration,
        reason: input.reason,
        record
    });
}
export function requireMemoryV1ToV2ManifestInventoryV1(value) {
    const input = inspectMemoryRecord(value, [
        'legacyAggregateCount', 'manifest', 'expectation', 'consentEvidence',
        'revisionEvidence'
    ]);
    const revisionEvidenceValues = inspectMemoryArray(input.revisionEvidence, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationRevisionBindings);
    const manifest = requireMemoryV1ToV2AggregateManifestV1(input.legacyAggregateCount, input.manifest, input.expectation);
    if (manifest === null) {
        if (input.consentEvidence !== null || revisionEvidenceValues.length !== 0) {
            return invalidMemoryValue();
        }
        return null;
    }
    let consentEvidence = null;
    if (input.consentEvidence !== null) {
        consentEvidence = parseMemoryConsentEvidenceV1(input.consentEvidence);
        if (consentEvidence.namespaceRef !== manifest.namespaceRef ||
            consentEvidence.namespaceGeneration !== manifest.namespaceGeneration) {
            return invalidMemoryValue();
        }
    }
    if ((manifest.consentEvidenceId === null) !== (consentEvidence === null) ||
        (consentEvidence !== null && (consentEvidence.evidenceId !== manifest.consentEvidenceId ||
            consentEvidence.evidenceHash !== manifest.consentEvidenceHash)))
        return invalidMemoryValue();
    const revisionEvidence = revisionEvidenceValues.map(parseMemoryRevisionEvidenceV1);
    if (revisionEvidence.length !== manifest.revisionEvidenceBindings.length) {
        return invalidMemoryValue();
    }
    for (let index = 0; index < revisionEvidence.length; index += 1) {
        const evidence = revisionEvidence[index];
        const binding = manifest.revisionEvidenceBindings[index];
        if (evidence.namespaceRef !== manifest.namespaceRef ||
            evidence.namespaceGeneration !== manifest.namespaceGeneration ||
            evidence.memoryId !== manifest.plannedMemoryId ||
            evidence.revision !== binding.revision ||
            evidence.evidenceId !== binding.evidenceId ||
            evidence.evidenceHash !== binding.evidenceHash ||
            evidence.revision !== index + 2)
            return invalidMemoryValue();
    }
    if (manifest.aggregate.kind === 'proposal' && revisionEvidence.length !== 0) {
        return invalidMemoryValue();
    }
    if (manifest.aggregate.kind === 'memory' &&
        revisionEvidence.length !== manifest.aggregate.currentRevision - 1) {
        return invalidMemoryValue();
    }
    return manifest;
}
