import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  selectImportableConfig,
  selectPersistedConfig
} from '../../src/runtime/config-persistence.js'
import { normalizeGuobaConfigValue } from '../../src/runtime/guoba-config.js'
import { buildGuobaSchemas } from '../../src/runtime/guoba-schema.js'

const root = process.cwd()

const removedFields = [
  'OpenAiPlatformRefreshToken',
  'api',
  'apiBaseUrl',
  'apiForceUseReverse',
  'useGPT4',
  'sydney',
  'sydneyReverseProxy',
  'sydneyForceUseReverse',
  'sydneyWebsocketUseProxy',
  'sydneyMood',
  'sydneyMoodTip',
  'sydneyEnableSearch',
  'sydneyFirstMessageTimeout',
  'sydneyApologyIgnored',
  'bingAiToken',
  'bingAiClientId',
  'bingAiScope',
  'bingAiRefreshToken',
  'bingAiOid',
  'bingReasoning',
  'claudeApiKey',
  'claudeApiBaseUrl',
  'claudeApiModel',
  'claudeSystemPrompt',
  'claudeAIOrganizationId',
  'claudeAISessionKey',
  'claudeAIReverseProxy',
  'claudeAITimeout',
  'claudeAIJA3',
  'claudeAIUA',
  'geminiKey',
  'geminiModel',
  'geminiPrompt',
  'geminiBaseUrl',
  'geminiEnableGoogleSearch',
  'geminiEnableCodeExecution',
  'geminiForceToolKeywords',
  'qwenApiKey',
  'qwenModel',
  'qwenTopP',
  'qwenTopK',
  'qwenSeed',
  'qwenTemperature',
  'qwenEnableSearch',
  'chatglmBaseUrl',
  'chatglmRefreshToken',
  'xinghuoToken',
  'xhmode',
  'xhAppId',
  'xhAPISecret',
  'xhAPIKey',
  'xhAssistants',
  'xhTemperature',
  'xhMaxTokens',
  'xhPromptSerialize',
  'xhPrompt',
  'xhPromptEval',
  'xhRetRegExp',
  'xhRetReplace',
  'azureUrl',
  'azureDeploymentName',
  'allowOtherMode',
  'bymMode',
  'translateSource',
  'enableDraw',
  'drawCD',
  'enableToolPrivateSend',
  'enableToolCrossGroupSend'
] as const

const preservedFields = [
  'apiKey',
  'openAiBaseUrl',
  'model',
  'apiStream',
  'apiThinkingMode',
  'apiReasoningEffort',
  'azureTTSKey',
  'azureTTSRegion',
  'azureTTSSpeaker',
  'defaultTTSRole',
  'voicevoxSpace',
  'voicevoxTTSSpeaker',
  'smartMode',
  'toolPrivateSendPolicy',
  'toolCrossGroupSendPolicy',
  'enableToolVideoDownload',
  'toolVideoMaxMB'
] as const

