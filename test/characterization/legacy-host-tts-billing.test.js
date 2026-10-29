import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  AZURE_VOICES,
  BILLING_RESPONSES,
  CONFIGS,
  FIXTURE_TIMEZONE,
  MODES,
  NOW_VALUES,
  VITS_SPEAKERS,
  VOICEVOX_VOICES,
  VOICE_REQUESTS,
  buildRowsWith,
  convertSpeaker,
  recordingFetch
} from '../../dist/verification/host-tts-billing-baseline.js'
import {
  createHostTtsAdministration
} from '../../dist/runtime/host/host-tts-administration.js'
import { createHostBilling } from '../../dist/runtime/host/host-billing.js'

// Regenerate with `node scripts/capture-host-tts-billing-baseline.mjs`; both values are pinned here
// so a regenerated fixture cannot quietly move the baseline it claims to reproduce.
const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
const BASELINE_SHA256 = '5a7287db38ca41e301e9955fb1e4967ba393de9b978ddece79028eb48b77af80'

async function fixture () {
  const url = new URL('../fixtures/host-bootstrap/batch-5-tts-billing.json', import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

function typedRows () {
  return buildRowsWith((config, scenario, log) => ({
    ttsAdministration: createHostTtsAdministration({
      config,
      setTtsMode: mode => { config.ttsMode = mode },
      vitsSpeakers: VITS_SPEAKERS,
      convertSpeaker,
      azureVoices: AZURE_VOICES,
      voiceVoxVoices: VOICEVOX_VOICES
    }),
    billing: createHostBilling({
      config,
      fetch: recordingFetch(scenario.response, log)
    })
  }))
}

test('the captured TTS and billing baseline still describes the pre-migration entry point', async () => {
  const baseline = await fixture()
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.baselineCommit, BASELINE_COMMIT)
  assert.equal(baseline.baselineSha256, BASELINE_SHA256)
  assert.equal(baseline.generator, 'src/verification/host-tts-billing-baseline.ts')
  assert.equal(baseline.scenarios.timezone, FIXTURE_TIMEZONE)
  assert.deepEqual(
    [...new Set(baseline.rows.map(row => row.fn))].sort(),
    [
      'getMode', 'isConfigured', 'missingConfigurationMessage', 'queryLastHundredDays',
      'selectVoice', 'setMode'
    ]
  )
  assert.deepEqual(Object.keys(baseline.scenarios.configs), Object.keys(CONFIGS))
  assert.deepEqual(baseline.scenarios.modes, MODES)
  assert.deepEqual(baseline.scenarios.vitsSpeakers, VITS_SPEAKERS)
  assert.deepEqual(baseline.scenarios.nowValues, NOW_VALUES)
  assert.equal(baseline.scenarios.voiceRequests.length, VOICE_REQUESTS.length)
  assert.deepEqual(Object.keys(baseline.scenarios.billingResponses), Object.keys(BILLING_RESPONSES))
  assert.equal(baseline.rows.length, 130)
})

test('the captured TTS and billing baseline reached the branches it claims to cover', async () => {
  const rows = (await fixture()).rows
  const selections = rows.filter(row => row.fn === 'selectVoice')
  assert.deepEqual(
    [...new Set(selections.map(row => row.result.kind))].sort(),
    ['selected', 'unsupported']
  )
  // The VITS alias resolver has to run before the catalogue check.
  const alias = selections.find(row => row.args[0] === 'vits-uma-genshin-honkai' &&
    row.args[1] === '草神')
  assert.equal(alias?.result.storedVoice, '纳西妲')
  // The Azure emotion hint is appended only when the voice supports it and the switch is on.
  const withHint = selections.find(row => row.config === 'azureConfigured' && row.args[1] === '晓晓')
  const withoutHint = selections.find(row => row.config === 'azureNoEmotion' && row.args[1] === '晓晓')
  assert.equal(withHint?.result.message.includes('多情绪配置'), true)
  assert.equal(withoutHint?.result.message.includes('多情绪配置'), false)
  // A VoiceVox style is parsed off the request and validated against the voice.
  const style = selections.find(row => row.args[0] === 'voicevox' && row.args[1] === '四国めたん-あまあま')
  assert.equal(style?.result.storedVoice, '四国めたん-あまあま')
  const badStyle = selections.find(row => row.args[0] === 'voicevox' && row.args[1] === '四国めたん-不存在')
  assert.equal(badStyle?.result.kind, 'unsupported')

  // Billing must stop at the first rejected response and validate the parsed numbers.
  const stopped = rows.find(row => row.response === 'subscriptionRejected')
  assert.equal(stopped?.result.message, 'billing subscription request failed')
  assert.equal(stopped?.calls.length, 1)
  for (const name of ['missingLimit', 'missingUsage', 'invalidAccessUntil', 'nonObjectBodies']) {
    assert.equal(
      rows.find(row => row.response === name)?.result.message, 'billing response is invalid'
    )
  }
  // The credential travels as a header name only; no row may carry its value.
  for (const row of rows.filter(item => item.fn === 'queryLastHundredDays')) {
    for (const call of row.calls) assert.deepEqual(call.headers, ['Authorization'])
  }
  assert.equal(JSON.stringify(rows).includes('Bearer'), false)
})

test('the typed TTS administration and billing reproduce every captured legacy row', async () => {
  const baseline = await fixture()
  const actual = await typedRows()
  assert.equal(actual.length, baseline.rows.length)
  const divergences = []
  for (const [index, expected] of baseline.rows.entries()) {
    const row = actual[index]
    if (JSON.stringify(row) !== JSON.stringify(expected)) {
      divergences.push({ index, fn: expected.fn, expected, actual: row })
    }
  }
  assert.deepEqual(divergences, [])
})

test('the migrated TTS administration and billing have exactly one editable copy', async () => {
  const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
  for (const name of [
    'ttsConfigured', 'missingTtsConfiguration', 'selectVoice', 'formatDateOnly'
  ]) {
    assert.equal(
      index.includes(`\nfunction ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  assert.equal(index.includes('\nconst ttsAdministration = Object.freeze({'), false)
  assert.equal(index.includes('\nconst billing = Object.freeze({'), false)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-tts-administration\.js'/)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-billing\.js'/)
  // The speaker catalogues and the proxy-aware fetch must still be bound at exactly one place.
  assert.match(index, /createHostTtsAdministration\(\{[\s\S]*?vitsSpeakers,[\s\S]*?convertSpeaker,[\s\S]*?azureVoices,[\s\S]*?voiceVoxVoices[\s\S]*?\}\)/)
  assert.match(index, /createHostBilling\(\{ config: Config, fetch: newFetch \}\)/)
})
