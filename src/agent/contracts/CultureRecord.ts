import type { MemoryRetrievalCandidateV2 } from '../memory/memory-retrieval.js'

export type CultureKindV1 = 'topic_preference' | 'language_convention' | 'meme_description'
export const CULTURE_LIMITS = Object.freeze({ records: 64, pending: 32, textBytes: 1024 })
export const CULTURE_LABELS = Object.freeze({
  topic_preference: '主题偏好', language_convention: '语言约定', meme_description: '梗说明'
})
export const CULTURE_TTL_DAYS = Object.freeze({ topic_preference: 30, language_convention: 90, meme_description: 14 })

/** A descriptive projection of canonical group_culture, never an authority or consensus proof. */
export interface CultureRecordV1 {
  readonly schemaVersion: 1
  readonly kind: CultureKindV1
  readonly memoryId: string
  readonly revision: number
  readonly revisionHash: string
  readonly namespaceRef: string
  readonly text: string
  readonly sources: MemoryRetrievalCandidateV2['sources']
  readonly conflict: MemoryRetrievalCandidateV2['conflict']
  readonly validUntil: string
  readonly consensusVerified: false
  readonly descriptionOnly: true
}

export function cultureKindV1 (text: string): CultureKindV1 | null {
  for (const kind of Object.keys(CULTURE_LABELS) as CultureKindV1[]) {
    if (text.startsWith(`本群${CULTURE_LABELS[kind]}：`)) return kind
  }
  return null
}

export function projectCultureRecordV1 (candidate: MemoryRetrievalCandidateV2): CultureRecordV1 | null {
  const kind = cultureKindV1(candidate.text)
  if (candidate.kind !== 'group_culture' || candidate.sensitivity !== 'group' || kind === null ||
    candidate.sources.length === 0 || Buffer.byteLength(candidate.text) > CULTURE_LIMITS.textBytes) return null
  return Object.freeze({ schemaVersion: 1, kind, memoryId: candidate.memoryId,
    revision: candidate.revision, revisionHash: candidate.revisionHash, namespaceRef: candidate.namespaceRef,
    text: candidate.text, sources: candidate.sources, conflict: candidate.conflict, validUntil: candidate.validUntil,
    consensusVerified: false, descriptionOnly: true })
}
