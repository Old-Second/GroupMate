import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  guobaConfigSaveMessage,
  normalizeGuobaConfigValue
} from '../../src/runtime/guoba-config.js'

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

test('normalizes the explicit context window override with zero as profile default', () => {
  for (const value of [0, 1, 65_536, 1_000_000]) {
    assert.equal(normalizeGuobaConfigValue('apiContextWindowTokens', value), value)
  }
  for (const value of [-1, 1.5, '65536', 1_000_001, Number.NaN]) {
    assert.throws(
      () => normalizeGuobaConfigValue('apiContextWindowTokens', value),
      /模型上下文窗口配置无效/
    )
  }
})

test('normalizes the OpenAI compatibility profile explicitly and fail closed', () => {
  assert.equal(normalizeGuobaConfigValue('openAiCompatibilityProfile', 'standard'), 'standard')
  assert.equal(normalizeGuobaConfigValue('openAiCompatibilityProfile', 'deepseek'), 'deepseek')
  assert.throws(
    () => normalizeGuobaConfigValue('openAiCompatibilityProfile', 'auto'),
    /兼容配置无效/
  )
  assert.throws(
    () => normalizeGuobaConfigValue('openAiCompatibilityProfile', 1),
    /兼容配置无效/
  )
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

test('normalizes pending indicator compatibility as a boolean-only field', () => {
  assert.equal(normalizeGuobaConfigValue('turnConfirm', true), true)
  assert.equal(normalizeGuobaConfigValue('turnConfirm', false), false)
  assert.throws(
    () => normalizeGuobaConfigValue('turnConfirm', 'on'),
    /正在思考提示配置无效/
  )
})

test('normalizes the three observability levels fail closed', () => {
  assert.equal(normalizeGuobaConfigValue('observabilityLevel', 'off'), 'off')
  assert.equal(normalizeGuobaConfigValue('observabilityLevel', 'basic'), 'basic')
  assert.equal(normalizeGuobaConfigValue('observabilityLevel', 'diagnostic'), 'diagnostic')
  assert.throws(
    () => normalizeGuobaConfigValue('observabilityLevel', 'debug'),
    /可观测性级别配置无效/
  )
})

test('disk log saves require restart while ordinary live fields keep the normal result', () => {
  assert.equal(
    guobaConfigSaveMessage(['diskLogEnabled']),
    '保存成功；部分模型传输、运行入口、落盘日志或 Chromium 配置将在重启后生效~'
  )
  assert.equal(guobaConfigSaveMessage(['debug']), '保存成功~')
  assert.equal(guobaConfigSaveMessage([]), '保存成功~')
  assert.equal(
    guobaConfigSaveMessage(['diskLogEnabled'], '观测屏障优先'),
    '观测屏障优先'
  )
  assert.equal(
    guobaConfigSaveMessage(['apiContextWindowTokens']),
    '保存成功；部分模型传输、运行入口、落盘日志或 Chromium 配置将在重启后生效~'
  )
})
