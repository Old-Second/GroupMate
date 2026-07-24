import { parseMemorySourceV1 } from './memory-domain.js';
import { memoryLifecycleActorCapabilityAllowsV1, memoryLifecycleActorCapabilityRoleV1 } from './memory-lifecycle-authority.js';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, parseMemoryBotInstanceIdV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1, parseMemoryQqIdV1 } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
const GROUP_MEMORY_KINDS = [
    'group_rule', 'group_culture', 'task_fact', 'other'
];
const MEMORY_KINDS = [
    'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
    'task_fact', 'other'
];
const MEMORY_SENSITIVITIES = [
    'public', 'group', 'personal', 'sensitive'
];
const ACTOR_ACTIONS = [
    'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe',
    'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict',
    'forget', 'export', 'delete_namespace', 'resolve_deletion', 'claim_export'
];
const CANONICAL_REQUIREMENTS = [
    'none', 'ordinary', 'elevated'
];
const TARGET_MODES = [
    'none', 'expected_revision', 'opaque_delete_only'
];
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseSceneRef(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        return invalidMemoryValue();
    return value;
}
function parseActorRef(value) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        typeof value !== 'string' || !/^actor:[0-9a-f]{64}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
export function parseMemoryLifecycleActorPolicyRequestV1(value) {
    const input = inspectMemoryRecord(value, [
        'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
        'action', 'beforeRequirement', 'afterRequirement', 'initiatedByActorRef',
        'targetMode', 'expectedRevision'
    ]);
    const targetMode = enumValue(input.targetMode, TARGET_MODES);
    const expectedRevision = input.expectedRevision === null
        ? null
        : positiveInteger(input.expectedRevision);
    if ((targetMode === 'expected_revision') !== (expectedRevision !== null)) {
        return invalidMemoryValue();
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
    });
}
function denied(reason) {
    return Object.freeze({ allowed: false, projection: 'none', reason });
}
function maximumCanonicalRequirement(action, before, after) {
    if (before === 'elevated' || after === 'elevated')
        return 'elevated';
    if (before === 'ordinary' || after === 'ordinary' || ![
        'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe'
    ].includes(action))
        return 'ordinary';
    return 'safe';
}
export function decideMemoryLifecycleActorPolicyV1(capability, requestValue, freshNow) {
    let request;
    try {
        request = parseMemoryLifecycleActorPolicyRequestV1(requestValue);
    }
    catch {
        return denied('invalid_request');
    }
    if (request.action === 'withdraw_own_proposal' &&
        request.initiatedByActorRef !== request.actorRef)
        return denied('not_own_proposal');
    const role = memoryLifecycleActorCapabilityRoleV1(capability);
    if (role === null)
        return denied('authority_denied');
    const deleteOnly = role === 'personal_bot_master';
    if (deleteOnly && request.action === 'forget' &&
        (request.targetMode !== 'opaque_delete_only' || request.expectedRevision !== null)) {
        return denied('delete_only_target_required');
    }
    if (!deleteOnly && request.action === 'forget' && request.targetMode !== 'expected_revision') {
        return denied('revision_target_required');
    }
    const requiredAuthority = deleteOnly
        ? 'delete_only'
        : maximumCanonicalRequirement(request.action, request.beforeRequirement, request.afterRequirement);
    if (!memoryLifecycleActorCapabilityAllowsV1(capability, {
        botInstanceId: request.botInstanceId,
        accountId: request.accountId,
        sceneRef: request.sceneRef,
        namespaceRef: request.namespaceRef,
        generation: request.generation,
        actorRef: request.actorRef,
        action: request.action,
        requiredAuthority
    }, freshNow))
        return denied('authority_denied');
    const projection = deleteOnly
        ? 'delete_only'
        : request.action === 'list_safe'
            ? 'safe'
            : request.action === 'inspect_full' || request.action === 'export' ||
                request.action === 'claim_export'
                ? 'full'
                : 'none';
    return Object.freeze({ allowed: true, projection, reason: null });
}
export function memoryConsentMatchesNamespaceV1(namespaceValue, consentValue) {
    try {
        const namespace = parseMemoryNamespaceV1(namespaceValue);
        const consent = enumValue(consentValue, ['explicit', 'owner_policy', 'group_policy']);
        return consent === 'explicit' ||
            (namespace.scope.kind === 'personal' && consent === 'owner_policy') ||
            (namespace.scope.kind === 'group' && consent === 'group_policy');
    }
    catch {
        return false;
    }
}
export function parseGroupMemoryAdmissionV1(value) {
    const input = inspectMemoryRecord(value, ['kind', 'sensitivity', 'sources']);
    const sources = inspectMemoryArray(input.sources, MEMORY_RESOURCE_LIMITS.sources)
        .map(parseMemorySourceV1);
    if (sources.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        kind: enumValue(input.kind, MEMORY_KINDS),
        sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
        sources: Object.freeze(sources)
    });
}
export function evaluateGroupMemoryAdmissionV1(namespaceValue, admissionValue) {
    let namespace;
    let admission;
    try {
        namespace = parseMemoryNamespaceV1(namespaceValue);
        admission = parseGroupMemoryAdmissionV1(admissionValue);
    }
    catch {
        return Object.freeze({ allowed: false, reason: 'invalid_admission' });
    }
    if (namespace.scope.kind !== 'group') {
        return Object.freeze({ allowed: false, reason: 'not_group_namespace' });
    }
    if (!GROUP_MEMORY_KINDS.includes(admission.kind)) {
        return Object.freeze({ allowed: false, reason: 'kind_not_allowed' });
    }
    if (admission.sensitivity !== 'public' && admission.sensitivity !== 'group') {
        return Object.freeze({ allowed: false, reason: 'sensitivity_not_allowed' });
    }
    for (const source of admission.sources) {
        if (source.sourceKind === 'private_history' || source.scene.kind !== 'group' ||
            source.scene.groupId !== namespace.scope.groupId ||
            source.scene.groupLifecycleId !== namespace.scope.groupLifecycleId) {
            return Object.freeze({ allowed: false, reason: 'source_scene_not_allowed' });
        }
    }
    return Object.freeze({ allowed: true });
}
