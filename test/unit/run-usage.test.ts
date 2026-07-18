import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseModelPriceSnapshot } from '../../src/agent/model/model-price-catalog.js'
import {
  createInitialRunUsageSummary,
  parseRunUsageSummary,
  recordRunUsage
} from '../../src/agent/run/run-usage.js'

const initial = Object.freeze({
  schemaVersion: 1 as const,
  availability: 'complete' as const,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  turnsWithUsage: 0,
  turnsWithoutUsage: 0,
  cacheUsageComplete: true
})

test('fresh run usage is an exact frozen complete zero summary', () => {
  const usage = createInitialRunUsageSummary()
  assert.deepEqual(usage, initial)
  assert.equal(Object.isFrozen(usage), true)
  assert.deepEqual(parseRunUsageSummary(usage), usage)
})

test('usage codec rejects unknown, missing, unsafe and inconsistent values', () => {
  const invalid = [
    { ...initial, extra: true },
    Object.fromEntries(Object.entries(initial).filter(([key]) => key !== 'totalTokens')),
    { ...initial, inputTokens: -1 },
    { ...initial, outputTokens: 0.5 },
    { ...initial, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...initial, inputTokens: 1, totalTokens: 0 },
    { ...initial, inputTokens: 1, totalTokens: 1, cacheHitTokens: 2 },
    { ...initial, inputTokens: 1, totalTokens: 1, cacheUsageComplete: true },
    { ...initial, availability: 'complete', turnsWithoutUsage: 1 },
    { ...initial, availability: 'partial', turnsWithoutUsage: 0 }
  ]
  for (const value of invalid) {
    assert.throws(() => parseRunUsageSummary(value), /usage/i)
  }
})

test('records complete and partial usage without conflating missing cache extensions', () => {
  const complete = recordRunUsage(initial, {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    inputCache: { hitTokens: 4, missTokens: 6 }
  })
  assert.deepEqual(complete, {
    ...initial,
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cacheHitTokens: 4,
    cacheMissTokens: 6,
    turnsWithUsage: 1
  })

  const missingCache = recordRunUsage(complete, {
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4
  })
  assert.deepEqual(missingCache, {
    ...complete,
    inputTokens: 13,
    outputTokens: 3,
    totalTokens: 16,
    turnsWithUsage: 2,
    cacheUsageComplete: false
  })

  const missingUsage = recordRunUsage(missingCache, undefined)
  assert.equal(missingUsage.availability, 'partial')
  assert.equal(missingUsage.turnsWithoutUsage, 1)
  assert.equal(missingUsage.cacheUsageComplete, false)
})

test('historical unavailable usage never becomes known and cache completeness never recovers', () => {
  const unavailable = parseRunUsageSummary({
    ...initial,
    availability: 'unavailable',
    cacheUsageComplete: false
  })
  const next = recordRunUsage(unavailable, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    inputCache: { hitTokens: 1, missTokens: 0 }
  })
  assert.equal(next.availability, 'unavailable')
  assert.equal(next.cacheUsageComplete, false)
  assert.equal(next.turnsWithUsage, 1)
})

test('usage accumulation validates per-turn arithmetic and overflow before mutation', () => {
  assert.throws(() => recordRunUsage(initial, {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 1
  }), /usage/i)
  assert.throws(() => recordRunUsage(initial, {
    inputTokens: 1,
    outputTokens: 0,
    totalTokens: 1,
    inputCache: { hitTokens: 1, missTokens: 1 }
  }), /usage/i)
  const nearLimit = parseRunUsageSummary({
    ...initial,
    inputTokens: Number.MAX_SAFE_INTEGER,
    totalTokens: Number.MAX_SAFE_INTEGER,
    cacheHitTokens: Number.MAX_SAFE_INTEGER,
    turnsWithUsage: 1
  })
  assert.throws(() => recordRunUsage(nearLimit, {
    inputTokens: 1,
    outputTokens: 0,
    totalTokens: 1,
    inputCache: { hitTokens: 1, missTokens: 0 }
  }), /overflow|usage/i)
})

test('price codec is exact, bounded, numeric, consistent and returns a frozen copy', () => {
  const source = {
    schemaVersion: 1,
    catalogVersion: 'catalog-v1',
    model: 'model-v1',
    inputCacheHitPicoYuanPerMillionTokens: 1,
    inputCacheMissPicoYuanPerMillionTokens: 2,
    outputPicoYuanPerMillionTokens: 3
  }
  const parsed = parseModelPriceSnapshot(source)
  assert.deepEqual(parsed, source)
  assert.notEqual(parsed, source)
  assert.equal(Object.isFrozen(parsed), true)

  for (const value of [
    { ...source, extra: true },
    { ...source, catalogVersion: '' },
    { ...source, catalogVersion: 'x'.repeat(129) },
    { ...source, model: '' },
    { ...source, inputCacheHitPicoYuanPerMillionTokens: '1' },
    { ...source, inputCacheMissPicoYuanPerMillionTokens: -1 },
    { ...source, outputPicoYuanPerMillionTokens: 0.5 },
    { ...source, outputPicoYuanPerMillionTokens: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.throws(() => parseModelPriceSnapshot(value), /price/i)
  }
})
