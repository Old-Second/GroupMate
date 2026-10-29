import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  ACTOR_IDS,
  AZURE_VOICES,
  CAST_FILES,
  CONFIGS,
  OCR_EVENTS,
  PREFERENCES,
  PREFERENCE_PATCHES,
  REDIS_STORES,
  TARGETS,
  buildRowsWith,
  recordingCastStore,
  recordingRedis
} from '../../dist/verification/host-chat-policy-baseline.js'
import { createHostChatPreferences } from '../../dist/runtime/host/host-preferences.js'
import {
  collectEventImageUrls,
  createHostChatPolicy,
  findAzureVoice
} from '../../dist/runtime/host/host-chat-policy.js'
import { createHostBotRegistry } from '../../dist/runtime/host/host-bot-registry.js'

// Regenerate with `node scripts/capture-host-chat-policy-baseline.mjs`; both values are pinned here
// so a regenerated fixture cannot quietly move the baseline it claims to reproduce.
const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
const BASELINE_SHA256 = '5a7287db38ca41e301e9955fb1e4967ba393de9b978ddece79028eb48b77af80'

async function fixture () {
  const url = new URL(
    '../fixtures/host-bootstrap/batch-4-preferences-policy.json',
    import.meta.url
  )
  return JSON.parse(await readFile(url, 'utf8'))
}

function typedRows () {
  return buildRowsWith((config, scenario, log) => {
    const redis = recordingRedis(REDIS_STORES[scenario.redis], log)
    const { eventActorId } = createHostBotRegistry({
      config,
      hostBot: () => undefined,
      loadHostConfig: async () => undefined
    })
    return {
      chatPreferences: createHostChatPreferences({ redis, config }),
      chatPolicy: createHostChatPolicy({
        config,
        redis,
        readTextFile: recordingCastStore(log),
        eventActorId,
        azureVoices: AZURE_VOICES
      }),
      eventImageUrls: collectEventImageUrls,
      azureVoice: voice => findAzureVoice(AZURE_VOICES, voice)
    }
  })
}

test('the captured chat policy baseline still describes the pre-migration entry point', async () => {
  const baseline = await fixture()
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.baselineCommit, BASELINE_COMMIT)
  assert.equal(baseline.baselineSha256, BASELINE_SHA256)
  assert.equal(baseline.generator, 'src/verification/host-chat-policy-baseline.ts')
  assert.deepEqual(
    [...new Set(baseline.rows.map(row => row.fn))].sort(),
    [
      'chatPolicy.appendAzureEmotionFeedback', 'chatPolicy.clearAzureEmotionFeedback',
      'chatPolicy.entryMode', 'chatPolicy.isMuted', 'chatPolicy.ocrText', 'chatPolicy.snapshot',
      'chatPolicy.snapshotForActor', 'chatPreferences.load', 'chatPreferences.patch',
      'azureVoice', 'entryModeAfterConfigChange', 'eventImageUrls'
    ].sort()
  )
  for (const [key, expected] of [
    ['configs', Object.keys(CONFIGS)],
    ['redisStores', Object.keys(REDIS_STORES)],
    ['castFiles', Object.keys(CAST_FILES)],
    ['preferences', Object.keys(PREFERENCES)],
    ['targets', Object.keys(TARGETS)]
  ]) {
    assert.deepEqual(Object.keys(baseline.scenarios[key]), expected)
  }
  assert.deepEqual(baseline.scenarios.actorIds.map(decodeShort), ACTOR_IDS)
  assert.deepEqual(baseline.scenarios.ocrEvents, OCR_EVENTS)
  assert.equal(baseline.scenarios.preferencePatches.length, PREFERENCE_PATCHES.length)
  assert.equal(baseline.scenarios.azureVoices.length, AZURE_VOICES.length)
  assert.equal(baseline.rows.length, 162)
})

