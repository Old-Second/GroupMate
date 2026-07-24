import { types as utilTypes } from 'node:util'
import type { MemoryAccessCapabilityV1 } from './memory-access-gate.js'
import { memoryAccessCapabilityAllowsV1 } from './memory-access-gate.js'
import type { MemoryKindV1, MemorySourceKindV1 } from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryGroupLifecycleIdV1,
  parseMemoryNamespaceRefV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import {
  memoryAsciiWithinLimit,
  memoryCanonicalTextWithinLimits
} from './memory-resource-limits.js'

export const MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2 = Object.freeze({
  subjects: 4,
  queryTextUtf8Bytes: 4 * 1_024,
  queryTextCodePoints: 2_000,
  languageHintAsciiBytes: 32,
  maxCandidates: 12,
  maxLexicalHits: 24,
  maxTokens: 2_400,
  maxBytes: 64 * 1_024,
  maxDurationMs: 500,
  candidateTextUtf8Bytes: 4 * 1_024,
  candidateTextCodePoints: 2_000,
  candidateSources: 8,
  displayNameUtf8Bytes: 1_024,
  displayNameCodePoints: 256,
  groupNameUtf8Bytes: 1_024,
  groupNameCodePoints: 256,
  opaqueRefAsciiBytes: 128,
  resultWireBytes: 128 * 1_024
})

export type MemoryRetrievalSubjectReasonV2 =
  | 'current_actor'
  | 'quoted_actor'
  | 'mentioned_actor'
  | 'explicit_target'

export interface MemoryRetrievalSubjectV2 {
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly reason: MemoryRetrievalSubjectReasonV2
}

export interface MemoryRetrievalRequestV2 {
  readonly schemaVersion: 2
  readonly capability: MemoryAccessCapabilityV1
  readonly subjects: readonly MemoryRetrievalSubjectV2[]
  readonly query: Readonly<{
    readonly text: string
    readonly languageHint: string | null
  }>
  readonly limits: Readonly<{
    readonly maxCandidates: number
    readonly maxTokens: number
    readonly maxBytes: number
  }>
  readonly requestedAt: string
  readonly deadlineAt: string
}

export interface MemoryRetrievalSourceV1 {
  readonly schemaVersion: 1
  readonly sourceId: string
  readonly sourceKind: MemorySourceKindV1
  readonly messageId: string | null
  readonly actor: Readonly<{
    readonly userId: string
    readonly displayName: string | null
  }>
  readonly scene:
    | Readonly<{ readonly kind: 'private' }>
    | Readonly<{
        readonly kind: 'group'
        readonly groupId: string
        readonly groupLifecycleId: string
        readonly groupName: string | null
      }>
  readonly observedAt: string
}

export interface MemoryRetrievalCandidateV2 {
  readonly schemaVersion: 2
  readonly memoryId: string
  readonly revision: number
  readonly revisionHash: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly kind: MemoryKindV1
  readonly text: string
  readonly createdAt: string
  readonly observedAt: string
  readonly updatedAt: string
  readonly validUntil: string
  readonly confidence: number
  readonly sensitivity: 'public' | 'group' | 'personal' | 'sensitive'
  readonly conflict: 'none' | 'possible' | 'confirmed'
  readonly consent: 'explicit' | 'owner_policy' | 'group_policy'
  readonly estimatedTokens: number
  readonly sources: readonly MemoryRetrievalSourceV1[]
  readonly ranking: Readonly<{
    readonly exactMatch: boolean
    readonly lexicalRank: number | null
    readonly vectorRank: number | null
    readonly rerankRank: number | null
    readonly fusedRank: number
  }>
}

export type MemoryRetrievalUnavailableReasonV2 =
  | 'disabled'
  | 'not_opted_in'
  | 'not_in_canary'
  | 'adapter_unavailable'
  | 'adapter_invalid'
  | 'deadline_exceeded'
  | 'index_unavailable'
  | 'canonical_unavailable'
  | 'policy_unavailable'

export type MemoryRetrievalDeniedReasonV2 =
  | 'capability_invalid'
  | 'namespace_denied'
  | 'policy_denied'

