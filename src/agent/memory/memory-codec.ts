import {
  MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN,
  MEMORY_RECORD_CONTENT_HASH_DOMAIN,
  MEMORY_REVISION_HASH_DOMAIN,
  MEMORY_SOURCE_CONTENT_HASH_DOMAIN,
  MEMORY_SOURCE_ID_HASH_DOMAIN,
  MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN,
  parseMemoryOutboxEventV1,
  parseMemoryProposalV1,
  parseMemoryRecordV1,
  parseMemoryRevisionV1,
  parseMemorySourceV1,
  parseMemoryTombstoneV1,
  type MemoryOutboxEventV1,
  type MemoryProposalV1,
  type MemoryRecordV1,
  type MemoryRevisionV1,
  type MemorySourceV1,
  type MemoryTombstoneV1
} from './memory-domain.js'
import { invalidMemoryValue } from './memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js'

export {
  MEMORY_OUTBOX_PAYLOAD_HASH_DOMAIN,
  MEMORY_RECORD_CONTENT_HASH_DOMAIN,
  MEMORY_REVISION_HASH_DOMAIN,
  MEMORY_SOURCE_CONTENT_HASH_DOMAIN,
  MEMORY_SOURCE_ID_HASH_DOMAIN,
  MEMORY_TOMBSTONE_RECEIPT_HASH_DOMAIN
}

function encodeCanonical<T> (
  value: unknown,
  parse: (value: unknown) => T,
  maximumBytes: number
): string {
  const wire = JSON.stringify(parse(value))
  if (Buffer.byteLength(wire, 'utf8') > maximumBytes) return invalidMemoryValue()
  return wire
}

function decodeCanonical<T> (
  raw: unknown,
  parse: (value: unknown) => T,
  maximumBytes: number
): T {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maximumBytes) {
    return invalidMemoryValue()
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch {
    return invalidMemoryValue()
  }
  const parsed = parse(decoded)
  if (JSON.stringify(parsed) !== raw) return invalidMemoryValue()
  return parsed
}

export function encodeMemorySourceV1 (value: MemorySourceV1): string {
  return encodeCanonical(
    value,
    parseMemorySourceV1,
    MEMORY_RESOURCE_LIMITS.proposalWireBytes
  )
}

export function decodeMemorySourceV1 (raw: string): MemorySourceV1 {
  return decodeCanonical(raw, parseMemorySourceV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes)
}

export function encodeMemoryProposalV1 (value: MemoryProposalV1): string {
  return encodeCanonical(
    value,
    parseMemoryProposalV1,
    MEMORY_RESOURCE_LIMITS.proposalWireBytes
  )
}

export function decodeMemoryProposalV1 (raw: string): MemoryProposalV1 {
  return decodeCanonical(raw, parseMemoryProposalV1, MEMORY_RESOURCE_LIMITS.proposalWireBytes)
}

export function encodeMemoryRecordV1 (value: MemoryRecordV1): string {
  return encodeCanonical(value, parseMemoryRecordV1, MEMORY_RESOURCE_LIMITS.recordWireBytes)
}

export function decodeMemoryRecordV1 (raw: string): MemoryRecordV1 {
  return decodeCanonical(raw, parseMemoryRecordV1, MEMORY_RESOURCE_LIMITS.recordWireBytes)
}

export function encodeMemoryRevisionV1 (value: MemoryRevisionV1): string {
  return encodeCanonical(
    value,
    parseMemoryRevisionV1,
    MEMORY_RESOURCE_LIMITS.revisionWireBytes
  )
}

export function decodeMemoryRevisionV1 (raw: string): MemoryRevisionV1 {
  return decodeCanonical(raw, parseMemoryRevisionV1, MEMORY_RESOURCE_LIMITS.revisionWireBytes)
}

export function encodeMemoryTombstoneV1 (value: MemoryTombstoneV1): string {
  return encodeCanonical(
    value,
    parseMemoryTombstoneV1,
    MEMORY_RESOURCE_LIMITS.tombstoneWireBytes
  )
}

export function decodeMemoryTombstoneV1 (raw: string): MemoryTombstoneV1 {
  return decodeCanonical(raw, parseMemoryTombstoneV1, MEMORY_RESOURCE_LIMITS.tombstoneWireBytes)
}

export function encodeMemoryOutboxEventV1 (value: MemoryOutboxEventV1): string {
  return encodeCanonical(
    value,
    parseMemoryOutboxEventV1,
    MEMORY_RESOURCE_LIMITS.outboxEventWireBytes
  )
}

export function decodeMemoryOutboxEventV1 (raw: string): MemoryOutboxEventV1 {
  return decodeCanonical(
    raw,
    parseMemoryOutboxEventV1,
    MEMORY_RESOURCE_LIMITS.outboxEventWireBytes
  )
}
