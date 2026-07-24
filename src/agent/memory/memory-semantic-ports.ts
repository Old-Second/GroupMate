import { types as utilTypes } from 'node:util'
import type { MemoryCanonicalIdentityV1 } from './memory-canonical-rehydrator.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { memoryCanonicalTextWithinLimits } from './memory-resource-limits.js'

export const MEMORY_SEMANTIC_RESOURCE_LIMITS_V1 = Object.freeze({
  inputs: 32,
  dimensions: 4_096,
  vectorHits: 24,
  rerankCandidates: 12,
  queryUtf8Bytes: 4 * 1_024,
  queryCodePoints: 2_000,
  textUtf8Bytes: 4 * 1_024,
  textCodePoints: 2_000,
  modelVersionAsciiBytes: 128,
  opaqueRefAsciiBytes: 128
})

export interface MemoryEmbeddingRequestV1 {
  readonly purpose: 'query' | 'document'
  readonly modelVersion: string
  readonly dimensions: number
  readonly texts: readonly string[]
}

export type MemoryEmbeddingResultV1 =
  | Readonly<{
      readonly status: 'completed'
      readonly modelVersion: string
      readonly dimensions: number
      readonly vectors: readonly (readonly number[])[]
    }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryEmbedderAdapterV1 {
  readonly embed: (
    request: MemoryEmbeddingRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface MemoryEmbedderPortV1 {
  readonly embed: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryEmbeddingResultV1>
}

export interface MemoryVectorSearchRequestV1 {
  readonly namespaceRefs: readonly MemoryNamespaceRefV1[]
  readonly modelVersion: string
  readonly dimensions: number
  readonly queryVector: readonly number[]
  readonly maxHits: number
}

export interface MemoryVectorSearchHitV1 extends MemoryCanonicalIdentityV1 {
  readonly vectorRank: number
  readonly distance: number
}

export type MemoryVectorSearchResultV1 =
  | Readonly<{
      readonly status: 'completed'
      readonly state: 'fresh' | 'stale' | 'rebuilding'
      readonly modelVersion: string
      readonly dimensions: number
      readonly watermark: string | null
      readonly hits: readonly MemoryVectorSearchHitV1[]
    }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryVectorIndexAdapterV1 {
  readonly search: (
    request: MemoryVectorSearchRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface MemoryVectorIndexPortV1 {
  readonly search: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryVectorSearchResultV1>
}

export interface MemoryRerankRequestV1 {
  readonly modelVersion: string
  readonly queryText: string
  readonly candidates: readonly Readonly<{
    readonly candidateId: string
    readonly text: string
  }>[]
}

export type MemoryRerankResultV1 =
  | Readonly<{
      readonly status: 'completed'
      readonly modelVersion: string
      readonly rankedCandidateIds: readonly string[]
    }>
  | Readonly<{ readonly status: 'unavailable' }>
  | Readonly<{ readonly status: 'aborted' }>

export interface MemoryRerankerAdapterV1 {
  readonly rerank: (
    request: MemoryRerankRequestV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface MemoryRerankerPortV1 {
  readonly rerank: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryRerankResultV1>
}

const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/
const VECTOR_STATES = Object.freeze(['fresh', 'stale', 'rebuilding'] as const)
const UNAVAILABLE = Object.freeze({ status: 'unavailable' as const })
const ABORTED = Object.freeze({ status: 'aborted' as const })

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function positiveInteger (value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function fixedAscii (value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.opaqueRefAsciiBytes ||
    !/^[\x20-\x7e]+$/.test(value) || (pattern !== undefined && !pattern.test(value))) {
    return invalidMemoryValue()
  }
  return value
}

function modelVersion (value: unknown): string {
  const parsed = fixedAscii(value, MODEL_VERSION)
  if (Buffer.byteLength(parsed, 'ascii') >
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.modelVersionAsciiBytes) return invalidMemoryValue()
  return parsed
}

function canonicalText (
  value: unknown,
  maximumUtf8Bytes: number,
  maximumCodePoints: number
): string {
  if (!memoryCanonicalTextWithinLimits(value, maximumUtf8Bytes, maximumCodePoints) ||
    value.length === 0) return invalidMemoryValue()
  return value
}

function finiteVector (value: unknown, dimensions: number): readonly number[] {
  const input = inspectMemoryArray(value, dimensions)
  if (input.length !== dimensions) return invalidMemoryValue()
  const vector = input.map(component => {
    if (typeof component !== 'number' || !Number.isFinite(component) ||
      Object.is(component, -0) || Math.abs(component) > 1_000_000) {
      return invalidMemoryValue()
    }
    return component
  })
  return Object.freeze(vector)
}

function dataFunction<T extends (...args: never[]) => unknown> (
  value: unknown,
  name: string
): T {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return invalidMemoryValue()
  }
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
        utilTypes.isProxy(descriptor.value)) return invalidMemoryValue()
      return descriptor.value as T
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return invalidMemoryValue()
}

function parseEmbeddingRequest (value: unknown): MemoryEmbeddingRequestV1 {
  const input = inspectMemoryRecord(value, ['purpose', 'modelVersion', 'dimensions', 'texts'])
  if (input.purpose !== 'query' && input.purpose !== 'document') return invalidMemoryValue()
  const texts = inspectMemoryArray(
    input.texts,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.inputs
  ).map(text => canonicalText(
    text,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textUtf8Bytes,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textCodePoints
  ))
  if (texts.length === 0) return invalidMemoryValue()
  return Object.freeze({
    purpose: input.purpose,
    modelVersion: modelVersion(input.modelVersion),
    dimensions: positiveInteger(
      input.dimensions,
      MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions
    ),
    texts: Object.freeze(texts)
  })
}

function parseEmbeddingResult (
  value: unknown,
  request: MemoryEmbeddingRequestV1
): MemoryEmbeddingResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['modelVersion', 'dimensions', 'vectors']
  )
  if (discriminator.status === 'unavailable') {
    inspectMemoryRecord(value, ['status'])
    return UNAVAILABLE
  }
  if (discriminator.status !== 'completed') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, [
    'status', 'modelVersion', 'dimensions', 'vectors'
  ])
  const parsedModelVersion = modelVersion(input.modelVersion)
  const dimensions = positiveInteger(
    input.dimensions,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions
  )
  if (parsedModelVersion !== request.modelVersion || dimensions !== request.dimensions) {
    return invalidMemoryValue()
  }
  const vectors = inspectMemoryArray(input.vectors, request.texts.length)
    .map(vector => finiteVector(vector, dimensions))
  if (vectors.length !== request.texts.length) return invalidMemoryValue()
  return Object.freeze({
    status: 'completed' as const,
    modelVersion: parsedModelVersion,
    dimensions,
    vectors: Object.freeze(vectors)
  })
}

function parseVectorSearchRequest (value: unknown): MemoryVectorSearchRequestV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRefs', 'modelVersion', 'dimensions', 'queryVector', 'maxHits'
  ])
  const namespaceRefs = inspectMemoryArray(input.namespaceRefs, 4)
    .map(parseMemoryNamespaceRefV1)
  if (namespaceRefs.length === 0 || new Set(namespaceRefs).size !== namespaceRefs.length) {
    return invalidMemoryValue()
  }
  const dimensions = positiveInteger(
    input.dimensions,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions
  )
  return Object.freeze({
    namespaceRefs: Object.freeze(namespaceRefs),
    modelVersion: modelVersion(input.modelVersion),
    dimensions,
    queryVector: finiteVector(input.queryVector, dimensions),
    maxHits: positiveInteger(
      input.maxHits,
      MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.vectorHits
    )
  })
}