export type MemoryRetrievalResultV2 =
  | Readonly<{
      readonly schemaVersion: 2
      readonly status: 'completed'
      readonly mode: 'none' | 'exact' | 'lexical' | 'hybrid'
      readonly candidates: readonly MemoryRetrievalCandidateV2[]
      readonly index: Readonly<{
        readonly lexical: 'disabled' | 'fresh' | 'stale' | 'rebuilding' | 'unavailable'
        readonly vector: 'disabled' | 'fresh' | 'stale' | 'rebuilding' | 'unavailable'
        readonly watermark: string | null
      }>
    }>
  | Readonly<{
      readonly schemaVersion: 2
      readonly status: 'unavailable'
      readonly reason: MemoryRetrievalUnavailableReasonV2
    }>
  | Readonly<{
      readonly schemaVersion: 2
      readonly status: 'denied'
      readonly reason: MemoryRetrievalDeniedReasonV2
    }>

export interface MemoryRetrievalAdapterV2 {
  retrieve(
    request: MemoryRetrievalRequestV2,
    signal?: AbortSignal
  ): Promise<unknown>
}

export interface MemoryRetrievalInvocationV2 {
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

const SUBJECT_REASONS = Object.freeze([
  'current_actor', 'quoted_actor', 'mentioned_actor', 'explicit_target'
] as const satisfies readonly MemoryRetrievalSubjectReasonV2[])
const MEMORY_KINDS = Object.freeze([
  'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
  'task_fact', 'other'
] as const satisfies readonly MemoryKindV1[])
const SOURCE_KINDS = Object.freeze([
  'current_message', 'quoted_message', 'group_history', 'private_history',
  'manual_user_input', 'manual_correction'
] as const satisfies readonly MemorySourceKindV1[])
const SENSITIVITIES = Object.freeze([
  'public', 'group', 'personal', 'sensitive'
] as const)
const CONFLICTS = Object.freeze(['none', 'possible', 'confirmed'] as const)
const CONSENTS = Object.freeze(['explicit', 'owner_policy', 'group_policy'] as const)
const UNAVAILABLE_REASONS = Object.freeze([
  'disabled', 'not_opted_in', 'not_in_canary', 'adapter_unavailable',
  'adapter_invalid', 'deadline_exceeded', 'index_unavailable',
  'canonical_unavailable', 'policy_unavailable'
] as const satisfies readonly MemoryRetrievalUnavailableReasonV2[])
const DENIED_REASONS = Object.freeze([
  'capability_invalid', 'namespace_denied', 'policy_denied'
] as const satisfies readonly MemoryRetrievalDeniedReasonV2[])
const MODES = Object.freeze(['none', 'exact', 'lexical', 'hybrid'] as const)
const INDEX_STATES = Object.freeze([
  'disabled', 'fresh', 'stale', 'rebuilding', 'unavailable'
] as const)
const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const LANGUAGE_HINT = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return invalidMemoryValue()
  }
  return value as T
}

function positiveInteger (value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function nullablePositiveInteger (value: unknown, maximum: number): number | null {
  return value === null ? null : positiveInteger(value, maximum)
}

function canonicalInstant (value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalidMemoryValue()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalidMemoryValue()
  }
  return value
}

function canonicalText (
  value: unknown,
  maximumUtf8Bytes: number,
  maximumCodePoints: number,
  allowEmpty = false
): string {
  if (!memoryCanonicalTextWithinLimits(value, maximumUtf8Bytes, maximumCodePoints) ||
    (!allowEmpty && value.length === 0)) return invalidMemoryValue()
  return value
}

function nullableCanonicalText (
  value: unknown,
  maximumUtf8Bytes: number,
  maximumCodePoints: number
): string | null {
  return value === null
    ? null
    : canonicalText(value, maximumUtf8Bytes, maximumCodePoints)
}

function opaqueRef (value: unknown, pattern?: RegExp): string {
  if (!memoryAsciiWithinLimit(
    value,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.opaqueRefAsciiBytes
  ) || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    return invalidMemoryValue()
  }
  return value
}

function parseSubject (value: unknown, capability: MemoryAccessCapabilityV1, now: string) {
  const input = inspectMemoryRecord(value, ['namespaceRef', 'reason'])
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  if (!memoryAccessCapabilityAllowsV1(capability, namespaceRef, now)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    namespaceRef,
    reason: enumValue(input.reason, SUBJECT_REASONS)
  })
}

function parseLanguageHint (value: unknown): string | null {
  if (value === null) return null
  if (!memoryAsciiWithinLimit(
    value,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.languageHintAsciiBytes
  ) || !LANGUAGE_HINT.test(value)) return invalidMemoryValue()
  return value
}

