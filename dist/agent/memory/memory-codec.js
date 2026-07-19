import { MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN, MEMORY_RECORD_CONTENT_HASH_DOMAIN, MEMORY_REVISION_HASH_DOMAIN, MEMORY_SOURCE_CONTENT_HASH_DOMAIN, MEMORY_SOURCE_ID_HASH_DOMAIN, MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN, parseMemoryOutboxEventV1, parseMemoryProposalV1, parseMemoryRecordV1, parseMemoryRevisionV1, parseMemorySourceV1, parseMemoryTombstoneV1 } from './memory-domain.js';
import { invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js';
export { MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN, MEMORY_RECORD_CONTENT_HASH_DOMAIN, MEMORY_REVISION_HASH_DOMAIN, MEMORY_SOURCE_CONTENT_HASH_DOMAIN, MEMORY_SOURCE_ID_HASH_DOMAIN, MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN };
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
export function encodeMemorySourceV1(value) {
    return encodeCanonical(value, parseMemorySourceV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function decodeMemorySourceV1(raw) {
    return decodeCanonical(raw, parseMemorySourceV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function encodeMemoryProposalV1(value) {
    return encodeCanonical(value, parseMemoryProposalV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function decodeMemoryProposalV1(raw) {
    return decodeCanonical(raw, parseMemoryProposalV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes);
}
export function encodeMemoryRecordV1(value) {
    return encodeCanonical(value, parseMemoryRecordV1, MEMORY_RESOURCE_LIMITS.recordWireBytes);
}
export function decodeMemoryRecordV1(raw) {
    return decodeCanonical(raw, parseMemoryRecordV1, MEMORY_RESOURCE_LIMITS.recordWireBytes);
}
export function encodeMemoryRevisionV1(value) {
    return encodeCanonical(value, parseMemoryRevisionV1, MEMORY_RESOURCE_LIMITS.revisionWireBytes);
}
export function decodeMemoryRevisionV1(raw) {
    return decodeCanonical(raw, parseMemoryRevisionV1, MEMORY_RESOURCE_LIMITS.revisionWireBytes);
}
export function encodeMemoryTombstoneV1(value) {
    return encodeCanonical(value, parseMemoryTombstoneV1, MEMORY_RESOURCE_LIMITS.tombstoneWireBytes);
}
export function decodeMemoryTombstoneV1(raw) {
    return decodeCanonical(raw, parseMemoryTombstoneV1, MEMORY_RESOURCE_LIMITS.tombstoneWireBytes);
}
export function encodeMemoryOutboxEventV1(value) {
    return encodeCanonical(value, parseMemoryOutboxEventV1, MEMORY_RESOURCE_LIMITS.outboxEventWireBytes);
}
export function decodeMemoryOutboxEventV1(raw) {
    return decodeCanonical(raw, parseMemoryOutboxEventV1, MEMORY_RESOURCE_LIMITS.outboxEventWireBytes);
}