const requiredGuobaFields = [
  'toggleMode',
  'assistantLabel',
  'enablePrivateChat',
  'turnConfirm',
  'enableRobotAt',
  'debug',
  'proxy',
  'defaultTimeoutMs',
  'enableToolbox',
  'closeBrowserAfterRender',
  'apiKey',
  'openAiBaseUrl',
  'openAiCompatibilityProfile',
  'openAiForceUseReverse',
  'model',
  'apiStream',
  'apiMaxToken',
  'apiThinkingMode',
  'apiReasoningEffort',
  'promptPrefixOverride',
  'temperature',
  'forwardReasoning',
  'smartMode',
  'toolPolicyProfile',
  'toolApprovalTtlSeconds',
  'enableGroupContext',
  'groupContextTip',
  'groupContextLength',
  'groupMerge',
  'conversationPreserveTime',
  'toolPrivateSendPolicy',
  'toolCrossGroupSendPolicy',
  'enableToolVideoDownload',
  'toolVideoMaxMB',
  'amapKey',
  'azSerpKey',
  'tavilyApiKey',
  'braveSearchApiKey',
  'serpSource',
  'imageSearchSource',
  'extraUrl',
  'githubAPIKey',
  'blockWords',
  'promptBlockWords',
  'whitelist',
  'blacklist',
  'imgOcr',
  'quoteReply',
  'defaultUsePicture',
  'autoUsePicture',
  'autoUsePictureThreshold',
  'showQRCode',
  'headless',
  'chromePath',
  'chromeTimeoutMS',
  'chatViewWidth',
  'toneStyle',
  'serverPort',
  'serverHost',
  'viewHost',
  'cloudRender',
  'cloudDPR',
  'chatViewBotName',
  'groupAdminPage',
  'live2d',
  'live2dModel',
  'live2dOption_scale',
  'live2dOption_positionX',
  'live2dOption_positionY',
  'live2dOption_rotation',
  'live2dOption_alpha',
  'defaultUseTTS',
  'alsoSendText',
  'ttsMode',
  'defaultTTSRole',
  'ttsSpace',
  'huggingFaceReverseProxy',
  'voicevoxSpace',
  'voicevoxTTSSpeaker',
  'azureTTSKey',
  'azureTTSRegion',
  'azureTTSSpeaker',
  'azureTTSEmotion',
  'enhanceAzureTTSEmotion',
  'ttsRegex',
  'ttsAutoFallbackThreshold',
  'autoJapanese',
  'cloudTranscode',
  'cloudMode',
  'noiseScale',
  'noiseScaleW',
  'lengthScale',
  'initiativeChatGroups',
  'helloPrompt',
  'helloInterval',
  'helloProbability',
  'emojiBaseURL',
  'enableBYM',
  'bymRecognizeLeadingAlias',
  'bymRate',
  'bymDisableGroup',
  'bymThinkingMode',
  'bymReasoningEffort',
  'bymPreset',
  'bymFuckPrompt',
  'bymFuckRecall',
  'bymFuckRecallTime',
  'bymFuckList',
  'bymFuckBlacklist',
  'sunoSessToken',
  'sunoClientToken',
  'enableChatSuno'
] as const

const expectedGuobaGroups = [
  {
    label: '基础与运行',
    fields: [
      'toggleMode', 'assistantLabel', 'enablePrivateChat', 'turnConfirm', 'enableRobotAt',
      'proxy', 'defaultTimeoutMs', 'debug'
    ]
  },
  {
    label: '模型与会话',
    fields: [
      'apiKey', 'openAiBaseUrl', 'openAiCompatibilityProfile', 'model',
      'promptPrefixOverride', 'temperature',
      'apiStream', 'apiMaxToken', 'apiThinkingMode', 'apiReasoningEffort',
      'forwardReasoning', 'openAiForceUseReverse', 'enableGroupContext',
      'groupContextLength', 'groupContextTip', 'groupMerge',
      'conversationPreserveTime'
    ]
  },
  {
    label: '群聊参与',
    fields: [
      'initiativeChatGroups', 'helloProbability', 'helloInterval', 'helloPrompt',
      'enableBYM', 'bymRecognizeLeadingAlias', 'bymRate', 'bymDisableGroup', 'bymThinkingMode',
      'bymReasoningEffort', 'bymPreset', 'bymFuckList', 'bymFuckBlacklist',
      'bymFuckPrompt', 'bymFuckRecall', 'bymFuckRecallTime'
    ]
  },
  {
    label: '工具与搜索',
    fields: [
      'smartMode', 'toolPolicyProfile', 'toolApprovalTtlSeconds',
      'toolPrivateSendPolicy', 'toolCrossGroupSendPolicy',
      'enableToolVideoDownload', 'toolVideoMaxMB', 'serpSource', 'tavilyApiKey',
      'azSerpKey', 'imageSearchSource', 'braveSearchApiKey', 'amapKey',
      'githubAPIKey', 'extraUrl'
    ]
  },
  {
    label: '权限与内容安全',
    fields: ['whitelist', 'blacklist', 'promptBlockWords', 'blockWords', 'imgOcr']
  },
  {
    label: '回复与图片',
    fields: [
      'quoteReply', 'defaultUsePicture', 'autoUsePicture',
      'autoUsePictureThreshold', 'chatViewWidth', 'toneStyle', 'chatViewBotName',
      'cloudDPR', 'closeBrowserAfterRender', 'headless', 'chromePath',
      'chromeTimeoutMS'
    ]
  },
  {
    label: '渲染服务与外观',
    fields: [
      'viewHost', 'cloudRender', 'serverHost', 'serverPort', 'showQRCode',
      'enableToolbox', 'groupAdminPage', 'live2d', 'live2dModel',
      'live2dOption_scale', 'live2dOption_positionX', 'live2dOption_positionY',
      'live2dOption_rotation', 'live2dOption_alpha'
    ]
  },
  {
    label: '语音回复',
    fields: [
      'defaultUseTTS', 'alsoSendText', 'ttsMode', 'ttsRegex',
      'ttsAutoFallbackThreshold', 'cloudTranscode', 'cloudMode',
      'defaultTTSRole', 'ttsSpace', 'huggingFaceReverseProxy', 'autoJapanese',
      'noiseScale', 'noiseScaleW', 'lengthScale', 'voicevoxSpace',
      'voicevoxTTSSpeaker', 'azureTTSKey', 'azureTTSRegion', 'azureTTSSpeaker',
      'azureTTSEmotion', 'enhanceAzureTTSEmotion'
    ]
  },
  {
    label: '表情与音乐',
    fields: ['emojiBaseURL', 'sunoSessToken', 'sunoClientToken', 'enableChatSuno']
  }
] as const

