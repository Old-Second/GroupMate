import { MEMORY_CONSENT_EVIDENCE_HASH_DOMAIN_V1, MEMORY_CONSENT_TARGET_HASH_DOMAIN_V2, MEMORY_DELETION_RECEIPT_HASH_DOMAIN_V1, MEMORY_LIFECYCLE_AUDIT_HASH_DOMAIN_V1, MEMORY_RECORD_CONTENT_HASH_DOMAIN_V2, MEMORY_REVISION_EVIDENCE_HASH_DOMAIN_V1, MEMORY_REVISION_HASH_DOMAIN_V2, MEMORY_V1_TO_V2_MANIFEST_HASH_DOMAIN_V1, parseDeletionMutationReceiptV1, parseDeletionStatusV1, parseMemoryConsentEvidenceV1, parseMemoryLifecycleAuditV1, parseMemoryProposalV2, parseMemoryRecordV2, parseMemoryRevisionEvidenceV1, parseMemoryRevisionV2, parseMemoryV1ToV2AggregateManifestV1 } from './memory-lifecycle-domain.js';
import { invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_LIFECYCLE_RESOURCE_LIMITS, MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export { MEMORY_CONSENT_EVIDENCE_HASH_DOMAIN_V1, MEMORY_CONSENT_TARGET_HASH_DOMAIN_V2, MEMORY_DELETION_RECEIPT_HASH_DOMAIN_V1, MEMORY_LIFECYCLE_AUDIT_HASH_DOMAIN_V1, MEMORY_RECORD_CONTENT_HASH_DOMAIN_V2, MEMORY_REVISION_EVIDENCE_HASH_DOMAIN_V1, MEMORY_REVISION_HASH_DOMAIN_V2, MEMORY_V1_TO_V2_MANIFEST_HASH_DOMAIN_V1 };
function encodeCanonical(value, parse, maximumBytes) {
    const wire = JSON.stringify(parse(value));
    if (Buffer.byteLength(wire, 'utf8') > maximumBytes)
        return invalidMemoryValue();
    return wire;
}
function decodeCanonical(raw, parse, maximumBytes) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maximumBytes) {
        return invalidMemoryValue();
    }
    let decoded;
    try {
        decoded = JSON.parse(raw);
    }
    catch {
        return invalidMemoryValue();
    }
    const parsed = parse(decoded);
    if (JSON.stringify(parsed) !== raw)
        return invalidMemoryValue();
    return parsed;
}
export function encodeMemoryProposalV2(value) {
    return encodeCanonical(value, parseMemoryProposalV2, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function decodeMemoryProposalV2(raw) {
    return decodeCanonical(raw, parseMemoryProposalV2, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function encodeMemoryConsentEvidenceV1(value) {
    return encodeCanonical(value, parseMemoryConsentEvidenceV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes);
}
export function decodeMemoryConsentEvidenceV1(raw) {
    return decodeCanonical(raw, parseMemoryConsentEvidenceV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes);
}
export function encodeMemoryRecordV2(value) {
    return encodeCanonical(value, parseMemoryRecordV2, MEMORY_RESOURCE_LIMITS.recordWireBytes);
}
export function decodeMemoryRecordV2(raw) {
    return decodeCanonical(raw, parseMemoryRecordV2, MEMORY_RESOURCE_LIMITS.recordWireBytes);
}
export function encodeMemoryRevisionEvidenceV1(value) {
    return encodeCanonical(value, parseMemoryRevisionEvidenceV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes);
}
export function decodeMemoryRevisionEvidenceV1(raw) {
    return decodeCanonical(raw, parseMemoryRevisionEvidenceV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleEvidenceWireBytes);
}
export function encodeMemoryRevisionV2(value) {
    return encodeCanonical(value, parseMemoryRevisionV2, MEMORY_RESOURCE_LIMITS.revisionWireBytes);
}
export function decodeMemoryRevisionV2(raw) {
    return decodeCanonical(raw, parseMemoryRevisionV2, MEMORY_RESOURCE_LIMITS.revisionWireBytes);
}
export function encodeMemoryLifecycleAuditV1(value) {
    return encodeCanonical(value, parseMemoryLifecycleAuditV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes);
}
export function decodeMemoryLifecycleAuditV1(raw) {
    return decodeCanonical(raw, parseMemoryLifecycleAuditV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes);
}
export function encodeDeletionMutationReceiptV1(value) {
    return encodeCanonical(value, parseDeletionMutationReceiptV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionReceiptWireBytes);
}
export function decodeDeletionMutationReceiptV1(raw) {
    return decodeCanonical(raw, parseDeletionMutationReceiptV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionReceiptWireBytes);
}
export function encodeDeletionStatusV1(value) {
    return encodeCanonical(value, parseDeletionStatusV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionStatusWireBytes);
}
export function decodeDeletionStatusV1(raw) {
    return decodeCanonical(raw, parseDeletionStatusV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionStatusWireBytes);
}
export function encodeMemoryV1ToV2AggregateManifestV1(value) {
    return encodeCanonical(value, parseMemoryV1ToV2AggregateManifestV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes);
}
export function decodeMemoryV1ToV2AggregateManifestV1(raw) {
    return decodeCanonical(raw, parseMemoryV1ToV2AggregateManifestV1, MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleMigrationManifestWireBytes);
}
