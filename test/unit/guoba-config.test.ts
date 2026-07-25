import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGuobaConfigPatch,
  guobaConfigSaveMessage,
  normalizeGuobaConfigValue,
  PERSONAL_MEMORY_CONFIG_DEFAULTS
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
    normalizeGuobaConfigValue(
      'personalMemoryGroupAllowlist',
      ['123456', ' 654321 ', '123456', 'invalid']
    ),
    ['123456', '654321']
  )
  assert.deepEqual(
    normalizeGuobaConfigValue('blockWords', 'bad phrase, second phrase'),
    ['bad phrase', 'second phrase']
  )
})

test('normalizes the bounded personal memory pilot configuration fail closed', () => {
  assert.deepEqual(PERSONAL_MEMORY_CONFIG_DEFAULTS, {
    personalMemoryMode: 'off',
    personalMemoryGroupAllowlist: [],
    personalMemoryRecallMaxItems: 6,
    personalMemoryRecallMaxTokens: 1_200,
    personalMemoryRecallTimeoutMs: 150
  })

  for (const mode of ['off', 'explicit', 'shadow', 'automatic']) {
    assert.equal(normalizeGuobaConfigValue('personalMemoryMode', mode), mode)
  }
  for (const value of ['enabled', 'auto', '', 1]) {
    assert.throws(
      () => normalizeGuobaConfigValue('personalMemoryMode', value),
      /长期记忆模式配置无效/
    )
  }

  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallMaxItems', 1), 1)
  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallMaxItems', 12), 12)
  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallMaxTokens', 1), 1)
  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallMaxTokens', 2_400), 2_400)
  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallTimeoutMs', 1), 1)
  assert.equal(normalizeGuobaConfigValue('personalMemoryRecallTimeoutMs', 500), 500)
  for (const [field, values] of [
    ['personalMemoryRecallMaxItems', [0, 13, 1.5, '6']],
    ['personalMemoryRecallMaxTokens', [0, 2_401, 1.5, '1200']],
    ['personalMemoryRecallTimeoutMs', [0, 501, 1.5, '150']]
  ] as const) {
    for (const value of values) {
      assert.throws(
        () => normalizeGuobaConfigValue(field, value),
        /长期记忆召回预算配置无效/
      )
    }
  }
})

test('Guoba patch keeps masked secrets, saves ordinary empty values and ignores unknown fields', () => {
  const current = {
    apiKey: 'existing-secret',
    model: 'deepseek-chat',
    personalMemoryMode: 'off',
    legacyUnknown: 'must-survive-outside-the-form'
  }
  assert.deepEqual(buildGuobaConfigPatch({
    apiKey: '',
    model: '',
    personalMemoryMode: 'explicit',
    unknownSubmittedField: 'drop-me'
  }, {
    current,
    supportedKeys: ['apiKey', 'model', 'personalMemoryMode']
  }), {
    model: '',
    personalMemoryMode: 'explicit'
  })
  assert.deepEqual(buildGuobaConfigPatch({}, {
    current,
    supportedKeys: ['apiKey', 'model']
  }), {})
  assert.deepEqual(buildGuobaConfigPatch({ apiKey: 'replacement-secret' }, {
    current,
    supportedKeys: ['apiKey']
  }), { apiKey: 'replacement-secret' })
  assert.deepEqual(buildGuobaConfigPatch({
    personalMemoryOperationsStatus: 'hostile-status',
    personalMemoryMaintenanceAction: 'verify'
  }, {
    current,
    supportedKeys: [],
    virtualKeys: ['personalMemoryMaintenanceAction']
  }), { personalMemoryMaintenanceAction: 'verify' })
})

test('Guoba patch rejects accessors without invoking them', () => {
  let reads = 0
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'apiKey', {
    enumerable: true,
    get () {
      reads += 1
      return 'leaked'
    }
  })
  assert.throws(() => buildGuobaConfigPatch(hostile, {
    current: { apiKey: 'existing-secret' },
    supportedKeys: ['apiKey']
  }), /Guoba 配置数据无效/)
  assert.equal(reads, 0)
  assert.throws(() => buildGuobaConfigPatch(new Proxy({ apiKey: 'leaked' }, {}), {
    current: { apiKey: 'existing-secret' },
    supportedKeys: ['apiKey']
  }), /Guoba 配置数据无效/)
})

test('Guoba patch accepts only bounded plain strings for masked secrets', () => {
  let serialized = 0
  const hostile = {
    toJSON () {
      serialized += 1
      return 'leaked'
    }
  }
  for (const value of [1, true, hostile, 'a\0b', 'a'.repeat(16 * 1_024 + 1)]) {
    assert.throws(() => buildGuobaConfigPatch({ apiKey: value }, {
      current: { apiKey: 'existing-secret' },
      supportedKeys: ['apiKey']
    }), /Guoba 密钥配置无效/)
  }
  assert.equal(serialized, 0)
  assert.deepEqual(buildGuobaConfigPatch({ apiKey: 'a'.repeat(16 * 1_024) }, {
    current: { apiKey: 'existing-secret' },
    supportedKeys: ['apiKey']
  }), { apiKey: 'a'.repeat(16 * 1_024) })
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
  assert.equal(
    guobaConfigSaveMessage(['personalMemoryMode']),
    '保存成功；部分模型传输、运行入口、落盘日志或 Chromium 配置将在重启后生效~'
  )
})
