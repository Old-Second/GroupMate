import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function qqId(value) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > MEMORY_RESOURCE_LIMITS.qqIdDigits || !/^\d+$/.test(value)) {
        return invalidMemoryValue();
    }
    return value;
}
function parseEnrollment(value) {
    const input = inspectMemoryRecord(value, ['status', 'candidateMode']);
    const status = enumValue(input.status, ['opted_out', 'opted_in']);
    const candidateMode = enumValue(input.candidateMode, ['off', 'shadow', 'policy_approved']);
    if (status === 'opted_out' && candidateMode !== 'off')
        return invalidMemoryValue();
    return Object.freeze({ status, candidateMode });
}
function parseScene(value) {
    const discriminator = inspectMemoryRecord(value, ['kind'], ['groupId']);
    if (discriminator.kind === 'private') {
        if (Object.hasOwn(discriminator, 'groupId'))
            return invalidMemoryValue();
        return Object.freeze({ kind: 'private' });
    }
    if (discriminator.kind !== 'group' || !Object.hasOwn(discriminator, 'groupId')) {
        return invalidMemoryValue();
    }
    return Object.freeze({ kind: 'group', groupId: qqId(discriminator.groupId) });
}
function disabledDecision(reason) {
    return Object.freeze({
        status: 'disabled',
        reason,
        recall: false,
        explicitWrite: false,
        shadowCandidate: false,
        automaticCandidate: false
    });
}
export function decidePersonalMemoryPilotV1(optionsValue) {
    const input = inspectMemoryRecord(optionsValue, [
        'deploymentMode', 'enrollment', 'scene'
    ]);
    const deploymentMode = enumValue(input.deploymentMode, ['off', 'explicit', 'shadow', 'automatic']);
    const enrollment = parseEnrollment(input.enrollment);
    // Every private and group scene participates by default; only the subject's durable opt-out narrows it.
    parseScene(input.scene);
    if (deploymentMode === 'off')
        return disabledDecision('deployment_off');
    if (enrollment.status === 'opted_out')
        return disabledDecision('user_opted_out');
    const automaticCandidate = deploymentMode === 'automatic' &&
        enrollment.candidateMode === 'policy_approved';
    const shadowCandidate = !automaticCandidate &&
        (deploymentMode === 'shadow' || deploymentMode === 'automatic') &&
        enrollment.candidateMode !== 'off';
    return Object.freeze({
        status: 'enabled',
        reason: 'enabled',
        recall: true,
        explicitWrite: true,
        shadowCandidate,
        automaticCandidate
    });
}
