import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { memoryLifecycleActorCapabilityAllowsV1, memoryLifecycleActorCapabilityRoleV1 } from './memory-lifecycle-authority.js';
import { projectMemoryProposalLifecycleV2, projectMemoryRecordLifecycleV2 } from './memory-lifecycle-builder.js';
import { memoryLifecycleCommandRefHashV1 } from './memory-lifecycle-command.js';
import { parseDeletionMutationReceiptV1, parseDeletionStatusV1, parseMemoryLifecycleAuditV1, parseMemoryLifecycleHashV1, parseMemoryLifecycleHashedRefV1, parseMemoryLifecycleInstantV1, parseMemoryProposalV2, parseMemoryRecordV2, parseMemoryRevisionV2 } from './memory-lifecycle-domain.js';
import { parseMemoryTombstoneV1 } from './memory-domain.js';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, parseMemoryBotInstanceIdV1, parseMemoryNamespaceRefV1, parseMemoryQqIdV1 } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_RESOURCE_LIMITS, memoryTextWithinLimits } from './memory-resource-limits.js';
const OPERATIONS = Object.freeze([
    'proposal.list', 'proposal.inspect', 'record.listSafe', 'record.inspectGet', 'record.inspectList',
    'revision.get', 'revision.list', 'tombstone.list', 'audit.list',
    'deletion.getStatus', 'deletion.resolve', 'usage.getGlobal'
]);
const LIST_OPERATIONS = new Set([
    'proposal.list', 'record.listSafe', 'record.inspectList', 'revision.list', 'tombstone.list',
    'audit.list'
]);
const PROPOSAL_STATES = Object.freeze([
    'pending', 'approved', 'rejected', 'withdrawn', 'expired'
]);
const MEMORY_KINDS = Object.freeze([
    'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
    'task_fact', 'other'
]);
const MEMORY_SENSITIVITIES = Object.freeze([
    'public', 'group', 'personal', 'sensitive'
]);
const GROUP_SAFE_MEMORY_KINDS = new Set([
    'group_rule', 'group_culture', 'task_fact', 'other'
]);
const REQUEST_AUTH_FIELDS = Object.freeze([
    'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
    'access', 'actor'
]);
const REQUEST_OPERATION_FIELDS = Object.freeze([
    'states', 'proposalId', 'memoryId', 'revision', 'cursor', 'limit', 'maxWireBytes',
    'deletionRef', 'commandRef', 'targetGeneration', 'cursorAnchor'
]);
const RESULT_FIELDS = Object.freeze([
    'operation', 'snapshotAt', 'records', 'nextCursor', 'wireBytes', 'corruptRecords',
    'corruptRefs', 'value', 'effectiveState', 'receipt', 'deletionStatus', 'category',
    'retryable', 'head', 'nextCursorAnchor'
]);
const CURSOR_PATTERN = /^memory-control-cursor:v1:[0-9a-f]{64}$/;
const SCENE_REF_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_CURSOR_HASH_DOMAIN_V1 = 'groupmate.memory.control-revision-cursor.v1';
const PROPOSAL_CURSOR_HASH_DOMAIN_V1 = 'groupmate.memory.control-proposal-cursor.v1';
const MIN_LIST_PAGE_WIRE_BYTES = 1_024;
const ABORTED_RESULT = Object.freeze({ status: 'aborted' });
const DENIED_ACCESS_RESULT = Object.freeze({ status: 'denied', category: 'access' });
const DENIED_AUTHORITY_RESULT = Object.freeze({
    status: 'denied',
    category: 'authority'
});
const ADAPTER_CONTRACT_RESULT = Object.freeze({
    status: 'corrupt',
    category: 'adapter_contract'
});
const ADAPTER_IO_RESULT = Object.freeze({
    status: 'unavailable',
    category: 'io',
    retryable: true
});
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        value > maximum || Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function nonnegativeInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function sceneRef(value) {
    if (typeof value !== 'string' || !SCENE_REF_PATTERN.test(value))
        return invalidMemoryValue();
    return value;
}
function cursor(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || !CURSOR_PATTERN.test(value))
        return invalidMemoryValue();
    return value;
}
function actorRef(value) {
    return parseMemoryLifecycleHashedRefV1(value, 'actor:');
}
function proposalRef(value) {
    return parseMemoryLifecycleHashedRefV1(value, 'proposal:');
}
function memoryRef(value) {
    return parseMemoryLifecycleHashedRefV1(value, 'memory:');
}
function deletionRef(value) {
    return parseMemoryLifecycleHashedRefV1(value, 'deletion:');
}
function commandRef(value) {
    return parseMemoryLifecycleHashedRefV1(value, 'command:');
}
function parseRevisionCursorAnchor(value) {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'revision', 'revisionHash']);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
        revisionHash: parseMemoryLifecycleHashV1(input.revisionHash)
    });
}
export function memoryRevisionHistoryCursorV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'anchor'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const canonical = Object.freeze({
        schemaVersion: 1,
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        memoryId: memoryRef(input.memoryId),
        anchor: parseRevisionCursorAnchor(input.anchor)
    });
    const digest = createHash('sha256')
        .update(REVISION_CURSOR_HASH_DOMAIN_V1, 'utf8')
        .update('\0')
        .update(JSON.stringify(canonical), 'utf8')
        .digest('hex');
    return `memory-control-cursor:v1:${digest}`;
}
function parseProposalCursorAnchor(value) {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'proposedAt', 'proposalId']);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        proposedAt: parseMemoryLifecycleInstantV1(input.proposedAt),
        proposalId: proposalRef(input.proposalId)
    });
}
export function memoryProposalListCursorV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'states', 'anchor'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const states = parseProposalStates(input.states);
    const canonical = Object.freeze({
        schemaVersion: 1,
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        states,
        anchor: parseProposalCursorAnchor(input.anchor)
    });
    const digest = createHash('sha256')
        .update(PROPOSAL_CURSOR_HASH_DOMAIN_V1, 'utf8')
        .update('\0')
        .update(JSON.stringify(canonical), 'utf8')
        .digest('hex');
    return `memory-control-cursor:v1:${digest}`;
}
function parseProposalCursorBinding(cursorValue, anchorValue, namespaceRef, namespaceGeneration, states) {
    if (cursorValue === null) {
        if (anchorValue !== undefined && anchorValue !== null)
            return invalidMemoryValue();
        return null;
    }
    if (anchorValue === undefined || anchorValue === null)
        return invalidMemoryValue();
    const anchor = parseProposalCursorAnchor(anchorValue);
    if (memoryProposalListCursorV1({
        schemaVersion: 1,
        namespaceRef,
        namespaceGeneration,
        states,
        anchor
    }) !== cursorValue)
        return invalidMemoryValue();
    return anchor;
}
function parseRevisionCursorBinding(cursorValue, anchorValue, namespaceRef, namespaceGeneration, memoryId) {
    if (cursorValue === null) {
        if (anchorValue !== null)
            return invalidMemoryValue();
        return null;
    }
    if (anchorValue === null)
        return invalidMemoryValue();
    const anchor = parseRevisionCursorAnchor(anchorValue);
    if (memoryRevisionHistoryCursorV1({
        schemaVersion: 1,
        namespaceRef,
        namespaceGeneration,
        memoryId,
        anchor
    }) !== cursorValue)
        return invalidMemoryValue();
    return anchor;
}
function parsePageFields(input, maximumRecords = MEMORY_RESOURCE_LIMITS.listPageRecords) {
    const maxWireBytes = positiveInteger(input.maxWireBytes, MEMORY_RESOURCE_LIMITS.listPageWireBytes);
    if (maxWireBytes < MIN_LIST_PAGE_WIRE_BYTES)
        return invalidMemoryValue();
    return Object.freeze({
        cursor: cursor(input.cursor),
        limit: positiveInteger(input.limit, maximumRecords),
        maxWireBytes
    });
}
function parseAuthorization(input) {
    if (input.access === null || typeof input.access !== 'object' ||
        utilTypes.isProxy(input.access) || input.actor === null || typeof input.actor !== 'object' ||
        utilTypes.isProxy(input.actor))
        return invalidMemoryValue();
    return Object.freeze({
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        accountId: parseMemoryQqIdV1(input.accountId),
        sceneRef: sceneRef(input.sceneRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        generation: positiveInteger(input.generation),
        actorRef: actorRef(input.actorRef),
        access: input.access,
        actor: input.actor
    });
}
function parseProposalStates(value) {
    if (value === undefined)
        return Object.freeze(['pending']);
    const parsed = inspectMemoryArray(value, PROPOSAL_STATES.length)
        .map(item => enumValue(item, PROPOSAL_STATES));
    if (parsed.length === 0 || new Set(parsed).size !== parsed.length)
        return invalidMemoryValue();
    parsed.sort((left, right) => PROPOSAL_STATES.indexOf(left) - PROPOSAL_STATES.indexOf(right));
    return Object.freeze(parsed);
}
function parseRequest(value) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'operation', ...REQUEST_AUTH_FIELDS], REQUEST_OPERATION_FIELDS);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(discriminator.operation, OPERATIONS);
    const common = ['schemaVersion', 'operation', ...REQUEST_AUTH_FIELDS];
    let input;
    let operationFields;
    if (operation === 'proposal.list') {
        input = inspectMemoryRecord(value, [...common, 'cursor', 'limit', 'maxWireBytes'], ['states', 'cursorAnchor']);
        const authorization = parseAuthorization(input);
        const page = parsePageFields(input);
        const states = parseProposalStates(input.states);
        operationFields = {
            ...page,
            states,
            cursorAnchor: parseProposalCursorBinding(page.cursor, input.cursorAnchor, authorization.namespaceRef, authorization.generation, states)
        };
    }
    else if (operation === 'proposal.inspect') {
        input = inspectMemoryRecord(value, [...common, 'proposalId']);
        operationFields = { proposalId: proposalRef(input.proposalId) };
    }
    else if (operation === 'record.inspectGet') {
        input = inspectMemoryRecord(value, [...common, 'memoryId']);
        operationFields = { memoryId: memoryRef(input.memoryId) };
    }
    else if (operation === 'record.inspectList' || operation === 'record.listSafe') {
        input = inspectMemoryRecord(value, [...common, 'cursor', 'limit', 'maxWireBytes']);
        operationFields = { ...parsePageFields(input) };
    }
    else if (operation === 'tombstone.list' || operation === 'audit.list') {
        input = inspectMemoryRecord(value, [...common, 'cursor', 'limit', 'maxWireBytes'], ['targetGeneration']);
        const authorization = parseAuthorization(input);
        const targetGeneration = input.targetGeneration === undefined
            ? authorization.generation
            : positiveInteger(input.targetGeneration, authorization.generation);
        operationFields = { ...parsePageFields(input), targetGeneration };
    }
    else if (operation === 'revision.get') {
        input = inspectMemoryRecord(value, [...common, 'memoryId', 'revision']);
        operationFields = {
            memoryId: memoryRef(input.memoryId),
            revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions)
        };
    }
    else if (operation === 'revision.list') {
        input = inspectMemoryRecord(value, [
            ...common, 'memoryId', 'cursor', 'cursorAnchor', 'limit', 'maxWireBytes'
        ]);
        const authorization = parseAuthorization(input);
        const memoryId = memoryRef(input.memoryId);
        const page = parsePageFields(input, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions);
        operationFields = {
            memoryId,
            ...page,
            cursorAnchor: parseRevisionCursorBinding(page.cursor, input.cursorAnchor, authorization.namespaceRef, authorization.generation, memoryId)
        };
    }
    else if (operation === 'deletion.getStatus') {
        input = inspectMemoryRecord(value, [...common, 'deletionRef']);
        operationFields = { deletionRef: deletionRef(input.deletionRef) };
    }
    else if (operation === 'deletion.resolve') {
        input = inspectMemoryRecord(value, [...common, 'deletionRef', 'commandRef']);
        operationFields = {
            deletionRef: deletionRef(input.deletionRef),
            commandRef: commandRef(input.commandRef)
        };
    }
    else {
        input = inspectMemoryRecord(value, common);
        operationFields = {};
    }
    const authorization = parseAuthorization(input);
    const adapterRequest = Object.freeze({
        schemaVersion: 1,
        operation,
        namespaceRef: authorization.namespaceRef,
        generation: authorization.generation,
        ...operationFields
    });
    return Object.freeze({ authorization, adapterRequest });
}
function actionForRequest(request) {
    if (request.operation === 'record.listSafe')
        return 'list_safe';
    if (request.operation === 'deletion.getStatus' || request.operation === 'deletion.resolve' ||
        ((request.operation === 'tombstone.list' || request.operation === 'audit.list') &&
            request.targetGeneration < request.generation)) {
        return 'resolve_deletion';
    }
    return 'inspect_full';
}
function requiredAuthority(action, role) {
    if (action === 'list_safe')
        return 'safe';
    if (action === 'resolve_deletion') {
        return role === 'personal_bot_master' ? 'delete_only' : 'elevated';
    }
    return 'ordinary';
}
function authorizationDenial(parsed, now) {
    const { authorization, adapterRequest } = parsed;
    if (!memoryAccessCapabilityAllowsV1(authorization.access, authorization.namespaceRef, now))
        return DENIED_ACCESS_RESULT;
    const access = authorization.access;
    if (access.botInstanceId !== authorization.botInstanceId ||
        access.accountId !== authorization.accountId || access.sceneRef !== authorization.sceneRef) {
        return DENIED_ACCESS_RESULT;
    }
    const role = memoryLifecycleActorCapabilityRoleV1(authorization.actor);
    if (role === null)
        return DENIED_AUTHORITY_RESULT;
    const action = actionForRequest(adapterRequest);
    if (!memoryLifecycleActorCapabilityAllowsV1(authorization.actor, {
        botInstanceId: authorization.botInstanceId,
        accountId: authorization.accountId,
        sceneRef: authorization.sceneRef,
        namespaceRef: authorization.namespaceRef,
        generation: authorization.generation,
        actorRef: authorization.actorRef,
        action,
        requiredAuthority: requiredAuthority(action, role)
    }, now))
        return DENIED_AUTHORITY_RESULT;
    if (adapterRequest.operation === 'usage.getGlobal' && role !== 'group_bot_master') {
        return DENIED_AUTHORITY_RESULT;
    }
    return null;
}
function canonicalPageBytes(records, corruptRefs, metadata = {}) {
    return Buffer.byteLength(JSON.stringify({ records, corruptRefs, ...metadata }), 'utf8');
}
function parseSnapshotAt(value) {
    return parseMemoryLifecycleInstantV1(value);
}
function parseProposalSafeProjection(value, snapshotAt, request) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'proposalId', 'revision', 'state',
        'effectiveState', 'intentKind', 'plannedMemoryId', 'kind', 'sensitivity', 'proposedAt',
        'deadlineAt', 'validUntil', 'approvalCutoff'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation) {
        return invalidMemoryValue();
    }
    const state = enumValue(input.state, PROPOSAL_STATES);
    if (!request.states.includes(state))
        return invalidMemoryValue();
    const revision = positiveInteger(input.revision, 2);
    if ((state === 'pending' && revision !== 1) || (state !== 'pending' && revision !== 2)) {
        return invalidMemoryValue();
    }
    const proposedAt = parseMemoryLifecycleInstantV1(input.proposedAt);
    const deadlineAt = parseMemoryLifecycleInstantV1(input.deadlineAt);
    const validUntil = parseMemoryLifecycleInstantV1(input.validUntil);
    const approvalCutoff = parseMemoryLifecycleInstantV1(input.approvalCutoff);
    const expectedDeadlineMs = Date.parse(proposedAt) + 7 * 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(expectedDeadlineMs) ||
        new Date(expectedDeadlineMs).toISOString() !== deadlineAt)
        return invalidMemoryValue();
    const expectedApprovalCutoff = Date.parse(deadlineAt) <= Date.parse(validUntil)
        ? deadlineAt
        : validUntil;
    if (Date.parse(validUntil) <= Date.parse(proposedAt) ||
        approvalCutoff !== expectedApprovalCutoff)
        return invalidMemoryValue();
    const effectiveState = enumValue(input.effectiveState, [
        ...PROPOSAL_STATES, 'expired_due'
    ]);
    const expectedEffective = state === 'pending' &&
        Date.parse(snapshotAt) >= Date.parse(approvalCutoff)
        ? 'expired_due'
        : state;
    if (effectiveState !== expectedEffective)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        namespaceRef,
        namespaceGeneration,
        proposalId: proposalRef(input.proposalId),
        revision,
        state,
        effectiveState,
        intentKind: enumValue(input.intentKind, ['create', 'correction']),
        plannedMemoryId: memoryRef(input.plannedMemoryId),
        kind: enumValue(input.kind, MEMORY_KINDS),
        sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
        proposedAt,
        deadlineAt,
        validUntil,
        approvalCutoff
    });
}
function assertProposalOldestFirst(records) {
    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        if (previous.proposedAt > current.proposedAt ||
            (previous.proposedAt === current.proposedAt && previous.proposalId >= current.proposalId)) {
            return invalidMemoryValue();
        }
    }
}
function parseRecordProjection(value, snapshotAt, request) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState'], [
        'record', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision', 'validUntil',
        'purgeAt'
    ]);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const lifecycleState = enumValue(discriminator.lifecycleState, ['current', 'expired', 'purge_due']);
    if (lifecycleState !== 'purge_due') {
        const input = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState', 'record']);
        const record = parseMemoryRecordV2(input.record);
        if (record.namespaceRef !== request.namespaceRef ||
            record.namespaceGeneration !== request.generation ||
            (request.operation === 'record.inspectGet' && record.memoryId !== request.memoryId) ||
            projectMemoryRecordLifecycleV2(record, snapshotAt).state !== lifecycleState) {
            return invalidMemoryValue();
        }
        return Object.freeze({ schemaVersion: 1, lifecycleState, record });
    }
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'lifecycleState', 'namespaceRef', 'namespaceGeneration', 'memoryId',
        'revision', 'validUntil', 'purgeAt'
    ]);
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    const memoryId = memoryRef(input.memoryId);
    const validUntil = parseMemoryLifecycleInstantV1(input.validUntil);
    const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt);
    if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
        (request.operation === 'record.inspectGet' && memoryId !== request.memoryId) ||
        Date.parse(purgeAt) - Date.parse(validUntil) !==
            MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs ||
        Date.parse(snapshotAt) < Date.parse(purgeAt)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        lifecycleState,
        namespaceRef,
        namespaceGeneration,
        memoryId,
        revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
        validUntil,
        purgeAt
    });
}
function parseSafeValidity(value, updatedAt) {
    const input = inspectMemoryRecord(value, ['state', 'validFrom']);
    const state = enumValue(input.state, ['current', 'uncertain', 'superseded']);
    const validFrom = input.validFrom === null
        ? null
        : parseMemoryLifecycleInstantV1(input.validFrom);
    if ((state === 'uncertain' && validFrom !== null) ||
        (state !== 'uncertain' && validFrom === null) ||
        (validFrom !== null && Date.parse(validFrom) > Date.parse(updatedAt))) {
        return invalidMemoryValue();
    }
    return Object.freeze({ state, validFrom });
}
function parseSafeText(value) {
    if (typeof value !== 'string' || value.includes('\r') || !memoryTextWithinLimits(value) ||
        !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value))
        return invalidMemoryValue();
    return value;
}
function parseSafeConfidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
        value < 0 || value > 1)
        return invalidMemoryValue();
    return value;
}
function parseRecordSafeProjection(value, snapshotAt, request) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision',
        'lifecycleState', 'kind', 'text', 'validity', 'confidence', 'sensitivity', 'updatedAt',
        'sourceCount', 'validUntil', 'purgeAt'
    ]);
    if (input.schemaVersion !== 1 || input.lifecycleState !== 'current') {
        return invalidMemoryValue();
    }
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    const validUntil = parseMemoryLifecycleInstantV1(input.validUntil);
    const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt);
    const updatedAt = parseMemoryLifecycleInstantV1(input.updatedAt);
    if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
        Date.parse(snapshotAt) >= Date.parse(validUntil) ||
        Date.parse(purgeAt) - Date.parse(validUntil) !== MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs ||
        Date.parse(updatedAt) > Date.parse(snapshotAt))
        return invalidMemoryValue();
    const kind = enumValue(input.kind, MEMORY_KINDS);
    const sensitivity = enumValue(input.sensitivity, MEMORY_SENSITIVITIES);
    if (!GROUP_SAFE_MEMORY_KINDS.has(kind) || !['public', 'group'].includes(sensitivity)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        namespaceRef,
        namespaceGeneration,
        memoryId: memoryRef(input.memoryId),
        revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
        lifecycleState: 'current',
        kind,
        text: parseSafeText(input.text),
        validity: parseSafeValidity(input.validity, updatedAt),
        confidence: parseSafeConfidence(input.confidence),
        sensitivity,
        updatedAt,
        sourceCount: positiveInteger(input.sourceCount, MEMORY_RESOURCE_LIMITS.sources),
        validUntil,
        purgeAt
    });
}
function parseTombstoneControlProjection(value, snapshotAt, request) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'tombstoneId', 'namespaceRef', 'namespaceGeneration', 'memoryId',
        'deletedRevision', 'deletionKind', 'deletedAt', 'deletedByActorRef', 'reasonCode',
        'receiptHash', 'expiresAt'
    ]);
    const tombstone = parseMemoryTombstoneV1(input);
    const memoryId = tombstone.memoryId === null ? null : memoryRef(tombstone.memoryId);
    const deletedRevision = tombstone.deletedRevision === null
        ? null
        : positiveInteger(tombstone.deletedRevision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions);
    const namespaceRef = parseMemoryNamespaceRefV1(tombstone.namespaceRef);
    const namespaceGeneration = positiveInteger(tombstone.namespaceGeneration);
    const deletedAt = parseMemoryLifecycleInstantV1(tombstone.deletedAt);
    const expiresAt = parseMemoryLifecycleInstantV1(tombstone.expiresAt);
    if (namespaceRef !== request.namespaceRef ||
        namespaceGeneration !== request.targetGeneration ||
        Date.parse(deletedAt) > Date.parse(snapshotAt))
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        tombstoneId: parseMemoryLifecycleHashedRefV1(tombstone.tombstoneId, 'tombstone:'),
        namespaceRef,
        namespaceGeneration,
        memoryId,
        deletedRevision,
        deletionKind: tombstone.deletionKind,
        deletedAt,
        receiptHash: parseMemoryLifecycleHashV1(tombstone.receiptHash),
        expiresAt
    });
}
function parseRevisionHeadProof(value, snapshotAt, request) {
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState'], [
        'namespaceRef', 'namespaceGeneration', 'memoryId', 'headRevision', 'headRevisionHash',
        'validUntil', 'purgeAt'
    ]);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const lifecycleState = enumValue(discriminator.lifecycleState, ['current', 'expired', 'purge_due']);
    const fields = [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'headRevision',
        'lifecycleState', 'validUntil', 'purgeAt'
    ];
    const input = lifecycleState === 'purge_due'
        ? inspectMemoryRecord(value, fields)
        : inspectMemoryRecord(value, [...fields, 'headRevisionHash']);
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    const memoryId = memoryRef(input.memoryId);
    const headRevision = positiveInteger(input.headRevision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions);
    const validUntil = parseMemoryLifecycleInstantV1(input.validUntil);
    const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt);
    const expectedState = Date.parse(snapshotAt) < Date.parse(validUntil)
        ? 'current'
        : Date.parse(snapshotAt) < Date.parse(purgeAt)
            ? 'expired'
            : 'purge_due';
    if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
        memoryId !== request.memoryId || lifecycleState !== expectedState ||
        Date.parse(purgeAt) - Date.parse(validUntil) !==
            MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs)
        return invalidMemoryValue();
    const common = {
        schemaVersion: 1,
        namespaceRef,
        namespaceGeneration,
        memoryId,
        headRevision,
        validUntil,
        purgeAt
    };
    if (lifecycleState === 'purge_due') {
        return Object.freeze({ ...common, lifecycleState: 'purge_due' });
    }
    return Object.freeze({
        ...common,
        lifecycleState,
        headRevisionHash: parseMemoryLifecycleHashV1(input.headRevisionHash)
    });
}
function parseOpaqueCorruptRef(value, operation) {
    if (operation === 'proposal.list')
        return proposalRef(value);
    if (operation === 'record.inspectList' || operation === 'record.listSafe') {
        return memoryRef(value);
    }
    if (operation === 'tombstone.list') {
        return parseMemoryLifecycleHashedRefV1(value, 'tombstone:');
    }
    if (operation === 'audit.list')
        return parseMemoryLifecycleHashedRefV1(value, 'audit:');
    return invalidMemoryValue();
}
function parseCommonPage(value, request) {
    const fields = [
        'status', 'operation', 'snapshotAt', 'records', 'nextCursor', 'wireBytes',
        'corruptRecords', 'corruptRefs'
    ];
    const input = request.operation === 'revision.list'
        ? inspectMemoryRecord(value, [...fields, 'head', 'nextCursorAnchor'])
        : request.operation === 'proposal.list'
            ? inspectMemoryRecord(value, fields, ['nextCursorAnchor'])
            : inspectMemoryRecord(value, fields);
    if (input.status !== 'page' || input.operation !== request.operation) {
        return invalidMemoryValue();
    }
    const snapshotAt = parseSnapshotAt(input.snapshotAt);
    const nextCursor = cursor(input.nextCursor);
    if (nextCursor !== null && nextCursor === request.cursor)
        return invalidMemoryValue();
    const corruptRecords = nonnegativeInteger(input.corruptRecords);
    const corruptRefs = request.operation === 'revision.list'
        ? inspectMemoryArray(input.corruptRefs, 0).map(() => invalidMemoryValue())
        : inspectMemoryArray(input.corruptRefs, request.limit)
            .map(item => parseOpaqueCorruptRef(item, request.operation));
    if (corruptRefs.length !== corruptRecords)
        return invalidMemoryValue();
    if (new Set(corruptRefs).size !== corruptRefs.length)
        return invalidMemoryValue();
    return Object.freeze({
        input,
        snapshotAt,
        nextCursor,
        corruptRecords,
        corruptRefs: Object.freeze(corruptRefs)
    });
}
function parsePageResult(value, request) {
    const common = parseCommonPage(value, request);
    let records;
    let revisionHead;
    let nextCursorAnchor;
    let proposalNextCursorAnchor;
    if (request.operation === 'proposal.list') {
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(item => parseProposalSafeProjection(item, common.snapshotAt, request));
        assertProposalOldestFirst(parsed);
        if (request.cursorAnchor !== null) {
            const first = parsed.at(0);
            if (first !== undefined && (first.proposedAt < request.cursorAnchor.proposedAt ||
                (first.proposedAt === request.cursorAnchor.proposedAt &&
                    first.proposalId <= request.cursorAnchor.proposalId)))
                return invalidMemoryValue();
        }
        if (common.nextCursor === null) {
            if (common.input.nextCursorAnchor !== undefined &&
                common.input.nextCursorAnchor !== null)
                return invalidMemoryValue();
        }
        else {
            if (common.input.nextCursorAnchor === undefined ||
                common.input.nextCursorAnchor === null)
                return invalidMemoryValue();
            proposalNextCursorAnchor = parseProposalCursorAnchor(common.input.nextCursorAnchor);
            if (common.nextCursor !== memoryProposalListCursorV1({
                schemaVersion: 1,
                namespaceRef: request.namespaceRef,
                namespaceGeneration: request.generation,
                states: request.states,
                anchor: proposalNextCursorAnchor
            }))
                return invalidMemoryValue();
            const lastRecord = parsed.at(-1);
            if (lastRecord !== undefined && (proposalNextCursorAnchor.proposedAt < lastRecord.proposedAt ||
                (proposalNextCursorAnchor.proposedAt === lastRecord.proposedAt &&
                    proposalNextCursorAnchor.proposalId < lastRecord.proposalId)))
                return invalidMemoryValue();
            if (!parsed.some(item => item.proposalId === proposalNextCursorAnchor?.proposalId) &&
                !common.corruptRefs.includes(proposalNextCursorAnchor.proposalId)) {
                return invalidMemoryValue();
            }
        }
        records = Object.freeze(parsed);
    }
    else if (request.operation === 'record.listSafe') {
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(item => parseRecordSafeProjection(item, common.snapshotAt, request));
        for (let index = 1; index < parsed.length; index += 1) {
            if (parsed[index - 1].memoryId >= parsed[index].memoryId)
                return invalidMemoryValue();
        }
        records = Object.freeze(parsed);
    }
    else if (request.operation === 'record.inspectList') {
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(item => parseRecordProjection(item, common.snapshotAt, request));
        for (let index = 1; index < parsed.length; index += 1) {
            const previous = parsed[index - 1];
            const current = parsed[index];
            const previousId = previous.lifecycleState === 'purge_due'
                ? previous.memoryId
                : previous.record.memoryId;
            const currentId = current.lifecycleState === 'purge_due'
                ? current.memoryId
                : current.record.memoryId;
            if (previousId >= currentId)
                return invalidMemoryValue();
        }
        records = Object.freeze(parsed);
    }
    else if (request.operation === 'revision.list') {
        const parsedHead = parseRevisionHeadProof(common.input.head, common.snapshotAt, request);
        if (parsedHead.lifecycleState === 'purge_due')
            return invalidMemoryValue();
        revisionHead = parsedHead;
        nextCursorAnchor = common.input.nextCursorAnchor === null
            ? null
            : parseRevisionCursorAnchor(common.input.nextCursorAnchor);
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(parseMemoryRevisionV2);
        let priorRevision = request.cursorAnchor?.revision ?? 0;
        let priorRevisionHash = request.cursorAnchor?.revisionHash ?? null;
        if (priorRevision > revisionHead.headRevision ||
            (priorRevision === revisionHead.headRevision &&
                priorRevisionHash !== revisionHead.headRevisionHash))
            return invalidMemoryValue();
        for (let index = 0; index < parsed.length; index += 1) {
            const revision = parsed[index];
            if (revision.record.namespaceRef !== request.namespaceRef ||
                revision.record.namespaceGeneration !== request.generation ||
                revision.memoryId !== request.memoryId ||
                revision.revision !== priorRevision + 1 ||
                revision.previousRevisionHash !== priorRevisionHash) {
                return invalidMemoryValue();
            }
            priorRevision = revision.revision;
            priorRevisionHash = revision.revisionHash;
        }
        if (common.nextCursor === null) {
            if (nextCursorAnchor !== null || priorRevision !== revisionHead.headRevision ||
                priorRevisionHash !== revisionHead.headRevisionHash)
                return invalidMemoryValue();
        }
        else {
            const last = parsed.at(-1);
            if (last === undefined || nextCursorAnchor === null ||
                nextCursorAnchor.revision !== last.revision ||
                nextCursorAnchor.revisionHash !== last.revisionHash ||
                last.revision >= revisionHead.headRevision ||
                common.nextCursor !== memoryRevisionHistoryCursorV1({
                    schemaVersion: 1,
                    namespaceRef: request.namespaceRef,
                    namespaceGeneration: request.generation,
                    memoryId: request.memoryId,
                    anchor: nextCursorAnchor
                }))
                return invalidMemoryValue();
        }
        const finalRevision = parsed.at(-1);
        if (finalRevision?.revision === revisionHead.headRevision && (finalRevision.revisionHash !== revisionHead.headRevisionHash ||
            finalRevision.record.retention.validUntil !== revisionHead.validUntil ||
            finalRevision.record.retention.purgeAt !== revisionHead.purgeAt)) {
            return invalidMemoryValue();
        }
        records = Object.freeze(parsed);
    }
    else if (request.operation === 'tombstone.list') {
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(item => parseTombstoneControlProjection(item, common.snapshotAt, request));
        for (let index = 1; index < parsed.length; index += 1) {
            const previous = parsed[index - 1];
            const current = parsed[index];
            if (previous.deletedAt > current.deletedAt ||
                (previous.deletedAt === current.deletedAt && previous.tombstoneId >= current.tombstoneId)) {
                return invalidMemoryValue();
            }
        }
        records = Object.freeze(parsed);
    }
    else {
        const parsed = inspectMemoryArray(common.input.records, request.limit)
            .map(parseMemoryLifecycleAuditV1);
        if (parsed.some(item => item.namespaceRef !== request.namespaceRef ||
            item.namespaceGeneration !== request.targetGeneration))
            return invalidMemoryValue();
        for (let index = 1; index < parsed.length; index += 1) {
            const previous = parsed[index - 1];
            const current = parsed[index];
            if (previous.recordedAt > current.recordedAt ||
                (previous.recordedAt === current.recordedAt && previous.auditId >= current.auditId)) {
                return invalidMemoryValue();
            }
        }
        records = Object.freeze(parsed);
    }
    if (records.length + common.corruptRecords > request.limit)
        return invalidMemoryValue();
    const aggregateRefs = records.map(record => {
        if (request.operation === 'proposal.list') {
            return record.proposalId;
        }
        if (request.operation === 'record.listSafe') {
            return record.memoryId;
        }
        if (request.operation === 'record.inspectList') {
            const projection = record;
            return projection.lifecycleState === 'purge_due'
                ? projection.memoryId
                : projection.record.memoryId;
        }
        if (request.operation === 'revision.list') {
            return `${record.memoryId}:${record.revision}`;
        }
        if (request.operation === 'tombstone.list') {
            return record.tombstoneId;
        }
        return record.auditId;
    });
    if (new Set(aggregateRefs).size !== aggregateRefs.length ||
        common.corruptRefs.some(ref => aggregateRefs.includes(ref)) ||
        (records.length + common.corruptRecords === 0 && common.nextCursor !== null)) {
        return invalidMemoryValue();
    }
    const wireBytes = positiveInteger(common.input.wireBytes);
    const pageMetadata = revisionHead !== undefined
        ? { head: revisionHead, nextCursorAnchor }
        : proposalNextCursorAnchor === undefined
            ? {}
            : { nextCursorAnchor: proposalNextCursorAnchor };
    const actualBytes = canonicalPageBytes(records, common.corruptRefs, pageMetadata);
    if (wireBytes !== actualBytes || wireBytes > request.maxWireBytes ||
        wireBytes > MEMORY_RESOURCE_LIMITS.listPageWireBytes)
        return invalidMemoryValue();
    return deepFreeze({
        status: 'page',
        operation: request.operation,
        snapshotAt: common.snapshotAt,
        records,
        nextCursor: common.nextCursor,
        wireBytes,
        corruptRecords: common.corruptRecords,
        corruptRefs: common.corruptRefs,
        ...pageMetadata
    });
}
function parseGlobalUsage(value) {
    const fields = [
        'namespaceRecords', 'pendingProposalRecords', 'activeMemoryRecords',
        'retainedRevisionRecords', 'tombstoneRecords', 'lifecycleAuditRecords',
        'lifecycleAuditReservedRecords', 'lifecycleCommandRecords', 'deletionCheckpointRecords',
        'exportJobRecords', 'canonicalLogicalBytes', 'pendingOutboxRecords',
        'outboxLogicalBytes', 'lifecycleAuditLogicalBytes', 'lifecycleAuditReservedBytes',
        'lifecycleCommandLogicalBytes', 'deletionCheckpointLogicalBytes', 'exportJobLogicalBytes'
    ];
    const input = inspectMemoryRecord(value, ['schemaVersion', ...fields]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        namespaceRecords: nonnegativeInteger(input.namespaceRecords),
        pendingProposalRecords: nonnegativeInteger(input.pendingProposalRecords),
        activeMemoryRecords: nonnegativeInteger(input.activeMemoryRecords),
        retainedRevisionRecords: nonnegativeInteger(input.retainedRevisionRecords),
        tombstoneRecords: nonnegativeInteger(input.tombstoneRecords),
        lifecycleAuditRecords: nonnegativeInteger(input.lifecycleAuditRecords),
        lifecycleAuditReservedRecords: nonnegativeInteger(input.lifecycleAuditReservedRecords),
        lifecycleCommandRecords: nonnegativeInteger(input.lifecycleCommandRecords),
        deletionCheckpointRecords: nonnegativeInteger(input.deletionCheckpointRecords),
        exportJobRecords: nonnegativeInteger(input.exportJobRecords),
        canonicalLogicalBytes: nonnegativeInteger(input.canonicalLogicalBytes),
        pendingOutboxRecords: nonnegativeInteger(input.pendingOutboxRecords),
        outboxLogicalBytes: nonnegativeInteger(input.outboxLogicalBytes),
        lifecycleAuditLogicalBytes: nonnegativeInteger(input.lifecycleAuditLogicalBytes),
        lifecycleAuditReservedBytes: nonnegativeInteger(input.lifecycleAuditReservedBytes),
        lifecycleCommandLogicalBytes: nonnegativeInteger(input.lifecycleCommandLogicalBytes),
        deletionCheckpointLogicalBytes: nonnegativeInteger(input.deletionCheckpointLogicalBytes),
        exportJobLogicalBytes: nonnegativeInteger(input.exportJobLogicalBytes)
    });
}
function parseFoundResult(value, request) {
    if (request.operation === 'proposal.inspect') {
        const input = inspectMemoryRecord(value, [
            'status', 'operation', 'snapshotAt', 'value', 'effectiveState'
        ]);
        if (input.status !== 'found' || input.operation !== request.operation) {
            return invalidMemoryValue();
        }
        const snapshotAt = parseSnapshotAt(input.snapshotAt);
        const proposal = parseMemoryProposalV2(input.value);
        const projection = projectMemoryProposalLifecycleV2(proposal, snapshotAt);
        if (proposal.namespaceRef !== request.namespaceRef ||
            proposal.namespaceGeneration !== request.generation ||
            proposal.proposalId !== request.proposalId ||
            input.effectiveState !== projection.logicalState || !projection.fullWireReadable) {
            return invalidMemoryValue();
        }
        return deepFreeze({
            status: 'found',
            operation: request.operation,
            snapshotAt,
            value: proposal,
            effectiveState: projection.logicalState
        });
    }
    if (request.operation === 'record.inspectGet') {
        const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value']);
        if (input.status !== 'found' || input.operation !== request.operation) {
            return invalidMemoryValue();
        }
        const snapshotAt = parseSnapshotAt(input.snapshotAt);
        return deepFreeze({
            status: 'found',
            operation: request.operation,
            snapshotAt,
            value: parseRecordProjection(input.value, snapshotAt, request)
        });
    }
    if (request.operation === 'revision.get') {
        const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value', 'head']);
        if (input.status !== 'found' || input.operation !== request.operation) {
            return invalidMemoryValue();
        }
        const snapshotAt = parseSnapshotAt(input.snapshotAt);
        const head = parseRevisionHeadProof(input.head, snapshotAt, request);
        if (head.lifecycleState === 'purge_due')
            return invalidMemoryValue();
        const revision = parseMemoryRevisionV2(input.value);
        if (revision.record.namespaceRef !== request.namespaceRef ||
            revision.record.namespaceGeneration !== request.generation ||
            revision.memoryId !== request.memoryId || revision.revision !== request.revision ||
            revision.revision > head.headRevision ||
            (revision.revision === head.headRevision && (revision.revisionHash !== head.headRevisionHash ||
                revision.record.retention.validUntil !== head.validUntil ||
                revision.record.retention.purgeAt !== head.purgeAt))) {
            return invalidMemoryValue();
        }
        return deepFreeze({
            status: 'found',
            operation: request.operation,
            snapshotAt,
            value: revision,
            head
        });
    }
    if (request.operation === 'deletion.getStatus') {
        const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value']);
        if (input.status !== 'found' || input.operation !== request.operation) {
            return invalidMemoryValue();
        }
        const status = parseDeletionStatusV1(input.value);
        const snapshotAt = parseSnapshotAt(input.snapshotAt);
        if (status.deletionRef !== request.deletionRef ||
            status.namespaceRef !== request.namespaceRef ||
            status.observedCurrentGeneration !== request.generation ||
            status.observedAt !== snapshotAt)
            return invalidMemoryValue();
        return deepFreeze({
            status: 'found',
            operation: request.operation,
            snapshotAt,
            value: status
        });
    }
    if (request.operation === 'deletion.resolve') {
        const input = inspectMemoryRecord(value, [
            'status', 'operation', 'snapshotAt', 'receipt', 'deletionStatus'
        ]);
        if (input.status !== 'resolved' || input.operation !== request.operation) {
            return invalidMemoryValue();
        }
        const receipt = parseDeletionMutationReceiptV1(input.receipt);
        const status = parseDeletionStatusV1(input.deletionStatus);
        const snapshotAt = parseSnapshotAt(input.snapshotAt);
        if (receipt.deletionRef !== request.deletionRef || status.deletionRef !== request.deletionRef ||
            receipt.commandRefHash !== memoryLifecycleCommandRefHashV1(request.commandRef) ||
            receipt.namespaceRef !== request.namespaceRef || status.namespaceRef !== request.namespaceRef ||
            receipt.generationAfter > request.generation ||
            status.observedCurrentGeneration !== request.generation ||
            receipt.deletingGeneration !== status.deletingGeneration ||
            status.observedAt !== snapshotAt)
            return invalidMemoryValue();
        return deepFreeze({
            status: 'resolved',
            operation: request.operation,
            snapshotAt,
            receipt,
            deletionStatus: status
        });
    }
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value']);
    if (input.status !== 'usage' || input.operation !== request.operation) {
        return invalidMemoryValue();
    }
    return deepFreeze({
        status: 'usage',
        operation: request.operation,
        snapshotAt: parseSnapshotAt(input.snapshotAt),
        value: parseGlobalUsage(input.value)
    });
}
function parseRecordPurgeDueResult(value, request) {
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'head']);
    if (input.status !== 'record_purge_due' || input.operation !== request.operation) {
        return invalidMemoryValue();
    }
    const snapshotAt = parseSnapshotAt(input.snapshotAt);
    const head = parseRevisionHeadProof(input.head, snapshotAt, request);
    if (head.lifecycleState !== 'purge_due')
        return invalidMemoryValue();
    return deepFreeze({
        status: 'record_purge_due',
        operation: request.operation,
        snapshotAt,
        head
    });
}
function retryableForCategory(category, value) {
    const expected = category !== 'storage';
    if (typeof value !== 'boolean' || value !== expected)
        return invalidMemoryValue();
    return value;
}
function parseAdapterResult(value, request) {
    const discriminator = inspectMemoryRecord(value, ['status'], RESULT_FIELDS);
    if (discriminator.status === 'denied') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'denied',
            category: enumValue(input.category, ['access', 'authority'])
        });
    }
    if (discriminator.status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        if (input.category !== 'canonical_data')
            return invalidMemoryValue();
        return Object.freeze({ status: 'corrupt', category: 'canonical_data' });
    }
    if (discriminator.status === 'unavailable') {
        const input = inspectMemoryRecord(value, ['status', 'category', 'retryable']);
        const category = enumValue(input.category, ['busy', 'storage', 'io']);
        return Object.freeze({
            status: 'unavailable',
            category,
            retryable: retryableForCategory(category, input.retryable)
        });
    }
    if (discriminator.status === 'invalid_cursor') {
        const input = inspectMemoryRecord(value, ['status', 'operation']);
        if (!LIST_OPERATIONS.has(request.operation) ||
            input.operation !== request.operation)
            return invalidMemoryValue();
        return Object.freeze({
            status: 'invalid_cursor',
            operation: request.operation
        });
    }
    if (discriminator.status === 'record_purge_due') {
        if (request.operation !== 'revision.get' && request.operation !== 'revision.list') {
            return invalidMemoryValue();
        }
        return parseRecordPurgeDueResult(value, request);
    }
    if (discriminator.status === 'not_found') {
        const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt']);
        if (LIST_OPERATIONS.has(request.operation) ||
            input.operation !== request.operation || request.operation === 'usage.getGlobal') {
            return invalidMemoryValue();
        }
        return Object.freeze({
            status: 'not_found',
            operation: request.operation,
            snapshotAt: parseSnapshotAt(input.snapshotAt)
        });
    }
    if (discriminator.status === 'page') {
        if (!LIST_OPERATIONS.has(request.operation)) {
            return invalidMemoryValue();
        }
        return parsePageResult(value, request);
    }
    if (discriminator.status === 'found' || discriminator.status === 'resolved' ||
        discriminator.status === 'usage') {
        if (LIST_OPERATIONS.has(request.operation)) {
            return invalidMemoryValue();
        }
        return parseFoundResult(value, request);
    }
    return invalidMemoryValue();
}
function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value))
        return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
            deepFreeze(descriptor.value, seen);
        }
    }
    return Object.freeze(value);
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, ['now', 'execute']);
    if (typeof input.now !== 'function' || utilTypes.isProxy(input.now) ||
        typeof input.execute !== 'function' || utilTypes.isProxy(input.execute)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        now: input.now,
        execute: input.execute
    });
}
export function createMemoryControlRepositoryPortV1(optionsValue) {
    const options = parseOptions(optionsValue);
    return Object.freeze({
        execute: async (requestValue, signalValue) => {
            const signal = createMemoryPortSignalScopeV1(signalValue);
            let parsed;
            try {
                parsed = parseRequest(requestValue);
            }
            catch (error) {
                signal.close();
                throw error;
            }
            if (signal.isAborted()) {
                signal.close();
                return ABORTED_RESULT;
            }
            let now;
            try {
                now = parseMemoryLifecycleInstantV1(Reflect.apply(options.now, undefined, []));
            }
            catch {
                signal.close();
                return ADAPTER_IO_RESULT;
            }
            const denial = authorizationDenial(parsed, now);
            if (denial !== null) {
                signal.close();
                return denial;
            }
            // Task 5 adapters must freeze their own trusted high-water under BEGIN IMMEDIATE.
            // This outer authorization clock is deliberately not presented as read linearization.
            // The process-local envelope has no codec and exists only for the locked authoritative check.
            const adapterEnvelope = Object.freeze({
                schemaVersion: 1,
                request: parsed.adapterRequest,
                authorization: parsed.authorization
            });
            let raw;
            try {
                raw = await Reflect.apply(options.execute, undefined, [
                    adapterEnvelope,
                    signal.signal
                ]);
            }
            catch {
                const aborted = signal.isAborted();
                signal.close();
                return aborted ? ABORTED_RESULT : ADAPTER_IO_RESULT;
            }
            if (signal.isAborted()) {
                signal.close();
                return ABORTED_RESULT;
            }
            try {
                const result = parseAdapterResult(raw, parsed.adapterRequest);
                signal.close();
                return result;
            }
            catch {
                const aborted = signal.isAborted();
                signal.close();
                return aborted ? ABORTED_RESULT : ADAPTER_CONTRACT_RESULT;
            }
        }
    });
}
