import { types as utilTypes } from 'node:util';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryBotInstanceIdV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1, parseMemoryQqIdV1 } from './memory-namespace.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
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
]);
export const MEMORY_PERSONAL_ENROLLMENT_ACTOR_ACTION_V1 = 'manage_enrollment';
export const MEMORY_MAINTENANCE_OPERATIONS_V1 = Object.freeze([
    'proposal.expireDue',
    'proposal.purgeDecided',
    'record.purgeExpired',
    'namespace.scrubDeleted',
    'namespace.verifyScrubbed',
    'tombstone.purgeExpired',
    'audit.purgeExpired',
    'command.purgeExpired',
    'export.releaseExpiredReservations',
    'deletion.checkpoint'
]);
const MEMORY_KINDS = [
    'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
    'task_fact', 'other'
];
const MEMORY_SENSITIVITIES = [
    'public', 'group', 'personal', 'sensitive'
];
const MEMORY_SOURCE_KINDS = [
    'current_message', 'quoted_message', 'group_history', 'private_history',
    'manual_user_input', 'manual_correction'
];
const ACTOR_ROLES = [
    'personal_subject', 'personal_bot_master', 'group_member', 'group_admin',
    'group_owner', 'group_bot_master'
];
const AUTHORITY_REQUIREMENTS = [
    'safe', 'ordinary', 'elevated', 'delete_only'
];
const MAX_CANONICAL_INSTANT_MS = 8_640_000_000_000_000;
const OLD_GENERATION_MAINTENANCE_OPERATIONS = new Set([
    'namespace.scrubDeleted', 'namespace.verifyScrubbed'
]);
const ALL_ACTOR_ACTIONS = Object.freeze([
    ...MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1,
    MEMORY_PERSONAL_ENROLLMENT_ACTOR_ACTION_V1
]);
const PERSONAL_SUBJECT_ACTIONS = new Set(ALL_ACTOR_ACTIONS);
const PERSONAL_DELETE_ONLY_ACTIONS = new Set([
    'forget', 'delete_namespace', 'resolve_deletion'
]);
const GROUP_MEMBER_ACTIONS = new Set([
    'propose_create', 'propose_correction', 'withdraw_own_proposal', 'list_safe'
]);
const GROUP_ADMIN_ACTIONS = new Set([
    ...GROUP_MEMBER_ACTIONS,
    'inspect_full', 'approve', 'reject', 'correct', 'renew', 'change_conflict', 'forget'
]);
const GROUP_ELEVATED_ACTIONS = new Set(MEMORY_LIFECYCLE_ACTOR_ACTIONS_V1);
const authorityRootBrand = Symbol('MemoryLifecycleAuthorityRootV1');
const actorCapabilityBrand = Symbol('MemoryLifecycleActorCapabilityV1');
const policyCapabilityBrand = Symbol('MemoryPolicyCapabilityV1');
const maintenanceCapabilityBrand = Symbol('MemoryMaintenanceCapabilityV1');
const roots = new WeakSet();
const rootVerifiers = new WeakMap();
const actorCapabilities = new WeakSet();
const actorStates = new WeakMap();
const policyCapabilities = new WeakSet();
const policyStates = new WeakMap();
const maintenanceCapabilities = new WeakSet();
const maintenanceStates = new WeakMap();
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
function parseCanonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 ||
        milliseconds > MAX_CANONICAL_INSTANT_MS || new Date(milliseconds).toISOString() !== value) {
        return invalidMemoryValue();
    }
    return value;
}
function parseSceneRef(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        return invalidMemoryValue();
    return value;
}
function parseOpaqueRef(value, prefix) {
    if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        typeof value !== 'string' || !value.startsWith(prefix) || value.length <= prefix.length) {
        return invalidMemoryValue();
    }
    return value;
}
function parseActorRef(value) {
    if (typeof value !== 'string' || !/^actor:[0-9a-f]{64}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseDeletionRef(value) {
    if (typeof value !== 'string' || !/^deletion:[0-9a-f]{64}$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseUniqueEnumArray(value, values, maximumLength) {
    const parsed = inspectMemoryArray(value, maximumLength).map(item => enumValue(item, values));
    if (new Set(parsed).size !== parsed.length)
        return invalidMemoryValue();
    return Object.freeze(parsed);
}
function parseUniqueOpaqueArray(value, prefix) {
    const parsed = inspectMemoryArray(value, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues).map(item => parseOpaqueRef(item, prefix));
    if (new Set(parsed).size !== parsed.length)
        return invalidMemoryValue();
    return Object.freeze(parsed);
}
function parseNamespaceBoundContext(input) {
    if (input.adapter !== 'qq')
        return invalidMemoryValue();
    const botInstanceId = parseMemoryBotInstanceIdV1(input.botInstanceId);
    const accountId = parseMemoryQqIdV1(input.accountId);
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    if (namespace.botInstanceId !== botInstanceId || namespace.accountId !== accountId ||
        memoryNamespaceRefV1(namespace) !== namespaceRef)
        return invalidMemoryValue();
    return {
        botInstanceId,
        accountId,
        sceneRef: parseSceneRef(input.sceneRef),
        namespace,
        namespaceRef,
        generation: positiveInteger(input.generation)
    };
}
function allowedActionsForRole(role) {
    if (role === 'personal_subject')
        return PERSONAL_SUBJECT_ACTIONS;
    if (role === 'personal_bot_master')
        return PERSONAL_DELETE_ONLY_ACTIONS;
    if (role === 'group_member')
        return GROUP_MEMBER_ACTIONS;
    if (role === 'group_admin')
        return GROUP_ADMIN_ACTIONS;
    return GROUP_ELEVATED_ACTIONS;
}
export function parseMemoryLifecycleActorAuthorityContextV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'sceneRef', 'namespace',
        'namespaceRef', 'generation', 'actorRef', 'actorUserId', 'role', 'roleObservedAt',
        'actions'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const binding = parseNamespaceBoundContext(input);
    const role = enumValue(input.role, ACTOR_ROLES);
    const actorRef = parseActorRef(input.actorRef);
    const actorUserId = parseMemoryQqIdV1(input.actorUserId);
    const actions = parseUniqueEnumArray(input.actions, ALL_ACTOR_ACTIONS, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleActorActions);
    const allowedActions = allowedActionsForRole(role);
    if (actions.length === 0 || actions.some(action => !allowedActions.has(action))) {
        return invalidMemoryValue();
    }
    let roleObservedAt;
    if (binding.namespace.scope.kind === 'personal') {
        if (role !== 'personal_subject' && role !== 'personal_bot_master')
            return invalidMemoryValue();
        roleObservedAt = input.roleObservedAt === null ? null : invalidMemoryValue();
        const isSubject = actorUserId === binding.namespace.scope.subjectUserId;
        if ((role === 'personal_subject') !== isSubject)
            return invalidMemoryValue();
    }
    else {
        if (role === 'personal_subject' || role === 'personal_bot_master')
            return invalidMemoryValue();
        roleObservedAt = parseCanonicalInstant(input.roleObservedAt);
    }
    return Object.freeze({
        schemaVersion: 1,
        botInstanceId: binding.botInstanceId,
        adapter: 'qq',
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
    });
}
export function parseMemoryPolicyAuthorityContextV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'sceneRef', 'namespace',
        'namespaceRef', 'generation', 'policyRef', 'policyGeneration', 'createdByActorRef',
        'createdByUserId', 'consent', 'allowedKinds', 'allowedSensitivities', 'allowedSourceKinds',
        'allowedRetentionPolicyRefs'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const binding = parseNamespaceBoundContext(input);
    const consent = enumValue(input.consent, ['owner_policy', 'group_policy']);
    if ((binding.namespace.scope.kind === 'personal') !== (consent === 'owner_policy')) {
        return invalidMemoryValue();
    }
    const createdByActorRef = parseActorRef(input.createdByActorRef);
    const createdByUserId = parseMemoryQqIdV1(input.createdByUserId);
    if (binding.namespace.scope.kind === 'personal' &&
        createdByUserId !== binding.namespace.scope.subjectUserId) {
        return invalidMemoryValue();
    }
    const allowedKinds = parseUniqueEnumArray(input.allowedKinds, MEMORY_KINDS, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues);
    const allowedSensitivities = parseUniqueEnumArray(input.allowedSensitivities, MEMORY_SENSITIVITIES, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues);
    const allowedSourceKinds = parseUniqueEnumArray(input.allowedSourceKinds, MEMORY_SOURCE_KINDS, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecyclePolicyValues);
    const allowedRetentionPolicyRefs = parseUniqueOpaqueArray(input.allowedRetentionPolicyRefs, 'retention:');
    if (allowedKinds.length === 0 || allowedSensitivities.length === 0 ||
        allowedSourceKinds.length === 0 || allowedRetentionPolicyRefs.length === 0) {
        return invalidMemoryValue();
    }
    if (binding.namespace.scope.kind === 'group' && (allowedKinds.some(kind => !['group_rule', 'group_culture', 'task_fact', 'other'].includes(kind)) ||
        allowedSensitivities.some(value => value !== 'public' && value !== 'group') ||
        allowedSourceKinds.includes('private_history')))
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        botInstanceId: binding.botInstanceId,
        adapter: 'qq',
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
    });
}
export function parseMemoryMaintenanceAuthorityContextV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'botInstanceId', 'adapter', 'accountId', 'namespace', 'namespaceRef',
        'currentGeneration', 'targetGeneration', 'deletionRef', 'operation', 'limit'
    ]);
    if (input.schemaVersion !== 1 || input.adapter !== 'qq')
        return invalidMemoryValue();
    const botInstanceId = parseMemoryBotInstanceIdV1(input.botInstanceId);
    const accountId = parseMemoryQqIdV1(input.accountId);
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef);
    if (namespace.botInstanceId !== botInstanceId || namespace.accountId !== accountId ||
        memoryNamespaceRefV1(namespace) !== namespaceRef)
        return invalidMemoryValue();
    const operation = enumValue(input.operation, MEMORY_MAINTENANCE_OPERATIONS_V1);
    const currentGeneration = positiveInteger(input.currentGeneration);
    const targetGeneration = positiveInteger(input.targetGeneration);
    const deletionRef = input.deletionRef === null
        ? null
        : parseDeletionRef(input.deletionRef);
    const limit = positiveInteger(input.limit);
    if (limit > MEMORY_RESOURCE_LIMITS.operationBatchRecords)
        return invalidMemoryValue();
    if (!OLD_GENERATION_MAINTENANCE_OPERATIONS.has(operation)) {
        if (deletionRef !== null || targetGeneration !== currentGeneration)
            return invalidMemoryValue();
    }
    else if (deletionRef === null || targetGeneration >= currentGeneration) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        botInstanceId,
        adapter: 'qq',
        accountId,
        namespace,
        namespaceRef,
        currentGeneration,
        targetGeneration,
        deletionRef,
        operation,
        limit
    });
}
export function createMemoryLifecycleAuthorityRootV1(verifier) {
    if (typeof verifier !== 'function' || utilTypes.isProxy(verifier))
        return invalidMemoryValue();
    const root = Object.freeze({
        schemaVersion: 1,
        [authorityRootBrand]: true
    });
    roots.add(root);
    rootVerifiers.set(root, verifier);
    return root;
}
function verifyTrusted(rootValue, request, now) {
    if (rootValue === null || typeof rootValue !== 'object' || utilTypes.isProxy(rootValue) ||
        !roots.has(rootValue))
        return invalidMemoryValue();
    const verifier = rootVerifiers.get(rootValue);
    if (verifier === undefined)
        return invalidMemoryValue();
    let result;
    try {
        result = Reflect.apply(verifier, undefined, [request, now]);
    }
    catch {
        return invalidMemoryValue();
    }
    if (utilTypes.isPromise(result)) {
        void Promise.prototype.then.call(result, undefined, () => undefined);
        return invalidMemoryValue();
    }
    if (result !== true)
        return invalidMemoryValue();
}
function capabilityWindow(now, observedAt) {
    const validFromMs = Date.parse(now);
    let validUntilMs = validFromMs +
        MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCapabilityAbsoluteTtlMs;
    if (!Number.isSafeInteger(validUntilMs) || validUntilMs > MAX_CANONICAL_INSTANT_MS) {
        return invalidMemoryValue();
    }
    if (observedAt !== null) {
        const observedAtMs = Date.parse(observedAt);
        if (validFromMs - observedAtMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs ||
            observedAtMs - validFromMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs) {
            return invalidMemoryValue();
        }
        validUntilMs = Math.min(validUntilMs, observedAtMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs);
    }
    return {
        validFromMs,
        validUntilMs,
        validUntil: new Date(validUntilMs).toISOString()
    };
}
export function issueMemoryLifecycleActorCapabilityV1(root, contextValue, nowValue) {
    const now = parseCanonicalInstant(nowValue);
    const context = parseMemoryLifecycleActorAuthorityContextV1(contextValue);
    verifyTrusted(root, Object.freeze({ kind: 'actor', context }), now);
    const window = capabilityWindow(now, context.roleObservedAt);
    const capability = Object.freeze({
        schemaVersion: 1,
        botInstanceId: context.botInstanceId,
        adapter: 'qq',
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
        [actorCapabilityBrand]: true
    });
    actorCapabilities.add(capability);
    actorStates.set(capability, Object.freeze({
        validFromMs: window.validFromMs,
        validUntilMs: window.validUntilMs,
        actions: new Set(context.actions),
        role: context.role
    }));
    return capability;
}
export function issueMemoryPolicyCapabilityV1(root, contextValue, nowValue) {
    const now = parseCanonicalInstant(nowValue);
    const context = parseMemoryPolicyAuthorityContextV1(contextValue);
    verifyTrusted(root, Object.freeze({ kind: 'policy', context }), now);
    const window = capabilityWindow(now, null);
    const capability = Object.freeze({
        schemaVersion: 1,
        botInstanceId: context.botInstanceId,
        adapter: 'qq',
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
        [policyCapabilityBrand]: true
    });
    policyCapabilities.add(capability);
    policyStates.set(capability, Object.freeze({
        validFromMs: window.validFromMs,
        validUntilMs: window.validUntilMs,
        allowedKinds: new Set(context.allowedKinds),
        allowedSensitivities: new Set(context.allowedSensitivities),
        allowedSourceKinds: new Set(context.allowedSourceKinds),
        allowedRetentionPolicyRefs: new Set(context.allowedRetentionPolicyRefs)
    }));
    return capability;
}
export function issueMemoryMaintenanceCapabilityV1(root, contextValue, nowValue) {
    const now = parseCanonicalInstant(nowValue);
    const context = parseMemoryMaintenanceAuthorityContextV1(contextValue);
    verifyTrusted(root, Object.freeze({ kind: 'maintenance', context }), now);
    const window = capabilityWindow(now, null);
    const capability = Object.freeze({
        schemaVersion: 1,
        botInstanceId: context.botInstanceId,
        adapter: 'qq',
        accountId: context.accountId,
        namespaceRef: context.namespaceRef,
        currentGeneration: context.currentGeneration,
        targetGeneration: context.targetGeneration,
        deletionRef: context.deletionRef,
        operation: context.operation,
        limit: context.limit,
        validFrom: now,
        validUntil: window.validUntil,
        [maintenanceCapabilityBrand]: true
    });
    maintenanceCapabilities.add(capability);
    maintenanceStates.set(capability, Object.freeze({
        validFromMs: window.validFromMs,
        validUntilMs: window.validUntilMs
    }));
    return capability;
}
function freshAt(state, nowValue) {
    const nowMs = Date.parse(parseCanonicalInstant(nowValue));
    return nowMs >= state.validFromMs && nowMs <= state.validUntilMs;
}
function actorRoleAllowsRequirement(role, requirement) {
    if (requirement === 'safe')
        return role === 'group_member' || role === 'group_admin' ||
            role === 'group_owner' || role === 'group_bot_master' || role === 'personal_subject';
    if (requirement === 'ordinary')
        return role === 'group_admin' || role === 'group_owner' ||
            role === 'group_bot_master' || role === 'personal_subject';
    if (requirement === 'elevated')
        return role === 'group_owner' ||
            role === 'group_bot_master' || role === 'personal_subject';
    return role === 'personal_bot_master';
}
export function parseMemoryLifecycleActorCapabilityRequestV1(value) {
    const input = inspectMemoryRecord(value, [
        'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
        'action', 'requiredAuthority'
    ]);
    return Object.freeze({
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        accountId: parseMemoryQqIdV1(input.accountId),
        sceneRef: parseSceneRef(input.sceneRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        generation: positiveInteger(input.generation),
        actorRef: parseActorRef(input.actorRef),
        action: enumValue(input.action, ALL_ACTOR_ACTIONS),
        requiredAuthority: enumValue(input.requiredAuthority, AUTHORITY_REQUIREMENTS)
    });
}
export function memoryLifecycleActorCapabilityAllowsV1(capabilityValue, requestValue, freshNowValue) {
    if (capabilityValue === null || typeof capabilityValue !== 'object' ||
        utilTypes.isProxy(capabilityValue) ||
        !actorCapabilities.has(capabilityValue))
        return false;
    const capability = capabilityValue;
    const state = actorStates.get(capability);
    if (state === undefined)
        return false;
    try {
        const request = parseMemoryLifecycleActorCapabilityRequestV1(requestValue);
        return freshAt(state, freshNowValue) &&
            capability.botInstanceId === request.botInstanceId &&
            capability.accountId === request.accountId &&
            capability.sceneRef === request.sceneRef &&
            capability.namespaceRef === request.namespaceRef &&
            capability.generation === request.generation &&
            capability.actorRef === request.actorRef &&
            state.actions.has(request.action) &&
            actorRoleAllowsRequirement(capability.role, request.requiredAuthority);
    }
    catch {
        return false;
    }
}
export function parseMemoryPolicyCapabilityBindingRequestV1(value) {
    const input = inspectMemoryRecord(value, [
        'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'policyRef',
        'policyGeneration', 'consent', 'createdByActorRef'
    ]);
    return Object.freeze({
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        accountId: parseMemoryQqIdV1(input.accountId),
        sceneRef: parseSceneRef(input.sceneRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        generation: positiveInteger(input.generation),
        policyRef: parseOpaqueRef(input.policyRef, 'policy:'),
        policyGeneration: positiveInteger(input.policyGeneration),
        consent: enumValue(input.consent, ['owner_policy', 'group_policy']),
        createdByActorRef: parseActorRef(input.createdByActorRef)
    });
}
export function memoryPolicyCapabilityAllowsBindingV1(capabilityValue, requestValue, freshNowValue) {
    if (capabilityValue === null || typeof capabilityValue !== 'object' ||
        utilTypes.isProxy(capabilityValue) ||
        !policyCapabilities.has(capabilityValue))
        return false;
    const capability = capabilityValue;
    const state = policyStates.get(capability);
    if (state === undefined)
        return false;
    try {
        const request = parseMemoryPolicyCapabilityBindingRequestV1(requestValue);
        return freshAt(state, freshNowValue) &&
            capability.botInstanceId === request.botInstanceId &&
            capability.accountId === request.accountId &&
            capability.sceneRef === request.sceneRef &&
            capability.namespaceRef === request.namespaceRef &&
            capability.generation === request.generation &&
            capability.policyRef === request.policyRef &&
            capability.policyGeneration === request.policyGeneration &&
            capability.consent === request.consent &&
            capability.createdByActorRef === request.createdByActorRef;
    }
    catch {
        return false;
    }
}
export function parseMemoryPolicyCapabilityRequestV1(value) {
    const input = inspectMemoryRecord(value, [
        'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'policyRef',
        'policyGeneration', 'consent', 'kind', 'sensitivity', 'sourceKinds',
        'retentionPolicyRef'
    ]);
    const sourceKinds = parseUniqueEnumArray(input.sourceKinds, MEMORY_SOURCE_KINDS, MEMORY_RESOURCE_LIMITS.sources);
    if (sourceKinds.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        accountId: parseMemoryQqIdV1(input.accountId),
        sceneRef: parseSceneRef(input.sceneRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        generation: positiveInteger(input.generation),
        policyRef: parseOpaqueRef(input.policyRef, 'policy:'),
        policyGeneration: positiveInteger(input.policyGeneration),
        consent: enumValue(input.consent, ['owner_policy', 'group_policy']),
        kind: enumValue(input.kind, MEMORY_KINDS),
        sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
        sourceKinds,
        retentionPolicyRef: parseOpaqueRef(input.retentionPolicyRef, 'retention:')
    });
}
export function memoryPolicyCapabilityAllowsV1(capabilityValue, requestValue, freshNowValue) {
    if (capabilityValue === null || typeof capabilityValue !== 'object' ||
        utilTypes.isProxy(capabilityValue) ||
        !policyCapabilities.has(capabilityValue))
        return false;
    const capability = capabilityValue;
    const state = policyStates.get(capability);
    if (state === undefined)
        return false;
    try {
        const request = parseMemoryPolicyCapabilityRequestV1(requestValue);
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
            state.allowedRetentionPolicyRefs.has(request.retentionPolicyRef);
    }
    catch {
        return false;
    }
}
export function memoryLifecycleActorCapabilityRoleV1(capabilityValue) {
    if (capabilityValue === null || typeof capabilityValue !== 'object' ||
        utilTypes.isProxy(capabilityValue) ||
        !actorCapabilities.has(capabilityValue))
        return null;
    return actorStates.get(capabilityValue)?.role ?? null;
}
export function parseMemoryMaintenanceCapabilityRequestV1(value) {
    const input = inspectMemoryRecord(value, [
        'botInstanceId', 'accountId', 'namespaceRef', 'currentGeneration', 'targetGeneration',
        'deletionRef', 'operation', 'limit'
    ]);
    const operation = enumValue(input.operation, MEMORY_MAINTENANCE_OPERATIONS_V1);
    const currentGeneration = positiveInteger(input.currentGeneration);
    const targetGeneration = positiveInteger(input.targetGeneration);
    const deletionRef = input.deletionRef === null
        ? null
        : parseDeletionRef(input.deletionRef);
    const limit = positiveInteger(input.limit);
    if (limit > MEMORY_RESOURCE_LIMITS.operationBatchRecords)
        return invalidMemoryValue();
    if (!OLD_GENERATION_MAINTENANCE_OPERATIONS.has(operation)) {
        if (deletionRef !== null || targetGeneration !== currentGeneration)
            return invalidMemoryValue();
    }
    else if (deletionRef === null || targetGeneration >= currentGeneration) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        accountId: parseMemoryQqIdV1(input.accountId),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        currentGeneration,
        targetGeneration,
        deletionRef,
        operation,
        limit
    });
}
export function memoryMaintenanceCapabilityAllowsRequestV1(capabilityValue, requestValue, freshNowValue) {
    if (capabilityValue === null || typeof capabilityValue !== 'object' ||
        utilTypes.isProxy(capabilityValue) ||
        !maintenanceCapabilities.has(capabilityValue))
        return false;
    const capability = capabilityValue;
    const state = maintenanceStates.get(capability);
    if (state === undefined)
        return false;
    try {
        const request = parseMemoryMaintenanceCapabilityRequestV1(requestValue);
        return freshAt(state, freshNowValue) &&
            capability.botInstanceId === request.botInstanceId &&
            capability.accountId === request.accountId &&
            capability.namespaceRef === request.namespaceRef &&
            capability.currentGeneration === request.currentGeneration &&
            capability.targetGeneration === request.targetGeneration &&
            capability.deletionRef === request.deletionRef &&
            capability.operation === request.operation &&
            capability.limit === request.limit;
    }
    catch {
        return false;
    }
}
export function memoryMaintenanceCapabilityAllowsV1(capabilityValue, requestValue, freshNowValue) {
    try {
        const request = parseMemoryMaintenanceAuthorityContextV1(requestValue);
        return memoryMaintenanceCapabilityAllowsRequestV1(capabilityValue, {
            botInstanceId: request.botInstanceId,
            accountId: request.accountId,
            namespaceRef: request.namespaceRef,
            currentGeneration: request.currentGeneration,
            targetGeneration: request.targetGeneration,
            deletionRef: request.deletionRef,
            operation: request.operation,
            limit: request.limit
        }, freshNowValue);
    }
    catch {
        return false;
    }
}
