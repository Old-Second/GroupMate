import { randomBytes } from 'node:crypto';
export const RUN_REF_PATTERN = /^[0-9a-f]{32}$/;
function createReference(random) {
    const bytes = random(16);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
        throw new TypeError('random bytes must contain exactly 16 bytes');
    }
    const reference = bytes.toString('hex');
    if (!RUN_REF_PATTERN.test(reference)) {
        throw new TypeError('random bytes did not produce a valid reference');
    }
    return reference;
}
export function createRunRef(random = randomBytes) {
    return createReference(random);
}
export function createRequestRef(random = randomBytes) {
    return createReference(random);
}