function parseVectorHit (value: unknown, maximumRank: number): MemoryVectorSearchHitV1 {
  const input = inspectMemoryRecord(value, [
    'namespaceRef', 'namespaceGeneration', 'memoryId', 'memoryRevision',
    'revisionHash', 'vectorRank', 'distance'
  ])
  if (typeof input.distance !== 'number' || !Number.isFinite(input.distance) ||
    input.distance < 0 || Object.is(input.distance, -0)) return invalidMemoryValue()
  return Object.freeze({
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration, Number.MAX_SAFE_INTEGER),
    memoryId: fixedAscii(input.memoryId, MEMORY_ID),
    memoryRevision: positiveInteger(input.memoryRevision, Number.MAX_SAFE_INTEGER),
    revisionHash: fixedAscii(input.revisionHash, HASH),
    vectorRank: positiveInteger(input.vectorRank, maximumRank),
    distance: input.distance
  })
}

function parseVectorSearchResult (
  value: unknown,
  request: MemoryVectorSearchRequestV1
): MemoryVectorSearchResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['state', 'modelVersion', 'dimensions', 'watermark', 'hits']
  )
  if (discriminator.status === 'unavailable') {
    inspectMemoryRecord(value, ['status'])
    return UNAVAILABLE
  }
  if (discriminator.status !== 'completed') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, [
    'status', 'state', 'modelVersion', 'dimensions', 'watermark', 'hits'
  ])
  if (typeof input.state !== 'string' || !VECTOR_STATES.includes(input.state as never)) {
    return invalidMemoryValue()
  }
  const parsedModelVersion = modelVersion(input.modelVersion)
  const dimensions = positiveInteger(
    input.dimensions,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.dimensions
  )
  if (parsedModelVersion !== request.modelVersion || dimensions !== request.dimensions) {
    return invalidMemoryValue()
  }
  const hits = inspectMemoryArray(input.hits, request.maxHits)
    .map(hit => parseVectorHit(hit, request.maxHits))
  const namespaces = new Set(request.namespaceRefs)
  if (hits.some(hit => !namespaces.has(hit.namespaceRef)) ||
    new Set(hits.map(hit => `${hit.namespaceRef}\0${hit.memoryId}`)).size !== hits.length ||
    new Set(hits.map(hit => hit.vectorRank)).size !== hits.length ||
    hits.some((_, index) => !hits.some(hit => hit.vectorRank === index + 1))) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    status: 'completed' as const,
    state: input.state as typeof VECTOR_STATES[number],
    modelVersion: parsedModelVersion,
    dimensions,
    watermark: input.watermark === null ? null : fixedAscii(input.watermark),
    hits: Object.freeze(hits)
  })
}

