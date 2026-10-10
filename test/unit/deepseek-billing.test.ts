import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepSeekBillingPeriod } from '../../src/agent/model/deepseek-billing-calendar.js'
import { resolveModelPriceSnapshot, parseModelPriceSnapshot } from '../../src/agent/model/model-price-catalog.js'
import { resolveModelCapabilitySnapshot } from '../../src/agent/model/model-capability.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import { calculateModelCost } from '../../src/agent/model/model-cost.js'
import { createInitialRunUsageSummary, recordRunUsage, parseRunUsageSummary } from '../../src/agent/run/run-usage.js'

test('Beijing tariff boundaries, holidays and adjusted weekends match the documented calendar', () => {
  const cases = [
    ['2026-10-12T00:59:59.999Z', 'offpeak'], ['2026-10-12T01:00:00Z', 'peak'],
    ['2026-10-12T03:59:59.999Z', 'peak'], ['2026-10-12T04:00:00Z', 'offpeak'],
    ['2026-10-12T05:59:59.999Z', 'offpeak'], ['2026-10-12T06:00:00Z', 'peak'],
    ['2026-10-12T09:59:59.999Z', 'peak'], ['2026-10-12T10:00:00Z', 'offpeak'],
    ['2026-10-10T01:00:00Z', 'offpeak'], ['2026-10-11T01:00:00Z', 'offpeak'],
    ['2026-10-01T01:00:00Z', 'offpeak'], ['2026-10-07T01:00:00Z', 'offpeak'],
    ['2026-02-23T01:00:00Z', 'offpeak'], ['2026-04-06T01:00:00Z', 'offpeak'],
    ['2026-05-05T01:00:00Z', 'offpeak'], ['2026-06-19T01:00:00Z', 'offpeak'],
    ['2026-09-25T01:00:00Z', 'offpeak'], ['2027-01-04T01:00:00Z', undefined]
  ] as const
  for (const [instant, period] of cases) assert.equal(deepSeekBillingPeriod(new Date(instant)), period, instant)
})

test('current documented aliases share Flash rates and independent 1Mi/384Ki capabilities', () => {
  const now = new Date('2026-10-10T09:00:00Z')
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const price = resolveModelPriceSnapshot(model, now)!
    assert.equal(price.model, 'deepseek-flash')
    assert.equal(price.outputPicoYuanPerMillionTokens, 4_000_000_000_000)
    assert.equal(price.inputCacheHitPicoYuanPerMillionTokens, 20_000_000_000)
    const capability = resolveModelCapabilitySnapshot({ profile: deepSeekCompatibilityProfile, model, now })
    assert.equal(capability.contextWindowTokens, 1_048_576)
    assert.equal(capability.maxOutputTokens, 393_216)
    assert.equal(capability.source, 'profile')
  }
  assert.equal(resolveModelPriceSnapshot('deepseek-reasoner', now), undefined)
  const expired = new Date('2026-11-09T00:00:00Z')
  assert.equal(resolveModelPriceSnapshot('deepseek-flash', expired), undefined)
  assert.equal(resolveModelCapabilitySnapshot({ profile: deepSeekCompatibilityProfile,
    model: 'deepseek-flash', now: expired }).source, 'profile')
})

test('all three Pro tariffs double during peak time and exact cost includes reasoning in output once', () => {
  const usage = { inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000,
    inputCache: { hitTokens: 1_000_000, missTokens: 1_000_000 } }
  const low = resolveModelPriceSnapshot('deepseek-v4-pro', new Date('2026-10-12T04:00:00Z'))!
  const high = resolveModelPriceSnapshot('deepseek-v4-pro', new Date('2026-10-12T06:00:00Z'))!
  assert.equal(low.inputCacheHitPicoYuanPerMillionTokens, 150_000_000_000)
  assert.equal(low.inputCacheMissPicoYuanPerMillionTokens, 4_500_000_000_000)
  assert.equal(low.outputPicoYuanPerMillionTokens, 13_500_000_000_000)
  const cost = calculateModelCost(low, usage)
  const peak = calculateModelCost(high, usage)
  assert.equal(cost.kind, 'exact')
  assert.equal(cost.kind === 'exact' && cost.picoYuan, 18_150_000_000_000n)
  assert.equal(peak.kind === 'exact' && peak.picoYuan, 36_300_000_000_000n)
})

test('per-request cost accumulation survives JSON reload and sums differing tariff periods', () => {
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120,
    inputCache: { hitTokens: 80, missTokens: 20 } }
  const offpeak = calculateModelCost(resolveModelPriceSnapshot('deepseek-flash', new Date('2026-10-12T04:00:00Z')), usage)
  const peak = calculateModelCost(resolveModelPriceSnapshot('deepseek-flash', new Date('2026-10-12T06:00:00Z')), usage)
  const first = recordRunUsage(createInitialRunUsageSummary(), usage, offpeak)
  const second = recordRunUsage(parseRunUsageSummary(JSON.parse(JSON.stringify(first))), usage, peak)
  assert.deepEqual(second.cost, { kind: 'exact', currency: 'CNY', picoYuan: '304800000',
    catalogVersion: 'deepseek-cny-2026-10-10', billingAuthority: false })
  const unknown = recordRunUsage(second, usage, calculateModelCost(undefined, usage))
  assert.equal(unknown.cost?.kind, 'unavailable')
  assert.equal(unknown.totalTokens, 360)
})

test('historical snapshots keep their original rates and unknown prices never become zero', () => {
  const historical = resolveModelPriceSnapshot('deepseek-v4-flash', new Date('2026-07-19T00:00:00Z'))!
  const reloaded = parseModelPriceSnapshot(JSON.parse(JSON.stringify(historical)))
  assert.equal(reloaded.outputPicoYuanPerMillionTokens, 2_000_000_000_000)
  assert.deepEqual(calculateModelCost(undefined, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }), {
    kind: 'unavailable', catalogVersion: null, billingAuthority: false
  })
})
