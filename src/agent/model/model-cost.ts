import type { ModelUsage } from './model-adapter.js'
import type { ModelPriceSnapshotV1 } from './model-price-catalog.js'

export type ModelCost =
  | Readonly<{
      kind: 'exact' | 'upper_bound'
      currency: 'CNY'
      picoYuan: bigint
      catalogVersion: string
      billingAuthority: false
    }>
  | Readonly<{
      kind: 'unavailable'
      catalogVersion: string | null
      billingAuthority: false
    }>

const TOKENS_PER_MILLION = 1_000_000n

function isTokenCount (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function unavailable (catalogVersion: string | null): ModelCost {
  return Object.freeze({ kind: 'unavailable', catalogVersion, billingAuthority: false })
}

function roundHalfUp (numerator: bigint): bigint {
  return (numerator + (TOKENS_PER_MILLION / 2n)) / TOKENS_PER_MILLION
}

export function calculateModelCost (
  snapshot: ModelPriceSnapshotV1 | undefined,
  usage: ModelUsage | undefined
): ModelCost {
  if (snapshot === undefined) return unavailable(null)
  if (usage === undefined || !isTokenCount(usage.inputTokens) ||
      !isTokenCount(usage.outputTokens) || !isTokenCount(usage.totalTokens) ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    return unavailable(snapshot.catalogVersion)
  }

  let hitTokens = 0
  let missTokens = usage.inputTokens
  let kind: 'exact' | 'upper_bound' = 'upper_bound'
  if (usage.inputCache !== undefined) {
    hitTokens = usage.inputCache.hitTokens
    missTokens = usage.inputCache.missTokens
    if (!isTokenCount(hitTokens) || !isTokenCount(missTokens) ||
        hitTokens + missTokens !== usage.inputTokens) {
      return unavailable(snapshot.catalogVersion)
    }
    kind = 'exact'
  }
  const picoYuan = roundHalfUp(
    BigInt(hitTokens) * BigInt(snapshot.inputCacheHitPicoYuanPerMillionTokens) +
    BigInt(missTokens) * BigInt(snapshot.inputCacheMissPicoYuanPerMillionTokens) +
    BigInt(usage.outputTokens) * BigInt(snapshot.outputPicoYuanPerMillionTokens)
  )
  return Object.freeze({
    kind,
    currency: 'CNY',
    picoYuan,
    catalogVersion: snapshot.catalogVersion,
    billingAuthority: false
  })
}
