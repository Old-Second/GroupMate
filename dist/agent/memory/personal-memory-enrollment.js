import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1, memoryAccessSceneRefV1 } from './memory-access-gate.js';
import { parseMemorySourceV1 } from './memory-domain.js';
import { memoryLifecycleActorCapabilityAllowsV1 } from './memory-lifecycle-authority.js';
import { memoryLifecycleDomainHashV1, parseMemoryLifecycleHashV1, parseMemoryLifecycleInstantV1, parseMemoryLifecyclePositiveIntegerV1 } from './memory-lifecycle-domain.js';
import { inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryNamespaceRefV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { MEMORY_DERIVATIVE_RESOURCE_LIMITS } from './memory-resource-limits.js';
export const PERSONAL_MEMORY_ENROLLMENT_COMMAND_HASH_DOMAIN_V1 = 'groupmate.memory.personal-enrollment-command.v1';
export const PERSONAL_MEMORY_ENROLLMENT_COMMAND_REF_HASH_DOMAIN_V1 = 'groupmate.memory.personal-enrollment-command-ref.v1';
export const PERSONAL_MEMORY_ENROLLMENT_ACTOR_REF_HASH_DOMAIN_V1 = 'groupmate.memory.personal-enrollment-actor-ref.v1';
export const PERSONAL_MEMORY_ENROLLMENT_SOURCE_REF_HASH_DOMAIN_V1 = 'groupmate.memory.personal-enrollment-source-ref.v1';
export const PERSONAL_MEMORY_ENROLLMENT_POLICY_HASH_DOMAIN_V1 = 'groupmate.memory.personal-enrollment-policy.v1';
const COMMAND_REF = /^command:[0-9a-f]{64}$/;
const ACTOR_REF = /^actor:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATIONS = Object.freeze([
    'enrollment.optIn', 'enrollment.optOut'
]);
const STATES = Object.freeze(['opted_out', 'opted_in']);
const CANDIDATE_MODES = Object.freeze([
    'off', 'shadow', 'policy_approved'
]);
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function nonnegativeInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function commandRef(value) {
    if (typeof value !== 'string' || !COMMAND_REF.test(value))
        return invalidMemoryValue();
    return value;
}
function actorRef(value) {
    if (typeof value !== 'string' || !ACTOR_REF.test(value))
        return invalidMemoryValue();
    return value;
}
function sourceId(value) {
    if (typeof value !== 'string' || !HASH.test(value))
        return invalidMemoryValue();
    return value;
}
function plainCapabilityObject(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
        return false;
    try {
        if (Object.getPrototypeOf(value) !== Object.prototype)
            return false;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        return Reflect.ownKeys(value).every(key => {
            const descriptor = descriptors[key];
            return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
        });
    }
    catch {
        return false;
    }
}
function parseCommandWireObject(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
        'expectedNamespaceGeneration', 'expectedPolicyGeneration', 'candidateMode',
        'occurredAt', 'sourceId'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const operation = enumValue(input.operation, OPERATIONS);
    const candidateMode = enumValue(input.candidateMode, CANDIDATE_MODES);
    if (operation === 'enrollment.optOut' && candidateMode !== 'off') {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        commandRef: commandRef(input.commandRef),
        operation,
        initiatedByActorRef: actorRef(input.initiatedByActorRef),
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        expectedNamespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.expectedNamespaceGeneration),
        expectedPolicyGeneration: nonnegativeInteger(input.expectedPolicyGeneration),
        candidateMode,
        occurredAt: parseMemoryLifecycleInstantV1(input.occurredAt),
        sourceId: sourceId(input.sourceId)
    });
}
export function encodePersonalMemoryEnrollmentCommandWireV1(value) {
    const wire = JSON.stringify(parseCommandWireObject(value));
    if (Buffer.byteLength(wire, 'utf8') >
        MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes)
        return invalidMemoryValue();
    return wire;
}
export function decodePersonalMemoryEnrollmentCommandWireV1(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
        MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes)
        return invalidMemoryValue();
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const parsed = parseCommandWireObject(value);
    if (JSON.stringify(parsed) !== raw)
        return invalidMemoryValue();
    return parsed;
}
export function createPersonalMemoryEnrollmentCommandV1(value) {
    const input = inspectMemoryRecord(value, [
        'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
        'expectedNamespaceGeneration', 'expectedPolicyGeneration', 'candidateMode',
        'occurredAt', 'source'
    ]);
    const source = parseMemorySourceV1(input.source);
    if (source.sourceKind !== 'current_message')
        return invalidMemoryValue();
    const wire = encodePersonalMemoryEnrollmentCommandWireV1({
        schemaVersion: 1,
        commandRef: input.commandRef,
        operation: input.operation,
        initiatedByActorRef: input.initiatedByActorRef,
        namespaceRef: input.namespaceRef,
        expectedNamespaceGeneration: input.expectedNamespaceGeneration,
        expectedPolicyGeneration: input.expectedPolicyGeneration,
        candidateMode: input.candidateMode,
        occurredAt: input.occurredAt,
        sourceId: source.sourceId
    });
    const decoded = decodePersonalMemoryEnrollmentCommandWireV1(wire);
    if (source.observedAt !== decoded.occurredAt)
        return invalidMemoryValue();
    return Object.freeze({ wire, source });
}
export function parsePersonalMemoryEnrollmentCommandV1(value) {
    const input = inspectMemoryRecord(value, ['wire', 'source']);
    const wire = decodePersonalMemoryEnrollmentCommandWireV1(input.wire);
    const source = parseMemorySourceV1(input.source);
    if (source.sourceKind !== 'current_message' || source.sourceId !== wire.sourceId ||
        source.observedAt !== wire.occurredAt)
        return invalidMemoryValue();
    return Object.freeze({ wire: input.wire, source });
}
export function personalMemoryEnrollmentCommandHashV1(wire) {
    const canonical = encodePersonalMemoryEnrollmentCommandWireV1(decodePersonalMemoryEnrollmentCommandWireV1(wire));
    return memoryLifecycleDomainHashV1(PERSONAL_MEMORY_ENROLLMENT_COMMAND_HASH_DOMAIN_V1, canonical);
}
function refHash(domain, value) {
    return memoryLifecycleDomainHashV1(domain, value);
}
export function personalMemoryEnrollmentCommandRefHashV1(value) {
    return refHash(PERSONAL_MEMORY_ENROLLMENT_COMMAND_REF_HASH_DOMAIN_V1, commandRef(value));
}
export function personalMemoryEnrollmentActorRefHashV1(value) {
    return refHash(PERSONAL_MEMORY_ENROLLMENT_ACTOR_REF_HASH_DOMAIN_V1, actorRef(value));
}
export function personalMemoryEnrollmentSourceRefHashV1(value) {
    return refHash(PERSONAL_MEMORY_ENROLLMENT_SOURCE_REF_HASH_DOMAIN_V1, sourceId(value));
}
function parsePolicyBase(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'state', 'candidateMode',
        'policyGeneration', 'commandRefHash', 'commandHash', 'decidedByActorRefHash',
        'decisionSourceRefHash', 'updatedAt'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const state = enumValue(input.state, STATES);
    const candidateMode = enumValue(input.candidateMode, CANDIDATE_MODES);
    if (state === 'opted_out' && candidateMode !== 'off')
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
        namespaceGeneration: parseMemoryLifecyclePositiveIntegerV1(input.namespaceGeneration),
        state,
        candidateMode,
        policyGeneration: parseMemoryLifecyclePositiveIntegerV1(input.policyGeneration),
        commandRefHash: parseMemoryLifecycleHashV1(input.commandRefHash),
        commandHash: parseMemoryLifecycleHashV1(input.commandHash),
        decidedByActorRefHash: parseMemoryLifecycleHashV1(input.decidedByActorRefHash),
        decisionSourceRefHash: parseMemoryLifecycleHashV1(input.decisionSourceRefHash),
        updatedAt: parseMemoryLifecycleInstantV1(input.updatedAt)
    });
}
function policyHashForBase(base) {
    return memoryLifecycleDomainHashV1(PERSONAL_MEMORY_ENROLLMENT_POLICY_HASH_DOMAIN_V1, JSON.stringify(base));
}
export function createPersonalMemoryEnrollmentPolicyV1(value) {
    const base = parsePolicyBase(value);
    return Object.freeze({ ...base, policyHash: policyHashForBase(base) });
}
function parsePolicy(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'state', 'candidateMode',
        'policyGeneration', 'commandRefHash', 'commandHash', 'decidedByActorRefHash',
        'decisionSourceRefHash', 'updatedAt', 'policyHash'
    ]);
    const base = parsePolicyBase({
        schemaVersion: input.schemaVersion,
        namespaceRef: input.namespaceRef,
        namespaceGeneration: input.namespaceGeneration,
        state: input.state,
        candidateMode: input.candidateMode,
        policyGeneration: input.policyGeneration,
        commandRefHash: input.commandRefHash,
        commandHash: input.commandHash,
        decidedByActorRefHash: input.decidedByActorRefHash,
        decisionSourceRefHash: input.decisionSourceRefHash,
        updatedAt: input.updatedAt
    });
    const policyHash = parseMemoryLifecycleHashV1(input.policyHash);
    if (policyHash !== policyHashForBase(base))
        return invalidMemoryValue();
    return Object.freeze({ ...base, policyHash });
}
export function encodePersonalMemoryEnrollmentPolicyV1(value) {
    const wire = JSON.stringify(parsePolicy(value));
    if (Buffer.byteLength(wire, 'utf8') >
        MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes)
        return invalidMemoryValue();
    return wire;
}
export function decodePersonalMemoryEnrollmentPolicyV1(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') >
        MEMORY_DERIVATIVE_RESOURCE_LIMITS.personalPolicyWireBytes)
        return invalidMemoryValue();
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const parsed = parsePolicy(value);
    if (JSON.stringify(parsed) !== raw)
        return invalidMemoryValue();
    return parsed;
}
export function personalMemoryEnrollmentSourceSceneRefV1(sourceValue) {
    const source = parseMemorySourceV1(sourceValue);
    if (source.scene.kind === 'private') {
        return memoryAccessSceneRefV1({
            kind: 'private',
            peerUserId: source.actor.userId
        });
    }
    return memoryAccessSceneRefV1({
        kind: 'group',
        groupId: source.scene.groupId,
        groupLifecycleId: source.scene.groupLifecycleId,
        trustedMemberUserIds: [source.actor.userId],
        observedAt: source.observedAt
    });
}
function parseReadRequest(value) {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'namespace', 'access']);
    if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access)) {
        return invalidMemoryValue();
    }
    const namespace = parseMemoryNamespaceV1(input.namespace);
    if (namespace.scope.kind !== 'personal')
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        namespace,
        access: input.access
    });
}
export function parsePersonalMemoryEnrollmentDecisionEnvelopeV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'namespace', 'command', 'access', 'actor'
    ]);
    if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access) ||
        !plainCapabilityObject(input.actor))
        return invalidMemoryValue();
    const namespace = parseMemoryNamespaceV1(input.namespace);
    const command = parsePersonalMemoryEnrollmentCommandV1(input.command);
    const wire = decodePersonalMemoryEnrollmentCommandWireV1(command.wire);
    if (namespace.scope.kind !== 'personal' || memoryNamespaceRefV1(namespace) !== wire.namespaceRef ||
        command.source.actor.userId !== namespace.scope.subjectUserId)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        namespace,
        command,
        access: input.access,
        actor: input.actor
    });
}
function retryableForCategory(category, value) {
    if (typeof value !== 'boolean' || value !== (category !== 'storage')) {
        return invalidMemoryValue();
    }
    return value;
}
function parseReadResult(value, namespaceRef, aborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['policy', 'category', 'retryable']);
    if (discriminator.status === 'found') {
        const input = inspectMemoryRecord(value, ['status', 'policy']);
        const policy = parsePolicy(input.policy);
        if (policy.namespaceRef !== namespaceRef)
            return invalidMemoryValue();
        return Object.freeze({ status: 'found', policy });
    }
    if (discriminator.status === 'not_enrolled') {
        inspectMemoryRecord(value, ['status']);
        return Object.freeze({ status: 'not_enrolled' });
    }
    if (discriminator.status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'corrupt',
            category: enumValue(input.category, ['canonical_data', 'adapter_contract'])
        });
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
    if (discriminator.status === 'aborted' && aborted) {
        inspectMemoryRecord(value, ['status']);
        return Object.freeze({ status: 'aborted' });
    }
    return invalidMemoryValue();
}
function expectedPolicyForCommand(wire, policyGeneration) {
    return {
        schemaVersion: 1,
        namespaceRef: wire.namespaceRef,
        namespaceGeneration: wire.expectedNamespaceGeneration,
        state: wire.operation === 'enrollment.optIn' ? 'opted_in' : 'opted_out',
        candidateMode: wire.candidateMode,
        policyGeneration,
        commandRefHash: personalMemoryEnrollmentCommandRefHashV1(wire.commandRef),
        commandHash: personalMemoryEnrollmentCommandHashV1(encodePersonalMemoryEnrollmentCommandWireV1(wire)),
        decidedByActorRefHash: personalMemoryEnrollmentActorRefHashV1(wire.initiatedByActorRef),
        decisionSourceRefHash: personalMemoryEnrollmentSourceRefHashV1(wire.sourceId)
    };
}
function policyBindsCommand(policy, wire) {
    const expected = expectedPolicyForCommand(wire, wire.expectedPolicyGeneration + 1);
    return Object.entries(expected).every(([key, value]) => (policy[key] === value)) && Date.parse(policy.updatedAt) >= Date.parse(wire.occurredAt);
}
function parseDecisionResult(value, wire, aborted) {
    const discriminator = inspectMemoryRecord(value, ['status'], ['policy', 'category', 'retryable']);
    if (discriminator.status === 'stored' || discriminator.status === 'unchanged') {
        const input = inspectMemoryRecord(value, ['status', 'policy']);
        const policy = parsePolicy(input.policy);
        if (!policyBindsCommand(policy, wire))
            return invalidMemoryValue();
        return Object.freeze({ status: discriminator.status, policy });
    }
    if (discriminator.status === 'denied') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'denied',
            category: enumValue(input.category, ['access', 'authority'])
        });
    }
    if (discriminator.status === 'conflict') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'conflict',
            category: enumValue(input.category, ['generation', 'idempotency'])
        });
    }
    if (discriminator.status === 'capacity') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'capacity',
            category: enumValue(input.category, ['namespaces', 'canonical_bytes'])
        });
    }
    if (discriminator.status === 'corrupt') {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        return Object.freeze({
            status: 'corrupt',
            category: enumValue(input.category, ['canonical_data', 'adapter_contract'])
        });
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
    if (discriminator.status === 'resolve_required' && aborted) {
        const input = inspectMemoryRecord(value, ['status', 'category']);
        if (input.category !== 'outcome_unknown')
            return invalidMemoryValue();
        return Object.freeze({ status: 'resolve_required', category: 'outcome_unknown' });
    }
    if (discriminator.status === 'aborted' && aborted) {
        inspectMemoryRecord(value, ['status']);
        return Object.freeze({ status: 'aborted' });
    }
    return invalidMemoryValue();
}
function accessBindsNamespace(capability, namespace, now) {
    return capability.botInstanceId === namespace.botInstanceId &&
        capability.accountId === namespace.accountId &&
        memoryAccessCapabilityAllowsV1(capability, memoryNamespaceRefV1(namespace), now);
}
function trustedEnrollmentNow(source) {
    try {
        return parseMemoryLifecycleInstantV1(Reflect.apply(source, undefined, []));
    }
    catch {
        return null;
    }
}
export function createPersonalMemoryEnrollmentPortV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, ['now', 'read', 'decide']);
    if (typeof input.now !== 'function' || typeof input.read !== 'function' ||
        typeof input.decide !== 'function' || utilTypes.isProxy(input.now) ||
        utilTypes.isProxy(input.read) || utilTypes.isProxy(input.decide))
        return invalidMemoryValue();
    const now = input.now;
    const adapterRead = input.read;
    const adapterDecide = input.decide;
    const read = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const request = parseReadRequest(requestValue);
            const namespaceRef = memoryNamespaceRefV1(request.namespace);
            const freshNow = trustedEnrollmentNow(now);
            if (freshNow === null) {
                return Object.freeze({
                    status: 'unavailable',
                    category: 'storage',
                    retryable: false
                });
            }
            if (signalScope.isAborted())
                return Object.freeze({ status: 'aborted' });
            if (!accessBindsNamespace(request.access, request.namespace, freshNow)) {
                return Object.freeze({ status: 'denied' });
            }
            let result;
            try {
                result = await Reflect.apply(adapterRead, undefined, [Object.freeze({
                        schemaVersion: 1,
                        namespace: request.namespace,
                        namespaceRef
                    }), signalScope.signal]);
            }
            catch {
                if (signalScope.isAborted())
                    return Object.freeze({ status: 'aborted' });
                return Object.freeze({
                    status: 'unavailable',
                    category: 'io',
                    retryable: true
                });
            }
            if (signalScope.isAborted())
                return Object.freeze({ status: 'aborted' });
            const afterNow = trustedEnrollmentNow(now);
            if (afterNow === null) {
                return Object.freeze({
                    status: 'unavailable',
                    category: 'storage',
                    retryable: false
                });
            }
            if (!accessBindsNamespace(request.access, request.namespace, afterNow)) {
                return Object.freeze({ status: 'denied' });
            }
            try {
                return parseReadResult(result, namespaceRef, signalScope.isAborted());
            }
            catch {
                return Object.freeze({
                    status: 'corrupt',
                    category: 'adapter_contract'
                });
            }
        }
        finally {
            signalScope.close();
        }
    };
    const decide = async (envelopeValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const envelope = parsePersonalMemoryEnrollmentDecisionEnvelopeV1(envelopeValue);
            const wire = decodePersonalMemoryEnrollmentCommandWireV1(envelope.command.wire);
            const freshNow = trustedEnrollmentNow(now);
            if (freshNow === null) {
                return Object.freeze({
                    status: 'unavailable',
                    category: 'storage',
                    retryable: false
                });
            }
            if (signalScope.isAborted())
                return Object.freeze({ status: 'aborted' });
            if (!accessBindsNamespace(envelope.access, envelope.namespace, freshNow)) {
                return Object.freeze({ status: 'denied', category: 'access' });
            }
            if (envelope.access.sceneRef !== envelope.actor.sceneRef ||
                envelope.access.sceneRef !== personalMemoryEnrollmentSourceSceneRefV1(envelope.command.source) ||
                envelope.actor.botInstanceId !== envelope.namespace.botInstanceId ||
                envelope.actor.accountId !== envelope.namespace.accountId ||
                envelope.actor.actorRef !== wire.initiatedByActorRef ||
                !memoryLifecycleActorCapabilityAllowsV1(envelope.actor, {
                    botInstanceId: envelope.namespace.botInstanceId,
                    accountId: envelope.namespace.accountId,
                    sceneRef: envelope.access.sceneRef,
                    namespaceRef: wire.namespaceRef,
                    generation: wire.expectedNamespaceGeneration,
                    actorRef: wire.initiatedByActorRef,
                    action: 'manage_enrollment',
                    requiredAuthority: 'elevated'
                }, freshNow)) {
                return Object.freeze({ status: 'denied', category: 'authority' });
            }
            let result;
            try {
                result = await Reflect.apply(adapterDecide, undefined, [envelope, signalScope.signal]);
            }
            catch {
                if (signalScope.isAborted()) {
                    return Object.freeze({
                        status: 'resolve_required',
                        category: 'outcome_unknown'
                    });
                }
                return Object.freeze({
                    status: 'unavailable',
                    category: 'io',
                    retryable: true
                });
            }
            try {
                return parseDecisionResult(result, wire, signalScope.isAborted());
            }
            catch {
                return Object.freeze({
                    status: 'corrupt',
                    category: 'adapter_contract'
                });
            }
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ read, decide });
}
