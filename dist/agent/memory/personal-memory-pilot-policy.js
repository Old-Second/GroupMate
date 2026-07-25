import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
const MAXIMUM_CANARY_GROUPS = 128;
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
function parseGroupAllowlist(value) {
    const input = inspectMemoryArray(value, MAXIMUM_CANARY_GROUPS);
    const groups = new Set();
    for (const candidate of input) {
        const groupId = qqId(candidate);
        if (groups.has(groupId))
            return invalidMemoryValue();
        groups.add(groupId);
    }
    return groups;
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
        'deploymentMode', 'enrollment', 'scene', 'groupAllowlist'
    ]);
    const deploymentMode = enumValue(input.deploymentMode, ['off', 'explicit', 'shadow', 'automatic']);
    const enrollment = parseEnrollment(input.enrollment);
    const scene = parseScene(input.scene);
    const groupAllowlist = parseGroupAllowlist(input.groupAllowlist);
    if (deploymentMode === 'off')
        return disabledDecision('deployment_off');
    if (enrollment.status === 'opted_out')
        return disabledDecision('user_opted_out');
    if (scene.kind === 'group' && !groupAllowlist.has(scene.groupId)) {
        return disabledDecision('group_not_allowed');
    }
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
