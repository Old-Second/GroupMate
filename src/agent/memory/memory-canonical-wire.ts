import {
  decodeMemoryRecordV1,
  decodeMemoryRevisionV1,
  encodeMemoryRecordV1
} from './memory-codec.js'
import {
  parseMemoryRecordV1,
  type MemoryRecordV1,
  type MemoryRevisionV1
} from './memory-domain.js'
import {
  decodeMemoryRecordV2,
  decodeMemoryRevisionV2,
  encodeMemoryRecordV2
} from './memory-lifecycle-codec.js'
import {
  parseMemoryRecordV2,
  type MemoryRecordV2,
  type MemoryRevisionV2
} from './memory-lifecycle-domain.js'
import { invalidMemoryValue } from './memory-namespace.js'

export type CanonicalMemoryRecordV1 = MemoryRecordV1 | MemoryRecordV2
export type CanonicalMemoryRevisionV1 = MemoryRevisionV1 | MemoryRevisionV2

export function parseCanonicalMemoryRecordV1 (value: unknown): CanonicalMemoryRecordV1 {
  try {
    return parseMemoryRecordV2(value)
  } catch {}
  return parseMemoryRecordV1(value)
}

export function encodeCanonicalMemoryRecordV1 (value: unknown): string {
  const record = parseCanonicalMemoryRecordV1(value)
  if (record.schemaVersion === 2) return encodeMemoryRecordV2(record)
  if (record.schemaVersion === 1) return encodeMemoryRecordV1(record)
  return invalidMemoryValue()
}

export function decodeCanonicalMemoryRecordV1 (wire: unknown): CanonicalMemoryRecordV1 {
  try {
    return decodeMemoryRecordV2(wire)
  } catch {}
  if (typeof wire !== 'string') return invalidMemoryValue()
  return decodeMemoryRecordV1(wire)
}

export function decodeCanonicalMemoryRevisionV1 (wire: unknown): CanonicalMemoryRevisionV1 {
  try {
    return decodeMemoryRevisionV2(wire)
  } catch {}
  if (typeof wire !== 'string') return invalidMemoryValue()
  return decodeMemoryRevisionV1(wire)
}
