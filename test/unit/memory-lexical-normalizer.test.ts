import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEMORY_LEXICAL_TEXT_LIMITS_V1,
  normalizeMemoryLexicalTextV1,
  type MemoryLexicalTransliteratorV1
} from '../../src/agent/memory/memory-lexical-normalizer.js'

const pinyin: MemoryLexicalTransliteratorV1 = Object.freeze({
  aliases: (text: string) => text.includes('火锅')
    ? Object.freeze(['huoguo', 'huo guo'])
    : Object.freeze([])
})

test('lexical normalizer freezes deterministic Chinese bigrams, ASCII and emoji tokens', () => {
  const normalized = normalizeMemoryLexicalTextV1('我爱火锅 TypeScript 🔥')

  assert.deepEqual(normalized.tokens, [
    '我', '爱', '火', '锅', '我爱', '爱火', '火锅', 'typescript', 'emoji_1f525'
  ])
  assert.equal(normalized.body, normalized.tokens.join(' '))
  assert.equal(normalized.query, normalized.tokens.map(token => `"${token}"`).join(' OR '))
  assert.equal(normalized.exactKey, '我爱火锅typescriptemoji_1f525')
  assert.equal(normalized.truncated, false)
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(Object.isFrozen(normalized.tokens), true)
})

test('lexical normalizer accepts bounded explicit transliteration aliases without a bundled dictionary', () => {
  const indexed = normalizeMemoryLexicalTextV1('最喜欢火锅', { transliterator: pinyin })
  const compactQuery = normalizeMemoryLexicalTextV1('huoguo')
  const spacedQuery = normalizeMemoryLexicalTextV1('huo guo')

  assert.ok(indexed.tokens.includes('huoguo'))
  assert.ok(indexed.tokens.includes('huo'))
  assert.ok(indexed.tokens.includes('guo'))
  assert.deepEqual(compactQuery.tokens, ['huoguo'])
  assert.deepEqual(spacedQuery.tokens, ['huo', 'guo'])
})

test('lexical normalizer applies fixed token and byte caps and rejects hostile aliases', () => {
  const long = normalizeMemoryLexicalTextV1(Array.from(
    { length: 1_200 },
    (_, index) => String.fromCodePoint(0x4e00 + index)
  ).join(''))
  assert.equal(long.truncated, true)
  assert.ok(long.tokens.length <= MEMORY_LEXICAL_TEXT_LIMITS_V1.tokens)
  assert.ok(Buffer.byteLength(long.body, 'utf8') <=
    MEMORY_LEXICAL_TEXT_LIMITS_V1.normalizedUtf8Bytes)

  assert.throws(() => normalizeMemoryLexicalTextV1('火锅', {
    transliterator: Object.freeze({ aliases: () => ['huoguo', '秘密!'] })
  }), TypeError)
  assert.throws(() => normalizeMemoryLexicalTextV1('!!!'), TypeError)
})
