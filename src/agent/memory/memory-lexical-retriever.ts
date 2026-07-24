import { types as utilTypes } from 'node:util'
import type { CanonicalMemoryRecordV1 } from './memory-canonical-wire.js'
import type {
  MemoryCanonicalRehydrateResultV1,
  MemoryCanonicalRehydratorV1
} from './memory-canonical-rehydrator.js'
import type {
  MemoryLexicalIndexPortV1,
  MemoryLexicalSearchHitV1
} from './memory-lexical-index.js'
import { memoryLexicalBodyHashV1 } from './memory-lexical-index.js'
import {
  normalizeMemoryLexicalTextV1,
  type MemoryLexicalTransliteratorV1
} from './memory-lexical-normalizer.js'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import type {
  MemoryRetrievalAdapterV2,
  MemoryRetrievalCandidateV2,
  MemoryRetrievalRequestV2,
  MemoryRetrievalResultV2,
  MemoryRetrievalSourceV1
} from './memory-retrieval.js'
import { MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2 } from './memory-retrieval.js'

interface CreateLexicalMemoryRetrieverOptionsV1 {
  readonly index: MemoryLexicalIndexPortV1
  readonly canonical: MemoryCanonicalRehydratorV1
  readonly now: () => string
  readonly transliterator?: MemoryLexicalTransliteratorV1
}

interface RankedRecordV1 {
  readonly record: CanonicalMemoryRecordV1
  readonly revisionHash: string
  readonly hit: MemoryLexicalSearchHitV1
  readonly sources: readonly MemoryRetrievalSourceV1[]
  readonly baseScore: number
}

const DAY_MS = 86_400_000
const SOURCE_WEIGHT = Object.freeze({
  manual_correction: 1.5,
  manual_user_input: 1.25,
  current_message: 1,
  quoted_message: 0.9,
  private_history: 0.75,
  group_history: 0.5
} as const)

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

function parseOptions (
  value: CreateLexicalMemoryRetrieverOptionsV1
): CreateLexicalMemoryRetrieverOptionsV1 {
  const input = inspectMemoryRecord(value, ['index', 'canonical', 'now'], ['transliterator'])
  if (typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
    return invalidMemoryValue()
  }
  dataFunction<MemoryLexicalIndexPortV1['search']>(input.index, 'search')
  dataFunction<MemoryCanonicalRehydratorV1['rehydrate']>(input.canonical, 'rehydrate')
  if (input.transliterator !== undefined) {
    dataFunction<MemoryLexicalTransliteratorV1['aliases']>(
      input.transliterator,
      'aliases'
    )
  }
  return Object.freeze({
    index: input.index as MemoryLexicalIndexPortV1,
    canonical: input.canonical as MemoryCanonicalRehydratorV1,
    now: input.now as () => string,
    ...(input.transliterator === undefined
      ? {}
      : { transliterator: input.transliterator as MemoryLexicalTransliteratorV1 })
  })
}

function canonicalInstant (value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return null
  }
  return value
}

function unavailable (
  reason: 'index_unavailable' | 'canonical_unavailable' | 'policy_unavailable'
): MemoryRetrievalResultV2 {
  return Object.freeze({ schemaVersion: 2 as const, status: 'unavailable' as const, reason })
}

function denied (): MemoryRetrievalResultV2 {
  return Object.freeze({
    schemaVersion: 2 as const,
    status: 'denied' as const,
    reason: 'namespace_denied' as const
  })
}

function abortError (): DOMException {
  return new DOMException('operation was aborted', 'AbortError')
}

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function sourceProjection (record: CanonicalMemoryRecordV1): readonly MemoryRetrievalSourceV1[] {
  if (record.namespace.scope.kind !== 'personal') return Object.freeze([])
  const subjectUserId = record.namespace.scope.subjectUserId
  const sources = record.sources
    .filter(source => source.actor.userId === subjectUserId)
    .slice(0, 8)
    .map(source => Object.freeze({
      schemaVersion: 1 as const,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      messageId: source.messageId,
      actor: Object.freeze({
        userId: source.actor.userId,
        displayName: source.actor.displayName
      }),
      scene: source.scene.kind === 'private'
        ? Object.freeze({ kind: 'private' as const })
        : Object.freeze({
            kind: 'group' as const,
            groupId: source.scene.groupId,
            groupLifecycleId: source.scene.groupLifecycleId,
            groupName: source.scene.groupName
          }),
      observedAt: source.observedAt
    }))
  return Object.freeze(sources)
}

function sourceScore (sources: readonly MemoryRetrievalSourceV1[]): number {
  return sources.reduce((maximum, source) => (
    Math.max(maximum, SOURCE_WEIGHT[source.sourceKind])
  ), 0)
}