function parseRerankRequest (value: unknown): MemoryRerankRequestV1 {
  const input = inspectMemoryRecord(value, ['modelVersion', 'queryText', 'candidates'])
  const candidates = inspectMemoryArray(
    input.candidates,
    MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.rerankCandidates
  ).map(value => {
    const candidate = inspectMemoryRecord(value, ['candidateId', 'text'])
    return Object.freeze({
      candidateId: fixedAscii(candidate.candidateId, MEMORY_ID),
      text: canonicalText(
        candidate.text,
        MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textUtf8Bytes,
        MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.textCodePoints
      )
    })
  })
  if (candidates.length === 0 ||
    new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    modelVersion: modelVersion(input.modelVersion),
    queryText: canonicalText(
      input.queryText,
      MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.queryUtf8Bytes,
      MEMORY_SEMANTIC_RESOURCE_LIMITS_V1.queryCodePoints
    ),
    candidates: Object.freeze(candidates)
  })
}

function parseRerankResult (
  value: unknown,
  request: MemoryRerankRequestV1
): MemoryRerankResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['modelVersion', 'rankedCandidateIds']
  )
  if (discriminator.status === 'unavailable') {
    inspectMemoryRecord(value, ['status'])
    return UNAVAILABLE
  }
  if (discriminator.status !== 'completed') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, ['status', 'modelVersion', 'rankedCandidateIds'])
  const parsedModelVersion = modelVersion(input.modelVersion)
  if (parsedModelVersion !== request.modelVersion) return invalidMemoryValue()
  const rankedCandidateIds = inspectMemoryArray(
    input.rankedCandidateIds,
    request.candidates.length
  ).map(candidateId => fixedAscii(candidateId, MEMORY_ID))
  const expected = new Set(request.candidates.map(candidate => candidate.candidateId))
  if (rankedCandidateIds.length !== expected.size ||
    new Set(rankedCandidateIds).size !== rankedCandidateIds.length ||
    rankedCandidateIds.some(candidateId => !expected.has(candidateId))) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    status: 'completed' as const,
    modelVersion: parsedModelVersion,
    rankedCandidateIds: Object.freeze(rankedCandidateIds)
  })
}

function createPort<Request, Result> (
  adapter: unknown,
  methodName: 'embed' | 'search' | 'rerank',
  parseRequest: (value: unknown) => Request,
  parseResult: (value: unknown, request: Request) => Result
): Readonly<Record<typeof methodName, (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<Result | typeof ABORTED | typeof UNAVAILABLE>>> {
  const adapterMethod = dataFunction<(request: Request, signal?: AbortSignal) => Promise<unknown>>(
    adapter,
    methodName
  )
  const method = async (requestValue: unknown, signal?: AbortSignal) => {
    if (isAborted(signal)) return ABORTED
    let request: Request
    try {
      request = parseRequest(requestValue)
    } catch {
      return UNAVAILABLE
    }
    let raw: unknown
    try {
      raw = await Reflect.apply(adapterMethod, adapter, [request, signal])
    } catch {
      return isAborted(signal) ? ABORTED : UNAVAILABLE
    }
    if (isAborted(signal)) return ABORTED
    try {
      return parseResult(raw, request)
    } catch {
      return UNAVAILABLE
    }
  }
  return Object.freeze({ [methodName]: method }) as Readonly<Record<
  typeof methodName,
  typeof method
  >>
}

export function createMemoryEmbedderPortV1 (
  adapter: MemoryEmbedderAdapterV1
): MemoryEmbedderPortV1 {
  return createPort(
    adapter,
    'embed',
    parseEmbeddingRequest,
    parseEmbeddingResult
  ) as MemoryEmbedderPortV1
}

export function createMemoryVectorIndexPortV1 (
  adapter: MemoryVectorIndexAdapterV1
): MemoryVectorIndexPortV1 {
  return createPort(
    adapter,
    'search',
    parseVectorSearchRequest,
    parseVectorSearchResult
  ) as MemoryVectorIndexPortV1
}

export function createMemoryRerankerPortV1 (
  adapter: MemoryRerankerAdapterV1
): MemoryRerankerPortV1 {
  return createPort(
    adapter,
    'rerank',
    parseRerankRequest,
    parseRerankResult
  ) as MemoryRerankerPortV1
}
