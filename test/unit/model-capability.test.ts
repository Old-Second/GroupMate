import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  modelCapabilityStableHash,
  parseModelCapabilitySnapshot,
  resolveModelCapabilitySnapshot
} from '../../src/agent/model/model-capability.js'
import { resolveModelPriceSnapshot } from '../../src/agent/model/model-price-catalog.js'
import { deepSeekCompatibilityProfile } from '../../src/agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'

const BEFORE_ALIAS_EXPIRY = new Date('2026-07-24T15:59:59.999Z')
const AT_ALIAS_EXPIRY = new Date('2026-07-24T16:00:00.000Z')

test('resolves frozen DeepSeek capability and price snapshots from the profile', () => {
  const capability = resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-v4-flash',
    now: BEFORE_ALIAS_EXPIRY
  })
  const price = resolveModelPriceSnapshot('deepseek-v4-flash', BEFORE_ALIAS_EXPIRY)

  assert.deepEqual(capability, {
    schemaVersion: 1,
    source: 'profile',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    promptCaching: 'deepseek_disk',
    usageExtensions: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'],
    priceCatalogVersion: 'deepseek-cny-2026-07-19'
  })
  assert.deepEqual(price, {
    schemaVersion: 1,
    catalogVersion: 'deepseek-cny-2026-07-19',
    model: 'deepseek-v4-flash',
    inputCacheHitPicoYuanPerMillionTokens: 20_000_000_000,
    inputCacheMissPicoYuanPerMillionTokens: 1_000_000_000_000,
    outputPicoYuanPerMillionTokens: 2_000_000_000_000
  })
  assert.ok(Object.isFrozen(capability))
  assert.ok(Object.isFrozen(capability.usageExtensions))
  assert.ok(Object.isFrozen(price))
})

test('projects only explicit user overrides without inferring a price for an unknown model', () => {
  const snapshot = resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'unlisted-deepseek-model',
    override: { maxOutputTokens: 16_384 },
    now: BEFORE_ALIAS_EXPIRY
  })

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    source: 'user_override',
    contextWindowTokens: 32_768,
    maxOutputTokens: 16_384,
    promptCaching: 'unknown',
    usageExtensions: [],
    priceCatalogVersion: null
  })
  assert.equal(resolveModelPriceSnapshot('unlisted-deepseek-model', BEFORE_ALIAS_EXPIRY), undefined)
})

test('uses the safe default when no profile capability or override exists', () => {
  assert.deepEqual(resolveModelCapabilitySnapshot({
    profile: standardOpenAIProfile,
    model: 'unlisted-openai-compatible-model',
    now: BEFORE_ALIAS_EXPIRY
  }), {
    schemaVersion: 1,
    source: 'safe_default',
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown',
    usageExtensions: [],
    priceCatalogVersion: null
  })
})

test('known capability overrides may only narrow provider-declared features', () => {
  assert.deepEqual(resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-v4-flash',
    override: {
      contextWindowTokens: 65_536,
      promptCaching: 'unknown',
      usageExtensions: ['prompt_cache_hit_tokens']
    },
    now: BEFORE_ALIAS_EXPIRY
  }), {
    schemaVersion: 1,
    source: 'user_override',
    contextWindowTokens: 65_536,
    maxOutputTokens: 65_536,
    promptCaching: 'unknown',
    usageExtensions: ['prompt_cache_hit_tokens'],
    priceCatalogVersion: 'deepseek-cny-2026-07-19'
  })

  assert.throws(() => resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-v4-flash',
    override: { contextWindowTokens: 1_000_001 },
    now: BEFORE_ALIAS_EXPIRY
  }), /override/i)
  assert.throws(() => resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-v4-flash',
    override: { maxOutputTokens: 500_000 },
    now: BEFORE_ALIAS_EXPIRY
  }), /override/i)
  assert.throws(() => resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-v4-flash',
    override: { contextWindowTokens: 65_536, maxOutputTokens: 65_537 },
    now: BEFORE_ALIAS_EXPIRY
  }), /override|context/i)
  assert.throws(() => resolveModelCapabilitySnapshot({
    profile: standardOpenAIProfile,
    model: 'unlisted-openai-compatible-model',
    override: { contextWindowTokens: 0 },
    now: BEFORE_ALIAS_EXPIRY
  }), /override/i)
  assert.throws(() => resolveModelCapabilitySnapshot({
    profile: standardOpenAIProfile,
    model: 'unlisted-openai-compatible-model',
    override: { promptCaching: 'deepseek_disk' },
    now: BEFORE_ALIAS_EXPIRY
  }), /override/i)
  assert.deepEqual(resolveModelCapabilitySnapshot({
    profile: standardOpenAIProfile,
    model: 'unlisted-openai-compatible-model',
    override: { contextWindowTokens: 1_000_000, maxOutputTokens: 500_000 },
    now: BEFORE_ALIAS_EXPIRY
  }), {
    schemaVersion: 1,
    source: 'user_override',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 500_000,
    promptCaching: 'unknown',
    usageExtensions: [],
    priceCatalogVersion: null
  })
})

test('expires only the documented DeepSeek aliases at their exact cutoff instant', () => {
  const before = resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-reasoner',
    now: BEFORE_ALIAS_EXPIRY
  })
  const at = resolveModelCapabilitySnapshot({
    profile: deepSeekCompatibilityProfile,
    model: 'deepseek-reasoner',
    now: AT_ALIAS_EXPIRY
  })

  assert.equal(before.source, 'profile')
  assert.equal(before.priceCatalogVersion, 'deepseek-cny-2026-07-19')
  assert.equal(resolveModelPriceSnapshot('deepseek-reasoner', BEFORE_ALIAS_EXPIRY)?.model,
    'deepseek-v4-flash')
  assert.equal(at.source, 'safe_default')
  assert.equal(at.priceCatalogVersion, null)
  assert.equal(resolveModelPriceSnapshot('deepseek-reasoner', AT_ALIAS_EXPIRY), undefined)
})

test('capability codec accepts only exact safe-integer snapshot keys', () => {
  assert.throws(() => parseModelCapabilitySnapshot({
    schemaVersion: 1,
    source: 'profile',
    contextWindowTokens: 1.5,
    maxOutputTokens: 384_000,
    promptCaching: 'deepseek_disk',
    usageExtensions: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'],
    priceCatalogVersion: 'deepseek-cny-2026-07-19'
  }), /capability/i)
  assert.throws(() => parseModelCapabilitySnapshot({
    schemaVersion: 1,
    source: 'profile',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    promptCaching: 'deepseek_disk',
    usageExtensions: ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'],
    priceCatalogVersion: 'deepseek-cny-2026-07-19',
    guessed: true
  }), /capability/i)
})

test('capability stable hash has a domain-separated fixed vector', () => {
  assert.equal(modelCapabilityStableHash({
    schemaVersion: 1,
    source: 'safe_default',
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: 'unknown',
    usageExtensions: [],
    priceCatalogVersion: null
  }), '5ae13d264e71c7f1ae28fc9f23b4fb323f3e816353b30116525284cfb1590dd8')
})
