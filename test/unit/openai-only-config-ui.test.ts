import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  selectImportableConfig,
  selectPersistedConfig
} from '../../src/runtime/config-persistence.js'

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
  const guoba = await readSource('guoba.support.js')
  const legacyView = await readSource('resources/view/setting_view.json')

  for (const field of removedFields) {
    assert.doesNotMatch(guoba, new RegExp(`field: '${field}'`))
    assert.doesNotMatch(legacyView, new RegExp(`"data"\\s*:\\s*"${field}"`))
  }
  for (const field of preservedFields) {
    assert.match(guoba, new RegExp(`field: '${field}'`), `${field} must remain in Guoba`)
    assert.match(legacyView, new RegExp(`"data"\\s*:\\s*"${field}"`), `${field} must remain in the legacy view`)
  }
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
