import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  resolveForwardToolDetailsSetting,
  selectImportableConfig,
  selectPersistedConfig
} from '../../src/runtime/config-persistence.js'
import {
  GUOBA_MASKED_SECRET_FIELDS,
  normalizeGuobaConfigValue
} from '../../src/runtime/guoba-config.js'
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
  'apiContextWindowTokens',
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
  'diskLogEnabled',
  'proxy',
  'defaultTimeoutMs',
  'observabilityLevel',
  'enableToolbox',
  'closeBrowserAfterRender',
  'apiKey',
  'openAiBaseUrl',
  'openAiCompatibilityProfile',
  'openAiForceUseReverse',
  'model',
  'apiStream',
  'apiMaxToken',
  'apiContextWindowTokens',
  'apiThinkingMode',
  'apiReasoningEffort',
  'promptPrefixOverride',
  'temperature',
  'forwardReasoning',
  'forwardToolDetails',
  'smartMode',
  'toolPolicyProfile',
  'toolApprovalTtlSeconds',
  'enableGroupContext',
  'groupContextTip',
  'groupContextLength',
  'groupMerge',
  'conversationPreserveTime',
  'personalMemoryMode',
  'personalMemoryGroupAllowlist',
  'personalMemoryRecallMaxItems',
  'personalMemoryRecallMaxTokens',
  'personalMemoryRecallTimeoutMs',
  'personalMemoryOperationsStatus',
  'personalMemoryMaintenanceAction',
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
    label: '网络与调试',
    fields: [
      'proxy', 'defaultTimeoutMs', 'observabilityLevel', 'diskLogEnabled', 'debug'
    ]
  },
  {
    label: '模型与会话',
    fields: [
      'toggleMode', 'assistantLabel', 'enablePrivateChat', 'enableRobotAt', 'turnConfirm',
      'apiKey', 'openAiBaseUrl', 'openAiCompatibilityProfile', 'model',
      'promptPrefixOverride', 'temperature',
      'apiStream', 'apiMaxToken', 'apiContextWindowTokens', 'apiThinkingMode', 'apiReasoningEffort',
      'forwardReasoning', 'forwardToolDetails', 'openAiForceUseReverse', 'enableGroupContext',
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
    label: '长期记忆',
    fields: [
      'personalMemoryMode', 'personalMemoryGroupAllowlist',
      'personalMemoryRecallMaxItems', 'personalMemoryRecallMaxTokens',
      'personalMemoryRecallTimeoutMs', 'personalMemoryOperationsStatus',
      'personalMemoryMaintenanceAction'
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
  assert.equal(example.openAiCompatibilityProfile, 'deepseek')
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
    if (field === 'turnConfirm' || field === 'personalMemoryOperationsStatus' ||
      field === 'personalMemoryMaintenanceAction') continue
    assert.match(configSource, new RegExp(`^  ${field}:`, 'm'), `${field} must have a runtime default`)
    assert.equal(Object.hasOwn(configExample, field), true, `${field} must have a safe example value`)
  }
  assert.doesNotMatch(configSource, /^  turnConfirm:/m)
  assert.equal(Object.hasOwn(configExample, 'turnConfirm'), false)
  for (const field of ['personalMemoryOperationsStatus', 'personalMemoryMaintenanceAction']) {
    assert.doesNotMatch(configSource, new RegExp(`^  ${field}:`, 'm'))
    assert.equal(Object.hasOwn(configExample, field), false)
  }

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

test('Guoba explains the current bounded Redis trace retention', () => {
  const field = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).find(schema => schema.field === 'observabilityLevel')

  assert.match(field?.bottomHelpMessage ?? '', /7 天/)
  assert.match(field?.bottomHelpMessage ?? '', /2048 条/)
  assert.match(field?.bottomHelpMessage ?? '', /16 MiB/)
})

test('full disk journal is enabled by default and explained independently from Redis', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const fields = schemas.filter(schema => schema.field === 'diskLogEnabled')
  const source = await readSource('utils/config.js')
  const example = JSON.parse(
    await readSource('config/config.example.json')
  ) as Record<string, unknown>

  assert.equal(fields.length, 1)
  assert.equal(fields[0]?.component, 'Switch')
  assert.match(fields[0]?.bottomHelpMessage ?? '', /完整/)
  assert.match(fields[0]?.bottomHelpMessage ?? '', /30 天/)
  assert.match(fields[0]?.bottomHelpMessage ?? '', /32 MiB/)
  assert.match(fields[0]?.bottomHelpMessage ?? '', /512 MiB/)
  assert.match(fields[0]?.bottomHelpMessage ?? '', /Redis/)
  assert.match(fields[0]?.bottomHelpMessage ?? '', /独立/)
  assert.match(source, /^  diskLogEnabled: true,/m)
  assert.equal(example.diskLogEnabled, true)
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

test('Guoba exposes one bounded restart-only context window override', async () => {
  const field = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).find(schema => schema.field === 'apiContextWindowTokens')
  const source = await readSource('utils/config.js')
  const example = JSON.parse(
    await readSource('config/config.example.json')
  ) as Record<string, unknown>

  assert.equal(field?.component, 'InputNumber')
  assert.deepEqual(field?.componentProps, { min: 0, max: 1_000_000, step: 1 })
  assert.match(field?.bottomHelpMessage ?? '', /0.*Profile|Profile.*0/)
  assert.match(field?.bottomHelpMessage ?? '', /512 KiB/)
  assert.match(field?.bottomHelpMessage ?? '', /256 KiB/)
  assert.match(field?.bottomHelpMessage ?? '', /重启/)
  assert.match(source, /^  apiContextWindowTokens: 0,/m)
  assert.equal(example.apiContextWindowTokens, 0)
})

test('Guoba accurately marks restart-only and deferred rendering settings', async () => {
  const fields = new Map(buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  }).flatMap(schema => schema.field ? [[schema.field, schema] as const] : []))

  for (const field of [
    'toggleMode', 'apiKey', 'openAiBaseUrl', 'openAiCompatibilityProfile',
    'apiContextWindowTokens', 'proxy', 'headless', 'chromePath', 'diskLogEnabled'
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
  assert.match(support, /guobaConfigSaveMessage/)
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

test('Guoba groups supported settings into ten functional sections', () => {
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

test('long-term memory pilot is default-off, bounded and operationally explicit', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const fields = new Map(schemas.flatMap(schema => (
    schema.field ? [[schema.field, schema] as const] : []
  )))
  const source = await readSource('utils/config.js')
  const example = JSON.parse(
    await readSource('config/config.example.json')
  ) as Record<string, unknown>

  assert.deepEqual(
    (fields.get('personalMemoryMode')?.componentProps?.options as Array<{ value: string }>)
      .map(option => option.value),
    ['off', 'explicit', 'shadow', 'automatic']
  )
  assert.equal(example.personalMemoryMode, 'off')
  assert.match(source, /^  personalMemoryMode: 'off',/m)
  assert.deepEqual(example.personalMemoryGroupAllowlist, [])
  assert.deepEqual(fields.get('personalMemoryGroupAllowlist')?.componentProps, {
    allowAdd: true,
    closable: true
  })
  assert.deepEqual(fields.get('personalMemoryRecallMaxItems')?.componentProps, {
    min: 1, max: 12, step: 1
  })
  assert.deepEqual(fields.get('personalMemoryRecallMaxTokens')?.componentProps, {
    min: 1, max: 2_400, step: 1
  })
  assert.deepEqual(fields.get('personalMemoryRecallTimeoutMs')?.componentProps, {
    min: 1, max: 500, step: 1
  })
  assert.equal(example.personalMemoryRecallMaxItems, 6)
  assert.equal(example.personalMemoryRecallMaxTokens, 1_200)
  assert.equal(example.personalMemoryRecallTimeoutMs, 150)
  assert.equal(fields.get('personalMemoryOperationsStatus')?.componentProps?.disabled, true)
  assert.deepEqual(
    (fields.get('personalMemoryMaintenanceAction')?.componentProps?.options as Array<{
      value: string
    }>).map(option => option.value),
    ['none', 'verify', 'rebuild_lexical']
  )

  for (const field of [
    'personalMemoryMode', 'personalMemoryGroupAllowlist', 'personalMemoryRecallMaxItems',
    'personalMemoryRecallMaxTokens', 'personalMemoryRecallTimeoutMs'
  ]) assert.match(fields.get(field)?.bottomHelpMessage ?? '', /重启/)
  assert.match(fields.get('personalMemoryMode')?.bottomHelpMessage ?? '', /用户.*独立.*加入|opt-in/)
  assert.match(fields.get('personalMemoryGroupAllowlist')?.bottomHelpMessage ?? '', /空.*群聊.*不允许/)
  assert.match(fields.get('personalMemoryOperationsStatus')?.bottomHelpMessage ?? '', /不会.*初始化/)
  assert.match(fields.get('personalMemoryMaintenanceAction')?.bottomHelpMessage ?? '', /不会.*删除/)

  const all = `${source}\n${JSON.stringify(example)}\n${JSON.stringify(schemas)}`
  assert.doesNotMatch(all, /personalMemory(?:Embedding|Vector|Rerank).*(?:true|enabled)/i)
})

test('Guoba masks every password field and routes saves through the reviewed patch boundary', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const passwordFields = schemas.flatMap(schema => (
    schema.component === 'InputPassword' && schema.field !== undefined ? [schema.field] : []
  )).sort()
  assert.deepEqual(passwordFields, [...GUOBA_MASKED_SECRET_FIELDS].sort())

  const support = await readSource('guoba.support.js')
  assert.match(support, /buildGuobaConfigPatch\(data, \{/)
  assert.match(support, /supportedKeys: supportedConfigKeys/)
  assert.match(support, /virtualKeys: \['turnConfirm', 'personalMemoryMaintenanceAction'\]/)
  assert.doesNotMatch(support, /Object\.entries\(data\)/)
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

test('Guoba exposes adjacent independent reasoning and tool-detail switches', async () => {
  const schemas = buildGuobaSchemas({
    vitsRoleOptions: [], voicevoxRoleOptions: [], azureRoleOptions: []
  })
  const reasoningIndex = schemas.findIndex(schema => schema.field === 'forwardReasoning')
  const toolIndexes = schemas.flatMap((schema, index) => (
    schema.field === 'forwardToolDetails' ? [index] : []
  ))
  assert.equal(toolIndexes.length, 1)
  assert.equal(toolIndexes[0], reasoningIndex + 1)
  const field = schemas[toolIndexes[0] ?? -1]
  assert.equal(field?.component, 'Switch')
  assert.match(field?.bottomHelpMessage ?? '', /脱敏|参数|结果|目标/)

  const example = JSON.parse(await readSource('config/config.example.json')) as Record<string, unknown>
  assert.equal(example.forwardReasoning, true)
  assert.equal(example.forwardToolDetails, true)

  assert.equal(resolveForwardToolDetailsSetting(undefined, false), false)
  assert.equal(resolveForwardToolDetailsSetting(undefined, true), true)
  assert.equal(resolveForwardToolDetailsSetting(true, false), true)
  assert.equal(resolveForwardToolDetailsSetting(false, true), false)
  const source = await readSource('utils/config.js')
  const inheritanceIndex = source.indexOf(
    'const effectiveForwardToolDetails = resolveForwardToolDetailsSetting('
  )
  assert.ok(inheritanceIndex >= 0)
  assert.ok(
    inheritanceIndex <
      source.indexOf('Object.assign({}, defaultConfig, config)'),
    'legacy inheritance must be resolved before defaults hide a missing field'
  )
})
