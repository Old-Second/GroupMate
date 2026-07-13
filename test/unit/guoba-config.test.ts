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

test('normalizes the tool policy profile and approval TTL fail closed', () => {
  assert.equal(normalizeGuobaConfigValue('toolPolicyProfile', 'compatible'), 'compatible')
  assert.equal(normalizeGuobaConfigValue('toolPolicyProfile', 'safe'), 'safe')
  assert.equal(normalizeGuobaConfigValue('toolPolicyProfile', 'strict'), 'strict')
  assert.throws(() => normalizeGuobaConfigValue('toolPolicyProfile', 'unknown'), /工具权限策略配置无效/)
  assert.throws(() => normalizeGuobaConfigValue('toolPolicyProfile', 1), /工具权限策略配置无效/)

  assert.equal(normalizeGuobaConfigValue('toolApprovalTtlSeconds', 12), 30)
  assert.equal(normalizeGuobaConfigValue('toolApprovalTtlSeconds', 120.9), 120)
  assert.equal(normalizeGuobaConfigValue('toolApprovalTtlSeconds', 999), 300)
  assert.equal(normalizeGuobaConfigValue('toolApprovalTtlSeconds', 'bad'), 120)
})