export function parseMemoryRetrievalRequestV2 (value: unknown): MemoryRetrievalRequestV2 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'capability', 'subjects', 'query', 'limits',
    'requestedAt', 'deadlineAt'
  ])
  if (input.schemaVersion !== 2 || input.capability === null ||
    typeof input.capability !== 'object' || utilTypes.isProxy(input.capability)) {
    return invalidMemoryValue()
  }
  const requestedAt = canonicalInstant(input.requestedAt)
  const deadlineAt = canonicalInstant(input.deadlineAt)
  const duration = Date.parse(deadlineAt) - Date.parse(requestedAt)
  if (duration <= 0 || duration > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxDurationMs) {
    return invalidMemoryValue()
  }
  const capability = input.capability as MemoryAccessCapabilityV1
  const subjects = inspectMemoryArray(
    input.subjects,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.subjects
  ).map(subject => parseSubject(subject, capability, requestedAt))
  if (subjects.length === 0 ||
    new Set(subjects.map(subject => subject.namespaceRef)).size !== subjects.length) {
    return invalidMemoryValue()
  }
  const queryInput = inspectMemoryRecord(input.query, ['text', 'languageHint'])
  const query = Object.freeze({
    text: canonicalText(
      queryInput.text,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.queryTextUtf8Bytes,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.queryTextCodePoints
    ),
    languageHint: parseLanguageHint(queryInput.languageHint)
  })
  const limitsInput = inspectMemoryRecord(input.limits, [
    'maxCandidates', 'maxTokens', 'maxBytes'
  ])
  const limits = Object.freeze({
    maxCandidates: positiveInteger(
      limitsInput.maxCandidates,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates
    ),
    maxTokens: positiveInteger(
      limitsInput.maxTokens,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxTokens
    ),
    maxBytes: positiveInteger(
      limitsInput.maxBytes,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxBytes
    )
  })
  return Object.freeze({
    schemaVersion: 2 as const,
    capability,
    subjects: Object.freeze(subjects),
    query,
    limits,
    requestedAt,
    deadlineAt
  })
}

function parseActor (value: unknown): MemoryRetrievalSourceV1['actor'] {
  const input = inspectMemoryRecord(value, ['userId', 'displayName'])
  return Object.freeze({
    userId: parseMemoryQqIdV1(input.userId),
    displayName: nullableCanonicalText(
      input.displayName,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.displayNameUtf8Bytes,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.displayNameCodePoints
    )
  })
}

function parseScene (value: unknown): MemoryRetrievalSourceV1['scene'] {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['groupId', 'groupLifecycleId', 'groupName']
  )
  if (discriminator.kind === 'private') {
    inspectMemoryRecord(value, ['kind'])
    return Object.freeze({ kind: 'private' as const })
  }
  if (discriminator.kind !== 'group') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, [
    'kind', 'groupId', 'groupLifecycleId', 'groupName'
  ])
  return Object.freeze({
    kind: 'group' as const,
    groupId: parseMemoryQqIdV1(input.groupId),
    groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId),
    groupName: nullableCanonicalText(
      input.groupName,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.groupNameUtf8Bytes,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.groupNameCodePoints
    )
  })
}

function parseMessageId (value: unknown): string | null {
  if (value === null) return null
  return opaqueRef(value)
}

function parseSource (value: unknown): MemoryRetrievalSourceV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'sourceId', 'sourceKind', 'messageId',
    'actor', 'scene', 'observedAt'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceId: opaqueRef(input.sourceId),
    sourceKind: enumValue(input.sourceKind, SOURCE_KINDS),
    messageId: parseMessageId(input.messageId),
    actor: parseActor(input.actor),
    scene: parseScene(input.scene),
    observedAt: canonicalInstant(input.observedAt)
  })
}

