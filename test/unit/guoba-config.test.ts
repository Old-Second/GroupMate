import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeGuobaConfigValue } from '../../src/runtime/guoba-config.js'

test('normalizes editable Guoba list fields into unique trimmed values', () => {
  assert.deepEqual(
    normalizeGuobaConfigValue('bymFuckList', ' 骂,你妈；骂 | 艹 '),
    ['骂', '你妈', '艹']
  )
  assert.deepEqual(
    normalizeGuobaConfigValue('initiativeChatGroups', ['123456', ' 654321 ']),
    ['123456', '654321']
  )
  assert.deepEqual(
    normalizeGuobaConfigValue('blockWords', 'bad phrase, second phrase'),
    ['bad phrase', 'second phrase']
  )
})

test('validates QQ scope and BYM exception identifiers', () => {
  assert.deepEqual(
    normalizeGuobaConfigValue('whitelist', '123456,^234567,345678^456789,invalid'),
    ['123456', '^234567', '345678^456789']
  )
  assert.deepEqual(
    normalizeGuobaConfigValue('bymFuckBlacklist', '123456,invalid,123456,234567'),
    ['123456', '234567']
  )
})

test('leaves scalar Guoba values unchanged', () => {
  assert.equal(normalizeGuobaConfigValue('temperature', 0.8), 0.8)
  assert.equal(normalizeGuobaConfigValue('model', 'deepseek-chat'), 'deepseek-chat')
})
