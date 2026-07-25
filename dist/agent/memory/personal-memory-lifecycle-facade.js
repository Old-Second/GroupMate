import { types as utilTypes } from 'node:util';
import { decodeMemoryExportCommandWireV1 } from './memory-export-port.js';
import { decodeMemoryLifecycleCommandWireV1, parseMemoryLifecycleCommandV1 } from './memory-lifecycle-command.js';
import { inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { decodePersonalMemoryEnrollmentCommandWireV1, personalMemoryEnrollmentSourceSceneRefV1 } from './personal-memory-enrollment.js';
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js';
export const PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1 = '关闭个人长期记忆后会立即停止召回和新写入，但不会删除已经保存的长期记忆。';
export const PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1 = '遗忘或删除长期记忆不会删除 GroupMate 的独立诊断日志；诊断日志按单独的保留策略清理。';
export const PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1 = '长期记忆导出不包含 GroupMate 的独立诊断日志、QQ 服务端历史或 Provider 日志。';
const OPERATIONS = Object.freeze([
    'enrollment.read', 'enrollment.optIn', 'enrollment.optOut', 'remember', 'list',
    'correct', 'renew', 'forget', 'export', 'delete'
]);
function dataRecord(value, allowSymbols) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value))
        return invalidMemoryValue();
    let prototype;
    let keys;
    try {
        prototype = Object.getPrototypeOf(value);
        keys = Reflect.ownKeys(value);
    }
    catch {
        return invalidMemoryValue();
    }
    if (prototype !== Object.prototype || (!allowSymbols &&
        keys.some(key => typeof key !== 'string'))) {
        return invalidMemoryValue();
    }
    const result = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true)
            return invalidMemoryValue();
        if (typeof key === 'string')
            result[key] = descriptor.value;
    }
    return result;
}
function plainDataRecord(value) {
    return dataRecord(value, false);
}
function capabilityDataRecord(value) {
    return dataRecord(value, true);
}
function dataField(value, field) {
    const record = plainDataRecord(value);
    if (!Object.hasOwn(record, field))
        return invalidMemoryValue();
    return record[field];
}
function capabilityField(value, field) {
    const record = capabilityDataRecord(value);
    if (!Object.hasOwn(record, field))
        return invalidMemoryValue();
    return record[field];
}
function enumOperation(value) {
    if (typeof value !== 'string' || !OPERATIONS.includes(value))
        return invalidMemoryValue();
    return value;
}
function parseRequest(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'operation', 'namespace', 'payload'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const namespace = parseMemoryNamespaceV1(input.namespace);
    if (namespace.scope.kind !== 'personal')
        return invalidMemoryValue();
    plainDataRecord(input.payload);
    return Object.freeze({
        schemaVersion: 1,
        operation: enumOperation(input.operation),
        namespace,
        payload: input.payload
    });
}
function actorIsPersonalSubject(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
        return false;
    const record = capabilityDataRecord(value);
    return record.role === 'personal_subject';
}
function requirePersonalLifecyclePayload(payload, namespace, operation) {
    const input = inspectMemoryRecord(payload, [
        'schemaVersion', 'command', 'access', 'authority'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const command = parseMemoryLifecycleCommandV1(input.command);
    const wire = decodeMemoryLifecycleCommandWireV1(command.wire);
    const authority = inspectMemoryRecord(input.authority, ['kind', 'capability']);
    const access = capabilityDataRecord(input.access);
    if (wire.operation !== operation || wire.namespaceRef !== memoryNamespaceRefV1(namespace) ||
        authority.kind !== 'actor' || !actorIsPersonalSubject(authority.capability) ||
        capabilityField(authority.capability, 'namespaceRef') !== wire.namespaceRef ||
        capabilityField(authority.capability, 'generation') !== wire.expectedNamespaceGeneration ||
        capabilityField(authority.capability, 'actorRef') !== wire.initiatedByActorRef ||
        capabilityField(input.access, 'botInstanceId') !== namespace.botInstanceId ||
        capabilityField(input.access, 'accountId') !== namespace.accountId)
        return invalidMemoryValue();
    return Object.freeze({ access, command });
}
function requireSelfCurrentSource(source, namespace, access) {
    if (source === null || typeof source !== 'object')
        return invalidMemoryValue();
    const sourceRecord = plainDataRecord(source);
    const actor = plainDataRecord(sourceRecord.actor);
    if (namespace.scope.kind !== 'personal' || sourceRecord.sourceKind !== 'current_message' ||
        actor.userId !== namespace.scope.subjectUserId ||
        personalMemoryEnrollmentSourceSceneRefV1(source) !== access.sceneRef) {
        return invalidMemoryValue();
    }
}
function validateRememberPayload(payload, namespace) {
    const bound = requirePersonalLifecyclePayload(payload, namespace, 'proposal.createAndApprove');
    const material = bound.command.material;
    if (material === null || material.kind !== 'proposal_approval_v1' ||
        material.proposal.namespaceRef !== memoryNamespaceRefV1(namespace) ||
        material.proposal.proposedBy.kind !== 'user')
        return invalidMemoryValue();
    requireSelfCurrentSource(material.proposal.sources[0], namespace, bound.access);
    requireSelfCurrentSource(material.consentEvidence.source, namespace, bound.access);
}
function validateRevisionPayload(payload, namespace, operation) {
    const bound = requirePersonalLifecyclePayload(payload, namespace, operation);
    const material = bound.command.material;
    if (material === null || material.kind !== 'revision_change_v1' ||
        material.evidence.evidenceKind !== 'explicit')
        return invalidMemoryValue();
    requireSelfCurrentSource(material.evidence.source, namespace, bound.access);
}
function validateListPayload(payload, namespace) {
    const operation = dataField(payload, 'operation');
    if (operation !== 'record.inspectList' ||
        dataField(payload, 'namespaceRef') !== memoryNamespaceRefV1(namespace) ||
        !actorIsPersonalSubject(dataField(payload, 'actor')))
        return invalidMemoryValue();
}
function validateExportPayload(payload, namespace) {
    const input = inspectMemoryRecord(payload, ['schemaVersion', 'command', 'access', 'actor']);
    if (input.schemaVersion !== 1 || !actorIsPersonalSubject(input.actor)) {
        return invalidMemoryValue();
    }
    const command = inspectMemoryRecord(input.command, ['wire']);
    const wire = decodeMemoryExportCommandWireV1(command.wire);
    if (wire.namespaceRef !== memoryNamespaceRefV1(namespace) ||
        capabilityField(input.actor, 'namespaceRef') !== wire.namespaceRef ||
        capabilityField(input.actor, 'generation') !== wire.expectedNamespaceGeneration ||
        capabilityField(input.actor, 'actorRef') !== wire.initiatedByActorRef) {
        return invalidMemoryValue();
    }
}
function noticesFor(operation) {
    if (operation === 'enrollment.optOut') {
        return Object.freeze([PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1]);
    }
    if (operation === 'forget' || operation === 'delete') {
        return Object.freeze([PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1]);
    }
    if (operation === 'export') {
        return Object.freeze([PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1]);
    }
    return Object.freeze([]);
}
function result(operation, delegateResult) {
    return Object.freeze({
        schemaVersion: 1,
        operation,
        result: delegateResult,
        notices: noticesFor(operation)
    });
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, [
        'enrollment', 'lifecycle', 'control', 'export'
    ]);
    for (const [port, methods] of [
        [input.enrollment, ['read', 'decide']],
        [input.lifecycle, ['execute']],
        [input.control, ['execute']],
        [input.export, ['execute']]
    ]) {
        const record = plainDataRecord(port);
        for (const method of methods) {
            if (typeof record[method] !== 'function' || utilTypes.isProxy(record[method])) {
                return invalidMemoryValue();
            }
        }
    }
    return Object.freeze({
        enrollment: input.enrollment,
        lifecycle: input.lifecycle,
        control: input.control,
        export: input.export
    });
}
export function createPersonalMemoryLifecycleFacadeV1(optionsValue) {
    const options = parseOptions(optionsValue);
    const execute = async (requestValue, signal) => {
        const signalScope = createMemoryPortSignalScopeV1(signal);
        try {
            const request = parseRequest(requestValue);
            const payload = request.payload;
            if (request.operation === 'enrollment.read') {
                return result(request.operation, await options.enrollment.read(payload, signalScope.signal));
            }
            if (request.operation === 'enrollment.optIn' ||
                request.operation === 'enrollment.optOut') {
                const command = dataField(payload, 'command');
                const wire = decodePersonalMemoryEnrollmentCommandWireV1(dataField(command, 'wire'));
                const expected = request.operation === 'enrollment.optIn'
                    ? 'enrollment.optIn'
                    : 'enrollment.optOut';
                if (wire.operation !== expected || wire.namespaceRef !==
                    memoryNamespaceRefV1(request.namespace))
                    return invalidMemoryValue();
                return result(request.operation, await options.enrollment.decide(payload, signalScope.signal));
            }
            if (request.operation === 'remember') {
                validateRememberPayload(payload, request.namespace);
                const enrollmentRead = await options.enrollment.read({
                    schemaVersion: 1,
                    namespace: request.namespace,
                    access: dataField(payload, 'access')
                }, signalScope.signal);
                if (enrollmentRead.status === 'not_enrolled') {
                    return result(request.operation, Object.freeze({ status: 'enrollment_required' }));
                }
                if (enrollmentRead.status !== 'found' || enrollmentRead.policy.state !== 'opted_in') {
                    const category = enrollmentRead.status === 'denied'
                        ? 'denied'
                        : enrollmentRead.status === 'corrupt'
                            ? 'corrupt'
                            : 'unavailable';
                    return result(request.operation, Object.freeze({
                        status: 'enrollment_unavailable',
                        category
                    }));
                }
                return result(request.operation, await options.lifecycle.execute(payload, signalScope.signal));
            }
            if (request.operation === 'list') {
                validateListPayload(payload, request.namespace);
                return result(request.operation, await options.control.execute(payload, signalScope.signal));
            }
            if (request.operation === 'correct' || request.operation === 'renew') {
                validateRevisionPayload(payload, request.namespace, request.operation === 'correct' ? 'record.correct' : 'record.renew');
                return result(request.operation, await options.lifecycle.execute(payload, signalScope.signal));
            }
            if (request.operation === 'forget' || request.operation === 'delete') {
                requirePersonalLifecyclePayload(payload, request.namespace, request.operation === 'forget' ? 'record.forget' : 'namespace.delete');
                return result(request.operation, await options.lifecycle.execute(payload, signalScope.signal));
            }
            validateExportPayload(payload, request.namespace);
            return result(request.operation, await options.export.execute(payload, signalScope.signal));
        }
        finally {
            signalScope.close();
        }
    };
    return Object.freeze({ execute });
}
