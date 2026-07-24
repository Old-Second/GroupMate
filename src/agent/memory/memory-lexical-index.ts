import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { memoryCanonicalTextWithinLimits } from './memory-resource-limits.js'

export const MEMORY_LEXICAL_SEARCH_LIMITS_V1 = Object.freeze({
  namespaces: 4,
  hits: 24,
  queryUtf8Bytes: 4 * 1_024,
  queryCodePoints: 2_000,
  opaqueRefAsciiBytes: 128
})

export interface MemoryLexicalSearchRequestV1 {
  readonly namespaceRefs: readonly MemoryNamespaceRefV1[]
  readonly queryText: string
  readonly maxHits: number
}

export interface MemoryLexicalSearchHitV1 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly memoryRevision: number
  readonly revisionHash: string
  readonly bodyHash: string
  readonly updatedAt: string
  readonly exactMatch: boolean
  readonly lexicalRank: number
  readonly bm25: number
}

export type MemoryLexicalSearchResultV1 =
  | Readonly<{
      readonly status: 'completed'
      readonly state: 'fresh' | 'stale' | 'rebuilding'
      readonly watermark: string | null
      readonly hits: readonly MemoryLexicalSearchHitV1[]
    }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryLexicalIndexPortV1 {
  readonly search: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryLexicalSearchResultV1>
}

export interface MemoryLexicalIndexAdapterV1 {
  readonly search: (
    request: MemoryLexicalSearchRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const MEMORY_LEXICAL_BODY_HASH_DOMAIN_V1 = 'groupmate.memory.lexical-body.v1'
const STATES = Object.freeze(['fresh', 'stale', 'rebuilding'] as const)
const ABORTED = Object.freeze({ status: 'aborted' as const })
const UNAVAILABLE = Object.freeze({ status: 'unavailable' as const })

function positiveInteger (value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function fixedAscii (value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MEMORY_LEXICAL_SEARCH_LIMITS_V1.opaqueRefAsciiBytes ||
    !/^[\x20-\x7e]+$/.test(value) || (pattern !== undefined && !pattern.test(value))) {
    return invalidMemoryValue()
  }
  return value
}

export function memoryLexicalBodyHashV1 (value: string): string {
  if (typeof value !== 'string' || value.length === 0) return invalidMemoryValue()
  return createHash('sha256')
    .update(MEMORY_LEXICAL_BODY_HASH_DOMAIN_V1, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
}

export function parseMemoryLexicalSearchRequestV1 (
  value: unknown
): MemoryLexicalSearchRequestV1 {
  const input = inspectMemoryRecord(value, ['namespaceRefs', 'queryText', 'maxHits'])
  const namespaceRefs = inspectMemoryArray(
    input.namespaceRefs,
    MEMORY_LEXICAL_SEARCH_LIMITS_V1.namespaces
  ).map(parseMemoryNamespaceRefV1)
  if (namespaceRefs.length === 0 || new Set(namespaceRefs).size !== namespaceRefs.length ||
    !memoryCanonicalTextWithinLimits(
      input.queryText,
      MEMORY_LEXICAL_SEARCH_LIMITS_V1.queryUtf8Bytes,
      MEMORY_LEXICAL_SEARCH_LIMITS_V1.queryCodePoints
    ) || input.queryText.length === 0) return invalidMemoryValue()
  return Object.freeze({
    namespaceRefs: Object.freeze(namespaceRefs),
    queryText: input.queryText,
    maxHits: positiveInteger(input.maxHits, MEMORY_LEXICAL_SEARCH_LIMITS_V1.hits)
  })
}

function parseHit (value: unknown, maximumRank: number): MemoryLexicalSearchHitV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision',
    'revisionHash', 'bodyHash', 'updatedAt', 'exactMatch', 'lexicalRank', 'bm25'
  ])
  if (typeof input.exactMatch !== 'boolean' || typeof input.bm25 !== 'number' ||
    !Number.isFinite(input.bm25) || Object.is(input.bm25, -0)) return invalidMemoryValue()
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration, Number.MAX_SAFE_INTEGER),
    memoryId: fixedAscii(input.memoryId, MEMORY_ID),
    memoryRevision: positiveInteger(input.memoryRevision, Number.MAX_SAFE_INTEGER),
    revisionHash: fixedAscii(input.revisionHash, HASH),
    bodyHash: fixedAscii(input.bodyHash, HASH),
    updatedAt: canonicalInstant(input.updatedAt),
    exactMatch: input.exactMatch,
    lexicalRank: positiveInteger(input.lexicalRank, maximumRank),
    bm25: input.bm25
  })
}

export function parseMemoryLexicalSearchResultV1 (
  value: unknown,
  request: MemoryLexicalSearchRequestV1
): MemoryLexicalSearchResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['state', 'watermark', 'hits']
  )
  if (discriminator.status === 'unavailable') {
    inspectMemoryRecord(value, ['status'])
    return UNAVAILABLE
  }
  if (discriminator.status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    return ABORTED
  }
  if (discriminator.status !== 'completed') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, ['status', 'state', 'watermark', 'hits'])
  if (typeof input.state !== 'string' || !STATES.includes(input.state as never)) {
    return invalidMemoryValue()
  }
  const hits = inspectMemoryArray(input.hits, request.maxHits)
    .map(hit => parseHit(hit, request.maxHits))
  const namespaces = new Set(request.namespaceRefs)
  if (hits.some(hit => !namespaces.has(hit.namespaceRef)) ||
    new Set(hits.map(hit => `${hit.namespaceRef}\0${hit.memoryId}`)).size !== hits.length ||
    new Set(hits.map(hit => hit.lexicalRank)).size !== hits.length ||
    hits.some((_, index) => !hits.some(hit => hit.lexicalRank === index + 1))) {
    return invalidMemoryValue()
  }
  const watermark = input.watermark === null ? null : fixedAscii(input.watermark)
  return Object.freeze({
    status: 'completed' as const,
    state: input.state as typeof STATES[number],
    watermark,
    hits: Object.freeze(hits)
  })
}

function adapterSearch (value: unknown): MemoryLexicalIndexAdapterV1['search'] {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return invalidMemoryValue()
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'search')
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
    return invalidMemoryValue()
  }
  return descriptor.value as MemoryLexicalIndexAdapterV1['search']
}

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

export function createMemoryLexicalIndexPortV1 (
  adapter: MemoryLexicalIndexAdapterV1
): MemoryLexicalIndexPortV1 {
  const searchAdapter = adapterSearch(adapter)
  const search = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<MemoryLexicalSearchResultV1> => {
    if (isAborted(signal)) return ABORTED
    const request = parseMemoryLexicalSearchRequestV1(requestValue)
    let raw: unknown
    try {
      raw = await Reflect.apply(searchAdapter, adapter, [request, signal])
    } catch {
      return isAborted(signal) ? ABORTED : UNAVAILABLE
    }
    if (isAborted(signal)) return ABORTED
    try {
      return parseMemoryLexicalSearchResultV1(raw, request)
    } catch {
      return UNAVAILABLE
    }
  }
  return Object.freeze({ search })
}
