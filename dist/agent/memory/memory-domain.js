import { createHash } from 'node:crypto';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryGroupLifecycleIdV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1, parseMemoryQqIdV1 } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit, memoryCanonicalTextWithinLimits, memorySourceExcerptWithinLimits, memoryTextWithinLimits } from './memory-resource-limits.js';
export const MEMORY_SOURCE_CONTENT_HASH_DOMAIN = 'groupmate.memory.source-content.v1';
export const MEMORY_SOURCE_ID_HASH_DOMAIN = 'groupmate.memory.source-id.v1';
export const MEMORY_RECORD_CONTENT_HASH_DOMAIN = 'groupmate.memory.record-content.v1';
export const MEMORY_REVISION_HASH_DOMAIN = 'groupmate.memory.revision.v1';
export const MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN = 'groupmate.memory.tombstone-receipt.v1';
export const MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN = 'groupmate.memory.outbox-payload.v1';
const MEMORY_SOURCE_KINDS = [
    'current_message', 'quoted_message', 'group_history', 'private_history',
    'manual_user_input', 'manual_correction'
];
const MEMORY_KINDS = [
    'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
    'task_fact', 'other'
];
const MEMORY_SENSITIVITIES = [
    'public', 'group', 'personal', 'sensitive'
];
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value <= 0 || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function confidenceValue(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
        value < 0 || value > 1)
        return invalidMemoryValue();
    return value;
}
function canonicalHash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function domainSeparatedHash(domain, preimage) {
    return createHash('sha256')
        .update(domain, 'utf8')
        .update('\0')
        .update(preimage, 'utf8')
        .digest('hex');
}
function opaqueId(value, prefix) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        value.length === 0 ||
        (prefix !== undefined && (!value.startsWith(prefix) || value.length === prefix.length))) {
        return invalidMemoryValue();
    }
    return value;
}
function resourceRef(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.resourceRefAsciiBytes) ||
        !value.startsWith('resource:') || value.length === 'resource:'.length || value.includes('://')) {
        return invalidMemoryValue();
    }
    return value;
}
function canonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        return invalidMemoryValue();
    }
    return value;
}
function canonicalizeText(value) {
    if (typeof value !== 'string')
        return invalidMemoryValue();
    return value.replace(/\r\n?/g, '\n').normalize('NFC');
}
function hasSemanticText(value) {
    return /[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
}
function boundedText(value, normalize, maximumUtf8Bytes, maximumCodePoints) {
    const result = normalize ? canonicalizeText(value) : value;
    if (typeof result !== 'string' || (!normalize && (result.includes('\r') ||
        result.normalize('NFC') !== result)) || !memoryCanonicalTextWithinLimits(result, maximumUtf8Bytes, maximumCodePoints))
        return invalidMemoryValue();
    return result;
}
function nullableBoundedText(value, normalize, maximumUtf8Bytes, maximumCodePoints) {
    return value === null
        ? null
        : boundedText(value, normalize, maximumUtf8Bytes, maximumCodePoints);
}
function memoryText(value, normalize) {
    const result = normalize ? canonicalizeText(value) : value;
    if (typeof result !== 'string' || (!normalize && result.includes('\r')) ||
        !memoryTextWithinLimits(result) || !hasSemanticText(result))
        return invalidMemoryValue();
    return result;
}
function sourceText(value, normalize) {
    const result = normalize ? canonicalizeText(value) : value;
    if (typeof result !== 'string' || (!normalize && result.includes('\r')) ||
        !memorySourceExcerptWithinLimits(result) || !hasSemanticText(result)) {
        return invalidMemoryValue();
    }
    return result;
}
function reasonText(value, normalize) {
    const result = nullableBoundedText(value, normalize, MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes, MEMORY_RESOURCE_LIMITS.reasonTextCodePoints);
    if (result !== null && !hasSemanticText(result))
        return invalidMemoryValue();
    return result;
}
function parseIdentityFields(value, create) {
    const input = inspectMemoryRecord(value, create
        ? ['userId', 'nickname', 'groupCard', 'groupTitle', 'groupRole']
        : ['userId', 'nickname', 'groupCard', 'groupTitle', 'groupRole', 'displayName']);
    const userId = parseMemoryQqIdV1(input.userId);
    const nickname = nullableBoundedText(input.nickname, create, MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes, MEMORY_RESOURCE_LIMITS.identityTextCodePoints);
    const groupCard = nullableBoundedText(input.groupCard, create, MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes, MEMORY_RESOURCE_LIMITS.identityTextCodePoints);
    const groupTitle = nullableBoundedText(input.groupTitle, create, MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes, MEMORY_RESOURCE_LIMITS.identityTextCodePoints);
    const trimmedGroupCard = groupCard?.trim() ?? '';
    const trimmedNickname = nickname?.trim() ?? '';
    const displayName = hasSemanticText(trimmedGroupCard)
        ? trimmedGroupCard
        : hasSemanticText(trimmedNickname)
            ? trimmedNickname
            : userId;
    if (!create && input.displayName !== displayName)
        return invalidMemoryValue();
    return Object.freeze({
        userId,
        nickname,
        groupCard,
        groupTitle,
        groupRole: enumValue(input.groupRole, ['owner', 'admin', 'member', 'unknown']),
        displayName
    });
}
export function createQqIdentitySnapshotV1(value) {
    return parseIdentityFields(value, true);
}
export function parseQqIdentitySnapshotV1(value) {
    return parseIdentityFields(value, false);
}
export function parseQqSceneSnapshotV1(value) {
    const discriminator = inspectMemoryRecord(value, ['kind'], ['groupId', 'groupLifecycleId', 'groupName']);
    if (discriminator.kind === 'private') {
        const input = inspectMemoryRecord(value, ['kind', 'groupId', 'groupLifecycleId', 'groupName']);
        if (input.groupId !== null || input.groupLifecycleId !== null || input.groupName !== null) {
            return invalidMemoryValue();
        }
        return Object.freeze({
            kind: 'private',
            groupId: null,
            groupLifecycleId: null,
            groupName: null
        });
    }
    if (discriminator.kind === 'group') {
        const input = inspectMemoryRecord(value, ['kind', 'groupId', 'groupLifecycleId', 'groupName']);
        return Object.freeze({
            kind: 'group',
            groupId: parseMemoryQqIdV1(input.groupId),
            groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId),
            groupName: nullableBoundedText(input.groupName, false, MEMORY_RESOURCE_LIMITS.identityTextUtf8Bytes, MEMORY_RESOURCE_LIMITS.identityTextCodePoints)
        });
    }
    return invalidMemoryValue();
}
function identityPreimage(identity) {
    return JSON.stringify({
        userId: identity.userId,
        nickname: identity.nickname,
        groupCard: identity.groupCard,
        groupTitle: identity.groupTitle,
        groupRole: identity.groupRole,
        displayName: identity.displayName
    });
}
function scenePreimage(scene) {
    return JSON.stringify({
        kind: scene.kind,
        groupId: scene.groupId,
        groupLifecycleId: scene.groupLifecycleId,
        groupName: scene.groupName
    });
}
function sourceIdPreimage(source) {
    return `{"schemaVersion":1,"sourceKind":${JSON.stringify(source.sourceKind)},"messageId":${JSON.stringify(source.messageId)},"actor":${identityPreimage(source.actor)},"scene":${scenePreimage(source.scene)},"observedAt":${JSON.stringify(source.observedAt)},"normalizedText":${JSON.stringify(source.normalizedText)},"contentHash":${JSON.stringify(source.contentHash)},"resourceRefs":${JSON.stringify(source.resourceRefs)}}`;
}
function parseResourceRefs(value) {
    const refs = inspectMemoryArray(value, MEMORY_RESOURCE_LIMITS.sourceResourceRefs)
        .map(resourceRef);
    if (new Set(refs).size !== refs.length)
        return invalidMemoryValue();
    return Object.freeze(refs);
}
function validateSourceMatrix(sourceKind, messageId, actor, scene) {
    const manual = sourceKind === 'manual_user_input' || sourceKind === 'manual_correction';
    if (!manual && messageId === null)
        return invalidMemoryValue();
    if (sourceKind === 'group_history' && scene.kind !== 'group')
        return invalidMemoryValue();
    if (sourceKind === 'private_history' && scene.kind !== 'private')
        return invalidMemoryValue();
    if (scene.kind === 'private' && (actor.groupCard !== null || actor.groupTitle !== null || actor.groupRole !== 'unknown'))
        return invalidMemoryValue();
}
function parseSourceFields(value, includeComputed, normalize) {
    const baseKeys = [
        'sourceKind', 'messageId', 'actor', 'scene', 'observedAt', 'normalizedText', 'resourceRefs'
    ];
    const input = inspectMemoryRecord(value, includeComputed
        ? ['schemaVersion', 'sourceId', ...baseKeys.slice(0, 6), 'contentHash', 'resourceRefs']
        : baseKeys);
    if (includeComputed && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const sourceKind = enumValue(input.sourceKind, MEMORY_SOURCE_KINDS);
    const messageId = input.messageId === null ? null : opaqueId(input.messageId);
    const actor = parseQqIdentitySnapshotV1(input.actor);
    const scene = parseQqSceneSnapshotV1(input.scene);
    validateSourceMatrix(sourceKind, messageId, actor, scene);
    const observedAt = canonicalInstant(input.observedAt);
    const normalizedText = sourceText(input.normalizedText, normalize);
    const contentHash = domainSeparatedHash(MEMORY_SOURCE_CONTENT_HASH_DOMAIN, normalizedText);
    const resourceRefs = parseResourceRefs(input.resourceRefs);
    const withoutId = Object.freeze({
        schemaVersion: 1,
        sourceKind,
        messageId,
        actor,
        scene,
        observedAt,
        normalizedText,
        contentHash,
        resourceRefs
    });
    const sourceId = domainSeparatedHash(MEMORY_SOURCE_ID_HASH_DOMAIN, sourceIdPreimage(withoutId));
    if (includeComputed && (canonicalHash(input.contentHash) !== contentHash || canonicalHash(input.sourceId) !== sourceId))
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        sourceId,
        sourceKind,
        messageId,
        actor,
        scene,
        observedAt,
        normalizedText,
        contentHash,
        resourceRefs
    });
}
export function createMemorySourceV1(value) {
    return parseSourceFields(value, false, true);
}
export function parseMemorySourceV1(value) {
    return parseSourceFields(value, true, false);
}
function parseSources(value) {
    const sources = inspectMemoryArray(value, MEMORY_RESOURCE_LIMITS.sources)
        .map(parseMemorySourceV1);
    if (sources.length === 0 || new Set(sources.map(source => source.sourceId)).size !== sources.length) {
        return invalidMemoryValue();
    }
    return Object.freeze(sources);
}
function parseMemoryKind(value) {
    return enumValue(value, MEMORY_KINDS);
}
function parseSensitivity(value) {
    return enumValue(value, MEMORY_SENSITIVITIES);
}
function parseMemoryId(value) {
    return opaqueId(value, 'memory:');
}
function parseConflict(value, normalize, ownMemoryId = null) {
    const input = inspectMemoryRecord(value, ['state', 'relatedMemoryIds', 'note']);
    const state = enumValue(input.state, ['none', 'possible', 'confirmed']);
    const relatedMemoryIds = inspectMemoryArray(input.relatedMemoryIds, MEMORY_RESOURCE_LIMITS.conflictRefs).map(parseMemoryId);
    if (new Set(relatedMemoryIds).size !== relatedMemoryIds.length ||
        (ownMemoryId !== null && relatedMemoryIds.includes(ownMemoryId)))
        return invalidMemoryValue();
    const note = reasonText(input.note, normalize);
    if (state === 'none') {
        if (relatedMemoryIds.length !== 0 || note !== null)
            return invalidMemoryValue();
    }
    else if (relatedMemoryIds.length === 0 || note === null || note.trim().length === 0) {
        return invalidMemoryValue();
    }
    return Object.freeze({ state, relatedMemoryIds: Object.freeze(relatedMemoryIds), note });
}
function parseRetention(value) {
    const input = inspectMemoryRecord(value, ['validUntil', 'purgeAt']);
    const validUntil = canonicalInstant(input.validUntil);
    const purgeAt = canonicalInstant(input.purgeAt);
    if (Date.parse(purgeAt) < Date.parse(validUntil))
        return invalidMemoryValue();
    return Object.freeze({ validUntil, purgeAt });
}
function parseProposer(value) {
    const discriminator = inspectMemoryRecord(value, ['kind'], ['runRef', 'modelProfile', 'actorRef', 'policyRef']);
    if (discriminator.kind === 'model') {
        const input = inspectMemoryRecord(value, ['kind', 'runRef', 'modelProfile']);
        return Object.freeze({
            kind: 'model',
            runRef: opaqueId(input.runRef, 'run:'),
            modelProfile: opaqueId(input.modelProfile)
        });
    }
    if (discriminator.kind === 'user') {
        const input = inspectMemoryRecord(value, ['kind', 'actorRef']);
        return Object.freeze({ kind: 'user', actorRef: opaqueId(input.actorRef, 'actor:') });
    }
    if (discriminator.kind === 'system_policy') {
        const input = inspectMemoryRecord(value, ['kind', 'policyRef']);
        return Object.freeze({
            kind: 'system_policy',
            policyRef: opaqueId(input.policyRef, 'policy:')
        });
    }
    return invalidMemoryValue();
}
function parseProposalDecision(value, normalize) {
    if (value === null)
        return null;
    const input = inspectMemoryRecord(value, ['decidedAt', 'decidedByActorRef', 'reason']);
    return Object.freeze({
        decidedAt: canonicalInstant(input.decidedAt),
        decidedByActorRef: opaqueId(input.decidedByActorRef, 'actor:'),
        reason: reasonText(input.reason, normalize)
    });
}
function parseProposalFields(value, create) {
    const storedKeys = [
        'schemaVersion', 'proposalId', 'revision', 'namespace', 'namespaceRef', 'state',
        'proposedBy', 'kind', 'text', 'sources', 'observedAt', 'proposedAt', 'confidence',
        'sensitivity', 'conflict', 'suggestedRetention', 'consentRequirement', 'decision'
    ];
    const draftKeys = [
        'proposalId', 'namespace', 'proposedBy', 'kind', 'text', 'sources', 'observedAt',
        'proposedAt', 'confidence', 'sensitivity', 'conflict', 'suggestedRetention',
        'consentRequirement'
    ];
    const input = inspectMemoryRecord(value, create ? draftKeys : storedKeys);
    if (!create && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = memoryNamespaceRefV1(namespace);
    if (!create && parseMemoryNamespaceRefV1(input.namespaceRef) !== namespaceRef) {
        return invalidMemoryValue();
    }
    const revision = create ? 1 : positiveInteger(input.revision);
    const state = create
        ? 'pending'
        : enumValue(input.state, ['pending', 'approved', 'rejected', 'expired']);
    const decision = create ? null : parseProposalDecision(input.decision, false);
    if ((state === 'pending' && decision !== null) ||
        (state !== 'pending' && (decision === null || revision < 2)))
        return invalidMemoryValue();
    const observedAt = canonicalInstant(input.observedAt);
    const proposedAt = canonicalInstant(input.proposedAt);
    if (Date.parse(observedAt) > Date.parse(proposedAt) ||
        (decision !== null && Date.parse(decision.decidedAt) < Date.parse(proposedAt))) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        proposalId: opaqueId(input.proposalId, 'proposal:'),
        revision,
        namespace,
        namespaceRef,
        state,
        proposedBy: parseProposer(input.proposedBy),
        kind: parseMemoryKind(input.kind),
        text: memoryText(input.text, create),
        sources: parseSources(input.sources),
        observedAt,
        proposedAt,
        confidence: confidenceValue(input.confidence),
        sensitivity: parseSensitivity(input.sensitivity),
        conflict: parseConflict(input.conflict, create),
        suggestedRetention: parseRetention(input.suggestedRetention),
        consentRequirement: enumValue(input.consentRequirement, ['explicit', 'owner_policy', 'group_policy']),
        decision
    });
}
export function createMemoryProposalV1(value) {
    return parseProposalFields(value, true);
}
export function parseMemoryProposalV1(value) {
    return parseProposalFields(value, false);
}
function parseValidity(value) {
    const input = inspectMemoryRecord(value, ['state', 'validFrom']);
    const state = enumValue(input.state, ['current', 'uncertain', 'superseded']);
    const validFrom = input.validFrom === null ? null : canonicalInstant(input.validFrom);
    if ((state === 'uncertain' && validFrom !== null) ||
        (state !== 'uncertain' && validFrom === null))
        return invalidMemoryValue();
    return Object.freeze({ state, validFrom });
}
function parseConsent(value, sourceIds) {
    const input = inspectMemoryRecord(value, [
        'state', 'approvedByActorRef', 'evidenceSourceId', 'policyRef', 'approvedAt'
    ]);
    const state = enumValue(input.state, ['explicit', 'owner_policy', 'group_policy']);
    const evidenceSourceId = input.evidenceSourceId === null
        ? null
        : canonicalHash(input.evidenceSourceId);
    const policyRef = input.policyRef === null ? null : opaqueId(input.policyRef, 'policy:');
    if (state === 'explicit') {
        if (evidenceSourceId === null || !sourceIds.has(evidenceSourceId) || policyRef !== null) {
            return invalidMemoryValue();
        }
    }
    else if (evidenceSourceId !== null || policyRef === null) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        state,
        approvedByActorRef: opaqueId(input.approvedByActorRef, 'actor:'),
        evidenceSourceId,
        policyRef,
        approvedAt: canonicalInstant(input.approvedAt)
    });
}
function parseSupersedes(value, ownMemoryId) {
    const ids = inspectMemoryArray(value, MEMORY_RESOURCE_LIMITS.supersedesRefs)
        .map(parseMemoryId);
    if (new Set(ids).size !== ids.length || ids.includes(ownMemoryId))
        return invalidMemoryValue();
    return Object.freeze(ids);
}
function recordContentPreimage(record) {
    return JSON.stringify({
        schemaVersion: 1,
        memoryId: record.memoryId,
        revision: record.revision,
        namespace: record.namespace,
        namespaceRef: record.namespaceRef,
        namespaceGeneration: record.namespaceGeneration,
        kind: record.kind,
        text: record.text,
        sources: record.sources,
        createdAt: record.createdAt,
        observedAt: record.observedAt,
        confirmedAt: record.confirmedAt,
        updatedAt: record.updatedAt,
        validity: record.validity,
        confidence: record.confidence,
        consent: record.consent,
        sensitivity: record.sensitivity,
        conflict: record.conflict,
        supersedes: record.supersedes,
        retention: record.retention,
        deletionState: record.deletionState
    });
}
function parseRecordFields(value, create) {
    const baseKeys = [
        'memoryId', 'revision', 'namespace', 'namespaceRef', 'namespaceGeneration', 'kind',
        'text', 'sources', 'createdAt', 'observedAt', 'confirmedAt', 'updatedAt', 'validity',
        'confidence', 'consent', 'sensitivity', 'conflict', 'supersedes', 'retention',
        'deletionState'
    ];
    const input = inspectMemoryRecord(value, create ? baseKeys : ['schemaVersion', ...baseKeys, 'contentHash']);
    if (!create && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const memoryId = parseMemoryId(input.memoryId);
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = memoryNamespaceRefV1(namespace);
    if (parseMemoryNamespaceRefV1(input.namespaceRef) !== namespaceRef) {
        return invalidMemoryValue();
    }
    const sources = parseSources(input.sources);
    const sourceIds = new Set(sources.map(source => source.sourceId));
    const createdAt = canonicalInstant(input.createdAt);
    const observedAt = canonicalInstant(input.observedAt);
    const confirmedAt = canonicalInstant(input.confirmedAt);
    const updatedAt = canonicalInstant(input.updatedAt);
    if (Date.parse(createdAt) > Date.parse(confirmedAt) ||
        Date.parse(confirmedAt) > Date.parse(updatedAt))
        return invalidMemoryValue();
    const consent = parseConsent(input.consent, sourceIds);
    if (Date.parse(consent.approvedAt) > Date.parse(updatedAt))
        return invalidMemoryValue();
    const withoutHash = Object.freeze({
        schemaVersion: 1,
        memoryId,
        revision: positiveInteger(input.revision),
        namespace,
        namespaceRef,
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        kind: parseMemoryKind(input.kind),
        text: memoryText(input.text, create),
        sources,
        createdAt,
        observedAt,
        confirmedAt,
        updatedAt,
        validity: parseValidity(input.validity),
        confidence: confidenceValue(input.confidence),
        consent,
        sensitivity: parseSensitivity(input.sensitivity),
        conflict: parseConflict(input.conflict, create, memoryId),
        supersedes: parseSupersedes(input.supersedes, memoryId),
        retention: parseRetention(input.retention),
        deletionState: enumValue(input.deletionState, ['active'])
    });
    const contentHash = domainSeparatedHash(MEMORY_RECORD_CONTENT_HASH_DOMAIN, recordContentPreimage(withoutHash));
    if (!create && canonicalHash(input.contentHash) !== contentHash)
        return invalidMemoryValue();
    return Object.freeze({ ...withoutHash, contentHash });
}
export function createMemoryRecordV1(value) {
    return parseRecordFields(value, true);
}
export function parseMemoryRecordV1(value) {
    return parseRecordFields(value, false);
}
function revisionPreimage(revision) {
    return JSON.stringify({
        schemaVersion: 1,
        memoryId: revision.memoryId,
        revision: revision.revision,
        operation: revision.operation,
        record: revision.record,
        changedByActorRef: revision.changedByActorRef,
        changedAt: revision.changedAt,
        reason: revision.reason,
        previousRevisionHash: revision.previousRevisionHash
    });
}
function parseRevisionFields(value, create) {
    const baseKeys = [
        'memoryId', 'revision', 'operation', 'record', 'changedByActorRef', 'changedAt',
        'reason', 'previousRevisionHash'
    ];
    const input = inspectMemoryRecord(value, create ? baseKeys : ['schemaVersion', ...baseKeys, 'revisionHash']);
    if (!create && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const memoryId = parseMemoryId(input.memoryId);
    const revision = positiveInteger(input.revision);
    const operation = enumValue(input.operation, ['created', 'corrected', 'retention_changed', 'conflict_changed']);
    const record = parseMemoryRecordV1(input.record);
    const previousRevisionHash = input.previousRevisionHash === null
        ? null
        : canonicalHash(input.previousRevisionHash);
    if (record.memoryId !== memoryId || record.revision !== revision)
        return invalidMemoryValue();
    if (operation === 'created') {
        if (revision !== 1 || previousRevisionHash !== null)
            return invalidMemoryValue();
    }
    else if (revision < 2 || previousRevisionHash === null) {
        return invalidMemoryValue();
    }
    const changedAt = canonicalInstant(input.changedAt);
    if (changedAt !== record.updatedAt)
        return invalidMemoryValue();
    const withoutHash = Object.freeze({
        schemaVersion: 1,
        memoryId,
        revision,
        operation,
        record,
        changedByActorRef: opaqueId(input.changedByActorRef, 'actor:'),
        changedAt,
        reason: reasonText(input.reason, create),
        previousRevisionHash
    });
    const revisionHash = domainSeparatedHash(MEMORY_REVISION_HASH_DOMAIN, revisionPreimage(withoutHash));
    if (!create && canonicalHash(input.revisionHash) !== revisionHash)
        return invalidMemoryValue();
    return Object.freeze({ ...withoutHash, revisionHash });
}
export function createMemoryRevisionV1(value) {
    return parseRevisionFields(value, true);
}
export function parseMemoryRevisionV1(value) {
    return parseRevisionFields(value, false);
}
function tombstonePreimage(tombstone) {
    return JSON.stringify({
        schemaVersion: 1,
        tombstoneId: tombstone.tombstoneId,
        namespaceRef: tombstone.namespaceRef,
        namespaceGeneration: tombstone.namespaceGeneration,
        memoryId: tombstone.memoryId,
        deletedRevision: tombstone.deletedRevision,
        deletionKind: tombstone.deletionKind,
        deletedAt: tombstone.deletedAt,
        deletedByActorRef: tombstone.deletedByActorRef,
        reasonCode: tombstone.reasonCode,
        expiresAt: tombstone.expiresAt
    });
}
function parseTombstoneFields(value, create) {
    const baseKeys = [
        'tombstoneId', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'deletedRevision',
        'deletionKind', 'deletedAt', 'deletedByActorRef', 'reasonCode', 'expiresAt'
    ];
    const input = inspectMemoryRecord(value, create ? baseKeys : [
        'schemaVersion', ...baseKeys.slice(0, 9), 'receiptHash', 'expiresAt'
    ]);
    if (!create && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const deletionKind = enumValue(input.deletionKind, ['memory_forgotten', 'namespace_deleted']);
    const memoryId = input.memoryId === null ? null : parseMemoryId(input.memoryId);
    const deletedRevision = input.deletedRevision === null
        ? null
        : positiveInteger(input.deletedRevision);
    if (deletionKind === 'memory_forgotten') {
        if (memoryId === null || deletedRevision === null)
            return invalidMemoryValue();
    }
    else if (memoryId !== null || deletedRevision !== null) {
        return invalidMemoryValue();
    }
    const deletedAt = canonicalInstant(input.deletedAt);
    const expiresAt = canonicalInstant(input.expiresAt);
    if (Date.parse(expiresAt) - Date.parse(deletedAt) !==
        MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs)
        return invalidMemoryValue();
    const withoutHash = Object.freeze({
        schemaVersion: 1,
        tombstoneId: opaqueId(input.tombstoneId, 'tombstone:'),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        memoryId,
        deletedRevision,
        deletionKind,
        deletedAt,
        deletedByActorRef: opaqueId(input.deletedByActorRef, 'actor:'),
        reasonCode: opaqueId(input.reasonCode),
        expiresAt
    });
    const receiptHash = domainSeparatedHash(MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN, tombstonePreimage(withoutHash));
    if (!create && canonicalHash(input.receiptHash) !== receiptHash)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: withoutHash.schemaVersion,
        tombstoneId: withoutHash.tombstoneId,
        namespaceRef: withoutHash.namespaceRef,
        namespaceGeneration: withoutHash.namespaceGeneration,
        memoryId: withoutHash.memoryId,
        deletedRevision: withoutHash.deletedRevision,
        deletionKind: withoutHash.deletionKind,
        deletedAt: withoutHash.deletedAt,
        deletedByActorRef: withoutHash.deletedByActorRef,
        reasonCode: withoutHash.reasonCode,
        receiptHash,
        expiresAt: withoutHash.expiresAt
    });
}
export function createMemoryTombstoneV1(value) {
    return parseTombstoneFields(value, true);
}
export function parseMemoryTombstoneV1(value) {
    return parseTombstoneFields(value, false);
}
function outboxPreimage(event) {
    return JSON.stringify({
        schemaVersion: 1,
        eventId: event.eventId,
        sequence: event.sequence,
        namespaceRef: event.namespaceRef,
        namespaceGeneration: event.namespaceGeneration,
        aggregate: event.aggregate,
        aggregateId: event.aggregateId,
        revision: event.revision,
        eventKind: event.eventKind,
        occurredAt: event.occurredAt
    });
}
function parseOutboxFields(value, create) {
    const baseKeys = [
        'eventId', 'sequence', 'namespaceRef', 'namespaceGeneration', 'aggregate',
        'aggregateId', 'revision', 'eventKind', 'occurredAt'
    ];
    const input = inspectMemoryRecord(value, create ? baseKeys : ['schemaVersion', ...baseKeys, 'payloadHash']);
    if (!create && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    const aggregate = enumValue(input.aggregate, ['proposal', 'record', 'namespace']);
    const revision = positiveInteger(input.revision);
    const eventKind = enumValue(input.eventKind, ['proposal_changed', 'record_upserted', 'record_forgotten', 'namespace_deleted']);
    let aggregateId;
    if (aggregate === 'proposal') {
        aggregateId = opaqueId(input.aggregateId, 'proposal:');
        if (eventKind !== 'proposal_changed')
            return invalidMemoryValue();
    }
    else if (aggregate === 'record') {
        aggregateId = parseMemoryId(input.aggregateId);
        if (eventKind !== 'record_upserted' && eventKind !== 'record_forgotten') {
            return invalidMemoryValue();
        }
    }
    else {
        aggregateId = parseMemoryNamespaceRefV1(input.aggregateId);
        if (aggregateId !== namespaceRef || eventKind !== 'namespace_deleted' ||
            revision !== namespaceGeneration)
            return invalidMemoryValue();
    }
    const withoutHash = Object.freeze({
        schemaVersion: 1,
        eventId: opaqueId(input.eventId, 'event:'),
        sequence: positiveInteger(input.sequence),
        namespaceRef,
        namespaceGeneration,
        aggregate,
        aggregateId,
        revision,
        eventKind,
        occurredAt: canonicalInstant(input.occurredAt)
    });
    const payloadHash = domainSeparatedHash(MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN, outboxPreimage(withoutHash));
    if (!create && canonicalHash(input.payloadHash) !== payloadHash)
        return invalidMemoryValue();
    return Object.freeze({ ...withoutHash, payloadHash });
}
export function createMemoryOutboxEventV1(value) {
    return parseOutboxFields(value, true);
}
export function parseMemoryOutboxEventV1(value) {
    return parseOutboxFields(value, false);
}
