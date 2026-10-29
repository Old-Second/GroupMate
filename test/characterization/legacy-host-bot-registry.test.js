import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  CONFIGS,
  EVENTS,
  HOST_BOTS,
  HOST_CONFIGS,
  SEQUENCES,
  buildRowsWith
} from '../../dist/verification/host-bot-registry-baseline.js'
import { createHostBotRegistry } from '../../dist/runtime/host/host-bot-registry.js'

// Regenerate with `node scripts/capture-host-bot-registry-baseline.mjs`; both values are pinned
// here so a regenerated fixture cannot quietly move the baseline it claims to reproduce.
const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
const BASELINE_SHA256 = '5a7287db38ca41e301e9955fb1e4967ba393de9b978ddece79028eb48b77af80'

async function fixture () {
  const url = new URL('../fixtures/host-bootstrap/batch-2-bot-registry.json', import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

function typedRows () {
  return buildRowsWith((config, hostBot, hostConfig) => createHostBotRegistry({
    config,
    hostBot: () => hostBot,
    loadHostConfig: async () => HOST_CONFIGS[hostConfig]
  }))
}

test('the captured bot registry baseline still describes the pre-migration entry point', async () => {
  const baseline = await fixture()
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.baselineCommit, BASELINE_COMMIT)
  assert.equal(baseline.baselineSha256, BASELINE_SHA256)
  assert.equal(baseline.generator, 'src/verification/host-bot-registry-baseline.ts')
  assert.deepEqual(
    [...new Set(baseline.rows.map(row => row.fn))].sort(),
    ['botPicker.pick', 'configuredBotId', 'eventActorId', 'eventTarget', 'masterIds', 'sequence']
  )
  assert.deepEqual(
    Object.keys(baseline.scenarios).sort(),
    ['configs', 'events', 'hostBots', 'hostConfigs', 'sequences']
  )

  // A scenario the capture never reached would make the replay below a vacuous check.
  for (const [key, expected] of [
    ['hostBots', Object.keys(HOST_BOTS)],
    ['configs', Object.keys(CONFIGS)],
    ['hostConfigs', Object.keys(HOST_CONFIGS)],
    ['sequences', Object.keys(SEQUENCES)]
  ]) {
    assert.deepEqual(Object.keys(baseline.scenarios[key]), expected)
  }
  assert.equal(baseline.scenarios.events.length, EVENTS.length)
  assert.equal(baseline.rows.length, 170)

  // The identity failure and the host master filter are both real legacy behaviour; a baseline
  // without them would hide the two cases most likely to regress.
  const thrown = baseline.rows.filter(row => row.result?.['@'] === 'error')
  assert.equal(thrown.length > 0, true)
  for (const row of thrown) {
    assert.equal(row.result.name, 'TypeError')
    assert.equal(row.result.message, 'Yunzai bot identity is unavailable')
  }
  assert.deepEqual(
    baseline.rows.find(row => row.fn === 'masterIds' && row.hostConfig === 'mixedList')?.result,
    ['1001', 1002]
  )
})

test('the typed bot registry reproduces every captured legacy row', async () => {
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

test('the migrated bot registry has exactly one editable copy', async () => {
  const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
  for (const name of [
    'rememberBot', 'configuredBotId', 'eventActorId', 'eventTarget'
  ]) {
    assert.equal(
      index.includes(`\nfunction ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  assert.equal(index.includes('\nasync function masterIds ('), false)
  assert.equal(index.includes('\nconst rememberedBots = new Map()'), false)
  assert.equal(index.includes('\nconst botPicker = Object.freeze({'), false)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-bot-registry\.js'/)
  // The host globals this module no longer reads must still be bound at exactly one place.
  assert.match(index, /hostBot: \(\) => globalThis\.Bot/)
  assert.match(index, /lib\/config\/config\.js/)
})