async function readSource (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('default and example configuration expose only the supported provider', async () => {
  const source = await readSource('utils/config.js')
  const example = JSON.parse(await readSource('config/config.example.json')) as Record<string, unknown>

  for (const field of removedFields) {
    assert.equal(Object.hasOwn(example, field), false, `${field} must be removed from the example`)
    assert.doesNotMatch(source, new RegExp(`^  ${field}:`, 'm'))
  }
  for (const field of preservedFields) {
    assert.equal(Object.hasOwn(example, field), true, `${field} must remain in the example`)
    assert.match(source, new RegExp(`^  ${field}:`, 'm'))
  }
  assert.doesNotMatch(source, /getGeminiKey|pureSydneyInstruction|defaultChatGPTAPI|officialChatGPTAPI/)
  assert.match(source, /^  openAiCompatibilityProfile: 'standard',/m)
  assert.equal(example.openAiCompatibilityProfile, 'standard')
})

test('Guoba and legacy settings view expose supported API, TTS and tool fields only', async () => {
  const guobaFields = new Set(buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  }).flatMap(schema => schema.field ? [schema.field] : []))
  const legacyView = await readSource('resources/view/setting_view.json')

  for (const field of removedFields) {
    assert.equal(guobaFields.has(field), false, `${field} must be removed from Guoba`)
    assert.doesNotMatch(legacyView, new RegExp(`"data"\\s*:\\s*"${field}"`))
  }
  for (const field of preservedFields) {
    assert.equal(guobaFields.has(field), true, `${field} must remain in Guoba`)
    assert.match(legacyView, new RegExp(`"data"\\s*:\\s*"${field}"`), `${field} must remain in the legacy view`)
  }
})

test('Guoba exposes every supported user-facing configuration with an explanation', async () => {
  const configSource = await readSource('utils/config.js')
  const configExample = JSON.parse(await readSource('config/config.example.json')) as Record<string, unknown>
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  })
  const fields = new Map(schemas.flatMap(schema =>
    schema.field ? [[schema.field, schema] as const] : []
  ))
  const fieldCount = schemas.filter(schema => schema.field).length

  assert.equal(fields.size, fieldCount, 'Guoba field names must be unique')

  for (const field of requiredGuobaFields) {
    assert.equal(fields.has(field), true, `${field} must be configurable in Guoba`)
    if (field === 'turnConfirm') continue
    assert.match(configSource, new RegExp(`^  ${field}:`, 'm'), `${field} must have a runtime default`)
    assert.equal(Object.hasOwn(configExample, field), true, `${field} must have a safe example value`)
  }
  assert.doesNotMatch(configSource, /^  turnConfirm:/m)
  assert.equal(Object.hasOwn(configExample, 'turnConfirm'), false)

  for (const [field, schema] of fields) {
    assert.equal(
      typeof schema.bottomHelpMessage === 'string' && schema.bottomHelpMessage.trim().length > 0,
      true,
      `${field} must explain its behavior in Guoba`
    )
  }
})

test('Guoba explains the retired legacy approval behavior', () => {
  const fields = new Map(buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).flatMap(schema => schema.field ? [[schema.field, schema] as const] : []))

  assert.match(fields.get('toolPolicyProfile')?.bottomHelpMessage ?? '', /需要审批的操作会拒绝执行/)
  assert.match(fields.get('toolApprovalTtlSeconds')?.bottomHelpMessage ?? '', /新审批流程预留/)
})

test('Guoba exposes only explicit standard and DeepSeek compatibility profiles', () => {
  const field = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).find(schema => schema.field === 'openAiCompatibilityProfile')

  assert.equal(field?.component, 'Select')
  assert.deepEqual(
    (field?.componentProps?.options as Array<{ value: string }>).map(option => option.value),
    ['standard', 'deepseek']
  )
  assert.match(field?.bottomHelpMessage ?? '', /不会.*自动猜测/)
  assert.match(field?.bottomHelpMessage ?? '', /重启/)
})

