import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerSurfaceManifest } from '../../src/runtime/provider-surface-manifest.js'

const providerIds = [
  'openaiCompatible',
  'chatgptWeb',
  'bing',
  'claude',
  'gemini',
  'qwen',
  'chatglm',
  'xinghuo',
  'azureOpenai'
] as const

test('provider manifest defines every baseline category with exact source entries', () => {
  assert.deepEqual(Object.keys(providerSurfaceManifest.sources), providerIds)
  assert.ok(providerSurfaceManifest.sources.openaiCompatible.length > 0)
  for (const providerId of providerIds.slice(1)) {
    assert.deepEqual(
      providerSurfaceManifest.sources[providerId],
      [],
      `${providerId} must have no retained exact source`
    )
  }
  assert.ok(providerSurfaceManifest.sources.openaiCompatible.includes(
    'src/agent/model/deepseek-compatibility-profile.ts'
  ))
  assert.ok(providerSurfaceManifest.sources.openaiCompatible.includes(
    'dist/agent/model/deepseek-compatibility-profile.js'
  ))
  assert.ok(providerSurfaceManifest.configFields.openaiCompatible.includes(
    'openAiCompatibilityProfile'
  ))
  assert.ok(providerSurfaceManifest.uiFields.openaiCompatible.includes(
    'openAiCompatibilityProfile'
  ))
})

test('provider manifest separates Azure TTS from Azure OpenAI', () => {
  assert.ok(providerSurfaceManifest.preservedExclusions.identifiers.includes('azureTTSKey'))

  const azureOpenaiEntries = [
    ...providerSurfaceManifest.sources.azureOpenai,
    ...providerSurfaceManifest.commands.azureOpenai,
    ...providerSurfaceManifest.configFields.azureOpenai,
    ...providerSurfaceManifest.uiFields.azureOpenai,
    ...providerSurfaceManifest.dependencies.azureOpenai
  ]
  assert.equal(azureOpenaiEntries.some(entry => entry.includes('azureTTS')), false)
})

test('provider manifest excludes its own source and compiled output from discovery', () => {
  const excludedPaths: readonly string[] = providerSurfaceManifest.preservedExclusions.paths

  assert.ok(excludedPaths.includes(
    'src/runtime/provider-surface-manifest.ts'
  ))
  assert.ok(excludedPaths.includes(
    'dist/runtime/provider-surface-manifest.js'
  ))
})