function confidence (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
    value > 1 || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function parseRanking (value: unknown): MemoryRetrievalCandidateV2['ranking'] {
  const input = inspectMemoryRecord(value, [
    'exactMatch', 'lexicalRank', 'vectorRank', 'rerankRank', 'fusedRank'
  ])
  if (typeof input.exactMatch !== 'boolean') return invalidMemoryValue()
  return Object.freeze({
    exactMatch: input.exactMatch,
    lexicalRank: nullablePositiveInteger(
      input.lexicalRank,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxLexicalHits
    ),
    vectorRank: nullablePositiveInteger(
      input.vectorRank,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates
    ),
    rerankRank: nullablePositiveInteger(
      input.rerankRank,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates
    ),
    fusedRank: positiveInteger(
      input.fusedRank,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates
    )
  })
}

function parseCandidate (value: unknown): MemoryRetrievalCandidateV2 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'memoryId', 'revision', 'revisionHash', 'namespaceRef',
    'kind', 'text', 'createdAt', 'observedAt', 'updatedAt', 'validUntil',
    'confidence', 'sensitivity', 'conflict', 'consent', 'estimatedTokens',
    'sources', 'ranking'
  ])
  if (input.schemaVersion !== 2) return invalidMemoryValue()
  const createdAt = canonicalInstant(input.createdAt)
  const observedAt = canonicalInstant(input.observedAt)
  const updatedAt = canonicalInstant(input.updatedAt)
  const validUntil = canonicalInstant(input.validUntil)
  if (Date.parse(updatedAt) < Date.parse(createdAt) ||
    Date.parse(validUntil) <= Date.parse(updatedAt)) return invalidMemoryValue()
  const sources = inspectMemoryArray(
    input.sources,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.candidateSources
  ).map(parseSource)
  if (sources.length === 0 || new Set(sources.map(source => source.sourceId)).size !== sources.length) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    memoryId: opaqueRef(input.memoryId, MEMORY_ID),
    revision: positiveInteger(input.revision, Number.MAX_SAFE_INTEGER),
    revisionHash: opaqueRef(input.revisionHash, HASH),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    kind: enumValue(input.kind, MEMORY_KINDS),
    text: canonicalText(
      input.text,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.candidateTextUtf8Bytes,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.candidateTextCodePoints
    ),
    createdAt,
    observedAt,
    updatedAt,
    validUntil,
    confidence: confidence(input.confidence),
    sensitivity: enumValue(input.sensitivity, SENSITIVITIES),
    conflict: enumValue(input.conflict, CONFLICTS),
    consent: enumValue(input.consent, CONSENTS),
    estimatedTokens: positiveInteger(
      input.estimatedTokens,
      MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxTokens
    ),
    sources: Object.freeze(sources),
    ranking: parseRanking(input.ranking)
  })
}

function parseIndexState (value: unknown) {
  return enumValue(value, INDEX_STATES)
}

function parseIndex (value: unknown): Extract<
MemoryRetrievalResultV2,
{ readonly status: 'completed' }
>['index'] {
  const input = inspectMemoryRecord(value, ['lexical', 'vector', 'watermark'])
  return Object.freeze({
    lexical: parseIndexState(input.lexical),
    vector: parseIndexState(input.vector),
    watermark: input.watermark === null ? null : opaqueRef(input.watermark)
  })
}

function resultWireWithinLimit (value: unknown): void {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return invalidMemoryValue()
  }
  if (bytes > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.resultWireBytes) {
    return invalidMemoryValue()
  }
}

export function parseMemoryRetrievalResultV2 (value: unknown): MemoryRetrievalResultV2 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'status'],
    ['mode', 'candidates', 'index', 'reason']
  )
  if (discriminator.schemaVersion !== 2) return invalidMemoryValue()
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'status', 'reason'])
    const result = Object.freeze({
      schemaVersion: 2 as const,
      status: 'unavailable' as const,
      reason: enumValue(input.reason, UNAVAILABLE_REASONS)
    })
    resultWireWithinLimit(result)
    return result
  }
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'status', 'reason'])
    const result = Object.freeze({
      schemaVersion: 2 as const,
      status: 'denied' as const,
      reason: enumValue(input.reason, DENIED_REASONS)
    })
    resultWireWithinLimit(result)
    return result
  }
  if (discriminator.status !== 'completed') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'status', 'mode', 'candidates', 'index'
  ])
  const mode = enumValue(input.mode, MODES)
  const candidates = inspectMemoryArray(
    input.candidates,
    MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates
  ).map(parseCandidate)
  if (new Set(candidates.map(candidate => candidate.memoryId)).size !== candidates.length) {
    return invalidMemoryValue()
  }
  const index = parseIndex(input.index)
  if (mode === 'none' && (candidates.length !== 0 || index.lexical !== 'disabled' ||
    index.vector !== 'disabled')) return invalidMemoryValue()
  if (mode === 'lexical' && ['disabled', 'unavailable'].includes(index.lexical)) {
    return invalidMemoryValue()
  }
  if (mode === 'hybrid' && (
    ['disabled', 'unavailable'].includes(index.lexical) ||
    ['disabled', 'unavailable'].includes(index.vector)
  )) return invalidMemoryValue()
  const result = Object.freeze({
    schemaVersion: 2 as const,
    status: 'completed' as const,
    mode,
    candidates: Object.freeze(candidates),
    index
  })
  resultWireWithinLimit(result)
  return result
}

