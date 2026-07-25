import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryBotInstanceIdV1, parseMemoryGroupLifecycleIdV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1, parseMemoryQqIdV1 } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
const memoryAccessCapabilityBrand = Symbol('MemoryAccessCapabilityV1');
const memoryAccessCapabilityIssuerBrand = Symbol('MemoryAccessCapabilityIssuerV1');
const issuedMemoryAccessCapabilities = new WeakSet();
const issuedMemoryAccessCapabilityIssuers = new WeakSet();
const memoryAccessCapabilityVerifier = new WeakMap();
const memoryAccessCapabilityState = new WeakMap();
const MEMORY_ACCESS_SCENE_HASH_DOMAIN = 'groupmate.memory.access-scene.v1';
const DENIED_REASONS = [
    'wrong_bot',
    'wrong_account',
    'wrong_group',
    'wrong_group_lifecycle',
    'subject_not_in_current_group',
    'private_subject_mismatch'
];
function parseCanonicalInstant(value) {
    if (typeof value !== 'string' || value.length > 32)
        return invalidMemoryValue();
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
        return invalidMemoryValue();
    return value;
}
function asciiMemoryCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function parseMemoryAccessSceneV1(value) {
    const discriminator = inspectMemoryRecord(value, ['kind'], ['peerUserId', 'groupId', 'groupLifecycleId', 'trustedMemberUserIds', 'observedAt']);
    if (discriminator.kind === 'private') {
        const input = inspectMemoryRecord(value, ['kind', 'peerUserId']);
        return Object.freeze({
            kind: 'private',
            peerUserId: parseMemoryQqIdV1(input.peerUserId)
        });
    }
    if (discriminator.kind === 'group') {
        const input = inspectMemoryRecord(value, [
            'kind',
            'groupId',
            'groupLifecycleId',
            'trustedMemberUserIds',
            'observedAt'
        ]);
        const members = inspectMemoryArray(input.trustedMemberUserIds, MEMORY_RESOURCE_LIMITS.trustedMemberUserIds).map(parseMemoryQqIdV1);
        if (new Set(members).size !== members.length)
            return invalidMemoryValue();
        members.sort(asciiMemoryCompare);
        return Object.freeze({
            kind: 'group',
            groupId: parseMemoryQqIdV1(input.groupId),
            groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId),
            trustedMemberUserIds: Object.freeze(members),
            observedAt: parseCanonicalInstant(input.observedAt)
        });
    }
    return invalidMemoryValue();
}
export function parseMemoryAccessContextV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion',
        'botInstanceId',
        'adapter',
        'accountId',
        'scene'
    ]);
    if (input.schemaVersion !== 1 || input.adapter !== 'qq')
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
        adapter: 'qq',
        accountId: parseMemoryQqIdV1(input.accountId),
        scene: parseMemoryAccessSceneV1(input.scene)
    });
}
function deniedReason(context, namespace) {
    if (namespace.botInstanceId !== context.botInstanceId)
        return 'wrong_bot';
    if (namespace.accountId !== context.accountId)
        return 'wrong_account';
    if (context.scene.kind === 'private') {
        if (namespace.scope.kind === 'group')
            return 'wrong_group';
        return namespace.scope.subjectUserId === context.scene.peerUserId
            ? null
            : 'private_subject_mismatch';
    }
    if (namespace.scope.kind === 'personal') {
        return context.scene.trustedMemberUserIds.includes(namespace.scope.subjectUserId)
            ? null
            : 'subject_not_in_current_group';
    }
    if (namespace.scope.groupId !== context.scene.groupId)
        return 'wrong_group';
    return namespace.scope.groupLifecycleId === context.scene.groupLifecycleId
        ? null
        : 'wrong_group_lifecycle';
}
function evaluateMemoryAccessV1(contextValue, requestedNamespacesValue) {
    const context = parseMemoryAccessContextV1(contextValue);
    const namespaces = inspectMemoryArray(requestedNamespacesValue, MEMORY_RESOURCE_LIMITS.accessNamespaces).map(parseMemoryNamespaceV1);
    const refs = namespaces.map(memoryNamespaceRefV1);
    if (new Set(refs).size !== refs.length)
        return invalidMemoryValue();
    const allowedNamespaceRefs = [];
    const denied = [];
    namespaces.forEach((namespace, index) => {
        const requestedNamespaceRef = refs[index];
        if (requestedNamespaceRef === undefined)
            return invalidMemoryValue();
        const reason = deniedReason(context, namespace);
        if (reason === null) {
            allowedNamespaceRefs.push(requestedNamespaceRef);
        }
        else {
            denied.push(Object.freeze({ requestedNamespaceRef, reason }));
        }
    });
    return Object.freeze({
        context,
        decision: Object.freeze({
            allowedNamespaceRefs: Object.freeze(allowedNamespaceRefs),
            denied: Object.freeze(denied)
        })
    });
}
export function decideMemoryAccessV1(contextValue, requestedNamespacesValue) {
    return evaluateMemoryAccessV1(contextValue, requestedNamespacesValue).decision;
}
export function memoryAccessSceneRefV1(sceneValue) {
    const scene = parseMemoryAccessSceneV1(sceneValue);
    const wire = scene.kind === 'private'
        ? `{"kind":"private","peerUserId":${JSON.stringify(scene.peerUserId)}}`
        : `{"kind":"group","groupId":${JSON.stringify(scene.groupId)},"groupLifecycleId":${JSON.stringify(scene.groupLifecycleId)}}`;
    return createHash('sha256')
        .update(MEMORY_ACCESS_SCENE_HASH_DOMAIN, 'utf8')
        .update('\0')
        .update(wire, 'utf8')
        .digest('hex');
}
function canonicalInstantFromMilliseconds(milliseconds) {
    if (!Number.isSafeInteger(milliseconds))
        return invalidMemoryValue();
    try {
        return new Date(milliseconds).toISOString();
    }
    catch {
        return invalidMemoryValue();
    }
}
export function createMemoryAccessCapabilityIssuerV1(verifierValue) {
    if (typeof verifierValue !== 'function')
        return invalidMemoryValue();
    const issuer = Object.freeze({
        [memoryAccessCapabilityIssuerBrand]: true
    });
    issuedMemoryAccessCapabilityIssuers.add(issuer);
    memoryAccessCapabilityVerifier.set(issuer, verifierValue);
    return issuer;
}
function trustedVerifierAllows(issuer, context, now) {
    const verifier = memoryAccessCapabilityVerifier.get(issuer);
    if (verifier === undefined)
        return false;
    let result;
    try {
        result = Reflect.apply(verifier, undefined, [context, now]);
    }
    catch {
        return false;
    }
    if (utilTypes.isPromise(result)) {
        void Promise.prototype.then.call(result, undefined, () => undefined);
        return false;
    }
    return result === true;
}
export function issueMemoryAccessCapabilityV1(issuer, contextValue, requestedNamespacesValue, nowValue) {
    if (issuer === null || typeof issuer !== 'object' ||
        !issuedMemoryAccessCapabilityIssuers.has(issuer)) {
        return invalidMemoryValue();
    }
    const now = parseCanonicalInstant(nowValue);
    const context = parseMemoryAccessContextV1(contextValue);
    if (!trustedVerifierAllows(issuer, context, now))
        return invalidMemoryValue();
    const nowMs = Date.parse(now);
    const evaluation = evaluateMemoryAccessV1(context, requestedNamespacesValue);
    const observedAt = evaluation.context.scene.kind === 'group'
        ? evaluation.context.scene.observedAt
        : null;
    let validUntilMs = nowMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs;
    if (evaluation.context.scene.kind === 'group') {
        const observedAtMs = Date.parse(evaluation.context.scene.observedAt);
        if (nowMs - observedAtMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs ||
            observedAtMs - nowMs > MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotFutureSkewMs) {
            return invalidMemoryValue();
        }
        validUntilMs = Math.min(validUntilMs, observedAtMs + MEMORY_RESOURCE_LIMITS.trustedMemberSnapshotMaxAgeMs);
    }
    const allowedNamespaceRefs = Object.freeze([
        ...evaluation.decision.allowedNamespaceRefs
    ]);
    const capability = Object.freeze({
        schemaVersion: 1,
        botInstanceId: evaluation.context.botInstanceId,
        adapter: 'qq',
        accountId: evaluation.context.accountId,
        sceneRef: memoryAccessSceneRefV1(evaluation.context.scene),
        observedAt,
        validFrom: now,
        validUntil: canonicalInstantFromMilliseconds(validUntilMs),
        allowedNamespaceRefs,
        [memoryAccessCapabilityBrand]: true
    });
    issuedMemoryAccessCapabilities.add(capability);
    memoryAccessCapabilityState.set(capability, Object.freeze({
        allowedNamespaceRefs: new Set(allowedNamespaceRefs),
        validFromMs: nowMs,
        validUntilMs
    }));
    return capability;
}
export function memoryAccessCapabilityAllowsV1(capability, namespaceRefValue, nowValue) {
    if (capability === null || typeof capability !== 'object' ||
        !issuedMemoryAccessCapabilities.has(capability))
        return false;
    const state = memoryAccessCapabilityState.get(capability);
    if (state === undefined)
        return false;
    try {
        const namespaceRef = parseMemoryNamespaceRefV1(namespaceRefValue);
        const nowMs = nowValue === undefined
            ? Date.now()
            : Date.parse(parseCanonicalInstant(nowValue));
        return nowMs >= state.validFromMs && nowMs <= state.validUntilMs &&
            state.allowedNamespaceRefs.has(namespaceRef);
    }
    catch {
        return false;
    }
}
function parseDeniedReason(value) {
    if (typeof value !== 'string' || !DENIED_REASONS.includes(value)) {
        return invalidMemoryValue();
    }
    return value;
}
export function parseMemoryAccessDecisionV1(value) {
    const input = inspectMemoryRecord(value, ['allowedNamespaceRefs', 'denied']);
    const allowedNamespaceRefs = inspectMemoryArray(input.allowedNamespaceRefs, MEMORY_RESOURCE_LIMITS.accessNamespaces).map(parseMemoryNamespaceRefV1);
    const denied = inspectMemoryArray(input.denied, MEMORY_RESOURCE_LIMITS.accessNamespaces).map(entry => {
        const item = inspectMemoryRecord(entry, ['requestedNamespaceRef', 'reason']);
        return Object.freeze({
            requestedNamespaceRef: parseMemoryNamespaceRefV1(item.requestedNamespaceRef),
            reason: parseDeniedReason(item.reason)
        });
    });
    const allRefs = [
        ...allowedNamespaceRefs,
        ...denied.map(value => value.requestedNamespaceRef)
    ];
    if (allRefs.length > MEMORY_RESOURCE_LIMITS.accessNamespaces ||
        new Set(allRefs).size !== allRefs.length)
        return invalidMemoryValue();
    return Object.freeze({
        allowedNamespaceRefs: Object.freeze(allowedNamespaceRefs),
        denied: Object.freeze(denied)
    });
}