function decodeShort (value) {
  return typeof value === 'object' && value?.['@'] === 'repeat'
    ? value.unit.repeat(value.count)
    : value
}

test('the captured chat policy baseline reached the branches it claims to cover', async () => {
  const baseline = await fixture()
  const rows = baseline.rows

  // A patch must preserve keys the migrated code does not own.
  const preserved = rows.find(row => row.fn === 'chatPreferences.patch' &&
    row.redis === 'storedPreferences' &&
    row.calls.some(call => call.host === 'redis.set' && call.value.includes('unrelated')))
  assert.notEqual(preserved, undefined)

  // `toggleMode` must stay at its construction-time value, which needs a restart to change.
  for (const row of rows.filter(item => item.fn === 'entryModeAfterConfigChange')) {
    assert.equal(row.result.after, row.result.before)
    assert.equal(row.result.snapshotToggleMode, row.result.before)
    assert.notEqual(row.result.changedTo, row.result.before)
  }

  // OCR must swallow a backend failure, cap the images and truncate the recognized text.
  const capped = rows.find(row => row.fn === 'chatPolicy.ocrText' && row.args[0] === 'manyImages' &&
    row.calls.filter(call => call.host === 'imageOcr').length === 8)
  assert.notEqual(capped, undefined)
  const swallowed = rows.find(row => row.fn === 'chatPolicy.ocrText' &&
    row.calls.some(call => call.host === 'imageOcr') &&
    Array.isArray(row.result) && row.result.length === 0)
  assert.notEqual(swallowed, undefined)
  const truncated = rows.find(row => row.fn === 'chatPolicy.ocrText' &&
    JSON.stringify(row.result).includes('"count":2000'))
  assert.notEqual(truncated, undefined)
  // The host OCR adapter must be called as a method on `event.bot`.
  for (const row of rows.filter(item => item.fn === 'chatPolicy.ocrText')) {
    for (const call of row.calls.filter(item => item.host === 'imageOcr')) {
      assert.equal(call.receiver, 'host-bot')
    }
  }

  // Each emotion correction has to be reachable, and an unknown flag must change nothing.
  const appended = rows.filter(row => row.fn === 'chatPolicy.appendAzureEmotionFeedback' &&
    row.result !== '原始提示')
  assert.equal(appended.length > 0, true)
  assert.equal(
    rows.some(row => row.fn === 'chatPolicy.appendAzureEmotionFeedback' &&
      row.redis === 'emotionFlagUnknown' && row.result === '原始提示' && row.calls.length === 1),
    true
  )

  // Muting is global or per group, decided on the scope kind: a private target must never read a
  // group key, even when the address still carries a group id.
  for (const target of ['private', 'privateWithGroupId']) {
    const privateMute = rows.find(row => row.fn === 'chatPolicy.isMuted' &&
      row.args[0] === target && row.redis === 'mutedOneGroup')
    assert.equal(privateMute?.result, false)
    assert.deepEqual(privateMute?.calls.map(call => call.key), ['CHATGPT:SHUT_UP:ALL'])
  }
})

test('the typed preferences and chat policy reproduce every captured legacy row', async () => {
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

test('the migrated preferences and chat policy have exactly one editable copy', async () => {
  const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
  for (const name of ['eventImageUrls', 'azureVoice']) {
    assert.equal(
      index.includes(`\nfunction ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  for (const name of ['actorCast', 'ocrText', 'appendAzureEmotionFeedback']) {
    assert.equal(
      index.includes(`\nasync function ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  assert.equal(index.includes('\nconst chatPreferences = Object.freeze({'), false)
  assert.equal(index.includes('\nconst chatPolicy = Object.freeze({'), false)
  assert.equal(index.includes('\nconst bootstrapEntryMode ='), false)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-preferences\.js'/)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-chat-policy\.js'/)
  // The host dependencies this module no longer reaches must still be bound at exactly one place.
  assert.match(index, /azureVoices/)
  assert.match(index, /readTextFile:/)
})
