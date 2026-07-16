export type FinalPresentationProfile =
  | {
      readonly kind: 'ordinary'
      readonly forcePicture: boolean
      readonly quoteCurrentRequest: boolean
    }
  | {
      readonly kind: 'proactive'
      readonly maxParts: 3
      readonly quoteProbability: 0.1
      readonly delayPerCodePointMs: 200
      readonly maxDelayMs: 3000
      readonly recallAfterMs: number | null
    }
  | {
      readonly kind: 'recovered_legacy_plain_text'
    }

export function ordinaryProfile (input: {
  readonly forcePicture: boolean
  readonly quoteCurrentRequest: boolean
}): Extract<FinalPresentationProfile, { kind: 'ordinary' }> {
  if (typeof input.forcePicture !== 'boolean' || typeof input.quoteCurrentRequest !== 'boolean') {
    throw new TypeError('ordinary presentation profile is invalid')
  }
  return Object.freeze({
    kind: 'ordinary',
    forcePicture: input.forcePicture,
    quoteCurrentRequest: input.quoteCurrentRequest
  })
}

export function proactiveProfile (input: {
  readonly recallAfterMs: number | null
}): Extract<FinalPresentationProfile, { kind: 'proactive' }> {
  if (input.recallAfterMs !== null &&
    (!Number.isSafeInteger(input.recallAfterMs) || input.recallAfterMs < 1_000 ||
      input.recallAfterMs > 3_600_000 || input.recallAfterMs % 1_000 !== 0)) {
    throw new TypeError('proactive presentation recall delay is invalid')
  }
  return Object.freeze({
    kind: 'proactive',
    maxParts: 3,
    quoteProbability: 0.1,
    delayPerCodePointMs: 200,
    maxDelayMs: 3_000,
    recallAfterMs: input.recallAfterMs
  })
}

export const RECOVERED_LEGACY_PROFILE: Extract<
  FinalPresentationProfile,
  { kind: 'recovered_legacy_plain_text' }
> = Object.freeze({ kind: 'recovered_legacy_plain_text' })
