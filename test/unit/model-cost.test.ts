import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateModelCost } from '../../src/agent/model/model-cost.js'
import { resolveModelPriceSnapshot } from '../../src/agent/model/model-price-catalog.js'

const NOW = new Date('2026-07-19T00:00:00.000Z')
const FLASH_PRICE = resolveModelPriceSnapshot('deepseek-v4-flash', NOW)!

test('calculates exact cached-input cost in pico-yuan without sub-micro rounding loss', () => {
  assert.deepEqual(calculateModelCost(FLASH_PRICE, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputCache: { hitTokens: 80, missTokens: 20 }
  }), {
    kind: 'exact',
    currency: 'CNY',
    picoYuan: 61_600_000n,
    catalogVersion: 'deepseek-cny-2026-07-19',
    billingAuthority: false
  })
})

test('uses all cache-miss input as the bounded upper estimate when cache usage is absent', () => {
  assert.deepEqual(calculateModelCost(FLASH_PRICE, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120
  }), {
    kind: 'upper_bound',
    currency: 'CNY',
    picoYuan: 140_000_000n,
    catalogVersion: 'deepseek-cny-2026-07-19',
    billingAuthority: false
  })
})

test('returns unavailable rather than estimating when price or usage is incomplete', () => {
  assert.deepEqual(calculateModelCost(undefined, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120
  }), {
    kind: 'unavailable',
    catalogVersion: null,
    billingAuthority: false
  })
  assert.deepEqual(calculateModelCost(FLASH_PRICE, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputCache: { hitTokens: 80, missTokens: 10 }
  }), {
    kind: 'unavailable',
    catalogVersion: 'deepseek-cny-2026-07-19',
    billingAuthority: false
  })
})
