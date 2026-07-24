import { types as utilTypes } from 'node:util';
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js';
import { memoryLifecycleActorCapabilityAllowsV1, memoryLifecycleActorCapabilityRoleV1, memoryMaintenanceCapabilityAllowsRequestV1, memoryPolicyCapabilityAllowsBindingV1 } from './memory-lifecycle-authority.js';
import { memoryLifecycleCommandHashV1, memoryLifecycleCommandRefHashV1, parseMemoryLifecycleCommandV1, decodeMemoryLifecycleCommandWireV1 } from './memory-lifecycle-command.js';
import { memoryLifecycleDomainHashV1, parseMemoryLifecycleInstantV1 } from './memory-lifecycle-domain.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
import { createMemoryLifecycleResultV1, memoryLifecycleResolveRefV1, memoryLifecycleResultIsLedgerStableV1, memoryLifecycleStableResultHashV1, parseMemoryLifecycleResultV1 } from './memory-lifecycle-result.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
export const MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_HASH_DOMAIN_V1 = 'groupmate.memory.lifecycle-maintenance-actor.v1';
export const MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_REF_V1 = `actor:${memoryLifecycleDomainHashV1(MEMORY_LIFECYCLE_MAINTENANCE_ACTOR_HASH_DOMAIN_V1, 'system:memory-lifecycle-maintenance:v1')}`;
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
function parseEnvelopeAuthority(value) {
    const discriminator = inspectMemoryRecord(value, ['kind', 'capability']);
    if (!plainCapabilityObject(discriminator.capability))
        return invalidMemoryValue();
    if (discriminator.kind === 'actor') {
        return Object.freeze({
            kind: 'actor',
            capability: discriminator.capability
        });
    }
    if (discriminator.kind === 'policy') {
        return Object.freeze({
            kind: 'policy',
            capability: discriminator.capability
        });
    }
    if (discriminator.kind === 'maintenance') {
        return Object.freeze({
            kind: 'maintenance',
            capability: discriminator.capability
        });
    }
    return invalidMemoryValue();
}
function parseMemoryLifecycleAuthorizationEnvelopeV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'command', 'access', 'authority'
    ]);
    if (input.schemaVersion !== 1 || !plainCapabilityObject(input.access)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        schemaVersion: 1,
        command: parseMemoryLifecycleCommandV1(input.command),
        access: input.access,
        authority: parseEnvelopeAuthority(input.authority)
    });
}
function actorAllows(envelope, wire, action, requiredAuthority, freshNow) {
    if (envelope.authority.kind !== 'actor')
        return false;
    return memoryLifecycleActorCapabilityAllowsV1(envelope.authority.capability, {
        botInstanceId: envelope.access.botInstanceId,
        accountId: envelope.access.accountId,
        sceneRef: envelope.access.sceneRef,
        namespaceRef: wire.namespaceRef,
        generation: wire.expectedNamespaceGeneration,
        actorRef: wire.initiatedByActorRef,
        action,
        requiredAuthority
    }, freshNow);
}
function proposalForCreate(command, operation) {
    if (operation === 'proposal.create')
        return command.material;
    return command.material.proposal;
}
function policyAllowsApproval(envelope, wire, evidence, freshNow) {
    if (envelope.authority.kind !== 'policy' ||
        (evidence.evidenceKind !== 'owner_policy' && evidence.evidenceKind !== 'group_policy') ||
        evidence.policyRef === null || evidence.policyGeneration === null)
        return false;
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
    }, freshNow);
}
function maintenanceAllowsExpire(envelope, wire, freshNow) {
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
        }, freshNow);
}
function authorityAllows(envelope, wire, freshNow) {
    if (wire.operation === 'proposal.create') {
        const proposal = proposalForCreate(envelope.command, wire.operation);
        return actorAllows(envelope, wire, proposal.intent.kind === 'correction' ? 'propose_correction' : 'propose_create', 'safe', freshNow);
    }
    if (wire.operation === 'proposal.createAndApprove') {
        const proposal = proposalForCreate(envelope.command, wire.operation);
        if (envelope.authority.kind !== 'actor' ||
            memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability) !== 'personal_subject') {
            return false;
        }
        const proposeAction = proposal.intent.kind === 'correction'
            ? 'propose_correction'
            : 'propose_create';
        return actorAllows(envelope, wire, proposeAction, 'safe', freshNow) &&
            actorAllows(envelope, wire, 'approve', 'ordinary', freshNow);
    }
    if (wire.operation === 'proposal.approve') {
        const evidence = envelope.command.material;
        if (evidence.evidenceKind === 'explicit') {
            return actorAllows(envelope, wire, 'approve', 'ordinary', freshNow);
        }
        return policyAllowsApproval(envelope, wire, evidence, freshNow);
    }
    if (wire.operation === 'proposal.reject') {
        return actorAllows(envelope, wire, 'reject', 'ordinary', freshNow);
    }
    if (wire.operation === 'proposal.withdraw') {
        return actorAllows(envelope, wire, 'withdraw_own_proposal', 'safe', freshNow);
    }
    if (wire.operation === 'proposal.expire') {
        return maintenanceAllowsExpire(envelope, wire, freshNow);
    }
    if (wire.operation === 'record.correct') {
        return actorAllows(envelope, wire, 'correct', 'ordinary', freshNow);
    }
    if (wire.operation === 'record.renew') {
        return actorAllows(envelope, wire, 'renew', 'ordinary', freshNow);
    }
    if (wire.operation === 'record.changeConflict') {
        return actorAllows(envelope, wire, 'change_conflict', 'ordinary', freshNow);
    }
    if (wire.operation === 'record.forget') {
        if (envelope.authority.kind !== 'actor')
            return false;
        const role = memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability);
        const hasExactExpectedState = wire.expectedRevision !== null &&
            wire.expectedAggregateHash !== null;
        if (role === 'personal_bot_master' ? hasExactExpectedState : !hasExactExpectedState) {
            return false;
        }
        return actorAllows(envelope, wire, 'forget', role === 'personal_bot_master' ? 'delete_only' : 'ordinary', freshNow);
    }
    if (envelope.authority.kind !== 'actor')
        return false;
    const role = memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability);
    return actorAllows(envelope, wire, 'delete_namespace', role === 'personal_bot_master' ? 'delete_only' : 'elevated', freshNow);
}
function portResult(wire, commandHash, value) {
    return createMemoryLifecycleResultV1({
        schemaVersion: 1,
        operation: wire.operation,
        commandHash,
        ...value
    });
}
function expectedStoredResultRef(command, wire) {
    if (wire.operation === 'proposal.create') {
        return command.material.proposalId;
    }
    if (wire.operation === 'proposal.createAndApprove') {
        return command.material.record.memoryId;
    }
    return wire.aggregateRef;
}
function expectedStoredRevision(wire) {
    if (wire.operation === 'proposal.create' || wire.operation === 'proposal.createAndApprove')
        return 1;
    if (wire.operation.startsWith('proposal.'))
        return 2;
    if (wire.operation === 'record.correct' || wire.operation === 'record.renew' ||
        wire.operation === 'record.changeConflict') {
        return wire.expectedRevision + 1;
    }
    return null;
}
function adapterResultBindsCommand(result, command, wire, commandHash) {
    if (result.operation !== wire.operation || result.commandHash !== commandHash)
        return false;
    if ((result.status === 'stored' || result.status === 'unchanged') && 'resultRef' in result) {
        return result.resultRef === expectedStoredResultRef(command, wire) &&
            result.resultRevision === expectedStoredRevision(wire);
    }
    if ('receipt' in result) {
        const receipt = result.receipt;
        if (receipt === undefined)
            return false;
        if (receipt.commandRefHash !== memoryLifecycleCommandRefHashV1(wire.commandRef) ||
            receipt.namespaceRef !== wire.namespaceRef ||
            receipt.generationBefore !== wire.expectedNamespaceGeneration ||
            receipt.deletingGeneration !== wire.expectedNamespaceGeneration)
            return false;
        if (wire.operation === 'record.forget') {
            return receipt.operation === 'forget' && receipt.memoryId === wire.aggregateRef &&
                (wire.expectedRevision === null || receipt.deletedRevision === wire.expectedRevision) &&
                receipt.generationAfter === wire.expectedNamespaceGeneration;
        }
        return wire.operation === 'namespace.delete' && receipt.operation === 'delete_namespace' &&
            receipt.memoryId === null && receipt.deletedRevision === null &&
            receipt.generationAfter === wire.expectedNamespaceGeneration + 1;
    }
    return true;
}
function projectDeleteOnlyResult(envelope, wire, commandHash, result) {
    if (envelope.authority.kind !== 'actor' ||
        memoryLifecycleActorCapabilityRoleV1(envelope.authority.capability) !== 'personal_bot_master' ||
        (wire.operation !== 'record.forget' && wire.operation !== 'namespace.delete'))
        return result;
    if (result.status === 'not_found' ||
        (result.status === 'conflict' && result.category !== 'idempotency')) {
        return portResult(wire, commandHash, { status: 'opaque_not_applied' });
    }
    return result;
}
export function createMemoryLifecyclePortV1(optionsValue) {
    const options = inspectMemoryRecord(optionsValue, ['now', 'execute']);
    if (typeof options.now !== 'function' || typeof options.execute !== 'function' ||
        utilTypes.isProxy(options.now) || utilTypes.isProxy(options.execute))
        return invalidMemoryValue();
    const now = options.now;
    const adapterExecute = options.execute;
    const execute = async (envelopeValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const envelope = parseMemoryLifecycleAuthorizationEnvelopeV1(envelopeValue);
            const wire = decodeMemoryLifecycleCommandWireV1(envelope.command.wire);
            const commandHash = memoryLifecycleCommandHashV1(envelope.command.wire);
            if (signalScope.isAborted()) {
                return portResult(wire, commandHash, { status: 'aborted' });
            }
            let freshNow;
            try {
                freshNow = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []));
            }
            catch {
                return invalidMemoryValue();
            }
            if (!memoryAccessCapabilityAllowsV1(envelope.access, wire.namespaceRef, freshNow)) {
                return portResult(wire, commandHash, {
                    status: 'denied', category: 'access'
                });
            }
            if (!authorityAllows(envelope, wire, freshNow)) {
                return portResult(wire, commandHash, {
                    status: 'denied', category: 'authority'
                });
            }
            let adapterValue;
            try {
                adapterValue = await Reflect.apply(adapterExecute, undefined, [
                    envelope,
                    signalScope.signal
                ]);
            }
            catch {
                if (signalScope.isAborted()) {
                    return portResult(wire, commandHash, {
                        status: 'resolve_required',
                        category: 'outcome_unknown',
                        resolveRef: memoryLifecycleResolveRefV1(commandHash)
                    });
                }
                return portResult(wire, commandHash, {
                    status: 'unavailable', category: 'io', retryable: true
                });
            }
            let result;
            try {
                result = parseMemoryLifecycleResultV1(adapterValue);
                if (!adapterResultBindsCommand(result, envelope.command, wire, commandHash) ||
                    (result.status === 'committed_after_abort' && !signalScope.isAborted()) ||
                    (result.status === 'resolve_required' && !signalScope.isAborted()) ||
                    (result.status === 'aborted' && !signalScope.isAborted())) {
                    return invalidMemoryValue();
                }
            }
            catch {
                if (signalScope.isAborted()) {
                    return portResult(wire, commandHash, {
                        status: 'resolve_required',
                        category: 'outcome_unknown',
                        resolveRef: memoryLifecycleResolveRefV1(commandHash)
                    });
                }
                return portResult(wire, commandHash, {
                    status: 'corrupt', category: 'adapter_contract'
                });
            }
            result = projectDeleteOnlyResult(envelope, wire, commandHash, result);
            const committedResultHash = signalScope.isAborted() &&
                memoryLifecycleResultIsLedgerStableV1(result)
                ? memoryLifecycleStableResultHashV1(result)
                : null;
            if (committedResultHash !== null) {
                return portResult(wire, commandHash, {
                    status: 'committed_after_abort',
                    resolveRef: memoryLifecycleResolveRefV1(commandHash),
                    committedResultHash,
                    ...('receipt' in result ? { receipt: result.receipt } : {})
                });
            }
            return result;
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
