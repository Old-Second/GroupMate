export const DEEPSEEK_CNY_CATALOG_VERSION = 'deepseek-cny-2026-07-19'
const DEEPSEEK_ALIAS_EXPIRY_MS = Date.parse('2026-07-24T16:00:00.000Z')

export interface ModelPriceSnapshotV1 {
  readonly schemaVersion: 1
  readonly catalogVersion: string
  readonly model: string
  readonly inputCacheHitPicoYuanPerMillionTokens: number
  readonly inputCacheMissPicoYuanPerMillionTokens: number
  readonly outputPicoYuanPerMillionTokens: number
}

const DEEPSEEK_V4_FLASH_PRICE: ModelPriceSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  catalogVersion: DEEPSEEK_CNY_CATALOG_VERSION,
  model: 'deepseek-v4-flash',
  inputCacheHitPicoYuanPerMillionTokens: 20_000_000_000,
  inputCacheMissPicoYuanPerMillionTokens: 1_000_000_000_000,
  outputPicoYuanPerMillionTokens: 2_000_000_000_000
})

const DEEPSEEK_V4_PRO_PRICE: ModelPriceSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  catalogVersion: DEEPSEEK_CNY_CATALOG_VERSION,
  model: 'deepseek-v4-pro',
  inputCacheHitPicoYuanPerMillionTokens: 25_000_000_000,
  inputCacheMissPicoYuanPerMillionTokens: 3_000_000_000_000,
  outputPicoYuanPerMillionTokens: 6_000_000_000_000
})

function isValidNow (value: Date): boolean {
  return Number.isFinite(value.getTime())
}

function canonicalDeepSeekModel (model: string, now: Date): string | undefined {
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro') return model
  if ((model === 'deepseek-chat' || model === 'deepseek-reasoner') &&
      now.getTime() < DEEPSEEK_ALIAS_EXPIRY_MS) {
    return 'deepseek-v4-flash'
  }
  return undefined
}

export function resolveModelPriceSnapshot (
  model: string,
  now: Date = new Date()
): ModelPriceSnapshotV1 | undefined {
  if (typeof model !== 'string' || !isValidNow(now)) {
    throw new TypeError('model price lookup is invalid')
  }
  switch (canonicalDeepSeekModel(model, now)) {
    case 'deepseek-v4-flash': return DEEPSEEK_V4_FLASH_PRICE
    case 'deepseek-v4-pro': return DEEPSEEK_V4_PRO_PRICE
    default: return undefined
  }
}