test('Guoba accurately marks restart-only and deferred rendering settings', async () => {
  const fields = new Map(buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).flatMap(schema => schema.field ? [[schema.field, schema] as const] : []))

  for (const field of [
    'toggleMode', 'apiKey', 'openAiBaseUrl', 'openAiCompatibilityProfile',
    'proxy', 'headless', 'chromePath'
  ]) {
    assert.match(fields.get(field)?.bottomHelpMessage ?? '', /重启/)
  }
  for (const field of [
    'live2d', 'live2dModel', 'live2dOption_scale', 'live2dOption_positionX',
    'live2dOption_positionY', 'live2dOption_rotation', 'live2dOption_alpha'
  ]) {
    const schema = fields.get(field)
    assert.equal(schema?.componentProps?.disabled, true)
    assert.match(`${schema?.label ?? ''}${schema?.bottomHelpMessage ?? ''}`, /暂不可用|后续/)
  }

  const support = await readSource('guoba.support.js')
  assert.match(support, /RESTART_REQUIRED_CONFIG_FIELDS/)
  assert.match(support, /部分模型传输、运行入口或 Chromium 配置将在重启后生效/)
})

test('Guoba configures leading name recognition as an enabled-by-default switch', async () => {
  const fields = new Map(buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).flatMap(schema => schema.field ? [[schema.field, schema] as const] : []))
  const source = await readSource('utils/config.js')
  const example = JSON.parse(
    await readSource('config/config.example.json')
  ) as Record<string, unknown>
  const schema = fields.get('bymRecognizeLeadingAlias')

  assert.equal(schema?.component, 'Switch')
  assert.match(schema?.bottomHelpMessage ?? '', /句首.*称呼|别名.*明确点名/)
  assert.match(source, /^  bymRecognizeLeadingAlias: true,/m)
  assert.equal(example.bymRecognizeLeadingAlias, true)
})

test('cross-channel send permissions use independent fail-closed selects', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const fields = new Map(schemas.flatMap(schema =>
    schema.field ? [[schema.field, schema] as const] : []
  ))
  for (const field of ['toolPrivateSendPolicy', 'toolCrossGroupSendPolicy']) {
    const schema = fields.get(field)
    assert.equal(schema?.component, 'Select')
    assert.deepEqual(
      (schema?.componentProps?.options as Array<{ value: string }>).map(option => option.value),
      ['disabled', 'master', 'everyone']
    )
    assert.match(schema?.bottomHelpMessage ?? '', /明确.*目标|精确.*目标/)
  }
  assert.equal(normalizeGuobaConfigValue('toolPrivateSendPolicy', 'master'), 'master')
  assert.equal(normalizeGuobaConfigValue('toolCrossGroupSendPolicy', 'everyone'), 'everyone')
  assert.throws(
    () => normalizeGuobaConfigValue('toolPrivateSendPolicy', 'invalid'),
    /工具跨会话发送权限配置无效/
  )

  const configSource = await readSource('utils/config.js')
  assert.ok(
    configSource.indexOf('migrateLegacyCrossChannelPolicies(config)') <
      configSource.indexOf('Object.assign({}, defaultConfig, config)'),
    'raw persisted configuration must migrate before defaults merge'
  )
  const managementSource = await readSource('apps/management.js')
  const importStart = managementSource.indexOf('const chatdata = selectImportableConfig(')
  const importEnd = managementSource.indexOf('for (let [keyPath, value]', importStart)
  const importBlock = managementSource.slice(importStart, importEnd)
  assert.match(importBlock, /migrateLegacyCrossChannelPolicies\(data\.chatConfig \|\| \{\}\)/)
})