function scoreRecord (
  record: CanonicalMemoryRecordV1,
  hit: MemoryLexicalSearchHitV1,
  sources: readonly MemoryRetrievalSourceV1[],
  nowMs: number
): number {
  const ageDays = Math.max(0, nowMs - Date.parse(record.updatedAt)) / DAY_MS
  const recency = 1 / (1 + ageDays / 180)
  const lexical = 4 / hit.lexicalRank
  const exact = hit.exactMatch ? 8 : 0
  const confidence = record.confidence * 2
  const conflict = record.conflict.state === 'none' ? 1 : 0.1
  const validity = record.validity.state === 'current' ? 0.5 : 0
  return exact + lexical + recency + confidence + sourceScore(sources) + conflict + validity
}

function validRecord (
  result: MemoryCanonicalRehydrateResultV1,
  hit: MemoryLexicalSearchHitV1,
  requestedNamespaces: ReadonlySet<string>,
  nowMs: number,
  expectedBody: string,
  expectedExactMatch: boolean
): RankedRecordV1 | null {
  if (result.status !== 'found') return null
  const record = result.record
  if (!requestedNamespaces.has(record.namespaceRef) ||
    record.namespace.scope.kind !== 'personal' ||
    record.namespaceRef !== hit.namespaceRef ||
    record.namespaceGeneration !== hit.namespaceGeneration ||
    record.memoryId !== hit.memoryId || record.revision !== hit.memoryRevision ||
    result.revisionHash !== hit.revisionHash ||
    record.updatedAt !== hit.updatedAt ||
    memoryLexicalBodyHashV1(expectedBody) !== hit.bodyHash ||
    hit.exactMatch !== expectedExactMatch ||
    record.deletionState !== 'active' || record.validity.state === 'superseded' ||
    record.conflict.state === 'confirmed' || Date.parse(record.retention.validUntil) <= nowMs) {
    return null
  }
  const sources = sourceProjection(record)
  if (sources.length === 0) return null
  return Object.freeze({
    record,
    revisionHash: result.revisionHash,
    hit,
    sources,
    baseScore: scoreRecord(record, hit, sources, nowMs)
  })
}

function diversityOrder (values: readonly RankedRecordV1[]): readonly RankedRecordV1[] {
  const remaining = [...values]
  const selected: RankedRecordV1[] = []
  const kindCounts = new Map<string, number>()
  const namespaceCounts = new Map<string, number>()
  while (remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftScore = left.baseScore - (kindCounts.get(left.record.kind) ?? 0) * 0.35 -
        (namespaceCounts.get(left.record.namespaceRef) ?? 0) * 0.1
      const rightScore = right.baseScore - (kindCounts.get(right.record.kind) ?? 0) * 0.35 -
        (namespaceCounts.get(right.record.namespaceRef) ?? 0) * 0.1
      return rightScore - leftScore ||
        Number(right.hit.exactMatch) - Number(left.hit.exactMatch) ||
        left.hit.lexicalRank - right.hit.lexicalRank ||
        (left.record.updatedAt < right.record.updatedAt ? 1 :
            left.record.updatedAt > right.record.updatedAt ? -1 :
              left.record.memoryId < right.record.memoryId ? -1 : 1)
    })
    const next = remaining.shift()
    if (next === undefined) break
    selected.push(next)
    kindCounts.set(next.record.kind, (kindCounts.get(next.record.kind) ?? 0) + 1)
    namespaceCounts.set(
      next.record.namespaceRef,
      (namespaceCounts.get(next.record.namespaceRef) ?? 0) + 1
    )
  }
  return Object.freeze(selected)
}

function estimatedTokens (text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3))
}

function candidateFor (
  value: RankedRecordV1,
  fusedRank: number
): MemoryRetrievalCandidateV2 {
  const record = value.record
  return Object.freeze({
    schemaVersion: 2 as const,
    memoryId: record.memoryId,
    revision: record.revision,
    revisionHash: value.revisionHash,
    namespaceRef: record.namespaceRef,
    kind: record.kind,
    text: record.text,
    createdAt: record.createdAt,
    observedAt: record.observedAt,
    updatedAt: record.updatedAt,
    validUntil: record.retention.validUntil,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    conflict: record.conflict.state,
    consent: record.consent.state,
    estimatedTokens: estimatedTokens(record.text),
    sources: value.sources,
    ranking: Object.freeze({
      exactMatch: value.hit.exactMatch,
      lexicalRank: value.hit.lexicalRank,
      vectorRank: null,
      rerankRank: null,
      fusedRank
    })
  })
}

function budgetedCandidates (
  ranked: readonly RankedRecordV1[],
  request: MemoryRetrievalRequestV2
): readonly MemoryRetrievalCandidateV2[] {
  const result: MemoryRetrievalCandidateV2[] = []
  let tokens = 0
  let bytes = 0
  for (const value of ranked) {
    if (result.length >= request.limits.maxCandidates) break
    const candidate = candidateFor(value, result.length + 1)
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (tokens + candidate.estimatedTokens > request.limits.maxTokens ||
      bytes + candidateBytes > request.limits.maxBytes) continue
    tokens += candidate.estimatedTokens
    bytes += candidateBytes
    result.push(candidate)
  }
  return Object.freeze(result)
}