function unavailable (
  reason: MemoryRetrievalUnavailableReasonV2
): Extract<MemoryRetrievalResultV2, { readonly status: 'unavailable' }> {
  return Object.freeze({ schemaVersion: 2 as const, status: 'unavailable' as const, reason })
}

function abortError (): DOMException {
  return new DOMException('operation was aborted', 'AbortError')
}

function throwIfAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

function isAbortError (error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function completedResultMatchesRequest (
  result: Extract<MemoryRetrievalResultV2, { readonly status: 'completed' }>,
  request: MemoryRetrievalRequestV2,
  now: string
): boolean {
  if (result.candidates.length > request.limits.maxCandidates) return false
  const namespaces = new Set(request.subjects.map(subject => subject.namespaceRef))
  let tokens = 0
  let bytes = 0
  for (const candidate of result.candidates) {
    if (!namespaces.has(candidate.namespaceRef) ||
      !memoryAccessCapabilityAllowsV1(
        request.capability,
        candidate.namespaceRef,
        now
      )) return false
    tokens += candidate.estimatedTokens
    try {
      bytes += Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    } catch {
      return false
    }
    if (tokens > request.limits.maxTokens || bytes > request.limits.maxBytes) return false
  }
  return true
}

function trustedNow (source: (() => Date) | undefined): string | null {
  let value: unknown
  try {
    value = source === undefined ? new Date() : source()
  } catch {
    return null
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null
  try {
    return value.toISOString()
  } catch {
    return null
  }
}

function invocationWindowResult (
  request: MemoryRetrievalRequestV2,
  now: string
): Extract<MemoryRetrievalResultV2, { readonly status: 'unavailable' | 'denied' }> | null {
  const nowMs = Date.parse(now)
  if (nowMs > Date.parse(request.deadlineAt)) return unavailable('deadline_exceeded')
  if (nowMs < Date.parse(request.requestedAt) || request.subjects.some(subject => (
    !memoryAccessCapabilityAllowsV1(request.capability, subject.namespaceRef, now)
  ))) {
    return Object.freeze({
      schemaVersion: 2 as const,
      status: 'denied' as const,
      reason: 'capability_invalid' as const
    })
  }
  return null
}

export async function retrieveMemoryV2 (
  adapter: MemoryRetrievalAdapterV2,
  requestValue: unknown,
  options: MemoryRetrievalInvocationV2 = {}
): Promise<MemoryRetrievalResultV2> {
  const signal = options.signal
  throwIfAborted(signal)
  const request = parseMemoryRetrievalRequestV2(requestValue)
  const before = trustedNow(options.now)
  if (before === null) return unavailable('policy_unavailable')
  const beforeWindow = invocationWindowResult(request, before)
  if (beforeWindow !== null) return beforeWindow
  let raw: unknown
  try {
    raw = await adapter.retrieve(request, signal)
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortError()
    return unavailable('adapter_unavailable')
  }
  throwIfAborted(signal)
  const after = trustedNow(options.now)
  if (after === null) return unavailable('policy_unavailable')
  const afterWindow = invocationWindowResult(request, after)
  if (afterWindow !== null) return afterWindow
  let result: MemoryRetrievalResultV2
  try {
    result = parseMemoryRetrievalResultV2(raw)
  } catch {
    return unavailable('adapter_invalid')
  }
  if (result.status === 'completed' && !completedResultMatchesRequest(result, request, after)) {
    return unavailable('adapter_invalid')
  }
  return result
}

const EMPTY_COMPLETED_RESULT = Object.freeze({
  schemaVersion: 2 as const,
  status: 'completed' as const,
  mode: 'none' as const,
  candidates: Object.freeze([]) as readonly MemoryRetrievalCandidateV2[],
  index: Object.freeze({
    lexical: 'disabled' as const,
    vector: 'disabled' as const,
    watermark: null
  })
})

export class NoopMemoryRetrieverV2 implements MemoryRetrievalAdapterV2 {
  async retrieve (
    _request: MemoryRetrievalRequestV2,
    signal?: AbortSignal
  ): Promise<MemoryRetrievalResultV2> {
    throwIfAborted(signal)
    return EMPTY_COMPLETED_RESULT
  }
}