test('Guoba external service fields provide actionable setup references', () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  })
  const fields = new Map(schemas.flatMap(schema =>
    schema.field ? [[schema.field, schema] as const] : []
  ))
  const expectedReferences = {
    amapKey: 'https://lbs.amap.com/api/webservice/guide/create-project/get-key',
    azSerpKey: 'https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement',
    tavilyApiKey: 'https://app.tavily.com/home',
    braveSearchApiKey: 'https://api-dashboard.search.brave.com/app/keys',
    extraUrl: 'https://github.com/ikechan8370/chatgpt-plugin-extras',
    githubAPIKey: 'https://github.com/settings/personal-access-tokens',
    ttsSpace: 'https://huggingface.co/spaces/ikechan8370/vits-uma-genshin-honkai',
    voicevoxSpace: 'https://github.com/VOICEVOX/voicevox_engine',
    azureTTSKey: 'https://portal.azure.com/'
  } as const

  for (const [field, reference] of Object.entries(expectedReferences)) {
    assert.match(
      fields.get(field)?.bottomHelpMessage ?? '',
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${field} must provide its setup or status reference`
    )
  }

  const serpSource = fields.get('serpSource')
  const serpOptions = serpSource?.componentProps?.options as Array<{ label: string, value: string }>
  assert.match(serpSource?.bottomHelpMessage ?? '', /退役.*Tavily/)
  assert.match(serpOptions.find(option => option.value === 'azure')?.label ?? '', /退役/)
})

test('Guoba groups supported settings into nine functional sections', () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  })
  const groups: Array<{ label: string, fields: string[] }> = []

  for (const schema of schemas) {
    if (schema.component === 'Divider') {
      groups.push({ label: schema.label, fields: [] })
    } else if (schema.field) {
      assert.ok(groups.length > 0, `${schema.field} must follow a Guoba divider`)
      groups.at(-1)?.fields.push(schema.field)
    }
  }

  assert.deepEqual(
    groups,
    expectedGuobaGroups.map(group => ({ label: group.label, fields: [...group.fields] }))
  )
  assert.deepEqual(
    expectedGuobaGroups.flatMap(group => group.fields).sort(),
    [...requiredGuobaFields].sort(),
    'the layout must preserve the complete supported field set'
  )
})

test('management and help no longer advertise removed providers', async () => {
  const combined = [
    await readSource('apps/management.js'),
    await readSource('apps/help.js'),
    await readSource('apps/md.js'),
    await readSource('server/modules/prompts.js'),
    await readSource('resources/help.json')
  ].join('\n')

  assert.doesNotMatch(
    combined,
    /api3|Copilot|Sydney|必应|Claude(?:\.ai)?|Gemini|通义千问|星火|ChatGLM|智谱|#bing|#qwen|#xh|#claude/i
  )
  assert.match(combined, /OpenAI-compatible/)
})

test('saving one supported field retains unknown legacy configuration keys', () => {
  const defaults = {
    model: '',
    apiKey: '',
    openAiCompatibilityProfile: 'standard',
    nested: { enabled: false }
  }
  const loaded = {
    ...defaults,
    model: 'fixture-model',
    openAiCompatibilityProfile: 'deepseek',
    legacyProviderToken: 'fixture-legacy-token',
    unknownObject: { keep: true }
  }
  loaded.nested = { enabled: true }

  assert.deepEqual(selectPersistedConfig(loaded, defaults), {
    model: 'fixture-model',
    openAiCompatibilityProfile: 'deepseek',
    nested: { enabled: true },
    legacyProviderToken: 'fixture-legacy-token',
    unknownObject: { keep: true }
  })
  assert.deepEqual(selectPersistedConfig({
    ...defaults,
    legacyProviderToken: 'fixture-legacy-token'
  }, defaults), {
    legacyProviderToken: 'fixture-legacy-token'
  })
})

test('old configuration imports ignore obsolete and unknown fields', () => {
  assert.deepEqual(selectImportableConfig({
    model: 'fixture-model',
    geminiKey: 'fixture-obsolete-key',
    unknownField: 'fixture-unknown-value'
  }, ['model', 'apiKey']), {
    model: 'fixture-model'
  })
})

test('tool video limit matches the memory-safe runtime hard limit', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const field = schemas.find(schema => schema.field === 'toolVideoMaxMB')
  assert.equal(field?.componentProps?.max, 8)
  const example = JSON.parse(await readSource('config/config.example.json')) as Record<string, unknown>
  assert.equal(example.toolVideoMaxMB, 8)
  assert.match(await readSource('utils/config.js'), /toolVideoMaxMB:\s*8/)
})

test('Guoba exposes exactly one pending indicator field with lifecycle semantics', () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const fields = schemas.filter(schema => schema.field === 'turnConfirm')
  assert.equal(fields.length, 1)
  assert.equal(fields[0]?.component, 'Switch')
  assert.equal(fields[0]?.label, '显示正在思考提示')
  assert.equal(
    fields[0]?.bottomHelpMessage,
    '普通聊天开始后显示一次提示，并在首条进度、审批暂停、终态或最多 8 秒后撤回；主动群聊不显示。'
  )
})