export function createLexicalMemoryRetrieverV2 (
  optionsValue: CreateLexicalMemoryRetrieverOptionsV1
): MemoryRetrievalAdapterV2 {
  const options = parseOptions(optionsValue)
  const search = dataFunction<MemoryLexicalIndexPortV1['search']>(options.index, 'search')
  const rehydrate = dataFunction<MemoryCanonicalRehydratorV1['rehydrate']>(
    options.canonical,
    'rehydrate'
  )

  const retrieve = async (
    request: MemoryRetrievalRequestV2,
    signal?: AbortSignal
  ): Promise<MemoryRetrievalResultV2> => {
    if (isAborted(signal)) throw abortError()
    let now: string | null
    try {
      now = canonicalInstant(Reflect.apply(options.now, undefined, []))
    } catch {
      now = null
    }
    if (now === null) return unavailable('policy_unavailable')
    let indexResult: Awaited<ReturnType<MemoryLexicalIndexPortV1['search']>>
    try {
      indexResult = await Reflect.apply(search, options.index, [{
        namespaceRefs: request.subjects.map(subject => subject.namespaceRef),
        queryText: request.query.text,
        maxHits: Math.min(
          MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxLexicalHits,
          request.limits.maxCandidates * 2
        )
      }, signal])
    } catch {
      if (isAborted(signal)) throw abortError()
      return unavailable('index_unavailable')
    }
    if (indexResult.status === 'aborted') throw abortError()
    if (indexResult.status === 'unavailable') return unavailable('index_unavailable')

    let normalizedQuery: ReturnType<typeof normalizeMemoryLexicalTextV1>
    try {
      normalizedQuery = normalizeMemoryLexicalTextV1(request.query.text, {
        ...(options.transliterator === undefined
          ? {}
          : { transliterator: options.transliterator })
      })
    } catch {
      return Object.freeze({
        schemaVersion: 2 as const,
        status: 'completed' as const,
        mode: 'lexical' as const,
        candidates: Object.freeze([]),
        index: Object.freeze({
          lexical: indexResult.state,
          vector: 'disabled' as const,
          watermark: indexResult.watermark
        })
      })
    }

    const requestedNamespaces = new Set(
      request.subjects.map(subject => subject.namespaceRef as string)
    )
    const records = new Map<string, RankedRecordV1>()
    for (const hit of indexResult.hits) {
      if (isAborted(signal)) throw abortError()
      let result: Awaited<ReturnType<MemoryCanonicalRehydratorV1['rehydrate']>>
      try {
        result = await Reflect.apply(rehydrate, options.canonical, [{
          capability: request.capability,
          identity: {
            namespaceRef: hit.namespaceRef,
            namespaceGeneration: hit.namespaceGeneration,
            memoryId: hit.memoryId,
            memoryRevision: hit.memoryRevision,
            revisionHash: hit.revisionHash
          }
        }, signal])
      } catch {
        if (isAborted(signal)) throw abortError()
        return unavailable('canonical_unavailable')
      }
      if (result.status === 'aborted') throw abortError()
      if (result.status === 'unavailable') return unavailable('canonical_unavailable')
      if (result.status === 'denied') return denied()
      if (result.status !== 'found') continue
      let normalizedRecord: ReturnType<typeof normalizeMemoryLexicalTextV1>
      try {
        normalizedRecord = normalizeMemoryLexicalTextV1(result.record.text, {
          ...(options.transliterator === undefined
            ? {}
            : { transliterator: options.transliterator })
        })
      } catch {
        continue
      }
      const valid = validRecord(
        result,
        hit,
        requestedNamespaces,
        Date.parse(now),
        normalizedRecord.body,
        normalizedRecord.body === normalizedQuery.body
      )
      if (valid !== null) {
        const previous = records.get(valid.record.memoryId)
        if (previous === undefined || valid.baseScore > previous.baseScore) {
          records.set(valid.record.memoryId, valid)
        }
      }
    }
    const candidates = budgetedCandidates(diversityOrder([...records.values()]), request)
    return Object.freeze({
      schemaVersion: 2 as const,
      status: 'completed' as const,
      mode: candidates.length > 0 && candidates.every(candidate => candidate.ranking.exactMatch)
        ? 'exact' as const
        : 'lexical' as const,
      candidates,
      index: Object.freeze({
        lexical: indexResult.state,
        vector: 'disabled' as const,
        watermark: indexResult.watermark
      })
    })
  }
  return Object.freeze({ retrieve })
}
