import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  selectImportableConfig,
  selectPersistedConfig
} from '../../src/runtime/config-persistence.js'
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
  'drawCD'
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
  'enableToolPrivateSend',
  'enableToolCrossGroupSend',
  'enableToolVideoDownload',
  'toolVideoMaxMB'
] as const

const requiredGuobaFields = [
  'toggleMode',
  'assistantLabel',
  'enablePrivateChat',
  'enableRobotAt',
  'debug',
  'proxy',
  'defaultTimeoutMs',
  'enableToolbox',
  'closeBrowserAfterRender',
  'apiKey',
  'openAiBaseUrl',
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
  'enableGroupContext',
  'groupContextTip',
  'groupContextLength',
  'groupMerge',
  'conversationPreserveTime',
  'enableToolPrivateSend',
  'enableToolCrossGroupSend',
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
    assert.match(configSource, new RegExp(`^  ${field}:`, 'm'), `${field} must have a runtime default`)
    assert.equal(Object.hasOwn(configExample, field), true, `${field} must have a safe example value`)
  }

  for (const [field, schema] of fields) {
    assert.equal(
      typeof schema.bottomHelpMessage === 'string' && schema.bottomHelpMessage.trim().length > 0,
      true,
      `${field} must explain its behavior in Guoba`
    )
  }
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
    nested: { enabled: false }
  }
  const loaded = {
    ...defaults,
    model: 'fixture-model',
    legacyProviderToken: 'fixture-legacy-token',
    unknownObject: { keep: true }
  }
  loaded.nested = { enabled: true }

  assert.deepEqual(selectPersistedConfig(loaded, defaults), {
    model: 'fixture-model',
    nested: { enabled: true },
    legacyProviderToken: 'fixture-legacy-token',
    unknownObject: { keep: true }
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
