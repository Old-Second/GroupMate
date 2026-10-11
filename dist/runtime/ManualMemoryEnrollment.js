import { createHash } from 'node:crypto';
import { personalMemoryEnrollmentCommandRefHashV1 } from '../agent/memory/personal-memory-enrollment.js';
/** Persist command intent in the existing versioned command provenance field. */
export function manualMemoryEnrollmentCommandRef(namespaceRef, namespaceGeneration, policyGeneration) {
    return `command:${createHash('sha256').update(`groupmate.memory.manual-enrollment.v1\0${namespaceRef}\0${namespaceGeneration}\0${policyGeneration}`).digest('hex')}`;
}
export function isManualMemoryEnrollmentPolicy(policy) {
    return policy.state === 'opted_in' && policy.candidateMode === 'off' &&
        policy.commandRefHash === personalMemoryEnrollmentCommandRefHashV1(manualMemoryEnrollmentCommandRef(policy.namespaceRef, policy.namespaceGeneration, policy.policyGeneration));
}
